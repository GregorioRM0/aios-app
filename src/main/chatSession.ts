import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import type { Options, Query, SDKUserMessage, CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import {
  createChatTranslator, mergeStatus, parseStatuslinePayload, summarizeTool,
  type ChatEvent, type ChatEventBody, type ChatStatus, type ChatTranslator,
} from '../core/chatEvents';

/**
 * Chat view — the MAIN half. One persistent Claude Code session per chat tab, driven through the
 * Agent SDK instead of a pty: the renderer gets structured events (deltas, tool calls, permission
 * requests) instead of a terminal screen to scrape.
 *
 * This module imports NOTHING from electron and nothing from ./aios: everything it needs from the
 * app arrives through `ChatDeps`, and every event leaves through the `send` callback given at
 * start. That is deliberate — it keeps the bridge runnable under plain node (a one-off script over
 * out/ is how it was tested) and keeps main.ts the single place that knows about windows and IPC.
 *
 * Glass, not engine: the engine is still the real `claude` CLI. The SDK only speaks its
 * stream-json protocol for us and spawns the SAME executable the terminals use (see resolveClaude).
 */

export interface ChatDeps {
  /** Where a session starts: the vault root, else ~/aios. Same place a primary terminal lands. */
  cwd(): string;
  /** The environment of an app-launched terminal, with CLAUDE_AGENT_NAME set to the primary session's
   *  name — so CLAUDE.md's Mandatory First Action fires exactly as it does in a terminal. */
  env(): Record<string, string>;
  /** The operator's configured claude command (`shellSettings().claudeCmd`). */
  claudeCmd(): string;
  /** Where Claude Code's statusline dumps its latest payload. */
  statuslinePath(): string;
  /** Overrides the permission mode. Left out in the app on purpose: a session then honours the
   *  operator's own `defaultMode`, exactly like a terminal does. It exists so a one-off script can
   *  force 'default' on a machine whose settings say `bypassPermissions` (where no permission
   *  request would ever reach `canUseTool`) and still exercise the approval path. */
  permissionMode?(): Options['permissionMode'] | undefined;
}

export type ChatSend = (ev: ChatEvent) => void;

// The text a terminal session is started with, so the vault context loads the same way.
const START_MESSAGE = 'Start session';
// Same wording for an explicit denial, an interrupt and a close: the model only needs to know it was refused.
const DENIED = 'Denied by the operator';

// ── loading the SDK ─────────────────────────────────────────────────────────

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<SdkModule> | undefined;

/**
 * The SDK is ESM-only (`"type":"module"`, exports with just a `default` condition), and this
 * project compiles to CommonJS. tsc would rewrite a plain `import()` into `require()` — which
 * cannot load an .mjs entry — so the import is hidden inside a Function constructor, which tsc
 * leaves alone and which Node resolves with the real ESM loader.
 * A Function-constructor import has no parent module to resolve a bare specifier against, so the
 * entry is resolved here (require.resolve honours the `default` export condition) and handed over
 * as a file:// URL.
 */
function loadSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const entry = require.resolve('@anthropic-ai/claude-agent-sdk');
      const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<SdkModule>;
      return dynamicImport(pathToFileURL(entry).href);
    })();
    sdkPromise.catch(() => { sdkPromise = undefined; });   // a failed load may be retried (e.g. after an install)
  }
  return sdkPromise;
}

// ── which `claude` to run ───────────────────────────────────────────────────

/**
 * The executable the terminals run, resolved to an absolute path (the SDK spawns a file, not a
 * shell command line). Terminals get it from the login shell's PATH; a Dock-launched app has a
 * minimal PATH, so the usual install locations are searched too.
 * Returns undefined when it cannot be found — then the SDK falls back to the native binary it
 * ships with, which is a different version than the operator's installed one but always present.
 * Only the first word of the command is used: arguments in `claudeCmd` (a wrapper with flags) are
 * not carried over, because the SDK builds its own argument list.
 */
export function resolveClaude(cmd: string): string | undefined {
  const first = (cmd || 'claude').trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const name = first ? (first[1] || first[2] || first[3]) : 'claude';
  const isFile = (p: string): boolean => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  if (name.includes('/') || name.includes('\\')) return isFile(name) ? path.resolve(name) : undefined;
  const home = os.homedir();
  const dirs = [
    ...(process.env.PATH || '').split(path.delimiter),
    path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
  ].filter(Boolean);
  // a Windows .cmd shim cannot be spawned without a shell, so only .exe counts there
  const names = process.platform === 'win32' ? [name + '.exe', name] : [name];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (isFile(p)) return p; }
  return undefined;
}

// ── input: an async queue the SDK reads user messages from ──────────────────

class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private done = false;
  push(text: string): void {
    const m: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: m, done: false }); }
    else this.items.push(m);
  }
  end(): void {
    this.done = true;
    if (this.waiter) { const w = this.waiter; this.waiter = undefined; w({ value: undefined, done: true }); }
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as SDKUserMessage, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => { this.waiter = res; });
      },
    };
  }
}

// ── the manager ─────────────────────────────────────────────────────────────

interface Session {
  id: number;
  send: ChatSend;
  query: Query;
  inbox: Inbox;
  abort: AbortController;
  tr: ChatTranslator;
  pending: Map<string, (allow: boolean) => void>;   // permission requestId → resolver
  turnsInFlight: number;                            // user messages sent whose `result` has not arrived
  closed: boolean;
  exited: boolean;
  gotMessage: boolean;
  stderrTail: string;
}

export type StartResult = { ok: true; id: number } | { ok: false; error: string };

export interface ChatManager {
  start(opts: { startSession?: boolean }, send: ChatSend): Promise<StartResult>;
  sendText(id: number, text: string): void;
  interrupt(id: number): Promise<void>;
  permission(id: number, requestId: string, allow: boolean): void;
  close(id: number): void;
  closeAll(): void;
  /** The usage bar from the statusline file alone — what to paint before any session has spoken. */
  fileStatus(): Promise<ChatStatus>;
}

export function createChatManager(deps: ChatDeps): ChatManager {
  const sessions = new Map<number, Session>();
  let nextId = 1;

  // fs.promises, so a slow disk never blocks the main thread (it also runs the window)
  async function readFileFields(): Promise<ReturnType<typeof parseStatuslinePayload>> {
    try { return parseStatuslinePayload(await fs.promises.readFile(deps.statuslinePath(), 'utf8')); }
    catch { return {}; }   // no file yet, or unreadable: the bar just has fewer fields
  }

  async function fileStatus(): Promise<ChatStatus> {
    return mergeStatus(undefined, await readFileFields());
  }

  const emit = (s: Session, b: ChatEventBody): void => {
    try { s.send({ id: s.id, ...b } as ChatEvent); } catch { /* the window is gone; nothing to tell */ }
  };

  async function emitStatus(s: Session): Promise<void> {
    const file = await readFileFields();
    if (s.exited) return;
    emit(s, { type: 'status', status: mergeStatus(s.tr.sdkStatus(), file) });
  }

  /** Answer every parked permission request as denied and tell the renderer to drop its cards. */
  function denyPending(s: Session): void {
    // each resolver deletes itself, answers the SDK and emits `permission-resolved`
    for (const settle of [...s.pending.values()]) settle(false);
  }

  function finish(s: Session): void {
    if (s.exited) return;
    s.exited = true;
    denyPending(s);
    emit(s, { type: 'exit' });
    sessions.delete(s.id);
  }

  async function pump(s: Session): Promise<void> {
    try {
      for await (const msg of s.query) {
        s.gotMessage = true;
        const events = s.tr.push(msg);
        for (const e of events) {
          const { id: _id, ...body } = e;
          emit(s, body as ChatEventBody);
        }
        const type = (msg as { type?: string }).type;
        if (type === 'result') s.turnsInFlight = Math.max(0, s.turnsInFlight - 1);
        if (events.some((e) => e.type === 'result' || e.type === 'ready')) void emitStatus(s);
      }
    } catch (err) {
      if (!s.closed) {
        const detail = (err instanceof Error ? err.message : String(err)) + (s.stderrTail ? `\n${s.stderrTail}` : '');
        emit(s, { type: 'error', code: s.gotMessage ? 'turn-failed' : 'spawn-failed', message: detail.trim() });
      }
    }
    finish(s);
  }

  async function start(opts: { startSession?: boolean }, send: ChatSend): Promise<StartResult> {
    let sdk: SdkModule;
    try { sdk = await loadSdk(); }
    catch (err) { return { ok: false, error: 'sdk-missing: ' + (err instanceof Error ? err.message : String(err)) }; }

    const id = nextId++;
    const abort = new AbortController();
    const inbox = new Inbox();
    const s: Session = {
      id, send, inbox, abort, tr: createChatTranslator(id), pending: new Map(), turnsInFlight: 0,
      closed: false, exited: false, gotMessage: false, stderrTail: '',
      query: undefined as unknown as Query,   // assigned just below, once canUseTool (which closes over `s`) exists
    };

    // Every tool the CLI would have asked the operator about arrives here. The promise stays open
    // until the renderer answers (or the session is interrupted/closed, which denies it).
    const canUseTool: CanUseTool = (toolName, input, o) => new Promise((resolve) => {
      const requestId = randomUUID();
      const settle = (allow: boolean): void => {
        if (!s.pending.has(requestId)) return;
        s.pending.delete(requestId);
        emit(s, { type: 'permission-resolved', requestId, allow });
        resolve(allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: DENIED });
      };
      s.pending.set(requestId, settle);
      o.signal.addEventListener('abort', () => settle(false), { once: true });
      emit(s, { type: 'permission', requestId, toolName, summary: o.title || summarizeTool(toolName, input), input });
    });

    const exe = resolveClaude(deps.claudeCmd());
    const options: Options = {
      cwd: deps.cwd(),
      env: deps.env(),
      canUseTool,
      abortController: abort,
      includePartialMessages: true,
      // The SDK's default prompt is a bare one; the preset is the prompt the terminal CLI runs with.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      stderr: (d: string) => { s.stderrTail = (s.stderrTail + d).slice(-1500); },
      ...(exe ? { pathToClaudeCodeExecutable: exe } : {}),   // else the binary bundled with the SDK
      ...(deps.permissionMode?.() ? { permissionMode: deps.permissionMode() } : {}),
    };

    try {
      s.query = sdk.query({ prompt: inbox, options });
    } catch (err) {
      return { ok: false, error: 'spawn-failed: ' + (err instanceof Error ? err.message : String(err)) };
    }
    sessions.set(id, s);
    void pump(s);
    // The process is up once it answers the initialize handshake; only then can the input be used.
    void s.query.initializationResult().then(
      () => { if (!s.exited) emit(s, { type: 'ready' }); },
      (err: unknown) => {
        if (s.closed || s.exited) return;
        const detail = (err instanceof Error ? err.message : String(err)) + (s.stderrTail ? `\n${s.stderrTail}` : '');
        emit(s, { type: 'error', code: 'spawn-failed', message: detail.trim() });
      },
    );
    if (opts.startSession) { s.turnsInFlight++; inbox.push(START_MESSAGE); }
    return { ok: true, id };
  }

  function sendText(id: number, text: string): void {
    const s = sessions.get(id);
    if (!s || s.closed || !String(text ?? '').trim()) return;
    s.turnsInFlight++;
    s.inbox.push(String(text));
  }

  async function interrupt(id: number): Promise<void> {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    // Parked permission requests first: a turn blocked on one cannot hear an interrupt until it is answered.
    denyPending(s);
    if (s.turnsInFlight === 0) return;   // nothing running — Esc on an idle prompt is a no-op, as in the terminal
    s.tr.noteInterrupt();
    try { await s.query.interrupt(); }
    catch (err) {
      emit(s, { type: 'error', code: 'interrupt-failed', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function permission(id: number, requestId: string, allow: boolean): void {
    sessions.get(id)?.pending.get(String(requestId))?.(!!allow);
  }

  function close(id: number): void {
    const s = sessions.get(id);
    if (!s || s.closed) return;
    s.closed = true;
    denyPending(s);
    s.inbox.end();
    try { s.query.close(); } catch { /* already gone */ }
    try { s.abort.abort(); } catch { /* ignore */ }
    finish(s);
  }

  function closeAll(): void {
    for (const id of [...sessions.keys()]) close(id);
  }

  return { start, sendText, interrupt, permission, close, closeAll, fileStatus };
}

/**
 * Chat view — the PURE half of the main-process bridge (no electron, no fs).
 *
 * Three jobs, all of them string/number shaping that must be testable without a window:
 *  (a) translate the messages of a Claude Code session (Agent SDK `query()` output, or the lines of
 *      `claude -p --output-format stream-json`, which are the same objects) into the ChatEvent
 *      contract the renderer consumes;
 *  (b) mergeStatus — build the usage bar's ChatStatus, preferring what the live session said;
 *  (c) parseStatuslinePayload — read the payload Claude Code's statusline dumps to disk.
 *
 * THE RULE FOR EVERY NUMBER HERE: an absent field stays `undefined`. A bar that shows "0%" because
 * a field was missing is a fabricated reading, and the operator would trust it. Nothing in this
 * file defaults a percentage to 0.
 */

// ── the contract (shared by main, preload and renderer) ─────────────────────

export interface ChatStatus {
  fiveHourPct?: number;
  sevenDayPct?: number;
  contextPct?: number;
  model?: string;
  effort?: string;
  /** Where the fields came from: the live session, the statusline file, or a blend of both. */
  source: 'sdk' | 'file' | 'mixed';
}

/** A ChatStatus without its provenance — what one source can contribute on its own. */
export type StatusFields = Omit<ChatStatus, 'source'>;

export type ChatEventBody =
  | { type: 'ready'; sessionId?: string; model?: string }
  | { type: 'turn-start'; turnId: string }
  /** Incremental text; the renderer concatenates. */
  | { type: 'delta'; turnId: string; text: string }
  /** The complete text of the assistant block — replaces whatever the deltas built. */
  | { type: 'turn-end'; turnId: string; text: string }
  | { type: 'tool'; turnId?: string; name: string; summary: string }
  | { type: 'permission'; requestId: string; toolName: string; summary: string; input: unknown }
  | { type: 'permission-resolved'; requestId: string; allow: boolean }
  | { type: 'result'; isError: boolean; interrupted?: boolean }
  | { type: 'status'; status: ChatStatus }
  /** `code` is stable so the renderer can translate it through i18n; `message` is the raw detail. */
  | { type: 'error'; code: string; message: string }
  | { type: 'exit' };

export type ChatEvent = { id: number } & ChatEventBody;

// ── small, defensive readers ────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A finite number, or undefined. Numeric strings are NOT accepted: a payload that stringifies a
 *  percentage is a payload we do not understand, and guessing is how a bar lies. */
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

const clampPct = (n: number): number => Math.min(100, Math.max(0, n));

/** First defined value among dotted paths — the same idea as the statusline hook's
 *  `first_present`, because the payload's field names have moved between Claude Code versions. */
function firstPresent(o: unknown, paths: string[]): unknown {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p.split('.')) {
      if (!isObj(cur)) { cur = undefined; break; }
      cur = cur[k];
    }
    if (cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

// ── (c) the statusline payload ──────────────────────────────────────────────

/**
 * Read `~/.claude/statusline-payload.json` (already read to a string, or parsed). Field paths and
 * fallbacks mirror hooks/statusline.py, which is the only place the payload's shape is verified
 * against a live Claude Code. Garbage in → `{}` out, never a throw, never an invented zero.
 */
export function parseStatuslinePayload(input: unknown): StatusFields {
  let d: unknown = input;
  if (typeof input === 'string') {
    try { d = JSON.parse(input); } catch { return {}; }
  }
  if (!isObj(d)) return {};

  // context: the reported percentage first; else derive it from tokens and the window size
  let context = num(firstPresent(d, [
    'context_window.used_percentage', 'context_window.percentage_used',
    'context.percentage_used', 'context.usage_pct',
  ]));
  if (context === undefined) {
    const used = num(firstPresent(d, ['context_window.total_input_tokens', 'context.tokens_used']));
    const size = num(firstPresent(d, ['context_window.context_window_size', 'context.window_size']));
    if (used !== undefined && size !== undefined && size > 0) context = (used / size) * 100;
  }

  const five = num(firstPresent(d, [
    'rate_limits.five_hour.used_percentage', 'rate_limits.five_hour.percent_used',
    'session_5h.used_percentage', 'session_5h.usage_pct',
  ]));
  const seven = num(firstPresent(d, [
    'rate_limits.seven_day.used_percentage', 'rate_limits.seven_day.percent_used',
    'rate_limits.weekly.used_percentage', 'weekly.usage_pct',
  ]));

  // `model` is an object ({id, display_name}) in current payloads and a bare string in older ones
  const m = d.model;
  const model = str(firstPresent(d, ['model.display_name', 'model.id'])) ?? str(m);
  const effort = str(firstPresent(d, ['effort.level', 'effort_level', 'effortLevel', 'model.effort_level']));

  const out: StatusFields = {};
  if (five !== undefined) out.fiveHourPct = clampPct(five);
  if (seven !== undefined) out.sevenDayPct = clampPct(seven);
  if (context !== undefined) out.contextPct = clampPct(context);
  if (model !== undefined) out.model = model;
  if (effort !== undefined) out.effort = effort;
  return out;
}

// ── (b) merging the two sources ─────────────────────────────────────────────

const FIELDS = ['fiveHourPct', 'sevenDayPct', 'contextPct', 'model', 'effort'] as const;

/**
 * The live session wins field by field; the file fills what the session cannot know (rate limits
 * and effort are account/CLI facts the SDK stream does not carry). The file is the LAST payload
 * written by ANY Claude Code session on the machine, so for model and context it can describe a
 * different conversation entirely — which is why it is only ever the fallback.
 * `source` says what actually contributed, so the bar can be honest about a stale reading.
 */
export function mergeStatus(sdk: StatusFields | undefined, file: StatusFields | undefined): ChatStatus {
  const out: ChatStatus = { source: sdk ? 'sdk' : 'file' };
  let fromSdk = false;
  let fromFile = false;
  for (const f of FIELDS) {
    const a = sdk?.[f];
    const b = file?.[f];
    if (a !== undefined) { (out as unknown as Obj)[f] = a; fromSdk = true; }
    else if (b !== undefined) { (out as unknown as Obj)[f] = b; fromFile = true; }
  }
  if (fromSdk && fromFile) out.source = 'mixed';
  else if (fromSdk) out.source = 'sdk';
  else if (fromFile) out.source = 'file';
  return out;
}

// ── (a) message → event translation ─────────────────────────────────────────

/** One line saying what a tool call is about — enough to recognise it, not to audit it. */
export function summarizeTool(name: string, input: unknown): string {
  const i = isObj(input) ? input : {};
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) { const v = str(i[k]); if (v) return v; }
    return undefined;
  };
  let s: string | undefined;
  switch (name) {
    case 'Bash': case 'PowerShell': s = pick('command'); break;
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': s = pick('file_path', 'notebook_path', 'path'); break;
    case 'Glob': case 'Grep': s = pick('pattern'); break;
    case 'WebFetch': s = pick('url'); break;
    case 'WebSearch': s = pick('query'); break;
    case 'Skill': s = pick('skill'); break;
    case 'Agent': case 'Task': s = pick('description', 'prompt'); break;
    default: break;
  }
  if (s === undefined) {
    // an unknown tool: its first string argument is the most informative thing we can show
    for (const v of Object.values(i)) { const t = str(v); if (t) { s = t; break; } }
  }
  if (s === undefined) { try { s = JSON.stringify(input) ?? ''; } catch { s = ''; } }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

export interface ChatTranslator {
  /** Feed one SDK message; get the events it produces (possibly none). Never throws. */
  push(msg: unknown): ChatEvent[];
  /** Same, for a raw stream-json line (the CLI fallback). Blank or unparseable lines yield []. */
  pushLine(line: string): ChatEvent[];
  /** Tell the translator the operator interrupted, so the next `result` is flagged as such. */
  noteInterrupt(): void;
  /** What the live session has said about itself so far (model, context). */
  sdkStatus(): StatusFields;
  sessionId(): string | undefined;
}

/** Which of `modelUsage`'s entries describes the model in use. Keys may carry a `[1m]` suffix the
 *  message's own model id lacks, and the map also holds helper models, so match loosely. */
function usageFor(modelUsage: unknown, model: string | undefined): Obj | undefined {
  if (!isObj(modelUsage)) return undefined;
  const keys = Object.keys(modelUsage);
  const base = (k: string): string => k.replace(/\[.*\]$/, '');
  if (model) {
    const k = keys.find((x) => x === model) ?? keys.find((x) => base(x) === base(model));
    if (k && isObj(modelUsage[k])) return modelUsage[k] as Obj;
  }
  return keys.length === 1 && isObj(modelUsage[keys[0]]) ? (modelUsage[keys[0]] as Obj) : undefined;
}

export function createChatTranslator(id: number): ChatTranslator {
  let turnSeq = 0;
  let open: { turnId: string; text: string } | undefined;   // a text block that is streaming right now
  let interrupted = false;
  let sessionId: string | undefined;
  let announcedModel: string | undefined;
  let announcedSession: string | undefined;
  const st: StatusFields = {};
  let lastCtxTokens: number | undefined;
  let ctxWindow: number | undefined;

  const ev = (b: ChatEventBody): ChatEvent => ({ id, ...b }) as ChatEvent;
  const newTurn = (): string => `t${++turnSeq}`;

  function recomputeContext(): void {
    if (lastCtxTokens !== undefined && ctxWindow !== undefined && ctxWindow > 0) {
      st.contextPct = Math.round(clampPct((lastCtxTokens / ctxWindow) * 100));
    }
  }

  function closeOpen(out: ChatEvent[]): void {
    if (!open) return;
    out.push(ev({ type: 'turn-end', turnId: open.turnId, text: open.text }));
    open = undefined;
  }

  function onStreamEvent(m: Obj, out: ChatEvent[]): void {
    if (m.parent_tool_use_id) return;              // a subagent's chatter is not the operator's conversation
    const e = m.event;
    if (!isObj(e) || e.type !== 'content_block_delta' || !isObj(e.delta)) return;
    if (e.delta.type !== 'text_delta') return;     // thinking / tool-input deltas are not shown
    const text = typeof e.delta.text === 'string' ? e.delta.text : '';
    if (!text) return;
    // The turn opens on the first text, not on message_start: an assistant message that only calls
    // tools would otherwise leave an empty bubble behind.
    if (!open) {
      open = { turnId: newTurn(), text: '' };
      out.push(ev({ type: 'turn-start', turnId: open.turnId }));
    }
    open.text += text;
    out.push(ev({ type: 'delta', turnId: open.turnId, text }));
  }

  function onAssistant(m: Obj, out: ChatEvent[]): void {
    if (m.parent_tool_use_id) return;
    const msg = isObj(m.message) ? m.message : {};
    const model = str(msg.model);
    if (model && model !== '<synthetic>') st.model = model;
    const usage = isObj(msg.usage) ? msg.usage : undefined;
    if (usage) {
      const parts = [usage.input_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens].map(num);
      // only trust it when the input side is actually reported; a lone output count is not "context"
      if (parts.some((p) => p !== undefined) && parts[0] !== undefined) {
        lastCtxTokens = parts.reduce<number>((a, p) => a + (p ?? 0), 0);
        recomputeContext();
      }
    }
    const content = Array.isArray(msg.content) ? msg.content : [];
    const texts: string[] = [];
    const tools: { name: string; input: unknown }[] = [];
    for (const b of content) {
      if (!isObj(b)) continue;
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'tool_use') tools.push({ name: str(b.name) ?? 'tool', input: b.input });
    }
    const text = texts.join('');
    let turnId: string | undefined;
    if (text.trim()) {
      if (open) { turnId = open.turnId; open = undefined; }
      else { turnId = newTurn(); out.push(ev({ type: 'turn-start', turnId })); }   // streaming was off
      out.push(ev({ type: 'turn-end', turnId, text }));
    } else if (open) {
      // streamed text that the final message did not echo (should not happen) — still finalise it
      closeOpen(out);
    }
    for (const t of tools) out.push(ev({ type: 'tool', ...(turnId ? { turnId } : {}), name: t.name, summary: summarizeTool(t.name, t.input) }));
    if (m.error) out.push(ev({ type: 'error', code: 'turn-failed', message: String(m.error) }));
  }

  function onSystem(m: Obj, out: ChatEvent[]): void {
    if (m.subtype !== 'init') return;
    sessionId = str(m.session_id) ?? sessionId;
    const model = str(m.model);
    if (model) st.model = model;
    // the SDK repeats init every turn; only tell the renderer when something actually changed
    if (sessionId !== announcedSession || st.model !== announcedModel) {
      announcedSession = sessionId; announcedModel = st.model;
      out.push(ev({ type: 'ready', ...(sessionId ? { sessionId } : {}), ...(st.model ? { model: st.model } : {}) }));
    }
  }

  function onResult(m: Obj, out: ChatEvent[]): void {
    closeOpen(out);
    const wasInterrupted = interrupted;
    interrupted = false;
    const u = usageFor(m.modelUsage, st.model);
    const win = u ? num(u.contextWindow) : undefined;
    if (win !== undefined && win > 0) { ctxWindow = win; recomputeContext(); }
    const isError = m.is_error === true && !wasInterrupted;
    if (isError) {
      const errs = Array.isArray(m.errors) ? (m.errors as unknown[]).filter((x) => typeof x === 'string').join('; ') : '';
      out.push(ev({ type: 'error', code: 'turn-failed', message: errs || str(m.result) || str(m.subtype) || 'turn failed' }));
    }
    out.push(ev({ type: 'result', isError, ...(wasInterrupted ? { interrupted: true } : {}) }));
  }

  /**
   * Plan usage as the live session reports it. MEASURED against a real session: `utilization` is a
   * FRACTION (0.77 = 77%), and the event carries both windows under `unifiedWindows`, so one event
   * refreshes the 5-hour and the weekly reading together. It is also fresher than the statusline
   * file, which is only rewritten when some terminal session repaints its status line.
   */
  function onRateLimit(m: Obj): void {
    const info = isObj(m.rate_limit_info) ? m.rate_limit_info : undefined;
    if (!info) return;
    const frac = (v: unknown): number | undefined => { const n = num(v); return n === undefined ? undefined : Math.round(clampPct(n * 100)); };
    const w = isObj(info.unifiedWindows) ? info.unifiedWindows : undefined;
    const five = frac(isObj(w?.five_hour) ? (w?.five_hour as Obj).utilization : undefined)
      ?? (info.rateLimitType === 'five_hour' ? frac(info.utilization) : undefined);
    const seven = frac(isObj(w?.seven_day) ? (w?.seven_day as Obj).utilization : undefined)
      ?? (info.rateLimitType === 'seven_day' ? frac(info.utilization) : undefined);
    if (five !== undefined) st.fiveHourPct = five;
    if (seven !== undefined) st.sevenDayPct = seven;
  }

  function push(msg: unknown): ChatEvent[] {
    const out: ChatEvent[] = [];
    try {
      if (!isObj(msg)) return out;
      switch (msg.type) {
        case 'stream_event': onStreamEvent(msg, out); break;
        case 'assistant': onAssistant(msg, out); break;
        case 'system': onSystem(msg, out); break;
        case 'result': onResult(msg, out); break;
        case 'rate_limit_event': onRateLimit(msg); break;
        default: break;
      }
    } catch { /* a malformed message must not take the conversation down */ }
    return out;
  }

  return {
    push,
    pushLine(line: string): ChatEvent[] {
      const s = line.trim();
      if (!s) return [];
      try { return push(JSON.parse(s)); } catch { return []; }
    },
    noteInterrupt(): void { interrupted = true; },
    sdkStatus(): StatusFields { return { ...st }; },
    sessionId(): string | undefined { return sessionId; },
  };
}

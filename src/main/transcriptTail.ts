import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { createTranscriptTracker, type ChatItem, type TranscriptTracker, type TranscriptUsage } from '../core/transcriptChat';
import { projectsDir } from './usageIo';

/**
 * Chat skin — follow a session's transcript file live and turn it into chat events.
 *
 * Imports nothing from electron: the file location is injected and every event leaves through the
 * callback given to `watch`, so the whole thing runs (and is tested) under plain node.
 *
 * What it has to survive, all of which happen to real transcripts:
 *  - the file does not exist yet (a brand-new session writes its first line seconds after launch),
 *    so locating it is retried instead of failing once;
 *  - the writer appends a line in two writes, so a read can end mid-line — the tail is held back
 *    until its newline arrives (and a multi-byte character split across reads is decoded whole);
 *  - the file is large (tens of MB with the request blobs), so backfill is chunked and async, and
 *    never blocks the main process;
 *  - the file is truncated or replaced, in which case the view is reset and re-read from the top;
 *  - `fs.watch` is unreliable (coalesced, missed after a replace, EMFILE), so a slow poll runs
 *    alongside it and is the guarantee; the watcher only makes it quicker.
 * Nothing is left behind: `unwatch` clears the fs watcher and the timer, and a read in flight
 * notices and stops emitting.
 */

export type TailEvent =
  | { type: 'reset' }
  | { type: 'items'; items: ChatItem[] }
  | { type: 'turn'; open: boolean }
  | { type: 'usage'; contextTokens?: number; model?: string }
  | { type: 'missing' }
  | { type: 'error'; code: string };

export type TailEmit = (ev: { paneId: number } & TailEvent) => void;

export type WatchResult = { ok: true; file: string } | { ok: false; error: 'not-found' | 'bad-id' };

export interface TailOptions {
  /** Claude Code's projects folder. Defaults to the one honouring CLAUDE_CONFIG_DIR. */
  projectsDir?: () => string;
  /** Poll period. Also how often a missing file is searched for (slower after a while). */
  pollMs?: number;
  /** Bytes per backfill read. */
  chunkBytes?: number;
}

export interface TranscriptTail {
  watch(paneId: number, sessionId: string, onEvent: TailEmit): Promise<WatchResult>;
  unwatch(paneId: number): void;
  /** Read whatever the writer flushed last, THEN stop — for a session that just exited. */
  finish(paneId: number): Promise<void>;
  unwatchAll(): void;
  /** Pane ids with a live watcher — what a leak test (and the quit path) asks. */
  active(): number[];
}

/** The id becomes part of a PATH, so anything that is not id-shaped is refused before it is joined. */
export const isSessionId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9-]{8,}$/.test(s);

/**
 * Find `<base>/<any project folder>/<sessionId>.jsonl`. The project folder is the cwd slug, which
 * the caller usually does not know (the session may have been resumed from another folder), so
 * every subdirectory is tried.
 */
export async function locateTranscript(base: string, sessionId: string): Promise<string | undefined> {
  if (!isSessionId(sessionId)) return undefined;
  let dirs: fs.Dirent[];
  try { dirs = await fs.promises.readdir(base, { withFileTypes: true }); } catch { return undefined; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(base, d.name, `${sessionId}.jsonl`);
    try { await fs.promises.access(f); return f; } catch { /* not in this folder */ }
  }
  return undefined;
}

interface Watcher {
  paneId: number;
  sessionId: string;
  emit: TailEmit;
  tracker: TranscriptTracker;
  file?: string;
  ino?: number;
  offset: number;
  rest: string;
  decoder: StringDecoder;
  fsw?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  closed: boolean;
  reading: boolean;
  again: boolean;
  /** True from "file located / reset" until the backfill pass ends: only items are streamed then. */
  syncing: boolean;
  missingSent: boolean;
  polls: number;
}

export function createTranscriptTail(opts: TailOptions = {}): TranscriptTail {
  const base = (): string => (opts.projectsDir ?? projectsDir)();
  const pollMs = opts.pollMs ?? 1000;
  const chunk = Math.max(4096, opts.chunkBytes ?? 1024 * 1024);
  const watchers = new Map<number, Watcher>();

  const emit = (w: Watcher, ev: TailEvent): void => {
    if (w.closed) return;
    try { w.emit({ paneId: w.paneId, ...ev }); } catch { /* the window is gone; nothing to tell */ }
  };

  function closeFsWatcher(w: Watcher): void {
    try { w.fsw?.close(); } catch { /* already closed */ }
    w.fsw = undefined;
  }

  function startFsWatcher(w: Watcher): void {
    closeFsWatcher(w);
    if (!w.file) return;
    try {
      // 'rename' means the inode went away (replace/delete): re-arm on the next pump
      w.fsw = fs.watch(w.file, (kind) => { if (kind === 'rename') closeFsWatcher(w); void pump(w); });
      w.fsw.on('error', () => closeFsWatcher(w));   // polling still covers us
    } catch { /* EMFILE, or the file vanished: the poll is the guarantee */ }
  }

  /** (Re)start reading from the top: the view is told to empty itself first. */
  function rewind(w: Watcher): void {
    w.tracker.reset();
    w.offset = 0;
    w.rest = '';
    w.decoder = new StringDecoder('utf8');
    w.syncing = true;
    emit(w, { type: 'reset' });
  }

  function flush(w: Watcher, lines: string[]): void {
    if (lines.length === 0) return;
    const u = w.tracker.feedAll(lines);
    if (u.items.length) emit(w, { type: 'items', items: u.items });
    // while backfilling, the flips of a whole history are noise; the end state is announced once
    if (w.syncing) return;
    if (u.turnOpen !== undefined) emit(w, { type: 'turn', open: u.turnOpen });
    if (u.usage) emit(w, { type: 'usage', ...usageFields(u.usage) });
  }

  const usageFields = (u: TranscriptUsage): { contextTokens?: number; model?: string } => ({
    ...(u.contextTokens !== undefined ? { contextTokens: u.contextTokens } : {}),
    ...(u.model !== undefined ? { model: u.model } : {}),
  });

  async function readTo(w: Watcher, size: number): Promise<void> {
    if (!w.file) return;
    const fh = await fs.promises.open(w.file, 'r');
    try {
      while (!w.closed && w.offset < size) {
        const buf = Buffer.alloc(Math.min(chunk, size - w.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, w.offset);
        if (bytesRead === 0) break;
        w.offset += bytesRead;
        const text = w.rest + w.decoder.write(buf.subarray(0, bytesRead));
        const lines = text.split('\n');
        w.rest = lines.pop() ?? '';        // the unfinished tail waits for its newline
        flush(w, lines);
      }
    } finally { await fh.close(); }
  }

  async function locate(w: Watcher): Promise<boolean> {
    if (w.file) return true;
    const f = await locateTranscript(base(), w.sessionId);
    if (w.closed) return false;
    if (!f) {
      if (!w.missingSent) { w.missingSent = true; emit(w, { type: 'missing' }); }
      return false;
    }
    w.file = f;
    w.ino = undefined;
    rewind(w);
    startFsWatcher(w);
    return true;
  }

  async function pump(w: Watcher): Promise<void> {
    if (w.closed) return;
    if (w.reading) { w.again = true; return; }
    w.reading = true;
    try {
      do {
        w.again = false;
        if (!(await locate(w))) break;
        let st: fs.Stats;
        try { st = await fs.promises.stat(w.file as string); }
        catch {
          // deleted under us: forget the file and go back to searching (a new one may appear)
          closeFsWatcher(w); w.file = undefined; w.missingSent = false; w.ino = undefined;
          break;
        }
        if (w.ino !== undefined && (st.ino !== w.ino || st.size < w.offset)) {
          rewind(w);                       // replaced or truncated: the old offset means nothing
          startFsWatcher(w);
        }
        w.ino = st.ino;
        if (!w.fsw) startFsWatcher(w);
        if (st.size > w.offset) await readTo(w, st.size);
        if (w.syncing && !w.closed) {
          w.syncing = false;
          const s = w.tracker.snapshot();
          emit(w, { type: 'turn', open: s.turnOpen });
          if (s.usage.contextTokens !== undefined || s.usage.model !== undefined) emit(w, { type: 'usage', ...usageFields(s.usage) });
        }
      } while (w.again && !w.closed);
    } catch {
      emit(w, { type: 'error', code: 'read-failed' });
    } finally { w.reading = false; }
  }

  function stop(w: Watcher): void {
    w.closed = true;
    if (w.timer) clearInterval(w.timer);
    w.timer = undefined;
    closeFsWatcher(w);
    if (watchers.get(w.paneId) === w) watchers.delete(w.paneId);
  }

  function unwatch(paneId: number): void {
    const w = watchers.get(paneId);
    if (w) stop(w);
  }

  async function finish(paneId: number): Promise<void> {
    const w = watchers.get(paneId);
    if (!w) return;
    // A session's last lines (the closing answer, turn_duration) land right before its pty exits,
    // usually before the poll has seen them. Wait out a read in flight, take one more pass, stop.
    for (let i = 0; i < 100 && w.reading && !w.closed; i++) await new Promise((r) => setTimeout(r, 20));
    if (!w.closed) await pump(w);
    stop(w);
  }

  async function watch(paneId: number, sessionId: string, onEvent: TailEmit): Promise<WatchResult> {
    unwatch(paneId);                       // a pane follows one session at a time
    if (!isSessionId(sessionId)) return { ok: false, error: 'bad-id' };
    const w: Watcher = {
      paneId, sessionId, emit: onEvent, tracker: createTranscriptTracker(),
      offset: 0, rest: '', decoder: new StringDecoder('utf8'),
      closed: false, reading: false, again: false, syncing: true, missingSent: false, polls: 0,
    };
    watchers.set(paneId, w);
    // The poll is the guarantee. A session that never writes a transcript (a shell, a claude that
    // never started) is searched for less and less often instead of every second forever.
    w.timer = setInterval(() => {
      w.polls++;
      if (!w.file && w.polls > 30 && w.polls % 5 !== 0) return;
      void pump(w);
    }, pollMs);
    w.timer.unref?.();
    // Hold the read lock while locating, or the first poll tick can locate the same file at the same
    // time and the view gets two resets. A tick that lands meanwhile just asks for another pass.
    w.reading = true;
    let found = false;
    try { found = await locate(w); } finally { w.reading = false; }
    if (w.closed) return { ok: false, error: 'not-found' };   // unwatched while we looked
    void pump(w);                          // backfill streams after this returns
    return found ? { ok: true, file: w.file as string } : { ok: false, error: 'not-found' };
  }

  return {
    watch,
    unwatch,
    finish,
    unwatchAll(): void { for (const w of [...watchers.values()]) stop(w); },
    active(): number[] { return [...watchers.keys()]; },
  };
}

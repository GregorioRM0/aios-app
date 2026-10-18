/**
 * A conditional `kill`: `expect` names what the writer saw when it decided the session was done,
 * and the surface refuses the kill when the session no longer matches.
 *
 * Why it exists: a writer that closes a finished session checks it first (idle, nothing new in its
 * transcript) and then drops a `kill`. Between that check and the surface acting on the request
 * there is a window — seconds when the surface is live, longer when the request waits — and an
 * operator who writes to the session inside it loses the turn they just typed. The surface acts at
 * the moment of the kill, so it compares what the writer saw against the registry and the
 * transcript immediately before the SIGTERM. That REDUCES the risk; it does not remove it: between
 * reading the transcript and the signal there is still a (much smaller) window.
 *
 *   { "action": "kill", "name": "worker", "surface": "app",
 *     "expect": { "sessionId": "<uuid>", "status": "idle", "idleSince": "2026-10-18T09:00:00.000Z" } }
 *
 *   sessionId   the registry's sessionId for that name. A different one means another session
 *               holds the name now.
 *   status      the registry status the writer saw (normally `idle`).
 *   idleSince   the timestamp of the last user/assistant record the writer saw, copied as it appears
 *               in the transcript. Full date and time with `Z` or an explicit offset, at most
 *               millisecond precision; anything looser is refused rather than guessed.
 *
 * Every key is optional, but `expect` itself must carry at least one, and an unknown key or an
 * unusable value refuses the whole request: a guard the surface cannot honour must never be
 * dropped silently, because the kill that follows is exactly the one the writer asked to avoid.
 * Anything this module cannot verify — a request it cannot re-read, a transcript that is malformed,
 * cut mid-line or has no datable turn — refuses the kill too. A refused kill is dead-lettered
 * naming why, and nothing is killed.
 *
 * Only `kill` reads it. A request without `expect` behaves exactly as before. A surface that does
 * not check it (Glass, an older App) ignores the field and kills unconditionally, so a writer that
 * depends on the guard confirms support first: this App lists KILL_EXPECT_CAPABILITY under
 * `capabilities` in its presence file (`~/.aios/surfaces/app.json`), which counts only while the
 * pid in that file is alive. With it confirmed, the writer addresses the kill to `"surface":"app"`
 * so no other surface can take it; without it, the writer should not send the kill at all.
 */

/** The capability this App declares in its presence file when it honours `expect` on kill. */
export const KILL_EXPECT_CAPABILITY = 'kill-expect';

/** Does a parsed presence record (with its pid already checked alive) declare `kill-expect`? */
export function presenceHonoursExpect(rec: unknown): boolean {
  if (!rec || typeof rec !== 'object') return false;
  const caps = (rec as { capabilities?: unknown }).capabilities;
  return Array.isArray(caps) && caps.includes(KILL_EXPECT_CAPABILITY);
}

export interface KillExpect {
  sessionId?: string;
  status?: string;
  idleSince?: number;   // epoch ms
}

export type KillExpectParse =
  | { ok: true; expect?: KillExpect }
  | { ok: false; reason: string };

const KEYS = ['sessionId', 'status', 'idleSince'];

/* Full date-time with a zone, at most millisecond precision. Date.parse alone accepts '2026',
   zoneless times (read as LOCAL time) and microseconds it silently truncates. */
const ISO_ZONED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

/** Parse a zoned ISO timestamp to epoch ms; NaN for anything ambiguous or impossible. */
export function parseZonedIso(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const m = ISO_ZONED.exec(s);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, se, , z] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +h > 23 || +mi > 59 || +se > 59) return NaN;
  if (z !== 'Z' && (+z.slice(1, 3) > 23 || +z.slice(4, 6) > 59)) return NaN;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return NaN;
  /* Date.parse rolls 2026-02-30 over to March; the calendar day must survive the round trip. */
  const off = z === 'Z' ? 0 : (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(4, 6));
  const local = new Date(t + off * 60000);
  if (local.getUTCFullYear() !== +y || local.getUTCMonth() + 1 !== +mo || local.getUTCDate() !== +d) return NaN;
  return t;
}

/** Read `expect` from a raw request body. Absent → no guard. */
export function parseKillExpect(body: Record<string, unknown>): KillExpectParse {
  if (!('expect' in body) || body.expect === undefined) return { ok: true };
  const e = body.expect;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, reason: 'expect must be an object' };
  const raw = e as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((k) => !KEYS.includes(k));
  if (unknown.length) return { ok: false, reason: `expect has unknown key(s): ${unknown.join(', ')} — this surface checks ${KEYS.join(', ')}` };
  const out: KillExpect = {};
  if (raw.sessionId !== undefined) {
    if (typeof raw.sessionId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(raw.sessionId)) return { ok: false, reason: `expect.sessionId '${String(raw.sessionId)}' is not a session id` };
    out.sessionId = raw.sessionId;
  }
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || !/^[a-z_-]{1,32}$/.test(raw.status.trim())) return { ok: false, reason: `expect.status '${String(raw.status)}' is not a registry status` };
    out.status = raw.status.trim();
  }
  if (raw.idleSince !== undefined) {
    const t = parseZonedIso(raw.idleSince);
    if (!Number.isFinite(t)) return { ok: false, reason: `expect.idleSince '${String(raw.idleSince)}' is not a full ISO date-time with Z or an offset (at most milliseconds)` };
    out.idleSince = t;
  }
  if (!Object.keys(out).length) return { ok: false, reason: `expect is empty — name at least one of ${KEYS.join(', ')}` };
  return { ok: true, expect: out };
}

/** The fields of a held kill that decide what it does. The rest is the fulfillers' bookkeeping. */
const DECIDING = ['action', 'name', 'surface', 'expect'];

/* JSON with sorted keys, so two bodies compare by content rather than by key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

/**
 * Re-read the held request and confirm it is still the one that was claimed: the same `action`,
 * `name`, `surface` and `expect`, compared in depth. The guard itself never comes from this read —
 * it comes from the body parsed when the request was claimed — because a request rewritten in
 * between (down to `{}`) would otherwise parse as "no guard" and authorise the very kill the writer
 * guarded. ANY failure — the file gone, unreadable, not JSON, not an object, changed — refuses.
 */
export function heldUnchanged(original: Record<string, unknown>, readRaw: () => string): { ok: true } | { ok: false; reason: string } {
  let raw: string;
  try { raw = readRaw(); } catch (e) { return { ok: false, reason: `the held request could not be re-read (${(e as Error)?.message ?? e})` }; }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return { ok: false, reason: 'the held request is no longer valid JSON' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'the held request is not a JSON object' };
  const now = body as Record<string, unknown>;
  const changed = DECIDING.filter((k) => canonical(original[k]) !== canonical(now[k]));
  if (changed.length) return { ok: false, reason: `the held request changed since it was claimed (${changed.join(', ')})` };
  return { ok: true };
}

export type LastTurn = { ok: true; at: number } | { ok: false; reason: string };

/**
 * The newest user/assistant record in a transcript, or why it cannot be known. Indeterminate —
 * and so a refusal — when the text is empty, when any line is not JSON, when the last line is cut
 * (no trailing newline: the session may be writing right now), when a turn carries no valid
 * timestamp, or when there is no turn at all. Measured on eleven live transcripts (3.6–52 MB):
 * none had a malformed line, a missing trailing newline or an undated turn, so a healthy idle
 * session always passes.
 */
export function lastTurnAt(transcript: string): LastTurn {
  if (!transcript) return { ok: false, reason: 'the transcript is empty or could not be read' };
  if (!transcript.endsWith('\n')) return { ok: false, reason: 'the transcript ends mid-line (it may be being written)' };
  let last = 0;
  let n = 0;
  const lines = transcript.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let r: unknown;
    try { r = JSON.parse(line); } catch { return { ok: false, reason: `transcript line ${i + 1} is not valid JSON` }; }
    if (!r || typeof r !== 'object') return { ok: false, reason: `transcript line ${i + 1} is not a record` };
    const rec = r as { type?: unknown; timestamp?: unknown };
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const t = parseZonedIso(rec.timestamp);
    if (!Number.isFinite(t)) return { ok: false, reason: `transcript line ${i + 1} is a ${rec.type} turn without a valid timestamp` };
    n++;
    if (t > last) last = t;
  }
  if (!n) return { ok: false, reason: 'the transcript has no user/assistant turn to compare against' };
  return { ok: true, at: last };
}

export type KillVerdict = { kill: true } | { kill: false; reason: string };

/**
 * Decide, at the moment of the kill, whether the target still matches what the writer saw.
 * `target` is the live registry entry (undefined when nothing live holds the name — then there is
 * no session to protect, and the kill goes ahead as it always did). `transcript` is read only when
 * `idleSince` asks for it.
 */
export function killVerdict(
  expect: KillExpect | undefined,
  target: { status: string; sessionId: string } | undefined,
  transcript: () => string,
): KillVerdict {
  if (!expect || !target) return { kill: true };
  if (expect.sessionId !== undefined && target.sessionId !== expect.sessionId) {
    return { kill: false, reason: `expect.sessionId ${expect.sessionId} but the name is now held by ${target.sessionId || 'a session with no id'}` };
  }
  if (expect.status !== undefined && target.status !== expect.status) {
    return { kill: false, reason: `expect.status '${expect.status}' but the session is '${target.status || 'unknown'}'` };
  }
  if (expect.idleSince !== undefined) {
    let text: string;
    try { text = transcript(); } catch { text = ''; }
    const last = lastTurnAt(text);
    if (!last.ok) return { kill: false, reason: `expect.idleSince cannot be checked: ${last.reason}` };
    if (last.at > expect.idleSince) {
      return { kill: false, reason: `the session had a turn at ${new Date(last.at).toISOString()}, after expect.idleSince ${new Date(expect.idleSince).toISOString()}` };
    }
  }
  return { kill: true };
}

/**
 * The whole decision the dispatcher makes for a kill. `original` is the request body as it was
 * parsed when this surface claimed it, and the guard comes from there; the held file is re-read
 * only to confirm it has not changed. The dispatcher sends the SIGTERM only on `{ kill: true }`,
 * so every failure on the way ends in a refusal.
 */
export function decideKill(
  original: Record<string, unknown>,
  readHeld: () => string,
  target: { status: string; sessionId: string } | undefined,
  transcript: () => string,
): KillVerdict {
  const ex = parseKillExpect(original);
  if (!ex.ok) return { kill: false, reason: `kill refused — ${ex.reason}; nothing was killed` };
  const same = heldUnchanged(original, readHeld);
  if (!same.ok) return { kill: false, reason: `kill refused — ${same.reason}; nothing was killed` };
  const v = killVerdict(ex.expect, target, transcript);
  return v.kill ? v : { kill: false, reason: `kill refused by expect — ${v.reason}; the session was left running` };
}

/**
 * A conditional `kill`: `expect` names what the writer saw when it decided the session was done,
 * and the surface refuses the kill when the session no longer matches.
 *
 * Why it exists: a writer that closes a finished session checks it first (idle, nothing new in its
 * transcript) and then drops a `kill`. Between that check and the surface acting on the request
 * there is a window — seconds when the surface is live, longer when the request waits — and an
 * operator who writes to the session inside it loses the turn they just typed. Only the surface
 * can close that window, because only the surface acts at the moment of the kill. So the writer
 * says what it saw, and the surface compares it against the registry and the transcript
 * immediately before the SIGTERM.
 *
 *   { "action": "kill", "name": "worker",
 *     "expect": { "sessionId": "<uuid>", "status": "idle", "idleSince": "2026-10-18T09:00:00.000Z" } }
 *
 *   sessionId   the registry's sessionId for that name. A different one means another session
 *               holds the name now.
 *   status      the registry status the writer saw (normally `idle`).
 *   idleSince   the timestamp of the last user/assistant record the writer saw. A newer one in the
 *               transcript means someone talked to the session since.
 *
 * Every key is optional, but `expect` itself must carry at least one, and an unknown key or an
 * unusable value refuses the whole request: a guard the surface cannot honour must never be
 * dropped silently, because the kill that follows is exactly the one the writer asked to avoid.
 * A refused kill is dead-lettered naming what changed, and nothing is killed.
 *
 * Only `kill` reads it. A request without `expect` behaves exactly as before.
 */

export interface KillExpect {
  sessionId?: string;
  status?: string;
  idleSince?: number;   // epoch ms
}

export type KillExpectParse =
  | { ok: true; expect?: KillExpect }
  | { ok: false; reason: string };

const KEYS = ['sessionId', 'status', 'idleSince'];

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
    const t = typeof raw.idleSince === 'string' ? Date.parse(raw.idleSince) : NaN;
    if (!Number.isFinite(t)) return { ok: false, reason: `expect.idleSince '${String(raw.idleSince)}' is not an ISO timestamp` };
    out.idleSince = t;
  }
  if (!Object.keys(out).length) return { ok: false, reason: `expect is empty — name at least one of ${KEYS.join(', ')}` };
  return { ok: true, expect: out };
}

/** The newest user/assistant record in a transcript, as epoch ms; 0 when there is none. */
export function lastTurnAt(transcript: string): number {
  let last = 0;
  for (const line of transcript.split('\n')) {
    if (!line.includes('"timestamp"')) continue;
    let r: { type?: unknown; timestamp?: unknown };
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(t) && t > last) last = t;
  }
  return last;
}

export type KillVerdict = { kill: true } | { kill: false; reason: string };

/**
 * Decide, at the moment of the kill, whether the target still matches what the writer saw.
 * `target` is the live registry entry (undefined when nothing live holds the name — then there is
 * no session to protect, and the kill goes ahead as it always did). `transcript` is read only when
 * `idleSince` asks for it; an empty one cannot prove the session stayed quiet, so it refuses.
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
    const text = transcript();
    if (!text) return { kill: false, reason: 'expect.idleSince given but the transcript could not be read' };
    const last = lastTurnAt(text);
    if (last > expect.idleSince) {
      return { kill: false, reason: `the session had a turn at ${new Date(last).toISOString()}, after expect.idleSince ${new Date(expect.idleSince).toISOString()}` };
    }
  }
  return { kill: true };
}

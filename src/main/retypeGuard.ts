import { verifyVerdict } from '../core/sendQueue';

/**
 * Re-type, or has the earlier type already landed? Asked right before EVERY re-type.
 *
 * 26 Oct 2026, measured: a send went to a session that turned busy during verification. The
 * verdict was 'wait', the loop held until the target was idle again, and then typed the message a
 * second time, because the late-arrival check ran only once the attempts were spent. By then the
 * first copy was in the transcript: the operator got the same message twice, 33 s apart, and the
 * App's own counter logged DUPLICATE DELIVERY. A busy target finishes its turn and writes the text
 * it was given; the only safe moment to decide on a re-type is after re-reading.
 *
 * App-only on purpose: core/sendQueue.ts is pinned byte-for-byte to the Glass fulfiller
 * (protocolContract SENDQUEUE_SHA). This changes no decision table, only when the App re-reads.
 */
export function landedBeforeRetype(typedOnce: boolean, before: number, now: number): boolean {
  return typedOnce && verifyVerdict(before, now) !== 'pending';
}

/**
 * #81 (an operator saw sessions "jump in" while typing). Is the operator writing in the target's
 * pane? The renderer reports its own keystrokes: composing = keys since the last Enter / Ctrl-C; `at` = the last key. A bus message is never typed into a draft (it lands inside it), so
 * the bus treats a composing target like a busy one: it holds, through its own budgets and
 * readiness checks, and never types from anywhere else.
 */
export const COMPOSE_QUIET_MS = 8000;
/** A draft with no key for this long is abandoned, not being written: a lone Esc, Shift-Tab or a digit
 *  answering a prompt leaves "composing" set with no Enter to clear it, and at 30 min (or never, in the
 *  pane) that held a session's messages for up to the queue's 24 h ceiling, silently. 3 min covers a
 *  real pause mid-sentence. The pane's own check uses the same limit (renderer BUS_COMPOSE_STALE_MS). */
export const COMPOSE_STALE_MS = 3 * 60 * 1000;
export function operatorComposing(rec: { composing: boolean; at: number } | undefined, now: number): boolean {
  return !!rec && ((rec.composing && now - rec.at < COMPOSE_STALE_MS) || now - rec.at < COMPOSE_QUIET_MS);
}

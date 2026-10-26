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
 * #81 (Luigi, 26 Oct: "sessions jump in" while he types). Is the operator writing in the target's
 * pane? The renderer reports its own keystrokes: composing = keys since the last Enter / Ctrl-C /
 * Ctrl-U; `at` = the last key. A bus message is never typed into a draft (it lands inside it), so
 * the bus treats a composing target like a busy one: it holds, through its own budgets and
 * readiness checks, and never types from anywhere else.
 */
export const COMPOSE_QUIET_MS = 8000;
export function operatorComposing(rec: { composing: boolean; at: number } | undefined, now: number): boolean {
  return !!rec && (rec.composing || now - rec.at < COMPOSE_QUIET_MS);
}

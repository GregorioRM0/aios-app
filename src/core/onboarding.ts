/**
 * The Onboarding flow — the pure model behind the sequenced onboarding stepper.
 *
 * Gated steps, each VERIFIED by doctor checks (the Batch-D CheckResult
 * shape): a step is done only when every required check passes. The first
 * not-done step is `active` (its buttons are live); everything after is
 * `locked`. Optional checks (node) surface but never gate.
 *
 * Pure by design (no fs, no exec, no electron): aios.ts feeds it real
 * CheckResults; tests feed it fabricated ones.
 */

export interface OnboardingCheckLike { id: string; status: 'pass' | 'warn' | 'fail'; }

export interface OnboardingStepSpec {
  id: string;
  /** Doctor-check ids that must ALL pass for the step to be done. */
  required: string[];
  /** Shown on the step but never gates it (e.g. node — warn-only). */
  optional?: string[];
  /** The operator may pass it with "Skip for now"; a skipped step counts as done. */
  skippable?: boolean;
}

/** The sequence. FOUR steps, and the third is a conversation.
 *
 *  It was seven. The operator who walked it named the problem exactly: every extra box is a
 *  decision handed to someone who has no basis for making it. "Starter pack" was the proof —
 *  they read it, clicked it, and still could not say what it had done. If the person who
 *  commissioned the feature cannot explain it at the moment of use, a newcomer certainly cannot.
 *
 *  So the app owns only what a script does better than a conversation — install, sign in,
 *  authorize — and everything downstream of "Claude runs" belongs to
 *  the setup session: the vault (fresh or cloned — a question worth ASKING, not two buttons),
 *  the wiring, the frequent tasks, the interview. That work needs judgment, and a session can
 *  ask a follow-up where a button can only guess.
 *
 *  The vault, wiring and starter checks did not disappear — they hang off the final step as
 *  `optional`, so they still show what has landed and what has not, without gating on anything
 *  the session is in the middle of doing. `personalized` is the only gate: evidence that this
 *  AIOS became someone's (see core/personalized.ts).
 */
export const ONBOARDING_STEPS: OnboardingStepSpec[] = [
  { id: 'prereqs', required: ['git', 'claude'], optional: ['node', 'psPolicy'] },
  { id: 'login', required: ['account'] },
  /* GitHub BEFORE the setup session, and SKIPPABLE (operator decision, 0.11.0 test). #51 moved it
     last because, while it was a hard gate in front of setup, a Mac with no Homebrew stalled on it
     and never reached "Set up my AIOS" — GitHub buys an off-machine backup, and nothing upstream
     needs it (SETUP.md: "never a gate"). The operator's point stands too: connected first, the vault
     is backed up from its first day, and Claude is already signed in to help if `gh` gets stuck.
     "Skip for now" keeps #51's guarantee — this step can never block the conversation. */
  { id: 'github', required: ['gh'], skippable: true },
  {
    id: 'firstrun',
    required: ['personalized'],
    optional: ['framework', 'vault', 'skills', 'mcpObsidian', 'spawn', 'plugin', 'hooks', 'starter'],
  },
];

export interface OnboardingStepState<C extends OnboardingCheckLike = OnboardingCheckLike> {
  id: string;
  done: boolean;
  state: 'done' | 'active' | 'locked';
  /** Required checks first (spec order), then optional ones. */
  checks: C[];
  required: string[];
  optional: string[];
  /** Passed with "Skip for now" rather than by its checks. */
  skipped: boolean;
}

export interface OnboardingDerived<C extends OnboardingCheckLike = OnboardingCheckLike> {
  steps: OnboardingStepState<C>[];
  /** Index of the active step; steps.length when everything is done. */
  current: number;
}

/** Derive the stepper from one battery of check results. Idempotent + honest:
 *  re-running never "re-does" anything — done is only what re-verifies as done. */
export function deriveOnboarding<C extends OnboardingCheckLike>(checks: C[], skipped: ReadonlySet<string> = new Set()): OnboardingDerived<C> {
  const by = new Map<string, C>(checks.map((c) => [c.id, c]));
  const steps: OnboardingStepState<C>[] = ONBOARDING_STEPS.map((s) => {
    const req = s.required.map((id) => by.get(id)).filter((c): c is C => !!c);
    const opt = (s.optional ?? []).map((id) => by.get(id)).filter((c): c is C => !!c);
    // A missing required check can never read as done — absent evidence ≠ pass.
    const passed = req.length === s.required.length && req.every((c) => c.status === 'pass');
    const wasSkipped = !passed && !!s.skippable && skipped.has(s.id);
    return { id: s.id, done: passed || wasSkipped, state: 'locked', checks: [...req, ...opt], required: s.required, optional: s.optional ?? [], skipped: wasSkipped };
  });
  let current = steps.findIndex((s) => !s.done);
  if (current < 0) current = steps.length;
  for (let i = 0; i < steps.length; i++) {
    steps[i].state = steps[i].done ? 'done' : i === current ? 'active' : 'locked';
  }
  return { steps, current };
}

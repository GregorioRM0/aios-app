/**
 * AI-195 — the advisor. Facts from Claude Code 2.1.296's own source, not inferred:
 *  - advisor choices are the aliases fable · opus · sonnet (filtered by what the account has);
 *    the setting is `advisorModel` (alias or id); absent = no advisor.
 *  - "the advisor must be at least as capable as the main model" — otherwise it is NOT USED.
 *    MEASURED: an Opus 5.5 session with advisorModel "sonnet" shows nothing on screen and writes
 *    nothing to its transcript (only Claude's debug log says it), so the operator would believe an
 *    advisor is reviewing their work while none is. That silence is what this module exists for.
 */
export const ADVISOR_OPTIONS = ['fable', 'opus', 'sonnet'] as const;

const RANK: [RegExp, number][] = [[/fable/i, 4], [/opus/i, 3], [/sonnet/i, 2], [/haiku/i, 1]];
export function familyRank(model: string): number | undefined {
  for (const [re, n] of RANK) if (re.test(String(model ?? ''))) return n;
  return undefined;
}

/**
 * Can `advisor` advise `main`? `undefined` when either side is unknown (an unset main model is
 * Claude's own default, which the App cannot rank) — never a guess in either direction.
 */
export function canAdvise(advisor: string, main: string): boolean | undefined {
  if (!advisor) return undefined;
  const a = familyRank(advisor), m = familyRank(main);
  if (a === undefined || m === undefined) return undefined;
  return a >= m;
}

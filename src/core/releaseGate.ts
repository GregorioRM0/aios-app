/**
 * The all-or-nothing release gate (operator's decision, 0.11.0).
 *
 * The old order: macOS created the Release PUBLIC, then Linux and Windows attached to it. A Mac
 * failure could never ship without Mac, but the reverse was open — Mac publishes, Linux or Windows
 * then fails, and the release is live with only Mac's feed, so every Windows/Linux updater fails
 * against the newest release until someone repairs it by hand.
 *
 * Now macOS creates it as a DRAFT (electron-updater ignores drafts, so nobody sees it), every lane
 * attaches to the draft, and each lane ends by asking this function whether the set is complete.
 * Whichever lane completes it publishes. A missing manifest is not a failure here — another lane
 * may still be running — it simply leaves the draft a draft. Pure.
 */
export const REQUIRED_MANIFESTS = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml'] as const;

export type GateDecision =
  | { do: 'publish' }
  | { do: 'wait'; missing: string[] }
  | { do: 'already-public' };

export function gateDecision(release: { isDraft: boolean; assets: string[] }): GateDecision {
  if (!release.isDraft) return { do: 'already-public' };
  const have = new Set(release.assets);
  const missing = REQUIRED_MANIFESTS.filter((m) => !have.has(m));
  return missing.length ? { do: 'wait', missing } : { do: 'publish' };
}

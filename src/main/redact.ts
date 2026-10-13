/**
 * Review should-fix 12 — "Report this" writes a tab's scrollback to a local file for `aios-feedback`.
 * The agent is told to scrub before anything leaves the machine, but the App must not depend on
 * that: the file itself is written already redacted. Token SHAPES, not a list of known values —
 * the App never knows the secrets it is protecting. Pure.
 */
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[redacted github token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted github token]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, '[redacted anthropic key]'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted api key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted slack token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted aws key]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[redacted google key]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]'],
  [/\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi, '$1[redacted]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
];

export function redactSecrets(text: string): string {
  let out = String(text ?? '');
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

/* Which path-shaped strings in a terminal line become links, and what each link may do.
 *
 * Two levels, because the two gestures carry different risks:
 *   open   — ⌘-click previews the file INSIDE the app, which reads it. Gated by the allowed
 *            roots (framework root + workspace folders), exactly as before.
 *   reveal — ⌘⇧-click hands the path to Finder / Explorer, selected in its folder. Nothing is
 *            read, so the roots do not apply: an agent's deliverable in a temp folder, or a
 *            FOLDER it names, is exactly what the operator wants to see on the desktop, and
 *            before this neither became a link at all (no error, no underline — it read as
 *            "the app does not do that").
 *
 * Reveal-only targets must be written ABSOLUTE (or `~/…`). A relative token resolved against
 * the home folder would turn ordinary words that happen to name a folder into links.
 * Pure over the filesystem it is handed, so it is tested against real files. */
import * as path from 'node:path';

export interface LinkEnv {
  allowed: (abs: string) => boolean;
  /** Folders a relative candidate is resolved against, in order (pane cwd, framework, home). */
  bases: string[];
  home: string;
  stat: (abs: string) => { isFile(): boolean; isDirectory(): boolean } | null;
}

export interface LinkTargets {
  open: Record<string, string>;     // candidate → absolute file the viewer may read
  reveal: Record<string, string>;   // candidate → absolute file or folder Finder may show
}

/** The candidate as a filesystem string: trailing punctuation and a `:line(:col)` dropped, `~` expanded. */
export function normalizeCandidate(c: string, home: string): string {
  let v = String(c || '').trim().replace(/[)\]},.;:'"]+$/, '');
  v = v.replace(/:\d+(?::\d+)?$/, '');
  if (v.startsWith('~')) v = path.join(home, v.slice(1));
  return v;
}

export function resolveLinkTargets(cands: unknown, env: LinkEnv): LinkTargets {
  const out: LinkTargets = { open: {}, reveal: {} };
  for (const c of (Array.isArray(cands) ? cands : []).slice(0, 24)) {
    try {
      const v = normalizeCandidate(String(c), env.home);
      if (!v) continue;
      const absolute = path.isAbsolute(v);
      const tries = absolute ? [v] : env.bases.map((b) => path.resolve(b, v));
      for (const abs of tries) {
        if (!env.allowed(abs)) continue;
        const st = env.stat(abs);
        if (st && st.isFile()) { out.open[c] = abs; break; }
      }
      if (out.open[c] || !absolute) continue;
      const st = env.stat(v);
      if (st && (st.isFile() || st.isDirectory())) out.reveal[c] = v;
    } catch { /* skip */ }
  }
  return out;
}

/** Whether `shell:reveal` may show this path: anything absolute that exists. */
export function canReveal(p: unknown, stat: LinkEnv['stat']): boolean {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  return stat(p) !== null;
}

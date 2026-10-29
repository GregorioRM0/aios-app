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
import * as fs from 'node:fs';
import * as path from 'node:path';

/* Reveal-only paths are stat'ed on HOVER, from text anyone could have printed, so a stat must
   never reach the network: a UNC or device path (`\\host\share`, `//host/x`, `\\?\`) makes
   Windows authenticate to that host (NTLM), and macOS's `/net/<host>` and `/Network/…` are automounts. Those
   only ever resolve through the allowed roots, as before. */
export function localAbsolute(v: string): string | null {
  const net = (x: string) => /^[\\/]{2}/.test(x) || /^\/(net|network)(\/|$)/i.test(x);
  if (!path.isAbsolute(v) || net(v)) return null;
  /* Checked again AFTER normalizing, and the normalized form is what gets stat'ed: `/./net`,
     `/a/../net` and `/NET` (APFS ignores case) are all /net. */
  const n = path.resolve(v);
  return net(n) ? null : n;
}

export interface LinkEnv {
  allowed: (abs: string) => boolean;
  /** Folders a relative candidate is resolved against, in order (pane cwd, framework, home). */
  bases: string[];
  home: string;
  stat: (abs: string) => StatLike | null | Promise<StatLike | null>;
}

type StatLike = { isFile(): boolean; isDirectory(): boolean };

/* A stat that answers within `ms` or not at all. These stats run on HOVER over text anyone could
   have printed, in the main process. A synchronous stat of a sleeping external disk, a stale
   network mount or an iCloud placeholder blocks that process — every window freezes while the
   operator only moved the mouse. Asynchronous, the slow stat waits on a worker thread instead,
   and past `ms` the answer is "no link", which is what a path nobody can reach should be. */
export const STAT_TIMEOUT_MS = 1500;
export function statWithin(ms: number = STAT_TIMEOUT_MS,
  statp: (abs: string) => Promise<StatLike> = (abs) => fs.promises.stat(abs)): (abs: string) => Promise<StatLike | null> {
  return (abs) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    statp(abs).then((st) => resolve(st), () => resolve(null)).finally(() => clearTimeout(timer));
  });
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

export async function resolveLinkTargets(cands: unknown, env: LinkEnv): Promise<LinkTargets> {
  const out: LinkTargets = { open: {}, reveal: {} };
  /* Candidates resolve in PARALLEL: one unreachable path waits out its timeout once, beside the
     others, rather than once per token in turn. */
  await Promise.all((Array.isArray(cands) ? cands : []).slice(0, 24).map(async (c) => {
    try {
      const v = normalizeCandidate(String(c), env.home);
      if (!v) return;
      const absolute = path.isAbsolute(v);
      const tries = absolute ? [v] : env.bases.map((b) => path.resolve(b, v));
      for (const abs of tries) {
        if (!env.allowed(abs)) continue;
        const st = await env.stat(abs);
        if (st && st.isFile()) { out.open[c] = abs; break; }
      }
      const local = out.open[c] || !absolute ? null : localAbsolute(v);
      if (!local) return;
      const st = await env.stat(local);
      if (st && (st.isFile() || st.isDirectory())) out.reveal[c] = local;
    } catch { /* skip */ }
  }));
  return out;
}

/** What `shell:reveal` may show: the normalized form of a local absolute path that exists. */
export async function revealable(p: unknown, stat: LinkEnv['stat']): Promise<string | null> {
  const local = typeof p === 'string' ? localAbsolute(p) : null;
  return local && (await stat(local)) !== null ? local : null;
}

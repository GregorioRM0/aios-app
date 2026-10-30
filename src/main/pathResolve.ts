/**
 * Turning a path-shaped string from a terminal line or a chat message into a real path on disk.
 *
 * ONE implementation of the rules, because there are now two callers here and they must never drift:
 *   · fs:resolveFile   — a single candidate (files only)
 *   · fs:resolvePaths  — a chat message, as a batch (files AND folders, and it says which)
 * (fs:resolveFiles, the terminal's hover, runs on pathLinks.ts: same cleaning, plus a reveal-only level.)
 *
 * The rules are the ones the terminal has always had: trim the punctuation prose leaves on the end,
 * drop a `:line[:col]` suffix, expand `~`, try the base folder first and then the framework root and
 * the home folder, and refuse anything outside the allowed roots. Nothing is a link unless it
 * EXISTS, which is also what makes a loose candidate regex safe: a false positive would have to be
 * a real path.
 *
 * Kept free of electron and of module state (the allowed-roots check and the framework root are
 * handed in), so a test can run it against a folder it creates itself.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeCandidate } from './pathLinks';

export interface ResolvedPath {
  abs: string;
  /** true when the path is a folder. The terminal never asks for folders, so for it this is always false. */
  dir: boolean;
}

export interface ResolveEnv {
  /** Is this absolute path under a root the app may show? (main's inAllowed) */
  allowed(abs: string): boolean;
  /** The framework root, tried after the base folder. */
  frameworkRoot(): string | null | undefined;
  /** The home folder: `~` expands to it and it is the last base tried. Defaults to the OS one. */
  home?: string;
}

/** How many candidates one hovered terminal line may ask about. */
export const RESOLVE_FILES_LIMIT = 24;
/* A chat message is resolved in ONE batch (a long answer can name dozens of files, and a round trip
   per handful is what made hover slow in the terminal), so its ceiling is higher. Still a ceiling:
   each candidate costs up to three stat calls on the main thread. */
export const RESOLVE_PATHS_LIMIT = 200;

/** The text of a candidate with the prose around it removed: what is left is what to look for on disk.
 *  The rules live in pathLinks.normalizeCandidate (the terminal's resolver uses them too): one copy, so
 *  a terminal link and a chat link cannot disagree about the same string. */
export function cleanCandidate(raw: unknown, home: string = os.homedir()): string {
  return normalizeCandidate(String(raw || ''), home);
}

/**
 * Resolve one candidate. `wantDirs` is the only difference between the callers: with it off a folder
 * is skipped (and the search moves on to the next base), as the terminal has always done; with it on
 * the first thing that exists, file or folder, wins.
 */
export function resolveOne(cand: unknown, base: string | undefined, env: ResolveEnv, wantDirs: boolean): ResolvedPath | null {
  const home = env.home ?? os.homedir();
  const v = cleanCandidate(cand, home);
  if (!v) return null;
  const bases = [base, env.frameworkRoot(), home].filter(Boolean) as string[];
  /* An ABSOLUTE candidate is normally tried as typed. A `..` segment is the exception: the allowed-roots
     check compares text, so `<root>/../outside` would pass it while naming a place outside the root.
     Normalising only then keeps every other string byte-for-byte what it was. */
  const tries = path.isAbsolute(v)
    ? [/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(v) ? path.resolve(v) : v]
    : bases.map((b) => path.resolve(b, v));
  for (const abs of tries) {
    if (!env.allowed(abs)) continue;
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) return { abs, dir: false };
      if (wantDirs && st.isDirectory()) return { abs, dir: true };
    } catch { /* not here: next base */ }
  }
  return null;
}

/** A batch, keyed by the candidate exactly as it was given. Only what exists is in the result. */
export function resolveMany(cands: unknown, base: string | undefined, env: ResolveEnv, opts: { dirs: boolean; limit: number }): Record<string, ResolvedPath> {
  const out: Record<string, ResolvedPath> = {};
  for (const c of (Array.isArray(cands) ? cands : []).slice(0, opts.limit)) {
    try {
      const r = resolveOne(c, base, env, opts.dirs);
      if (r) out[c] = r;
    } catch { /* skip */ }
  }
  return out;
}

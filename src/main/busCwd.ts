import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The optional `cwd` of a bus `spawn` / `resume` — the directory the session's terminal opens in.
 *
 * WHY: the App opens every bus session in the framework root. A worker whose rules live in its own
 * directory (a `CLAUDE.md` that scopes it, a repo it owns) then starts with the framework's
 * `CLAUDE.md` and the whole vault instead — the opposite of the scoping its author built. The
 * shell wrapper can be told where to start; the bus could not.
 *
 * WHY THESE RULES: the path is written by an agent, so it is validated like any other field that
 * reaches a launch, and a value we cannot honour is dead-lettered NAMING it, never silently
 * dropped (a worker started in the wrong directory looks exactly like one started in the right
 * one). Absolute, existing, a directory, and under the operator's home once symlinks are
 * resolved — so `~/../other-user` or a link out of home cannot widen where a session may start.
 */
export type BusCwd = { cwd: string } | { error: string };

const MAX_LEN = 4096;

/** Validate a raw `cwd` field. `home` is injectable for tests. */
export function resolveBusCwd(raw: unknown, home: string = os.homedir()): BusCwd {
  const shown = String(raw).slice(0, 200);
  const bad = (why: string): BusCwd => ({ error: `cwd '${shown}' is not valid — ${why}` });
  if (typeof raw !== 'string' || !raw.trim()) return bad('it must be a non-empty string');
  if (raw.length > MAX_LEN || raw.includes('\0')) return bad('it is too long or contains a NUL byte');
  if (!path.isAbsolute(raw)) return bad('it must be an absolute path (no ~, no relative paths)');
  let real: string;
  let realHome: string;
  try { real = fs.realpathSync(raw); } catch { return bad('it does not exist'); }
  try { realHome = fs.realpathSync(home); } catch { return bad('the home directory could not be resolved'); }
  try { if (!fs.statSync(real).isDirectory()) return bad('it is not a directory'); } catch { return bad('it does not exist'); }
  const norm = (p: string): string => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
  const r = norm(real);
  const h = norm(realHome).replace(/\/+$/, '');
  if (r !== h && !r.startsWith(h + '/')) return bad('it must be inside the home directory');
  return { cwd: real };
}

/* Directories the bus has validated, so `pty:spawn` may open a terminal there even though they are
   outside the explorer's allowed roots. Only resolveBusCwd's output is ever added, and the check
   re-resolves the path, so a renderer cannot widen this set by asking. Bounded. */
const granted = new Set<string>();

export function grantBusCwd(real: string): void {
  if (granted.size > 200) granted.clear();
  granted.add(real);
}

export function isBusCwdGranted(p: string): boolean {
  if (!granted.size) return false;
  try { return granted.has(fs.realpathSync(p)); } catch { return false; }
}

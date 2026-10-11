/**
 * Awake with the lid closed — the driver (macOS only). The policy and the installed files are pure
 * and live in `src/core/lidAwake.ts`; this file holds the one child process and talks to the OS.
 *
 * It is driven by `src/main/caffeinate.ts`, never by the renderer: the lid hold follows the
 * keep-awake decision (plus a grace), so the operator's mental model stays one control — the cup —
 * with one extra setting that says "and that includes with the lid closed".
 *
 * THE SHAPE, AND WHY. `pmset -a disablesleep 1` needs root and outlives every process. So:
 *  - root is obtained ONCE, behind macOS's own administrator prompt, to install a root-owned guard
 *    and a sudoers rule that allows exactly `guard hold <pid>` and `guard release` — nothing else;
 *  - holding = a long-lived `sudo -n guard hold <our pid>`, which releases by itself when our pid
 *    dies (crash, force-quit, the updater), so a dead App can never leave a Mac that will not sleep;
 *  - a boot daemon puts sleep back at every boot, for the case where the App never opens again.
 * Nothing here can raise privileges beyond those two verbs, and `Remove` deletes all three files.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  GUARD_PATH, SUDOERS_PATH, DAEMON_PATH, guardScript, installCommand, uninstallCommand,
} from '../core/lidAwake';

const log = (m: string): void => console.log('[lid-awake]', m);

let child: ChildProcess | null = null;
let held = false;
let lastError = '';

export interface LidState {
  /** macOS only — on Windows and Linux the lid is the OS's own setting and the row is hidden. */
  available: boolean;
  /** The guard is installed AND is the version this build ships (an older guard counts as absent). */
  installed: boolean;
  /** The guard reported `held` and is still running. */
  holding: boolean;
  /** Last failure, verbatim, so the UI can say why instead of silently not holding. */
  error: string;
}

export function available(): boolean {
  return process.platform === 'darwin';
}

/**
 * Installed = all three files present and the guard is byte-identical to this build's.
 * Readable without root: the guard is 755, and existence in /etc/sudoers.d needs only the
 * directory's x bit. A guard from an older build is treated as not installed, so the operator is
 * asked to reinstall rather than running a script whose behaviour this code no longer describes.
 */
export function installed(): boolean {
  if (!available()) return false;
  try {
    return fs.existsSync(SUDOERS_PATH) && fs.existsSync(DAEMON_PATH)
      && fs.readFileSync(GUARD_PATH, 'utf8') === guardScript();
  } catch { return false; }
}

export function state(): LidState {
  return { available: available(), installed: installed(), holding: held && child !== null, error: lastError };
}

/** Run one shell command as root behind the standard macOS administrator prompt. */
function asAdmin(cmd: string, prompt: string): Promise<{ ok: boolean; error: string }> {
  return new Promise((resolve) => {
    /* The command goes in as an argv item, never spliced into AppleScript source — so no quoting
       of ours can turn into script. */
    execFile('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges',
      '-e', 'end run',
      cmd, prompt,
    ], (err, _out, stderr) => {
      if (!err) return resolve({ ok: true, error: '' });
      /* -128 is the operator pressing Cancel — a choice, not a failure worth a red line. */
      const msg = String(stderr || err.message).trim();
      resolve({ ok: false, error: /-128/.test(msg) ? 'cancelled' : msg });
    });
  });
}

export async function install(prompt: string): Promise<LidState> {
  if (!available()) return state();
  const r = await asAdmin(installCommand(os.userInfo().username), prompt);
  lastError = r.ok ? '' : r.error;
  log(r.ok ? 'installed' : `install failed: ${r.error}`);
  return state();
}

export async function uninstall(prompt: string): Promise<LidState> {
  if (!available()) return state();
  await sync(false);
  const r = await asAdmin(uninstallCommand(), prompt);
  lastError = r.ok ? '' : r.error;
  log(r.ok ? 'removed' : `remove failed: ${r.error}`);
  return state();
}

function release(): Promise<void> {
  return new Promise((resolve) => {
    execFile('/usr/bin/sudo', ['-n', GUARD_PATH, 'release'], (err, _o, stderr) => {
      if (err) { lastError = String(stderr || err.message).trim(); log(`release failed: ${lastError}`); }
      resolve();
    });
  });
}

/**
 * Bring the hold in line with `want`. Idempotent and cheap when nothing changes — it is called on
 * every keep-awake tick.
 */
export async function sync(want: boolean): Promise<void> {
  if (!available()) return;
  if (want && !child) {
    if (!installed()) return;
    /* `-n`: never prompt. If the sudoers rule is missing or stale this fails loudly instead of
       hanging on a password nobody can see. */
    const c = spawn('/usr/bin/sudo', ['-n', GUARD_PATH, 'hold', String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    child = c;
    held = false;
    c.stdout?.on('data', (d: Buffer) => {
      if (/\bheld\b/.test(d.toString())) { held = true; lastError = ''; log('holding — the lid can close'); }
    });
    c.stderr?.on('data', (d: Buffer) => { lastError = d.toString().trim(); });
    c.on('exit', (code) => {
      if (child === c) { child = null; held = false; }
      log(`guard exited (${String(code)})${lastError ? ' — ' + lastError : ''}`);
    });
  } else if (!want && child) {
    child = null;
    held = false;
    await release();
    log('released');
  }
}

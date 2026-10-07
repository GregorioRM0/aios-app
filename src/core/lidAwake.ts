/**
 * Awake with the lid closed — pure policy and the exact files the one-time install writes.
 * No Electron, no fs, no child_process: everything here is a decision or a string, so it is
 * testable byte for byte (src/test/lidAwake.test.ts).
 *
 * WHY THE KEEP-AWAKE BLOCKER IS NOT ENOUGH. `powerSaveBlocker` (src/main/caffeinate.ts) takes a
 * `PreventUserIdleSystemSleep` assertion — the same one bare `caffeinate` takes. It stops IDLE
 * sleep. It does not stop CLAMSHELL sleep: on a MacBook running on battery with no external
 * display, closing the lid sleeps the machine no matter which assertions are held. So the operator
 * who starts a long session and closes the lid to walk away loses the session's progress, which is
 * the exact moment keep-awake exists for. `pmset -g assertions` shows the assertion held right up
 * to the lid-close sleep — the blocker is honest, it simply answers a different question.
 *
 * WHAT DOES STOP IT. `pmset -a disablesleep 1` (shows as `SleepDisabled 1` in `pmset -g`). It is
 * what Amphetamine's "closed-display mode" helper toggles. It needs root, and it is PERSISTENT —
 * it survives the process that set it and survives a reboot. Those two facts shape everything
 * below: root means a one-time, visible install; persistent means the release path cannot depend
 * on the App staying alive, so it lives in a root-owned guard that releases on its own.
 */

/** Where the one-time install puts its three files. Fixed paths, so status can be read without root. */
export const GUARD_PATH = '/Library/PrivilegedHelperTools/com.the-aios.lid-guard';
export const SUDOERS_PATH = '/etc/sudoers.d/com-the-aios-lid-guard';   // no dot: sudo skips names containing '.'
export const DAEMON_PATH = '/Library/LaunchDaemons/com.the-aios.lid-guard.plist';
export const DAEMON_LABEL = 'com.the-aios.lid-guard';

/**
 * After the last busy moment, how long the lid hold lingers before it lets go.
 *
 * Five ticks of the 2s keep-awake poll — a margin, not a wait. Measured on Claude Code 2.1.292
 * with a 100ms poll of the session file: status stays `busy` without a single gap across tool
 * calls, model turns and a foreground subagent, AND after the turn ends while a background Bash
 * task or background agent is still running; it reads `idle` only once nothing is left. So the
 * grace is not covering a known blip — it covers one nobody has measured on another machine,
 * and costs ten seconds of battery.
 */
export const LID_GRACE_MS = 10_000;

/** On battery at or below this, the guard releases on its own — a bag is not a place to drain to 0. */
export const LID_BATTERY_FLOOR = 10;

/**
 * Should the lid hold be on right now?
 *
 * Follows the keep-awake blocker (so `auto`, `manual` and the override all mean the same thing
 * they already mean) plus a short GRACE after it lets go. With the lid closed, releasing is not
 * "stop preventing sleep" but "sleep now" (see `release` in the guard), so a status that read
 * `idle` for a single tick would put the machine to sleep mid-work. None was observed (see
 * LID_GRACE_MS), so the grace is kept small. Closing the lid with nothing working in the last
 * grace window is untouched: no hold exists, and macOS sleeps at once as it always has.
 */
export function desiredLidHold(input: {
  platform: string;
  enabled: boolean;
  installed: boolean;
  blockerWanted: boolean;
  /** ms since epoch of the last tick the blocker was wanted; 0 = never this run. */
  lastWantedAt: number;
  now: number;
}): boolean {
  if (input.platform !== 'darwin' || !input.enabled || !input.installed) return false;
  if (input.blockerWanted) return true;
  return input.lastWantedAt > 0 && input.now - input.lastWantedAt < LID_GRACE_MS;
}

/**
 * The guard. Runs as root, only through the sudoers rule below, and only with `hold <pid>` or
 * `release`.
 *
 * WHY IT WATCHES A PID INSTEAD OF BEING TOLD TO STOP. The setting it flips outlives every process,
 * so a release that depends on the App asking for it is a release that does not happen when the
 * App crashes, is force-quit, or the update installer kills it — and the machine then never sleeps
 * on lid close again, in a bag, until someone notices the heat. So the guard holds only while the
 * App's pid is alive and releases itself the moment it is not. `release` exists for the normal
 * case (the sessions went idle) and is idempotent.
 *
 * WHY IT SLEEPS THE MACHINE ON RELEASE. With the lid already closed, clearing `disablesleep` does
 * not sleep anything: the lid-close event happened while sleep was disabled and is not replayed.
 * The operator's ask is that the Mac sleeps when the work is done, so when the lid is closed at
 * release the guard says `pmset sleepnow` itself.
 *
 * The battery floor lives here too, not in the App, for the same reason as the pid watch: it must
 * hold even if the App hangs.
 */
export function guardScript(): string {
  return `#!/bin/sh
# AIOS — keep the Mac awake with the lid closed while sessions are working.
# Installed by the AIOS app; owned by root; run only via ${SUDOERS_PATH}.
# hold <pid>  disable sleep while <pid> is alive (and the battery is above ${LID_BATTERY_FLOOR}%)
# release     put everything back; sleep now if the lid is closed
# boot        put everything back (run at boot by ${DAEMON_PATH})
PATH=/usr/bin:/bin:/usr/sbin:/sbin
PIDFILE=/var/run/com.the-aios.lid-guard.pid

lid_closed() { ioreg -r -k AppleClamshellState -d 4 | grep -q '"AppleClamshellState" = Yes'; }
battery_low() {
  pmset -g batt | grep -q "Battery Power" || return 1
  pct=$(pmset -g batt | grep -o '[0-9]*%' | head -1 | tr -d '%')
  [ -n "$pct" ] && [ "$pct" -le ${LID_BATTERY_FLOOR} ]
}
restore() {
  pmset -a disablesleep 0
  rm -f "$PIDFILE"
  if lid_closed; then pmset sleepnow >/dev/null; fi
}

case "$1" in
  hold)
    case "$2" in ''|*[!0-9]*) echo "hold needs the app's pid" >&2; exit 2 ;; esac
    # A previous holder (an App that restarted) steps aside WITHOUT restoring: USR1 means
    # "someone is taking over", and restoring here could sleep a closed-lid Mac mid-handover.
    if [ -f "$PIDFILE" ]; then kill -USR1 "$(cat "$PIDFILE")" 2>/dev/null; sleep 1; fi
    echo $$ > "$PIDFILE"
    trap 'restore; exit 0' HUP INT TERM
    trap 'exit 0' USR1
    pmset -a disablesleep 1 || { rm -f "$PIDFILE"; exit 1; }
    echo held
    while kill -0 "$2" 2>/dev/null; do
      if battery_low; then echo "battery at or below ${LID_BATTERY_FLOOR}%" >&2; break; fi
      sleep 5 & wait $!
    done
    restore ;;
  release)
    if [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; then exit 0; fi
    restore ;;
  boot)
    pmset -a disablesleep 0
    rm -f "$PIDFILE" ;;
  *)
    echo "usage: $0 hold <pid> | release | boot" >&2; exit 2 ;;
esac
`;
}

/**
 * The sudoers rule: this user, this one file, these two verbs. Nothing else runs without a
 * password. `hold *` is a wildcard on purpose — the pid changes every launch — and the guard
 * rejects anything that is not digits.
 */
export function sudoersRule(user: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`unexpected user name: ${user}`);
  return `# AIOS — lets the AIOS app keep this Mac awake with the lid closed (Settings → Keep awake).\n`
    + `# Remove with Settings → Keep awake → Remove, or delete this file.\n`
    + `${user} ALL=(root) NOPASSWD: ${GUARD_PATH} hold *, ${GUARD_PATH} release\n`;
}

/** At every boot, put sleep back — `disablesleep` survives a reboot and the App may never reopen. */
export function daemonPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${GUARD_PATH}</string><string>boot</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
}

/** A file's content as a root shell step, with no temp file in between that another process could swap. */
function writeStep(dest: string, content: string, mode: string): string {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return `echo '${b64}' | /usr/bin/base64 -D > '${dest}.tmp' && /usr/sbin/chown root:wheel '${dest}.tmp' && /bin/chmod ${mode} '${dest}.tmp'`;
}

/**
 * The whole install as ONE shell command, run once behind macOS's own administrator prompt.
 *
 * The sudoers file is validated with `visudo -cf` BEFORE it is moved into place. A malformed file
 * in /etc/sudoers.d does not just fail this feature — it breaks `sudo` for the whole machine — so
 * a rule that does not parse never reaches the directory.
 */
export function installCommand(user: string): string {
  return [
    '/bin/mkdir -p /Library/PrivilegedHelperTools',
    writeStep(GUARD_PATH, guardScript(), '755'),
    `/bin/mv -f '${GUARD_PATH}.tmp' '${GUARD_PATH}'`,
    writeStep(SUDOERS_PATH, sudoersRule(user), '440'),
    `/usr/sbin/visudo -cf '${SUDOERS_PATH}.tmp'`,
    `/bin/mv -f '${SUDOERS_PATH}.tmp' '${SUDOERS_PATH}'`,
    writeStep(DAEMON_PATH, daemonPlist(), '644'),
    `/bin/mv -f '${DAEMON_PATH}.tmp' '${DAEMON_PATH}'`,
  ].join(' && ');
}

/** The undo: put sleep back first, then remove all three files. */
export function uninstallCommand(): string {
  return [
    `( [ -x '${GUARD_PATH}' ] && '${GUARD_PATH}' boot; true )`,
    `/bin/rm -f '${SUDOERS_PATH}' '${DAEMON_PATH}' '${GUARD_PATH}'`,
  ].join(' && ');
}

/** `pmset -g` prints `SleepDisabled 1` only while it is set; absent means 0. */
export function parseSleepDisabled(pmsetG: string): boolean {
  return /^\s*SleepDisabled\s+1\b/m.test(pmsetG);
}

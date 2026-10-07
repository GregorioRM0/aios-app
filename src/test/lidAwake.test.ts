/**
 * Awake with the lid closed (macOS).
 *
 * What these tests care about, in order: (1) the machine is never left unable to sleep — the
 * guard releases when the App's pid dies, on `release`, on the battery floor, and at boot;
 * (2) when the work ends with the lid closed, the Mac actually sleeps; (3) the root surface is
 * exactly two verbs and nothing else; (4) a one-tick idle blip cannot sleep a closed lid mid-work.
 *
 * The guard is RUN, not read: its PATH and pidfile are pointed at a temp dir holding fake `pmset`
 * and `ioreg` that log what they were asked. Everything else in the script is the shipped bytes.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  desiredLidHold, guardScript, sudoersRule, daemonPlist, installCommand, uninstallCommand,
  parseSleepDisabled, LID_GRACE_MS, LID_BATTERY_FLOOR, GUARD_PATH, SUDOERS_PATH, DAEMON_PATH,
} from '../core/lidAwake';

const base = { platform: 'darwin', enabled: true, installed: true, blockerWanted: false, lastWantedAt: 0, now: 1_000_000 };

test('the lid hold follows the keep-awake decision', () => {
  assert.equal(desiredLidHold({ ...base, blockerWanted: true }), true);
  assert.equal(desiredLidHold({ ...base }), false, 'never wanted this run → nothing to hold');
});

test('it is off unless it is macOS, enabled AND installed', () => {
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, platform: 'linux' }), false);
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, platform: 'win32' }), false);
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, enabled: false }), false);
  assert.equal(desiredLidHold({ ...base, blockerWanted: true, installed: false }), false,
    'without the guard there is nothing to run — and sudo -n must never be tried blind');
});

test('a short idle blip does not let go — releasing with the lid closed means sleeping NOW', () => {
  const t0 = base.now;
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - 2_000 }), true, 'one 2s tick of idle must not sleep a closed lid');
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - 4_000 }), true, 'nor two');
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - (LID_GRACE_MS - 1) }), true);
  assert.equal(desiredLidHold({ ...base, lastWantedAt: t0 - LID_GRACE_MS }), false, 'after the grace it lets go');
  /* At least two 2s ticks, so one stale read cannot release; at most 30s, because after the
     work ends the operator expects the Mac to sleep, not to idle on battery in a bag. */
  assert.ok(LID_GRACE_MS >= 4_000 && LID_GRACE_MS <= 30_000, 'a margin of a few ticks, not a wait');
});

test('the sudoers rule grants exactly hold and release on the guard, to one user', () => {
  const r = sudoersRule('operator');
  const grant = r.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.equal(grant.length, 1, 'one rule line');
  assert.equal(grant[0], `operator ALL=(root) NOPASSWD: ${GUARD_PATH} hold *, ${GUARD_PATH} release`);
  assert.doesNotMatch(r, /%admin|ALL\s*$|NOPASSWD:\s*ALL/, 'never a broad grant');
  assert.throws(() => sudoersRule('a b'), 'a name that could smuggle syntax into sudoers is refused');
  assert.throws(() => sudoersRule('x, ALL'));
  assert.ok(!path.basename(SUDOERS_PATH).includes('.'), 'sudo silently skips sudoers.d files whose name contains a dot');
});

test('the install validates sudoers before it can land, and writes no swappable temp file outside root', () => {
  const cmd = installCommand('operator');
  const visudo = cmd.indexOf(`visudo -cf '${SUDOERS_PATH}.tmp'`);
  const move = cmd.indexOf(`mv -f '${SUDOERS_PATH}.tmp' '${SUDOERS_PATH}'`);
  assert.ok(visudo > 0 && move > visudo, 'a malformed sudoers file breaks sudo machine-wide — it is checked first');
  assert.ok(cmd.split(' && ').length > 5, 'steps are chained with && so one failure stops the rest');
  assert.doesNotMatch(cmd, /\/tmp\/|TMPDIR/, 'contents travel inside the command, never via a user-writable file');
  for (const p of [GUARD_PATH, SUDOERS_PATH, DAEMON_PATH]) assert.ok(cmd.includes(`'${p}'`), `installs ${p}`);
  const un = uninstallCommand();
  assert.ok(un.indexOf('boot') < un.indexOf('rm -f'), 'remove puts sleep back BEFORE deleting the guard that can');
  for (const p of [GUARD_PATH, SUDOERS_PATH, DAEMON_PATH]) assert.ok(un.includes(p), `removes ${p}`);
});

test('the boot daemon puts sleep back at every boot', () => {
  const p = daemonPlist();
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(p.includes(`<string>${GUARD_PATH}</string><string>boot</string>`));
});

test('SleepDisabled parsing — absent means off', () => {
  assert.equal(parseSleepDisabled(' sleep 1\n SleepDisabled\t\t1\n'), true);
  assert.equal(parseSleepDisabled(' sleep 1\n displaysleep 3\n'), false);
  assert.equal(parseSleepDisabled(' SleepDisabled\t\t0\n'), false);
});

/* ── the guard, run for real against fakes ── */

function sandbox(opts: { lidClosed: boolean; battery?: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lid-guard-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const logf = path.join(dir, 'pmset.log');
  const batt = opts.battery ?? "Now drawing from 'AC Power'\n -InternalBattery-0 80%; charging";
  fs.writeFileSync(path.join(bin, 'pmset'),
    `#!/bin/sh\nif [ "$1" = "-g" ] && [ "$2" = "batt" ]; then printf '%s\\n' "${batt.replace(/"/g, '\\"')}"; exit 0; fi\necho "$*" >> '${logf}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'ioreg'),
    `#!/bin/sh\necho '  |   "AppleClamshellState" = ${opts.lidClosed ? 'Yes' : 'No'}'\n`, { mode: 0o755 });
  const script = guardScript()
    .replace('PATH=/usr/bin:/bin:/usr/sbin:/sbin', `PATH=${bin}:/usr/bin:/bin:/usr/sbin:/sbin`)
    .replace('PIDFILE=/var/run/com.the-aios.lid-guard.pid', `PIDFILE=${dir}/guard.pid`);
  assert.notEqual(script, guardScript(), 'the sandbox must actually redirect PATH and the pidfile');
  const guard = path.join(dir, 'guard');
  fs.writeFileSync(guard, script, { mode: 0o755 });
  const calls = (): string[] => (fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { dir, guard, calls };
}

function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => (cond() ? res() : Date.now() - t0 > ms ? rej(new Error('timed out')) : setTimeout(tick, 50));
    tick();
  });
}

const skipOffPosix = process.platform === 'win32' ? 'POSIX shell' : false;

test('the guard parses as sh', { skip: skipOffPosix }, () => {
  const r = spawnSync('/bin/sh', ['-n'], { input: guardScript() });
  assert.equal(r.status, 0, String(r.stderr));
});

test('the guard releases on its own when the App dies — and sleeps a closed lid', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: true });
  const app = spawn('/bin/sleep', ['60']);                      // stands in for the App's pid
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  let out = '';
  g.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('held'));
  assert.deepEqual(s.calls(), ['-a disablesleep 1']);
  app.kill('SIGKILL');                                           // a crash, not a polite quit
  await new Promise((r) => g.on('exit', r));
  assert.deepEqual(s.calls(), ['-a disablesleep 1', '-a disablesleep 0', 'sleepnow'],
    'a dead App must never leave sleep disabled; with the lid closed the work is over, so sleep');
  assert.ok(!fs.existsSync(path.join(s.dir, 'guard.pid')));
});

test('release from the App stops the holder; an open lid is NOT put to sleep', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: false });
  const app = spawn('/bin/sleep', ['60']);
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  let out = '';
  g.stdout.on('data', (d) => { out += d; });
  await waitFor(() => out.includes('held'));
  const r = spawnSync(s.guard, ['release']);
  assert.equal(r.status, 0);
  await new Promise((res) => g.on('exit', res));
  app.kill();
  assert.deepEqual(s.calls(), ['-a disablesleep 1', '-a disablesleep 0'], 'operator is at the keyboard — no surprise sleep');
});

test('the battery floor releases even while the App is alive', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: true, battery: `Now drawing from 'Battery Power'\n -InternalBattery-0 ${LID_BATTERY_FLOOR}%; discharging` });
  const app = spawn('/bin/sleep', ['60']);
  const g = spawn(s.guard, ['hold', String(app.pid)]);
  await new Promise((res) => g.on('exit', res));
  app.kill();
  assert.deepEqual(s.calls(), ['-a disablesleep 1', '-a disablesleep 0', 'sleepnow']);
});

test('a restarted App takes over the hold without a sleep in between', { skip: skipOffPosix }, async () => {
  const s = sandbox({ lidClosed: true });
  const app1 = spawn('/bin/sleep', ['60']);
  const g1 = spawn(s.guard, ['hold', String(app1.pid)]);
  /* Subscribed up front: g1 exits during g2's start-up, before the line that awaits it runs, and
     an 'exit' listener attached after the fact never fires. */
  const g1Exit = new Promise((res) => g1.on('exit', res));
  let o1 = '';
  g1.stdout.on('data', (d) => { o1 += d; });
  await waitFor(() => o1.includes('held'));
  const app2 = spawn('/bin/sleep', ['60']);
  const g2 = spawn(s.guard, ['hold', String(app2.pid)]);
  let o2 = '';
  g2.stdout.on('data', (d) => { o2 += d; });
  await waitFor(() => o2.includes('held'));
  await g1Exit;
  assert.ok(!s.calls().includes('sleepnow'), 'handover must not sleep a closed lid');
  spawnSync(s.guard, ['release']);
  await new Promise((res) => g2.on('exit', res));
  app1.kill(); app2.kill();
  assert.equal(s.calls().at(-1), 'sleepnow', 'the final release still sleeps it');
});

test('the guard refuses anything but its verbs', { skip: skipOffPosix }, () => {
  const s = sandbox({ lidClosed: false });
  assert.equal(spawnSync(s.guard, ['hold']).status, 2, 'hold without a pid');
  assert.equal(spawnSync(s.guard, ['hold', '1; rm -rf /']).status, 2, 'a pid that is not digits');
  assert.equal(spawnSync(s.guard, ['whatever']).status, 2);
  assert.deepEqual(s.calls(), [], 'and touched nothing');
});

test('boot puts sleep back without sleeping', { skip: skipOffPosix }, () => {
  const s = sandbox({ lidClosed: true });
  assert.equal(spawnSync(s.guard, ['boot']).status, 0);
  assert.deepEqual(s.calls(), ['-a disablesleep 0']);
});

test('the lid word fits the title-bar tooltip in every locale', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['caffeinate.lidHolding', 'settings.lidAwake', 'settings.lidAwakeHint', 'caffeinate.lidOn', 'caffeinate.lidOff',
                     'caffeinate.lidRemove', 'caffeinate.lidFailed', 'caffeinate.lidPrompt', 'caffeinate.lidPromptRemove']) {
      assert.ok(d[k], `${loc}: missing ${k}`);
    }
    const status = [d['caffeinate.modeAutoShort'], d['caffeinate.modeManualShort'], d['caffeinate.statusOverride']]
      .reduce((a, b) => (a.length >= b.length ? a : b));
    const worst = `${d['caffeinate.title']}: ${status} · ${d['caffeinate.lidHolding']}`;
    assert.ok(worst.length <= 64, `${loc}: "${worst}" is ${worst.length} chars`);
  }
});

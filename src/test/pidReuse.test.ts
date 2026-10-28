/**
 * #78 — a registry entry whose pid now belongs to ANOTHER process is not a running session.
 * Measured against a real process (this test's own), with a control whose recorded start is true.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-pidreuse-'));
fs.mkdirSync(path.join(cfg, 'sessions'));
process.env.CLAUDE_CONFIG_DIR = cfg;
const entry = (procStart: string) => fs.writeFileSync(path.join(cfg, 'sessions', `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, name: 'heron', sessionId: 's', procStart }));

test('a pid whose process started at another time drops out; the true one stays', { skip: process.platform === 'win32' }, async () => {
  const aios = await import('../main/aios');
  const { processStartMs } = await import('../main/procStartProbe');
  const real = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).toString().trim();

  entry(real);   // CONTROL: the recorded start is this process's own
  await processStartMs(process.pid);
  assert.ok(aios.listRunningAgents().some((a) => a.name === 'heron'), 'the true session is listed');
  assert.equal(await aios.registryPidIsSession(process.pid), true);

  entry('Mon Jan  1 00:00:00 2001');   // the same pid, recorded for a process from 2001: reused
  assert.ok(!aios.listRunningAgents().some((a) => a.name === 'heron'), 'a reused pid is not a session');
  assert.equal(await aios.registryPidIsSession(process.pid), false, 'resume must not reveal it');

  entry('');   // no readable record: the old behaviour, never a guess
  assert.ok(aios.listRunningAgents().some((a) => a.name === 'heron'));
  assert.equal(await aios.registryPidIsSession(process.pid), true);
});

test('resume awaits the check before calling a session already running', () => {
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const fn = /async function resumeOrReveal\([\s\S]*?\n\}/.exec(bus)![0];
  assert.ok(fn.indexOf('await aios.registryPidIsSession(live.pid)') < fn.indexOf('if (live) {'));
});

/**
 * The conditional kill (core/killGuard): `expect` on a `kill` request is compared against the
 * registry and the transcript immediately before the SIGTERM, and a session that changed since
 * the writer looked is left running.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { parseKillExpect, killVerdict, lastTurnAt } from '../core/killGuard';

const SID = '0b5c2a4e-1111-4222-8333-944455556666';
const rec = (type: string, ts: string) => JSON.stringify({ type, timestamp: ts, message: { content: 'x' } });
const transcript = [
  rec('user', '2026-10-18T09:00:00.000Z'),
  rec('assistant', '2026-10-18T09:00:05.000Z'),
  JSON.stringify({ type: 'agent-name', agentName: 'worker' }),       // no timestamp: never a turn
  JSON.stringify({ type: 'system', timestamp: '2026-10-18T11:00:00.000Z' }),   // not a turn either
].join('\n');

test('no expect → no guard: a plain kill behaves exactly as before', () => {
  assert.deepEqual(parseKillExpect({ action: 'kill', name: 'w' }), { ok: true });
  assert.deepEqual(killVerdict(undefined, { status: 'busy', sessionId: SID }, () => ''), { kill: true });
});

test('expect is parsed: sessionId, status, idleSince', () => {
  const p = parseKillExpect({ expect: { sessionId: SID, status: ' idle ', idleSince: '2026-10-18T09:00:05.000Z' } });
  assert.ok(p.ok);
  assert.deepEqual(p.expect, { sessionId: SID, status: 'idle', idleSince: Date.parse('2026-10-18T09:00:05.000Z') });
});

test('a guard the surface cannot honour refuses the request instead of being dropped', () => {
  for (const bad of [
    { expect: 'idle' },
    { expect: [] },
    { expect: null },
    { expect: {} },
    { expect: { status: 'idle', lastTurn: 'x' } },          // unknown key
    { expect: { sessionId: 'a b; rm' } },
    { expect: { status: 42 } },
    { expect: { idleSince: 'yesterday' } },
    { expect: { idleSince: 1792341391 } },                   // epoch, not ISO
  ]) {
    const p = parseKillExpect(bad as Record<string, unknown>);
    assert.equal(p.ok, false, `must refuse ${JSON.stringify(bad)}`);
  }
});

test('lastTurnAt counts user/assistant records only', () => {
  assert.equal(lastTurnAt(transcript), Date.parse('2026-10-18T09:00:05.000Z'));
  assert.equal(lastTurnAt(''), 0);
  assert.equal(lastTurnAt('not json\n{"type":"user"}'), 0);
});

test('matching session → kill', () => {
  const ex = { sessionId: SID, status: 'idle', idleSince: Date.parse('2026-10-18T09:00:05.000Z') };
  assert.deepEqual(killVerdict(ex, { status: 'idle', sessionId: SID }, () => transcript), { kill: true });
});

test('a turn after idleSince → left running (the race this exists for)', () => {
  const ex = { idleSince: Date.parse('2026-10-18T09:00:05.000Z') };
  const later = transcript + '\n' + rec('user', '2026-10-18T09:00:06.000Z');
  const v = killVerdict(ex, { status: 'idle', sessionId: SID }, () => later);
  assert.equal(v.kill, false);
  assert.match((v as { reason: string }).reason, /09:00:06/);
});

test('status changed → left running; control: same status → kill', () => {
  assert.equal(killVerdict({ status: 'idle' }, { status: 'busy', sessionId: SID }, () => '').kill, false);
  assert.equal(killVerdict({ status: 'idle' }, { status: 'idle', sessionId: SID }, () => '').kill, true);
});

test('another session holds the name → left running', () => {
  assert.equal(killVerdict({ sessionId: SID }, { status: 'idle', sessionId: 'ffff' }, () => '').kill, false);
});

test('idleSince with an unreadable transcript cannot prove quiet → left running', () => {
  assert.equal(killVerdict({ idleSince: 1 }, { status: 'idle', sessionId: SID }, () => '').kill, false);
});

test('the transcript is read only when idleSince asks for it', () => {
  let reads = 0;
  killVerdict({ status: 'idle' }, { status: 'idle', sessionId: SID }, () => { reads++; return transcript; });
  assert.equal(reads, 0);
});

test('no live target → nothing to protect, the kill goes ahead as before', () => {
  assert.deepEqual(killVerdict({ status: 'idle' }, undefined, () => ''), { kill: true });
});

test('the dispatcher checks the guard BEFORE the SIGTERM, and refuses by dead letter', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const start = src.indexOf("if (req.action === 'kill') {");
  assert.ok(start > 0, 'the kill branch must exist');
  const branch = src.slice(start, src.indexOf("} else if (req.action === 'resume')", start));
  const guard = branch.indexOf('killVerdict(');
  const sigterm = branch.indexOf("process.kill(t.pid, 'SIGTERM')");
  assert.ok(guard > 0 && sigterm > 0, 'both the guard and the SIGTERM are in the kill branch');
  assert.ok(guard < sigterm, 'the guard runs before the SIGTERM');
  assert.match(branch.slice(0, sigterm), /parseKillExpect\(/);
  assert.equal((branch.slice(0, sigterm).match(/markUndelivered\(/g) || []).length, 2, 'both refusals dead-letter');
});

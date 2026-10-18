/**
 * The conditional kill (core/killGuard): `expect` on a `kill` request is compared against the
 * registry and the transcript immediately before the SIGTERM, and a session that changed since
 * the writer looked is left running. Anything that cannot be verified refuses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  parseKillExpect, killVerdict, lastTurnAt, parseZonedIso, guardFromHeld, decideKill,
  presenceHonoursExpect, KILL_EXPECT_CAPABILITY,
} from '../core/killGuard';

const SID = '0b5c2a4e-1111-4222-8333-944455556666';
const T0 = '2026-10-18T09:00:05.000Z';
const rec = (type: string, ts: string) => JSON.stringify({ type, timestamp: ts, message: { content: 'x' } });
const transcript = [
  rec('user', '2026-10-18T09:00:00.000Z'),
  rec('assistant', T0),
  JSON.stringify({ type: 'agent-name', agentName: 'worker' }),                 // no timestamp: never a turn
  JSON.stringify({ type: 'system', timestamp: '2026-10-18T11:00:00.000Z' }),    // not a turn either
].join('\n') + '\n';
const idle = { status: 'idle', sessionId: SID };
const held = (o: unknown) => () => JSON.stringify(o);

/* ---------- 1. the re-read of the held request ---------- */

test('no expect → no guard: a plain kill behaves exactly as before', () => {
  assert.deepEqual(parseKillExpect({ action: 'kill', name: 'w' }), { ok: true });
  assert.deepEqual(killVerdict(undefined, { status: 'busy', sessionId: SID }, () => ''), { kill: true });
  assert.deepEqual(decideKill(held({ action: 'kill', name: 'w' }), { status: 'busy', sessionId: SID }, () => ''), { kill: true });
});

test('a held request that cannot be re-read NEVER reaches the kill', () => {
  const reads: Array<() => string> = [
    () => { throw new Error('ENOENT'); },              // vanished
    () => { throw new Error('EACCES'); },              // unreadable
    () => '',                                          // truncated to nothing
    () => '{"action":"kill","name":"w","expect":{"st', // cut mid-write
    () => 'null',
    () => '[1,2]',
    () => '"kill"',
  ];
  for (const r of reads) {
    const v = decideKill(r, idle, () => transcript);
    assert.equal(v.kill, false, `must refuse when the re-read gives ${(() => { try { return JSON.stringify(r()); } catch (e) { return String(e); } })()}`);
    assert.match((v as { reason: string }).reason, /^kill refused — /);
  }
  // control: the same request, readable, kills
  assert.deepEqual(decideKill(held({ action: 'kill', name: 'w', expect: { status: 'idle' } }), idle, () => transcript), { kill: true });
});

test('guardFromHeld reports the failure instead of an empty guard', () => {
  const g = guardFromHeld(() => { throw new Error('gone'); });
  assert.equal(g.ok, false);
  assert.match((g as { reason: string }).reason, /could not be re-read \(gone\)/);
});

test('the dispatcher sends the SIGTERM only after decideKill, and has no other path to it', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  const start = src.indexOf("if (req.action === 'kill') {");
  assert.ok(start > 0, 'the kill branch must exist');
  const branch = src.slice(start, src.indexOf("} else if (req.action === 'resume')", start));
  const guard = branch.indexOf('decideKill(');
  const sigterm = branch.indexOf("process.kill(t.pid, 'SIGTERM')");
  assert.ok(guard > 0 && sigterm > guard, 'decideKill runs before the SIGTERM');
  assert.match(branch.slice(guard, sigterm), /if \(!verdict\.kill\) \{ markUndelivered\([^)]*\); return; \}/, 'a refusal dead-letters and returns');
  assert.equal((src.match(/process\.kill\(t\.pid, 'SIGTERM'\)/g) || []).length, 1, 'one SIGTERM site');
  assert.doesNotMatch(branch, /catch \{ \/\* parsed once already \*\/ \}/, 'the swallowed re-read is gone');
});

/* ---------- 2. the transcript must be verifiable ---------- */

test('lastTurnAt: a healthy transcript gives the newest user/assistant turn', () => {
  assert.deepEqual(lastTurnAt(transcript), { ok: true, at: Date.parse(T0) });
});

test('lastTurnAt: anything unverifiable is indeterminate, never "quiet"', () => {
  const cases: Record<string, string> = {
    empty: '',
    'malformed line': transcript + 'not json\n',
    'malformed line in the middle': rec('user', T0) + '\n{oops\n' + rec('assistant', T0) + '\n',
    'cut last line': transcript + '{"type":"user","timestamp":"2026-10-18T09:10',
    'no trailing newline': transcript.trimEnd(),
    'turn without timestamp': transcript + JSON.stringify({ type: 'user', message: {} }) + '\n',
    'turn with a zoneless timestamp': transcript + JSON.stringify({ type: 'assistant', timestamp: '2026-10-18T09:10:00' }) + '\n',
    'turn with a garbage timestamp': transcript + JSON.stringify({ type: 'user', timestamp: 42 }) + '\n',
    'no turn at all': JSON.stringify({ type: 'agent-name', agentName: 'w' }) + '\n',
    'a non-object line': transcript + '7\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(lastTurnAt(text).ok, false, name);
    const v = killVerdict({ idleSince: Date.parse(T0) }, idle, () => text);
    assert.equal(v.kill, false, `${name}: the kill must be refused`);
    assert.match((v as { reason: string }).reason, /cannot be checked/, name);
  }
});

test('a transcript reader that throws refuses too', () => {
  assert.equal(killVerdict({ idleSince: 1 }, idle, () => { throw new Error('EIO'); }).kill, false);
});

test('a turn after idleSince → left running (the race this exists for); control: none → kill', () => {
  const ex = { idleSince: Date.parse(T0) };
  const later = transcript + rec('user', '2026-10-18T09:00:05.001Z') + '\n';
  const v = killVerdict(ex, idle, () => later);
  assert.equal(v.kill, false);
  assert.match((v as { reason: string }).reason, /09:00:05\.001Z/);
  assert.deepEqual(killVerdict(ex, idle, () => transcript), { kill: true });
});

/* ---------- 3. idleSince must be unambiguous ---------- */

test('idleSince: full date-time with Z or an offset; equivalent offsets agree', () => {
  const z = parseZonedIso('2026-10-18T12:00:00.000Z');
  assert.equal(parseZonedIso('2026-10-18T09:00:00.000-03:00'), z);
  assert.equal(parseZonedIso('2026-10-18T14:30:00+02:30'), z);
  assert.equal(parseZonedIso('2026-10-18T12:00:00Z'), z);
  assert.equal(parseZonedIso('2026-10-18T12:00:00.5Z'), z + 500);
  assert.equal(parseZonedIso('2026-10-18T12:00:00.123Z'), z + 123);
});

test('idleSince: ambiguous or impossible values are refused, not guessed', () => {
  for (const bad of [
    '2026', '2026-10', '2026-10-18',                 // date only
    '2026-10-18T12:00:00', '2026-10-18T12:00:00.000', // no zone → would be read as LOCAL time
    '2026-10-18 12:00:00Z',                           // space separator
    '2026-10-18T12:00Z',                              // no seconds
    '2026-10-18T12:00:00.1234Z',                      // beyond ms: would be truncated silently
    '2026-10-18T12:00:00+0300', '2026-10-18T12:00:00+03', // offset without colon
    '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z',   // impossible dates (Date.parse rolls them)
    '2026-10-18T24:00:00Z', '2026-10-18T12:60:00Z',
    '2026-10-18T12:00:00+24:00',
    'Sun Oct 18 2026 12:00:00 GMT', 1792341391, null,
  ]) {
    assert.ok(Number.isNaN(parseZonedIso(bad)), `must refuse ${JSON.stringify(bad)}`);
    assert.equal(parseKillExpect({ expect: { idleSince: bad } }).ok, false, `expect must refuse ${JSON.stringify(bad)}`);
  }
});

test('idleSince is compared at the transcript\'s own precision: the same ms is not "after"', () => {
  const same = transcript;   // last turn exactly T0
  assert.deepEqual(killVerdict({ idleSince: parseZonedIso(T0) }, idle, () => same), { kill: true });
  assert.equal(killVerdict({ idleSince: parseZonedIso('2026-10-18T09:00:04.999Z') }, idle, () => same).kill, false);
});

/* ---------- the other keys ---------- */

test('expect is parsed: sessionId, status, idleSince', () => {
  const p = parseKillExpect({ expect: { sessionId: SID, status: ' idle ', idleSince: T0 } });
  assert.ok(p.ok);
  assert.deepEqual(p.expect, { sessionId: SID, status: 'idle', idleSince: Date.parse(T0) });
});

test('a guard the surface cannot honour refuses the request instead of being dropped', () => {
  for (const bad of [
    { expect: 'idle' }, { expect: [] }, { expect: null }, { expect: {} },
    { expect: { status: 'idle', lastTurn: 'x' } },
    { expect: { sessionId: 'a b; rm' } },
    { expect: { status: 42 } },
  ]) {
    assert.equal(parseKillExpect(bad as Record<string, unknown>).ok, false, `must refuse ${JSON.stringify(bad)}`);
    assert.equal(decideKill(held(bad), idle, () => transcript).kill, false);
  }
});

test('status changed → left running; control: same status → kill', () => {
  assert.equal(killVerdict({ status: 'idle' }, { status: 'busy', sessionId: SID }, () => '').kill, false);
  assert.equal(killVerdict({ status: 'idle' }, idle, () => '').kill, true);
});

test('another session holds the name → left running', () => {
  assert.equal(killVerdict({ sessionId: SID }, { status: 'idle', sessionId: 'ffff' }, () => '').kill, false);
});

test('the transcript is read only when idleSince asks for it', () => {
  let reads = 0;
  killVerdict({ status: 'idle' }, idle, () => { reads++; return transcript; });
  assert.equal(reads, 0);
});

test('no live target → nothing to protect, the kill goes ahead as before', () => {
  assert.deepEqual(killVerdict({ status: 'idle' }, undefined, () => ''), { kill: true });
});

/* ---------- 4. a writer can confirm support ---------- */

test('the App declares kill-expect in its presence record; a record without it does not count', () => {
  assert.equal(KILL_EXPECT_CAPABILITY, 'kill-expect');
  assert.equal(presenceHonoursExpect({ surface: 'app', pid: 9, capabilities: ['kill-expect'] }), true);
  for (const r of [undefined, null, {}, { surface: 'glass', pid: 9 }, { capabilities: 'kill-expect' }, { capabilities: [] }]) {
    assert.equal(presenceHonoursExpect(r), false, JSON.stringify(r));
  }
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /function presenceBody\([^)]*\)[^{]*\{\s*return \{[^}]*capabilities: \[KILL_EXPECT_CAPABILITY\]/, 'presence carries the capability');
  assert.equal((src.match(/const body = presenceBody\(root, appVersion\);/g) || []).length, 2, 'both presence writers (announce and heal) use it');
});

test('the inbox README tells writers to check the capability and pin the surface', () => {
  const src = fs.readFileSync('src/core/inboxReadme.ts', 'utf8');
  assert.match(src, /"kill-expect"/);
  assert.match(src, /"surface": "app"/);
  assert.match(src, /reduces the risk/);
});

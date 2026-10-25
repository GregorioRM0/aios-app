/**
 * Chat skin — following a transcript file live (main/transcriptTail), plus the invariants that keep
 * its wiring in main/preload honest. The tail imports nothing from electron, so these tests run it
 * for real against a temp folder: files that appear late, lines written in two halves, truncation,
 * and a watcher that must stop the moment it is told to.
 *
 * Fixtures are hand-written and neutral. Each behaviour has a NEGATIVE CONTROL beside it (the
 * half-line that must NOT be emitted yet, the unwatched pane that must stay silent).
 */
import { test, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTranscriptTail, locateTranscript, isSessionId, type TailEvent } from '../main/transcriptTail';
import type { ChatItem } from '../core/transcriptChat';

type Ev = { paneId: number } & TailEvent;
const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const line = (o: object): string => JSON.stringify(o) + '\n';
let n = 0;
const user = (text: string): string => line({ parentUuid: null, isSidechain: false, type: 'user', uuid: `u-${++n}`, message: { role: 'user', content: text } });
const answer = (text: string, stop = 'end_turn'): string =>
  line({ parentUuid: null, isSidechain: false, type: 'assistant', uuid: `a-${++n}`, message: { model: 'm', stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 1, cache_read_input_tokens: 10 } } });

function sandbox(): { base: string; dir: string; file: (sid?: string) => string; done: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-tail-'));
  const dir = path.join(base, '-some-project-slug');
  fs.mkdirSync(dir);
  return { base, dir, file: (sid = SID) => path.join(dir, `${sid}.jsonl`), done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function waitFor(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** Every tail a test makes is closed at the end even if the test threw, or a failure would leave an
 *  fs.watch handle open and the whole run would hang instead of reporting it. */
const made: Array<ReturnType<typeof createTranscriptTail>> = [];
const mkTail = (o: Parameters<typeof createTranscriptTail>[0]): ReturnType<typeof createTranscriptTail> => { const t = createTranscriptTail(o); made.push(t); return t; };
after(() => { for (const t of made) t.unwatchAll(); });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const textsOf = (evs: Ev[]): string[] => evs.flatMap((e) => (e.type === 'items' ? e.items.map((i: ChatItem) => i.text ?? '') : []));

test('a file that already exists is backfilled in one pass, then the end state is announced', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('first question') + answer('first answer'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25 });
  const r = await tail.watch(7, SID, (e) => evs.push(e));
  assert.deepEqual(r, { ok: true, file: sb.file() });
  await waitFor(() => evs.some((e) => e.type === 'turn'), 3000, 'the backfill to finish');
  assert.equal(evs[0].type, 'reset', 'the view is emptied before anything arrives');
  assert.deepEqual(textsOf(evs), ['first question', 'first answer']);
  const turn = evs.find((e) => e.type === 'turn');
  assert.deepEqual(turn && 'open' in turn ? turn.open : undefined, false);
  assert.ok(evs.every((e) => e.paneId === 7), 'every event carries the pane id');
  const usage = evs.find((e) => e.type === 'usage');
  assert.ok(usage && 'contextTokens' in usage && usage.contextTokens === 11);
  tail.unwatchAll(); sb.done();
});

test('a transcript that does not exist yet: not-found, a missing event, then it appears and streams', async () => {
  const sb = sandbox();
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 25 });
  const r = await tail.watch(1, SID, (e) => evs.push(e));
  assert.deepEqual(r, { ok: false, error: 'not-found' });
  assert.equal(evs.filter((e) => e.type === 'missing').length, 1, 'told once, not on every retry');
  await sleep(120);
  assert.equal(evs.filter((e) => e.type === 'missing').length, 1);
  assert.deepEqual(textsOf(evs), [], 'control: nothing to show while the file is absent');
  assert.deepEqual(tail.active(), [1], 'it keeps looking');

  fs.writeFileSync(sb.file(), user('hello from a new session'));
  await waitFor(() => textsOf(evs).includes('hello from a new session'), 3000, 'the late file');
  assert.ok(evs.some((e) => e.type === 'reset'), 'the arrival resets the view before streaming');
  tail.unwatchAll(); sb.done();
});

test('a line written in two halves is held back until its newline, and nothing is lost or duplicated', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('before'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(2, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));

  const whole = answer('a long answer with ünïcode and 日本語 inside');
  const cut = Math.floor(whole.length / 2);
  fs.appendFileSync(sb.file(), whole.slice(0, cut));
  await sleep(150);
  assert.deepEqual(textsOf(evs), ['before'], 'control: half a line is NOT emitted');
  assert.ok(!evs.some((e) => e.type === 'error'), 'and a half line is not an error');

  fs.appendFileSync(sb.file(), whole.slice(cut));
  await waitFor(() => textsOf(evs).length === 2, 3000, 'the second half');
  assert.deepEqual(textsOf(evs), ['before', 'a long answer with ünïcode and 日本語 inside']);
  await sleep(100);
  assert.equal(textsOf(evs).length, 2, 'no duplicate from later polls');
  tail.unwatchAll(); sb.done();
});

test('a multi-byte character split across two reads is decoded whole', async () => {
  const sb = sandbox();
  const reply = answer('日本語日本語日本語日本語');
  const CHUNK = 4096;   // the module's floor for a read
  // pad the first line until the first 3-byte character straddles the end of the first read
  let prefix = '';
  for (let k = 100; k < 2 * CHUNK; k++) {
    const p = user('x'.repeat(k));
    const at = Buffer.byteLength(p) + Buffer.byteLength(reply.slice(0, reply.indexOf('日')));
    if (at % CHUNK === CHUNK - 1) { prefix = p; break; }
  }
  assert.ok(prefix, 'found an alignment that splits a character');
  fs.writeFileSync(sb.file(), prefix + reply);
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20, chunkBytes: CHUNK });
  await tail.watch(3, SID, (e) => evs.push(e));
  await waitFor(() => textsOf(evs).length === 2);
  assert.equal(textsOf(evs)[1], '日本語日本語日本語日本語');
  assert.ok(!textsOf(evs).join('').includes('\ufffd'), 'no replacement characters');
  tail.unwatchAll(); sb.done();
});

test('appended lines stream incrementally with turn and usage updates', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), '');
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(4, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));
  const before = evs.length;
  fs.appendFileSync(sb.file(), user('live question'));
  await waitFor(() => evs.slice(before).some((e) => e.type === 'turn' && e.open === true), 3000, 'turn open');
  fs.appendFileSync(sb.file(), answer('live answer'));
  await waitFor(() => evs.slice(before).some((e) => e.type === 'turn' && e.open === false), 3000, 'turn closed');
  assert.deepEqual(textsOf(evs.slice(before)), ['live question', 'live answer']);
  assert.ok(evs.slice(before).some((e) => e.type === 'usage'));
  tail.unwatchAll(); sb.done();
});

test('unwatch stops emitting and leaves no watcher behind', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('one'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(5, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));
  assert.deepEqual(tail.active(), [5]);

  tail.unwatch(5);
  assert.deepEqual(tail.active(), []);
  const count = evs.length;
  fs.appendFileSync(sb.file(), answer('after unwatch'));
  await sleep(200);
  assert.equal(evs.length, count, 'silent after unwatch');

  // control: the same append IS seen while watching
  const seen: Ev[] = [];
  await tail.watch(5, SID, (e) => seen.push(e));
  await waitFor(() => textsOf(seen).includes('after unwatch'));
  // unwatching a pane that was never watched is harmless
  tail.unwatch(999);
  tail.unwatchAll();
  assert.deepEqual(tail.active(), []);
  sb.done();
});

test('unwatch while the file is still missing stops the search', async () => {
  const sb = sandbox();
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(6, SID, (e) => evs.push(e));
  tail.unwatch(6);
  fs.writeFileSync(sb.file(), user('too late'));
  await sleep(150);
  assert.deepEqual(textsOf(evs), []);
  assert.deepEqual(tail.active(), []);
  sb.done();
});

test('changing the session id on a pane drops the old watch and starts the new one', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(SID), user('old session'));
  fs.writeFileSync(sb.file(SID2), user('new session'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(8, SID, (e) => evs.push(e));
  await waitFor(() => textsOf(evs).includes('old session'));
  const r = await tail.watch(8, SID2, (e) => evs.push(e));
  assert.deepEqual(r, { ok: true, file: sb.file(SID2) });
  await waitFor(() => textsOf(evs).includes('new session'));
  assert.deepEqual(tail.active(), [8], 'one watcher per pane');

  const count = evs.length;
  fs.appendFileSync(sb.file(SID), answer('old file still growing'));
  await sleep(150);
  assert.equal(evs.length, count, 'the old file no longer reaches the pane');
  fs.appendFileSync(sb.file(SID2), answer('new file growing'));
  await waitFor(() => textsOf(evs).includes('new file growing'));
  tail.unwatchAll(); sb.done();
});

test('truncation or replacement resets the view and re-reads from the top', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('a long original line number one') + answer('a long original answer'));
  const evs: Ev[] = [];
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  await tail.watch(9, SID, (e) => evs.push(e));
  await waitFor(() => textsOf(evs).length === 2);
  const resets = evs.filter((e) => e.type === 'reset').length;

  fs.writeFileSync(sb.file(), user('new'));   // shorter than what was read: a truncate/replace
  await waitFor(() => textsOf(evs).includes('new'), 3000, 'the re-read');
  assert.equal(evs.filter((e) => e.type === 'reset').length, resets + 1);
  tail.unwatchAll(); sb.done();
});

test('finish takes a last pass before stopping (the closing lines land as the session exits)', async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file(), user('q'));
  const evs: Ev[] = [];
  // a poll so slow it cannot be what picks the last line up
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 60_000 });
  await tail.watch(10, SID, (e) => evs.push(e));
  await waitFor(() => evs.some((e) => e.type === 'turn'));
  fs.appendFileSync(sb.file(), answer('the very last answer'));
  await tail.finish(10);
  assert.ok(textsOf(evs).includes('the very last answer'));
  assert.deepEqual(tail.active(), []);
  sb.done();
});

test('ids that are not id-shaped never touch the filesystem', async () => {
  const sb = sandbox();
  const tail = mkTail({ projectsDir: () => sb.base, pollMs: 20 });
  for (const bad of ['', '..', '../../etc/passwd', 'short', 'a/b/cccccccc', 'ok-but with space', 'x'.repeat(8) + '/..']) {
    assert.deepEqual(await tail.watch(11, bad, () => {}), { ok: false, error: 'bad-id' }, JSON.stringify(bad));
  }
  assert.deepEqual(tail.active(), []);
  assert.equal(isSessionId(SID), true, 'control: a real id is accepted');
  assert.equal(await locateTranscript(sb.base, '../' + SID), undefined);
  sb.done();
});

test('locateTranscript searches every project folder and honours the injected base', async () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.base, '-other-slug'));
  fs.writeFileSync(path.join(sb.base, '-other-slug', `${SID2}.jsonl`), '');
  assert.equal(await locateTranscript(sb.base, SID2), path.join(sb.base, '-other-slug', `${SID2}.jsonl`));
  assert.equal(await locateTranscript(sb.base, SID), undefined, 'control: absent stays absent');
  assert.equal(await locateTranscript(path.join(sb.base, 'nope'), SID2), undefined, 'a missing base is not an error');
  sb.done();
});

// ── wiring invariants (source) ──────────────────────────────────────────────

const read = (f: string): string => fs.readFileSync(f, 'utf8');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
const aios = read('src/main/aios.ts');

test('main and preload agree on every chatSkin channel, and the SDK is gone', () => {
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('(chatSkin:[a-zA-Z]+|chat:[a-zA-Z]+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('(chatSkin:[a-zA-Z]+|chat:[a-zA-Z]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...invoked].sort(), ['chat:status', 'chatSkin:unwatch', 'chatSkin:watch']);
  assert.deepEqual([...handled].sort(), [...invoked].sort(), 'a channel with only one side is a button that does nothing');
  assert.match(preload, /ipcRenderer\.on\('chatSkin:event'/);
  assert.match(main, /sender\.send\('chatSkin:event', ev\)/);
  for (const gone of ['chatStart', 'chatSend', 'chatInterrupt', 'chatPermission', 'chatClose', 'onChatEvent']) {
    assert.doesNotMatch(preload, new RegExp(`\\b${gone}\\b`), `${gone} belonged to the SDK chat`);
  }
  for (const gone of ["'chat:start'", "'chat:send'", "'chat:interrupt'", "'chat:permission'", "'chat:close'"]) {
    assert.ok(!main.includes(gone), `${gone} belonged to the SDK chat`);
  }
  assert.doesNotMatch(main, /chatSession|createChatManager|claude-agent-sdk/);
  assert.equal(fs.existsSync('src/main/chatSession.ts'), false);
  assert.doesNotMatch(read('package.json'), /claude-agent-sdk/);
});

test('the preload exposes exactly the contract the renderer programs against', () => {
  assert.match(preload, /chatSkinWatch: \(paneId: number, sessionId: string \| null\): Promise<\{ ok: true; file: string \} \| \{ ok: false; error: string \}>/);
  assert.match(preload, /chatSkinUnwatch: \(paneId: number\): Promise<void>/);
  assert.match(preload, /onChatSkinEvent: \(cb: \(ev: ChatSkinEvent\) => void\)/);
  assert.match(preload, /chatStatus: \(\): Promise<ChatStatus>/);
  for (const t of ['reset', 'items', 'turn', 'usage', 'prompt', 'missing', 'error']) {
    assert.match(preload, new RegExp(`type: '${t}'`), `event type ${t} is part of the contract`);
  }
});

test('the watch is tied to the pty: fed by its output, ended by its exit, kill, and the window', () => {
  assert.match(main, /sk\.monitor\.push\(data\)/, 'pty output feeds the dialog detector (until the renderer sends real screens)');
  assert.match(main, /p\.onExit\([^\n]*endSkin\(id, true\)/, 'pty exit ends the watch (after a last pass)');
  assert.match(main, /ipcMain\.on\('pty:kill'[^\n]*endSkin\(id, false\)/, 'a killed pane ends the watch');
  assert.match(main, /sender\.once\('destroyed', onGone\)/, 'a destroyed window ends the watch');
  assert.match(main, /removeListener\('destroyed', k\.onGone\)/, 'and the listener does not pile up');
  assert.match(main, /win\.on\('closed', \(\) => \{ tail\.unwatchAll\(\)/);
  assert.match(main, /app\.on\('before-quit', \(\) => \{ tail\.unwatchAll\(\)/);
  // the pane id is the pty id: the id pty:spawn hands out is the one the skin map is keyed by
  assert.match(main, /const id = nextId\+\+;\n\s+ptys\.set\(id, p\);/);
  assert.match(main, /k = \{ sender, monitor, onGone, screenFed: false \};\n\s+skins\.set\(id, k\)/);
});

test('a dialog is cleared only by proof from the transcript, not by assistant text', () => {
  const m = /monitor\.clear\(\);/.exec(main);
  assert.ok(m, 'the monitor is cleared somewhere');
  assert.match(main, /it\.role === 'user' \|\| \(it\.tool && it\.tool\.status !== 'running'\)/);
});

test('chatViewDefault is a boolean setting, off unless literally true, and settable', () => {
  assert.match(aios, /chatViewDefault: boolean/);
  assert.match(aios, /chatViewDefault: raw\.chatViewDefault === true/);
  assert.match(main, /'lidAsked' \| 'chatViewDefault', value: unknown\)/);
});

test('chat:status reads the global statusline payload without the SDK', () => {
  assert.match(main, /ipcMain\.handle\('chat:status', async \(\) => \{/);
  assert.match(main, /statusline-payload\.json/);
  assert.match(main, /mergeStatus\(undefined, parseStatuslinePayload\(/);
});

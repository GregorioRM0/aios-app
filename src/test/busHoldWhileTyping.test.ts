/**
 * #81 — a bus message is never typed into a prompt the operator is writing (Luigi, 26 Oct:
 * "sessions jump in" while he types). The pane reports its operator's keystrokes (renderer
 * noteOperatorKeys, lifted from the source here); the bus holds while operatorComposing says so,
 * inside its own readiness checks and budgets (source invariant below).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { operatorComposing, COMPOSE_QUIET_MS, COMPOSE_STALE_MS } from '../main/retypeGuard';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
const fn = (/const TERM_REPLY = [^\n]+/.exec(app)?.[0] ?? '') + '\n' + (/function noteOperatorKeys\(p, d\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '');

function keys() {
  const sent: Array<[string, boolean]> = [];
  const ctx: Record<string, unknown> = {
    window: { glassShell: { busComposing: (n: string, c: boolean) => sent.push([n, c]) } },
    Date: { now: () => 1_000_000 },
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.note = noteOperatorKeys;', ctx);
  return { note: ctx.note as (p: object, d: string) => void, sent };
}

test('the renderer helper exists and reports to the bus', () => { assert.ok(fn, 'noteOperatorKeys in renderer/app.js'); });

test('typing is a draft; Enter and Ctrl-C end it; Ctrl-U does not (it may clear only to the cursor)', () => {
  const { note, sent } = keys(); const p: Record<string, unknown> = { name: 'ali' };
  note(p, 'half a sen'); assert.equal(p.composing, true);
  note(p, '\r'); assert.equal(p.composing, false);
  note(p, 'x'); note(p, '\x03'); assert.equal(p.composing, false);
  note(p, 'y'); note(p, '\x1b[D\x1b[D'); note(p, '\x15'); assert.equal(p.composing, true, 'text after the cursor may remain');
  assert.deepEqual(sent[0], ['ali', true]);
});

test('an up-arrow recalls a prompt, so it is a draft', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, '\x1b[A'); assert.equal(p.composing, true);
});

test('a bracketed paste with line breaks stays a draft until a real Enter', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, '\x1b[200~line one\rline two\r\x1b[201~'); assert.equal(p.composing, true);
  note(p, '\x1b[200~split'); note(p, ' paste\r'); assert.equal(p.composing, true, 'still inside the paste');
  note(p, '\x1b[201~'); note(p, '\r'); assert.equal(p.composing, false);
});

test('text after the last Enter in one chunk is a new draft', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, 'sent\rnext'); assert.equal(p.composing, true);
});

test('the bus holds while composing or within the quiet window, and not otherwise', () => {
  assert.equal(operatorComposing(undefined, 0), false);
  assert.equal(operatorComposing({ composing: true, at: 0 }, 10 * 60_000), true);
  assert.equal(operatorComposing({ composing: false, at: 0 }, COMPOSE_QUIET_MS - 1), true);
  assert.equal(operatorComposing({ composing: false, at: 0 }, COMPOSE_QUIET_MS), false);
});

test('the hold sits in the bus loop, before every type, and gives up under the hold budget', () => {
  const at = bus.indexOf('if (operatorComposing(composing.get(sessionKey(req.name)), Date.now()))');
  assert.ok(at > 0, 'runSend checks composing');
  assert.ok(at < bus.indexOf("emit(win(), 'sendByName'"), 'before it types');
  assert.match(bus.slice(at, at + 600), /MAX_HOLD_MS[\s\S]*markUndelivered/);
  assert.doesNotMatch(app, /holdBusSend/, 'the renderer never types a held message on its own');
});

test('the pane re-checks with no gap and the bus keeps the request without spending an attempt', () => {
  const send = /case 'sendByName': \{[\s\S]*?\n    \}/.exec(app)?.[0] ?? '';
  assert.ok(send.indexOf('BUS_DEFERRED_TYPING') > 0 && send.indexOf('BUS_DEFERRED_TYPING') < send.indexOf('submitToPty'));
  const r = /const BUS_DEFERRED_TYPING = '([^']+)'/.exec(app)?.[1];
  const m = /const DEFERRED_TYPING = '([^']+)'/.exec(bus)?.[1];
  assert.ok(r && r === m, 'renderer and bus agree on the deferred reason');
  const branch = bus.slice(bus.indexOf('sendResult.reason === DEFERRED_TYPING'), bus.indexOf('if (releaseForSibling'));
  assert.match(branch, /attempts--/);
  assert.doesNotMatch(branch, /markUndelivered|releaseForSibling/);
});

test('a dropped path counts as a draft', () => {
  assert.match(app, /attachDropZone\(el, \(paths\) => \{ noteOperatorKeys\(p, 'drop'\);/);
});

test('a deferral is a timed hold: it never latches a draft the pane did not report', () => {
  const branch = bus.slice(bus.indexOf('sendResult.reason === DEFERRED_TYPING'), bus.indexOf('if (releaseForSibling'));
  assert.match(branch, /composing: !!prev && prev\.composing, at: Date\.now\(\)/);
  assert.doesNotMatch(branch, /composing: true/);
});

test('ESC-Enter (a new line inside the draft) does not end it', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, 'line one'); note(p, '\x1b\r'); assert.equal(p.composing, true);
});

test('a draft report goes stale; an ended pane clears its draft', () => {
  assert.equal(operatorComposing({ composing: true, at: 0 }, COMPOSE_STALE_MS - 1), true);
  assert.equal(operatorComposing({ composing: true, at: 0 }, COMPOSE_STALE_MS), false);
  assert.match(app, /p\.exited = true; if \(p\.composing && p\.name\) \{ p\.composing = false; window\.glassShell\.busComposing\(p\.name, false\); \}/);
});

test('an earlier copy that landed is found before any draft hold or its timeout', () => {
  assert.ok(bus.indexOf('landedBeforeRetype(!!firstTypedAt') < bus.indexOf('if (operatorComposing(composing.get'));
});

test('terminal replies (focus, cursor position, device attributes, mouse) never make a draft', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  for (const r of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;10;1c', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[<0;10;5M', '\x1b[?2004;1$y']) {
    note(p, r);
    assert.notEqual(p.composing, true, JSON.stringify(r));
  }
  assert.equal(p.lastKeyAt, undefined, 'and they do not count as a key');
  note(p, 'x'); assert.equal(p.composing, true);
});

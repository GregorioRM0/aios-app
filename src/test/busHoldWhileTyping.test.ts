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
import { operatorComposing, COMPOSE_QUIET_MS } from '../main/retypeGuard';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
const fn = /function noteOperatorKeys\(p, d\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '';

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

test('typing is a draft; Enter, Ctrl-C and Ctrl-U end it', () => {
  const { note, sent } = keys(); const p: Record<string, unknown> = { name: 'ali' };
  note(p, 'half a sen'); assert.equal(p.composing, true);
  note(p, '\r'); assert.equal(p.composing, false);
  note(p, 'x'); note(p, '\x03'); assert.equal(p.composing, false);
  note(p, 'y'); note(p, '\x15'); assert.equal(p.composing, false);
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

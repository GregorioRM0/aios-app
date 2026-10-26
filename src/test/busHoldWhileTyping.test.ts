/**
 * #81 — a bus message is never typed into a prompt the operator is writing (Luigi, 26 Oct:
 * "sessions jump in" while he types). The helpers live in renderer/app.js, so this test lifts them
 * out of the source and runs them against a fake pane, a fake clock and a fake timer.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const lift = (re: RegExp): string => { const m = re.exec(app); assert.ok(m, `found ${re}`); return m![0]; };
const src = [
  lift(/const COMPOSE_QUIET_MS = \d+;/),
  lift(/const HELD_MAX_MS = [^;]+;/),
  lift(/function noteOperatorKeys\(p, d\) \{[\s\S]*?\n\}/),
  lift(/function operatorComposing\(p, now\) \{[\s\S]*?\n\}/),
  lift(/function holdBusSend\(id, p, text\) \{[\s\S]*?\n\}\n/),
].join('\n');

function harness() {
  const typed: string[] = [];
  let tick: (() => void) | null = null;
  let now = 1_000_000;
  const ctx: Record<string, unknown> = {
    submitToPty: (_id: number, t: string) => typed.push(t),
    setInterval: (f: () => void) => { tick = f; return 1; },
    clearInterval: () => { tick = null; },
    Date: { now: () => now },
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.noteOperatorKeys = noteOperatorKeys; this.holdBusSend = holdBusSend;', ctx);
  return {
    typed, ctx,
    advance(ms: number) { now += ms; },
    tick() { if (tick) tick(); },
    get armed() { return tick !== null; },
  };
}

test('idle pane: the message is typed at once', () => {
  const h = harness(); const p: Record<string, unknown> = {};
  h.advance(60_000);
  (h.ctx.holdBusSend as Function)(1, p, 'hello');
  assert.deepEqual(h.typed, ['hello']);
});

test('a draft in progress holds the message until it is sent, then types it once', () => {
  const h = harness(); const p: Record<string, unknown> = { isSession: true };
  (h.ctx.noteOperatorKeys as Function)(p, 'half a sen');
  (h.ctx.holdBusSend as Function)(1, p, 'bus msg');
  (h.ctx.holdBusSend as Function)(1, p, 'bus msg');            // the bus re-types while it waits
  h.advance(60_000); h.tick();
  assert.deepEqual(h.typed, [], 'a draft left unsent still holds it');
  (h.ctx.noteOperatorKeys as Function)(p, '\r');                // he sends his own message
  h.tick(); assert.deepEqual(h.typed, [], 'not within the quiet window after his Enter');
  h.advance(9_000); h.tick();
  assert.deepEqual(h.typed, ['bus msg'], 'typed once, after the quiet window');
  assert.equal(h.armed, false);
});

test('arrows and pastes count as a draft (up-arrow recalls a prompt); Ctrl-U clears one', () => {
  const h = harness(); const p: Record<string, unknown> = {};
  (h.ctx.noteOperatorKeys as Function)(p, '\x1b[A');
  assert.equal(p.composing, true);
  (h.ctx.noteOperatorKeys as Function)(p, '\x1b[200~pasted\x1b[201~');
  assert.equal(p.composing, true);
  (h.ctx.noteOperatorKeys as Function)(p, '\x15');
  assert.equal(p.composing, false);
});

test('a held message is dropped, never typed, if the pane stops being the session', () => {
  const h = harness(); const p: Record<string, unknown> = { isSession: true };
  (h.ctx.noteOperatorKeys as Function)(p, 'draft');
  (h.ctx.holdBusSend as Function)(1, p, 'rm -rf in a shell would be bad');
  p.isSession = false; p.composing = false; h.advance(60_000); h.tick();
  assert.deepEqual(h.typed, []);
  assert.equal(h.armed, false);
});

test('a held message expires before the bus gives up, so it is never typed after a dead letter', () => {
  const h = harness(); const p: Record<string, unknown> = { isSession: true };
  (h.ctx.noteOperatorKeys as Function)(p, 'a long draft');
  (h.ctx.holdBusSend as Function)(1, p, 'late');
  h.advance(26 * 60 * 1000); h.tick();
  (h.ctx.noteOperatorKeys as Function)(p, '\r'); h.advance(9_000); h.tick();
  assert.deepEqual(h.typed, []);
});

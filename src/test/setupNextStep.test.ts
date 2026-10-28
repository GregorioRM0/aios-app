/**
 * The next Setup step is always on screen.
 *
 * Operator-reported: the stepper was drawn in sequence order, so every finished step stayed above
 * the active one, and once git and node were installed the button that mattered ("Set up my AIOS")
 * sat below the fold — reachable only by a scroll nothing hinted at. The fix draws the active step
 * FIRST, brings a newly-active step into view and focuses its primary action, and announces it.
 *
 * The ordering is EXECUTED (the real `setupStepOrder`, lifted out of renderer/app.js the way
 * closeSameName.test.ts does), because the guarantee is about which step comes first. The paint
 * wiring is asserted on the source, like the rest of this suite's renderer checks.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function grab(re: RegExp, what: string): string {
  const m = re.exec(app);
  if (!m) assert.fail(`${what} must be findable in renderer/app.js`);
  return m[0];
}

type Step = { id: string; done: boolean };
const order = new Function(`${grab(/function setupStepOrder\(steps, current\) \{[\s\S]*?\n\}/, 'setupStepOrder')}\nreturn setupStepOrder;`)() as
  (steps: Step[], current: number) => number[];
const steps = (done: boolean[]): Step[] => ['prereqs', 'login', 'github', 'firstrun'].map((id, i) => ({ id, done: done[i] }));

test('the active step is drawn first, the rest pending after it, the finished ones last', () => {
  // the reported case: tools installed, signed in, GitHub done → "Set up my AIOS" must lead
  assert.deepEqual(order(steps([true, true, true, false]), 3), [3, 0, 1, 2]);
  assert.deepEqual(order(steps([true, false, false, false]), 1), [1, 2, 3, 0]);
  // a later step can pass before an earlier one (GitHub before login): still pending order, then done
  assert.deepEqual(order(steps([true, false, true, false]), 1), [1, 3, 0, 2]);
});

test('nothing done → plain sequence; everything done → plain sequence (no "next" to pin)', () => {
  assert.deepEqual(order(steps([false, false, false, false]), 0), [0, 1, 2, 3]);
  assert.deepEqual(order(steps([true, true, true, true]), 4), [0, 1, 2, 3]);
});

test('every step is drawn exactly once, whatever the state', () => {
  for (let mask = 0; mask < 16; mask++) {
    const done = [0, 1, 2, 3].map((b) => !!(mask & (1 << b)));
    const current = done.indexOf(false) < 0 ? 4 : done.indexOf(false);
    assert.deepEqual([...order(steps(done), current)].sort(), [0, 1, 2, 3], `mask ${mask}`);
  }
});

test('paint draws in that order, and keeps each step\'s own number', () => {
  assert.match(app, /const order = setupStepOrder\(st\.steps, st\.current\);/);
  assert.match(app, /list\.appendChild\(stepEl\(s, i\)\);/, 'stepEl still gets the step\'s own index, so "4" stays "4"');
  assert.match(app, /t\('setup\.alreadyDone'\)/, 'the finished group is labelled, so the order reads as intended');
});

test('a NEW next step is scrolled into view and focused — once, and never from someone typing', () => {
  const i = app.indexOf('if (st.current !== prevCurrent) {');
  assert.ok(i > 0, 'only on a change of the active step — the 5 s poll must not drag a reader back');
  const block = app.slice(i, app.indexOf('prevCurrent = st.current;', i));
  assert.match(block, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  assert.match(block, /ae\.tagName === 'TEXTAREA' \|\| ae\.tagName === 'INPUT' \|\| ae\.isContentEditable/,
    'the setup session is a terminal (xterm textarea) the operator types into beside this tab');
  assert.match(block, /action\.focus\(\{ preventScroll: true \}\)/);
  assert.match(block, /announce\.textContent = /);
  assert.match(app, /announce\.setAttribute\('aria-live', 'polite'\)/);
});

test('the "why" note moves under the steps once progress exists', () => {
  assert.match(app, /if \(st\.current > 0\) \{ if \(why\.nextSibling !== announce\) wrap\.insertBefore\(why, announce\); \}/);
});

test('the new strings exist in every locale, and the hidden class is real', () => {
  for (const l of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(path.join('src/i18n/locales', `${l}.json`), 'utf8')) as Record<string, string>;
    assert.ok(j['setup.alreadyDone'], `${l}: setup.alreadyDone`);
    assert.match(j['setup.nextStepAnnounce'] || '', /\{n\}[\s\S]*\{total\}[\s\S]*\{name\}/, `${l}: setup.nextStepAnnounce`);
  }
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.sr-only \{[^}]*clip: rect\(0, 0, 0, 0\)/);
  assert.match(css, /\.steps-donelab \{[^}]*var\(--subtle\)/, 'a token, not a pinned colour — both themes');
});

/**
 * A tab whose session has ended must not make its name ambiguous.
 *
 * 11 Oct 2026: six duplicate chats were closed by pid from a shell. Their tabs stayed, marked
 * `exited` by onPtyExit, and `ambiguous()` still counted them, so every bus send to those six
 * names was refused for 80 minutes ("two live sessions are called X"). These tests execute the
 * real `ambiguous` and `byName` against one live and one ended pane sharing a name.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const grab = (re: RegExp, what: string) => { const m = re.exec(app); if (!m) assert.fail(`${what} must be findable`); return m[0]; };

type Pane = { kind: string; name: string; sessionId: string | null; exited?: boolean };
function load(entries: Array<[number, Pane]>) {
  const panes = new Map<number, Pane>(entries);
  const src = [
    grab(/const byName = \(name, id\) => \{[\s\S]*?\n\};/, 'byName'),
    grab(/const ambiguous = \(name\) =>\n[^\n]*;/, 'ambiguous'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('panes', `${src}\nreturn { byName, ambiguous };`)(panes) as {
    byName: (n: string, id?: string) => [number, Pane] | undefined; ambiguous: (n: string) => boolean };
}

test('an ended tab does not make a live name ambiguous', () => {
  const f = load([[1, { kind: 'term', name: 'health', sessionId: 'a', exited: true }],
                  [2, { kind: 'term', name: 'health', sessionId: 'b' }]]);
  assert.equal(f.ambiguous('health'), false);
  assert.equal(f.byName('health')?.[0], 2, 'the live pane is chosen, not the first one');
});

test('two live tabs with one name are still ambiguous', () => {
  const f = load([[1, { kind: 'term', name: 'health', sessionId: 'a' }],
                  [2, { kind: 'term', name: 'health', sessionId: 'b' }]]);
  assert.equal(f.ambiguous('health'), true);
});

test('only ended tabs: not ambiguous, and the lookup still finds one', () => {
  const f = load([[1, { kind: 'term', name: 'market-desk', sessionId: 'a', exited: true }],
                  [2, { kind: 'term', name: 'market-desk', sessionId: 'b', exited: true }]]);
  assert.equal(f.ambiguous('market-desk'), false);
  assert.equal(f.byName('market-desk')?.[0], 1);
});

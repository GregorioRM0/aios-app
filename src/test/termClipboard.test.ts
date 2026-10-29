/**
 * Ctrl+C / Ctrl+V in the terminal on Windows and Linux.
 *
 * The bug: off macOS, xterm turned Ctrl+V into a raw ^V (0x16) for the pty, so nothing pasted —
 * and Windows clipboard history (Win+V) pastes an older entry by SYNTHESIZING a Ctrl+V, so it
 * failed the same way. Ctrl+C always sent ^C, even over a selection.
 *
 * The decision is EXECUTED here (extracted from renderer/app.js), because the one property that
 * must never regress is behavioural: Ctrl+C with no selection is still SIGINT. A regex can only
 * say the code still looks a certain way.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

type Key = { type?: string; keyCode: number; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean };
const src = /function termClipboardKey\(e, mac, hasSelection, linux\) \{[\s\S]*?\n\}/.exec(app);
assert.ok(src, 'termClipboardKey must be findable in renderer/app.js');
const decide = new Function(`${src![0]} return termClipboardKey;`)() as
  (e: Key, mac: boolean, hasSelection: boolean, linux?: boolean) => 'copy' | 'paste' | null;

const C = 67, V = 86;
const ev = (keyCode: number, mods: Partial<Key> = {}): Key =>
  ({ type: 'keydown', keyCode, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('Ctrl+C with a selection copies', () => {
  assert.equal(decide(ev(C), false, true), 'copy');
  assert.equal(decide(ev(C, { shiftKey: true }), false, true), 'copy', 'Ctrl+Shift+C copies too');
});

test('Ctrl+C with NO selection is left alone — it must stay SIGINT', () => {
  assert.equal(decide(ev(C), false, false), null, 'null = xterm sends ^C exactly as before');
  // and Ctrl+Shift+C with nothing selected keeps whatever it did before (the Run command accelerator)
  assert.equal(decide(ev(C, { shiftKey: true }), false, false), null);
});

test('Ctrl+V and Ctrl+Shift+V paste, selection or not', () => {
  for (const sel of [false, true]) {
    assert.equal(decide(ev(V), false, sel), 'paste');
    assert.equal(decide(ev(V, { shiftKey: true }), false, sel), 'paste');
  }
});

test('Linux takes only Ctrl+Shift+C/V — plain Ctrl+V stays Claude Code\'s image paste', () => {
  assert.equal(decide(ev(V), false, false, true), null, 'plain Ctrl+V reaches the session');
  assert.equal(decide(ev(V), false, true, true), null, 'even over a selection');
  assert.equal(decide(ev(C), false, true, true), null, 'plain Ctrl+C stays SIGINT, selection or not');
  assert.equal(decide(ev(V, { shiftKey: true }), false, false, true), 'paste');
  assert.equal(decide(ev(C, { shiftKey: true }), false, true, true), 'copy');
  assert.equal(decide(ev(C, { shiftKey: true }), false, false, true), null, 'nothing selected → untouched');
});

test('CONTROL: Windows still pastes on plain Ctrl+V (clipboard history synthesizes it)', () => {
  assert.equal(decide(ev(V), false, false, false), 'paste');
});

test('macOS is untouched — ⌘ keeps its own handling and Ctrl stays a control key', () => {
  assert.equal(decide(ev(V), true, false), null);
  assert.equal(decide(ev(C), true, true), null);
  assert.equal(decide(ev(C, { ctrlKey: false, metaKey: true }), true, true), null);
});

test('Alt, AltGr and keyup are not clipboard keys', () => {
  assert.equal(decide(ev(V, { ctrlKey: false, altKey: true }), false, false), null, 'Alt+V still reaches the session');
  assert.equal(decide(ev(C, { ctrlKey: false, altKey: true }), false, true), null, 'Alt+C still reaches the session');
  assert.equal(decide(ev(V, { altKey: true }), false, false), null, 'AltGr arrives as Ctrl+Alt on Windows');
  assert.equal(decide(ev(V, { type: 'keyup' }), false, false), null, 'only keydown decides');
  assert.equal(decide(ev(65), false, true), null, 'Ctrl+A is not ours');
});

test('the terminal key handler consults it before the macOS-only early return', () => {
  const h = /term\.attachCustomKeyEventHandler\(\(e\) => \{[\s\S]*?\n {2}\}\);/.exec(app);
  assert.ok(h, 'the terminal key handler must be findable');
  const body = h[0];
  const at = body.indexOf('termClipboardKey(e, IS_MAC, term.hasSelection(), IS_LINUX)');
  const macGate = body.indexOf("if (e.type !== 'keydown' || !e.metaKey || e.altKey) return true;");
  assert.ok(at > 0, 'the handler must ask termClipboardKey');
  assert.ok(macGate > at, 'and must ask BEFORE the ⌘-only gate, which returns early for every Ctrl key');
});

test('paste is left to xterm\'s native paste path — one writer, bracketed', () => {
  // Returning false WITHOUT preventDefault is the whole mechanism: xterm skips the key (no ^V)
  // and Chromium's default Ctrl+V fires the native `paste` event xterm already handles.
  assert.match(app, /if \(clip === 'paste'\) return false;/, 'the paste branch must only decline the key');
  assert.doesNotMatch(app, /clip === 'paste'[^\n]*(preventDefault|ptyWrite|readText|\.paste\()/,
    'a hand-rolled write or a preventDefault here would double-paste or kill the paste');
  const copy = /if \(clip === 'copy'\) \{[\s\S]*?return false;\s*\}/.exec(app);
  assert.ok(copy, 'the copy branch must be findable');
  assert.match(copy[0], /e\.preventDefault\(\)/, 'copy must keep the keystroke handled (no ^C, no Run command)');
  assert.match(copy[0], /copyText\(term\.getSelection\(\)\)/, 'copy must write the selection');
  assert.match(copy[0], /term\.clearSelection\(\)/, 'copy clears the selection, as Windows Terminal does');
});

test('every terminal the App shows gets these keys — there is ONE terminal constructor and ONE key handler', () => {
  /* The setup session, ritual panes, spawned workers and plain terminals all open through
     createPane (spawnNamed included), which is the only place an xterm is built. If a second
     `new Terminal(` ever appears, it would ship without Ctrl+C / Ctrl+V — so this fails first. */
  assert.equal((app.match(/new Terminal\(/g) || []).length, 1, 'one place builds a terminal');
  assert.equal((app.match(/\.attachCustomKeyEventHandler\(/g) || []).length, 1, 'and one handler decides its keys');
  const spawnNamed = /function spawnNamed\([\s\S]*?\n\}/.exec(app);
  assert.ok(spawnNamed, 'spawnNamed must be findable');
  assert.match(spawnNamed[0], /createPane\(/, 'the setup session and every named session open through createPane');
});

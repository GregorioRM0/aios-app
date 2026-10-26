/**
 * Chat skin — the assistant reply that is being written, read off the TUI screen (core/screenStream).
 *
 * Every screen below is written by hand to match the STRUCTURE the CLI paints (the `⏺` bullet and its
 * two-column gutter, `⎿` tool results, a spinner line, the input box, footer hints); none is a copy of a
 * real session. The half that matters most is the NEGATIVE half: the extractor feeds a bubble the
 * operator reads, so spinner text, the input box and the statusline must never end up in it, and a
 * screen with no reply being written (idle, a dialog, only tools) must give null.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractStreaming, sameMessage, anchorOf, normalizeForMatch, STREAM_ANCHOR_WORDS } from '../core/screenStream';

const RULE = '─'.repeat(56);
const BOX = ['╭' + RULE + '╮', '│ > ' + ' '.repeat(52) + ' │', '╰' + RULE + '╯'];
const FOOTER = ['  ? for shortcuts                                  Context 12%'];
const SPIN = '✻ Thinking… (4s · ↓ 312 tokens · esc to interrupt)';
const screen = (...parts: Array<string | string[]>): string => parts.flat().join('\n');

const STREAMING = screen(
  '> make the sync client retry with backoff',
  '',
  '⏺ I read the sync module and found two causes. The first is that the',
  '  retry timer is never reset after a success, so the client keeps backing',
  '  off long after the network is back.',
  '',
  SPIN,
  '',
  BOX,
  FOOTER,
);

test('the reply in progress comes back clean: no bullet, spinner, input box or footer', () => {
  const r = extractStreaming(STREAMING);
  assert.ok(r);
  assert.equal(r.text, 'I read the sync module and found two causes. The first is that the retry timer is never reset after a success, so the client keeps backing off long after the network is back.');
  assert.equal(r.headCut, false);
  for (const noise of ['⏺', 'Thinking', 'esc to interrupt', 'tokens', '> ', '? for shortcuts', 'Context 12%', '╭', '│']) {
    assert.ok(!r.text.includes(noise), `"${noise}" must not leak into the text`);
  }
});

test('the other spinner phrasings and the star/dot glyphs are noise too', () => {
  for (const spin of ['· Pondering… (esc to interrupt)', '✶ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)', '✻ Thinking…', '✽ Running… (3s)', '* Hatching… (7s · esc to interrupt)']) {
    const r = extractStreaming(screen('⏺ Working on it now.', '', spin, '', BOX, FOOTER));
    assert.equal(r?.text, 'Working on it now.', spin);
  }
  // an "esc to interrupt" hint on its own line also marks a live turn
  assert.equal(extractStreaming(screen('⏺ Partial answer', '  (esc to interrupt)', BOX))?.text, 'Partial answer');
});

test('wrapped lines are rejoined, paragraphs and list items are kept apart', () => {
  const r = extractStreaming(screen(
    '⏺ Here is the plan, which has a few steps and',
    '  needs a little care:',
    '',
    '  1. Read the config file and check that the',
    '     port is not already taken',
    '  2. Change the port',
    '',
    '  • a bullet item',
    '  • another one that wraps because it is',
    '    long enough to need a second row',
    '',
    'ignored flush-left system line',
    SPIN, BOX,
  ));
  assert.equal(r, null, 'flush-left output after the block ends it: the last block is not text');
  const ok = extractStreaming(screen(
    '⏺ Here is the plan, which has a few steps and',
    '  needs a little care:',
    '',
    '  1. Read the config file and check that the',
    '     port is not already taken',
    '  2. Change the port',
    '',
    '  • a bullet item',
    '  • another one that wraps because it is',
    '    long enough to need a second row',
    SPIN, BOX,
  ));
  assert.equal(ok?.text, [
    'Here is the plan, which has a few steps and needs a little care:',
    '',
    '1. Read the config file and check that the port is not already taken',
    '2. Change the port',
    '',
    '• a bullet item',
    '• another one that wraps because it is long enough to need a second row',
  ].join('\n'));
});

test('partial markdown is returned as painted: a half-written code block, an unclosed bold, a cut table', () => {
  const code = extractStreaming(screen('⏺ Use this:', '', '    const retry = (fn) => {', '      return backoff(fn)', SPIN, BOX));
  assert.equal(code?.text, 'Use this:\n\n  const retry = (fn) => {\n    return backoff(fn)');
  assert.equal(extractStreaming(screen('⏺ This is **really impor', SPIN, BOX))?.text, 'This is **really impor');
  const table = extractStreaming(screen('⏺ Results:', '', '  ┌──────┬──────┐', '  │ name │ time │', '  ├──────┼──────┤', '  │ a    │ 1s   │', SPIN, BOX));
  assert.ok(table?.text.includes('│ name │ time │'), 'table rows survive');
  assert.equal(table?.text.split('\n').filter((l) => l.includes('│')).length, 2, 'one line per table row, not glued');
});

test('a reply that has a table in it is not mistaken for the input box and cut away', () => {
  const r = extractStreaming(screen(
    '> compare the two',
    '',
    '⏺ Here is the comparison:',
    '',
    '  ┌──────┬──────┐',
    '  │ name │ time │',
    '  └──────┴──────┘',
    '',
    '  The second one is faster.',
    SPIN, BOX,
  ));
  assert.ok(r?.text.includes('The second one is faster.'));
});

test('the anchor is the first words, normalised, and stays put while the text grows', () => {
  const a = extractStreaming(screen('⏺ **Good** question: the retry timer, in the sync client,', '  is never reset.', SPIN, BOX));
  assert.equal(a?.anchor, 'good question the retry timer in');
  assert.equal(a?.anchor.split(' ').length, STREAM_ANCHOR_WORDS);
  const grown = extractStreaming(screen('⏺ **Good** question: the retry timer, in the sync client,', '  is never reset. Fix it by', '  clearing the timer on success.', SPIN, BOX));
  assert.equal(grown?.anchor, a?.anchor);
  assert.equal(anchorOf('Hello there friend', 2), 'hello there');
});

// ── negative controls ───────────────────────────────────────────────────────

test('an idle screen gives null: the last answer is still visible but nothing is being written', () => {
  const idle = screen(
    '> make the sync client retry',
    '',
    '⏺ Done. The retry timer is now reset on success.',
    '',
    '✻ Worked for 12s',
    '',
    BOX,
    FOOTER,
  );
  assert.equal(extractStreaming(idle), null);
  // control: the same screen WITH a spinner under the text is a reply in progress
  assert.equal(extractStreaming(idle.replace('✻ Worked for 12s', SPIN))?.text, 'Done. The retry timer is now reset on success.');
  assert.equal(extractStreaming(''), null);
  assert.equal(extractStreaming('   \n\n  '), null);
});

test('only tools, or a tool after the text, give null: that text is complete and lives in the transcript', () => {
  assert.equal(extractStreaming(screen('> run the tests', '', '⏺ Bash(npm test)', '  ⎿  Running…', '', SPIN, BOX)), null);
  assert.equal(extractStreaming(screen('⏺ Read(src/sync.ts)', '  ⎿  Read 120 lines', '⏺ Searched for 2 patterns (ctrl+o to expand)', SPIN, BOX)), null);
  assert.equal(extractStreaming(screen('⏺ Let me run the tests.', '', '⏺ Bash(npm test)', '  ⎿  Running…', SPIN, BOX)), null);
  // control: a text block AFTER the tool is the one being written
  assert.equal(extractStreaming(screen('⏺ Bash(npm test)', '  ⎿  ok, 12 passed', '', '⏺ All twelve pass.', SPIN, BOX))?.text, 'All twelve pass.');
  // tool rows never leak into a later block's text
  const t = extractStreaming(screen('⏺ Bash(npm test)', '  ⎿  ok, 12 passed', '     detail line of the output', '', '⏺ All twelve pass.', SPIN, BOX));
  assert.ok(!t?.text.includes('Bash') && !t?.text.includes('detail'));
});

test('the operator just sent a message and nothing is painted yet: null', () => {
  assert.equal(extractStreaming(screen('⏺ An older answer.', '', '> and now this one', '', SPIN, BOX)), null);
  assert.equal(extractStreaming(screen('> and now this one', '', '⏺', SPIN, BOX)), null, 'an empty bullet is not a reply yet');
  assert.equal(extractStreaming(screen('> a question', '', '∴ Thinking…', '  weighing two options', SPIN, BOX)), null, 'thinking is not the reply');
});

test('a dialog on screen gives null, even with an answer above it', () => {
  const dialog = screen(
    '⏺ I will remove the build folder.',
    '',
    '⏺ Bash(rm -rf build)',
    '',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently (esc)',
  );
  assert.equal(extractStreaming(dialog), null);
  assert.equal(extractStreaming(screen('⏺ Almost done.', SPIN, '', 'Make auto mode your default permission mode?', '', '❯ Yes, set auto mode', '  No, keep manual approval')), null);
});

test('words that look like TUI noise inside the answer are kept', () => {
  const r = extractStreaming(screen(
    '⏺ You can press esc to interrupt me at any time, and the line',
    '  ? for shortcuts is shown under the box. Thinking… is only the spinner.',
    SPIN, BOX,
  ));
  assert.equal(r?.text, 'You can press esc to interrupt me at any time, and the line ? for shortcuts is shown under the box. Thinking… is only the spinner.');
});

test('a reply taller than the window has lost its head: flagged, with no anchor', () => {
  const r = extractStreaming(screen(
    '  of the older rows were scrolled away, and this is the middle of a long',
    '  answer that keeps going down the screen.',
    SPIN, BOX,
  ));
  assert.equal(r?.headCut, true);
  assert.equal(r?.anchor, '');
  assert.ok(r?.text.startsWith('of the older rows'));
  // deeper-indented rows with no opener are as likely to be a tool's output: not claimed as a reply
  assert.equal(extractStreaming(screen('       a long line of tool output with no opener above it', SPIN, BOX)), null);
});

test('without an input box on screen the footer hints are still dropped', () => {
  const r = extractStreaming(screen('⏺ Answer in progress', '', SPIN, '', '  ? for shortcuts', '  ⏵⏵ auto-accept edits on (shift+tab to cycle)'));
  assert.equal(r?.text, 'Answer in progress');
});

// ── matching the finished message ───────────────────────────────────────────

test('sameMessage: the provisional text is the start of the final one, whatever the markdown did to it', () => {
  const final = [
    '## The plan',
    '',
    'I read the **sync module** and found two causes. See [the docs](https://example.com/docs) for `retry`.',
    '',
    '```ts',
    'const retry = 1;',
    '```',
    '',
    '- first thing',
    '- second thing',
  ].join('\n');
  assert.ok(sameMessage('The plan\n\nI read the sync module and found two causes. See the docs for retry.', final));
  assert.ok(sameMessage('The plan I read the sync mod', final), 'cut mid-word');
  assert.ok(sameMessage('The plan\n\nI read the sync module and found two causes. See the docs for retry.\n\nconst retry = 1;\n\n• first thing', final), 'code fence and bullet glyph');
  // negative controls
  assert.equal(sameMessage('A completely different reply about something else', final), false);
  assert.equal(sameMessage('The plan\n\nI read the sync module and found three causes.', final), false);
  assert.equal(sameMessage('', final), false);
  assert.equal(sameMessage('The plan', ''), false);
  // the provisional must not run past the final text
  assert.equal(sameMessage(final + ' and then some more words that never arrived', final), false);
});

test('sameMessage: a head-cut reply is matched as a substring, and a tiny fragment matches nothing', () => {
  const final = 'Intro paragraph that scrolled off the screen. Then the middle of the answer keeps going and the end follows.';
  assert.ok(sameMessage('the middle of the answer keeps going', final, { headCut: true }));
  assert.equal(sameMessage('the middle of the answer keeps going', final), false, 'without headCut it must be a prefix');
  assert.equal(sameMessage('keeps going', final, { headCut: true }), false, 'too short to identify a message');
  assert.equal(sameMessage('some other text that is long enough to count', final, { headCut: true }), false);
});

test('normalizeForMatch keeps letters and digits only', () => {
  assert.equal(normalizeForMatch('**Hello**, wörld! 42 [x](http://a.b)\n```ts\nq\n```'), 'hellowörld42xq');
});

test('reading the last text block of any screen (requireActive: false) still leaves the input box out', () => {
  const idle = screen('> hi', '', '⏺ Hello, how can I help?', '', BOX, FOOTER);
  assert.equal(extractStreaming(idle), null);
  assert.equal(extractStreaming(idle, { requireActive: false })?.text, 'Hello, how can I help?');
  // control: a draft typed in the box (multi-line) does not leak either
  const draft = screen('⏺ Hello, how can I help?', '', '╭' + RULE + '╮', '│ > a draft I am typing' + ' '.repeat(33) + ' │', '│   on two lines' + ' '.repeat(41) + ' │', '╰' + RULE + '╯', FOOTER);
  assert.equal(extractStreaming(draft, { requireActive: false })?.text, 'Hello, how can I help?');
  // a rule-framed box (no side borders) is cut the same way
  assert.equal(extractStreaming(screen('⏺ Hello again.', RULE, '> ', RULE, FOOTER), { requireActive: false })?.text, 'Hello again.');
});

/**
 * The chat view — a Claude Code session driven through the Agent SDK in the main process and
 * painted by a renderer pane.
 *
 * Like menu.test.ts, most of this reads SOURCE: the feature is four files that must agree on
 * names nothing type-checks across (a channel string in the preload, a `case` in the renderer, a
 * key in three locales). Those are the failures that look fine in review and do nothing at run
 * time — a send with no handler resolves to `undefined` and the pane just sits there.
 *
 * What source-reading cannot prove is stated where it matters: the SDK, the `claude` child and the
 * pane itself are exercised by hand (docs/rfcs/chat-view.md says how), because a unit test that
 * mocked them would only assert the mock.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  createChatTranslator, mergeStatus, parseStatuslinePayload, summarizeTool,
  type ChatEvent,
} from '../core/chatEvents';

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const app = read('renderer/app.js');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
const session = read('src/main/chatSession.ts');
const events = read('src/core/chatEvents.ts');
const menu = read('src/main/menu.ts');
const aios = read('src/main/aios.ts');

/** The chat pane's slice of app.js, so a `case` or a key elsewhere cannot satisfy a chat check. */
const chatStart = app.indexOf('/* ═══ CHAT PANE');
const chatEnd = app.indexOf('/* ── tool tabs');
const chatApp = app.slice(chatStart, chatEnd);

/** Body of `function name(...) { ... }` by brace matching, so a regex cannot stop at the first `}`. */
function fnBody(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `function ${name} must exist`);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

// ── wiring: menu, channels, events ──────────────────────────────────────────

test('the chat slice of app.js was found', () => {
  assert.ok(chatStart > 0 && chatEnd > chatStart, 'section markers moved; the checks below would read nothing');
  assert.ok(chatApp.length > 2000);
});

test('the menu offers the chat and the renderer routes it to openChatPane', () => {
  assert.match(menu, /intent\('openChat'\)/);
  // menu.test.ts proves the case EXISTS; this proves it does the right thing
  assert.match(app, /case 'openChat': void openChatPane\(\); return;/);
  assert.match(app, /item\(t\('newtab\.chat'\), \(\) => openChatPane\(\)\)/, 'the (+) menu must offer it too');
  const html = read('renderer/index.html');
  assert.equal((html.match(/class="newChat"/g) || []).length, 2, 'a chat button beside the (+) in both tab strips');
});

test('every chat:* channel the preload uses has a handler in main, and vice versa', () => {
  const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\('(chat:[a-z-]+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('(chat:[a-z-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...invoked].sort(), [...handled].sort(), 'preload invokes and main handles different channels');
  assert.deepEqual([...invoked].sort(), ['chat:close', 'chat:interrupt', 'chat:permission', 'chat:send', 'chat:start', 'chat:status']);
  // the one push channel runs the other way: main sends, the preload listens
  assert.match(preload, /ipcRenderer\.on\('chat:event'/);
  assert.match(main, /sender\.send\('chat:event', ev\)/);
});

test('the renderer calls only what the preload exposes, with the arguments the preload declares', () => {
  const exposed = new Set([...preload.matchAll(/^\s{2}(chat[A-Za-z]+|onChatEvent):/gm)].map((m) => m[1]));
  const used = new Set([...chatApp.matchAll(/(?:glassShell|gs)\.(chat[A-Za-z]+|onChatEvent)\(/g)].map((m) => m[1]));
  const missing = [...used].filter((u) => !exposed.has(u));
  assert.deepEqual(missing, [], `the renderer calls glassShell methods the preload does not expose: ${missing.join(', ')}`);
  assert.ok(used.size >= 6, `expected the pane to use the whole bridge, found ${[...used].join(', ')}`);
  assert.match(chatApp, /chatSend\(p\.chatId, text\)/);
  assert.match(chatApp, /chatPermission\(p\.chatId, ev\.requestId, ok\)/);
  assert.match(chatApp, /chatStart\(\{ startSession: true \}\)/);
});

test('every ChatEvent type the main process can emit has a handler in the renderer', () => {
  const union = events.slice(events.indexOf('export type ChatEventBody'), events.indexOf('export type ChatEvent ='));
  const declared = new Set([...union.matchAll(/type: '([a-z-]+)'/g)].map((m) => m[1]));
  // what the code actually emits: the translator's ev({ type }) and the manager's emit(s, { type })
  const emitted = new Set([
    ...[...events.matchAll(/ev\(\{ type: '([a-z-]+)'/g)].map((m) => m[1]),
    ...[...session.matchAll(/emit\(s, \{ type: '([a-z-]+)'/g)].map((m) => m[1]),
  ]);
  for (const e of emitted) assert.ok(declared.has(e), `'${e}' is emitted but missing from the ChatEventBody union`);
  const handled = new Set([...fnBody(app, 'chatHandleEvent').matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));
  const unhandled = [...declared].filter((d) => !handled.has(d));
  assert.deepEqual(unhandled, [], `the renderer ignores event types main sends: ${unhandled.join(', ')}`);
  const stray = [...handled].filter((h) => !declared.has(h));
  assert.deepEqual(stray, [], `the renderer handles types main never sends: ${stray.join(', ')}`);
  assert.ok(declared.size >= 11);
});

test('the error codes main emits are the ones the renderer knows how to word', () => {
  const codes = new Set([
    ...[...events.matchAll(/code: '([a-z-]+)'/g)].map((m) => m[1]),
    ...[...session.matchAll(/code: (?:'([a-z-]+)'|s\.gotMessage \? '([a-z-]+)' : '([a-z-]+)')/g)].flatMap((m) => m.slice(1).filter(Boolean)),
  ]);
  const known = /const CHAT_KNOWN_ERRORS = \[([^\]]+)\]/.exec(chatApp)?.[1].match(/'([a-z-]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  // 'interrupt-failed' is deliberately worded by the generic line: the turn's own `result` is the truth
  const unworded = [...codes].filter((c) => !known.includes(c) && c !== 'interrupt-failed');
  assert.deepEqual(unworded, [], `error codes without a translated line: ${unworded.join(', ')}`);
  assert.ok(codes.has('spawn-failed') && codes.has('turn-failed'));
});

// ── the session starts where a terminal would, as the same someone ──────────

test('the chat starts in the vault, with the primary session\'s name, through the terminals\' own env', () => {
  const wiring = /createChatManager\(\{[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.ok(wiring, 'main.ts must construct the chat manager');
  assert.match(wiring, /cwd: \(\) => aios\.vaultRoot\(\) \?\? path\.join\(os\.homedir\(\), 'aios'\)/);
  assert.match(wiring, /env: \(\) => termEnv\(undefined, aios\.primaryName\(\)\)/);
  // the SAME termEnv a pty:spawn uses — a parallel env would drift from the terminals one flag at a time
  assert.match(main, /env: termEnv\(opts\.cmd, opts\.name\)/);
  assert.match(main, /if \(chosen && \/\^\[a-z0-9\]\[a-z0-9-\]\*\$\/i\.test\(chosen\)\) env\.CLAUDE_AGENT_NAME = chosen;/,
    'termEnv is where CLAUDE_AGENT_NAME is set');
  // and the bridge must not build an identity or environment of its own
  const code = session.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');   // prose may mention the variable; code may not set it
  assert.doesNotMatch(code, /CLAUDE_AGENT_NAME/, 'chatSession must take its env from the injected dep, not make one');
  assert.doesNotMatch(code, /process\.env\.(?!PATH)/, 'chatSession must not read the process env directly (PATH for the claude lookup only)');
  assert.match(session, /env: deps\.env\(\)/);
  assert.match(session, /cwd: deps\.cwd\(\)/);
  // no permission override in the app: the session honours the operator's own settings, like a terminal
  assert.doesNotMatch(wiring, /permissionMode/);
});

test('"Start session" is the first message, and only when the opener asks for it', () => {
  assert.match(session, /const START_MESSAGE = 'Start session';/);
  assert.match(session, /if \(opts\.startSession\) \{ s\.turnsInFlight\+\+; inbox\.push\(START_MESSAGE\); \}/);
  assert.equal((session.match(/START_MESSAGE/g) || []).length, 2, 'declared once, used once');
  assert.match(chatApp, /chatStart\(\{ startSession: true \}\)/, 'the pane opts in');
  assert.match(main, /startSession: !!opts\?\.startSession/, 'main passes the flag through unchanged and defaults it off');
});

test('the session is the real claude, with the terminal\'s system prompt and settings', () => {
  assert.match(session, /systemPrompt: \{ type: 'preset', preset: 'claude_code' \}/);
  assert.match(session, /includePartialMessages: true/);
  assert.match(session, /pathToClaudeCodeExecutable: exe/);
  assert.match(main, /claudeCmd: \(\) => aios\.shellSettings\(\)\.claudeCmd/);
  // not narrowed: dropping settingSources would silently lose the operator's CLAUDE.md, hooks and rules
  assert.doesNotMatch(session, /settingSources/);
});

// ── permissions: nothing waits forever ─────────────────────────────────────

test('a pending permission request is denied when the turn is interrupted or the session closed', () => {
  const settle = /const settle = \(allow: boolean\): void => \{[\s\S]*?\n {6}\};/.exec(session)?.[0] ?? '';
  assert.ok(settle, 'canUseTool must define settle');
  assert.match(settle, /if \(!s\.pending\.has\(requestId\)\) return;/, 'answering twice must be a no-op');
  assert.match(settle, /emit\(s, \{ type: 'permission-resolved', requestId, allow \}\)/);
  assert.match(settle, /behavior: 'deny', message: DENIED/);
  assert.match(settle, /behavior: 'allow', updatedInput: input/);
  assert.match(session, /o\.signal\.addEventListener\('abort', \(\) => settle\(false\)/, 'the SDK cancelling a request denies it');
  assert.match(fnBody(session, 'denyPending'), /settle\(false\)/);
  // every way a session can end or be cut short goes through denyPending
  for (const fn of ['interrupt', 'close', 'finish']) {
    assert.match(fnBody(session, fn), /denyPending\(s\)/, `${fn}() must deny parked requests`);
  }
  // and the interrupt denies BEFORE awaiting the SDK: a turn blocked on a request cannot hear it
  const intr = fnBody(session, 'interrupt');
  assert.ok(intr.indexOf('denyPending(s)') < intr.indexOf('await s.query.interrupt()'));
  // the card relays a click; it never decides
  assert.match(chatApp, /card\.resolve = \(ok\) =>/);
  assert.match(fnBody(app, 'chatHandleEvent'), /case 'permission-resolved': \{/);
});

test('closing a tab, a window or the app closes its sessions (no orphaned claude children)', () => {
  assert.match(fnBody(app, 'chatTeardown'), /chatClose\(p\.chatId\)/);
  assert.match(fnBody(app, 'closePane'), /chatTeardown\(p\)/);
  assert.match(main, /win\.on\('closed', \(\) => chat\.closeAll\(\)\)/);
  assert.match(main, /app\.on\('before-quit', \(\) => chat\.closeAll\(\)\)/);
  assert.match(main, /sender\.once\('destroyed', \(\) => chat\.close\(r\.id\)\)/, 'a reload must not leave the child running');
});

// ── the composer ────────────────────────────────────────────────────────────

test('Enter sends, Shift+Enter does not, and IME composition never sends', () => {
  const cond = /input\.addEventListener\('keydown', \(e\) => \{[\s\S]*?if \((e\.key !== 'Enter'[^)]*)\) return;/.exec(chatApp)?.[1];
  assert.ok(cond, 'the composer keydown guard must exist');
  // evaluate the real condition rather than re-describe it
  const skips = new Function('e', `return (${cond});`) as (e: Record<string, unknown>) => boolean;
  const ev = (o: Record<string, unknown>) => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...o });
  assert.equal(skips(ev({})), false, 'plain Enter must send');
  assert.equal(skips(ev({ shiftKey: true })), true, 'Shift+Enter must break the line');
  assert.equal(skips(ev({ isComposing: true })), true, 'Enter while composing confirms the candidate');
  assert.equal(skips(ev({ keyCode: 229 })), true, 'keyCode 229 covers engines that clear isComposing early');
  assert.equal(skips(ev({ key: 'a' })), true);
  // and the plain-Enter branch is the one that prevents default and sends
  assert.match(chatApp, /e\.preventDefault\(\);\n\s+chatSendNow\(p\);/);
});

test('Esc stops a running turn and does nothing otherwise; the send path cannot double-send', () => {
  assert.match(chatApp, /e\.key !== 'Escape' \|\| e\.isComposing \|\| !p\.busy/);
  assert.match(fnBody(app, 'chatInterruptNow'), /if \(!p\.busy \|\| p\.chatId === null\) return;/);
  const send = fnBody(app, 'chatSendNow');
  assert.match(send, /!p\.ready \|\| p\.busy \|\| p\.exited \|\| p\.failed/, 'no sending before ready, mid-turn or after the end');
  assert.ok(send.indexOf('p.busy = true') < send.indexOf('chatSend('), 'busy must be set before the IPC call, or a second Enter races it');
  assert.match(send, /bubble\.textContent = text/, 'the operator\'s own text is never parsed as HTML either');
});

// ── untrusted model text ────────────────────────────────────────────────────

test('model output never reaches the DOM as raw HTML', () => {
  // guard 1: a private marked instance whose html renderer escapes (the global one renders vault notes)
  const md = fnBody(app, 'chatMarkdown');
  assert.match(md, /new marked\.Marked\(/);
  assert.doesNotMatch(md, /marked\.use\(/, 'the global marked must not be reconfigured');
  assert.match(md, /html\(tok\) \{ return chatEscape\(/);
  // guard 2: an allowlist pass over an inert <template>
  const san = fnBody(app, 'chatSanitize');
  assert.match(san, /document\.createElement\('template'\)/);
  assert.match(san, /CHAT_DROP\.has\(tag\)/);
  assert.match(san, /\^\(https\?:\|mailto:\)/, 'only http(s) and mailto links survive');
  assert.match(san, /child\.removeAttribute\(a\.name\)/, 'no attribute (onerror, style, src…) survives');
  const tags = /const CHAT_TAGS = new Set\(\[([\s\S]*?)\]\)/.exec(app)?.[1] ?? '';
  for (const bad of ['SCRIPT', 'IMG', 'IFRAME', 'STYLE', 'FORM', 'SVG']) assert.doesNotMatch(tags, new RegExp(`'${bad}'`), `${bad} must not be allowed`);
  // the only way markup enters the page: through chatSanitize
  assert.match(fnBody(app, 'chatRender'), /target\.replaceChildren\(frag\)/);
  assert.match(fnBody(app, 'chatRender'), /chatSanitize\(chatMarkdown\(\)\.parse\(/);
  const direct = [...chatApp.matchAll(/(\w+(?:\.\w+)*)\.innerHTML\s*=/g)].map((m) => m[1]);
  // tpl.innerHTML is the inert template; code.innerHTML is hljs output over code.textContent
  assert.deepEqual(direct.sort(), ['code', 'tpl'], `unexpected innerHTML writes: ${direct.join(', ')}`);
  // links open in the system browser, never inside this window
  assert.match(chatApp, /e\.preventDefault\(\);\n\s+void window\.glassShell\.openExternal\(/);
});

// ── settings ────────────────────────────────────────────────────────────────

test('the chat font and size are persisted through the same whitelist as every other setting', () => {
  const white = /ipcMain\.handle\('shell:setSetting', \(_e, key: ([^,]+),/.exec(main)?.[1] ?? '';
  assert.ok(white, 'shell:setSetting key union not found');
  assert.match(white, /'chatFontFamily'/);
  assert.match(white, /'chatFontSize'/);
  const iface = /export interface ShellSettings \{([^}]*)\}/.exec(aios)?.[1] ?? '';
  assert.match(iface, /chatFontFamily: string;/);
  assert.match(iface, /chatFontSize: number;/);
  // read back with a default and a clamp, so a hand-edited shell.json cannot break the pane
  assert.match(aios, /chatFontFamily: typeof raw\.chatFontFamily === 'string' \? raw\.chatFontFamily\.trim\(\)\.slice\(0, 200\) : ''/);
  assert.match(aios, /chatFontSize: Math\.min\(28, Math\.max\(10, Number\(raw\.chatFontSize\) \|\| 14\)\)/);
  assert.match(chatApp, /setSetting\('chatFontFamily'/);
  assert.match(chatApp, /setSetting\('chatFontSize'/);
});

// ── i18n ────────────────────────────────────────────────────────────────────

test('every chat key the renderer and menu use exists in all three locales, with the same placeholders', () => {
  const loc = Object.fromEntries(['en', 'es', 'pt-br'].map((l) => [l, JSON.parse(read(`src/i18n/locales/${l}.json`)) as Record<string, string>]));
  const used = new Set<string>([
    ...[...chatApp.matchAll(/'(chat\.[A-Za-z.-]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')),   // 'chat.error.' + code is a prefix, added below
    'newtab.chat', 'tab.newChat', 'menu.openChat',
  ]);
  // keys built at run time: 'chat.error.' + code
  for (const c of /const CHAT_KNOWN_ERRORS = \[([^\]]+)\]/.exec(chatApp)?.[1].match(/'([a-z-]+)'/g) ?? []) used.add('chat.error.' + c.slice(1, -1));
  assert.ok(used.size >= 30, `expected the full chat vocabulary, found ${used.size}`);
  for (const l of Object.keys(loc)) {
    const missing = [...used].filter((k) => typeof loc[l][k] !== 'string' || !loc[l][k].trim());
    assert.deepEqual(missing, [], `${l}.json is missing: ${missing.join(', ')}`);
  }
  // the three locales carry the same chat.* set, and the same {placeholders} in each line
  const keysOf = (l: string): string[] => Object.keys(loc[l]).filter((k) => k.startsWith('chat.')).sort();
  assert.deepEqual(keysOf('es'), keysOf('en'));
  assert.deepEqual(keysOf('pt-br'), keysOf('en'));
  const holes = (s: string): string => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keysOf('en')) for (const l of ['es', 'pt-br']) assert.equal(holes(loc[l][k]), holes(loc.en[k]), `${l}.json ${k}: placeholders differ from en`);
});

test('every colour the chat uses is a token, defined for both themes', () => {
  const css = read('renderer/theme.css');
  const tokens = ['--chat-user-bg', '--chat-user-line', '--chat-claude-bg', '--chat-claude-line', '--chat-code-bg', '--chat-tool-ink', '--chat-perm-bg', '--chat-perm-line'];
  const light = css.slice(css.indexOf('body.light {'));
  for (const tk of tokens) {
    assert.match(css, new RegExp(`:root \\{[^}]*${tk}:`), `${tk} must be minted in :root`);
    assert.match(light, new RegExp(`${tk}:`), `${tk} must be re-declared for body.light (a var() resolves where it is declared)`);
  }
});

// ── usage bar: parseStatuslinePayload / mergeStatus ─────────────────────────

/** A payload shaped like the one Claude Code's statusline dumps (field paths from hooks/statusline.py). */
const PAYLOAD = {
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'high' },
  context_window: { used_percentage: 21.4, context_window_size: 1000000, total_input_tokens: 214000 },
  rate_limits: { five_hour: { used_percentage: 8 }, seven_day: { used_percentage: 73 } },
};

test('parseStatuslinePayload reads the live payload shape', () => {
  assert.deepEqual(parseStatuslinePayload(PAYLOAD), {
    fiveHourPct: 8, sevenDayPct: 73, contextPct: 21.4, model: 'Opus 5.5', effort: 'high',
  });
  assert.deepEqual(parseStatuslinePayload(JSON.stringify(PAYLOAD)), parseStatuslinePayload(PAYLOAD), 'a JSON string parses the same');
});

test('parseStatuslinePayload: absent stays undefined (never 0), garbage yields {}, fallbacks apply', () => {
  const none = parseStatuslinePayload({ model: { id: 'm' } });
  assert.deepEqual(none, { model: 'm' });
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct', 'effort'] as const) assert.equal(k in none, false, `${k} must be absent, not 0`);
  assert.deepEqual(parseStatuslinePayload('not json'), {});
  assert.deepEqual(parseStatuslinePayload(null), {});
  assert.deepEqual(parseStatuslinePayload([1, 2]), {});
  assert.deepEqual(parseStatuslinePayload(42), {});
  // an explicit 0 IS a reading and is kept; a numeric STRING is not trusted
  assert.equal(parseStatuslinePayload({ rate_limits: { five_hour: { used_percentage: 0 } } }).fiveHourPct, 0);
  assert.equal('fiveHourPct' in parseStatuslinePayload({ rate_limits: { five_hour: { used_percentage: '40' } } }), false);
  // context derived from tokens when no percentage is reported
  assert.equal(parseStatuslinePayload({ context_window: { total_input_tokens: 250000, context_window_size: 1000000 } }).contextPct, 25);
  assert.equal('contextPct' in parseStatuslinePayload({ context_window: { total_input_tokens: 1, context_window_size: 0 } }), false);
  // clamped, so a bar can never overflow its track; a bare-string model (older payloads) still reads
  assert.equal(parseStatuslinePayload({ rate_limits: { seven_day: { used_percentage: 140 } } }).sevenDayPct, 100);
  assert.equal(parseStatuslinePayload({ rate_limits: { seven_day: { used_percentage: -3 } } }).sevenDayPct, 0);
  assert.equal(parseStatuslinePayload({ model: 'claude-x' }).model, 'claude-x');
  assert.equal(parseStatuslinePayload({ effort_level: 'low' }).effort, 'low');
  assert.equal('model' in parseStatuslinePayload({ model: '   ' }), false, 'a blank string is not a model');
});

test('mergeStatus: the live session wins field by field, the file fills the rest, nothing becomes 0', () => {
  const sdk = { model: 'live-model', contextPct: 14, fiveHourPct: 58 };
  const file = { model: 'other-session', contextPct: 90, fiveHourPct: 8, sevenDayPct: 73, effort: 'high' };
  assert.deepEqual(mergeStatus(sdk, file), { source: 'mixed', model: 'live-model', contextPct: 14, fiveHourPct: 58, sevenDayPct: 73, effort: 'high' });

  assert.deepEqual(mergeStatus({ model: 'm' }, {}), { source: 'sdk', model: 'm' });
  assert.deepEqual(mergeStatus(undefined, { sevenDayPct: 5 }), { source: 'file', sevenDayPct: 5 });

  // nothing known: no fields at all — `undefined`, never a fabricated 0%
  const empty = mergeStatus(undefined, undefined);
  assert.deepEqual(empty, { source: 'file' });
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct', 'model', 'effort'] as const) assert.equal(empty[k], undefined);

  // a 0 from the session is a reading and must beat the file's stale number
  assert.equal(mergeStatus({ fiveHourPct: 0 }, { fiveHourPct: 40 }).fiveHourPct, 0);
  // an explicitly undefined SDK field falls through to the file rather than hiding it
  assert.equal(mergeStatus({ fiveHourPct: undefined }, { fiveHourPct: 40 }).fiveHourPct, 40);
});

// ── the translator: the contract the renderer paints ───────────────────────

const types = (es: ChatEvent[]): string[] => es.map((e) => e.type);
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

test('translator: text streams as turn-start, deltas, then a turn-end carrying the whole text', () => {
  const tr = createChatTranslator(7);
  const out = [...tr.push(delta('Hel')), ...tr.push(delta('lo'))];
  assert.deepEqual(types(out), ['turn-start', 'delta', 'delta']);
  assert.ok(out.every((e) => e.id === 7), 'every event carries the chat id');
  const fin = tr.push({ type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'Hello' }] } });
  assert.deepEqual(types(fin), ['turn-end']);
  assert.equal((fin[0] as { text: string }).text, 'Hello');
  assert.equal((fin[0] as { turnId: string }).turnId, (out[0] as { turnId: string }).turnId, 'the same turn the deltas built');
});

test('translator: a tool-only message leaves no empty bubble; subagent chatter is ignored', () => {
  const tr = createChatTranslator(1);
  const out = tr.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls  -la' } }] } });
  assert.deepEqual(types(out), ['tool']);
  assert.equal((out[0] as { summary: string }).summary, 'ls -la');
  assert.deepEqual(tr.push({ ...delta('x'), parent_tool_use_id: 'toolu_1' }), []);
  assert.deepEqual(tr.push({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: 'sub' }] } }), []);
});

test('translator: an interrupt closes the open block and flags the result; an error result is reported once', () => {
  const tr = createChatTranslator(1);
  tr.push(delta('half'));
  tr.noteInterrupt();
  const out = tr.push({ type: 'result', subtype: 'error_during_execution', is_error: true });
  assert.deepEqual(types(out), ['turn-end', 'result']);
  assert.equal((out[1] as { interrupted?: boolean }).interrupted, true);
  assert.equal((out[1] as { isError: boolean }).isError, false, 'an operator stop is not a failure');
  const bad = createChatTranslator(1).push({ type: 'result', is_error: true, errors: ['boom'] });
  assert.deepEqual(types(bad), ['error', 'result']);
  assert.equal((bad[0] as { message: string }).message, 'boom');
});

test('translator: plan usage from the live session is a fraction scaled to percent; nothing is invented', () => {
  const tr = createChatTranslator(1);
  tr.push({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.58 }, seven_day: { utilization: 0.78 } } } });
  assert.deepEqual(tr.sdkStatus(), { fiveHourPct: 58, sevenDayPct: 78 });
  const fresh = createChatTranslator(2);
  assert.deepEqual(fresh.sdkStatus(), {}, 'before anything is said there are no numbers at all');
  assert.deepEqual(fresh.pushLine('   '), []);
  assert.deepEqual(fresh.pushLine('{not json'), []);
});

test('summarizeTool: one readable line, bounded', () => {
  assert.equal(summarizeTool('Bash', { command: 'echo hi' }), 'echo hi');
  assert.equal(summarizeTool('Read', { file_path: '/a/b.md' }), '/a/b.md');
  assert.equal(summarizeTool('Mystery', { first: 'x' }), 'x');
  assert.equal(summarizeTool('Mystery', {}), '{}');
  assert.ok(summarizeTool('Bash', { command: 'x'.repeat(500) }).length <= 160);
});

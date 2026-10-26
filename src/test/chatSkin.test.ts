/**
 * The chat skin — a second way of LOOKING at a Claude terminal pane, never a pane of its own.
 *
 * Source-reading invariants, in the style of menu.test.ts. They exist because every failure this
 * feature can have is silent at the unit level: a toggle that spawned a second pty would still
 * "work"; a hidden xterm that went `display:none` would resize the real session to 0 columns and
 * break the TUI only when the operator came back; a composer that wrote `text + CR` in one chunk
 * would deliver a message that never sends. None of that throws, so each guard reads the code and
 * every guard is paired with a NEGATIVE CONTROL — the same check run against a deliberately broken
 * copy of the source must fail, or the check proves nothing (it would be a gate that reads the
 * wrong thing and reports confidence about something it never examined).
 *
 * What these cannot see: that the bubbles actually paint and the strip actually shows. That is the
 * hidden-window run (see the PR description), not a source test.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { detectTuiPrompt, createPromptMonitor } from '../core/tuiPrompt';

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const app = read('renderer/app.js');
const menu = read('src/main/menu.ts');
const css = read('renderer/theme.css');
const html = read('renderer/index.html');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');

const START = '/* ═══ CHAT SKIN';
const END = '/* ═══ END CHAT SKIN ═══ */';
const slice = (src: string): string => {
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  return a >= 0 && b > a ? src.slice(a, b) : '';
};
const skin = slice(app);

/** A top-level function (or arrow const) by name: from its header to the first closing brace at column 0. */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}|const ${name} = [^\\n]*=> \\{[\\s\\S]*?\\n\\};`);
  return re.exec(src)?.[0] ?? '';
}
/** Run a check against the real source (must hold) and against a broken copy (must fail). */
function guarded(name: string, check: (src: string) => boolean, breakIt: (src: string) => string): void {
  test(name, () => {
    assert.ok(check(app), `${name}: the check does not hold on the real source`);
    const broken = breakIt(app);
    assert.notEqual(broken, app, `${name}: the negative control did not change anything`);
    assert.equal(check(broken), false, `${name}: the check still passes on a deliberately broken copy — it proves nothing`);
  });
}

test('the chat-skin block was found, once, and the SDK pane is gone', () => {
  assert.ok(skin.length > 5000, 'the block between the CHAT SKIN markers must exist');
  assert.equal(app.split(START).length, 2, 'exactly one start marker');
  assert.equal(app.split(END).length, 2, 'exactly one end marker');
});

// ── the SDK pane is gone ────────────────────────────────────────────────────

const SDK_TRACES = /kind: 'chat'|kind === 'chat'|openChatPane|chatPanes|\bchatStart\b|\bchatSend\b|\bchatInterrupt\b|\bchatPermission\b|\bchatClose\b|\bonChatEvent\b/;
guarded('no pane kind "chat" and no SDK chat call survives in the renderer or the menu',
  (src) => !SDK_TRACES.test(src) && !/openChat/.test(menu) && !/newChat/.test(html + css),
  (src) => src + "\nwindow.glassShell.chatStart({ startSession: true });\n");

// ── the toggle only flips a view ────────────────────────────────────────────

const CREATES = /createPane\(|ptySpawn\(|panes\.set\(|new Terminal\(|homePane\(|makeTab\(/;
guarded('the toggle creates no pane, no pty and no session: it flips a view on the same pane object',
  (src) => {
    const s = slice(src);
    const fns = ['chatSkinSetView', 'chatSkinToggle', 'chatSkinToggleFocused', 'chatSkinBuild', 'chatSkinLayout', 'chatSkinHandBack'].map((n) => fnBody(s, n));
    return fns.every((b) => b.length > 40 && !CREATES.test(b)) && !CREATES.test(s.replace(fnBody(s, 'chatSkinMaybeDefault'), ''));
  },
  (src) => src.replace('function chatSkinSetView(id, view) {', 'function chatSkinSetView(id, view) {\n  void createPane({ name: "chat" });'));

test('the skin only adds fields and DOM inside p.el: it never reassigns the pane identity', () => {
  // identity = what byName / resume / the bus / restore key on. The skin may ADD p.view, p.chatSkin,
  // p.viewBtn, p.lastPtyAt (set outside), p.csEligible, p.chatEnded; it must not rename or re-key anything.
  for (const bad of [/\.name\s*=[^=]/, /\.confirmedName\s*=[^=]/, /\.cmd\s*=[^=]/, /panes\.delete\(/, /panes\.set\(/, /\.isSession\s*=[^=]/, /renamePane\(/]) {
    assert.doesNotMatch(skin, bad, `the skin must not touch ${bad}`);
  }
  // the single exception, stated: a session replaced under the same pty is re-resolved from the registry's own authority
  const assigns = [...skin.matchAll(/\.sessionId\s*=[^=]/g)].length;
  assert.equal(assigns, 1, 'exactly one sessionId assignment in the skin');
  assert.match(fnBody(skin, 'chatSkinRecheckId'), /sessionUnder\(\[id\]\)[\s\S]*p\.sessionId = real\.id/);
  // every overlay node lives inside the pane's own element
  assert.match(fnBody(skin, 'chatSkinBuild'), /p\.el\.appendChild\(root\)/);
});

// ── the composer writes through the one chokepoint ──────────────────────────

guarded('the composer submits through submitToPty, never by writing a CR itself',
  (src) => {
    const s = slice(src);
    // the typed message and the bar's model button both end in chatSkinSubmit, the one place that hands text to submitToPty
    const send = fnBody(s, 'chatSkinSubmit') + fnBody(s, 'chatSkinSendNow');
    // every direct pty write in the skin is the lone ESC, or one chunk of a dialog key inside the key chokepoint; nothing writes text or a CR
    const writes = [...s.replace(fnBody(s, 'chatSkinSendKey'), '').matchAll(/ptyWrite\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    return /submitToPty\(id, text\)/.test(send) && /chatSkinSubmit\(id, p, text\)/.test(fnBody(s, 'chatSkinSendNow')) && writes.length >= 1 && writes.every((w) => w === "id, '\\x1b'");
  },
  (src) => src.replace('submitToPty(id, text);   // the one chokepoint', "window.glassShell.ptyWrite(id, text + '\\r');   // the one chokepoint"));

guarded('slash commands are sent exactly like any other message (no filter, no special path)',
  (src) => {
    const send = fnBody(slice(src), 'chatSkinSendNow') + fnBody(slice(src), 'chatSkinSubmit');
    return !/startsWith\('\/'\)\s*\)\s*return/.test(send) && !/ptyRun\(/.test(send) && /submitToPty\(id, text\)/.test(send);
  },
  (src) => src.replace('const text = cs.input.value.replace', "if (cs.input.value.startsWith('/')) return;\n  const text = cs.input.value.replace"));

test('Enter sends, Shift+Enter breaks the line, and IME composition never sends', () => {
  const cond = /input\.addEventListener\('keydown', \(e\) => \{[\s\S]*?if \((e\.key !== 'Enter'[^)]*)\) return;/.exec(skin)?.[1];
  assert.ok(cond, 'the composer keydown guard must exist');
  // evaluate the real condition rather than re-describe it
  const skips = new Function('e', `return (${cond});`) as (e: Record<string, unknown>) => boolean;
  const ev = (o: Record<string, unknown>) => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...o });
  assert.equal(skips(ev({})), false, 'plain Enter must send');
  assert.equal(skips(ev({ shiftKey: true })), true, 'Shift+Enter must break the line (the textarea default)');
  assert.equal(skips(ev({ isComposing: true })), true, 'Enter while composing confirms the candidate');
  assert.equal(skips(ev({ keyCode: 229 })), true, 'keyCode 229 covers engines that clear isComposing early');
  assert.equal(skips(ev({ key: 'a' })), true);
  assert.match(skin, /e\.preventDefault\(\);\n\s+chatSkinSendNow\(id, p\);/, 'the plain-Enter branch prevents default and sends');
  // negative control: a condition that forgot Shift would send on Shift+Enter
  const broken = new Function('e', `return (${cond.replace(/ \|\| e\.shiftKey/, '')});`) as (e: Record<string, unknown>) => boolean;
  assert.equal(broken(ev({ shiftKey: true })), false, 'control: without the shiftKey clause Shift+Enter would send');
});

guarded('Esc writes a lone ESC to the pty, only while something is running',
  (src) => {
    const s = slice(src);
    const intr = fnBody(s, 'chatSkinInterrupt');
    return /ptyWrite\(id, '\\x1b'\)/.test(intr) && /!chatSkinWorking\(p\)/.test(intr)
      && /e\.key !== 'Escape'[\s\S]{0,120}chatSkinInterrupt\(id, p\)/.test(s);
  },
  (src) => src.replace("window.glassShell.ptyWrite(id, '\\x1b');", "window.glassShell.ptyWrite(id, '\\x03');"));

// ── watch / unwatch follow the session and the pane's life ──────────────────

guarded('closing the pane or losing the pty unwatches the transcript',
  (src) => {
    const s = slice(src);
    const close = fnBody(src, 'closePane');
    return /chatSkinTeardown\(id, p\)/.test(close)
      && /chatSkinUnwatch\(id\)/.test(fnBody(s, 'chatSkinTeardown'))
      && /chatSkinTeardown\(id, p\)/.test(fnBody(s, 'chatSkinOnExit'))
      && /chatSkinOnExit\(m\.id, p\)/.test(/window\.glassShell\.onPtyExit\(\(m\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? '');
  },
  (src) => src.replace('  chatSkinTeardown(id, p);   // stop tailing the transcript', '  // (teardown removed)   // stop tailing the transcript'));

guarded('the watch follows the sessionId: a new id replaces the watch, no id yet still watches dialogs, only leaving chat unwatches',
  (src) => {
    const sync = fnBody(slice(src), 'chatSkinSync');
    return /cs\.watched === want\) return/.test(sync)
      // '' = chat view without a session id yet (dialogs only); null = not watching at all
      && /p\.view === 'chat' && !p\.exited \? \(p\.sessionId \? String\(p\.sessionId\) : ''\) : null/.test(sync)
      && /cs\.watched !== null && want === null/.test(sync) && sync.indexOf('chatSkinUnwatch(id)') > 0
      && /chatSkinWatch\(id, want \|\| null\)/.test(sync)
      && sync.indexOf('chatSkinUnwatch(id)') < sync.indexOf('chatSkinWatch(id,');
  },
  (src) => src.replace('if (cs.watched === want) return;', 'if (cs.watched) return;'));

guarded('a transcript that is not there yet is "waiting", not an error: a new session has no file until its first message',
  (src) => /r && !r\.ok && r\.error === 'not-found'\) \{ chatSkinPaintState\(p\); return; \}/.test(fnBody(slice(src), 'chatSkinSync')),
  (src) => src.replace("r.error === 'not-found'", "r.error === 'nothing'"));

test('every place that learns, changes or forgets a session tells the skin (or the tick reconciles it)', () => {
  const hooks = (app.match(/chatSkinSessionChanged\(/g) || []).length;
  // title listener (×2: name match + process-tree correction), pulse "ended", restore, tick, recheck, definition
  assert.ok(hooks >= 7, `expected the adoption sites to call chatSkinSessionChanged, found ${hooks}`);
  const tick = fnBody(skin, 'chatSkinTick');
  assert.match(tick, /chatSkinEligible\(p\)[\s\S]*chatSkinSessionChanged\(id, p\)[\s\S]*chatSkinSync\(id, p\)/, 'the tick is the safety net for sites that do not call');
  // adoptUnidentified is exercised by sessionRestore.test.ts in isolation, so it relies on the tick on purpose
  assert.doesNotMatch(/function adoptUnidentified\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /chatSkin\w*\(/);
  // negative control: a pane that is not a Claude pane is not eligible
  assert.match(fnBody(skin, 'chatSkinEligible'), /p\.kind === 'term' && !p\.exited/);
});

// ── the xterm is hidden without being destroyed or resized ──────────────────

guarded('hiding the xterm never uses display:none on its host, and no fit() runs while the skin is up',
  (src) => {
    const s = slice(src);
    const fits = [...s.matchAll(/\.fit\(\)/g)].length;
    const handBack = fnBody(s, 'chatSkinHandBack');
    const twrapDisplay = /twrap[^\n]*style\.display|\.twrap[^{]*\{[^}]*display:\s*none/;
    return fits === 1 && /\.fit\(\)/.test(handBack) && /p\.view === 'chat'/.test(handBack)
      && !twrapDisplay.test(s) && !twrapDisplay.test(css)
      && !/ptyResize\(/.test(s)
      && /\.pane\.termcard\.view-chat \.twrap \{ visibility: hidden; \}/.test(css);
  },
  (src) => src.replace('function chatSkinFocus(p) {', "function chatSkinFocus(p) {\n  p.el.querySelector('.twrap').style.display = 'none';"));

test('no CSS rule of the skin can punch through a hidden pane with an explicit visibility:visible', () => {
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');   // rules only: the prose explains the very mistake
  assert.ok(sk.length > 1500, 'the skin stylesheet block must exist');
  assert.doesNotMatch(sk, /visibility:\s*visible/, 'a child with visibility:visible shows through .panehidden (use inherit)');
  assert.match(sk, /\.pane\.termcard\.view-chat\.cs-strip \.twrap \{ visibility: inherit; \}/);
  // control: the pattern would catch the mistake
  assert.match(sk + '\n.x { visibility: visible; }', /visibility:\s*visible/);
});

test('the pty resize path stays the terminal\'s own (the skin adds no geometry push)', () => {
  assert.doesNotMatch(skin, /ptyResize/);
  // the only geometry push is the hand-back, after the overlay is gone
  const uses = [...skin.matchAll(/pushPtyGeom\(/g)].length;
  assert.equal(uses, 1);
  assert.match(fnBody(skin, 'chatSkinHandBack'), /pushPtyGeom\(id, p\)/);
});

// ── doors: button, shortcut, menu, context menu, preference ─────────────────

guarded('the toggle has all its doors: tab button, menu item with a free accelerator, context-menu row, Settings preference',
  (src) => {
    const accels = [...menu.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);
    const mine = /accelerator: '(CmdOrCtrl\+Shift\+L)', click: \(\) => intent\('toggleChatView'\)/.exec(menu)?.[1];
    return !!mine && accels.filter((a) => a === mine).length === 1
      && /case 'toggleChatView': chatSkinToggleFocused\(\); return;/.test(src)
      && /value: 'chatView'/.test(src) && /pick === 'chatView'\) chatSkinToggle\(id\)/.test(src)
      && /chatSkinMountToggle\(id, p\)/.test(fnBody(src, 'createPane'))
      && /setSetting\('chatViewDefault', chatDefToggle\.checked\)/.test(src);
  },
  (src) => src.replace("case 'toggleChatView': chatSkinToggleFocused(); return;", '/* removed */'));

guarded('chatViewDefault opens every NEW Claude pane in chat view, restored and resumed ones included, because they all come through createPane',
  (src) => {
    const dflt = fnBody(slice(src), 'chatSkinMaybeDefault');
    return /createPane/.test(fnBody(src, 'createPane')) && /chatSkinMaybeDefault\(id, p\)/.test(fnBody(src, 'createPane'))
      && /paneIsClaude\(p\.cmd\)/.test(dflt) && /chatViewDefault === true/.test(dflt) && /chatSkinSetView\(id, 'chat'\)/.test(dflt)
      && /await createPane\(\{ name: ph\.name, cmd, cwd: ph\.cwd \|\| undefined \}\)/.test(src);   // restore/resume path: `claude --resume` via createPane
  },
  (src) => src.replace("chatViewDefault === true", 'chatViewDefault === 1'));

// ── dialogs the chat cannot draw ────────────────────────────────────────────

guarded('a prompt event brings the REAL xterm forward with focus and a visible, announced notice; kind null puts the composer back',
  (src) => {
    const s = slice(src);
    const pr = fnBody(s, 'chatSkinPrompt');
    return /p\.term\.focus\(\)/.test(pr) && /toast\(t\(card \? 'chat\.skin\.needsYouHere' : 'chat\.skin\.needsYou', \{ name: chatSkinWho\(p\) \}\)\)/.test(pr) && /markActivity\(id\)/.test(pr)
      && /chatSkinFocus\(p\)/.test(pr)
      && /el\('div', 'cs-alert'\)/.test(s) && /alertEl\.setAttribute\('role', 'alert'\)/.test(s)
      && /classList\.toggle\('cs-strip'/.test(fnBody(s, 'chatSkinLayout'))
      && /cs\.input\.disabled = !!cs\.promptKind/.test(fnBody(s, 'chatSkinLayout'));
  },
  (src) => src.replace("alertEl.setAttribute('role', 'alert');", ''));

test('there is always a way back to the terminal, and a stalled turn offers it', () => {
  assert.match(skin, /alertBtn\.addEventListener\('click', \(\) => chatSkinSetView\(id, 'term'\)\)/, 'the notice button');
  assert.match(skin, /p\.viewBtn = b;/, 'the tab button: the pane has no header switch any more, so this icon is the way back');
  assert.match(fnBody(skin, 'chatSkinMountToggle'), /b\.addEventListener\('click', go\)/);
  // the safety net: open turn + live pty + silent transcript -> the stalled notice
  const tick = fnBody(skin, 'chatSkinTick');
  assert.match(tick, /cs\.turnOpen && now - \(p\.lastPtyAt \|\| 0\) < CS_WORKING_MS \* 2 && quiet > CS_STALL_MS/);
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /chat\.skin\.stalled/);
  // lastPtyAt is recorded on every pty:data of the pane
  assert.match(/window\.glassShell\.onPtyData\(\(m\) => \{[\s\S]*?\n\}\);/.exec(app)?.[0] ?? '', /p\.lastPtyAt = Date\.now\(\)/);
});

test('the usage bar prefers this session\'s own numbers over the global statusline payload', () => {
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(fnBody(skin, 'chatContextOf'), /Number\.isFinite\(cs\.ctxTokens\)/);
  assert.match(paint, /const model = cs\.model \|\| cs\.status\.model;/);
  assert.match(fnBody(skin, 'chatSkinRefreshStatus'), /gs\.chatStatus\(cs\.pane\.sessionId\)/);
  // an absent number is a dash, never a fabricated 0
  assert.match(fnBody(skin, 'chatApplyStatus'), /s\[k\] === undefined \|\| s\[k\] === null \|\| s\[k\] === ''\) continue;/);
});

// ── untrusted model text ────────────────────────────────────────────────────

test('model output never reaches the DOM as raw HTML', () => {
  const md = fnBody(skin, 'chatMarkdown');
  assert.match(md, /new marked\.Marked\(/);
  assert.doesNotMatch(md, /marked\.use\(/, 'the global marked must not be reconfigured');
  assert.match(md, /html\(tok\) \{ return chatEscape\(/);
  const san = fnBody(skin, 'chatSanitize');
  assert.match(san, /document\.createElement\('template'\)/);
  assert.match(san, /CHAT_DROP\.has\(tag\)/);
  assert.match(san, /\^\(https\?:\|mailto:\)/, 'only http(s) and mailto links survive');
  assert.match(san, /child\.removeAttribute\(a\.name\)/, 'no attribute (onerror, style, src…) survives');
  const tags = /const CHAT_TAGS = new Set\(\[([\s\S]*?)\]\)/.exec(skin)?.[1] ?? '';
  for (const bad of ['SCRIPT', 'IMG', 'IFRAME', 'STYLE', 'FORM', 'SVG']) assert.doesNotMatch(tags, new RegExp(`'${bad}'`), `${bad} must not be allowed`);
  assert.match(fnBody(skin, 'chatRender'), /chatSanitize\(chatMarkdown\(\)\.parse\(/);
  assert.match(fnBody(skin, 'chatRender'), /target\.replaceChildren\(frag\)/);
  // the only markup writes: the inert template, hljs output over textContent, the tab icon glyph, and csIcon's holder
  // (an icon from the static ICONS table, never model text — a model-text write would still show up as a new name here)
  const direct = [...skin.matchAll(/(\w+(?:\.\w+)*)\.innerHTML\s*=/g)].map((m) => m[1]);
  assert.deepEqual(direct.sort(), ['b', 'code', 'holder', 'tpl'], `unexpected innerHTML writes: ${direct.join(', ')}`);
  // the operator's and the transcript's plain text go in as textContent
  assert.match(fnBody(skin, 'chatSkinUpsert'), /rec\.body\.textContent = text/);
  // links open in the system browser, never inside this window
  assert.match(skin, /e\.preventDefault\(\);\n\s+void window\.glassShell\.openExternal\(/);
  // negative control: an innerHTML of model text would be caught by the same list
  assert.notDeepEqual([...(skin + '\nrow.innerHTML = text;').matchAll(/(\w+(?:\.\w+)*)\.innerHTML\s*=/g)].map((m) => m[1]).sort(), ['b', 'code', 'holder', 'tpl']);
});

test('the markdown sanitizer, run for real, drops scripts, handlers and unsafe links', () => {
  // the browser DOM is not available here, so the policy tables are checked instead of the walk
  const drop = /const CHAT_DROP = new Set\(\[([\s\S]*?)\]\)/.exec(skin)?.[1] ?? '';
  for (const must of ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG']) assert.match(drop, new RegExp(`'${must}'`));
  assert.match(fnBody(skin, 'chatSanitize'), /tag === 'IMG'[\s\S]*alt/, 'a remote image is replaced by its alt text, never fetched');
});

// ── i18n and colours ────────────────────────────────────────────────────────

const loc = Object.fromEntries(['en', 'es', 'pt-br'].map((l) => [l, JSON.parse(read(`src/i18n/locales/${l}.json`)) as Record<string, string>]));

test('every key the skin, the menu and the settings row use exists in en, es and pt-br, with the same placeholders', () => {
  const used = new Set<string>([
    ...[...skin.matchAll(/\bt\('([A-Za-z.-]+)'/g)].map((m) => m[1]),
    ...[...skin.matchAll(/label: '(chat\.[A-Za-z.]+)'/g)].map((m) => m[1]),    // CHAT_FONTS labels
    ...[...skin.matchAll(/\['[A-Za-z]+', '(chat\.usage\.[A-Za-z]+)'/g)].map((m) => m[1]),   // CHAT_USAGE_FIELDS labels
    'menu.chatView', 'settings.chatViewDefault', 'settings.chatViewDefaultHint',
    'settings.chatFont', 'settings.chatFontHint', 'settings.chatSize', 'settings.chatSizeHint', 'chat.settings.sample',   // the Settings rows for the chat's font and size
  ]);
  // keys built at run time: 'chat.skin.prompt.' + kind, 'chat.skin.tool.' + status
  const kinds = /const CHAT_PROMPT_KINDS = \[([^\]]+)\]/.exec(skin)?.[1].match(/'([a-z]+)'/g) ?? [];
  assert.ok(kinds.length >= 6, 'the prompt kinds of the contract');
  for (const k of kinds) used.add('chat.skin.prompt.' + k.slice(1, -1));
  for (const s of ['running', 'ok', 'error']) used.add('chat.skin.tool.' + s);
  for (const k of [...used].filter((u) => u.endsWith('.'))) used.delete(k);
  assert.ok(used.size >= 40, `expected the full chat vocabulary, found ${used.size}`);
  for (const l of Object.keys(loc)) {
    const missing = [...used].filter((k) => typeof loc[l][k] !== 'string' || !loc[l][k].trim());
    assert.deepEqual(missing, [], `${l}.json is missing: ${missing.join(', ')}`);
  }
  // control: a key nobody wrote is reported missing
  assert.equal(typeof loc.en['chat.skin.nope'], 'undefined');
  const keysOf = (l: string): string[] => Object.keys(loc[l]).filter((k) => k.startsWith('chat.')).sort();
  assert.deepEqual(keysOf('es'), keysOf('en'));
  assert.deepEqual(keysOf('pt-br'), keysOf('en'));
  const holes = (s: string): string => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keysOf('en')) for (const l of ['es', 'pt-br']) assert.equal(holes(loc[l][k]), holes(loc.en[k]), `${l}.json ${k}: placeholders differ from en`);
});

test('the SDK pane\'s strings are gone from every locale', () => {
  for (const l of Object.keys(loc)) {
    const stale = Object.keys(loc[l]).filter((k) => /^(menu\.openChat|newtab\.chat|tab\.newChat|chat\.title|chat\.unavailable|chat\.perm\.|chat\.interrupted|chat\.turnError|chat\.exited|chat\.error\.)/.test(k));
    assert.deepEqual(stale, [], `${l}.json still carries ${stale.join(', ')}`);
  }
});

test('every colour the skin uses is a token (none minted in the skin\'s own rules), defined for both themes', () => {
  const tokens = ['--chat-user-bg', '--chat-user-line', '--chat-claude-bg', '--chat-claude-line', '--chat-code-bg', '--chat-tool-ink',
    // the redesign's own (each must resolve against body.light's ink/surface, hence re-declared there)
    '--chat-code-head', '--chat-out-bg', '--chat-row-hover', '--chat-table-head', '--chat-table-zebra', '--chat-quote-line', '--chat-composer-bg',
    '--chat-composer-line', '--chat-meter-track', '--chat-meter-fill', '--chat-focus', '--chat-float', '--chat-pop', '--chat-on-accent',
    // the status bar's own
    '--chat-meter-warn', '--chat-meter-hot', '--chat-warn-ink', '--chat-hot-ink', '--chat-bar-bg', '--chat-bar-line', '--chat-bar-sep'];
  const light = css.slice(css.indexOf('body.light {'));
  for (const tk of tokens) {
    assert.match(css, new RegExp(`:root \\{[^}]*${tk}:`), `${tk} must be minted in :root`);
    assert.match(light, new RegExp(`${tk}:`), `${tk} must be re-declared for body.light (a var() resolves where it is declared)`);
  }
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(sk, /#[0-9a-fA-F]{3,8}\b/, 'no hex literal in the skin\'s rules');
  assert.doesNotMatch(sk, /\brgba?\(/, 'no raw rgb()/rgba() in the skin\'s rules');
  // control
  assert.match(sk + '\n.x { color: #fff; }', /#[0-9a-fA-F]{3,8}\b/);
});

/** The Settings screen's own function: the font and size of the chat live there and nowhere in the conversation. */
const settingsFn = (src: string): string => fnBody(src, 'openSettingsTab');
guarded('the chat font and size are chosen in Settings, in the chatViewDefault section, saved under the same two keys and applied live',
  (src) => {
    const st = settingsFn(src);
    const at = (needle: string): number => st.indexOf(needle);
    const def = at("row(wrap, t('settings.chatViewDefault')");
    const font = at("row(wrap, t('settings.chatFont')");
    const size = at("row(wrap, t('settings.chatSize')");
    const next = at("row(wrap, t('settings.appFont')");
    // the same section: right after the chat-by-default toggle, before the next unrelated row
    const together = def > 0 && font > def && size > font && next > size && font - def < 3500;
    const fontHandler = /chatFontSel\.addEventListener\('change'[\s\S]*?\n    \}\);/.exec(st)?.[0] ?? '';
    const sizeHandler = /chatSizeSel\.addEventListener\('change'[\s\S]*?\n    \}\);/.exec(st)?.[0] ?? '';
    return together
      && /chatPrefs\.family = chatFontSel\.value/.test(fontHandler) && /chatApplyPrefs\(\)/.test(fontHandler) && /setSetting\('chatFontFamily', chatPrefs\.family\)/.test(fontHandler)
      && /chatPrefs\.size = v/.test(sizeHandler) && /chatApplyPrefs\(\)/.test(sizeHandler) && /setSetting\('chatFontSize', v\)/.test(sizeHandler)
      && /chatReadPrefs\(cfg\)/.test(st)   // seeded from the config this page was built from, not from whatever a chat view last read
      && /CHAT_FONTS\.map/.test(st) && /CHAT_SIZES\.map/.test(st);
  },
  // the live effect is lost: the font is saved but no open chat repaints until the next time it is entered
  (src) => src.replace("      chatPrefs.family = chatFontSel.value;\n      chatApplyPrefs();", "      chatPrefs.family = chatFontSel.value;"));


// ── integration: renderer ↔ preload ↔ main speak the same contract ──────────

/** The renderer's pane id IS the pty id: every call below passes the `panes` key, and main keys `skins` by the pty id. */
const contractHolds = (rend: string, pre: string, mn: string): boolean => {
  const chans = ['chatSkin:watch', 'chatSkin:unwatch', 'chatSkin:event', 'chatSkin:screen'];
  const events = ['reset', 'items', 'turn', 'usage', 'prompt', 'stream', 'missing', 'error'];
  const handler = /function chatSkinHandleEvent\(ev\) \{[\s\S]*?\n\}/.exec(rend)?.[0] ?? '';
  return chans.every((c) => pre.includes(`'${c}'`) && mn.includes(`'${c}'`))
    && /ipcMain\.handle\('chatSkin:watch'/.test(mn) && /ipcMain\.handle\('chatSkin:unwatch'/.test(mn)
    && /ipcMain\.on\('chatSkin:screen'/.test(mn) && /sender\.send\('chatSkin:event', ev\)/.test(mn)
    && events.every((e) => new RegExp(`type: '${e}'`).test(pre) && new RegExp(`case '${e}':`).test(handler))
    && /glassShell\.onChatSkinEvent\(chatSkinHandleEvent\)/.test(rend)
    && /gs\.chatSkinWatch\(id, want \|\| null\)/.test(rend) && /gs\.chatSkinUnwatch\(id\)/.test(rend)
    && /glassShell\.chatSkinScreen\(id, chatSkinScreenText\(p\)\)/.test(rend)
    && /const paneId = ev\.paneId|const id = ev\.paneId/.test(handler) && /panes\.get\(id\)/.test(handler)
    && /const id = nextId\+\+;\n\s+ptys\.set\(id, p\);/.test(mn)
    && /const id = await window\.glassShell\.ptySpawn\(/.test(rend) && /panes\.set\(id, p\)/.test(rend);
};
test('the renderer, the preload and main agree on every channel, event type and the pane id', () => {
  assert.ok(contractHolds(app, preload, main));
  // negative controls: a renamed channel, a dropped event case and a pane id that is not the pty id each break it
  assert.equal(contractHolds(app, preload.replaceAll("'chatSkin:event'", "'chatSkin:events'"), main), false);
  assert.equal(contractHolds(app.replace("case 'missing':", "case 'absent':"), preload, main), false);
  assert.equal(contractHolds(app, preload, main.replace('const id = nextId++;', 'const id = nextId++ + 1;')), false);
});

test('main\'s watch accepts a null session id (dialogs only) and keeps the dialog monitor when the id arrives', () => {
  const w = /ipcMain\.handle\('chatSkin:watch'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(w, /sessionId: string \| null/);
  assert.match(w, /if \(!transcript\) return \{ ok: true, file: '' \}/);
  assert.match(w, /if \(!k\) \{[\s\S]*createPromptMonitor[\s\S]*skins\.set\(id, k\)/, 'the monitor is created once, not per watch');
  assert.match(w, /monitor\.push\(seen\)/, 'a dialog already on screen is not forgotten');
  assert.match(preload, /chatSkinWatch: \(paneId: number, sessionId: string \| null\)/);
  assert.doesNotMatch(w.replace('if (!k) {', 'if (true) {'), /if \(!k\) \{/, 'control: the reuse guard is what the first check reads');
});

// ── the dialog detector, against what this CLI really draws ─────────────────

/* Claude Code 2.1 places words with an ABSOLUTE column (`ESC[<n>G`) and draws the folder-trust dialog
   with no numbers. Hand-written from a capture's structure; neutral folder name. */
const TRUST_RAW = '\x1b[2G\x1b[38;5;220m\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\r\r\n\r\r\n\x1b[2G\x1b[1m/tmp/example-folder\x1b[22m\r\r\n\r\r\n'
  + '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\r\n\r\r\n'
  + '\x1b[2G\x1b[38;5;246mSecurity\x1b[11Gguide\x1b[39m\r\r\n\r\r\n\x1b[2G\x1b[38;5;153m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n\r\r\n'
  + '\x1b[2G\x1b[38;5;246mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\r\n\x1b[1C\x1b[4A';
/* Moving the selection repaints only the two option lines — the footer is NOT sent again. */
const TRUST_MOVED = '\x1b[1D\x1b[4B\r\x1b[1C\x1b[4A \x1b[4GNo, exit\r\x1b[1C\x1b[1B\x1b[38;5;153m❯\x1b[4GYes, I trust this folder\x1b[39m\r\r\n\r\n\r\n\x1b[1C\x1b[3A';
const TRUST_SCREEN = ['Accessing workspace:', '/tmp/example-folder', 'Quick safety check: Is this a project you created or one you trust?', 'Security guide',
  '   No, exit', ' ❯ Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n');
const COMPOSER_SCREEN = ['Do you want me to continue?', '─'.repeat(60), '❯ Try "fix lint errors"', '─'.repeat(60), ' ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

test('the unnumbered folder-trust dialog is recognised once the absolute-column words are joined', () => {
  assert.equal(detectTuiPrompt(TRUST_RAW)?.kind, 'trust');
  assert.match(detectTuiPrompt(TRUST_RAW)?.hint ?? '', /Quick safety check/);
  // negative control: without the words the same bytes read as noise ("Quicksafetycheck…")
  assert.equal(detectTuiPrompt(TRUST_RAW.replace(/\x1b\[\d+G/g, '')), null);
});

test('the idle composer is not a dialog, even right under a question Claude asked', () => {
  assert.equal(detectTuiPrompt(COMPOSER_SCREEN), null);
  assert.equal(detectTuiPrompt(COMPOSER_SCREEN.replace('Do you want me to continue?', 'Which option do you prefer?')), null);
  assert.equal(detectTuiPrompt(TRUST_SCREEN)?.kind, 'trust', 'control: the same detector does see a real dialog');
});

test('a differential repaint hides the dialog from the stream but not from the screen — which is why the screen is what main reads', () => {
  assert.equal(detectTuiPrompt(TRUST_RAW + TRUST_MOVED), null, 'the raw stream loses it (the footer was not repainted)');
  assert.equal(detectTuiPrompt(TRUST_SCREEN)?.kind, 'trust', 'the screen still shows it');
  const seen: Array<string | null> = [];
  const m = createPromptMonitor({ onChange: (k) => seen.push(k), setTimer: (fn) => { fn(); return 0; }, clearTimer: () => undefined });
  m.screen(TRUST_SCREEN);
  m.screen(TRUST_SCREEN.replace(' ❯ Yes', '   Yes').replace('   No, exit', ' ❯ No, exit'));   // the cursor moved; still a dialog, no flicker
  assert.deepEqual(seen, ['trust'], 'one event, no null in between');
  m.screen(COMPOSER_SCREEN);
  assert.deepEqual(seen, ['trust', null]);
  // control: the stream-fed monitor is the one that flickers
  const seen2: Array<string | null> = [];
  const m2 = createPromptMonitor({ onChange: (k) => seen2.push(k), setTimer: (fn) => { fn(); return 0; }, clearTimer: () => undefined });
  m2.push(TRUST_RAW); m2.push(TRUST_MOVED);
  assert.deepEqual(seen2, ['trust', null]);
});

test('the renderer sends screens only while the chat view is up and watching, after xterm parsed the bytes', () => {
  const fn = fnBody(skin, 'chatSkinScreenSoon');
  assert.match(fn, /cs\.watched === null \|\| p\.view !== 'chat'/);
  assert.match(fn, /clearTimeout\(cs\.screenTimer\)/, 'every chunk pushes the snapshot back to the end of the repaint…');
  assert.match(fn, /cs\.screenSince \+ CS_SCREEN_MAX_MS - now/, '…but never past the ceiling after the first unsent byte');
  assert.match(app, /p\.term\.write\(m\.data, p\.chatSkin && p\.view === 'chat' \? \(\) => \{ chatSkinFrameState\(p\.chatSkin, m\.data\); chatSkinScreenSoon\(m\.id, p\); \} : undefined\)/);
  assert.match(main, /if \(sk && !sk\.screenFed\) sk\.monitor\.push\(data\)/, 'once a screen arrives the raw stream stops feeding the monitor');
  assert.match(main, /k\.sender !== e\.sender/, 'only the window that owns the watch can feed it');
});

// ── the chat view changes nothing about who a session is or how it is reached ──

guarded('in chat view a session is still found by name/id, written to by the bus and the primary, closed, and restored — none of it reads the view',
  (src) => {
    const by = /const byName = [\s\S]*?\n\};/.exec(src)?.[0] ?? '';
    const amb = /const ambiguous = [\s\S]*?;\n/.exec(src)?.[0] ?? '';
    const send = /case 'sendByName': \{[\s\S]*?\n    \}\n/.exec(src)?.[0] ?? '';
    const prim = fnBody(src, 'runInPrimary');
    const close = fnBody(src, 'closePane');
    const snap = fnBody(src, 'sessionsSnapshot');
    const noView = (x: string): boolean => x.length > 40 && !/\.view\b|chatSkin(?!Teardown)/.test(x);
    return noView(by) && noView(amb) && noView(send) && noView(prim) && noView(snap)
      && /submitToPty\(hit\[0\], m\.text\)/.test(send) && /submitToPty\(hit\[0\], slash\)/.test(prim)
      && close.indexOf('chatSkinTeardown(id, p)') > 0 && close.indexOf('chatSkinTeardown(id, p)') < close.indexOf('window.glassShell.ptyKill(id)')
      && /panes\.delete\(id\)/.test(close);
  },
  (src) => src.replace('submitToPty(hit[0], m.text);\n      // a bus send', 'if (panes.get(hit[0]).view === "chat") return;\n      submitToPty(hit[0], m.text);\n      // a bus send'));

guarded('every route that opens a Claude session — new, resume, restore, bus, primary — goes through createPane, where the chat default is applied',
  (src) => {
    const cp = fnBody(src, 'createPane');
    return /chatSkinMountToggle\(id, p\)/.test(cp) && /void chatSkinMaybeDefault\(id, p\)/.test(cp)
      && !/chatSkinMaybeDefault\(/.test(src.replace(cp, '').replace(skin, ''))
      && (src.match(/createPane\(\{[^}]*cmd:/g) || []).length >= 6;
  },
  (src) => src.replace('void chatSkinMaybeDefault(id, p);', ''));

// ── the end-to-end smoke gate stays honest ──────────────────────────────────

const gateHolds = (src: string): boolean => {
    const g = /async function chatViewSmoke[\s\S]*?\n\}\n/.exec(src)?.[0] ?? '';
    return /show: !\(SMOKE \|\| CHAT_SHOT\)/.test(src)
      && /AIOS_SMOKE_CHAT/.test(g) && /strict \? \{ status: 'failed'/.test(g) && /status: 'skipped'/.test(g)
      && /--model haiku/.test(g) && /mkdtempSync\(path\.join\(tmpRoot, 'aios-smoke-chat-'\)\)/.test(g)
      && /\} finally \{[\s\S]*closePane\([\s\S]*rmSync\(dir[\s\S]*rmSync\(tdir/.test(g)
      && /path\.basename\(dir\) === `aios-smoke-chat-\$\{tag\}`/.test(g)
      && /path\.dirname\(tdir\) === projects/.test(g) && /isSymbolicLink\(\)/.test(g)
      && /viewBtn\.click\(\)/.test(g) && /KeyboardEvent\('keydown', \{ key: 'Enter'/.test(g)
      && /app\.exit\(ok && chat\.status !== 'failed' \? 0 : 1\)/.test(src)
      && /smokeUserData = path\.join\(os\.tmpdir\(\), 'aios-smoke-userdata'\)/.test(src);
};
test('the real-session smoke gate: hidden window, skipped without claude, strict on request, always cleans up, deletes only what it can name', () => {
  assert.ok(gateHolds(main));
  assert.equal(gateHolds(main.replace('path.dirname(tdir) === projects', 'true')), false, 'control: a transcript folder check that can be bypassed');
  assert.equal(gateHolds(main.replace('} finally {\n    // CLEANUP', '} catch (e2) {\n    // CLEANUP')), false, 'control: cleanup that only runs on success');
});

// ── the hidden-window screenshot harness (--chat-shot) ──────────────────────
// A QA mode whose one promise is "never shows a window". Everything it does is invisible to the
// unit level (a visible window still captures fine), so the promise is pinned in the source, each
// guard with a negative control, plus the fixture the harness renders.

const runner = read('scripts/chat-shot.mjs');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const chatShotBlock = (src: string): string => {
  const a = src.indexOf('/* ── CHAT SHOT');
  const b = src.indexOf('/* Every session the App creates');
  return a >= 0 && b > a ? src.slice(a, b) : '';
};
const shotBlock = chatShotBlock(main);

test('chat-shot: the window is created hidden, the lock makes any later show a no-op, and nothing in the mode shows it', () => {
  const holds = (src: string): boolean => {
    const win = /new BrowserWindow\(\{[\s\S]*?\n  \}\);/.exec(src)?.[0] ?? '';
    const lock = /function lockWindowHidden\(win: BrowserWindow\): void \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    return /show: !\(SMOKE \|\| CHAT_SHOT\)/.test(win)
      && /show: noop/.test(lock) && /showInactive: noop/.test(lock) && /focus: noop/.test(lock) && /win\.on\('show', \(\) => \{[^}]*win\.hide\(\)/.test(lock)
      && /if \(CHAT_SHOT\) \{ lockWindowHidden\(win\); void runChatShot\(win\); return; \}/.test(src)
      && !/\.show\(\)|showInactive\(\)|\.focus\(\)/.test(chatShotBlock(src).replace(lock, ''))
      && /if \(!CHAT_SHOT && mainWin/.test(src);   // the Dock's activate handler
  };
  assert.ok(holds(main), 'the hidden-window guarantees must hold on the real source');
  assert.equal(holds(main.replace('show: !(SMOKE || CHAT_SHOT)', 'show: !SMOKE')), false, 'control: a window that is shown in chat-shot mode');
  assert.equal(holds(main.replace("win.on('show', () => { if (!win.isDestroyed()) win.hide(); });", '')), false, 'control: no re-hide if something shows it');
  assert.equal(holds(main.replace('void runChatShot(win); return; }', 'void runChatShot(win); }')), false, 'control: the mode falls through into the normal flow');
});

test('chat-shot: skips the single-instance lock, the bus, the watchers and the updater, like --shot and --eval', () => {
  const holds = (src: string): boolean => /if \(!\(SMOKE \|\| CHAT_SHOT\) && !app\.requestSingleInstanceLock\(\)\)/.test(src)
    && /if \(!SMOKE && !SHOT && !CHAT_SHOT\) setupExplorerWatch\(win\)/.test(src)
    && /if \(!SMOKE && !SHOT && !CHAT_SHOT\) setupClaudeConfigWatch\(win\)/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) initCommandBus\(/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) initAutoUpdater\(/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) \{\s*const stopCaffeine/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) \{\s*try \{\s*const r = aios\.seedClaudeDefaults/.test(src);
  assert.ok(holds(main));
  assert.equal(holds(main.replace('!(SMOKE || CHAT_SHOT) && !app.requestSingleInstanceLock()', '!SMOKE && !app.requestSingleInstanceLock()')), false, 'control: the lock is taken, so a QA run would quit the moment the App is open');
  assert.equal(holds(main.replace('!SHOT && !EVAL && !CHAT_SHOT) initCommandBus(', '!SHOT && !EVAL) initCommandBus(')), false, 'control: the bus would fulfil real spawn requests');
});

test('chat-shot: 1280x860 CSS px at 2x, throwaway userData, a 2x switch set before ready, and a global timeout', () => {
  const holds = (src: string): boolean => {
    const top = src.slice(0, src.indexOf('const ptys = new Map'));
    return /CHAT_SHOT_SIZE = \{ width: 1280, height: 860 \}/.test(top)
      && /if \(CHAT_SHOT\) \{\s*\/\*[\s\S]*?app\.commandLine\.appendSwitch\('force-device-scale-factor', '2'\)/.test(top)
      && /useContentSize: CHAT_SHOT/.test(src)
      && /backgroundThrottling: false/.test(src)
      && /--user-data-dir must be an existing folder under/.test(top) && /process\.exit\(1\)/.test(top)
      && /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'aios-chatshot-ud-'\)\)/.test(top)
      && /setTimeout\(\(\) => fail\('timed out after 150 s'\), 150_000\)/.test(chatShotBlock(src))
      && /finish\(0\)/.test(chatShotBlock(src)) && /app\.exit\(code\)/.test(chatShotBlock(src));
  };
  assert.ok(holds(main));
  assert.equal(holds(main.replace("appendSwitch('force-device-scale-factor', '2')", "appendSwitch('force-device-scale-factor', '1')")), false, 'control: a 1x capture');
  assert.equal(holds(main.replace("'aios-chatshot-ud-'", "'aios-chatshot-'")), false, 'control: userData named something the cleanup would not recognise');
  assert.equal(holds(main.replace('150_000', '1_500_000')), false, 'control: a timeout nobody would wait for');
});

test('chat-shot: the renderer driver only feeds the skin and the xterm — it never writes to the pty', () => {
  const driver = /const CHAT_SHOT_DRIVER = String\.raw`[\s\S]*?\n\}\)\(\)`;/.exec(main)?.[0] ?? '';
  assert.ok(driver.length > 1500, 'the driver was found');
  assert.ok(/chatSkinHandleEvent\(/.test(driver) && /p\.term\.write\(/.test(driver));
  assert.equal(/ptyWrite|submitToPty|ptyRun\(|chatSkinSendNow/.test(driver), false, 'the driver must never type into the pty');
  assert.equal(/ptyWrite|submitToPty/.test(driver.replace('p.term.write(', 'ptyWrite(')), true, 'control: the pattern does catch a pty write');
  assert.ok(/noProfile: true/.test(driver) && /cmd: 'cat'/.test(driver), 'a bare shell running cat, never a real claude');
});

test('chat-shot: the fake watch is settled before the fixture is injected, and the choice is written down', () => {
  const holds = (src: string): boolean => {
    const open = src.indexOf('async open(o)');
    const apply = src.indexOf('async apply(id, spec)');
    const i = src.indexOf('await window.glassShell.chatSkinWatch(id, FAKE_SESSION)');
    return open > 0 && i > open && i < apply && /THE FAKE SESSION, AND THE WATCH THAT COMES BACK/.test(src);
  };
  assert.ok(holds(main));
  assert.equal(holds(main.replace('await window.glassShell.chatSkinWatch(id, FAKE_SESSION);', '')), false, 'control: injecting while the app\'s own watch can still answer');
});

test('chat-shot: the runner isolates HOME + userData, turns the bus off, launches --chat-shot hidden and deletes only its own temp folders', () => {
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const holds = (src: string): boolean => /demo\.mjs'\), '--build-only', '--out', home/.test(src)
    && /AIOS_BUS_DISABLED: '1'/.test(src) && /HOME: home/.test(src)
    && /`--user-data-dir=\$\{userData\}`/.test(src) && /`--chat-shot=\$\{out\}`/.test(src) && /--use-mock-keychain/.test(src)
    && /real\.startsWith\(tmp \+ path\.sep\) && path\.basename\(real\)\.startsWith\(PREFIX\)/.test(src)
    && /const cleanup = \(\) => \{ for \(const d of created\.splice\(0\)\) if \(isOurTemp\(d\)\)/.test(src)
    && !/--shot|--eval|--smoke|\.dev-userdata|pkill|killall/.test(code(src));
  assert.ok(holds(runner));
  assert.equal(holds(runner.replace("AIOS_BUS_DISABLED: '1'", "AIOS_BUS_DISABLED: '0'")), false, 'control: the bus left on');
  assert.equal(holds(runner.replace('path.basename(real).startsWith(PREFIX)', 'true')), false, 'control: a cleanup that deletes any temp folder');
  assert.equal(holds(runner.replace('`--user-data-dir=${userData}`', "'--user-data-dir=.dev-userdata'")), false, 'control: the developer userData');
  assert.equal(holds(runner.replace("'--use-mock-keychain',", "'--use-mock-keychain', '--eval=1',")), false, 'control: a visible-window flag');
  assert.equal(pkg.scripts['chat:shot'], 'npm run compile && node scripts/chat-shot.mjs');
});

interface FxTool { id: string; name: string; summary: string; status: string; output?: string }
interface FxItem { uuid: string; role: string; text?: string; tool?: FxTool }
interface FxEvent { type: string; items?: FxItem[]; kind?: string; open?: boolean; [k: string]: unknown }
interface FxShot { name: string; theme?: string; events?: Array<string | FxEvent>; composer?: string; terminal?: string; js?: string | string[]; size?: { width: number; height: number }; layout?: string }
const fixture = JSON.parse(read('src/test/fixtures/chat-shot.json')) as { version: number; setup?: string | string[]; streams: Record<string, FxEvent[]>; shots: FxShot[] };

test('chat-shot fixture: parses, has the minimum shots, and every shot resolves to real streams', () => {
  assert.equal(fixture.version, 1);
  const names = fixture.shots.map((s) => s.name);
  for (const n of ['chat-dark', 'chat-light', 'attention-dark', 'attention-light', 'empty-dark']) assert.ok(names.includes(n), `missing shot ${n}`);
  assert.equal(new Set(names).size, names.length, 'shot names are unique (they become file names)');
  for (const s of fixture.shots) {
    assert.match(s.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    for (const e of s.events ?? []) assert.ok(typeof e === 'string' ? Array.isArray(fixture.streams[e]) : typeof e.type === 'string', `${s.name}: bad event ${JSON.stringify(e).slice(0, 60)}`);
  }
  const byName = (n: string): FxShot => fixture.shots.find((s) => s.name === n) as FxShot;
  assert.equal(byName('chat-dark').theme, 'dark');
  assert.equal(byName('chat-light').theme, 'light');
  for (const n of ['chat-dark', 'chat-light']) assert.ok(byName(n).composer, `${n} has text in the composer`);
  for (const n of ['attention-dark', 'attention-light']) assert.ok(byName(n).terminal && (byName(n).events ?? []).includes('attention-prompt'), `${n} shows a dialog in the xterm and fires a prompt event`);
  assert.ok(fixture.shots.some((s) => s.js), 'at least one shot demonstrates per-shot js');
  assert.ok(fixture.shots.some((s) => s.size), 'at least one shot demonstrates a size override');
});

test('chat-shot fixture: the conversation covers markdown, three tool states with output, usage, and an open turn', () => {
  const ev = fixture.streams.conversation;
  const items = ev.filter((e) => e.type === 'items').flatMap((e) => e.items ?? []);
  assert.ok(items.filter((i) => i.role === 'user').length >= 2 && items.filter((i) => i.role === 'user').length <= 3, '2 or 3 operator messages');
  const md = items.filter((i) => i.role === 'assistant').map((i) => i.text ?? '').join('\n');
  for (const [what, re] of [['h2', /^## /m], ['h3', /^### /m], ['bullets', /^- /m], ['numbered list', /^1\. /m], ['inline code', /`[^`\n]+`/], ['ts block', /```ts\n/], ['bash block', /```bash\n/],
    ['3-column table', /^\|[^|\n]+\|[^|\n]+\|[^|\n]+\|$/m], ['blockquote', /^> /m], ['link', /\[[^\]]+\]\(https?:\/\/[^)]+\)/]] as Array<[string, RegExp]>) assert.match(md, re, `markdown: ${what}`);
  const tools = items.filter((i) => i.role === 'tool').map((i) => i.tool as FxTool);
  assert.deepEqual([...new Set(tools.map((t) => t.status))].sort(), ['error', 'ok', 'running']);
  for (const t of tools) { assert.ok(t.summary, `${t.name} has a summary`); assert.ok((t.output ?? '').split('\n').length >= 2, `${t.name} has multi-line output`); }
  const status = ev.find((e) => e.type === 'status') as FxEvent;
  assert.ok(typeof status.fiveHourPct === 'number' && typeof status.sevenDayPct === 'number' && status.model && status.effort);
  const usage = ev.find((e) => e.type === 'usage') as FxEvent;
  assert.ok(Number.isFinite(usage.contextTokens) && usage.model);
  assert.equal((ev[ev.length - 1] as FxEvent).open, true, 'the turn is left open: Claude is working');
  const prompt = fixture.streams['attention-prompt'][0];
  assert.ok(prompt.type === 'prompt' && (prompt.kind === 'permission' || prompt.kind === 'trust'));
});

test('chat-shot fixture: neutral by construction — no hex colors, no personal paths, nothing copied from a real vault', () => {
  const raw = read('src/test/fixtures/chat-shot.json');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(raw), false);
  assert.equal(/\/Users\/|\/home\/|C:\\\\|@gmail|\.aios\/|vault/i.test(raw), false);
});

// ── the "boxes" redesign: what it must never loosen ─────────────────────────

guarded('the code header and the copy button are built AFTER the sanitiser, as DOM — a <button> can never come from model output',
  (src) => {
    const s = slice(src);
    const render = fnBody(s, 'chatRender');
    const deco = fnBody(s, 'chatDecorate');
    const tags = /const CHAT_TAGS = new Set\(\[([\s\S]*?)\]\)/.exec(s)?.[1] ?? '';
    return render.indexOf('chatSanitize(') > 0 && render.indexOf('chatSanitize(') < render.indexOf('chatDecorate(frag)')
      && render.indexOf('chatDecorate(frag)') < render.indexOf('target.replaceChildren(frag)')
      && /el\('button', 'cm-copy'\)/.test(deco) && !/innerHTML/.test(deco) && !/BUTTON/.test(tags)
      && /glassShell\.copyText\(text\)/.test(deco) && /chat\.code\.copied/.test(deco);
  },
  (src) => src.replace('chatDecorate(frag);\n  target.replaceChildren(frag);', 'target.replaceChildren(frag);\n  chatDecorate(target);'));

guarded('a tool\'s output is untrusted text: it only ever enters through textContent, and an open row stays open when its status moves',
  (src) => {
    const s = slice(src);
    const paint = fnBody(s, 'chatSkinPaintTool');
    const make = fnBody(s, 'chatSkinMakeTool');
    return /x\.out\.textContent = text/.test(paint) && !/innerHTML/.test(paint) && !/innerHTML/.test(make)
      && /aria-expanded/.test(make)
      // the status moves on the same node: classes toggle, nothing is rebuilt, so `open` survives
      && /rec\.node\.classList\.remove\('running', 'ok', 'error'\)/.test(paint) && !/rec\.node\.className\s*=/.test(paint)
      && /rec\.node\.dataset\.kind/.test(paint) && /chatSkinPaintTool\(rec, item\)/.test(fnBody(s, 'chatSkinUpsert'));
  },
  (src) => src.replace('x.out.textContent = text;', 'x.out.innerHTML = text;'));

test('tool kinds: each family gets its glyph by name, anchored, and anything else falls to the wrench', () => {
  const s = slice(app);
  const table = /const CHAT_TOOL_KINDS = \[[\s\S]*?\n\];/.exec(s)?.[0] ?? '';
  const fn = fnBody(s, 'chatToolKind');
  assert.ok(table && fn);
  const kind = new Function(`${table}\n${fn}\nreturn chatToolKind;`)() as (n: string) => { kind: string; ico: string };
  for (const [name, want] of [['Read', 'read'], ['NotebookRead', 'read'], ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
    ['Bash', 'bash'], ['BashOutput', 'bash'], ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'], ['WebFetch', 'web'], ['WebSearch', 'web'],
    ['Task', 'agent'], ['Agent', 'agent']] as Array<[string, string]>) assert.equal(kind(name).kind, want, name);
  assert.equal(kind('mcp__drive__read_file').kind, 'tool', 'an MCP tool is generic');
  assert.equal(kind('Bashful').kind, 'tool', 'control: the match is anchored, a name that merely starts like Bash is generic');
  assert.equal(kind('').kind, 'tool');
  // every glyph a kind points at exists in the icon table (a missing one would silently draw the file icon)
  const have = new Set([...app.matchAll(/^  ([A-Za-z0-9]+): '</gm)].map((m) => m[1]).concat([...s.matchAll(/^  ([A-Za-z0-9]+): '</gm)].map((m) => m[1])));
  for (const [, , ico] of [...table.matchAll(/\['(\w+)', \/[^/]+\/, '(\w+)'\]/g)].map((m) => [m[0], m[1], m[2]])) assert.ok(have.has(ico), `icon ${ico} exists`);
});

test('every animation in the skin has a prefers-reduced-motion fallback that stops it', () => {
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  const reduced = [...sk.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\}\s*(?=\n|$)/g)].map((m) => m[1]).join('\n');
  const animated = [...sk.matchAll(/(?:^|\n)\s*([^@{}\n][^{}\n]*?)\s*\{[^}]*\banimation:\s*(?!none)[^;}]+/g)].map((m) => m[1].trim());
  assert.ok(animated.length >= 3, `expected the skin's animated selectors, found ${animated.join(' | ')}`);
  for (const sel of animated) assert.ok(reduced.includes(sel), `${sel} animates and has no reduced-motion rule`);
  // control: a selector missing from the reduced block is caught by the same test
  assert.equal(reduced.includes('.not-in-the-skin'), false);
});

test('every string the redesigned skin shows goes through t() and exists in every locale', () => {
  // a literal key ending in a dot is a prefix (the kind or status is appended); those are expanded below
  const keys = new Set<string>([...skin.matchAll(/\bt\('(chat\.[\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
  for (const status of ['running', 'ok', 'error']) keys.add(`chat.skin.tool.${status}`);
  for (const kind of ['connecting', 'waiting', 'empty', 'error']) for (const part of ['title', 'text']) keys.add(`chat.skin.state.${kind}.${part}`);
  for (const kind of ['prompt', 'stalled']) keys.add(`chat.skin.alert.${kind}.title`);
  for (const kind of ['permission', 'trust', 'select', 'question', 'model', 'other']) keys.add(`chat.skin.prompt.${kind}`);
  for (const f of ['inherit', 'sans', 'serif', 'mono', 'inter']) keys.add(`chat.font.${f}`);
  assert.ok(keys.size > 40, `found ${keys.size} keys`);
  for (const l of Object.keys(loc)) for (const k of keys) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  // control: a key that is not there is reported
  assert.equal(typeof loc.en['chat.skin.nothing.here'], 'undefined');
});

test('no coral in a status role: the cards and marks take their hue from --st-*, never --accent', () => {
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string): string => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`).exec(sk)?.[0] ?? '';
  for (const sel of ['.cs-alert', '.cs-alert.prompt', '.ct-spin', '.cw-dots i', '.chat-tool.error .ct-kind']) {
    const r = rule(sel);
    assert.ok(r, `${sel} exists`);
    assert.doesNotMatch(r, /--accent/, `${sel} must not use coral`);
  }
  assert.match(rule('.cs-alert.prompt'), /--st-input/);
  assert.match(rule('.cs-alert'), /--st-warn/);
  assert.match(rule('.ct-spin'), /--st-busy/);
  // control
  assert.match('.cs-alert { --sc: var(--accent); }', /--accent/);
});

test('the chat view names the session that is talking, never a hardcoded "Claude"', () => {
  /* The operator runs several named sessions side by side and wants to see which one answers:
     the placeholder, the working line, the attention cards and the connecting card all carry the
     pane's name. "Claude" survives only as the fallback for an unnamed pane. */
  const keys = ['chat.claude', 'chat.placeholder', 'chat.skin.working', 'chat.skin.stalled',
    'chat.skin.prompt.permission', 'chat.skin.prompt.trust', 'chat.skin.prompt.select',
    'chat.skin.prompt.question', 'chat.skin.prompt.other', 'chat.skin.state.connecting.title'];
  for (const lang of ['en', 'es', 'pt-br']) {
    const loc = JSON.parse(fs.readFileSync(`src/i18n/locales/${lang}.json`, 'utf8'));
    for (const k of keys) {
      assert.match(loc[k], /\{name\}/, `${lang} ${k} must name the session`);
      assert.doesNotMatch(loc[k], /Claude/, `${lang} ${k} still says Claude`);
    }
  }
  const src = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(src, /function chatSkinWho\(p\)/, 'one helper decides the name');
  assert.match(src, /t\('chat\.placeholder', \{ name: (chatSkinWho\(p\)|who) \}\)/, 'the composer placeholder carries the name');
  assert.match(src, /t\('chat\.skin\.prompt\.' \+ cs\.promptKind, \{ name \}\)/, 'the attention card carries the name');
});

// ── fewer colours, denser rows: coral is the send button and nothing else in the chat ─────────

/** The chat skin's rules with comments removed, as [selector, declarations] pairs (@media / @container wrappers flattened). */
function skinRules(sheet: string): Array<[string, string]> {
  const sk = sheet.slice(sheet.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...sk.matchAll(/([^{}@;]+?)\s*\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]] as [string, string]);
}
/** Selectors in the skin block whose declarations reach for the coral (--accent*, but not --chat-on-accent, the white glyph on it). */
const coralUsers = (sheet: string): string[] => skinRules(sheet)
  .filter(([, decl]) => /var\(--accent[a-z-]*\)/.test(decl.replace(/--chat-on-accent/g, '')))
  .map(([sel]) => sel);
/** The chat tokens minted in :root / body.light must not be coral either. */
const coralTokens = (sheet: string): string[] => [...sheet.matchAll(/^\s*(--chat-[a-z-]+):([^;]*);/gm)]
  .filter(([, name, value]) => name !== '--chat-on-accent' && /--accent/.test(value)).map((m) => m[1]);

test('coral is the send button and nothing else in the chat: focus, links, rings and tokens are neutral or cool', () => {
  // the tab's Terminal/Chat icon lives on the TAB (app chrome, "identity"), not in the conversation
  const inView = (sheet: string): string[] => coralUsers(sheet).filter((s) => !s.startsWith('.tab .tview'));
  assert.deepEqual([...new Set(inView(css))].sort(), ['.cc-send', '.cc-send:hover:not(:disabled)'], 'only the send button may use the accent');
  assert.deepEqual(coralTokens(css), [], 'no chat token is built from the accent');
  // the composer card keeps a neutral focus (a border and a faint halo), and links use their own cool token
  const rule = (sel: string): string => skinRules(css).find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cc-box:focus-within'), /var\(--chat-focus-line\)[\s\S]*var\(--chat-focus-soft\)/);
  assert.match(rule('.chat-md a'), /color: var\(--chat-link\)/);
  assert.match(css, /:root \{[^}]*--chat-link: var\(--st-input-ink\)/);
  // controls: a focus ring or a link painted coral again is caught by the same check
  assert.equal(inView(css.replace('.cc-box:focus-within { border-color: var(--chat-focus-line);', '.cc-box:focus-within { border-color: var(--accent);')).includes('.cc-box:focus-within'), true);
  assert.equal(inView(css.replace('.chat-md a { color: var(--chat-link);', '.chat-md a { color: var(--accent-ink);')).includes('.chat-md a'), true);
  assert.deepEqual(coralTokens(css.replace('--chat-focus-soft: color-mix(in srgb, var(--ink) 7%', '--chat-focus-soft: color-mix(in srgb, var(--accent) 7%')), ['--chat-focus-soft']);
});

test('tool rows are dense: a short row, small type for the name and the argument, still a comfortable hit target', () => {
  const head = skinRules(css).find(([s]) => s === '.ct-head')?.[1] ?? '';
  const minH = Number(/min-height:\s*(\d+)px/.exec(head)?.[1]);
  const padY = Number(/padding:\s*(\d+)px/.exec(head)?.[1]);
  assert.ok(minH >= 26 && minH <= 30, `a row is 26-30 px tall (got ${minH})`);
  assert.ok(padY <= 4, `vertical padding is at most 4 px (got ${padY})`);
  const px = (sel: string): number => Number(/font-size:\s*([\d.]+)px/.exec(skinRules(css).find(([s]) => s === sel)?.[1] ?? '')?.[1]);
  assert.ok(px('.ct-name') >= 11.5 && px('.ct-name') <= 12.5, 'the tool name is 12 px');
  assert.ok(px('.ct-arg') >= 10.5 && px('.ct-arg') <= 11.5, 'the argument is 11 px (mono) — smaller than the name, never below 10.5');
  // control: the pre-density row (36 px, 6 px padding) fails the same bounds
  assert.equal(36 >= 26 && 36 <= 30, false);
});

// ── the status bar under the composer ───────────────────────────────────────

/** chatPaintUsage, chatApplyStatus and the helpers they need, evaluated against a hand-made stand-in for the DOM: the real
 *  code, run for real, with `t` echoing its key so a test can see which sentence was chosen. */
function loadUsage(): { paint: (cs: unknown) => void; apply: (cs: unknown, s: unknown) => void; left: (sec: number, now: number) => string; when: (sec: number, now: number) => string; label: (id: string) => string; fake: () => FakeEl } {
  const s = skin;
  const from = s.indexOf('const CHAT_METERS = [');
  const to = s.indexOf('function chatSkinTip(');
  assert.ok(from > 0 && to > from, 'the usage block was found');
  const src = s.slice(from, to);
  const fake = (): FakeEl => {
    const e: FakeEl = {
      className: '', textContent: '', title: '', hidden: false, attrs: {}, props: {}, kids: [], q: {},
      classList: {
        toggle(c: string, on: boolean) { const set = new Set(e.className.split(/\s+/).filter(Boolean)); if (on) set.add(c); else set.delete(c); e.className = [...set].join(' '); },
      },
      style: { setProperty(k: string, v: string) { e.props[k] = v; } },
      setAttribute(k: string, v: string) { e.attrs[k] = v; },
      replaceChildren(...n: FakeEl[]) { e.kids = n; },
    };
    return e;
  };
  type Api = { paint: (cs: unknown) => void; apply: (cs: unknown, s: unknown) => void; left: (sec: number, now: number) => string; when: (sec: number, now: number) => string; label: (id: string) => string };
  const make = new Function('t', 'el', 'window', `${src}\nreturn { paint: chatPaintUsage, apply: chatApplyStatus, left: chatResetLeft, when: chatResetWhen, label: chatModelLabel };`) as
    (t: (k: string, v?: Record<string, unknown>) => string, el: (tag: string, cls?: string, text?: string) => FakeEl, w: unknown) => Api;
  const t = (k: string, v?: Record<string, unknown>): string => (v ? `${k}${JSON.stringify(v)}` : k);
  const el = (_tag: string, cls = '', text = ''): FakeEl => { const n = fake(); n.className = cls; n.textContent = text; return n; };
  return { ...make(t, el, { i18n: { getLocale: () => 'en' } }), fake };
}
interface FakeEl {
  className: string; textContent: string; title: string; hidden: boolean; attrs: Record<string, string>; props: Record<string, string>; kids: FakeEl[]; q: Record<string, FakeEl>;
  classList: { toggle(c: string, on: boolean): void }; style: { setProperty(k: string, v: string): void };
  setAttribute(k: string, v: string): void; replaceChildren(...n: FakeEl[]): void;
}
interface Part { seg: FakeEl; v: FakeEl; of: FakeEl; tipH: FakeEl; tipV: FakeEl; tipD: FakeEl }
/** A `cs` with the three meters, the model and the effort, shaped as chatSkinBuild makes them (`barParts`). */
function usageCs(u: ReturnType<typeof loadUsage>, status: Record<string, unknown>, extra: Record<string, unknown> = {}): { cs: Record<string, unknown>; parts: Record<string, Part> } {
  const parts: Record<string, Part> = {};
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct', 'model', 'effort']) parts[k] = { seg: u.fake(), v: u.fake(), of: u.fake(), tipH: u.fake(), tipV: u.fake(), tipD: u.fake() };
  return { cs: { status, barParts: parts, ...extra }, parts };
}
const tipOf = (p: Part): { h: string; v: string; d: string[] } => ({ h: p.tipH.textContent, v: p.tipV.textContent, d: p.tipD.kids.map((k) => k.textContent) });

test('status bar, run for real: a missing reading is a dash and an empty ring; a present one is the percentage, amber from 60 and red from 85', () => {
  const u = loadUsage();
  const none = usageCs(u, {});
  u.paint(none.cs);
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct']) {
    assert.equal(none.parts[k].v.textContent, '—', `${k}: a dash, never 0`);
    assert.equal(none.parts[k].seg.props['--p'], '0');
    assert.match(none.parts[k].seg.className, /\bnone\b/);
    assert.equal(tipOf(none.parts[k]).v, 'chat.usage.none');
    assert.deepEqual(tipOf(none.parts[k]).d, [], 'no invented detail');
  }
  const band = (pct: number): string => { const x = usageCs(u, { fiveHourPct: pct }); u.paint(x.cs); return x.parts.fiveHourPct.seg.className; };
  assert.doesNotMatch(band(42), /\b(warn|hot|none)\b/, 'neutral at 42');
  assert.doesNotMatch(band(59), /\b(warn|hot)\b/, 'neutral just under 60');
  assert.match(band(60), /\bwarn\b/, 'amber from 60');
  assert.match(band(72), /\bwarn\b/);
  assert.match(band(84), /\bwarn\b/);
  assert.doesNotMatch(band(84), /\bhot\b/);
  assert.match(band(85), /\bhot\b/, 'red from 85');
  assert.doesNotMatch(band(85), /\bwarn\b/, 'one colour at a time');
  assert.match(band(100), /\bhot\b/);
  const some = usageCs(u, { fiveHourPct: 42, sevenDayPct: 71, contextPct: 93 });
  u.paint(some.cs);
  assert.equal(some.parts.fiveHourPct.v.textContent, '42%');
  assert.equal(some.parts.fiveHourPct.seg.props['--p'], '42');
  assert.match(some.parts.fiveHourPct.seg.attrs['aria-label'], /42%/, 'the value is in the accessible name');
  assert.equal(tipOf(some.parts.sevenDayPct).v, 'chat.usage.tip.used{"pct":71}');
  // an honest zero is a zero (a real reading), unlike an absent one
  const zero = usageCs(u, { fiveHourPct: 0 });
  u.paint(zero.cs);
  assert.equal(zero.parts.fiveHourPct.v.textContent, '0%');
  assert.doesNotMatch(zero.parts.fiveHourPct.seg.className, /\bnone\b/);
  // repainting keeps the classes the painter does not own (the hover card is "tip-open")
  const open = usageCs(u, { fiveHourPct: 70 });
  open.parts.fiveHourPct.seg.className = 'cb-m tip-open';
  u.paint(open.cs);
  assert.match(open.parts.fiveHourPct.seg.className, /\btip-open\b/);
});

test('status bar, run for real: resets appear only when the payload carried them, and a reset already behind us marks the reading stale', () => {
  const u = loadUsage();
  const now = Date.now();
  const sec = (ms: number): number => Math.floor((now + ms) / 1000);
  const without = usageCs(u, { fiveHourPct: 42, sevenDayPct: 10 });
  u.paint(without.cs);
  assert.deepEqual(tipOf(without.parts.fiveHourPct).d, [], 'no reset in the payload → no reset line (nothing is derived from "5 hours")');
  assert.deepEqual(tipOf(without.parts.sevenDayPct).d, []);
  const withR = usageCs(u, { fiveHourPct: 42, sevenDayPct: 10, fiveHourResetsAt: sec(2 * 3600e3 + 10 * 60e3), sevenDayResetsAt: sec(50 * 3600e3) });
  u.paint(withR.cs);
  assert.match(tipOf(withR.parts.fiveHourPct).d[0], /^chat\.usage\.tip\.resets\{/);
  assert.match(tipOf(withR.parts.fiveHourPct).d[0], /"left":"chat\.usage\.unit\.h\{\\"n\\":2\}[^"]*chat\.usage\.unit\.m\{\\"n\\":(9|10)\}"/, 'in 2 h 10 min');
  assert.match(tipOf(withR.parts.sevenDayPct).d[0], /"left":"chat\.usage\.unit\.d\{\\"n\\":2\} chat\.usage\.unit\.h\{\\"n\\":2\}"/, 'in 2 d 2 h (no minutes once days are shown)');
  const stale = usageCs(u, { fiveHourPct: 90, fiveHourResetsAt: sec(-60e3) });
  u.paint(stale.cs);
  assert.deepEqual(tipOf(stale.parts.fiveHourPct).d, ['chat.usage.tip.stale']);
  assert.match(stale.parts.fiveHourPct.seg.className, /\bstale\b/);
  assert.doesNotMatch(withR.parts.fiveHourPct.seg.className, /\bstale\b/);
  // control: a reset line for a meter that has no reset field (context) never appears
  assert.deepEqual(tipOf(withR.parts.contextPct).d, []);
});

test('status bar, run for real: the context is this pane\'s own tokens over the window — used / limit with a bar — and says so only when they agree', () => {
  const u = loadUsage();
  const ok = usageCs(u, { contextPct: 5, contextWindow: 200000 }, { ctxTokens: 84000 });
  u.paint(ok.cs);
  assert.equal(ok.parts.contextPct.v.textContent, '84k');
  assert.equal(ok.parts.contextPct.of.textContent, '/ 200k', 'used / limit');
  assert.equal(ok.parts.contextPct.seg.props['--p'], '42', 'own tokens / window, not the global payload\'s percentage');
  assert.match(tipOf(ok.parts.contextPct).d[0], /^chat\.usage\.tip\.ctxOf\{"used":"84,000","total":"200,000"\}$/);
  assert.match(ok.parts.contextPct.seg.attrs['aria-label'], /84k \/ 200k \(42%\)/);
  // tokens above the payload's window: the payload describes another session's model — tokens only, no percentage, no limit
  const clash = usageCs(u, { contextPct: 5, contextWindow: 200000 }, { ctxTokens: 300000 });
  u.paint(clash.cs);
  assert.equal(clash.parts.contextPct.v.textContent, '300k');
  assert.equal(clash.parts.contextPct.of.textContent, '');
  assert.equal(clash.parts.contextPct.seg.props['--p'], '0');
  assert.match(tipOf(clash.parts.contextPct).d[0], /^chat\.usage\.tip\.ctxUsed\{/);
  // no window size known: the payload's own percentage still drives the bar, the tokens are what is shown, and there is no limit to show
  const nowin = usageCs(u, { contextPct: 31 }, { ctxTokens: 62000 });
  u.paint(nowin.cs);
  assert.equal(nowin.parts.contextPct.v.textContent, '62k');
  assert.equal(nowin.parts.contextPct.of.textContent, '');
  assert.equal(nowin.parts.contextPct.seg.props['--p'], '31');
  // no tokens at all, only a percentage that is this tab's: the percentage; nothing: a dash
  const pctOnly = usageCs(u, { contextPct: 38 });
  u.paint(pctOnly.cs);
  assert.equal(pctOnly.parts.contextPct.v.textContent, '38%');
  // colour follows the percentage of the WINDOW, not the token count: 182k of 200k is red
  const hot = usageCs(u, { contextWindow: 200000 }, { ctxTokens: 182000 });
  u.paint(hot.cs);
  assert.match(hot.parts.contextPct.seg.className, /\bhot\b/);
});

test('status bar, run for real: the payload is global, so model, effort, context and window are only taken when it is THIS tab\'s (sessionMatch === true)', () => {
  const u = loadUsage();
  const payload = { fiveHourPct: 42, sevenDayPct: 55, fiveHourResetsAt: 2e9, sevenDayResetsAt: 2e9, model: 'claude-opus-5-5', effort: 'max', contextPct: 97, contextWindow: 1000000 };
  const foreign = usageCs(u, {});
  u.apply(foreign.cs, { ...payload, sessionMatch: false });
  assert.deepEqual(foreign.cs.status, { fiveHourPct: 42, sevenDayPct: 55, fiveHourResetsAt: 2e9, sevenDayResetsAt: 2e9 }, 'only the account-wide windows and their resets');
  assert.equal(foreign.parts.effort.seg.hidden, true, 'no effort has ever been reported by this tab\'s own payload: the segment is not there (not a dash)');
  // anything but a literal true is a no: a missing flag (an older main) and truthy look-alikes
  for (const flag of [undefined, null, 'true', 1, {}]) {
    const x = usageCs(u, {});
    u.apply(x.cs, { ...payload, sessionMatch: flag });
    assert.equal((x.cs.status as Record<string, unknown>).effort, undefined, `sessionMatch ${JSON.stringify(flag)} must not write the effort`);
    assert.equal((x.cs.status as Record<string, unknown>).model, undefined);
  }
  const mine = usageCs(u, {});
  u.apply(mine.cs, { ...payload, sessionMatch: true });
  assert.equal((mine.cs.status as Record<string, unknown>).effort, 'max');
  assert.equal((mine.cs.status as Record<string, unknown>).contextWindow, 1000000);
  assert.equal(mine.parts.effort.seg.hidden, false);
  assert.equal(mine.parts.effort.v.textContent, 'chat.bar.effort.max');
  // an effort this build does not know is shown as it came, never swallowed
  const odd = usageCs(u, {});
  u.apply(odd.cs, { effort: 'ultra', sessionMatch: true });
  assert.equal(odd.parts.effort.v.textContent, 'ultra');
  // a later payload that is not this tab's changes nothing it already knew
  u.apply(mine.cs, { effort: 'low', model: 'claude-haiku-4-5', sessionMatch: false });
  assert.equal((mine.cs.status as Record<string, unknown>).effort, 'max');
  // the model: this tab's own transcript wins, then a matching payload, and never a foreign one
  const tr = usageCs(u, {}, { model: 'claude-sonnet-5-5' });
  u.apply(tr.cs, { model: 'claude-opus-5-5', sessionMatch: false });
  assert.equal(tr.parts.model.v.textContent, 'Sonnet 5.5');
  const fromPayload = usageCs(u, {});
  u.apply(fromPayload.cs, { model: 'claude-opus-5-5', sessionMatch: true });
  assert.equal(fromPayload.parts.model.v.textContent, 'Opus 5.5');
  const nobody = usageCs(u, {});
  u.paint(nobody.cs);
  assert.equal(nobody.parts.model.v.textContent, '—');
});

test('status bar: model names read as a person says them, and an id nobody taught us is shown as it came', () => {
  const u = loadUsage();
  assert.equal(u.label('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(u.label('claude-opus-5'), 'Opus 5');
  assert.equal(u.label('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(u.label('claude-opus-4-1[1m]'), 'Opus 4.1');
  assert.equal(u.label('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(u.label('some-other-model'), 'some-other-model');
});

test('status bar: the reset formatters give the two largest units, and a clock time today or weekday + time otherwise', () => {
  const u = loadUsage();
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const at = (ms: number): number => Math.floor((now + ms) / 1000);
  assert.equal(u.left(at(14 * 60e3), now), 'chat.usage.unit.m{"n":14}');
  assert.equal(u.left(at(60 * 60e3), now), 'chat.usage.unit.h{"n":1}', 'a whole hour has no "0 min"');
  assert.equal(u.left(at(26 * 3600e3), now), 'chat.usage.unit.d{"n":1} chat.usage.unit.h{"n":2}');
  assert.equal(u.left(at(-5000), now), 'chat.usage.unit.m{"n":0}', 'never negative');
  assert.match(u.when(at(3 * 3600e3), now), /^\d{1,2}:\d{2}/, 'later today: just the time');
  assert.match(u.when(at(30 * 3600e3), now), /^[A-Za-z]{3}\.? \d{1,2}:\d{2}/, 'another day: weekday and time');
});

test('status bar: the thresholds are 60 and 85, named once, and the painter reads those names (no stray 70 or 90)', () => {
  assert.match(skin, /const CHAT_WARN_PCT = 60, CHAT_HOT_PCT = 85;/);
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(paint, /pct >= CHAT_WARN_PCT && pct < CHAT_HOT_PCT/);
  assert.match(paint, /pct >= CHAT_HOT_PCT/);
  assert.doesNotMatch(paint, /\b(70|90)\b/);
  assert.match(paint, /const has = typeof pct === 'number' && Number\.isFinite\(pct\)/);
  assert.match(paint, /setProperty\('--p', has \? /, 'the ring and the bar are empty without a reading');
  assert.match(paint, /\.\.\.lines\]\.join\(' — '\)/, 'the accessible name carries the value and the detail');
});

guarded('the status payload is asked for with THIS tab\'s session id, and per-session fields are written only when main says it matches',
  (src) => {
    const s = slice(src);
    const apply = fnBody(s, 'chatApplyStatus');
    const refresh = fnBody(s, 'chatSkinRefreshStatus');
    return /gs\.chatStatus\(cs\.pane\.sessionId\)/.test(refresh)
      && /const CHAT_STATUS_OWN = \['contextPct', 'model', 'effort', 'contextWindow'\];/.test(s)
      && /CHAT_STATUS_OWN\.includes\(k\) && s\.sessionMatch !== true\) continue;/.test(apply)
      && /s\[k\] === undefined \|\| s\[k\] === null \|\| s\[k\] === ''\) continue;/.test(apply);
  },
  (src) => src.replace('if (CHAT_STATUS_OWN.includes(k) && s.sessionMatch !== true) continue;', ''));

guarded('the status bar is built UNDER the card, and the card holds only the text and send/stop (no chips, no usage row)',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    return /meta\.appendChild\(bar\)/.test(b) && /compose\.append\(jumpBtn, wrap, meta\)/.test(b)
      && /root\.append\(log, alertEl, compose\)/.test(b)   // log, notice, compose block: nothing above the log
      && /box\.append\(input, ccRow, dropEl\)/.test(b) && /ccRow\.append\(stopBtn, sendBtn\)/.test(b)
      && !/cc-chip|chat-usage|usageEl|usageVals/.test(slice(src))
      && b.indexOf('wrap.append(slashPop, box)') > 0 && b.indexOf('wrap.append(slashPop, box)') < b.indexOf('compose.append(')
      && !/cc-chip|chat-usage/.test(css);
  },
  // the bar moved out of the compose block (into the pane itself): the card and the strip are no longer one object
  (src) => src.replace('meta.appendChild(bar);', 'root.append(bar);'));

// ── the pane has no header ──────────────────────────────────────────────────

/** Everything the old header was made of, as it could be named in the source or the stylesheet. */
const HEADER_TRACES = /cs-head|cs-switch|cs-sw\b|cs-gear|cs-menu|cs-fill|csm-|swTerm|swChat|chatSkinMenu|chatSkinOpt\b|chatSkinCheck|menuOpen|\bfontList\b|\bsizeList\b|textSize/;
guarded('the pane has no header: no Terminal | Chat switch, no Aa button, no font menu — the log is the first thing in the overlay',
  (src) => {
    const s = slice(src);
    const b = fnBody(s, 'chatSkinBuild');
    return !HEADER_TRACES.test(s) && /root\.append\(log, alertEl, compose\)/.test(b) && !/\bhead\b/.test(b.replace(/\/\*[\s\S]*?\*\//g, ''))
      // the reading settings are not set from the conversation any more: only applied there
      && !/setSetting\('chatFont/.test(s) && /function chatApplyPrefs\(\)/.test(s) && /function chatReadPrefs\(c\)/.test(s);
  },
  (src) => src.replace('root.append(log, alertEl, compose);', "const head = el('div', 'cs-head');\n  root.append(head, log, alertEl, compose);"));

test('the stylesheet carries no rule of the old header, and the stylesheet check catches one that comes back', () => {
  assert.doesNotMatch(css, HEADER_TRACES);
  assert.match(css + '\n.cs-head { padding: 9px 14px; }', HEADER_TRACES, 'control: a header rule would be caught');
  assert.match(css + '\n.cs-gear { width: 30px; }', HEADER_TRACES, 'control: so would the Aa button');
  // no place left for the strip: the first child of the overlay is the log, which fills it
  assert.match(skinRules(css).find(([sel]) => sel === '.chat-log')?.[1] ?? '', /flex: 1/);
});

guarded('the tab icon is the way to switch: a labelled, pressed-aware button whose words say which view it leads to',
  (src) => {
    const s = slice(src);
    const paint = fnBody(s, 'chatSkinPaintToggle');
    const mount = fnBody(s, 'chatSkinMountToggle');
    return /classList\.toggle\('on', on\)/.test(paint) && /setAttribute\('aria-pressed', String\(on\)\)/.test(paint)
      && /t\(on \? 'chat\.skin\.toTerminal' : 'chat\.skin\.toChat'\)/.test(paint)
      && /\.title = label/.test(paint) && /setAttribute\('aria-label', label\)/.test(paint)
      && /setAttribute\('role', 'button'\)/.test(mount) && /addEventListener\('click', go\)/.test(mount);
  },
  (src) => src.replace("p.viewBtn.setAttribute('aria-label', label);", ''));

test('the tab icon looks clickable in both themes: a hit area, a pointer, a hover fill and a distinct active chip, none of it a hex literal', () => {
  const rules = [...css.matchAll(/^(\.tab \.tview[^{]*)\{([^}]*)\}/gm)].map((m) => [m[1].trim(), m[2]] as const);
  const rule = (sel: string): string => rules.find(([x]) => x === sel)?.[1] ?? '';
  const base = rule('.tab .tview');
  assert.match(base, /cursor: pointer/);
  const px = (re: RegExp): number => Number(re.exec(base)?.[1] ?? 0);
  assert.ok(px(/width: (\d+)px/) >= 20 && px(/height: (\d+)px/) >= 20, 'a comfortable hit area, not the 12 px glyph');
  assert.match(rule('.tab .tview:hover'), /background: var\(--chat-row-hover\)/);
  assert.match(rule('.tab .tview:focus-visible'), /outline: 2px solid var\(--chat-focus\)/);
  const on = rule('.tab .tview.on');
  assert.match(on, /background: color-mix/);
  assert.match(on, /box-shadow: inset 0 0 0 1px/, 'the active state is a shape (a ring), not only a colour');
  assert.notEqual(on.replace(/\s+/g, ''), base.replace(/\s+/g, ''));
  assert.doesNotMatch(rules.map((r) => r[1]).join('\n'), /#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.tab \.tview \{ transition: none; \} \}/);
});

guarded('every meter answers hover AND keyboard focus with its detail card, aria-labelled, and the card is not read twice',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const tip = fnBody(slice(src), 'chatSkinTip');
    return /seg\.tabIndex = 0/.test(b) && /seg\.addEventListener\('pointerenter', \(\) => chatSkinTip\(seg, true\)\)/.test(b)
      && /seg\.addEventListener\('focus', \(\) => chatSkinTip\(seg, true\)\)/.test(b) && /seg\.addEventListener\('blur', \(\) => chatSkinTip\(seg, false\)\)/.test(b)
      && /tip\.setAttribute\('aria-hidden', 'true'\)/.test(b) && /seg\.setAttribute\('role', 'img'\)/.test(b)
      && /classList\.toggle\('tip-open', on\)/.test(tip)
      && /bar\.setAttribute\('aria-label', t\('chat\.bar\.label', \{ name: chatSkinWho\(p\) \}\)\)/.test(b)   // the session's name, from the one function that knows it
      && !/seg\.title\s*=/.test(fnBody(slice(src), 'chatPaintUsage').split('/* Model:')[0]);   // no native title on a meter: the card is ours
  },
  (src) => src.replace("seg.addEventListener('focus', () => chatSkinTip(seg, true));", ''));

guarded('the model in the bar sends /model through the same chokepoint as a typed message — and never while a turn runs or a dialog is open',
  (src) => {
    const s = slice(src);
    const menu = fnBody(s, 'chatSkinModelMenu');
    const submit = fnBody(s, 'chatSkinSubmit');
    return /chatSkinSubmit\(id, p, '\/model'\)/.test(menu) && /cs\.promptKind \|\| chatSkinWorking\(p\)/.test(menu) && !/ptyWrite|ptyRun/.test(menu)
      && /submitToPty\(id, text\)/.test(submit) && /chatSkinSubmit\(id, p, text\)/.test(fnBody(s, 'chatSkinSendNow'))
      && /modelSeg\.addEventListener\('click', \(\) => chatSkinModelMenu\(id, p\)\)/.test(fnBody(s, 'chatSkinBuild'))
      && /cs\.modelSeg\.disabled = working \|\| !!cs\.promptKind \|\| !!p\.exited/.test(fnBody(s, 'chatSkinControls'));
  },
  (src) => src.replace("chatSkinSubmit(id, p, '/model');", "window.glassShell.ptyWrite(id, '/model\\r');"));

test('the bar has ONE look, the strip: no switch, no stored preference, no other variant left behind', () => {
  // The operator compared three looks and chose the strip; the other two and everything that switched between them are gone.
  // A check on the CSS and the source together: a stray selector or a leftover switch would revive a look nobody can reach.
  const gone = (src: string): string[] => [
    ...(/CHAT_BAR_STYLES|CHAT_BAR_DEFAULT|chatStatusBarStyle|chatSkinSetBarStyle|chatSkinApplyBarStyle/.exec(src) ?? []),
    ...(/\bbar-(minimal|pills|strip)\b/.exec(src) ?? []),
    ...(/csRing|\bcu-ring\b|\.r-track\b|\.r-val\b|'r-track'|'r-val'/.exec(src) ?? []),
  ];
  assert.deepEqual(gone(app), [], 'no switch, no look class and no ring in the renderer script');
  assert.deepEqual(gone(css), [], 'no look class and no ring in the stylesheet');
  assert.doesNotMatch(read('src/test/fixtures/chat-shot.json'), /BarStyle|barShot\(ctx, '/, 'the shot fixture does not switch looks');
  // the strip is the bar's own rules, not a class someone has to remember to set
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([x]) => x === sel)?.[1] ?? '';
  assert.match(rule('.chat-bar'), /border-radius: 0 0 22px 22px/, 'the bar is the strip, always');
  assert.match(rule('.chat-bar'), /clip-path: inset\(0 -48px -48px -48px\)/);
  assert.match(rule('.cc-meta'), /margin-top: 0/, 'flush under the card');
  assert.match(rule('.cc-box'), /border-radius: 22px 22px 0 0/, 'the card gives its bottom corners to the strip');
  assert.match(rule('.cb-m:hover'), /background-color:/, 'a segment hover keeps its divider (the colour alone, never the shorthand)');
  assert.match(rule('.cb-meter'), /display: block/, 'the bar is always shown: it is the meter');
  // no markup left over from another look: the meter is a bar and nothing else
  assert.doesNotMatch(fnBody(skin, 'chatSkinBuild'), /createElementNS|csRing/);
  // negative control: a leftover of any removed look trips the same check
  assert.ok(gone(app + '\nconst CHAT_BAR_STYLES = [];').length > 0);
  assert.ok(gone(css + '\n.bar-pills .cb-m { }').length > 0);
  assert.ok(gone(css + '\n.cu-ring { }').length > 0);
});

test('the bar\'s CSS: thresholds through --chat-* tokens, the detail card on the bar\'s own line, hint only with focus, hidden under a dialog strip', () => {
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cb-m.warn .cb-meter i'), /var\(--chat-meter-warn\)/);
  assert.match(rule('.cb-m.hot .cb-meter i'), /var\(--chat-meter-hot\)/);
  assert.match(rule('.cb-meter i'), /width: calc\(var\(--p, 0\) \* 1%\)/);
  assert.match(rule('.cb-m.warn .cb-v'), /var\(--chat-warn-ink\)/);
  assert.match(rule('.cb-m.hot .cb-v'), /var\(--chat-hot-ink\)/);
  // the amber and the red are the house's status hues, and never the coral
  const dark = css.slice(0, css.indexOf('body.light {'));
  assert.match(dark, /--chat-meter-warn: var\(--st-warn\);/);
  assert.match(dark, /--chat-meter-hot: var\(--st-error\);/);
  assert.deepEqual(coralTokens(css), []);
  // the detail card lies over the bar's own line: it is positioned against the bar, fills it, and nothing in its rule lifts it above
  const tip = rule('.cb-tip');
  assert.match(tip, /position: absolute/);
  assert.match(tip, /inset: 0/);
  assert.doesNotMatch(tip, /\bbottom:|\btop:\s*-|calc\(100%/, 'a card that opened upward would cover the text being typed');
  assert.match(rule('.chat-bar'), /position: relative/, 'the bar is what the card is placed against');
  assert.match(rule('.cb-m'), /flex: 0 0 auto/);
  assert.doesNotMatch(rule('.cb-m'), /position:/, 'a meter is not the containing block of its card (the bar is)');
  assert.match(rule('.cb-m.tip-open .cb-tip'), /opacity: 1/);
  const strip = rules.find(([s]) => s.startsWith('.pane.cs-strip > .chatskin .chat-bar'));
  assert.ok(strip && /\.cc-meta/.test(strip[0]) && /\.chat-compose/.test(strip[0]) && /display: none/.test(strip[1]), 'the strip rule hides the bar (and the whole compose block) for a live dialog');
  assert.match(rule('.cb-hint'), /opacity: 0/, 'the keys hint is invisible until the box has focus');
  assert.match(rule('.cc-wrap:focus-within + .cc-meta .cb-hint'), /opacity: 1/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.cb-m, \.cb-meter i, \.cb-tip, \.cb-hint, \.chat-bar \{ transition: none; \}/);
  // control: the old floating card (up and away from its meter) would trip the same check
  assert.match(rule('.cb-tip').replace('inset: 0;', 'bottom: calc(100% + 8px);'), /calc\(100%/);
});

test('a narrow pane gives up the labels first, then the "of 200k", then the effort, and only then the numbers — the bars never', () => {
  const widths = (sel: RegExp): number[] => [...css.matchAll(/@container \(max-width: (\d+)px\) \{([^@\n]*)\}/g)].filter((m) => sel.test(m[2])).map((m) => Number(m[1]));
  const labels = Math.max(...widths(/\.cb-k \{ display: none/));
  const of = Math.max(...widths(/\.cb-of \{ display: none/));
  const effort = Math.max(...widths(/\.cb-effort \{ display: none/));
  const values = Math.max(...widths(/\.cb-m \.cb-v \{ display: none/));
  assert.ok(labels > 0 && of > 0 && effort > 0 && values > 0, `all the steps exist (${[labels, of, effort, values]})`);
  assert.ok(labels > of && of >= effort - 20 && effort > values, `order of loss by width: labels ${labels} > of ${of} > effort ${effort} > numbers ${values}`);
  // nothing ever hides the bar itself
  assert.doesNotMatch(css, /@container[^{]*\{[^}]*\.cb-meter(?! i)[^}]*display: none/);
  // the bar is its own size container, so the steps follow the bar and not the window
  assert.match(skinRules(css).find(([s]) => s === '.cc-meta')?.[1] ?? '', /container-type: inline-size/);
});

test('the status bar\'s sentences exist in every locale (the ones built at run time included), with the same placeholders', () => {
  const keys = ['chat.hintShort', 'chat.bar.hintTiny', 'chat.bar.label', 'chat.bar.modelTip', 'chat.bar.modelPick', 'chat.bar.modelAria', 'chat.usage.tip.fiveHour', 'chat.usage.tip.sevenDay', 'chat.usage.tip.context',
    'chat.usage.tip.used', 'chat.usage.tip.resets', 'chat.usage.tip.stale', 'chat.usage.tip.ctxOf', 'chat.usage.tip.ctxUsed', 'chat.usage.unit.d', 'chat.usage.unit.h', 'chat.usage.unit.m', 'chat.usage.none',
    'chat.usage.fiveHour', 'chat.usage.sevenDay', 'chat.usage.context', 'chat.usage.effort'];
  const efforts = /const CHAT_EFFORTS = \[([^\]]+)\]/.exec(skin)?.[1].match(/'(\w+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const e of efforts) keys.push('chat.bar.effort.' + e);
  for (const k of keys) for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  const holes = (s: string): string => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keys) for (const l of ['es', 'pt-br']) assert.equal(holes(loc[l][k]), holes(loc.en[k]), `${l} ${k}`);
  assert.equal(holes(loc.en['chat.usage.tip.resets']), '{left},{when}');
  assert.equal(holes(loc.en['chat.bar.label']), '{name}', 'the bar is named after the session, like every other sentence about it');
  assert.equal(holes(loc.en['chat.bar.modelAria']), '{model}');
  // every key the painter builds at run time is in the list above
  assert.deepEqual([...skin.matchAll(/\['(?:fiveHourPct|sevenDayPct|contextPct)', 'chat\.usage\.\w+', '(chat\.usage\.tip\.\w+)'\]/g)].map((m) => m[1]), ['chat.usage.tip.fiveHour', 'chat.usage.tip.sevenDay', 'chat.usage.tip.context']);
  assert.match(skin, /t\('chat\.bar\.effort\.' \+ effort\)/);
  // the old row is gone with its sentence
  assert.equal(typeof loc.en['chat.usage.contextTokens'], 'undefined');
});

test('chat-shot fixture: the strip × light/dark × wide/narrow/card open/hot values, plus a payload that is not this tab\'s', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  const js = (n: string): string => String([byName(n)?.js].flat().join('\n'));
  for (const th of ['light', 'dark']) {
    for (const suffix of ['', '-narrow', '-tip', '-hot', '-hot-tip']) {
      const n = `bar-strip-${th}${suffix}`;
      assert.ok(byName(n), `missing shot ${n}`);
      assert.equal(byName(n)?.theme, th);
      assert.match(js(n), /barShot\(ctx[,)]/, `${n} goes through the shared helper, which takes no look`);
    }
    for (const suffix of ['-tip', '-hot-tip']) assert.match(js(`bar-strip-${th}${suffix}`), /tip: '(fiveHourPct|contextPct)'/, 'the card is forced open');
    assert.match(js(`bar-strip-${th}-narrow`), /pane: \d+/, 'a narrow pane (the window width alone would only shrink the layout around it)');
    assert.deepEqual(byName(`bar-strip-${th}-hot`)?.events, ['conversation', 'bar-hot']);
  }
  // only the strip is shot: a look that does not exist has no pictures
  assert.deepEqual(fixture.shots.map((x) => x.name).filter((n) => /^bar-(minimal|pills)-/.test(n)), []);
  // the helper fails the run when the card reaches into the composer or leaves the bar
  const setup = [fixture.setup].flat().join('\n');
  assert.match(setup, /tip\.top < box\.bottom/);
  assert.match(setup, /tip\.top < bar\.top[\s\S]*tip\.right > bar\.right/);
  assert.doesNotMatch(setup, /BarStyle/, 'the helper has no look to pick');
  // hot values: amber on the 5 h, red on the context (tokens of the window)
  const hot = fixture.streams['bar-hot'];
  const st = hot.find((e) => e.type === 'status') as FxEvent;
  const us = hot.find((e) => e.type === 'usage') as FxEvent;
  assert.ok(Number(st.fiveHourPct) >= 60 && Number(st.fiveHourPct) < 85, 'amber');
  assert.ok(Number(us.contextTokens) / Number(st.contextWindow) >= 0.85, 'red');
  // every status event that carries a per-session field says whether it is this tab's
  for (const [name, evs] of Object.entries(fixture.streams)) for (const e of evs) {
    if (e.type === 'status' && ['model', 'effort', 'contextPct', 'contextWindow'].some((k) => k in e)) assert.equal(typeof e.sessionMatch, 'boolean', `${name}: a status event with per-session fields declares sessionMatch`);
  }
  assert.equal((fixture.streams.conversation.find((e) => e.type === 'status') as FxEvent).sessionMatch, true);
  // the payload that is not this tab's: the shot feeds one and FAILS if the effort shows or the model is not the transcript's
  const nm = js('bar-nomatch-dark');
  assert.match(nm, /"sessionMatch": false/);
  assert.match(nm, /barParts\.effort\.seg\.hidden\) throw/);
  assert.match(nm, /'Sonnet 5\.5'/);
  // resets in the fixture are relative ("+seconds"), never an instant that would be in the past by the next run
  const resets = [...Object.values(fixture.streams).flat(), ...fixture.shots.flatMap((s) => [s.js].flat().join('\n').match(/"[a-zA-Z]+ResetsAt": ("[^"]*"|\d+)/g) ?? [])]
    .flatMap((e) => (typeof e === 'string' ? [e.split(': ')[1].replace(/"/g, '')] : Object.entries(e).filter(([k]) => /ResetsAt$/.test(k)).map(([, v]) => v)));
  assert.ok(resets.length >= 4 && resets.every((v) => typeof v === 'string' && /^\+\d+$/.test(v)), `relative resets only (${resets.join(', ')})`);
  assert.match(main, /\/ResetsAt\$\/\.test\(k\) && typeof s\[k\] === 'string' && \/\^\\\+\\d\+\$\/\.test\(s\[k\]\)/, 'the driver understands them');
  // and the dense tool rows are still shot
  for (const n of ['tools-dense-dark', 'tools-dense-light']) assert.ok(byName(n), `missing shot ${n}`);
});

// ── the slash-command popup ─────────────────────────────────────────────────

/** A stand-in element rich enough for the popup code: attributes, classes, children, listeners. */
class FakeNode {
  tag: string; className = ''; textContent = ''; id = ''; hidden = false; value = ''; scrollTop = 0;
  attrs: Record<string, string> = {}; children: FakeNode[] = []; handlers: Record<string, Array<(e: unknown) => void>> = {};
  selection: [number, number] | null = null;
  get selectionStart(): number { return this.selection ? this.selection[0] : this.value.length; }
  get selectionEnd(): number { return this.selection ? this.selection[1] : this.value.length; }
  constructor(tag: string, cls = '', text = '') { this.tag = tag; this.className = cls; this.textContent = text; }
  classList = {
    toggle: (c: string, on: boolean): void => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); },
  };
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  appendChild(n: FakeNode): FakeNode { this.children.push(n); return n; }
  replaceChildren(...n: FakeNode[]): void { this.children = n; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { (this.handlers[ev] ||= []).push(fn); }
  scrollIntoView(): void { /* layout is not under test */ }
  setSelectionRange(a: number, b: number): void { this.selection = [a, b]; }
  focus(): void { /* focus is not under test */ }
}
interface SlashHarness {
  cs: { slash: { open: boolean; items: unknown[]; index: number; seq: number; pop: FakeNode; list: FakeNode }; input: FakeNode; pane: unknown };
  fns: { refresh: (cs: unknown, p: unknown) => void; show: (cs: unknown, rows: unknown[]) => void; move: (cs: unknown, to: number, scroll?: boolean) => void; close: (cs: unknown) => void; pick: (cs: unknown, i: number) => void; key: (cs: unknown, e: Record<string, unknown>) => boolean };
  calls: string[]; asked: Array<[unknown, string]>; answer: (rows: unknown[]) => Promise<void>;
}
/** The popup's functions, from the real source, wired to fakes. `answer` resolves the pending slashCommands() call. */
function slashHarness(src: string = skin): SlashHarness {
  const from = src.indexOf('function chatSkinSlashRefresh(');
  const to = src.indexOf('/* Which glyph a tool wears');
  assert.ok(from > 0 && to > from, 'the popup block was found');
  const calls: string[] = [];
  const asked: Array<[unknown, string]> = [];
  let resolve: (rows: unknown[]) => void = () => undefined;
  const glassShell = { slashCommands: (cwd: unknown, text: string): Promise<unknown[]> => { asked.push([cwd, text]); return new Promise((r) => { resolve = r; }); }, ptyWrite: (): void => { calls.push('ptyWrite'); } };
  const input = new FakeNode('textarea');
  const cs = { slash: { open: false, items: [] as unknown[], index: 0, seq: 0, pop: new FakeNode('div'), list: new FakeNode('div') }, input, pane: { view: 'chat' }, promptKind: null };
  cs.slash.pop.hidden = true;
  cs.slash.list.id = 'cs-slash-7';
  const make = new Function('window', 'el', 't', 'chatSkinAutosize', 'chatSkinControls',
    `${src.slice(from, to)}\nreturn { refresh: chatSkinSlashRefresh, show: chatSkinSlashShow, move: chatSkinSlashMove, close: chatSkinSlashClose, pick: chatSkinSlashPick, key: chatSkinSlashKey };`) as
    (w: unknown, el: (tag: string, cls?: string, text?: string) => FakeNode, t: (k: string) => string, auto: () => void, controls: () => void) => SlashHarness['fns'];
  const fns = make({ glassShell }, (tag, cls, text) => new FakeNode(tag, cls, text), (k) => `«${k}»`, () => calls.push('autosize'), () => calls.push('controls'));
  return { cs, fns, calls, asked, answer: async (rows) => { resolve(rows); await new Promise((r) => setTimeout(r, 0)); } };
}
const ROWS = [
  { name: 'compact', description: '', descKey: 'chat.slash.cmd.compact', argumentHint: '<optional custom summarization instructions>', source: 'builtin' },
  { name: 'deploy', description: 'Push to staging', argumentHint: '[branch]', source: 'project' },
  { name: 'aios:today', description: 'Daily plan', source: 'plugin', plugin: 'aios' },
];
const keyEv = (key: string, o: Record<string, unknown> = {}): Record<string, unknown> & { prevented: boolean } => {
  const e = { key, keyCode: key === 'Enter' ? 13 : 0, shiftKey: false, isComposing: false, altKey: false, metaKey: false, ctrlKey: false, prevented: false, preventDefault() { e.prevented = true; }, ...o };
  return e;
};

test('slash popup, run for real: "/" asks main with the pane\'s folder, shows the rows as an accessible listbox, and a stale answer is ignored', async () => {
  const h = slashHarness();
  h.cs.input.value = '/';
  (h.cs.pane as { cwd?: string }).cwd = '/work/app';
  h.fns.refresh(h.cs, h.cs.pane);
  assert.deepEqual(h.asked, [['/work/app', '/']], 'main is asked with the pane\'s folder and the text');
  await h.answer(ROWS);
  const s = h.cs.slash;
  assert.equal(s.open, true);
  assert.equal(s.pop.hidden, false);
  assert.equal(s.list.children.length, 3);
  const rows = s.list.children;
  assert.ok(rows.every((r) => r.attrs.role === 'option' && /^cs-slash-7-\d$/.test(r.id)), 'options with ids the box can point at');
  assert.deepEqual(rows.map((r) => r.attrs['aria-selected']), ['true', 'false', 'false']);
  assert.equal(h.cs.input.attrs['aria-activedescendant'], rows[0].id);
  assert.equal(h.cs.input.attrs['aria-expanded'], 'true');
  // built-ins are described through t(); a file's description is shown as written; a project command carries its tag, a plugin's name is already the prefix
  assert.deepEqual(rows[0].children.map((c) => c.textContent), ['/compact', '<optional custom…>', '«chat.slash.cmd.compact»'], 'a long usage is shortened at a word, brackets closed');
  assert.equal((rows[0].children[1] as unknown as { title?: string }).title, '<optional custom summarization instructions>', 'and the whole usage stays one hover away');
  assert.equal((rows[1].children[1] as unknown as { title?: string }).title, undefined, 'a usage that fits has no title');
  assert.deepEqual(rows[1].children.map((c) => c.textContent), ['/deploy', '[branch]', 'Push to staging', '«chat.slash.src.project»']);
  assert.deepEqual(rows[2].children.map((c) => c.textContent), ['/aios:today', '', 'Daily plan'], 'an empty usage cell keeps the columns aligned');
  // a text that no longer starts with a slash closes it, and an answer that arrives late does not bring it back
  h.cs.input.value = '/c';
  h.fns.refresh(h.cs, h.cs.pane);
  h.cs.input.value = 'hello';
  h.fns.refresh(h.cs, h.cs.pane);
  assert.equal(s.open, false);
  await h.answer(ROWS);
  assert.equal(s.open, false, 'the late answer for "/c" is dropped');
  assert.equal(h.asked.length, 2, 'prose never asks main at all');
  // an empty answer (no match, or a finished command) means no popup
  h.cs.input.value = '/zzz';
  h.fns.refresh(h.cs, h.cs.pane);
  await h.answer([]);
  assert.equal(s.open, false);
  assert.ok(!h.calls.includes('ptyWrite'), 'nothing here ever touches the pty');
});

test('slash popup, run for real: arrows move the choice and wrap, Enter and Tab complete into the box and are CONSUMED (so Enter cannot send), Shift+Enter and IME are left alone', async () => {
  const h = slashHarness();
  h.cs.input.value = '/';
  h.fns.refresh(h.cs, h.cs.pane);
  await h.answer(ROWS);
  const s = h.cs.slash;
  const down = keyEv('ArrowDown');
  assert.equal(h.fns.key(h.cs, down), true);
  assert.equal(down.prevented, true);
  assert.equal(s.index, 1);
  assert.equal(h.cs.input.attrs['aria-activedescendant'], 'cs-slash-7-1');
  h.fns.key(h.cs, keyEv('ArrowDown')); h.fns.key(h.cs, keyEv('ArrowDown'));
  assert.equal(s.index, 0, 'wraps past the last row');
  h.fns.key(h.cs, keyEv('ArrowUp'));
  assert.equal(s.index, 2, 'wraps before the first row');
  // modified or composing keys are not the popup's
  for (const o of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) assert.equal(h.fns.key(h.cs, keyEv('ArrowDown', o)), false, JSON.stringify(o));
  assert.equal(h.fns.key(h.cs, keyEv('Enter', { shiftKey: true })), false, 'Shift+Enter is a newline, and a newline closes the popup');
  assert.equal(h.fns.key(h.cs, keyEv('a')), false, 'typing is the box\'s own');
  // Enter completes the highlighted row — consumed, nothing sent, nothing written to the pty
  h.fns.move(h.cs, 1);
  const enter = keyEv('Enter');
  assert.equal(h.fns.key(h.cs, enter), true, 'Enter is consumed while the popup is open');
  assert.equal(enter.prevented, true);
  assert.equal(h.cs.input.value, '/deploy ', 'the command and a space, ready for its arguments');
  assert.deepEqual(h.cs.input.selection, [8, 8], 'the caret goes to the end');
  assert.equal(s.open, false);
  assert.equal(h.cs.input.attrs['aria-expanded'], 'false');
  assert.equal(h.cs.input.attrs['aria-activedescendant'], undefined);
  assert.ok(!h.calls.includes('ptyWrite'));
  // closed again: the same Enter is NOT consumed, so the sending listener gets it
  assert.equal(h.fns.key(h.cs, keyEv('Enter')), false);
  // Tab completes too
  h.cs.input.value = '/'; h.fns.refresh(h.cs, h.cs.pane); await h.answer(ROWS);
  assert.equal(h.fns.key(h.cs, keyEv('Tab')), true);
  assert.equal(h.cs.input.value, '/compact ');
  // a click completes the clicked row
  h.cs.input.value = '/'; h.fns.refresh(h.cs, h.cs.pane); await h.answer(ROWS);
  s.list.children[2].handlers.click[0]({});
  assert.equal(h.cs.input.value, '/aios:today ');
  // hover moves the choice (mousemove, not mouseover)
  h.cs.input.value = '/'; h.fns.refresh(h.cs, h.cs.pane); await h.answer(ROWS);
  s.list.children[1].handlers.mousemove[0]({});
  assert.equal(s.index, 1);
  assert.equal(s.list.children[0].handlers.mouseover, undefined);
});

guarded('Enter with the popup open completes and does NOT send: its listener is registered first and stops the event for the sending one',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const popAt = b.indexOf("input.addEventListener('keydown', (e) => { if (chatSkinSlashKey(cs, e)) e.stopImmediatePropagation(); });");
    const sendAt = b.indexOf('e.preventDefault();\n    chatSkinSendNow(id, p);');
    const key = fnBody(slice(src), 'chatSkinSlashKey');
    return popAt > 0 && sendAt > popAt
      && /e\.key === 'Enter' \|\| e\.key === 'Tab'\) && !e\.shiftKey\) \{ e\.preventDefault\(\); chatSkinSlashPick\(cs, s\.index\); return true; \}/.test(key)
      && !/chatSkinSendNow|submitToPty|ptyWrite/.test(key + fnBody(slice(src), 'chatSkinSlashPick'));
  },
  (src) => src.replace("if (chatSkinSlashKey(cs, e)) e.stopImmediatePropagation();", 'chatSkinSlashKey(cs, e);'));

guarded('Esc closes the slash popup and does NOT cut the turn: its listener runs before the interrupt one and stops the event',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const slashAt = b.indexOf("e.key !== 'Escape' || !cs.slash.open");
    const intrAt = b.indexOf('chatSkinInterrupt(id, p);\n  });');
    return slashAt > 0 && intrAt > slashAt
      && /stopImmediatePropagation\(\)/.test(b.slice(slashAt, intrAt)) && /chatSkinSlashClose\(cs\)/.test(b.slice(slashAt, intrAt))
      && !/chatSkinInterrupt/.test(b.slice(slashAt, intrAt).split('// Esc anywhere')[0]);
  },
  (src) => src.replace("e.preventDefault(); e.stopImmediatePropagation();\n    chatSkinSlashClose(cs);", 'e.preventDefault();\n    chatSkinSlashClose(cs);'));

test('Esc with the popup open, run for real, reaches the interrupt listener never: the two listeners in registration order', () => {
  // replay the skin's keydown listeners on `root` in the order they were registered, with a fake event that honours stopImmediatePropagation
  const b = fnBody(skin, 'chatSkinBuild');
  const listeners = [...b.matchAll(/root\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n  \}\);/g)].map((m) => m[1]);
  assert.equal(listeners.length, 2, 'popup Esc, interrupt');
  const interrupted: string[] = [];
  const run = (open: boolean): string[] => {
    interrupted.length = 0;
    const cs = { slash: { open }, promptKind: null };
    const fns = listeners.map((body) => new Function('cs', 'e', 'chatSkinSlashClose', 'chatSkinInterrupt', 'id', 'p', body) as (...a: unknown[]) => void);
    let stopped = false;
    const e = { key: 'Escape', isComposing: false, preventDefault() { /* */ }, stopPropagation() { /* */ }, stopImmediatePropagation() { stopped = true; } };
    for (const fn of fns) { if (stopped) break; fn(cs, e, () => interrupted.push('popup'), () => interrupted.push('INTERRUPT'), 1, {}); }
    return [...interrupted];
  };
  assert.deepEqual(run(true), ['popup'], 'the popup takes the key; the turn keeps running');
  assert.deepEqual(run(false), ['INTERRUPT'], 'control: with the popup closed the same key does reach the interrupt');
});

test('the slash popup wires: the box is a combobox over a listbox, input asks, send/hide/blocked close it, and the IPC is read-only with a leading-slash gate', () => {
  const b = fnBody(skin, 'chatSkinBuild');
  assert.match(b, /slashList\.setAttribute\('role', 'listbox'\)/);
  assert.match(b, /input\.setAttribute\('role', 'combobox'\)/);
  assert.match(b, /input\.setAttribute\('aria-autocomplete', 'list'\)/);
  assert.match(b, /input\.setAttribute\('aria-controls', slashList\.id\)/);
  assert.match(b, /slashFoot\.setAttribute\('aria-hidden', 'true'\)/, 'the footer hint is not read inside the listbox');
  assert.match(b, /wrap\.append\(slashPop, box\)/, 'the popup floats against the card');
  assert.match(b, /slashPop\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/, 'a press on a row keeps the caret in the box');
  assert.match(b, /input\.addEventListener\('input', \(\) => \{ chatSkinAutosize\(cs\); chatSkinControls\(p\); chatSkinSlashRefresh\(cs, p\); \}\)/);
  assert.match(b, /input\.addEventListener\('blur', \(\) => chatSkinSlashClose\(cs\)\)/);
  assert.match(fnBody(skin, 'chatSkinSendNow'), /chatSkinSlashClose\(cs\)/);
  assert.match(fnBody(skin, 'chatSkinLayout'), /if \(!on \|\| cs\.promptKind\) chatSkinSlashClose\(cs\)/);
  // the popup only completes: nothing in it writes to the pty or submits
  const block = skin.slice(skin.indexOf('function chatSkinSlashRefresh('), skin.indexOf('/* Which glyph a tool wears'));
  assert.doesNotMatch(block, /ptyWrite|submitToPty|chatSkinSendNow|innerHTML/);
  // the command rows only ever take text through textContent (el(tag, class, text))
  assert.match(block, /el\('span', 'csl-desc', c\.descKey \? t\(c\.descKey\) : String\(c\.description \|\| ''\)\)/);
  // main and the preload agree on the channel; main reads only, gates on a leading slash and caps the text
  assert.match(preload, /slashCommands: \(cwd: string \| null, text: string\): Promise<SlashCommand\[\]> => ipcRenderer\.invoke\('slashCommands:list', cwd, text\)/);
  const h = /ipcMain\.handle\('slashCommands:list'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(h, /text\.length > 200 \|\| text\.charCodeAt\(0\) !== 47\) return \[\]/);
  assert.match(h, /path\.isAbsolute\(cwd\)/);
  assert.match(h, /slashSuggestions\(await hit\.list, text\)/);
  assert.match(h, /aios\.claudeConfigDir\(\)[\s\S]*aios\.discoverCommands\(\)/);
  assert.doesNotMatch(h, /writeFile|appendFile|rm\(|unlink|spawn|exec/, 'the handler only reads');
  // control: a handler that did not gate on the slash would list commands for any text
  assert.doesNotMatch(h.replace('text.charCodeAt(0) !== 47', 'false'), /charCodeAt\(0\) !== 47/);
});

test('the slash popup\'s CSS: neutral, above the card, scrolls, rows are options with a visible active state, narrow panes stack the description', () => {
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cc-slash'), /position: absolute[\s\S]*bottom: calc\(100% \+ 8px\)/);
  assert.match(rule('.cc-slash'), /max-height: min\(332px, 52vh\)/);
  assert.match(rule('.csl-list'), /overflow-y: auto/);
  assert.match(rule('.csl-row.on'), /background: var\(--chat-row-hover\)/);
  assert.ok(!coralUsers(css).some((s) => /csl|cc-slash/.test(s)), 'no coral in the popup');
  assert.ok(rules.some(([s, d]) => s === '.csl-desc' && /flex: 1 1 100%/.test(d)), 'a narrow container stacks the description under the name');
  assert.match(rule('.csl-row'), /grid-template-columns: subgrid/, 'wide rows share their columns');
  assert.match(rule('.chatskin [hidden]') + css, /\.chatskin\[hidden\], \.chatskin \[hidden\] \{ display: none !important; \}/, 'hidden stays hidden');
});

test('the slash popup, polished: usage hints cut at a word, at most seven rows, a fade says there is more, the origin is a whisper not a capsule', () => {
  // the shortener, from the real source: whole short hints pass through; long ones lose words, never half a word, and keep their brackets
  const from = skin.indexOf('const CHAT_SLASH_HINT_MAX'); const to = skin.indexOf('function chatSkinSlashFade(');
  assert.ok(from > 0 && to > from, 'the shortener was found');
  const hint = new Function(`${skin.slice(from, to)}\nreturn chatSkinSlashHint;`)() as (h: string) => string;
  assert.equal(hint('[branch]'), '[branch]');
  assert.equal(hint(''), '');
  assert.equal(hint('<optional custom summarization instructions>'), '<optional custom…>');
  assert.equal(hint('[conversation id or search term]'), '[conversation id…]', 'never ends on a dangling joiner');
  assert.equal(hint('averyveryveryverylongsingleword'), 'averyveryveryverylong…', 'one long word has no boundary: the CSS ellipsis is the net');
  for (const h of ['<optional custom summarization instructions>', '[conversation id or search term]', 'x'.repeat(60)]) assert.ok(hint(h).length <= 22, `"${hint(h)}" fits the column`);
  // negative control: a shortener that cut blindly would split the word
  assert.notEqual('<optional custom summarization instructions>'.slice(0, 21) + '…', hint('<optional custom summarization instructions>'));
  // the CSS: seven rows, a mask that follows the more-t / more-b classes, an origin with no border and no pill radius
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([x]) => x === sel)?.[1] ?? '';
  assert.match(rule('.csl-list'), /--csl-row: 28px/);
  assert.match(rule('.csl-list'), /max-height: calc\(7 \* var\(--csl-row\)\)/);
  assert.match(rule('.csl-list'), /mask-image: linear-gradient/);
  assert.match(rule('.csl-list.more-b'), /--csl-fb: \d+px/);
  assert.match(rule('.csl-list'), /scroll-padding: 16px 5px 22px/, 'the active row is never parked under the fade');
  assert.doesNotMatch(rule('.csl-tag'), /border|border-radius|background/, 'the origin is text, not a capsule');
  assert.match(rule('.csl-tag'), /font-size: 10px/);
  assert.match(fnBody(skin, 'chatSkinSlashMove'), /scrollIntoView\(\{ block: 'nearest' \}\)/, 'the active row is scrolled into view when the arrows move it');
  assert.match(fnBody(skin, 'chatSkinSlashFade'), /more-t[\s\S]*more-b/);
});

test('the empty card: a name, a sentence and three keys, every word through t(), the keys only when the view is empty', () => {
  const paint = fnBody(skin, 'chatSkinPaintState');
  assert.match(paint, /cs\.stateTips\) cs\.stateTips\.hidden = kind !== 'empty'/);
  assert.match(paint, /t\(key \+ '\.title', \{ name: chatSkinWho\(p\) \}\)/, 'the title carries the session name');
  for (const k of ['chat.skin.empty.tip.slash', 'chat.skin.empty.tip.send', 'chat.skin.empty.tip.newline']) {
    assert.ok(skin.includes(`'${k}'`), `the card builds ${k}`);
    for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  }
  for (const l of Object.keys(loc)) assert.match(loc[l]['chat.skin.state.empty.title'], /\{name\}/, `${l}: the empty title names the session`);
  assert.match(css, /\.csc-title \{[^}]*color: var\(--ink\)/, 'the title has an explicit ink: a card has no message around it to inherit from');
});

test('the vertical scale: one set of spacing variables on the skin, used by rows, tools, notes and markdown blocks alike', () => {
  const rules = skinRules(css);
  const decl = (sel: string): string => rules.filter(([x]) => x === sel).map(([, d]) => d).join(' ');
  assert.match(decl('.chatskin'), /--cs-m: 7px; --cs-turn: 19px; --cs-blk: \.85em; --cs-sec: 1\.4em/);
  assert.match(decl('.chat-row.who-user'), /margin: var\(--cs-turn\) 0 var\(--cs-m\)/);
  assert.match(decl('.chat-row.who-claude'), /margin: var\(--cs-m\) 0/);
  assert.match(decl('.chat-tool.tg-solo, .chat-tool.tg-last'), /margin-bottom: var\(--cs-m\)/);
  assert.match(decl('.cm-code'), /margin: 0 0 var\(--cs-blk\)/);
  assert.match(decl('.cm-table'), /margin: 0 0 var\(--cs-blk\)/);
  assert.match(decl('.chat-md p, .chat-md ul, .chat-md ol, .chat-md blockquote, .chat-md pre, .chat-md table'), /margin: 0 0 var\(--cs-blk\)/);
  // the operator's bubble: smaller padding and radius than it had (10px 15px, 16px), a lighter skin
  assert.match(decl('.who-user .chat-bubble'), /padding: 7px 13px 8px/);
  assert.match(decl('.who-user .chat-bubble'), /border-radius: 14px 14px 4px 14px/);
  assert.doesNotMatch(decl('.who-user .chat-bubble'), /box-shadow/);
});

test('the slash popup\'s sentences exist in every locale with the same placeholders', () => {
  for (const k of ['chat.slash.label', 'chat.slash.foot', 'chat.slash.src.project', 'chat.slash.src.user']) for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  // every key the popup builds from a command (descKey) is in the main process's list: the two cannot drift
  const keys = [...fs.readFileSync('src/core/slashCommands.ts', 'utf8').matchAll(/^  \['([a-z0-9-]+)'/gm)].map((m) => `chat.slash.cmd.${m[1]}`);
  assert.ok(keys.length >= 60);
  for (const l of Object.keys(loc)) assert.deepEqual(keys.filter((k) => !loc[l][k]), [], `${l}.json lacks descriptions`);
});

test('chat-shot fixture: the slash popup is shot open (all sources, filtered, narrow, and through the real IPC) in dark and light', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['slash-dark', 'slash-light', 'slash-filter-dark', 'slash-filter-light', 'slash-live-dark', 'slash-narrow-dark', 'slash-narrow-light']) assert.ok(byName(n), `missing shot ${n}`);
  const js = (n: string): string => [byName(n)?.js].flat().join('\n');
  assert.match(js('slash-dark'), /chatSkinSlashShow\(/);
  assert.match(js('slash-live-dark'), /dispatchEvent\(new Event\('input'/, 'the live shot goes through the real input listener and the real slashCommands IPC');
  // the hand-written rows cover every source and a built-in described through its locale key
  const rows = JSON.parse(/chatSkinSlashShow\(ctx\.cs, (\[[\s\S]*?\])\);/.exec(js('slash-dark'))?.[1] ?? '[]') as Array<{ source: string; descKey?: string; name: string }>;
  assert.deepEqual([...new Set(rows.map((r) => r.source))].sort(), ['builtin', 'plugin', 'project', 'user']);
  assert.ok(rows.some((r) => r.descKey && loc.en[r.descKey]), 'built-in rows name a real description key');
});

// ── files into the box: drop and paste ──────────────────────────────────────

interface DropHarness {
  cs: { input: FakeNode; box: FakeNode; pane: { el: { classList: { remove: (c: string) => void } } } };
  calls: string[]; saved: Array<[number, string]>; toasts: string[];
  fire: (zone: FakeNode, ev: string, e: Record<string, unknown>) => Promise<void>;
}
/** The drop/paste code from the real source, wired to fakes. `savedPath` is what main would answer for a picture with no file. */
function dropHarness(src: string = skin, o: { savedPath?: string | null; realPath?: (f: { name: string }) => string } = {}): DropHarness {
  const from = src.indexOf('function chatSkinQuotePath(');
  const to = src.indexOf('/* Which glyph a tool wears');
  assert.ok(from > 0 && to > from, 'the drop block was found');
  const calls: string[] = []; const saved: Array<[number, string]> = []; const toasts: string[] = [];
  const glassShell = {
    pathForFile: (f: { name: string }): string => (o.realPath ? o.realPath(f) : `/Users/op/${f.name}`),
    chatSavePastedImage: async (buf: { byteLength: number }, mime: string): Promise<string | null> => { saved.push([buf.byteLength, mime]); return o.savedPath === undefined ? '/tmp/aios-chat-paste/paste-1-abc.png' : o.savedPath; },
    ptyWrite: (): void => { calls.push('ptyWrite'); },
  };
  const make = new Function('window', 'xQuote', 'droppedPaths', 'clearDragging', 'toast', 't', 'chatSkinSlashClose', 'chatSkinAutosize', 'chatSkinControls',
    `${src.slice(from, to)}\nreturn { bind: chatSkinDropBind };`) as (...a: unknown[]) => { bind: (cs: unknown) => void };
  const input = new FakeNode('textarea'); const box = new FakeNode('div');
  const cs = { input, box, pane: { el: { classList: { remove: (c: string): void => { calls.push('pane-remove-' + c); } } } } };
  make({ glassShell }, (p: string) => `'${p}'`, (ev: { dataTransfer: { getData: (t: string) => string } }) => (ev.dataTransfer.getData('text/uri-list') || '').split('\n').filter(Boolean).map((u) => u.replace(/^file:\/\//, '')),
    () => calls.push('clearDragging'), (m: string) => toasts.push(m), (k: string) => `«${k}»`, () => calls.push('slashClose'), () => calls.push('autosize'), () => calls.push('controls')).bind(cs);
  return { cs, calls, saved, toasts, fire: async (zone, ev, e) => { for (const fn of zone.handlers[ev] || []) fn(e); await new Promise((r) => setTimeout(r, 0)); } };
}
interface FakeDrop { stops: number; prevents: number; [k: string]: unknown }
const dropEv = (o: { types?: string[]; data?: Record<string, string>; files?: Array<{ name: string; type?: string; size?: number }> } = {}): FakeDrop => {
  const e: FakeDrop = {
    stops: 0, prevents: 0, relatedTarget: null,
    dataTransfer: { types: o.types ?? ['Files'], getData: (t: string) => o.data?.[t] ?? '', files: (o.files ?? []).map((f) => ({ type: '', size: 3, arrayBuffer: async () => ({ byteLength: f.size ?? 3 }), ...f })), dropEffect: '' },
    preventDefault() { e.prevents++; }, stopPropagation() { e.stops++; },
  };
  return e;
};

test('drop and paste, run for real: a dropped file lands at the caret as a double-quoted absolute path, never sent, and the pane under the card never hears of it', async () => {
  const h = dropHarness();
  const zone = h.cs.box;
  // dragover: accepted, copy cursor, the card lights up, the pane's own zone is told to dim and the event stops here
  const over = dropEv();
  await h.fire(zone, 'dragover', over);
  assert.equal(over.prevents, 1); assert.equal(over.stops, 1);
  assert.match(zone.className, /dropok/);
  assert.ok(h.calls.includes('pane-remove-dropok'), 'the pane\'s coral drop ring does not light up behind the card');
  // a tab being reordered is not a file: not accepted, not stopped
  const tab = dropEv({ types: ['application/x-aios-tab', 'text/plain'] });
  await h.fire(zone, 'dragover', tab);
  assert.equal(tab.prevents, 0);
  // an empty box: the path alone, quoted, with a space after so typing continues
  const drop = dropEv({ files: [{ name: 'My Notes v2.pdf' }] });
  await h.fire(zone, 'drop', drop);
  assert.equal(h.cs.input.value, '"/Users/op/My Notes v2.pdf" ');
  assert.deepEqual(h.cs.input.selection, [h.cs.input.value.length, h.cs.input.value.length]);
  assert.equal(drop.stops, 1, 'the drop stops here: the pane\'s terminal zone would write the path to the pty'); assert.equal(drop.prevents, 1);
  assert.ok(!/dropok/.test(zone.className), 'the veil is gone after the drop');
  assert.ok(!h.calls.includes('ptyWrite'), 'the drop only edits the box');
  // text already in the box: a space is added before the path when needed, and the caret decides where it lands
  h.cs.input.value = 'look at'; h.cs.input.selection = [7, 7];
  await h.fire(zone, 'drop', dropEv({ files: [{ name: 'a.png' }, { name: 'b.png' }] }));
  assert.equal(h.cs.input.value, 'look at "/Users/op/a.png" "/Users/op/b.png" ');
  h.cs.input.value = 'compare  and then'; h.cs.input.selection = [8, 8];
  await h.fire(zone, 'drop', dropEv({ files: [{ name: 'c.png' }] }));
  assert.equal(h.cs.input.value, 'compare "/Users/op/c.png" and then', 'in the middle: one space each side, none doubled');
  // one of our explorer rows
  h.cs.input.value = ''; h.cs.input.selection = [0, 0];
  await h.fire(zone, 'drop', dropEv({ types: ['application/x-aios-path', 'text/plain'], data: { 'application/x-aios-path': '/work/app/src' } }));
  assert.equal(h.cs.input.value, '"/work/app/src" ');
  // plain text: the textarea's own business — the drop still stops here (so the pane's zone does not write it to the pty) but nothing is inserted by us
  h.cs.input.value = ''; h.cs.input.selection = [0, 0];
  const text = dropEv({ types: ['text/plain'], data: { 'text/plain': 'hello' } });
  await h.fire(zone, 'drop', text);
  assert.equal(text.stops, 1); assert.equal(text.prevents, 0); assert.equal(h.cs.input.value, '');
  assert.ok(!h.calls.includes('ptyWrite'));
});

test('drop and paste, run for real: a picture with no file behind it is saved by main and its path inserted; anything else that cannot be attached says so once', async () => {
  const h = dropHarness();
  // an image dragged out of a browser: no path from the OS, the bytes go to main, the temp path comes back
  const real = (f: { name: string }): string => (/^(photo|image)\.png$/.test(f.name) ? '' : `/Users/op/${f.name}`);
  const h2 = dropHarness(skin, { realPath: real });
  await h2.fire(h2.cs.box, 'drop', dropEv({ files: [{ name: 'photo.png', type: 'image/png', size: 2048 }] }));
  assert.deepEqual(h2.saved, [[2048, 'image/png']]);
  assert.equal(h2.cs.input.value, '"/tmp/aios-chat-paste/paste-1-abc.png" ');
  // a paste of that same picture: native paste is cancelled, the same path is inserted
  const pasteEv = { clipboardData: { files: [{ name: 'image.png', type: 'image/png', size: 10, arrayBuffer: async () => ({ byteLength: 10 }) }] }, prevents: 0, preventDefault() { pasteEv.prevents++; } };
  h2.cs.input.value = 'what is wrong here?'; h2.cs.input.selection = [19, 19];
  await h2.fire(h2.cs.input, 'paste', pasteEv);
  assert.equal(pasteEv.prevents, 1);
  assert.equal(h2.cs.input.value, 'what is wrong here? "/tmp/aios-chat-paste/paste-1-abc.png" ');
  // control: a text paste has no files, so it is left to the textarea (we never cancel it)
  const textPaste = { clipboardData: { files: [] }, prevents: 0, preventDefault() { textPaste.prevents++; } };
  await h2.fire(h2.cs.input, 'paste', textPaste);
  assert.equal(textPaste.prevents, 0);
  // not an image and no path (or main refused): nothing inserted, one message
  const h3 = dropHarness(skin, { realPath: () => '', savedPath: null });
  await h3.fire(h3.cs.box, 'drop', dropEv({ files: [{ name: 'x.bin', type: 'application/octet-stream' }, { name: 'y.png', type: 'image/png' }] }));
  assert.equal(h3.cs.input.value, '');
  assert.deepEqual(h3.toasts, ['«chat.drop.failed»'], 'once, however many files failed');
  assert.equal(h3.saved.length, 1, 'only the picture is offered to main');
  assert.ok(h.calls.length === 0 || !h.calls.includes('ptyWrite'));
  // a double quote in a path falls back to the shell-style quote rather than a broken pair
  const h4 = dropHarness(skin, { realPath: () => '/Users/op/say "hi".png' });
  await h4.fire(h4.cs.box, 'drop', dropEv({ files: [{ name: 'q.png' }] }));
  assert.equal(h4.cs.input.value, `'/Users/op/say "hi".png' `);
});

guarded('the drop on the card inserts the double-quoted absolute path and stops the event, so the pane under it does not also write to the pty',
  (src) => {
    const s = slice(src);
    const quote = fnBody(s, 'chatSkinQuotePath');
    const bind = fnBody(s, 'chatSkinDropBind');
    const insert = fnBody(s, 'chatSkinInsertPaths');
    const dropAt = bind.indexOf("zone.addEventListener('drop'");
    const stopAt = bind.indexOf('ev.stopPropagation();', dropAt);
    const guardAt = bind.indexOf('if (!wants(ev)) return;', dropAt);
    return /'"' \+ s \+ '"'/.test(quote)
      && dropAt > 0 && stopAt > dropAt && stopAt < guardAt   // stopped BEFORE the early return: a text drop must not fall through to the pane either
      && /chatSkinInsertPaths\(cs, paths\)/.test(bind) && /paths\.map\(chatSkinQuotePath\)/.test(insert)
      && !/ptyWrite|submitToPty|chatSkinSendNow/.test(quote + bind + insert + fnBody(s, 'chatSkinFilePaths'));
  },
  (src) => src.replace("    // ALWAYS stop it here: a drop of plain text on the box is the textarea's own (it inserts the text), and must not also reach the pane's zone\n    ev.stopPropagation();\n", ''));

guarded('a path is only ever quoted with double quotes unless it holds one itself, and a dragover over the card never lights the pane\'s coral ring',
  (src) => {
    const s = slice(src);
    return /return s\.includes\('"'\) \? xQuote\(s\) : '"' \+ s \+ '"'/.test(fnBody(s, 'chatSkinQuotePath'))
      && /cs\.pane\.el\?\.classList\.remove\('dropok'\)/.test(fnBody(s, 'chatSkinDropBind'));
  },
  (src) => src.replace("return s.includes('\"') ? xQuote(s) : '\"' + s + '\"';", 'return xQuote(s);'));

test('drop and paste: the picture-saving IPC is bounded, names its own file, sweeps only its own files, and the card has a neutral drop veil', () => {
  assert.match(preload, /chatSavePastedImage: \(bytes: ArrayBuffer, mime: string\): Promise<string \| null> => ipcRenderer\.invoke\('chatFiles:savePastedImage', bytes, mime\)/);
  const h = /ipcMain\.handle\('chatFiles:savePastedImage'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.ok(h.length > 400, 'handler found');
  assert.match(h, /PASTE_EXT\[mime\.toLowerCase\(\)\]/, 'only the image types on the allow-list');
  assert.match(main, /const PASTE_MAX_BYTES = 25 \* 1024 \* 1024/);
  assert.match(h, /buf\.length > PASTE_MAX_BYTES\) return null/);
  assert.match(h, /path\.join\(fs\.realpathSync\(os\.tmpdir\(\)\), 'aios-chat-paste'\)/, 'one folder under the system temp');
  assert.match(h, /paste-\$\{Date\.now\(\)\}-\$\{crypto\.randomBytes\(3\)\.toString\('hex'\)\}\.\$\{ext\}/, 'main names the file; the renderer chooses no path or extension');
  assert.match(h, /\^paste-\[\\w-\]\+\\\.\(png\|jpg\|gif\|webp\)\$/, 'the sweep only touches files that look like its own');
  assert.match(h, /mode: 0o600/);
  assert.doesNotMatch(h, /\.\.\/|ev\.|_e\./, 'no renderer-supplied path anywhere');
  // control: a handler that took the file name from the renderer would show up as a second parameter being joined into the path
  assert.doesNotMatch(h.replace('paste-${Date.now()}', '${name}'), /paste-\$\{Date\.now\(\)\}/);
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cc-drop'), /pointer-events: none/);
  assert.match(rule('.cc-drop'), /border: 1\.5px dashed var\(--line-strong\)/);
  assert.ok(!coralUsers(css).some((s) => /cc-drop|dropok/.test(s) && !/termcard/.test(s)), 'no coral on the card\'s drop veil');
  for (const l of Object.keys(loc)) for (const k of ['chat.drop.label', 'chat.drop.failed']) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
});

test('chat-shot fixture: the drop veil and an inserted pair of paths are shot in dark and light, with paths that name nothing personal', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['drop-over-dark', 'drop-over-light', 'drop-inserted-dark', 'drop-inserted-light']) assert.ok(byName(n), `missing shot ${n}`);
  assert.match([byName('drop-over-dark')?.js].flat().join('\n'), /box\.classList\.add\('dropok'\)/, 'the veil is forced by the fixture');
  const ins = [byName('drop-inserted-light')?.js].flat().join('\n');
  assert.match(ins, /chatSkinInsertPaths\(ctx\.cs, \['\/work\/app\//, 'it goes through the real insert function, with neutral paths');
});

// ── streaming: the reply being written, as ONE provisional bubble the finished message takes over ──────────

/** A DOM stand-in rich enough for the column code: ordered children, classes, attributes, a class-selector query, focus. */
class Dn {
  tag: string; className: string; textContent: string; hidden = false; disabled = false; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  children: Dn[] = []; parent: Dn | null = null; handlers: Record<string, Array<(e: unknown) => void>> = {}; value = ''; renders = 0;
  static active: Dn | null = null;
  constructor(tag = 'div', cls = '', text = '') { this.tag = tag; this.className = cls; this.textContent = text; }
  private cls(): Set<string> { return new Set(this.className.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...c: string[]): void => { const s = this.cls(); c.forEach((x) => s.add(x)); this.className = [...s].join(' '); },
    remove: (...c: string[]): void => { const s = this.cls(); c.forEach((x) => s.delete(x)); this.className = [...s].join(' '); },
    contains: (c: string): boolean => this.cls().has(c),
    toggle: (c: string, on?: boolean): void => { const s = this.cls(); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); this.className = [...s].join(' '); },
  };
  insertBefore(n: Dn, ref: Dn | null): Dn { n.remove(); const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, n); n.parent = this; return n; }
  appendChild(n: Dn): Dn { return this.insertBefore(n, null); }
  append(...ns: Dn[]): void { ns.forEach((n) => this.appendChild(n)); }
  remove(): void { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...ns: Dn[]): void { this.children.forEach((c) => { c.parent = null; }); this.children = []; ns.forEach((n) => this.appendChild(n)); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { (this.handlers[ev] ||= []).push(fn); }
  focus(): void { Dn.active = this; }
  click(): void { if (this.disabled) return; for (const fn of this.handlers.click ?? []) fn({ target: this, preventDefault: () => undefined }); this.parent?.bubble('click', this); }
  /** a click on a child reaches the listeners of its ancestors (the card delegates its clicks to the list) */
  bubble(ev: string, target: Dn): void { for (const fn of this.handlers[ev] ?? []) fn({ target, preventDefault: () => undefined }); this.parent?.bubble(ev, target); }
  closest(sel: string): Dn | null { for (let n: Dn | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  private matches(sel: string): boolean {
    const notDisabled = sel.includes(':not(:disabled)');
    const classes = sel.replace(':not(:disabled)', '').split('.').filter(Boolean);
    return classes.every((c) => this.cls().has(c)) && (!notDisabled || !this.disabled);
  }
  querySelectorAll(sel: string): Dn[] { const out: Dn[] = []; const walk = (n: Dn): void => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel: string): Dn | null { return this.querySelectorAll(sel)[0] ?? null; }
}
const isProv = (n: Dn): boolean => n.classList.contains('cs-prov');

interface StreamHarness { cs: Record<string, any>; handle: (ev: Record<string, unknown>) => void; p: Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
/** The column code (items, the provisional bubble, adoption, the event switch) from the real source, wired to stand-ins. */
function streamHarness(src: string = app): StreamHarness {
  const from = src.indexOf('function chatSkinRegroup(');
  const to = src.indexOf('if (window.glassShell && typeof window.glassShell.onChatSkinEvent');
  assert.ok(from > 0 && to > from, 'the column block was found');
  const make = new Function('el', 't', 'chatRender', 'chatSkinMakeTool', 'chatSkinPaintTool', 'chatSkinScroll', 'chatSkinPaintJump', 'chatSkinControls', 'chatSkinPaintAlert', 'chatSkinPaintState',
    'chatSkinCardPaint', 'chatSkinPrompt', 'chatReducedMotion', 'CS_ANIM_AFTER_MS', 'panes',
    `${src.slice(from, to)}\nreturn chatSkinHandleEvent;`) as (...a: unknown[]) => (ev: Record<string, unknown>) => void;
  const log = new Dn('div', 'chat-log');
  const stateEl = new Dn('div', 'cs-card'); const workEl = new Dn('div', 'cs-working');
  log.append(stateEl, workEl);
  const p: Record<string, any> = { name: 'chat-qa', view: 'chat' }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cs: Record<string, any> = { log, stateEl, workEl, items: new Map(), stream: null, dlg: null, dlgSig: '', turnOpen: false, stalled: false, state: 'waiting', stick: true, resetAt: 0, lastEventAt: 0, lastSubmitAt: 0, pane: p }; // eslint-disable-line @typescript-eslint/no-explicit-any
  p.chatSkin = cs;
  const handle = make((tag: string, cls?: string, text?: string) => new Dn(tag, cls, text), (k: string) => k,
    (target: Dn, text: string) => { target.textContent = text; target.renders++; },
    () => ({ node: new Dn('div', 'chat-tool'), body: null, role: 'tool', tool: {} }), () => undefined, () => undefined, () => undefined, () => undefined, () => undefined, () => undefined,
    () => undefined, () => undefined, () => false, 1500, new Map([[1, p]]));
  return { cs, p, handle: (ev) => handle({ paneId: 1, ...ev }) };
}
const rowsOf = (cs: StreamHarness['cs']): Dn[] => (cs.log as Dn).children.filter((c) => c.className.includes('who-claude'));

/** The scenario every streaming guard reads: a message, text growing in three snapshots, then the finished message. */
function streamRun(src: string): { provisionals: number; sameNode: boolean; stillProvisional: boolean; sameSlot: boolean; answerRows: number; finalText: string; renderedOnce: boolean; ariaHiddenGone: boolean } {
  const { cs, handle } = streamHarness(src);
  handle({ type: 'items', items: [{ uuid: 'u1', role: 'user', text: 'explain the cap' }] });
  handle({ type: 'turn', open: true });
  handle({ type: 'stream', text: 'The cap', anchor: 'the cap', headCut: false });
  handle({ type: 'stream', text: 'The cap is enforced in nextDelay', anchor: 'the cap is enforced in nextdelay', headCut: false });
  handle({ type: 'stream', text: 'The cap is enforced in nextDelay: the smaller of both.', anchor: 'the cap is enforced in nextdelay', headCut: false });
  const log = cs.log as Dn;
  const provs = log.children.filter(isProv);
  const slot = log.children.indexOf(provs[0]);
  const rendersBefore = provs[0]?.querySelector('.chat-md')?.renders ?? 0;
  handle({ type: 'stream', text: null, adopt: 'a1' });
  handle({ type: 'items', items: [{ uuid: 'a1', role: 'assistant', text: 'The cap is enforced in `nextDelay`: the smaller of both.' }] });
  handle({ type: 'turn', open: false });
  const rec = cs.items.get('a1');
  return {
    provisionals: provs.length, sameNode: !!rec && rec.node === provs[0], stillProvisional: !!provs[0] && isProv(provs[0]),
    sameSlot: !!provs[0] && log.children.indexOf(provs[0]) === slot && slot > 0, answerRows: rowsOf(cs).length,
    finalText: rec ? String(rec.body.textContent) : '', renderedOnce: rendersBefore >= 3, ariaHiddenGone: !!provs[0] && provs[0].getAttribute('aria-hidden') === null,
  };
}

guarded('streaming: text growing is ONE provisional bubble, and the finished message takes over that very node — same place, no second bubble, no flash of nothing',
  (src) => {
    const r = streamRun(src);
    return r.provisionals === 1 && r.sameNode && !r.stillProvisional && r.sameSlot && r.answerRows === 1 && /`nextDelay`/.test(r.finalText) && r.renderedOnce && r.ariaHiddenGone;
  },
  (src) => src.replace('  cs.items.set(uuid, st.rec);\n', ''));   // no hand-over: the item makes a NEW node and the preview is left beside it

guarded('streaming: a second preview is never created while the first one is being written',
  (src) => streamRun(src).provisionals === 1,
  (src) => src.replace('  if (!st) {\n    const rec = chatSkinMakeItem', '  if (true) {\n    const rec = chatSkinMakeItem'));

guarded('streaming: a tool that lands while a preview is on screen goes ABOVE it, so the preview stays the last thing and keeps its place under the column',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'stream', text: 'Let me check the logs and then', anchor: 'let me check the logs and then', headCut: false });
    handle({ type: 'items', items: [{ uuid: 't1', role: 'tool', tool: { id: 't1', name: 'Read', summary: 'a.ts', status: 'running' } }] });
    const kids = (cs.log as Dn).children;
    const prov = kids.findIndex(isProv); const tool = kids.findIndex((c) => c.className.includes('chat-tool'));
    return prov > 0 && tool > 0 && tool < prov && kids.indexOf(cs.workEl) === kids.length - 1 && kids[kids.length - 2] === kids[prov];
  },
  (src) => src.replace(/\(cs\.stream && cs\.stream\.rec\.node\) \|\| (?:cs\.dlg \|\| )?cs\.workEl/, 'cs.workEl'));

guarded('streaming: a preview that was never adopted is dropped when the turn ends or the view resets, and a frozen one waits for its message until then',
  (src) => {
    const { cs, handle } = streamHarness(src);
    const provs = (): number => (cs.log as Dn).children.filter(isProv).length;
    handle({ type: 'stream', text: 'Half of an answer that', anchor: 'half of an answer that', headCut: false });
    handle({ type: 'stream', text: null });                                   // the spinner went away: freeze, do not remove
    const frozen = provs() === 1 && !(cs.log as Dn).children.find(isProv)!.classList.contains('live');
    handle({ type: 'turn', open: false });
    const afterTurn = provs();
    handle({ type: 'stream', text: 'Another answer that', anchor: 'another answer that', headCut: false });
    handle({ type: 'reset' });
    return frozen && afterTurn === 0 && provs() === 0 && cs.stream === null;
  },
  (src) => src.replace("if (!ev.open) { cs.lastSubmitAt = 0; chatSkinStreamDrop(cs); }", 'if (!ev.open) { cs.lastSubmitAt = 0; }'));

guarded('streaming: a different block (its first words are not an extension of the preview\'s) replaces the preview instead of being appended to it',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'stream', text: 'First block of text here', anchor: 'first block of text here', headCut: false });
    const first = (cs.log as Dn).children.find(isProv);
    handle({ type: 'stream', text: 'Second block starts elsewhere', anchor: 'second block starts elsewhere', headCut: false });
    const provs = (cs.log as Dn).children.filter(isProv);
    // the old preview was NOT the message that came next: it is gone, and the new one is a node of its own (not the old one rewritten)
    return provs.length === 1 && provs[0] !== first && !first!.parent && provs[0].querySelector('.chat-md')!.textContent.startsWith('Second');
  },
  (src) => src.replace("!anchor.startsWith(st.anchor) && !st.anchor.startsWith(anchor)", 'false'));

test('streaming: the preview is dimmer, never coral, has a reduced-motion fallback, and the screen reader hears the finished message once', () => {
  const rules = skinRules(css);
  const all = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(all, /\.chat-row\.cs-prov \.chat-md \{ color: color-mix\(in srgb, var\(--ink\) 84%/, 'a step quieter than the message');
  const caret = /\.chat-row\.cs-prov\.live[^{]*::after \{[^}]*\}/.exec(all)?.[0] ?? '';
  assert.match(caret, /background: var\(--st-busy\)/, 'the caret is the busy hue');
  assert.doesNotMatch(caret, /--accent/, 'coral stays on the send button');
  assert.match(all, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.chat-row\.cs-prov\.live[^{]*::after[^}]*animation: none/, 'reduced motion: no blinking');
  assert.ok(!coralUsers(css).some((s) => /cs-prov|cs-dlg|csd-/.test(s)), `no coral in the preview or the cards: ${coralUsers(css).join(', ')}`);
  assert.ok(rules.length > 10);
  assert.match(fnBody(skin, 'chatSkinStream'), /rec\.node\.setAttribute\('aria-hidden', 'true'\)/, 'hidden from assistive tech while it is only a preview');
  assert.match(fnBody(skin, 'chatSkinStreamAdopt'), /removeAttribute\('aria-hidden'\)/);
});

test('streaming, main: the extractor runs where the transcript is, the preview is sent only while a transcript can replace it, and the adoption goes out BEFORE the item', () => {
  const w = /ipcMain\.handle\('chatSkin:watch'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  const order = (m: string): boolean => {
    const a = m.indexOf('skin.stream.items(ev.items)');
    const b = m.indexOf('skin.send(rest)');
    return a > 0 && b > a;
  };
  assert.ok(order(w), 'the adoption event is computed and sent before the items event');
  assert.equal(order(w.replace('skin.send(rest)', 'skin.send(rest); /*moved*/').replace(/if \(ev\.type === 'items'\) \{ const a = skin\.stream\.items\(ev\.items\); if \(a\) skin\.send\(\{ \.\.\.a \}\); \}/, '')), false, 'control: without the adoption step the order check fails');
  const screen = /ipcMain\.on\('chatSkin:screen'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(screen, /if \(!k\.following\) return;/, 'no transcript, no preview: a bubble that nothing can replace is never drawn');
  assert.match(screen, /k\.stream\.screen\(text\)/);
  assert.match(w, /else if \(ev\.type === 'turn'\) \{ if \(ev\.open\) skin\.stream\.begin\(\); else skin\.stream\.end\(\); \}/);
  assert.match(w, /else if \(ev\.type === 'reset'\) skin\.stream\.reset\(\)/);
  assert.match(w, /k\.stream\.reset\(\);/, 'a new watch forgets the old transcript\'s preview');
  assert.match(preload, /\| \{ type: 'stream'; text: string; anchor: string; headCut: boolean \}\n\s+\| \{ type: 'stream'; text: null; adopt\?: string \}/);
});

test('streaming, sampling: a snapshot waits for the repaint to finish, never longer than the old ceiling, and the cost was measured rather than guessed', () => {
  const fn = fnBody(skin, 'chatSkinScreenSoon');
  assert.match(skin, /const CS_SCREEN_QUIET_MS = 40;/);
  assert.match(skin, /const CS_SCREEN_MAX_MS = 150;/, 'the worst case is the old fixed window');
  assert.match(fn, /Math\.min\(CS_SCREEN_QUIET_MS, cs\.screenSince \+ CS_SCREEN_MAX_MS - now\)/);
  assert.match(fn, /cs\.screenTimer = 0; cs\.screenSince = 0;/, 'the window restarts after each snapshot');
  assert.match(fn, /cs\.framing && performance\.now\(\) - cs\.screenSince < CS_SCREEN_MAX_MS \+ CS_FRAME_WAIT_MS/, 'a half-painted frame is waited for, but not for ever');
  assert.match(skin, /const CS_FRAME_WAIT_MS = 250;/);
  assert.match(main, /extractor \$\{avg\(extractMs\)\.toFixed\(2\)\} ms avg/, 'the smoke gate prints what the extractor and the snapshot cost');
});

/** The frame-open tracker and the snapshot timer, run for real against a fake clock: a half-painted frame is waited for, an open frame that never closes is not. */
function frameHarness(src: string = app): { feed: (data: string) => void; soon: () => void; sent: number[]; tick: (ms: number) => void; cs: Record<string, any> } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const from = src.indexOf('function chatSkinFrameState(');
  const to = src.indexOf('/* Called wherever app.js learns, changes or forgets a pane\'s session. */');
  assert.ok(from > 0 && to > from);
  const consts = ['CS_SCREEN_QUIET_MS', 'CS_SCREEN_MAX_MS', 'CS_FRAME_WAIT_MS'].map((n) => new RegExp(`const ${n} = [^\\n]+`).exec(src)![0]).join('\n');
  const sent: number[] = [];
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const cs: Record<string, any> = { watched: 'sid', screenTimer: 0, screenSince: 0, framing: false }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = { chatSkin: cs, view: 'chat', exited: false };
  const make = new Function('performance', 'setTimeout', 'clearTimeout', 'panes', 'window', 'chatSkinScreenText', `${consts}\n${src.slice(from, to)}\nreturn { state: chatSkinFrameState, soon: chatSkinScreenSoon };`) as (...a: unknown[]) => { state: (cs: unknown, d: string) => void; soon: (id: number, p: unknown) => void };
  const api = make({ now: () => now }, (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }, new Map([[1, p]]),
    { glassShell: { chatSkinScreen: () => { sent.push(now); } } }, () => 'screen');
  return {
    cs, sent,
    feed: (data) => { api.state(cs, data); api.soon(1, p); },
    soon: () => api.soon(1, p),
    tick: (ms) => { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t0 = timers[0]; if (!t0 || t0.at > end) break; timers.shift(); now = t0.at; t0.fn(); } now = end; },
  };
}
const HIDE = '\x1b[?25l'; const SHOW = '\x1b[?25h';

guarded('a snapshot is not taken between the pieces of one repaint: it waits for the cursor to be shown again, and gives up after a while so a menu that keeps it hidden is still seen',
  (src) => {
    const a = frameHarness(src);
    a.feed(HIDE + 'x'.repeat(1000));                       // the first piece of a long frame: the frame is open
    a.tick(100);
    const heldBack = a.sent.length === 0;
    a.feed('y'.repeat(30) + SHOW);                         // the last piece
    a.tick(60);
    const afterClose = a.sent.length === 1;
    // a menu that hides the cursor and keeps it hidden is still reported, within the ceiling plus the patience
    const b = frameHarness(src);
    b.feed(HIDE + 'menu');
    b.tick(150 + 250 + 40);
    const neverHeldForever = b.sent.length === 1;
    // a complete frame in one piece goes out quickly
    const c = frameHarness(src);
    c.feed(HIDE + 'whole' + SHOW);
    c.tick(60);
    return heldBack && afterClose && neverHeldForever && c.sent.length === 1;
  },
  (src) => src.replace("if (cs.framing && performance.now() - cs.screenSince < CS_SCREEN_MAX_MS + CS_FRAME_WAIT_MS) { cs.screenTimer = setTimeout(fire, 15); return; }", ''));

test('chat-shot fixture: the reply half-written and the same reply after the finished message took its place are shot in dark and light, from neutral, hand-written events', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['stream-half-dark', 'stream-half-light', 'stream-final-dark', 'stream-final-light']) assert.ok(byName(n), `missing shot ${n}`);
  // the half-written reply: ends mid-word, the finished one replaces it by adoption
  const half = fixture.streams['streaming-half'][0] as FxEvent & { text: string; anchor: string };
  assert.equal(half.type, 'stream');
  assert.ok(/[a-z]$/.test(half.text) && !/[.!?:]$/.test(half.text), 'the preview ends mid-sentence');
  const fin = fixture.streams['streaming-final'];
  assert.equal((fin[0] as FxEvent & { adopt?: string }).adopt, 's-a2');
  assert.equal(((fin[1].items ?? [])[0] ?? {}).uuid, 's-a2', 'the adoption names the item that follows it');
  // the harness only feeds the skin: no shot answers anything
  for (const s of fixture.shots) assert.doesNotMatch([s.js].flat().join('\n'), /chatSkinPick\(|ptyWrite/, `${s.name} must not write to the pty`);
});

// ── dialogs as cards: a button per option, one chokepoint for the key, nothing sent without the operator ───────

interface DialogHarness {
  cs: Record<string, any>; p: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  prompt: (ev: Record<string, unknown>) => void; pick: (i: number) => void; key: (e: Record<string, unknown>) => void; sendKey: (key: string) => boolean;
  /** Everything the skin wrote to the pty, with the delay it was scheduled at (0 = at once). */
  writes: Array<{ id: number; data: string; at: number }>; flush: (upToMs?: number) => void; calls: string[];
}
/** The card code (prompt events, the card, its keys, the answer) from the real source, wired to stand-ins. */
function dialogHarness(src: string = app): DialogHarness {
  const from = src.indexOf('const chatSkinCardOn');
  const to = src.indexOf('/* ── actions');
  assert.ok(from > 0 && to > from, 'the dialog block was found');
  const pull = (re: RegExp): string => { const m = re.exec(src); assert.ok(m, `source line ${re} found`); return m[0]; };
  const consts = [pull(/const CS_KEY_GAP_MS = [^\n]+/), pull(/const CS_RETRY_MS = [^\n]+/), pull(/const CHAT_KEY_OK = [^\n]+/), pull(/const CHAT_KEY_CHUNK = [^\n]+/), pull(/const CHAT_PROMPT_KINDS = [^\n]+/)].join('\n');
  const writes: DialogHarness['writes'] = [];
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let clock = 0;
  const log = new Dn('div', 'chat-log'); const workEl = new Dn('div', 'cs-working'); log.append(workEl);
  const input = new Dn('textarea');
  const p: Record<string, any> = { name: 'chat-qa', view: 'chat', exited: false, term: { focus: () => calls.push('term.focus'), blur: () => undefined } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cs: Record<string, any> = { id: 7, pane: p, log, workEl, input, promptKind: null, promptHint: '', promptQ: '', promptOpts: null, promptUsed: false, promptTerm: false, promptGen: 0, dlg: null, dlgSig: '', stick: true, stalled: false }; // eslint-disable-line @typescript-eslint/no-explicit-any
  p.chatSkin = cs;
  const panes = new Map([[7, p]]);
  const body = `${consts}
function chatSkinLayout(p) { chatSkinCardPaint(p); calls.push('layout'); }
function chatSkinPlaceholder(p) { p.chatSkin.input.placeholder = p.chatSkin.promptOpts ? 'waiting' : 'message'; }
${src.slice(from, to)}
return { prompt: chatSkinPrompt, pick: chatSkinPick, key: chatSkinCardKey, sendKey: chatSkinSendKey, strip: chatSkinStrip, on: chatSkinCardOn };`;
  const make = new Function('el', 't', 'csIcon', 'panes', 'window', 'document', 'calls', 'setTimeout', 'requestAnimationFrame', 'paneShown', 'active', 'zoneOf', 'markActivity', 'toast', 'repaintTerm',
    'chatSkinWho', 'chatSkinScroll', 'chatSkinRegroup', 'chatSkinPaintAlert', 'chatSkinFocus', 'submitToPty', body) as (...a: unknown[]) => { prompt: (id: number, p: unknown, ev: unknown) => void; pick: (id: number, p: unknown, i: number) => void; key: (cs: unknown, p: unknown, e: unknown) => void; sendKey: (id: number, p: unknown, k: string) => boolean };
  const api = make((tag: string, cls?: string, text?: string) => new Dn(tag, cls, text), (k: string, a?: { name?: string }) => (a && a.name ? `${k}|${a.name}` : k), () => new Dn('span', 'cs-ico'),
    panes, { glassShell: { ptyWrite: (id: number, data: string): void => { writes.push({ id, data, at: clock }); } } }, { hidden: false, get activeElement() { return Dn.active; } }, calls,
    (fn: () => void, ms: number) => { timers.push({ fn, ms: clock + ms }); return timers.length; }, (fn: () => void) => { fn(); return 0; },
    () => true, { term: 7 }, () => 'term', () => undefined, () => undefined, () => undefined,
    (pp: { name?: string }) => pp.name ?? 'Claude', () => undefined, () => undefined, () => undefined, () => undefined,
    (id: number, text: string) => { writes.push({ id, data: text + '\r', at: -1 }); });   // submitToPty: text THEN a CR — what a digit must never get
  return {
    cs, p, writes, calls,
    prompt: (ev) => api.prompt(7, p, { type: 'prompt', ...ev }), pick: (i) => api.pick(7, p, i), key: (e) => api.key(cs, p, { isComposing: false, altKey: false, metaKey: false, ctrlKey: false, preventDefault: () => undefined, ...e }),
    sendKey: (k) => api.sendKey(7, p, k),
    flush: (upToMs = Infinity) => { timers.sort((a, b) => a.ms - b.ms); while (timers.length && timers[0].ms <= upToMs) { const t0 = timers.shift()!; clock = t0.ms; t0.fn(); } },
  };
}
const PERMISSION = { kind: 'permission', hint: 'Do you want to proceed?', question: 'Do you want to proceed?', options: [
  { n: 1, label: 'Yes', selected: true, key: '1' },
  { n: 2, label: "Yes, and don't ask again for npm test commands", selected: false, key: '2' },
  { n: 3, label: 'No, and tell the assistant what to do differently', selected: false, key: '3' }] };
const MENU = { kind: 'select', hint: 'Pick one', question: 'Pick one', options: [
  { n: null, label: 'Keep the current value', selected: true, key: '\r' },
  { n: null, label: 'Use the new value', selected: false, key: '\x1b[B\r' }] };

guarded('a dialog with readable options is a card: a group named for the session, the question as text, one button per option, the cursor\'s option marked, a way to the real terminal',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    const card = h.cs.dlg as Dn | null;
    if (!card) return false;
    const btns = card.querySelectorAll('.csd-opt');
    return card.getAttribute('role') === 'group' && card.getAttribute('aria-label') === 'chat.skin.dlg.label|chat-qa' && btns.length === 3
      && btns.map((b) => b.querySelector('.csd-n')!.textContent).join(',') === '1,2,3' && btns[0].classList.contains('def') && !btns[1].classList.contains('def')
      && card.querySelector('.csd-q')!.textContent === 'Do you want to proceed?' && card.querySelector('.csd-kind')!.textContent === 'chat.skin.dlg.kind.permission|chat-qa'
      && card.querySelector('.csd-link')!.textContent === 'chat.skin.dlg.viewTerminal' && h.writes.length === 0;
  },
  (src) => src.replace("card.setAttribute('role', 'group');", ''));

guarded('a dialog whose options were not read — absent, empty, or with one key that is not a digit, an arrow or Enter — keeps the terminal strip, exactly as before',
  (src) => {
    const cases: Array<Record<string, unknown>> = [
      { kind: 'permission', hint: 'Do you want to proceed?' },
      { kind: 'permission', hint: 'Do you want to proceed?', options: [] },
      { kind: 'permission', hint: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true, key: '1' }, { n: 2, label: 'No', selected: false, key: 'rm -rf ~\r' }] },
      { kind: 'permission', hint: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true, key: '1' }, { n: 2, label: 42, selected: false, key: '2' }] },
    ];
    return cases.every((c) => {
      const h = dialogHarness(src);
      h.prompt(c);
      return h.cs.dlg === null && h.cs.promptOpts === null && h.cs.promptKind === 'permission' && h.writes.length === 0
        && (h.cs.log as Dn).children.every((n) => !n.classList.contains('cs-dlg'));
    });
  },
  (src) => src.replace("typeof o.key !== 'string' || !CHAT_KEY_OK.test(o.key)) return null;", "typeof o.key !== 'string') return null;"));

test('the layout decides strip or card from ONE rule: a card is drawn, the strip is not, and the other way round', () => {
  const h = dialogHarness();
  h.prompt(PERMISSION);
  assert.equal(h.cs.promptOpts.length, 3);
  assert.ok(h.cs.dlg, 'a card');
  const strip = (): boolean => new Function('cs', `${/const chatSkinCardOn = [^\n]+\nconst chatSkinStrip = [^\n]+/.exec(app)![0]}\nreturn chatSkinStrip(cs);`)(h.cs) as boolean;
  assert.equal(strip(), false, 'a card: the xterm stays hidden');
  h.cs.promptTerm = true;
  assert.equal(strip(), true, '"View in the terminal" brings the real strip');
  h.cs.promptOpts = null; h.cs.promptTerm = false;
  assert.equal(strip(), true, 'no options: the strip');
  h.cs.promptKind = null;
  assert.equal(strip(), false, 'no dialog: neither');
  assert.match(fnBody(skin, 'chatSkinLayout'), /classList\.toggle\('cs-strip', on && chatSkinStrip\(cs\)\)/);
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /chatSkinCardOn\(cs\) \? '' :/, 'a card is its own notice');
});

guarded('a click sends exactly the option\'s key — one write for a digit, one write per piece for arrows and Enter — through the key chokepoint, never as text followed by a CR',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    h.pick(2);                                   // "No, and tell…": key '3'
    h.flush();
    const digit = h.writes.length === 1 && h.writes[0].data === '3' && h.writes[0].id === 7;
    const h2 = dialogHarness(src);
    h2.prompt(MENU);
    h2.pick(1);                                  // an unnumbered menu: arrow down, then Enter, as two writes a moment apart
    h2.flush();
    const arrows = h2.writes.length === 2 && h2.writes[0].data === '\x1b[B' && h2.writes[1].data === '\r' && h2.writes[1].at > h2.writes[0].at;
    return digit && arrows && [...h.writes, ...h2.writes].every((w) => /^(?:\x1b\[[AB]|\r|[0-9])$/.test(w.data));
  },
  (src) => src.replace('  chatSkinSendKey(id, p, o.key);', '  submitToPty(id, o.key);'));

guarded('nothing but a digit, an arrow or Enter can ever come out of the key path, whatever a parser or a hostile screen put in an option',
  (src) => {
    const h = dialogHarness(src);
    const bad = ['rm -rf ~', '1\rrm', '\x1b', '\x1b[2J', 'y', '', '1 ', '\x03'];
    const refused = bad.every((k) => h.sendKey(k) === false);
    const ok = h.sendKey('2') === true && h.sendKey('\x1b[A\r') === true;
    h.flush();
    return refused && ok && h.writes.map((w) => w.data).join('|') === '2|\x1b[A|\r';
  },
  (src) => src.replace("if (typeof key !== 'string' || !CHAT_KEY_OK.test(key)) return false;", "if (typeof key !== 'string') return false;"));

guarded('a double click answers once: the card is used and disabled until the next dialog event; a moved cursor keeps it used but adopts the new keys; a new dialog is a fresh card',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(MENU);
    h.pick(0); h.pick(0); h.pick(1);
    h.flush(1000);
    const once = h.writes.length === 1 && h.writes[0].data === '\r';
    const used = h.cs.promptUsed === true && (h.cs.dlg as Dn).querySelectorAll('.csd-opt').every((b) => b.disabled);
    // the cursor moved in the terminal: the SAME dialog, new keys and a new default — still used, nothing re-enabled, nothing sent
    h.prompt({ ...MENU, refresh: true, options: [{ ...MENU.options[0], selected: false, key: '\x1b[A\r' }, { ...MENU.options[1], selected: true, key: '\r' }] });
    const refreshed = h.cs.promptUsed === true && h.cs.promptOpts[1].key === '\r' && (h.cs.dlg as Dn).querySelectorAll('.csd-opt')[1].classList.contains('def') && h.writes.length === 1;
    // the NEXT dialog (a different question) is a new, enabled card
    h.prompt({ ...PERMISSION });
    const fresh = h.cs.promptUsed === false && (h.cs.dlg as Dn).querySelectorAll('.csd-opt').every((b) => !b.disabled) && (h.cs.dlg as Dn).querySelectorAll('.csd-opt').length === 3;
    return once && used && refreshed && fresh;
  },
  (src) => src.replace('  cs.promptUsed = true;\n  const gen', '  const gen'));

test('a used card whose dialog is still up after a while is re-armed, and one that was answered is not', () => {
  const h = dialogHarness();
  h.prompt(PERMISSION);
  h.pick(0);
  h.flush(2000);
  assert.equal(h.cs.promptUsed, true, 'still used a moment later');
  h.flush(7000);
  assert.equal(h.cs.promptUsed, false, 'the key never landed: the operator can answer again');
  const g = dialogHarness();
  g.prompt(PERMISSION);
  g.pick(0);
  g.prompt({ kind: null });                      // the dialog went away: answered
  g.flush(7000);
  assert.equal(g.cs.dlg, null);
  assert.equal(g.cs.promptUsed, false);
  assert.equal(g.writes.length, 1, 'and nothing was sent a second time');
});

guarded('the card writes NOTHING on its own: drawing it, refreshing its keys, focusing it, a quiet period and the dialog going away send no key',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    h.prompt({ ...PERMISSION, refresh: true });
    h.prompt({ ...MENU });
    h.prompt({ ...MENU, refresh: true });
    h.key({ key: 'ArrowDown' });
    h.key({ key: 'Tab' });
    h.flush();
    h.prompt({ kind: null });
    h.flush();
    return h.writes.length === 0;
  },
  (src) => src.replace("  chatSkinCardSync(cs);\n}\nfunction chatSkinCardBuild", "  chatSkinCardSync(cs);\n  if (cs.promptOpts.some((o) => o.selected) && !cs.promptUsed) chatSkinPick(cs.id, p, cs.promptOpts.findIndex((o) => o.selected));\n}\nfunction chatSkinCardBuild"));

guarded('the keyboard: a digit presses that option (an unnumbered menu counts 1, 2, 3 from the top), arrows move focus, and a chord is left alone',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    h.key({ key: '2' });
    h.flush();
    const digit = h.writes.length === 1 && h.writes[0].data === '2';
    const m = dialogHarness(src);
    m.prompt(MENU);
    m.key({ key: '9' });                        // no option 9
    m.key({ key: '2', ctrlKey: true });         // a chord is not the operator choosing
    m.flush();
    const quiet = m.writes.length === 0;
    m.key({ key: '2' });
    m.flush();
    const byPosition = m.writes.map((w) => w.data).join('|') === '\x1b[B|\r';
    const f = dialogHarness(src);
    f.prompt(PERMISSION);
    const btns = (f.cs.dlg as Dn).querySelectorAll('.csd-opt');
    btns[0].focus();
    f.key({ key: 'ArrowDown' });
    const down = Dn.active === btns[1];
    f.key({ key: 'ArrowUp' }); f.key({ key: 'ArrowUp' });
    const wrap = Dn.active === btns[2];
    return digit && quiet && byPosition && down && wrap && f.writes.length === 0;
  },
  (src) => src.replace('const b = btns.find((x) => x.dataset.num === e.key);', 'const b = btns.find((x) => x.dataset.num === "0");'));

test('an option that asks for typing only gets its key, and the live terminal comes forward so the operator can type', () => {
  const h = dialogHarness();
  h.prompt({ kind: 'question', hint: 'Which?', question: 'Which?', options: [
    { n: null, label: 'The first', selected: true, key: '\r' },
    { n: null, label: 'Type something.', selected: false, key: '\x1b[B', freeText: true }] });
  h.pick(1);
  h.flush();
  assert.deepEqual(h.writes.map((w) => w.data), ['\x1b[B'], 'the arrow only: no Enter, which would submit an empty answer');
  assert.equal(h.cs.promptTerm, true);
  assert.ok(h.calls.includes('term.focus'), 'the xterm takes the focus');
  assert.equal(h.cs.dlg, null, 'the card steps aside for the strip');
  // control: an ordinary option does not bring the terminal
  const g = dialogHarness();
  g.prompt(MENU); g.pick(0);
  assert.equal(g.cs.promptTerm, false);
});

test('"View in the terminal" shows the strip without answering anything, and the way back restores the buttons', () => {
  const h = dialogHarness();
  h.prompt(PERMISSION);
  const link = (h.cs.dlg as Dn).querySelector('.csd-link')!;
  link.click();
  assert.equal(h.cs.promptTerm, true);
  assert.equal(h.writes.length, 0, 'looking is not answering');
  assert.equal(h.cs.dlg, null);
  assert.equal(h.cs.promptOpts.length, 3, 'the options are kept for the way back');
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /cs\.alertBack\.hidden = !\(cs\.promptKind && cs\.promptOpts && cs\.promptTerm\)/);
  assert.match(skin, /alertBack\.addEventListener\('click', \(\) => \{ cs\.promptTerm = false;/);
});

guarded('only chatSkinPick answers a dialog, and only chatSkinSendKey writes its key: no other call site, no timer, no event handler',
  (src) => {
    const s = slice(src);
    const callsOfSend = [...s.matchAll(/chatSkinSendKey\(/g)].length;      // the definition + the one call
    const callsOfPick = [...s.matchAll(/chatSkinPick\(/g)].map((m) => m.index as number);
    const insidePick = fnBody(s, 'chatSkinPick');
    const pickCallers = [fnBody(s, 'chatSkinCardBuild'), fnBody(s, 'chatSkinCardKey')];
    return callsOfSend === 2 && /chatSkinSendKey\(id, p, o\.key\)/.test(insidePick)
      && pickCallers.every((b) => /chatSkinPick\(/.test(b)) && callsOfPick.length === 3   // the definition + the click handler + the digit key
      && !/chatSkinPick\(/.test(fnBody(s, 'chatSkinPrompt')) && !/chatSkinPick\(/.test(fnBody(s, 'chatSkinCardPaint')) && !/chatSkinPick\(/.test(fnBody(s, 'chatSkinHandleEvent'));
  },
  (src) => src.replace('function chatSkinPrompt(id, p, ev) {\n  const cs = p.chatSkin;', 'function chatSkinPrompt(id, p, ev) {\n  const cs = p.chatSkin;\n  if (ev.auto) chatSkinPick(id, p, 0);'));

test('dialog cards: every string is a locale key with the session\'s name in it where a name appears, in en, es and pt-br', () => {
  const kinds = ['permission', 'trust', 'select', 'question', 'model', 'other'];
  const keys = [...skin.matchAll(/\bt\('(chat\.skin\.dlg\.[\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'));
  for (const k of kinds) keys.push(`chat.skin.dlg.kind.${k}`);
  keys.push('chat.skin.needsYouHere');
  assert.ok(new Set(keys).size >= 12, `found ${new Set(keys).size} keys`);
  for (const l of Object.keys(loc)) for (const k of new Set(keys)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  for (const l of Object.keys(loc)) for (const k of ['chat.skin.dlg.label', 'chat.skin.needsYouHere', ...kinds.map((x) => `chat.skin.dlg.kind.${x}`)]) {
    assert.match(loc[l][k], /\{name\}/, `${l} ${k} names the session`);
    assert.doesNotMatch(loc[l][k], /Claude/, `${l} ${k} must not hardcode the product name`);
  }
  assert.match(fnBody(skin, 'chatSkinCardBuild'), /t\('chat\.skin\.dlg\.label', \{ name: who \}\)/);
  assert.match(fnBody(skin, 'chatSkinCardBuild'), /const who = chatSkinWho\(p\)/);
  // control: a locale that dropped the name is caught by the same pattern
  assert.doesNotMatch('Asks for permission', /\{name\}/);
});

test('the dialog card is the house component set: blue (--st-input), a neutral default, no coral, a hover and a focus ring, and nothing minted in the card\'s own rules', () => {
  const all = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const card = /\.cs-dlg \{[^}]*\}/.exec(all)?.[0] ?? '';
  assert.match(card, /--sc: var\(--st-input\)/);
  assert.doesNotMatch(card, /--accent/);
  for (const sel of ['.csd-opt', '.csd-opt.def', '.csd-opt:hover:not(:disabled)', '.csd-opt:disabled', '.csd-opt:focus-visible', '.csd-link']) {
    const r = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`).exec(all)?.[0] ?? '';
    assert.ok(r, `${sel} is styled`);
    assert.doesNotMatch(r, /--accent|#[0-9a-fA-F]{3,8}\b/, `${sel}: no coral, no hex`);
  }
  assert.match(all, /\.csd-opt:focus-visible \{ outline: 2px solid var\(--chat-focus\)/);
  assert.match(all, /@media \(prefers-reduced-motion: reduce\) \{ \.csd-opt \{ transition: none; \} \}/);
});

test('main forwards what the parser read of a dialog — the question and the options with their keys — bounded, and marks a moved cursor as a refresh, not a new dialog', () => {
  const w = /ipcMain\.handle\('chatSkin:watch'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  const wire = /function promptWire\([\s\S]*?\n\}/.exec(main)?.[0] ?? '';
  assert.match(w, /onChange: \(kind, hint, prompt\) => send\(\{ type: 'prompt', kind, \.\.\.\(hint \? \{ hint \} : \{\}\), \.\.\.promptWire\(prompt\) \}\)/);
  assert.match(w, /onRefresh: \(prompt\) => send\(\{ type: 'prompt', kind: prompt\.kind,[^\n]*\.\.\.promptWire\(prompt\), refresh: true \}\)/);
  assert.match(wire, /\.slice\(0, 12\)/, 'at most a dozen rows');
  assert.match(wire, /label: String\(o\.label\)\.slice\(0, 200\)/);
  assert.match(wire, /prompt\.question\.slice\(0, 300\)/);
  assert.match(wire, /key: o\.key/, 'the key is the parser\'s, passed through untouched');
  assert.doesNotMatch(wire, /key: [^o]|o\.key\s*[+=]/, 'main never edits or invents a key');
  // a `null` dialog carries no options at all (nothing to draw once it is gone)
  assert.match(wire, /if \(!prompt\) return \{\}/);
  assert.match(preload, /\| \{ type: 'prompt'; kind: TuiPromptKind \| null; hint\?: string; question\?: string; options\?: TuiOption\[\]; refresh\?: boolean \}/);
});

test('chat-shot fixture: the permission card, the menu cards, the used card, the narrow card and the strip-with-a-way-back are shot in dark and light, from neutral, hand-written events', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['dialog-permission-dark', 'dialog-permission-light', 'dialog-menu-dark', 'dialog-menu-light',
    'dialog-question-dark', 'dialog-question-light', 'dialog-permission-used-dark', 'dialog-terminal-dark', 'dialog-narrow-dark', 'dialog-narrow-light']) assert.ok(byName(n), `missing shot ${n}`);
  // every dialog event carries options whose keys are what the renderer will accept (a digit, an arrow, Enter)
  for (const n of ['permission-card', 'menu-card', 'question-card']) {
    const pr = fixture.streams[n].find((e) => e.type === 'prompt') as FxEvent & { options: Array<{ label: string; key: string; selected: boolean }> };
    assert.ok(pr && pr.options.length >= 3, `${n} has its options`);
    assert.equal(pr.options.filter((o) => o.selected).length, 1, `${n}: one default`);
    for (const o of pr.options) assert.match(o.key, /^(?:\x1b\[[AB]|\r|[0-9])+$/, `${n}: ${o.label} has a key the card accepts`);
  }
  assert.ok(fixture.streams['question-card'].some((e) => e.type === 'prompt' && (e.options as Array<{ freeText?: boolean }>).some((o) => o.freeText)), 'a typing option is shown too');
  // the harness only feeds the skin: no shot clicks an option (that would write to the cat behind the pane)
  for (const s of fixture.shots) assert.doesNotMatch([s.js].flat().join('\n'), /csd-opt[^\n]*click\(|chatSkinPick\(|ptyWrite/, `${s.name} must not answer a dialog`);
  assert.match([byName('dialog-terminal-dark')?.js].flat().join('\n'), /\.csd-link'\)\.click\(\)/);
});


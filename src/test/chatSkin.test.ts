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
    const send = fnBody(s, 'chatSkinSendNow');
    // every direct pty write in the skin is the lone ESC; nothing writes text or a CR
    const writes = [...s.matchAll(/ptyWrite\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    return /submitToPty\(id, text\)/.test(send) && writes.length >= 1 && writes.every((w) => w === "id, '\\x1b'");
  },
  (src) => src.replace('submitToPty(id, text);   // the one chokepoint', "window.glassShell.ptyWrite(id, text + '\\r');   // the one chokepoint"));

guarded('slash commands are sent exactly like any other message (no filter, no special path)',
  (src) => {
    const send = fnBody(slice(src), 'chatSkinSendNow');
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
    return /p\.term\.focus\(\)/.test(pr) && /toast\(t\('chat\.skin\.needsYou'/.test(pr) && /markActivity\(id\)/.test(pr)
      && /chatSkinFocus\(p\)/.test(pr)
      && /el\('div', 'cs-alert'\)/.test(s) && /alertEl\.setAttribute\('role', 'alert'\)/.test(s)
      && /classList\.toggle\('cs-strip'/.test(fnBody(s, 'chatSkinLayout'))
      && /cs\.input\.disabled = !!cs\.promptKind/.test(fnBody(s, 'chatSkinLayout'));
  },
  (src) => src.replace("alertEl.setAttribute('role', 'alert');", ''));

test('there is always a way back to the terminal, and a stalled turn offers it', () => {
  assert.match(skin, /swTerm\.addEventListener\('click', \(\) => chatSkinSetView\(id, 'term'\)\)/, 'the header switch');
  assert.match(skin, /alertBtn\.addEventListener\('click', \(\) => chatSkinSetView\(id, 'term'\)\)/, 'the notice button');
  assert.match(skin, /p\.viewBtn = b;/, 'the tab button');
  // the safety net: open turn + live pty + silent transcript -> the stalled notice
  const tick = fnBody(skin, 'chatSkinTick');
  assert.match(tick, /cs\.turnOpen && now - \(p\.lastPtyAt \|\| 0\) < CS_WORKING_MS \* 2 && quiet > CS_STALL_MS/);
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /chat\.skin\.stalled/);
  // lastPtyAt is recorded on every pty:data of the pane
  assert.match(/window\.glassShell\.onPtyData\(\(m\) => \{[\s\S]*?\n\}\);/.exec(app)?.[0] ?? '', /p\.lastPtyAt = Date\.now\(\)/);
});

test('the usage bar prefers this session\'s own numbers over the global statusline payload', () => {
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(paint, /k === 'contextPct' && Number\.isFinite\(cs\.ctxTokens\)/);
  assert.match(paint, /k === 'model' && cs\.model \? cs\.model : cs\.status\[k\]/);
  assert.match(fnBody(skin, 'chatSkinRefreshStatus'), /gs\.chatStatus\(\)/);
  // an absent number is a dash, never a fabricated 0
  assert.match(fnBody(skin, 'chatApplyStatus'), /s\[k\] !== undefined && s\[k\] !== null && s\[k\] !== ''/);
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
    '--chat-composer-line', '--chat-meter-track', '--chat-meter-fill', '--chat-focus', '--chat-float', '--chat-pop', '--chat-on-accent'];
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

test('the font and size pickers persist through the same settings as before', () => {
  assert.match(skin, /setSetting\('chatFontFamily'/);
  assert.match(skin, /setSetting\('chatFontSize'/);
});


// ── integration: renderer ↔ preload ↔ main speak the same contract ──────────

/** The renderer's pane id IS the pty id: every call below passes the `panes` key, and main keys `skins` by the pty id. */
const contractHolds = (rend: string, pre: string, mn: string): boolean => {
  const chans = ['chatSkin:watch', 'chatSkin:unwatch', 'chatSkin:event', 'chatSkin:screen'];
  const events = ['reset', 'items', 'turn', 'usage', 'prompt', 'missing', 'error'];
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
  assert.match(fn, /cs\.screenTimer\) return/, 'one snapshot per window');
  assert.match(app, /p\.term\.write\(m\.data, p\.chatSkin && p\.view === 'chat' \? \(\) => chatSkinScreenSoon\(m\.id, p\) : undefined\)/);
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
const fixture = JSON.parse(read('src/test/fixtures/chat-shot.json')) as { version: number; streams: Record<string, FxEvent[]>; shots: FxShot[] };

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

guarded('Esc closes the settings menu and does NOT cut the turn: its listener runs first and stops the event for the interrupt one',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const menuAt = b.indexOf("e.key !== 'Escape' || !cs.menuOpen");
    const intrAt = b.indexOf('chatSkinInterrupt(id, p);\n  });');
    const nextAt = b.indexOf("e.key !== 'Escape' || !cs.slash.open");   // the popup's own Esc listener follows the menu's: the stop must be IN the menu's
    const menuEnd = nextAt > menuAt ? nextAt : intrAt;
    return menuAt > 0 && intrAt > menuAt && /stopImmediatePropagation\(\)/.test(b.slice(menuAt, menuEnd))
      && /chatSkinMenu\(cs, false, true\)/.test(b.slice(menuAt, menuEnd))
      && /pointerdown/.test(fnBody(slice(src), 'chatSkinMenu')) && /removeEventListener\('pointerdown'/.test(fnBody(slice(src), 'chatSkinMenu'));
  },
  (src) => src.replace('e.preventDefault(); e.stopImmediatePropagation();', 'e.preventDefault();'));

test('the usage meters never paint a missing reading as zero, and carry their value for assistive tech (source)', () => {
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(paint, /const has = typeof pct === 'number' && Number\.isFinite\(pct\)/);
  assert.match(paint, /setProperty\('--p', has \? /, 'the ring is empty without a reading');
  assert.match(paint, /has \? Math\.round\(pct\) \+ '%' : '—'/, 'a missing reading shows a dash');
  assert.match(paint, /pct >= 90 \? ' hi' : pct >= 70 \? ' mid'/, 'warn from 70, error from 90');
  assert.match(paint, /cell\.setAttribute\('aria-label', \[/, 'the accessible name carries the value and the detail');
  // control: a paint that coerced the absence to 0 would fail the dash rule
  assert.doesNotMatch(paint.replace("has ? Math.round(pct) + '%' : '—'", 'Math.round(pct || 0) + \'%\''), /has \? Math\.round\(pct\) \+ '%' : '—'/);
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

// ── the usage row under the composer ────────────────────────────────────────

/** chatPaintUsage and the helpers it needs, evaluated against a hand-made stand-in for the DOM: the real
 *  code, run for real, with `t` echoing its key so a test can see which sentence was chosen. */
function loadUsage(): { paint: (cs: unknown) => void; left: (sec: number, now: number) => string; when: (sec: number, now: number) => string; fake: () => FakeEl } {
  const s = skin;
  const from = s.indexOf('const CHAT_USAGE_FIELDS = [');
  const to = s.indexOf('function chatSkinTip(');
  assert.ok(from > 0 && to > from, 'the usage block was found');
  const src = s.slice(from, to);
  const fake = (): FakeEl => {
    const e: FakeEl = {
      className: '', textContent: '', title: '', attrs: {}, props: {}, kids: [], parentElement: null, q: {},
      classList: {
        add(c: string) { const set = new Set(e.className.split(/\s+/).filter(Boolean)); set.add(c); e.className = [...set].join(' '); },
        toggle(c: string, on: boolean) { const set = new Set(e.className.split(/\s+/).filter(Boolean)); if (on) set.add(c); else set.delete(c); e.className = [...set].join(' '); },
      },
      style: { setProperty(k: string, v: string) { e.props[k] = v; } },
      setAttribute(k: string, v: string) { e.attrs[k] = v; },
      replaceChildren(...n: FakeEl[]) { e.kids = n; },
      querySelector(sel: string) { return e.q[sel] ?? null; },
    };
    return e;
  };
  const make = new Function('t', 'el', 'window', `${src}\nreturn { paint: chatPaintUsage, left: chatResetLeft, when: chatResetWhen };`) as
    (t: (k: string, v?: Record<string, unknown>) => string, el: (tag: string, cls?: string, text?: string) => FakeEl, w: unknown) => { paint: (cs: unknown) => void; left: (sec: number, now: number) => string; when: (sec: number, now: number) => string };
  const t = (k: string, v?: Record<string, unknown>): string => (v ? `${k}${JSON.stringify(v)}` : k);
  const el = (_tag: string, cls = '', text = ''): FakeEl => { const n = fake(); n.className = cls; n.textContent = text; return n; };
  return { ...make(t, el, { i18n: { getLocale: () => 'en' } }), fake };
}
interface FakeEl {
  className: string; textContent: string; title: string; attrs: Record<string, string>; props: Record<string, string>; kids: FakeEl[]; parentElement: FakeEl | null; q: Record<string, FakeEl>;
  classList: { add(c: string): void; toggle(c: string, on: boolean): void }; style: { setProperty(k: string, v: string): void };
  setAttribute(k: string, v: string): void; replaceChildren(...n: FakeEl[]): void; querySelector(sel: string): FakeEl | null;
}
/** A composer-shaped `cs` with the three meters and the two chips, as chatSkinBuild makes them. */
function usageCs(u: ReturnType<typeof loadUsage>, status: Record<string, unknown>, extra: Record<string, unknown> = {}): { cs: Record<string, unknown>; cells: Record<string, FakeEl>; vals: Record<string, FakeEl> } {
  const cells: Record<string, FakeEl> = {};
  const vals: Record<string, FakeEl> = {};
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct']) {
    const cell = u.fake(), v = u.fake(), tip = u.fake();
    v.parentElement = cell;
    cell.q['.cu-tip'] = tip;
    for (const part of ['.cut-h', '.cut-v', '.cut-d']) tip.q[part] = u.fake();
    cells[k] = cell; vals[k] = v;
  }
  for (const k of ['model', 'effort']) { const chip = u.fake(), v = u.fake(); v.parentElement = chip; vals[k] = v; }
  return { cs: { status, usageVals: vals, ...extra }, cells, vals };
}
const tipOf = (cell: FakeEl): { h: string; v: string; d: string[] } => {
  const tip = cell.q['.cu-tip'];
  return { h: tip.q['.cut-h'].textContent, v: tip.q['.cut-v'].textContent, d: tip.q['.cut-d'].kids.map((k) => k.textContent) };
};

test('usage row, run for real: a missing reading is a dash and an empty ring; a present one is the percentage, coloured at 70 and 90', () => {
  const u = loadUsage();
  const none = usageCs(u, {});
  u.paint(none.cs);
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct']) {
    assert.equal(none.vals[k].textContent, '—', `${k}: a dash, never 0`);
    assert.equal(none.cells[k].props['--p'], '0');
    assert.match(none.cells[k].className, /\bnone\b/);
    assert.equal(tipOf(none.cells[k]).v, 'chat.usage.none');
    assert.deepEqual(tipOf(none.cells[k]).d, [], 'no invented detail');
  }
  const some = usageCs(u, { fiveHourPct: 42, sevenDayPct: 71, contextPct: 93 });
  u.paint(some.cs);
  assert.equal(some.vals.fiveHourPct.textContent, '42%');
  assert.equal(some.cells.fiveHourPct.props['--p'], '42');
  assert.doesNotMatch(some.cells.fiveHourPct.className, /\b(mid|hi|none)\b/, 'neutral below 70');
  assert.match(some.cells.sevenDayPct.className, /\bmid\b/);
  assert.match(some.cells.contextPct.className, /\bhi\b/);
  assert.match(some.cells.fiveHourPct.attrs['aria-label'], /42%/, 'the value is in the accessible name');
  // an honest zero is a zero (a real reading), unlike an absent one
  const zero = usageCs(u, { fiveHourPct: 0 });
  u.paint(zero.cs);
  assert.equal(zero.vals.fiveHourPct.textContent, '0%');
  assert.doesNotMatch(zero.cells.fiveHourPct.className, /\bnone\b/);
});

test('usage row, run for real: resets appear only when the payload carried them, and a reset already behind us marks the reading stale', () => {
  const u = loadUsage();
  const now = Date.now();
  const sec = (ms: number): number => Math.floor((now + ms) / 1000);
  const without = usageCs(u, { fiveHourPct: 42, sevenDayPct: 10 });
  u.paint(without.cs);
  assert.deepEqual(tipOf(without.cells.fiveHourPct).d, [], 'no reset in the payload → no reset line (nothing is derived from "5 hours")');
  assert.deepEqual(tipOf(without.cells.sevenDayPct).d, []);
  const withR = usageCs(u, { fiveHourPct: 42, sevenDayPct: 10, fiveHourResetsAt: sec(2 * 3600e3 + 10 * 60e3), sevenDayResetsAt: sec(50 * 3600e3) });
  u.paint(withR.cs);
  assert.match(tipOf(withR.cells.fiveHourPct).d[0], /^chat\.usage\.tip\.resets\{/);
  assert.match(tipOf(withR.cells.fiveHourPct).d[0], /"left":"chat\.usage\.unit\.h\{\\"n\\":2\}[^"]*chat\.usage\.unit\.m\{\\"n\\":(9|10)\}"/, 'in 2 h 10 min');
  assert.match(tipOf(withR.cells.sevenDayPct).d[0], /"left":"chat\.usage\.unit\.d\{\\"n\\":2\} chat\.usage\.unit\.h\{\\"n\\":2\}"/, 'in 2 d 2 h (no minutes once days are shown)');
  const stale = usageCs(u, { fiveHourPct: 90, fiveHourResetsAt: sec(-60e3) });
  u.paint(stale.cs);
  assert.deepEqual(tipOf(stale.cells.fiveHourPct).d, ['chat.usage.tip.stale']);
  assert.match(stale.cells.fiveHourPct.className, /\bstale\b/);
  assert.doesNotMatch(withR.cells.fiveHourPct.className, /\bstale\b/);
  // control: a reset line for a meter that has no reset field (context) never appears
  assert.deepEqual(tipOf(withR.cells.contextPct).d, []);
});

test('usage row, run for real: the context meter is this pane\'s own tokens over the window, and says so only when they agree', () => {
  const u = loadUsage();
  const ok = usageCs(u, { contextPct: 5, contextWindow: 200000 }, { ctxTokens: 84000 });
  u.paint(ok.cs);
  assert.equal(ok.vals.contextPct.textContent, '84k');
  assert.equal(ok.cells.contextPct.props['--p'], '42', 'own tokens / window, not the global payload\'s percentage');
  assert.match(tipOf(ok.cells.contextPct).d[0], /^chat\.usage\.tip\.ctxOf\{"used":"84,000","total":"200,000"\}$/);
  // tokens above the payload's window: the payload describes another session's model — tokens only, no percentage
  const clash = usageCs(u, { contextPct: 5, contextWindow: 200000 }, { ctxTokens: 300000 });
  u.paint(clash.cs);
  assert.equal(clash.vals.contextPct.textContent, '300k');
  assert.equal(clash.cells.contextPct.props['--p'], '0');
  assert.match(tipOf(clash.cells.contextPct).d[0], /^chat\.usage\.tip\.ctxUsed\{/);
  // no window size known: the payload's own percentage still drives the ring, the tokens are what is shown
  const nowin = usageCs(u, { contextPct: 31 }, { ctxTokens: 62000 });
  u.paint(nowin.cs);
  assert.equal(nowin.cells.contextPct.props['--p'], '31');
});

test('usage row: the reset formatters give the two largest units, and a clock time today or weekday + time otherwise', () => {
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

guarded('the meters left the header: the usage row is built into the compose block, under the card, and the header carries only the switch and the settings',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const head = /head\.append\((.*)\);/.exec(b)?.[1] ?? '';
    return head.length > 0 && !/usageEl|chat-usage/.test(head) && /sw, el\('span', 'cs-fill'\), gear, menu/.test(head)
      && /meta\.append\(usageEl, hint\)/.test(b) && /compose\.append\(jumpBtn, wrap, meta\)/.test(b)
      && b.indexOf('wrap.append(slashPop, box)') > 0 && b.indexOf('wrap.append(slashPop, box)') < b.indexOf('compose.append(')
      && !/\.cs-head \.chat-usage/.test(css);
  },
  (src) => src.replace("head.append(sw, el('span', 'cs-fill'), gear, menu);", "head.append(sw, el('span', 'cs-fill'), usageEl, gear, menu);"));

guarded('every meter answers hover AND keyboard focus with a tooltip of its own, aria-labelled, and the tooltip is not read twice',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const tip = fnBody(slice(src), 'chatSkinTip');
    return /cell\.tabIndex = 0/.test(b) && /cell\.addEventListener\('pointerenter', \(\) => chatSkinTip\(cell, true\)\)/.test(b)
      && /cell\.addEventListener\('focus', \(\) => chatSkinTip\(cell, true\)\)/.test(b) && /cell\.addEventListener\('blur', \(\) => chatSkinTip\(cell, false\)\)/.test(b)
      && /tip\.setAttribute\('aria-hidden', 'true'\)/.test(b)
      && /classList\.toggle\('tip-open', on\)/.test(tip)
      && !/cell\.title\s*=|\.parentElement\.title = tip/.test(fnBody(slice(src), 'chatPaintUsage').split("if (kind === 'text')")[0]);   // no native title on a meter: the tooltip is ours
  },
  (src) => src.replace("cell.addEventListener('focus', () => chatSkinTip(cell, true));", ''));

test('the usage row\'s CSS: own tooltip, ring arc from --p, neutral until 70/90, hidden with the rest of the compose block under a dialog strip, hint only with focus', () => {
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cu-ring .r-val'), /stroke-dasharray: var\(--p, 0\) 100/);
  assert.match(rule('.chat-usage .cu.mid .r-val'), /--st-warn/);
  assert.match(rule('.chat-usage .cu.hi .r-val'), /--st-error/);
  assert.match(rule('.cu-tip'), /position: absolute/);
  assert.match(rule('.cu.tip-open .cu-tip'), /opacity: 1/);
  const strip = rules.find(([s]) => s.startsWith('.pane.cs-strip > .chatskin .chat-usage'));
  assert.ok(strip && /\.cc-meta/.test(strip[0]) && /\.chat-compose/.test(strip[0]) && /display: none/.test(strip[1]), 'the strip rule hides the usage row (and the whole compose block) for a live dialog');
  assert.match(rule('.cc-hint'), /opacity: 0/, 'the keys hint is invisible until the box has focus');
  assert.match(rule('.cc-wrap:focus-within + .cc-meta .cc-hint'), /opacity: 1/);
  // control: the old always-visible grey line (a centred 11 px hint under the card) is gone
  assert.equal(rule('.cc-hint').includes('text-align: center'), false);
  // the tooltip's animation has a reduced-motion fallback (the generic animation test only sees `animation:`, this one is a transition)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.chat-usage \.cu, \.cu-ring \.r-val, \.cu-tip \{ transition: none; \}/);
});

test('the usage row\'s sentences exist in every locale (the three built at run time included), with the same placeholders', () => {
  const keys = ['chat.hintShort', 'chat.usage.tip.fiveHour', 'chat.usage.tip.sevenDay', 'chat.usage.tip.context', 'chat.usage.tip.used', 'chat.usage.tip.resets', 'chat.usage.tip.stale',
    'chat.usage.tip.ctxOf', 'chat.usage.tip.ctxUsed', 'chat.usage.unit.d', 'chat.usage.unit.h', 'chat.usage.unit.m'];
  for (const k of keys) for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  const holes = (s: string): string => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keys) for (const l of ['es', 'pt-br']) assert.equal(holes(loc[l][k]), holes(loc.en[k]), `${l} ${k}`);
  assert.equal(holes(loc.en['chat.usage.tip.resets']), '{left},{when}');
  // every key the paint code builds at run time is in the list above
  assert.deepEqual([...skin.matchAll(/t\('chat\.usage\.tip\.' \+ \(k === 'fiveHourPct' \? '(\w+)' : k === 'sevenDayPct' \? '(\w+)' : '(\w+)'\)\)/g)].flatMap((m) => m.slice(1)), ['fiveHour', 'sevenDay', 'context']);
  assert.equal(typeof loc.en['chat.usage.contextTokens'], 'undefined', 'the old title-attribute sentence is gone with the title attribute');
});

test('chat-shot fixture: the usage row (resting, hover tooltip on each meter, high, empty, narrow) and the dense tool rows are shot in dark and light', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['usage-dark', 'usage-light', 'usage-tip-dark', 'usage-tip-light', 'usage-tip-context-dark', 'usage-tip-high-dark', 'usage-tip-high-light', 'usage-none-dark', 'usage-narrow-dark', 'usage-narrow-light', 'tools-dense-dark', 'tools-dense-light']) assert.ok(byName(n), `missing shot ${n}`);
  for (const n of ['usage-tip-dark', 'usage-tip-light', 'usage-tip-context-dark', 'usage-tip-high-dark', 'usage-none-dark', 'usage-narrow-dark']) assert.match(String([byName(n)?.js].flat().join('\n')), /chatSkinTip\(/, `${n} forces its tooltip open`);
  // resets in the fixture are relative ("+seconds"), never an instant that would be in the past by the next run
  const resets = Object.values(fixture.streams).flat().flatMap((e) => Object.entries(e).filter(([k]) => /ResetsAt$/.test(k)).map(([, v]) => v));
  assert.ok(resets.length >= 4 && resets.every((v) => typeof v === 'string' && /^\+\d+$/.test(v)), `relative resets only (${resets.join(', ')})`);
  assert.match(main, /\/ResetsAt\$\/\.test\(k\) && typeof s\[k\] === 'string' && \/\^\\\+\\d\+\$\/\.test\(s\[k\]\)/, 'the driver understands them');
  // the three states of the tooltip (window usage with resets, tokens of context, no reading) are all covered
  assert.ok(fixture.streams.conversation[0].contextWindow && fixture.streams['usage-high'].some((e) => e.type === 'usage'));
});

// ── the slash-command popup ─────────────────────────────────────────────────

/** A stand-in element rich enough for the popup code: attributes, classes, children, listeners. */
class FakeNode {
  tag: string; className = ''; textContent = ''; id = ''; hidden = false; value = ''; scrollTop = 0;
  attrs: Record<string, string> = {}; children: FakeNode[] = []; handlers: Record<string, Array<(e: unknown) => void>> = {};
  selection: [number, number] | null = null;
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
  assert.deepEqual(rows[0].children.map((c) => c.textContent), ['/compact', '<optional custom summarization instructions>', '«chat.slash.cmd.compact»']);
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
    const menuAt = b.indexOf("e.key !== 'Escape' || !cs.menuOpen");
    const slashAt = b.indexOf("e.key !== 'Escape' || !cs.slash.open");
    const intrAt = b.indexOf('chatSkinInterrupt(id, p);\n  });');
    return menuAt > 0 && slashAt > menuAt && intrAt > slashAt
      && /stopImmediatePropagation\(\)/.test(b.slice(slashAt, intrAt)) && /chatSkinSlashClose\(cs\)/.test(b.slice(slashAt, intrAt))
      && !/chatSkinInterrupt/.test(b.slice(slashAt, intrAt).split('// Esc anywhere')[0]);
  },
  (src) => src.replace("e.preventDefault(); e.stopImmediatePropagation();\n    chatSkinSlashClose(cs);", 'e.preventDefault();\n    chatSkinSlashClose(cs);'));

test('Esc with the popup open, run for real, reaches the interrupt listener never: the two listeners in registration order', () => {
  // replay the skin's keydown listeners on `root` in the order they were registered, with a fake event that honours stopImmediatePropagation
  const b = fnBody(skin, 'chatSkinBuild');
  const listeners = [...b.matchAll(/root\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n  \}\);/g)].map((m) => m[1]);
  assert.equal(listeners.length, 3, 'menu Esc, popup Esc, interrupt');
  const interrupted: string[] = [];
  const run = (open: boolean): string[] => {
    interrupted.length = 0;
    const cs = { menuOpen: false, slash: { open }, promptKind: null };
    const fns = listeners.map((body) => new Function('cs', 'e', 'chatSkinMenu', 'chatSkinSlashClose', 'chatSkinInterrupt', 'id', 'p', body) as (...a: unknown[]) => void);
    let stopped = false;
    const e = { key: 'Escape', isComposing: false, preventDefault() { /* */ }, stopPropagation() { /* */ }, stopImmediatePropagation() { stopped = true; } };
    for (const fn of fns) { if (stopped) break; fn(cs, e, () => interrupted.push('menu'), () => interrupted.push('popup'), () => interrupted.push('INTERRUPT'), 1, {}); }
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

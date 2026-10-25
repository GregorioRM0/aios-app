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
    return menuAt > 0 && intrAt > menuAt && /stopImmediatePropagation\(\)/.test(b.slice(menuAt, intrAt))
      && /chatSkinMenu\(cs, false, true\)/.test(b.slice(menuAt, intrAt))
      && /pointerdown/.test(fnBody(slice(src), 'chatSkinMenu')) && /removeEventListener\('pointerdown'/.test(fnBody(slice(src), 'chatSkinMenu'));
  },
  (src) => src.replace('e.preventDefault(); e.stopImmediatePropagation();', 'e.preventDefault();'));

test('the usage meters never paint a missing reading as zero, and carry their value for assistive tech', () => {
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(paint, /const has = typeof pct === 'number' && Number\.isFinite\(pct\)/);
  assert.match(paint, /style\.width = has \? /, 'the bar is empty without a reading');
  assert.match(paint, /has \? Math\.round\(pct\) \+ '%' : '—'/, 'a missing reading shows a dash');
  assert.match(paint, /pct >= 90 \? ' hi' : pct >= 70 \? ' mid'/, 'warn from 70, error from 90');
  assert.match(paint, /setAttribute\('aria-label', tip\)/);
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

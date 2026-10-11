/**
 * 0.11.0 — behaviour the operator and the release brief asked for, run against the real code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');

test('AI-193: there is one renderer, and no stale twin at the repo root for a grep to land in', () => {
  /* An 8,071-line copy of renderer/app.js sat at the repo root, referenced by nothing and never
     packaged. A grep-driven fix could land in it and pass review while the App stayed unchanged. */
  assert.ok(!fs.existsSync(path.join(ROOT, 'app.js')), 'repo-root app.js is back — the renderer is renderer/app.js');
  assert.match(fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8'), /<script src="app\.js"><\/script>/,
    'index.html loads app.js relative to renderer/');
});

import { withDefaultLocale, DEFAULT_TERM_LANG } from '../main/termLocale';

test('AI-191: a terminal with no locale gets a UTF-8 one; an operator locale is never overridden', () => {
  assert.equal(withDefaultLocale({ PATH: '/bin' }, 'darwin').LANG, DEFAULT_TERM_LANG, 'Dock-launched App: no locale at all');
  assert.equal(withDefaultLocale({ PATH: '/bin' }, 'linux').LANG, DEFAULT_TERM_LANG);
  assert.equal(withDefaultLocale({ LANG: 'es_MX.UTF-8' }, 'darwin').LANG, 'es_MX.UTF-8', 'the operator wins');
  assert.equal(withDefaultLocale({ LC_ALL: 'pt_BR.UTF-8' }, 'darwin').LANG, undefined, 'LC_ALL already decides; add nothing');
  assert.equal(withDefaultLocale({ LC_CTYPE: 'UTF-8' }, 'darwin').LANG, undefined);
  assert.equal(withDefaultLocale({}, 'win32').LANG, undefined, 'Windows has no POSIX locale');
  assert.match(DEFAULT_TERM_LANG, /UTF-8$/);
});

test('AI-191: every App terminal goes through the locale default', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /function termEnv\([^)]*\)[^{]*\{\s*const env: Record<string, string> = withDefaultLocale\(\{ \.\.\.\(process\.env/);
});

test('AI-191: pbcopy really needs it (macOS only) — with the default, a UTF-8 arrow round-trips', { skip: process.platform !== 'darwin' ? 'macOS pasteboard' : false }, () => {
  /* The measured mechanism, kept as a live check: pbcopy decodes stdin by the process locale. */
  const cp = require('child_process') as typeof import('child_process');
  let saved = '';
  try { saved = cp.execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' }); } catch { return; }   // no pasteboard (CI, ssh)
  const text = 'a→b — á';
  try {
    cp.execFileSync('/usr/bin/pbcopy', { input: text, env: withDefaultLocale({ PATH: '/usr/bin:/bin' }, 'darwin') });
    assert.equal(cp.execFileSync('/usr/bin/pbpaste', { encoding: 'utf8', env: { LANG: 'C.UTF-8' } }), text);
  } finally {
    cp.execFileSync('/usr/bin/pbcopy', { input: saved, env: { LANG: 'C.UTF-8' } });
  }
});

import * as os from 'node:os';
import * as aios from '../main/aios';

function withHome(fn: (home: string) => Promise<void> | void) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-pat-home-'));
    const saved = { h: process.env.HOME, u: process.env.USERPROFILE };
    process.env.HOME = home; process.env.USERPROFILE = home;
    try { await fn(home); } finally {
      if (saved.h === undefined) delete process.env.HOME; else process.env.HOME = saved.h;
      if (saved.u === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.u;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };
}

test('#50: a token GitHub accepts leaves a marker (a timestamp, never the token); a refused one leaves none', withHome(async () => {
  assert.equal(await aios.verifyGitHubPat('ghp_refused', async () => 401), false);
  assert.ok(!fs.existsSync(aios.githubPatMarker()));
  assert.equal(await aios.verifyGitHubPat('ghp_offline', () => Promise.reject(new Error('ENOTFOUND'))), false);
  assert.ok(!fs.existsSync(aios.githubPatMarker()));
  assert.equal(await aios.verifyGitHubPat('ghp_good', async () => 200), true);
  const mark = fs.readFileSync(aios.githubPatMarker(), 'utf8');
  assert.doesNotMatch(mark, /ghp_/, 'the marker never holds the token');
}));

test('#50: the gh probe passes on the marker, so a Mac whose token lives in Keychain can finish setup', { skip: process.platform === 'win32' }, withHome((home) => {
  const cp = require('child_process') as typeof import('child_process');
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-nogh-'));   // no gh at all
  const probe = () => cp.execFileSync('/bin/sh', ['-c', aios.GH_PROBE_POSIX], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } }).trim();
  assert.equal(probe(), 'NOGH', 'control: no gh, no token');
  fs.mkdirSync(path.join(home, '.aios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aios', 'github-pat-verified'), '2026-10-11T00:00:00Z\n');
  assert.equal(probe(), 'PATOK');
}));

test('#50: the token lane tells a refused token apart from a stored one, in every locale', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.match(app, /res === 'verified' \? t\('onboarding\.patStored'\) : res === 'unverified' \? t\('onboarding\.patRejected'\)/);
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.json`), 'utf8'));
    assert.ok(d['onboarding.patRejected'], `${loc} has patRejected`);
  }
});

import { resolvedTheme, WINDOW_BG } from '../core/theme';

test('AI-190: with no pick the theme follows the OS; a pick is kept; garbage means "follow the OS"', () => {
  assert.equal(resolvedTheme('system', false), 'light', 'light Mac, never touched → light first frame');
  assert.equal(resolvedTheme('system', true), 'dark');
  assert.equal(resolvedTheme('dark', false), 'dark', 'an explicit pick survives a light OS');
  assert.equal(resolvedTheme('light', true), 'light');
  assert.equal(resolvedTheme('', false), 'light');
});

test('AI-190: an absent or unknown stored theme normalises to "system"; light/dark are kept (no migration)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'aios.ts'), 'utf8');
  assert.match(src, /theme: raw\.theme === 'light' \|\| raw\.theme === 'dark' \? raw\.theme : 'system',/);
});

test('AI-190: the window background matches the theme tokens, so the first frame never flashes dark', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'theme.css'), 'utf8');
  const root = /:root\s*\{[^}]*?--bg:\s*(#[0-9a-f]{6})/i.exec(css)!;
  const light = /body\.light\s*\{[^}]*?--bg:\s*(#[0-9a-f]{6})/i.exec(css)!;
  assert.equal(WINDOW_BG.dark, root[1].toLowerCase());
  assert.equal(WINDOW_BG.light, light[1].toLowerCase());
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /backgroundColor: WINDOW_BG\[firstTheme\]/);
  assert.match(main, /loadFile\([^)]*index\.html'\), \{ query: \{ theme: firstTheme \} \}\)/);
});

test('AI-190: the renderer stamps the light class from the URL before anything paints, and follows the OS live only while unpicked', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.match(app, /new URLSearchParams\(location\.search\)\.get\('theme'\) === 'light'\) document\.body\.classList\.add\('light'\)/);
  assert.match(app, /OS_DARK\.addEventListener\('change', \(\) => \{\s*if \(THEME_PREF !== 'system'\) return;/);
  assert.match(app, /THEME_PREF = THEME;\s*\/\/ the sun\/moon is a pick/);
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.json`), 'utf8'));
    assert.ok(d['settings.themeSystem'], `${loc}: System option`);
    assert.doesNotMatch(d['settings.themeHint'], /stay dark|oscuras|escuros/i, `${loc}: the hint no longer claims terminals stay dark`);
  }
});

test('AI-192: ⇧⌘C and the terminal right-click menu copy as plain text, through the tested core', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /ipcMain\.handle\('shell:copyPlainText', \(_e, t: string, cols: number\) => \{ clipboard\.writeText\(plainText\(String\(t\), Number\(cols\) \|\| 80\)\)/);
  assert.match(app, /if \(k === 'C' \|\| \(k === 'c' && e\.shiftKey\)\) \{ const sel = term\.getSelection\(\); if \(sel\) \{ void window\.glassShell\.copyPlainText\(sel, term\.cols\)/);
  assert.ok(app.indexOf("k === 'C' ||") < app.indexOf("if (k === 'c') { const sel"), '⇧⌘C is checked before plain ⌘C');
  assert.match(app, /el\.addEventListener\('mousedown', \(ev\) => \{ if \(ev\.button === 2\) ctxSel = term\.getSelection\(\); \}, true\);/, 'the selection is kept before right-click selects a word');
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.json`), 'utf8'));
    for (const k of ['term.copy', 'term.copyPlain', 'term.copiedPlain']) assert.ok(d[k], `${loc}: ${k}`);
  }
});

test('AI-199: an unnamed session\'s topic labels its tab — never over a manual name, never from a shell title', () => {
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const src = /function claudeTopicLabel\(id, title\) \{[\s\S]*?\n\}\nfunction paintTabLabel\(p\) \{[\s\S]*?\n\}/.exec(app)![0];
  type P = { name: string; manualName?: boolean; claudeTitled?: boolean; topic?: string; tab: { title: string; querySelector: () => { textContent: string } } };
  const mk = (name: string, manual = false): P => {
    const label = { textContent: name };
    return { name, manualName: manual, tab: { title: '', querySelector: () => label } };
  };
  const run = new Function('panes', 'sessionNameFromTitle', `${src}; return claudeTopicLabel;`);
  const slug = (t: string) => (/^[a-z0-9][a-z0-9-]{1,40}$/i.test(t.replace(/^[^\w~/]+/, '').trim()) ? t : null);
  const label = (p: P) => p.tab.querySelector().textContent;

  const term = mk('terminal'); const panes = new Map([[1, term]]);
  const f = run(panes, slug) as (id: number, t: string) => void;
  f(1, 'Qué es un respaldo');
  assert.equal(label(term), 'terminal', 'no Claude announcement yet → a free-text title is not trusted');
  for (const t of ['✳ Claude Code', '◐ Claude Code', 'Claude Code', 'Qué es un respaldo']) f(1, t);   // the measured sequence
  assert.equal(label(term), 'Qué es un respaldo');
  assert.equal(term.name, 'terminal', 'the identity the bus correlates on is untouched');
  f(1, 'chuy@mac: ~/code');
  assert.equal(label(term), 'terminal', 'back to a shell → back to its own name');

  const manual = mk('build', true); const f2 = run(new Map([[1, manual]]), slug) as (id: number, t: string) => void;
  for (const t of ['✳ Claude Code', 'Qué es un respaldo']) f2(1, t);
  assert.equal(label(manual), 'build', 'a name the operator set wins');
});

test('AI-172: what the App records is what canonical provenance.py recognises — across the language boundary', { skip: !fs.existsSync(path.join(os.homedir(), 'aios', 'hooks', 'bus_log.py')) ? 'no canonical hooks on this machine' : false }, async () => {
  const { recordTyped } = await import('../main/busSent');
  const cp = require('child_process') as typeof import('child_process');
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-buslog-')), 'bus-sent.jsonl');
  const saved = process.env.AIOS_BUS_LOG;
  process.env.AIOS_BUS_LOG = log;
  try {
    const typed = 'Por favor revisa el PR → y dime qué opinas — 🎉 gracias';
    recordTyped(typed, 'bg-test', 'send');
    recordTyped(typed, 'bg-test', 'send');
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1, 'one line per text per window');
    const py = (text: string) => cp.execFileSync('python3', ['-c',
      'import sys; sys.path.insert(0, sys.argv[1]); import bus_log; print(bus_log.is_bus_prompt(sys.argv[2]))',
      path.join(os.homedir(), 'aios', 'hooks'), text], { encoding: 'utf8', env: { ...process.env, AIOS_BUS_LOG: log } }).trim();
    assert.equal(py(typed), 'True', 'the provenance hook sees the App-typed prompt as bus-delivered');
    assert.equal(py('  POR FAVOR revisa el PR →   y dime qué opinas — 🎉 gracias '), 'True', 'whitespace and case aside, as bus_log normalises');
    assert.equal(py('something the operator really typed'), 'False', 'control: a text never typed by the bus is not');
  } finally {
    if (saved === undefined) delete process.env.AIOS_BUS_LOG; else process.env.AIOS_BUS_LOG = saved;
  }
});

test('AI-172: every bus delivery records the exact text the session receives, before it is typed', () => {
  const bus = fs.readFileSync(path.join(ROOT, 'src', 'main', 'commandBus.ts'), 'utf8');
  assert.match(bus, /recordTyped\(deliverText, req\.name, 'send'\);[^\n]*\n\s*emit\(win\(\), 'sendByName'/);
  assert.match(bus, /recordTyped\(taskFile \? taskFileInstruction\(taskFile\) : \(req\.task \|\| 'Start session'\), req\.name, 'spawn'\);/);
  assert.match(bus, /if \(req\.prompt\) recordTyped\(taskFile \? taskFileInstruction\(taskFile\) : req\.prompt, req\.name, 'resume'\);/);
});

test('#24 contrast: every text token clears 4.5:1 on every surface, in both themes — read from theme.css', () => {
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'theme.css'), 'utf8');
  const block = (sel: RegExp) => sel.exec(css)![0];
  const tok = (src: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(src)?.[1];
  const lum = (h: string) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const dark = block(/:root\s*\{[\s\S]*?\n\}/), light = block(/body\.light\s*\{[\s\S]*?\n\}/);
  const surfaces = ['bg', 'zone-edit', 'zone-term', 'surface', 'surface-2'];
  const text = ['ink', 'subtle', 'faint', 'accent-ink', 'st-ok-ink', 'st-busy-ink', 'st-input-ink', 'st-warn-ink', 'st-error-ink'];
  for (const [theme, src] of [['dark', dark], ['light', light]] as const) {
    for (const t of text) {
      // an alias (var(--x)) resolves to the dark base value
      const fg = tok(src, t) ?? tok(dark, t) ?? tok(dark, t.replace(/-ink$/, '').replace(/^accent$/, 'accent'));
      const base = fg ?? tok(dark, t.replace(/-ink$/, ''));
      assert.ok(base, `${theme}: --${t} resolves to a colour`);
      for (const s of surfaces) {
        const bg = tok(src, s) ?? tok(dark, s)!;
        assert.ok(ratio(base!, bg) >= 4.5, `${theme}: --${t} ${base} on --${s} ${bg} is ${ratio(base!, bg).toFixed(2)}:1`);
      }
    }
  }
  assert.doesNotMatch(css, /color: var\(--subtle\);[^}]*opacity: \.[0-6]\d?;/, 'no text dimmed below its token by opacity (that is how 2.4:1 happened)');
  assert.doesNotMatch(css, /(?<![-\w])color: var\(--(accent|st-(ok|busy|input|warn|error))\)/, 'text uses the -ink variants; the bright hues stay for fills');
});

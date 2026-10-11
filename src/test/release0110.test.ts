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

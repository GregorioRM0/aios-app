/** AI-222 — a new export never opens a tab from a pull, and by default never takes focus. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { cameFromGit, exportOpenMode, type GitRun } from '../main/exportOpen';

test('mode: the default is the quiet badge; a saved off stays off', () => {
  assert.equal(exportOpenMode({}), 'badge');
  assert.equal(exportOpenMode({ autoOpenExports: true }), 'badge');
  assert.equal(exportOpenMode({ autoOpenExports: false }), 'off');
  assert.equal(exportOpenMode({ openExports: 'open', autoOpenExports: false }), 'open');
});

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const git = (dir: string): GitRun => (args) => new Promise((res) =>
  execFile('git', ['-C', dir, ...args], (e, out) => res(e ? null : String(out))));

test('against a real repo: pulled = tracked and clean; a session\'s file is not', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-exp-')));
  sh(d, 'init', '-q'); sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(d, 'pulled.html'), 'a'); sh(d, 'add', '.'); sh(d, 'commit', '-qm', 'x');
  assert.equal(await cameFromGit(path.join(d, 'pulled.html'), git(d)), true, 'a pull/checkout → never announced');
  fs.writeFileSync(path.join(d, 'new.html'), 'b');
  assert.equal(await cameFromGit(path.join(d, 'new.html'), git(d)), false, 'untracked = a session wrote it');
  fs.writeFileSync(path.join(d, 'pulled.html'), 'changed');
  assert.equal(await cameFromGit(path.join(d, 'pulled.html'), git(d)), false, 'modified = a session rewrote it');
});

test('no git answer is "not from git" — the export is still announced, never silently lost', async () => {
  assert.equal(await cameFromGit('/x.html', async () => null), false);
});

test('the watcher asks git before it opens or badges anything, and honours off', () => {
  const host = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  const w = host.slice(host.indexOf("'03 - export'"), host.indexOf("'00 - notes', 'projects'"));
  assert.match(w, /if \(mode === 'off'\) return;/);
  const ask = w.indexOf('cameFromGit(');
  assert.ok(ask > 0 && ask < w.indexOf("'openFile'") && ask < w.indexOf("'exportReady'"), 'git is asked first');
  assert.match(w, /if \(pulled\) return;/);
});

test('git runs from the vault root with fsmonitor and hooks off — never from the export\'s own folder', () => {
  const host = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  assert.match(host, /'-c', 'core\.fsmonitor=false', '-c', 'core\.hooksPath=' \+ os\.devNull, '-C', vault/);
  assert.match(host, /GIT_CEILING_DIRECTORIES: ceiling/);
  assert.match(host, /cameFromGit\(path\.relative\(v, newest\.path\), gitIn\(v\)\)/);
  assert.doesNotMatch(host, /gitIn\(path\.dirname/);
});

test('the count survives the layout redraw of the files button (found live in round 1: the redraw wiped it)', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const at = app.indexOf("rx.innerHTML = icon(showX ? 'folderOpen' : 'folder', 15)");
  assert.ok(at > 0, 'the layout redraws the button');
  assert.match(app.slice(at - 200, at), /const exportCount = rx\.querySelector\('\.ribadge'\);/, 'the count is taken off first');
  assert.match(app.slice(at, at + 200), /if \(exportCount\) rx\.appendChild\(exportCount\);/, 'and put back after');
  assert.equal((app.match(/getElementById\('railExplorer'\)\.innerHTML =/g) || []).length, 1, 'one other redraw: the creation, before the count exists');
});

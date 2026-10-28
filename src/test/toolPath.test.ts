/** #72 — sessions the App launches find Homebrew and uv, as the operator's login shell does. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { withToolDirs } from '../main/toolPath';

const all = () => true;

test('a Finder-launched App PATH gains Homebrew and ~/.local/bin, at the END', () => {
  assert.equal(withToolDirs('/usr/bin:/bin', '/Users/x', 'darwin', all),
    '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/x/.local/bin:/Users/x/.cargo/bin');
});

test('the operator\'s own order wins: a folder already on PATH is not moved or repeated', () => {
  assert.equal(withToolDirs('/opt/homebrew/bin:/usr/bin', '/Users/x', 'darwin', (d) => d === '/opt/homebrew/bin'),
    '/opt/homebrew/bin:/usr/bin');
});

test('only folders that exist are added', () => {
  assert.equal(withToolDirs('/usr/bin', '/Users/x', 'darwin', (d) => d === '/Users/x/.local/bin'), '/usr/bin:/Users/x/.local/bin');
});

test('Linux gets linuxbrew, Windows is untouched', () => {
  assert.match(withToolDirs('/usr/bin', '/home/x', 'linux', all), /\/home\/linuxbrew\/\.linuxbrew\/bin/);
  assert.equal(withToolDirs('C:\\Windows', 'C:\\Users\\x', 'win32', all), 'C:\\Windows');
});

test('termEnv, the chokepoint every pane goes through, applies it', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const fn = /function termEnv\([\s\S]*?\n\}/.exec(main);
  assert.ok(fn, 'termEnv must be findable');
  assert.match(fn![0], /env\.PATH = withToolDirs\(env\.PATH, os\.homedir\(\), process\.platform, /);
});

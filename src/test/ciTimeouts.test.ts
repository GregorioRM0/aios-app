/**
 * Every CI and release job has a time limit, and every test run a per-test timeout.
 *
 * 0.13.0: the Windows job did not fail, it HUNG until GitHub cancelled it at 6 h, on two pushes in a
 * row, and a release tag would have hung the Windows lane the same way and shipped no installer.
 * With no limit, a hang reads as "still running" for hours, which is exactly how it was misread.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = '.github/workflows';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml'));

test('every job that runs on a machine states timeout-minutes', () => {
  assert.ok(files.length >= 5, 'the workflows must be found');
  for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const runsOn = (s.match(/^ {4}runs-on: /gm) || []).length;
    const limits = (s.match(/^ {4}timeout-minutes: \d+/gm) || []).length;
    assert.ok(runsOn > 0, `${f}: no job found — this guard is reading the wrong shape`);
    assert.equal(limits, runsOn, `${f}: ${runsOn} job(s), ${limits} time limit(s)`);
  }
});

test('every unit-suite run has a per-test timeout', () => {
  for (const f of files) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of s.split('\n').filter((l) => /node --test/.test(l))) {
      assert.match(line, /--test-timeout=\d+/, `${f}: ${line.trim()}`);
    }
  }
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.test, /node --test --test-timeout=\d+/);
});

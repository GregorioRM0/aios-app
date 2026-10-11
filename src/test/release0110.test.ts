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

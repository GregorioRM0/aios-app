/** Review should-fix 12 — the "Report this" snapshot is written already redacted. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../main/redact';

test('token shapes, keys and URL credentials never reach the snapshot', () => {
  const gh = 'ghp_' + 'A'.repeat(36);
  const fine = 'github_pat_' + 'B'.repeat(40);
  const ant = 'sk-ant-api03-' + 'c'.repeat(40);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const input = [
    `export GITHUB_TOKEN=${gh}`, fine, `ANTHROPIC_API_KEY="${ant}"`, `Authorization: Bearer ${'z'.repeat(30)}`,
    'xoxb-1234567890-abcdefghij', 'AKIAABCDEFGHIJKLMNOP', jwt, 'git clone https://user:hunter22@github.com/org/repo.git',
    'password: correct-horse-battery', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----',
  ].join('\n');
  const out = redactSecrets(input);
  for (const secret of [gh, fine, ant, jwt, 'z'.repeat(30), 'xoxb-1234567890', 'AKIAABCDEFGHIJKLMNOP', 'hunter22', 'correct-horse-battery', '\nAAAA\n']) {
    assert.ok(!out.includes(secret), `leaked: ${secret.slice(0, 16)}`);
  }
  assert.match(out, /https:\/\/\[redacted\]@github\.com\/org\/repo\.git/, 'the URL stays readable');
});

test('ordinary terminal output is left alone', () => {
  const s = '✓ 42 tests passed in src/main — build ok (token count: 1200)\nnpm run compile';
  assert.equal(redactSecrets(s), s);
});

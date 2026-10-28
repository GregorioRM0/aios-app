/**
 * `/rename` inside a NAMED session reaches the tab, even when the new name has spaces.
 *
 * Measured on claude 2.1.308: `claude --name Sev` titles "✳ Sev" from its first frame and never
 * "Claude Code"; `/rename Two Words` then titles "✳ Two Words". The handle path rejects the space
 * (sessionNameFromTitle is slug-only, deliberately), and the topic path waited for a "Claude Code"
 * announcement a named session never makes — so the registry and the tty title changed and the
 * tab did not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

type P = { name: string; manualName?: boolean; claudeTitled?: boolean; topic?: string; tab: { title: string; querySelector: () => { textContent: string } } };
const mk = (name: string, manual = false): P => {
  const label = { textContent: name };
  return { name, manualName: manual, tab: { title: '', querySelector: () => label } };
};
const label = (p: P) => p.tab.querySelector().textContent;
const slug = (t: string) => (/^[a-z0-9][a-z0-9-]{1,40}$/i.test(t.replace(/^[^\w~/]+/, '').trim()) ? t : null);
const topicLabel = (panes: Map<number, P>) => {
  const src = /function claudeTopicLabel\(id, title\) \{[\s\S]*?\n\}\nfunction paintTabLabel\(p\) \{[\s\S]*?\n\}/.exec(app)![0];
  return new Function('panes', 'sessionNameFromTitle', `${src}; return claudeTopicLabel;`)(panes, slug) as (id: number, t: string) => void;
};

test('a live session confirming its handle counts as Claude announcing itself', () => {
  const handler = /term\.onTitleChange\(\(title\) => \{[\s\S]*?\n {2}\}\);/.exec(app)![0];
  assert.match(handler, /if \(!hit\) return;\s*p\.isSession = true;\s*p\.claudeTitled = true;/,
    'the registry-confirmed branch must set claudeTitled, or a named session never unlocks the topic label');
});

test('/rename to two words inside a named session relabels the tab, and renaming back restores it', () => {
  const sev = mk('Sev'); const f = topicLabel(new Map([[1, sev]]));
  f(1, '✳ Sev');
  assert.equal(label(sev), 'Sev', 'its own handle is not a topic');
  sev.claudeTitled = true;   // what the title handler does once "Sev" matches the live registry
  f(1, '✳ Sev Habla');
  assert.equal(label(sev), 'Sev Habla');
  assert.equal(sev.name, 'Sev', 'the identity the bus correlates on is untouched');
  f(1, '✳ Sev');
  assert.equal(label(sev), 'Sev', '/rename back to the handle drops the stale topic');
  f(1, 'ana@mac: ~/aios');
  assert.equal(label(sev), 'Sev', 'back to a shell → back to its own name');
});

test('a slug title never unlocks the topic label by itself — a shell titled "vim" stays a shell', () => {
  const term = mk('terminal'); const f = topicLabel(new Map([[1, term]]));
  for (const t of ['vim', 'npm run dev']) f(1, t);
  assert.equal(label(term), 'terminal');
});

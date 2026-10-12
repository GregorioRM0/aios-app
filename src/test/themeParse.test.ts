/**
 * The update pill must PARSE. A rule pasted into its comment once ended the comment early
 * (an inner close-comment), turned the pill selector into garbage and the browser dropped the
 * whole rule: the pill fell back to a cramped 26×26 box. Anything on the update path is a
 * blocker, so this strips comments the way a CSS parser does and checks the selectors are real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'theme.css'), 'utf8');
/** Rules as a CSS parser sees them: comments removed first, exactly as the browser does. */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
const ruleFor = (sel: string) => {
  /* The selector must be the WHOLE text between the previous rule's `}` and this `{`: stray text
     before it (a broken comment's tail) makes the selector invalid and the rule is dropped. */
  const re = new RegExp(`\\}\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  return re.exec(stripped)?.[1];
};

test('the update pill rule survives comment stripping, with its id+class selector', () => {
  const pill = ruleFor('#dragacts .updpill');
  assert.ok(pill, '#dragacts .updpill must be a real rule after comments are removed');
  assert.match(pill!, /width: auto;/);
  assert.match(pill!, /background: var\(--accent-fill\);/);
  assert.ok(ruleFor('#dragacts .updexplain'), '"What\'s in it?" too');
});

test('no comment in theme.css contains another comment opener (the way the pill was lost)', () => {
  for (const m of css.matchAll(/\/\*([\s\S]*?)\*\//g)) {
    assert.ok(!m[1].includes('/*'), `a comment contains "/*": ${m[1].slice(0, 80)}`);
  }
});

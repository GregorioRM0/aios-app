/** #84, on top — Next steps' "Finish setup" lists what it will change before it changes it. */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { FINISH_SETUP_IDS } from '../core/finishSetup';

test('the Next steps button is preceded by the change list and the backup note', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = /function openNextStepsTab\(\) \{[\s\S]*?\n\}/.exec(app)![0];
  const list = fn.indexOf("for (const w of left) changes.appendChild(el('li', '', t('finish.change.' + w.id)));");
  const backup = fn.indexOf("t('finish.backup')");
  const go = fn.indexOf("btn(acts, t('finish.go')");
  assert.ok(list > 0 && backup > list && go > backup, 'list, then backup note, then the button');
});

test('every id the button can run has its sentence in every locale', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const id of FINISH_SETUP_IDS) assert.ok(d['finish.change.' + id], `${loc} finish.change.${id}`);
  }
});

/**
 * aios#231 — a session handed a run file must be allowed to read it.
 *
 * Under Claude Code's permissions.blockReadsOutsideWorkingDirectories, a worker could not open its
 * own task file in ~/.aios/run, so every long handoff arrived as an instruction it was forbidden to
 * follow. Each App launch that points a session at a run file now passes `--add-dir <its folder>`.
 * The renderer builds these commands, so the helpers are EXECUTED here from its source.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { taskFileInstruction } from '../core/commandBus';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const grab = (re: RegExp, what: string): string => { const m = re.exec(app); assert.ok(m, `${what} must be findable`); return m![0]; };
const helpers = [
  grab(/const xSepIdx = .*;/, 'xSepIdx'),
  grab(/const TASK_FILE_RE = .*;/, 'TASK_FILE_RE'),
  grab(/const taskFileOf = .*;/, 'taskFileOf'),
  grab(/function addDirArgs\(\.\.\.files\) \{[\s\S]*?\n\}/, 'addDirArgs'),
].join('\n');
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const { taskFileOf, addDirArgs } = new Function('shq', `${helpers}\nreturn { taskFileOf, addDirArgs };`)(shq) as {
  taskFileOf: (p: string) => string; addDirArgs: (...f: string[]) => string;
};

test('the renderer recognises exactly the instruction core writes', () => {
  const f = '/Users/x/.aios/run/aios-task-ask.md';
  assert.equal(taskFileOf(taskFileInstruction(f)), f, 'TASK_FILE_RE and taskFileInstruction must agree');
  assert.equal(taskFileOf('Fix my health'), '', 'an inline prompt names no file');
});

test('--add-dir names the folder, once, quoted', () => {
  assert.equal(addDirArgs('/Users/x/.aios/run/a.md', '/Users/x/.aios/run/b.txt'), " --add-dir '/Users/x/.aios/run'");
  assert.equal(addDirArgs('C:\\Users\\x\\AppData\\Local\\Temp\\a.md'), " --add-dir 'C:\\Users\\x\\AppData\\Local\\Temp'");
  assert.equal(addDirArgs(''), '', 'no file, no flag');
});

test('every launch that hands over a run file carries --add-dir BEFORE another flag (the flag is variadic)', () => {
  const spawn = grab(/function spawnNamed\([\s\S]*?\n\}/, 'spawnNamed');
  assert.match(spawn, /cmd: CLAUDE \+ addDirArgs\(taskFileOf\(task\), \.\.\.\(readFiles \|\| \[\]\)\)\s*\+ \(mode \?/,
    'spawnNamed: right after the binary, so the next token is a flag, never the prompt');
  assert.match(app, /cmd: `\$\{CLAUDE\}\$\{addDirArgs\(taskFileOf\(handed\)\)\} --name /, 'Ask AIOS');
  assert.match(app, /cmd: CLAUDE \+ addDirArgs\(h\.file\) \+ ' --name aios-builder '/, 'the Designer');
  assert.match(app, /until I approve\.', undefined, 'default', undefined, \[file\]\);/, 'Report this: the snapshot file');
  assert.match(app, /spawnNamed\('health-help', handed,/, 'health help goes through spawnNamed, which reads the instruction');
});

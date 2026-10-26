#!/usr/bin/env node
/**
 * chat-shot — screenshots of the chat view, from a window that is never shown.
 *
 * For whoever iterates on how the chat view LOOKS: this renders hand-written conversations
 * (src/test/fixtures/chat-shot.json) in the real renderer and writes one PNG per shot, so a design
 * change can be judged by looking at pictures instead of by opening the App over the operator's work.
 *
 * Usage:   npm run chat:shot                          → PNGs in a fresh temp folder (path printed)
 *          npm run chat:shot -- --out <dir>           → PNGs in <dir>
 *          npm run chat:shot -- --fixture <file.json> → another shot list (same format)
 *
 * WHY A SEPARATE RUNNER, and why it isolates this much. The shell must be started with a synthetic
 * HOME (the App reads ~/.claude, ~/.aios and the vault from it), a throwaway userData folder (so the
 * operator's tabs and settings, and a developer's `.dev-userdata`, are never read or written) and the
 * command bus off (a QA run must not fulfil spawn requests meant for the real App). Same isolation as
 * scripts/whatsnew-shot.mjs, but that script opens a VISIBLE window; this one launches `--chat-shot`,
 * which creates a hidden one (see the CHAT SHOT block in src/main/main.ts).
 *
 * It deletes only what it created: folders under os.tmpdir() whose names start with the prefix below.
 * The output folder is never deleted, since the PNGs are the product.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'aios-chatshot-';
const RUN_LIMIT_MS = 360_000;   // main has its own 300 s timer; this one only matters if main itself hangs

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) { console.error(`chat-shot: ${name} needs a value`); process.exit(2); }
  return v;
};
for (const a of args) {
  if (a.startsWith('--') && !['--out', '--fixture'].includes(a)) { console.error(`chat-shot: unknown option ${a} (known: --out <dir>, --fixture <file>)`); process.exit(2); }
}

/** True only for a folder this script made: inside the OS temp dir, with our prefix. */
function isOurTemp(dir) {
  try {
    const real = fs.realpathSync(dir);
    const tmp = fs.realpathSync(os.tmpdir());
    return real.startsWith(tmp + path.sep) && path.basename(real).startsWith(PREFIX);
  } catch { return false; }
}
const created = [];
const cleanup = () => { for (const d of created.splice(0)) if (isOurTemp(d)) fs.rmSync(d, { recursive: true, force: true }); };

const fixture = opt('--fixture') ? path.resolve(opt('--fixture')) : '';
if (fixture && !fs.existsSync(fixture)) { console.error(`chat-shot: fixture not found: ${fixture}`); process.exit(2); }
const outArg = opt('--out');
let out;
if (outArg) { out = path.resolve(outArg); fs.mkdirSync(out, { recursive: true }); }
else out = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}out-`));   // deliberately NOT registered for cleanup

const work = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}work-`));
created.push(work);
const home = path.join(work, 'home');
const userData = path.join(work, 'userdata');
fs.mkdirSync(userData, { recursive: true });

let code = 1;
try {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo.mjs'), '--build-only', '--out', home], { stdio: 'ignore' });
  const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIOS_BUS_DISABLED: '1', GLASS_FRAMEWORK_PATH: path.join(home, 'aios') };
  delete env.ELECTRON_RUN_AS_NODE;   // inherited from some launchers; it would run the entry as plain node
  const child = spawn(electron, [
    '.', `--user-data-dir=${userData}`, '--use-mock-keychain', `--chat-shot=${out}`,
    ...(fixture ? [`--chat-shot-fixture=${fixture}`] : []),
  ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });

  const pngs = [];
  let log = '';
  const onLine = (line) => {
    log += line + '\n';
    if (line.startsWith('chat-shot:')) console.log(line);
    const m = /^chat-shot: (.+\.png) \d+x\d+/.exec(line);
    if (m) pngs.push(m[1]);
  };
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) !== -1) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    stream.on('end', () => { if (buf) onLine(buf); });
  }
  // Only ever kills the pid THIS script started.
  const killer = setTimeout(() => { console.error('chat-shot: the shell did not finish in time; stopping it'); child.kill('SIGKILL'); }, RUN_LIMIT_MS);
  const onSignal = () => { child.kill('SIGTERM'); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  code = await new Promise((res) => { child.on('exit', (c, sig) => res(c ?? (sig ? 1 : 0))); child.on('error', (e) => { console.error('chat-shot: cannot start electron:', e.message); res(1); }); });
  clearTimeout(killer);
  if (code !== 0) {
    console.error(`chat-shot: failed (exit ${code}). Last output:\n${log.split('\n').filter((l) => !l.startsWith('[renderer]')).slice(-15).join('\n')}`);
  } else if (!pngs.length) {
    console.error('chat-shot: the shell exited 0 but reported no PNG — treating that as a failure');
    code = 1;
  } else {
    console.log(`\nchat-shot: ${pngs.length} PNG(s) in ${out}`);
  }
} catch (e) {
  console.error('chat-shot:', e instanceof Error ? e.message : e);
  code = 1;
} finally {
  cleanup();
}
process.exit(code);

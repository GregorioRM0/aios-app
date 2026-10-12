#!/usr/bin/env node
/**
 * rehearse-update — prove THIS candidate can update to the NEXT version, before it ships.
 *
 * WHY. Every release so far was tested by updating TO it, never FROM it. But the build a user is
 * running is the one that has to fetch the next fix: if the candidate's update pill, download or
 * install is broken, every user on it is stranded and no later release can reach them. So the
 * candidate gets one rehearsal of its own future: candidate (N) → throwaway (N+1, same code, only
 * the version changed), through the real electron-updater + Squirrel.Mac path.
 *
 * NEVER TOUCHES THE REAL FEED. The feed is a local HTTP server on 127.0.0.1; nothing is uploaded,
 * tagged or drafted. Both builds differ from a shipped build in exactly these ways, all outside the
 * code under test:
 *   - publish → generic provider at http://127.0.0.1:<port>/ (the shipped app reads GitHub);
 *   - productName "AIOS Rehearsal" + its own appId, so it has its own profile and its own
 *     single-instance lock and can never hand off to (or be mistaken for) the installed AIOS;
 *   - Info.plist LSEnvironment: a synthetic HOME, AIOS_BUS_DISABLED=1 and its own
 *     CLAUDE_CONFIG_DIR. This is the part that matters: Squirrel RELAUNCHES the updated app
 *     through LaunchServices, which drops the environment of whoever started the first one. A
 *     relaunched app with the real HOME would join the operator's spawn-inbox as a second App
 *     surface. LaunchServices applies LSEnvironment on that relaunch too.
 *   - not notarized (local, never quarantined; the update check is the code signature, which IS
 *     real: Developer ID, the same identity as a release).
 *
 * Usage:  node scripts/rehearse-update.mjs [--out <dir>] [--port 8765] [--skip-build]
 * macOS only (the Windows updater is NSIS + a different verifier; this script says so and exits).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i === -1 ? d : process.argv[i + 1]; };
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), 'aios-rehearsal')));
const PORT = Number(arg('--port', '8765'));
const CDP = Number(arg('--cdp', '9333'));
const SKIP_BUILD = process.argv.includes('--skip-build');
const NAME = 'AIOS Rehearsal';

if (process.platform !== 'darwin') { console.error('rehearse-update: macOS only — Windows/Linux are NOT covered by this script.'); process.exit(2); }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FROM = pkg.version;
const TO = FROM.replace(/(\d+)$/, (m) => String(Number(m) + 1));
const HOME = path.join(OUT, 'home');
const FEED = path.join(OUT, 'feed');
const INSTALL = path.join(OUT, 'install');
const APP = path.join(INSTALL, `${NAME}.app`);
const log = (...a) => console.log('rehearse:', ...a);
const record = { from: FROM, to: TO, feed: `http://127.0.0.1:${PORT}/`, steps: [] };
const step = (name, ok, detail) => { record.steps.push({ name, ok, detail }); log(`${ok ? '✓' : '✗'} ${name}`, detail === undefined ? '' : JSON.stringify(detail)); };

function config(version) {
  const b = structuredClone(pkg.build);
  b.productName = NAME;
  b.appId = 'com.the-aios.app.rehearsal';
  b.publish = [{ provider: 'generic', url: `http://127.0.0.1:${PORT}/` }];
  b.directories = { ...b.directories, output: path.join(OUT, `dist-${version}`) };
  b.mac = { ...b.mac, notarize: false, target: [{ target: 'zip', arch: ['arm64'] }], artifactName: 'AIOS-Rehearsal-${version}-${arch}.${ext}',
    extendInfo: { ...(b.mac.extendInfo || {}), CFBundleDisplayName: NAME,
      LSEnvironment: { HOME, AIOS_BUS_DISABLED: '1', CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), GLASS_FRAMEWORK_PATH: path.join(HOME, 'aios') } } };
  /* productName MUST also go into the packaged package.json: Electron names the profile folder from
     it, and macOS resolves that folder from the real account, not $HOME. Left as "AIOS", the
     rehearsal found the installed App's single-instance lock and quit on launch (measured). */
  b.extraMetadata = { version, name: 'aios-app-rehearsal', productName: NAME };
  const f = path.join(OUT, `builder-${version}.json`);
  fs.writeFileSync(f, JSON.stringify(b, null, 2));
  return f;
}

function build(version) {
  log(`building ${NAME} ${version} …`);
  const r = spawnSync('npx', ['electron-builder', '--mac', '--config', config(version), '--publish', 'never'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  fs.writeFileSync(path.join(OUT, `build-${version}.log`), (r.stdout || '') + (r.stderr || ''));
  if (r.status !== 0) { console.error(r.stderr?.slice(-2000)); throw new Error(`build ${version} failed — see build-${version}.log`); }
}

async function cdpEval(expression) {
  const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error('no renderer page yet');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const out = await new Promise((res) => {
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result?.result?.value); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  ws.close();
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundleVersion = () => { try { return execFileSync('defaults', ['read', path.join(APP, 'Contents', 'Info.plist'), 'CFBundleShortVersionString'], { encoding: 'utf8' }).trim(); } catch { return ''; } };
const appPids = () => { try { return execFileSync('pgrep', ['-f', `${APP}/Contents/MacOS/`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };

const PILL = `(() => { const p = document.getElementById('updPill'); if (!p || p.hidden) return null;
  const r = p.getBoundingClientRect(), cs = getComputedStyle(p), ex = document.getElementById('updExplain');
  return { state: p.dataset.state, version: p.dataset.version, text: p.textContent, w: Math.round(r.width), h: Math.round(r.height),
    bg: cs.backgroundColor, radius: cs.borderRadius, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === p,
    explain: ex && !ex.hidden ? { text: ex.textContent, w: Math.round(ex.getBoundingClientRect().width), h: Math.round(ex.getBoundingClientRect().height) } : null }; })()`;

const T0 = Date.now();
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!SKIP_BUILD) {
    for (const d of [`dist-${FROM}`, `dist-${TO}`]) fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
    execFileSync('npm', ['run', 'compile'], { cwd: ROOT, stdio: 'ignore' });
    build(FROM); build(TO);
  }
  // A synthetic home (the demo fixture): no real vault, session, account or inbox is reachable.
  fs.rmSync(HOME, { recursive: true, force: true });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo.mjs'), '--build-only', '--out', HOME], { stdio: 'ignore' });

  // The feed: the N+1 zip + its manifest, and nothing else.
  fs.rmSync(FEED, { recursive: true, force: true }); fs.mkdirSync(FEED, { recursive: true });
  const toDist = path.join(OUT, `dist-${TO}`);
  for (const f of fs.readdirSync(toDist)) if (/^latest-mac\.yml$|\.zip$|\.zip\.blockmap$/.test(f)) fs.copyFileSync(path.join(toDist, f), path.join(FEED, f));
  step('feed holds only the throwaway', fs.readFileSync(path.join(FEED, 'latest-mac.yml'), 'utf8').includes(`version: ${TO}`), fs.readdirSync(FEED));
  const served = [];
  const server = http.createServer((req, res) => {
    const f = path.join(FEED, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    served.push(`${req.method} ${req.url}`);
    if (!f.startsWith(FEED) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-length': fs.statSync(f).size }); fs.createReadStream(f).pipe(res);
  }).listen(PORT, '127.0.0.1');

  // Install the candidate into a scratch folder — never /Applications, never the operator's AIOS.
  fs.rmSync(INSTALL, { recursive: true, force: true }); fs.mkdirSync(INSTALL, { recursive: true });
  const fromApp = path.join(OUT, `dist-${FROM}`, 'mac-arm64', `${NAME}.app`);
  execFileSync('ditto', [fromApp, APP]);
  step('candidate installed', bundleVersion() === FROM, { path: APP, version: bundleVersion() });
  // Guard: never launch anything that would share the installed AIOS's profile or instance lock.
  const asarPkg = JSON.parse(execFileSync('npx', ['asar', 'extract-file', path.join(APP, 'Contents', 'Resources', 'app.asar'), 'package.json'], { cwd: OUT }) && fs.readFileSync(path.join(OUT, 'package.json'), 'utf8'));
  fs.rmSync(path.join(OUT, 'package.json'), { force: true });
  if (asarPkg.productName !== NAME) { step('rehearsal has its own profile', false, asarPkg.productName); throw new Error('packaged productName is not the rehearsal name — refusing to launch'); }

  const env = { ...process.env, HOME, AIOS_BUS_DISABLED: '1', CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), GLASS_FRAMEWORK_PATH: path.join(HOME, 'aios') };
  const logFile = fs.openSync(path.join(OUT, 'candidate.log'), 'w');
  const first = spawn(path.join(APP, 'Contents', 'MacOS', NAME), [`--remote-debugging-port=${CDP}`], { env, stdio: ['ignore', logFile, logFile], detached: true });
  first.unref();

  // 1. The pill appears, downloads, then reads ready — and is a real, clickable button.
  let seen = [], pill = null;
  for (let t = 0; t < 180; t += 2) {
    await sleep(2000);
    try { pill = await cdpEval(PILL); } catch { continue; }
    if (pill && seen[seen.length - 1] !== pill.state) seen.push(pill.state);
    if (pill?.state === 'ready') break;
  }
  step('pill appeared and reached ready', pill?.state === 'ready', { states: seen, pill });
  step('pill renders as a pill (not the 26px box) and takes the click', !!pill && pill.w > 40 && pill.h >= 20 && pill.radius === '999px' && pill.hit && !/rgba\(0, 0, 0, 0\)/.test(pill.bg), pill && { w: pill.w, h: pill.h, radius: pill.radius, bg: pill.bg, hit: pill.hit });
  step('"What\'s in it?" shown beside it', !!pill?.explain && pill.explain.w > 40, pill?.explain);

  // 2. "What's in it?" responds. On a signed-in machine it opens `explainer` as a named session. This
  //    isolated home is deliberately NOT signed in to Claude, so the App's readiness gate must answer
  //    instead — a toast naming what is missing, and the Setup tab. Either is a working button; a
  //    click that does nothing is the failure. The explainer's own answer is NOT exercised here.
  const before = await cdpEval('[...panes.values()].map((p) => p.name)');
  await cdpEval(`document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()); document.getElementById('updExplain').click()`);
  await sleep(3000);
  const after = await cdpEval('({ panes: [...panes.values()].map((p) => ({ name: p.name, cmd: p.cmd || "" })), toasts: [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent), ready: null })');
  const opened = (after?.panes || []).some((p) => /explainer/.test(p.name) || /explainer/.test(p.cmd));
  const gated = (after?.toasts || []).length > 0 && (after?.panes || []).some((p) => /set ?up/i.test(p.name));
  step('"What\'s in it?" responds (explainer opens, or the not-signed-in gate explains)', opened || gated, { before, after, opened, gated });
  record.explainerAgentExercised = opened;

  // 3. Click the pill → confirm → quit, Squirrel installs, the app relaunches as N+1.
  await cdpEval(`window.confirm = () => true; document.getElementById('updPill').click(); 'clicked'`).catch(() => 'clicked (page went away)');
  let relaunched = [], v = '';
  for (let t = 0; t < 120; t += 2) {
    await sleep(2000);
    v = bundleVersion();
    relaunched = appPids().filter((p) => p !== first.pid);
    if (v === TO && relaunched.length) break;
  }
  step('bundle replaced with the throwaway', v === TO, { version: v });
  step('app relaunched by itself', relaunched.length > 0, { pids: relaunched });
  const sig = spawnSync('codesign', ['--verify', '--deep', '--strict', APP], { encoding: 'utf8' });
  step('installed bundle passes codesign --verify --deep --strict', sig.status === 0, (sig.stderr || '').trim() || 'valid');
  /* The relaunch must be isolated too. LaunchServices applies LSEnvironment on the relaunch EXCEPT
     HOME, which it always resets to the real one (measured). So the evidence is: the bus is off and
     Claude's config points at the synthetic home (the App reads the registry from CLAUDE_CONFIG_DIR),
     and nothing under the real ~/.aios was written while the rehearsal ran. */
  let envOk = false, envSeen = '';
  for (const pid of relaunched) {
    try {
      const e = execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      envSeen = e.split(' ').filter((w) => /^(HOME|AIOS_BUS_DISABLED|CLAUDE_CONFIG_DIR)=/.test(w)).join(' ');
      if (e.includes('AIOS_BUS_DISABLED=1') && e.includes(`CLAUDE_CONFIG_DIR=${path.join(HOME, '.claude')}`)) envOk = true;
    } catch { /* gone */ }
  }
  step('relaunched app is isolated (bus off, Claude config in the synthetic home)', envOk, envSeen);
  /* What a second App surface would leave behind on the REAL machine — and nothing else, because the
     operator's own App and sessions write ~/.aios all the time: a surface file naming a rehearsal pid,
     a rewritten inbox README (every surface rewrites it at boot), a hold claimed by a rehearsal pid. */
  const realAios = path.join(os.homedir(), '.aios');
  const ours = new Set([first.pid, ...relaunched]);
  const leaks = [];
  try { for (const f of fs.readdirSync(path.join(realAios, 'surfaces'))) { try { const j = JSON.parse(fs.readFileSync(path.join(realAios, 'surfaces', f), 'utf8')); if (ours.has(j.pid)) leaks.push(`surfaces/${f}`); } catch { /* torn */ } } } catch { /* none */ }
  try { if (fs.statSync(path.join(realAios, 'spawn-inbox', 'README.md')).mtimeMs >= T0) leaks.push('spawn-inbox/README.md rewritten'); } catch { /* none */ }
  try { for (const f of fs.readdirSync(path.join(realAios, 'spawn-inbox')).filter((n) => n.endsWith('.holding'))) { try { const j = JSON.parse(fs.readFileSync(path.join(realAios, 'spawn-inbox', f), 'utf8')); if (ours.has(j?._claim?.pid)) leaks.push(`holding ${f}`); } catch { /* torn */ } } } catch { /* none */ }
  step('the rehearsal never acted as a surface on the real bus', leaks.length === 0, leaks);
  step('feed requests', served.some((s) => /latest-mac\.yml/.test(s)) && served.some((s) => /\.zip/.test(s)), served);

  for (const pid of appPids()) { try { process.kill(pid); } catch { /* gone */ } }
  server.close();
  // The profile folder lives under the REAL account (see above); it is the rehearsal's own, so remove it.
  fs.rmSync(path.join(os.homedir(), 'Library', 'Application Support', NAME), { recursive: true, force: true });
  record.ok = record.steps.every((s) => s.ok);
  record.at = new Date().toISOString();
  record.coverage = 'macOS arm64 only. Windows (NSIS + its own verifier) and Linux (AppImage) are NOT exercised by this rehearsal.';
  fs.writeFileSync(path.join(OUT, 'rehearsal.json'), JSON.stringify(record, null, 2));
  log(record.ok ? `PASS — ${FROM} → ${TO}` : `FAIL — see ${path.join(OUT, 'rehearsal.json')}`);
  process.exit(record.ok ? 0 : 1);
}
main().catch((e) => { console.error('rehearse:', e); for (const pid of appPids()) { try { process.kill(pid); } catch { /* gone */ } } process.exit(1); });

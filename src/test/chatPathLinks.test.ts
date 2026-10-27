/**
 * Paths in the chat view become links — the part that can be run for real.
 *
 * Two halves:
 *   1. the RESOLVER shared by the terminal and the chat (src/main/pathResolve.ts), run against a
 *      folder this test creates under the OS temp dir. Nothing here names a real person's path.
 *   2. the chat's linking (renderer/app.js), lifted out of the real source and run against a fake
 *      resolver and a small fake DOM, plus source guards — each with a negative control, because a
 *      guard that cannot fail reports confidence about something it never examined.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanCandidate, resolveOne, resolveMany, RESOLVE_FILES_LIMIT, RESOLVE_PATHS_LIMIT, type ResolveEnv } from '../main/pathResolve';

const read = (p: string): string => fs.readFileSync(p, 'utf8');

// ── 1 · the resolver ───────────────────────────────────────────────────────────────────────────

/** A throwaway tree: <tmp>/work (the base), <tmp>/work/notes/a b.md, <tmp>/work/src/main.ts, <tmp>/work/my folder/, <tmp>/home, and a file OUTSIDE every root. */
function tree(): { root: string; work: string; home: string; outside: string; env: ResolveEnv } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-chatpaths-')));
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(work, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'my folder'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(work, 'notes', 'a b.md'), 'x');
  fs.writeFileSync(path.join(work, 'src', 'main.ts'), 'x');
  fs.writeFileSync(path.join(home, 'todo.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  // the allowed roots are `work` and `home`, textually — the way main's inAllowed compares them
  const allowed = (abs: string): boolean => [work, home].some((r) => abs === r || abs.startsWith(r + path.sep));
  return { root, work, home, outside, env: { allowed, frameworkRoot: () => undefined, home } };
}

test('the resolver: a file that exists resolves, with its type', () => {
  const t = tree();
  assert.deepEqual(resolveOne('src/main.ts', t.work, t.env, true), { abs: path.join(t.work, 'src', 'main.ts'), dir: false });
  assert.deepEqual(resolveOne(path.join(t.work, 'src', 'main.ts'), undefined, t.env, true), { abs: path.join(t.work, 'src', 'main.ts'), dir: false });
});

test('the resolver: a folder resolves as a folder, and only when folders are asked for', () => {
  const t = tree();
  assert.deepEqual(resolveOne('notes', t.work, t.env, true), { abs: path.join(t.work, 'notes'), dir: true });
  assert.equal(resolveOne('notes', t.work, t.env, false), null, 'the terminal never asked for folders and must not start getting them');
});

test('the resolver: names with spaces, a ~ prefix and a :line suffix resolve', () => {
  const t = tree();
  assert.equal(resolveOne('notes/a b.md', t.work, t.env, true)?.abs, path.join(t.work, 'notes', 'a b.md'));
  assert.equal(resolveOne('my folder', t.work, t.env, true)?.dir, true);
  assert.equal(resolveOne('~/todo.txt', t.work, t.env, true)?.abs, path.join(t.home, 'todo.txt'));
  assert.equal(resolveOne('src/main.ts:42:7', t.work, t.env, true)?.abs, path.join(t.work, 'src', 'main.ts'));
  assert.equal(resolveOne('(see src/main.ts).', t.work, t.env, true), null, 'only TRAILING punctuation is trimmed, a leading paren is part of the string');
  assert.equal(resolveOne('src/main.ts).', t.work, t.env, true)?.abs, path.join(t.work, 'src', 'main.ts'));
});

test('the resolver: a path that does not exist does NOT resolve (negative control)', () => {
  const t = tree();
  assert.equal(resolveOne('src/nope.ts', t.work, t.env, true), null);
  assert.equal(resolveOne('nowhere', t.work, t.env, true), null);
  assert.equal(resolveOne('', t.work, t.env, true), null);
  assert.equal(resolveOne(undefined, t.work, t.env, true), null);
});

test('the resolver: a path outside the allowed roots does not resolve, however it is spelled', () => {
  const t = tree();
  const out = path.join(t.outside, 'secret.txt');
  assert.equal(fs.existsSync(out), true, 'control: the file is really there');
  assert.equal(resolveOne(out, t.work, t.env, true), null);
  /* `..` passes a textual startsWith check while naming a place outside the root: the reason the
     resolver normalises exactly those strings. */
  assert.equal(resolveOne(path.join(t.work, '..', 'elsewhere', 'secret.txt'), t.work, t.env, true), null);
  assert.equal(resolveOne('../elsewhere/secret.txt', t.work, t.env, true), null);
  // and the normalisation is not a blanket ban: a `..` that stays inside is still fine
  assert.equal(resolveOne(path.join(t.work, 'notes', '..', 'src', 'main.ts'), undefined, t.env, true)?.abs, path.join(t.work, 'src', 'main.ts'));
});

test('the resolver: the base folder wins, then the home folder is tried', () => {
  const t = tree();
  fs.writeFileSync(path.join(t.work, 'todo.txt'), 'x');
  assert.equal(resolveOne('todo.txt', t.work, t.env, true)?.abs, path.join(t.work, 'todo.txt'));
  fs.rmSync(path.join(t.work, 'todo.txt'));
  assert.equal(resolveOne('todo.txt', t.work, t.env, true)?.abs, path.join(t.home, 'todo.txt'), 'home is the last base');
});

test('resolveMany: keyed by the candidate as given, only what exists, and capped', () => {
  const t = tree();
  const got = resolveMany(['src/main.ts', 'notes', 'src/nope.ts'], t.work, t.env, { dirs: true, limit: RESOLVE_PATHS_LIMIT });
  assert.deepEqual(Object.keys(got).sort(), ['notes', 'src/main.ts']);
  assert.equal(got['notes'].dir, true);
  const filesOnly = resolveMany(['src/main.ts', 'notes'], t.work, t.env, { dirs: false, limit: RESOLVE_FILES_LIMIT });
  assert.deepEqual(Object.keys(filesOnly), ['src/main.ts'], 'files only means a folder is simply absent');
  const names = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);
  for (const n of names) fs.writeFileSync(path.join(t.work, n), 'x');
  assert.equal(Object.keys(resolveMany(names, t.work, t.env, { dirs: false, limit: RESOLVE_FILES_LIMIT })).length, RESOLVE_FILES_LIMIT, 'a terminal line asks about at most 24');
  assert.equal(Object.keys(resolveMany(names, t.work, t.env, { dirs: true, limit: RESOLVE_PATHS_LIMIT })).length, 30, 'a chat message gets the higher ceiling');
  assert.deepEqual(resolveMany('not an array', t.work, t.env, { dirs: true, limit: 5 }), {});
});

test('cleanCandidate: the trimming rules are the terminal\'s, unchanged', () => {
  assert.equal(cleanCandidate('  src/a.ts:12:3). ', '/h'), 'src/a.ts');
  assert.equal(cleanCandidate('~/x/y.md', '/h'), path.join('/h', '/x/y.md'));
  assert.equal(cleanCandidate('', '/h'), '');
});

// ── the IPC handlers stay thin, and the terminal's one is still files-only ─────────────────────

const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
/** Run a check against the real source (must hold) and against a broken copy (must fail). */
function guarded(name: string, src: string, check: (s: string) => boolean, breakIt: (s: string) => string): void {
  test(name, () => {
    assert.ok(check(src), `${name}: the check does not hold on the real source`);
    const broken = breakIt(src);
    assert.notEqual(broken, src, `${name}: the negative control did not change anything`);
    assert.equal(check(broken), false, `${name}: the check still passes on a deliberately broken copy — it proves nothing`);
  });
}

guarded('fs:resolveFiles (the terminal\'s) is still files-only and still capped at 24', main,
  (s) => {
    const h = /ipcMain\.handle\('fs:resolveFiles'[\s\S]*?\n\}\);/.exec(s)?.[0] ?? '';
    return h.length > 60 && /dirs: false/.test(h) && /RESOLVE_FILES_LIMIT/.test(h) && !/dirs: true/.test(h) && /RESOLVE_FILES_LIMIT = 24/.test(read('src/main/pathResolve.ts'));
  },
  (s) => s.replace("{ dirs: false, limit: RESOLVE_FILES_LIMIT }", "{ dirs: true, limit: RESOLVE_FILES_LIMIT }"));

guarded('the rules live in ONE place: no handler carries its own copy of the trimming, ~ or base logic', main,
  (s) => !/replace\(\/\[\)\\\]\},\.;:/.test(s) && !/os\.homedir\(\), v\.slice\(1\)/.test(s) && /resolveOne\(cand, base, resolveEnv, false\)/.test(s)
    && /resolveMany\(cands, base, resolveEnv, \{ dirs: false/.test(s) && /resolveMany\(cands, base, resolveEnv, \{ dirs: true/.test(s),
  (s) => s.replace("resolveOne(cand, base, resolveEnv, false)?.abs ?? null", "String(cand).trim().replace(/[)\\]},.;:'\"]+$/, '')"));

guarded('the new channel is exposed by the preload and answers {abs, dir}', preload,
  (s) => /resolvePaths: \(cands: string\[\], base\?: string\): Promise<Record<string, \{ abs: string; dir: boolean \}>> => ipcRenderer\.invoke\('fs:resolvePaths', cands, base\)/.test(s) && /resolveFiles: \(cands: string\[\], base\?: string\): Promise<Record<string, string>>/.test(s),
  (s) => s.replace("ipcRenderer.invoke('fs:resolvePaths', cands, base)", "ipcRenderer.invoke('fs:resolveFiles', cands, base)"));


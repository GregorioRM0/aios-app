#!/usr/bin/env node
/**
 * release-gate — publish the draft Release only when all three platform feeds are attached.
 * Run as the LAST step of every release lane; whichever lane completes the set publishes.
 * The decision is src/core/releaseGate.ts (tested); this only reads the Release and acts.
 *
 * Usage: node scripts/release-gate.mjs --tag v0.11.0      (needs `npm run compile` and GH_TOKEN)
 * Exit 0 = published, already public, or waiting for another lane · 1 = could not read/publish.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const i = process.argv.indexOf('--tag');
const tag = (i !== -1 && process.argv[i + 1]) || process.env.RELEASE_TAG || '';
if (!tag) { console.error('release-gate: ✗ no tag (--tag or $RELEASE_TAG)'); process.exit(1); }
const { gateDecision } = createRequire(import.meta.url)(path.resolve('out/core/releaseGate.js'));

let rel;
try {
  rel = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--json', 'isDraft,assets'], { encoding: 'utf8' }));
} catch (e) {
  console.error(`release-gate: ✗ cannot read release ${tag}: ${e.message}`); process.exit(1);
}
const d = gateDecision({ isDraft: !!rel.isDraft, assets: (rel.assets || []).map((a) => a.name) });
if (d.do === 'already-public') { console.log(`release-gate: ${tag} is already public — nothing to do`); process.exit(0); }
if (d.do === 'wait') {
  console.log(`release-gate: ${tag} stays a DRAFT — still missing ${d.missing.join(', ')} (another lane may still be running; nobody's updater sees a draft)`);
  process.exit(0);
}
execFileSync('gh', ['release', 'edit', tag, '--draft=false', '--latest'], { stdio: 'inherit' });
console.log(`release-gate: ✓ ${tag} published — all three platform feeds are attached`);

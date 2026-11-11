#!/usr/bin/env node
/**
 * innovations-pricing-spec.js --check — verifies that the receiver allowlist in the Classic Visions
 * edge function matches this repo's pricing-mirror column spec (so a drifted column is caught before
 * the receiver silently drops it). Reads files only.
 *
 *   node scripts/innovations-pricing-spec.js --check [path/to/supabase/functions/innovations-sync/index.ts]
 *   (default: $CV_REPO or C:\DEV\cvweb-deploy\optilens-1c39be6c)
 */
const fs = require('node:fs');
const path = require('node:path');
const mirror = require(path.join(__dirname, '..', 'lib', 'innovations-pricing-mirror'));

const AUDIT = new Set(['source_updated_at', 'source_hash', 'last_synced_at']);
const repo = process.env.CV_REPO || 'C:\\DEV\\cvweb-deploy\\optilens-1c39be6c';
const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(repo, 'supabase', 'functions', 'innovations-sync', 'index.ts');
const src = fs.readFileSync(file, 'utf8');

const found = new Map();
for (const m of src.matchAll(/(inn_\w+): mirror\("(inn_\w+)", "(\w+)", (\[[^\]]*\])\)/g)) found.set(m[1], { table: m[2], key: m[3], cols: JSON.parse(m[4]) });

const problems = [];
for (const spec of mirror.SPECS) {
  const r = found.get(spec.name);
  if (!r) { problems.push(`${spec.name}: missing from receiver`); continue; }
  const want = mirror.allowlist(spec).filter((c) => !AUDIT.has(c));
  if (r.table !== spec.name) problems.push(`${spec.name}: table is ${r.table}`);
  if (r.key !== spec.pk) problems.push(`${spec.name}: conflict key ${r.key}, expected ${spec.pk}`);
  if (JSON.stringify(r.cols) !== JSON.stringify(want)) problems.push(`${spec.name}: allowlist differs`);
}
for (const name of found.keys()) if (!mirror.SPEC_BY_NAME[name]) problems.push(`${name}: in receiver but not in the office spec`);

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`OK: ${found.size} receiver entities match the office spec (${file}).`);

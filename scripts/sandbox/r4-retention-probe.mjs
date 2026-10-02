#!/usr/bin/env node
// R4 probe — is retention an enforced policy or a declared number?
//
// The claim under test (AC-18 / Z01 logs acceptance): an artifact whose TTL has passed is
// actually gone, one still inside its TTL (and anything active) is kept, and repeating the
// sweep changes nothing further. The shipped evidence asserts only `ttl_days > 0` and the
// presence of the artifact field — a number, not a cleanup.
//
// Storage boundary chosen here: the local receipt store the tool writes (the same records the
// workflows upload), because that is the only boundary a sandbox can honestly exercise. The
// GitHub-managed expiry of uploaded artifacts is a server-side policy (`retention-days` on
// upload-artifact); it is asserted separately as configuration and is NOT simulated.
//
//   node scripts/sandbox/r4-retention-probe.mjs [--json]
// exit 0 = retention is enforced; exit 1 = defect (declared, not enforced); exit 2 = harness error

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = process.argv[2] && !process.argv[2].startsWith('--')
  ? path.resolve(process.argv[2])
  : path.resolve(HERE, '..', '..');
const AS_JSON = process.argv.includes('--json');

const DAY_MS = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'r4-retention-'));
const store = path.join(root, 'receipt-store');
mkdirSync(store, { recursive: true });

const receipt = (name, ageDays, { active = false } = {}) => writeFileSync(
  path.join(store, name),
  `${JSON.stringify({
    tool: { name: 'pr-autofix', version: 'unpinned:local', commit: 'unpinned:local' },
    run_id: name.replace(/\.json$/, ''),
    outcome: 'failed',
    // An active record (in-flight run, checkpoint) carries no age at all: it must never be
    // swept, no matter how far the clock moves.
    retention: active
      ? { ttl_days: 90, artifact: name }
      : { ttl_days: 90, artifact: name, written_at: new Date(T0 - ageDays * DAY_MS).toISOString() },
  }, null, 2)}\n`,
);

receipt('expired-a.json', 91);        // one day past its 90-day TTL
receipt('expired-b.json', 400);       // far past
receipt('fresh-c.json', 3);           // well inside its TTL
receipt('active-checkpoint.json', 0, { active: true }); // no written_at — in flight

const before = readdirSync(store).sort();
check('the fixture holds one expired, one fresh and one active receipt',
  before.length === 4 && before.includes('expired-a.json') && before.includes('fresh-c.json') && before.includes('active-checkpoint.json'),
  before.join(', '));

// Load the retention module the tool must own. Any of these shapes is an acceptable owner;
// what is NOT acceptable is "there is none".
const CANDIDATES = [
  'scripts/lib/devbaseline/retention.mjs',
  'scripts/lib/devbaseline/ttl.mjs',
  'scripts/retention.mjs',
];
// A sweep may report what it removed as a count or as a list; both are countable evidence, and
// a report that names neither is not evidence — it is a deletion the reader cannot audit.
const removedCount = (r = {}) => {
  for (const k of ['removed_count', 'removed', 'expired', 'removed_paths', 'expired_paths']) {
    const v = r[k];
    if (Array.isArray(v)) return v.length;
    if (Number.isFinite(Number(v))) return Number(v);
  }
  return NaN;
};

const owner = CANDIDATES.map(p => path.join(CODE, p)).find(p => existsSync(p));

if (!owner) {
  check('the tool owns a retention module with an injectable clock (accelerated TTL sweep)', false,
    `none of ${CANDIDATES.join(', ')} exists — ttl_days is written into the record and nothing ever reads it`);
} else {
  const mod = await import(pathToFileURL(owner).href);
  const sweep = mod.sweepExpiredArtifacts || mod.enforceRetention || mod.expire || (mod.default && mod.default);
  check('the retention module exposes a sweep entry point', typeof sweep === 'function',
    `${path.relative(CODE, owner)} exports: ${Object.keys(mod).join(', ')}`);
  if (typeof sweep === 'function') {
    // The clock is injected and accelerated: 100 days pass in milliseconds, so an expiry that
    // depends on wall time is not what is being measured.
    const result = sweep({ storeDir: store, now: T0, clock: () => T0 }) || {};
    const after = readdirSync(store).sort();
    check('an expired artifact is removed', !after.includes('expired-a.json') && !after.includes('expired-b.json'), after.join(', '));
    check('an artifact inside its TTL is kept', after.includes('fresh-c.json'), after.join(', '));
    check('an ACTIVE artifact is never swept', after.includes('active-checkpoint.json'), after.join(', '));
    check('the sweep reports what it removed (countable evidence)', removedCount(result) === 2,
      JSON.stringify(result));
    // Idempotence: the second sweep must find nothing left to do and remove nothing more.
    const second = sweep({ storeDir: store, now: T0, clock: () => T0 }) || {};
    const third = readdirSync(store).sort();
    check('a repeat sweep is safe and removes nothing further',
      third.join(',') === after.join(',') && removedCount(second) === 0,
      JSON.stringify(second));
  }
}

// The declared policy must still be asserted where it is actually configuration: the retention
// the workflows hand to GitHub's artifact storage. Recorded, not simulated — GitHub expires
// those server-side and no sandbox can force it.
const wfUpload = ['.github/workflows/autofix-callable.yml', '.github/workflows/devbaseline-callable.yml']
  .map(f => ({ f, text: existsSync(path.join(CODE, f)) ? readFileSync(path.join(CODE, f), 'utf8') : '' }))
  .filter(x => x.text.includes('upload-artifact'));
check('the uploaded artifact declares a non-zero retention to GitHub (configuration, not a cleanup)',
  wfUpload.length === 2 && wfUpload.every(x => /retention-days:\s*([1-9]\d*)/.test(x.text)),
  wfUpload.map(x => `${x.f}: ${(x.text.match(/retention-days:\s*\d+/) || ['—'])[0]}`).join(' · '));

const failed = results.filter(r => !r.ok);
const out = {
  probe: 'retention as an enforced policy vs a declared number',
  storage_boundary: 'local receipt store (the boundary a sandbox can honestly exercise)',
  github_managed_expiry: 'declared via upload-artifact retention-days; server-side, asserted as configuration only, not simulated',
  checks: results,
  passed: results.length - failed.length,
  total: results.length,
  verdict: failed.length ? 'DEFECT — retention is declared, not enforced' : 'retention enforced',
  workdir: root,
};
if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); } else {
  console.log(`\nR4 retention probe — ${out.passed}/${out.total} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nverdict: ${out.verdict}\nworkdir: ${root}`);
}
try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed.length ? 1 : 0);

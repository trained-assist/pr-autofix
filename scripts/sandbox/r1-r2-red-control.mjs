#!/usr/bin/env node
// R1/R2 RED CONTROL — proves the fixes are discriminating, not cosmetic.
//
// Every scenario below was accepted (ok:true) by the PRE-FIX judgeFix of commit 6e49f10.
// The NEW judgeFix (same file, after the R1/R2 fix) must REJECT each one. A control that
// cannot fail proves nothing: this file runs BOTH validators side by side on identical
// inputs and fails loudly if the new one is not strictly stronger.
//
//   node r1-r2-red-control.mjs            # compare old vs new
//   node r1-r2-red-control.mjs --json     # machine-readable

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.resolve(HERE, '..', '..'); // this file lives at <repo>/scripts/sandbox/
const HARNESS = path.join(HERE, 'r2-hosted-harness.mjs');
const AS_JSON = process.argv.includes('--json');

// ── The PRE-FIX judgeFix, extracted verbatim from 6e49f10 ──────────────────────
// This is the exact decision logic the it.7 reviewer proved wrong. It is reproduced here
// so the red control measures the FIX, not a paraphrase of it.
const COMMIT_ALLOWED = ['.devbaseline/', 'docs/', 'README.md', 'broken/'];
const isFixSubject = (f) => ['.devbaseline/', 'docs/', 'broken/'].some((p) => f === p || f.startsWith(p));
function judgeFixOld({ fixFiles = [], runnerBefore = null, runnerAfter = null, evidence = {} }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const outside = fixFiles.filter((f) => !COMMIT_ALLOWED.some((p) => f === p || f.startsWith(p)));
  add('the fix commit touches only allowlisted paths', outside.length === 0,
    outside.length ? `unexpected: ${outside.slice(0, 6).join(', ')}` : `${fixFiles.length} file(s)`);
  const gitlinks = (runnerAfter?.gitlinks || []).filter(Boolean);
  add('no tooling gitlink (160000) in the runner index', gitlinks.length === 0, gitlinks.slice(0, 4).join(', '));
  const beforeOk = Boolean(runnerBefore && runnerBefore.fingerprint && runnerBefore.index !== undefined);
  const afterOk = Boolean(runnerAfter && runnerAfter.fingerprint && runnerAfter.index !== undefined);
  add('runner state captured before and after the fixer', beforeOk && afterOk,
    beforeOk && afterOk ? 'captured' : 'missing');
  if (runnerBefore && runnerAfter) {
    const collateral = Object.entries(runnerBefore.fingerprint || {})
      .filter(([k]) => !k.startsWith('.git/') && !isFixSubject(k)
        && runnerAfter.fingerprint[k] !== runnerBefore.fingerprint[k])
      .map(([k]) => k);
    add('runner content outside the fix subject survives untouched', collateral.length === 0,
      collateral.length ? collateral.slice(0, 6).join(', ') : 'compared');
    const toolPaths = Object.keys(runnerAfter.fingerprint || {})
      .filter((k) => k.includes('pr-autofix/') || k.includes('runner/temp'));
    add('no tool tree materialized into the consumer tree', toolPaths.length === 0, toolPaths.slice(0, 4).join(', '));
  }
  const need = ['caller_sha', 'tool_sha', 'run_id', 'run_url', 'logs', 'patch', 'changed_files', 'receipt', 'shipped_job'];
  const missing = need.filter((k) => !evidence[k]);
  add('the evidence bundle is complete before teardown', missing.length === 0, missing.join(', '));
  const raw = evidence.shipped_job || {};
  const job = typeof raw === 'string' ? { name: raw.split(' — ')[0], conclusion: raw.split(' — ').slice(1).join(' — ') } : raw;
  const ran = job.name && job.conclusion && !/^(skipped|cancelled|neutral)$/.test(job.conclusion);
  add('the shipped autofix job actually ran', Boolean(ran), `${job.name || 'no autofix job'} — ${job.conclusion || 'absent'}`);
  return { checks, ok: checks.every((c) => c.ok) };
}

// ── Load the NEW judgeFix by importing the harness's own module scope ───────────
// judgeFix is not exported, so we evaluate the harness in a child process per scenario.
// That keeps the red control honest: it measures the shipped code, not a copy.
// ── Load the NEW judgeFix by evaluating the SHIPPED source verbatim ─────────────
// judgeFix is not exported, so the source between its constants and the self-test is
// extracted byte-for-byte into a temp module and imported. That keeps the red control
// honest: it measures the shipped code, not a paraphrase of it. The file is deleted after.
function judgeFixNew(input) {
  const src = readFileSync(HARNESS, 'utf8');
  const start = src.indexOf('const ALLOWLIST_PREFIXES');
  const end = src.indexOf('// ── self-test');
  if (start === -1 || end === -1) throw new Error('could not locate judgeFix in the harness source');
  const tmp = path.join(require('node:os').tmpdir(), `judgefix-extract-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(tmp, `${src.slice(start, end)}\nexport { judgeFix };\n`);
  try {
    const r = spawnSync(process.execPath, ['-e', `
      import(${JSON.stringify(`file://${tmp}`)}).then((m) => {
        process.stdout.write(JSON.stringify(m.judgeFix(${JSON.stringify(input)})));
      }).catch((e) => { console.error('IMPORT_FAILED ' + e.message); process.exit(3); });
    `], { encoding: 'utf8', cwd: CODE });
    if (r.status !== 0) throw new Error(`harness evaluation failed (status=${r.status}): ${(r.stderr || r.stdout || 'no output').slice(0, 500)}`);
    return JSON.parse(r.stdout);
  } finally { rmSync(tmp, { force: true }); }
}

// ── The three scenarios the it.7 reviewer's independent probe proved wrong ──────
// Each is ok:true under the OLD validator. Each must be ok:false under the NEW one.
const EVIDENCE_OK = {
  caller_sha: 'c'.repeat(40), tool_sha: 'b'.repeat(40), run_id: '1',
  run_url: 'https://example.invalid/runs/1', logs: 'sanitized.log', patch: 'fix.patch',
  changed_files: '.devbaseline/log.json,broken/bad.md', receipt: '.devbaseline/log.json',
  shipped_job: 'autofix — success',
};
const FP = { 'README.md': 'F aaa', 'broken/': 'D', 'broken/bad.md': 'F bbb', 'outside/': 'D', 'outside/precious.txt': 'F ccc' };
const IDX = '100644 aaa\tREADME.md\n100644 bbb\tbroken/bad.md';

const scenarios = [
  {
    id: 'R1-a',
    name: 'a FAILED shipped job was accepted as "ran" by the old blacklist',
    input: { fixFiles: ['.devbaseline/log.json'], runnerBefore: { fingerprint: FP, index: IDX, gitlinks: [] },
      runnerAfter: { fingerprint: FP, index: IDX, gitlinks: [] },
      evidence: { ...EVIDENCE_OK, shipped_job: 'autofix — failure' } },
    expect_old: true, expect_new: false,
  },
  {
    id: 'R1-b',
    name: 'an extra staged path in runnerAfter.index was invisible (field-presence check only)',
    input: { fixFiles: ['.devbaseline/log.json'], runnerBefore: { fingerprint: FP, index: IDX, gitlinks: [] },
      runnerAfter: { fingerprint: FP, index: `${IDX}\n100644 ccc\tsecret.txt`, gitlinks: [] },
      evidence: EVIDENCE_OK },
    expect_old: true, expect_new: false,
  },
  {
    id: 'R1-c',
    name: 'an untracked file in runnerAfter.status_porcelain was ignored entirely',
    input: { fixFiles: ['.devbaseline/log.json'], runnerBefore: { fingerprint: FP, index: IDX, gitlinks: [], status_porcelain: '' },
      runnerAfter: { fingerprint: FP, index: IDX, gitlinks: [], status_porcelain: '??  secret.txt' },
      evidence: EVIDENCE_OK },
    expect_old: true, expect_new: false,
  },
];

let allOk = true;
const results = [];
for (const s of scenarios) {
  const oldV = judgeFixOld(s.input);
  const newV = judgeFixNew(s.input);
  const oldAsExpected = oldV.ok === s.expect_old;
  const newAsExpected = newV.ok === s.expect_new;
  const discriminating = oldV.ok === true && newV.ok === false;
  const pass = oldAsExpected && newAsExpected && discriminating;
  allOk = allOk && pass;
  results.push({ id: s.id, name: s.name, old_ok: oldV.ok, new_ok: newV.ok,
    expected_old: s.expect_old, expected_new: s.expect_new,
    discriminating, pass,
    new_failed_checks: newV.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` — ${c.detail}` : ''}`) });
  const mark = pass ? 'ok  ' : 'FAIL';
  process.stdout.write(`${mark} ${s.id} — ${s.name}\n`);
  process.stdout.write(`       old: ok=${oldV.ok} (expected ${s.expect_old})  new: ok=${newV.ok} (expected ${s.expect_new})  discriminating=${discriminating}\n`);
  for (const c of newV.checks) if (!c.ok) process.stdout.write(`       red: ${c.name}${c.detail ? ` — ${c.detail}` : ''}\n`);
}

const report = {
  probe: 'r1-r2-red-control',
  tool_sha_hint: readFileSync(HARNESS, 'utf8').length,
  ok: allOk,
  verdict: allOk
    ? 'DISCRIMINATING — every scenario the it.7 reviewer proved wrong is accepted by the old validator and rejected by the new one'
    : 'NOT DISCRIMINATING — the fix does not strictly improve on the pre-fix validator',
  scenarios: results,
};
if (AS_JSON) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`\nverdict: ${report.verdict}\n`);
process.exit(allOk ? 0 : 1);
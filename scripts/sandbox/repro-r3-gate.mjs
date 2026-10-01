#!/usr/bin/env node
// R3 regression — a red gate cannot turn green, and a declared staging.command actually runs.
//
// The defect had two halves and neither was a shell bug:
//
//   1. `devbaseline-callable.yml` branched on exit code 2 and exited 0, so `needs_human` —
//      "the profile has no fixer, or fix.cap is spent" — became a GREEN required check. Under
//      `bash -e` the shell was correct for 0/1/3 and masked exactly 2.
//   2. `staging.command` is declared in the adapter schema and returned by effectiveConfig
//      (adapter.mjs:91) and was executed NOWHERE. A repository named the command that rehearses
//      its merge gate and nothing ran it.
//
// Assertions:
//   A. the truth table verify{0,1,2,3} × staging{ok,fail} against the required colour — 2 must
//      BLOCK, and a failing declared staging command must block even when verify is green;
//   B. the workflow no longer contains the mask, and has exactly ONE gate line;
//   C. a declared staging.command is executed (a marker file proves it ran);
//   D. the classification is not lost: needs_human still records its own outcome/reason_code.
//
//   node scripts/sandbox/repro-r3-gate.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'devbaseline.mjs');
const KEEP = process.argv.includes('--keep');
const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'repro-r3-'));
const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

const gate = (repoDir, extra = []) => {
  const r = spawnSync('node', [CLI, 'gate', '--repo', repoDir, ...extra], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, DEVBASELINE_OFFLINE: '1' },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

/** A repository whose check exit code and declared staging command we control. */
function fixture(name, { checkExit, stagingCommand = null }) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  writeFileSync(path.join(dir, 'marker.txt'), '');
  // The check is a script whose exit code the fixture chooses — no npm, no network.
  writeFileSync(path.join(dir, 'check.sh'), `#!/bin/sh\nexit ${checkExit}\n`);
  spawnSync('chmod', ['+x', path.join(dir, 'check.sh')]);
  const adapter = {
    schema_version: 1,
    profile: 'minimal',
    check: { commands: ['./check.sh'] },
    autofix: { enabled: false },
  };
  if (stagingCommand) adapter.staging = { required: true, command: stagingCommand };
  writeFileSync(path.join(dir, '.devbaseline.json'), `${JSON.stringify(adapter, null, 2)}\n`);
  return dir;
}

try {
  // ── B. the workflow has no mask and one gate line ────────────────────────────
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'devbaseline-callable.yml'), 'utf8');
  const masked = /if\s*\[\s*"\$code"\s*=\s*"2"\s*\]/.test(wf) || /code"\s*=\s*"2"/.test(wf);
  check('workflow has no `code = 2 → exit 0` mask', !masked, /code"\s*=\s*"2"/.exec(wf)?.[0] ?? '—');
  check('workflow has exactly one gate invocation', (wf.match(/\bgate --repo/g) || []).length === 1,
    `found ${(wf.match(/\bgate --repo/g) || []).length}`);
  check('workflow no longer uses node --check on the payload', !/node --check "\$RUNNER_TEMP/.test(wf));

  // ── C. a declared staging.command is EXECUTED ────────────────────────────────
  // The command's whole purpose is to leave evidence; if it never runs, no evidence appears.
  const marker = path.join(root, 'staging-ran.txt');
  const fOk = fixture('staging-ok', { checkExit: 0, stagingCommand: `node -e "require('fs').writeFileSync('${marker}','ran')"` });
  const gOk = gate(fOk);
  check('declared staging.command is executed (marker file written)', existsSync(marker),
    `gate output: ${gOk.out.trim().slice(0, 200)}`);
  check('verify 0 + staging 0 → GREEN (exit 0)', gOk.code === 0, `exit ${gOk.code}`);

  // ── A1. the truth table, on the mapping itself ──────────────────────────────
  // verify{0,1,2,3} → blocks? Only 0 is green. An unknown code also blocks: silence is not a pass.
  const { verdictForVerify } = await import(path.join(ROOT, 'scripts', 'lib', 'devbaseline', 'gate.mjs'));
  const table = [0, 1, 2, 3, 99].map(verdictForVerify);
  check('truth table: only exit 0 is green', table[0].blocks === false && table.slice(1).every(v => v.blocks === true),
    JSON.stringify(table.map(v => [v.code, v.blocks, v.outcome])));
  check('the mapping names needs_human as its own outcome', table[2].outcome === 'needs_human', table[2].outcome);

  // ── A2. the truth table, end to end through the CLI ─────────────────────────
  // verify 1 (controlled failure), no staging → blocked
  const fFail = fixture('check-fails', { checkExit: 1 });
  const gFail = gate(fFail);
  check('verify 1 (failed) → RED', gFail.code !== 0, `exit ${gFail.code}`);
  // A failing check on a profile with no fixer is reported as needs_human (2) — that IS the R3
  // case. Exit 1 (controlled failure, fixer dispatched) needs a live fixer, so it is covered by
  // the truth table below rather than by a fixture that would have to fake a dispatch.
  check('a failing check names the rule that stopped it', /unsupported_by_profile|cap_exhausted|check_command_failed/.test(gFail.out),
    gFail.out.trim().slice(0, 160));

  // verify 2 — needs_human. Reached by a failing check on a profile with NO fixer, which is
  // exactly the case the old workflow reported as green.
  const fHuman = fixture('needs-human', { checkExit: 1 });
  const gHuman = gate(fHuman);
  check('verify 2 (needs_human) → RED (was green: the R3 defect)', gHuman.code !== 0, `exit ${gHuman.code}`);
  // D. the classification survives
  check('needs_human still records outcome + reason_code', /outcome: needs_human/.test(gHuman.out) && /reason_code: /.test(gHuman.out),
    gHuman.out.trim().slice(0, 200));

  // a FAILING declared staging command blocks even when verify is green
  const fStagingFail = fixture('staging-fails', { checkExit: 0, stagingCommand: 'node -e "process.exit(3)"' });
  const gStagingFail = gate(fStagingFail);
  check('verify 0 + staging 3 → RED (staging is part of the gate)', gStagingFail.code !== 0, `exit ${gStagingFail.code}`);
  check('the red staging command is named in the output', /staging:.*exit 3/.test(gStagingFail.out), gStagingFail.out.trim().slice(0, 200));
  check('reason_code says the staging command failed', /staging_command_failed/.test(gStagingFail.out), gStagingFail.out.trim().slice(0, 200));

  // no staging declared at all → the gate is exactly verify, not more and not less
  const fNone = fixture('no-staging', { checkExit: 0 });
  const gNone = gate(fNone);
  check('verify 0 with no declared staging → GREEN', gNone.code === 0, `exit ${gNone.code}`);
  check('the gate reports that no staging command is declared', /staging: none declared/.test(gNone.out), gNone.out.trim().slice(0, 200));

  const failed = results.filter(r => !r.ok);
  console.log(`\nR3 gate reproduction — ${results.length - failed.length}/${results.length} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nworkdir: ${root}${KEEP ? '' : ' (removed)'}`);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('repro harness error:', e && e.stack ? e.stack : e);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(2);
}
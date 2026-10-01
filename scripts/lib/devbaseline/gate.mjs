// The ONE owner of "does this repository block the merge?" (R3).
//
// Two halves, both real defects, neither fixable in shell:
//
// 1. The shipped workflow ran `verify`, then `if [ "$code" = "2" ]; then exit 0; fi` — an
//    explicit branch that turned `needs_human` into a GREEN required check. Under `bash -e` the
//    shell was mechanically correct for 0/1/3 and masked exactly 2. The branch encoded the
//    decision recorded in run.mjs: "needs_human is deliberately NOT a pipeline failure". Fixing
//    only the shell would have left the source of that decision still asserting it, and the next
//    workflow would reintroduce the mask. So the axis "does this block the merge" gets ONE owner
//    here, and `needs_human` BLOCKS.
//
//    What is NOT lost: the classification stays. A repository whose profile has no fixer, or whose
//    fix.cap is spent, still reports its own `outcome` and `reason_code`, so the number of
//    unresolved cases remains countable — a red check with a distinct reason, not a silent pass.
//
// 2. `staging.command` was declared in the adapter schema and returned by effectiveConfig
//    (adapter.mjs:91) and executed NOWHERE. The repository said which command rehearses its merge
//    gate, and nothing ever ran it. runGate runs it through the same runner `verify` uses, and a
//    non-zero exit makes the gate red.
//
// `verify`'s own exit codes are NOT changed: they are an external contract for consumers reading
// them (design §2.1, AC-19). Only the mapping onto a check colour changes.

import { verify } from './run.mjs';
import { spawnSync } from 'node:child_process';
import { resolveRepo } from './resolve.mjs';
import { effectiveConfig } from './adapter.mjs';
import { expandCommand } from './profile.mjs';
import { writeLogRecord } from './log.mjs';

const COMBINED_TIMEOUT_MS = 120_000;

/**
 * The mapping, in one place: exit code → does the merge gate block?
 * 0 pass/no_change is the ONLY green. needs_human (2) is a real gap with nobody able to close it
 * automatically — exactly the case that must not pass unnoticed.
 */
export const GATE_BLOCKS = { 0: false, 1: true, 2: true, 3: true };

export function verdictForVerify(code) {
  const blocks = GATE_BLOCKS[code] ?? true; // unknown code blocks: silence is not a pass
  return {
    blocks,
    verdict: blocks ? 'blocked' : 'passed',
    code,
    outcome: code === 0 ? 'pass' : code === 1 ? 'failed' : code === 2 ? 'needs_human' : 'invalid',
  };
}

function runOne(cmd, cwd) {
  const r = spawnSync(cmd, {
    cwd, shell: true, encoding: 'utf8', timeout: COMBINED_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DEVBASELINE_OFFLINE: process.env.DEVBASELINE_OFFLINE || '1' },
  });
  return { code: r.status === null ? -1 : r.status, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/**
 * verify() + the declared staging command. Both must be green for the gate to be green.
 * @returns {{verdict, blocks, code, outcome, reason_code, verify, staging}}
 */
export function runGate({ repoDir, profileId = '', typeHint = null, attempt = 1, allowFix = true, runCommand = runOne } = {}) {
  const result = verify({ repoDir, profileId, typeHint, attempt, allowFix });

  // The adapter's staging command is read through the SAME seam as the profile (R5) — two
  // readers would be two answers about what this repository declared.
  const resolved = resolveRepo({ repoDir, profileId, typeHint });
  let staging = { declared: false, code: null, output: '' };
  if (resolved.ok) {
    const config = effectiveConfig({ profile: resolved.profile, adapter: resolved.adapter });
    const declared = config.staging_command;
    if (declared) {
      const r = runCommand(expandCommand(declared), repoDir);
      staging = { declared: true, command: declared, code: r.code, output: r.output };
    }
  }

  const v = verdictForVerify(result.code);
  // A declared staging command that fails blocks, even when verify is green: the repository said
  // the merge gate is rehearsed by this command, and it did not pass.
  const stagingBlocks = staging.declared && staging.code !== 0;
  const blocks = v.blocks || stagingBlocks;

  return {
    ...result,
    verdict: blocks ? 'blocked' : 'passed',
    blocks,
    reason_code: stagingBlocks && !v.blocks ? 'staging_command_failed' : (result.record.reason_code ?? null),
    staging,
  };
}

/** Thin CLI wrapper so the workflow has ONE line and no shell branch of its own. */
export function cmdGate(flags = {}) {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  const repoDir = String(flags.repo || '.');
  const gate = runGate({
    repoDir,
    profileId: flags.profile ? String(flags.profile) : '',
    typeHint: flags['type-hint'] ? String(flags['type-hint']) : null,
    attempt: flags.attempt ? Number(flags.attempt) : 1,
    allowFix: flags['no-fix'] ? false : true,
  });

  out(`gate: ${gate.verdict} (verify exit ${gate.code} → ${gate.outcome}${gate.blocks ? ', blocks the merge' : ''})`);
  out(`profile: ${gate.profile} · adapter: ${gate.adapter}`);
  // The EFFECTIVE reason: the record's own classification, overridden when the declared staging
  // command is what blocked. Two reasons for a red gate is the whole point — "needs_human" and
  // "staging_command_failed" lead to different next actions.
  out(`outcome: ${gate.outcome} · rule_id: ${gate.record.rule_id ?? '—'} · reason_code: ${gate.reason_code ?? '—'}`);
  if (gate.staging.declared) {
    out(`staging: ${gate.staging.command} → exit ${gate.staging.code}${gate.staging.code === 0 ? '' : ' (blocks)'}`);
  } else {
    out('staging: none declared by the profile or adapter');
  }
  for (const v of gate.record.gate_violations) out(`  · ${v.rule_id}: ${v.path}: ${v.message}`);

  if (flags.log) {
    // R2: persist the GATE verdict, not the record of the verify run it contains. The two answers
    // are different facts — "what is wrong with the repository" (outcome/rule_id) and "does this
    // block the merge" (gate.*) — and writing only the first let a red staging leave `no_change`
    // on disk as the audit artifact of a blocked merge.
    const gateBlock = {
      verdict: gate.verdict,
      blocks: gate.blocks,
      verify_exit: gate.code,
      reason_code: gate.reason_code ?? null,
      staging: { declared: gate.staging.declared, command: gate.staging.command ?? null, code: gate.staging.code },
    };
    writeLogRecord(String(flags.log), { ...gate.record, gate: gateBlock, patch: { commit: null, source: 'none' } });
    out(`log: ${flags.log}`);
  }
  return gate.blocks ? 1 : 0;
}
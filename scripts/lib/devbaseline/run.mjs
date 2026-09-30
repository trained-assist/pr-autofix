// The verify runner: check → (fix, if a fixer is registered) → verify-again.
//
// Exit codes are the external contract (design §2.1) and are read by the staging rehearsal
// through the CLI, never by calling this module (AC-19):
//   0 pass / no_change      1 controlled failure      2 needs_human      3 invalid config
//
// `needs_human` (2) is deliberately NOT a pipeline failure: either the profile has no fixer,
// or `fix.cap` attempts are spent. It is reported with its own outcome and reason_code so the
// number of unresolved cases is countable rather than anecdotal.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadAdapter, effectiveConfig, ADAPTER_FILENAME } from './adapter.mjs';
import { resolveProfile, expandCommand, profileHasBuild } from './profile.mjs';
import { buildLogRecord, writeLogRecord, gitInfo, estTokens } from './log.mjs';

export const VERIFY_CODES = { pass: 0, failed: 1, needs_human: 2, invalid: 3 };
const COMBINED_TIMEOUT_MS = 120_000;

function runCommand(cmd, cwd) {
  const r = spawnSync(cmd, {
    cwd, shell: true, encoding: 'utf8', timeout: COMBINED_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DEVBASELINE_OFFLINE: process.env.DEVBASELINE_OFFLINE || '1' },
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return { code: r.status === null ? -1 : r.status, output: out };
}

function runAll(commands, cwd) {
  const results = [];
  for (const c of commands) results.push({ command: c, ...runCommand(expandCommand(c), cwd) });
  return results;
}

const failedStep = (results) => results.find(r => r.code !== 0) || null;

/**
 * Paths the run actually covered. Included = context entrypoints that exist in the tree
 * (plus the adapter when it is a file). Omitted = entrypoints that are absent, and profile
 * exclude paths that exist — with the reason attached, because "omitted" without a reason is
 * indistinguishable from "we forgot".
 */
function coveragePaths(repoDir, config, adapterSource, excludePaths = []) {
  const included = [];
  const omitted = [];
  const excluded = new Set(excludePaths);
  for (const e of config.context_entrypoints) {
    if (excluded.has(e)) { omitted.push({ path: e, reason: 'excluded_by_profile' }); continue; }
    if (fs.existsSync(path.join(repoDir, e))) included.push(e);
    else omitted.push({ path: e, reason: 'entrypoint_absent' });
  }
  if (adapterSource === 'file') included.push(ADAPTER_FILENAME);
  return { included: [...new Set(included)].sort(), omitted };
}

function record(args) {
  return writeLogRecord(args.logFile, buildLogRecord(args));
}

function invalidConfig(repoDir, { ruleId, message, adapterSource = 'derived', profileId = 'unknown', code = VERIFY_CODES.invalid }) {
  return {
    code, profile: profileId, adapter: adapterSource, outcome: 'failed',
    record: buildLogRecord({
      outcome: 'failed', profileId, adapterSource, mode: 'verify', attempt: 1,
      ruleId, reasonCode: 'check_failed', patchRefs: [], includedPaths: [], omittedPaths: [],
      source: { ...gitInfo(repoDir) }, budget: {}, ttlDays: 90, credentials: [],
      gateViolations: [{ rule_id: ruleId, path: ADAPTER_FILENAME, message }],
    }),
  };
}

/**
 * @param {{repoDir: string, profileId?: string, typeHint?: string|null, logFile?: string,
 *          attempt?: number, allowFix?: boolean}} input
 */
export function verify(input) {
  const repoDir = path.resolve(input.repoDir || '.');
  const attempt = Math.max(1, Number(input.attempt) || 1);

  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    return invalidConfig(repoDir, { ruleId: 'adapter_schema_violation', message: `repo directory does not exist: ${repoDir}` });
  }

  const adapterResult = loadAdapter(repoDir);
  if (!adapterResult.ok) return invalidConfig(repoDir, { ruleId: 'adapter_schema_violation', message: adapterResult.message });

  const prof = resolveProfile({ repoDir, profileId: input.profileId, typeHint: input.typeHint });
  if (!prof.ok) return invalidConfig(repoDir, { ruleId: prof.rule_id, message: prof.message, adapterSource: adapterResult.source });

  const profile = prof.profile;
  const config = effectiveConfig({ profile, adapter: adapterResult.adapter });
  const { included, omitted } = coveragePaths(repoDir, config, adapterResult.source, profile.context.exclude_paths);
  const git = gitInfo(repoDir);
  const source = { repo: input.repo || git.repo || '', base_commit: git.base_commit, head_commit: git.head_commit, run_id: input.runId || 'local', pr: input.pr || '' };

  // A fixer is registered only when the profile declares a callable AND this repository
  // actually has it. Declaring a fixer the repo does not have is exactly the case that turns a
  // controlled failure into a silent "nothing to fix".
  const callableRel = config.fix_autofix_callable;
  const fixerRegistered = Boolean(callableRel) && fs.existsSync(path.join(repoDir, callableRel));

  const checkResults = runAll(config.check_commands, repoDir);
  const bad = failedStep(checkResults);
  const logText = checkResults.map(r => r.output).join('\n');
  const budget = { ...config.budget, diff_tokens_used: estTokens(logText) };

  const base = {
    profileId: profile.id, adapterSource: adapterResult.source, mode: 'verify', attempt,
    source, includedPaths: included, omittedPaths: omitted, budget,
    ttlDays: config.logs.retention_days, credentials: config.credentials,
    checkOutput: checkResults.map(r => r.output).join('\n'), logText,
  };

  if (!bad) {
    // Nothing failed, therefore nothing was changed. `no_change` is the honest outcome for a
    // green verify — including the very first one, and including every repeat. A separate
    // "first success" state would only mean "the log file did not exist yet".
    return {
      code: VERIFY_CODES.pass, profile: profile.id, adapter: adapterResult.source, outcome: 'no_change',
      record: buildLogRecord({ ...base, outcome: 'no_change', ruleId: null, reasonCode: 'no_change', patchRefs: [] }),
    };
  }

  const reason = `check step failed (exit ${bad.code}): ${bad.command}`;

  if (input.allowFix === false || !fixerRegistered) {
    const ruleId = input.allowFix === false ? 'cap_exhausted' : 'unsupported_by_profile';
    return {
      code: VERIFY_CODES.needs_human, profile: profile.id, adapter: adapterResult.source, outcome: 'needs_human',
      record: buildLogRecord({
        ...base, outcome: 'needs_human', ruleId, reasonCode: ruleId, patchRefs: [],
        gateViolations: [{ rule_id: ruleId, path: callableRel || profile.id, message: fixerRegistered ? reason : `profile "${profile.id}" has no fixer for this repository (autofix_callable=${callableRel || 'null'}); ${reason}` }],
      }),
    };
  }

  if (attempt > config.fix_cap) {
    return {
      code: VERIFY_CODES.needs_human, profile: profile.id, adapter: adapterResult.source, outcome: 'needs_human',
      record: buildLogRecord({
        ...base, outcome: 'needs_human', ruleId: 'cap_exhausted', reasonCode: 'cap_exhausted', patchRefs: [],
        gateViolations: [{ rule_id: 'cap_exhausted', path: profile.id, message: `fix.cap=${config.fix_cap} exhausted at attempt ${attempt}; ${reason}` }],
      }),
    };
  }

  // Fix dispatch. Online this is a workflow_dispatch against the repo's own callable; in the
  // rehearsal there is no network and no token, so the ref recorded is an explicit local one.
  const patchRefs = dispatchFix({ callableRel, ref: config.fix_ref, attempt });

  const verifyResults = runAll(config.verify_commands, repoDir);
  const stillBad = failedStep(verifyResults);
  const combinedLog = `${logText}\n${verifyResults.map(r => r.output).join('\n')}`;
  const finalBudget = { ...budget, diff_tokens_used: estTokens(combinedLog), log_tokens_used: estTokens(combinedLog) };

  if (!stillBad) {
    return {
      code: VERIFY_CODES.pass, profile: profile.id, adapter: adapterResult.source, outcome: 'passed',
      record: buildLogRecord({
        ...base, logText: combinedLog, budget: finalBudget,
        outcome: 'passed', ruleId: null, reasonCode: 'passed', patchRefs,
      }),
    };
  }
  return {
    code: VERIFY_CODES.failed, profile: profile.id, adapter: adapterResult.source, outcome: 'failed',
    record: buildLogRecord({
      ...base, logText: combinedLog, budget: finalBudget,
      outcome: 'failed', ruleId: 'check_command_failed', reasonCode: 'check_failed', patchRefs,
      gateViolations: [{ rule_id: 'check_command_failed', path: bad.command, message: `${reason}; still failing after the fix attempt (exit ${stillBad.code})` }],
    }),
  };
}

/**
 * Record what a fix attempt points at.
 *
 * `patch_refs` holds REFERENCES, never URLs assembled from parts. GitHub's workflow_dispatch
 * answers 204 with no run id, so there is no run URL to record here — and inventing one from
 * run_id/attempt produces a link that looks real and 404s, which is worse than no link. A real
 * fix PR URL is added by autofix.mjs, which is the component that actually opens one.
 */
function dispatchFix({ callableRel, ref, attempt }) {
  const online = process.env.DEVBASELINE_OFFLINE !== '1' && Boolean(process.env.GH_TOKEN);
  return [online
    ? `workflow_dispatch:${callableRel}@${ref || 'unpinned'}#attempt=${attempt}`
    : `local-dispatch:${callableRel}@${ref || 'unpinned'}#attempt=${attempt}`];
}

export { writeLogRecord, profileHasBuild };
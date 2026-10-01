// The verify runner: check → (fix, if a fixer is registered) → verify-again.
//
// Exit codes are the external contract (design §2.1) and are read by the staging rehearsal
// through the CLI, never by calling this module (AC-19):
//   0 pass / no_change      1 controlled failure      2 needs_human      3 invalid config
//
// `needs_human` (2) means either the profile has no fixer, or `fix.cap` attempts are spent. It
// keeps its own outcome and reason_code so the number of unresolved cases is countable rather
// than anecdotal — and it BLOCKS the merge: the caller decides the colour through
// gate.mjs, which treats only exit 0 as green. An earlier version of this comment claimed
// needs_human was "deliberately NOT a pipeline failure", and a workflow branched on that claim to
// turn exit 2 into a green required check. The classification was always worth keeping; the
// exemption was not.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { effectiveConfig, ADAPTER_FILENAME } from './adapter.mjs';
import { expandCommand, profileHasBuild } from './profile.mjs';
import { resolveRepo } from './resolve.mjs';
import { buildLogRecord, writeLogRecord, gitInfo, estTokens, RULE_IDS } from './log.mjs';

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
 * Recover the rule IDs a check reported from its own output.
 *
 * A failed check is only useful if the log says WHICH rule fired. Without this, a run whose
 * profile has no fixer recorded `rule_id: unsupported_by_profile` — a fact about the ENGINE, not
 * about the repository — and the real violation (`docs_heading_missing: checklist.md: no
 * top-level (#) heading`) existed only in check_output, so the log said nothing was wrong while
 * the repository was red. The AutoFix path already carries `violations[{rule_id,path,message}]`
 * (autofix.mjs checkFixDiff); this reuses that shape rather than inventing a second one.
 *
 * Lines are the format `check-docs` prints verbatim (check-docs.mjs formatViolations):
 * `<rule_id>: <path>: <message>`. A line whose first token is not in the fixed dictionary is
 * chatter, not a violation — inventing a rule id for it would be worse than dropping it.
 */
export function parseCheckViolations(logText) {
  const out = [];
  const seen = new Set();
  for (const line of String(logText || '').split('\n')) {
    const m = /^\s*([a-z][a-z0-9_]*):\s+(\S.*)$/.exec(line);
    if (!m) continue;
    const [, ruleId, rest] = m;
    if (!RULE_IDS.includes(ruleId)) continue;
    const sep = rest.search(/:\s/);
    const p = sep > 0 ? rest.slice(0, sep).trim() : '';
    const message = sep > 0 ? rest.slice(sep + 1).trim() : rest.trim();
    const key = `${ruleId}|${p}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rule_id: ruleId, path: p || '(check output)', message });
  }
  return out;
}

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

  // One seam for the profile AND the adapter (R5): `verify` used to re-read the adapter and pass
  // only a subset of the resolver inputs, so a repository pinning a profile in
  // .devbaseline.json got that profile in `inventory` and a derived one here. A malformed
  // adapter surfaces as `ok: false` from the same call — it is never downgraded to `derived`.
  const resolved = resolveRepo({ repoDir, profileId: input.profileId, typeHint: input.typeHint });
  if (!resolved.ok) {
    return invalidConfig(repoDir, {
      ruleId: resolved.rule_id || 'adapter_schema_violation',
      message: resolved.message,
      adapterSource: resolved.adapterSource || 'derived',
    });
  }
  const adapterSource = resolved.adapterSource;

  const profile = resolved.profile;
  const config = effectiveConfig({ profile, adapter: resolved.adapter });
  const { included, omitted } = coveragePaths(repoDir, config, adapterSource, profile.context.exclude_paths);
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
  // What the CHECK itself found. Empty when the check failed without naming a rule — then the
  // generic `check_command_failed` stands, which is honest, rather than a guessed rule id.
  const checkViolations = parseCheckViolations(logText);
  const checkRuleId = checkViolations.length ? checkViolations[0].rule_id : null;

  const base = {
    profileId: profile.id, adapterSource, mode: 'verify', attempt,
    source, includedPaths: included, omittedPaths: omitted, budget,
    ttlDays: config.logs.retention_days, credentials: config.credentials,
    checkOutput: checkResults.map(r => r.output).join('\n'), logText,
  };

  if (!bad) {
    // Nothing failed, therefore nothing was changed. `no_change` is the honest outcome for a
    // green verify — including the very first one, and including every repeat. A separate
    // "first success" state would only mean "the log file did not exist yet".
    return {
      code: VERIFY_CODES.pass, profile: profile.id, adapter: adapterSource, outcome: 'no_change',
      record: buildLogRecord({ ...base, outcome: 'no_change', ruleId: null, reasonCode: 'no_change', patchRefs: [] }),
    };
  }

  const reason = `check step failed (exit ${bad.code}): ${bad.command}`;

  if (input.allowFix === false || !fixerRegistered) {
    const engineRuleId = input.allowFix === false ? 'cap_exhausted' : 'unsupported_by_profile';
    const message = fixerRegistered ? reason : `profile "${profile.id}" has no fixer for this repository (autofix_callable=${callableRel || 'null'}); ${reason}`;
    return {
      code: VERIFY_CODES.needs_human, profile: profile.id, adapter: adapterSource, outcome: 'needs_human',
      record: buildLogRecord({
        // `rule_id` names the rule that FIRED (the check's own rule when it named one);
        // `reason_code` names why the pipeline stopped here. They were the same field before,
        // which meant "nothing could fix it" overwrote the fact that the repository is red.
        ...base, outcome: 'needs_human', ruleId: checkRuleId || engineRuleId, reasonCode: engineRuleId, patchRefs: [],
        extra: { stopped_because: engineRuleId },
        gateViolations: [
          ...checkViolations,
          { rule_id: engineRuleId, path: callableRel || profile.id, message, engine_fact: true },
        ],
      }),
    };
  }

  if (attempt > config.fix_cap) {
    return {
      code: VERIFY_CODES.needs_human, profile: profile.id, adapter: adapterSource, outcome: 'needs_human',
      record: buildLogRecord({
        ...base, outcome: 'needs_human', ruleId: checkRuleId || 'cap_exhausted', reasonCode: 'cap_exhausted', patchRefs: [],
        extra: { stopped_because: 'cap_exhausted' },
        gateViolations: [
          ...checkViolations,
          { rule_id: 'cap_exhausted', path: profile.id, message: `fix.cap=${config.fix_cap} exhausted at attempt ${attempt}; ${reason}`, engine_fact: true },
        ],
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
  // Re-read the rules from the REPEAT run as well: the first run's rule may already be gone,
  // and a "still failing" record naming only the first rule would point at a solved problem.
  const remainingViolations = parseCheckViolations(verifyResults.map(r => r.output).join('\n'));

  if (!stillBad) {
    return {
      code: VERIFY_CODES.pass, profile: profile.id, adapter: adapterSource, outcome: 'passed',
      record: buildLogRecord({
        ...base, logText: combinedLog, budget: finalBudget,
        outcome: 'passed', ruleId: null, reasonCode: 'passed', patchRefs,
      }),
    };
  }
  return {
    code: VERIFY_CODES.failed, profile: profile.id, adapter: adapterSource, outcome: 'failed',
    record: buildLogRecord({
      ...base, logText: combinedLog, budget: finalBudget,
      outcome: 'failed',
      ruleId: remainingViolations[0]?.rule_id || 'check_command_failed',
      reasonCode: 'check_failed', patchRefs,
      extra: { failed_command: bad.command, exit_code: stillBad.code },
      gateViolations: [
        ...remainingViolations,
        { rule_id: 'check_command_failed', path: bad.command, message: `${reason}; still failing after the fix attempt (exit ${stillBad.code})`, engine_fact: true },
      ],
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
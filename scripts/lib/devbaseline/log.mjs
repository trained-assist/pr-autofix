// The log contract (design §2.4 / AC-44). One record from which you can read: which rule
// fired, which tool build produced it, how many attempts it took, which patches it produced,
// which source commit it ran against, which paths were included and omitted, and what the
// budget was. Nothing else is required to answer "how was this result assembled?".
//
// Two hard rules:
//   * `rule_id` comes from a FIXED dictionary. A new id is a new tag, never a new string —
//     otherwise "rule_id present" stops meaning "rule id we can act on".
//   * `request_id` is derived (<run>|<mode>|<attempt>), never a UUID and never a timestamp,
//     so that two runs of the same thing are comparable records.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { redact } from './secrets.mjs';

/** Fixed dictionary. Extending it is a deliberate act, tied to a release tag. */
export const RULE_IDS = [
  'workflow_edited', 'test_disabled', 'assertion_removed', 'test_file_deleted', 'lock_file_touched',
  'too_many_files', 'too_many_lines', 'docs_link_broken', 'docs_json_invalid', 'docs_heading_missing',
  'adapter_schema_violation', 'profile_unknown', 'check_command_failed', 'cap_exhausted',
  'unsupported_by_profile',
];

export const REASON_CODES = ['gate_rejected', 'check_failed', 'no_change', 'cap_exhausted', 'unsupported_by_profile', 'passed'];

export const OUTCOMES = ['passed', 'no_change', 'failed', 'needs_human'];

export const TOOL_NAME = 'pr-autofix';

/**
 * Real ref where the workflow provides one; honest `unpinned:local` where it does not.
 *
 * The sources are the TOOL's own pins (`AUTOFIX_TOOL_VERSION`, then the delivered pin
 * `AUTOFIX_WORKFLOW_REF`). There is deliberately no `GITHUB_WORKFLOW_REF` fallback: inside a
 * reusable workflow `github.*` (and the GITHUB_* defaults derived from it) identify the CALLER's
 * workflow — the consumer's ci.yml — per the GitHub context contract, so reading it here wrote
 * the consumer's ref into `tool.version` with a fully credible shape (pr-autofix#55). Without a
 * trustworthy pin the only honest answer is `unpinned:local`.
 */
export function toolVersion() {
  if (process.env.AUTOFIX_TOOL_VERSION) return process.env.AUTOFIX_TOOL_VERSION;
  const ref = process.env.AUTOFIX_WORKFLOW_REF || '';
  const at = ref.lastIndexOf('@');
  if (at > 0) return ref.slice(at + 1);
  return 'unpinned:local';
}

export function toolCommit() {
  // R3: the TOOL BUILD, and only ever the tool build. This used to be overridable by an
  // `extra.tool_commit` slot, which the autofix call site filled with the CONSUMER's patch commit —
  // so a record read as "pr-autofix built this" while naming the repository it fixed. Two
  // different entities shared one field, and a test rewritten under the new meaning kept it green.
  // The patch has its own slot (`patch.commit`); the tool build comes from the environment that
  // pins it, and anything that is not a 40-hex commit degrades to an honest `unpinned:local`
  // instead of asserting a provenance that does not exist.
  //
  // R2 (pr-autofix#55): no `GITHUB_WORKFLOW_SHA` fallback, for the same reason as toolVersion —
  // it is the CALLER's workflow identity, not the tool's. A 40-hex shape cannot tell the two
  // apart, so validation of the form would still launder the caller SHA into tool.commit.
  const declared = process.env.AUTOFIX_TOOL_COMMIT || process.env.AUTOFIX_WORKFLOW_SHA || '';
  return /^[0-9a-f]{40}$/.test(String(declared)) ? String(declared) : 'unpinned:local';
}

/** Rough token estimate — the same ~4-chars-per-token heuristic autofix.mjs uses. */
export const estTokens = (text) => Math.ceil(String(text ?? '').length / 4);

export function gitInfo(dir) {
  const unknown = { repo: null, head_commit: 'unknown', base_commit: 'unknown', clean: null, in_repo: false };
  // Only a directory that IS a worktree root gets repository facts. A subdirectory of someone
  // else's repository would otherwise report the ENCLOSING repo's remote and HEAD as if they
  // were its own — a plausible-looking lie in exactly the field AC-44 exists to make true.
  if (!dir || !fs.existsSync(path.join(dir, '.git'))) return unknown;
  const one = (args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }).trim();
    } catch { return ''; }
  };
  const head = one(['rev-parse', 'HEAD']);
  if (!head) return unknown;
  const base = one(['rev-parse', 'HEAD^']) || 'unknown';
  return { repo: one(['config', '--get', 'remote.origin.url']) || null, head_commit: head, base_commit: base, clean: one(['status', '--porcelain']) === '', in_repo: true };
}

/**
 * Build one log record. Every AC-44 field is always present — a field that is `null` is an
 * honest "did not apply"; a field that is ABSENT is indistinguishable from a version that
 * forgot it, which is exactly the failure AC-44 exists to prevent.
 */
export function buildLogRecord({
  outcome,
  profileId,
  adapterSource,
  mode = 'verify',
  attempt = 1,
  ruleId = null,
  reasonCode = null,
  patchRefs = [],
  includedPaths = [],
  omittedPaths = [],
  source = {},
  request = {},
  budget = {},
  ttlDays = 90,
  credentials = [],
  gateViolations = [],
  gateVerdict = null,
  patchCommit = null,
  patchSource = 'none',
  checkOutput = '',
  logText = '',
  extra = {},
}) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome "${outcome}"`);
  if (ruleId !== null && !RULE_IDS.includes(ruleId)) throw new Error(`rule_id "${ruleId}" is outside the fixed dictionary`);

  const runId = source.run_id || 'local';
  const b = { diff_tokens: 4000, log_tokens: 2500, max_files: 15, max_lines: 400, ...budget };
  const record = {
    contract_version: 1,
    ts: new Date().toISOString(),
    profile: profileId,
    adapter: adapterSource === 'file' ? `file:.devbaseline.json` : 'derived',
    tool: { name: TOOL_NAME, version: toolVersion(), commit: toolCommit() },
    source: {
      repo: source.repo || '',
      base_commit: source.base_commit || 'unknown',
      head_commit: source.head_commit || 'unknown',
      run_id: runId,
      pr: source.pr || '',
    },
    request: {
      mode,
      // Deterministic by design (design §2.6.4): no UUID, no clock.
      request_id: request.request_id || `${runId}:${mode}:${attempt}`,
      attempt,
    },
    rule_id: ruleId,
    reason_code: reasonCode,
    attempt_count: attempt,
    outcome,
    patch_refs: patchRefs,
    included_paths: includedPaths,
    omitted_paths: omittedPaths,
    budget: {
      diff_tokens: b.diff_tokens,
      diff_tokens_used: b.diff_tokens_used ?? 0,
      log_tokens: b.log_tokens,
      log_tokens_used: b.log_tokens_used ?? estTokens(logText),
      max_files: b.max_files,
      max_lines: b.max_lines,
    },
    // R2 — THE GATE VERDICT, PERSISTED. This record used to be written by `gate` while carrying
    // only the VERIFY record: a failed staging command left `outcome: no_change`, empty
    // `gate_violations` and the verify reason behind — the artifact said "nothing changed" about a
    // run that blocked the merge. The verdict lived in stdout, which nobody reads twice. It is in
    // the record now, and `gate` is what a reader re-derives from `verify_exit` + `staging`
    // (scripts/lib/devbaseline/receipt.mjs). Additive: a record written before this has no `gate`
    // block and stays valid.
    gate: gateVerdict ? {
      verdict: gateVerdict.verdict ?? null,
      blocks: gateVerdict.blocks ?? null,
      verify_exit: gateVerdict.verify_exit ?? null,
      reason_code: gateVerdict.reason_code ?? null,
      staging: {
        declared: gateVerdict.staging?.declared ?? false,
        command: gateVerdict.staging?.command ?? null,
        code: gateVerdict.staging?.code ?? null,
      },
    } : null,
    // R3 — THE PATCH IS NOT THE TOOL. `patch_refs` says where the change is; `patch.commit` says
    // which commit this run produced; `tool.commit` (above) says which build of pr-autofix ran.
    // Three entities, three slots, and none of them is an `extra.<key>` a call site can overwrite.
    patch: { commit: patchCommit || null, source: patchSource || 'none' },
    retention: {
      ttl_days: ttlDays,
      // R4 — a deadline nobody can compute. `written_at` is what makes the TTL a date; without it
      // `ttl_days` is a number and nothing on earth can decide whether this record is expired.
      written_at: new Date().toISOString(),
      artifact: source.artifact || `ci-fixer-stats-${source.pr || 'local'}-${runId}`,
    },
    credentials,
    gate_violations: gateViolations,
    // Additive (AC-44): what the CHECK itself found, as {rule_id, path, message} — the same
    // shape autofix.mjs already writes. `gate_violations` keeps additionally the engine-level
    // facts (why the pipeline stopped). Splitting them is what lets a reader answer both
    // "what is wrong with the repository" and "why was nothing fixed" from one record; before
    // this, the second answer overwrote the first.
    rule_violations: gateViolations.filter(v => v && RULE_IDS.includes(v.rule_id) && !v.engine_fact),
    ...extra,
  };
  return redactRecord(record);
}

/** Never let a secret-shaped value reach a written record, whatever produced it (AC-07). */
export function redactRecord(record) {
  return JSON.parse(redact(JSON.stringify(record)));
}

export function writeLogRecord(file, record) {
  if (!file) return null;
  // `log.json` in the current directory is a perfectly normal --log argument, and
  // mkdirSync('') throws — so the directory is created only when there IS one.
  const dir = path.dirname(path.resolve(file));
  if (dir && dir !== process.cwd()) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return file;
}
#!/usr/bin/env node
// CI auto-fix pipeline — three layers:
//
//   Pre-stage (deterministic, no AI):
//     A. Out-of-date branch  → update PR branch in place (clean) / merge + AI conflict resolution
//     B. Missing permissions → patch workflow YAML
//     C. Cloudflare DO conflict → bail with precise diagnosis
//
//   AI stages (llm-ladder worker, model free-ladder; only if pre-stage didn't apply):
//     Stage 1 (deepseek-v4-flash:free)    — diagnose: root cause + files to examine
//     Stage 2 (nemotron-3-super-120b:free) — contextualize: read real files, describe changes
//     Stage 3 (nemotron-3-ultra-550b:free) — patch: write the unified diff
//
// On success: creates a new fix/ci-* branch + PR (never pushes code to the original branch).
// Exception — no code of ours: a branch that is merely behind and merges cleanly is updated
// in place (GitHub update-branch on the original PR); a new PR is only for a change we author.
// The new PR auto-merges when CI passes; ci-fix-cleanup.yml then closes the original PR.
// Exits 0 on success (fix PR created), 1 on failure.
//
// ── Lifecycle ─────────────────────────────────────────────────────────────────
//
// Every action is logged as a GitHub PR comment with the prefix "pr-fixer:".
// GitHub IS the audit log — no external data model needed.
//
// Stage 0 (reasoning)   — understand WHY the PR exists before touching anything.
//                          If unclear → comment + label + stop. Never patch blindly.
// Pre-stage A/B/C       — deterministic fixes (no AI needed).
// Stage 1/2/3 (AI)      — cheap paid primary (deepseek-v4-flash) → free ladder; stage 3 = search/replace edits.
//
// ── Stats (category taxonomy) ──────────────────────────────────────────────────
// Every run writes ci-fixer-stats.json + appends to $GITHUB_STEP_SUMMARY.
// Categories (used to decide when to escalate to a paid-model second pass):
//
//   success:pre_a_update_in_place    branch was behind, merges clean → original PR branch
//                                    updated via GitHub update-branch (no new PR)
//   skip:not_behind                  merge failed but branch already contains base → no-op
//   success:pre_a_conflict_resolved  merge had conflicts → AI resolved them using PR purpose
//   success:pre_b_permissions        job lacked permissions → workflow YAML patched
//   success:ai                       3-stage free-model pipeline fixed it
//   success:agent                    AUTOFIX_AGENT=1: the coding agent produced a fix (fix PR CI decides)
//
//   fail:stage0_ambiguous       PR purpose unclear — skipping to avoid blind fix
//   fail:cloudflare_do          Cloudflare DO migration conflict (needs human)
//   fail:merge_conflict         git merge had conflicts and AI could not resolve them
//   fail:ai_conflict_resolution AI tried to resolve conflicts but failed/left markers
//   fail:permissions_no_workflow permission error but no patchable workflow found
//   fail:race_pr_closed         PR was already closed/merged before we started
//   fail:race_pr_superseded     PR still open but no longer ours: `superseded` label or head moved mid-run
//   fail:guard_unknown_state    live PR state could not be read — failing closed, nothing mutated
//   fail:update_branch          clean merge, but GitHub refused update-branch (head moved)
//   fail:ai_no_diagnose         Stage 1 could not identify root cause
//   fail:ai_low_confidence      Stage 1 diagnosed but confidence too low to patch
//   fail:ai_cannot_fix          Stage 3 returned CANNOT_FIX        ← paid-tier candidate
//   fail:ai_corrupt_patch       Stage 3 produced malformed diff     ← paid-tier candidate
//   fail:ai_tests_fail          patch applied but tests still fail  ← paid-tier candidate
//   fail:ai_model_error         llm-ladder error (worker unreachable / every rung failed)
//   fail:agent_no_change        AUTOFIX_AGENT=1: the agent finished without changing any file
//   fail:agent_error            (retired: an agent error now falls back to Stages 2–3; the
//                               result is then an ordinary success:ai / fail:ai_* category)
//   fail:diff_rejected          the fix diff failed the deterministic gate (weakened tests, lock
//                               files, too big) — never becomes a PR, whoever wrote it
//   fail:other                  unexpected error
//
// ── Batch mode ──────────────────────────────────────────────────────────────────
// Set RUN_ID=0 (or BATCH_MODE=true) to run without a CI log reference.
// In batch mode the script skips the CI log fetch and always tries pre-stage A
// (merge + AI conflict resolution). Use batch-fix-prs.yml workflow to trigger
// multiple PRs at once.

import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGuard, classifyLivePr, runGuardedSequence, GUARD } from './lib/supersede-guard.mjs';

const LOG_CHAR_LIMIT = 120000; // raw log cap BEFORE compressLog (which fits LOG_TOKEN_BUDGET)
const FILE_CHAR_LIMIT = 8000;
const MAX_FILES = 8;
// Structured input compression (PR-Agent style, issue #7). Budgets are in
// tokens, estimated as chars/4 — no tokenizer dependency in the runner.
const DIFF_TOKEN_BUDGET = 4000;      // compressed PR diff fed to every stage
const FILE_TOKEN_BUDGET = 2000;      // per-file excerpt in Stage 2
const HUNK_CTX_BEFORE = 3;           // asymmetric hunk context: 3 lines before,
const HUNK_CTX_AFTER = 1;            // 1 after each changed line
const FILE_WINDOW = 15;              // Stage 2: lines around each changed/log-cited line
const WHOLE_FILE_CHARS = 4000;       // Stage 2: small files are sent whole, not excerpted
const estTokens = s => Math.ceil(String(s).length / 4);

// Models: every stage calls ONE place — the trained-assist-llm-ladder worker
// (https://llm-ladder.trainedassist.store, repo trained-assist/trained-assist-llm-ladder), model
// `free-ladder`: OpenCode Go cheap rungs → OpenRouter :free, with per-model health, Go key
// rotation, JSON guard and response_format-400 retry done server-side. The bench-validated rung
// order that used to live here (FREE_MODEL_LADDER / GO_MODEL_LADDER / paid fallback) moved into
// the worker's config — one ladder for every trained-assist consumer (owner 2026-09-27).
const LADDER_URL = (process.env.LLM_LADDER_URL || 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
const LADDER_MODEL = process.env.AUTOFIX_LADDER || 'free-ladder';
const STAGE0_MODEL = LADDER_MODEL;
const STAGE1_MODEL = LADDER_MODEL;
const STAGE2_MODEL = LADDER_MODEL;
const STAGE3_MODEL = LADDER_MODEL;

// AUTOFIX_AGENT=1 (repo variable): after the Stage 1 diagnosis, a coding agent (opencode)
// replaces the single-shot Stages 2–3 — it reads files, edits, runs the failing tests and
// iterates. Its model calls go to the SAME llm-ladder worker with the SAME token, as an
// OpenAI-compatible provider (issue #21: the weak link is the fix step, not diagnosis).
const AGENT_MODE = process.env.AUTOFIX_AGENT === '1';
const AGENT_TIMEOUT_MS = (Number(process.env.AUTOFIX_AGENT_TIMEOUT_MIN) || 20) * 60_000;
const AGENT_BIN = process.env.AUTOFIX_AGENT_BIN || 'opencode';

// opencode config: one provider = the llm-ladder worker. The key is read from env at
// runtime ({env:…}), never written to disk; the model id is the ladder name.
function agentOpencodeConfig(ladderUrl = LADDER_URL, ladder = LADDER_MODEL) {
  return {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      ladder: {
        npm: '@ai-sdk/openai-compatible',
        name: 'llm-ladder',
        options: { baseURL: `${ladderUrl}/v1`, apiKey: '{env:LLM_LADDER_TOKEN}' },
        models: { [ladder]: { name: `ladder ${ladder}`, tool_call: true, limit: { context: 128000, output: 16000 } } },
      },
    },
    model: `ladder/${ladder}`,
    small_model: `ladder/${ladder}`,
  };
}

function agentPrompt({ diagnosis, purpose, log: ciLog, diff, base }) {
  return `You are fixing a failed CI run on a pull request. The repository is checked out at the PR head in the current directory.

PR purpose: ${purpose || '(unknown)'}

Diagnosis from a first pass (may be incomplete — verify it):
- Root cause: ${diagnosis.problem}
- Suggested fix: ${diagnosis.fix_approach}
- Files: ${(diagnosis.files_to_examine || []).join(', ') || '(none named)'}

Failed CI log (compressed):
\`\`\`
${ciLog}
\`\`\`

PR diff vs ${base} (compressed):
\`\`\`diff
${diff}
\`\`\`

Do:
1. Read the relevant files and reproduce the failure by running the failing test(s) or check named in the log (prefer the single failing file over the whole suite).
2. Make the smallest change that fixes it, in line with the PR purpose. No refactors, no unrelated edits.
3. Re-run the failing test(s)/check until they pass. Tests that also fail without this PR are not yours to fix.
Do NOT: commit, push, create branches or PRs, edit .github/workflows/, delete or skip tests to make them pass, or change lock files unless the failure is about them.
Finish with one short paragraph: what was wrong and what you changed.`;
}

// The GitHub write token must be unusable while the agent runs. Removing it from the env
// is not enough: actions/checkout persists it in the repo git config (an http.<url>.extraheader,
// or an includeIf'd credentials file in newer checkout versions). Hide those entries for
// the agent's run; restoreGitConfig() puts the config back byte-for-byte afterwards, which
// also undoes anything the agent changed there (hooksPath, aliases, credential helpers).
const GIT_CRED_KEY_RE = /^(http\..*\.extraheader|includeif\..*|credential\..*)$/i;
function hideGitCredentials(cwd = process.cwd()) {
  const cfgPath = path.join(cwd, '.git', 'config');
  const saved = readFileSync(cfgPath);
  let keys = [];
  try { keys = sh('git config --local --name-only --list').split('\n').map(k => k.trim()).filter(k => GIT_CRED_KEY_RE.test(k)); } catch { /* no local config */ }
  for (const k of [...new Set(keys)]) { try { sh(`git config --local --unset-all ${JSON.stringify(k)}`); } catch { /* already gone */ } }
  return { cfgPath, saved, hidden: [...new Set(keys)] };
}
function restoreGitConfig(state) {
  if (state) writeFileSync(state.cfgPath, state.saved);
}

// ── Fix-diff gate (deterministic) ──────────────────────────────────────────────
// CI is the judge — so a fix may not weaken what CI checks. Applied to every AI/agent
// fix before it is committed; pre-stage merges are exempt (their diff is main's).
const GATE_MAX_FILES = Number(process.env.AUTOFIX_GATE_MAX_FILES) || 15;
const GATE_MAX_LINES = Number(process.env.AUTOFIX_GATE_MAX_LINES) || 400;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i;
const LOCK_PATH_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$/;
const TEST_DISABLE_RE = /\b(?:it|test|describe|suite|context)\.(?:skip|only|todo)\s*\(|\bx(?:it|test|describe)\s*\(|\{\s*skip\s*:\s*true|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip(?:Now|f)?\(|@(?:Disabled|Ignore)\b/;
const ASSERT_RE = /\b(?:assert\w*|expect|should)\b|\.(?:toBe|toEqual|strictEqual|deepEqual|deepStrictEqual|match|throws|rejects)\b/;

// Rule IDs (AC-44). Fixed dictionary: a new id is a new release tag, never a new ad-hoc string.
// `reasons: string[]` is read in four places and collapsed into a PR comment, so it keeps its
// shape; `violations` is the structured twin that lets a log say WHICH rule fired, not just that
// something did. Both are always produced — see checkFixDiff.
const RULE_IDS = new Set([
  'workflow_edited', 'test_disabled', 'assertion_removed', 'test_file_deleted', 'lock_file_touched',
  'too_many_files', 'too_many_lines', 'docs_link_broken', 'docs_json_invalid', 'docs_heading_missing',
  'adapter_schema_violation', 'profile_unknown', 'check_command_failed', 'cap_exhausted',
  'unsupported_by_profile',
]);

function checkFixDiff(diff, { failedLog = '' } = {}) {
  const reasons = [];
  const violations = [];
  const flag = (ruleId, path, message) => { reasons.push(`${path}: ${message}`); violations.push({ rule_id: ruleId, path, message }); };
  const files = parseDiff(diff);
  let changed = 0;
  for (const f of files) {
    const added = [], removed = [];
    for (const h of f.hunks) for (const l of h.lines) {
      if (l.startsWith('+')) added.push(l.slice(1));
      else if (l.startsWith('-')) removed.push(l.slice(1));
    }
    changed += added.length + removed.length;
    const p = f.path;
    if (/^\.github\/workflows\//.test(p)) flag('workflow_edited', p, 'CI workflow changed');
    if (LOCK_PATH_RE.test(p) && !/lock|npm ci|ERESOLVE|frozen|integrity|checksum/i.test(failedLog)) flag('lock_file_touched', p, 'lock file changed but the failure is not about dependencies');
    if (TEST_PATH_RE.test(p)) {
      if (f.deleted) flag('test_file_deleted', p, 'test file deleted');
      const disabling = added.filter(l => TEST_DISABLE_RE.test(l));
      if (disabling.length) flag('test_disabled', p, `test disabled/focused (${disabling[0].trim().slice(0, 80)})`);
      const lostAsserts = removed.filter(l => ASSERT_RE.test(l)).length - added.filter(l => ASSERT_RE.test(l)).length;
      if (lostAsserts > 0) flag('assertion_removed', p, `${lostAsserts} assertion(s) removed`);
    }
  }
  if (files.length > GATE_MAX_FILES) flag('too_many_files', '(diff)', `${files.length} files changed (max ${GATE_MAX_FILES})`);
  if (changed > GATE_MAX_LINES) flag('too_many_lines', '(diff)', `${changed} lines changed (max ${GATE_MAX_LINES})`);
  return { ok: reasons.length === 0, reasons, violations, files: files.length, lines: changed };
}

// Runs the agent in the working tree. Returns { ok, summary, error }.
function runAgentFix(prompt) {
  const dir = path.join(os.tmpdir(), `autofix-agent-${process.pid}`); // outside the repo: never committed
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'opencode.json');
  writeFileSync(configPath, JSON.stringify(agentOpencodeConfig(), null, 2));
  // The agent gets the ladder token (its model access) but not the GitHub write token.
  // HOME is a scratch dir too: whatever the agent writes to ~/.gitconfig etc. cannot
  // affect the git commands autofix runs after it.
  const { GH_TOKEN: _gh, GITHUB_TOKEN: _gt, ...env } = process.env;
  const home = path.join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const r = spawnSync(AGENT_BIN, ['run', '--auto', '-m', `ladder/${LADDER_MODEL}`, prompt], {
    cwd: process.cwd(),
    env: { ...env, HOME: home, OPENCODE_CONFIG: configPath, XDG_DATA_HOME: path.join(dir, 'data') },
    encoding: 'utf8',
    timeout: AGENT_TIMEOUT_MS,
    maxBuffer: 50 * 1024 * 1024,
  });
  const out = `${r.stdout || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  const summary = out.trim().split('\n').slice(-12).join('\n').slice(-1500);
  if (r.error) return { ok: false, summary, error: r.error.code === 'ETIMEDOUT' ? `timed out after ${AGENT_TIMEOUT_MS / 60000} min` : r.error.message };
  if (r.status !== 0) return { ok: false, summary, error: `exit ${r.status}: ${(r.stderr || '').slice(-300)}` };
  return { ok: true, summary };
}

// Whatever the agent did to git history or workflows is undone; only working-tree
// changes outside .github/workflows/ survive into the fix PR.
function normalizeAgentChanges(headBefore) {
  if (sh('git rev-parse HEAD').trim() !== headBefore) {
    log('agent', 'agent created commits — folding them back into the working tree');
    sh(`git reset --soft ${headBefore}`);
    sh('git reset -q');
  }
  sh(`git checkout ${headBefore} -- .github/workflows 2>/dev/null || true`);
  sh('git clean -fdq -- .github/workflows 2>/dev/null || true');
  return sh('git status --porcelain').trim();
}

const PR_FIXER_PREFIX = 'pr-fixer:';

const {
  LLM_LADDER_TOKEN,
  GH_TOKEN,
  RUN_ID,
  REPO,
  PR_NUMBER,
  ORIGINAL_BRANCH = '',
  BASE_BRANCH = 'main',
  GITHUB_STEP_SUMMARY = '',
} = process.env;

// Batch mode: RUN_ID=0 means "no CI run to reference — just try merge + conflict resolution"
const BATCH_MODE = RUN_ID === '0' || process.env.BATCH_MODE === 'true';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 });
}

function log(stage, msg) {
  console.error(`[autofix ${stage}] ${msg}`);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function writeStats(category, extra = {}) {
  // AC-44 receipt. Every field is OPTIONAL: records written by older runs stay valid, and a
  // consumer that predates these keys keeps working. What changes is that a NEW record can
  // answer "which rule fired, on which tool build, over which paths, within what budget".
  const violations = extra.gate_violations || [];
  const firstRule = extra.rule_id || violations[0]?.rule_id || null;
  const toolRef = (process.env.AUTOFIX_WORKFLOW_REF || '').split('@').pop() || 'unpinned:local';
  // R3 — WHICH BUILD RAN, answered only by the env that pins the build. `extra.tool_commit` used
  // to win here, and the fix call site passed the CONSUMER's patch commit through it: the receipt
  // read "pr-autofix built this" while naming the commit of the repository it fixed. An `extra.*`
  // slot is writable by any call site, so one field could hold two entities depending on who
  // wrote it — and the test that checked it had been rewritten under the new meaning. The patch
  // has its own slot (`patch.commit`), below. A "commit" that is not a 40-hex SHA is not a commit:
  // an absent or malformed env value degrades to `unpinned:local` and says so.
  const declaredCommit = process.env.AUTOFIX_WORKFLOW_SHA || process.env.AUTOFIX_TOOL_COMMIT || '';
  const commitIsSha = /^[0-9a-f]{40}$/.test(String(declaredCommit));
  const toolCommit = commitIsSha ? declaredCommit : 'unpinned:local';
  const patchRefs = extra.patch_refs ?? [];
  // R3 — three distinct provenance entities. `tool.commit` is the tool build (above); the
  // consumer's fix commit lives in `patch.commit`, never in the tool slot. A patch commit that
  // is not a 40-hex SHA is not a commit either: it is recorded as null, not asserted.
  const { patch_commit: rawPatchCommit, patch_source: rawPatchSource, ...extraRest } = extra;
  const patchCommit = /^[0-9a-f]{40}$/.test(String(rawPatchCommit ?? '')) ? String(rawPatchCommit) : null;
  const recordTs = new Date().toISOString();
  const stats = {
    ts: recordTs,
    repo: REPO || '',
    pr: PR_NUMBER || '',
    branch: ORIGINAL_BRANCH || '',
    run_id: RUN_ID || '',
    category,
    // ── AC-44 (additive; absent in records written before this contract) ──
    rule_id: firstRule,
    gate_violations: violations,
    tool: {
      name: 'pr-autofix',
      version: process.env.AUTOFIX_TOOL_VERSION || toolRef,
      commit: toolCommit,
    },
    attempt_count: extra.attempt_count ?? 1,
    // The consumer's patch — its OWN entity, never the tool build (R3/AC-04).
    patch: {
      commit: patchCommit,
      source: rawPatchSource || (patchRefs.length ? 'applied' : 'none_required'),
    },
    patch_refs: patchRefs,
    // Why patch_refs is what it is. Acceptance asks for a no-change repeat to carry NO patch —
    // but "nothing needed changing" and "the writer never filled this in" are different facts,
    // and an empty array cannot tell them apart. `applied` | `none_required` | `not_attempted`.
    patch_refs_source: extra.patch_refs_source || (patchRefs.length ? 'applied' : 'not_attempted'),
    included_paths: extra.included_paths ?? [],
    omitted_paths: extra.omitted_paths ?? [],
    budget: extra.budget || {
      diff_tokens: DIFF_TOKEN_BUDGET, diff_tokens_used: 0,
      log_tokens: LOG_TOKEN_BUDGET, log_tokens_used: 0,
      max_files: GATE_MAX_FILES, max_lines: GATE_MAX_LINES,
    },
    // R4 — `written_at` is what makes the TTL a DATE. Without it no sweeper can decide whether
    // this record is expired, and `ttl_days` stays a number nobody executes.
    retention: extra.retention || { ttl_days: 90, written_at: recordTs, artifact: `ci-fixer-stats-pr${PR_NUMBER || 'local'}-run${RUN_ID || '0'}` },
    credentials: extra.credentials ?? [],
    ...extraRest,
    ...(typeof agentFellBack === 'string' ? { agent_fallback: agentFellBack } : {}),
    llm_usage: { ..._usage, cost_usd: Number(_usage.cost_usd.toFixed(6)) },
  };

  // Machine-readable JSON artifact — aggregatable later via GitHub Actions API
  try { writeFileSync('ci-fixer-stats.json', JSON.stringify(stats, null, 2)); } catch { /* best effort */ }

  // Human-readable Step Summary visible in every GitHub Actions run
  if (GITHUB_STEP_SUMMARY) {
    const icon = category.startsWith('success') ? '✅' : '❌';
    const rows = [
      ['PR', `#${stats.pr}`],
      ['Branch', `\`${stats.branch}\``],
      ['Repo', stats.repo],
      extra.problem ? ['Root cause', extra.problem.slice(0, 200)] : null,
      extra.reason  ? ['Reason',     extra.reason.slice(0, 200)]  : null,
      firstRule     ? ['Rule',       `\`${firstRule}\`${violations.length > 1 ? ` (+${violations.length - 1} more)` : ''}`] : null,
      extra.fix     ? ['Fix',        extra.fix.slice(0, 200)]     : null,
      extra.hint    ? ['Hint',       extra.hint.slice(0, 300)]    : null,
      _usage.calls  ? ['LLM', `${_usage.calls} calls, ${_usage.prompt_tokens} in / ${_usage.completion_tokens} out tokens, $${_usage.cost_usd.toFixed(5)} — ${Object.keys(_usage.by_model).join(', ')}`] : null,
    ].filter(Boolean);

    const tableRows = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
    const md = [
      `## ${icon} CI Fixer — \`${category}\``,
      '',
      '| Field | Value |',
      '|-------|-------|',
      tableRows,
      '',
      '<details><summary>Full JSON</summary>',
      '',
      '```json',
      JSON.stringify(stats, null, 2),
      '```',
      '</details>',
      '',
    ].join('\n');

    try { appendFileSync(GITHUB_STEP_SUMMARY, md); } catch { /* best effort */ }
  }

  console.error(`[autofix stats] ${category} | pr=${stats.pr} | branch=${stats.branch}`);
}

function failWithStats(category, reason, extra = {}) {
  writeStats(category, { reason, ...extra });
  console.error(`[autofix] giving up (${category}): ${reason}`);
  process.exit(1);
}

// Post a comment to the original PR — GitHub is our audit log.
// All comments carry the PR_FIXER_PREFIX so humans can filter them.
async function prComment(body) {
  if (!PR_NUMBER || !REPO) return;
  const text = `${PR_FIXER_PREFIX} ${body}`;
  writeFileSync('__comment.txt', text);
  try {
    sh(`gh pr comment ${PR_NUMBER} -R "${REPO}" --body-file __comment.txt`);
  } catch { /* best effort — never let a comment failure abort the fix */ }
  try { unlinkSync('__comment.txt'); } catch {}
}

// One stage call → the llm-ladder worker. `model` is the ladder name (all stages use
// LADDER_MODEL); failover across rungs happens in the worker. Patch writing (stage 3) needs long
// answers, so rungs get a 60s budget and the whole ladder up to 2 min.
async function callModel(model, messages, json = false, opts = {}) {
  if (!LADDER_TOKEN) throw Object.assign(new Error('no LLM provider configured (LLM_LADDER_TOKEN)'), { status: 401 });
  let res;
  try {
    res = await fetch(`${LADDER_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${LADDER_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || LADDER_MODEL,
        messages,
        temperature: 0,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        ladder_timeout_ms: 60_000,
        ladder_total_timeout_ms: 120_000,
      }),
      signal: AbortSignal.timeout(130_000),
    });
  } catch (e) {
    throw Object.assign(new Error(`llm-ladder unreachable: ${e.message}`), { name: e.name });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const attempts = (data?.error?.attempts || []).map(a => `${a.model}=${a.outcome}`).join(', ');
    throw Object.assign(new Error(`llm-ladder HTTP ${res.status}: ${data?.error?.message || ''}${attempts ? ` [${attempts}]` : ''}`), { status: res.status });
  }
  recordUsage(data?.model || model, data?.usage);
  const result = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!result) throw new Error(`llm-ladder: ${data?.model || model} returned an empty answer`);
  if (json) parseJSON(result); // worker guards JSON too; a caller-side parse failure must surface here
  return result;
}

// Per-run model usage — which rung actually answered (the worker reports it in `model`).
// OpenRouter returns usage.cost (USD); Go is subscription.
const _usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, by_model: {} };
function recordUsage(m, u) {
  const e = (_usage.by_model[m] ||= { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 });
  const pt = u?.prompt_tokens || 0, ct = u?.completion_tokens || 0, c = Number(u?.cost) || 0;
  for (const t of [_usage, e]) { t.calls++; t.prompt_tokens += pt; t.completion_tokens += ct; t.cost_usd += c; }
  log('model', `${m} answered: ${pt} in / ${ct} out tokens${c ? `, $${c.toFixed(6)}` : ''}`);
}

// Mutable so the self-test can toggle the token without env juggling.
let LADDER_TOKEN = LLM_LADDER_TOKEN || '';

function extractPatch(raw) {
  const fenced = raw.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
  return (fenced ? fenced[1] : raw).trim();
}

// Tolerant JSON extraction — free models frequently wrap JSON in fences or
// lead with prose. Slices the first '{' to the last '}' and parses that.
function parseJSON(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('no JSON object found');
  return JSON.parse(t.slice(s, e + 1));
}

function readFileSafe(filePath, limit = FILE_CHAR_LIMIT) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8').slice(0, limit);
  } catch {
    return null;
  }
}

// ── Input compression (issue #7) ─────────────────────────────────────────────
// PR-Agent-style: instead of slicing the raw diff/file at N chars (which cuts
// mid-hunk and drops whatever came last), parse the diff into hunks and shrink
// it structurally, least-useful parts first. Output is still a valid unified
// diff (sub-hunk headers are recomputed), so models read it as usual.

// Files whose diff is noise for a CI fix — listed by name, never inlined.
const NOISE_FILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|composer\.lock|Gemfile\.lock)$|\.(min\.js|min\.css|map|snap|svg|png|jpe?g|gif|ico|pdf|woff2?)$|(^|\/)(dist|build|vendor|node_modules)\//;

function parseDiff(diff) {
  const files = [];
  let f = null, h = null;
  for (const line of String(diff || '').split('\n')) {
    const g = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (g) { f = { path: g[2], header: [line], hunks: [], binary: false, deleted: false }; files.push(f); h = null; continue; }
    if (!f) continue;
    const hh = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hh) { h = { oldStart: +hh[1], newStart: +hh[3], tail: hh[5] || '', lines: [] }; f.hunks.push(h); continue; }
    if (!h) {
      if (/^Binary files /.test(line)) f.binary = true;
      if (/^deleted file mode/.test(line)) f.deleted = true;
      f.header.push(line);
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '+' || line[0] === '-' || line[0] === '\\') h.lines.push(line);
  }
  return files;
}

// Keep ctxBefore/ctxAfter context lines around each change; split the hunk
// where context runs longer and recompute each piece's @@ header. With
// collapseDeletes, runs of '-' lines become one marker comment (level 1).
function trimHunk(h, ctxBefore, ctxAfter, collapseDeletes = false) {
  const L = h.lines.filter(l => l[0] !== '\\');
  const isChg = l => l[0] === '+' || l[0] === '-';
  const keep = new Array(L.length).fill(false);
  L.forEach((l, i) => {
    if (!isChg(l)) return;
    for (let k = Math.max(0, i - ctxBefore); k <= Math.min(L.length - 1, i + ctxAfter); k++) keep[k] = true;
  });
  const out = [];
  let oldLn = h.oldStart, newLn = h.newStart, cur = null;
  L.forEach((l, i) => {
    const t = l[0] === '+' ? '+' : l[0] === '-' ? '-' : ' ';
    if (keep[i]) {
      if (!cur) { cur = { oldStart: oldLn, newStart: newLn, oldN: 0, newN: 0, body: [], dels: 0 }; out.push(cur); }
      if (t === '-' && collapseDeletes) { cur.dels++; cur.oldN++; }
      else {
        if (cur.dels) { cur.body.push(`-… (${cur.dels} removed line(s) omitted)`); cur.dels = 0; }
        cur.body.push(l);
        if (t !== '+') cur.oldN++;
        if (t !== '-') cur.newN++;
      }
    } else cur = null;
    if (t !== '+') oldLn++;
    if (t !== '-') newLn++;
  });
  return out.map(c => {
    if (c.dels) c.body.push(`-… (${c.dels} removed line(s) omitted)`);
    return `@@ -${c.oldStart},${c.oldN} +${c.newStart},${c.newN} @@${h.tail}\n${c.body.join('\n')}`;
  });
}

// Compress a unified diff into <= budgetTokens. Degradation order:
//   always: drop noise/binary/deleted files and deletion-only hunks (listed)
//   level 0: asymmetric context 3/1 for every file
//   level 1 (if level 0 is over budget): zero context + collapse removed lines
//   then, in priority order: a file that doesn't fit is cut mid-additions (if
//   enough budget is left to be useful) or listed by name as "over budget".
// Files cited in the failing CI log are placed first so they survive longest.
function compressDiff(diff, budgetTokens = DIFF_TOKEN_BUDGET, failedLogText = '', meta = {}) {
  const files = parseDiff(diff);
  // `meta` is the AC-44 receipt: what actually made it into the prompt and what did not, plus
  // the tokens spent. It is filled in place so the four existing call sites stay untouched and
  // every one of them can opt in by passing a fourth argument.
  const omittedDetail = [];
  const note = (p, reason) => omittedDetail.push({ path: p, reason });
  const finish = (text) => {
    meta.tokens_used = estTokens(text);
    meta.budget_tokens = budgetTokens;
    meta.included_paths = includedDetail;
    meta.omitted_paths = omittedDetail;
    return text;
  };
  const includedDetail = [];
  if (!files.length) return finish(String(diff || '').slice(0, budgetTokens * 4));
  const omitted = [];
  const cited = f => failedLogText && (failedLogText.includes(f.path) || failedLogText.includes(path.basename(f.path)));
  const useful = [];
  for (const f of files) {
    if (NOISE_FILE_RE.test(f.path) || f.binary) { omitted.push(`${f.path} (lock/generated/binary)`); note(f.path, 'lock_generated_binary'); continue; }
    if (f.deleted) { omitted.push(`${f.path} (deleted)`); note(f.path, 'deleted'); continue; }
    const hunks = f.hunks.filter(h => h.lines.some(l => l[0] === '+'));
    const dropped = f.hunks.length - hunks.length;
    if (!hunks.length) { if (f.hunks.length) { omitted.push(`${f.path} (deletion-only)`); note(f.path, 'deletion_only'); } continue; }
    useful.push({ ...f, hunks, dropped });
  }
  useful.sort((a, b) => (cited(b) ? 1 : 0) - (cited(a) ? 1 : 0));
  const render = (f, level) => {
    const hdr = f.header.filter(l => /^(diff --git|--- |\+\+\+ |new file mode|rename )/.test(l));
    const body = f.hunks.flatMap(h => level === 0 ? trimHunk(h, HUNK_CTX_BEFORE, HUNK_CTX_AFTER) : trimHunk(h, 0, 0, true));
    const note = f.dropped ? [`# (${f.dropped} deletion-only hunk(s) omitted)`] : [];
    return [...hdr, ...note, ...body].join('\n');
  };
  // Reserve room for the trailing "not shown" note (every path may end up there).
  const reserve = estTokens(omitted.concat(useful.map(f => `${f.path} (over budget)`)).join(', ')) + 40;
  const avail = budgetTokens - reserve;
  let rendered = useful.map(f => render(f, 0));
  if (estTokens(rendered.join('\n')) > avail) rendered = useful.map(f => render(f, 1));
  let used = 0;
  const parts = [], rest = [];
  rendered.forEach((r, i) => {
    const t = estTokens(r) + 1;
    if (used + t <= avail) { parts.push(r); used += t; includedDetail.push(useful[i].path); return; }
    const left = avail - used;
    if (left >= 200) {
      const cut = r.slice(0, left * 4 - 80);
      const kept = cut.slice(0, cut.lastIndexOf('\n'));
      const more = r.slice(kept.length).split('\n').filter(l => l.startsWith('+')).length;
      parts.push(`${kept}\n# … ${more} more added line(s) in ${useful[i].path} truncated (budget)`);
      includedDetail.push(`${useful[i].path} (truncated)`);
      used = avail;
      return;
    }
    rest.push(useful[i].path);
  });
  if (rest.length) {
    omitted.push(...rest.map(p => `${p} (over budget)`));
    for (const p of rest) note(p, 'over_budget');
  }
  if (omitted.length) parts.push(`# Compressed diff — not shown: ${omitted.join(', ')}.\n# Ask for a file via files_to_examine if you need it.`);
  return finish(parts.join('\n'));
}

// CI log compression. Raw Actions job logs are mostly runner noise: ISO
// timestamps on every line, ANSI colours, ##[group] blocks with env dumps and
// setup chatter, post-job cleanup. Strip that, keep step headers ("Run npm
// test") and step output, then fit the budget keeping error-looking lines and
// their neighbourhood first, the tail next. Order is preserved.
const LOG_TOKEN_BUDGET = 2500;
const LOG_ERROR_RE = /(error|fail|not ok|assert|expected|received|actual|exception|traceback|panic|cannot|undefined|denied|missing|exit code [1-9]|✗|✖|×)/i;
function compressLog(raw, budgetTokens = LOG_TOKEN_BUDGET) {
  const lines = [];
  let inGroup = false, seen = new Set(), sawStep = false;
  for (let l of String(raw || '').split('\n')) {
    l = l.replace(/^\uFEFF/, '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').trimEnd();
    if (/^##\[group\]/.test(l)) {
      inGroup = true;
      const step = l.replace(/^##\[group\]/, '');
      if (/^Run /.test(step)) { lines.push(`▶ ${step.slice(0, 160)}`); sawStep = true; }
      continue;
    }
    if (/^##\[endgroup\]/.test(l)) { inGroup = false; continue; }
    if (inGroup || !l.trim()) continue;
    if (/^Post job cleanup|^Cleaning up orphan processes/.test(l)) break;
    if (/^(=== job: )/.test(l)) { lines.push(l); sawStep = false; continue; }
    // Runner preamble before the first step (versions, action downloads).
    if (!sawStep && !LOG_ERROR_RE.test(l)) continue;
    // Collapse exact repeats (retry spam, progress bars).
    if (seen.has(l) && !LOG_ERROR_RE.test(l)) continue;
    seen.add(l);
    lines.push(l.replace(/^##\[error\]/, 'ERROR: ').slice(0, 400));
  }
  const text = lines.join('\n');
  if (estTokens(text) <= budgetTokens) return text;
  // Over budget: error lines ±3 first, then fill from the tail backwards.
  const keep = new Array(lines.length).fill(false);
  let used = 0;
  const take = i => { if (keep[i]) return true; const t = estTokens(lines[i]) + 1; if (used + t > budgetTokens) return false; keep[i] = true; used += t; return true; };
  lines.forEach((l, i) => { if (/^(▶ |=== job: )/.test(l)) take(i); });
  outer: for (let i = lines.length - 1; i >= 0; i--) {
    if (!LOG_ERROR_RE.test(lines[i])) continue;
    for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) if (!take(k)) break outer;
  }
  for (let i = lines.length - 1; i >= 0; i--) if (!take(i)) break;
  const out = [];
  lines.forEach((l, i) => {
    if (keep[i]) out.push(l);
    else if (out[out.length - 1] !== '  …') out.push('  …');
  });
  return out.join('\n');
}

// New-side line numbers touched by the PR, per file (for Stage 2 excerpts).
function changedLinesByFile(diff) {
  const map = new Map();
  for (const f of parseDiff(diff)) {
    const set = new Set();
    for (const h of f.hunks) {
      let n = h.newStart;
      for (const l of h.lines) {
        if (l[0] === '+') { set.add(n); n++; }
        else if (l[0] === '-' || l[0] === '\\') { /* old side only */ }
        else n++;
      }
    }
    map.set(f.path, set);
  }
  return map;
}

// Line numbers the CI log cites for this file ("src/a.js:42", "a.js(42,7)").
function logCitedLines(filePath, logText) {
  const out = new Set();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const name of new Set([filePath, path.basename(filePath)])) {
    const re = new RegExp(`${esc(name)}(?::|\\()(\\d+)`, 'g');
    for (const m of String(logText || '').matchAll(re)) out.add(+m[1]);
  }
  return out;
}

// Stage 2 file context. Small files go whole; bigger ones become line-numbered
// windows around PR-changed and log-cited lines, plus the first lines
// (imports). Gaps are marked so the model knows it sees an excerpt and can say
// MISSING_CONTEXT instead of guessing. Returns { text, excerpt }.
function excerptFile(content, focusLines, budgetTokens = FILE_TOKEN_BUDGET) {
  const lines = content.split('\n');
  const num = (i) => `${String(i + 1).padStart(5)}| ${lines[i]}`;
  if (content.length <= WHOLE_FILE_CHARS || (!focusLines.size && estTokens(content) <= budgetTokens)) {
    return { text: lines.map((_, i) => num(i)).join('\n'), excerpt: false };
  }
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < Math.min(20, lines.length); i++) keep[i] = true;
  // Nearest-first so the budget is spent on what the PR/log points at.
  for (const ln of [...focusLines].sort((a, b) => a - b)) {
    for (let k = Math.max(0, ln - 1 - FILE_WINDOW); k <= Math.min(lines.length - 1, ln - 1 + FILE_WINDOW); k++) keep[k] = true;
  }
  const out = [];
  let used = 0, gapFrom = -1, cut = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) { if (gapFrom < 0) gapFrom = i; continue; }
    if (gapFrom >= 0) { out.push(`  ... (lines ${gapFrom + 1}-${i} omitted)`); gapFrom = -1; }
    const row = num(i);
    if (used + estTokens(row) > budgetTokens) { cut = true; out.push(`  ... (excerpt truncated at line ${i}, file has ${lines.length} lines)`); break; }
    out.push(row); used += estTokens(row);
  }
  if (!cut && gapFrom >= 0) out.push(`  ... (lines ${gapFrom + 1}-${lines.length} omitted)`);
  return { text: out.join('\n'), excerpt: true };
}

// MISSING_CONTEXT retry: the model says WHAT it needs ("the stale
// require('../playbooks/development.json')"). Re-sending the head of the file
// misses it when it sits past the cap (seen live: agent#1469, line >141 of a
// 48k test file). Pull concrete needles from the request + diagnosis and focus
// the excerpt on the lines that contain them.
function missingContextNeeds(text) {
  const out = new Map();
  for (const m of String(text || '').matchAll(/MISSING_CONTEXT:\s*`?([\w./@-]+\.[\w]+)`?\s*[—:-]*\s*(.*)/g)) out.set(m[1], m[2] || '');
  return out;
}
function contextNeedles(...texts) {
  const needles = new Set();
  for (const t of texts) {
    const s = String(t || '');
    for (const m of s.matchAll(/[`'"]([^`'"\n]{4,80})[`'"]/g)) needles.add(m[1].trim());
    for (const m of s.matchAll(/[\w@./-]*[\w-]\.(?:json|js|mjs|cjs|ts|tsx|yml|yaml|md|py|go|sh)\b/g)) needles.add(m[0].split('/').pop());
    for (const m of s.matchAll(/\b([A-Za-z_$][\w$]{4,})\s*\(/g)) needles.add(m[1]);
  }
  return [...needles].filter(n => n.length >= 4).slice(0, 20);
}
function needleLines(content, needles, max = 40) {
  const hits = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    if (needles.some(n => lines[i].includes(n))) hits.push(i + 1);
  }
  return hits;
}

// Stage 2 contract: the model names files it could not see enough of.
function parseMissingContext(text) {
  return [...String(text || '').matchAll(/MISSING_CONTEXT:\s*`?([\w./@-]+\.[\w]+)`?/g)].map(m => m[1]);
}

// Apply Stage 3 search/replace edits atomically: validate every edit against
// the current file text first (exact, unique match; a copied "NNNNN| " prefix
// is tolerated), write nothing unless all edits are valid.
function applyEdits(edits, cwd) {
  const errors = [], pending = new Map(), files = [];
  const stripNum = t => String(t ?? '').replace(/^ *\d+\| ?/gm, '');
  const root = path.resolve(cwd);
  edits.forEach((e, i) => {
    const file = String(e?.file || '').replace(/^\.?\//, '');
    const abs = path.resolve(root, file);
    if (!file || !abs.startsWith(root + path.sep) || /(^|\/)\.git\//.test(file)) { errors.push(`edit ${i + 1}: bad file path "${file}"`); return; }
    const exists = existsSync(abs);
    let text = pending.has(abs) ? pending.get(abs) : (exists ? readFileSync(abs, 'utf8') : null);
    let oldStr = String(e?.old_str ?? ''), newStr = String(e?.new_str ?? '');
    if (oldStr === '') {
      if (text !== null && text !== '') { errors.push(`edit ${i + 1}: ${file} exists — old_str must not be empty`); return; }
      pending.set(abs, newStr); files.push(file); return;
    }
    if (text === null) { errors.push(`edit ${i + 1}: ${file} does not exist`); return; }
    const count = (hay, needle) => hay.split(needle).length - 1;
    if (count(text, oldStr) !== 1 && count(text, stripNum(oldStr)) === 1) { oldStr = stripNum(oldStr); newStr = stripNum(newStr); }
    const n = count(text, oldStr);
    if (n === 0) { errors.push(`edit ${i + 1}: old_str not found in ${file}: ${JSON.stringify(oldStr.slice(0, 120))}`); return; }
    if (n > 1) { errors.push(`edit ${i + 1}: old_str occurs ${n} times in ${file} — add surrounding lines to make it unique`); return; }
    pending.set(abs, text.replace(oldStr, () => newStr)); files.push(file);
  });
  if (!edits.length) errors.push('edits array is empty');
  if (errors.length) return { ok: false, errors };
  for (const [abs, text] of pending) { mkdirSync(path.dirname(abs), { recursive: true }); writeFileSync(abs, text); }
  return { ok: true, count: edits.length, files, errors: [] };
}

// ── Conflict resolution with AI ──────────────────────────────────────────────
// Called by tryFixOutOfDate when git merge has conflicts.
// Uses the PR's purpose (from Stage 0) to guide resolution — the "why" makes
// per-block decisions more accurate than resolving with no context.
// CI/workflow config: an AI "resolution" here can silently delete merge gates
// (seen live: hh-skill#6 → fix PR dropped main's contract/behavior/guards/
// staging-gate jobs). Conflicts in these paths always go to a human.
const PROTECTED_CONFLICT_RE = /^\.github\/workflows\//;

// Guard one AI-resolved block. We merge origin/<base> INTO the PR branch, so
// `ours` (HEAD) = PR side and `theirs` = code already on the base branch.
// Dropping most of the base side means the fix PR would revert other people's
// merged work — reject instead of shipping it. Also reject runaway output.
function checkResolvedBlock(block, result) {
  const norm = t => t.split('\n').map(l => l.trim()).filter(Boolean);
  const baseLines = norm(block.theirs);
  const out = new Set(norm(result));
  if (baseLines.length >= 3) {
    const kept = baseLines.filter(l => out.has(l)).length;
    if (kept / baseLines.length < 0.5) {
      return `resolution dropped ${baseLines.length - kept}/${baseLines.length} lines already on ${BASE_BRANCH}`;
    }
  }
  if (result.length > (block.ours.length + block.theirs.length) * 1.2 + 200) {
    return `resolution is larger than both sides combined (${result.length} chars) — runaway output`;
  }
  return null;
}

// Strip a markdown fence the model wraps the code in despite instructions.
function stripCodeFence(t) {
  const m = String(t || '').match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : String(t || '');
}

async function resolveConflictsWithAI(conflictedFiles, prPurposeArg, retryHints = {}) {
  const protectedFiles = conflictedFiles.filter(f => PROTECTED_CONFLICT_RE.test(f));
  if (protectedFiles.length) {
    return { ok: false, reason: `conflict in protected CI config (${protectedFiles.join(', ')}) — needs a human` };
  }
  // <<< ... === ... >>> regex — one conflict block at a time
  const CONFLICT_RE = /<<<<<<< [^\n]+\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> [^\n]+/g;

  for (const filePath of conflictedFiles) {
    const fullPath = path.join(process.cwd(), filePath);
    let content;
    try { content = readFileSync(fullPath, 'utf8'); } catch { continue; }

    const blocks = [];
    let match;
    CONFLICT_RE.lastIndex = 0;
    while ((match = CONFLICT_RE.exec(content)) !== null) {
      blocks.push({ full: match[0], ours: match[1], theirs: match[2] });
    }
    if (blocks.length === 0) continue;

    log('conflict-resolve', `${filePath}: resolving ${blocks.length} block(s) with AI (one call per block)...`);

    // Resolve each block independently — smaller prompts, no brittle multi-block parsing.
    // Retry up to 2 times per block on empty response before skipping.
    const resolvedCode = [];
    let failedBlocks = 0;
    for (let bi = 0; bi < blocks.length; bi++) {
      const blockNum = `${bi + 1}/${blocks.length}`;
      let blockResult = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          log('conflict-resolve', `${filePath}: block ${blockNum} empty — waiting 5s, retry ${attempt}...`);
          await new Promise(r => setTimeout(r, 5000));
        }
        try {
          blockResult = await callModel(STAGE0_MODEL, [
            {
              role: 'system',
              content: `Resolve this single git merge conflict. PR purpose: "${prPurposeArg}".
The side between <<<<<<< and ======= is the PR branch; the side between ======= and >>>>>>> is code ALREADY MERGED on ${BASE_BRANCH} by other changes.
Keep the intent of BOTH sides: never drop code from ${BASE_BRANCH} unless the PR purpose explicitly requires removing it.
Return ONLY the resolved code — no conflict markers, no explanations, no markdown fences.`,
            },
            {
              role: 'user',
              content: (() => {
                // Surrounding code: a block resolved blind breaks syntax at its edges
                // (hh-skill#5/#7 live: node --check failed after per-block resolution).
                const at = content.indexOf(blocks[bi].full);
                const before = content.slice(0, at).split('\n').slice(-20).join('\n');
                const after = content.slice(at + blocks[bi].full.length).split('\n').slice(0, 20).join('\n');
                const hint = retryHints[filePath] ? `\n\nA previous resolution of this file failed: ${retryHints[filePath]}\nMake the result syntactically valid in its surroundings.` : '';
                return `File: ${filePath}\n\nCode BEFORE the conflict (context, do not repeat):\n${before}\n\nCONFLICT:\n${blocks[bi].full}\n\nCode AFTER the conflict (context, do not repeat):\n${after}${hint}\n\nReturn only the code that replaces the CONFLICT region.`;
              })(),
            },
          ]);
        } catch (e) {
          log('conflict-resolve', `${filePath}: block ${blockNum} error (attempt ${attempt + 1}): ${e.message.slice(0, 80)}`);
          blockResult = '';
        }
        if (blockResult) break;
      }
      if (!blockResult) {
        log('conflict-resolve', `${filePath}: block ${blockNum} — could not resolve after retries, leaving as-is`);
        resolvedCode.push(blocks[bi].full); // leave original conflict marker
        failedBlocks++;
      } else {
        blockResult = stripCodeFence(blockResult);
        const guard = checkResolvedBlock(blocks[bi], blockResult.trim());
        if (guard) {
          log('conflict-resolve', `${filePath}: block ${blockNum} rejected — ${guard}`);
          return { ok: false, reason: `${filePath} block ${blockNum}: ${guard}` };
        }
        log('conflict-resolve', `${filePath}: block ${blockNum} OK`);
        resolvedCode.push(blockResult.trim());
      }
    }

    if (failedBlocks === blocks.length) {
      return { ok: false, reason: `AI could not resolve any of ${blocks.length} blocks in ${filePath}` };
    }

    let resolved = content;
    for (let i = 0; i < blocks.length; i++) {
      resolved = resolved.replace(blocks[i].full, resolvedCode[i]);
    }

    // \w after the markers ensures regex patterns like /<<<<<<< [^\n]+/ in source code
    // don't trigger a false positive — real markers are always followed by HEAD/branch-name
    if (/^<{7} \w/m.test(resolved) || /^>{7} \w/m.test(resolved)) {
      return { ok: false, reason: `conflict markers remain in ${filePath} after AI resolution` };
    }

    writeFileSync(fullPath, resolved);

    // Syntax check for JS files — AI sometimes introduces await outside async, etc.
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) {
      try {
        execFileSync('node', ['--check', fullPath], { encoding: 'utf8' });
        log('conflict-resolve', `${filePath}: resolved OK (syntax valid)`);
      } catch (syntaxErr) {
        writeFileSync(fullPath, content); // restore original conflicted content
        const msg = String(syntaxErr.stderr || syntaxErr.message).split('\n').filter(l => /Error|^\s*\^|:\d+$/.test(l)).slice(0, 4).join(' | ').slice(0, 300);
        return { ok: false, syntax: true, file: filePath, reason: `AI resolution of ${filePath} introduced syntax error: ${msg}` };
      }
    } else {
      log('conflict-resolve', `${filePath}: resolved OK`);
    }
  }

  return { ok: true };
}

// ── Pre-stage A: Out-of-date branch ─────────────────────────────────────────
// Detection: CI auto-merge step fails with "not up to date with the base branch"
//            OR batch mode (always try merge regardless of log content).
// Fix: git merge origin/<BASE_BRANCH>; if conflicts → AI resolution using PR purpose.
//
// A new fix PR is only for a change we author (conflict resolution, AI patch).
// Branch merely behind + clean merge → no code of ours: `inPlace`, the caller
// updates the ORIGINAL PR's branch via GitHub's update-branch (same PR, fresh CI).
// Branch not behind at all → `noop`: the merge failure wasn't staleness.
async function tryFixOutOfDate(failedLog, prPurposeArg) {
  const logMatches = /not up to date with the base branch|head branch.*behind|base branch policy prohibits the merge/i.test(failedLog);
  if (!BATCH_MODE && !logMatches) return null;

  log('pre-A', `${BATCH_MODE ? 'batch mode' : 'detected "not up to date"'} — merging origin/${BASE_BRANCH}...`);
  sh(`git fetch origin ${BASE_BRANCH} --quiet`);
  const headSha = sh('git rev-parse HEAD').trim();
  try {
    sh(`git merge-base --is-ancestor origin/${BASE_BRANCH} HEAD`);
    log('pre-A', `branch already contains origin/${BASE_BRANCH} — nothing to merge`);
    return {
      ok: true,
      noop: true,
      category: 'skip:not_behind',
      problem: `Branch already contains \`${BASE_BRANCH}\` — the merge failure was not caused by a stale branch`,
    };
  } catch { /* exit 1 = behind → merge below */ }
  try {
    sh(`git merge origin/${BASE_BRANCH} --no-edit -m "merge: sync with ${BASE_BRANCH} before merge"`);
    sh(`git reset --hard ${headSha}`); // the local merge was only a conflict probe
    log('pre-A', 'clean merge — no code changes needed, will update the original PR branch in place');
    return {
      ok: true,
      inPlace: true,
      headSha,
      category: 'success:pre_a_update_in_place',
      problem: `Branch was behind \`${BASE_BRANCH}\` (merges cleanly)`,
      fix_approach: `Updated the PR branch from \`${BASE_BRANCH}\` in place (GitHub update-branch). No source code changes, no new PR.`,
    };
  } catch (mergeErr) {
    const conflictedFiles = sh('git diff --name-only --diff-filter=U').trim().split('\n').filter(Boolean);

    if (conflictedFiles.length === 0) {
      // Non-conflict merge failure (dirty worktree, etc.)
      try { sh('git merge --abort'); } catch {}
      return {
        ok: false,
        category: 'fail:merge_conflict',
        reason: `merge with ${BASE_BRANCH} failed (not a conflict): ${mergeErr.message.slice(0, 100)}`,
        detail: mergeErr.message.slice(0, 200),
      };
    }

    // If Stage 0 failed to get purpose, fall back to branch name — still useful context for AI
    const effectivePurpose = prPurposeArg || `Changes in PR branch: ${ORIGINAL_BRANCH}`;

    log('pre-A', `${conflictedFiles.length} conflict(s): ${conflictedFiles.join(', ')} — asking AI to resolve...`);
    await prComment(`🔀 Merge conflicts in ${conflictedFiles.length} file(s): \`${conflictedFiles.join('`, `')}\`\n\nAsking AI to resolve using context: _"${effectivePurpose.slice(0, 100)}"_…`);

    let resolveResult = await resolveConflictsWithAI(conflictedFiles, effectivePurpose);
    if (!resolveResult.ok && resolveResult.syntax) {
      log('pre-A', `syntax error after resolution — one retry with the error: ${resolveResult.reason.slice(0, 160)}`);
      resolveResult = await resolveConflictsWithAI(conflictedFiles, effectivePurpose, { [resolveResult.file]: resolveResult.reason });
    }
    if (!resolveResult.ok) {
      try { sh('git merge --abort'); } catch {}
      return {
        ok: false,
        category: 'fail:ai_conflict_resolution',
        reason: resolveResult.reason,
        detail: `conflicted files: ${conflictedFiles.join(', ')}`,
      };
    }

    sh('git add -A');
    sh(`git commit -m "merge: resolve conflicts with origin/${BASE_BRANCH} [ai-assisted]"`);
    log('pre-A', 'AI conflict resolution successful');
    return {
      ok: true,
      category: 'success:pre_a_conflict_resolved',
      problem: `Branch had merge conflicts with \`${BASE_BRANCH}\` — AI resolved them using PR purpose`,
      fix_approach: `Merged \`origin/${BASE_BRANCH}\`, AI resolved ${conflictedFiles.length} file(s): ${conflictedFiles.join(', ')} (context: "${effectivePurpose.slice(0, 60)}")`,
    };
  }
}

// ── Pre-stage B: Missing GitHub Actions permissions ──────────────────────────
// Detection: "Resource not accessible by integration" in CI log
// Fix: add permissions: contents: write / pull-requests: write to the failing job
function patchWorkflowPermissions(content) {
  const lines = content.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Job header: exactly 2 spaces + identifier + colon (no trailing content)
    if (/^  [a-zA-Z0-9_-]+:\s*$/.test(line)) {
      // Collect entire job block (all lines until next same-level key or end)
      const jobLines = [line];
      i++;
      while (i < lines.length && (lines[i].startsWith('    ') || lines[i].trim() === '')) {
        jobLines.push(lines[i]);
        i++;
      }

      const jobText = jobLines.join('\n');
      const needsFix = (jobText.includes('gh pr merge') || jobText.includes('gh pr close')) &&
                       !jobText.includes('permissions:');

      if (needsFix) {
        // Insert permissions block before the first 4-space property line
        let inserted = false;
        for (const jl of jobLines) {
          if (!inserted && /^    [a-zA-Z]/.test(jl)) {
            result.push('    permissions:');
            result.push('      contents: write');
            result.push('      pull-requests: write');
            inserted = true;
          }
          result.push(jl);
        }
      } else {
        result.push(...jobLines);
      }
    } else {
      result.push(line);
      i++;
    }
  }

  return result.join('\n');
}

function tryFixMissingPermissions(failedLog) {
  if (!/Resource not accessible by integration|GraphQL.*[Mm]erge[Pp]ull[Rr]equest/i.test(failedLog)) return null;

  log('pre-B', 'detected missing GitHub Actions permissions — scanning workflow files...');

  const workflowDir = path.join(process.cwd(), '.github', 'workflows');
  if (!existsSync(workflowDir)) {
    return { ok: false, category: 'fail:permissions_no_workflow', reason: 'no .github/workflows directory found in this repo' };
  }

  const files = readdirSync(workflowDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const patched = [];

  for (const file of files) {
    const fp = path.join(workflowDir, file);
    const orig = readFileSync(fp, 'utf8');
    const updated = patchWorkflowPermissions(orig);
    if (updated !== orig) {
      writeFileSync(fp, updated);
      patched.push(file);
      log('pre-B', `patched: .github/workflows/${file}`);
    }
  }

  if (patched.length === 0) {
    return {
      ok: false,
      category: 'fail:permissions_no_workflow',
      reason: 'no workflow file found with a `gh pr merge` job missing a `permissions:` block',
    };
  }

  return {
    ok: true,
    category: 'success:pre_b_permissions',
    problem: `GitHub Actions job lacked \`permissions: contents: write, pull-requests: write\` — GITHUB_TOKEN defaulted to read-only`,
    fix_approach: `Added permissions block to merge job in: ${patched.join(', ')}`,
  };
}

// ── Pre-stage C: Cloudflare Durable Objects migration conflict ───────────────
// Detection: wrangler error code 10074 or specific migration messages
// Action: bail immediately (not safe to auto-fix — requires human review of DO state)
function checkCloudflareConflict(failedLog) {
  const patterns = [
    /code: 10074/,
    /Cannot apply new-sqlite-class migration.*already depended/i,
    /new-sqlite-class migration.*already depended/i,
    /migration tag.*not found in your wrangler\.toml/i,
    /Applying all available migrations.*Cannot apply/i,
  ];
  return patterns.some(p => p.test(failedLog));
}

// ── Self-test (AUTOFIX_SELFTEST=1) ─────────────────────────────────────────────
// Pure-function contract test, runnable without GitHub/OpenRouter:
//   AUTOFIX_SELFTEST=1 node scripts/autofix.mjs && echo PASS
// Exercises parseJSON tolerance and the callModel failover ladder against a
// mocked fetch, so the regression that free models only fail over on transport
// errors (not on 400-rejected response_format or prose answers) stays locked.
if (process.env.AUTOFIX_SELFTEST === '1') {
  let failed = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { console.log(`ok   ${name}`); }
    else { failed++; console.log(`FAIL ${name} ${detail}`); }
  };

  // parseJSON tolerance: fences, prose prefix, nested braces, no-JSON.
  check('parseJSON plain', parseJSON('{"a":1}').a === 1);
  check('parseJSON fenced', parseJSON('```json\n{"a":1}\n```').a === 1);
  check('parseJSON prose-prefixed', parseJSON('Sure! Here is the result:\n{"a":1}').a === 1);
  check('parseJSON nested braces', parseJSON('{"a":{"b":[{"c":2}]}}').a.b[0].c === 2);
  let threw = false; try { parseJSON('just some prose, no json'); } catch { threw = true; }
  check('parseJSON rejects plain prose', threw);

  // MISSING_CONTEXT retry targets what was asked for, not the file head (agent#1469).
  const mcNeeds = missingContextNeeds("MISSING_CONTEXT: test/a.test.cjs — the stale require('../playbooks/development.json')");
  check('missing-context need parsed', /development\.json/.test(mcNeeds.get('test/a.test.cjs') || ''));
  const bigFile = Array.from({ length: 900 }, (_, i) => i === 700 ? "const pb = require('../playbooks/development.json');" : `line ${i} filler text here`).join('\n');
  const hitLines = needleLines(bigFile, contextNeedles(mcNeeds.get('test/a.test.cjs')));
  check('needle finds line past the head', hitLines.includes(701));
  const mcEx = excerptFile(bigFile, new Set(hitLines), FILE_TOKEN_BUDGET * 4).text;
  check('retry excerpt contains the needed line', mcEx.includes('development.json'));

  // Conflict-resolution guards (hh-skill#6 regression: base-side CI jobs dropped).
  check('protected path: workflows', PROTECTED_CONFLICT_RE.test('.github/workflows/ci.yml'));
  check('protected path: src not', !PROTECTED_CONFLICT_RE.test('src/ci.yml'));
  const blk = { ours: 'a: 1\nb: 2', theirs: 'x: 1\ny: 2\nz: 3\nw: 4' };
  check('guard rejects dropping base side', /dropped/.test(checkResolvedBlock(blk, 'a: 1\nb: 2') || ''));
  check('guard accepts union', checkResolvedBlock(blk, 'a: 1\nb: 2\nx: 1\ny: 2\nz: 3\nw: 4') === null);
  check('fence stripped', stripCodeFence('```js\nconst a = 1;\n```') === 'const a = 1;');
  check('unfenced kept', stripCodeFence('const a = 1;') === 'const a = 1;');
  check('guard rejects runaway', /runaway/.test(checkResolvedBlock(blk, blk.theirs + '\n' + 'q'.repeat(1000)) || ''));

  // ── Model calls go to the llm-ladder worker (failover is server-side) ──
  check('stages use the ladder', [STAGE0_MODEL, STAGE1_MODEL, STAGE2_MODEL, STAGE3_MODEL].every(m => m === LADDER_MODEL));
  const originalFetch = globalThis.fetch;
  const calls = [];
  let MODE = 'ok';
  const jsonBody = { model: 'opencode-go/deepseek-v4-flash', choices: [{ message: { content: '{"problem":"x","files_to_examine":[],"fix_approach":"y","confidence":"high"}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0000052 } };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
    if (MODE === 'ladder502') return { ok: false, status: 502, json: async () => ({ error: { message: 'every rung failed', type: 'ladder_error', attempts: [{ model: 'opencode-go/a', outcome: 'error' }] } }) };
    if (MODE === 'auth401') return { ok: false, status: 401, json: async () => ({ error: { message: 'unauthorized' } }) };
    if (MODE === 'prose') return { ok: true, status: 200, json: async () => ({ model: 'm', choices: [{ message: { content: 'just prose' } }] }) };
    return { ok: true, status: 200, json: async () => jsonBody };
  };
  LADDER_TOKEN = 'ladder-test';

  // 1. JSON stage call → one request to the worker: ladder model, JSON mode, budgets, bearer.
  calls.length = 0; MODE = 'ok';
  try {
    const out = await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
    const b = calls[0]?.body || {};
    check('worker called once with ladder model + json mode', calls.length === 1 && /\/v1\/chat\/completions$/.test(calls[0].url) && b.model === LADDER_MODEL && b.response_format?.type === 'json_object' && out.includes('"problem"'));
    check('worker bearer token', calls[0].auth === 'Bearer ladder-test');
    check('rung budgets for long patches', b.ladder_timeout_ms === 60000 && b.ladder_total_timeout_ms === 120000);
    check('usage recorded under the answering rung', _usage.by_model['opencode-go/deepseek-v4-flash']?.calls === 1);
  } catch (e) { check('worker called once with ladder model + json mode', false, e.message); }

  // 2. Every rung failed (502) → the stage fails with the attempts in the error.
  MODE = 'ladder502';
  try { await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true); check('ladder 502 throws', false, 'should have thrown'); }
  catch (e) { check('ladder 502 throws with attempts', String(e.status) === '502' && /opencode-go\/a=error/.test(e.message)); }

  // 3. 401 (bad ladder token) surfaces as status 401.
  MODE = 'auth401';
  try { await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true); check('auth401 throws', false, 'should have thrown'); }
  catch (e) { check('auth401 throws', String(e.status) === '401'); }

  // 4. json=true + prose answer → caller-side parse error, not silent prose.
  MODE = 'prose';
  try { await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true); check('prose in json mode throws', false, 'should have thrown'); }
  catch (e) { check('prose in json mode throws', true); }

  // 5. No token → configuration error without a request.
  calls.length = 0; LADDER_TOKEN = '';
  try { await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], false); check('no token throws', false, 'should have thrown'); }
  catch (e) { check('no token throws without a request', /LLM_LADDER_TOKEN/.test(e.message) && calls.length === 0); }
  LADDER_TOKEN = 'ladder-test'; MODE = 'ok';

  // ── Input compression (issue #7) ──
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'autofix-st-'));
  const orig = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
  const mod = orig.slice();
  mod[9] = 'line 10 CHANGED';                 // hunk A
  mod.splice(60, 0, 'added after 60');        // hunk B (pure addition)
  mod.splice(101, 3);                          // hunk C (deletion-only: lines 101-103)
  writeFileSync(path.join(tmp, 'a.txt'), orig.join('\n') + '\n');
  writeFileSync(path.join(tmp, 'b.txt'), mod.join('\n') + '\n');
  let raw = '';
  try { execFileSync('git', ['diff', '--no-index', 'a.txt', 'b.txt'], { cwd: tmp, encoding: 'utf8' }); }
  catch (e) { raw = e.stdout; } // exit 1 = files differ
  raw = raw.replace(/a\/a\.txt/g, 'a/src/f.txt').replace(/b\/b\.txt/g, 'b/src/f.txt');
  const lock = 'diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,1 +1,1 @@\n-{"a":1}\n+{"a":2}\n';
  const cd = compressDiff(raw + lock, 4000, '');
  check('compress: lock file listed, not inlined', cd.includes('package-lock.json (lock/generated/binary)') && !cd.includes('{"a":2}'));
  check('compress: deletion-only hunk dropped', !cd.includes('-line 101') && cd.includes('deletion-only hunk'));
  check('compress: additions kept', cd.includes('+line 10 CHANGED') && cd.includes('+added after 60'));
  const body = cd.split('\n').filter(l => !l.startsWith('@@'));
  check('compress: asymmetric context 3/1', body.includes(' line 7') && !body.includes(' line 6') && body.includes(' line 11') && !body.includes(' line 12'));
  // Recomputed sub-hunk headers must still apply cleanly (minus the dropped deletion hunk).
  const applicable = compressDiff(raw, 4000, '').split('\n').filter(l => !l.startsWith('#')).join('\n').replace(/src\/f\.txt/g, 'a.txt') + '\n';
  writeFileSync(path.join(tmp, 'p.diff'), applicable);
  let applies = true;
  try { execFileSync('git', ['apply', '--check', 'p.diff'], { cwd: tmp, stdio: 'pipe' }); } catch { applies = false; }
  check('compress: level-0 output is a valid applicable diff', applies);
  // Budget: many big files → stays under budget, extra files listed by name, cited file first.
  const big = n => `diff --git a/f${n}.js b/f${n}.js\n--- a/f${n}.js\n+++ b/f${n}.js\n@@ -1,1 +1,200 @@\n` + Array.from({ length: 200 }, (_, i) => `+const v${i} = ${i}; // padding padding padding`).join('\n');
  const many = [1, 2, 3, 4, 5, 6].map(big).join('\n');
  const cb = compressDiff(many, 1500, 'Error at f5.js:3');
  check('compress: respects token budget', estTokens(cb) <= 1500, `~${estTokens(cb)}`);
  check('compress: over-budget files listed', /f\d\.js \(over budget\)/.test(cb));
  check('compress: log-cited file kept first', cb.indexOf('diff --git a/f5.js') === 0, cb.slice(0, 80));
  check('compress: oversized file cut mid-additions, not dropped', /more added line\(s\) in f5\.js truncated/.test(cb));
  const del = 'diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1,40 +1,2 @@\n' + Array.from({ length: 38 }, (_, i) => `-old ${i}`).join('\n') + '\n+new 1\n+new 2';
  const cl = compressDiff(del + '\n' + big(9), 1200, '');
  check('compress: level-1 collapses removals, keeps additions', cl.includes('removed line(s) omitted') && cl.includes('+new 1') && !cl.includes('-old 5'), cl.slice(0, 200));

  // Stage 2 excerpts.
  check('changedLinesByFile maps new-side lines', changedLinesByFile(raw).get('src/f.txt')?.has(10) && changedLinesByFile(raw).get('src/f.txt')?.has(61));
  check('logCitedLines finds path:line', logCitedLines('src/f.txt', 'at src/f.txt:77:3\n f.txt(5,2)').has(77) && logCitedLines('src/f.txt', 'f.txt(5,2)').has(5));
  const small = excerptFile('a\nb\nc', new Set([2]));
  check('excerpt: small file sent whole', !small.excerpt && small.text.includes('    3| c'));
  const long = Array.from({ length: 2000 }, (_, i) => `const row${i} = ${i}; // some code here`).join('\n');
  const ex = excerptFile(long, new Set([1000]));
  check('excerpt: big file windows focus line with numbers', ex.excerpt && ex.text.includes(' 1000| const row999') && ex.text.includes('omitted') && !ex.text.includes('row500 '));
  check('excerpt: within budget', estTokens(ex.text) <= FILE_TOKEN_BUDGET + 50, `~${estTokens(ex.text)}`);
  check('parseMissingContext', parseMissingContext('ok\nMISSING_CONTEXT: src/lib/a.ts — need foo()\nMISSING_CONTEXT: `b.js`').join(',') === 'src/lib/a.ts,b.js');
  rmSync(tmp, { recursive: true, force: true });

  // ── Stage 3 search/replace edits (smoke run 2: git apply rejected a correct fix) ──
  const et = mkdtempSync(path.join(os.tmpdir(), 'autofix-ed-'));
  writeFileSync(path.join(et, 'cart.js'), 'export function ship(t) {\n  return t > 50 ? 0 : 5;\n}\nconst a = 1;\nconst a2 = 1;\n');
  let r = applyEdits([{ file: 'cart.js', old_str: '  return t > 50 ? 0 : 5;', new_str: '  return t >= 50 ? 0 : 5;' }], et);
  check('edits: exact unique replace applied', r.ok && readFileSync(path.join(et, 'cart.js'), 'utf8').includes('t >= 50'));
  r = applyEdits([{ file: 'cart.js', old_str: '    2|   return t >= 50 ? 0 : 5;', new_str: '    2|   return t >= 49 ? 0 : 5;' }], et);
  check('edits: copied line-number prefix tolerated', r.ok && readFileSync(path.join(et, 'cart.js'), 'utf8').includes('t >= 49 ? 0'));
  const before = readFileSync(path.join(et, 'cart.js'), 'utf8');
  r = applyEdits([{ file: 'cart.js', old_str: 'const a', new_str: 'let a' }, { file: 'cart.js', old_str: 'return t >= 49', new_str: 'return t >= 1' }], et);
  check('edits: ambiguous match rejected atomically', !r.ok && /occurs 2 times/.test(r.errors[0]) && readFileSync(path.join(et, 'cart.js'), 'utf8') === before);
  r = applyEdits([{ file: 'cart.js', old_str: 'nope', new_str: 'x' }], et);
  check('edits: missing old_str reported', !r.ok && /not found/.test(r.errors[0]));
  r = applyEdits([{ file: '../escape.js', old_str: '', new_str: 'x' }], et);
  check('edits: path escape refused', !r.ok && /bad file path/.test(r.errors[0]));
  r = applyEdits([{ file: 'test/new.test.js', old_str: '', new_str: 'ok\n' }], et);
  check('edits: new file in new dir created', r.ok && readFileSync(path.join(et, 'test/new.test.js'), 'utf8') === 'ok\n');
  rmSync(et, { recursive: true, force: true });

  // ── CI log compression + fast paid routing (live smoke findings) ──
  const ts = '2026-09-26T20:14:11.9392263Z ';
  const rawLog = '﻿' + ts + "Current runner version: '2.337.0'\n" + ts + '##[group]Run actions/checkout@v4\n' + ts + 'with: token: ***\n' + ts + '##[endgroup]\n'
    + Array.from({ length: 400 }, (_, i) => `${ts}\x1b[32mprogress ${i} ok\x1b[0m`).join('\n') + '\n'
    + ts + '##[group]Run npm test\n' + ts + 'npm test\n' + ts + '##[endgroup]\n'
    + ts + "# Error: Cannot find module '/w/test'\n" + ts + 'not ok 1 - test\n' + ts + '##[error]Process completed with exit code 1.\n'
    + ts + 'Post job cleanup.\n' + ts + 'git version 2.4\n';
  const lc = compressLog(rawLog, 300);
  check('log: timestamps/ANSI/BOM/preamble stripped', !/2026-09-26T|\x1b|﻿|runner version/.test(lc), lc.slice(0, 120));
  // ── Agent stage config (issue #21) ──
  const ac = agentOpencodeConfig('https://ladder.example', 'deepseek');
  check('agent: provider points at the ladder /v1', ac.provider.ladder.options.baseURL === 'https://ladder.example/v1');
  check('agent: key comes from env, never inline', ac.provider.ladder.options.apiKey === '{env:LLM_LADDER_TOKEN}');
  check('agent: model = ladder name', ac.model === 'ladder/deepseek' && !!ac.provider.ladder.models.deepseek?.tool_call);
  const ap = agentPrompt({ diagnosis: { problem: 'P', fix_approach: 'F', files_to_examine: ['a.js'] }, purpose: 'X', log: 'L', diff: 'D', base: 'main' });
  check('agent: prompt carries diagnosis/log/diff and forbids commits + workflow edits', ap.includes('P') && ap.includes('a.js') && /Do NOT: commit/.test(ap) && ap.includes('.github/workflows/'));
  // ── Fix-diff gate ──
  const mk = (file, lines, extra = '') => `diff --git a/${file} b/${file}\n${extra}--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${lines}\n`;
  const okFix = checkFixDiff(mk('src/sum.js', '-  return a - b;\n+  return a + b;'));
  check('gate: a plain source fix passes', okFix.ok && okFix.files === 1 && okFix.lines === 2);
  check('gate: .skip in a test is rejected', !checkFixDiff(mk('tests/sum.test.js', "-it('adds', () => {\n+it.skip('adds', () => {")).ok);
  check('gate: xit / pytest skip rejected', !checkFixDiff(mk('test/a.test.js', "+xit('x', () => {})")).ok && !checkFixDiff(mk('tests/test_a.py', '+@pytest.mark.skip')).ok);
  check('gate: removed assertion rejected', !checkFixDiff(mk('src/__tests__/a.js', '-  expect(sum(2, 3)).toBe(5);')).ok);
  check('gate: test file deletion rejected', !checkFixDiff(mk('test/a.test.js', '-assert.ok(1)', 'deleted file mode 100644\n')).ok);
  check('gate: lock file only when the log is about deps', !checkFixDiff(mk('package-lock.json', '+x')).ok && checkFixDiff(mk('package-lock.json', '+x'), { failedLog: 'npm ci failed: lock file out of sync' }).ok);
  check('gate: workflow edit rejected', !checkFixDiff(mk('.github/workflows/ci.yml', '-  run: npm test\n+  run: true')).ok);
  const bigFix = Array.from({ length: GATE_MAX_FILES + 1 }, (_, i) => mk(`src/f${i}.js`, '+x')).join('');
  check('gate: too many files rejected', !checkFixDiff(bigFix).ok);
  check('gate: rewriting an assertion (same count) passes', checkFixDiff(mk('test/a.test.js', '-  expect(x).toBe(1);\n+  expect(x).toBe(2);')).ok);
  // ── AC-44: the receipt (Z01 slice T2) ────────────────────────────────────────
  const g1 = checkFixDiff(mk('.github/workflows/ci.yml', '-  run: npm test\n+  run: true'));
  check('gate: reasons shape unchanged (string[])', Array.isArray(g1.reasons) && g1.reasons.every(r => typeof r === 'string'));
  check('gate: violations carry rule_id + path + message', g1.violations.length === 1 && g1.violations[0].rule_id === 'workflow_edited' && g1.violations[0].path === '.github/workflows/ci.yml' && !!g1.violations[0].message);
  const g2 = checkFixDiff(mk('tests/sum.test.js', "+it.skip('a', () => {})"));
  check('gate: rule id discriminates (test_disabled ≠ workflow_edited)', g2.violations[0].rule_id === 'test_disabled');
  const g3 = checkFixDiff(mk('src/__tests__/a.js', '-  expect(sum(2, 3)).toBe(5);'));
  check('gate: assertion_removed rule id', g3.violations[0].rule_id === 'assertion_removed');
  const g4 = checkFixDiff(mk('test/a.test.js', '-assert.ok(1)', 'deleted file mode 100644\n'));
  check('gate: test_file_deleted rule id', g4.violations[0].rule_id === 'test_file_deleted');
  const g5 = checkFixDiff(Array.from({ length: GATE_MAX_FILES + 1 }, (_, i) => mk(`src/f${i}.js`, '+x')).join(''));
  check('gate: too_many_files rule id', g5.violations.some(v => v.rule_id === 'too_many_files'));
  check('gate: every rule id is inside the fixed dictionary', [g1, g2, g3, g4, g5].every(g => g.violations.every(v => RULE_IDS.has(v.rule_id))));
  check('gate: reasons and violations never diverge in count', [g1, g2, g3, g4, g5].every(g => g.reasons.length === g.violations.length));
  check('gate: a clean diff has empty violations', checkFixDiff(mk('src/sum.js', '-a\n+b')).violations.length === 0);
  const cm = {};
  const cmText = compressDiff(mk('src/sum.js', '-  return a - b;\n+  return a + b;').replace('--- a/src/sum.js\n', '').replace('+++ b/src/sum.js\n', ''), 4000, '', cm);
  check('meta: compressDiff fills included_paths', Array.isArray(cm.included_paths) && cm.included_paths.includes('src/sum.js'), JSON.stringify(cm.included_paths));
  check('meta: compressDiff reports tokens_used and budget_tokens', typeof cm.tokens_used === 'number' && cm.tokens_used > 0 && cm.budget_tokens === 4000);
  check('meta: compressDiff reports omitted_paths with reasons', Array.isArray(cm.omitted_paths) && cm.omitted_paths.every(o => o.path && o.reason));
  check('meta: omitted lock file is labelled, not silently dropped', (() => {
    const m2 = {};
    compressDiff('diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1,1 +1,1 @@\n-a\n+b\n', 4000, '', m2);
    return m2.omitted_paths.some(o => o.path === 'package-lock.json' && o.reason === 'lock_generated_binary');
  })());
  check('meta: omitted_paths is []-safe when there is nothing to omit', Array.isArray((() => { const m3 = {}; compressDiff('', 4000, '', m3); return m3.omitted_paths; })()));
  check('creds: checkout credential keys are matched', ['http.https://github.com/.extraheader', 'includeIf.gitdir:/x/.git.path', 'credential.helper'].every(k => GIT_CRED_KEY_RE.test(k)) && !GIT_CRED_KEY_RE.test('user.name'));
  check('log: group bodies dropped, step headers kept', lc.includes('▶ Run npm test') && !lc.includes('token: ***'));
  check('log: error lines survive the budget', lc.includes("Cannot find module '/w/test'") && lc.includes('not ok 1') && lc.includes('ERROR: Process completed with exit code 1'));
  check('log: within budget, post-job cleanup cut', estTokens(lc) <= 300 && !lc.includes('git version'), `~${estTokens(lc)}`);
  // ── Pre-stage A: behind + clean merge → in place, never a new PR (trained-assist-agent#1663) ──
  const gt = mkdtempSync(path.join(os.tmpdir(), 'autofix-behind-'));
  const g = (...a) => execFileSync('git', a, { cwd: gt, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g('init', '-q', '--bare', 'origin.git');
  g('clone', '-q', 'origin.git', 'w');
  const gw = (...a) => execFileSync('git', a, { cwd: path.join(gt, 'w'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  gw('config', 'user.email', 't@t'); gw('config', 'user.name', 't');
  gw('checkout', '-q', '-b', BASE_BRANCH);
  writeFileSync(path.join(gt, 'w', 'a.txt'), 'a\n'); gw('add', '-A'); gw('commit', '-qm', 'base');
  gw('push', '-q', 'origin', BASE_BRANCH);
  gw('checkout', '-q', '-b', 'feat');
  writeFileSync(path.join(gt, 'w', 'b.txt'), 'b\n'); gw('add', '-A'); gw('commit', '-qm', 'feat');
  const cwd0 = process.cwd();
  process.chdir(path.join(gt, 'w'));
  try {
    const behindLog = 'X Pull request o/r#1 is not mergeable: the base branch policy prohibits the merge.';
    let pa = await tryFixOutOfDate(behindLog, '');
    check('pre-A: up-to-date branch → noop, no fix PR', pa?.noop === true && pa.category === 'skip:not_behind');
    gw('checkout', '-q', BASE_BRANCH);
    writeFileSync(path.join(gt, 'w', 'c.txt'), 'c\n'); gw('add', '-A'); gw('commit', '-qm', 'main moved');
    gw('push', '-q', 'origin', BASE_BRANCH);
    gw('checkout', '-q', 'feat');
    const featSha = gw('rev-parse', 'HEAD').trim();
    pa = await tryFixOutOfDate(behindLog, '');
    check('pre-A: behind + clean → in place, pinned to head', pa?.inPlace === true && pa.category === 'success:pre_a_update_in_place' && pa.headSha === featSha);
    check('pre-A: conflict probe leaves the checkout untouched', gw('rev-parse', 'HEAD').trim() === featSha && !gw('status', '--porcelain').trim());
    check('pre-A: unrelated failure log is not staleness', (await tryFixOutOfDate('Error: test failed', '')) === null);
  } finally {
    process.chdir(cwd0);
    rmSync(gt, { recursive: true, force: true });
  }

  // ── Supersede guard (trained-assist-engineering#27) ─────────────────────
  // Pure decision: open + no `superseded` label + stable head = actionable.
  // Unknown live state (null PR or a failed read) is NOT actionable: this is
  // the class defect the first draft had — it proceeded on a failed fetch.
  check('guard: open PR actionable', classifyLivePr({ state: 'open', labels: [], head: { sha: 'abc123' } }, '', 7).state === GUARD.OK);
  check('guard: closed detected', classifyLivePr({ state: 'closed', labels: [], head: { sha: 'abc123' } }, 'abc123', 7).state === GUARD.STALE);
  check('guard: superseded label detected', /superseded/.test(classifyLivePr({ state: 'open', labels: [{ name: 'superseded' }], head: { sha: 'abc123' } }, 'abc123', 7).reason));
  check('guard: unrelated label ignored', classifyLivePr({ state: 'open', labels: [{ name: 'wip' }], head: { sha: 'abc123' } }, 'abc123', 7).state === GUARD.OK);
  check('guard: head moved detected', /head moved/.test(classifyLivePr({ state: 'open', labels: [], head: { sha: 'def456' } }, 'abc123', 7).reason));
  check('guard: NO live data fails closed (fail-open regression)', classifyLivePr(null, 'abc123', 7).state === GUARD.UNKNOWN);
  check('guard: read error fails closed', classifyLivePr({ readError: 'HTTP 502' }, 'abc123', 7).state === GUARD.UNKNOWN);

  // End-to-end, mocked: the REAL publish sequence (push → PR → cleanup →
  // auto-merge → close original) driven through the REAL guard with a scripted
  // GitHub. A mutation recorder must stay EMPTY when the PR stops being ours
  // between diagnosis and publish — that race is what pure prStaleReason
  // self-tests cannot show.
  const MUTATIONS = ['push', 'create-pr', 'close-stale', 'auto-merge', 'close-original'];
  const healthy = { state: 'open', labels: [], head: { sha: 'head-1' } };
  const scenarios = [
    ['healthy', () => healthy, { aborted: false }],
    ['superseded mid-run', () => (mutations.length ? { state: 'open', labels: [{ name: 'superseded' }], head: { sha: 'head-1' } } : healthy), { aborted: true, afterZeroMutations: true }],
    ['head moved mid-run', () => (mutations.length ? { state: 'open', labels: [], head: { sha: 'head-2' } } : healthy), { aborted: true, afterZeroMutations: true }],
    ['api failure mid-run', () => (mutations.length ? { throw: 'HTTP 502 from gh api' } : healthy), { aborted: true, afterZeroMutations: true }],
    ['api failure from the start (read fails)', () => { throw new Error('HTTP 503 from gh api'); }, { aborted: true, afterZeroMutations: true, wantState: GUARD.UNKNOWN }],
  ];
  for (const [name, next, want] of scenarios) {
    const mutations = [];
    const scriptedSteps = MUTATIONS.map(name => ({ where: `before ${name}`, run: async () => { mutations.push(name); } }));
    const guard = createGuard({ prNumber: 7, fetchPr: () => { const r = next(); if (r && r.throw) throw new Error(r.throw); return r; } });
    const res = await runGuardedSequence({ guard, steps: scriptedSteps });
    check(`guard e2e: ${name} → aborted=${res.aborted}`, res.aborted === want.aborted);
    if (want.wantState) check(`guard e2e: ${name} → state=${want.wantState}`, res.state === want.wantState);
    if (want.afterZeroMutations) {
      check(`guard e2e: ${name} → no mutation happened`, mutations.length === 0, `mutations=${JSON.stringify(mutations)}`);
    }
  }

  globalThis.fetch = originalFetch;
  if (failed > 0) { console.error(`SELFTEST FAILED: ${failed} check(s)`); process.exit(1); }
  console.log('SELFTEST PASS');
  process.exit(0);
}

// ── Preflight ────────────────────────────────────────────────────────────────

if (!LLM_LADDER_TOKEN) failWithStats('fail:other', 'LLM_LADDER_TOKEN not set (trained-assist-llm-ladder worker)');
log('model', `llm-ladder: ${LADDER_URL} model ${LADDER_MODEL}`);
if (!REPO || !PR_NUMBER) failWithStats('fail:other', 'missing REPO/PR_NUMBER env');
if (!BATCH_MODE && !RUN_ID) failWithStats('fail:other', 'missing RUN_ID env (set RUN_ID=0 for batch/manual mode)');

// Configure git identity early — needed for merge commits (before tryFixOutOfDate)
try {
  sh('git config user.name "trained-assist-autofix"');
  sh('git config user.email "autofix@trained-assist.bot"');
} catch { /* non-fatal — will fail later if identity really needed */ }

// ── Live-PR guard (supersede-aware) + race guard ────────────────────────────
// One live read decides everything: stale (closed / `superseded` / head moved),
// unknown (read failed) or ok. Unknown is NOT ok — we mutate nothing until
// GitHub confirms the PR is still ours. Batch mode targets stale fix branches
// instead of a live PR, so it keeps its previous behaviour (no guard).
const prGuard = BATCH_MODE ? null : createGuard({
  prNumber: PR_NUMBER,
  fetchPr: n => JSON.parse(sh(`gh api "repos/${REPO}/pulls/${n}"`)),
});

function abortOnGuard(verdict) {
  const category = verdict.state === GUARD.UNKNOWN ? 'fail:guard_unknown_state' : 'fail:race_pr_superseded';
  log('guard', `[${verdict.where}] ${verdict.reason} — aborting before any mutation`);
  writeStats(category, { reason: verdict.reason, where: verdict.where, guard_state: verdict.state });
  process.exit(0); // not a failure of the tool — there is simply nothing to fix
}

if (prGuard) {
  const startVerdict = prGuard.check('start');
  if (startVerdict.state !== GUARD.OK) abortOnGuard(startVerdict);
}
{
  // CI-state race: the PR may have gone green between the webhook and this run.
  let prInfo;
  try {
    prInfo = JSON.parse(sh(`gh pr view ${PR_NUMBER} -R ${REPO} --json state,statusCheckRollup`));
  } catch (e) {
    // Fail closed (same rule as the supersede guard): no readable PR → no write.
    abortOnGuard({ state: GUARD.UNKNOWN, reason: `could not read PR #${PR_NUMBER} state (${e.message}) — failing closed`, where: 'start' });
  }
  if (prInfo.state !== 'OPEN') {
    writeStats('fail:race_pr_closed', { reason: `PR is already ${prInfo.state}` });
    log('guard', `PR #${PR_NUMBER} is already ${prInfo.state} — aborting`);
    process.exit(0); // not a real failure — nothing to do
  }
  const checks = prInfo.statusCheckRollup || [];
  if (!BATCH_MODE && checks.length > 0 && !checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')) {
    writeStats('fail:race_pr_closed', { reason: 'CI no longer shows failures' });
    log('guard', `PR #${PR_NUMBER} CI no longer shows failures — aborting`);
    process.exit(0);
  }
}

let failedLog = '';
if (BATCH_MODE) {
  log('batch', `batch mode (RUN_ID=${RUN_ID || 'unset'}) — skipping CI log fetch, will always attempt merge`);
} else {
  try {
    // gh run view --log-failed fails when the overall run is still in progress
    // (which it always is, since autofix runs as a job within the same run).
    // Instead: fetch individual job logs for completed failed jobs via the API.
    try {
      const jobsRaw = sh(`gh api "repos/${REPO}/actions/runs/${RUN_ID}/jobs" --jq '[.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out")]'`);
      const failedJobs = JSON.parse(jobsRaw);
      if (failedJobs.length === 0) throw new Error('no failed jobs found in run');
      const logParts = [];
      for (const job of failedJobs) {
        try {
          // --allow-escape-sequences: job logs contain ANSI color codes; newer gh
          // CLI versions refuse to print them to stdout without this flag, which
          // made every automatic-mode run fail with fail:other "could not fetch CI log".
          const jobLog = sh(`gh api --allow-escape-sequences "repos/${REPO}/actions/jobs/${job.id}/logs"`).slice(-60000);
          logParts.push(`=== job: ${job.name} ===\n${jobLog}`);
        } catch { /* best effort per job */ }
      }
      failedLog = logParts.join('\n\n').slice(-LOG_CHAR_LIMIT);
      if (!failedLog) throw new Error('all job log fetches failed');
    } catch (apiErr) {
      log('fetch-log', `job-level API fetch failed (${apiErr.message}), falling back to --log-failed`);
      failedLog = sh(`gh run view ${RUN_ID} --log-failed -R ${REPO}`).slice(-LOG_CHAR_LIMIT);
    }
  } catch (e) {
    failWithStats('fail:other', `could not fetch CI log: ${e.message}`);
  }
}

// Deterministic pre-stage checks regex the RAW log; only LLM prompts get the
// compressed one.
const failedLogRaw = failedLog;
const rawLogTokens = estTokens(failedLog);
failedLog = compressLog(failedLog);
if (failedLog) log('input', `CI log compressed: ~${rawLogTokens} → ~${estTokens(failedLog)} tokens`);

// prDiffRaw drives Stage 2 excerpts; prDiff is the structurally compressed
// version every prompt sees (issue #7 — no more blind 10k-char slice).
let prDiffRaw = '';
let prDiff = '';
// The AC-44 receipt is filled HERE, on the wire, not declared at the writer (R6). `compressDiff`
// already computes what entered the prompt, what was omitted and the tokens spent — it fills
// `meta` in place — but the production call sites passed no meta, so ci-fixer-stats.json reported
// patch_refs=[], included_paths=[] and budget.diff_tokens_used=0 while the run had in fact done all
// of that work. The selftest fed the function a hand-written object instead, so the test asserted
// the writer's contract, never the artifact's.
const receiptMeta = { included_paths: [], omitted_paths: [], tokens_used: 0 };
let logTokensUsed = 0;
let fixAttempts = 1; // edit attempts actually spent; the agent path spends exactly one
try {
  sh(`git fetch origin ${BASE_BRANCH} --quiet`);
  prDiffRaw = sh(`git diff origin/${BASE_BRANCH}...HEAD`);
  prDiff = compressDiff(prDiffRaw, DIFF_TOKEN_BUDGET, failedLog, receiptMeta);
  logTokensUsed = estTokens(failedLog);
  log('input', `diff compressed: ~${estTokens(prDiffRaw)} → ~${estTokens(prDiff)} tokens`);
} catch { /* best effort */ }

// ── Stage 0: Reasoning — understand WHY this PR exists ───────────────────────
// Before touching anything, ask: is the PR's purpose clear enough to auto-fix?
// If not — comment and stop. Never patch blindly.
// prPurpose is module-scoped so tryFixOutOfDate (pre-stage A) can use it for
// AI conflict resolution after Stage 0 runs.
let prPurpose = '';
{
  log('stage0', 'fetching PR metadata for purpose reasoning...');

  let prMeta = { title: '', body: '', commits: [] };
  try {
    const raw = sh(`gh pr view ${PR_NUMBER} -R ${REPO} --json title,body,commits`);
    prMeta = JSON.parse(raw);
  } catch { /* non-fatal — proceed with empty */ }

  const commitMessages = (prMeta.commits || [])
    .slice(-10)
    .map(c => c.messageHeadline || '')
    .filter(Boolean)
    .join('\n');

  const prContext = [
    `PR title: ${prMeta.title || '(no title)'}`,
    `PR body: ${(prMeta.body || '(empty)').slice(0, 800)}`,
    `Recent commits:\n${commitMessages || '(none)'}`,
    `Branch: ${ORIGINAL_BRANCH}`,
  ].join('\n\n');

  let reasoning;
  try {
    const raw = await callModel(STAGE0_MODEL, [
      {
        role: 'system',
        content: `You are a PR reviewer. Given a PR's title, body, and commit messages, decide whether the PR's purpose is clear enough to safely attempt an automated CI fix.

Reply with valid JSON only:
{
  "purpose": "one sentence describing what this PR is trying to do",
  "is_clear": true,
  "ambiguity_reason": ""
}

Set is_clear=false if:
- The PR title/body is empty or gibberish
- The change seems to be a significant business-logic redesign (not just a technical fix)
- You cannot tell what the PR is trying to accomplish at all

Set is_clear=true for ordinary feature PRs, bug fixes, refactors, dependency updates — even if you don't know the codebase details.`,
      },
      { role: 'user', content: prContext },
    ], true);
    // callModel already validated this parses when json=true; parseJSON also
    // tolerates fences/prose wrappers that JSON.parse(cleaned) used to choke on.
    reasoning = parseJSON(raw);
  } catch (e) {
    log('stage0', `reasoning model error (${e.message.slice(0, 80)}) — assuming clear and proceeding`);
    reasoning = { purpose: 'unknown (model error)', is_clear: true, ambiguity_reason: '' };
  }

  prPurpose = reasoning.purpose;
  log('stage0', `purpose: ${prPurpose}`);
  log('stage0', `is_clear: ${reasoning.is_clear}`);

  if (!reasoning.is_clear) {
    if (BATCH_MODE) {
      // In batch mode we're here to merge a stale branch, not to diagnose CI failures.
      // Proceed with branch name as purpose fallback for conflict resolution.
      log('stage0', `ambiguous in batch mode — proceeding anyway (purpose: ${reasoning.purpose})`);
    } else {
      const why = reasoning.ambiguity_reason || 'could not determine PR purpose';
      await prComment(`🤷 PR purpose unclear — ${why}\n\nSkipping automated fix. Please clarify the PR description or link a related issue.`);
      writeStats('fail:stage0_ambiguous', { reason: why, purpose: reasoning.purpose });
      log('stage0', `ambiguous PR — stopping`);
      process.exit(0); // not a failure — just not our job
    }
  }

  // Announce we're starting — purpose confirmed
  await prComment(`🔍 Starting automated fix\n\n**PR purpose:** ${reasoning.purpose}\n**CI failure:** fetching logs…`);
}

// ── Run pre-stage strategies (deterministic, no AI) ──────────────────────────

// Pre-stage C: Cloudflare conflicts — bail with a precise message, never patch blindly
if (checkCloudflareConflict(failedLogRaw)) {
  await prComment('❌ Cannot auto-fix: Cloudflare Durable Objects migration conflict (code 10074)\n\nThe migration tag in `wrangler.toml` is out of sync with what Cloudflare has deployed. Patching this blindly would corrupt live DO state. Needs human review of the migration history.');
  failWithStats(
    'fail:cloudflare_do',
    'Cloudflare DO migration conflict (code 10074 or similar) — migration tag out of sync with deployed state',
    { hint: 'Check wrangler.toml migration history vs what Cloudflare has deployed. Code 10074 = class already has live instances that depend on a previous schema. Patching blindly would corrupt live DO state — needs human review.' }
  );
}

// Pre-stage A + B: deterministic fixes
let preStageDiagnosis = null;

const outOfDateResult = await tryFixOutOfDate(failedLogRaw, prPurpose);
if (outOfDateResult) {
  if (!outOfDateResult.ok) {
    const icon = outOfDateResult.category === 'fail:ai_conflict_resolution' ? '🤖' : '❌';
    await prComment(`${icon} Could not fix: ${outOfDateResult.reason}\n\n\`\`\`\n${outOfDateResult.detail || ''}\n\`\`\``);
    failWithStats(outOfDateResult.category, outOfDateResult.reason, { detail: outOfDateResult.detail });
  }
  if (outOfDateResult.noop) {
    await prComment(`ℹ️ ${outOfDateResult.problem}. Nothing to fix in code — no fix PR created.`);
    writeStats(outOfDateResult.category, { problem: outOfDateResult.problem });
    process.exit(0);
  }
  if (outOfDateResult.inPlace) {
    // expected_head_sha: if the author pushed since we checked out, GitHub refuses (422)
    // instead of merging into a head we never looked at.
    if (prGuard) {
      const inPlaceVerdict = prGuard.check('before update-branch in place');
      if (inPlaceVerdict.state !== GUARD.OK) abortOnGuard(inPlaceVerdict);
    }
    try {
      sh(`gh api -X PUT "repos/${REPO}/pulls/${PR_NUMBER}/update-branch" -f expected_head_sha=${outOfDateResult.headSha}`);
    } catch (e) {
      const reason = `update-branch refused: ${String(e.stderr || e.message).slice(0, 200)}`;
      await prComment(`❌ Branch is behind \`${BASE_BRANCH}\` but could not be updated in place — ${reason}`);
      failWithStats('fail:update_branch', reason);
    }
    await prComment(`🔄 ${outOfDateResult.problem}\n\n**Fix:** ${outOfDateResult.fix_approach} CI re-runs on this PR.`);
    writeStats(outOfDateResult.category, { problem: outOfDateResult.problem, fix: outOfDateResult.fix_approach });
    console.log(`[autofix] PR #${PR_NUMBER} branch updated in place from ${BASE_BRANCH}`);
    process.exit(0);
  }
  preStageDiagnosis = outOfDateResult;
}

if (!preStageDiagnosis) {
  const permResult = tryFixMissingPermissions(failedLogRaw);
  if (permResult) {
    if (!permResult.ok) {
      await prComment(`❌ Could not fix: GitHub Actions permissions issue but no patchable workflow found\n\nReason: ${permResult.reason}`);
      failWithStats(permResult.category, permResult.reason);
    }
    preStageDiagnosis = permResult;
  }
}

// ── AI pipeline (only runs if pre-stages didn't apply) ───────────────────────

let diagnosis;
// Set when the AUTOFIX_AGENT run errored/timed out → Stages 2–3 ran instead (lands in stats).
var agentFellBack = null;
let patchToApply = null; // set by stage 3 if AI ran

if (preStageDiagnosis) {
  diagnosis = preStageDiagnosis;
  log('pre', `pre-stage fix applied (${preStageDiagnosis.category}) — skipping AI pipeline`);
  await prComment(`🔧 Deterministic fix applied (no AI needed)\n\n**Cause:** ${preStageDiagnosis.problem}\n**Fix:** ${preStageDiagnosis.fix_approach}`);
} else {
  // ── Stage 1: Diagnose ──────────────────────────────────────────────────────
  log('stage1', `calling ${STAGE1_MODEL} for diagnosis...`);
  await prComment('🔎 Stage 1/3: diagnosing CI failure with a cheap LLM…');

  let stage1Content;
  try {
    stage1Content = await callModel(STAGE1_MODEL, [
      {
        role: 'system',
        content: `You are a CI failure analyst. Given a failed GitHub Actions log and a PR diff, identify the root cause and which source files need to be changed.

Reply with valid JSON only:
{
  "problem": "concise one-paragraph root cause description",
  "files_to_examine": ["path/to/file1.js", "path/to/file2.js"],
  "fix_approach": "brief description of what to change and where",
  "confidence": "high|medium|low"
}

Rules:
- files_to_examine: list up to ${MAX_FILES} specific source files (not node_modules, not lock files)
- If the fix is obvious from the log alone and needs no extra file context, set files_to_examine to []
- The PR diff is COMPRESSED: trimmed context, removed lines may be collapsed, some files listed as "not shown". If the cause may live in a file or region you cannot see, put that file in files_to_examine — never guess its content
- If you cannot determine the cause, set problem to "CANNOT_DIAGNOSE"
- confidence: high = clear deterministic fix; medium = likely fix; low = uncertain`,
      },
      {
        role: 'user',
        content: `Failed CI log (tail):\n\`\`\`\n${failedLog}\n\`\`\`\n\nPR diff vs ${BASE_BRANCH}:\n\`\`\`diff\n${prDiff}\n\`\`\``,
      },
    ], true);
  } catch (e) {
    await prComment(`❌ Stage 1 model error — could not diagnose CI failure\n\n\`${e.message.slice(0, 200)}\``);
    failWithStats('fail:ai_model_error', `Stage 1 model error: ${e.message.slice(0, 200)}`);
  }

  try {
    diagnosis = parseJSON(stage1Content);
  } catch (e) {
    await prComment(`❌ Stage 1 returned unparseable response — cannot proceed`);
    failWithStats('fail:ai_no_diagnose', `Stage 1 returned invalid JSON: ${e.message}`, { raw: stage1Content.slice(0, 300) });
  }

  if (diagnosis.problem === 'CANNOT_DIAGNOSE') {
    await prComment('❌ Stage 1: could not identify root cause from CI logs\n\nThe failure may require context only a human has. Please check the CI run directly.');
    failWithStats('fail:ai_no_diagnose', 'Stage 1 could not identify root cause');
  }
  if (diagnosis.confidence === 'low') {
    await prComment(`❌ Stage 1: diagnosis confidence too low — not safe to auto-fix\n\n**Suspected cause:** ${diagnosis.problem}\n\nPlease review manually.`);
    failWithStats('fail:ai_low_confidence', `Low confidence — not safe to auto-fix`, { problem: diagnosis.problem });
  }

  log('stage1', `diagnosis: ${diagnosis.problem.slice(0, 120)}`);
  log('stage1', `confidence: ${diagnosis.confidence || 'unset'}`);
  log('stage1', `files to examine: ${(diagnosis.files_to_examine || []).join(', ') || '(none)'}`);
  await prComment(`✅ Stage 1/3: root cause identified (confidence: ${diagnosis.confidence || '?'})\n\n**Cause:** ${diagnosis.problem}\n**Plan:** ${diagnosis.fix_approach}`);;

  if (AGENT_MODE) {
  // ── Agent stage (replaces Stages 2–3) ──────────────────────────────────────
  await prComment(`🤖 Agent: fixing with opencode (ladder \`${LADDER_MODEL}\`) — reads files, runs the failing tests, iterates…`);
  const headBefore = sh('git rev-parse HEAD').trim();
  const creds = hideGitCredentials();
  log('agent', `git credentials hidden for the agent run (${creds.hidden.length} entr${creds.hidden.length === 1 ? 'y' : 'ies'})`);
  let res;
  try {
    res = runAgentFix(agentPrompt({ diagnosis, purpose: prPurpose, log: failedLog, diff: prDiff, base: BASE_BRANCH }));
  } finally {
    restoreGitConfig(creds);
  }
  const changed = normalizeAgentChanges(headBefore);
  log('agent', `finished (ok=${res.ok}${res.error ? `, ${res.error}` : ''}); changed: ${changed.split('\n').filter(Boolean).length} path(s)`);
  if (!changed && res.ok) {
    await prComment(`❌ Agent made no change\n\n**Cause:** ${diagnosis.problem}\n\n\`\`\`\n${res.summary.slice(-800)}\n\`\`\``);
    failWithStats('fail:agent_no_change', 'agent finished without changing any file', { problem: diagnosis.problem, agent_summary: res.summary.slice(-500) });
  }
  if (changed) {
    diagnosis.fix_approach = res.summary.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 600) || diagnosis.fix_approach;
    diagnosis.agent = true;
  } else {
    // The agent could not run / went silent (timeout) → the single-shot Stages 2–3 below.
    agentFellBack = res.error;
    log('agent', `agent error (${res.error}) — falling back to Stages 2–3`);
    await prComment(`⚠️ Agent failed (${res.error}) — falling back to single-shot Stages 2–3`);
  }
  }
  if (!AGENT_MODE || agentFellBack) {
  // ── Stage 2: Gather context ────────────────────────────────────────────────
  const fileList = (diagnosis.files_to_examine || []).slice(0, MAX_FILES);
  const fileContents = [];
  const changedLines = changedLinesByFile(prDiffRaw);

  // Line-numbered excerpts around PR-changed and log-cited lines (small files
  // whole). full=true is the MISSING_CONTEXT retry: the plain capped file.
  // full = the MISSING_CONTEXT retry: a 4x budget, focused on lines matching
  // what the model asked for (+ diagnosis), not the head of the file.
  const loadFile = (filePath, full = false, need = '') => {
    const content = readFileSafe(path.join(process.cwd(), filePath), 1_000_000);
    if (content === null) { log('stage2', `skipped ${filePath} (not found)`); return null; }
    const focus = new Set([...(changedLines.get(filePath) || []), ...logCitedLines(filePath, failedLog)]);
    // First pass also focuses on what the DIAGNOSIS names (agent#1469: the stale
    // require() sat on line ~400 of a 48k test file, neither PR-changed nor
    // log-cited → a 343-token excerpt without it → Stage 3 declined).
    const hits = needleLines(content, contextNeedles(full ? need : '', diagnosis.problem, diagnosis.fix_approach), full ? 40 : 15);
    hits.forEach(l => focus.add(l));
    if (hits.length) log('stage2', `${filePath}: focus +${hits.length} line(s) matching ${full ? 'the requested context' : 'the diagnosis'}`);
    const { text, excerpt } = excerptFile(content, focus, full ? FILE_TOKEN_BUDGET * 4 : FILE_TOKEN_BUDGET);
    log('stage2', `loaded ${filePath} (${content.length} chars → ~${estTokens(text)} tokens${excerpt ? ', excerpt' : ''})`);
    return `=== ${filePath}${excerpt ? ' (EXCERPT — gaps marked)' : ''} ===\n${text}`;
  };
  for (const filePath of fileList) {
    const block = loadFile(filePath);
    if (block) fileContents.push(block);
  }

  let changeSpec = diagnosis.fix_approach;

  if (fileContents.length > 0) {
    log('stage2', `calling ${STAGE2_MODEL} for context analysis...`);

    try {
      const stage2Content = await callModel(STAGE2_MODEL, [
        {
          role: 'system',
          content: `You are a code reviewer helping plan a minimal CI fix. You will receive:
1. A root cause diagnosis
2. The actual source file contents
3. The PR diff

Your job: describe exactly what lines/functions need to change to fix the CI failure. Be specific (file, function name, what to add/remove/change). Do NOT write code — only describe the change in plain English.

If the diagnosis is wrong given what you see in the files, correct it.

Inputs are COMPRESSED: files may be line-numbered EXCERPTS with "... omitted" gaps, and the diff is trimmed. If the part you need is not visible, do NOT guess — output one line per file: MISSING_CONTEXT: <path> — <what you need>. You will then get the full file.`,
        },
        {
          role: 'user',
          content: `Root cause: ${diagnosis.problem}\n\nProposed fix approach: ${diagnosis.fix_approach}\n\nSource files:\n\n${fileContents.join('\n\n')}\n\nPR diff:\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nDescribe the exact changes needed.`,
        },
      ]);

      changeSpec = stage2Content;
      // One retry with full files when the model says the excerpt was not enough.
      const missing = [...new Set(parseMissingContext(stage2Content))].slice(0, MAX_FILES);
      if (missing.length) {
        log('stage2', `model reported MISSING_CONTEXT for: ${missing.join(', ')} — retrying with full files`);
        const needs = missingContextNeeds(stage2Content);
        const full = missing.map(f => loadFile(f, true, needs.get(f) || '')).filter(Boolean);
        const others = fileContents.filter(b => !missing.some(f => b.startsWith(`=== ${f} `) || b.startsWith(`=== ${f}\n`)));
        if (full.length) {
          changeSpec = await callModel(STAGE2_MODEL, [
            { role: 'system', content: 'You are a code reviewer helping plan a minimal CI fix. Describe exactly what lines/functions need to change (file, function, what to add/remove/change). Plain English, no code. The files you asked for are re-sent, focused on the lines matching what you asked for (line-numbered; gaps marked). If something is still missing, say so explicitly instead of guessing.' },
            { role: 'user', content: `Root cause: ${diagnosis.problem}\n\nProposed fix approach: ${diagnosis.fix_approach}\n\nSource files:\n\n${[...full, ...others].join('\n\n')}\n\nPR diff:\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nDescribe the exact changes needed.` },
          ]);
        }
      }
      log('stage2', `change spec (first 200): ${changeSpec.slice(0, 200)}`);
    } catch (e) {
      log('stage2', `model error (${e.message.slice(0, 80)}) — falling back to stage 1 diagnosis`);
    }
  } else {
    log('stage2', 'no files to load, skipping stage 2 — using diagnosis directly');
  }

  // ── Stage 3: Write patch ───────────────────────────────────────────────────
  log('stage3', `calling ${STAGE3_MODEL} to write patch...`);
  await prComment('🔧 Stage 3/3: generating patch…');

  // Stage 3 returns exact search/replace edits, not a unified diff: models
  // can't count @@ line numbers — the live smoke's correct fix died in
  // `git apply` (fail:ai_corrupt_patch). Exact-substring edits have no hunk
  // arithmetic (bench-cicd/fix-loop.mjs). One retry with the apply errors fed
  // back; a model that still answers with a diff goes down the diff path below.
  const stage3System = `You are a CI auto-fix bot. Fix the CI failure with the smallest possible change — no refactors, no unrelated edits.

Reply with JSON only:
{"edits":[{"file":"path/to/file","old_str":"exact text currently in the file","new_str":"replacement text"}]}

Rules:
- old_str must be copied VERBATIM from the current file (same whitespace/indentation) and must occur exactly once in it; include 1-3 surrounding lines if needed to make it unique
- Source files are shown with a "NNNNN| " line-number prefix that is NOT part of the file — never copy the prefix into old_str/new_str
- To create a new file: old_str "" and new_str = whole file content
- If the excerpts don't show the exact text you need to replace, or you cannot fix it safely, reply {"cannot_fix":"<reason, e.g. missing context: file/what>"}`;
  const stage3User = `Root cause:\n${diagnosis.problem}\n\nWhat to change:\n${changeSpec}\n\n${fileContents.length ? `Source files (current PR state):\n\n${fileContents.join('\n\n')}\n\n` : ''}Current PR diff (for context on what already changed):\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nReturn the edits.`;

  let stage3Content, applied = null;
  const messages3 = [{ role: 'system', content: stage3System }, { role: 'user', content: stage3User }];
  for (let attempt = 1; attempt <= 2 && !applied; attempt++) {
    // How many edit attempts this run actually spent — the receipt states it rather than always 1.
    fixAttempts = attempt;
    try {
      stage3Content = await callModel(STAGE3_MODEL, messages3, false, { reasoning: true });
    } catch (e) {
      failWithStats('fail:ai_model_error', `Stage 3 model error: ${e.message.slice(0, 200)}`, { problem: diagnosis.problem });
    }
    let parsed = null;
    try { parsed = parseJSON(stage3Content); } catch { /* not JSON — maybe a diff */ }
    const why = parsed?.cannot_fix || ((stage3Content || '').match(/CANNOT_FIX:?\s*(.{0,300})/)?.[1]?.trim()) || (/CANNOT_FIX/.test(stage3Content || '') ? 'no reason given' : '');
    if (!stage3Content || why) {
      await prComment(`❌ Stage 3: model declined to generate a patch\n\n**Cause:** ${diagnosis.problem}\n**Model says:** ${String(why || 'empty answer').slice(0, 300)}\n\nThis likely requires a code change that needs human judgement.`);
      failWithStats('fail:ai_cannot_fix', `Stage 3 declined to produce a patch: ${String(why || 'empty answer').slice(0, 200)}`, {
        problem: diagnosis.problem,
        fix_approach: diagnosis.fix_approach,
      });
    }
    if (Array.isArray(parsed?.edits)) {
      const res = applyEdits(parsed.edits, process.cwd());
      if (res.ok) { applied = res; break; }
      log('stage3', `edits rejected (attempt ${attempt}): ${res.errors.join('; ').slice(0, 300)}`);
      if (attempt === 2) {
        await prComment(`❌ Stage 3: edits did not match the files\n\n**Cause:** ${diagnosis.problem}\n\n\`\`\`\n${res.errors.join('\n').slice(0, 500)}\n\`\`\``);
        failWithStats('fail:ai_corrupt_patch', 'Stage 3 edits did not match the files', { problem: diagnosis.problem, edit_errors: res.errors.slice(0, 5) });
      }
      messages3.push({ role: 'assistant', content: stage3Content }, { role: 'user', content: `These edits could not be applied — nothing was changed:\n${res.errors.join('\n')}\n\nReturn corrected edits for the whole fix (old_str must be verbatim, unique, without line-number prefixes).` });
      continue;
    }
    // Legacy path: the model answered with a unified diff anyway.
    const patch = extractPatch(stage3Content);
    if (patch.startsWith('diff --git') || patch.startsWith('---')) { patchToApply = patch; break; }
    if (attempt === 2) {
      await prComment(`❌ Stage 3: generated neither edits nor a diff — cannot apply\n\n**Cause:** ${diagnosis.problem}`);
      failWithStats('fail:ai_corrupt_patch', 'Stage 3 produced malformed output', { problem: diagnosis.problem, patch_head: String(stage3Content).slice(0, 100) });
    }
    messages3.push({ role: 'assistant', content: stage3Content }, { role: 'user', content: 'That was not valid JSON with an "edits" array. Reply with the JSON only.' });
  }
  if (applied) log('stage3', `applied ${applied.count} edit(s) to ${[...new Set(applied.files)].join(', ')}`);
  diagnosis.fix_approach = changeSpec; // use refined spec from stage 2
  } // end !AGENT_MODE || agentFellBack
}

// ── Apply patch (AI path only) ────────────────────────────────────────────────

if (patchToApply) {
  const patchFile = 'autofix-openrouter.patch';
  writeFileSync(patchFile, patchToApply + '\n');

  // Models miscount @@ headers: fall back to --recount, then GNU patch fuzz.
  const tryApply = [
    ['git', ['apply', '--whitespace=fix', patchFile]],
    ['git', ['apply', '--recount', '--whitespace=fix', patchFile]],
    ['patch', ['-p1', '--fuzz=3', '--no-backup-if-mismatch', '-i', patchFile]],
  ];
  try {
    let lastErr;
    for (const [cmd, args] of tryApply) {
      try { execFileSync(cmd, args, { stdio: 'pipe' }); lastErr = null; log('apply', `applied with ${cmd} ${args.slice(0, 2).join(' ')}`); break; }
      catch (err) { lastErr = err; sh('git checkout -- . 2>/dev/null || true'); }
    }
    if (lastErr) throw lastErr;
  } catch (e) {
    unlinkSync(patchFile);
    await prComment(`❌ Patch did not apply cleanly\n\n**Cause:** ${diagnosis.problem}\n\n\`\`\`\n${e.message.slice(0, 300)}\n\`\`\``);
    failWithStats('fail:ai_corrupt_patch', 'Patch did not apply cleanly', {
      problem: diagnosis.problem,
      git_error: e.message.slice(0, 200),
    });
  }
  unlinkSync(patchFile);
}

// ── Verify: run tests ─────────────────────────────────────────────────────────
// Skip for conflict resolution — push fix PR and let CI report failures.
// The loop: conflict resolved → fix PR → CI fails → fixer picks up next iteration.

// Agent mode: the agent already ran the failing tests; the full suite is judged by the
// fix PR's own CI (a full local `npm test` mostly flagged unrelated failures — issue #21).
if (diagnosis.agent) {
  log('verify', 'agent mode — skipping local full test run; the fix PR CI verifies');
} else if (!preStageDiagnosis?.category.startsWith('success:pre_a')) {
  await prComment('🧪 Patch applied — running tests…');
  try {
    sh('npm test');
  } catch (e) {
    sh('git checkout -- .');
    sh('git clean -fd');
    await prComment(`❌ Tests still fail after patch\n\n**Cause:** ${diagnosis.problem}\n\nReverted. Needs human review.\n\n\`\`\`\n${e.message.slice(0, 300)}\n\`\`\``);
    failWithStats('fail:ai_tests_fail', 'Patch applied but tests still fail', {
      problem: diagnosis.problem,
      test_error: e.message.slice(0, 300),
    });
  }
}

// ── Create new fix branch + PR (never push to original branch) ───────────────

const ts = Math.floor(Date.now() / 1000);
const safeBranch = (ORIGINAL_BRANCH || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
const fixBranch = `fix/ci-${safeBranch}-${ts}`;
const fixStrategy = preStageDiagnosis
  ? preStageDiagnosis.category
  : diagnosis.agent ? `agent (opencode, ladder/${LADDER_MODEL})`
  : `ai (${Object.keys(_usage.by_model).join(', ') || STAGE1_MODEL}, $${_usage.cost_usd.toFixed(5)})`;

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');

// Deterministic gate on what actually changed (git, not the model's word). Pre-stage
// merges/permission patches are exempt — their diff is main's, not an AI fix.
if (!preStageDiagnosis) {
  const gate = checkFixDiff(sh('git diff --cached --no-color'), { failedLog: failedLogRaw });
  log('gate', `fix diff: ${gate.files} file(s), ${gate.lines} line(s) — ${gate.ok ? 'ok' : gate.reasons.join('; ')}`);
  if (!gate.ok) {
    sh('git reset -q');
    await prComment(`❌ Fix rejected by the diff gate — no PR created\n\n**Cause:** ${diagnosis.problem}\n\n${gate.reasons.map(r => `- ${r}`).join('\n')}`);
    failWithStats('fail:diff_rejected', gate.reasons.join('; ').slice(0, 300), {
      problem: diagnosis.problem,
      gate_reasons: gate.reasons.slice(0, 10),
      // AC-44: which rule fired, on which paths — not only a human-readable sentence.
      rule_id: gate.violations[0].rule_id,
      gate_violations: gate.violations.slice(0, 10),
      agent: !!diagnosis.agent,
    });
  }
}
// Pre-stage A (conflict resolution or clean merge) may have already committed.
// Skip the commit if nothing is staged — avoids "nothing to commit" crash.
const fixStagedSomething = Boolean(sh('git status --porcelain').trim());
if (fixStagedSomething) {
  sh(`git -c core.hooksPath=/dev/null commit --no-verify -m "fix: auto-fix CI failure [autofix]

Diagnosis: ${diagnosis.problem.slice(0, 120).replace(/"/g, "'")}
Strategy: ${fixStrategy}"
`);
}
// What the FIX commit actually contains, read from git rather than from the model's word —
// the same determinism the diff gate uses.
const fixCommitSha = sh('git rev-parse HEAD').trim();
const fixPaths = sh(`git show --name-only --format= ${fixCommitSha}`).split('\n').map(s => s.trim()).filter(Boolean);
log('gate', `fix commit ${fixCommitSha.slice(0, 8)}: ${fixPaths.length} path(s)`);

sh(`git checkout -b ${fixBranch}`);

const prTitle = `fix: auto-fix CI failure in ${ORIGINAL_BRANCH || safeBranch}`;
const prBody = [
  `🤖 Automatically generated fix for CI failure in #${PR_NUMBER}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  '',
  `**Fix:** ${diagnosis.fix_approach}`,
  '',
  `**Strategy:** \`${fixStrategy}\``,
  '',
  `---`,
  `<!-- ci-fixer-original-pr: ${PR_NUMBER} -->`,
].join('\n');

writeFileSync('pr-body.txt', prBody);
let newPRUrl = null;
let newPRNumber = null;

// ── Publish sequence — every mutation re-checks live PR state ───────────────
// Order matters for recoverability: the replacement PR exists BEFORE anything
// is closed, so an abort at a later step leaves a reviewable fix behind.
// Each step is individually tolerant of its own API failure (as before) — the
// guard decides whether the step may run at all, not whether it succeeds.
const publishSteps = [
  { where: 'before push', run: () => {
    sh(`git -c core.hooksPath=/dev/null push --no-verify origin ${fixBranch}`);
    log('publish', `pushed fix branch: ${fixBranch}`);
  } },
  { where: 'before publish', run: () => {
    try {
      newPRUrl = sh(
        `gh pr create --repo "${REPO}" --base "${BASE_BRANCH}" --head "${fixBranch}" --title "${prTitle}" --body-file pr-body.txt`
      ).trim();
    } finally {
      unlinkSync('pr-body.txt');
    }
    newPRNumber = newPRUrl.match(/\/pull\/(\d+)$/)?.[1] || '?';
    log('publish', `created new PR #${newPRNumber}: ${newPRUrl}`);
  } },
  { where: 'before stale-fix cleanup', run: () => {
    try {
      const safeBranchForClose = (ORIGINAL_BRANCH || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
      const stalePRs = JSON.parse(
        sh(`gh pr list -R "${REPO}" --json number,headRefName --state open`)
      ).filter(pr =>
        pr.headRefName.startsWith(`fix/ci-${safeBranchForClose}-`) &&
        String(pr.number) !== String(newPRNumber)
      );
      for (const stale of stalePRs) {
        sh(`gh pr close ${stale.number} -R "${REPO}" --comment "♻️ Superseded by #${newPRNumber}: ${newPRUrl}"`);
        log('publish', `closed stale fix PR #${stale.number} (superseded by #${newPRNumber})`);
      }
    } catch (e) {
      log('publish', `could not close stale fix PRs: ${e.message.slice(0, 80)}`);
    }
  } },
  { where: 'before auto-merge', run: () => {
    try {
      // Locked to the pushed head: an out-of-date fix branch then physically
      // cannot merge (the old plain --auto merged whatever was green later).
      const headSha = sh('git rev-parse HEAD').trim();
      sh(`gh pr merge --auto --squash "${newPRNumber}" -R "${REPO}" --match-head-commit "${headSha}"`);
      log('publish', `auto-merge enabled on PR #${newPRNumber} (locked to ${headSha.slice(0, 7)})`);
    } catch (e) {
      log('publish', `auto-merge not available (${e.message.slice(0, 80)}) — PR will need manual merge`);
    }
  } },
  { where: 'before closing original', run: () => {
    try {
      sh(`gh pr close ${PR_NUMBER} -R "${REPO}" --comment "🤖 Superseded by #${newPRNumber}: ${newPRUrl} (pending CI + auto-merge)."`);
      log('publish', `closed original PR #${PR_NUMBER}`);
    } catch (e) {
      log('publish', `could not close original PR: ${e.message.slice(0, 80)}`);
    }
  } },
];

// BATCH_MODE has no live PR (it fixes stale branches), so it keeps the old
// straight-line behaviour; a live run re-verifies GitHub before every step.
const publishResult = prGuard
  ? await runGuardedSequence({ guard: prGuard, steps: publishSteps })
  : { aborted: false, at: null, state: null, reason: null };

if (publishResult.aborted) {
  if (existsSync('pr-body.txt')) unlinkSync('pr-body.txt');
  if (newPRUrl) {
    await prComment(
      `🛑 Stopped at "${publishResult.at}": ${publishResult.reason}.\n` +
      `The replacement PR ${newPRUrl} was already created — review and merge it manually; ` +
      `nothing was merged or closed automatically after the guard stopped.`
    );
  }
  abortOnGuard({ state: publishResult.state, reason: publishResult.reason, where: publishResult.at });
}

await prComment([
  `✅ Fix PR created: ${newPRUrl}`,
  '',
  `**Root cause:** ${diagnosis.problem}`,
  `**Fix:** ${diagnosis.fix_approach}`,
  `**Strategy:** \`${fixStrategy}\``,
  '',
  `PR #${newPRNumber} will auto-merge when CI passes.`,
].join('\n'));

// ── Write success stats ───────────────────────────────────────────────────────
writeStats(preStageDiagnosis ? preStageDiagnosis.category : diagnosis.agent ? 'success:agent' : 'success:ai', {
  problem: diagnosis.problem,
  fix: diagnosis.fix_approach,
  fix_branch: fixBranch,
  fix_pr: newPRNumber,
  strategy: fixStrategy,
  // ── AC-44, filled from the run itself (R6/R3) ──
  // The patch gets ITS OWN slot: `tool.commit` answers "which build of pr-autofix ran" and is
  // derived from the pinned env inside writeStats — this call site must not (and can no longer)
  // put the CONSUMER's fix commit there. patch.commit names what THIS run produced in the
  // repository it fixed; patch_source says why patch_refs is what it is.
  patch_commit: fixCommitSha,
  patch_source: fixStagedSomething ? 'applied' : 'none_required',
  attempt_count: Number(process.env.AUTOFIX_ATTEMPT) || fixAttempts,
  // A run that committed nothing gets NO patch ref — and says why (`none_required`), so a repeat
  // that changed nothing is distinguishable from a writer that filled nothing in. Recording the
  // pre-existing HEAD as a "fix commit" would be a fabricated provenance.
  patch_refs: fixStagedSomething ? [`commit:${fixCommitSha}`] : [],
  patch_refs_source: fixStagedSomething ? 'applied' : 'none_required',
  included_paths: fixStagedSomething ? fixPaths : [],
  omitted_paths: receiptMeta.omitted_paths || [],
  prompt_included_paths: receiptMeta.included_paths || [],
  budget: {
    diff_tokens: DIFF_TOKEN_BUDGET, diff_tokens_used: receiptMeta.tokens_used || 0,
    log_tokens: LOG_TOKEN_BUDGET, log_tokens_used: logTokensUsed,
    max_files: GATE_MAX_FILES, max_lines: GATE_MAX_LINES,
  },
});

console.log(`[autofix] fix PR #${newPRNumber} created (strategy: ${fixStrategy})`);

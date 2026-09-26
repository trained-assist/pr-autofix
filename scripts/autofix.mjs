#!/usr/bin/env node
// CI auto-fix pipeline — three layers:
//
//   Pre-stage (deterministic, no AI):
//     A. Out-of-date branch  → git merge origin/main
//     B. Missing permissions → patch workflow YAML
//     C. Cloudflare DO conflict → bail with precise diagnosis
//
//   AI stages (OpenRouter free models, only if pre-stage didn't apply):
//     Stage 1 (deepseek-v4-flash:free)    — diagnose: root cause + files to examine
//     Stage 2 (nemotron-3-super-120b:free) — contextualize: read real files, describe changes
//     Stage 3 (nemotron-3-ultra-550b:free) — patch: write the unified diff
//
// On success: creates a new fix/ci-* branch + PR (never pushes to original branch).
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
// Stage 1/2/3 (AI)      — OpenRouter free models.
//
// ── Stats (category taxonomy) ──────────────────────────────────────────────────
// Every run writes ci-fixer-stats.json + appends to $GITHUB_STEP_SUMMARY.
// Categories (used to decide when to escalate to a paid-model second pass):
//
//   success:pre_a_merge              branch was behind → git merge fixed it
//   success:pre_a_conflict_resolved  merge had conflicts → AI resolved them using PR purpose
//   success:pre_b_permissions        job lacked permissions → workflow YAML patched
//   success:ai                       3-stage free-model pipeline fixed it
//
//   fail:stage0_ambiguous       PR purpose unclear — skipping to avoid blind fix
//   fail:cloudflare_do          Cloudflare DO migration conflict (needs human)
//   fail:merge_conflict         git merge had conflicts and AI could not resolve them
//   fail:ai_conflict_resolution AI tried to resolve conflicts but failed/left markers
//   fail:permissions_no_workflow permission error but no patchable workflow found
//   fail:race_pr_closed         PR was already closed/merged before we started
//   fail:ai_no_diagnose         Stage 1 could not identify root cause
//   fail:ai_low_confidence      Stage 1 diagnosed but confidence too low to patch
//   fail:ai_cannot_fix          Stage 3 returned CANNOT_FIX        ← paid-tier candidate
//   fail:ai_corrupt_patch       Stage 3 produced malformed diff     ← paid-tier candidate
//   fail:ai_tests_fail          patch applied but tests still fail  ← paid-tier candidate
//   fail:ai_model_error         OpenRouter API error (network/quota/model gone)
//   fail:other                  unexpected error
//
// ── Batch mode ──────────────────────────────────────────────────────────────────
// Set RUN_ID=0 (or BATCH_MODE=true) to run without a CI log reference.
// In batch mode the script skips the CI log fetch and always tries pre-stage A
// (merge + AI conflict resolution). Use batch-fix-prs.yml workflow to trigger
// multiple PRs at once.

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const LOG_CHAR_LIMIT = 12000;
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

// Free-tier model ladder — bench-validated 2026-09-26 (500 rows, 10 diffs × 5
// runs × 10 models, see bench-cicd/bench-ext-summary.json). Ordered by
// availability × recall. The old chain (deepseek-v3-0324 / gemma-3-12b /
// llama-3.1-8b / mistral-7b) and old STAGE1 (deepseek-v4-flash-0731) are gone
// from the live OpenRouter catalog — replaced by the survivors below.
const FREE_MODEL_LADDER = [
  'nvidia/nemotron-3-super-120b-a12b:free',        // 84% avail, recall 0.79, 4.6s
  'inclusionai/ling-3.0-flash-fin:free',           // 72% avail, recall 0.92, 0 FP, 2.5s
  'inclusionai/ling-3.0-flash-sante:free',         // 58% avail, recall 0.72, 3.2s
  'nvidia/nemotron-3-ultra-550b-a55b:free',        // 52% avail, recall 1.0, 0 FP, 13s
  'cohere/north-mini-code:free',                   // 50% avail, recall 0.88, 0 FP
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', // 46% avail, recall 0.74
  'poolside/laguna-xs-2.1:free',                   // 46% avail, recall 1.0 (rate-limited)
  'dots-studio/dots-3-note-preview:free',          // 18% avail, recall 1.0
];
// Primary model (issue #7): a cheap PAID model is tried first on every stage.
// Inputs are compressed (see compressDiff), so a whole run costs well under a
// cent, and a paid model has none of the free-tier 429/availability roulette.
// deepseek-v4-flash-0731: $0.021/M in, $0.32/M out, 1.3M ctx, JSON mode, p50 ~1.5s.
// The free ladder stays right behind it as fallback. AUTOFIX_PRIMARY_MODEL=free
// switches back to free-first (stage models below), any other id overrides;
// unset/empty (e.g. an undefined repo var) keeps the default.
const PRIMARY_MODEL = (m => !m ? 'deepseek/deepseek-v4-flash-0731' : m === 'free' ? '' : m)(process.env.AUTOFIX_PRIMARY_MODEL);
// Free stage assignment (bench per role), used when PRIMARY_MODEL is empty:
// diagnose = best recall/FP (ling-fin), contextualize = most reliable (super),
// patch = perfect recall (ultra).
const STAGE1_MODEL = PRIMARY_MODEL || 'inclusionai/ling-3.0-flash-fin:free';
const STAGE2_MODEL = PRIMARY_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free';
const STAGE3_MODEL = PRIMARY_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free';
const STAGE0_MODEL_CHAIN = FREE_MODEL_LADDER; // first success wins (conflict resolution)
// Cheap paid models — last resort after all free options exhausted.
// (google/gemini-flash-1.5-8b is gone from the OpenRouter catalog, 2026-09-26.)
const CHEAP_PAID_FALLBACK = [
  'deepseek/deepseek-v4.1-flash',  // $0.035/M in — same family as primary, different endpoint
  'deepseek/deepseek-chat',        // DeepSeek V3 paid, very capable
  'openai/gpt-4o-mini',            // $0.15/M — reliable, different vendor
];
// Paid ids get the long timeout and are counted in the per-run cost summary.
const isPaidModel = m => m === PRIMARY_MODEL || CHEAP_PAID_FALLBACK.includes(m);

// OpenCode Go gateway — primary provider when OPENCODE_GO_API_KEY is set.
// Subscription-backed, so no free-tier 429 roulette: tried FIRST on every
// stage call; the OpenRouter free ladder + paid fallback stay behind it.
// Rungs are tagged `go:<model>` so callModel knows which endpoint to hit.
// Order: bench 2026-09-26 (bench-cicd, BENCH_PROVIDER=go, 10 diffs × 3 runs).
const GO_BASE = 'https://opencode.ai/zen/go/v1/chat/completions';
const GO_PREFIX = 'go:';
const GO_SESSION = `pr-autofix-${process.env.GITHUB_RUN_ID || 'local'}-${Date.now()}`;
const GO_MODEL_LADDER = [
  'go:deepseek-v4-flash',        // 97% avail, recall 0.83, 1 FP, p50 1.6s
  'go:longcat-2.5-preview-free', // 100% avail, recall 0.90, 0 FP, p50 7.0s
  'go:qwen3.8-flash',            // 97% avail, recall 0.86, 1 FP, p50 9.0s
  'go:mimo-v2.6-flash',          // 87% avail, recall 0.88, 3 FP
  'go:deepseek-flash',           // 77% avail, recall 0.87, 2 FP, p50 2.8s
  'go:glm-5.3-flash',            // 47% avail, recall 1.00, 0 FP
];

const STAGE0_MODEL = PRIMARY_MODEL || STAGE0_MODEL_CHAIN[0];
const STAGE0_FALLBACK_MODEL = STAGE0_MODEL_CHAIN[1]; // kept for compat, chain handles the rest

const PR_FIXER_PREFIX = 'pr-fixer:';

const {
  OPENROUTER_API_KEY,
  OPENCODE_GO_API_KEY,
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
  const stats = {
    ts: new Date().toISOString(),
    repo: REPO || '',
    pr: PR_NUMBER || '',
    branch: ORIGINAL_BRANCH || '',
    run_id: RUN_ID || '',
    category,
    ...extra,
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

async function callModel(model, messages, json = false) {
  const tryModel = async (m, wantJson) => {
    const isGo = m.startsWith(GO_PREFIX);
    const res = await fetch(isGo ? GO_BASE : 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${isGo ? GO_KEY : OR_KEY}`,
        'Content-Type': 'application/json',
        // The Go gateway 400s (MissingSessionID) without a session header.
        ...(isGo ? { 'x-opencode-session': GO_SESSION } : {}),
      },
      body: JSON.stringify({
        model: isGo ? m.slice(GO_PREFIX.length) : m,
        messages,
        temperature: 0,
        ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
      }),
      // Go p90 latency is 3–26s (bench) — the 20s free-tier cut would drop
      // healthy answers from qwen/glm, so Go rungs get the paid-tier budget.
      signal: AbortSignal.timeout(isGo || isPaidModel(m) ? 60_000 : 20_000),
    });
    if (!res.ok) {
      const body = await res.text();
      // Free models reject response_format with a 400 whose body says things
      // like `does not support feature: structured-outputs` — it never mentions
      // "response_format", so this used to be gated on a regex that never
      // matched and the model was skipped instead of retried prompt-only.
      // Any 400 while wantJson → retry the SAME model once without the
      // constraint. Recursion is bounded: the retry passes wantJson=false, so a
      // second 400 falls through to the throw below.
      if (json && res.status === 400 && wantJson) {
        log('model', `${m} rejected response_format (400) — retrying prompt-only`);
        return tryModel(m, false);
      }
      throw Object.assign(new Error(`${isGo ? 'OpenCode Go' : 'OpenRouter'} HTTP ${res.status}: ${body}`), { status: res.status, isGo });
    }
    const data = await res.json();
    recordUsage(m, data?.usage);
    return data?.choices?.[0]?.message?.content?.trim() || '';
  };

  // Every stage call fails over: primary model → rest of the ladder → any
  // remaining free models OpenRouter still lists → cheap paid last resort.
  // (Previously only STAGE0 had a chain; STAGE1/2/3 died on a single 429.)
  // The cheap paid PRIMARY_MODEL leads; the free ladder is its fallback.
  const isPrimary = !!PRIMARY_MODEL && model === PRIMARY_MODEL;
  const ladderStart = isPrimary ? 0 : FREE_MODEL_LADDER.indexOf(model);
  const orChain = !OR_KEY && GO_KEY ? []
    : ladderStart >= 0
      ? [...(isPrimary ? [PRIMARY_MODEL] : []), ...FREE_MODEL_LADDER.slice(ladderStart), ...(await discoverFreeModels()), ...CHEAP_PAID_FALLBACK]
      : [model];
  // Go rungs go first whenever the Go key is present — for every stage.
  const chain = [...new Set([...(goAvailable() ? GO_MODEL_LADDER : []), ...orChain])];
  if (!chain.length) throw new Error('no LLM provider configured (OPENCODE_GO_API_KEY / OPENROUTER_API_KEY)');

  let lastErr;
  let reachedPaid = false;
  for (const m of chain) {
    if (m.startsWith(GO_PREFIX) && !goAvailable()) continue; // Go key rejected earlier this run
    const isPaid = CHEAP_PAID_FALLBACK.includes(m);
    try {
      if (m !== model) {
        if (isPaid && !reachedPaid) {
          reachedPaid = true;
          log('model', 'all free models exhausted — falling back to cheap paid models');
        }
        log('model', `trying ${m}${isPaid ? ' (paid)' : ''}`);
      }
      const result = await tryModel(m, json);
      if (!result) {
        lastErr = new Error(`${m} returned empty response`);
        log('model', `${m} empty — trying next`);
        continue;
      }
      // When JSON was requested, "non-empty" is NOT success: the bench showed
      // no_json was the dominant failure (227/500 rows), and a prose answer
      // used to pass this check only to blow up in the caller's parseJSON with
      // no failover — the stage died on a model that had simply answered
      // talkatively. Validate here so the ladder advances instead.
      if (json) {
        try {
          parseJSON(result);
        } catch (e) {
          lastErr = new Error(`${m} returned unparseable JSON: ${e.message}`);
          log('model', `${m} returned non-JSON — trying next`);
          continue;
        }
      }
      return result;
    } catch (e) {
      lastErr = e;
      // Default is "advance the ladder". The old list only tolerated
      // 400/403/404/429/503 — a 500/502/504 from an upstream provider (never
      // seen in the bench, common in prod) escaped the loop and killed the
      // whole stage on one model, which is exactly what the ladder exists to
      // prevent. Only auth/billing are fatal: retrying them across models
      // cannot help and just burns the chain.
      // A rejected Go key/subscription only disables the Go rungs — the
      // OpenRouter ladder behind them is an independent provider.
      if (e.isGo && [401, 402, 403].includes(e.status)) {
        _goDisabled = true;
        log('model', `OpenCode Go auth/billing failed (${e.status}) — skipping Go rungs, falling back to OpenRouter`);
        continue;
      }
      const fatal = [401, 402].includes(e.status);
      if (fatal) throw e;
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        log('model', `${m} timed out — trying next`);
      } else {
        log('model', `${m} failed (${e.status || e.name}) — trying next`);
      }
    }
  }
  throw lastErr;
}

// Per-run model usage — which model actually answered and what it cost.
// OpenRouter returns usage.cost (USD) in every response; Go is subscription.
const _usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, by_model: {} };
function recordUsage(m, u) {
  const e = (_usage.by_model[m] ||= { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 });
  const pt = u?.prompt_tokens || 0, ct = u?.completion_tokens || 0, c = Number(u?.cost) || 0;
  for (const t of [_usage, e]) { t.calls++; t.prompt_tokens += pt; t.completion_tokens += ct; t.cost_usd += c; }
  log('model', `${m} answered: ${pt} in / ${ct} out tokens${c ? `, $${c.toFixed(6)}` : ''}`);
}

// Mutable copies so the self-test can toggle providers without env juggling.
let OR_KEY = OPENROUTER_API_KEY || '';
let GO_KEY = OPENCODE_GO_API_KEY || '';
let _goDisabled = false;
function goAvailable() { return !!GO_KEY && !_goDisabled; }

// Cached list of free models discovered from OpenRouter /models (fetched once per run)
let _discoveredFreeModels = null;
async function discoverFreeModels() {
  if (_discoveredFreeModels !== null) return _discoveredFreeModels;
  if (!OR_KEY) return (_discoveredFreeModels = []);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${OR_KEY}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { _discoveredFreeModels = []; return []; }
    const { data = [] } = await res.json();
    const known = new Set(FREE_MODEL_LADDER);
    _discoveredFreeModels = data
      .filter(m => m.id.endsWith(':free') && !known.has(m.id))
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .map(m => m.id);
    log('model', `discovered ${_discoveredFreeModels.length} additional free models from OpenRouter`);
  } catch (e) {
    log('model', `free model discovery failed: ${e.message.slice(0, 60)} — skipping`);
    _discoveredFreeModels = [];
  }
  return _discoveredFreeModels;
}

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
function compressDiff(diff, budgetTokens = DIFF_TOKEN_BUDGET, failedLogText = '') {
  const files = parseDiff(diff);
  if (!files.length) return String(diff || '').slice(0, budgetTokens * 4);
  const omitted = [];
  const cited = f => failedLogText && (failedLogText.includes(f.path) || failedLogText.includes(path.basename(f.path)));
  const useful = [];
  for (const f of files) {
    if (NOISE_FILE_RE.test(f.path) || f.binary) { omitted.push(`${f.path} (lock/generated/binary)`); continue; }
    if (f.deleted) { omitted.push(`${f.path} (deleted)`); continue; }
    const hunks = f.hunks.filter(h => h.lines.some(l => l[0] === '+'));
    const dropped = f.hunks.length - hunks.length;
    if (!hunks.length) { if (f.hunks.length) omitted.push(`${f.path} (deletion-only)`); continue; }
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
    if (used + t <= avail) { parts.push(r); used += t; return; }
    const left = avail - used;
    if (left >= 200) {
      const cut = r.slice(0, left * 4 - 80);
      const kept = cut.slice(0, cut.lastIndexOf('\n'));
      const more = r.slice(kept.length).split('\n').filter(l => l.startsWith('+')).length;
      parts.push(`${kept}\n# … ${more} more added line(s) in ${useful[i].path} truncated (budget)`);
      used = avail;
      return;
    }
    rest.push(useful[i].path);
  });
  if (rest.length) omitted.push(...rest.map(p => `${p} (over budget)`));
  if (omitted.length) parts.push(`# Compressed diff — not shown: ${omitted.join(', ')}.\n# Ask for a file via files_to_examine if you need it.`);
  return parts.join('\n');
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

// Stage 2 contract: the model names files it could not see enough of.
function parseMissingContext(text) {
  return [...String(text || '').matchAll(/MISSING_CONTEXT:\s*`?([\w./@-]+\.[\w]+)`?/g)].map(m => m[1]);
}

// ── Conflict resolution with AI ──────────────────────────────────────────────
// Called by tryFixOutOfDate when git merge has conflicts.
// Uses the PR's purpose (from Stage 0) to guide resolution — the "why" makes
// per-block decisions more accurate than resolving with no context.
async function resolveConflictsWithAI(conflictedFiles, prPurposeArg) {
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
Return ONLY the resolved code — no conflict markers, no explanations, no markdown fences.`,
            },
            {
              role: 'user',
              content: `File: ${filePath}\n\n${blocks[bi].full}`,
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
        return { ok: false, reason: `AI resolution of ${filePath} introduced syntax error: ${syntaxErr.message.slice(0, 120)}` };
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
async function tryFixOutOfDate(failedLog, prPurposeArg) {
  const logMatches = /not up to date with the base branch|head branch.*behind/i.test(failedLog);
  if (!BATCH_MODE && !logMatches) return null;

  log('pre-A', `${BATCH_MODE ? 'batch mode' : 'detected "not up to date"'} — merging origin/${BASE_BRANCH}...`);
  try {
    sh(`git fetch origin ${BASE_BRANCH} --quiet`);
    sh(`git merge origin/${BASE_BRANCH} --no-edit -m "merge: sync with ${BASE_BRANCH} before merge"`);
    log('pre-A', 'merge successful — no code changes needed');
    return {
      ok: true,
      category: 'success:pre_a_merge',
      problem: `Branch was behind \`${BASE_BRANCH}\` — merged to bring it up to date`,
      fix_approach: `Merged \`origin/${BASE_BRANCH}\` into the branch. No source code changes.`,
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

    const resolveResult = await resolveConflictsWithAI(conflictedFiles, effectivePurpose);
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

  // Ladder integrity: every rung is a :free model, stages are on the ladder.
  check('ladder non-empty', FREE_MODEL_LADDER.length >= 5);
  check('ladder all :free', FREE_MODEL_LADDER.every(m => m.endsWith(':free')));
  check('ladder unique', new Set(FREE_MODEL_LADDER).size === FREE_MODEL_LADDER.length);
  check('paid fallback non-empty', CHEAP_PAID_FALLBACK.length >= 1);

  // callModel failover against a scripted mock of the OpenRouter API.
  // The mock keys off the ACTUAL ladder entries (callModel builds the chain from
  // the ladder when the model is on it), so the failover path is the real one.
  const [R0, R1] = [FREE_MODEL_LADDER[0], FREE_MODEL_LADDER[1]];
  const originalFetch = globalThis.fetch;
  const seq = [];
  const rfRejectedBody = JSON.stringify({ error: { message: 'Provider returned error', code: 400, metadata: { raw: '{"code":400,"reason":"INVALID_REQUEST_BODY","message":"model: inclusionai/ling-3.0-flash-fin does not support feature: structured-outputs"}' } } });
  const proseBody = JSON.stringify({ choices: [{ message: { content: 'I cannot do that, but here is a thought: the bug is obvious.' } }] });
  const jsonBody = JSON.stringify({ choices: [{ message: { content: '{"problem":"x","files_to_examine":[],"fix_approach":"y","confidence":"high"}' } }] });
  let MODE = 'rf-reject';
  globalThis.fetch = async (url, opts) => {
    const m = JSON.parse(opts.body).model;
    const rf = !!JSON.parse(opts.body).response_format;
    if (m === R0) {
      seq.push('R0');
      if (MODE === 'rf-reject' && rf) return { ok: false, status: 400, text: async () => rfRejectedBody };
      if (MODE === 'prose') return { ok: true, status: 200, json: async () => JSON.parse(proseBody) };
      if (MODE === 'http500') return { ok: false, status: 500, text: async () => 'upstream error' };
      if (MODE === 'auth401') return { ok: false, status: 401, text: async () => 'bad key' };
      // default / rf-reject prompt-only retry: R0 answers JSON fine.
      return { ok: true, status: 200, json: async () => JSON.parse(jsonBody) };
    }
    seq.push('R1');
    return { ok: true, status: 200, json: async () => JSON.parse(jsonBody) };
  };
  _discoveredFreeModels = [];
  // OpenRouter-only for tests 1–4, independent of whatever keys the host has.
  OR_KEY = 'or-test'; GO_KEY = '';

  // 1. response_format 400 → retries the SAME model prompt-only and succeeds.
  //    Regression: the old regex `/response_format|json_object/` never matched
  //    the real body ("does not support feature: structured-outputs"), so R0 was
  //    skipped to the next rung instead of retried — STAGE1's best model was
  //    silently dropped on every run. Now the retry must land on R0, not R1.
  seq.length = 0;
  MODE = 'rf-reject';
  try {
    const out = await callModel(R0, [{ role: 'user', content: 'hi' }], true);
    check('rf-400 retried prompt-only and succeeded', out.includes('"problem"') && !seq.includes('R1'));
  } catch (e) { check('rf-400 retried prompt-only and succeeded', false, e.message); }

  // 2. json=true + prose answer → advances to the next rung instead of returning prose.
  seq.length = 0;
  MODE = 'prose';
  try {
    const out = await callModel(R0, [{ role: 'user', content: 'hi' }], true);
    check('prose advanced to next rung', seq.includes('R1') && out.includes('"problem"'));
  } catch (e) { check('prose advanced to next rung', false, e.message); }

  // 3. HTTP 500 (was NOT in the old retryable list → killed the whole stage) → advances.
  seq.length = 0;
  MODE = 'http500';
  try {
    const out = await callModel(R0, [{ role: 'user', content: 'hi' }], true);
    check('http500 advanced to next rung', seq.includes('R1') && out.includes('"problem"'));
  } catch (e) { check('http500 advanced to next rung', false, e.message); }

  // 4. HTTP 401 is fatal — retrying across models can't help.
  seq.length = 0;
  MODE = 'auth401';
  try {
    await callModel(R0, [{ role: 'user', content: 'hi' }], true);
    check('auth401 is fatal', false, 'should have thrown');
  } catch (e) {
    check('auth401 is fatal', String(e.status) === '401' && !seq.includes('R1'));
  }

  // ── OpenCode Go provider ──
  check('go ladder non-empty', GO_MODEL_LADDER.length >= 3);
  check('go ladder all tagged', GO_MODEL_LADDER.every(m => m.startsWith(GO_PREFIX)));
  const goSeq = [];
  let GO_MODE = 'ok';
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    const auth = opts.headers.Authorization;
    if (url === GO_BASE) {
      if (!opts.headers['x-opencode-session']) return { ok: false, status: 400, text: async () => '{"error":{"type":"MissingSessionID"}}' };
      goSeq.push(`go:${b.model}|${auth}`);
      if (GO_MODE === 'auth401') return { ok: false, status: 401, text: async () => 'invalid key' };
      if (GO_MODE === 'first429' && b.model === GO_MODEL_LADDER[0].slice(GO_PREFIX.length)) return { ok: false, status: 429, text: async () => 'rate' };
      return { ok: true, status: 200, json: async () => JSON.parse(jsonBody) };
    }
    goSeq.push(`or:${b.model}|${auth}`);
    return { ok: true, status: 200, json: async () => JSON.parse(jsonBody) };
  };
  OR_KEY = 'or-test'; GO_KEY = 'go-test';

  // 5. Go key set → Go rung is hit FIRST, with the Go key, model id untagged.
  goSeq.length = 0; GO_MODE = 'ok'; _goDisabled = false;
  try {
    await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
    check('go tried first with go key', goSeq[0] === `${GO_MODEL_LADDER[0]}|Bearer go-test` && goSeq.length === 1, goSeq.join(','));
  } catch (e) { check('go tried first with go key', false, e.message); }

  // 6. Go 429 on first rung → next Go rung (not straight to OpenRouter).
  goSeq.length = 0; GO_MODE = 'first429'; _goDisabled = false;
  try {
    await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
    check('go 429 advances within go', goSeq[1]?.startsWith(GO_MODEL_LADDER[1] + '|'), goSeq.join(','));
  } catch (e) { check('go 429 advances within go', false, e.message); }

  // 7. Go 401 → NOT fatal: Go rungs skipped, OpenRouter ladder answers with the OR key.
  goSeq.length = 0; GO_MODE = 'auth401'; _goDisabled = false;
  try {
    await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
    const goHits = goSeq.filter(x => x.startsWith('go:')).length;
    check('go 401 falls back to openrouter', goHits === 1 && goSeq[1] === `or:${STAGE1_MODEL}|Bearer or-test`, goSeq.join(','));
  } catch (e) { check('go 401 falls back to openrouter', false, e.message); }

  // 8. Go-only config (no OpenRouter key) still works.
  goSeq.length = 0; GO_MODE = 'ok'; _goDisabled = false; OR_KEY = '';
  try {
    await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
    check('go-only config works', goSeq.length === 1 && goSeq[0].startsWith(GO_PREFIX));
  } catch (e) { check('go-only config works', false, e.message); }

  // ── Primary cheap paid model (issue #7) ──
  // Primary leads, the free ladder is its fallback, paid last-resort behind that.
  globalThis.fetch = async (url, opts) => {
    const b = JSON.parse(opts.body);
    goSeq.push(b.model);
    if (b.model === PRIMARY_MODEL && GO_MODE === 'primary500') return { ok: false, status: 500, text: async () => 'upstream' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.0000052 } }) };
  };
  OR_KEY = 'or-test'; GO_KEY = ''; _goDisabled = false;
  if (!PRIMARY_MODEL) {
    check('free-first mode: stages on free ladder', [STAGE1_MODEL, STAGE2_MODEL, STAGE3_MODEL].every(m => FREE_MODEL_LADDER.includes(m)));
  } else {
    check('primary is a paid, non-free model', !!PRIMARY_MODEL && !PRIMARY_MODEL.endsWith(':free') && isPaidModel(PRIMARY_MODEL));
    check('stages 0-3 use primary', [STAGE0_MODEL, STAGE1_MODEL, STAGE2_MODEL, STAGE3_MODEL].every(m => m === PRIMARY_MODEL));
    check('paid fallback has no retired ids', !CHEAP_PAID_FALLBACK.includes('google/gemini-flash-1.5-8b'));
    goSeq.length = 0; GO_MODE = 'ok';
    try {
      await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
      check('primary tried first', goSeq.length === 1 && goSeq[0] === PRIMARY_MODEL, goSeq.join(','));
      check('usage recorded with cost', _usage.by_model[PRIMARY_MODEL]?.cost_usd > 0 && _usage.prompt_tokens >= 100);
    } catch (e) { check('primary tried first', false, e.message); }
    goSeq.length = 0; GO_MODE = 'primary500';
    try {
      await callModel(STAGE1_MODEL, [{ role: 'user', content: 'hi' }], true);
      check('primary failure falls back to free ladder', goSeq[0] === PRIMARY_MODEL && goSeq[1] === FREE_MODEL_LADDER[0], goSeq.join(','));
    } catch (e) { check('primary failure falls back to free ladder', false, e.message); }
  }

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

  globalThis.fetch = originalFetch;
  if (failed > 0) { console.error(`SELFTEST FAILED: ${failed} check(s)`); process.exit(1); }
  console.log('SELFTEST PASS');
  process.exit(0);
}

// ── Preflight ────────────────────────────────────────────────────────────────

if (!OPENROUTER_API_KEY && !OPENCODE_GO_API_KEY) failWithStats('fail:other', 'neither OPENCODE_GO_API_KEY nor OPENROUTER_API_KEY set');
log('model', `providers: ${OPENCODE_GO_API_KEY ? `OpenCode Go (${GO_MODEL_LADDER.length} rungs) → ` : ''}${OPENROUTER_API_KEY ? 'OpenRouter free ladder → paid' : '(no OpenRouter)'}`);
if (!REPO || !PR_NUMBER) failWithStats('fail:other', 'missing REPO/PR_NUMBER env');
if (!BATCH_MODE && !RUN_ID) failWithStats('fail:other', 'missing RUN_ID env (set RUN_ID=0 for batch/manual mode)');

// Configure git identity early — needed for merge commits (before tryFixOutOfDate)
try {
  sh('git config user.name "trained-assist-autofix"');
  sh('git config user.email "autofix@trained-assist.bot"');
} catch { /* non-fatal — will fail later if identity really needed */ }

// ── Race condition guard (skipped in batch mode) ─────────────────────────────
if (!BATCH_MODE) {
  try {
    const prViewRaw = sh(`gh pr view ${PR_NUMBER} -R ${REPO} --json state,statusCheckRollup`);
    const prInfo = JSON.parse(prViewRaw);
    if (prInfo.state !== 'OPEN') {
      writeStats('fail:race_pr_closed', { reason: `PR is already ${prInfo.state}` });
      log('guard', `PR #${PR_NUMBER} is already ${prInfo.state} — aborting`);
      process.exit(0); // not a real failure — nothing to do
    }
    const checks = prInfo.statusCheckRollup || [];
    if (checks.length > 0 && !checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')) {
      writeStats('fail:race_pr_closed', { reason: 'CI no longer shows failures' });
      log('guard', `PR #${PR_NUMBER} CI no longer shows failures — aborting`);
      process.exit(0);
    }
  } catch (e) {
    log('guard', `could not check PR state (${e.message}) — proceeding anyway`);
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
          const jobLog = sh(`gh api --allow-escape-sequences "repos/${REPO}/actions/jobs/${job.id}/logs"`).slice(-8000);
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

// prDiffRaw drives Stage 2 excerpts; prDiff is the structurally compressed
// version every prompt sees (issue #7 — no more blind 10k-char slice).
let prDiffRaw = '';
let prDiff = '';
try {
  sh(`git fetch origin ${BASE_BRANCH} --quiet`);
  prDiffRaw = sh(`git diff origin/${BASE_BRANCH}...HEAD`);
  prDiff = compressDiff(prDiffRaw, DIFF_TOKEN_BUDGET, failedLog);
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
if (checkCloudflareConflict(failedLog)) {
  await prComment('❌ Cannot auto-fix: Cloudflare Durable Objects migration conflict (code 10074)\n\nThe migration tag in `wrangler.toml` is out of sync with what Cloudflare has deployed. Patching this blindly would corrupt live DO state. Needs human review of the migration history.');
  failWithStats(
    'fail:cloudflare_do',
    'Cloudflare DO migration conflict (code 10074 or similar) — migration tag out of sync with deployed state',
    { hint: 'Check wrangler.toml migration history vs what Cloudflare has deployed. Code 10074 = class already has live instances that depend on a previous schema. Patching blindly would corrupt live DO state — needs human review.' }
  );
}

// Pre-stage A + B: deterministic fixes
let preStageDiagnosis = null;

const outOfDateResult = await tryFixOutOfDate(failedLog, prPurpose);
if (outOfDateResult) {
  if (!outOfDateResult.ok) {
    const icon = outOfDateResult.category === 'fail:ai_conflict_resolution' ? '🤖' : '❌';
    await prComment(`${icon} Could not fix: ${outOfDateResult.reason}\n\n\`\`\`\n${outOfDateResult.detail || ''}\n\`\`\``);
    failWithStats(outOfDateResult.category, outOfDateResult.reason, { detail: outOfDateResult.detail });
  }
  preStageDiagnosis = outOfDateResult;
}

if (!preStageDiagnosis) {
  const permResult = tryFixMissingPermissions(failedLog);
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

  // ── Stage 2: Gather context ────────────────────────────────────────────────
  const fileList = (diagnosis.files_to_examine || []).slice(0, MAX_FILES);
  const fileContents = [];
  const changedLines = changedLinesByFile(prDiffRaw);

  // Line-numbered excerpts around PR-changed and log-cited lines (small files
  // whole). full=true is the MISSING_CONTEXT retry: the plain capped file.
  const loadFile = (filePath, full = false) => {
    const content = readFileSafe(path.join(process.cwd(), filePath), full ? FILE_CHAR_LIMIT : 1_000_000);
    if (content === null) { log('stage2', `skipped ${filePath} (not found)`); return null; }
    const focus = new Set([...(changedLines.get(filePath) || []), ...logCitedLines(filePath, failedLog)]);
    const { text, excerpt } = full ? excerptFile(content, new Set(), Infinity) : excerptFile(content, focus);
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
        const full = missing.map(f => loadFile(f, true)).filter(Boolean);
        const others = fileContents.filter(b => !missing.some(f => b.startsWith(`=== ${f} `) || b.startsWith(`=== ${f}\n`)));
        if (full.length) {
          changeSpec = await callModel(STAGE2_MODEL, [
            { role: 'system', content: 'You are a code reviewer helping plan a minimal CI fix. Describe exactly what lines/functions need to change (file, function, what to add/remove/change). Plain English, no code. The files you asked for are now complete (up to a size cap). If something is still missing, say so explicitly instead of guessing.' },
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

  let stage3Content;
  try {
    stage3Content = await callModel(STAGE3_MODEL, [
      {
        role: 'system',
        content: `You are a CI auto-fix bot. Write a unified diff (git format, "diff --git a/... b/..." prefix) that fixes a CI failure.

Rules:
- Smallest possible change — no refactors, no unrelated edits
- Valid git diff format, applicable via "git apply"
- Wrap in a single \`\`\`diff code block
- The PR diff you see is compressed (trimmed context). If you lack the exact surrounding lines needed for an applicable patch, reply CANNOT_FIX: missing context <file/what> — do not invent context lines
- If you cannot produce a correct patch, reply exactly: CANNOT_FIX`,
      },
      {
        role: 'user',
        content: `Root cause:\n${diagnosis.problem}\n\nWhat to change:\n${changeSpec}\n\nCurrent PR diff (for context on what already changed):\n\`\`\`diff\n${prDiff}\n\`\`\`\n\nWrite the fix patch.`,
      },
    ]);
  } catch (e) {
    failWithStats('fail:ai_model_error', `Stage 3 model error: ${e.message.slice(0, 200)}`, { problem: diagnosis.problem });
  }

  if (!stage3Content || stage3Content.includes('CANNOT_FIX')) {
    const why = (stage3Content || '').match(/CANNOT_FIX:?\s*(.{0,300})/)?.[1]?.trim() || '';
    await prComment(`❌ Stage 3: model declined to generate a patch\n\n**Cause:** ${diagnosis.problem}${why ? `\n**Model says:** ${why}` : ''}\n\nThis likely requires a code change that needs human judgement.`);
    failWithStats('fail:ai_cannot_fix', `Stage 3 declined to produce a patch${why ? `: ${why}` : ''}`, {
      problem: diagnosis.problem,
      fix_approach: diagnosis.fix_approach,
    });
  }

  const patch = extractPatch(stage3Content);
  if (!patch.startsWith('diff --git') && !patch.startsWith('---')) {
    await prComment(`❌ Stage 3: generated a malformed diff — cannot apply\n\n**Cause:** ${diagnosis.problem}`);
    failWithStats('fail:ai_corrupt_patch', 'Stage 3 produced malformed diff', {
      problem: diagnosis.problem,
      patch_head: patch.slice(0, 100),
    });
  }

  patchToApply = patch;
  diagnosis.fix_approach = changeSpec; // use refined spec from stage 2
}

// ── Apply patch (AI path only) ────────────────────────────────────────────────

if (patchToApply) {
  const patchFile = 'autofix-openrouter.patch';
  writeFileSync(patchFile, patchToApply + '\n');

  try {
    execFileSync('git', ['apply', '--whitespace=fix', patchFile], { stdio: 'inherit' });
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

if (!preStageDiagnosis?.category.startsWith('success:pre_a')) {
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
  : `ai (${Object.keys(_usage.by_model).join(', ') || STAGE1_MODEL}, $${_usage.cost_usd.toFixed(5)})`;

sh('git config user.name "trained-assist-autofix"');
sh('git config user.email "autofix@trained-assist.bot"');
sh('git add -A');
// Pre-stage A (conflict resolution or clean merge) may have already committed.
// Skip the commit if nothing is staged — avoids "nothing to commit" crash.
if (sh('git status --porcelain').trim()) {
  sh(`git commit -m "fix: auto-fix CI failure [autofix]

Diagnosis: ${diagnosis.problem.slice(0, 120).replace(/"/g, "'")}
Strategy: ${fixStrategy}"
`);
}
sh(`git checkout -b ${fixBranch}`);
sh(`git push origin ${fixBranch}`);

log('publish', `pushed fix branch: ${fixBranch}`);

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
let newPRUrl;
try {
  newPRUrl = sh(
    `gh pr create --repo "${REPO}" --base "${BASE_BRANCH}" --head "${fixBranch}" --title "${prTitle}" --body-file pr-body.txt`
  ).trim();
} finally {
  unlinkSync('pr-body.txt');
}

const newPRNumber = newPRUrl.match(/\/pull\/(\d+)$/)?.[1] || '?';
log('publish', `created new PR #${newPRNumber}: ${newPRUrl}`);

// Close any stale fix/ci-* PRs for the same original branch (excluding the one just created)
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

try {
  sh(`gh pr merge --auto --squash "${newPRNumber}" -R "${REPO}"`);
  log('publish', `auto-merge enabled on PR #${newPRNumber}`);
} catch (e) {
  log('publish', `auto-merge not available (${e.message.slice(0, 80)}) — PR will need manual merge`);
}

// Close the original PR immediately — don't rely on webhook events from ci-fix-cleanup.yml
// which can be dropped by GitHub. The fix PR is now the source of truth.
try {
  sh(`gh pr close ${PR_NUMBER} -R "${REPO}" --comment "🤖 Superseded by #${newPRNumber}: ${newPRUrl} (pending CI + auto-merge)."`);
  log('publish', `closed original PR #${PR_NUMBER}`);
} catch (e) {
  log('publish', `could not close original PR: ${e.message.slice(0, 80)}`);
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
writeStats(preStageDiagnosis ? preStageDiagnosis.category : 'success:ai', {
  problem: diagnosis.problem,
  fix: diagnosis.fix_approach,
  fix_branch: fixBranch,
  fix_pr: newPRNumber,
  strategy: fixStrategy,
});

console.log(`[autofix] fix PR #${newPRNumber} created (strategy: ${fixStrategy})`);

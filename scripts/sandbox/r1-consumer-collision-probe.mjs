#!/usr/bin/env node
// R1 consumer-collision probe — installing the pinned tool must never change a consumer-owned
// `pr-autofix/` catalog, and it must actually install (pr-autofix#61, #67).
//
// Two forms of this defect class have shipped, and this probe is the one that must stay green
// across both:
//   #61 — delivery materialized INSIDE the consumer root (`actions/checkout … path: pr-autofix`,
//     then `mv`). Real actions/checkout clears a target that has no `.git` of its own
//     (prepareExistingDirectory → git-directory-helper.ts), so the consumer's file was gone and
//     autofix's `git add -A` staged its deletion.
//   #67 — the v1.7.9 form delivered outside the root with
//     `env: GITHUB_WORKSPACE: ${{ runner.temp }}` + an absolute `path:`, which the runner never
//     honours (NodeScriptActionHandler writes the runtime context over a step env): checkout saw
//     the CONSUMER workspace, refused the runner-temp path and exited 1 — an INSTALL REFUSAL, not
//     a content loss. This probe used to model the opposite env order and called that release
//     clean; the env order below is now the runner's, and the verdict distinguishes the two
//     failures instead of naming every red scenario "content lost".
//
// Unlike r1-root-separation-probe.mjs (which EMULATES checkout), this probe executes the shipped
// delivery steps verbatim, read from the live workflow files, and runs the REAL unmodified
// actions/checkout@v4 dist whenever a delivery point still ships a checkout step. Fully offline:
// the tool repository is a local bare mirror reached through `url.<mirror>.insteadOf` (both URL
// forms), and GIT_ALLOW_PROTOCOL=file refuses any network transport, so a green run cannot be the
// network's doing.
//
// Fixtures: a consumer that OWNS `pr-autofix/` three ways — tracked file, untracked file,
// tracked symlink. Delivery must leave every one of them byte-identical, and the tool must still
// be materialized OUTSIDE the consumer root (a delivery that materializes nothing would otherwise
// pass the preservation checks vacuously).
//
//   node scripts/sandbox/r1-consumer-collision-probe.mjs [--checkout <actions/checkout tree>]
//                                                        [--code <repo>] [--keep] [--json]
// exit 0 = delivery installed the tool and left the consumer byte-identical;
//      1 = defect reproduced; 2 = harness error

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,
  readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : null;
};
const CODE = arg('--code') || path.resolve(HERE, '..', '..');
const CHECKOUT_ARG = arg('--checkout') || process.env.ACTIONS_CHECKOUT_DIR;
const KEEP = process.argv.includes('--keep');
const AS_JSON = process.argv.includes('--json');

// The exact actions/checkout revision the iteration-4 cross-review executed for R1
// (review evidence: dist/index.js of 11d5960a326750d5838078e36cf38b85af677262).
const CHECKOUT_PIN = '11d5960a326750d5838078e36cf38b85af677262';
const TOOL_REPO = 'trained-assist/pr-autofix';

const FOUR = [
  '.github/workflows/devbaseline-callable.yml',
  '.github/workflows/autofix-callable.yml',
  '.github/workflows/ci-fix-cleanup.yml',
  'templates/batch-fix-prs.yml',
];
// Dynamic delivery execution needs one real consumer checkout in front of it (the collision
// precondition); the other three points get the same dynamic run, the file-wide shapes are
// asserted by r1-root-separation-probe.mjs scenario e as well.
const SCENARIOS = [
  [FOUR[0], 'tracked'], [FOUR[0], 'untracked'], [FOUR[0], 'symlink'],
  [FOUR[1], 'tracked'], [FOUR[2], 'tracked'], [FOUR[3], 'tracked'],
];

const die = (msg) => { console.error(`::error::${msg}`); process.exit(2); };

for (const f of FOUR) if (!existsSync(path.join(CODE, f))) die(`no ${f} in ${CODE} — pass --code <repo>`);
let TOOL_SHA;
try { TOOL_SHA = execFileSync('git', ['-C', CODE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
catch { die(`${CODE} is not a git checkout — cannot establish the pinned tool identity`); }

// ── the real actions/checkout dist — resolved only if a delivery point still ships one ──
function resolveCheckout() {
  const usable = (d) => d && existsSync(path.join(d, 'dist', 'index.js'));
  if (usable(CHECKOUT_ARG)) return CHECKOUT_ARG;
  if (CHECKOUT_ARG) die(`--checkout ${CHECKOUT_ARG} has no dist/index.js`);
  const sandboxBase = process.env.DEVBASELINE_SANDBOX_TMP || path.join(CODE, '.devbaseline-sandbox');
  mkdirSync(sandboxBase, { recursive: true });
  const cache = path.join(sandboxBase, `actions-checkout-${CHECKOUT_PIN.slice(0, 8)}`);
  if (usable(cache)) return cache;
  // CI / fresh machine: fetch the pinned source tarball (codeload serves any commit SHA).
  const tgz = path.join(sandboxBase, `actions-checkout-${CHECKOUT_PIN.slice(0, 8)}.tar.gz`);
  try {
    execFileSync('/usr/bin/bash', ['-e', '-o', 'pipefail', '-c',
      'curl -fsSL --retry 2 -o "$TGZ" "https://codeload.github.com/actions/checkout/tar.gz/$PIN"' +
      ' && rm -rf "$DEST" && mkdir -p "$DEST" && tar -xzf "$TGZ" --strip-components=1 -C "$DEST"'],
      { stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, TGZ: tgz, PIN: CHECKOUT_PIN, DEST: cache } });
  } catch { /* fall through to the explicit error below */ }
  if (!usable(cache)) {
    die(`actions/checkout@${CHECKOUT_PIN.slice(0, 8)} is not available: pass --checkout <path to an actions/checkout working tree> ` +
        `(offline sandbox) or allow codeload.github.com (CI)`);
  }
  return cache;
}
let CHECKOUT = null;
let CHECKOUT_DIST_SHA = null;
function checkoutDist() {
  if (!CHECKOUT) {
    CHECKOUT = resolveCheckout();
    CHECKOUT_DIST_SHA = createHash('sha256').update(readFileSync(path.join(CHECKOUT, 'dist', 'index.js'))).digest('hex');
  }
  return CHECKOUT_DIST_SHA ? path.join(CHECKOUT, 'dist', 'index.js') : null;
}

// ── sandbox ────────────────────────────────────────────────────────────────────
const sandboxBase = process.env.DEVBASELINE_SANDBOX_TMP || path.join(CODE, '.devbaseline-sandbox');
mkdirSync(sandboxBase, { recursive: true });
const root = mkdtempSync(path.join(sandboxBase, 'collision-'));
const HOME = path.join(root, 'home');
const TMP = path.join(root, 'tmp');
mkdirSync(HOME, { recursive: true });
mkdirSync(TMP, { recursive: true });

const git = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// Local bare mirror of the tool + insteadOf, so both delivery forms fetch from disk. Both URL
// forms are registered because git rewrites the LONGEST matching prefix: a run step that fetches
// `…/pr-autofix.git` and an action that fetches `…/pr-autofix` must land on the same mirror.
const MIRROR = path.join(root, 'tool.git');
try {
  git(['clone', '--bare', '--quiet', CODE, MIRROR]);
  git(['-C', MIRROR, 'config', 'uploadpack.allowAnySHA1InWant', 'true']); // GitHub allows sha fetches; the mirror must too
  execFileSync('git', ['config', '--global', `url.file://${MIRROR}.insteadOf`, `https://github.com/${TOOL_REPO}.git`],
    { env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', '--global', '--add', `url.file://${MIRROR}.insteadOf`, `https://github.com/${TOOL_REPO}`],
    { env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { die(`cannot build the local tool mirror: ${e.message}`); }

// ── yaml / render / if — the runner's semantics (same as r1-root-separation-probe) ─
function yamlJobs(file) {
  const py = `
import sys, yaml, json
d = yaml.safe_load(open(sys.argv[1]))
print(json.dumps(d.get("jobs") or {}, default=str))
`;
  return JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}

function render(text, ctx) {
  return String(text).replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => {
    const e = expr.trim();
    let m;
    if ((m = e.match(/^inputs\.([A-Za-z_]\w*)\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'$/))) return ctx.inputs[m[1]] ? m[2] : m[3];
    if ((m = e.match(/^secrets\.([A-Za-z_]\w*)\s*\|\|\s*github\.token$/))) return String(ctx.secrets[m[1]] || ctx.secrets.__github_token || '');
    if ((m = e.match(/^inputs\.([A-Za-z_]\w*)$/))) return String(ctx.inputs[m[1]] ?? '');
    if ((m = e.match(/^secrets\.([A-Za-z_]\w*)$/))) return String(ctx.secrets[m[1]] ?? '');
    if ((m = e.match(/^vars\.([A-Za-z_]\w*)$/))) return String((ctx.vars || {})[m[1]] ?? '');
    if ((m = e.match(/^([A-Za-z_]+\.[A-Za-z_][\w.]*)$/))) return String(ctx.globals[m[1]] ?? '');
    return '';
  });
}

function evalIf(expr) {
  const e = String(expr || '').trim();
  if (!e || e === 'always()') return true;
  if (/^steps\./.test(e)) return true; // guard steps of the shipped jobs are not our subject
  return true;
}

const ctx = {
  inputs: { mode: 'ci', profile: '', check_timeout_minutes: '20' },
  secrets: { gh_token: 'synthetic-fixture-token', llm_ladder_token: 'synthetic', __github_token: 'synthetic-fixture-token' },
  vars: {},
  globals: {
    'job.workflow_repository': TOOL_REPO,
    'job.workflow_sha': TOOL_SHA,
    'job.workflow_ref': `${TOOL_REPO}/.github/workflows/devbaseline-callable.yml@${TOOL_SHA}`,
    'github.repository': 'fixture/consumer',
    'github.workflow_sha': TOOL_SHA,
    'github.token': 'synthetic-fixture-token',
    'github.run_id': '1',
    'github.server_url': 'https://github.com',
    'github.api_url': 'https://api.github.com',
    'runner.temp': TMP,
  },
};

// ── consumer fixture ───────────────────────────────────────────────────────────
const README = '# collision-consumer\n\nOwns a pr-autofix/ catalog of its own.\n';
const ADAPTER = `${JSON.stringify({ schema_version: 1, profile: 'docs', autofix: { enabled: false } }, null, 2)}\n`;
const OWNED = '# Consumer-owned file — installing a tool must never touch it.\n';

function buildFixture(consumerDir, variant) {
  rmSync(consumerDir, { recursive: true, force: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(path.join(consumerDir, 'README.md'), README);
  writeFileSync(path.join(consumerDir, '.devbaseline.json'), ADAPTER);
  if (variant === 'tracked') {
    mkdirSync(path.join(consumerDir, 'pr-autofix'), { recursive: true });
    writeFileSync(path.join(consumerDir, 'pr-autofix', 'consumer-owned.md'), OWNED);
  } else if (variant === 'untracked') {
    mkdirSync(path.join(consumerDir, 'pr-autofix'), { recursive: true });
    writeFileSync(path.join(consumerDir, 'pr-autofix', 'consumer-owned.md'), OWNED);
  } else if (variant === 'symlink') {
    mkdirSync(path.join(consumerDir, '.consumer-owned'), { recursive: true });
    writeFileSync(path.join(consumerDir, '.consumer-owned', 'consumer-owned.md'), OWNED);
    execFileSync('ln', ['-s', '.consumer-owned', 'pr-autofix'], { cwd: consumerDir });
  }
  git(['init', '-q'], consumerDir);
  git(['add', '-A'], consumerDir);
  if (variant === 'untracked') git(['reset', '-q', '--', 'pr-autofix/'], consumerDir); // present, never committed
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], consumerDir);
}

function fingerprint(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === '.git') continue;
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (e.isSymbolicLink()) out.push(`L ${rel} -> ${readlinkSync(abs)}`);
      else if (e.isDirectory()) walk(abs);
      else out.push(`F ${rel} ${createHash('sha256').update(readFileSync(abs)).digest('hex')}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

const statusOf = (dir) => git(['status', '--porcelain'], dir);
const stagedOf = (dir) => { git(['add', '-A'], dir); const s = git(['diff', '--cached', '--name-status'], dir); git(['reset', '-q'], dir); return s; };

// ── executing the shipped delivery ─────────────────────────────────────────────
function spawnBash(block, { env, cwd }) {
  const script = path.join(root, `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
  writeFileSync(script, block, { mode: 0o755 });
  const child = spawn('/usr/bin/bash', ['-e', '-o', 'pipefail', script], { cwd, env });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: timedOut ? 124 : code, stdout, stderr }); });
  });
}

function runCheckoutDist({ env }) {
  const dist = checkoutDist();
  if (!dist) die('a delivery point ships an actions/checkout step but no checkout tree is available');
  const child = spawn(process.execPath, [dist], { env });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: timedOut ? 124 : code, stdout, stderr }); });
  });
}

const isToolCheckout = (s) =>
  /^actions\/checkout@/.test(String(s.uses || '')) && render(String(s.with?.repository || ''), ctx) === TOOL_REPO;
const materializeName = (s) => /^(materialize|deliver)\b/i.test(String(s.name || ''));
const isConsumerCheckout = (s) => /^actions\/checkout@/.test(String(s.uses || '')) && !isToolCheckout(s);

function baseEnv({ workspace, consumerDir, runnerTemp, head, extra = {} }) {
  const f = (n) => { const p = path.join(runnerTemp, n); if (!existsSync(p)) writeFileSync(p, ''); return p; };
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file', // offline: any https fetch fails instead of "accidentally" succeeding
    TMPDIR: TMP,
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_REPOSITORY: 'fixture/consumer',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: head,
    GITHUB_RUN_ID: '1',
    GITHUB_ACTION: 'materialize-the-pinned-tool',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_OUTPUT: f('github-output'),
    GITHUB_STATE: f('github-state'),
    GITHUB_ENV: f('github-env'),
    GITHUB_PATH: f('github-path'),
    GITHUB_STEP_SUMMARY: f('step-summary.md'),
    GH_TOKEN: 'synthetic-fixture-token',
    ...extra,
  };
}

const RUN_TOOL = /(^|[^\w-])(node|npm|npx)\s/;

// The delivery window starts at the collision preflight ("Delivery target is outside the
// consumer tree") when the shipped form has one, else at the materialization itself: the
// preflight is part of delivery — it must run BEFORE any write, and T5's negative scenarios
// (symlink / foreign directory / target inside the workspace) assert its loud refusal.
const isPreflight = (s) => typeof s.run === 'string' && /RUNNER_TEMP\/pr-autofix/.test(s.run) && /refusing/.test(s.run);
const isDeliveryStart = (s) => isToolCheckout(s) || materializeName(s) || isPreflight(s);

// Deliver: start at the preflight/materialization, run the shipped steps verbatim, stop when the
// tool tree has been materialized OUTSIDE the consumer root — delivery is complete at that
// point (there is no relocation step to wait for; the form is "straight to the runner temp").
// Steps before that (consumer checkout, guards, setup-node) are not part of the delivery
// boundary; steps after it EXECUTE the tool and are not delivery either.
async function runDelivery(steps, ctxA, { workspace, consumerDir, runnerTemp, head }) {
  const startIdx = steps.findIndex((s) => isDeliveryStart(s) && evalIf(s.if, ctxA));
  if (startIdx === -1) return { error: 'no tool materialization step found in this job' };
  const executed = [];
  let code = 0;
  // The runner's environment order (pr-autofix#67): a step's `env:` is applied, then the runtime
  // context is written OVER it — NodeScriptActionHandler.cs:42-50 exports GITHUB_WORKSPACE from
  // GitHubContext.cs:49-64. So the context values are re-applied last here too. An earlier version
  // of this probe merged them the other way round and therefore reported "clean" on v1.7.9, where
  // every delivery failed with "Repository path … is not under …".
  const runnerEnv = (extra) => {
    const context = baseEnv({ workspace, consumerDir, runnerTemp, head });
    const env = { ...context, ...extra };
    for (const [k, v] of Object.entries(context)) if (k.startsWith('GITHUB_')) env[k] = v;
    return env;
  };
  for (const step of steps.slice(startIdx, startIdx + 8)) {
    const name = step.name || step.uses || '(unnamed)';
    if (step.run) {
      const script = render(step.run, ctxA);
      if (RUN_TOOL.test(script)) { executed.push({ name, stopped: 'tool execution begins — delivery is over' }); break; }
      const env = runnerEnv(Object.fromEntries(Object.entries(step.env || {}).map(([k, v]) => [k, render(String(v), ctxA)])));
      const r = await spawnBash(script, { env, cwd: workspace });
      executed.push({ name, code: r.code, tail: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-6).join('\n') });
      if (r.code !== 0) { code = r.code; break; }
      continue;
    }
    if (isToolCheckout(step)) {
      const extra = { INPUT_TOKEN: 'synthetic-fixture-token',
        ...Object.fromEntries(Object.entries(step.env || {}).map(([k, v]) => [k, render(String(v), ctxA)])) };
      for (const [k, v] of Object.entries(step.with || {})) {
        const rendered = render(String(v), ctxA);
        if (rendered !== '') extra[`INPUT_${k.toUpperCase()}`] = rendered;
      }
      const r = await runCheckoutDist({ env: runnerEnv(extra) });
      executed.push({ name, code: r.code, tail: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-6).join('\n'),
        step_env: step.env || {} });
      if (r.code !== 0) { code = r.code; break; }
      executed.push({ name: `${name} (delivery)`, delivered: true }); // the tool tree is outside the consumer root — delivery is over
      break;
    }
    executed.push({ name, skipped: `uses:${step.uses || '?'} is not delivery` });
  }
  return { executed, code };
}

// Vacuity guard: the tool tree must exist SOMEWHERE outside this consumer root (its own
// case directory — never a sibling scenario's tree, or a delivery that materialized nothing
// would pass the preservation checks on someone else's artifacts).
function findToolTreeOutside(workspace, caseDir) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (abs === workspace || abs.startsWith(workspace + path.sep)) continue;
      if (e.isDirectory()) {
        if (existsSync(path.join(abs, 'payload.manifest.json'))) hits.push(abs);
        walk(abs, depth + 1);
      }
    }
  };
  if (existsSync(caseDir)) { try { walk(caseDir, 0); } catch { /* ignore */ } }
  return [...new Set(hits)];
}

// ── the scenarios ──────────────────────────────────────────────────────────────
const results = [];
const say = (s) => { if (!AS_JSON) console.log(s); };
const check = (scenario, name, ok, detail = '') => {
  scenario.checks.push({ name, ok: !!ok, detail });
  say(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

for (const [wf, variant] of SCENARIOS) {
  const short = path.basename(wf).replace(/\.yml$/, '');
  say(`\n== ${wf} / ${variant}`);
  const scenario = { workflow: wf, variant, checks: [], executed: [] };

  let jobs;
  try { jobs = yamlJobs(path.join(CODE, wf)); } catch (e) { die(`cannot parse ${wf}: ${e.message}`); }
  const jobName = Object.keys(jobs).find((jn) => (jobs[jn].steps || []).some((s) => isToolCheckout(s) || materializeName(s)));
  if (!jobName) die(`${wf}: no job with a tool materialization step`);
  const steps = jobs[jobName].steps || [];

  // Consumer root: where the shipped consumer checkout (if any) puts the repository.
  // One case directory per scenario, so every check only ever sees its own artifacts.
  const consumerStep = steps.find(isConsumerCheckout);
  const consumerSub = consumerStep ? render(String(consumerStep.with?.path || ''), ctx).trim() : '';
  const caseDir = path.join(root, `case-${short}-${variant}`);
  const workspace = path.join(caseDir, 'ws');
  const consumerDir = consumerSub ? path.join(workspace, consumerSub) : workspace;
  const runnerTemp = path.join(caseDir, 'rt');
  mkdirSync(runnerTemp, { recursive: true });
  // `${{ runner.temp }}` and $RUNNER_TEMP must be the SAME per case: the shipped form renders the
  // path from the expression while the preflight reads the env, and a probe that let them diverge
  // would test a delivery nobody ships.
  ctx.globals['runner.temp'] = runnerTemp;

  buildFixture(consumerDir, variant);
  const fpBefore = fingerprint(consumerDir);
  const statusBefore = statusOf(consumerDir);
  const expectedStaged = stagedOf(consumerDir);
  const head = git(['rev-parse', 'HEAD'], consumerDir);

  const delivery = await runDelivery(steps, ctx, { workspace, consumerDir, runnerTemp, head });
  if (delivery.error) die(`${wf}: ${delivery.error}`);
  scenario.executed = delivery.executed;

  // a. the shipped delivery ran to completion
  const failed = delivery.executed.filter((s) => s.code);
  check(scenario, 'a. delivery steps exit 0 (preflight + materialize)',
    delivery.code === 0,
    failed.length ? failed.map((s) => `${s.name} exit ${s.code}: ${(s.tail || '').split('\n').slice(-1)[0]}`).join('; ') : '');

  // b. the tool tree exists OUTSIDE the consumer root (a no-op delivery must not pass c–e)
  const toolTrees = findToolTreeOutside(consumerDir, caseDir);
  check(scenario, 'b. the tool tree is materialized outside the consumer root',
    toolTrees.length > 0, toolTrees.length ? `at ${toolTrees[0]}` : 'no payload.manifest.json found outside the consumer root');

  // c. byte-for-byte preservation of the consumer working tree
  const fpAfter = fingerprint(consumerDir);
  const fpDiff = fpBefore.split('\n').filter((l) => !fpAfter.split('\n').includes(l))
    .concat(fpAfter.split('\n').filter((l) => !fpBefore.split('\n').includes(l)).map((l) => `+ ${l}`));
  check(scenario, 'c. consumer tree is byte-identical (files + symlinks)',
    fpAfter === fpBefore, fpDiff.slice(0, 4).join(' | '));

  // d. git status sees exactly what it saw before delivery
  const statusAfter = statusOf(consumerDir);
  check(scenario, 'd. `git status --porcelain` is unchanged',
    statusAfter === statusBefore,
    statusBefore === statusAfter ? '' : `before=${JSON.stringify(statusBefore)} after=${JSON.stringify(statusAfter)}`);

  // e. `git add -A` (what autofix stages) produces exactly the pristine expectation
  const stagedAfter = stagedOf(consumerDir);
  const unexpected = stagedAfter.split('\n').filter((l) => l && !expectedStaged.includes(l));
  const missing = expectedStaged.split('\n').filter((l) => l && !stagedAfter.includes(l));
  const stageProblems = [...unexpected.map((l) => `unexpected: ${l}`), ...missing.map((l) => `missing: ${l}`)];
  check(scenario, 'e. `git add -A` stages exactly the pristine expectation (no deletions, no tool paths)',
    stagedAfter === expectedStaged,
    stageProblems.length <= 6 ? stageProblems.join(' | ')
      : `${stageProblems.slice(0, 6).join(' | ')} | … +${stageProblems.length - 6} more (see results.json)`);

  // f. no tooling gitlink
  const gitlinks = git(['ls-files', '-s'], consumerDir).split('\n').filter((l) => l.startsWith('160000'));
  check(scenario, 'f. no tooling gitlink (160000) in the index', gitlinks.length === 0, gitlinks.slice(0, 2).join('; '));

  scenario.evidence = { status_before: statusBefore, status_after: statusAfter,
    expected_staged: expectedStaged, staged_after: stagedAfter,
    fp_before: fpBefore, fp_after: fpAfter };
  scenario.passed = scenario.checks.every((c) => c.ok);
  results.push(scenario);
}

// ── T5 — the preflight must refuse LOUDLY, before any write ─────────────────────
// A collision check that silently overwrites is worse than none, and one that holds only because
// nothing happened to be in the way proves nothing. Each case puts a real obstacle in the delivery
// target (or puts the target inside the consumer) and asserts three things: the shipped preflight
// exits non-zero with an explicit refusal, the obstacle is byte-identical afterwards (nothing was
// written AND nothing was destroyed), and the consumer tree is untouched. The last case pins the
// other side of the rule: a previous checkout PROVEN ours (delivery marker + our origin,
// pr-autofix#70) is allowed through, while the same checkout WITHOUT the marker — a legacy
// install or anything that merely looks like one — is refused before any write.
const preflightCases = [];
{
  const wf = '.github/workflows/devbaseline-callable.yml';
  let pf = null;
  try {
    const jobs = yamlJobs(path.join(CODE, wf));
    const jobName = Object.keys(jobs).find((jn) => (jobs[jn].steps || []).some(isPreflight));
    pf = jobName ? (jobs[jobName].steps || []).find(isPreflight) : null;
  } catch (e) { pf = null; }
  if (!pf) {
    preflightCases.push({ name: 'shipped preflight exists', checks: [{ name: 'a collision preflight is shipped', ok: false, detail: `none found in ${wf}` }] });
    say('FAIL a collision preflight is shipped — none found');
  } else {
    const script = render(pf.run, ctx);
    // The preflight now reads $TOOL_REPOSITORY (ownership guard, pr-autofix#70): the runner
    // resolves the step's `env:` before the script runs, so the probe must too — otherwise
    // `set -u` fails the block before it can prove anything.
    const preflightEnv = Object.fromEntries(Object.entries(pf.env || {}).map(([k, v]) => [k, render(String(v), ctx)]));
    const ABSENT = '(absent)';
    // The obstacle ITSELF, not its parent directory: the runner's own marker files
    // (GITHUB_ENV/GITHUB_OUTPUT/…) are created inside the temp dir when the step env is built,
    // and fingerprinting the directory would report that as "the target changed".
    const targetFp = (p) => {
      let st;
      try { st = lstatSync(p); } catch { return ABSENT; }
      if (st.isSymbolicLink()) return `L -> ${readlinkSync(p)}`;
      if (st.isDirectory()) return fingerprint(p);
      return `F ${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    };
    const cases = [
      { name: 'symlink at the target', obstacle: 'symlink' },
      { name: 'foreign directory at the target', obstacle: 'dir' },
      { name: 'target inside the consumer tree', obstacle: 'inside' },
      { name: 'a tool checkout proven ours is not an obstacle', obstacle: 'tool-checkout', allow: true },
      { name: 'a tool checkout WITHOUT the ownership marker is refused', obstacle: 'tool-checkout-no-marker' },
    ];
    for (const c of cases) {
      const caseDir = path.join(root, `preflight-${c.obstacle}`);
      const workspace = path.join(caseDir, 'ws');
      const consumerDir = workspace;
      const runnerTemp = path.join(caseDir, 'rt');
      mkdirSync(runnerTemp, { recursive: true });
      ctx.globals['runner.temp'] = runnerTemp;
      buildFixture(consumerDir, 'tracked');
      const head = git(['rev-parse', 'HEAD'], consumerDir);
      const target = path.join(runnerTemp, 'pr-autofix');
      const extra = {};
      if (c.obstacle === 'symlink') {
        mkdirSync(path.join(runnerTemp, 'obstacle'), { recursive: true });
        writeFileSync(path.join(runnerTemp, 'obstacle', 'keep.md'), OWNED);
        execFileSync('ln', ['-s', 'obstacle', target], { cwd: runnerTemp });
      } else if (c.obstacle === 'dir') {
        mkdirSync(target, { recursive: true });
        writeFileSync(path.join(target, 'keep.md'), OWNED);
      } else if (c.obstacle === 'tool-checkout' || c.obstacle === 'tool-checkout-no-marker') {
        // A real previous install of THIS tool: git repo, origin = the tool repository, and (for
        // the proven case) the ownership marker the guard reads. The marker-less twin is what a
        // legacy install looks like — same shape, no proof — and must be refused (pr-autofix#70).
        execFileSync('git', ['init', '-q', target]);
        execFileSync('git', ['-C', target, 'remote', 'add', 'origin', 'https://github.com/trained-assist/pr-autofix.git']);
        if (c.obstacle === 'tool-checkout') writeFileSync(path.join(target, '.git', 'pr-autofix-delivery'), 'repo=trained-assist/pr-autofix\n');
      } else if (c.obstacle === 'inside') {
        extra.RUNNER_TEMP = path.join(workspace, 'scratch'); // a misconfigured runner: target lands in the consumer
        mkdirSync(extra.RUNNER_TEMP, { recursive: true });
      }
      const consumerBefore = fingerprint(consumerDir);
      const targetPath = c.obstacle === 'inside' ? path.join(extra.RUNNER_TEMP, 'pr-autofix') : target;
      const targetBefore = targetFp(targetPath);
      const env = { ...baseEnv({ workspace, consumerDir, runnerTemp, head }), ...preflightEnv, ...extra };
      const r = await spawnBash(script, { env, cwd: workspace });
      const out = `${r.stdout}${r.stderr}`.trim();
      const consumerAfter = fingerprint(consumerDir);
      const targetAfter = targetFp(targetPath);
      const verdictWord = c.allow ? 'allows' : 'refuses';
      const checks = [
        { name: `${c.name}: the preflight ${verdictWord} (exit ${r.code})`, ok: c.allow ? r.code === 0 : r.code !== 0, detail: out.split('\n').slice(-1)[0] || '(no output)' },
        { name: `${c.name}: ${c.allow ? 'the allowance is deliberate (no refusal)' : 'the refusal is explicit, not a silent skip'}`, ok: c.allow || /refusing/.test(out), detail: c.allow ? '' : (/refusing/.test(out) ? '' : out.split('\n').slice(-2).join(' | ').slice(0, 200)) },
        { name: `${c.name}: nothing in the target was written or destroyed`, ok: targetAfter === targetBefore, detail: targetAfter === targetBefore ? '' : `before=${targetBefore.slice(0, 120)} after=${targetAfter.slice(0, 120)}` },
        { name: `${c.name}: the consumer tree is byte-identical`, ok: consumerAfter === consumerBefore, detail: consumerAfter === consumerBefore ? '' : 'the consumer changed' },
      ];
      preflightCases.push({ name: c.name, expect: verdictWord, exit: r.code, output: out, checks });
      for (const k of checks) say(`${k.ok ? 'ok  ' : 'FAIL'} ${k.name}${k.ok ? '' : ` — ${k.detail}`}`);
    }
  }
}

const failedScenarios = results.filter((s) => !s.passed);
const failedPreflight = preflightCases.flatMap((c) => c.checks).filter((k) => !k.ok).length;
// Two different failures used to share one sentence, which is how #67 read as "content lost" when
// nothing was installed at all (R2). Name them apart: an install refusal leaves the consumer
// untouched, a content loss does not.
const installRefused = results.filter((s) => s.checks.find((c) => c.name.startsWith('a.'))?.ok === false);
const contentLost = results.filter((s) => ['c.', 'd.', 'e.', 'f.'].some((p) => s.checks.find((c) => c.name.startsWith(p))?.ok === false));
const notInstalled = results.filter((s) => s.checks.find((c) => c.name.startsWith('b.'))?.ok === false);
const report = {
  probe: 'r1-consumer-collision-probe',
  code: CODE,
  tool_sha: TOOL_SHA,
  actions_checkout: CHECKOUT
    ? { dir: CHECKOUT, dist_sha256: CHECKOUT_DIST_SHA, pinned_review_sha: CHECKOUT_PIN }
    : null, // the shipped delivery is a run step — no action dist was needed, and none was fetched
  transport: 'local bare mirror via url.insteadOf; GIT_ALLOW_PROTOCOL=file (no network)',
  scenarios: results,
  preflight_cases: preflightCases,
  preflight_shape: `${preflightCases.filter((c) => c.expect === 'refuses').length} refusal cases + ${preflightCases.filter((c) => c.expect === 'allows').length} deliberate allowance (not four failures)`,
  verdict: (failedScenarios.length || failedPreflight)
    ? `DEFECT — ${[
        installRefused.length ? `install refused at ${installRefused.length}/${results.length} scenarios` : '',
        notInstalled.length ? `tool tree absent at ${notInstalled.length}/${results.length} scenarios` : '',
        contentLost.length ? `CONSUMER CONTENT LOST at ${contentLost.length}/${results.length} scenarios` : '',
        failedPreflight ? `the collision preflight fails ${failedPreflight} check(s)` : '',
      ].filter(Boolean).join('; ')}`
    : 'clean — the tool is installed outside the consumer and the consumer is byte-identical',
};
writeFileSync(path.join(sandboxBase, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else console.log(`\nverdict: ${report.verdict}\nresults: ${path.join(sandboxBase, 'results.json')}`);

if (!KEEP && !process.env.DEVBASELINE_SANDBOX_TMP) rmSync(root, { recursive: true, force: true });
else say(`sandbox kept at ${root}`);
process.exit(failedScenarios.length || failedPreflight ? 1 : 0);

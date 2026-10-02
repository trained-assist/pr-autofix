#!/usr/bin/env node
// R1 probe, runner-faithful — the pinned tool tree must actually be INSTALLED, outside the
// consumer, when the runner's own environment ordering is applied.
//
// Defect (pr-autofix#67 — R1/P1 of the Z01 iteration-5 cross-review). v1.7.9 delivered the tool
// with `uses: actions/checkout` + `env: GITHUB_WORKSPACE: ${{ runner.temp }}` + an absolute
// `path: ${{ runner.temp }}/pr-autofix`. For a JavaScript action the runner does not let a step's
// `env:` win:
//     actions/runner 2.337.0 — ActionRunner.cs:240-252 (step env) → NodeScriptActionHandler.cs:42-50
//     (runtime context written over it) → GitHubContext.cs:49-64 (GITHUB_WORKSPACE exported).
// The real checkout therefore saw the CONSUMER workspace and refused the runner-temp path:
//     ::error::Repository path '<rt>/pr-autofix' is not under '<ws>'   (exit 1)
// Nothing was installed, so baseline / AutoFix / cleanup never started. The consumer lost no bytes
// — this is an INSTALL REFUSAL, not content loss, and a verdict that calls it content loss hides
// the actual break (R2 of the same review).
//
// Why this probe exists at all: r1-consumer-collision-probe.mjs lets the step env WIN, which is the
// reverse of the runner, and therefore reported `clean` on a release where every delivery failed.
// A probe that inverts the runner under test proves nothing about it. Here the env is built the
// way 2.337.0 builds it — CONTEXT LAST, so the context wins — and the shipped delivery is then
// executed against a synthetic consumer. RED on the v1.7.9 form, GREEN only on a form that needs
// no GITHUB_* override at all.
//
//   node scripts/sandbox/r1-runner-faithful-delivery-probe.mjs [--code <repo>] [--checkout <tree>]
//                                                              [--keep] [--json]
// exit 0 = the tree arrived outside the consumer and the consumer is byte-identical;
//      1 = defect; 2 = harness error (never a verdict)

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync,
  readdirSync, readlinkSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
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

// The actions/checkout revision the iteration-5 review executed for R1. Only needed when a
// delivery point still SHIPS a tool checkout — the fixed form is a plain run step and this probe
// then never touches an action dist or the network at all.
const CHECKOUT_PIN = '11d5960a326750d5838078e36cf38b85af677262';
const TOOL_REPO = 'trained-assist/pr-autofix';

const FOUR = [
  '.github/workflows/devbaseline-callable.yml',
  '.github/workflows/autofix-callable.yml',
  '.github/workflows/ci-fix-cleanup.yml',
  'templates/batch-fix-prs.yml',
];
// Three ways a consumer can own `pr-autofix/` in its root (the defect class of #61) on the first
// delivery point, and one plain tracked consumer per remaining point — so every one of the four
// shipped delivery forms is executed, not merely parsed.
const SCENARIOS = [
  [FOUR[0], 'tracked'], [FOUR[0], 'untracked'], [FOUR[0], 'symlink'],
  [FOUR[1], 'tracked'], [FOUR[2], 'tracked'], [FOUR[3], 'tracked'],
];

const die = (msg) => { console.error(`::error::${msg}`); process.exit(2); };
const say = (s) => { if (!AS_JSON) console.log(s); };

for (const f of FOUR) if (!existsSync(path.join(CODE, f))) die(`no ${f} in ${CODE} — pass --code <repo>`);
let TOOL_SHA;
try { TOOL_SHA = execFileSync('git', ['-C', CODE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
catch { die(`${CODE} is not a git checkout — cannot establish the pinned tool identity`); }

// ── yaml / render / if — the runner's expressions ─────────────────────────────────
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
  // Guard steps these harness runs do not execute (duplicate-PR protection, `if: inputs.x ==`)
  // are assumed to allow the run: that is the path the defect lives on, and both outcomes are
  // exercised by their own scenarios anyway.
  return true;
}

const ctx = {
  inputs: { mode: 'ci', profile: '', check_timeout_minutes: '20', pr_number: '1', dry_run: true, keep_branches: '[]' },
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
    'runner.temp': '',
  },
};

// ── sandbox: isolated consumer root, isolated runner temp, local tool mirror ───────
const sandboxBase = process.env.DEVBASELINE_SANDBOX_TMP || path.join(CODE, '.devbaseline-sandbox');
mkdirSync(sandboxBase, { recursive: true });
const root = mkdtempSync(path.join(sandboxBase, 'runner-faithful-'));
const HOME = path.join(root, 'home');
const TMP = path.join(root, 'tmp');
mkdirSync(HOME, { recursive: true });
mkdirSync(TMP, { recursive: true });

const git = (args, cwd, opts = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// Local bare mirror of the tool + url.insteadOf: a run-step that fetches the pinned tree must be
// exercised offline, against a repository on disk. Both URL forms are registered because git
// rewrites the longest matching prefix: `.../pr-autofix.git` and `.../pr-autofix`.
const MIRROR = path.join(root, 'tool.git');
try {
  git(['clone', '--bare', '--quiet', CODE, MIRROR]);
  git(['-C', MIRROR, 'config', 'uploadpack.allowAnySHA1InWant', 'true']); // GitHub allows sha fetches; the mirror must too
  execFileSync('git', ['config', '--global', `url.file://${MIRROR}.insteadOf`, `https://github.com/${TOOL_REPO}.git`],
    { env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', '--global', '--add', `url.file://${MIRROR}.insteadOf`, `https://github.com/${TOOL_REPO}`],
    { env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) { die(`cannot build the local tool mirror: ${e.message}`); }

// ── the environment, in the runner's order: context FIRST, step env SECOND, context LAST ──
// The last line is the whole point of this probe. Runner 2.337.0 hands a JavaScript action a
// dictionary that NodeScriptActionHandler has already overwritten with the runtime context, and
// GitHubContext exports GITHUB_WORKSPACE from that context — so a step env that tries to move the
// workspace does nothing.
function contextEnv({ workspace, runnerTemp, head }) {
  const f = (n) => { const p = path.join(runnerTemp, n); if (!existsSync(p)) writeFileSync(p, ''); return p; };
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME,
    TMPDIR: TMP,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file', // offline: a network fetch fails instead of "accidentally" succeeding
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
  };
}

function runnerEnv({ workspace, runnerTemp, head, step, stepEnv = {} }) {
  const context = contextEnv({ workspace, runnerTemp, head });
  const env = { ...context, ...stepEnv };
  for (const [k, v] of Object.entries(context)) if (k.startsWith('GITHUB_')) env[k] = v; // context wins
  return env;
}

function stepEnvOf(step, ctxA) {
  return Object.fromEntries(Object.entries(step?.env || {}).map(([k, v]) => [k, render(String(v), ctxA)]));
}

// ── consumer fixture ────────────────────────────────────────────────────────────
const README = '# runner-faithful-consumer\n\nOwns a pr-autofix/ catalog of its own.\n';
const ADAPTER = `${JSON.stringify({ schema_version: 1, profile: 'docs', autofix: { enabled: false } }, null, 2)}\n`;
const OWNED = '# Consumer-owned file — installing a tool must never touch it.\n';

function buildFixture(consumerDir, variant) {
  rmSync(consumerDir, { recursive: true, force: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(path.join(consumerDir, 'README.md'), README);
  writeFileSync(path.join(consumerDir, '.devbaseline.json'), ADAPTER);
  if (variant === 'tracked' || variant === 'untracked') {
    mkdirSync(path.join(consumerDir, 'pr-autofix'), { recursive: true });
    writeFileSync(path.join(consumerDir, 'pr-autofix', 'consumer-owned.md'), OWNED);
  } else if (variant === 'symlink') {
    mkdirSync(path.join(consumerDir, '.consumer-owned'), { recursive: true });
    writeFileSync(path.join(consumerDir, '.consumer-owned', 'consumer-owned.md'), OWNED);
    execFileSync('ln', ['-s', '.consumer-owned', 'pr-autofix'], { cwd: consumerDir });
  }
  git(['init', '-q'], consumerDir);
  git(['add', '-A'], consumerDir);
  if (variant === 'untracked') git(['reset', '-q', '--', 'pr-autofix/'], consumerDir);
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

// ── the real actions/checkout dist — only when a delivery point still ships one ──
let CHECKOUT_DIR = null;
function resolveCheckout() {
  const usable = (d) => d && existsSync(path.join(d, 'dist', 'index.js'));
  if (usable(CHECKOUT_ARG)) return CHECKOUT_ARG;
  if (CHECKOUT_ARG) die(`--checkout ${CHECKOUT_ARG} has no dist/index.js`);
  const cache = path.join(sandboxBase, `actions-checkout-${CHECKOUT_PIN.slice(0, 8)}`);
  if (usable(cache)) return cache;
  const tgz = path.join(sandboxBase, `actions-checkout-${CHECKOUT_PIN.slice(0, 8)}.tar.gz`);
  try {
    execFileSync('/usr/bin/bash', ['-e', '-o', 'pipefail', '-c',
      'curl -fsSL --retry 2 -o "$TGZ" "https://codeload.github.com/actions/checkout/tar.gz/$PIN"'
      + ' && rm -rf "$DEST" && mkdir -p "$DEST" && tar -xzf "$TGZ" --strip-components=1 -C "$DEST"'],
      { stdio: ['ignore', 'inherit', 'inherit'],
        env: { ...process.env, TGZ: tgz, PIN: CHECKOUT_PIN, DEST: cache } });
  } catch { /* fall through to the explicit error below */ }
  if (!usable(cache)) {
    die(`actions/checkout@${CHECKOUT_PIN.slice(0, 8)} is not available: pass --checkout <path to an actions/checkout working tree> `
      + `(offline sandbox) or allow codeload.github.com (CI)`);
  }
  return cache;
}
function runCheckoutDist({ env }) {
  const dist = path.join(CHECKOUT_DIR, 'dist', 'index.js');
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

function spawnBash(block, { env, cwd }) {
  const script = path.join(root, `step-${Math.random().toString(36).slice(2, 10)}.sh`);
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

// ── the shipped delivery window ──────────────────────────────────────────────────
const isToolCheckout = (s, ctxA) =>
  /^actions\/checkout@/.test(String(s.uses || '')) && render(String(s.with?.repository || ''), ctxA) === TOOL_REPO;
const materializeName = (s) => /^(materialize|deliver)\b/i.test(String(s.name || ''));
const isPreflight = (s) => typeof s.run === 'string' && /RUNNER_TEMP\/pr-autofix/.test(s.run) && /refusing/.test(s.run);
const isDeliveryStart = (s) => isToolCheckout(s, ctx) || materializeName(s) || isPreflight(s);
const RUN_TOOL = /(^|[^\w-])(node|npm|npx)\s/;

// The window runs from the collision preflight (delivery's own first write gate) or the
// materialization, and ends as soon as the tool tree exists outside the consumer root: steps after
// that point EXECUTE the tool, which is not this probe's subject.
async function runDelivery(steps, ctxA, { workspace, consumerDir, runnerTemp, head }) {
  const startIdx = steps.findIndex((s) => isDeliveryStart(s) && evalIf(s.if));
  if (startIdx === -1) return { error: 'no tool delivery step found in this job' };
  const executed = [];
  let code = 0;
  for (const step of steps.slice(startIdx, startIdx + 10)) {
    const name = step.name || step.uses || '(unnamed)';
    if (isPreflight(step) || materializeName(step) || (isToolCheckout(step, ctxA) && !step.run)) {
      if (step.run) {
        const script = render(step.run, ctxA);
        if (RUN_TOOL.test(script)) { executed.push({ name, stopped: 'tool execution begins — delivery is over' }); break; }
        const r = await spawnBash(script, { env: runnerEnv({ workspace, runnerTemp, head, step, stepEnv: stepEnvOf(step, ctxA) }), cwd: workspace });
        executed.push({ name, code: r.code, tail: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-6).join('\n') });
        if (r.code !== 0) { code = r.code; break; }
        continue;
      }
      if (!CHECKOUT_DIR) CHECKOUT_DIR = resolveCheckout();
      const env = runnerEnv({ workspace, runnerTemp, head, step, stepEnv: { INPUT_TOKEN: 'synthetic-fixture-token', ...Object.fromEntries(Object.entries(step.with || {}).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, render(String(v), ctxA)]).filter(([, v]) => v !== '')) } });
      const r = await runCheckoutDist({ env });
      executed.push({ name, code: r.code, tail: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-6).join('\n'), step_env: step.env || {} });
      if (r.code !== 0) { code = r.code; break; }
      executed.push({ name: `${name} (delivery)`, delivered: true });
      break;
    }
    executed.push({ name, skipped: `not part of delivery (uses:${step.uses || '?'})` });
  }
  return { executed, code };
}

// ── scenario 0: the static contract — no step may try to move the runner's context ──
// This is the form assertion that keeps the defect from coming back through a "harmless" refactor:
// on the v1.7.9 form it fails immediately, and it is cheap enough to run first.
const formChecks = [];
{
  for (const rel of FOUR) {
    const jobs = yamlJobs(path.join(CODE, rel));
    const offenders = [];
    for (const [jobName, job] of Object.entries(jobs)) {
      for (const s of job.steps || []) {
        for (const k of Object.keys(s.env || {})) {
          if (/^(GITHUB_|RUNNER_)/.test(k)) offenders.push(`${jobName} → ${s.name || '(unnamed)'}: env.${k}`);
        }
      }
    }
    formChecks.push({ workflow: rel, offenders });
    say(`${offenders.length ? 'FAIL' : 'ok  '} ${rel}: no step overrides a runner context variable (GITHUB_*/RUNNER_*)`);
  }
}
const formFailed = formChecks.filter((c) => c.offenders.length);

// ── the scenarios ────────────────────────────────────────────────────────────────
const results = [];
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
  const jobName = Object.keys(jobs).find((jn) => (jobs[jn].steps || []).some((s) => isToolCheckout(s, ctx) || materializeName(s) || isPreflight(s)));
  if (!jobName) die(`${wf}: no job with a tool delivery step`);
  const steps = jobs[jobName].steps || [];

  const caseDir = path.join(root, `case-${short}-${variant}`);
  const workspace = path.join(caseDir, 'ws');
  const consumerDir = workspace;
  const runnerTemp = path.join(caseDir, 'rt');
  mkdirSync(runnerTemp, { recursive: true });
  ctx.globals['runner.temp'] = runnerTemp;

  buildFixture(consumerDir, variant);
  const fpBefore = fingerprint(consumerDir);
  const statusBefore = statusOf(consumerDir);
  const expectedStaged = stagedOf(consumerDir);
  const head = git(['rev-parse', 'HEAD'], consumerDir);

  const delivery = await runDelivery(steps, ctx, { workspace, consumerDir, runnerTemp, head });
  if (delivery.error) die(`${wf}: ${delivery.error}`);
  scenario.executed = delivery.executed;

  const failed = delivery.executed.filter((s) => s.code);
  check(scenario, 'a. the shipped delivery exits 0 (the tool is actually installed)',
    delivery.code === 0,
    failed.length ? failed.map((s) => `${s.name} exit ${s.code}: ${(s.tail || '').split('\n').slice(-1)[0]}`).join('; ') : '');

  // b. the pinned tree landed in the runner temp at the pinned SHA — an installation, not a copy
  const target = path.join(runnerTemp, 'pr-autofix');
  let deliveredSha = null;
  try { deliveredSha = git(['rev-parse', 'HEAD'], target).trim(); } catch { /* not installed */ }
  check(scenario, 'b. the pinned tree is installed in $RUNNER_TEMP/pr-autofix at the pinned SHA',
    deliveredSha === TOOL_SHA && existsSync(path.join(target, 'payload.manifest.json')),
    deliveredSha ? `sha=${deliveredSha.slice(0, 7)} expected=${TOOL_SHA.slice(0, 7)}` : 'the tool tree is absent — installation refused');
  check(scenario, 'b2. the tool tree is outside the consumer root',
    existsSync(target) && !path.resolve(target).startsWith(path.resolve(consumerDir) + path.sep),
    `${target} vs ${consumerDir}`);

  // c–f. the consumer side of the contract (pr-autofix#61) — a refusal must not become a loss
  const fpAfter = fingerprint(consumerDir);
  const fpDiff = fpBefore.split('\n').filter((l) => !fpAfter.split('\n').includes(l))
    .concat(fpAfter.split('\n').filter((l) => !fpBefore.split('\n').includes(l)).map((l) => `+ ${l}`));
  check(scenario, 'c. the consumer tree is byte-identical (files + symlinks)', fpAfter === fpBefore, fpDiff.slice(0, 4).join(' | '));

  const statusAfter = statusOf(consumerDir);
  check(scenario, 'd. `git status --porcelain` is unchanged', statusAfter === statusBefore,
    statusBefore === statusAfter ? '' : `before=${JSON.stringify(statusBefore)} after=${JSON.stringify(statusAfter)}`);

  const stagedAfter = stagedOf(consumerDir);
  const stageProblems = [
    ...stagedAfter.split('\n').filter((l) => l && !expectedStaged.includes(l)).map((l) => `unexpected: ${l}`),
    ...expectedStaged.split('\n').filter((l) => l && !stagedAfter.includes(l)).map((l) => `missing: ${l}`),
  ];
  check(scenario, 'e. `git add -A` stages exactly the pristine expectation (no deletions, no tool paths)',
    stagedAfter === expectedStaged, stageProblems.length <= 6 ? stageProblems.join(' | ') : `${stageProblems.length} differences`);

  const gitlinks = git(['ls-files', '-s'], consumerDir).split('\n').filter((l) => l.startsWith('160000'));
  check(scenario, 'f. no tooling gitlink (160000) in the index', gitlinks.length === 0, gitlinks.slice(0, 2).join('; '));

  scenario.passed = scenario.checks.every((c) => c.ok);
  results.push(scenario);
}

// ── the preflight must refuse LOUDLY, before any write ───────────────────────────
const preflightCases = [];
{
  const wf = FOUR[0];
  const jobs = yamlJobs(path.join(CODE, wf));
  const jobName = Object.keys(jobs).find((jn) => (jobs[jn].steps || []).some(isPreflight));
  const pf = jobName ? jobs[jobName].steps.find(isPreflight) : null;
  if (!pf) {
    preflightCases.push({ name: 'shipped preflight exists', checks: [{ name: 'a collision preflight is shipped', ok: false, detail: `none found in ${wf}` }] });
    say('FAIL a collision preflight is shipped — none found');
  } else {
    const script = render(pf.run, ctx);
    // The preflight reads $TOOL_REPOSITORY (ownership guard, pr-autofix#70): the runner resolves
    // the step's `env:` before the script runs, so the probe must too.
    const preflightEnv = Object.fromEntries(Object.entries(pf.env || {}).map(([k, v]) => [k, render(String(v), ctx)]));
    const ABSENT = '(absent)';
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
      const runnerTemp = path.join(caseDir, 'rt');
      mkdirSync(runnerTemp, { recursive: true });
      ctx.globals['runner.temp'] = runnerTemp;
      buildFixture(workspace, 'tracked');
      const head = git(['rev-parse', 'HEAD'], workspace);
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
        // A real previous install of THIS tool; the marker-less twin is a legacy install — same
        // shape, no proof — and must be refused before any write (pr-autofix#70).
        execFileSync('git', ['init', '-q', target]);
        execFileSync('git', ['-C', target, 'remote', 'add', 'origin', 'https://github.com/trained-assist/pr-autofix.git']);
        if (c.obstacle === 'tool-checkout') writeFileSync(path.join(target, '.git', 'pr-autofix-delivery'), 'repo=trained-assist/pr-autofix\n');
      } else if (c.obstacle === 'inside') {
        extra.RUNNER_TEMP = path.join(workspace, 'scratch'); // a misconfigured runner: target lands in the consumer
        mkdirSync(extra.RUNNER_TEMP, { recursive: true });
      }
      const consumerBefore = fingerprint(workspace);
      const targetPath = c.obstacle === 'inside' ? path.join(extra.RUNNER_TEMP, 'pr-autofix') : target;
      const targetBefore = targetFp(targetPath);
      const context = contextEnv({ workspace, runnerTemp, head });
      const env = { ...context, ...preflightEnv, ...extra };
      for (const [k, v] of Object.entries(context)) if (k.startsWith('GITHUB_')) env[k] = v;
      const r = await spawnBash(script, { env, cwd: workspace });
      const out = `${r.stdout}${r.stderr}`.trim();
      const consumerAfter = fingerprint(workspace);
      const targetAfter = targetFp(targetPath);
      const verdictWord = c.allow ? 'allows' : 'refuses';
      const checks = [
        { name: `${c.name}: the preflight ${verdictWord} (exit ${r.code})`, ok: c.allow ? r.code === 0 : r.code !== 0, detail: out.split('\n').slice(-1)[0] || '(no output)' },
        { name: `${c.name}: ${c.allow ? 'the allowance is deliberate (no refusal)' : 'the refusal is explicit, not a silent skip'}`, ok: c.allow || /refusing/.test(out), detail: c.allow ? '' : out.split('\n').slice(-2).join(' | ').slice(0, 200) },
        { name: `${c.name}: nothing in the target was written or destroyed`, ok: targetAfter === targetBefore, detail: targetAfter === targetBefore ? '' : `before=${targetBefore.slice(0, 100)} after=${targetAfter.slice(0, 100)}` },
        { name: `${c.name}: the consumer tree is byte-identical`, ok: consumerAfter === consumerBefore, detail: consumerAfter === consumerBefore ? '' : 'the consumer changed' },
      ];
      preflightCases.push({ name: c.name, expect: verdictWord, exit: r.code, output: out, checks });
      for (const k of checks) say(`${k.ok ? 'ok  ' : 'FAIL'} ${k.name}${k.ok ? '' : ` — ${k.detail}`}`);
    }
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────────
const failedScenarios = results.filter((s) => !s.passed);
const failedPreflight = preflightCases.flatMap((c) => c.checks).filter((k) => !k.ok).length;
const installRefused = results.filter((s) => s.checks.find((c) => c.name.startsWith('a.'))?.ok === false);
const contentLost = results.filter((s) => ['c.', 'd.', 'e.', 'f.'].some((p) => s.checks.find((c) => c.name.startsWith(p))?.ok === false));
const verdict = (formFailed.length || failedScenarios.length || failedPreflight)
  ? `DEFECT — ${[
      formFailed.length ? `${formFailed.length}/4 delivery point(s) override a runner context variable` : '',
      installRefused.length ? `install refused at ${installRefused.length}/${results.length} scenarios` : '',
      contentLost.length ? `consumer content changed at ${contentLost.length}/${results.length} scenarios` : '',
      failedPreflight ? `the collision preflight fails ${failedPreflight} check(s)` : '',
    ].filter(Boolean).join('; ')}`
  : 'clean — the pinned tool is installed outside the consumer, which is left byte-identical';

const report = {
  probe: 'r1-runner-faithful-delivery-probe',
  code: CODE,
  tool_sha: TOOL_SHA,
  runner_semantics: 'actions/runner 2.337.0 — context written OVER step env (ActionRunner:240-252 → NodeScriptActionHandler:42-50 → GitHubContext:49-64)',
  transport: `local bare mirror via url.insteadOf; GIT_ALLOW_PROTOCOL=file (no network)`,
  actions_checkout: CHECKOUT_DIR ? { dir: CHECKOUT_DIR, pinned_review_sha: CHECKOUT_PIN } : null,
  form_contract: formChecks,
  scenarios: results,
  preflight_cases: preflightCases,
  verdict,
};
writeFileSync(path.join(sandboxBase, 'runner-faithful-results.json'), `${JSON.stringify(report, null, 2)}\n`);

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else console.log(`\nverdict: ${report.verdict}\nresults: ${path.join(sandboxBase, 'runner-faithful-results.json')}`);

if (!KEEP && !process.env.DEVBASELINE_SANDBOX_TMP) rmSync(root, { recursive: true, force: true });
else say(`sandbox kept at ${root}`);
process.exit(formFailed.length || failedScenarios.length || failedPreflight ? 1 : 0);

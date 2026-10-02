#!/usr/bin/env node
// R1 root-separation probe — installing the tool must not change the consumer.
//
// Defect (pr-autofix#54): PR #51 replaced the out-of-tree delivery with a pinned
// `actions/checkout … path: pr-autofix` INSIDE the consumer root. From that moment the tool's
// own tree (fixtures included) was part of every consumer's working tree: the shipped
// `check-docs --dir .` reported the tool's fixtures as the CONSUMER's violations (a clean
// repository blocked, needs_human), and autofix's `git add -A` staged the nested git repo as an
// unsolicited `160000` gitlink in the fix commit. The invariant the verdict names:
// «установка не меняет scan/status/diff потребителя».
//
// The probe is driven by the LIVE workflow files, not by a frozen copy of them:
//   1. parse `.github/workflows/devbaseline-callable.yml` / `autofix-callable.yml`,
//   2. render the `${{ }}` expressions the way a runner does,
//   3. emulate `actions/checkout` (consumer fixture / pinned tool tree at `path:`),
//   4. execute the shipped `run:` blocks sequentially in a synthetic consumer with
//      `bash -e -o pipefail`, stop-on-failure and `if: always()` — the runner's own semantics.
//
// Scenarios (verbatim from the acceptance verdict):
//   a. clean consumer + shipped steps → exit 0, 0 violations, gate not blocked;
//   b. controlled failure (broken docs file OF THE CONSUMER) → exit 1, the violation names a
//      consumer path, ZERO violations under pr-autofix/;
//   c. no-change: `git add -A` after delivery + shipped doc-check → empty staged index,
//      zero `160000` entries;
//   d. failed→fix: the REAL scripts/autofix.mjs with ladder/gh/opencode stubs through the
//      shipped autofix step → the fix commit touches only consumer paths, zero tooling gitlink;
//   e. static: all FOUR delivery points (devbaseline/autofix/ci-fix-cleanup callables +
//      templates/batch-fix-prs) relocate the tool tree to $RUNNER_TEMP right after the pinned
//      checkout, and no run: block addresses `pr-autofix/…` outside the $RUNNER_TEMP form.
//
// RED on the unfixed delivery (a, b, c, e fail), GREEN after the fix.
//   node scripts/sandbox/r1-root-separation-probe.mjs [--code <repo>] [--json] [--keep]
// exit 0 = installing the tool leaves the consumer untouched; 1 = defect; 2 = harness error

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = (() => {
  const i = process.argv.indexOf('--code');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.resolve(HERE, '..', '..');
})();
const AS_JSON = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');

const WF_DEV = path.join(CODE, '.github/workflows/devbaseline-callable.yml');
const WF_AUTO = path.join(CODE, '.github/workflows/autofix-callable.yml');
const FOUR = [
  '.github/workflows/devbaseline-callable.yml',
  '.github/workflows/autofix-callable.yml',
  '.github/workflows/ci-fix-cleanup.yml',
  'templates/batch-fix-prs.yml',
];
for (const f of FOUR) {
  if (!existsSync(path.join(CODE, f))) { console.error(`::error::no ${f} in ${CODE} — pass --code <repo>`); process.exit(2); }
}

let TOOL_SHA;
try {
  TOOL_SHA = execFileSync('git', ['-C', CODE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  console.error(`::error::${CODE} is not a git checkout — cannot establish the pinned tool identity`);
  process.exit(2);
}

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

// ── sandbox ─────────────────────────────────────────────────────────────────────
const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'r1-separation-'));
const HOME = path.join(root, 'home');
const fakebin = path.join(root, 'fakebin');
mkdirSync(HOME, { recursive: true });
mkdirSync(fakebin, { recursive: true });

// Stubs that must shadow anything real. Everything else (coreutils, git, node) comes from the
// interpreter's toolchain and /usr/bin — a real runner has a full toolset; what must NOT be real
// here is `gh` (destructive API), `opencode` (would talk to a model) and the ladder endpoint.
writeFileSync(path.join(fakebin, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
const has = s => a.includes(s);
const out = s => process.stdout.write(s);
if (a[0] === 'pr') {
  if (a[1] === 'view') {
    if (has('--json') && a.join(' ').includes('statusCheckRollup'))
      out(JSON.stringify({ state: 'OPEN', statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }));
    else
      out(JSON.stringify({ title: 'fix: failing sum test', body: 'sum returns wrong value', commits: [{ messageHeadline: 'feat change' }] }));
  } else if (a[1] === 'create') out('https://github.com/o/r/pull/2');
  else if (a[1] === 'list') out('[]');
  else out('');
} else if (a[0] === 'api') {
  const joined = a.join(' ');
  if (joined.includes('/logs')) out('npm test\\nnot ok 1 - sum\\nERROR: Process completed with exit code 1\\n');
  else if (joined.includes('/jobs')) out(JSON.stringify([{ id: 1, name: 'test', conclusion: 'failure' }]));
  else out('{}');
} else if (a[0] === 'run') out('not ok 1 - sum\\nERROR: Process completed with exit code 1\\n');
else out('');
`, { mode: 0o755 });
writeFileSync(path.join(fakebin, 'opencode'), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync('src/sum.js', 'module.exports = (a, b) => a + b;\\n');
process.stdout.write('fixed src/sum.js: removed the off-by-one\\n');
`, { mode: 0o755 });

const TOOLCHAIN = path.dirname(process.execPath);
const RUNNER_PATH = `${fakebin}:${TOOLCHAIN}:/usr/bin:/bin`;

// ── yaml / render / if — the runner's semantics ────────────────────────────────
function yamlSteps(file) {
  const py = `
import sys, yaml, json
d = yaml.safe_load(open(sys.argv[1]))
print(json.dumps(d["jobs"], default=str))
`;
  const jobs = JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
  const steps = [];
  for (const [jobName, job] of Object.entries(jobs || {})) {
    for (const s of (job?.steps || [])) steps.push({ ...s, _job: jobName });
  }
  return steps;
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

// `if:` evaluation for the forms these workflows actually use. `steps.*` conditions refer to
// guard steps this harness does not run (duplicate-PR protection) — they are assumed to allow the
// run, which is the path the defect lives on. Everything else defaults to "run".
function evalIf(expr, ctx) {
  const e = String(expr || '').trim();
  if (!e) return true;
  if (e === 'always()') return true;
  let m;
  if ((m = e.match(/^inputs\.([A-Za-z_]\w*)\s*==\s*'(.*)'$/))) return String(ctx.inputs[m[1]] ?? '') === m[2];
  if (/^steps\./.test(e)) return true;
  return true;
}

function stepEnv(step, ctx) {
  const env = {};
  for (const [k, v] of Object.entries(step.env || {})) env[k] = render(String(v), ctx);
  return env;
}

// ── materialisation: the two things actions/checkout does here ─────────────────
// Tool checkout: a COPY of the pinned tree (byte-identical, minus any `.git` of the probe's own
// checkout) plus its own fresh git repo — the same shape actions/checkout leaves behind, and the
// shape consumer `git add -A` reacts to (embedded repo → gitlink).
function materializeTool(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(CODE, dest, { recursive: true, dereference: true, filter: (src) => path.basename(src) !== '.git' });
  const git = (args) => execFileSync('git', args, { cwd: dest, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['-c', 'user.name=Materialize', '-c', 'user.email=materialize@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'pinned tool tree']);
}

function ensureConsumer(workspace, spec) {
  if (existsSync(path.join(workspace, '.git'))) return; // pre-built fixture (scenario d)
  mkdirSync(workspace, { recursive: true });
  for (const [rel, content] of Object.entries(spec.files)) {
    const abs = path.join(workspace, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  const git = (args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
}

// ── executing the shipped steps ────────────────────────────────────────────────
let stepSeq = 0;
function spawnBash(block, { env, cwd }) {
  const script = path.join(root, `step-${String(++stepSeq).padStart(3, '0')}.sh`);
  writeFileSync(script, block, { mode: 0o755 });
  const child = spawn('/usr/bin/bash', ['-e', '-o', 'pipefail', script], { cwd, env });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: timedOut ? 124 : code, stdout, stderr });
    });
  });
}

function baseEnv({ workspace, runnerTemp, extra = {} }) {
  const summary = path.join(runnerTemp, 'step-summary.md');
  if (!existsSync(summary)) writeFileSync(summary, '');
  return {
    PATH: RUNNER_PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: '/dev/null',
    GITHUB_ENV: '/dev/null',
    GITHUB_PATH: '/dev/null',
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_REPOSITORY: 'o/r',
    GH_TOKEN: 'stub-token-synthetic',
    ...extra,
  };
}

// One job = sequential steps over one workspace: stop at the first failure unless the step is
// `if: always()` (the receipt/retention readers of a FAILED gate are exactly the ones worth
// running). `continue-on-error` steps are recorded but do not fail the job — same as the runner.
async function runJob(steps, ctx, { workspace, consumerSpec, extraEnv = {} }) {
  const runnerTemp = path.join(root, `runner-temp-${String(++stepSeq)}`);
  mkdirSync(runnerTemp, { recursive: true });
  const out = [];
  let jobCode = 0;
  let failed = false;
  for (const step of steps) {
    const name = step.name || step.uses || '(unnamed)';
    if (!evalIf(step.if, ctx)) { out.push({ name, skipped: 'if' }); continue; }
    const always = /always\(\)/.test(String(step.if || ''));
    if (failed && !always) { out.push({ name, skipped: 'previous failure' }); continue; }

    if (!step.run) {
      if (/^actions\/checkout@/.test(String(step.uses || ''))) {
        const sub = String((step.with && step.with.path) || '').trim();
        if (sub) {
          materializeTool(path.join(workspace, sub));
          out.push({ name, code: 0, emulated: `tool checkout -> ${sub}` });
        } else {
          ensureConsumer(workspace, consumerSpec);
          out.push({ name, code: 0, emulated: 'consumer checkout' });
        }
        continue;
      }
      out.push({ name, skipped: `uses:${step.uses} not emulated` });
      continue;
    }

    const env = { ...baseEnv({ workspace, runnerTemp, extra: extraEnv }), ...stepEnv(step, ctx) };
    const block = render(step.run, ctx);
    const r = await spawnBash(block, { env, cwd: workspace });
    out.push({ name, code: r.code, stdout: r.stdout, stderr: r.stderr });
    if (r.code !== 0 && !(step['continue-on-error'] === true || step['continue-on-error'] === 'true')) {
      if (jobCode === 0) jobCode = r.code;
      failed = true;
    }
  }
  const output = out.map((s) => `${s.stdout || ''}${s.stderr || ''}`).join('\n');
  return { steps: out, code: jobCode, output, runnerTemp };
}

const gitIn = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ── fixtures ───────────────────────────────────────────────────────────────────
const README = '# clean-consumer\n\nA clean docs consumer: the tool must be invisible to it.\n';
const DOCS_ADAPTER = `${JSON.stringify({ schema_version: 1, profile: 'docs', autofix: { enabled: false } }, null, 2)}\n`;
const specClean = { files: { 'README.md': README, '.devbaseline.json': DOCS_ADAPTER } };
const specBroken = {
  files: {
    'README.md': README,
    '.devbaseline.json': DOCS_ADAPTER,
    // A failure that BELONGS TO THE CONSUMER — the controlled failure of scenario b.
    'docs/config.json': '{ "staging": , }\n',
  },
};

let devSteps;
try { devSteps = yamlSteps(WF_DEV).filter((s) => s._job === 'devbaseline'); } catch (e) {
  console.error(`r1 probe: cannot read ${WF_DEV}: ${e.message}`);
  process.exit(2);
}
let autoSteps;
try { autoSteps = yamlSteps(WF_AUTO).filter((s) => s._job === 'autofix'); } catch (e) {
  console.error(`r1 probe: cannot read ${WF_AUTO}: ${e.message}`);
  process.exit(2);
}

const devCtx = {
  inputs: { mode: 'ci', profile: '', check_timeout_minutes: '20' },
  secrets: { gh_token: 'stub-token-synthetic', llm_ladder_token: 'stub-token', __github_token: 'stub-token-synthetic' },
  vars: {},
  globals: {
    'job.workflow_repository': 'trained-assist/pr-autofix',
    'job.workflow_sha': TOOL_SHA,
    'job.workflow_ref': `trained-assist/pr-autofix/.github/workflows/devbaseline-callable.yml@${TOOL_SHA}`,
    'github.repository': 'o/r',
    'github.token': 'stub-token-synthetic',
    'github.run_id': '1',
    'github.server_url': 'https://github.com',
    'runner.temp': '', // per-run value injected via env by runJob
  },
};

// ── scenario a — clean consumer, the whole shipped job ─────────────────────────
const wsA = path.join(root, 'a-workspace');
{
  const a = await runJob(devSteps, devCtx, { workspace: wsA, consumerSpec: specClean });
  const doc = a.steps.find((s) => s.name === 'Documentation check');
  const gate = a.steps.find((s) => String(s.name || '').startsWith('Gate'));
  const receipt = (() => { try { return JSON.parse(readFileSync(path.join(wsA, 'devbaseline-verify.json'), 'utf8')); } catch { return null; } })();
  check('a. the shipped job exits 0 on a clean consumer', a.code === 0,
    `exit ${a.code}; failed: ${a.steps.filter((s) => s.code).map((s) => `${s.name}(${s.code})`).join(', ') || '—'}`);
  check('a. the documentation check reports 0 violations',
    !!doc && doc.code === 0 && /0 violation\(s\)/.test(`${doc.stdout}${doc.stderr}`),
    `exit=${doc?.code}; ${(doc ? `${doc.stdout}${doc.stderr}` : 'step missing').trim().split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
  check('a. no violation originates from the tool tree',
    !/^docs_\w+: pr-autofix\//m.test(a.output),
    (a.output.match(/^docs_\w+: \S+.*$/m) || ['no violations'])[0].slice(0, 200));
  check('a. the gate did not block',
    !!gate && gate.code === 0 && receipt?.gate?.verdict === 'passed',
    `gate exit=${gate?.code}; verdict=${receipt?.gate?.verdict ?? 'no receipt'}`);
}

// ── scenario b — controlled failure, and it must belong to the CONSUMER ────────
const wsB = path.join(root, 'b-workspace');
{
  const b = await runJob(devSteps, devCtx, { workspace: wsB, consumerSpec: specBroken });
  check('b. the shipped job fails on the consumer\'s broken docs', b.code !== 0, `exit ${b.code}`);
  check('b. the violation names the CONSUMER path',
    /docs_json_invalid: docs\/config\.json/.test(b.output),
    (b.output.match(/^docs_\w+: \S+.*$/m) || ['no violation line'])[0].slice(0, 200));
  check('b. ZERO violations under pr-autofix/',
    !/^docs_\w+: pr-autofix\//m.test(b.output),
    (b.output.match(/^docs_\w+: pr-autofix\/\S+.*$/m) || ['—'])[0].slice(0, 200));
}

// ── scenario c — no-change: delivery must leave a clean index ──────────────────
const wsC = path.join(root, 'c-workspace');
{
  const gateIdx = devSteps.findIndex((s) => String(s.name || '').startsWith('Gate'));
  const upToDocCheck = gateIdx === -1 ? devSteps : devSteps.slice(0, gateIdx);
  await runJob(upToDocCheck, devCtx, { workspace: wsC, consumerSpec: specClean });
  execFileSync('git', ['-C', wsC, 'add', '-A'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const staged = gitIn(wsC, ['diff', '--cached', '--raw']);
  check('c. git add -A after delivery stages nothing', staged === '',
    staged ? staged.split('\n').slice(0, 4).join(' | ').slice(0, 300) : 'empty index');
  check('c. no tooling gitlink (160000) in the index', !/\b160000\b/.test(staged),
    (staged.match(/.*160000.*/) || ['—'])[0].slice(0, 200));
}

// ── scenario d — failed→fix through the SHIPPED autofix step ───────────────────
{
  const origin = path.join(root, 'd-origin.git');
  const wsD = path.join(root, 'd-workspace');
  const g = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '--bare', origin], root);
  g(['clone', '-q', origin, wsD], root);
  g(['config', 'user.email', 't@t'], wsD); g(['config', 'user.name', 't'], wsD);
  g(['checkout', '-q', '-b', 'main'], wsD);
  mkdirSync(path.join(wsD, 'src'), { recursive: true });
  writeFileSync(path.join(wsD, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2) + '\n');
  writeFileSync(path.join(wsD, 'src', 'sum.js'), 'module.exports = (a, b) => a + b + 1;\n');
  writeFileSync(path.join(wsD, 'check.js'), "const sum = require('./src/sum');\nif (sum(2, 3) !== 5) { console.error('not ok 1 - sum'); process.exit(1); }\nconsole.log('ok 1');\n");
  g(['add', '-A'], wsD); g(['commit', '-qm', 'base'], wsD); g(['push', '-q', 'origin', 'main'], wsD);
  g(['checkout', '-q', '-b', 'feat'], wsD);
  writeFileSync(path.join(wsD, 'README.md'), '# fixture\n');
  g(['add', '-A'], wsD); g(['commit', '-qm', 'feat change'], wsD); g(['push', '-q', 'origin', 'feat'], wsD);

  // Stub llm-ladder: the same two roles the real worker answers for this fixture.
  const ladder = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let content = '{}';
      const sys = (() => { try { return JSON.parse(body).messages?.[0]?.content || ''; } catch { return ''; } })();
      if (/PR reviewer/.test(sys)) content = JSON.stringify({ purpose: 'fix the failing sum test', is_clear: true, ambiguity_reason: '' });
      else if (/CI failure analyst/.test(sys)) content = JSON.stringify({ problem: 'sum() adds an extra 1, so the test expecting 5 fails', files_to_examine: [], fix_approach: 'remove the +1 in src/sum.js', confidence: 'high' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 }, choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => ladder.listen(0, '127.0.0.1', r));
  const ladderUrl = `http://127.0.0.1:${ladder.address().port}`;

  const autoCtx = {
    inputs: { pr_number: '1', original_branch: 'feat', run_id: '123' },
    secrets: { gh_token: 'stub-token-synthetic', llm_ladder_token: 'stub-token', __github_token: 'stub-token-synthetic' },
    vars: {
      AUTOFIX_AGENT: '1', AUTOFIX_LADDER: '', AUTOFIX_AGENT_TIMEOUT_MIN: '',
      AUTOFIX_GATE_MAX_FILES: '', AUTOFIX_GATE_MAX_LINES: '',
    },
    globals: {
      'job.workflow_repository': 'trained-assist/pr-autofix',
      'job.workflow_sha': TOOL_SHA,
      'job.workflow_ref': `trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@${TOOL_SHA}`,
      'github.repository': 'o/r',
      'github.token': 'stub-token-synthetic',
      'github.run_id': '1',
      'github.workflow_sha': '211763a98adcf9e350764f12fbf0809543876e99',
      'github.server_url': 'https://github.com',
    },
  };
  // Only the steps that touch the tool tree and the fix: guard/duplicate-PR, npm ci (consumer
  // dependencies — the fixture has none) and artifact upload are outside what R1 is about.
  const wanted = new Set(['Materialize the pinned tool tree', 'Relocate the tool tree out of the consumer root', 'Run autofix pipeline']);
  const dSteps = autoSteps.filter((s) => wanted.has(String(s.name || '')));
  const before = gitIn(wsD, ['rev-parse', 'HEAD']);
  const d = await runJob(dSteps, autoCtx, {
    workspace: wsD,
    consumerSpec: null, // pre-built fixture: the consumer checkout step is a no-op
    extraEnv: {
      LLM_LADDER_URL: ladderUrl,
      AUTOFIX_AGENT_BIN: path.join(fakebin, 'opencode'),
    },
  });
  ladder.close();

  let stats = null;
  try { stats = JSON.parse(readFileSync(path.join(wsD, 'ci-fixer-stats.json'), 'utf8')); } catch { /* no receipt */ }
  check('d. the shipped autofix step ran the real pipeline', dSteps.length >= 2 && d.steps.every((s) => !s.skipped),
    `steps=${d.steps.map((s) => `${s.name}:${s.skipped || s.code}`).join(', ')}`);
  check('d. the fix path reached a success receipt', !!stats && /^success:/.test(String(stats.category || '')),
    `category=${stats?.category ?? 'no receipt'}; step exit=${d.steps.find((s) => s.name === 'Run autofix pipeline')?.code}`);
  const after = gitIn(wsD, ['rev-parse', 'HEAD']);
  check('d. a fix commit was created', after !== before, `before=${before.slice(0, 7)} after=${after.slice(0, 7)}`);
  const raw = (() => { try { return gitIn(wsD, ['diff-tree', '--raw', '-r', before, after]); } catch { return ''; } })();
  const paths = raw.split('\n').filter(Boolean).map((l) => (l.split('\t')[1] || '').replace(/[^A-Za-z0-9_./-]/g, ''));
  check('d. the fix commit touches only CONSUMER paths',
    paths.length > 0 && paths.every((p) => !p.startsWith('pr-autofix/')),
    paths.join(', ') || 'empty diff');
  check('d. the fix commit contains zero tooling gitlink (160000)',
    !raw.split('\n').some((l) => /\b160000\b/.test(l)),
    (raw.split('\n').find((l) => /\b160000\b/.test(l)) || '—').slice(0, 200));
  check('d. the consumer fix itself is present', paths.some((p) => p.includes('src/sum.js')),
    paths.join(', ') || '—');
}

// ── scenario e — static: ALL four delivery points separate the roots ───────────
for (const rel of FOUR) {
  let steps;
  try { steps = yamlSteps(path.join(CODE, rel)); } catch (e) {
    check(`${rel}: parses as YAML`, false, e.message);
    continue;
  }
  const ci = steps.findIndex((s) => /^actions\/checkout@/.test(String(s.uses || '')) && String((s.with && s.with.path) || '').trim() === 'pr-autofix');
  check(`${rel}: the pinned tool checkout (path: pr-autofix) is present`, ci !== -1, 'no tool checkout found');
  const stripRelocated = (t) => String(t).split('$RUNNER_TEMP/pr-autofix').join('');
  const bareRefs = steps.filter((s) => /pr-autofix\//.test(stripRelocated(String(s.run || ''))));
  check(`${rel}: no run: block addresses pr-autofix/ outside $RUNNER_TEMP`, bareRefs.length === 0,
    `${bareRefs.length} step(s), first: ${String(bareRefs[0]?.name || '')}`);
  const mvIdx = steps.findIndex((s, i) => i > ci && /mv "\$GITHUB_WORKSPACE\/pr-autofix" "\$RUNNER_TEMP\/pr-autofix"/.test(String(s.run || '')));
  check(`${rel}: a relocate step moves the tool tree to $RUNNER_TEMP`, ci !== -1 && mvIdx !== -1, `checkout@${ci}, mv@${mvIdx}`);
  const firstToolRun = steps.findIndex((s, i) => i > ci && /pr-autofix\/scripts\//.test(String(s.run || '')));
  check(`${rel}: relocation happens BEFORE the tool is executed`, mvIdx !== -1 && (firstToolRun === -1 || mvIdx < firstToolRun),
    `mv@${mvIdx}, first tool run@${firstToolRun}`);
}

const failed = results.filter((r) => !r.ok);
const out = {
  probe: 'installing the tool never changes the consumer scan/status/diff (artifact-driven)',
  tool_sha: TOOL_SHA,
  steps: { devbaseline: devSteps.map((s) => s.name || '(unnamed)'), autofix: autoSteps.map((s) => s.name || '(unnamed)') },
  checks: results, passed: results.length - failed.length, total: results.length,
  verdict: failed.length ? 'DEFECT — the tool tree enters the consumer root' : 'tool and consumer roots are separated at every delivery point',
};
if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`\nR1 root-separation probe — ${out.passed}/${out.total} checks pass (tool @ ${TOOL_SHA.slice(0, 7)})`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nverdict: ${out.verdict}`);
}
if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(failed.length ? 1 : 0);

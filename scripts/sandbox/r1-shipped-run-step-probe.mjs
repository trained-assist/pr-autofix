#!/usr/bin/env node
// R1 probe — does the SHIPPED cleanup step deliver the script it runs?
//
// The defect (pr-autofix#44): `.github/workflows/ci-fix-cleanup.yml` runs
//   node "$GITHUB_ACTION_PATH/scripts/cleanup-branches.mjs"
// in an ordinary `run:` step, with no delivery of that script. GITHUB_ACTION_PATH is a
// composite-action variable; a reusable workflow's plain run-step never has it. The existing
// regression (`repro-r4-cleanup.mjs`) only asserts the file NAME appears in the YAML, which is why
// a green suite hid the break.
//
// This probe is driven by the ARTIFACT, not by a frozen copy of it:
//   1. parse the live workflow YAML,
//   2. take the cleanup job's steps in order,
//   3. render the `${{ }}` expressions a real runner would render,
//   4. execute the `run:` blocks in an EMPTY consumer runner (empty RUNNER_TEMP, empty workspace,
//      no GITHUB_ACTION_PATH unless the workflow itself establishes one), with a mock `gh`,
//   5. serve the pinned payload over a local HTTP server so a fix that fetches+verifies the
//      pinned tree is exercised for real, end to end.
//
// A correct fix goes GREEN with this probe unchanged. A "liar" fix goes red.
//   node r1-shipped-run-step-probe.mjs [--code <repo>] [--json]
// exit 0 = shipped step works in an empty consumer runner; 1 = defect; 2 = harness error

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, cpSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The repo this probe grades is the checkout the probe itself lives in. Resolving it from
// import.meta.url is the only default that is true on a developer machine AND on a CI runner —
// an absolute path baked in at authoring time is green locally and ENOENT everywhere else, which
// is the same "fix lives on one machine" shape R1 is about.
const CODE = (() => {
  const i = process.argv.indexOf('--code');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.resolve(HERE, '..', '..');
})();
const AS_JSON = process.argv.includes('--json');
const WF = path.join(CODE, '.github/workflows/ci-fix-cleanup.yml');
if (!existsSync(WF)) {
  console.error(`::error::no ${WF} — pass --code <repo>`);
  process.exit(2);
}

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

// ── YAML → the cleanup job's steps ────────────────────────────────────────────────
function parseWorkflow(file) {
  const py = `
import sys, yaml, json
d = yaml.safe_load(open(sys.argv[1]))
job = d["jobs"]["cleanup"]
print(json.dumps(job["steps"], default=str))
`;
  const out = execFileSync('python3', ['-c', py, file], { encoding: 'utf8' });
  return JSON.parse(out);
}

// ── ${{ }} rendering, the way a runner does it ───────────────────────────────────
// The probe's stand-ins for the identity a real reusable-workflow call carries: the pinned
// commit the workflow was CALLED at, and the runner's scratch dir. Declared here (not as
// process.env) because they are known only after the sandbox directories exist.
let PINNED_SHA = () => '';
let RUNNER_TEMP_DIR = () => '';

function render(text, { inputs, secrets }) {
  const GITHUB = { 'github.server_url': 'https://github.com', 'github.repository': 'o/r', 'github.token': secrets.__github_token || '',
    'job.workflow_repository': 'trained-assist/pr-autofix', 'job.workflow_sha': PINNED_SHA(), 'runner.temp': RUNNER_TEMP_DIR() };
  return text.replace(/\$\{\{([^}]*)\}\}/g, (_, expr) => {
    const e = expr.trim();
    let m;
    if ((m = e.match(/^inputs\.([A-Za-z_][\w]*)$/))) return String(inputs[m[1]] ?? '');
    if ((m = e.match(/^secrets\.([A-Za-z_][\w]*)$/))) return String(secrets[m[1]] ?? '');
    // Any remaining `a.b` expression is a runner context value (github.*, job.*, runner.*).
    if ((m = e.match(/^([A-Za-z_][\w]*\.[A-Za-z_][\w.]*)$/))) return String(GITHUB[m[1]] ?? '');
    // ternary used by the shipped step: inputs.dry_run && '--dry-run' || '--no-dry-run'
    if ((m = e.match(/^inputs\.([A-Za-z_][\w]*)\s*&&\s*'([^']*)'\s*\|\|\s*'([^']*)'$/)))
      return (inputs[m[1]] ? m[2] : m[3]);
    if ((m = e.match(/^secrets\.([A-Za-z_][\w]*)\s*\|\|\s*github\.token$/)))
      return String(secrets[m[1]] || secrets.__github_token || '');
    return '';
  });
}

// ── sandbox: empty consumer runner + pinned payload server ──────────────────────
const root = mkdtempSync(path.join(os.tmpdir(), 'r1-shipped-'));
const runnerTemp = path.join(root, 'runner_temp');
const workspace = path.join(root, 'workspace');
const fakebin = path.join(root, 'fakebin');
for (const d of [runnerTemp, workspace, fakebin]) mkdirSync(d, { recursive: true });

// The pinned identity the payload is served under. Shape matches what fetch-payload.mjs
// accepts on loopback: owner/repo/<sha>. A fix that pins must fetch THIS, never a branch.
// A checkout without git cannot establish a pin, so that is a broken HARNESS (exit 2), never a
// verdict — guessing a SHA here would test a delivery of nothing.
let sha;
try {
  sha = execFileSync('git', ['-C', CODE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  console.error(`::error::${CODE} is not a git checkout — cannot establish the pinned SHA`);
  process.exit(2);
}
const PAYLOAD_BASE = `http://127.0.0.1:${0}/trained-assist/pr-autofix/${sha}`;
let port = 0;

const serve = createServer((req, res) => {
  const url = req.url.replace(/^\//, '');
  const base = `trained-assist/pr-autofix/${sha}/`;
  if (!url.startsWith(base)) { res.writeHead(404); res.end('not found'); return; }
  const rel = url.slice(base.length);
  const abs = path.join(CODE, rel);
  if (!abs.startsWith(CODE) || !existsSync(abs) || !require$stat(abs)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(readFileSync(abs));
});
function require$stat(p) { try { return require$fs().statSync(p).isFile(); } catch { return false; } }
function require$fs() { return fsMod; }
import * as fsMod from 'node:fs';

await new Promise(r => serve.listen(0, '127.0.0.1', r));
port = serve.address().port;
const BASE = `http://127.0.0.1:${port}/trained-assist/pr-autofix/${sha}`;
PINNED_SHA = () => sha;
RUNNER_TEMP_DIR = () => runnerTemp;

// mock `gh`: records every call, answers with a branch list that includes main, a branch of
// ANOTHER pr, a kept branch and this PR's own branch. A destructive DELETE is recorded.
const GH_LOG = path.join(root, 'gh-calls.log');
const ghStub = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_LOG)}, a.join(' ') + '\\n');
const mode = fs.readFileSync(${JSON.stringify(path.join(root, 'gh-mode'))}, 'utf8').trim();
if (a[0] === 'api' && a[1].includes('matching-refs')) {
  if (mode === 'api-down') { process.stderr.write('gh: HTTP 403 (simulated)\\n'); process.exit(1); }
  process.stdout.write([
    'refs/heads/pr-autofix-fix/11-a',
    'refs/heads/pr-autofix-fix/22-b',
    'refs/heads/pr-autofix-fix/keep-me',
    'refs/heads/feature/ordinary-branch',
    'refs/heads/main',
  ].join('\\n') + '\\n');
  process.exit(0);
}
if (a[0] === 'api' && a.includes('-X') && a.includes('DELETE')) process.exit(0);
process.exit(0);
`;
writeFileSync(path.join(fakebin, 'gh'), ghStub, { mode: 0o755 });
// Utilities a run-step may reach for. Symlinking them is best-effort on purpose — a missing `sed`
// must not decide the verdict. The TOOLCHAIN below is not best-effort and is checked explicitly.
for (const b of ['bash', 'cat', 'mkdir', 'ls', 'cp', 'sed', 'grep', 'tar', 'git', 'printf'])
  { try { symlinkSync(`/usr/bin/${b}`, path.join(fakebin, b)); } catch { /* optional */ } }

// ── the consumer runner's PATH ───────────────────────────────────────────────────
// "Empty consumer runner" means: no repository checkout, no delivered tool, no
// GITHUB_ACTION_PATH. It does NOT mean "no toolchain" — a real reusable-workflow job runs
// actions/checkout (a node action) and the shipped run-step executes `node …`, so node is
// present by definition.
//
// An earlier version symlinked /usr/bin/node and ignored failure. That is true on a Debian-ish
// dev box and false on a GitHub runner, where node lives under /opt/hostedtoolcache: the symlink
// quietly did not exist, and the simulated step died with `node: command not found` (exit 127) —
// a fault in THIS harness reported as a verdict about the shipped workflow. So the toolchain
// directory comes from the interpreter actually running this probe, and its availability is
// asserted before any step runs (see the guard below). fakebin stays FIRST, so the mock gh and
// the redirected curl still shadow anything real.
const TOOLCHAIN = path.dirname(process.execPath);
const RUNNER_PATH = `${fakebin}:${TOOLCHAIN}`;

function harnessCanRun(bin) {
  const r = spawnSync('/usr/bin/env', ['-i', `PATH=${RUNNER_PATH}`, bin, '--version'], { encoding: 'utf8' });
  return r.status === 0;
}
for (const bin of ['node', 'bash']) {
  if (!harnessCanRun(bin)) {
    console.error(`::error::empty consumer runner cannot resolve ${bin} (PATH=${RUNNER_PATH}) — harness incomplete, not a verdict`);
    process.exit(2);
  }
}

// curl is redirected at the loopback payload server (the pinned raw.githubusercontent URL
// cannot be fetched from a sandbox; the PINNED invariant in fetch-payload.mjs is asserted by
// its own tests, here only the delivery end-to-end is exercised).
// curl is redirected at the loopback payload server. Any pinned-GitHub URL form the shipped
// workflow may use (raw.githubusercontent.com/<o>/<r>/<sha>/… or <server>/<o>/<r>/raw/<sha>/…)
// is rewritten to the local server, so whichever delivery shape the fix chooses is exercised
// for real end to end. Nothing here weakens the PINNED check inside fetch-payload.mjs — that
// code path still sees the pinned base URL the workflow handed it.
const CURL_STUB = `#!/usr/bin/env bash
url=""; out=""
prev=""
for a in "$@"; do
  case "$prev" in
    -o|--output) out="$a" ;;
  esac
  case "$a" in
    -o) prev="-o" ;;
    -o*) out="\${a#-o}" ;;
    http://*|https://*) url="$a"; prev="" ;;
    *) prev="" ;;
  esac
done
if [ -z "$url" ] || [ -z "$out" ]; then exec /usr/bin/curl "$@"; fi
sha="$PROBE_SHA"
rel="$url"
for pat in \
  "https://raw.githubusercontent.com/trained-assist/pr-autofix/$sha/" \
  "https://github.com/o/r/raw/$sha/" \
  "https://github.com/o/r/raw/refs/heads/main/"; do
  case "$rel" in
    "$pat"*) rel="\${rel#$pat}"; break ;;
  esac
done
/usr/bin/curl -fsSL "${BASE}/$rel" -o "$out"
`;
writeFileSync(path.join(fakebin, 'curl'), CURL_STUB.replace('$PROBE_SHA', sha), { mode: 0o755 });
try { symlinkSync('/usr/bin/curl', path.join(fakebin, 'real-curl')); } catch { /* */ }

// ── run the shipped steps ───────────────────────────────────────────────────────
// Each step's `env:` is resolved by the RUNNER, before the script starts — a step whose script
// reads $FOO must find $FOO even though the text appears nowhere in the `run:` block. The probe
// renders those values into the environment AND substitutes them into the block, so a fix that
// relies on `env:` works here exactly as it does on a runner.
function stepEnv(step, inputs, secrets) {
  const env = {};
  for (const [k, v] of Object.entries(step.env || {})) env[k] = render(String(v), { inputs, secrets });
  return env;
}

// The whole job runs as one script: a runner gives every step the same workspace, RUNNER_TEMP,
// mock gh and job env; steps share state through the filesystem. Concatenating them is the
// faithful equivalent of the sequential step list, and it is what lets a delivery step feed the
// run step that follows.
// ASYNC, not spawnSync: the payload server lives in THIS process. A synchronous child blocks the
// event loop, so a step that fetches from the server could never be answered — the probe would
// hang instead of failing. Every spawn is awaited so the server keeps serving.
async function runJob({ inputs, secrets, ghMode, cwd }) {
  const out = [];
  let calls = [];
  for (const step of steps) {
    if (!step.run) {
      // Emulate `uses:` steps the way the runner really does them. actions/checkout materialises
      // the FULL tool tree at the requested ref into the workspace — that is the one delivery
      // shape that cannot half-work, because it brings every import with it. Any other action is
      // recorded as not emulated rather than silently ignored.
      if (/^actions\/checkout@/.test(String(step.uses || ''))) {
        const sub = (step.with && String(step.with.path || '').trim()) || '';
        const dest = sub ? path.join(workspace, sub) : workspace;
        mkdirSync(path.dirname(dest), { recursive: true });
        out.push({ name: step.name || step.uses, emulated: `checkout -> ${path.relative(workspace, dest) || '.'}` });
        cpSync(CODE, dest, { recursive: true, dereference: true, filter: p => !p.includes('/.git/') });
        continue;
      }
      out.push({ name: step.name || step.uses, notEmulated: String(step.uses) });
      continue;
    }
    const env = { ...baseJobEnv, ...stepEnv(step, inputs, secrets) };
    const block = render(step.run, { inputs, secrets });
    const r = await spawnOne(block, { env, secrets, ghMode, cwd: cwd || workspace });
    calls = calls.concat(r.calls);
    out.push({ name: step.name || '(unnamed)', code: r.code, stdout: r.stdout, stderr: r.stderr, env, block });
  }
  return { steps: out, calls, code: out.some(s => s.code) ? out.find(s => s.code).code : 0,
    stdout: out.map(s => s.stdout).join('\n'), stderr: out.map(s => s.stderr).join('\n') };
}

const baseJobEnv = { GITHUB_REPOSITORY: 'o/r' };

function spawnOne(block, { env, secrets, ghMode, cwd }) {
  writeFileSync(path.join(root, 'gh-mode'), ghMode);
  writeFileSync(GH_LOG, '');
  const script = path.join(root, `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(script, block, { mode: 0o755 });
  const r = spawn('/usr/bin/env', ['-i', `PATH=${RUNNER_PATH}`, `HOME=${root}`, `RUNNER_TEMP=${runnerTemp}`,
    `GITHUB_WORKSPACE=${workspace}`, 'GITHUB_ENV=/dev/null', 'GITHUB_OUTPUT=/dev/null',
    'GITHUB_PATH=/dev/null', 'GH_TOKEN=stub-token-synthetic',
    ...Object.entries(env || {}).map(([k, v]) => `${k}=${v}`),
    ...Object.entries(secrets || {}).filter(([k]) => !k.startsWith('__')).map(([k, v]) => `${k}=${v}`),
    '/usr/bin/bash', script],
    { encoding: 'utf8', cwd: cwd || workspace, timeout: 60_000 });
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; r.kill('SIGKILL'); }, 60_000);
    r.stdout.on('data', d => { stdout += d; });
    r.stderr.on('data', d => { stderr += d; });
    r.on('error', e => { clearTimeout(t); resolve({ code: 127, stdout, stderr: stderr + e.message, calls: [] }); });
    r.on('close', code => {
      clearTimeout(t);
      resolve({
        code: timedOut ? 124 : code, stdout, stderr,
        calls: existsSync(GH_LOG) ? readFileSync(GH_LOG, 'utf8').trim().split('\n').filter(Boolean) : [],
      });
    });
  });
}

// ── the scenarios ───────────────────────────────────────────────────────────────
let steps;
try { steps = parseWorkflow(WF); } catch (e) {
  console.error(`r1 probe: cannot read the cleanup job out of ${WF}: ${e.message}`);
  process.exit(2);
}

const runSteps = steps.filter(s => typeof s.run === 'string');
check('the cleanup job declares at least one run step', runSteps.length >= 1, `${runSteps.length} run step(s)`);
// A delivery is EITHER an action that materialises the tree (uses:) OR shell that fetches it.
// The existing regression only greps for the script's NAME, which is why a job with no delivery
// at all passed; here the job must actually bring the tool in.
const deliversViaAction = steps.some(s => !!s.uses);
const deliversViaShell = runSteps.some(s => /fetch-payload|curl -|wget |git clone|tar |unzip /.test(s.run));
check('the cleanup job delivers the tool before running it (checkout/fetch precedes the run)',
  deliversViaAction || deliversViaShell,
  `steps: ${steps.map(s => s.uses ? `uses:${s.uses}` : 'run').join(' → ')}`);

// Scenario A — the shipped happy path: PR 11, dry_run=true.
const IN_A = { pr_number: '11', dry_run: true, keep_branches: '[]' };
const SEC = { gh_token: 'stub-token-synthetic', __github_token: 'stub-token-synthetic' };
const a = await runJob({ inputs: IN_A, secrets: SEC, ghMode: 'ok' });

check('shipped run step succeeds in an empty consumer runner', a.code === 0,
  `exit ${a.code}; stderr: ${a.stderr.trim().split('\n').slice(0, 6).join(' | ').slice(0, 500)}`);
check('the dry run printed a plan (it actually reached the tool)', /would-delete|REFUSED|keep\s/.test(a.stdout),
  a.stdout.trim().split('\n').slice(0, 4).join(' | ').slice(0, 300));
check('the dry run deleted nothing', !a.calls.some(c => c.includes('DELETE')),
  a.calls.filter(c => c.includes('DELETE')).join(' | ') || 'no DELETE call');
check('the plan touches only this PR\'s own fix branch',
  /pr-autofix-fix\/11-a/.test(a.stdout) && !/would-delete pr-autofix-fix\/22-b/.test(a.stdout),
  a.stdout.trim().split('\n').filter(l => /would-delete|REFUSED|delete /.test(l)).join(' | ').slice(0, 300));
check('main is refused, never deleted', /REFUSED\s+main/.test(a.stdout),
  a.stdout.trim().split('\n').filter(l => /main/.test(l)).join(' | ').slice(0, 200));

// Scenario B — an unusable scope must refuse everything AND fail loudly.
// The check is three-part on purpose: `exit !== 0` alone was satisfiable by ANY crash of the
// step (the unbound-variable defect made it "pass" for the wrong reason), and "nothing was
// deleted" alone is also true of a step that died before it could act. What must hold is: the job
// failed, it said why in those words, and no branch was scheduled for deletion.
const b = await runJob({ inputs: { ...IN_A, pr_number: '' }, secrets: SEC, ghMode: 'ok' });
const bSaid = `${b.stdout}\n${b.stderr}`;
check('an unusable pr scope fails the job instead of widening to every branch',
  b.code !== 0
  && /pr_number scope was not usable/.test(bSaid)
  && !/would-delete\s+pr-autofix-fix\/(11|22)/.test(b.stdout),
  `exit ${b.code}; refused-marker=${/pr_number scope was not usable/.test(bSaid)}; would-delete=${b.stdout.match(/would-delete\s*\S+/g)?.join(' ') || '—'}`);
check('every branch is REFUSED, not merely left undeleted (the reason is visible in the plan)',
  /REFUSED\s+pr-autofix-fix\/11-a/.test(b.stdout) && /REFUSED\s+pr-autofix-fix\/22-b/.test(b.stdout),
  b.stdout.trim().split('\n').filter(l => /REFUSED/.test(l)).join(' | ') || 'no REFUSED line');

// Scenario C — the API is down: this is a failure, never "nothing to delete".
const c = await runJob({ inputs: IN_A, secrets: SEC, ghMode: 'api-down' });
check('an API failure is a non-zero exit, not an empty plan', c.code !== 0,
  `exit ${c.code}; stdout: ${c.stdout.trim().split('\n').slice(0, 3).join(' | ')}`);
check('an API failure deletes nothing', !c.calls.some(x => x.includes('DELETE')), 'no DELETE call');

// Scenario D — dry_run=false really deletes, and ONLY what the predicate owns.
const d = await runJob({ inputs: { ...IN_A, dry_run: false }, secrets: SEC, ghMode: 'ok' });
const deleted = d.calls.filter(x => x.includes('DELETE')).map(x => (x.match(/heads\/(\S+)/) || [])[1]);
check('a real run (dry_run=false) deletes exactly the owned branch and nothing else',
  deleted.length === 1 && deleted[0] === 'pr-autofix-fix/11-a',
  `deleted: ${deleted.join(', ') || 'none'}`);

serve.close();
const failed = results.filter(r => !r.ok);
const out = {
  probe: 'the shipped cleanup step delivers what it runs (artifact-driven, empty consumer runner)',
  workflow: path.relative(CODE, WF), pinned_sha: sha,
  steps: steps.map(s => ({ name: s.name || null, uses: s.uses || null, has_run: !!s.run })),
  checks: results, passed: results.length - failed.length, total: results.length,
  verdict: failed.length ? 'DEFECT — the shipped step cannot deliver/run its script in a consumer runner' : 'shipped step works end to end',
};
if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`\nR1 shipped-run-step probe — ${out.passed}/${out.total} checks pass (workflow @ ${sha.slice(0, 7)})`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nverdict: ${out.verdict}`);
}
try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(failed.length ? 1 : 0);
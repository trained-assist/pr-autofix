#!/usr/bin/env node
// R2 probe — a receipt must never wear the CALLER's workflow identity as the tool build.
//
// Defect (pr-autofix#55): `scripts/lib/devbaseline/log.mjs` fell back to
// `GITHUB_WORKFLOW_REF/SHA` when no pin was present, and the shipped gate/inventory steps of
// `devbaseline-callable.yml` never passed `AUTOFIX_WORKFLOW_*`. Inside a reusable workflow
// `github.*` (and the GITHUB_* defaults derived from it) describe the CALLER's workflow — the
// consumer's ci.yml — not the pr-autofix build that actually ran. The receipt then asserted
// `tool.name: pr-autofix, tool.commit: <consumer SHA>` with a fully credible shape: AC-44
// provenance lying in the one field it exists to make true.
//
// Four cases, all read from the SAVED JSON and the LIVE workflow files (not from a frozen copy):
//   1. real reusable env: GITHUB_WORKFLOW_SHA/REF = a distinct consumer 40-hex + ref, no
//      AUTOFIX_* → saved receipt: tool.commit is honest `unpinned:local` (NEVER the caller
//      SHA), tool.version is not the caller's ref tail;
//   2. no pin at all → `unpinned:local` (the honest baseline, unchanged by the fix);
//   3. AUTOFIX_WORKFLOW_* present alongside the same GITHUB_* → the pin WINS (precedence
//      kept by the fix — this is the case the wiring in case 4 relies on);
//   4. static wiring of the LIVE entrypoints: devbaseline-callable passes `job.workflow_ref/
//      sha` into the env of BOTH receipt-writing steps (Gate, Inventory), autofix-callable into
//      the autofix step, and log.mjs contains no GITHUB_WORKFLOW fallback.
//
// RED on the unfixed code (cases 1 and 4 fail), GREEN after the fix.
//   node scripts/sandbox/r2-reusable-receipt-probe.mjs [--json] [--keep]
// exit 0 = the receipt carries only tool identity; 1 = defect; 2 = harness error

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The checkout this probe ships in — resolved from its own location, so it is the same tree on a
// dev machine and on a runner (an authoring-time absolute path would ENOENT on every runner).
const CODE = (() => {
  const i = process.argv.indexOf('--code');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.resolve(HERE, '..', '..');
})();
const AS_JSON = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');

const CLI = path.join(CODE, 'scripts', 'devbaseline.mjs');
const LOG_MJS = path.join(CODE, 'scripts', 'lib', 'devbaseline', 'log.mjs');
const DEVBASELINE_WF = path.join(CODE, '.github', 'workflows', 'devbaseline-callable.yml');
const AUTOFIX_WF = path.join(CODE, '.github', 'workflows', 'autofix-callable.yml');
for (const f of [CLI, LOG_MJS, DEVBASELINE_WF, AUTOFIX_WF]) {
  if (!existsSync(f)) { console.error(`::error::no ${f} — pass --code <repo>`); process.exit(2); }
}

const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'r2-receipt-'));
const HOME = path.join(root, 'home');
mkdirSync(HOME, { recursive: true });

// ── a minimal consumer with a no-op check, exactly as the shipped gate would see one ──
function makeConsumer(name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'README.md'), `# ${name}\n\nClean consumer for the receipt probe.\n`);
  writeFileSync(path.join(dir, '.devbaseline.json'), JSON.stringify({
    schema_version: 1, profile: 'minimal',
    check: { commands: ['true'] }, autofix: { enabled: false },
  }, null, 2));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['add', 'README.md', '.devbaseline.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return dir;
}

// ── run the SHIPPED gate command with a fully controlled env ─────────────────────
// env is built key-by-key (never spread from process.env): on a real runner GITHUB_WORKFLOW_*
// is always present, and case 2 must be able to prove the "no pin at all" world deterministically.
function runGate(consumer, logFile, extraEnv) {
  const env = {
    PATH: process.env.PATH,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME,
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    DEVBASELINE_OFFLINE: '1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [CLI, 'gate', '--repo', '.', '--log', logFile], {
    cwd: consumer, encoding: 'utf8', env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function readReceipt(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

// The identity of a DIFFERENT workflow: the consumer's ci.yml. Two distinct 40-hex values —
// the whole defect is that either one of them can end up in tool.commit.
const CONSUMER_SHA = '211763a98adcf9e350764f12fbf0809543876e99';
const CONSUMER_REF = 'clean-consumer/.github/workflows/ci.yml@refs/heads/main';
const PIN_SHA = 'b0e933b2b597bb97594409a6718e53834d4d45f1';
const PIN_REF = 'trained-assist/pr-autofix@refs/tags/v1.7.8';

const consumer = makeConsumer('provenance-consumer');
const callerEnv = { GITHUB_WORKFLOW_SHA: CONSUMER_SHA, GITHUB_WORKFLOW_REF: CONSUMER_REF };

// ── case 1 — the real reusable-workflow env without the pin ──────────────────────
{
  const logFile = path.join(root, 'case1-receipt.json');
  rmSync(logFile, { force: true });
  const g = runGate(consumer, logFile, callerEnv);
  const rec = readReceipt(logFile);
  check('case1: the gate wrote a readable receipt', !!rec && !!rec.tool, `exit ${g.code}; ${g.out.trim().split('\n').slice(-1).join('')}`);
  if (rec && rec.tool) {
    check('case1: tool.commit is honest unpinned:local, not the caller SHA',
      rec.tool.commit === 'unpinned:local', `tool.commit=${rec.tool.commit} caller=${CONSUMER_SHA}`);
    check('case1: tool.commit never equals the caller workflow SHA',
      rec.tool.commit !== CONSUMER_SHA, `tool.commit=${rec.tool.commit}`);
    check('case1: tool.version is not the caller ref tail',
      rec.tool.version === 'unpinned:local',
      `tool.version=${rec.tool.version} caller-ref=${CONSUMER_REF}`);
  } else {
    check('case1: tool.commit is honest unpinned:local, not the caller SHA', false, 'no receipt');
    check('case1: tool.commit never equals the caller workflow SHA', false, 'no receipt');
    check('case1: tool.version is not the caller ref tail', false, 'no receipt');
  }
}

// ── case 2 — no pin at all (neither AUTOFIX_* nor GITHUB_*) ──────────────────────
{
  const logFile = path.join(root, 'case2-receipt.json');
  rmSync(logFile, { force: true });
  runGate(consumer, logFile, {});
  const rec = readReceipt(logFile);
  check('case2: no pin at all → unpinned:local in both slots',
    !!rec && rec.tool?.commit === 'unpinned:local' && rec.tool?.version === 'unpinned:local',
    `tool=${JSON.stringify(rec?.tool)}`);
}

// ── case 3 — the delivered pin wins over the caller identity (precedence kept) ────
{
  const logFile = path.join(root, 'case3-receipt.json');
  rmSync(logFile, { force: true });
  runGate(consumer, logFile, { ...callerEnv, AUTOFIX_WORKFLOW_SHA: PIN_SHA, AUTOFIX_WORKFLOW_REF: PIN_REF });
  const rec = readReceipt(logFile);
  check('case3: the AUTOFIX pin wins over the caller identity',
    !!rec && rec.tool?.commit === PIN_SHA && rec.tool?.version === 'refs/tags/v1.7.8',
    `tool=${JSON.stringify(rec?.tool)}`);
  check('case3: the caller SHA never leaks into the receipt',
    !!rec && rec.tool?.commit !== CONSUMER_SHA, `tool.commit=${rec?.tool?.commit}`);
}

// ── case 4 — the LIVE wiring: every receipt-writing entrypoint passes the tool pin ──
function parseWorkflow(file) {
  const py = `
import sys, yaml, json
d = yaml.safe_load(open(sys.argv[1]))
print(json.dumps(d["jobs"], default=str))
`;
  return JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
function envOfStep(step) {
  const env = step && step.env && typeof step.env === 'object' ? step.env : {};
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replace(/\s+/g, '')]));
}
function findStep(jobs, namePrefix) {
  for (const job of Object.values(jobs || {})) {
    for (const step of (job?.steps || [])) {
      if (String(step.name || '').startsWith(namePrefix)) return step;
    }
  }
  return null;
}
{
  let devJobs = null; let autoJobs = null;
  try { devJobs = parseWorkflow(DEVBASELINE_WF); } catch { /* reported below */ }
  try { autoJobs = parseWorkflow(AUTOFIX_WF); } catch { /* reported below */ }
  check('case4: devbaseline-callable.yml parses', !!devJobs, 'YAML');
  check('case4: autofix-callable.yml parses', !!autoJobs, 'YAML');

  const gateEnv = envOfStep(findStep(devJobs, 'Gate'));
  check('case4: the Gate step passes AUTOFIX_WORKFLOW_REF=${{ job.workflow_ref }}',
    gateEnv.AUTOFIX_WORKFLOW_REF === '${{job.workflow_ref}}', `env=${JSON.stringify(gateEnv)}`);
  check('case4: the Gate step passes AUTOFIX_WORKFLOW_SHA=${{ job.workflow_sha }}',
    gateEnv.AUTOFIX_WORKFLOW_SHA === '${{job.workflow_sha}}', `env=${JSON.stringify(gateEnv)}`);

  const invEnv = envOfStep(findStep(devJobs, 'Inventory row'));
  check('case4: the Inventory step passes AUTOFIX_WORKFLOW_REF=${{ job.workflow_ref }}',
    invEnv.AUTOFIX_WORKFLOW_REF === '${{job.workflow_ref}}', `env=${JSON.stringify(invEnv)}`);
  check('case4: the Inventory step passes AUTOFIX_WORKFLOW_SHA=${{ job.workflow_sha }}',
    invEnv.AUTOFIX_WORKFLOW_SHA === '${{job.workflow_sha}}', `env=${JSON.stringify(invEnv)}`);

  const autoEnv = envOfStep(findStep(autoJobs, 'Run autofix'));
  check('case4: the autofix step keeps AUTOFIX_WORKFLOW_REF/SHA on the tool pin',
    autoEnv.AUTOFIX_WORKFLOW_REF === '${{job.workflow_ref}}' && autoEnv.AUTOFIX_WORKFLOW_SHA === '${{job.workflow_sha}}',
    `env=${JSON.stringify(autoEnv)}`);

  const logSrc = readFileSync(LOG_MJS, 'utf8');
  check('case4: log.mjs contains no GITHUB_WORKFLOW fallback',
    !logSrc.includes('GITHUB_WORKFLOW'), 'log.mjs still reads GITHUB_WORKFLOW_*');
}

const failed = results.filter(r => !r.ok);
const out = {
  probe: 'the receipt carries tool identity, never the caller workflow identity',
  code: CODE,
  checks: results, passed: results.length - failed.length, total: results.length,
  verdict: failed.length ? 'DEFECT — the receipt can wear the caller workflow identity as the tool build' : 'receipt carries only tool identity',
};
if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`\nR2 reusable-receipt probe — ${out.passed}/${out.total} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nverdict: ${out.verdict}`);
}
if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(failed.length ? 1 : 0);

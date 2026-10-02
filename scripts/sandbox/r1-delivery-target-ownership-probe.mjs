#!/usr/bin/env node
// R1 delivery-target OWNERSHIP probe — the target may be replaced only with proven ownership
// (pr-autofix#70, blocker R1 of the it.6 cross-review).
//
// The collision preflight used to decide ownership by one predicate: "`.git` exists there → it
// is our previous checkout → `rm -rf` it". Any foreign Git checkout at $RUNNER_TEMP/pr-autofix
// (an orphan of another step, a reused self-hosted runner, a clone of an unrelated project) was
// therefore silently destroyed in all four delivery points — tracked, untracked and symlinked
// data alike. The fix states one rule everywhere: the target is replaced ONLY when ownership is
// proven — the delivery marker `.git/pr-autofix-delivery` names $TOOL_REPOSITORY AND origin is
// the tool repository, the target is not a symlink and `.git` is a directory. Everything else
// is refused BEFORE any write; nothing is renamed, nothing is bypassed.
//
// This probe executes the SHIPPED, UNMODIFIED `run:` blocks (preflight + materialize) of all
// four delivery points against a state matrix:
//
//   empty   — no target: the tool installs at the pinned SHA and writes its marker (the normal
//             path must not turn into a refusal), and a SECOND install over it passes too —
//             the policy is idempotent for our own checkout.
//   ours    — our previous install (marker + our origin) with a dirty untracked file inside:
//             allowed, reinstalled at the pin.
//   foreign — a Git checkout owned by SOMEBODY ELSE (foreign origin, committed + uncommitted
//             files, a symlink): refused, byte-identical afterwards. THE red control — this
//             exact case was destroyed 4/4 on the it.6 merge 2daff54.
//   legacy  — our origin but NO marker (an install of the old form): refused fail-closed,
//             byte-identical (the documented operator-facing trade of the fix).
//   plain   — a directory without `.git` (the only case the old regression covered): refused.
//   symlink — a symlink at the target: refused, the link and its target intact.
//
// Plus a static CLASS SCAN: the ownership guard must be textually identical in all four files
// (drift between the inline copies is the maintenance cost of this design), every `rm -rf
// "$target"` must sit behind that guard, and `scripts/autofix.mjs` must not contain delivery
// materialization or cleanup of a path it does not own.
//
// Fully offline: the tool repository is a local bare mirror reached through
// `url.<mirror>.insteadOf`, GIT_ALLOW_PROTOCOL=file refuses any network transport, no tokens,
// no live profiles. Fixtures live under `.devbaseline-sandbox/` (gitignored).
//
//   node scripts/sandbox/r1-delivery-target-ownership-probe.mjs [--code <repo>] [--json] [--keep]
// exit 0 = contract holds (foreign survives, ours installs, guard identical);
//      1 = defect reproduced / drift found;
//      2 = harness error
//
// Red on 2daff54 (it.6 merge): foreign destroyed at 4/4 points, no marker ever written.

import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync,
  readdirSync, rmSync } from 'node:fs';
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
const KEEP = process.argv.includes('--keep');
const AS_JSON = process.argv.includes('--json');

const FOUR = [
  '.github/workflows/devbaseline-callable.yml',
  '.github/workflows/autofix-callable.yml',
  '.github/workflows/ci-fix-cleanup.yml',
  'templates/batch-fix-prs.yml',
];
const PREFLIGHT = 'Delivery target is outside the consumer tree';
const MATERIALIZE = 'Materialize the pinned tool tree';
const TOOL_REPO = 'trained-assist/pr-autofix';
const FOREIGN_ORIGIN = 'https://example.invalid/another-project.git';

const die = (msg) => { console.error(`::error::${msg}`); process.exit(2); };

for (const f of FOUR) if (!existsSync(path.join(CODE, f))) die(`no ${f} in ${CODE} — pass --code <pr-autofix checkout>`);
if (!existsSync(path.join(CODE, 'scripts', 'autofix.mjs'))) die(`no scripts/autofix.mjs in ${CODE}`);

let TOOL_SHA;
try { TOOL_SHA = execFileSync('git', ['-C', CODE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
catch { die(`${CODE} is not a git checkout — cannot establish the pinned tool identity`); }

const SANDBOX = process.env.DEVBASELINE_SANDBOX_TMP || path.join(CODE, '.devbaseline-sandbox');
mkdirSync(SANDBOX, { recursive: true });
const ROOT = path.join(SANDBOX, `ownership-${process.pid}-${Date.now()}`);
mkdirSync(ROOT, { recursive: true });
const say = (s) => console.log(s);

// ── yaml: the shipped steps, parsed exactly as the runner reads them ──────────────
function yamlSteps(file) {
  const py = `
import sys, yaml, json
d = yaml.safe_load(open(sys.argv[1]))
steps = [s for j in (d.get("jobs") or {}).values() for s in (j.get("steps") or [])]
print(json.dumps(steps, default=str))
`;
  return JSON.parse(execFileSync('python3', ['-c', py, path.join(CODE, file)],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
}
const findStep = (steps, name) => steps.find((s) => s.name === name) || null;

// ── offline tool mirror: pinned-SHA fetches must work without the network ─────────
const MIRROR = path.join(ROOT, 'tool.git');
try {
  execFileSync('git', ['clone', '--bare', '--quiet', CODE, MIRROR], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-C', MIRROR, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
} catch (e) { die(`cannot build the local tool mirror: ${e.message}`); }

// ── execution of one shipped run: block ───────────────────────────────────────────
function runBlock(step, { caseDir, ws, rt }) {
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
    LANG: process.env.LANG || 'C.UTF-8',
    HOME: caseDir,                       // isolated: no user/system git config leaks in
    GITHUB_WORKSPACE: ws,
    RUNNER_TEMP: rt,
    TOOL_REPOSITORY: TOOL_REPO,          // both steps declare it in env: (the runner resolves it)
    TOOL_SHA,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${MIRROR}.insteadOf`,
    GIT_CONFIG_VALUE_0: `https://github.com/${TOOL_REPO}.git`,
    GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0',
  };
  const script = path.join(caseDir, `block-${Math.random().toString(36).slice(2, 8)}.sh`);
  writeFileSync(script, step.run, { mode: 0o755 });
  const child = spawn('/usr/bin/bash', ['-e', '-o', 'pipefail', script], { cwd: ws, env });
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code: timedOut ? 124 : code, stdout, stderr }); });
  });
}

// ── fingerprints: identity of the target INCLUDING .git (a substituted checkout must show) ─
function fingerprint(p) {
  const out = {};
  const walk = (abs, rel) => {
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (st.isSymbolicLink()) { out[rel] = 'L -> ' + readlinkSync(abs); return; }
    if (st.isDirectory()) {
      out[rel + '/'] = 'D';
      for (const e of readdirSync(abs).sort()) walk(path.join(abs, e), rel ? `${rel}/${e}` : e);
      return;
    }
    out[rel] = 'F ' + createHash('sha256').update(readFileSync(abs)).digest('hex');
  };
  if (!existsSync(p) && !lstatSyncSafe(p)) return { __absent__: true };
  walk(p, '');
  return out;
}
const lstatSyncSafe = (p) => { try { lstatSync(p); return true; } catch { return false; } };
// Structural equality of two fingerprints. `===` on freshly built objects compares references
// and is ALWAYS false — which would have turned this probe into a machine for reporting defects
// that are not there (it did, until this line existed).
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitMaybe(args, cwd) {
  try { return git(args, cwd); } catch { return null; }
}
const identity = (target) => ({
  head: gitMaybe(['rev-parse', 'HEAD'], target),
  origin: gitMaybe(['config', '--get', 'remote.origin.url'], target),
});

// ── case fixtures ─────────────────────────────────────────────────────────────────
function makeCase(state) {
  const caseDir = path.join(ROOT, `${state}-${Math.random().toString(36).slice(2, 8)}`);
  const ws = path.join(caseDir, 'ws');
  const rt = path.join(caseDir, 'rt');
  mkdirSync(ws, { recursive: true });
  mkdirSync(rt, { recursive: true });
  writeFileSync(path.join(ws, 'consumer-sentinel.txt'), 'the consumer this probe leaves alone\n');
  const target = path.join(rt, 'pr-autofix');
  const marker = path.join(target, '.git', 'pr-autofix-delivery');

  if (state === 'foreign') {
    git(['init', '-q', target]);
    git(['-C', target, 'remote', 'add', 'origin', FOREIGN_ORIGIN]);
    writeFileSync(path.join(target, 'foreign-tracked.txt'), 'committed in a repo that is not ours\n');
    git(['-C', target, 'add', '-A']);
    execFileSync('git', ['-C', target, '-c', 'user.email=p@example.invalid', '-c', 'user.name=p',
      'commit', '-q', '-m', 'foreign'], { stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(target, 'uncommitted-user-work.txt'), 'must survive; unrelated git repository\n');
    const outside = path.join(caseDir, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'precious.txt'), 'must survive; reachable only through the symlink\n');
    execFileSync('ln', ['-s', outside, path.join(target, 'link-to-outside')]);
  } else if (state === 'ours') {
    // A previous install of THIS tool, made dirty — the legitimate repeat case (T2).
    git(['init', '-q', target]);
    git(['-C', target, 'remote', 'add', 'origin', `https://github.com/${TOOL_REPO}.git`]);
    writeFileSync(path.join(target, 'tool-leftover.txt'), 'our previous install, uncommitted\n');
    git(['-C', target, 'add', '-A']);
    execFileSync('git', ['-C', target, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-q', '-m', 'ours'], { stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(marker, `repo=${TOOL_REPO}\n`);
    writeFileSync(path.join(target, 'dirty-untracked.txt'), 'dirty state inside OUR checkout\n');
  } else if (state === 'legacy') {
    // Same shape as our install, but no marker: the form that shipped before this fix.
    git(['init', '-q', target]);
    git(['-C', target, 'remote', 'add', 'origin', `https://github.com/${TOOL_REPO}.git`]);
    writeFileSync(path.join(target, 'legacy-tracked.txt'), 'installed before the marker existed\n');
    git(['-C', target, 'add', '-A']);
    execFileSync('git', ['-C', target, '-c', 'user.email=l@example.invalid', '-c', 'user.name=l',
      'commit', '-q', '-m', 'legacy'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else if (state === 'plain') {
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'keep.md'), 'a directory without .git\n');
  } else if (state === 'symlink') {
    const obstacle = path.join(rt, 'obstacle');
    mkdirSync(obstacle, { recursive: true });
    writeFileSync(path.join(obstacle, 'keep.md'), 'the symlink target this probe protects\n');
    execFileSync('ln', ['-s', 'obstacle', target]);
  } // empty: no target at all
  return { caseDir, ws, rt, target };
}

const installed = (target, pre, mat) => {
  const head = gitMaybe(['rev-parse', 'HEAD'], target);
  const origin = gitMaybe(['config', '--get', 'remote.origin.url'], target);
  let marker = null;
  try { marker = readFileSync(path.join(target, '.git', 'pr-autofix-delivery'), 'utf8').trim(); }
  catch { marker = null; }
  return {
    ok: pre.code === 0 && mat.code === 0 && head === TOOL_SHA
      && origin === `https://github.com/${TOOL_REPO}.git` && marker === `repo=${TOOL_REPO}`,
    head, origin, marker,
  };
};

// ── one scenario: preflight, then materialize (only if the preflight passed) ───────
async function scenario(wf, state) {
  const pre = findStep(yamlSteps(wf), PREFLIGHT);
  const mat = findStep(yamlSteps(wf), MATERIALIZE);
  if (!pre || !mat) return { workflow: wf, state, fatal: `steps not found in ${wf}` };

  const c = makeCase(state);
  const wsBefore = fingerprint(c.ws);
  const targetBefore = fingerprint(c.target);
  const identityBefore = (state === 'foreign' || state === 'legacy' || state === 'ours') ? identity(c.target) : null;

  const preR = await runBlock(pre, c);
  let matR = null;
  if (preR.code === 0) matR = await runBlock(mat, c);   // on a real runner materialize would not run
  // Idempotent repeat of the chosen policy: the SAME pair runs a second time in-place.
  const preR2 = await runBlock(pre, c);
  const matR2 = preR2.code === 0 ? await runBlock(mat, c) : null;

  const targetAfter = fingerprint(c.target);
  const wsAfter = fingerprint(c.ws);
  const identityAfter = (state === 'foreign' || state === 'legacy' || state === 'ours') ? identity(c.target) : null;
  const refused = (r) => r && r.code !== 0 && /refusing/.test(r.stdout + r.stderr);
  const combined = `${preR.stdout}${preR.stderr}${matR ? matR.stdout + matR.stderr : ''}`;

  let ok = false, detail = '', evidence = {};
  if (state === 'empty' || state === 'ours') {
    const first = installed(c.target, preR, matR);
    const second = matR2 ? installed(c.target, preR2, matR2)
      : { ok: false, head: null, origin: null, marker: null };
    ok = same(wsBefore, wsAfter) && first.ok && preR2.code === 0 && second.ok;
    detail = ok ? 'installed at the pin, marker written, repeat install passes'
      : `first: pre=${preR.code} mat=${matR && matR.code} head=${first.head} marker=${first.marker}; repeat: pre=${preR2.code} mat=${matR2 && matR2.code}`;
    evidence = { first, repeat: { pre: preR2.code, mat: matR2 && matR2.code, second } };
  } else {
    const survived = same(targetBefore, targetAfter) && same(identityBefore, identityAfter);
    const explicitlyRefused = refused(preR) || (matR && refused(matR));
    ok = survived && explicitlyRefused && same(wsBefore, wsAfter);
    const destroyed = Object.keys(targetBefore).filter((k) => targetAfter[k] !== targetBefore[k]);
    detail = survived
      ? (explicitlyRefused ? 'refused before any write, byte-identical' : 'NOT refused (silent pass)')
      : (targetAfter.__absent__ ? 'target vanished (rm -rf)' : `target changed: ${destroyed.length} path(s)`);
    evidence = { identity_before: identityBefore, identity_after: identityAfter,
      destroyed_count: destroyed.length, destroyed_paths: destroyed.slice(0, 16),
      preflight_exit: preR.code, delivery_exit: matR && matR.code, refusal: explicitlyRefused };
  }

  const r = { workflow: wf, state, preflight_exit: preR.code, delivery_exit: matR && matR.code,
    repeat_preflight_exit: preR2.code, repeat_delivery_exit: matR2 && matR2.code,
    ok, detail, evidence,
    output: combined.slice(-900) };
  if (!KEEP) rmSync(c.caseDir, { recursive: true, force: true });
  return r;
}

// ── class scan: the rule is one text in four copies, rm behind the guard, autofix clean ─
function classScan() {
  const findings = [];
  const note = (m) => findings.push(m);
  const blocks = [];

  for (const f of FOUR) {
    const text = readFileSync(path.join(CODE, f), 'utf8');
    const lines = text.split('\n');
    const starts = lines.map((l, i) => (l.includes('# OWNERSHIP GUARD') ? i : -1)).filter((i) => i !== -1);
    if (starts.length !== 2) {
      note(`${f}: expected the ownership guard in the preflight AND the materialize step, found ${starts.length}`);
      continue;
    }
    for (const s of starts) {
      let e = s;
      while (e < lines.length && lines[e] !== '          fi') e++;
      if (e >= lines.length) { note(`${f}: ownership guard starting at line ${s + 1} has no closing fi`); continue; }
      blocks.push({ file: f, text: lines.slice(s, e + 1).map((l) => l.trim()).join('\n') });
    }
    // every destructive write sits behind the guard. The marker is written AFTER the install by
    // design (an install that died leaves no claim on the target), so its presence is checked on
    // the materialize step below — not relative to the `rm -rf`.
    const rmLines = lines.map((l, i) => (l.includes('rm -rf "$target"') ? i : -1)).filter((i) => i !== -1);
    if (rmLines.length !== 1) note(`${f}: expected exactly one rm -rf "$target", found ${rmLines.length}`);
    for (const i of rmLines) {
      if (!starts.some((s) => s < i)) note(`${f}: rm -rf "$target" at line ${i + 1} is not behind an ownership guard`);
    }
    // both steps carry the guard, and the preflight declares TOOL_REPOSITORY in env
    const steps = yamlSteps(f);
    const pre = findStep(steps, PREFLIGHT);
    const mat = findStep(steps, MATERIALIZE);
    if (!pre || !String(pre.run || '').includes('OWNERSHIP GUARD')) note(`${f}: the preflight step does not run the ownership guard`);
    if (!mat || !String(mat.run || '').includes('OWNERSHIP GUARD')) note(`${f}: the materialize step does not run the ownership guard`);
    if (!mat || !String(mat.run || '').includes('pr-autofix-delivery')) note(`${f}: the materialize step does not write the ownership marker`);
    if (!pre || !(pre.env && pre.env.TOOL_REPOSITORY)) note(`${f}: the preflight step does not declare env.TOOL_REPOSITORY (the guard reads it under set -u)`);
  }

  if (blocks.length === 8) {
    const norm = blocks.map((b) => b.text);
    if (!norm.every((t) => t === norm[0])) {
      const distinct = [...new Set(norm)];
      note(`the ownership guard drifted: ${distinct.length} distinct variants across ${blocks.length} copies`);
    }
  } else if (blocks.length) {
    note(`expected 8 guard copies (2 per file × 4 files), found ${blocks.length}`);
  }

  // scripts/autofix.mjs must not materialize or clean a path it does not own. `git clean` in the
  // fixer runs INSIDE the consumer checkout (its cwd is the consumer's repo), so a bare clean is
  // within the tree the fixer legitimately owns; what must never appear is a clean or rm aimed at
  // a path OUTSIDE that tree — the delivery target, RUNNER_TEMP, an absolute path or `..`.
  const autofix = readFileSync(path.join(CODE, 'scripts', 'autofix.mjs'), 'utf8');
  if (/rm -rf/.test(autofix)) note('scripts/autofix.mjs contains `rm -rf` — the fixer must not clear paths it does not own');
  if (/RUNNER_TEMP/.test(autofix)) note("scripts/autofix.mjs references RUNNER_TEMP — delivery targets are the workflows' concern");
  if (/remote add origin/.test(autofix)) note('scripts/autofix.mjs materializes a git repository — not its job');
  autofix.split('\n').forEach((l, i) => {
    if (!/git\s+clean/.test(l)) return;
    const args = l.replace(/.*git\s+clean/, '');
    const outside = /(RUNNER_TEMP|\bpr-autofix\b|\.\.|^\s*['"]\s*\/)/.test(args);
    if (outside) note(`scripts/autofix.mjs:${i + 1}: git clean aimed outside the consumer tree: ${l.trim().slice(0, 140)}`);
  });

  return findings;
}

// ── run the matrix ────────────────────────────────────────────────────────────────
const results = [];
console.log(`code: ${CODE}\ntool sha: ${TOOL_SHA}\ntransport: local bare mirror via url.insteadOf; GIT_ALLOW_PROTOCOL=file (no network)\n`);
const STATES = ['empty', 'ours', 'foreign', 'legacy', 'plain', 'symlink'];
for (const wf of FOUR) {
  for (const state of STATES) {
    const r = await scenario(wf, state);
    if (r.fatal) die(r.fatal);
    results.push(r);
    say(`${r.ok ? 'ok  ' : 'FAIL'} ${wf} [${r.state}] pre=${r.preflight_exit} mat=${r.delivery_exit} repeat=${r.repeat_preflight_exit}/${r.repeat_delivery_exit} — ${r.detail}`);
  }
}

const scanFindings = classScan();
console.log(`\nclass scan: ${scanFindings.length ? 'DRIFT/DEFECT' : 'guard identical in 4 files, rm behind guard, autofix.mjs clean'}`);
for (const f of scanFindings) say(`  FAIL ${f}`);

const failed = results.filter((r) => !r.ok);
const byState = {};
for (const r of results) { byState[r.state] = byState[r.state] || { ok: 0, total: 0 }; byState[r.state].total++; if (r.ok) byState[r.state].ok++; }
const verdict = (failed.length || scanFindings.length)
  ? `DEFECT — ${[
      failed.length ? `ownership contract broken in ${failed.length}/${results.length} scenario(s): ${[...new Set(failed.map((r) => `${r.state}@${r.workflow}`))].slice(0, 6).join(', ')}` : '',
      scanFindings.length ? `${scanFindings.length} class-scan finding(s)` : '',
    ].filter(Boolean).join('; ')}`
  : `clean — foreign/legacy/plain/symlink refused byte-identical at 4/4 points, empty and our own checkout install at the pin (repeat passes), guard identical in 4 copies`;

const report = { probe: 'r1-delivery-target-ownership-probe', code: CODE, tool_sha: TOOL_SHA,
  transport: 'local bare mirror via url.insteadOf; GIT_ALLOW_PROTOCOL=file (no network)',
  states: STATES, by_state: byState, cases: results, class_scan: { findings: scanFindings },
  verdict };
const outPath = path.join(SANDBOX, 'ownership-results.json');
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
console.log(`\nverdict: ${verdict}\nresults: ${outPath}`);

if (!KEEP && !process.env.DEVBASELINE_SANDBOX_TMP) rmSync(ROOT, { recursive: true, force: true });
else say(`sandbox kept at ${ROOT}`);
process.exit(failed.length || scanFindings.length ? 1 : 0);

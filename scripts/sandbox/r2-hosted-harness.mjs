#!/usr/bin/env node
// R2 hosted harness — a REAL shipped workflow, a REAL failed→fix→verify cycle, and evidence
// taken on the runner itself (pr-autofix#71, blocker R2 of the it.6 cross-review).
//
// The it.6 reviewer's complaint is precise and it is not about "is failed→fix broken": it is that
// no run of a SHIPPED workflow ever received a failing check, produced a fix, re-verified and
// presented the patch — so nothing about the cycle was proven, and `git/trees/HEAD` of a deleted
// repo proves only what was COMMITTED (never that untracked data on the runner survived, or that
// the fix commit carries no extra staged paths). A local PASS does not substitute for that: local
// sandboxes invert the runner by construction.
//
// This harness is the reusable procedure — setup → run → evidence → teardown — against an
// isolated DISPOSABLE consumer. Phases:
//
//   setup     create the disposable consumer + push a commit whose CI (a) fails in a controlled
//             way and (b) calls the shipped `devbaseline-callable.yml` at the pinned tool SHA;
//   run       dispatch, wait for the failing check, read the fix run;
//   evidence  collect, FROM THE RUNNER: tracked/untracked/symlink fingerprints, `git status`,
//             the index, the exact allowlist of changed files in the fix commit, the absence of
//             a tooling gitlink, caller SHA + tool SHA, run metadata, sanitized logs, the receipt
//             and the patch. Written to a DURABLE directory BEFORE teardown — the consumer is
//             disposable, its evidence is not;
//   teardown  delete the consumer only after the bundle exists on disk.
//
// Self-test (`--self-test`) runs the whole decision logic offline against a synthetic consumer
// and a synthetic run: no network, no repository, no token. It proves the harness can detect a
// gitlink, an extra staged path and a destroyed untracked file — the three things a remote tree
// cannot show — and that it refuses to tear down before the bundle is durable (the red control).
//
//   node scripts/sandbox/r2-hosted-harness.mjs --self-test [--json]
//   node scripts/sandbox/r2-hosted-harness.mjs --run --evidence-out <dir> [--repo <name>]
//     [--tool-sha <sha>] [--consumer-root <dir>] [--keep]
// exit 0 = contract holds; 1 = defect/evidence incomplete; 2 = harness error
//
// Requires a token for the live phases: `gh auth token` (GH_TOKEN) with workflow + contents
// rights on the org. Nothing is written to a repository that is not disposable.

import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, readlinkSync,
  readdirSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.resolve(HERE, '..', '..');
const flag = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const SELF_TEST = process.argv.includes('--self-test');
const RUN = process.argv.includes('--run');
const AS_JSON = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');
const REPO = flag('--repo', 'pr-autofix-r2-hosted');
const TOOL_SHA = flag('--tool-sha') || gitOut(['-C', CODE, 'rev-parse', 'HEAD']);
const EVIDENCE_OUT = flag('--evidence-out');
const CONSUMER_ROOT = flag('--consumer-root');

// Inside the live run a failure must be an exception, not process.exit: only unwinding reaches
// the finally below, and that is what deletes the disposable consumer instead of leaking it.
// Outside it (argument checks, self-test) an immediate exit is correct — nothing was created.
let livePhase = false;
const die = (msg) => {
  if (livePhase) throw new Error(msg);
  console.error(`::error::${msg}`);
  process.exit(2);
};
function gitOut(args, cwd) {
  try { return spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim(); }
  catch { return null; }
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const say = (s) => console.log(s);

// ── the runner-side state probe: what a remote tree can NEVER show ────────────────
// Tracked, untracked and symlinked content are three different identities: a committed file can
// be replaced, an uncommitted file deleted, a symlink re-pointed — and only the runner's own
// filesystem before/after the run tells that apart.
function fingerprintTree(dir, { skipGit = false } = {}) {
  const out = {};
  const walk = (abs, rel) => {
    let st;
    try { st = lstatSync(abs); } catch { return; }
    if (!skipGit && rel.split('/').includes('.git')) return;
    if (st.isSymbolicLink()) { out[rel] = 'L -> ' + readlinkSync(abs); return; }
    if (st.isDirectory()) {
      out[rel + '/'] = 'D';
      for (const e of readdirSync(abs).sort()) walk(path.join(abs, e), rel ? `${rel}/${e}` : e);
      return;
    }
    out[rel] = 'F ' + sha256(readFileSync(abs));
  };
  walk(dir, '');
  return out;
}
const gitState = (dir) => ({
  status_porcelain: gitOut(['-C', dir, 'status', '--porcelain']),
  index: gitOut(['-C', dir, 'ls-files', '-s']),
  untracked: (gitOut(['-C', dir, 'ls-files', '--others', '--exclude-standard']) || '').split('\n').filter(Boolean),
  gitlinks: (gitOut(['-C', dir, 'ls-files', '-s']) || '').split('\n').filter((l) => l.startsWith('160000')),
});

// ── the verdict logic, shared by the self-test and the live run ────────────────────
// ALLOWLIST: the fix commit may touch the consumer's own files and the baseline artifacts it is
// supposed to write. Anything else — a nested repository of ours, a fixture of ours, a path of
// the delivery target — is a leak, and no amount of "the tests passed" excuses it.
// The consumer's own tracked files are the fix's SUBJECT: `broken/bad.md` is what the fixer
// rewrites, so a fix that leaves it alone never happened. What must not change is everything the
// consumer owned that the fixer had no business touching — its other tracked files, its untracked
// work and its symlinks.
const ALLOWLIST_PREFIXES = ['.devbaseline/', 'docs/', 'README.md'];
const FIX_SUBJECT_PREFIXES = ['.devbaseline/', 'docs/', 'broken/'];
const isFixSubject = (f) => FIX_SUBJECT_PREFIXES.some((p) => f === p || f.startsWith(p));
// The fix commit may touch the artifacts the baseline writes AND the fix's own subject —
// the consumer file the failing check pointed at. Anything else (scripts, other tracked
// consumer files, a path of ours) is a leak even when every test passed.
const COMMIT_ALLOWED = [...new Set([...ALLOWLIST_PREFIXES, ...FIX_SUBJECT_PREFIXES])];
function judgeFix({ fixFiles = [], runnerBefore = null, runnerAfter = null, evidence = {} }) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  const outside = fixFiles.filter((f) => !COMMIT_ALLOWED.some((p) => f === p || f.startsWith(p)));
  add('the fix commit touches only allowlisted paths', outside.length === 0,
    outside.length ? `unexpected: ${outside.slice(0, 6).join(', ')}` : `${fixFiles.length} file(s)`);

  const gitlinks = (runnerAfter?.gitlinks || []).filter(Boolean);
  add('no tooling gitlink (160000) in the runner index', gitlinks.length === 0, gitlinks.slice(0, 4).join(', '));

  // Fingerprints before and after the fixer ARE the R2 evidence — a remote tree of a deleted
  // repository can never show untracked work, symlinks or extra staged paths. Without this
  // check a failed artifact download degraded the comparison to "0 paths compared" and the
  // verdict went green on an empty base: an incomplete bundle must be red, not quiet.
  const beforeOk = Boolean(runnerBefore && runnerBefore.fingerprint && runnerBefore.index !== undefined);
  const afterOk = Boolean(runnerAfter && runnerAfter.fingerprint && runnerAfter.index !== undefined);
  add('runner state captured before and after the fixer', beforeOk && afterOk,
    beforeOk && afterOk ? `${Object.keys(runnerBefore.fingerprint).length} path(s) fingerprinted on each side`
      : `missing: ${[!beforeOk && 'before', !afterOk && 'after'].filter(Boolean).join(', ')}`);

  if (runnerBefore && runnerAfter) {
    // Everything the fixer had no business touching must be byte-identical; only the fix's own
    // subject may differ. Comparing the WHOLE tree and calling any difference a defect is the
    // mirror image of the "remote tree proves it" mistake — it would flag the fix itself.
    const collateral = Object.entries(runnerBefore.fingerprint || {})
      .filter(([k]) => !k.startsWith('.git/') && !isFixSubject(k)
        && runnerAfter.fingerprint[k] !== runnerBefore.fingerprint[k])
      .map(([k]) => k);
    add('runner content outside the fix subject survives untouched', collateral.length === 0,
      collateral.length ? `changed/absent: ${collateral.slice(0, 6).join(', ')}`
        : `${Object.keys(runnerBefore.fingerprint || {}).length} path(s) compared`);

    const leaked = (runnerAfter.fingerprint || {});
    const toolPaths = Object.keys(leaked).filter((k) => k.includes('pr-autofix/') || k.includes('runner/temp'));
    add('no tool tree materialized into the consumer tree', toolPaths.length === 0, toolPaths.slice(0, 4).join(', '));
  }

  const need = ['caller_sha', 'tool_sha', 'run_id', 'run_url', 'logs', 'patch', 'changed_files', 'receipt', 'shipped_job'];
  const missing = need.filter((k) => !evidence[k]);
  add('the evidence bundle is complete before teardown', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${need.length} fields`);

  // The reviewer's question is "did a SHIPPED workflow run?", and a workflow file that never
  // started produces no error line — only a `skipped` job. A green bundle without this check can
  // be assembled from a consumer whose fixer never executed at all.
  const raw = evidence.shipped_job || {};
  const job = typeof raw === 'string' ? { name: raw.split(' — ')[0], conclusion: raw.split(' — ').slice(1).join(' — ') } : raw;
  const ran = job.name && job.conclusion && !/^(skipped|cancelled|neutral)$/.test(job.conclusion);
  add('the shipped autofix job actually ran', Boolean(ran),
    `${job.name || 'no autofix job'} — ${job.conclusion || 'absent'}`);

  return { checks, ok: checks.every((c) => c.ok) };
}

// ── self-test: the decision logic, offline, with a red control ─────────────────────
// Without a red control this harness is decoration: a detector that cannot fail proves nothing.
function selfTest() {
  const root = path.join(CODE, '.devbaseline-sandbox', `r2-harness-selftest-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  const consumer = path.join(root, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'README.md'), '# disposable consumer\n');
  mkdirSync(path.join(consumer, 'broken'), { recursive: true });
  writeFileSync(path.join(consumer, 'broken', 'bad.md'), 'placeholder\n');
  writeFileSync(path.join(consumer, 'uncommitted-user-work.txt'), 'must survive the run\n');
  const outside = path.join(root, 'outside');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'precious.txt'), 'reachable only through the symlink\n');
  spawnSync('ln', ['-s', '../outside', path.join(consumer, 'link-to-outside')]);
  gitOut(['init', '-q'], consumer);
  gitOut(['-C', consumer, 'add', '-A']);
  spawnSync('git', ['-C', consumer, '-c', 'user.email=f@x.invalid', '-c', 'user.name=f', 'commit', '-q', '-m', 'fixture']);

  const before = { fingerprint: fingerprintTree(consumer), ...gitState(consumer) };
  // The shipped delivery writes the baseline into the consumer and fixes the broken file.
  mkdirSync(path.join(consumer, '.devbaseline'), { recursive: true });
  writeFileSync(path.join(consumer, '.devbaseline', 'log.json'), '{"run":"fixture"}\n');
  writeFileSync(path.join(consumer, 'broken', 'bad.md'), '# fixed by the baseline\n');
  const after = { fingerprint: fingerprintTree(consumer), ...gitState(consumer) };

  const evidenceOk = {
    caller_sha: 'c'.repeat(40), tool_sha: TOOL_SHA, run_id: '1', run_url: 'https://example.invalid/runs/1',
    logs: 'sanitized.log', patch: 'fix.patch', changed_files: '.devbaseline/log.json,broken/bad.md',
    receipt: '.devbaseline/log.json', shipped_job: 'autofix — success',
  };

  const scenarios = [
    {
      name: 'positive — a normal fix keeps the runner intact and the bundle complete',
      input: { fixFiles: ['.devbaseline/log.json', 'broken/bad.md'], runnerBefore: before, runnerAfter: after, evidence: evidenceOk },
      expect: true,
    },
    {
      name: 'a nested repository of ours in the index (gitlink) is a defect',
      input: { fixFiles: ['.devbaseline/log.json'], runnerAfter: { fingerprint: after.fingerprint, gitlinks: ['160000 abc\tdocs/submodule'] }, evidence: evidenceOk },
      expect: false,
    },
    {
      name: 'a staged path outside the allowlist is a defect',
      input: { fixFiles: ['.devbaseline/log.json', 'scripts/autofix-fixture.mjs'], runnerBefore: before, runnerAfter: after, evidence: evidenceOk },
      expect: false,
    },
    {
      name: 'destroyed untracked work on the runner is a defect (a remote tree cannot see this)',
      input: {
        fixFiles: ['.devbaseline/log.json'],
        runnerBefore: { fingerprint: { ...before.fingerprint, 'uncommitted-user-work.txt': 'F deadbeef' },
          gitlinks: [], index: '', untracked: [], status_porcelain: '' },
        runnerAfter: after,
        evidence: evidenceOk,
      },
      expect: false,
    },
    {
      name: 'a missing runner-state artifact is a defect (a 503 download leaves nothing to compare)',
      input: { fixFiles: ['.devbaseline/log.json'], runnerBefore: { gitlinks: [] }, runnerAfter: after, evidence: evidenceOk },
      expect: false,
    },
    {
      name: 'an incomplete evidence bundle is a defect (no teardown before durability)',
      input: { fixFiles: ['.devbaseline/log.json'], runnerBefore: before, runnerAfter: after, evidence: { ...evidenceOk, patch: '' } },
      expect: false,
    },
    {
      name: 'a skipped shipped job is a defect (a workflow that never started produces no error line)',
      input: { fixFiles: ['.devbaseline/log.json'], runnerBefore: before, runnerAfter: after, evidence: { ...evidenceOk, shipped_job: 'autofix — skipped' } },
      expect: false,
    },
  ];

  let ok = true;
  const results = [];
  for (const s of scenarios) {
    const v = judgeFix(s.input);
    const pass = v.ok === s.expect;
    ok = ok && pass;
    results.push({ name: s.name, expected_clean: s.expect, observed_clean: v.ok, ok: pass,
      failed_checks: v.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` — ${c.detail}` : ''}`) });
    say(`${pass ? 'ok  ' : 'FAIL'} ${s.name}`);
    for (const c of v.checks) if (!c.ok) say(`       red: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }

  const report = { harness: 'r2-hosted-harness', mode: 'self-test', ok, scenarios: results, verdict: ok ? 'clean — the harness can detect a gitlink, an extra staged path, a destroyed untracked file and an incomplete bundle' : 'DEFECT — the harness does not detect what it claims to detect' };
  const out = path.join(CODE, '.devbaseline-sandbox', 'r2-harness-selftest.json');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  say(`\nverdict: ${report.verdict}\nresults: ${out}`);
  if (!KEEP) rmSync(root, { recursive: true, force: true });
  return report;
}

// ── live phases ───────────────────────────────────────────────────────────────────
// `gh` is used for every remote call, so the harness never handles a token itself — the one
// exception is provisioning the disposable consumer's own secrets (see setup below), where a
// value reaches `gh secret set` as STDIN only and is never argv, log or bundle.
const gh = (args, { check = true } = {}) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (check && r.status !== 0) die(`gh ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || '').trim().slice(0, 300)}`);
  return (r.stdout || '').trim();
};

// The consumer's own fixture: an inventory whose declared total must equal the sum of the items.
// The harness PR inflates the total by one — a defect a fixer can diagnose, fix and re-verify
// (exactly what it.6's hosted cycle did), rather than a check no patch could ever satisfy.
const CONSUMER_CHECK = `const fs = require("fs");
const rows = fs.readFileSync("broken/bad.md", "utf8").split("\\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split("|").map((s) => s.trim()));
const sum = rows.filter(([k]) => k !== "total").reduce((a, [, q]) => a + Number(q), 0);
const declared = Number((rows.find(([k]) => k === "total") || [])[1]);
if (declared !== sum) {
  console.log("::error::broken/bad.md: declared total " + declared + " != the sum of the items (" + sum + ")");
  process.exit(1);
}
console.log("ok — the inventory adds up");
`;
const CONSUMER_BAD_MD = '# inventory\napple | 3\npear | 4\ntotal | 7\n';

// Runner-state capture, inline in the workflow because a reusable workflow's steps are not
// injectable: a consumer cannot take a fingerprint "around" a `uses:` job. What it CAN do is
// fingerprint the SAME head commit with the SAME fixture recipe in a job before the fixer and in
// a job after it — two real runners, byte-comparable, plus status/index/untracked/gitlinks that a
// remote tree of a deleted repository can never produce.
const CAPTURE_STEP = (when, toolSha) => `      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - name: Runner state ${when} the fixer
        run: |
          mkdir -p outside && echo precious > outside/precious.txt
          echo 'uncommitted work that belongs to the user' > uncommitted-user-work.txt
          ln -sfn ../outside link-to-outside
          node -e '
            const { execFileSync } = require("child_process");
            const fs = require("fs"); const crypto = require("crypto");
            const sh = (a) => { try { return execFileSync("git", a, { encoding: "utf8" }); } catch (e) { return String(e.stdout || ""); } };
            const fp = {};
            const walk = (abs, rel) => {
              let st; try { st = fs.lstatSync(abs); } catch { return; }
              if (rel.split("/").includes(".git")) return;
              if (st.isSymbolicLink()) { fp[rel] = "L -> " + fs.readlinkSync(abs); return; }
              if (st.isDirectory()) { fp[rel + "/"] = "D"; for (const e of fs.readdirSync(abs).sort()) walk(abs + "/" + e, rel ? rel + "/" + e : e); return; }
              fp[rel] = "F " + crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
            };
            walk(process.cwd(), "");
            fs.writeFileSync("runner-state.json", JSON.stringify({
              when: "${when}",
              fingerprint: fp,
              status_porcelain: sh(["-C", ".", "status", "--porcelain"]),
              index: sh(["-C", ".", "ls-files", "-s"]),
              untracked: sh(["-C", ".", "ls-files", "--others", "--exclude-standard"]).split("\\n").filter(Boolean),
              gitlinks: sh(["-C", ".", "ls-files", "-s"]).split("\\n").filter((l) => l.startsWith("160000")),
              head_sha: process.env.GITHUB_SHA,
              pr_head_sha: "${'$'}{{github.event.pull_request.head.sha}}",
              tool_sha: "${toolSha}",
              run_id: process.env.GITHUB_RUN_ID,
              run_url: process.env.GITHUB_SERVER_URL + "/" + process.env.GITHUB_REPOSITORY + "/actions/runs/" + process.env.GITHUB_RUN_ID,
              image: process.env.ImageOS || process.env.RUNNER_OS,
            }, null, 2));
          '
      - name: Archive the runner state (${when})
        uses: actions/upload-artifact@v4
        with:
          name: runner-state-${when}
          path: runner-state.json
`;

// The consumer's own CI, in the shape a real consumer has it — and the shape that was proven to
// work hosted (iteration 6's consumer, run 36981201200): a `CI` workflow whose check goes red on the
// pull request, and a separate `PR Autofix` workflow triggered by `workflow_run` of CI, calling the
// SHIPPED reusable workflow. The trigger shape is not decoration: the shipped fixer reads the failing
// CI run id and the PR from the `workflow_run` payload, so a bare `pull_request` call is a different
// product.
const CONSUMER_CI = (toolSha) => `name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
jobs:
  runner-state-before:
    runs-on: ubuntu-latest
    steps:
${CAPTURE_STEP('before', toolSha)}  broken-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: The consumer's own check — red on the harness PR, on purpose
        run: node check.js
`;

const CONSUMER_AUTOFIX = (toolSha) => `name: PR Autofix
on:
  workflow_run:
    workflows: ['CI']
    types: [completed]
permissions:
  contents: write
  pull-requests: write
jobs:
  autofix:
    if: >-
      github.event.workflow_run.conclusion == 'failure' &&
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.pull_requests[0] != null &&
      !startsWith(github.event.workflow_run.head_branch, 'fix/ci-')
    permissions:
      contents: write
      pull-requests: write
    uses: trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@${toolSha}
    with:
      pr_number: \${{ github.event.workflow_run.pull_requests[0].number }}
      original_branch: \${{ github.event.workflow_run.head_branch }}
      run_id: \${{ github.event.workflow_run.id }}
    secrets:
      llm_ladder_token: \${{ secrets.LLM_LADDER_TOKEN }}
      gh_token: \${{ secrets.AUTOFIX_PAT || github.token }}
  runner-state-after:
    needs: [autofix]
    if: always()
    runs-on: ubuntu-latest
    steps:
${CAPTURE_STEP('after', toolSha)}`;

function liveRun() {
  if (!EVIDENCE_OUT) die('--run requires --evidence-out <dir>: the bundle must be durable before teardown');
  if (!spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' }).stdout) die('gh is not authenticated — the live phases need a token');
  // The consumer's workflow calls the shipped reusable workflow at $TOOL_SHA. A SHA that exists
  // only locally makes GitHub reject the whole workflow FILE ("likely failed because of a
  // workflow file issue", zero jobs) — the run burns minutes and produces no evidence at all.
  const toolRepo = ((gitOut(['-C', CODE, 'remote', 'get-url', 'origin']) || '').match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) || [])[1];
  if (toolRepo && spawnSync('gh', ['api', `repos/${toolRepo}/commits/${TOOL_SHA}`], { encoding: 'utf8' }).status !== 0)
    die(`tool SHA ${TOOL_SHA.slice(0, 8)} is not on github.com/${toolRepo} — push the branch first; the consumer pins the shipped workflow at that SHA`);
  const org = gh(['repo', 'view', '--json', 'owner', '-q', '.owner.login']).split('\n')[0];
  const slug = `${REPO}-${Date.now().toString(36)}`;
  const full = `${org}/${slug}`;
  const outDir = path.resolve(EVIDENCE_OUT);
  const work = CONSUMER_ROOT ? path.resolve(CONSUMER_ROOT) : path.join(CODE, '.devbaseline-sandbox', slug);
  const phase = (name) => say(`── ${name}`);
  let teardownDone = false;
  let sawRuns = false;
  livePhase = true;
  try {
    phase('setup — disposable consumer');
    // A real consumer of this product carries the two repository secrets the shipped workflow
    // reads (autofix-callable.yml — "Required secrets in your repo"): the llm-ladder bearer
    // token without which autofix.mjs exits at `LLM_LADDER_TOKEN not set`, and the PAT under
    // which the fix branch is pushed and the fix PR is opened. Nine hosted runs died at that
    // exit and the bundle never held a patch — the harness must provision what every real
    // consumer has, or it proves nothing about failed→fix. Values go to `gh secret set` on
    // STDIN: never argv, never a log line, never the bundle.
    const ladderToken = process.env.LLM_LADDER_TOKEN || process.env.OPENCODE_LADDER_TOKEN;
    if (!ladderToken) die('LLM_LADDER_TOKEN (or OPENCODE_LADDER_TOKEN) is not set in the environment — the shipped fixer cannot run without it');
    gh(['repo', 'create', full, '--private', '--description', `disposable evidence consumer (auto-deleted) — ${TOOL_SHA.slice(0, 8)}`]);
    const setSecret = (name, value) => {
      const r = spawnSync('gh', ['secret', 'set', name, '--repo', full], { encoding: 'utf8', input: value });
      if (r.status !== 0) die(`gh secret set ${name} failed: ${(r.stderr || '').trim().slice(0, 200)}`);
    };
    setSecret('LLM_LADDER_TOKEN', ladderToken);
    const pat = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    if (pat.status === 0 && (pat.stdout || '').trim()) setSecret('AUTOFIX_PAT', pat.stdout.trim());
    else say('::warning::no gh auth token — the fixer falls back to GITHUB_TOKEN, which the org may refuse for PR creation');
    mkdirSync(work, { recursive: true });
    writeFileSync(path.join(work, 'README.md'), '# disposable consumer\n');
    mkdirSync(path.join(work, '.github', 'workflows'), { recursive: true });
    mkdirSync(path.join(work, 'broken'), { recursive: true });
    writeFileSync(path.join(work, 'broken', 'bad.md'), CONSUMER_BAD_MD);
    writeFileSync(path.join(work, 'check.js'), CONSUMER_CHECK);
    // The SHIPPED fixer is a Node consumer's fixer: `actions/setup-node` runs with `cache: npm`
    // and the next step is `npm ci --ignore-scripts`. A disposable consumer without a lockfile is
    // not a consumer of this product — it fails in setup-node, before the tool is ever executed.
    // `scripts.test` is the consumer's own verify contract: the non-agent pipeline runs
    // `npm test` after applying a patch (autofix.mjs — "Verify: run tests") and reverts the
    // patch if it fails, so a consumer with no `test` script can never produce a fix PR —
    // the harness would be proving the cycle against a fixture the product cannot pass.
    writeFileSync(path.join(work, 'package.json'), `${JSON.stringify({
      name: 'disposable-consumer', version: '1.0.0', private: true,
      scripts: { test: 'node check.js' },
    }, null, 2)}\n`);
    writeFileSync(path.join(work, 'package-lock.json'), `${JSON.stringify({
      name: 'disposable-consumer', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: { '': { name: 'disposable-consumer', version: '1.0.0', scripts: { test: 'node check.js' } } },
    }, null, 2)}\n`);
    writeFileSync(path.join(work, '.github', 'workflows', 'ci.yml'), CONSUMER_CI(TOOL_SHA));
    writeFileSync(path.join(work, '.github', 'workflows', 'pr-autofix.yml'), CONSUMER_AUTOFIX(TOOL_SHA));
    gitOut(['init', '-q', '-b', 'main'], work);
    gitOut(['-C', work, 'add', '-A']);
    spawnSync('git', ['-C', work, '-c', 'user.email=h@x.invalid', '-c', 'user.name=harness', 'commit', '-q', '-m', 'fixture consumer']);
    gitOut(['-C', work, 'remote', 'add', 'origin', `https://github.com/${full}.git`]);
    const push = spawnSync('git', ['-C', work, 'push', '-q', 'origin', 'HEAD:main'], { encoding: 'utf8' });
    if (push.status !== 0) die(`push failed: ${(push.stderr || '').trim().slice(0, 300)}`);
    // The pull request carries the defect: the declared total no longer equals the sum of items,
    // so `node check.js` goes red and the shipped fixer receives a failing check to act on.
    const prBranch = 'harness/failing-pr';
    gitOut(['-C', work, 'checkout', '-q', '-b', prBranch]);
    writeFileSync(path.join(work, 'broken', 'bad.md'), CONSUMER_BAD_MD.replace('total | 7', 'total | 8'));
    gitOut(['-C', work, 'add', '-A']);
    spawnSync('git', ['-C', work, '-c', 'user.email=h@x.invalid', '-c', 'user.name=harness', 'commit', '-q', '-m', 'inflate the declared total']);
    const pushPr = spawnSync('git', ['-C', work, 'push', '-q', 'origin', prBranch], { encoding: 'utf8' });
    if (pushPr.status !== 0) die(`push of the PR branch failed: ${(pushPr.stderr || '').trim().slice(0, 300)}`);
    const callerSha = gitOut(['-C', work, 'rev-parse', prBranch]);
    gh(['pr', 'create', '--repo', full, '--base', 'main', '--head', prBranch,
      '--title', 'fixture: the declared total drifted from the items', '--body',
      'Disposable harness fixture. The declared total was inflated by one, so the consumer check is red.']);

    phase('run — the shipped autofix workflow on a real runner (failed → fix → verify)');
    const started = Date.now();
    const waitFor = (workflow) => {
      for (;;) {
        const list = JSON.parse(gh(['run', 'list', '--repo', full, '--workflow', workflow, '--limit', '5', '--json', 'databaseId,status,conclusion,url,headSha,event'], { check: false }) || '[]');
        const r = list[0];
        if (r && r.status === 'completed') return r;
        if (Date.now() - started > 30 * 60_000) die(`${workflow} did not finish in 30 min (last: ${r ? `${r.status} ${r.conclusion}` : 'none'})`);
        spawnSync('sleep', ['15']);
      }
    };
    const ciRun = waitFor('ci.yml');
    sawRuns = true;
    say(`CI run ${ciRun.databaseId}: ${ciRun.conclusion} — ${ciRun.url}`);
    // A workflow_run consumer fires PR Autofix for EVERY completed CI run — including the GREEN
    // CI of the fix PR, whose autofix job is then skipped. The newest run at evidence time is
    // that empty one, so "wait for a completed run" would judge a skipped job and call the
    // product defective for its own success. The fix run is the one whose autofix job started.
    const autofixJobConclusion = (id) => (gh(['api', `repos/${full}/actions/runs/${id}/jobs`,
      '--jq', '[.jobs[] | select(.name | startswith("autofix"))][0].conclusion // "absent"'], { check: false }) || 'absent').trim();
    const waitForFixRun = () => {
      for (;;) {
        const list = (JSON.parse(gh(['run', 'list', '--repo', full, '--workflow', 'pr-autofix.yml',
          '--limit', '5', '--json', 'databaseId,status,conclusion,url,headSha,createdAt'], { check: false }) || '[]')
          .filter((r) => r.status === 'completed')
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
        for (const r of list) {
          const c = autofixJobConclusion(r.databaseId);
          if (c && c !== 'skipped' && c !== 'absent') return r;
        }
        if (Date.now() - started > 30 * 60_000) die('no PR Autofix run with a started autofix job in 30 min');
        spawnSync('sleep', ['15']);
      }
    };
    const run = waitForFixRun();
    say(`PR Autofix run ${run.databaseId}: ${run.conclusion} — ${run.url}`);

    phase('evidence — collected from the run, written before teardown');
    mkdirSync(outDir, { recursive: true });
    const logs = `${slug}-logs.txt`;
    const raw = [ciRun, run].map((r) => {
      const l = spawnSync('gh', ['run', 'view', String(r.databaseId), '--repo', full, '--log'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      return `===== run ${r.databaseId} (${r.workflowName || 'workflow'}) — ${r.conclusion} — ${r.url}\n${l.stdout || ''}`;
    }).join('\n');
    writeFileSync(path.join(outDir, logs), sanitize(raw));
    // The failing job's own log, always: a red shipped job is the moment the bundle must carry the
    // reason, and the reason disappears with the disposable consumer at teardown.
    // Job-level evidence: which jobs the run actually had and how each concluded. A workflow that
    // never started leaves a `skipped` job and no error line anywhere, so the log alone cannot tell
    // "the fixer ran and did nothing" from "the fixer never ran".
    const jobsFile = `${slug}-jobs.json`;
    const view = (r) => JSON.parse(gh(['run', 'view', String(r.databaseId), '--repo', full,
      '--json', 'conclusion,event,headSha,workflowName,createdAt,updatedAt,jobs'], { check: false }) || '{}');
    const ciView = view(ciRun), fixView = view(run);
    writeFileSync(path.join(outDir, jobsFile), `${JSON.stringify({ ci: ciView, autofix: fixView }, null, 2)}\n`);
    const shippedJob = (fixView.jobs || []).find((j) => /^autofix/.test(j.name)) || {};
    // Per-job logs, because `gh run view --log` does NOT carry the log of a reusable-workflow
    // job: the run-level dump ended at the caller, which is how a bundle can look complete while
    // containing no trace of the shipped step that actually ran.
    const jobLogs = [];
    for (const v of [ciView, fixView]) for (const j of v.jobs || []) {
      if (!j.databaseId) continue;
      // gh refuses to print a body containing terminal escapes unless told to — runner logs are
      // full of them, and the failure mode is an EMPTY bundle field, not an error.
      const jl = spawnSync('gh', ['api', `repos/${full}/actions/jobs/${j.databaseId}/logs`, '--allow-escape-sequences'], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
      if (!jl.stdout || !jl.stdout.trim()) continue;
      jobLogs.push(`===== job ${j.name} (${j.conclusion}) — ${j.url}\n${jl.stdout}`);
    }
    writeFileSync(path.join(outDir, `${slug}-joblogs.txt`),
      jobLogs.join('\n').replace(/\u001b\[[0-9;]*[A-Za-z]/g, ''));
    say(`shipped job autofix: ${shippedJob.conclusion || 'absent'}`);
    const state = {};
    for (const when of ['before', 'after']) {
      // The artifact CDN is rate-limited for real (a 503 "egress is over the account limit"
      // killed a whole run once): a transient blob error must cost retries, not the bundle.
      // After the last attempt the state is recorded as missing — the verdict has a dedicated
      // red check for exactly this, so an incomplete bundle can never read green.
      const dl = path.join(outDir, '_artifact');
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          rmSync(dl, { recursive: true, force: true });
          mkdirSync(dl, { recursive: true });
          gh(['run', 'download', String((when === 'before' ? ciRun : run).databaseId), '--repo', full, '--name', `runner-state-${when}`, '--dir', dl]);
          state[when] = JSON.parse(readFileSync(path.join(dl, 'runner-state.json'), 'utf8'));
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 3) spawnSync('sleep', ['15']);
        }
      }
      rmSync(dl, { recursive: true, force: true });
      if (lastErr) {
        state[when] = {};
        say(`::warning::no runner-state-${when} artifact after 3 attempts (${lastErr.message.slice(0, 140)}) — the verdict will call the bundle INCOMPLETE`);
      }
    }
    const runnerAfter = { ...state.after, gitlinks: state.after.gitlinks || [] };
    const runnerBefore = { ...state.before, gitlinks: state.before.gitlinks || [] };

    // ONLY the fixer's PR counts: it is identified by the shipped branch convention
    // `fix/ci-<sanitized original branch>-<ts>` (autofix.mjs), which the fixture PR's own head
    // (`harness/failing-pr`) can never carry — no "any PR" fallback can green the bundle with
    // the harness's own diff. Its BASE is the shipped BASE_BRANCH (default `main`), so
    // `baseRefName === prBranch` was never the product's shape: the fix branch neutralises the
    // fixture on top of main, and the PR-level net diff is EMPTY. The actual patch — what the
    // fixer changed, which is what R2 asks for — lives in the fix COMMIT, so the bundle reads
    // files and patch from the commit the PR carries, not from the PR's net diff.
    let fixFiles = [], patch = '', prUrl = '', fixCommit = '';
    try {
      const prs = JSON.parse(gh(['pr', 'list', '--repo', full, '--state', 'all', '--json', 'url,number,headRefName,baseRefName,title'], { check: false }) || '[]');
      const safePrBranch = prBranch.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 40);
      const pr = prs.find((p) => p.headRefName.startsWith(`fix/ci-${safePrBranch}-`));
      if (pr) {
        prUrl = pr.url;
        const prCommits = JSON.parse(gh(['pr', 'view', String(pr.number), '--repo', full, '--json', 'commits'], { check: false }) || '{}').commits || [];
        const fixC = [...prCommits].reverse().find((c) => /\[autofix\]/.test(c.messageHeadline || '')) || null;
        if (fixC) {
          fixCommit = fixC.oid;
          const api = JSON.parse(gh(['api', `repos/${full}/commits/${fixC.oid}`], { check: false }) || '{}');
          fixFiles = (api.files || []).map((f) => f.filename).filter(Boolean);
          patch = (api.files || []).map((f) =>
            `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch || ''}\n`).join('');
          if (patch) writeFileSync(path.join(outDir, `${slug}-patch.diff`), patch);
        } else say('::warning::the fix PR carries no [autofix] commit — the bundle is INCOMPLETE');
      } else say(`::warning::no fix/ci-${safePrBranch}-* PR (PRs: ${prs.map((p) => p.headRefName).join(', ') || 'none'}) — the bundle is INCOMPLETE`);
    } catch { say('::warning::the fix PR could not be read — the bundle is INCOMPLETE'); }

    const meta = { consumer: full, ci_run: { id: String(ciRun.databaseId), url: ciRun.url, conclusion: ciRun.conclusion },
      run_id: String(run.databaseId), run_url: run.url, conclusion: run.conclusion,
      caller_sha: callerSha, tool_sha: TOOL_SHA, fix_pr: prUrl, fix_commit: fixCommit, changed_files: fixFiles,
      runner_state: { before: runnerBefore, after: runnerAfter }, logs, jobs: jobsFile,
      shipped_job: shippedJob.name ? { name: shippedJob.name, conclusion: shippedJob.conclusion, startedAt: shippedJob.startedAt, completedAt: shippedJob.completedAt } : null,
      patch: patch ? `${slug}-patch.diff` : '' };
    writeFileSync(path.join(outDir, `${slug}-run.json`), `${JSON.stringify(meta, null, 2)}\n`);
    const checksums = Object.entries(readdirSync(outDir)).filter(([f]) => f.startsWith(slug))
      .map(([f]) => `${sha256(readFileSync(path.join(outDir, f)))}  ${f}`);
    writeFileSync(path.join(outDir, `${slug}-SHA256SUMS`), `${checksums.join('\n')}\n`);
    const evidence = { caller_sha: callerSha, tool_sha: TOOL_SHA, run_id: String(run.databaseId), run_url: run.url,
      logs, patch: meta.patch, changed_files: fixFiles.join(','), receipt: 'runner-state.json',
      shipped_job: shippedJob.name ? `${shippedJob.name} — ${shippedJob.conclusion}` : '' };
    const verdict = judgeFix({ fixFiles, runnerBefore, runnerAfter, evidence });
    writeFileSync(path.join(outDir, `${slug}-verdict.json`), `${JSON.stringify(verdict, null, 2)}\n`);
    say(`bundle: ${outDir}/${slug}-*`);

    if (KEEP && !verdict.ok) {
      say(`consumer KEPT for inspection: https://github.com/${full} — delete it after reading`);
      teardownDone = true;
    } else {
      phase('teardown — only now, with the bundle durable on disk');
      gh(['repo', 'delete', full, '--yes']);
      teardownDone = true;
      say(`deleted ${full}`);
    }

    if (AS_JSON) console.log(JSON.stringify(verdict, null, 2));
    say(`\nverdict: ${verdict.ok ? 'clean' : 'DEFECT'} — ${verdict.checks.map((c) => `${c.ok ? 'ok' : 'FAIL'} ${c.name}`).join('; ')}`);
    return verdict.ok ? 0 : 1;
  } catch (e) {
    say(`::error::${e.message}`);
    return 2;
  } finally {
    // A failed run must never leave a disposable consumer behind: that is how an org fills with
    // evidence repos nobody owns — except under --keep, where a red run deliberately keeps the
    // consumer alive because the consumer is the only place its job logs still exist.
    if (!teardownDone && !KEEP) {
      const bundle = existsSync(outDir) && readdirSync(outDir).some((f) => f.startsWith(slug));
      if (bundle || !sawRuns) {
        const d = spawnSync('gh', ['repo', 'delete', full, '--yes'], { encoding: 'utf8' });
        say(d.status === 0 ? `teardown after failure: deleted ${full}` : `::warning::could not delete ${full} — delete it by hand`);
      } else say(`::error::no durable bundle, leaving ${full} in place — delete it by hand`);
    }
    if (!KEEP && CONSUMER_ROOT && existsSync(work)) rmSync(work, { recursive: true, force: true });
  }
}

// Sanitized logs: keep the structure (step names, exit codes, the evidence lines) and drop the
// volatile/secret-bearing noise. A bundle that ships raw logs is a bundle that leaks tokens.
function sanitize(text) {
  const plain = String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
  const keep = /^(::group|::endgroup|::error|::warning|##\[|Run |=== |ok |FAIL |verdict:)|exited with code|Process completed|runner-state|"(run_id|tool_sha|caller_sha|gitlinks)"/;
  return `${plain.split('\n').filter((l) => keep.test(l) || /\bexit(ed)?\b.*\bcode\b/i.test(l)).join('\n')}\n`;
}

// ── entry ──────────────────────────────────────────────────────────────────────────
let report;
// `--print-consumer-ci` renders the consumer workflow for inspection: the live recipe is a
// string in this file, and a string nobody can read is how a wrong input shape ships.
if (process.argv.includes('--print-consumer-ci')) {
  const sha = flag('--tool-sha') || 'PINNED_SHA';
  console.log(`# ---- .github/workflows/ci.yml ----\n${CONSUMER_CI(sha)}\n# ---- .github/workflows/pr-autofix.yml ----\n${CONSUMER_AUTOFIX(sha)}`);
  process.exit(0);
}
if (SELF_TEST) report = selfTest();
else if (RUN) process.exit(liveRun());
else die('nothing to do: pass --self-test (offline) or --run --evidence-out <dir> (live)');

if (AS_JSON) console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
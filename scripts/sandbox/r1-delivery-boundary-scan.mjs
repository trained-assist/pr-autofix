#!/usr/bin/env node
// Class-level check for R1 — "a workflow runs a script it never delivered".
//
// R1 was reported against one workflow, but the shape is a CLASS: a reusable workflow downloads a
// script into a scratch dir and runs it there, without bringing the modules that script imports.
// ci-fix-cleanup.yml does it with GITHUB_ACTION_PATH (no delivery at all); devbaseline-callable.yml
// downloads fetch-payload.mjs FLAT, while that file imports ./lib/devbaseline/payload.mjs, which
// lands next to it only by accident — and then that one imports ./profile.mjs, and so on.
//
// This scanner is the guard: for every workflow, resolve the scripts it RUNS, resolve their
// transitive relative imports, and check that each job actually delivers them. A hand-written list
// of files is exactly the pattern that fails, so nothing here trusts a list.
//
//   node r1-delivery-boundary-scan.mjs [--code <repo>] [--json]
// exit 0 = every executed script's whole import tree is delivered; 1 = a gap; 2 = harness error

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Default = the checkout this scanner ships in, derived from its own location. An absolute path
// captured while authoring it would pass on one machine and ENOENT on every runner — the exact
// "it only works where it was written" shape this scanner exists to catch.
const CODE = (() => {
  const i = process.argv.indexOf('--code');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.resolve(HERE, '..', '..');
})();
const AS_JSON = process.argv.includes('--json');

const findings = [];
const note = (f, msg, detail) => findings.push({ workflow: f, message: msg, detail });

// Scripts in this repo that are self-contained (no relative import) need no delivery beyond
// themselves; the scan is about TRANSITIVE relative imports, which is where the break hides.
function relativeImports(file) {
  const abs = path.join(CODE, file);
  if (!existsSync(abs)) return [];
  const src = readFileSync(abs, 'utf8');
  const specs = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"](\.[^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  for (const m of src.matchAll(/\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) specs.add(m[1]);
  const out = [];
  for (const s of specs) out.push(path.normalize(path.join(path.dirname(file), s)));
  return [...new Set(out)];
}

function transitive(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const deps = relativeImports(file);
  return [...deps, ...deps.flatMap(d => transitive(d, seen))];
}

function yaml(f) {
  const py = `import sys,yaml,json;print(json.dumps(yaml.safe_load(open(sys.argv[1])),default=str))`;
  return JSON.parse(execFileSync('python3', ['-c', py, path.join(CODE, f)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) { if (e !== '.git' && e !== 'node_modules') walk(p, out); }
    else if (/\.ya?ml$/.test(e)) out.push(path.relative(CODE, p));
  }
  return out;
}

// A missing tree is a broken harness, not a verdict: say so with exit 2 instead of letting a bare
// ENOENT stack trace masquerade as "the scan found a gap" (or, read lazily, as "it passed").
if (!existsSync(path.join(CODE, '.github/workflows'))) {
  console.error(`::error::no workflow tree at ${CODE} — pass --code <repo>`);
  process.exit(2);
}

const workflows = [...walk(path.join(CODE, '.github/workflows')), ...walk(path.join(CODE, 'templates'))];
const examined = [];

for (const wf of workflows) {
  let doc;
  try { doc = yaml(wf); } catch { continue; }
  const jobs = doc && doc.jobs;
  if (!jobs) continue;

  for (const [jobName, job] of Object.entries(jobs)) {
    const steps = (job && job.steps) || [];
    if (!steps.length) continue;

    // How the job obtains code: an action that materialises a tree, or shell that fetches one.
    // A pinned delivery run-step (git fetch of the workflow's own commit into
    // $RUNNER_TEMP/pr-autofix) brings the WHOLE tree, so it delivers every import exactly like a
    // full-tree checkout did. Inside a reusable workflow a bare `actions/checkout` checks out the
    // CALLER's repository — the consumer's code, which contains none of the tool's modules. That
    // distinction is the whole bug class: a job can look like it has a checkout and still have no
    // tool at all.
    const TOOL_REPO = 'trained-assist/pr-autofix';
    // A reusable workflow (on: workflow_call) runs in the CALLER's repository: a bare
    // `actions/checkout` there checks out the consumer's code, not the tool's. Only in the tool's
    // OWN CI does a bare checkout deliver the tree.
    const isReusable = /workflow_call/.test(JSON.stringify(doc.on || doc.true || {}));
    const checkoutRepo = (st) => String((st.with && st.with.repository) || '')
      .replace(/\$\{\{\s*job\.workflow_repository\s*\}\}$/, TOOL_REPO).trim();
    const toolCheckoutStep = steps.find(st =>
      /^actions\/checkout@/.test(String(st.uses || '')) && checkoutRepo(st) === TOOL_REPO);
    const isToolFetch = (st) => typeof st.run === 'string'
      && /RUNNER_TEMP\/pr-autofix/.test(st.run) && /\bgit\b[\s\S]*\bfetch\b/.test(st.run);
    const toolFetchStep = steps.find(isToolFetch);
    // In the tool's OWN CI a bare `actions/checkout` is the delivery: the repository it checks out
    // IS the tool tree. In a reusable workflow it checks out the consumer's code instead.
    const fullTreeAction = !!toolCheckoutStep || !!toolFetchStep
      || (!isReusable && steps.some(st => /^actions\/checkout@/.test(String(st.uses || ''))));
    const jobText = steps.map(s => String(s.run || '')).join('\n');
    const fetchIntoJob = /fetch-payload\.mjs|curl -|wget |git clone|git fetch|tar |unzip /.test(jobText);

    // ── the delivery FORM (R1 collision class, pr-autofix#61, #67) ─────────────────────
    // Two runner facts decide what a supported delivery looks like. actions/checkout resolves
    // `path` against GITHUB_WORKSPACE and refuses anything outside it (input-helper.ts:42-52), and
    // a step `env:` cannot move that variable for a JavaScript action — runner 2.337.0 writes the
    // runtime context over the step environment (ActionRunner.cs:240-252 →
    // NodeScriptActionHandler.cs:42-50 → GitHubContext.cs:49-64). Shipping
    // `env: GITHUB_WORKSPACE: ${{ runner.temp }}` therefore installed NOTHING on v1.7.9 (#67).
    // Delivery outside the consumer is a plain run step that fetches the PINNED commit into
    // $RUNNER_TEMP/pr-autofix, and no step may ever try to override a runner context variable
    // again. Both halves are asserted at every delivery point.
    const envOverrides = [];
    steps.forEach((st, i) => {
      for (const k of Object.keys(st.env || {})) {
        if (/^(GITHUB_|RUNNER_)/.test(k)) envOverrides.push(`steps[${i}] ${st.name || '(unnamed)'}: env.${k}`);
      }
    });
    if (envOverrides.length) {
      note(wf, `job "${jobName}" tries to override a runner context variable in a step env`,
        `the runner writes its runtime context OVER step env (NodeScriptActionHandler:42-50); ${envOverrides.slice(0, 4).join('; ')}`);
    }
    const deliveryAt = toolFetchStep ? steps.indexOf(toolFetchStep) : (toolCheckoutStep ? steps.indexOf(toolCheckoutStep) : -1);
    if (deliveryAt === -1) {
      // Not a delivery job: the executed-script scan below is what judges it.
    } else {
      const fetchRun = String(toolFetchStep?.run || '');
      // The pin arrives through the step env (`TOOL_SHA: ${{ job.workflow_sha }}`), and the script
      // asserts it after checkout — a delivery that fetches "whatever main holds" is the defect
      // pr-autofix#58 was opened for, so both halves are read, not just the run text.
      const fetchEnv = Object.entries(toolFetchStep?.env || {}).map(([, v]) => String(v)).join('\n');
      if (toolFetchStep && !/workflow_sha/.test(`${fetchEnv}\n${fetchRun}`)) {
        note(wf, `job "${jobName}" does not pin its delivery by commit`, `no workflow_sha in env/run: ${fetchRun.slice(0, 120)}`);
      }
      if (toolFetchStep && (!/rev-parse/.test(fetchRun) || !/TOOL_SHA/.test(fetchRun))) {
        note(wf, `job "${jobName}" does not assert the delivered SHA after checkout`, `run: ${fetchRun.slice(0, 120)}`);
      }
      const pre = steps.findIndex(st => /RUNNER_TEMP\/pr-autofix/.test(String(st.run || '')) && /refusing/.test(String(st.run || '')));
      if (pre === -1 || pre > deliveryAt) {
        note(wf, `job "${jobName}" has no collision preflight before the materialization`,
          `preflight@${pre}, delivery@${deliveryAt}`);
      }
      const mv = steps.find(st => /\bmv\b[\s\S]*pr-autofix/.test(String(st.run || '')));
      if (mv) note(wf, `job "${jobName}" still relocates the tool tree out of the consumer root`, `step: ${mv.name || '(unnamed)'}`);
    }

    // Delivery ORDER matters. A tree fetched through payload.manifest.json only exists AFTER that
    // fetch step runs; anything executed BEFORE it is a bootstrap that must bring its own imports
    // (fetch-payload.mjs is exactly this: it imports the very module the manifest declares, so it
    // cannot be delivered by that manifest). Handing a bootstrap step credit for a later fetch is
    // how the devbaseline loader passed CI while dying on ERR_MODULE_NOT_FOUND.
    const manifestAt = steps.findIndex(s => /payload\.manifest\.json/.test(String(s.run || '')));
    const fetchedPaths = new Set();
    for (const st of steps) {
      for (const m of String(st.run || '').matchAll(/["']?\$?\{?[A-Za-z_]*\}?\/?([\w./-]+)["']?\s+-o\s+["']?\$?\{?[A-Za-z_]+\}?\/?([\w./-]+)/g)) void m;
      for (const m of String(st.run || '').matchAll(/\$base\/([\w./-]+)/g)) fetchedPaths.add(m[1]);
    }

    // Which repo scripts does this job actually execute, and in which delivery phase?
    const executed = new Map();
    // A workflow addresses a tool script through a shell variable ($GITHUB_ACTION_PATH/…,
    // ${RUNNER_TEMP}/…, "$GITHUB_WORKSPACE/pr-autofix/scripts/…") or a checkout directory
    // (`pr-autofix/scripts/…`). Anchoring on the `scripts/` segment is what makes both resolve —
    // stripping only `$VAR/` prefixes silently stopped EXAMINING a workflow the moment a fixed
    // prefix appeared, which is the same false green this scanner exists to prevent: fewer
    // scripts looked at, and a clean report.
    const stripVar = (r) => { const i = r.indexOf('scripts/'); return i === -1 ? r : r.slice(i); };
    for (const s of steps) {
      const run = String(s.run || '');
      for (const m of run.matchAll(/[\w./{}$-]*scripts\/[\w.-]+\.mjs/g)) {
        const ref = stripVar(m[0].replace(/^["'`]/, ''));
        if (existsSync(path.join(CODE, ref))) {
          // A script whose OWN bytes this step downloads (`$base/scripts/x.mjs` → curl → node) is a
          // bootstrap: it runs from the scratch dir before any tree exists, so its imports must
          // already be there. Same step as the manifest is still BEFORE the delivery.
          const selfFetched = new RegExp(`\\$base\\/${ref.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}`).test(String(s.run || ''));
          executed.set(ref, (selfFetched || manifestAt === -1 || steps.indexOf(s) < manifestAt) ? 'bootstrap' : 'after-manifest');
        }
      }
    }
    if (!executed.size) continue;

    for (const [script, phase] of executed) {
      const tree = transitive(script);
      if (!tree.length) { examined.push({ workflow: wf, job: jobName, script, imports: 0, delivered: true }); continue; }
      // `after-manifest`: the manifest fetch laid out the whole tree, so imports come with it.
      // `bootstrap`: nothing has been laid out yet — each import must itself be fetched, or the
      // job must have checked the tool out in full.
      const deliversAll = phase === 'after-manifest'
        ? (fullTreeAction || (fetchIntoJob && /payload\.manifest\.json/.test(jobText)))
        : fullTreeAction;
      if (!deliversAll) {
        note(wf, `job "${jobName}" runs ${script}, which imports ${tree.length} module(s) the job never delivers`,
          `missing: ${tree.slice(0, 6).join(', ')}${tree.length > 6 ? `, +${tree.length - 6} more` : ''}`);
      }
      examined.push({ workflow: wf, job: jobName, script, imports: tree.length, phase, delivered: deliversAll });
    }
  }
}

const out = { scan: 'delivery boundary — does every executed script bring its import tree?', workflows: workflows.length, examined, findings, verdict: findings.length ? 'GAPS FOUND' : 'every executed script tree is delivered' };
if (AS_JSON) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`\nDelivery-boundary scan — ${workflows.length} workflow/template file(s), ${examined.length} executed script(s)`);
  for (const e of examined) console.log(`${e.delivered === false ? 'FAIL' : 'ok  '} ${e.workflow} [${e.job}] ${e.script} — ${e.imports} relative import(s)${e.phase ? ` [${e.phase}]` : ''}`);
  console.log(`\nverdict: ${out.verdict}`);
  for (const f of findings) console.log(`  · ${f.workflow}: ${f.message}\n    ${f.detail}`);
}
process.exit(findings.length ? 1 : 0);
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

const CODE = (() => {
  const i = process.argv.indexOf('--code');
  return i !== -1 && process.argv[i + 1] ? path.resolve(process.argv[i + 1])
    : '/home/vova/users/trained-assist-product-owner/engineering-workspaces/trained-assist-product-owner/trained-assist-pr-autofix/ws-8d0ed1cfd31494e5/code';
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
    // actions/checkout only delivers the TOOL's tree when it checks the tool out. Inside a reusable
    // workflow a bare `actions/checkout` checks out the CALLER's repository — the consumer's code,
    // which contains none of the tool's modules. That distinction is the whole bug class: a job can
    // look like it has a checkout and still have no tool at all.
    const TOOL_REPO = 'trained-assist/pr-autofix';
    // A reusable workflow (on: workflow_call) runs in the CALLER's repository: a bare
    // `actions/checkout` there checks out the consumer's code, not the tool's. Only in the tool's
    // OWN CI does a bare checkout deliver the tree.
    const isReusable = /workflow_call/.test(JSON.stringify(doc.on || doc.true || {}));
    const fullTreeAction = steps.some(st => {
      if (!/^actions\/checkout@/.test(String(st.uses || ''))) return false;
      const repo = String((st.with && st.with.repository) || '')
        .replace(/\$\{\{\s*job\.workflow_repository\s*\}\}$/, TOOL_REPO).trim();
      if (repo) return repo === TOOL_REPO;
      return !isReusable;
    });
    const jobText = steps.map(s => String(s.run || '')).join('\n');
    const fetchIntoJob = /fetch-payload\.mjs|curl -|wget |git clone|tar |unzip /.test(jobText);

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
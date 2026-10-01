#!/usr/bin/env node
// devbaseline — the thin CLI over scripts/lib/devbaseline/*.
//
// Thin on purpose: argv parsing and dispatch only. Everything else is a library module so the
// behaviour is testable, and the EXIT CODE + the log record are the contract the staging
// rehearsal and the reusable workflows consume (design §2.1, AC-19).
//
//   validate       [--adapter <f> | --repo <d> | --all-profiles]      0 ok · 3 invalid config
//   verify         --repo <d> [--profile id] [--log f] [--attempt n]  0 pass/no_change · 1 failed
//                                                                   2 needs_human · 3 invalid config
//   context        --manifest <f>                                    0 fresh · 2 stale · 3 missing
//   inventory      --out <d> [--repos <f>] [--strict]                0 ok · 4 not visible (--strict)
//   check-docs     --dir <d>                                          0 ok · 1 violations
//   check-workflows --dir <d>                                         0 ok · 1 violations
//   run-derived-check --dir <d>                                       0 ok · 1 failed
//   payload-manifest [--out <f>] [--check]                            0 written/current · 1 stale
//   payload-verify   [--manifest <f>] [--dir <d>]                     0 complete · 1 incomplete
//   gate           --repo <d> [--profile id] [--log f]                0 gate green · 1 gate red
//
// run-derived-check is referenced BY the profiles (check.commands) — it is the derivation step
// that turns a package.json / pyproject.toml into an actual command, kept as a subcommand so a
// profile stays declarative instead of embedding a shell guess.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  TOOL_ROOT, listProfileIds, loadProfile, validateAllProfiles, expandCommand,
} from './lib/devbaseline/profile.mjs';
import { loadAdapter } from './lib/devbaseline/adapter.mjs';
import { resolveRepo } from './lib/devbaseline/resolve.mjs';
import { verify, VERIFY_CODES, writeLogRecord } from './lib/devbaseline/run.mjs';
import { inspectContext } from './lib/devbaseline/context.mjs';
import { buildCoverage, renderCoverageMd, renderStableJson, COVERAGE_COLUMNS, assertNoSecretValues } from './lib/devbaseline/inventory.mjs';
import { buildConstructionTasks, renderConstructionTasksMd } from './lib/devbaseline/construction-tasks.mjs';
import { checkDocs, formatViolations } from './lib/devbaseline/check-docs.mjs';
import { toolVersion, TOOL_NAME } from './lib/devbaseline/log.mjs';
import { cmdGate } from './lib/devbaseline/gate.mjs';
import { renderManifest, verifyManifest, readManifest, MANIFEST_FILENAME } from './lib/devbaseline/payload.mjs';

const DEFAULT_REPOS_FILE = path.join(TOOL_ROOT, 'inventory', 'repos.json');

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) { flags[key] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[key] = true; continue; }
    flags[key] = next;
    i++;
  }
  return { positional, flags };
}

const out = (line = '') => process.stdout.write(`${line}\n`);
const die = (code, msg) => { if (msg) process.stderr.write(`${msg}\n`); process.exit(code); };

// ── validate ───────────────────────────────────────────────────────────────────
function cmdValidate(flags) {
  const problems = [];
  if (flags['all-profiles'] || (!flags.adapter && !flags.repo)) {
    for (const r of validateAllProfiles()) {
      if (!r.ok) problems.push(`profile ${r.id}: ${r.rule_id}: ${r.message}`);
    }
    out(`profiles: ${listProfileIds().join(', ')} — ${problems.length ? 'invalid' : 'all valid'} (schema devbaseline-profile v${1})`);
    if (problems.length) { problems.forEach(p => out(`  · ${p}`)); return 3; }
    return 0;
  }

  if (flags.adapter) {
    const p = path.resolve(String(flags.adapter));
    if (!fs.existsSync(p)) { out(`adapter_schema_violation: ${p} does not exist`); return 3; }
    const dir = path.dirname(p);
    const parsed = loadAdapter(dir);
    if (!parsed.ok) {
      out(`adapter_schema_violation: ${parsed.message}`);
      for (const v of parsed.violations) out(`  · ${v.path}: ${v.message}`);
      return 3;
    }
    out(`adapter ok: ${path.basename(p)} (schema_version ${parsed.adapter.schema_version}, credentials: ${(parsed.adapter.credentials || []).map(c => c.name || c).join(', ') || 'none'})`);
  }

  if (flags.repo) {
    const dir = path.resolve(String(flags.repo));
    // Same seam as verify/inventory (R5): `validate` used to pass only `repoDir`, so a
    // repository pinning a profile was reported here as the DERIVED one.
    const prof = resolveRepo({ repoDir: dir });
    if (!prof.ok) { out(`${prof.rule_id}: ${prof.message}`); return 3; }
    out(`repo ${dir}: profile ${prof.profile.id} (${prof.source}: ${prof.derivation})`);
    if (prof.profile.check.build) out(`  note: this profile runs a build (${prof.profile.check.build.join(', ')})`);
    else out('  build: none — no build is run for this profile');
  }

  return problems.length ? 3 : 0;
}

// ── verify ─────────────────────────────────────────────────────────────────────
function cmdVerify(flags) {
  if (!flags.repo) die(3, 'verify: --repo <dir> is required');
  const result = verify({
    repoDir: String(flags.repo),
    profileId: flags.profile ? String(flags.profile) : '',
    typeHint: flags['type-hint'] ? String(flags['type-hint']) : null,
    attempt: flags.attempt ? Number(flags.attempt) : 1,
    allowFix: flags['no-fix'] ? false : true,
    repo: process.env.REPO || '',
    runId: process.env.RUN_ID || 'local',
    pr: process.env.PR_NUMBER || '',
  });

  out(`profile: ${result.profile} (adapter: ${result.adapter})`);
  out(`outcome: ${result.outcome}`);
  out(`rule_id: ${result.record.rule_id ?? '—'} · reason_code: ${result.record.reason_code ?? '—'}`);
  if (result.record.gate_violations.length) {
    for (const v of result.record.gate_violations) out(`  · ${v.rule_id}: ${v.path}: ${v.message}`);
  }
  out(`patch_refs: ${JSON.stringify(result.record.patch_refs)} · attempt_count: ${result.record.attempt_count}`);
  out(`included_paths: ${result.record.included_paths.join(', ') || '—'}`);
  out(`budget: diff ${result.record.budget.diff_tokens_used}/${result.record.budget.diff_tokens} · files ${result.record.budget.max_files} · lines ${result.record.budget.max_lines}`);

  if (flags.log) {
    writeLogRecord(String(flags.log), result.record);
    out(`log: ${flags.log}`);
  }
  return result.code;
}

// ── context ────────────────────────────────────────────────────────────────────
function cmdContext(flags) {
  const r = inspectContext(flags.manifest ? String(flags.manifest) : '');
  out(`context: ${r.state}`);
  out(`reason: ${r.reason}`);
  out(`source_commit: ${r.source_commit} · head_commit: ${r.head_commit}`);
  out(`entrypoints: ${r.entrypoints.join(', ') || '—'}${r.missing_entrypoints.length ? ` (absent: ${r.missing_entrypoints.join(', ')})` : ''}`);
  return r.code;
}

// ── inventory ──────────────────────────────────────────────────────────────────
async function cmdInventory(flags) {
  const reposFile = path.resolve(String(flags.repos || DEFAULT_REPOS_FILE));
  if (!fs.existsSync(reposFile)) { out(`inventory: repository list not found: ${reposFile}`); return 4; }
  let entries;
  try { entries = JSON.parse(fs.readFileSync(reposFile, 'utf8')); } catch (e) { out(`inventory: ${reposFile} is not valid JSON: ${e.message}`); return 4; }
  if (!Array.isArray(entries)) { out('inventory: repository list must be a JSON array'); return 4; }

  const profileRef = String(flags['profile-ref'] || toolVersion());
  const { rows, unreadable } = await buildCoverage(entries, { profileRef });

  const leak = assertNoSecretValues(rows);
  if (leak) { out(`inventory: refusing to write — a credential value is present at ${leak.path} (${leak.message})`); return 4; }

  const outDir = path.resolve(String(flags.out || path.join(TOOL_ROOT, 'docs', 'inventory')));
  fs.mkdirSync(outDir, { recursive: true });
  const tasks = buildConstructionTasks(rows);

  fs.writeFileSync(path.join(outDir, 'repo-coverage.json'), `${JSON.stringify({ generated_by: `${TOOL_NAME} ${profileRef}`, columns: COVERAGE_COLUMNS, repos: rows }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, 'repo-coverage.md'), renderCoverageMd({ rows, profileRef, unreadable }));
  // The gate compares THIS file, not the full table: a row the reader could not see is compared
  // by (repo, read_state) only, so the gate's answer does not depend on which authorized reader
  // ran it. Without it the gate compared a table whose content changed with the token's scope.
  fs.writeFileSync(path.join(outDir, 'repo-coverage.stable.json'), renderStableJson({ rows, profileRef, unreadable }));
  fs.writeFileSync(path.join(outDir, 'construction-tasks.md'), renderConstructionTasksMd({ tasks, profileRef, applied: false }));

  out(`inventory: ${rows.length} repositories · ${unreadable} not visible · profile_ref ${profileRef}`);
  for (const r of rows) out(`  ${r.read_state.padEnd(9)} ${r.repo} · profile=${r.profile ?? '—'} · adapter=${r.adapter ?? '—'} · ci=${r.ci_present} · staging=${r.staging_present}/${r.staging_required ?? '—'}`);
  out(`written: ${path.relative(process.cwd(), outDir) || outDir}/repo-coverage.{json,md,stable.json}, construction-tasks.md (dry-run — no issue was created)`);

  // Report-only by default: a repository this reader cannot see is data, not a broken run. `--strict` is for
  // the gate that must not accept a blind spot (design §2.1 lists 4; the rehearsal demands 0).
  return flags.strict && unreadable ? 4 : 0;
}

// ── check-docs ─────────────────────────────────────────────────────────────────
function cmdCheckDocs(flags) {
  const dir = path.resolve(String(flags.dir || '.'));
  const r = checkDocs(dir);
  out(`check-docs: ${r.scanned.md} markdown · ${r.scanned.json} json · ${r.violations.length} violation(s)`);
  if (r.violations.length) out(formatViolations(r.violations));
  return r.ok ? 0 : 1;
}

// ── check-workflows ────────────────────────────────────────────────────────────
function cmdCheckWorkflows(flags) {
  const dir = path.resolve(String(flags.dir || '.'));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort() : [];
  const violations = [];
  for (const f of files) {
    if (!/-?callable\.ya?ml$/.test(f)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { violations.push(`${f}: unreadable`); continue; }
    // A file named *-callable.yml that cannot be called is the exact regression R26 describes:
    // an installer points at it, the consumer's `uses:` silently fails to compose.
    if (!/workflow_call\s*:/.test(text)) violations.push(`${f}: named as callable but does not declare \`on: workflow_call\``);
    // A delivery boundary that can drift is not a boundary. R2: templates/batch-fix-prs.yml
    // fetched the tool from `main` — the exact invariant autofix-callable.yml refuses to break —
    // so a caller pinned a commit and executed whatever the branch held. Rule, not a one-off fix:
    // the same mistake in the next template must fail here too.
    if (/raw\.githubusercontent\.com\/[^\s"']+\/(main|master)\//.test(text)) {
      violations.push(`${f}: downloads the tool from a moving branch (main/master) — pin a commit SHA`);
    }
    // Fail-open around a NETWORK or DESTRUCTIVE call (R4 class, §5.4). `gh … 2>/dev/null || echo
    // NOT_FOUND` and `… || true` make "I could not ask GitHub" indistinguishable from "the thing
    // does not exist" — and the step then reports success having done nothing. Scoped to `gh` and
    // `curl` deliberately: a `grep` that finds no marker IS "no marker", and flagging that would
    // be a rule nobody could satisfy.
    for (const m of text.matchAll(/^.*\b(?:gh|curl)\b[^\n]*\|\|\s*(?:true|echo\b[^\n]*).*$/gm)) {
      violations.push(`${f}: swallows a gh/curl failure with \`||\` — an unreachable API must not read as "nothing to do": ${m[0].trim().slice(0, 120)}`);
    }
  }
  out(`check-workflows: ${files.length} workflow file(s) in ${path.relative(process.cwd(), dir) || '.'} · ${violations.length} violation(s)`);
  if (violations.length) violations.forEach(v => out(`  · ${v}`));
  return violations.length ? 1 : 0;
}

// ── run-derived-check ──────────────────────────────────────────────────────────
function cmdRunDerivedCheck(flags) {
  const dir = path.resolve(String(flags.dir || '.'));
  const pkgPath = path.join(dir, 'package.json');
  const have = f => fs.existsSync(path.join(dir, f));
  const npmOk = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], { encoding: 'utf8', timeout: 30_000 }).status === 0;

  let cmd = null;
  if (have('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) { out(`derived check: package.json is not valid JSON: ${e.message}`); return 1; }
    const scripts = pkg.scripts || {};
    const pick = ['test', 'check', 'lint', 'build'].find(s => scripts[s]);
    if (npmOk && pick) cmd = pick === 'test' ? 'npm test' : `npm run ${pick}`;
    else if (pick && /^node\s+\S/.test(String(scripts[pick]).trim())) {
      // npm is not on PATH here (the staging rehearsal deliberately strips it): a script that is
      // literally `node <file>` can be run as written, and the derivation stays visible.
      cmd = String(scripts[pick]).trim();
    } else if (npmOk) cmd = 'npm ci --ignore-scripts';
  } else if (have('pyproject.toml') || have('setup.py')) {
    const pyproject = have('pyproject.toml') ? fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8') : '';
    cmd = /pytest/.test(pyproject) ? 'python -m pytest -q' : 'python -m compileall -q .';
  } else {
    cmd = `node ${expandCommand('{{devbaseline}}')} check-docs --dir .`;
  }

  out(`derived check: ${cmd}`);
  const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === null ? 1 : r.status;
}

// ── payload-manifest / payload-verify ──────────────────────────────────────────
// The delivery boundary as a checked artifact (R2). `--check` is the CI mode: verify only, never
// write, so CI cannot "fix" a stale manifest by regenerating it and going green.
function cmdPayloadManifest(flags) {
  const file = path.resolve(String(flags.out || path.join(TOOL_ROOT, MANIFEST_FILENAME)));
  const rendered = renderManifest({
    repoDir: TOOL_ROOT,
    toolSha: flags.sha ? String(flags.sha) : process.env.DEVBASELINE_TOOL_SHA || null,
    toolRef: flags.ref ? String(flags.ref) : process.env.DEVBASELINE_TOOL_REF || null,
  });
  if (flags.check) {
    const onDisk = readManifest(file);
    if (!onDisk.ok) { out(`payload-manifest: ${onDisk.message}`); return 1; }
    const v = verifyManifest(onDisk.manifest, TOOL_ROOT);
    if (!v.ok) {
      out(`payload-manifest: STALE — ${file}`);
      for (const p of v.missing) out(`  · missing: ${p}`);
      for (const p of v.hash_mismatch) out(`  · changed since the manifest was written: ${p}`);
      for (const p of v.undeclared) out(`  · in the tree but NOT declared: ${p}`);
      if (v.reason) out(`  · ${v.reason}`);
      out('  → regenerate: node scripts/devbaseline.mjs payload-manifest --out ' + file);
      return 1;
    }
    out(`payload-manifest: current — ${onDisk.manifest.entries.length} entries, hashes match the tree`);
    return 0;
  }
  fs.writeFileSync(file, `${JSON.stringify(rendered, null, 2)}\n`);
  out(`payload-manifest: ${rendered.entries.length} entries → ${path.relative(process.cwd(), file) || file}`);
  return 0;
}

function cmdPayloadVerify(flags) {
  const file = path.resolve(String(flags.manifest || path.join(TOOL_ROOT, MANIFEST_FILENAME)));
  const dir = path.resolve(String(flags.dir || TOOL_ROOT));
  const m = readManifest(file);
  if (!m.ok) { out(`payload-verify: ${m.message}`); return 1; }
  const v = verifyManifest(m.manifest, dir);
  out(`payload-verify: ${m.manifest.entries.length} declared · ${v.ok ? 'complete and matching' : 'INCOMPLETE'}`);
  if (!v.ok) {
    for (const p of v.missing) out(`  · missing: ${p}`);
    for (const p of v.hash_mismatch) out(`  · hash mismatch: ${p}`);
    for (const p of v.undeclared) out(`  · undeclared in tree: ${p}`);
    if (v.reason) out(`  · ${v.reason}`);
    return 1;
  }
  return 0;
}

// ── dispatch ───────────────────────────────────────────────────────────────────
const HELP = `devbaseline — inventory and a common development baseline for participating repositories.

  validate         [--adapter <f> | --repo <d> | --all-profiles]
  verify           --repo <d> [--profile <id>] [--log <f>] [--attempt <n>] [--no-fix]
  context          --manifest <f>
  inventory        --out <d> [--repos <f>] [--strict]
  check-docs       --dir <d>
  check-workflows  --dir <d>
  run-derived-check --dir <d>
  payload-manifest [--out <f>] [--check] [--sha <s>] [--ref <r>]
  payload-verify   [--manifest <f>] [--dir <d>]
  gate             --repo <d> [--profile <id>] [--log <f>]

Profiles live in profiles/ (single source of truth). A repository stores only a thin
.devbaseline.json adapter pinning what cannot be derived: check command, staging command,
autofix ref, credential NAMES. Credential values are a schema violation, never a warning.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgv(rest);
  if (!command || flags.help || command === 'help') { out(HELP); return command ? 0 : 1; }

  switch (command) {
    case 'validate': return cmdValidate(flags);
    case 'verify': return cmdVerify(flags);
    case 'context': return cmdContext(flags);
    case 'inventory': return cmdInventory(flags);
    case 'check-docs': return cmdCheckDocs(flags);
    case 'check-workflows': return cmdCheckWorkflows(flags);
    case 'run-derived-check': return cmdRunDerivedCheck(flags);
    case 'payload-manifest': return cmdPayloadManifest(flags);
    case 'payload-verify': return cmdPayloadVerify(flags);
    case 'gate': return cmdGate(flags);
    default:
      out(`unknown command "${command}"${positional.length ? ` (args: ${positional.join(' ')})` : ''}`);
      out(HELP);
      return 3;
  }
}

main().then(code => process.exit(code)).catch((e) => {
  process.stderr.write(`devbaseline: ${e && e.stack ? e.stack : e}\n`);
  process.exit(3);
});
// Inventory: the coverage table (AC-40).
//
// One row per participating repository, every column always present. `*_present` and
// `*_required` are SEPARATE columns on purpose: collapsing them turns "a job named staging
// exists" into "staging is green", which is the specific lie the owner rule (2026-09-16)
// exists to prevent. A column that is unknown is `null`, never `false`.
//
// The repository list is an INPUT (inventory/repos.json), not a discovery scan: a table that
// silently enumerated every repository in the organisation could not be checked by acceptance.

import fs from 'node:fs';
import path from 'node:path';
import { loadAdapter, effectiveConfig, ADAPTER_FILENAME } from './adapter.mjs';
import { resolveProfile, profileHasBuild, listProfileIds } from './profile.mjs';
import { toolVersion } from './log.mjs';
import { findSecretValues } from './secrets.mjs';

export const COVERAGE_COLUMNS = [
  'repo', 'owner', 'type', 'profile', 'profile_ref', 'adapter', 'build', 'check', 'fix', 'verify',
  'context', 'logs', 'ci_present', 'ci_required', 'staging_present', 'staging_required',
  'autofix_ref', 'readable', 'notes',
];

const EMPTY = (repo, owner) => ({
  repo, owner, type: null, profile: null, profile_ref: toolVersion(), adapter: null, build: null,
  check: null, fix: null, verify: null, context: null, logs: null,
  ci_present: false, ci_required: null, staging_present: false, staging_required: null,
  autofix_ref: null, readable: false, notes: [],
});

const DEFAULT_AUTOFIX_REF = 'v1.7.4';

function workflows(dir) {
  const d = path.join(dir, '.github', 'workflows');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => /\.ya?ml$/.test(f));
}

/** A staging job is a job whose id/name mentions staging. Presence is NOT health. */
function hasStagingJob(dir) {
  const d = path.join(dir, '.github', 'workflows');
  if (!fs.existsSync(d)) return false;
  for (const f of fs.readdirSync(d).filter(x => /\.ya?ml$/.test(x))) {
    let text = '';
    try { text = fs.readFileSync(path.join(d, f), 'utf8'); } catch { continue; }
    if (/^\s{0,4}(staging|stage|deploy-staging)[\w-]*\s*:/m.test(text) || /\bstaging[-_]?gate\b/i.test(text)) return true;
  }
  return false;
}

export function scanLocal(entry, profileRef = toolVersion()) {
  const repo = entry.repo;
  const owner = repo.includes('/') ? repo.split('/')[0] : '';
  const dir = path.resolve(entry.path);
  const notes = [];

  if (!fs.existsSync(dir)) {
    const row = EMPTY(repo, owner);
    row.notes = [`unreadable: local path does not exist (${entry.path})`];
    return row;
  }

  const adapterResult = loadAdapter(dir);
  if (!adapterResult.ok) {
    const row = EMPTY(repo, owner);
    row.notes = [`adapter_schema_violation: ${adapterResult.message}`];
    return row;
  }

  const prof = resolveProfile({ repoDir: dir, typeHint: entry.type_hint || null });
  if (!prof.ok) {
    const row = EMPTY(repo, owner);
    row.notes = [`${prof.rule_id}: ${prof.message}`];
    return row;
  }

  const profile = prof.profile;
  const config = effectiveConfig({ profile, adapter: adapterResult.adapter });
  const callableRel = config.fix_autofix_callable;
  const entrypointsPresent = config.context_entrypoints.filter(e => fs.existsSync(path.join(dir, e)));

  const ciFiles = workflows(dir);
  const ciPresent = ciFiles.length > 0;
  const stagingPresent = hasStagingJob(dir) || Boolean(config.staging_command);
  const docsOnly = profile.repo_type === 'docs';
  const stagingRequired = docsOnly ? false : config.staging_required;
  if (docsOnly) notes.push('staging_required=false: docs_only');
  if (profile.id === 'minimal') notes.push('check: missing — no recognised entrypoint (profile minimal)');
  if (callableRel && !fs.existsSync(path.join(dir, callableRel))) notes.push(`fix: missing — repository has no ${callableRel}`);
  if (!callableRel) notes.push(`fix: unsupported_by_profile (profile ${profile.id} declares no fixer)`);
  if (stagingRequired && !stagingPresent) notes.push('staging: missing — required but absent');
  if (!ciPresent) notes.push('ci: missing — no workflow in .github/workflows');
  if (adapterResult.adapter === null) notes.push(`adapter: derived (${prof.derivation})`);

  return {
    repo,
    owner,
    type: entry.type_hint || profile.repo_type,
    profile: profile.id,
    profile_ref: profileRef,
    adapter: adapterResult.adapter === null ? 'derived' : 'file',
    build: profileHasBuild(profile),
    check: config.check_commands,
    fix: { autofix_callable: callableRel, fixer_present: Boolean(callableRel) && fs.existsSync(path.join(dir, callableRel)), cap: config.fix_cap, supported: Boolean(callableRel) },
    verify: config.verify_commands,
    context: { builder: profile.context.builder, entrypoints_present: entrypointsPresent },
    logs: { contract_version: profile.logs.contract_version, retention_days: config.logs.retention_days },
    ci_present: ciPresent,
    ci_required: typeof entry.ci_required === 'boolean' ? entry.ci_required : null,
    staging_present: stagingPresent,
    staging_required: stagingRequired,
    autofix_ref: config.fix_ref || (callableRel ? DEFAULT_AUTOFIX_REF : null),
    readable: true,
    notes,
  };
}

/** Live mode: read-only metadata via the GitHub API. No writes, no tokens beyond the reader's. */
async function scanRemote(entry, profileRef = toolVersion()) {
  const row = EMPTY(entry.repo, entry.repo.includes('/') ? entry.repo.split('/')[0] : '');
  if (!process.env.GH_TOKEN) {
    row.notes = ['unreadable: no local path and no GH_TOKEN — supply `path` (offline) or GH_TOKEN (live)'];
    return row;
  }
  const [owner, name] = entry.repo.split('/');
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const get = async (p) => {
    const r = await fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    const repo = await get('');
    const wfs = await get('/actions/workflows?per_page=100');
    const names = (wfs.workflows || []).map(w => w.name);
    row.readable = true;
    row.ci_present = names.length > 0;
    row.ci_required = null;
    row.staging_present = names.some(n => /staging/i.test(n));
    row.autofix_ref = DEFAULT_AUTOFIX_REF;
    row.notes.push(`live: default_branch=${repo.default_branch}, workflows=${names.length}`);
    if (!row.staging_present) row.notes.push('staging: missing — no workflow named *staging*');
  } catch (e) {
    row.notes = [`unreadable: GitHub API ${e.message}`];
  }
  row.profile_ref = profileRef;
  return row;
}

/** @returns {Promise<{rows: object[], unreadable: number}>} */
export async function buildCoverage(entries, { profileRef = toolVersion() } = {}) {
  const rows = [];
  for (const e of entries) {
    rows.push(e.path ? scanLocal(e, profileRef) : await scanRemote(e, profileRef));
  }
  rows.sort((a, b) => a.repo.localeCompare(b.repo));
  return { rows, unreadable: rows.filter(r => !r.readable).length };
}

export function renderCoverageMd({ rows, profileRef, unreadable }) {
  const head = [
    '<!-- GENERATED by `node scripts/devbaseline.mjs inventory` (Z01). Do not edit by hand. -->',
    '',
    '# Repository coverage',
    '',
    `Built by pr-autofix \`${profileRef}\` · ${rows.length} repositories · ${unreadable} unreadable.`,
    '',
    '`*_present` is what exists. `*_required` is what the merge rule demands. They are',
    'deliberately different columns: presence of a job is not a green job.',
    '',
    `Profiles shipped: ${listProfileIds().join(', ')}. Credentials appear as NAMES only.`,
    '',
  ].join('\n');
  const table = [
    `| ${COVERAGE_COLUMNS.join(' | ')} |`,
    `|${COVERAGE_COLUMNS.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${COVERAGE_COLUMNS.map(c => cell(r, c)).join(' | ')} |`),
    '',
  ].join('\n');
  return `${head}${table}`;
}

function cell(row, col) {
  const v = row[col];
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? `\`${v.join(' ')}\`` : '—';
  if (typeof v === 'object') return `\`${JSON.stringify(v).replace(/\|/g, '\\|')}\``;
  return String(v).replace(/\|/g, '\\|');
}

/** Guard before anything is written: no credential value may leave the process (AC-07). */
export function assertNoSecretValues(rows) {
  const hits = rows.flatMap(r => findSecretValues(r, r.repo));
  if (!hits.length) return null;
  return hits[0];
}
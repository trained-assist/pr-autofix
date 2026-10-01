// Inventory: the coverage table (AC-40).
//
// One row per participating repository, every column always present. `*_present` and
// `*_required` are SEPARATE columns on purpose: collapsing them turns "a job named staging
// exists" into "staging is green", which is the specific lie the owner rule (2026-09-16)
// exists to prevent. A column that is unknown is `null`, never `false`.
//
// The repository list is an INPUT (inventory/repos.json), not a discovery scan: a table that
// silently enumerated every repository in the organisation could not be checked by acceptance.
//
// ── One derivation, two sources ─────────────────────────────────────────────────
// `scanSource` is the ONLY place a row is built. It talks to a repository exclusively through a
// source (source.mjs), so the local checkout and the live GitHub API produce columns from the
// same code and cannot disagree. The earlier shape — `scanLocal` filling 18 columns and
// `scanRemote` filling 5 — is what made the live table empty and made pr-autofix report
// `staging_present: no` for itself while its own staging-gate job was green.

import fs from 'node:fs';
import path from 'node:path';
import { parseAdapterText, effectiveConfig } from './adapter.mjs';
import { profileHasBuild, listProfileIds } from './profile.mjs';
import { resolveRepo } from './resolve.mjs';
import { toolVersion } from './log.mjs';
import { findSecretValues } from './secrets.mjs';
import { localSource, liveSource, workflowFiles } from './source.mjs';

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

// ── Staging detection: one definition, both paths ──────────────────────────────
// A staging job is a JOB whose id/name mentions staging. A workflow FILE whose name mentions
// staging is not one: in this very repository the `staging-gate` job lives inside ci.yml (proof:
// CI run on merge-commit 335e7601, job staging-gate = success), so name-only detection wrote
// `staging_present: no` for the one repository that certainly has staging — a false construction
// task and a false merge blocker under R7.
const STAGING_JOB_RE = /^\s{0,4}(?:staging|stage|deploy-staging)[\w-]*\s*:/m;
const STAGING_GATE_RE = /\bstaging[-_]?gate\b/i;

function textHasStagingJob(text) {
  return STAGING_JOB_RE.test(text) || STAGING_GATE_RE.test(text);
}

/** @param {{readText: (rel: string) => Promise<string|null>, files: Set<string>}} source */
async function hasStagingJob(source) {
  for (const f of workflowFiles(source)) {
    const text = await source.readText(f);
    if (text !== null && textHasStagingJob(text)) return true;
  }
  return false;
}

/**
 * Build one row from any source. `adapterRaw` is the adapter text (or null when absent).
 * @param {{repo: string, owner: string, type_hint?: string|null, ci_required?: boolean|null,
 *          note?: string}} entry
 * @param {{kind: string, origin: string, readable: boolean, files: Set<string>,
 *          has: (rel: string) => boolean, readText: (rel: string) => Promise<string|null>}} source
 */
export async function scanSource(entry, source, profileRef = toolVersion()) {
  const repo = entry.repo;
  const owner = repo.includes('/') ? repo.split('/')[0] : '';
  const notes = [];

  if (!source.readable) {
    const row = EMPTY(repo, owner);
    row.notes = [`unreadable: ${source.kind === 'local' ? `local path does not exist` : `repository is not readable through the API`} (${entry.path || source.origin})`];
    return row;
  }

  // The adapter is read through the source, so the live path validates the same file the local
  // path does instead of silently assuming "no adapter".
  const adapterRaw = await source.readText('.devbaseline.json');
  const adapterResult = parseAdapterText(adapterRaw);
  if (!adapterResult.ok) {
    const row = EMPTY(repo, owner);
    row.notes = [`${adapterResult.rule_id}: ${adapterResult.message}`];
    return row;
  }
  // One seam with validate/verify (R5). The adapter is read through the SOURCE (local path or the
  // GitHub API), so what was read is passed in rather than re-read from disk — two reads would be
  // two answers to "what did this repository pin".
  const prof = resolveRepo({ repoDir: '.', exists: source.has, typeHint: entry.type_hint || null, adapter: adapterResult });
  if (!prof.ok) {
    const row = EMPTY(repo, owner);
    row.notes = [`${prof.rule_id}: ${prof.message}`];
    return row;
  }

  const profile = prof.profile;
  const config = effectiveConfig({ profile, adapter: adapterResult.adapter });
  const callableRel = config.fix_autofix_callable;
  const entrypointsPresent = config.context_entrypoints.filter(e => source.has(e));
  const wfFiles = workflowFiles(source);

  const ciPresent = wfFiles.length > 0;
  const stagingPresent = (await hasStagingJob(source)) || Boolean(config.staging_command);
  const docsOnly = profile.repo_type === 'docs';
  const stagingRequired = docsOnly ? false : config.staging_required;
  if (docsOnly) notes.push('staging_required=false: docs_only');
  if (profile.id === 'minimal') notes.push('check: missing — no recognised entrypoint (profile minimal)');
  if (callableRel && !source.has(callableRel)) notes.push(`fix: missing — repository has no ${callableRel}`);
  if (!callableRel) notes.push(`fix: unsupported_by_profile (profile ${profile.id} declares no fixer)`);
  if (stagingRequired && !stagingPresent) notes.push('staging: missing — required but absent');
  if (!ciPresent) notes.push('ci: missing — no workflow in .github/workflows');
  if (adapterResult.adapter === null) notes.push(`adapter: derived (${prof.derivation})`);
  if (source.kind === 'live') {
    notes.push(`live: branch=${source.defaultBranch}, files=${source.files.size}, workflows=${wfFiles.length}${source.truncated ? ', tree TRUNCATED by GitHub — file list is partial' : ''}`);
  }
  if (entry.note) notes.push(`scope: ${entry.note}`);

  return {
    repo,
    owner,
    type: entry.type_hint || profile.repo_type,
    profile: profile.id,
    profile_ref: profileRef,
    adapter: adapterResult.adapter === null ? 'derived' : 'file',
    build: profileHasBuild(profile),
    check: config.check_commands,
    fix: { autofix_callable: callableRel, fixer_present: Boolean(callableRel) && source.has(callableRel), cap: config.fix_cap, supported: Boolean(callableRel) },
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

/** Local checkout path (kept as a named export: the sandbox and callers address it directly). */
export async function scanLocal(entry, profileRef = toolVersion()) {
  return scanSource(entry, localSource(entry.path), profileRef);
}

/** Live path. Requires GH_TOKEN; without it the row says so instead of guessing. */
async function scanRemote(entry, profileRef = toolVersion()) {
  const repo = entry.repo;
  const parts = repo.split('/').filter(Boolean);
  const owner = parts.length ? parts[0] : '';
  if (parts.length !== 2) {
    // Say what is wrong with the INPUT instead of asking the API about a name we invented.
    // `owner/extra/name` used to be silently truncated to `owner/name` and came back as
    // `unreadable: HTTP 404` — a fact about the API, offered as an answer about the repository.
    const row = EMPTY(repo, owner);
    row.notes = [`input_invalid: repository id must be "owner/name" (got "${repo}"); supply \`path\` for a local checkout`];
    return row;
  }
  if (!process.env.GH_TOKEN) {
    const row = EMPTY(repo, owner);
    row.notes = ['unreadable: no local path and no GH_TOKEN — supply `path` (offline) or GH_TOKEN (live)'];
    return row;
  }
  const name = parts[1];
  try {
    const source = await liveSource({ owner, name });
    return await scanSource(entry, source, profileRef);
  } catch (e) {
    const row = EMPTY(repo, owner);
    row.notes = [`unreadable: GitHub API ${e.message}`];
    return row;
  }
}

/** @returns {Promise<{rows: object[], unreadable: number}>} */
export async function buildCoverage(entries, { profileRef = toolVersion() } = {}) {
  const rows = [];
  for (const e of entries) {
    rows.push(e.path ? await scanLocal(e, profileRef) : await scanRemote(e, profileRef));
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

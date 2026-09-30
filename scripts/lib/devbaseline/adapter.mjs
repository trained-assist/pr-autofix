// The thin per-repository adapter (.devbaseline.json) — optional by design.
//
// Why optional: a repo that must hand-write a config to be checked at all is a repo nobody
// will onboard. The profile is DERIVED from the file tree; the adapter exists only to pin
// what cannot be derived — the check command, the staging command, the autofix ref, the
// credential NAMES. The coverage table records `adapter: derived | file` so a reader always
// knows whether a row was derived or pinned, and can therefore tell a wrong derivation from
// a deliberate pin.

import fs from 'node:fs';
import path from 'node:path';
import { validateAgainstSchema } from './schema.mjs';
import { adapterSchema } from './profile.mjs';
import { findSecretValues } from './secrets.mjs';

export const ADAPTER_FILENAME = '.devbaseline.json';

export function adapterPath(repoDir) { return path.join(repoDir, ADAPTER_FILENAME); }

/**
 * @returns {{ok: true, adapter: object, source: 'file'} | {ok: true, adapter: null, source: 'derived'}
 *          | {ok: false, rule_id: string, message: string, violations: object[]}}
 */
export function loadAdapter(repoDir) {
  const p = adapterPath(repoDir);
  if (!fs.existsSync(p)) return { ok: true, adapter: null, source: 'derived' };

  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    return { ok: false, rule_id: 'adapter_schema_violation', message: `${ADAPTER_FILENAME} is unreadable: ${e.message}`, violations: [] };
  }
  return parseAdapterText(raw);
}

/**
 * Parse adapter TEXT. `null`/`undefined` means the adapter file is absent — the honest
 * `derived`, not a failure and not an empty object.
 *
 * This is the shared implementation: a live source reads the file over the API and validates it
 * here, so "is this adapter valid" has exactly one answer whether the text came from disk or
 * from the network. A live scan that skipped validation would report a broken repository as
 * fine; a live scan that re-implemented the rules would drift from `validate`.
 *
 * @param {string|null|undefined} raw
 * @returns {{ok: true, adapter: object|null, source: 'file'|'derived'}
 *          | {ok: false, rule_id: string, message: string, violations: object[]}}
 */
export function parseAdapterText(raw) {
  if (raw === null || raw === undefined) return { ok: true, adapter: null, source: 'derived' };

  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    return {
      ok: false, rule_id: 'adapter_schema_violation',
      message: `${ADAPTER_FILENAME} is not valid JSON: ${e.message}`, violations: [],
    };
  }

  const { valid, errors } = validateAgainstSchema(adapterSchema(), parsed);
  // A secret-shaped value is a schema violation, not a warning: AC-07 says no credential
  // values in logs/trace/issue/commit/docs, and an adapter is a committed doc.
  const secretHits = findSecretValues(parsed);
  const violations = [
    ...errors.map(e => ({ path: e.path, rule_id: 'adapter_schema_violation', message: e.message })),
    ...secretHits,
  ];
  if (!valid || secretHits.length) {
    return { ok: false, rule_id: 'adapter_schema_violation', message: violations[0] && `${ADAPTER_FILENAME}: ${violations[0].path}: ${violations[0].message}`, violations };
  }
  return { ok: true, adapter: parsed, source: 'file' };
}

/**
 * Merge profile + adapter into the effective configuration the runner executes.
 * Adapter wins only where it says something; everything else stays derived.
 */
export function effectiveConfig({ profile, adapter }) {
  const a = adapter || {};
  return {
    profile_id: profile.id,
    repo_type: profile.repo_type,
    check_commands: a.check?.commands?.length ? a.check.commands : profile.check.commands,
    build: a.check?.build !== undefined ? a.check.build : profile.check.build,
    check_working_dir: profile.check.working_dir || null,
    fix_autofix_callable: a.autofix?.enabled === false ? null : (profile.fix.autofix_callable || null),
    fix_ref: a.autofix?.ref || null,
    fix_cap: profile.fix.cap,
    verify_commands: a.check?.commands?.length ? a.check.commands : profile.verify.commands,
    context_entrypoints: a.context?.entrypoints?.length ? a.context.entrypoints : profile.context.entrypoints,
    staging_required: a.staging?.required === undefined ? profile.repo_type !== 'docs' : a.staging.required,
    staging_command: a.staging?.command === undefined ? null : a.staging.command,
    credentials: (a.credentials || []).map(c => (typeof c === 'string' ? c : c.name)),
    logs: { ...profile.logs, retention_days: a.logs?.retention_days ?? profile.logs.retention_days },
    budget: profile.budget || { diff_tokens: 4000, log_tokens: 2500, max_files: 15, max_lines: 400 },
    adapter: a.schema_version ? 'file' : 'derived',
  };
}
// Profile resolution: load the five shipped profiles, validate them against the published
// contract, and DERIVE the right one from a repository's file tree.
//
// Two properties are load-bearing:
//   1. Derivation is deterministic and first-match — no network, no guessing from the repo
//      NAME (a repo called "docs" that contains TypeScript is a node repo).
//   2. There is no `extends`. Five small self-contained files cost less than a resolution
//      order, and a profile-resolution order is precisely the class of bug a coverage table
//      cannot explain when it is wrong.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema } from './schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOOL_ROOT = path.resolve(HERE, '..', '..', '..');
export const PROFILES_DIR = path.join(TOOL_ROOT, 'profiles');
export const CONTRACTS_DIR = path.join(TOOL_ROOT, 'contracts');
export const CLI_PATH = path.join(TOOL_ROOT, 'scripts', 'devbaseline.mjs');

const PROFILE_IDS = ['docs', 'node', 'python', 'mixed', 'minimal'];

/** Entry-point signals per stack. Presence, not content — no package-name heuristics. */
const SIGNALS = {
  node: ['package.json'],
  python: ['pyproject.toml', 'setup.py', 'requirements.txt'],
  docs: ['README.md', 'README.rst', 'index.md'],
};

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
};

let schemaCache = null;
export function profileSchema() {
  if (!schemaCache) schemaCache = readJson(path.join(CONTRACTS_DIR, 'devbaseline-profile.schema.json'));
  return schemaCache;
}

let adapterSchemaCache = null;
export function adapterSchema() {
  if (!adapterSchemaCache) adapterSchemaCache = readJson(path.join(CONTRACTS_DIR, 'devbaseline-adapter.schema.json'));
  return adapterSchemaCache;
}

/** All shipped profile ids, in a stable order (never directory-listing order). */
export function listProfileIds() { return [...PROFILE_IDS]; }

/** @returns {{ok: true, profile: object} | {ok: false, rule_id: string, message: string}} */
export function loadProfile(id) {
  if (!PROFILE_IDS.includes(id)) {
    return { ok: false, rule_id: 'profile_unknown', message: `unknown profile "${id}" (known: ${PROFILE_IDS.join(', ')})` };
  }
  const profile = readJson(path.join(PROFILES_DIR, `${id}.json`));
  if (!profile) return { ok: false, rule_id: 'profile_unknown', message: `profile file profiles/${id}.json is missing or is not valid JSON` };
  const { valid, errors } = validateAgainstSchema(profileSchema(), profile);
  if (!valid) {
    const e = errors[0];
    return { ok: false, rule_id: 'adapter_schema_violation', message: `profile ${id} violates contract at ${e.path}: ${e.message}` };
  }
  if (profile.id !== id) return { ok: false, rule_id: 'adapter_schema_violation', message: `profile file ${id}.json declares id "${profile.id}"` };
  return { ok: true, profile };
}

/** Validate every shipped profile. Used by the staging-gate and by `validate --all-profiles`. */
export function validateAllProfiles() {
  return PROFILE_IDS.map(id => ({ id, ...loadProfile(id) }));
}

/**
 * Derive the profile id from a repository directory. Deterministic, offline, no name
 * heuristics. Order is load-bearing and is the first match wins:
 *   mixed  → both stacks present
 *   node   → package.json
 *   python → pyproject.toml / setup.py / requirements.txt
 *   docs   → no code stack, but a documentation entrypoint
 *   minimal→ nothing recognised (its check is an explicit `missing` no-op)
 */
export function deriveProfileId(repoDir) {
  const has = f => fs.existsSync(path.join(repoDir, f));
  const node = SIGNALS.node.filter(has);
  const python = SIGNALS.python.filter(has);
  const docs = SIGNALS.docs.filter(has);
  const gitOnly = ['.git'].every(has) && !node.length && !python.length && !docs.length;

  if (node.length && python.length) return { id: 'mixed', reason: `both stacks present (${node.join(', ')} + ${python.join(', ')})` };
  if (node.length) return { id: 'node', reason: `${node.join(', ')} present` };
  if (python.length) return { id: 'python', reason: `${python.join(', ')} present` };
  if (docs.length) return { id: 'docs', reason: `no code stack, ${docs.join(', ')} present` };
  return { id: 'minimal', reason: gitOnly ? 'only git metadata, no recognised entrypoint' : 'no recognised entrypoint' };
}

/** Does this profile run a build? Docs/minimal never do — checked as a property, not a comment. */
export function profileHasBuild(profile) {
  return Array.isArray(profile?.check?.build) && profile.check.build.length > 0;
}

/**
 * Resolve the effective profile for a repository.
 * @returns {{ok: true, profile: object, source: 'explicit'|'hint'|'derived', derivation: string}
 *          |{ok: false, rule_id: string, message: string}}
 */
export function resolveProfile({ repoDir, profileId = '', typeHint = null } = {}) {
  if (profileId) {
    const r = loadProfile(profileId);
    return r.ok ? { ok: true, profile: r.profile, source: 'explicit', derivation: 'requested with --profile' } : r;
  }
  if (typeHint) {
    const r = loadProfile(typeHint);
    return r.ok ? { ok: true, profile: r.profile, source: 'hint', derivation: `type_hint in the repository list` } : r;
  }
  const d = deriveProfileId(repoDir || TOOL_ROOT);
  const r = loadProfile(d.id);
  return r.ok ? { ok: true, profile: r.profile, source: 'derived', derivation: d.reason } : r;
}

/** Expand the `{{devbaseline}}` token in a profile command to the absolute CLI path. */
export function expandCommand(cmd) {
  return String(cmd).replace(/\{\{devbaseline\}\}/g, CLI_PATH);
}
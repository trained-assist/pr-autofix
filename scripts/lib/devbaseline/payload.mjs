// The delivery boundary, made a first-class checked artifact.
//
// R2: the shipped loader (`devbaseline-callable.yml`) fetched ~20 files into a FLAT directory via
// `$(basename "$f")` and then ran `node --check`. The CLI imports `./lib/devbaseline/*.mjs`, so
// the very first real invocation failed with ERR_MODULE_NOT_FOUND — and the check stayed GREEN,
// because `node --check` parses one file and never resolves imports (proven in the root-cause
// report). The consumer got a broken CLI and a passing gate, which is worse than no gate: the
// repository passed a check that did not exist.
//
// Three fixes were deliberately NOT taken, because each leaves the class alive:
//   · preserving the tree inside the hand-written list — the list stays prose, so the NEXT module
//     ships broken silently (this is the structural relapse the report named);
//   · `node --check` alone — proven blind to imports;
//   · unpacking the whole repository — drags fixtures/docs/.git into the runner and blurs what
//     the boundary is.
//
// So the composition of the payload is DECLARED, not listed: payloadEntries() reads the actual
// tree, renderManifest() hashes it into a committed manifest, verifyManifest() checks both
// directions — missing AND undeclared. `undeclared` is the anti-relapse guard: adding a module
// without regenerating the manifest fails the gate instead of shipping broken.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TOOL_ROOT, listProfileIds } from './profile.mjs';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILENAME = 'payload.manifest.json';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const listFiles = (dir, filter) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && filter(e.name))
    .map(e => path.join(dir, e.name))
    .sort();
};

/**
 * The payload, enumerated from the TREE — never from a hand-kept list.
 * @returns {string[]} repo-relative POSIX paths
 */
export function payloadEntries(repoDir = TOOL_ROOT) {
  const rel = (abs) => path.relative(repoDir, abs).split(path.sep).join('/');
  const out = [
    ...listFiles(path.join(repoDir, 'scripts'), n => n === 'devbaseline.mjs'),
    ...listFiles(path.join(repoDir, 'scripts', 'lib', 'devbaseline'), n => n.endsWith('.mjs')),
    ...listFiles(path.join(repoDir, 'contracts'), n => n.endsWith('.json')),
    // The shipped profile ids come from the profile module, not from a directory listing: an
    // unknown profiles/*.json must not silently become payload.
    ...listProfileIds().map(id => path.join(repoDir, 'profiles', `${id}.json`)),
  ];
  return out.filter(p => fs.existsSync(p)).map(rel).sort();
}

/** @returns {object} the manifest object (caller decides whether to write it) */
export function renderManifest({ repoDir = TOOL_ROOT, toolSha = null, toolRef = null } = {}) {
  const entries = payloadEntries(repoDir).map((rel) => {
    const buf = fs.readFileSync(path.join(repoDir, rel));
    return { path: rel, sha256: sha256(buf), bytes: buf.length };
  });
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    tool: { name: 'pr-autofix', ...(toolSha ? { commit: toolSha } : {}), ...(toolRef ? { ref: toolRef } : {}) },
    generated_by: 'devbaseline payload-manifest',
    // The SHA this manifest describes. The loader fetches from the same identity, so a manifest
    // that does not match the tree it claims to describe fails — that is what binds the gate to
    // a commit instead of to a moving branch.
    entries,
  };
}

/**
 * Check a manifest against a laid-out tree, in BOTH directions.
 * @returns {{ok: boolean, missing: string[], hash_mismatch: string[], undeclared: string[]}}
 */
export function verifyManifest(manifest, dir) {
  const missing = [];
  const hash_mismatch = [];
  const declared = new Set();

  if (!manifest || manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    return { ok: false, missing: ['<manifest>'], hash_mismatch: [], undeclared: [], reason: `manifest schema_version must be ${MANIFEST_SCHEMA_VERSION}` };
  }
  if (!Array.isArray(manifest.entries) || !manifest.entries.length) {
    return { ok: false, missing: ['<entries>'], hash_mismatch: [], undeclared: [], reason: 'manifest has no entries' };
  }

  for (const e of manifest.entries) {
    declared.add(e.path);
    const abs = path.join(dir, e.path);
    if (!fs.existsSync(abs)) { missing.push(e.path); continue; }
    if (e.sha256 && sha256(fs.readFileSync(abs)) !== e.sha256) hash_mismatch.push(e.path);
  }

  // The anti-relapse direction: a module present in the tree but absent from the manifest is the
  // exact R2 failure waiting to happen (shipped broken because nobody listed it).
  const undeclared = payloadEntries(dir).filter(p => !declared.has(p));

  return { ok: !missing.length && !hash_mismatch.length && !undeclared.length, missing, hash_mismatch, undeclared };
}

/** Manifest on disk, or a structural failure rather than a confusing one. */
export function readManifest(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { ok: false, message: `payload manifest is unreadable: ${file}: ${e.message}`, manifest: null };
  }
  try { return { ok: true, manifest: JSON.parse(raw) }; }
  catch (e) { return { ok: false, message: `payload manifest is not valid JSON: ${file}: ${e.message}`, manifest: null }; }
}
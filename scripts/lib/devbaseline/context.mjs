// Context manifest freshness — the Z03 contract consumed here, built there.
//
// One invariant, and it is the whole point of this module: a manifest whose source_commit does
// not match the repository HEAD is STALE, and stale is never handed over as fresh. If freshness
// cannot be established (no manifest, no git HEAD), the answer is `missing`/`stale` — never
// `fresh`. A context that might be out of date is worse than no context, because it is used.

import fs from 'node:fs';
import path from 'node:path';
import { gitInfo } from './log.mjs';

export const CONTEXT_STATES = { fresh: 0, stale: 2, missing: 3 };

/**
 * @returns {{state: 'fresh'|'stale'|'missing', code: number, source_commit: string, head_commit: string,
 *            entrypoints: string[], missing_entrypoints: string[], reason: string}}
 */
export function inspectContext(manifestPath) {
  const base = {
    source_commit: '',
    head_commit: 'unknown',
    entrypoints: [],
    missing_entrypoints: [],
  };

  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return { ...base, state: 'missing', code: CONTEXT_STATES.missing, reason: `manifest not found: ${manifestPath || '(no --manifest)'}` };
  }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
    return { ...base, state: 'missing', code: CONTEXT_STATES.missing, reason: `manifest is not valid JSON: ${e.message.slice(0, 120)}` };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ...base, state: 'missing', code: CONTEXT_STATES.missing, reason: 'manifest is not an object' };
  }

  const repoDir = path.dirname(path.resolve(manifestPath));
  const entrypoints = Array.isArray(manifest.entrypoints) ? manifest.entrypoints : [];
  const missingEntry = entrypoints.filter(e => !fs.existsSync(path.join(repoDir, e)));
  const git = gitInfo(repoDir);
  const sourceCommit = String(manifest.source_commit || '');

  const common = {
    ...base,
    source_commit: sourceCommit || '(absent)',
    head_commit: git.head_commit,
    entrypoints,
    missing_entrypoints: missingEntry,
  };

  if (!sourceCommit) {
    return { ...common, state: 'missing', code: CONTEXT_STATES.missing, reason: 'manifest carries no source_commit — freshness is unknowable, so it is not fresh' };
  }
  if (git.head_commit === 'unknown') {
    return { ...common, state: 'stale', code: CONTEXT_STATES.stale, reason: 'repository HEAD is unreadable — freshness cannot be confirmed' };
  }
  if (sourceCommit !== git.head_commit) {
    return { ...common, state: 'stale', code: CONTEXT_STATES.stale, reason: `manifest source_commit ${sourceCommit.slice(0, 12)} != HEAD ${git.head_commit.slice(0, 12)}` };
  }
  if (missingEntry.length) {
    return { ...common, state: 'stale', code: CONTEXT_STATES.stale, reason: `entrypoints absent from the tree: ${missingEntry.join(', ')}` };
  }
  return { ...common, state: 'fresh', code: CONTEXT_STATES.fresh, reason: `source_commit matches HEAD ${git.head_commit.slice(0, 12)}` };
}
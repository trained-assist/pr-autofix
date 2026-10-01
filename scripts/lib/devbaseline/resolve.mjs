// The ONE seam between "who calls this" and "which profile does the repository have".
//
// R5 was a disagreement, not a typo: `resolveProfile` takes five inputs with the documented
// precedence `explicit > adapter > hint > derived`, and three call sites passed three DIFFERENT
// subsets of them. `inventory` passed `adapterProfile` (so a repository pinning `minimal` got
// `minimal`), while `verify` and `validate` passed only `repoDir` (so the same repository got
// `docs`, derived). Both were "correct" against the function's contract; the repository had no
// single profile. A subset of an argument list is not a type error, so nothing caught it.
//
// The fix is structural, not a matter of filling in two missing arguments: this module is the
// only place allowed to read the adapter and hand it to `resolveProfile`, so "forgot to pass
// adapterProfile" is not expressible. It is a separate module rather than a function inside
// profile.mjs because adapter.mjs already imports profile.mjs (for the schema) — putting the
// seam there would close an import cycle.
//
// `resolveProfile` itself keeps its five parameters: it is the pure decision function and stays
// unit-testable without touching the filesystem. What changed is that production code has
// exactly one entry point into it (guarded by scripts/sandbox/consumer-boundary.mjs).

import { loadAdapter } from './adapter.mjs';
import { resolveProfile } from './profile.mjs';

export const RESOLVER_SOURCE = 'resolve.mjs';

/**
 * @param {{repoDir?: string, profileId?: string, typeHint?: string|null,
 *          exists?: ((rel: string) => boolean)|null,
 *          adapter?: {ok: boolean, adapter: object|null, source: string}|null}} opts
 *   `adapter` — an already-parsed adapter result. The inventory scanner reads the adapter
 *   through a SOURCE (a local path or the GitHub API), not from disk, so it passes what it read;
 *   everyone else lets this module read it from the repository directory. Reading it twice
 *   would be two answers to "what did this repository pin".
 * @returns {{ok: boolean, profile?: object, source?: string, derivation?: string,
 *            adapter?: object, adapterResult?: object, rule_id?: string, message?: string}}
 */
export function resolveRepo({ repoDir = '.', profileId = '', typeHint = null, exists = null, adapter = null } = {}) {
  const adapterResult = adapter || loadAdapter(repoDir);

  // A malformed adapter must not be silently downgraded to "derived": that is how a broken
  // repository used to pass inventory as `ok`. The adapter failure is reported as-is and the
  // caller decides; resolveProfile only ever sees a VALID adapter or null.
  if (!adapterResult.ok) {
    return { ok: false, rule_id: adapterResult.rule_id, message: adapterResult.message, adapterResult, adapter: null };
  }

  const prof = resolveProfile({
    repoDir,
    profileId: profileId || '',
    adapterProfile: adapterResult.adapter?.profile ?? null,
    typeHint: typeHint ?? null,
    exists: exists || null,
  });
  return { ...prof, adapter: adapterResult.adapter, adapterResult, adapterSource: adapterResult.source };
}

// Read installation evidence through the same source boundary as profile resolution.
// Only a job-level uses is a reusable workflow call; comments and run blocks are not.
export async function resolveFixInstallation(source, callable, desiredRef) {
  const observed = [];
  let unknown = Boolean(source.truncated);
  for (const file of [...source.files].filter(p => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort()) {
    const text = await source.readText(file);
    if (text === null) { unknown = true; continue; }
    const stack = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const indent = line.search(/\S/);
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      // A scalar (especially run: |) cannot contain YAML mapping children.
      if (stack.some(p => p.scalar)) continue;
      const m = /^\s*([\w-]+|"[^"\n]+"|'[^'\n]+')\s*:\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      const key = m[1].replace(/^['"]|['"]$/g, '');
      const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key === 'jobs' && value && value !== '{}') unknown = true;
      if (stack.length === 2 && stack[0].key === 'jobs' && key === 'uses') {
        const prefix = `trained-assist/pr-autofix/${callable}@`;
        if (value.startsWith(prefix)) {
          const ref = value.slice(prefix.length);
          if (/^[A-Za-z0-9_./-]+$/.test(ref)) observed.push({ workflow: file, job: stack[1].key, ref });
          else unknown = true;
        }
      }
      if (stack.length === 1 && stack[0].key === 'jobs' && value.startsWith('{')) unknown = true;
      stack.push({ key, indent, scalar: Boolean(value) });
    }
  }
  const local = Boolean(callable) && source.has(callable);
  const installation = !callable ? 'unsupported' : observed.length ? 'remote_caller' : local ? 'local_provider' : unknown ? 'unknown' : 'absent';
  return {
    installation,
    fixer_present: !callable ? false : local || observed.length > 0 ? true : unknown ? null : false,
    observed_refs: [...new Set(observed.map(c => c.ref))].sort(),
    callers: observed,
    desired_ref: desiredRef,
    evidence_complete: !unknown,
    // Presence cannot establish that a remote workflow ever succeeded.
    execution_verified: false,
  };
}

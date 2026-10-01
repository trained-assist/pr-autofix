// Branch deletion is irreversible on GitHub. This module is therefore a PREDICATE with no network
// access: it decides what MAY be deleted, and scripts/cleanup-branches.mjs does the deleting.
//
// R4: `ci-fix-cleanup.yml` accepted `pr_number` as the documented scope of action and used it in
// exactly one place — the summary line. The deletion loop filtered only by the `pr-autofix-fix/`
// prefix, so `pr_number=11` deleted `pr-autofix-fix/22-b`: another PR's branch, gone. Alongside
// that, the branch list was read under `set -uo pipefail` with `|| true`, so an unavailable API
// (no token, 403, network) produced an EMPTY list and the workflow reported "nothing to do" with
// exit 0. "No such branch" and "I could not ask" were the same event.
//
// Two rules here, both false by default:
//   1. a branch is deletable only when all three are PROVEN — the tool's prefix, the PR number in
//      its name equals the requested scope, and it is not on the keep list;
//   2. an unusable scope (empty/non-numeric pr_number) refuses EVERYTHING. An empty scope must
//      never mean "delete everything under the prefix".
//
// Everything unproven becomes `refused` WITH a reason, so the summary can say what was skipped
// and why. The caller decides what to do about a refused branch; this function only refuses.

export const BRANCH_PREFIX = 'pr-autofix-fix/';

/** The PR number a branch belongs to, or null when its name does not state one. */
export function prNumberOfBranch(branch, prefix = BRANCH_PREFIX) {
  if (!branch.startsWith(prefix)) return null;
  const rest = branch.slice(prefix.length);
  const m = /^(\d+)(?:[-_/]|$)/.exec(rest);
  return m ? Number(m[1]) : null;
}

/** A scope is usable only as a positive integer. `null`, '', 'abc', 0, -1 are all refused. */
export function normalizeScope(prNumber) {
  if (prNumber === null || prNumber === undefined || prNumber === '') return null;
  const n = typeof prNumber === 'number' ? prNumber : Number(String(prNumber).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * @param {{branches: string[], prNumber: number|string, keep?: string[], prefix?: string}} input
 * @returns {{delete: string[], keep: string[], refused: {branch: string, reason: string}[]}}
 */
export function deletableBranches({ branches, prNumber, keep = [], prefix = BRANCH_PREFIX } = {}) {
  const keepSet = new Set((Array.isArray(keep) ? keep : []).map(String));
  const scope = normalizeScope(prNumber);
  const delete_ = [];
  const kept = [];
  const refused = [];

  for (const branch of (Array.isArray(branches) ? branches : [])) {
    if (!branch) continue;
    if (keepSet.has(branch)) { kept.push(branch); continue; }
    if (!branch.startsWith(prefix)) {
      refused.push({ branch, reason: `not owned by this tool (expected prefix ${prefix})` });
      continue;
    }
    const owner = prNumberOfBranch(branch, prefix);
    if (owner === null) {
      refused.push({ branch, reason: 'malformed scope: the branch name states no PR number' });
      continue;
    }
    if (scope === null) {
      // Refuse the whole run, loudly, rather than guessing a scope.
      refused.push({ branch, reason: `no usable pr_number scope (got ${JSON.stringify(prNumber ?? null)}) — refusing to delete` });
      continue;
    }
    if (owner !== scope) {
      refused.push({ branch, reason: `belongs to PR #${owner}, not the requested PR #${scope}` });
      continue;
    }
    delete_.push(branch);
  }

  return { delete: delete_, keep: kept, refused };
}
#!/usr/bin/env node
// Delete this PR's own pr-autofix-fix/* branches — and nothing else.
//
// The predicate (scripts/lib/devbaseline/cleanup.mjs) is pure; this is the part that talks to
// GitHub. Two properties matter here and both are the reason this is a script and not a shell
// loop:
//
//   1. An API failure is NOT an empty branch list. The previous version read the list with
//      `2>/dev/null || true` under `set -uo pipefail`: no token, a 403 or a network error all
//      produced "no branches match — nothing to do" and exit 0. Destructive work reported itself as
//      successfully having nothing to do. Here a non-zero `gh` is a non-zero exit and NOTHING is
//      deleted.
//   2. Destructive calls are not wrapped in `|| true`. A failure to delete is reported and counted,
//      never swallowed into a green run.
//
//   node scripts/cleanup-branches.mjs --pr <n> [--keep <json array>] [--dry-run]
//                                   [--repo <owner/name>] [--prefix <p>]

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deletableBranches, BRANCH_PREFIX } from './lib/devbaseline/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d = '') => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? ''); };
const out = (l = '') => process.stdout.write(`${l}\n`);
const err = (l) => process.stderr.write(`${l}\n`);

const repo = flag('repo', process.env.GITHUB_REPOSITORY || '');
if (!repo) { err('cleanup-branches: --repo <owner/name> (or GITHUB_REPOSITORY) is required'); process.exit(2); }

let keep = [];
const keepRaw = flag('keep', '[]');
try {
  const parsed = JSON.parse(keepRaw || '[]');
  if (!Array.isArray(parsed)) throw new Error('must be a JSON array');
  keep = parsed.map(String);
} catch (e) {
  err(`cleanup-branches: --keep is not a JSON array (${e.message}) — refusing to delete anything`);
  process.exit(2);
}

const prefix = flag('prefix', BRANCH_PREFIX);
// Dry run is the DEFAULT: an irreversible deletion should be something a caller opts out of, not
// something it opts into. --no-dry-run is required to actually delete.
const dryRun = !argv.includes('--no-dry-run');

// `gh api ... --jq '.[].ref'` — a failure here is a FAILURE, not an empty list.
const listed = spawnSync('gh', ['api', `repos/${repo}/git/matching-refs/heads/${prefix}`, '--jq', '.[].ref'], {
  encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
});
if (listed.error) { err(`cleanup-branches: gh is not available (${listed.error.message}) — nothing deleted`); process.exit(1); }
if (listed.status !== 0) {
  err(`::error::could not list branches in ${repo} under ${prefix} (gh exit ${listed.status}): ${(listed.stderr || '').trim().slice(0, 300)}`);
  err('cleanup-branches: refusing to treat an unreadable branch list as "nothing to delete"');
  process.exit(1);
}

const branches = String(listed.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^refs\/heads\//, ''));
const plan = deletableBranches({ branches, prNumber: flag('pr', process.env.PR_NUMBER || ''), keep, prefix });

for (const b of plan.keep) out(`keep    ${b} (listed in keep_branches)`);
for (const r of plan.refused) out(`REFUSED ${r.branch} — ${r.reason}`);
for (const b of plan.delete) out(`${dryRun ? 'would-delete' : 'delete'} ${b}`);

let deleted = 0;
let failed = 0;
for (const b of plan.delete) {
  if (dryRun) continue;
  const del = spawnSync('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${b}`], { encoding: 'utf8', timeout: 60_000 });
  if (del.status === 0) { deleted++; out(`deleted ${b}`); }
  else {
    // Reported and counted — a failed delete must never read as a successful cleanup.
    failed++;
    err(`::error::could not delete ${b} (gh exit ${del.status}): ${(del.stderr || '').trim().slice(0, 200)}`);
  }
}

out(`cleanup summary: deleted=${deleted} failed=${failed} kept=${plan.keep.length} refused=${plan.refused.length} scanned=${branches.length} pr=${flag('pr', process.env.PR_NUMBER || '') || 'n/a'}${dryRun ? ' (dry run — nothing deleted)' : ''}`);

// R1b: refusing to widen the scope and then reporting SUCCESS are different claims. This used to
// print `::error::…` and exit 0, so "we refused to act" was a green required check — the same
// shape R3 was rejected for (needs_human reported as a pass). A refusal that cannot be told apart
// from a completed cleanup is not a refusal. Nothing is deleted either way; now it also says so
// with an exit code the caller cannot misread.
if (plan.refused.some(r => r.reason.startsWith('no usable pr_number'))) {
  err('::error::the pr_number scope was not usable — every branch was refused. Fix the input rather than widening the scope.');
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
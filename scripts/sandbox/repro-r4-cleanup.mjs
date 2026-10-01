// R4 regression — cleanup deletes only branches it can PROVE it owns, and an API failure is
// never mistaken for "there is nothing to delete".
//
// The defect had two halves:
//   1. `pr_number` was documented as the scope of action and used only in the summary line; the
//      deletion loop filtered on the `pr-autofix-fix/` prefix alone, so cleanup for PR 11 deleted
//      PR 22's branch.
//   2. The branch list was read with `2>/dev/null || true` under `set -uo pipefail`. No token, a
//      403 or a network error all yielded an empty list → "nothing to do" → exit 0. A destructive
//      job reported itself as successfully having nothing to do.
//
//   node scripts/sandbox/repro-r4-cleanup.mjs

import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const KEEP = process.argv.includes('--keep');
const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'repro-r4-'));
const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

/** A mock `gh`: lists a fixed branch set, records every call, and materialises each DELETE. */
let mockSeq = 0;
function mockGh({ branches, listExit = 0 }) {
  const id = `m${mockSeq++}`;
  const bin = path.join(root, `bin-${id}`);
  mkdirSync(bin, { recursive: true });
  const log = path.join(root, `gh-${id}.log`);
  const marker = (branch) => path.join(root, `deleted-${id}-${branch.replace(/\//g, '_')}`);
  let script = [
    '#!/usr/bin/env node',
    "const a = process.argv.slice(2);",
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n');`,
    "if (a[0] === 'api' && a[1].includes('matching-refs')) {",
    "  __LIST__",
    `  process.exit(${listExit});`,
    '}',
    "if (a[0] === 'api' && a[1] === '-X' && a[2] === 'DELETE') {",
    "  const ref = decodeURIComponent(a[3].split('/').pop());",
    `  fs.writeFileSync(${JSON.stringify(path.join(root, 'deleted'))} + '_' + ${JSON.stringify(id)} + '_' + ref.replace(/\\//g, '_'), 'x');`,
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n');
  // The list itself: one refs/heads/<branch> per line, exactly as `gh api --jq '.[].ref'` prints.
  const listBody = branches.map(b => `refs/heads/${b}`).join('\n') + '\n';
  if (listExit === 0) script = script.replace('__LIST__', `process.stdout.write(${JSON.stringify(listBody)});`);
  else script = script.replace('__LIST__', '');
  writeFileSync(path.join(bin, 'gh'), script);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { bin, log, marker, deletedBranches: () => (existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(l => /-X DELETE/.test(l)).map(l => decodeURIComponent(l.split('git/refs/heads/')[1] || l.split('/').pop()))
    : []) };
}

const runCleanup = (bin, args) => spawnSync('node', [path.join(ROOT, 'scripts', 'cleanup-branches.mjs'), '--repo', 'o/r', ...args], {
  encoding: 'utf8', timeout: 60_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'stub' },
});

try {
  // ── the fixture from the defect report: 11-a belongs to PR 11, 22-b to PR 22 ────
  const branches = ['pr-autofix-fix/11-a', 'pr-autofix-fix/22-b', 'pr-autofix-fix/orphan', 'main'];
  const gh = mockGh({ branches });

  // A real delete run (--no-dry-run) for PR 11.
  const r = runCleanup(gh.bin, ['--pr', '11', '--no-dry-run']);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const deleted = gh.deletedBranches();

  check('only PR 11\u2019s own branch is deleted', deleted.length === 1 && deleted[0] === 'pr-autofix-fix/11-a',
    `DELETE calls: ${deleted.join(', ') || '\u2014'}`);
  check('PR 22\u2019s branch survives', !deleted.includes('pr-autofix-fix/22-b'));
  check('a branch with no PR number in its name is refused', /REFUSED pr-autofix-fix\/orphan \u2014 malformed scope/.test(out) || /REFUSED pr-autofix-fix\/orphan — malformed scope/.test(out),
    out.split('\n').filter(l => /orphan/.test(l)).join(' | ') || out.slice(0, 200));
  check('a branch outside the prefix is refused', /REFUSED main — not owned by this tool/.test(out) || /REFUSED main \u2014 not owned by this tool/.test(out),
    out.split('\n').filter(l => /\bmain\b/.test(l)).join(' | ') || out.slice(0, 200));
  check('each refusal states a reason', (out.match(/REFUSED/g) || []).length === 3, out.slice(0, 300));

  // ── an unusable scope refuses EVERYTHING ──────────────────────────────────────
  for (const scope of ['', '0', 'abc', '-3']) {
    const gh2 = mockGh({ branches });
    const r2 = runCleanup(gh2.bin, ['--pr', scope, '--no-dry-run']);
    const out2 = `${r2.stdout || ''}${r2.stderr || ''}`;
    const anyDelete = gh2.deletedBranches().length > 0;
    check(`scope ${JSON.stringify(scope)} deletes nothing`, !anyDelete && /REFUSED/.test(out2),
      out2.split('\n').slice(0, 3).join(' | '));
  }

  // ── an API failure is NOT "nothing to delete" ─────────────────────────────────
  const ghDown = mockGh({ branches, listExit: 1 });
  const r3 = runCleanup(ghDown.bin, ['--pr', '11', '--no-dry-run']);
  const out3 = `${r3.stdout || ''}${r3.stderr || ''}`;
  check('a failing branch list exits non-zero', r3.status !== 0, `exit ${r3.status}`);
  check('a failing branch list never prints "nothing to do"', !/nothing to do/i.test(out3), out3.slice(0, 200));
  check('a failing branch list deletes nothing', ghDown.deletedBranches().length === 0);

  // ── keep_branches wins ───────────────────────────────────────────────────────
  const gh3 = mockGh({ branches });
  const r4 = runCleanup(gh3.bin, ['--pr', '11', '--keep', '["pr-autofix-fix/11-a"]', '--no-dry-run']);
  const out4 = `${r4.stdout || ''}${r4.stderr || ''}`;
  check('a branch on the keep list is kept, not deleted',
    /keep\s+pr-autofix-fix\/11-a/.test(out4) && gh3.deletedBranches().length === 0,
    out4.split('\n').filter(l => /11-a/.test(l)).join(' | '));

  // ── dry run is the default ───────────────────────────────────────────────────
  const gh5 = mockGh({ branches });
  const r5 = runCleanup(gh5.bin, ['--pr', '11']);
  check('the default run deletes nothing and says so',
    r5.status === 0 && /would-delete pr-autofix-fix\/11-a/.test(r5.stdout || '') && /dry run/.test(`${r5.stdout}${r5.stderr}`),
    `${r5.stdout || ''}`.split('\n').slice(-2).join(' | '));
  check('the default run made no DELETE call', gh5.deletedBranches().length === 0);

  // ── the workflow delegates instead of filtering in shell ──────────────────────
  const wf = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci-fix-cleanup.yml'), 'utf8');
  check('the workflow calls cleanup-branches.mjs', /cleanup-branches\.mjs/.test(wf));
  check('the workflow no longer swallows the branch list with `|| true`',
    !/matching-refs[\s\S]{0,200}\|\| true/.test(wf));
  check('the workflow no longer documents `0 = every branch`', !/0 = every pr-autofix-fix/.test(wf));

  const failed = results.filter(r => !r.ok);
  console.log(`\nR4 cleanup reproduction — ${results.length - failed.length}/${results.length} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nworkdir: ${root}${KEEP ? '' : ' (removed)'}`);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('repro harness error:', e && e.stack ? e.stack : e);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(2);
}
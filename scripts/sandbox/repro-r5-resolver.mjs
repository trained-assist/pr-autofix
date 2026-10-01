#!/usr/bin/env node
// R5 regression — ONE seam for profile resolution, and the three consumers agree.
//
// Two assertions, both behavioural:
//
//   A. Guard: `resolveProfile` (the pure decision function) is called from exactly ONE module —
//      resolve.mjs. Three call sites each passed a different SUBSET of its five inputs, so a
//      repository pinning a profile got `inventory=minimal` and `verify=docs(derived)`. A subset
//      is not a type error, so nothing caught it. The guard makes the next such call site a
//      failing check rather than a silent disagreement.
//
//   B. Agreement: on a fixture whose adapter pins a profile, `validate`, `verify` and `inventory`
//      must report the SAME profile id and the SAME source. "Derived" is a valid answer; it is
//      only a defect when the consumers disagree about it.
//
//   node scripts/sandbox/repro-r5-resolver.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'devbaseline.mjs');
const KEEP = process.argv.includes('--keep');
const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'repro-r5-'));
const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

const run = (args, cwd = ROOT) => {
  const r = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, DEVBASELINE_OFFLINE: '1' } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

try {
  // ── A. only resolve.mjs may call resolveProfile ─────────────────────────────
  const callers = [];
  for (const f of readdirSync(path.join(ROOT, 'scripts', 'lib', 'devbaseline'))) {
    if (!f.endsWith('.mjs')) continue;
    const text = readFileSync(path.join(ROOT, 'scripts', 'lib', 'devbaseline', f), 'utf8');
    // Count real CALLS, not the word appearing in prose or an import specifier.
    const calls = (text.match(/resolveProfile\s*\(/g) || []).length;
    // profile.mjs DECLARES it — that is the definition, not a call site.
    if (calls > 0 && f !== 'resolve.mjs' && f !== 'profile.mjs') callers.push(`${f}(${calls})`);
  }
  const cliCallers = (() => {
    const t = readFileSync(CLI, 'utf8');
    return (t.match(/resolveProfile\s*\(/g) || []).length;
  })();
  check('resolveProfile is called only from resolve.mjs (profile.mjs declares it)', callers.length === 0, `other callers: ${callers.join(', ') || '—'}`);
  check('the CLI does not call resolveProfile directly', cliCallers === 0, `cli calls: ${cliCallers}`);

  // ── fixture: a repository that PINS its profile in .devbaseline.json ────────
  const repo = path.join(root, 'pinned');
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, 'README.md'), '# pinned fixture\n');
  writeFileSync(path.join(repo, '.devbaseline.json'), `${JSON.stringify({
    schema_version: 1,
    profile: 'minimal',
    check: { commands: ['node -e "process.exit(0)"'] },
    autofix: { enabled: false },
  }, null, 2)}\n`);

  // ── B. the three consumers agree ────────────────────────────────────────────
  const validated = run(['validate', '--repo', repo]);
  const mValidate = /profile (\w+) \(([^)]+)\)/.exec(validated.out);
  const verified = run(['verify', '--repo', repo, '--no-fix', '--log', path.join(root, 'verify.json')]);
  const mVerify = /profile: (\w+) \(adapter: (\w+)\)/.exec(verified.out);

  const reposList = path.join(root, 'repos.json');
  writeFileSync(reposList, JSON.stringify([{ repo: 'fixture/pinned', type_hint: null, path: repo }]));
  const inventoried = run(['inventory', '--out', path.join(root, 'inv'), '--repos', reposList]);
  const rowFile = path.join(root, 'inv', 'repo-coverage.json');
  let row = null;
  try { row = JSON.parse(readFileSync(rowFile, 'utf8')).repos[0]; } catch { /* missing */ }

  check('validate reports the pinned profile', mValidate?.[1] === 'minimal', validated.out.split('\n').filter(Boolean).slice(-2).join(' | '));
  check('validate reports source=adapter', mValidate?.[2]?.startsWith('adapter'), mValidate?.[2] ?? '—');
  check('verify reports the pinned profile', mVerify?.[1] === 'minimal', verified.out.split('\n').slice(0, 2).join(' | '));
  check('inventory reports the pinned profile', row?.profile === 'minimal', JSON.stringify({ profile: row?.profile, notes: row?.notes }));

  const ids = [mValidate?.[1], mVerify?.[1], row?.profile].filter(Boolean);
  check('validate / verify / inventory agree on one profile', new Set(ids).size === 1, `saw: ${ids.join(', ')}`);

  const failed = results.filter(r => !r.ok);
  console.log(`\nR5 reproduction — ${results.length - failed.length}/${results.length} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nworkdir: ${root}${KEEP ? '' : ' (removed)'}`);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('repro harness error:', e && e.stack ? e.stack : e);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(2);
}
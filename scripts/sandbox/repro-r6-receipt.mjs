#!/usr/bin/env node
// R6 reproduction — executable failed→fix→verify→receipt with a stub provider
// (local llm-ladder HTTP server) and a mock GitHub (`gh` stub on PATH).
//
// Defect (pr-autofix#35): the production call sites never pass the AC-44 meta,
// so ci-fixer-stats.json is written with empty patch_refs / included_paths /
// omitted_paths, budget.diff_tokens_used: 0 and attempt_count 1.
//
// R3 (iteration 3, design §2.7): two expectations in this file checked the meaning
// `tool.commit` acquired in #38 (the CONSUMER's fix commit, and "any 40-hex").
// The field now names the TOOL BUILD only and the patch lives in `patch.commit`,
// so those expectations were replaced by the three-entity checks below — with the
// reason recorded here: the old ones asserted the defect, not the contract.
//
// This is the regression test that must be RED on the unfixed code: it asserts
// the CORRECT behaviour (receipt carries factual SHA/attempt/patch/path/budget).
// Exit 0 = fixed, exit 1 = defect reproduced.
//
//   node scripts/sandbox/repro-r6-receipt.mjs [--keep]

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { GH_STUB_SOURCE } from './gh-stub-source.mjs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AUTOFIX = path.resolve(HERE, '..', 'autofix.mjs');
const KEEP = process.argv.includes('--keep');

const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'repro-r6-'));
const results = [];
const check = (name, cond, detail = '') => { results.push({ name, ok: !!cond, detail }); };

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  // ── fixture repo: main has a failing test, feat carries a change ─────────────
  const origin = path.join(root, 'origin.git');
  const w = path.join(root, 'w');
  git(['init', '-q', '--bare', origin], root);
  git(['clone', '-q', origin, w], root);
  const gw = (a) => git(a, w);
  gw(['config', 'user.email', 't@t']); gw(['config', 'user.name', 't']);
  gw(['checkout', '-q', '-b', 'main']);
  mkdirSync(path.join(w, 'src'), { recursive: true });
  writeFileSync(path.join(w, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2) + '\n');
  writeFileSync(path.join(w, 'src', 'sum.js'), 'module.exports = (a, b) => a + b + 1;\n');
  writeFileSync(path.join(w, 'check.js'), "const sum = require('./src/sum');\nif (sum(2, 3) !== 5) { console.error('not ok 1 - sum'); process.exit(1); }\nconsole.log('ok 1');\n");
  gw(['add', '-A']); gw(['commit', '-qm', 'base']);
  gw(['push', '-q', 'origin', 'main']);
  gw(['checkout', '-q', '-b', 'feat']);
  writeFileSync(path.join(w, 'README.md'), '# fixture\n');
  gw(['add', '-A']); gw(['commit', '-qm', 'feat change']);
  gw(['push', '-q', 'origin', 'feat']);

  // ── fakebin: stub `gh`, stub `opencode` ─────────────────────────────────────
  const fakebin = path.join(root, 'fakebin');
  mkdirSync(fakebin, { recursive: true });

  const ghStub = GH_STUB_SOURCE;
  writeFileSync(path.join(fakebin, 'gh'), ghStub);
  chmodSync(path.join(fakebin, 'gh'), 0o755);

  const agentStub = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const p = 'src/sum.js';
writeFileSync(p, 'module.exports = (a, b) => a + b;\\n');
process.stdout.write('fixed src/sum.js: removed the off-by-one\\n');
`;
  writeFileSync(path.join(fakebin, 'opencode'), agentStub);
  chmodSync(path.join(fakebin, 'opencode'), 0o755);

  // ── stub llm-ladder provider ────────────────────────────────────────────────
  const ladder = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      let content = '{}';
      const sys = (() => { try { return JSON.parse(body).messages?.[0]?.content || ''; } catch { return ''; } })();
      if (/PR reviewer/.test(sys)) content = JSON.stringify({ purpose: 'fix the failing sum test', is_clear: true, ambiguity_reason: '' });
      else if (/CI failure analyst/.test(sys)) content = JSON.stringify({ problem: 'sum() adds an extra 1, so the test expecting 5 fails', files_to_examine: [], fix_approach: 'remove the +1 in src/sum.js', confidence: 'high' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'stub', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 }, choices: [{ message: { content } }] }));
    });
  });
  await new Promise(r => ladder.listen(0, '127.0.0.1', r));
  const ladderUrl = `http://127.0.0.1:${ladder.address().port}`;

  // ── run the real pipeline ───────────────────────────────────────────────────
  const summary = path.join(root, 'summary.md');
  writeFileSync(summary, '');
  const env = {
    ...process.env,
    PATH: `${fakebin}:${process.env.PATH}`,
    LLM_LADDER_TOKEN: 'stub-token',
    LLM_LADDER_URL: ladderUrl,
    AUTOFIX_AGENT: '1',
    AUTOFIX_AGENT_BIN: path.join(fakebin, 'opencode'),
    REPO: 'o/r',
    PR_NUMBER: '1',
    RUN_ID: '123',
    ORIGINAL_BRANCH: 'feat',
    BASE_BRANCH: 'main',
    GITHUB_STEP_SUMMARY: summary,
    AUTOFIX_WORKFLOW_SHA: 'envnotarealsha',
  };
  const run = await new Promise((resolve) => {
    const child = spawn('node', [AUTOFIX], { cwd: w, env });
    let stderr = '';
    child.stderr.on('data', d => (stderr += d));
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
  });
  const receiptPath = path.join(w, 'ci-fixer-stats.json');

  // ── assertions: the receipt must carry factual data ─────────────────────────
  let stats = null;
  try { stats = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { /* missing */ }
  check('receipt written (ci-fixer-stats.json)', !!stats, run.stderr?.slice(-400));
  const fixSha = (() => { try { return gw(['rev-parse', 'HEAD']).trim(); } catch { return ''; } })();
  if (stats) {
    check('receipt is a success (fix path reached)', /^success:/.test(stats.category || ''), `category=${stats.category}`);
    check('patch_refs carries a real patch ref', Array.isArray(stats.patch_refs) && stats.patch_refs.length > 0, JSON.stringify(stats.patch_refs));
    check('included_paths lists what entered the prompt', Array.isArray(stats.included_paths) && stats.included_paths.length > 0, JSON.stringify(stats.included_paths));
    check('budget.diff_tokens_used > 0', Number(stats.budget?.diff_tokens_used) > 0, String(stats.budget?.diff_tokens_used));
    // R3 (design §2.7): the old expectation here was `tool.commit === fixSha` — the meaning the
    // field acquired in #38, under which the test had been rewritten. Three entities now:
    // tool.commit = the tool build (40-hex from env, or honest `unpinned:local`), patch.commit =
    // this run's commit in the CONSUMER repo, patch_refs = references to that patch.
    check('patch.commit is the real fix SHA (its own slot)', stats.patch?.commit === fixSha,
      `patch.commit=${stats.patch?.commit} fixSha=${fixSha}`);
    check('tool.commit is a DIFFERENT entity than the patch', stats.tool?.commit !== fixSha,
      `tool.commit=${stats.tool?.commit} fixSha=${fixSha}`);
    check('tool.commit is a 40-hex build sha or an honest unpinned:local',
      stats.tool?.commit === 'unpinned:local' || /^[0-9a-f]{40}$/.test(String(stats.tool?.commit)),
      String(stats.tool?.commit));
    check('attempt_count reflects attempts', Number.isInteger(stats.attempt_count) && stats.attempt_count >= 1, String(stats.attempt_count));

    // The receipt must say WHY patch_refs is what it is. Acceptance asks for a no-change repeat to
    // carry no patch — but an empty array is ambiguous between "nothing needed changing" and
    // "the writer never filled this in". patch_refs_source is the disambiguation.
    check('patch_refs_source is declared (applied for a committed fix)', stats.patch_refs_source === 'applied', String(stats.patch_refs_source));
    // The former `tool.commit is a 40-hex SHA` check is superseded by the R3 entity checks above:
    // this fixture pins AUTOFIX_WORKFLOW_SHA to a non-SHA string, so the CORRECT build value here
    // is `unpinned:local` — a 40-hex requirement would assert the defect's old behaviour.
    check('no legacy tool_commit slot aliases the patch into the tool entity',
      !('tool_commit' in stats), JSON.stringify(stats.tool_commit));
    check('included_paths are files the fix actually touched', Array.isArray(stats.included_paths) && stats.included_paths.includes('src/sum.js'), JSON.stringify(stats.included_paths));
    check('prompt_included_paths records what entered the prompt', Array.isArray(stats.prompt_included_paths), JSON.stringify(stats.prompt_included_paths));

    // Redaction and retention are asserted ON THE ARTIFACT, not by the presence of a field: a
    // field that exists but is empty proves nothing (AC-07: no credential values anywhere).
    const raw = JSON.stringify(stats);
    check('no secret-shaped value in the receipt', !/(ghp_|github_pat_|gh[osu]_|AKIA|-----BEGIN [A-Z ]*PRIVATE KEY)/.test(raw),
      (raw.match(/.{0,20}(ghp_|github_pat_|AKIA|PRIVATE KEY).{0,20}/) || ['—'])[0]);
    // R4 (design §2.7): the old check here was `ttl_days > 0 && artifact` — a NUMBER asserted as
    // if it were a cleanup. It is superseded by r4-retention-probe.mjs, which executes the sweep
    // with an accelerated clock (expired removed, active kept, repeat safe). What THIS receipt
    // can honestly assert is that its own deadline is computable: `written_at` makes ttl a date.
    check('retention carries a COMPUTABLE deadline (written_at + ttl_days), not just a number',
      Number(stats.retention?.ttl_days) > 0 && !!stats.retention?.artifact && !!stats.retention?.written_at,
      JSON.stringify(stats.retention));
    check('llm_usage is recorded from the actual run', typeof stats.llm_usage?.calls === 'number', JSON.stringify(stats.llm_usage));
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\nR6 reproduction — ${results.length - failed.length}/${results.length} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nworkdir: ${root}${KEEP ? '' : ' (removed)'}`);
  console.log(failed.length ? '\nR6 DEFECT REPRODUCED (red test)' : '\nR6 OK (regression test green)');
  ladder.close();
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('repro harness error:', e.message);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(2);
}

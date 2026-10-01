// The R2 regression: the devbaseline loader must lay out a tree whose composition is
// declared, hashed, and verified, then RUN the CLI from that tree — not a flat copy with
// node --check.
//
// Two assertions, both behavioural:
//
//   A. Flat layout → failure: the old loader used a hand-written list and flattened the tree
//      via `$(basename "$f")`. A real CLI that imports from subdirectories fails with
//      ERR_MODULE_NOT_FOUND, while the check stayed GREEN because `node --check` never
//      resolves imports. This scenario is red on the unfixed code.
//
//   B. Tree layout → success: the payload is declared in manifest.json, laid out with the
//      directory structure intact, verified both ways (missing AND undeclared), then RUN.
//      The CLI passes its own checks, and the consumer boundary exercises validate,
//      check-docs, verify, context without checkout of the tool itself.
//
//   C. Guard: anti-relapse — adding a module without updating the manifest fails the gate
//      instead of shipping broken silently (already checked by the resolver seam).
//
//   node scripts/sandbox/consumer-boundary.mjs

import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const KEEP = process.argv.includes('--keep');
const root = mkdtempSync(path.join(process.env.DEVBASELINE_SANDBOX_TMP || os.tmpdir(), 'repro-r2-'));
const results = [];
const check = (name, cond, detail = '') => results.push({ name, ok: !!cond, detail });

const run = (args, cwd = ROOT) => {
  const r = spawnSync('node', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

try {
  // ── fixture repo: a minimal repo that imports the CLI and runs validate/verify etc ─────
  const fixture = path.join(root, 'fixture');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'boundary-fixture',
    version: '1.0.0',
    scripts: {
      test: 'node scripts/devbaseline.mjs validate --repo . --all-profiles',
      check: 'node scripts/devbaseline.mjs check-docs --dir .',
      verify: 'node scripts/devbaseline.mjs verify --repo . --no-fix --log verify.json',
      context: 'node scripts/devbaseline.mjs context --manifest manifest.json',
    }
  }, null, 2) + '\n');

  // ── A. FLAT layout → failure ───────────────────────────────────────────────────────
  // Simulate the old loader: hand-pick a list of files (the manifest would have) and write
  // them FLAT into a temp dir, then try to run the CLI from there.
  const flat = path.join(root, 'flat');
  mkdirSync(flat, { recursive: true });
  // Copy only the files the old loader listed (it missed source.mjs, and the list was prose)
  const payload = JSON.parse(readFileSync(path.join(ROOT, 'payload.manifest.json'), 'utf8')).entries;
  for (const e of payload) {
    const src = path.join(ROOT, e.path);
    if (!existsSync(src)) continue;
    // FLAT: write only the basename, so scripts/lib/devbaseline/run.mjs → run.mjs
    const dest = path.join(flat, path.basename(e.path));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src, 'utf8'));
  }
  // Try running the flattened CLI
  const flatOut = run([`${flat}/devbaseline.mjs`, 'validate', '--repo', fixture, '--all-profiles'], flat);
  // It fails because it cannot find its imports: e.g. ./lib/devbaseline/profile.mjs is not there.
  const flatFail = flatOut.code !== 0 && /ERR_MODULE_NOT_FOUND|Cannot find module/.test(flatOut.out);
  check('flat layout → CLI cannot start (ERR_MODULE_NOT_FOUND)', flatFail,
    flatOut.out.trim().slice(0, 200));

  // ── B. TREE layout → success (the fixed loader) ─────────────────────────────────────
  // Serve the pinned tree via loopback HTTP so fetch-payload can get it and lay it out under
  // RUNNER_TEMP/devbaseline with the directory structure preserved.
  const serverDir = path.join(root, 'serve');
  mkdirSync(serverDir, { recursive: true });
  // Copy the WHOLE repo that the manifest describes (owner: trained-assist, repo: pr-autofix)
  // into a directory tree that the HTTP server will serve at /trained-assist/pr-autofix/<sha>
  const owner = 'trained-assist';
  const repo = 'pr-autofix';
  const sha = '0000000000000000000000000000000000000000'; // 40 zeros for the fixture
  const serveBase = path.join(serverDir, owner, repo, sha);
  mkdirSync(serveBase, { recursive: true });
  for (const e of payload) {
    const src = path.join(ROOT, e.path);
    if (!existsSync(src)) continue;
    const dest = path.join(serveBase, e.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(src, 'utf8'));
  }
  // Also need the manifest itself at the root of the served tree
  writeFileSync(path.join(serveBase, 'payload.manifest.json'), readFileSync(path.join(ROOT, 'payload.manifest.json'), 'utf8'));

  // The fetches below are SYNCHRONOUS, so the server must live in ANOTHER process — an
  // in-process HTTP server would deadlock on its own first request.
  const PORT = 38000 + Math.floor(Math.random() * 2000);
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', serverDir], { stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const probe = spawnSync('curl', ['-fsS', '-o', '/dev/null', `http://127.0.0.1:${PORT}/${owner}/${repo}/${sha}/payload.manifest.json`]);
    ready = probe.status === 0;
    if (!ready) await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) { srv.kill(); throw new Error('fixture file server did not start'); }
  const baseUrl = `http://127.0.0.1:${PORT}`;

  // Lay the tree out exactly the way the workflow does: one fetch-payload call per destination.
  const fetchPayload = (dest) => run([
    path.join(ROOT, 'scripts', 'fetch-payload.mjs'),
    '--manifest', path.join(ROOT, 'payload.manifest.json'),
    '--from-file', path.join(root, 'base.txt'),
    '--dest', dest,
    '--run', 'payload-verify',
    '--manifest', path.join(ROOT, 'payload.manifest.json'),
    '--dir', dest,
  ], path.join(ROOT, 'scripts'));
  const outDir = path.join(root, 'out');
  writeFileSync(path.join(root, 'base.txt'), `${baseUrl}/${owner}/${repo}/${sha}`);
  const fetch = fetchPayload(outDir);
  check('fetch-payload laid out tree and verified manifest', fetch.code === 0 && /laid out/.test(fetch.out),
    fetch.out.trim().slice(0, 200));

  // Now exercise the CLI from the laid-out tree — run its checks against the fixture.
  const cli = path.join(outDir, 'scripts', 'devbaseline.mjs');
  const env = { ...process.env, DEVBASELINE_OFFLINE: '1' };
  const wrapped = (cmd, args) => {
    const full = [cli, cmd, ...args];
    const r = spawnSync('node', full, { cwd: fixture, encoding: 'utf8', timeout: 120_000, env, maxBuffer: 50 * 1024 * 1024 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  // The point of running these from the laid-out tree is that the CLI STARTS at all. The exit
  // code carries the repository's own semantics (needs_human=2 for a node repo with no fixer), so
  // the assertion is "ran and reported", not a specific code.
  const checks = [
    ['validate', ['--repo', fixture, '--all-profiles'], /profiles: .*all valid/, 'validate --all-profiles runs from the payload tree'],
    ['check-docs', ['--dir', fixture], /0 violation/, 'check-docs runs from the payload tree'],
    ['verify', ['--repo', fixture, '--no-fix', '--log', 'verify.json'], /^profile: \w+ \(adapter:/m, 'verify runs from the payload tree'],
    ['context', ['--manifest', 'manifest.json'], /^context: /m, 'context runs from the payload tree'],
  ];
  for (const [name, args, expect, desc] of checks) {
    const r = wrapped(name, args);
    check(desc, r.out.length > 0 && expect.test(r.out) && !/Cannot find module|ERR_MODULE/.test(r.out), r.out.trim().slice(0, 200));
  }

  // ── C. Guard: a module in the tree that the manifest does not declare → red ─────────
  // This is the anti-relapse direction of R2: adding scripts/lib/devbaseline/<new>.mjs without
  // regenerating payload.manifest.json used to ship broken silently. The loader only fetches
  // declared entries, so the extra module is placed into the LAID-OUT tree and re-verified.
  fs.writeFileSync(path.join(outDir, 'scripts', 'lib', 'devbaseline', 'extra.mjs'), '// not declared\n');
  const undeclaredRun = run([
    path.join(outDir, 'scripts', 'devbaseline.mjs'), 'payload-verify',
    '--manifest', path.join(ROOT, 'payload.manifest.json'), '--dir', outDir,
  ], path.join(outDir, 'scripts'));
  const undeclared = undeclaredRun.code !== 0 && /undeclared/.test(undeclaredRun.out) && undeclaredRun.out.includes('extra.mjs');
  check('module added to the tree without manifest update → payload-verify RED (undeclared)', undeclared,
    undeclaredRun.out.trim().slice(0, 200));

  // ── D. Missing file → red ─────────────────────────────────────────────────────────
  // Remove a file from the served tree that IS in the manifest, re-fetch → missing.
  fs.unlinkSync(path.join(serveBase, payload[0].path)); // a file the manifest DOES declare
  const fetch3 = fetchPayload(path.join(root, 'out3'));
  const missing = fetch3.code !== 0 && fetch3.out.includes(payload[0].path);
  check('missing manifest-declared file → payload RED and names the file', missing,
    fetch3.out.trim().slice(0, 200));

  srv.kill();
  const failed = results.filter(r => !r.ok);
  console.log(`\nR2 consumer-boundary reproduction — ${results.length - failed.length}/${results.length} checks pass`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
  console.log(`\nworkdir: ${root}${KEEP ? '' : ' (removed)'}`);
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error('repro harness error:', e && e.stack ? e.stack : e);
  try { srv?.kill(); } catch {}
  if (!KEEP) { try { rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exit(2);
}
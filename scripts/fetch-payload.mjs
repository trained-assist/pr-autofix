#!/usr/bin/env node
// Fetch the pinned payload and LAY IT OUT AS THE TREE, then verify and RUN it.
//
// Fetch logic lives here, in code, not in shell prose in the workflow: the original defect was
// hand-written shell prose (a list of paths plus a flatten step), so the shell is exactly where
// this class of bug must not live again.
//
//   node scripts/fetch-payload.mjs --manifest <f> --dest <d> [--from-file <base-url-file>]
//                                  [--run <subcommand>...] [--dry-run]
//
// `--from-file` reads a base URL from a FILE rather than argv: a reusable workflow's base URL
// contains `${...}`-free text today, but shell interpolation of a URL is how a caller ends up
// fetching from a moving branch. The caller writes the identity it resolved; this script never
// guesses one.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from './lib/devbaseline/payload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : (argv[i + 1] ?? '');
};
const has = name => argv.includes(`--${name}`);

const manifestFile = flag('manifest');
// --dest IS the payload root: the tree is reproduced inside it exactly as declared. No implicit
// subdirectory — a silent suffix here is how a caller ends up verifying one path and running another.
const dest = path.resolve(flag('dest', path.join(process.env.RUNNER_TEMP || '.', 'devbaseline')));
const baseFile = flag('from-file');

if (!manifestFile) { process.stderr.write('fetch-payload: --manifest <f> is required\n'); process.exit(2); }
if (!baseFile) { process.stderr.write('fetch-payload: --from-file <f> is required — this script will not fall back to main\n'); process.exit(2); }

const base = fs.readFileSync(baseFile, 'utf8').trim().replace(/\/+$/, '');
// The base must name a COMMIT, not a branch: that is the invariant autofix-callable.yml already
// enforces and which templates/batch-fix-prs.yml violated by fetching from `main`. Loopback
// (127.0.0.1) is accepted ONLY so the offline boundary sandbox can exercise this exact code path
// — it still has to carry an owner/repo/sha shape.
const PINNED = /^https:\/\/raw\.githubusercontent\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[0-9a-f]{7,40}$/;
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[0-9a-f]{7,40}$/;
if (!PINNED.test(base) && !LOOPBACK.test(base)) {
  process.stderr.write(`fetch-payload: refusing to fetch from "${base}" — expected https://raw.githubusercontent.com/<owner>/<repo>/<commit-sha>\n`);
  process.exit(2);
}

let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) {
  process.stderr.write(`fetch-payload: manifest is unreadable: ${e.message}\n`); process.exit(2);
}

let fetched = 0;
for (const e of manifest.entries || []) {
  const abs = path.join(dest, e.path);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const r = spawnSync('curl', ['-fsSL', `${base}/${e.path}`, '-o', abs], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`fetch-payload: ${e.path} — ${(r.stderr || 'download failed').trim().slice(0, 200)}\n`);
    process.exit(1);
  }
  fetched++;
}

// Both directions: missing, hash mismatch, and files present but undeclared.
const v = verifyManifest(manifest, dest);
if (!v.ok) {
  for (const p of v.missing) process.stderr.write(`fetch-payload: missing ${p}\n`);
  for (const p of v.hash_mismatch) process.stderr.write(`fetch-payload: hash mismatch ${p}\n`);
  for (const p of v.undeclared) process.stderr.write(`fetch-payload: undeclared in tree ${p}\n`);
  if (v.reason) process.stderr.write(`fetch-payload: ${v.reason}\n`);
  process.exit(1);
}
process.stdout.write(`fetch-payload: ${fetched} file(s) laid out under the tree, hashes verified\n`);
if (has('dry-run')) process.exit(0);

// RUN the payload. `node --check` was proven blind to unresolved imports — the original loader
// used it and shipped a CLI that could not start. The subcommand is the only honest smoke test.
const cli = path.join(dest, 'scripts', 'devbaseline.mjs');
const runIdx = argv.indexOf('--run');
const sub = runIdx === -1 ? 'payload-verify' : (argv[runIdx + 1] || 'payload-verify');
// Everything after `--run <subcommand>` is forwarded verbatim to the payload CLI.
const extra = runIdx === -1 ? [] : argv.slice(runIdx + 2);
const r = spawnSync('node', [cli, sub, ...extra], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
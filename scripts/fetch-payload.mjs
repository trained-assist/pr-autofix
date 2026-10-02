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
//
// R1 — ZERO RELATIVE IMPORTS, ON PURPOSE. This file is a BOOTSTRAP: it is the one file that must
// exist before the manifest it honours is laid out, so it cannot be delivered by that manifest.
// It used to `import { verifyManifest } from './lib/devbaseline/payload.mjs'` — a dependency it
// could only satisfy when someone remembered to place the module next to it. That is the #38 shape
// (a hand-kept file list) rebuilt one level up, and the workflow's curl of this single file is
// exactly how it half-worked in production: the step died with ERR_MODULE_NOT_FOUND while the
// manifest it was about to verify looked fine. Verification is therefore NOT done here — it is done
// by the payload CLI, run FROM the tree this file just laid out (that is what `payload-verify`
// does, in both directions). Nothing is duplicated, and a bootstrap that runs alone in an empty
// scratch dir cannot be quietly dependent on a neighbour. The offline sandbox
// (scripts/sandbox/consumer-boundary.mjs) now runs this file from such an empty dir on purpose.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// Both directions — missing, hash mismatch, and files present but undeclared — are verified by the
// payload CLI run below, FROM this tree. Verifying here would mean importing the very module the
// manifest declares, which is the bootstrap dependency this file must not have.
process.stdout.write(`fetch-payload: ${fetched} file(s) laid out under the tree\n`);
if (has('dry-run')) {
  process.stdout.write('fetch-payload: --dry-run — the tree is NOT verified and NOT executed (verification happens in the run step)\n');
  process.exit(0);
}

// RUN the payload. `node --check` was proven blind to unresolved imports — the original loader
// used it and shipped a CLI that could not start. The subcommand is the only honest smoke test:
// it starts the CLI from the tree AND proves the tree matches the manifest at that commit.
const cli = path.join(dest, 'scripts', 'devbaseline.mjs');
const runIdx = argv.indexOf('--run');
const sub = runIdx === -1 ? 'payload-verify' : (argv[runIdx + 1] || 'payload-verify');
// Everything after `--run <subcommand>` is forwarded verbatim to the payload CLI.
const extra = runIdx === -1 ? [] : argv.slice(runIdx + 2);
const r = spawnSync('node', [cli, sub, ...extra], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
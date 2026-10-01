#!/usr/bin/env node
// Class scan #2 — who OWNS a fact written into the receipt?
//
// R1 was caught by `r1-delivery-boundary-scan.mjs` (the delivery boundary: a reusable workflow
// runs code it never delivers). R2, R3 and R4 are the same class one level up: **a fact is written
// and nobody reads it.** A `no_change` record sits where a blocked gate was; `tool.commit` carries
// the patch SHA where the tool build belongs; `retention.ttl_days` names a deadline no component
// executes. All three stayed invisible for one reason, and it is not bad luck:
//
//   the producer writes the artifact AND the test that "verifies" it. No independent reader of the
//   artifact exists in the repo, so a field's meaning can be redefined (R3), can be silently
//   overwritten by another writer (R2), or can be pure decoration (R4) — and nothing goes red.
//
// This scan turns the observation into a list a fix can gate on:
//   NO_READER            — declared in the contract, consumed by no production code (R4 shape)
//   PRODUCER_TESTED_ONLY — read only inside scripts/sandbox/, i.e. only by a test the producer's
//                          own commit brought with it (R2/R3 shape)
//   OVERLOADABLE         — an `extra.<key>` slot any call site can inject, so one field can hold
//                          two different meanings depending on who writes it (R2/R3 shape)
//
// Heuristic by construction (grep level, not a type system): it names CANDIDATES, over-reports on
// purpose, and is meant to be re-run after the fix — not to be trusted as a proof on its own.
//
//   node scripts/sandbox/contract-slot-scan.mjs [--code <repo>] [--json] [--strict]
// exit 1 = at least one NO_READER slot (default), or NO_READER + PRODUCER_TESTED_ONLY (--strict).

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i !== -1 && argv[i + 1] ? argv[i + 1] : d; };
const CODE = path.resolve(arg('--code', path.join(HERE, '..', '..')));
const AS_JSON = argv.includes('--json');
const STRICT = argv.includes('--strict');

// The two record builders. Keys are PARSED out of them, never hand-listed: a hand-written key list
// is prose that goes stale exactly the way the hand-written payload file list did (#38).
const WRITERS = ['scripts/lib/devbaseline/log.mjs', 'scripts/autofix.mjs'];

const PY = String.raw`
import sys, os, re, json
root = sys.argv[1]
writers = sys.argv[2:]
SKIP_DIRS = ('node_modules', '.git')
SANDBOX = os.path.join('scripts', 'sandbox')

def walk(exts):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in sorted(filenames):
            if fn.endswith(exts):
                yield dirpath, fn

# ── pass 1: contract slots, parsed from the builders ──────────────────────────────
slots = {}   # key -> {"writers": [relpath…], "extra": bool}
for w in writers:
    p = os.path.join(root, w)
    if not os.path.exists(p):
        continue
    text = open(p, encoding='utf8', errors='replace').read()
    for m in re.finditer(r'^[ ]{4,6}([a-z_][a-z0-9_]{2,}):', text, re.M):
        slots.setdefault(m.group(1), {"writers": [], "extra": False})["writers"].append(w)
    for m in re.finditer(r'\bextra\.([a-z_][a-z0-9_]{2,})', text):
        slots.setdefault(m.group(1), {"writers": [], "extra": False})
        slots[m.group(1)]["extra"] = True
        slots[m.group(1)]["writers"].append(w + " (extra.*)")

# ── pass 2: occurrences of every slot, split into writers / production / sandbox ───
writer_rel = set(writers)
found = {k: {"writers": [], "production": [], "sandbox": [], "docs": []} for k in slots}
patterns = {k: re.compile(r'(?<![A-Za-z0-9_])' + re.escape(k) + r'(?![A-Za-z0-9_])') for k in slots}
for dirpath, fn in walk(('.mjs', '.js', '.yml', '.json', '.md')):
    p = os.path.join(dirpath, fn)
    rel = os.path.relpath(p, root)
    try:
        text = open(p, encoding='utf8', errors='replace').read()
    except Exception:
        continue
    lines = text.splitlines()
    for k, rx in patterns.items():
        for i, line in enumerate(lines, 1):
            if not rx.search(line):
                continue
            hit = "%s:%d" % (rel, i)
            if rel in writer_rel:
                found[k]["writers"].append(hit)
            elif rel.startswith(SANDBOX):
                found[k]["sandbox"].append(hit)
            elif rel.endswith(('.mjs', '.js')):
                found[k]["production"].append(hit)
            else:
                found[k]["docs"].append(hit)

# ── pass 3: does ANY production code READ BACK a receipt it persisted? ──────────────
# Root-cause check, not a heuristic. A receipt nobody opens back catches nothing: every meaning
# assigned to a slot is then unchecked except by the test the same commit brought along (R2/R3),
# and a declared deadline nobody acts on stays decoration forever (R4). "Reads" is decided per
# LINE — a line that names a receipt artifact together with a file read / JSON.parse is a reader,
# the same line without one is a writer (upload-artifact, writeStats, upload step).
RECEIPT_ARTIFACT = re.compile(r'ci-fixer-stats|devbaseline-verify|log\.json|\breceipt\b|writeLogRecord|writeStats')
IS_READ = re.compile(r'readFileSync|readFile\(|JSON\.parse|createReadStream')
receipt_readers = {"production": [], "sandbox": [], "writers": [], "workflows": []}
for dirpath, fn in walk(('.mjs', '.js')):
    rel = os.path.relpath(os.path.join(dirpath, fn), root)
    lines = open(os.path.join(dirpath, fn), encoding='utf8', errors='replace').read().splitlines()
    reads, writes = [], []
    for i, line in enumerate(lines, 1):
        if not RECEIPT_ARTIFACT.search(line):
            continue
        (reads if IS_READ.search(line) else writes).append("%s:%d" % (rel, i))
    where = "sandbox" if rel.startswith(SANDBOX) else "production"
    if reads:
        receipt_readers[where].extend(reads)
    if writes and where == "production":
        receipt_readers["writers"].extend(writes)
for dirpath, fn in walk(('.yml',)):
    rel = os.path.relpath(os.path.join(dirpath, fn), root)
    lines = open(os.path.join(dirpath, fn), encoding='utf8', errors='replace').read().splitlines()
    for i, line in enumerate(lines, 1):
        if RECEIPT_ARTIFACT.search(line) and re.search(r'jq |node -e |cat ', line):
            receipt_readers["workflows"].append("%s:%d" % (rel, i))

out = []
for k in sorted(slots):
    f = found[k]
    prod = f["production"]
    if prod:
        verdict = "ok"
    elif f["sandbox"] or f["writers"]:
        verdict = "PRODUCER_TESTED_ONLY"
    else:
        verdict = "NO_READER"
    if verdict == "NO_READER":
        # no reader anywhere but the slot is still written by someone → R4 shape
        verdict = "NO_READER"
    out.append({
        "key": k,
        "writers": f["writers"][:4],
        "production_hits": prod[:6],
        "sandbox_hits": len(f["sandbox"]),
        "verdict": verdict,
        "overloadable": slots[k]["extra"],
    })
print(json.dumps({"slots": out, "receipt_readers": receipt_readers}, ensure_ascii=False))
`;

let parsed;
try {
  parsed = execFileSync('python3', ['-c', PY, CODE, ...WRITERS], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  console.error('contract-slot-scan: harness error:', e && e.stderr ? String(e.stderr).slice(0, 500) : e.message);
  process.exit(2);
}
const { slots, receipt_readers } = JSON.parse(parsed);
const noReader = slots.filter((s) => s.verdict === 'NO_READER');
const producerTested = slots.filter((s) => s.verdict === 'PRODUCER_TESTED_ONLY');
const overloadable = slots.filter((s) => s.overloadable);

if (AS_JSON) {
  console.log(JSON.stringify({ scan: 'contract slots', code: CODE, slots, noReader, producerTested, overloadable, receipt_readers }, null, 2));
} else {
  console.log(`\nContract-slot scan — ${slots.length} slot(s): ${noReader.length} NO_READER, ${producerTested.length} producer-tested-only, ${overloadable.length} overloadable\n`);
  for (const s of slots) {
    const flag = s.verdict === 'NO_READER' ? 'FAIL' : s.verdict === 'PRODUCER_TESTED_ONLY' ? 'warn' : 'ok  ';
    const tags = [s.overloadable ? 'overloadable' : null, `writers=${s.writers.length}`, `sandbox_hits=${s.sandbox_hits}`]
      .filter(Boolean).join(' · ');
    console.log(`${flag} ${s.key.padEnd(20)} ${s.verdict.padEnd(19)} ${tags}`);
    if (s.verdict !== 'ok' && s.production_hits.length) console.log(`       production reads: ${s.production_hits.slice(0, 3).join(', ')}`);
  }
  console.log('\nNO_READER            = contract slot written but consumed by no production code (R4 shape)');
  console.log('PRODUCER_TESTED_ONLY = read only inside scripts/sandbox/ (R2/R3 shape)');
  console.log('overloadable         = extra.<key> slot any call site can inject (one field, two meanings)');
  console.log('\nReceipt readers — production: ' + (receipt_readers.production.length ? receipt_readers.production.join(', ') : 'NONE'));
  console.log('                   sandbox:   ' + (receipt_readers.sandbox.length ? receipt_readers.sandbox.length + ' file(s)' : 'none'));
  console.log('                   workflows: ' + (receipt_readers.workflows.length ? receipt_readers.workflows.join(', ') : 'NONE'));
  if (!receipt_readers.production.length && !receipt_readers.workflows.length) {
    console.log('  → ROOT CAUSE SHAPE: no production code and no workflow ever opens a persisted receipt.');
  }
}

process.exit(STRICT ? (noReader.length + producerTested.length ? 1 : 0) : (noReader.length ? 1 : 0));
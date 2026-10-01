// The reader of a persisted receipt — the half that R2 was missing.
//
// The root cause of R2/R3/R4 in one line: the producer of an artifact wrote it AND the test that
// "verifies" it, so nobody independent ever opened the file. A red staging therefore sat on disk as
// `outcome: no_change` with `gate_violations: []` (R2), a field's meaning could be redefined and
// the test rewritten under the new meaning (R3), and a declared deadline nobody executed stayed
// decoration forever (R4). A receipt that only the author ever reads is not evidence.
//
// This module has ONE job: read a receipt back and say whether it contradicts ITSELF. The verdict
// is re-derived from the two facts the record already carries — `gate.verify_exit` and
// `gate.staging` — with the same mapping `runGate` used when it wrote them. If the stored
// `gate.blocks` disagrees with that derivation, the record is a liar: not wrong about the
// repository (a different question, answered by `outcome`/`rule_id`), wrong about its own decision.
//
// It deliberately does NOT decide what is good or bad: `blocks: true` is a perfectly consistent
// record. Consistency is the property being checked, so a repository that legitimately blocks the
// merge never trips this.

import fs from 'node:fs';
import { verdictForVerify } from './gate.mjs';

/** Read a receipt file. A file that cannot be parsed is reported, never guessed at. */
export function readReceipt(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, readable: false, message: `receipt is unreadable: ${file}: ${e.message}`, receipt: null };
  }
  try {
    const receipt = JSON.parse(raw);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      return { ok: false, readable: true, message: `receipt is not a JSON object: ${file}`, receipt: null };
    }
    return { ok: true, readable: true, message: '', receipt };
  } catch (e) {
    return { ok: false, readable: true, message: `receipt is not valid JSON: ${file}: ${e.message}`, receipt: null };
  }
}

/**
 * Re-derive the verdict from what the record says it ran. Null when the record predates the gate
 * block — that is an older, valid record, not a contradictory one.
 */
export function recomputeVerdict(receipt) {
  const gate = receipt && receipt.gate;
  if (!gate || typeof gate !== 'object') return null;
  const verifyExit = gate.verify_exit;
  if (!Number.isInteger(verifyExit)) return null;

  const v = verdictForVerify(verifyExit);
  const staging = gate.staging && typeof gate.staging === 'object' ? gate.staging : {};
  const stagingDeclared = staging.declared === true;
  const stagingCode = stagingDeclared ? staging.code : null;
  const stagingBlocks = stagingDeclared && stagingCode !== 0;
  const blocks = v.blocks || stagingBlocks;

  return {
    blocks,
    verdict: blocks ? 'blocked' : 'passed',
    // The same override runGate applies: a failing declared staging command is the EFFECTIVE
    // reason when verify itself was fine. Two reasons for a red gate are why this matters —
    // `needs_human` and `staging_command_failed` lead to different next actions.
    reason_code: stagingBlocks && !v.blocks ? 'staging_command_failed' : (receipt.reason_code ?? null),
    outcome: v.outcome,
    verify_exit: verifyExit,
    staging_declared: stagingDeclared,
    staging_code: stagingCode,
  };
}

/**
 * Does the stored gate block agree with the evidence stored next to it?
 * @returns {{ok: boolean, problems: string[], recomputed: object|null, has_gate: boolean}}
 */
export function assertReceiptConsistent(receipt) {
  const stored = receipt && receipt.gate;
  if (!stored || typeof stored !== 'object') {
    return { ok: true, problems: [], recomputed: null, has_gate: false };
  }
  const problems = [];
  const recomputed = recomputeVerdict(receipt);

  if (recomputed === null) {
    problems.push('gate block present but verify_exit is not an integer — the verdict cannot be re-derived');
    return { ok: false, problems, recomputed: null, has_gate: true };
  }
  if (stored.blocks !== recomputed.blocks) {
    problems.push(`gate.blocks says ${JSON.stringify(stored.blocks)} but verify_exit ${recomputed.verify_exit} + staging ${recomputed.staging_declared ? `exit ${recomputed.staging_code}` : 'not declared'} recompute to ${recomputed.blocks}`);
  }
  if (stored.verdict !== recomputed.verdict) {
    problems.push(`gate.verdict says ${JSON.stringify(stored.verdict)} but the evidence recomputes to ${recomputed.verdict}`);
  }
  if ((stored.reason_code ?? null) !== (recomputed.reason_code ?? null)) {
    problems.push(`gate.reason_code says ${JSON.stringify(stored.reason_code ?? null)} but the evidence recomputes to ${JSON.stringify(recomputed.reason_code)}`);
  }
  if (typeof stored.verify_exit !== 'number') {
    problems.push(`gate.verify_exit must be a number, got ${JSON.stringify(stored.verify_exit)}`);
  }
  if (recomputed.staging_declared && !Number.isInteger(recomputed.staging_code)) {
    problems.push(`staging is declared but gate.staging.code is ${JSON.stringify(recomputed.staging_code)} — a declared command that never ran cannot be a passed gate`);
  }
  if (!recomputed.staging_declared && stored.staging && stored.staging.declared === true) {
    problems.push('gate.staging.declared disagrees with the code path that re-derived it');
  }
  if (!recomputed.staging_declared && recomputed.staging_code !== null && recomputed.staging_code !== undefined) {
    problems.push(`staging is not declared yet a code (${JSON.stringify(recomputed.staging_code)}) is recorded`);
  }

  return { ok: problems.length === 0, problems, recomputed, has_gate: true };
}

/** Both directions in one call: readable AND self-consistent. */
export function checkReceipt(file) {
  const read = readReceipt(file);
  if (!read.ok) return { ...read, code: 2, has_gate: false, recomputed: null, problems: [read.message] };
  const consistency = assertReceiptConsistent(read.receipt);
  return {
    ...read,
    ...consistency,
    code: consistency.ok ? 0 : 1,
  };
}

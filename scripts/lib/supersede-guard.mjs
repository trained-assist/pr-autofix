// Supersede-aware live-PR guard (trained-assist-engineering#27).
//
// GitHub is the single source of truth for PR state. The agent supersedes a
// broken PR by opening the replacement FIRST and only then commenting →
// labelling (`superseded`) → closing the old one, so between "decided" and
// "closed" the old PR is still OPEN and a one-shot start check misses the race.
// Every mutating step therefore re-reads the live PR: still open, no
// `superseded` label, head unchanged since the first read.
//
// Fail CLOSED. A PR we could not read is NOT an actionable PR: an unknown state
// authorises nothing. This is the difference from the previous behaviour, where a
// swallowed `gh api` error (`catch → proceed`, `prStaleReason(null) === null`)
// let the run publish a fix and close PRs on a guess.
//
// The publish sequence lives HERE rather than in the caller so the self-test
// drives the same production path with a mocked fetcher and a mutation
// recorder — "no mutation on stale/unknown state" is proven, not asserted
// about a copy of the logic.

export const GUARD = { OK: 'ok', STALE: 'stale', UNKNOWN: 'unknown' };

const SHORT = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 120);

// Pure decision: may we still act against this PR?
//   pr == null / pr.readError → UNKNOWN (fail closed — no mutation)
//   closed / merged           → STALE
//   `superseded` label       → STALE
//   head != expectedHead     → STALE
export function classifyLivePr(pr, expectedHead, prNumber) {
  if (pr == null) {
    return { state: GUARD.UNKNOWN, reason: `live state of PR #${prNumber} is unavailable — failing closed` };
  }
  if (pr.readError) {
    return { state: GUARD.UNKNOWN, reason: `live read of PR #${prNumber} failed (${SHORT(pr.readError)}) — failing closed` };
  }
  if (pr.state !== 'open') {
    return { state: GUARD.STALE, reason: `PR #${prNumber} is already ${pr.state}` };
  }
  if ((pr.labels || []).some(l => l && l.name === 'superseded')) {
    return { state: GUARD.STALE, reason: `PR #${prNumber} is labelled superseded` };
  }
  if (expectedHead && pr.head && pr.head.sha && pr.head.sha !== expectedHead) {
    return { state: GUARD.STALE, reason: `PR #${prNumber} head moved (${SHORT(expectedHead).slice(0, 7)} → ${SHORT(pr.head.sha).slice(0, 7)})` };
  }
  return { state: GUARD.OK, reason: null };
}

// A guard instance per run: remembers the head seen on the first successful read
// and re-checks it on every later call.
export function createGuard({ prNumber, fetchPr }) {
  let expectedHead = '';
  return {
    get expectedHead() { return expectedHead; },
    check(where) {
      let pr = null;
      let readError = null;
      try {
        pr = fetchPr(prNumber);
      } catch (e) {
        readError = SHORT(e && e.message ? e.message : e);
      }
      const verdict = classifyLivePr(readError ? { readError } : pr, expectedHead, prNumber);
      if (verdict.state === GUARD.OK && pr && pr.head && pr.head.sha && !expectedHead) expectedHead = pr.head.sha;
      return { ...verdict, where };
    },
  };
}

// Run the mutating steps in order; before each one re-verify live state.
// Stops at the FIRST stale/unknown verdict — steps after it never run.
export async function runGuardedSequence({ guard, steps }) {
  for (const step of steps) {
    const verdict = guard.check(step.where);
    if (verdict.state !== GUARD.OK) {
      return { aborted: true, at: step.where, state: verdict.state, reason: verdict.reason };
    }
    await step.run();
  }
  return { aborted: false, at: null, state: null, reason: null };
}
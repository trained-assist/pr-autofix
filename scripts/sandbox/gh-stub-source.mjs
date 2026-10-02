// One `gh` stub source for every sandbox probe that runs the shipped autofix
// pipeline against a fake GitHub.
//
// It used to be copy-pasted into three probes, and each copy answered a live-PR
// read with `{}`. That "worked" only while the pipeline treated an unreadable PR
// as permission to act: the guard now fails closed (trained-assist-engineering#27),
// so a stub that models nothing is a stub that models "abort". The PR read is
// part of the stub contract here — `gh api …/pulls/<n>` answers a real, open,
// stable-head PR, which is the state in which the fixer may act.
//
// Probes that need a different shape (a recorded call log, simulated 403, branch
// listings) keep their own stub; they just may not pretend a PR read is empty.

export const GH_STUB_SOURCE = String.raw`#!/usr/bin/env node
const a = process.argv.slice(2);
const has = s => a.includes(s);
const out = s => process.stdout.write(s);
if (a[0] === 'pr') {
  if (a[1] === 'view') {
    if (has('--json') && a.join(' ').includes('statusCheckRollup'))
      out(JSON.stringify({ state: 'OPEN', statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }));
    else
      out(JSON.stringify({ title: 'fix: failing sum test', body: 'sum returns wrong value', commits: [{ messageHeadline: 'feat change' }] }));
  } else if (a[1] === 'create') out('https://github.com/o/r/pull/2');
  else if (a[1] === 'list') out('[]');
  else out('');
} else if (a[0] === 'api') {
  const joined = a.join(' ');
  if (joined.includes('/logs')) out('npm test\nnot ok 1 - sum\nERROR: Process completed with exit code 1\n');
  else if (joined.includes('/jobs')) out(JSON.stringify([{ id: 1, name: 'test', conclusion: 'failure' }]));
  // The supersede guard re-reads the live PR before every mutation and fails
  // CLOSED on an unreadable answer. A bare {} used to pass as "fine" only
  // because the old code treated a missing read as permission to act; the
  // scenario now models a real, stable, open PR.
  else if (/\/pulls\/\d+/.test(joined)) out(JSON.stringify({ state: 'open', labels: [], head: { sha: 'a'.repeat(40) } }));
  else out('{}');
} else if (a[0] === 'run') out('not ok 1 - sum\nERROR: Process completed with exit code 1\n');
else out('');
`;

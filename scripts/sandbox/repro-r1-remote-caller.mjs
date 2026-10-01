import assert from 'node:assert/strict';
import { scanSource } from '../lib/devbaseline/inventory.mjs';
import { buildConstructionTasks } from '../lib/devbaseline/construction-tasks.mjs';
const callable = '.github/workflows/autofix-callable.yml';
const uses = ref => `name: CI\non: push\njobs:\n  fix:\n    uses: trained-assist/pr-autofix/${callable}@${ref}\n`;
const fixtures = [
  ['provider', { [callable]: 'on: [workflow_call]\njobs: {}' }, true, 'local_provider', [], null],
  ['remote-current', { '.github/workflows/ci.yml': uses('v1.7.5') }, true, 'remote_caller', ['v1.7.5'], 'fix_unverified'],
  ['remote-old', { '.github/workflows/ci.yml': uses('v1.5.3') }, true, 'remote_caller', ['v1.5.3'], 'fix_upgrade'],
  ['remote-floating', { '.github/workflows/ci.yml': uses('v1') }, true, 'remote_caller', ['v1'], 'fix_upgrade'],
  ['absent', {}, false, 'absent', [], 'fix_missing'],
  ['comment-only', { '.github/workflows/ci.yml': '# '+uses('v1').replaceAll('\n', '\n# ') }, false, 'absent', [], 'fix_missing'],
  ['script-only', { '.github/workflows/ci.yml': 'jobs:\n  test:\n    steps:\n      - run: |\n          uses: trained-assist/pr-autofix/'+callable+'@v1\n' }, false, 'absent', [], 'fix_missing'],
  ['quoted', { '.github/workflows/ci.yaml': uses('v1.7.5').replace('uses: trained', 'uses: "trained').replace('@v1.7.5', '@v1.7.5" # pinned') }, true, 'remote_caller', ['v1.7.5'], 'fix_unverified'],
  ['multiple', { '.github/workflows/a.yml': uses('v1'), '.github/workflows/b.yml': uses('v1.7.5') }, true, 'remote_caller', ['v1', 'v1.7.5'], 'fix_upgrade'],
  ['unreadable', { '.github/workflows/ci.yml': null }, null, 'unknown', [], 'fix_unverified'],
];
let failed = 0;
for (const [name, files, present, installation, refs, taskKind] of fixtures) {
  files['package.json'] = '{}';
  for (const kind of ['local', 'live']) {
    const source = {kind, readable:true, files:new Set(Object.keys(files)), has:p=>p in files, readText:async p=>files[p]??null};
    try {
      const row = await scanSource({repo:'fixture/'+name},source,'v1.7.5');
      assert.equal(row.fix.fixer_present,present);
      assert.equal(row.fix.installation,installation);
      assert.deepEqual(row.fix.observed_refs,refs);
      assert.equal(row.fix.desired_ref,'v1.7.5');
      const tasks = buildConstructionTasks([row]).filter(t=>t.kind.startsWith('fix_'));
      assert.deepEqual(tasks.map(t=>t.kind), taskKind ? [taskKind] : []);
      console.log('ok', name, kind);
    } catch(e) { failed++; console.error('FAIL',name,kind,e.message); }
  }
}
process.exitCode = failed ? 1 : 0;

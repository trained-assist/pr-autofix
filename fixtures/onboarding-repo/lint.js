// FAILS ON PURPOSE — this is the planted defect the staging rehearsal must observe.
// Fixing this file would silently turn the controlled-failure check into a green no-op.
console.error('lint: onboarding-fixture: planted violation in src/sum.js (unused-parameter)');
process.exit(1);

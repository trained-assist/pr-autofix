// Passes. A fixture whose check always fails cannot tell "the check found the planted defect"
// apart from "the check is broken".
const { sum } = require('./src/sum.js');
if (sum(2, 3) !== 5) { console.error('check failed: sum(2,3) !== 5'); process.exit(1); }
console.log('check: ok');

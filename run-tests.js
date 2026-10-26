const EoM = require('./engine.js');
const { runTests } = require('./tests.js');
const res = runTests(EoM);
let group = '';
for (const r of res) {
  if (r.group !== group) { group = r.group; console.log('\n' + group); }
  console.log((r.pass ? '  PASS ' : '  FAIL ') + r.name + (r.pass ? '' : '\n       ' + r.error) + `  (${r.ms} ms)`);
}
const failed = res.filter(r => !r.pass).length;
console.log(`\n${res.length - failed}/${res.length} passed`);
process.exit(failed ? 1 : 0);

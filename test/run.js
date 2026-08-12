// run.js — the whole test suite. No framework; assert and a counter.
//
//   node test/run.js
//
// Test bodies may be async. They are queued as each file is required and then run
// in order, awaited one at a time. An earlier version called the body and moved on,
// which meant an async test that threw after its first await was counted as a pass
// and its failure surfaced as an unhandled rejection nobody read.

const files = [
  './parse.test.js',
  './validate.test.js',
  './decision.test.js',
  './intake.test.js',
  './changes.test.js',
  './regressions.test.js',
  './bridge.test.js',
];

let queue = [];
global.t = (name, fn) => queue.push({ name, fn });

(async () => {
  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const file of files) {
    queue = [];
    require(file);
    const cases = queue;
    console.log(`\n--- ${file.replace('./', '').replace('.test.js', '')} ---`);
    for (const { name, fn } of cases) {
      try {
        await fn();
        pass += 1;
      } catch (e) {
        fail += 1;
        failures.push(`${name}\n    ${e.message}`);
      }
    }
    console.log(`  ${cases.length} checks`);
  }

  console.log('');
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();

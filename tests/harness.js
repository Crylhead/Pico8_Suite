// Minimal async-capable test registry shared by tests/regress.js and tests/*.test.js.
const tests = [];
exports.t = (name, fn) => tests.push({ name, fn });
exports.run = async () => {
  let passed = 0, failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (e) {
      failed++;
      console.log(`not ok - ${name}\n  ${(e && e.stack) || e}`);
    }
  }
  console.log(`${passed} passed${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exitCode = 1;
};

// Helpers for integration tests that run actual functions from the tool modules (js/*.js) in a vm
// context, without a DOM (first used by tests/studio-save.test.js, #80). Not a test file itself.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** Source of `function name(...) {...}` (optionally async), found by balanced braces. */
function fn(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `function ${name} not found`);
  // the body starts at the first ") {" (parameters may destructure with braces of their own)
  const body = /\)\s*\{/g; body.lastIndex = m.index;
  let i = body.exec(src).index; let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

/** One source line that starts with `prefix` (after indentation); '' when optional and absent. */
const line = (src, prefix, { optional = false } = {}) => {
  const l = src.split('\n').find((x) => x.trim().startsWith(prefix));
  assert.ok(l || optional, `line ${prefix} not found`);
  return l || '';
};

/** Values from a vm realm have their own Array.prototype: compare them as JSON. */
const same = (actual, expected, msg) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);

module.exports = { read, fn, line, same };

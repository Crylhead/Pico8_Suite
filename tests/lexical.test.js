// #11: Audit token and include analysis share the Code Editor's Lua lexer
// (long brackets of any level, real #include lines only, .p8:N code tabs).
const assert = require('assert');
const { t } = require('./harness.js');
const A = require('../js/audit-core.js');

const cart = (lua) => `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n__gfx__\n00\n`;
const files = (o) => A.makeFs(new Map(Object.entries(o)));

t('#11 long comments and strings of any level count like level 0', () => {
  const x = A.countTokens('x=1');
  assert.strictEqual(x, 3);
  // previously 7: only --[[ ]] was a block comment
  assert.strictEqual(A.countTokens('--[=[\nx=99\n]=]\nx=1'), x);
  assert.strictEqual(A.countTokens('--[==[ ]] ]=] x=99 ]==]x=1'), x);
  // previously 3 vs 8: only [[ ]] was a long string
  assert.strictEqual(A.countTokens('s=[=[x y]=]'), A.countTokens('s=[[x y]]'));
  assert.strictEqual(A.countTokens('s=[==[a ]] b]==]'), 3);
  assert.strictEqual(A.countTokens('x=-1 print("a",[[b]]) local t={1,2} end'), 12);
});

t('#11 #include inside a comment or string never expands', () => {
  const fs = files({ 'm.lua': '--[[\n#include a.lua\n]]\n--[=[\n#include a.lua\n]=]\ns=[[\n#include a.lua\n]]\n#include a.lua\n', 'a.lua': 'y=1\n' });
  const w = [];
  const r = A.expandIncludes(fs, 'm.lua', fs.read('m.lua'), new Set(['m.lua']), w);
  assert.strictEqual((r.text.match(/y=1/g) || []).length, 1);
  assert.deepStrictEqual(r.resolved, ['a.lua']);
  assert.deepStrictEqual(A.parseIncludes(fs.read('m.lua')), ['a.lua']);
  assert.deepStrictEqual(w, []);
});

t('#11 .p8:N includes select that code tab, at every occurrence; tab cycles stop', () => {
  const lib = cart('t0=0\n-->8\nt1=1\n-->8\nt2=2');
  const fs = files({ 'lib.p8': lib, 'main.p8': cart('#include lib.p8:1\n#include lib.p8:1\n#include lib.p8:9') });
  const w = [];
  const r = A.expandIncludes(fs, 'main.p8', A.extractLua(fs.read('main.p8')), new Set(['main.p8']), w);
  assert.strictEqual((r.text.match(/t1=1/g) || []).length, 2);
  assert.ok(!/t0=0|t2=2/.test(r.text), r.text);
  assert.ok(w.some((m) => /unresolved include: lib\.p8:9/.test(m)), w.join(';'));
  assert.ok(!w.some((m) => /cycle/.test(m)), w.join(';'));
  // tab 2 includes tab 1 (fine); tab 1 including tab 2 back is a cycle
  const w2 = [];
  const fs2 = files({ 'c.p8': cart('-->8\n#include c.p8:2\n-->8\n#include c.p8:1') });
  A.expandIncludes(fs2, 'x.lua', '#include c.p8:1\n', new Set(['x.lua']), w2);
  assert.ok(w2.some((m) => /cycle/.test(m)), w2.join(';'));

  const stats = A.scanProject(new Map([['lib.p8', lib], ['main.p8', cart('#include lib.p8:1\nx=1')]]));
  const main = stats.find((c) => c.path === 'main.p8');
  assert.deepStrictEqual(main.includes_out, ['lib.p8:1']);
  assert.strictEqual(main.tokens_expanded, 6);
  assert.deepStrictEqual(stats.find((c) => c.path === 'lib.p8').includes_in, ['main.p8']);
  assert.strictEqual(A.summarize(stats).unused.length, 0);
});

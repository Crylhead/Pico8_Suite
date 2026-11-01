// #35: the Code Editor's include meter uses Audit's expansion (active include stack, .p8:N tabs),
// so repeated / diamond includes count at every occurrence, cycles stop and are not "missing",
// and the editor's total equals Audit's for the same files.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t } = require('./harness.js');
const A = require('../js/audit-core.js');
const K = require('../js/code-core.js');

const cart = (lua) => `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n__gfx__\n00\n`;

// the actual resolveIncludes() of js/code.js, run against an in-memory folder
const SRC = fs.readFileSync(path.join(__dirname, '../js/code.js'), 'utf8');
const RESOLVE = SRC.slice(SRC.indexOf('  let incRun = 0;'), SRC.indexOf('  function renderIncludes()'));
async function editor(files, rel, { folder = true } = {}) {
  const map = new Map(Object.entries(files));
  const parts = K.splitCart(map.get(rel));
  const ed = {
    folder: folder ? { name: 'demo' } : null, folderReady: folder, rel: folder ? rel : null, name: rel,
    files: new Map([...map.keys()].map((r) => [r.toLowerCase(), { rel: r }])),
    text: parts.lua, parts, incs: [], incTokens: 0,
  };
  const ctx = {
    K, A, ed, renders: 0,
    readRel: async (r) => { const f = ed.files.get(r.toLowerCase()); return f ? map.get(f.rel) : null; },
    cartText: () => K.joinCart(ed.parts, ed.text),
    renderIncludes() {}, renderMeters() { ctx.renders++; },
  };
  vm.createContext(ctx);
  vm.runInContext(`${RESOLVE}\nthis.resolveIncludes = resolveIncludes;`, ctx);
  await ctx.resolveIncludes();
  assert.strictEqual(ctx.renders, 1);
  return { ed, tokens: A.countTokens(ed.text), total: A.countTokens(ed.text) + ed.incTokens };
}

t('#35 a repeated include counts at each occurrence and both stay found', async () => {
  assert.strictEqual(A.countTokens('y=2\n'), 3);
  const { ed } = await editor({ 'main.lua': '#include lib.lua\n#include lib.lua\n', 'lib.lua': 'y=2\n' }, 'main.lua');
  // the old global "seen" set gave 3 and found [true, false]
  assert.strictEqual(ed.incTokens, 6);
  assert.deepStrictEqual(ed.incs.map((i) => [i.found, i.tokens, i.cycle]), [[true, 3, false], [true, 3, false]]);
  assert.deepStrictEqual(ed.incs.map((i) => i.rel), ['lib.lua', 'lib.lua']);
});

t('#35 diamond includes count each path; separate .p8:N tabs are separate units', async () => {
  const d = await editor({ 'm.lua': '#include a.lua\n#include b.lua\n', 'a.lua': '#include c.lua\na=1\n', 'b.lua': '#include c.lua\nb=1\n', 'c.lua': 'y=1\n' }, 'm.lua');
  assert.strictEqual(d.ed.incTokens, 12);
  assert.deepStrictEqual(d.ed.incs.map((i) => [i.found, i.tokens]), [[true, 6], [true, 6]]);

  const lib = cart('t0=0\n-->8\nt1=1\n-->8\nt2=22+1');
  const r = await editor({ 'lib.p8': lib, 'main.p8': cart('#include lib.p8:1\n#include lib.p8:2\n#include lib.p8:1\n#include lib.p8:9\nx=1') }, 'main.p8');
  assert.deepStrictEqual(r.ed.incs.map((i) => [i.found, i.tokens]), [[true, 3], [true, 5], [true, 3], [false, 0]]);
  assert.strictEqual(r.ed.incTokens, 11);
  assert.strictEqual(r.ed.incs[3].rel, 'lib.p8');
});

t('#35 self and indirect cycles stop with a warning and are not missing; real misses are', async () => {
  const s = await editor({ 's.lua': '#include s.lua\nx=1\n' }, 's.lua');
  assert.deepStrictEqual(s.ed.incs.map((i) => [i.found, i.cycle, i.tokens]), [[true, true, 0]]);
  assert.strictEqual(s.ed.incTokens, 0);

  const c = await editor({ 'm.lua': '#include a.lua\n#include gone.lua\n', 'a.lua': '#include b.lua\na=1\n', 'b.lua': '#include a.lua\n#include nope.lua\nb=1\n' }, 'm.lua');
  const [a, gone] = c.ed.incs;
  assert.deepStrictEqual([a.found, a.cycle, a.depth, a.missing, a.tokens], [true, true, false, 1, 6]);
  assert.ok(a.warnings.some((m) => /include cycle detected: a\.lua/.test(m)), a.warnings.join(';'));
  assert.deepStrictEqual([gone.found, gone.cycle, gone.rel], [false, false, 'gone.lua']);
  assert.strictEqual(c.ed.incTokens, 6);

  // without an open folder nothing is followed: every include is "not counted"
  const n = await editor({ 'main.lua': '#include lib.lua\n', 'lib.lua': 'y=2\n' }, 'main.lua', { folder: false });
  assert.deepStrictEqual(n.ed.incs.map((i) => i.found), [false]);
  assert.strictEqual(n.ed.incTokens, 0);
});

t('#35 Code Editor and Audit report the same expanded total for one fixture', async () => {
  const files = {
    'main.p8': cart('#include lib.lua\n#include lib.lua\n#include gfx/tabs.p8:1\n#include gfx/tabs.p8:2\n#include d.lua\nx=-1 print("hi")'),
    'lib.lua': 'y=2\n',
    'gfx/tabs.p8': cart('a=0\n-->8\n#include ../lib.lua\nb={1,2}\n-->8\nc=a+b[1]'),
    'd.lua': '#include e.lua\n#include f.lua\n#include d.lua\n',
    'e.lua': '#include lib.lua\n',
    'f.lua': '#include lib.lua\nf=1\n',
  };
  const audit = A.scanProject(new Map(Object.entries(files))).find((s) => s.path === 'main.p8');
  const { ed, tokens, total } = await editor(files, 'main.p8');
  assert.strictEqual(tokens, audit.tokens_self);
  assert.strictEqual(total, audit.tokens_expanded);
  assert.strictEqual(ed.incs.reduce((s, i) => s + i.tokens, 0), ed.incTokens);
  assert.ok(ed.incs.every((i) => i.found));
  assert.ok(ed.incs[4].cycle && audit.warnings.some((m) => /cycle/.test(m)));
});

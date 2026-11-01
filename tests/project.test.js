// Cart Builder project mutation (issues #1, #2, #7): conservative adoption and anchor rewriting.
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/project-core.js');

const cart = (name, text = '') => ({ rom: new Uint8Array(0x4300).fill(1), lua: '', used: new Uint8Array(0x4300), reads: [], luaAt: 0, name, text });
const adoptOf = (fx, more = []) => P.adopt(new Map([['fx.p8', cart('fx.p8', fx)], ['atlas.p8', cart('atlas.p8')], ...more.map((n) => [n, cart(n)])]));

t('#1 dynamic source/length is skipped with a reason and keeps its source cart', () => {
  const r = adoptOf('reload(0,frame*0x200,0x200,"atlas.p8")\nreload(0x8000,0,n+(2*k),"atlas.p8")\n');
  assert.strictEqual(r.edits.length, 0, 'no anchor for a dynamic read');
  assert.deepStrictEqual(r.skipped.map((s) => s.line), [1, 2]);
  assert.match(r.skipped[0].why, /frame/);
  assert.match(r.skipped[1].why, /\bn\b/);
  assert.ok(!r.adoptedCarts.includes('atlas.p8'), 'atlas.p8 stays in place');
  assert.ok(r.keptCarts.includes('atlas.p8'));
});
t('#1 a computed cart name keeps every source cart in place', () => {
  const r = adoptOf('reload(0x8000,0,0x100,"atlas.p8")\nreload(0x8000,0,0x100,which)\n');
  assert.strictEqual(r.edits.length, 1, 'the literal read is still anchored');
  assert.match(r.skipped[0].why, /computed/);
  assert.deepStrictEqual(r.adoptedCarts, []);
  assert.deepStrictEqual(r.keptCarts, ['atlas.p8']);
});
t('#1 out-of-range literal reads are not adopted', () => {
  const r = adoptOf('reload(0,0x4200,0x200,"atlas.p8")\nreload(0,-1,4,"atlas.p8")\nreload(0,0,0x8000*2,"atlas.p8")\n');
  assert.strictEqual(r.edits.length, 0);
  assert.strictEqual(r.skipped.length, 3);
  assert.ok(!r.adoptedCarts.includes('atlas.p8'));
});
t('#1 literal arithmetic still adopts and rewrites', () => {
  const r = adoptOf('reload(0x8000,0x200*2,(0x80+0x80)\\2,"atlas.p8")\n');
  assert.deepStrictEqual(r.skipped, []);
  assert.deepStrictEqual(r.adoptedCarts, ['atlas.p8']);
  const ref = /--@data (\S+)/.exec(r.edits[0].after)[1];
  assert.strictEqual(r.assets[0].parts[ref.split('.')[1]].bytes.length, 0x80);
  const out = P.rewriteAnchors(r.edits[0].after, () => ({ off: 0x1000, len: 0x80, cart: 'd0.p8' }));
  assert.deepStrictEqual(out.errors, []);
  assert.match(out.text, /^reload\(0x8000,0x1000,0x0080,"d0\.p8"\)/);
});
t('#1 rewrite refuses to replace a computed source, length or cart name', () => {
  const where = () => ({ off: 0x1000, len: 0x400, cart: 'd0.p8' });
  const src = 'reload(0,frame*0x200,0x200,"d0.p8") --@data a.bin+0\nreload(0,0,flr(n),"d0.p8") --@data a.bin\nreload(0,0,0x400,name) --@data a.bin\nreload(0,0x10,0x20,"d0.p8") --@data a.bin+0x10';
  const r = P.rewriteAnchors(src, where);
  assert.deepStrictEqual(r.errors.map((e) => e.line), [1, 2, 3]);
  const lines = r.text.split('\n');
  assert.strictEqual(lines[0], src.split('\n')[0], 'dynamic source left unchanged');
  assert.match(lines[3], /reload\(0,0x1010,0x0020,"d0\.p8"\)/);
  assert.ok(P.checkAnchors([{ name: 'fx.p8', text: src }], [{ ref: 'a.bin', bytes: new Uint8Array(0x400), lz: false }]).errors.length >= 3);
});

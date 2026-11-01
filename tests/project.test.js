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

// #7: a sub-range of an LZ stream cannot be unpacked; raw sub-ranges must lie inside the part
const C = require('../js/cart-core.js');
const lzPart = () => {
  const raw = new Uint8Array(100).map((_, i) => i % 10);
  const bytes = Uint8Array.from(C.lzEncode(raw));
  return { ref: 'x.bin', bytes, raw: raw.length, lz: true, asset: { parts: { bin: { bytes: raw } } }, id: 'bin' };
};
t('#7 ranged anchors into an LZ stream are rejected before writing', () => {
  const p = lzPart();
  const where = () => ({ off: 0x100, len: p.bytes.length, lz: true, cart: 'd0.p8' });
  const full = `reload(tmp,0,${p.bytes.length},"d0.p8") unlz(tmp,0x8000) --@data x.bin+0`;
  const src = ['reload(tmp,0,10,"old.p8") unlz(tmp,0x8000) --@data x.bin+5', 'reload(tmp,0,10,"old.p8") unlz(tmp,0x8000) --@data x.bin+0', full, 'reload(tmp,0,0x4300,"old.p8") unlz(tmp,0x8000) --@data x.bin'].join('\n');
  const r = P.rewriteAnchors(src, where);
  assert.deepStrictEqual(r.errors.map((e) => e.line), [1, 2]);
  assert.match(r.errors[0].msg, /LZ/);
  assert.strictEqual(r.text.split('\n')[0], src.split('\n')[0], 'nothing rewritten on a rejected line');
  assert.match(r.text.split('\n')[3], new RegExp(`reload\\(tmp,0x0100,${P.hex(p.bytes.length)},"d0\\.p8"\\)`), 'bare full-stream anchor still follows the part');
  assert.deepStrictEqual(P.checkAnchors([{ name: 'fx.p8', text: src }], [p]).errors.length, 2);
});
t('#7 raw ranges: out-of-range/overflowing/empty reads are rejected; valid slices keep their length', () => {
  const where = () => ({ off: 0x1000, len: 100, lz: false, cart: 'd0.p8' });
  const bad = ['reload(0,0,10,"a.p8") --@data x.bin+100', 'reload(0,0,10,"a.p8") --@data x.bin+0x5f', 'reload(0,0,0,"a.p8") --@data x.bin+0', 'reload(0,0,-4,"a.p8") --@data x.bin+0'];
  const r = P.rewriteAnchors([...bad, 'reload(0,0,10,"a.p8") --@data x.bin+90'].join('\n'), where);
  assert.deepStrictEqual(r.errors.map((e) => e.line), [1, 2, 3, 4]);
  assert.match(r.text.split('\n')[4], /reload\(0,0x105a,0x000a,"d0\.p8"\)/);
  const raw = { ref: 'x.bin', bytes: new Uint8Array(100), lz: false };
  assert.strictEqual(P.checkAnchors([{ name: 'fx.p8', text: bad.join('\n') }], [raw]).errors.length, 4);
});

// #2: retirement follows the references left in the final sources, not the adoption plan
t('#2 mixed literal/computed references keep atlas.p8; fully converted sources retire it', () => {
  const r = adoptOf('reload(0x8000,0,0x100,"atlas.p8")\nreload(0x8000,0,0x100,which)\n');
  const fx = P.rewriteAnchors(r.edits[0].after + '\nreload(0x8000,0,0x100,which)\n', () => ({ off: 0, len: 0x100, cart: 'd0.p8' })).text;
  const mixed = P.retirement(['atlas.p8'], [{ name: 'fx.p8', text: fx }]);
  assert.deepStrictEqual(mixed.retire, []);
  assert.strictEqual(mixed.unresolved.length, 1);
  assert.match(mixed.unresolved[0].why, /which/);
  const converted = P.retirement(['atlas.p8'], [{ name: 'fx.p8', text: fx.replace(/\nreload\(0x8000,0,0x100,which\)/, '') }]);
  assert.deepStrictEqual(converted, { retire: ['atlas.p8'], kept: [], unresolved: [] });
});
t('#2 load/cstore/include/multi-line/traceable references keep their carts, also through kept carts', () => {
  const files = [
    { name: 'main.p8', text: 'load("intro")\ncstore(0,0,0x10,"save.p8")\n#include gfx.p8:1\nreload(0x8000,\n 0,0x100,\n "multi.p8")\nlocal n="named.p8"\nreload(0,0,1,n)\n' },
    { name: 'intro.p8', text: 'reload(0,0,1,"chain.p8")' },
    { name: 'gone.p8', text: 'reload(0,0,1,"alsogone.p8")' },
  ];
  const cands = ['intro.p8', 'save.p8', 'gfx.p8', 'multi.p8', 'named.p8', 'chain.p8', 'gone.p8', 'alsogone.p8'];
  const r = P.retirement(cands, files);
  assert.deepStrictEqual(r.retire.sort(), ['alsogone.p8', 'gone.p8']);
  assert.deepStrictEqual(r.kept.map((k) => k.cart).sort(), ['chain.p8', 'gfx.p8', 'intro.p8', 'multi.p8', 'named.p8', 'save.p8']);
  assert.deepStrictEqual(r.unresolved, []);
  const inc = P.retirement(['gone.p8'], [{ name: 'main.p8', text: '#include ../lib/fx.lua\n' }]);
  assert.deepStrictEqual(inc.retire, [], 'an include that cannot be read keeps every candidate');
  assert.match(inc.unresolved[0].why, /fx\.lua/);
});

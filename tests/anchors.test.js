// #34: the whole --@data payload is validated; a malformed suffix is an error, never a shorter anchor.
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/project-core.js');

const line = (suffix) => `reload(0,0,10,"old.p8") --@data ${suffix}`;
const MALFORMED = ['x.bin+-1', 'x.bin+frame', 'x.bin+0x10*2', 'x.bin+0x', 'x.bin+0xg', 'x.bin+0x10 junk', 'x.bin+', 'x.bin+0x10000',
  'x.bin--note', 'x.bin.y', 'x.bin -- note --@data y.bin', 'x[]+4', '3x', ''];

t('#34 anchor payloads parse completely: malformed suffixes are errors, valid forms keep their meaning', () => {
  for (const s of MALFORMED) {
    const [a] = P.findAnchors(line(s));
    assert.ok(a && a.error, `--@data ${s} must be malformed`);
  }
  const ok = [
    ['x.bin', { ref: 'x.bin', sub: 0, ranged: false }],
    ['x.bin+0', { ref: 'x.bin', sub: 0, ranged: true }],
    ['x.bin+90', { ref: 'x.bin', sub: 90, ranged: true }],
    ['x.bin + 0x5a', { ref: 'x.bin', sub: 90, ranged: true }],
    ['x.bin+0X10 -- explained here\r', { ref: 'x.bin', sub: 16, ranged: true }],
    ['x.bin   ', { ref: 'x.bin', sub: 0, ranged: false }],
    ['set[] -- the skull carts', { set: 'set', sub: 0, ranged: false }],
  ];
  for (const [s, want] of ok) {
    const [a] = P.findAnchors(line(s));
    assert.strictEqual(a.error, null, `--@data ${s}: ${a.error}`);
    assert.deepStrictEqual({ ref: a.ref, set: a.set, sub: a.sub, ranged: a.ranged }, { ref: null, set: null, ...want }, s);
  }
  assert.deepStrictEqual(P.findAnchors('reload(0,0,10,"old.p8") --@datafile x.bin'), [], 'another word is no marker');
});

t('#34 rewrite and check reject malformed anchors line by line; valid lines in the same file still rewrite', () => {
  const where = (ref) => (ref === 'x.bin' ? { off: 0x100, len: 100, lz: false, cart: 'd0.p8' } : null);
  const whereSet = (n) => (n === 'set' ? { off: 0, len: 0x4300, carts: ['d1.p8', 'd2.p8'] } : null);
  const bad = ['x.bin+-1', 'x.bin+frame', 'x.bin+0x10*2', 'x.bin+0x', 'x.bin+0x10 junk'].map(line);
  const good = [line('x.bin'), line('x.bin+0'), line('x.bin+90'), line('x.bin+0x10 -- slice'), 'local cs={"a.p8","b.p8"}', 'reload(0,0,0x4300,cs[i]) --@data set[]'];
  const src = [...bad, ...good].join('\n');
  const r = P.rewriteAnchors(src, where, whereSet);
  assert.deepStrictEqual(r.errors.map((e) => e.line), [1, 2, 3, 4, 5]);
  assert.match(r.errors[0].msg, /\+-1/);
  assert.match(r.errors[2].msg, /0x10\*2/);
  const out = r.text.split('\n');
  assert.deepStrictEqual(out.slice(0, 5), bad, 'rejected lines are left unchanged (previously rewritten as bare/truncated reads)');
  assert.match(out[5], /^reload\(0,0x0100,0x0064,"d0\.p8"\)/);
  assert.match(out[6], /^reload\(0,0x0100,0x000a,"d0\.p8"\)/);
  assert.match(out[7], /^reload\(0,0x015a,0x000a,"d0\.p8"\)/);
  assert.match(out[8], /^reload\(0,0x0110,0x000a,"d0\.p8"\) --@data x\.bin\+0x10 -- slice$/);
  assert.strictEqual(out[9], 'local cs={"d1.p8", "d2.p8"}');
  assert.match(out[10], /^reload\(0,0x0000,0x4300,cs\[i\]\)/);
  const parts = [{ ref: 'x.bin', bytes: new Uint8Array(100), lz: false }];
  const chk = P.checkAnchors([{ name: 'fx.p8', text: [...bad, ...good.slice(0, 4)].join('\n') }], parts);
  assert.deepStrictEqual(chk.errors.map((e) => /^fx\.p8:(\d+) /.exec(e)?.[1]), ['1', '2', '3', '4', '5']);
  assert.deepStrictEqual(chk.warnings, []);
});

t('#34 adopt never re-anchors a malformed anchor line: it is reported and its cart stays', () => {
  const cart = (name, text = '') => ({ rom: new Uint8Array(0x4300).fill(1), lua: '', used: new Uint8Array(0x4300), reads: [], luaAt: 0, name, text });
  const fx = 'reload(0x8000,0,0x100,"atlas.p8") --@data x.bin+frame\nreload(0x9000,0,0x100,"other.p8")\n';
  const r = P.adopt(new Map([['fx.p8', cart('fx.p8', fx)], ['atlas.p8', cart('atlas.p8')], ['other.p8', cart('other.p8')]]));
  assert.deepStrictEqual(r.edits.map((e) => e.line), [2]);
  assert.deepStrictEqual(r.skipped.map((s) => [s.line, s.carts]), [[1, ['atlas.p8']]]);
  assert.match(r.skipped[0].why, /\+frame/);
  assert.deepStrictEqual(r.adoptedCarts, ['other.p8']);
  assert.deepStrictEqual(r.keptCarts, ['atlas.p8']);
  assert.strictEqual(P.renameInText(r.edits[0].after, /--@data (\w+)\./.exec(r.edits[0].after)[1], 'renamed'), 'reload(0x9000,0,0x100,"other.p8") --@data renamed.bin');
});

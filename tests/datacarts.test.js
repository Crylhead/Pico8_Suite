// #12: Cart Inspector read ranges: literal reads split over every region they cross, comments and
// strings ignored (shared Lua lexer), uncertain reads kept visible, "no read detected" wording.
const assert = require('assert');
const { t } = require('./harness.js');
const C = require('../js/cart-core.js');
const V = require('../js/datacarts-core.js');

const ROM = 0x4300;
const cart = (lua, fill = [[0, ROM]]) => {
  const rom = new Uint8Array(ROM);
  for (const [a, b] of fill) rom.fill(7, a, b);
  return { name: 'fx.p8', lua, luaAt: 0, rom, used: C.usedMask(rom), reads: [] };
};
const ranges = (own) => Object.fromEntries(C.REGIONS.filter((r) => own[r.id]).map((r) => [r.id, own[r.id].ranges.map((x) => [x.start, x.start + x.len])]));

t('#12 a literal memcpy is split over every region it crosses', () => {
  // Terrain Lab viewer: heights at 0x2000..0x3fff copied to 0x8000 (previously: map only)
  const own = V.ownReads(cart('memcpy(0x8000,0x2000,0x2000)\nfunction hget(x,y) return @(0x8000+(y<<7)+x) end'));
  assert.deepStrictEqual(ranges(own), { map: [[0x2000, 0x3000]], gff: [[0x3000, 0x3100]], music: [[0x3100, 0x3200]], sfx: [[0x3200, 0x4000]] });
  assert.ok(C.REGIONS.every((r) => !own[r.id] || !own[r.id].whole));
  const mask = V.ownMask(own);
  assert.strictEqual(mask.reduce((s, v) => s + v, 0), 0x2000);
  assert.ok(mask[0x2000] && mask[0x3fff] && !mask[0x1fff] && !mask[0x4000]);
  // read widths: peek2 / peek4 / %
  assert.deepStrictEqual(ranges(V.ownReads(cart('a=peek4(0x30fe) b=%0x1fff'))), { gfx: [[0x1fff, 0x2000]], map: [[0x2000, 0x2001]], gff: [[0x30fe, 0x3100]], music: [[0x3100, 0x3102]] });
});

t('#12 reads in comments and strings add nothing', () => {
  assert.deepStrictEqual(V.ownReads(cart('--[[\nsget(0,0)\n]]\nprint("@0x2000 mget(1,1)")')), {});
  assert.deepStrictEqual(V.ownReads(cart('--[==[ ]] sget(0,0) ]==] s=[=[ memcpy(0,0x2000,9) ]=]')), {});
  // the lexer keeps code after a closed long comment
  assert.ok(V.ownReads(cart('--[=[ x ]=] y=sget(0,0)')).gfx);
});

t('#12 approximations and uncertain reads stay visible', () => {
  const own = V.ownReads(cart('x=sget(1,2)\nv=peek(a+1)\nw=@(0x3200+i)\n#include lib.lua'));
  assert.ok(own.gfx.whole, 'sget approximates the whole sprite sheet');
  assert.ok(own.sfx.whole, 'literal base + computed offset marks the whole region');
  assert.ok(own.unresolved.some((u) => u.startsWith('peek(?) line 2')));
  assert.ok(own.unresolved.some((u) => u.startsWith('#include lib.lua line 4')));
  // sections: approximations are labelled, unread content says "no read detected"
  const c = cart('x=sget(1,2)\ny=@0x2000', [[0, ROM]]);
  c.reads = [{ from: 'other.p8', src: 0x3200, len: 0x100 }];
  const labels = V.sections(c, new Map()).map((s) => s.label);
  assert.ok(labels.some((l) => /sprite.*whole region \(approximation\)/i.test(l)), labels.join(' | '));
  assert.ok(labels.some((l) => /no read detected/.test(l)), labels.join(' | '));
});

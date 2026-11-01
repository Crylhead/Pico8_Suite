// Small regression entry point for review findings (P8S-010). Run: node tests/regress.js
// Focused regressions for later fixes live in tests/*.test.js and are loaded below.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t, run } = require('./harness.js');
const P = require('../js/project-core.js');
const A = require('../js/audit-core.js');

// P8S-002: a partial read at sub-offset zero keeps its own length
t('P8S-002 rewrite keeps partial length at +0x0', () => {
  const where = (ref) => (ref === 'd_atlas.bin' ? { off: 0x1000, len: 100, cart: 'd1.p8' } : null);
  const src = 'reload(0x8000,0,100,"atlas.p8") --@data d_atlas.bin\nreload(0x9000,0,50,"atlas.p8") --@data d_atlas.bin+0x0000\nreload(0x9100,10,20,"atlas.p8") --@data d_atlas.bin+0x000a';
  const out = P.rewriteAnchors(src, where).text.split('\n');
  assert.match(out[0], /reload\(0x8000,0x1000,0x0064,"d1\.p8"\)/);
  assert.match(out[1], /reload\(0x9000,0x1000,0x0032,"d1\.p8"\)/);
  assert.match(out[2], /reload\(0x9100,0x100a,0x0014,"d1\.p8"\)/);
});
t('P8S-002 bare anchor follows a resized part; ranged anchor is clamped', () => {
  const where = () => ({ off: 0, len: 40, cart: 'd1.p8' });
  const out = P.rewriteAnchors('reload(0,0,100,"a.p8") --@data x.bin\nreload(0,0,100,"a.p8") --@data x.bin+0', where).text.split('\n');
  assert.match(out[0], /0x0028/);
  assert.match(out[1], /0x0028/);
});
t('P8S-002 adopt -> rewrite keeps reads of 100 and 50 bytes distinct', () => {
  const mk = (name, text) => ({ rom: new Uint8Array(0x8000).fill(1), lua: '', used: new Uint8Array(0x8000), reads: [], luaAt: 0, name, text });
  const fx = 'reload(0x8000,0,100,"atlas.p8")\nreload(0x9000,0,50,"atlas.p8")\n';
  const r = P.adopt(new Map([['fx.p8', mk('fx.p8', fx)], ['atlas.p8', mk('atlas.p8', '')]]));
  const out = P.rewriteAnchors(r.edits.map((e) => e.after).join('\n'), () => ({ off: 0x2000, len: 100, cart: 'd1.p8' })).text.split('\n');
  assert.match(out[0], /0x2000,0x0064/);
  assert.match(out[1], /0x2000,0x0032/);
});

// P8S-008: repeated / diamond includes expand at every occurrence; real cycles stop
const files = (o) => A.makeFs(new Map(Object.entries(o)));
t('P8S-008 repeated include expands twice, no cycle warning', () => {
  const fs = files({ 'main.lua': '#include lib.lua\n#include lib.lua\n', 'lib.lua': 'x+=1\n' });
  const w = [];
  const r = A.expandIncludes(fs, 'main.lua', fs.read('main.lua'), new Set(['main.lua']), w);
  assert.strictEqual((r.text.match(/x\+=1/g) || []).length, 2);
  assert.ok(!w.some((m) => /cycle/.test(m)), w.join(';'));
});
t('P8S-008 diamond include expands both branches', () => {
  const fs = files({ 'm.lua': '#include a.lua\n#include b.lua\n', 'a.lua': '#include c.lua\n', 'b.lua': '#include c.lua\n', 'c.lua': 'y=1\n' });
  const w = [];
  const r = A.expandIncludes(fs, 'm.lua', fs.read('m.lua'), new Set(['m.lua']), w);
  assert.strictEqual((r.text.match(/y=1/g) || []).length, 2);
  assert.ok(!w.some((m) => /cycle/.test(m)));
});
t('P8S-008 self and indirect cycles still stop', () => {
  const fs = files({ 'm.lua': '#include a.lua\n', 'a.lua': '#include b.lua\n', 'b.lua': '#include a.lua\n' });
  const w = [];
  A.expandIncludes(fs, 'm.lua', fs.read('m.lua'), new Set(['m.lua']), w);
  assert.ok(w.some((m) => /cycle/.test(m)));
  const w2 = [];
  const fs2 = files({ 's.lua': '#include s.lua\n' });
  A.expandIncludes(fs2, 's.lua', fs2.read('s.lua'), new Set(['s.lua']), w2);
  assert.ok(w2.some((m) => /cycle/.test(m)));
});

for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
run();

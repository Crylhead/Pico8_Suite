// #64: side-panel width model and persistence (js/panels-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/panels-core.js');

const cfg = { min: 200, max: 560, def: 272, reserve: 62 };
const mem = (init) => { const d = new Map(init ? [[P.KEY, init]] : []); return { d, fail: false, getItem(k) { if (this.fail) throw new Error('denied'); return d.has(k) ? d.get(k) : null; }, setItem(k, v) { if (this.fail) throw new Error('quota'); d.set(k, v); } }; };

t('#64 bounds keep both the panel and the canvas usable', () => {
  assert.deepStrictEqual(P.bounds(cfg, 1600), [200, 560]);
  assert.deepStrictEqual(P.bounds(cfg, 800), [200, 800 - 62 - P.MIN_CENTER]);
  assert.deepStrictEqual(P.bounds(cfg, 500), [200, 200]); // never below the minimum, never inverted
  assert.strictEqual(P.clamp(cfg, 1600, 50), 200);
  assert.strictEqual(P.clamp(cfg, 1600, 9999), 560);
  assert.strictEqual(P.clamp(cfg, 1600, 'x'), 272);
  assert.strictEqual(P.clamp(cfg, 800, 560), 418);
});

t('#64 keyboard: arrows resize (Left widens), Shift steps further, Home/End/0 jump, other keys ignored', () => {
  assert.strictEqual(P.keyWidth(cfg, 1600, 272, 'ArrowLeft', false), 288);
  assert.strictEqual(P.keyWidth(cfg, 1600, 272, 'ArrowRight', true), 208);
  assert.strictEqual(P.keyWidth(cfg, 1600, 210, 'ArrowRight', true), 200);
  assert.strictEqual(P.keyWidth(cfg, 1600, 300, 'Home', false), 200);
  assert.strictEqual(P.keyWidth(cfg, 1600, 300, 'End', false), 560);
  assert.strictEqual(P.keyWidth(cfg, 1600, 400, '0', false), 272);
  assert.strictEqual(P.keyWidth(cfg, 1600, 400, 'a', false), null);
});

t('#64 persistence round-trips width and collapsed state per panel', () => {
  const st = mem();
  const a = P.createStore(st);
  a.set('studio', { w: 320 });
  a.set('map', { c: true });
  const b = P.createStore(st);
  assert.deepStrictEqual(b.get('studio'), { w: 320, c: false });
  assert.deepStrictEqual(b.get('map'), { w: null, c: true });
  b.reset('studio');
  assert.strictEqual(P.createStore(st).get('studio').w, null);
  assert.strictEqual(P.createStore(st).get('map').c, true);
  b.reset();
  assert.strictEqual(P.createStore(st).get('map').c, false);
});

t('#64 corrupt stored layouts recover to defaults; bad fields are ignored one by one', () => {
  for (const bad of ['{not json', 'null', '[]', '{"panels":5}', '']) assert.deepStrictEqual(P.createStore(mem(bad)).get('x'), { w: null, c: false });
  const s = P.createStore(mem(JSON.stringify({ v: 1, panels: { studio: { w: 'wide', c: 'yes' }, map: { w: 300 } } })));
  assert.deepStrictEqual(s.get('studio'), { w: null, c: false });
  assert.strictEqual(s.get('map').w, 300);
  assert.strictEqual(P.clamp(cfg, 1600, s.get('studio').w ?? NaN), 272); // a null width falls back to the default
});

t('#64 unavailable storage never throws and the layout still works for the page', () => {
  const st = mem();
  st.fail = true;
  const s = P.createStore(st);
  assert.doesNotThrow(() => s.set('studio', { w: 300 }));
  assert.strictEqual(s.get('studio').w, 300);
  assert.strictEqual(s.persistent(), false);
  assert.doesNotThrow(() => P.createStore(null).set('a', { w: 1 }));
});


t('#170 border-box gutters are excluded before reserving the 320px center track', () => {
  const grid = { min: 200, max: 560, def: 272, reserve: 52 + 20 };
  for (const width of [846, 886]) {
    const content = P.contentWidth(width, { paddingLeft: '16px', paddingRight: '16px' });
    const side = P.clamp(grid, content, 560);
    assert.strictEqual(content - grid.reserve - side, 320);
  }
  assert.strictEqual(P.contentWidth(846.5, { paddingLeft: '24px', paddingRight: '24px', borderLeftWidth: '1px', borderRightWidth: '1px' }), 796.5);
  assert.strictEqual(P.contentWidth(20, { paddingLeft: '16px', paddingRight: '16px' }), 0);
  assert.strictEqual(P.contentWidth(500, { paddingLeft: 'auto' }), 500);
});

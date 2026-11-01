// Terrain Lab regressions (#9 history resources). Run: node tests/regress.js
const { t } = require('./harness.js');
const assert = require('assert');
const T = require('../js/terrain-core.js');

const Hs = T.history;
const bitmap = (v, n = 4) => ({ w: n, h: 1, data: new Uint8Array(n).fill(v) });
const tile = (v, size = 4) => ({ size, data: new Float32Array(size * size).fill(v) });
const state = () => ({
  params: { seed: 1, importId: null, importMix: 1 }, stamps: [], passes: [], strokeStarts: [], preset: 'custom', weather: { style: 'mixed', amount: 0.6 },
  bitmaps: {}, imports: {}, importSrc: null,
});
// the UI's undo / redo / import / retile, reduced to their store changes (new objects, never edited in place)
const session = () => {
  const st = state(), undo = [], redo = [];
  const push = (withParams = false) => { undo.push(Hs.snapshot(st, withParams)); redo.length = 0; Hs.trim(undo, redo); };
  const back = () => { const s = undo.pop(); redo.push(Hs.snapshot(st, !!s.params)); Hs.restore(st, s); };
  const fwd = () => { const s = redo.pop(); undo.push(Hs.snapshot(st, !!s.params)); Hs.restore(st, s); };
  let n = 0;
  const retile = (patch = null) => { const s = patch ? { ...st.importSrc, ...patch } : st.importSrc, id = `h${++n}`; st.imports = { [id]: tile(s.grey[0] + s.blend) }; st.importSrc = s; st.params.importId = id; };
  const importMap = (name, v) => { push(); st.importSrc = { w: 2, h: 2, grey: new Float32Array(4).fill(v), name, method: st.importSrc?.method || 'blend', blend: st.importSrc?.blend ?? 0.25 }; retile(); };
  return { st, undo, redo, push, back, fwd, retile, importMap };
};

t('Terrain #9 undo after a scene load restores the replaced bitmaps, import and source', () => {
  const { st, undo, push, back } = session();
  const bm = bitmap(7), src = { w: 2, h: 2, grey: new Float32Array(4), name: 'A.png', method: 'edges', blend: 0.1 };
  Object.assign(st, { bitmaps: { b1: bm }, imports: { hA: tile(0.5) }, importSrc: src, stamps: [{ id: 1, tool: 'bitmap', bmp: 'b1', x: 0.5, y: 0.5 }] });
  st.params.importId = 'hA';
  push(true);
  // loadScene replaces every store; the session GC then prunes bitmaps no current stamp uses
  Object.assign(st, { bitmaps: { b2: bitmap(1) }, imports: {}, importSrc: null, stamps: [{ id: 2, tool: 'bitmap', bmp: 'b2', x: 0, y: 0 }] });
  st.params = { seed: 2, importId: null, importMix: 1 };
  const live = Hs.liveBitmapIds(st.stamps);
  for (const id of Object.keys(st.bitmaps)) if (!live.has(id)) delete st.bitmaps[id];
  assert.ok(!('b1' in st.bitmaps));
  back();
  assert.strictEqual(undo.length, 0);
  assert.strictEqual(st.params.seed, 1);
  assert.strictEqual(st.bitmaps.b1, bm, 'bitmap data of the undone stamps is back');
  assert.strictEqual(st.params.importId, 'hA');
  assert.strictEqual(st.imports.hA.data[0], 0.5, 'import data is back');
  assert.strictEqual(st.importSrc, src, 'import source and seam settings are back');
});

t('Terrain #9 import A then B: undo / redo switch source, tile and seams; seam edits keep older history', () => {
  const { st, undo, redo, push, back, fwd, retile, importMap } = session();
  importMap('A', 0.1);
  retile({ method: 'edges' }); // seam edit: not undoable itself, makes a new tile and source
  const tileA = st.imports[st.params.importId];
  push(); st.stamps = [{ id: 1, tool: 'raise', x: 0, y: 0, r: 0.1 }]; // an edit on the A' state
  importMap('B', 0.6);
  retile({ blend: 0.4 });
  assert.strictEqual(st.importSrc.name, 'B');
  back(); // undo import B
  assert.strictEqual(st.importSrc.name, 'A');
  assert.strictEqual(st.importSrc.method, 'edges');
  assert.strictEqual(st.importSrc.blend, 0.25);
  assert.strictEqual(st.imports[st.params.importId], tileA);
  fwd(); // redo import B, including its later seam edit
  assert.strictEqual(st.importSrc.name, 'B');
  assert.strictEqual(st.importSrc.blend, 0.4);
  assert.ok(Math.abs(st.imports[st.params.importId].data[0] - 1.0) < 1e-6);
  back(); back(); // the stroke, then import A
  assert.strictEqual(st.importSrc.name, 'A');
  assert.strictEqual(st.stamps.length, 0);
  assert.strictEqual(st.imports[st.params.importId], tileA, 'the seam edit did not invalidate the stroke snapshot');
  back();
  assert.strictEqual(st.params.importId, null);
  assert.strictEqual(st.importSrc, null);
  assert.strictEqual(undo.length, 0);
  assert.strictEqual(redo.length, 3);
});

t('Terrain #9 history drops the oldest snapshots over the memory budget, never the newer ones', () => {
  const big = (v) => ({ size: 256, data: new Float32Array(256 * 256).fill(v) }); // 256 KB each
  const snaps = [0, 1, 2, 3].map((i) => ({ imports: { [`h${i}`]: big(i) }, importSrc: null, bitmaps: {} }));
  const shared = { b: bitmap(1, 1024) };
  snaps.forEach((s) => { s.bitmaps = shared; });
  assert.strictEqual(Hs.retainedBytes(snaps), 4 * 262144 + 1024, 'shared resources count once');
  const undo = snaps.slice(), redo = [];
  Hs.trim(undo, redo, { budget: 2 * 262144 + 1024 });
  assert.deepStrictEqual(undo.map((s) => Object.keys(s.imports)[0]), ['h2', 'h3']);
  const many = Array.from({ length: 120 }, () => ({ bitmaps: {} }));
  Hs.trim(many, []);
  assert.strictEqual(many.length, Hs.MAX_ENTRIES);
});

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

// #8: the PICO-8 output recipe of scene files
const Sc = T.scene;
const reopen = (scene) => JSON.parse(JSON.stringify(scene)); // a scene file read back in a fresh session

t('Terrain #8 older scenes load the default output recipe, never the current one; undo brings it back', () => {
  const st = { ...state(), pico: { ...Sc.PICO_DEFAULTS, colors: 'libimg', palColors: [0, 1, 2, 3], palName: 'B', shade: 'fades', dither: 'diffuse', depth: 0.2 } };
  const before = st.pico;
  for (const old of [{ format: 'terrain-lab-scene', params: {}, stamps: [] }, { format: 'terrain-lab-scene', version: 3, params: {}, stamps: [], pico: before }]) {
    assert.deepStrictEqual(Sc.decodePico(reopen(old)), { ...Sc.PICO_DEFAULTS });
  }
  const s = Hs.snapshot(st, true, true); // what loadScene pushes
  st.pico = Sc.decodePico({ version: 3 });
  assert.strictEqual(Hs.restore(st, s).pico, true);
  assert.deepStrictEqual(st.pico, before);
});

t('Terrain #8 a live palette with fades saves as an identified snapshot and reopens to the same pixels', () => {
  const fades = { dark: { tables: [[...Array(16).keys()], Array.from({ length: 16 }, (_, i) => Math.max(0, i - 1)), Array(16).fill(0)] }, bright: null };
  const live = { palette: { pal: [0, 129, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], fades, name: 'dusk' } };
  const sources = (map) => ({ get: (id) => map[id] || null, label: (id) => ({ palette: 'Palette & Fades', studio: 'Pixel Studio' })[id] });
  const pico = { ...Sc.PICO_DEFAULTS, colors: 'src:palette', shade: 'fades', depth: 0.6, lift: 0.3, dither: 'none' };
  const m = 8, albedo = new Float32Array(m * m * 3), lit = new Float32Array(m * m * 3);
  for (let i = 0; i < albedo.length; i++) { albedo[i] = (i * 29) % 256; lit[i] = albedo[i] * (0.3 + ((i / 3) % m) / m); }
  const rgb = (c) => [(c * 37) & 255, (c * 91) & 255, (c * 53) & 255];
  const render = (p, src) => { const r = Sc.resolveFixed(p, src); return T.fadeShade(albedo, lit, m, r.pal.map(rgb), r.fades, { depth: p.depth, lift: p.lift, dither: p.dither !== 'none' }); };
  const saved = render(pico, sources(live));
  const file = reopen({ version: Sc.VERSION, pico: Sc.encodePico(pico, Sc.resolveFixed(pico, sources(live))) });
  assert.strictEqual(file.pico.palette.external, true);
  assert.strictEqual(file.pico.palette.link, 'src:palette');
  // fresh session: Palette & Fades now has another palette open, or nothing at all
  const other = { palette: { pal: [...Array(16).keys()].reverse(), fades: { dark: { tables: [Array(16).fill(5)] }, bright: null }, name: 'other' } };
  const loaded = Sc.decodePico(file);
  assert.strictEqual(loaded.colors, 'frozen');
  assert.strictEqual(loaded.link, 'src:palette');
  assert.deepStrictEqual(loaded.palColors, live.palette.pal, 'palette slots keep their order');
  for (const now of [other, {}]) {
    assert.deepStrictEqual(render(loaded, sources(now)), saved);
    assert.match(Sc.resolveFixed(loaded, sources(now)).note, /Palette & Fades \(live\)/);
  }
  assert.notDeepStrictEqual(render(pico, sources(other)), saved, 'the live mode itself would have changed');
  // a self-contained library palette stays a library palette; auto modes keep only their settings
  const lib = { ...Sc.PICO_DEFAULTS, colors: 'library', palColors: [1, 2, 3, 4], palName: 'four', dither: 'diffuse', strength: 0.7 };
  const libBack = Sc.decodePico(reopen({ version: 4, pico: Sc.encodePico(lib, Sc.resolveFixed(lib, sources({}))) }));
  assert.deepStrictEqual(libBack, { ...lib });
  const auto = Sc.decodePico(reopen({ version: 4, pico: Sc.encodePico({ ...Sc.PICO_DEFAULTS, colors: 'auto8', shade: 'fades' }, null) }));
  assert.deepStrictEqual(auto, { ...Sc.PICO_DEFAULTS, colors: 'auto8', shade: 'fades' });
});

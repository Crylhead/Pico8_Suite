// #81: Tile Maker → Map Editor goes through the guarded Send to. Runs the actual functions from
// js/tiles.js (sendToMapEditor), js/map.js (openAsset, loadMap, the 'map-open' consumer and the public
// P8MapEditor entry) and js/suite.js (openIn) with the real transfer, tiles, map and doc-status cores.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t } = require('./harness.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/** Source of `function name(...) {...}` (optionally async), found by balanced braces. */
function fn(src, name) {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
  assert.ok(m, `function ${name} not found`);
  // the body starts at the first ") {" (parameters may destructure with braces of their own)
  const body = /\)\s*\{/g; body.lastIndex = m.index;
  let i = body.exec(src).index; let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}
/** One source line that starts with `prefix` (after indentation). */
const line = (src, prefix, { optional = false } = {}) => {
  const l = src.split('\n').find((x) => x.trim().startsWith(prefix));
  assert.ok(l || optional, `line ${prefix} not found`);
  return l || '';
};
// values from the VM realm have their own Array.prototype: compare them as JSON
const same = (actual, expected, msg) => assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg);

function setup() {
  const ctx = vm.createContext({});
  for (const f of ['js/core.js', 'js/transfer-core.js', 'js/tiles-core.js', 'js/map-core.js', 'js/doc-status-core.js']) vm.runInContext(read(f), ctx, { filename: f });
  const map = read('js/map.js'); const tiles = read('js/tiles.js'); const suite = read('js/suite.js');
  vm.runInContext(`
    const log = { prompts: [], toasts: [], messages: [], workspace: [] };
    let answer = false;
    const window = {};
    const consumers = [];
    const App = { setWorkspace: (w) => log.workspace.push(w) };
    const confirmDialog = async (title, message, yes, no) => { log.prompts.push({ title, yes, no }); return answer; };
    const toast = (m) => log.toasts.push(m);
    const showMessage = (title, m) => log.messages.push(\`\${title}: \${m}\`);
    const closeLibrary = () => {};
    ${fn(suite, 'openIn')}
    const S = { normPal: (p) => (p ? Array.from(p) : Array.from({ length: 16 }, (_, i) => i)), openIn, registerConsumer: (c) => consumers.push(c) };

    // Map Editor state and the real functions that replace it
    const M = P8Map;
    const status = P8DocStatus.create();
    const me = { map: null, name: '', assetId: null, libBase: null, libSeen: null, sel: null, undo: [], redo: [], sheet: null, pal: null, sheetId: null, sheetName: '' };
    const buildSheetCanvas = () => {}; const rebuildMapCanvas = () => {}; const zoomFit = () => {}; const renderAll = () => {}; const scheduleSave = () => {};
    const importCartText = async () => {};
    ${fn(map, 'loadMap')}
    ${fn(map, 'openAsset')}
    ${line(map, 'const mapUnsaved =')}
    ${line(map, "S.registerConsumer({ id: 'map-open'")}
    ${line(map, 'const openAssetGuarded =', { optional: true })}
    ${line(map, 'window.P8MapEditor =')}

    // Tile Maker
    const T = P8Tiles;
    const tm = { name: 'level', result: null };
    const requireResult = () => Boolean(tm.result);
    const exportPalette = () => ({ rgb: T.PICO8_STD_RGB, picos: null });
    ${fn(tiles, 'sendToMapEditor')}
    this.env = { log, me, status, tm, T, sendToMapEditor, openAsset, setAnswer: (v) => { answer = v; } };
  `, ctx, { filename: 'tiles-to-map-glue.js' });
  return ctx.env;
}

const solid = (T, c) => { const rgb = T.PICO8_STD_RGB[c]; const px = new Uint8Array(64 * 3); for (let i = 0; i < 64; i++) px.set(rgb, i * 3); return px; };

/** Map Editor with a library map that has an unsaved edit and one undo entry. */
function dirtyMap(env) {
  env.openAsset({ kind: 'map', id: 'lib-1', modified: 1, name: 'my map', w: 1, h: 1, cells: [5], sheet: new Uint8Array(128 * 128).fill(9), pal: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] });
  env.me.map.cells[0] = 99;
  env.me.undo.push('paint');
  env.status.edit();
  assert.ok(env.status.dirty());
  return { sheet: env.me.sheet, pal: env.me.pal };
}

const result = (env, n = 2) => { env.tm.result = { tiles: Array.from({ length: n }, (_, i) => solid(env.T, 8 + (i % 4))), map: [0, 1], mapW: 2, mapH: 1 }; };

t('#81 Tile Maker → Map Editor: an unsaved map prompts Replace / Cancel; Cancel changes nothing', async () => {
  const env = setup();
  const before = dirtyMap(env);
  result(env);
  env.log.workspace.length = 0;
  env.setAnswer(false);
  await env.sendToMapEditor();
  same(env.log.prompts, [{ title: 'Replace unsaved work?', yes: 'Replace', no: 'Cancel' }]);
  assert.strictEqual(env.me.map.cells[0], 99);
  assert.strictEqual(env.me.name, 'my map');
  assert.strictEqual(env.me.assetId, 'lib-1');
  same(env.me.undo, ['paint']);
  assert.strictEqual(env.me.sheet, before.sheet);
  assert.strictEqual(env.me.pal, before.pal);
  assert.ok(env.status.dirty());
  same(env.log.workspace, [], 'no switch to the Map Editor on cancel');
  assert.ok(env.tm.result, 'the Tile Maker result is kept');
  assert.ok(env.log.toasts.length === 1 && /^Cancelled\./.test(env.log.toasts[0]), env.log.toasts.join(' | '));
});

t('#81 Replace and a clean destination open the Tile Maker map with tile-0 shift; it stays unsaved', async () => {
  for (const dirty of [true, false]) {
    const env = setup();
    if (dirty) dirtyMap(env);
    result(env);
    env.setAnswer(true);
    await env.sendToMapEditor();
    assert.strictEqual(env.log.prompts.length, dirty ? 1 : 0, `prompts (dirty=${dirty})`);
    assert.deepStrictEqual(Array.from(env.me.map.cells), [1, 2], 'cells shifted past the empty sprite 0');
    assert.strictEqual(env.me.name, 'level');
    assert.strictEqual(env.me.assetId, null);
    same(env.me.undo, []);
    assert.ok(env.me.sheet.slice(0, 8).every((v) => v === 0), 'sprite 0 stays empty');
    assert.strictEqual(env.me.sheet[8], 8, 'first tile at sprite 1 (red)');
    assert.strictEqual(env.me.sheetName, 'level (Tile Maker)');
    assert.ok(env.status.dirty(), 'incoming map is unsaved');
    assert.ok(env.log.toasts.some((m) => /temporary copy of “level” to Map Editor/.test(m)), env.log.toasts.join(' | '));
    assert.ok(env.log.toasts.some((m) => /2×1 map with 2 tiles at sprites 1–2/.test(m)));
  }
});

t('#81 more than 256 tiles or an oversized map is refused without prompt or mutation', async () => {
  const env = setup();
  dirtyMap(env);
  env.tm.result = { tiles: Array.from({ length: 257 }, () => solid(env.T, 1)), map: [0], mapW: 1, mapH: 1 };
  await env.sendToMapEditor();
  env.tm.result = { tiles: [solid(env.T, 1)], map: new Array(300).fill(0), mapW: 300, mapH: 1 };
  await env.sendToMapEditor();
  assert.strictEqual(env.log.prompts.length, 0);
  assert.strictEqual(env.log.messages.length, 2);
  assert.match(env.log.messages[0], /^Too Many Tiles/);
  assert.match(env.log.messages[1], /^Map Too Large/);
  assert.strictEqual(env.me.map.cells[0], 99);
  same(env.me.undo, ['paint']);
});

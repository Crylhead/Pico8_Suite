// #84: Tile Maker changes nothing (shared palette/fades, color mode, settings, content) until an import that
// replaces dirty work is accepted. Runs the actual importAsset, importImageData, persistSettings and the
// 'tiles-import' consumer from js/tiles.js through the real P8Transfer.send, with the real tiles core.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn, line, same } = require('./source-extract.js');

/** the real `S.registerConsumer({ id: 'tiles-import', ... });` block of js/tiles.js */
function consumerBlock(src) {
  const start = src.indexOf("S.registerConsumer({\n    id: 'tiles-import'") >= 0 ? src.indexOf("S.registerConsumer({\n    id: 'tiles-import'") : src.indexOf("S.registerConsumer({\r\n    id: 'tiles-import'");
  assert.ok(start >= 0, 'tiles-import consumer not found');
  return src.slice(start, src.indexOf('});', start) + 3);
}

function setup() {
  const ctx = vm.createContext({});
  for (const f of ['js/core.js', 'js/tiles-core.js', 'js/transfer-core.js']) vm.runInContext(read(f), ctx, { filename: f });
  const tiles = read('js/tiles.js');
  vm.runInContext(`
    const T = P8Tiles;
    const log = { prompts: [], settingsWrites: [], workspace: [], rebuilds: 0, messages: [] };
    let answer = false;
    // the shared Palette & Fades state that App.adoptImagePalette replaces
    const shared = { custom: [0, 1, 2], fades: { dark: 'mine' } };
    const consumers = [];
    // fires the p8:palette listener the way js/tiles.js:1269 does
    const paletteListener = () => { if (tm.result && usesCustomPalette()) tm.stale = true; };
    const App = {
      setWorkspace: (w) => log.workspace.push(w),
      adoptImagePalette: (pal, f) => { shared.custom = Array.from(pal); shared.fades = f; paletteListener(); },
    };
    const S = {
      hasOwnPalette: (a) => Array.isArray(a.pal),
      assetImageData: (a) => { if (a.broken) throw new Error('unsupported image data'); return { width: a.w, height: a.h, data: new Uint8ClampedArray(a.w * a.h * 4) }; },
      registerConsumer: (c) => consumers.push(c),
    };
    const KEYS = { settings: 'tiles-settings' };
    const store = { set: (k, v) => log.settingsWrites.push(JSON.parse(JSON.stringify(v))) };
    const confirmDialog = async (title) => { log.prompts.push(title); return answer; };
    const showMessage = (title, m) => log.messages.push(title + ': ' + m);
    const invalidate = () => {}; const renderAll = () => {}; const requestAnimationFrame = () => {}; const zoomFit = () => {};
    const rebuild = async () => { log.rebuilds++; tm.result = { tiles: [], built: tm.name }; tm.stale = false; };
    const tm = { name: 'old work', original: { w: 8, h: 8, rgb: 'old' }, result: { tiles: [1], built: 'old work' }, dirty: true, stale: false,
      colorMode: 'pico8', dither: 'none', mapping: 'ramp', threshold: 0, vpW: 16, vpH: 16, vp: null, modified: true, selected: 3 };
    ${line(tiles, 'const usesCustomPalette =')}
    ${fn(tiles, 'persistSettings')}
    ${fn(tiles, 'importImageData')}
    ${fn(tiles, 'importAsset')}
    ${consumerBlock(tiles)}
    const snapshot = () => JSON.parse(JSON.stringify({ shared, tm, settingsWrites: log.settingsWrites.length }));
    this.env = { log, tm, shared, consumers, snapshot, setAnswer: (v) => { answer = v; }, send: (a) => P8Transfer.send(consumers[0], a, { confirm: async () => true }) };
  `, ctx, { filename: 'tiles-import-glue.js' });
  return ctx.env;
}

const ownPal = () => ({ kind: 'image', name: 'incoming', w: 8, h: 8, pal: [3, 4, 5], meta: { fades: { dark: 'theirs' } } });

t('#84 dirty Tile Maker + Cancel: palette, fades, mode, content, flags, settings and name are all preserved', async () => {
  const env = setup();
  assert.strictEqual(env.consumers[0].id, 'tiles-import', 'the real Tile Maker consumer');
  const before = env.snapshot();
  env.setAnswer(false);
  const r = await env.send(ownPal());
  assert.strictEqual(r.status, 'cancelled');
  same(env.log.prompts, ['Import Image']);
  assert.deepStrictEqual(env.snapshot(), before, 'nothing changed: shared palette/fades, tm (original, result, mode, dirty, stale, name), settings writes');
  assert.strictEqual(env.log.workspace.length, 0);
  assert.strictEqual(env.log.rebuilds, 0);
});

t('#84 accepted own-palette import adopts palette and fades once, without marking the new result stale', async () => {
  const env = setup();
  env.setAnswer(true);
  const r = await env.send(ownPal());
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(env.log.prompts.length, 1, 'one prompt');
  same(env.shared.custom, [3, 4, 5]);
  same(env.shared.fades, { dark: 'theirs' });
  assert.strictEqual(env.tm.colorMode, 'nearest');
  assert.strictEqual(env.log.settingsWrites.length, 1);
  assert.strictEqual(env.log.settingsWrites[0].colorMode, 'nearest');
  assert.strictEqual(env.tm.name, 'incoming');
  assert.strictEqual(env.tm.stale, false, 'the palette change did not mark the result being replaced');
  assert.strictEqual(env.log.rebuilds, 1);
});

t('#84 no-palette import keeps the shared palette; a clean Tile Maker does not ask', async () => {
  const env = setup();
  env.tm.dirty = false;
  const r = await env.send({ kind: 'image', name: 'plain', w: 8, h: 8 });
  assert.strictEqual(r.status, 'done');
  assert.strictEqual(env.log.prompts.length, 0);
  same(env.shared.custom, [0, 1, 2]);
  assert.strictEqual(env.tm.colorMode, 'pico8');
  assert.strictEqual(env.log.settingsWrites.length, 0);
  assert.strictEqual(env.tm.name, 'plain');
});

t('#84 a conversion failure before replacement fails truthfully and leaves the old project', async () => {
  const env = setup();
  env.setAnswer(true);
  const before = env.snapshot();
  const r = await env.send({ ...ownPal(), broken: true });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.message, /could not open “incoming”: unsupported image data\. Nothing was changed\./);
  assert.deepStrictEqual(env.snapshot(), before);
});

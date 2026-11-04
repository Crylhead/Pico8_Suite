// #186: Tile Maker's "Match source colors" switches to nearest color and rebuilds in one step; a
// cancelled or failed rebuild leaves the mode as it was. Runs the actual matchSourceColors from
// js/tiles.js with a controllable fake rebuild.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');

function setup({ custom = [0, 7, 8], original = {}, colorMode = 'pico8', rebuildSucceeds = true } = {}) {
  const ctx = vm.createContext({ custom, original, colorMode, rebuildSucceeds });
  vm.runInContext(`
    const App = { state: { custom: custom.concat(Array(16 - custom.length).fill(null)) } };
    const tm = { original, colorMode, pending: true, result: { colorMode } };
    const log = { rebuilds: [], persisted: 0, rendered: 0 };
    const customHasColors = () => App.state.custom.some((p) => p != null);
    const invalidate = () => {};
    const persistSettings = () => { log.persisted++; };
    const renderControls = () => { log.rendered++; };
    // the real rebuild records the mode it converted with, or returns without a new result
    async function rebuild() {
      log.rebuilds.push(tm.colorMode);
      if (rebuildSucceeds) { tm.result = { colorMode: tm.colorMode }; tm.pending = false; }
    }
    ${fn(read('js/tiles.js'), 'matchSourceColors')}
  `, ctx);
  return ctx;
}
const run = (ctx, src) => vm.runInContext(src, ctx);

t('#186 Match source colors rebuilds once with nearest color and keeps the palette and image', async () => {
  const ctx = setup();
  await run(ctx, 'matchSourceColors()');
  assert.strictEqual(run(ctx, 'JSON.stringify(log.rebuilds)'), '["nearest"]');
  assert.strictEqual(run(ctx, 'tm.colorMode + "|" + tm.result.colorMode + "|" + tm.pending'), 'nearest|nearest|false');
  assert.strictEqual(run(ctx, 'tm.original === original && App.state.custom.slice(0, 3).join()'), '0,7,8');
  assert.ok(run(ctx, 'log.persisted >= 1 && log.rendered >= 1'), 'the new mode is saved and shown');
});

t('#186 an unbuilt nearest selection still rebuilds: the button follows the shown result', async () => {
  const ctx = setup();
  run(ctx, "tm.colorMode = 'nearest'");
  await run(ctx, 'matchSourceColors()');
  assert.strictEqual(run(ctx, 'JSON.stringify(log.rebuilds) + "|" + tm.result.colorMode'), '["nearest"]|nearest');
});

t('#186 a cancelled or failed rebuild restores the previous mode and pending state', async () => {
  const ctx = setup({ colorMode: 'levels', rebuildSucceeds: false });
  await run(ctx, 'matchSourceColors()');
  assert.strictEqual(run(ctx, 'JSON.stringify(log.rebuilds)'), '["nearest"]', 'the rebuild was attempted with nearest');
  assert.strictEqual(run(ctx, 'tm.colorMode + "|" + tm.pending + "|" + tm.result.colorMode'), 'levels|true|levels');
});

t('#186 Match source colors does nothing without an image, with an empty custom palette or in nearest mode', async () => {
  for (const opts of [{ original: null }, { custom: [] }, { colorMode: 'nearest' }]) {
    const ctx = setup(opts);
    await run(ctx, 'matchSourceColors()');
    assert.strictEqual(run(ctx, 'log.rebuilds.length + "|" + tm.colorMode'), `0|${opts.colorMode || 'pico8'}`, JSON.stringify(opts));
  }
});

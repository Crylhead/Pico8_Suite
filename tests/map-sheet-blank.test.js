// #184: a tileset counts as blank when every pixel has the same palette slot, so the Map Editor
// shows view-only placeholders. Tests the shared helper in js/map-core.js.
const assert = require('assert');
const { t } = require('./harness.js');
const M = require('../js/map-core.js');

t('#184 isSheetBlank: the default all-black sheet and any single-color sheet are blank', () => {
  assert.strictEqual(M.isSheetBlank(new Uint8Array(M.SHEET * 128)), true, 'new map default');
  assert.strictEqual(M.isSheetBlank(new Uint8Array(M.SHEET * 128).fill(7)), true, 'all white');
  assert.strictEqual(M.isSheetBlank(new Uint8Array(M.SHEET * 64).fill(12)), true, 'half-height sheet');
  assert.strictEqual(M.isSheetBlank(new Uint8Array(0)), true, 'no pixels');
});

t('#184 isSheetBlank: one differing pixel anywhere makes the sheet usable', () => {
  for (const i of [0, 1, M.SHEET * 8 + 3, M.SHEET * 128 - 1]) {
    const px = new Uint8Array(M.SHEET * 128);
    px[i] = 1;
    assert.strictEqual(M.isSheetBlank(px), false, `pixel ${i}`);
  }
});

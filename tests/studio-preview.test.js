// #102: Fit follows the viewport; fixed scales must never silently shrink.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');
const K = require('../js/studio-core.js');
const studio = read('js/studio.js');

t('#102 preview: true 1x/2x for sheets, sprites and whole maps', () => {
  for (const [w, h] of [[64, 64], [128, 128], [256, 256], [128, 256], [1024, 512]]) {
    for (const mode of [1, 2]) {
      assert.deepStrictEqual(K.previewSize(w, h, mode, 176, 176), { w: w * mode, h: h * mode, scale: mode });
    }
  }
});

t('#102 preview: Fit uses both viewport dimensions and integer enlargement', () => {
  assert.deepStrictEqual(K.previewSize(64, 64, 0, 210, 192), { w: 192, h: 192, scale: 3 });
  assert.deepStrictEqual(K.previewSize(128, 128, 0, 210, 192), { w: 128, h: 128, scale: 1 });
  assert.deepStrictEqual(K.previewSize(128, 256, 0, 210, 192), { w: 96, h: 192, scale: 0.75 });
  assert.deepStrictEqual(K.previewSize(1024, 512, 0, 210, 192), { w: 210, h: 105, scale: 210 / 1024 });
  // Sidebar resize / narrow width; no dependency on the former fixed 176px box.
  assert.deepStrictEqual(K.previewSize(256, 256, 0, 160, 192), { w: 160, h: 160, scale: 0.625 });
  assert.deepStrictEqual(K.previewSize(256, 256, 0, 400, 300), { w: 256, h: 256, scale: 1 });
  assert.strictEqual(K.previewSize(128, 128, 0, 0, 0), null);
  // Rounding stays inside Fit's bounds for non-square, single-pixel and maximum images.
  for (const [w, h] of [[123, 257], [1, 1], [1024, 1024]]) {
    const size = K.previewSize(w, h, 0, 213, 192);
    assert.ok(size.w <= 213 && size.h <= 192);
    assert.ok(Math.abs(size.w - w * size.scale) < 1 && Math.abs(size.h - h * size.scale) < 1);
  }
});

t('#102 preview: actual draw adapter uses current composite, dimensions and effective smoothing', () => {
  const calls = [];
  const g = {
    fillRect: (...args) => calls.push(['background', g.fillStyle, ...args]),
    drawImage: (...args) => calls.push(['image', ...args]),
  };
  const ps = { doc: K.newDoc(256, 256), previewScale: 2 };
  const dom = { preview: { getContext: () => g }, previewBox: { clientWidth: 210, clientHeight: 192 }, previewZoom: {} };
  const comp = {}; // The existing renderer supplies the current visible layers/frame here.
  const ctx = vm.createContext({ K, ps, dom, comp, rgbCache: ['0,0,0', '255,0,0'] });
  vm.runInContext(fn(studio, 'drawPreview'), ctx);
  ctx.drawPreview();
  assert.deepStrictEqual([dom.preview.width, dom.preview.height], [512, 512]);
  assert.strictEqual(g.imageSmoothingEnabled, false);
  assert.strictEqual(dom.previewZoom.textContent, '200% · 512×512 px');
  assert.deepStrictEqual(calls.pop(), ['image', comp, 0, 0, 512, 512]);

  ps.previewScale = 0; // legacy stored Auto value is now Fit
  ps.doc.transparent = 1;
  ctx.drawPreview();
  assert.deepStrictEqual([dom.preview.width, dom.preview.height], [192, 192]);
  assert.strictEqual(g.imageSmoothingEnabled, true);
  assert.strictEqual(dom.previewZoom.textContent, '75% · 192×192 px');
  assert.deepStrictEqual(calls.at(-2), ['background', 'rgb(255,0,0)', 0, 0, 192, 192]);
  dom.previewBox.clientWidth = 160;
  ctx.drawPreview();
  assert.strictEqual(dom.preview.width, 160);
  assert.strictEqual(dom.previewZoom.textContent, '62.5% · 160×160 px');
  assert.strictEqual(ps.doc.w, 256); // preview never resizes the document
});

t('#102 preview: scrolling keys retain their browser default and do not edit a selection', () => {
  const previewBox = {};
  const ctx = vm.createContext({ dom: { previewBox }, fullView: null });
  vm.runInContext(fn(studio, 'onKey'), ctx);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' ']) {
    ctx.onKey({ key, type: 'keydown', target: previewBox, preventDefault: () => assert.fail('preview scroll was cancelled') }, false);
  }
});

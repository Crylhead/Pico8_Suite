// #200: when the stage changes size, Pixel Studio and Map Editor refit an automatic view and only clamp a
// manual one so part of the document stays on screen. Runs the actual clampView and onStageResize from
// js/studio.js and js/map.js with a fake stage.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');

/** state(doc px w/h) -> { set view, resize(w, h), view } for one editor */
function editor(file) {
  const src = read(file);
  const isMap = file.endsWith('map.js');
  const ctx = vm.createContext({});
  vm.runInContext(`
    const T = 8;
    const dom = { stage: { clientWidth: 1000, clientHeight: 500 } };
    const ps = { doc: { w: 128, h: 128 }, zoom: 3, panX: 0, panY: 0 };
    const me = { map: { w: 16, h: 16 }, zoom: 3, panX: 0, panY: 0 };
    const log = { fits: 0, draws: 0 };
    const requestDraw = () => { log.draws++; };
    const requestRender = () => { log.draws++; };
    let viewAuto = true;
    function zoomFit() { log.fits++; viewAuto = true; }
    let stageSize = '';
    ${fn(src, 'clampView')}
    ${fn(src, 'onStageResize')}
    const v = ${isMap ? 'me' : 'ps'};
    this.api = {
      v, log,
      manual: () => { viewAuto = false; },
      auto: () => viewAuto,
      resize: (w, h) => { dom.stage.clientWidth = w; dom.stage.clientHeight = h; onStageResize(); },
      size: () => ${isMap ? 'me.map.w * T * me.zoom' : 'ps.doc.w * ps.zoom'},
    };
  `, ctx);
  return ctx.api;
}

for (const file of ['js/studio.js', 'js/map.js']) {
  t(`#200 ${file}: an automatic view refits on every real size change, once, and not while hidden`, () => {
    const e = editor(file);
    e.resize(1000, 500);
    e.resize(1000, 500); // same size (e.g. a redraw): no refit
    assert.strictEqual(e.log.fits, 1);
    e.resize(0, 0); // workspace hidden
    assert.strictEqual(e.log.fits, 1, 'no refit for a hidden stage');
    e.resize(341, 360);
    e.resize(1000, 500);
    assert.strictEqual(e.log.fits, 3, 'desktop -> phone -> desktop refits both ways');
  });

  t(`#200 ${file}: a manual view keeps zoom and pan unless the document would leave the stage`, () => {
    const e = editor(file);
    e.resize(1000, 500);
    e.manual();
    e.v.zoom = 4; e.v.panX = 268; e.v.panY = 8;
    const W = e.size();
    e.resize(900, 500); // still well on screen: unchanged
    assert.deepStrictEqual([e.v.zoom, e.v.panX, e.v.panY], [4, 268, 8]);
    e.resize(341, 360); // mostly off screen: pulled back so half the stage is covered
    assert.strictEqual(e.v.zoom, 4, 'zoom is kept');
    const visible = Math.min(341, e.v.panX + W) - Math.max(0, e.v.panX);
    assert.ok(visible >= Math.min(W, 341) / 2 - 1, `at least half visible (${visible}px)`);
    assert.strictEqual(e.log.fits, 1, 'a manual view is never refitted');
    assert.strictEqual(e.auto(), false);
    // dragged far away while the window keeps its size: a later resize brings it back on screen
    e.v.panX = -5000; e.v.panY = 5000;
    e.resize(342, 360);
    assert.ok(e.v.panX + W > 0 && e.v.panX < 342, 'back on screen horizontally');
    assert.ok(e.v.panY < 360, 'back on screen vertically');
  });
}

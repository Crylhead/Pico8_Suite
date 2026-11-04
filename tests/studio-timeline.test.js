// #199: Pixel Studio's timeline is compact for one-frame images in automatic mode, full with more frames,
// and an explicit Show / Hide (button, T, menu) is kept. Runs the actual setTimeline and applyTimeline
// from js/studio.js with a fake layout.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');

function setup(mode, frames) {
  const ctx = vm.createContext({ mode, frames });
  const src = read('js/studio.js');
  vm.runInContext(`
    const classes = new Set();
    const main = { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } };
    const $ = (s) => (s === 'main.layout-studio' ? main : null);
    const attrs = {};
    const dom = { timelineBtn: { setAttribute: (k, v) => { attrs[k] = v; } } };
    const ps = { timelineMode: mode, timeline: true, doc: { frames: Array.from({ length: frames }, () => ({})) } };
    let saved = 0;
    const persistSettings = () => { saved++; };
    const requestDraw = () => {};
    ${fn(src, 'setTimeline')}
    ${fn(src, 'applyTimeline')}
    this.api = {
      ps, attrs,
      layout: () => (classes.has('no-timeline') ? 'hidden' : classes.has('compact-timeline') ? 'compact' : 'full'),
      frames: (n) => { ps.doc.frames = Array.from({ length: n }, () => ({})); applyTimeline(); },
      apply: applyTimeline, set: setTimeline, saved: () => saved,
    };
  `, ctx);
  return ctx.api;
}

t('#199 automatic mode: one frame is compact, a second frame expands, back to one compacts again', () => {
  const e = setup('auto', 1);
  e.apply();
  assert.strictEqual(e.layout(), 'compact');
  assert.strictEqual(e.attrs['aria-pressed'], 'true', 'a compact timeline is still shown');
  e.frames(2);
  assert.strictEqual(e.layout(), 'full');
  e.frames(1);
  assert.strictEqual(e.layout(), 'compact');
  assert.strictEqual(e.ps.timelineMode, 'auto', 'frame changes never turn the automatic mode into a choice');
  assert.strictEqual(e.saved(), 0, 'applying the mode does not rewrite the settings');
});

t('#199 an explicit choice is kept: hidden stays hidden, shown stays full with one frame', () => {
  const e = setup('auto', 1);
  e.set(false);
  assert.deepStrictEqual([e.layout(), e.ps.timelineMode, e.ps.timeline, e.attrs['aria-pressed']], ['hidden', 'hidden', false, 'false']);
  e.frames(3);
  assert.strictEqual(e.layout(), 'hidden', 'adding frames does not reveal a hidden timeline');
  e.set(true);
  e.frames(1);
  assert.deepStrictEqual([e.layout(), e.ps.timelineMode, e.ps.timeline], ['full', 'shown', true]);
  assert.strictEqual(e.saved(), 2, 'each explicit choice is persisted');
});

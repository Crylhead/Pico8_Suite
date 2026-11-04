// #194: Tab is never a Pixel Studio shortcut; T toggles the timeline. Runs the actual onKey from
// js/studio.js with stubbed collaborators.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');

function setup() {
  const ctx = vm.createContext({});
  vm.runInContext(`
    const canvas = {}; const body = {};
    const document = { body };
    const dom = { canvas, previewBox: {}, stage: { classList: { add() {} } } };
    const ps = { timeline: true, tool: 'pencil' };
    const toggles = [];
    const setTimeline = (on) => { ps.timeline = on; toggles.push(on); };
    let fullView = null;
    const KEY_CYCLES = {}; const TOOL_KEYS = {}; const DRAW_TOOLS = new Set();
    const openFullView = () => { throw new Error('unexpected Full View'); };
    const key = (k, target, opts = {}) => {
      const e = { type: 'keydown', key: k, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, prevented: false, ...opts };
      e.preventDefault = () => { e.prevented = true; };
      onKey(e, !!opts.typing);
      return e;
    };
    ${fn(read('js/studio.js'), 'onKey')}
  `, ctx);
  return ctx;
}

t('#194 Tab and Shift+Tab are left to focus navigation from the canvas and the page body', () => {
  const ctx = setup();
  for (const target of ['canvas', 'body']) {
    for (const shiftKey of [false, true]) {
      const e = vm.runInContext(`key('Tab', ${target}, { shiftKey: ${shiftKey} })`, ctx);
      assert.strictEqual(e.prevented, false, `Tab (shift ${shiftKey}) on ${target} must not be prevented`);
    }
  }
  assert.strictEqual(vm.runInContext('toggles.length', ctx), 0, 'Tab must not toggle the timeline');
});

t('#194 T toggles the timeline, but not while typing in a field', () => {
  const ctx = setup();
  vm.runInContext(`key('t', canvas); key('T', body, { shiftKey: true })`, ctx);
  assert.strictEqual(vm.runInContext('JSON.stringify(toggles)', ctx), '[false,true]');
  vm.runInContext(`key('t', {}, { typing: true })`, ctx);
  assert.strictEqual(vm.runInContext('toggles.length', ctx), 2, 'typing t must not toggle the timeline');
});

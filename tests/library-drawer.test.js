// #192: Esc and focus for the Library drawer. Runs the actual openLibrary, closeLibrary and
// libraryEscape from js/suite.js against a minimal fake DOM.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');

function setup() {
  const ctx = vm.createContext({});
  const suite = read('js/suite.js');
  vm.runInContext(`
    const node = (tagName, extra = {}) => ({ tagName, value: '', isContentEditable: false, attrs: {}, visible: true,
      setAttribute(k, v) { this.attrs[k] = v; }, getClientRects() { return this.visible ? [1] : []; },
      focus() { document.activeElement = this; }, ...extra });
    const document = { activeElement: null, fullView: false, querySelector: (s) => (s === '.ps-fullview' && document.fullView ? {} : null) };
    const search = node('INPUT');
    const radio = node('BUTTON');
    const btn = node('BUTTON');
    const inside = new Set([search, radio]);
    const root = { hidden: true, contains: (n) => inside.has(n) };
    const drawer = { root, search };
    let renders = 0;
    const renderLibrary = () => { renders++; };
    const $ = (s) => (s === '#libraryBtn' ? btn : null);
    const esc = (target) => { const e = { key: 'Escape', target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; return { handled: libraryEscape(e), prevented: e.defaultPrevented }; };
    ${fn(suite, 'openLibrary')}
    ${fn(suite, 'closeLibrary')}
    ${fn(suite, 'libraryEscape')}
  `, ctx);
  return ctx;
}
const run = (ctx, src) => vm.runInContext(src, ctx);

t('#192 opening focuses the filter; in the filter Esc first clears the text, then closes and returns focus to Library', () => {
  const ctx = setup();
  run(ctx, 'openLibrary()');
  assert.strictEqual(run(ctx, 'document.activeElement === search && btn.attrs["aria-pressed"]'), 'true');
  run(ctx, 'search.value = "tree"');
  assert.strictEqual(run(ctx, 'esc(search).handled'), true);
  assert.strictEqual(run(ctx, 'search.value + "|" + root.hidden + "|" + renders'), '|false|2', 'first Esc clears and re-renders, drawer stays');
  assert.strictEqual(run(ctx, 'esc(search).handled'), true);
  assert.strictEqual(run(ctx, 'root.hidden && btn.attrs["aria-pressed"] === "false" && document.activeElement === btn'), true);
  assert.strictEqual(run(ctx, 'esc(btn).handled'), false, 'a closed drawer never takes Esc');
});

t('#192 outside the drawer Esc closes it, except on a canvas, in a text field, in Full View or when already consumed', () => {
  const ctx = setup();
  for (const [label, target, setupSrc] of [
    ['canvas', 'node("CANVAS")', ''], ['text field', 'node("INPUT")', ''], ['textarea', 'node("TEXTAREA")', ''],
    ['Full View', 'node("BODY")', 'document.fullView = true;'],
  ]) {
    run(ctx, `openLibrary(); document.fullView = false; ${setupSrc}`);
    assert.deepStrictEqual(JSON.parse(run(ctx, `JSON.stringify(esc(${target}))`)), { handled: false, prevented: false }, label);
    assert.strictEqual(run(ctx, 'root.hidden'), false, `${label} keeps the drawer open`);
  }
  run(ctx, 'document.fullView = false');
  assert.strictEqual(run(ctx, `(() => { const e = { key: 'Escape', target: node('BODY'), defaultPrevented: true, preventDefault() {} }; return libraryEscape(e); })()`), false, 'consumed by a tooltip or tour');
  // a button outside the drawer: closes; focus was not inside, so it is not moved
  run(ctx, 'const other = node("BUTTON"); other.focus()');
  assert.deepStrictEqual(JSON.parse(run(ctx, 'JSON.stringify(esc(other))')), { handled: true, prevented: true });
  assert.strictEqual(run(ctx, 'root.hidden && document.activeElement === other'), true);
});

t('#192 closing with focus inside returns it to Library only when the toggle is visible', () => {
  const ctx = setup();
  run(ctx, 'openLibrary(); radio.focus(); btn.visible = false; closeLibrary()');
  assert.strictEqual(run(ctx, 'document.activeElement === radio'), true);
  run(ctx, 'openLibrary(); radio.focus(); btn.visible = true; closeLibrary()');
  assert.strictEqual(run(ctx, 'document.activeElement === btn'), true);
});

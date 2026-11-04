// #53: workspace navigation model (js/nav-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const N = require('../js/nav-core.js');

const TOOLS = [
  { ws: 'palette', name: 'Palette & Fades', desc: '16-color custom palettes, dark/bright fade tables.', tags: ['palette', 'fades'], category: 'create' },
  { ws: 'studio', name: 'Pixel Studio', desc: 'Pixel editor limited to PICO-8.', tags: ['draw', 'sprites'], category: 'create' },
  { ws: 'audit', name: 'Project Audit', desc: 'Tokens and characters per cart.', tags: ['tokens', 'includes'], category: 'inspect' },
  { ws: 'code', name: 'Code Editor', desc: 'PICO-8 Lua with live token count.', tags: ['code', 'tokens'], category: 'develop' },
  { ws: 'mystery', name: 'Mystery', desc: 'Registered without a category.' },
  { ws: 'extras', name: 'Extra Tools', desc: 'LUT Creator, Terrain Lab.', category: 'utilities' },
  { ws: 'extras', sub: 'terrain', name: 'Terrain Lab', desc: 'Seamless terrain → color + height maps.', category: 'create' },
  { ws: 'odd', name: 'Odd', desc: 'Unknown category.', category: 'nonsense' },
];
const BAR = ['home', 'studio', 'palette', 'code', 'audit', 'extras'];
const ids = (list) => list.map((e) => e.sub ? `${e.ws}/${e.sub}` : e.ws);

t('#53 tools group by category in bar order; unknown or missing category falls back to Utilities', () => {
  const g = N.group(TOOLS, BAR);
  assert.deepStrictEqual(g.map((x) => x.category.id), ['create', 'develop', 'inspect', 'utilities']);
  assert.deepStrictEqual(ids(g[0].entries), ['studio', 'palette', 'extras/terrain'], 'bar order, then the sub-tool');
  assert.deepStrictEqual(ids(g[3].entries), ['extras', 'mystery', 'odd'], 'unclassified tools stay reachable');
  assert.strictEqual(N.categoryOf({}), N.FALLBACK);
  assert.strictEqual(g.reduce((n, x) => n + x.entries.length, 0), TOOLS.length, 'nothing is dropped');
});

t('#53 search matches name, description, tags and category; best name match first', () => {
  assert.deepStrictEqual(ids(N.search(TOOLS, 'tokens', BAR)), ['code', 'audit'], 'tag match; ties keep category order');
  assert.deepStrictEqual(ids(N.search(TOOLS, 'terr', BAR)), ['extras/terrain', 'extras'], 'name before description');
  assert.deepStrictEqual(ids(N.search(TOOLS, 'height', BAR)), ['extras/terrain'], 'description only');
  assert.deepStrictEqual(ids(N.search(TOOLS, 'inspect', BAR)), ['audit'], 'category name');
  assert.deepStrictEqual(ids(N.search(TOOLS, '  PIXEL   studio ', BAR)), ['studio'], 'case and spacing do not matter; all words must match');
  assert.deepStrictEqual(ids(N.search(TOOLS, 'fade', BAR)), ['palette'], 'word start inside a multi-word name');
});

t('#53 empty query lists every tool; a miss returns an empty list', () => {
  assert.strictEqual(N.search(TOOLS, '', BAR).length, TOOLS.length);
  assert.deepStrictEqual(N.search(TOOLS, '   ', BAR), N.sort(TOOLS, BAR));
  assert.deepStrictEqual(N.search(TOOLS, 'zzz', BAR), []);
  assert.deepStrictEqual(N.search(TOOLS, 'pixel zzz', BAR), [], 'every word has to match');
  assert.deepStrictEqual(ids(N.search([{ ws: 'x', name: 'Café', desc: '' }], 'cafe')), ['x'], 'accents are folded');
});

t('#53 deep links: #ws and #ws/sub round trip; malformed hashes are rejected', () => {
  assert.deepStrictEqual(N.parseRoute('#map'), { ws: 'map', sub: null });
  assert.deepStrictEqual(N.parseRoute('#extras/terrain'), { ws: 'extras', sub: 'terrain' });
  assert.deepStrictEqual(N.parseRoute('extras'), { ws: 'extras', sub: null });
  assert.deepStrictEqual(N.parseRoute(''), { ws: '', sub: null });
  assert.deepStrictEqual(N.parseRoute('#extras/<img>'), { ws: 'extras', sub: null }, 'bad sub part is ignored');
  for (const bad of ['#a/b/c', '#%E0%A4%A', '#../x', '#<script>']) assert.deepStrictEqual(N.parseRoute(bad), { ws: '', sub: null }, bad);
  assert.strictEqual(N.formatRoute('extras', 'terrain'), '#extras/terrain');
  assert.strictEqual(N.formatRoute('map'), '#map');
  assert.deepStrictEqual(N.parseRoute(N.formatRoute('extras', 'line')), { ws: 'extras', sub: 'line' });
});


// Exercise the actual shell open/fit adapters; layout itself is checked in the browser.
t('#166 menu opening fits the page gutter and short viewport while preserving keyboard focus', () => {
  const vm = require('vm');
  const { read, fn } = require('./source-extract.js');
  const src = read('js/app.js');
  for (const fixture of [
    { left: 16, right: 286, top: 80, width: 1280, page: 1265, height: 900, offset: 0 },
    { left: 267, right: 537, top: 80, width: 360, page: 345, height: 450, offset: -200 },
    { left: 6, right: 276, top: 106, width: 360, page: 345, height: 450, offset: 2 },
  ]) {
    const pop = { style: {}, getBoundingClientRect: () => fixture };
    const button = { setAttribute(k, v) { this[k] = v; } };
    let focused = null, closed = 0, opened = false;
    const menu = { classList: { add() { opened = true; } }, querySelector: (s) => s === '.menu-pop' ? pop : button };
    const items = [0, 1].map((i) => ({ focus() { focused = i; } }));
    const ctx = vm.createContext({ document: { documentElement: { clientWidth: fixture.width }, body: { clientWidth: fixture.page } }, window: { innerHeight: fixture.height }, closeMenus() { closed++; }, menuItems: () => items, menu });
    vm.runInContext(fn(src, 'fitMenu') + '\n' + fn(src, 'openMenu'), ctx);
    vm.runInContext('openMenu(menu, "last")', ctx);
    assert.ok(opened); assert.strictEqual(closed, 1); assert.strictEqual(button['aria-expanded'], 'true');
    assert.strictEqual(focused, 1);
    assert.strictEqual(Number.parseFloat(pop.style.left), fixture.offset);
    assert.strictEqual(Number.parseFloat(pop.style.maxHeight), fixture.height - fixture.top - 8);
    vm.runInContext('openMenu(menu)', ctx);
    assert.strictEqual(focused, 1, 'pointer opening leaves existing focus alone');
  }
});

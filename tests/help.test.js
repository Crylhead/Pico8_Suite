// #59: help registry integrity, parity with the F1 template and search (js/help-core.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const H = require('../js/help-core.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tabsStart = html.indexOf('id="wsTabs"');
const wsTabs = [...html.slice(tabsStart, html.indexOf('appbar-end', tabsStart)).matchAll(/data-value="([a-z]+)"/g)].map((m) => m[1]);
const docIds = [...html.slice(html.indexOf('id="docsTemplate"')).matchAll(/<h3 id="(doc-[\w-]+)"/g)].map((m) => m[1]);
const jsRegistered = [...fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js')).flatMap((f) =>
  [...fs.readFileSync(path.join(root, 'js', f), 'utf8').matchAll(/registerTool\(\{[^}]*?ws: '([a-z]+)'/gs)].map((m) => m[1]))];

t('#59 every workspace tab and every registered tool has exactly one canonical tool topic', () => {
  assert.ok(wsTabs.length >= 11, wsTabs.join());
  for (const ws of [...wsTabs, ...jsRegistered]) {
    const tools = H.topics().filter((x) => x.kind === 'tool' && x.ws === ws);
    assert.strictEqual(tools.length, 1, `workspace ${ws}`);
  }
});

t('#59 tool topics document purpose, inputs, outputs, key actions, restrictions and related topics', () => {
  for (const x of H.topics().filter((y) => y.kind === 'tool' && y.ws !== 'home')) {
    for (const k of ['summary', 'inputs', 'outputs', 'actions', 'restrictions', 'related']) {
      assert.ok(x[k] && x[k].length, `${x.id} lacks ${k}`);
    }
  }
});

t('#59 ids are unique and stable; related, legacy anchors and aliases resolve', () => {
  const ids = H.topics().map((x) => x.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  const ctl = H.topics().flatMap((x) => [...x.controls, ...x.actions].map((c) => c.id));
  assert.strictEqual(new Set(ctl).size, ctl.length, 'duplicate control/action ids');
  for (const x of H.topics()) {
    for (const r of x.related) assert.ok(H.topic(r), `${x.id} -> ${r}`);
    assert.ok(!x.legacy || docIds.includes(x.legacy), `${x.id} legacy ${x.legacy}`);
    assert.ok(Number.isInteger(x.rev) && x.rev > 0);
  }
  const A = require('../js/help-data.js').ALIASES;
  for (const [from, to] of Object.entries(A)) assert.ok(H.topic(to) || H.control(to), `alias ${from}`);
});

t('#59 parity: every long-form F1 section stays reachable from a topic until covered', () => {
  const linked = new Set(H.topics().map((x) => x.legacy));
  // sections with detail not yet migrated stay in the full documentation (listed here deliberately)
  const fullDocOnly = new Set(['doc-studio-pico', 'doc-studio-keys', 'doc-controls', 'doc-modes', 'doc-palette', 'doc-import', 'doc-ramps', 'doc-fades', 'doc-params', 'doc-preview', 'doc-projects', 'doc-export', 'doc-greyscale', 'doc-tiles-export', 'doc-web']);
  for (const id of docIds) assert.ok(linked.has(id) || fullDocOnly.has(id), `${id} is neither linked nor listed as full-doc-only`);
});

t('#59 lookups by control id work for tooltips and tours; unknown ids give null', () => {
  assert.strictEqual(H.control('code.run').topic.id, 'code');
  assert.strictEqual(H.control('map.status').topic.id, 'map');
  assert.strictEqual(H.control('nope.nothing'), null);
  assert.strictEqual(H.forWorkspace('cartbuilder').title, 'Cart Packer');
  assert.strictEqual(H.forWorkspace('missing'), null);
});

t('#59 search matches control names, tasks and shortcuts; empty state returns nothing', () => {
  const top = (q) => H.search(q).map((r) => r.topic.id);
  assert.strictEqual(top('tile reduction')[0], 'tiles');
  assert.ok(top('count tokens').includes('code') && top('count tokens').includes('audit'));
  assert.ok(top('fade slider').includes('palette'));
  assert.strictEqual(top('offline')[0], 'suite');
  assert.ok(top('ctrl+r').includes('code'));
  assert.deepStrictEqual(top('zzzqqq'), []);
  assert.deepStrictEqual(top('   '), []);
  assert.ok(top('TERRAIN').includes('extras'));
});

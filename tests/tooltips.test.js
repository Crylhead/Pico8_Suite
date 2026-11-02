// #60: tooltip lookup, levels and placement (js/ux-tooltips.js) and registry integrity of data-help-id.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const Tips = require('../js/ux-tooltips.js');
const Help = require('../js/help-core.js');

t('#60 off shows nothing; concise and detailed read the same registry text', () => {
  assert.strictEqual(Tips.resolveTip(Help, 'studio.tiled', 'off'), null);
  const c = Tips.resolveTip(Help, 'studio.tiled', 'concise');
  const d = Tips.resolveTip(Help, 'studio.tiled', 'detailed');
  assert.ok(c.text.length > 10);
  assert.ok(d.text.startsWith(c.text), 'detailed extends the concise text');
  assert.ok(d.text.length > c.text.length && /F1/.test(d.text));
  assert.strictEqual(c.topic, 'studio');
});

t('#60 unknown ids, missing help and throwing lookups fail quietly', () => {
  assert.strictEqual(Tips.resolveTip(Help, 'no.such.control', 'concise'), null);
  assert.strictEqual(Tips.resolveTip(Help, '', 'concise'), null);
  assert.strictEqual(Tips.resolveTip(null, 'x', 'concise'), null);
  assert.strictEqual(Tips.resolveTip({ control() { throw new Error('boom'); } }, 'x', 'concise'), null);
});

t('#60 placement stays on screen and never covers the target', () => {
  const r = { top: 100, bottom: 120, left: 10, width: 40 };
  const below = Tips.place(r, 200, 50, 800, 600);
  assert.strictEqual(below.side, 'below');
  assert.ok(below.top >= r.bottom);
  assert.ok(below.left >= 4);
  const above = Tips.place({ top: 560, bottom: 580, left: 700, width: 40 }, 200, 50, 800, 600);
  assert.strictEqual(above.side, 'above');
  assert.ok(above.top + 50 <= 560);
  assert.ok(above.left + 200 <= 796);
});

t('#60 every data-help-id in index.html resolves in the help registry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/data-help-id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, 'example controls are marked');
  for (const id of ids) assert.ok(Tips.resolveTip(Help, id, 'concise'), `no help text for ${id}`);
});

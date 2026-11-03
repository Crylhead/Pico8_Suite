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

t('#60 when neither below nor above fits, the tip goes beside the target or is shortened, never over it', () => {
  const covers = (p, r, w, h) => p && !(p.left + w <= r.left || r.left + r.width <= p.left || p.top + (p.maxHeight ?? h) <= r.top || r.bottom <= p.top);
  // short, wide viewport: room to the right
  const r1 = { top: 40, bottom: 70, left: 10, width: 100 };
  const p1 = Tips.place(r1, 200, 130, 800, 150);
  assert.strictEqual(p1.side, 'right');
  assert.ok(!covers(p1, r1, 200, 130));
  // narrow and short (320 x 150, the case found in the browser): shortened on the larger side
  const r2 = { top: 58, bottom: 92, left: 27, width: 162 };
  const p2 = Tips.place(r2, 304, 131, 320, 150);
  assert.ok(p2 && p2.maxHeight > 0 && p2.maxHeight < 131, JSON.stringify(p2));
  assert.ok(!covers(p2, r2, 304, 131), JSON.stringify(p2));
  // no room for even two lines anywhere: no tip rather than one over the control
  assert.strictEqual(Tips.place({ top: 20, bottom: 80, left: 10, width: 300 }, 304, 131, 320, 100), null);
});

t('#60 every data-help-id in index.html resolves in the help registry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/data-help-id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, 'example controls are marked');
  for (const id of ids) assert.ok(Tips.resolveTip(Help, id, 'concise'), `no help text for ${id}`);
});

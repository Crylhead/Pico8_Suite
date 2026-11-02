// #57: destination list with reasons and the send flow (js/transfer-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const X = require('../js/transfer-core.js');

const img = (w = 128, h = 128) => ({ kind: 'image', name: 'logo', w, h });
const mk = (over = {}) => ({ id: 'x', label: 'X', kinds: ['image'], open: async () => true, ...over });

t('#57 destinations come from the consumers: available first, every other with an exact reason', () => {
  const list = [
    mk({ id: 'map', label: 'Map Editor', kinds: ['map'] }),
    mk({ id: 'tiles', label: 'Tile Maker' }),
    mk({ id: 'tileset', label: 'Map Editor tileset', accepts: (a) => (a.w <= 128 ? true : 'A tileset is at most 128×128.') }),
  ];
  const d = X.destinations(list, img(256, 128));
  assert.deepStrictEqual(d.map((r) => [r.id, r.ok]), [['tiles', true], ['map', false], ['tileset', false]]);
  assert.strictEqual(d.find((r) => r.id === 'map').reason, 'Map Editor opens maps, not images.');
  assert.strictEqual(d.find((r) => r.id === 'tileset').reason, 'A tileset is at most 128×128.');
  assert.ok(X.destinations(list, img()).every((r) => r.id === 'map' || r.ok));
});

t('#57 unsupported destination is rejected without calling open', async () => {
  let opened = 0;
  const c = mk({ accepts: () => 'Too big.', open: async () => { opened++; } });
  const r = await X.send(c, img(), { confirm: async () => true });
  assert.deepStrictEqual([r.status, r.message, opened], ['rejected', 'Too big.', 0]);
});

t('#57 unsaved destination work: Cancel keeps both sides and never opens; Replace opens', async () => {
  let opened = 0;
  const c = mk({ unsaved: () => 'The current map has changes that are not saved.', open: async () => { opened++; return true; } });
  let asked = '';
  const no = await X.send(c, img(), { confirm: async (m) => { asked = m; return false; } });
  assert.strictEqual(no.status, 'cancelled');
  assert.strictEqual(opened, 0);
  assert.match(asked, /unsaved work.*not saved.*Replace.*cancel/s);
  const yes = await X.send(c, img(), { confirm: async () => true });
  assert.strictEqual(yes.status, 'done');
  assert.strictEqual(opened, 1);
});

t('#57 no prompt when the destination has nothing unsaved; a destination cancel (false) is not success', async () => {
  let asked = 0;
  const confirm = async () => { asked++; return true; };
  assert.strictEqual((await X.send(mk({ unsaved: () => false }), img(), { confirm })).status, 'done');
  assert.strictEqual(asked, 0);
  assert.strictEqual((await X.send(mk({ open: async () => false }), img(), { confirm })).status, 'cancelled');
});

t('#57 a failing destination reports failure, never success', async () => {
  const r = await X.send(mk({ open: async () => { throw new Error('storage full'); } }), img(), { confirm: async () => true });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.message, /could not open “logo”: storage full\. Nothing was changed/);
  assert.strictEqual((await X.send(null, img(), { confirm: async () => true })).status, 'rejected');
});

t('#57 success wording names the target and says temporary or saved', () => {
  const c = mk({ label: 'Tile Maker' });
  assert.match(X.doneMessage(c, img(), { saved: false }), /temporary copy.*Tile Maker.*not in the Library/);
  assert.match(X.doneMessage(c, img(), { saved: true }), /Library copy is unchanged/);
});

const assert = require('assert');
const { t } = require('./harness.js');
const K = require('../js/code-core.js');

t('MIN-06 snapshot copies live dirty cart, tabs and folder context without touching native capabilities', () => {
  const forbidden = () => { throw Error('handoff must not use filesystem capabilities'); };
  const folder = { name: 'demo', entries: forbidden, requestPermission: forbidden, queryPermission: forbidden };
  const raw = K.NEW_CART + 'saved()\n__gfx__\n0011\n__sfx__\n2233\n';
  const c = { doc: {}, loc: {}, name: 'main.p8', parts: K.splitCart(raw), text: 'dirty()\n-->8\nprint("♥")', savedLua: 'saved()',
    folder, folderReady: true, rel: 'src/main.p8', parent: { name: 'boot.p8', rel: 'boot.p8' }, handle: { createWritable: forbidden }, selection: { start: 3, end: 5 } };
  let focuses = 0;
  const bridge = K.createSourceBridge({ read: () => c, focus: () => focuses++ });
  const snapshot = bridge.getSnapshot();
  assert.ok(snapshot.dirty); assert.strictEqual(snapshot.lua, c.text); assert.strictEqual(snapshot.tabs.length, 2);
  assert.strictEqual(snapshot.source.entryPath, c.rel);
  assert.strictEqual(snapshot.source.files[0].text, K.joinCart(c.parts, c.text));
  assert.strictEqual(snapshot.parts.tail, c.parts.tail); assert.deepStrictEqual(snapshot.parts.sections, ['gfx', 'sfx']);
  assert.strictEqual(snapshot.context.folder.name, 'demo'); assert.strictEqual(snapshot.context.relativePath, c.rel);
  assert.strictEqual(snapshot.context.parent.rel, 'boot.p8');
  const walk = (value) => { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); for (const v of Object.values(value)) walk(v); } else assert.notStrictEqual(typeof value, 'function'); };
  walk(snapshot); assert.ok(!JSON.stringify(snapshot).includes('createWritable'));
  c.text = 'later()'; c.parts.sections.push('map'); c.parent.rel = 'changed.p8';
  assert.strictEqual(snapshot.lua, 'dirty()\n-->8\nprint("♥")'); assert.deepStrictEqual(snapshot.parts.sections, ['gfx', 'sfx']);
  assert.strictEqual(snapshot.context.parent.rel, 'boot.p8');
  bridge.focusCurrent(); assert.strictEqual(focuses, 1); assert.strictEqual(c.text, 'later()');
});

t('MIN-06 source identity changes for documents, edits, saves and file context, not caret movement', () => {
  const c = { ready: true, doc: {}, loc: {}, name: 'inc.lua', parts: K.splitCart('a=1'), text: 'a=2', savedLua: 'a=1' };
  const bridge = K.createSourceBridge({ read: () => c });
  let calls = 0;
  bridge.subscribe(() => { throw Error('broken observer'); });
  const off = bridge.subscribe(() => calls++);
  bridge.refresh(); bridge.refresh(); assert.strictEqual(calls, 1);
  const initial = bridge.getSnapshot(); c.selection = { start: 2, end: 3 }; bridge.refresh();
  assert.ok(bridge.isCurrent(initial.identity)); assert.strictEqual(calls, 1);
  for (const change of [() => { c.text += ' '; }, () => { c.savedLua = c.text; }, () => { c.doc = {}; }, () => { c.loc = {}; },
    () => { c.folder = { name: 'other' }; }, () => { c.folderReady = true; }, () => { c.rel = 'src/inc.lua'; }, () => { c.parent = { rel: 'main.p8', name: 'main.p8' }; }]) {
    const previous = bridge.getSnapshot(); change(); assert.ok(!bridge.isCurrent(previous.identity)); bridge.refresh();
  }
  off(); const count = calls; c.text += ' '; bridge.refresh(); assert.strictEqual(calls, count);
  c.ready = false; assert.ok(!bridge.getStatus().available); assert.match(bridge.getStatus().reason, /restoring/);
  c.ready = true; c.text = ' \n'; assert.strictEqual(bridge.getSnapshot(), null); assert.match(bridge.getStatus().reason, /nonempty/);
  c.text = 'cls()'; c.name = 'invalid.p8'; assert.strictEqual(bridge.getSnapshot(), null); assert.match(bridge.getStatus().reason, /valid .p8/);
});

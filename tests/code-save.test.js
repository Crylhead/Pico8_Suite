// #6 / #4 (Code Editor): revision-safe saves and external-edit merge / conflicts, with fake file handles.
const assert = require('assert');
const { t } = require('./harness.js');
const K = require('../js/code-core.js');

const cart = (lua, gfx = '0000') => `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n__gfx__\n${gfx}\n`;
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); p.open = open; return p; };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** FileSystemFileHandle stand-in: `hold` delays the next commit, `fail` rejects it. */
function fakeHandle(name, text) {
  const h = {
    name, text, writes: [], hold: null, fail: null,
    async getFile() { const snapshot = h.text; return { text: async () => snapshot }; },
    async createWritable() {
      let buf = '';
      return {
        write: async (x) => { buf += x; },
        close: async () => {
          const wait = h.hold; h.hold = null;
          if (wait) await wait;
          if (h.fail) throw h.fail;
          h.text = buf;
          h.writes.push(buf);
        },
      };
    },
    isSameEntry: async (o) => o === h,
  };
  return h;
}

/** the editor state code.js keeps, driven through K.createSaver like code.js does */
function editor(handle, { conflict = 'cancel', pick = null } = {}) {
  const ed = { text: '', savedLua: '', doc: {}, baseLua: null, parts: null, handle: null, name: '', log: [] };
  ed.open = (h) => {
    ed.parts = K.splitCart(h.text);
    Object.assign(ed, { text: ed.parts.lua, savedLua: ed.parts.lua, baseLua: ed.parts.lua, doc: {}, handle: h, name: h.name });
  };
  ed.dirty = () => ed.text !== ed.savedLua;
  ed.saver = K.createSaver({
    snapshot: () => ({ doc: ed.doc, lua: ed.text, parts: ed.parts, baseLua: ed.baseLua, handle: ed.handle, name: ed.name }),
    isCurrent: (doc) => doc === ed.doc,
    commit: (doc, r) => {
      ed.savedLua = r.lua;
      if (r.text != null) Object.assign(ed, { parts: r.parts, baseLua: r.parts.lua, handle: r.handle, name: r.name });
    },
    done: (how, r) => ed.log.push(`${how}${r.merged ? ' merged' : ''}`),
    read: async (h) => (await h.getFile()).text(),
    write: async (h, text) => { const w = await h.createWritable(); await w.write(text); await w.close(); },
    conflict: async (c) => { ed.log.push(`conflict ${c.diskLua}`); return conflict; },
    reload: (doc, text) => ed.open({ ...handle, text }),
    pickSave: pick,
    download: (text) => ed.log.push(`download ${text.length}`),
    warn: (m) => ed.log.push(`warn ${m}`),
  });
  ed.open(handle);
  return ed;
}

t('#6 typing during a delayed save keeps the newer text dirty', async () => {
  const h = fakeHandle('a.p8', cart('old'));
  const ed = editor(h);
  ed.text = 'mid';
  const gate = h.hold = deferred();
  const p = ed.saver.save();
  await tick();
  ed.text = 'new'; // typed while the write is pending
  gate.open();
  assert.strictEqual(await p, 'saved');
  assert.strictEqual(h.text, cart('mid'));
  assert.strictEqual(ed.savedLua, 'mid');
  assert.ok(ed.dirty(), 'the edit made during the save must stay unsaved');
  assert.strictEqual(await ed.saver.save(), 'saved');
  assert.strictEqual(h.text, cart('new'));
  assert.ok(!ed.dirty());
});

t('#6 overlapping saves run in order; the older one cannot replace the newer baseline', async () => {
  const h = fakeHandle('a.p8', cart('v0'));
  const ed = editor(h);
  ed.text = 'v1';
  const gate = h.hold = deferred();
  const first = ed.saver.save();
  await tick();
  ed.text = 'v2';
  const second = ed.saver.save();
  assert.ok(ed.saver.pending());
  gate.open();
  assert.deepStrictEqual(await Promise.all([first, second]), ['saved', 'saved']);
  assert.deepStrictEqual(h.writes, [cart('v1'), cart('v2')]);
  assert.strictEqual(ed.savedLua, 'v2');
  assert.ok(!ed.dirty() && !ed.saver.pending());
  assert.ok(!ed.log.some((l) => l.startsWith('conflict')), ed.log.join('; '));
});

t('#6 switching files during a pending save does not mark the new file saved', async () => {
  const a = fakeHandle('a.p8', cart('a0'));
  const b = fakeHandle('b.p8', cart('b0'));
  const ed = editor(a);
  ed.text = 'a1';
  const gate = a.hold = deferred();
  const p = ed.saver.save();
  await tick();
  ed.open(b);
  ed.text = 'b1';
  gate.open();
  assert.strictEqual(await p, 'saved');
  assert.strictEqual(a.text, cart('a1'));
  assert.strictEqual(b.text, cart('b0'));
  assert.strictEqual(ed.handle, b);
  assert.strictEqual(ed.savedLua, 'b0');
  assert.ok(ed.dirty());
});

t('#4 sprites changed on disk survive a Lua save (merged)', async () => {
  const h = fakeHandle('a.p8', cart('old', '0000'));
  const ed = editor(h);
  ed.text = 'mine';
  h.text = cart('old', '7777'); // PICO-8 saved new sprites
  assert.strictEqual(await ed.saver.save(), 'saved');
  assert.strictEqual(h.text, cart('mine', '7777'));
  assert.deepStrictEqual(ed.log, ['saved merged']);
  assert.ok(!ed.dirty());
  assert.strictEqual(K.joinCart(ed.parts, ed.text), h.text);
});

t('#4 Lua changed on disk asks first; cancel writes nothing, overwrite keeps the disk sprites', async () => {
  const h = fakeHandle('a.p8', cart('old'));
  const ed = editor(h, { conflict: 'cancel' });
  ed.text = 'mine';
  h.text = cart('theirs', '7777');
  assert.strictEqual(await ed.saver.save(), 'cancelled');
  assert.deepStrictEqual(h.writes, []);
  assert.strictEqual(h.text, cart('theirs', '7777'));
  assert.ok(ed.dirty());
  assert.deepStrictEqual(ed.log, ['conflict theirs']);

  const over = editor(h, { conflict: 'overwrite' });
  h.text = cart('theirs2', '7777');
  over.text = 'mine';
  assert.strictEqual(await over.saver.save(), 'saved');
  assert.strictEqual(h.text, cart('mine', '7777'));

  const back = editor(h, { conflict: 'reload' });
  back.text = 'unsaved';
  h.text = cart('theirs3');
  assert.strictEqual(await back.saver.save(), 'cancelled');
  assert.strictEqual(back.text, 'theirs3');
  assert.ok(!back.dirty());
});

t('#6 a rejected write keeps the buffer dirty; save / Save As outcomes stay explicit', async () => {
  const abort = () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  const h = fakeHandle('a.p8', cart('old'));
  const ed = editor(h, { pick: abort });
  ed.text = 'new';
  h.fail = new Error('disk full');
  assert.strictEqual(await ed.saver.save(), 'cancelled');
  assert.strictEqual(h.text, cart('old'));
  assert.ok(ed.dirty());
  assert.ok(ed.log[0].startsWith('warn Could not write a.p8: disk full'));

  h.fail = null;
  const other = fakeHandle('b.p8', '');
  const as = editor(h, { pick: async () => other });
  as.text = 'copy';
  assert.strictEqual(await as.saver.save({ as: true }), 'saved');
  assert.strictEqual(other.text, cart('copy'));
  assert.strictEqual(as.handle, other);

  const dl = editor(fakeHandle('c.p8', cart('x')));
  dl.text = 'y';
  assert.strictEqual(await dl.saver.save({ as: true }), 'downloaded');
  assert.ok(!dl.dirty());
});

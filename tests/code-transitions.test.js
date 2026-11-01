// #30 (Code Editor): document transitions (open another file, incoming code, Run) are bound to the open
// document and its saved revision. openRel() and runCart() are taken from js/code.js itself and run with
// the real P8Code.createSaver / createTransitions and fake, delayed file handles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t } = require('./harness.js');
const K = require('../js/code-core.js');

const SRC = fs.readFileSync(path.join(__dirname, '../js/code.js'), 'utf8');
const cart = (lua) => `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua}\n__gfx__\n0000\n`;
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); p.open = open; return p; };
const tick = () => new Promise((r) => setTimeout(r, 0));

/** the source of `[async] function name(...) {...}` in js/code.js (braces balance in its strings) */
function fn(name) {
  let at = SRC.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} not found in js/code.js`);
  if (SRC.slice(at - 6, at) === 'async ') at -= 6;
  let depth = 0;
  for (let i = SRC.indexOf('{', SRC.indexOf(')', at)); i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

/** FileSystemFileHandle stand-in: `hold` delays the next write, `fail` rejects it, `readHold` the next read */
function fakeHandle(name, text) {
  const h = {
    name, text, kind: 'file', writes: [], hold: null, fail: null, readHold: null,
    async getFile() {
      const wait = h.readHold; h.readHold = null;
      if (wait) await wait;
      const snapshot = h.text;
      return { text: async () => snapshot };
    },
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

/** the Code Editor state, saver and transition guard wired as in js/code.js, around its openRel/runCart */
function editor(files, { discard = true, pick = null } = {}) {
  const log = [];
  const ed = { name: 'untitled.p8', parts: K.splitCart(K.NEW_CART), handle: null, savedLua: '', doc: {}, baseLua: null, text: '', files: new Map(), rel: null, parent: null, incs: [], folder: null };
  for (const h of files) ed.files.set(h.name.toLowerCase(), { rel: h.name, handle: h });
  const load = (text, name, handle = null, { rel = null, parent = null } = {}) => {
    ed.parts = K.splitCart(text);
    Object.assign(ed, { name, handle, rel, parent, text: ed.parts.lua, savedLua: ed.parts.lua, doc: {}, baseLua: handle ? ed.parts.lua : null });
  };
  const dirty = () => ed.text !== ed.savedLua;
  const confirmDiscard = async (what) => { if (!dirty()) return true; log.push(`confirm ${what}`); return discard; };
  const saver = K.createSaver({
    snapshot: () => ({ doc: ed.doc, lua: ed.text, parts: ed.parts, baseLua: ed.baseLua, handle: ed.handle, name: ed.name }),
    isCurrent: (doc) => doc === ed.doc,
    commit: (doc, r) => {
      ed.savedLua = r.lua;
      if (r.text != null) Object.assign(ed, { parts: r.parts, baseLua: r.parts.lua, handle: r.handle, name: r.name });
    },
    read: async (h) => (await h.getFile()).text(),
    write: async (h, text) => { const w = await h.createWritable(); await w.write(text); await w.close(); },
    conflict: async () => 'cancel',
    reload: (doc, text) => load(text, ed.name, ed.handle, { rel: ed.rel, parent: ed.parent }),
    pickSave: pick,
    download: (text, name) => log.push(`download ${name}`),
    warn: (m) => log.push(`warn ${m}`),
  });
  const save = (opts) => saver.save(opts);
  const transitions = K.createTransitions({
    current: () => ({ doc: ed.doc, lua: ed.text, savedLua: ed.savedLua, handle: ed.handle, name: ed.name }),
    idle: () => saver.idle(),
    save: () => save(),
    confirmDiscard,
  });
  const sent = [];
  const ctx = vm.createContext({
    ed, K, saver, save, dirty, confirmDiscard, transitions, load, sent, log, Promise,
    readRel: async (rel) => (await ed.files.get(rel.toLowerCase()).handle.getFile()).text(),
    showMessage: (title, msg) => log.push(`message ${title}: ${msg}`),
    toast: (msg) => log.push(`toast ${msg}`),
    App: { setWorkspace() {} },
    call: async (p, body) => { sent.push(body); return { path: `/carts/${body.name}`, temp: false }; },
    dom: { output: {}, runInfo: {} },
    appendOut() {}, setRunning() {}, poll() {}, runSetup() {}, dirOf: () => '',
  });
  for (const name of ['openRel', 'runTarget', 'runCart']) vm.runInContext(fn(name), ctx);
  for (const name of ['explain', 'openText']) if (SRC.includes(`function ${name}(`)) vm.runInContext(fn(name), ctx);
  // before #30 code-open-text was an inline action: the same steps, so the tests also run on that code
  if (!ctx.openText) ctx.openText = async ({ text, name }) => { if (await confirmDiscard(`Open "${name}"?`)) load(text, name); };
  const open = (h) => load(h.text, h.name, h, { rel: h.name });
  return { ed, ctx, log, sent, saver, transitions, open, dirty, load };
}

t('#30 code typed while the file being left is saved stays open, dirty and recoverable', async () => {
  const a = fakeHandle('a.p8', cart('x=1'));
  const b = fakeHandle('b.p8', cart('b=1'));
  const e = editor([a, b]);
  e.open(a);
  e.ed.text = 'x=2';
  const gate = a.hold = deferred();
  const going = e.ctx.openRel('b.p8');
  await tick();
  e.ed.text = 'x=3'; // typed while A's automatic save is pending
  gate.open();
  await going;
  assert.strictEqual(a.text, cart('x=2'));
  assert.strictEqual(e.ed.handle, a, 'A must stay open');
  assert.strictEqual(e.ed.text, 'x=3');
  assert.ok(e.dirty(), 'the newer code stays unsaved, not marked saved');
  assert.ok(!e.log.some((l) => l.startsWith('confirm')), 'no discard was offered for it');
  assert.ok(e.log.some((l) => /a\.p8 was edited while it was being saved/.test(l)), e.log.join('; '));
  // the next click saves the newest code, then leaves
  await e.ctx.openRel('b.p8');
  assert.strictEqual(a.text, cart('x=3'));
  assert.strictEqual(e.ed.handle, b);
  assert.strictEqual(e.ed.text, 'b=1');
});

t('#30 a file saved at the revision on screen opens the next one without a prompt', async () => {
  const a = fakeHandle('a.p8', cart('x=1'));
  const b = fakeHandle('b.p8', cart('b=1'));
  const c = fakeHandle('c.p8', cart('c=1'));
  const e = editor([a, b, c]);
  e.open(a);
  e.ed.text = 'x=2';
  const gate = a.hold = deferred();
  const going = e.ctx.openRel('b.p8');
  await tick();
  gate.open();
  await going;
  assert.strictEqual(a.text, cart('x=2'));
  assert.strictEqual(e.ed.handle, b);
  assert.ok(!e.dirty());
  await e.ctx.openRel('c.p8'); // unchanged: no save, no prompt
  assert.strictEqual(e.ed.handle, c);
  assert.deepStrictEqual(b.writes, []);
  assert.deepStrictEqual(e.log, []);
});

t('#30 cancelled or download-only saves and a declined discard keep the open code', async () => {
  const abort = () => { throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); };
  const a = fakeHandle('a.p8', cart('x=1'));
  const b = fakeHandle('b.p8', cart('b=1'));
  const e = editor([a, b], { pick: abort, discard: false });
  e.open(a);
  e.ed.text = 'x=2';
  a.fail = new Error('denied');
  await e.ctx.openRel('b.p8');
  assert.strictEqual(e.ed.handle, a);
  assert.strictEqual(e.ed.text, 'x=2');
  assert.ok(e.log.some((l) => /a\.p8 was not saved in place, so it stays open/.test(l)), e.log.join('; '));

  const dl = editor([a, b]); // no Save As picker: the fallback only downloads a copy
  dl.open(a);
  dl.ed.text = 'x=3';
  assert.deepStrictEqual(await dl.transitions.open({ what: 'Open "b.p8"?', autosave: true, prepare: () => 'b', apply: () => assert.fail('left A') }), { ok: false, why: 'unsaved', name: 'a.p8', how: 'downloaded' });
  assert.strictEqual(dl.ed.text, 'x=3');

  // incoming code (code-open-text) for a buffer without a file: declining keeps it
  e.load(cart('mine'), 'untitled.p8');
  e.ed.text = 'mine2';
  await e.ctx.openText({ text: cart('other'), name: 'other.p8' });
  assert.strictEqual(e.ed.name, 'untitled.p8');
  assert.strictEqual(e.ed.text, 'mine2');
  assert.ok(e.log.includes('confirm Open "other.p8"?'));
});

t('#30 Run sends only the saved code; code typed during its save stops it', async () => {
  const a = fakeHandle('a.p8', cart('x=1'));
  const e = editor([a]);
  e.open(a);
  e.ed.text = 'x=2';
  const gate = a.hold = deferred();
  const run = e.ctx.runCart();
  await tick();
  e.ed.text = 'x=3';
  gate.open();
  await run;
  assert.strictEqual(e.sent.length, 0, 'nothing may be sent as if x=3 were the saved cart');
  assert.strictEqual(a.text, cart('x=2'));
  assert.ok(e.dirty());
  assert.ok(e.log.some((l) => /^message Run: a\.p8 was edited while it was being saved/.test(l)), e.log.join('; '));

  await e.ctx.runCart(); // no typing now: saves x=3 and sends exactly the file's bytes
  assert.strictEqual(a.text, cart('x=3'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(e.sent)), [{ name: 'a.p8', text: a.text }]);
});

t('#30 a newer transition wins; edits made while the next document loads keep the open one', async () => {
  const a = fakeHandle('a.p8', cart('x=1'));
  const b = fakeHandle('b.p8', cart('b=1'));
  const e = editor([a, b]);
  e.open(a);
  const slow = b.readHold = deferred();
  const older = e.ctx.openRel('b.p8');
  await tick();
  await e.ctx.openText({ text: cart('c=1'), name: 'c.p8' }); // another tool hands over code meanwhile
  assert.strictEqual(e.ed.name, 'c.p8');
  slow.open();
  await older;
  assert.strictEqual(e.ed.name, 'c.p8', 'the stale open must not load b.p8 over the newer document');

  e.open(a);
  const slow2 = b.readHold = deferred();
  const going = e.ctx.openRel('b.p8');
  await tick();
  e.ed.text = 'x=9'; // typed while b.p8 is being read
  slow2.open();
  await going;
  assert.strictEqual(e.ed.handle, a);
  assert.strictEqual(e.ed.text, 'x=9');

  // Run of a document replaced during its save is refused
  e.ed.text = 'x=10';
  const gate = a.hold = deferred();
  const run = e.transitions.ready(e.ed.doc);
  await tick();
  e.load(cart('d=1'), 'd.p8');
  gate.open();
  assert.strictEqual((await run).why, 'switched');
});

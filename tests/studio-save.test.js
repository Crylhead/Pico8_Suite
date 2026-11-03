// #80: Pixel Studio's Save to Library is bound to the document and revision it stored. Runs the actual
// saveToLibrary, currentAsset, changed, loadDoc, saveSession, confirmDiscard and commitFloating from
// js/studio.js with the real studio core and a controllable fake S.assets.put.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn, same } = require('./source-extract.js');

function setup() {
  const ctx = vm.createContext({ setTimeout: () => 0, clearTimeout: () => {} });
  vm.runInContext(read('js/studio-core.js'), ctx, { filename: 'js/studio-core.js' });
  const studio = read('js/studio.js');
  vm.runInContext(`
    const K = P8Studio;
    const log = { toasts: [], prompts: [], puts: [], session: [], errors: [] };
    let promptAnswer = false;
    const library = new Map();
    let nextId = 1;
    /** put(a) stays pending until the test calls finish(i) or fail(i) */
    const writes = [];
    const S = {
      imageAsset: (a) => ({ kind: 'image', ...a }),
      assets: {
        get: (id) => library.get(id) || null,
        put: (a) => new Promise((resolve, reject) => { log.puts.push(a); writes.push({ a, resolve, reject }); }),
      },
      reportStorageError: (what, e) => { log.errors.push(what + ': ' + e.message); return null; },
      kv: { set: (k, v) => { log.session.push(JSON.parse(JSON.stringify({ assetId: v.assetId, dirty: v.dirty, name: v.name }))); return Promise.resolve(); } },
      autosaveFailed: () => () => {},
    };
    const finish = (i) => { const w = writes[i]; const stored = { ...w.a, id: w.a.id || 'lib-' + nextId++, created: w.a.created || 1 }; library.set(stored.id, stored); w.resolve(stored); return stored; };
    const fail = (i) => writes[i].reject(new Error('QuotaExceededError'));
    const toast = (m) => log.toasts.push(m);
    const confirmDialog = async (title, message) => { log.prompts.push(title); return promptAnswer; };
    const KEYS = { session: 'ps-session' };
    const dom = { name: { value: '' }, size: { textContent: '' } };
    const ps = { doc: K.newDoc(8, 8), name: 'untitled', assetId: null, dirty: false, docSeq: 0, rev: 0, saving: null,
      fades: null, frame: 0, layer: 0, sel: null, floating: null, xform: null, primary: 7, secondary: 0, history: { clear() {} } };
    const setPlaying = () => {}; const afterDocReplaced = () => {}; const requestAnimationFrame = () => {}; const zoomFit = () => {};
    let sessionTimer = 0;
    ${fn(studio, 'renderTitle')}
    ${fn(studio, 'changed')}
    ${fn(studio, 'saveSession')}
    ${fn(studio, 'loadDoc')}
    ${fn(studio, 'confirmDiscard')}
    ${fn(studio, 'commitFloating')}
    ${fn(studio, 'currentAsset')}
    ${fn(studio, 'saveToLibrary')}
    /** paint one pixel the way a tool does: change the cel, then report the edit */
    const paint = (v) => { ps.doc.frames[0].cels[0][0] = v; changed(); };
    const open = (name, v, assetId = null) => { const d = K.newDoc(8, 8); d.frames[0].cels[0][0] = v; loadDoc(d, { name, assetId, dirty: !assetId }); };
    this.env = { ps, log, library, writes, finish, fail, paint, open, saveToLibrary, confirmDiscard, setAnswer: (v) => { promptAnswer = v; } };
  `, ctx, { filename: 'studio-save-glue.js' });
  return ctx.env;
}
const tick = () => new Promise((r) => setImmediate(r));

t('#80 drawing during a pending save: the old snapshot is stored truthfully, the newer edit stays unsaved', async () => {
  const env = setup();
  env.open('A', 1);
  const p = env.saveToLibrary();
  await tick();
  env.paint(7);
  const stored = env.finish(0);
  assert.strictEqual(await p, true);
  assert.strictEqual(stored.pixels[0], 1, 'the Library holds the snapshot taken when Save started');
  assert.strictEqual(env.ps.doc.frames[0].cels[0][0], 7);
  assert.strictEqual(env.ps.dirty, true, 'the newer edit is not marked saved');
  assert.strictEqual(env.ps.assetId, stored.id, 'the open document is linked to its Library entry');
  assert.match(env.log.toasts.at(-1), /as it was when you saved\. Newer changes are not saved yet/);
  assert.strictEqual(env.log.session.at(-1).dirty, true, 'the session keeps the unsaved state');
  env.setAnswer(false);
  assert.strictEqual(await env.confirmDiscard(), false, 'discarding still asks');
  same(env.log.prompts, ['Unsaved Changes']);
});

t('#80 opening another image during a pending save: it keeps its own id, contents and unsaved state', async () => {
  for (const second of ['new', 'library']) {
    const env = setup();
    env.open('A', 1);
    const p = env.saveToLibrary();
    await tick();
    if (second === 'new') env.open('B', 4); else env.open('B', 4, 'lib-B');
    const before = { assetId: env.ps.assetId, dirty: env.ps.dirty };
    const stored = env.finish(0);
    assert.strictEqual(await p, true);
    assert.strictEqual(stored.name, 'A');
    assert.strictEqual(env.ps.name, 'B');
    assert.strictEqual(env.ps.assetId, before.assetId, `B keeps its own id (${second})`);
    assert.notStrictEqual(env.ps.assetId, stored.id);
    assert.strictEqual(env.ps.dirty, before.dirty, `B keeps its own unsaved state (${second})`);
    assert.strictEqual(env.ps.doc.frames[0].cels[0][0], 4);
    assert.match(env.log.toasts.at(-1), /Saved "A" to the library\. The image open now \("B"\) was not saved\./);
    // B's next ordinary save creates or updates B's own entry, never A's
    const p2 = env.saveToLibrary();
    await tick();
    assert.notStrictEqual(env.log.puts[1].id, stored.id, 'B never overwrites A');
    env.finish(1); await p2;
    assert.strictEqual(env.library.get(stored.id).pixels[0], 1, 'A is intact');
  }
});

t('#80 normal save cleans the document; rejected storage keeps it dirty; overlapping save is refused', async () => {
  const env = setup();
  env.open('A', 1);
  let p = env.saveToLibrary();
  await tick();
  // raced against a tick: a second save that waits on storage would otherwise hang instead of failing
  const second = await Promise.race([env.saveToLibrary(), tick().then(() => 'still pending')]);
  assert.strictEqual(second, false, 'a second save while one is pending is refused');
  assert.match(env.log.toasts.at(-1), /Still saving "A" to the library/);
  assert.strictEqual(env.log.puts.length, 1, 'no second write started');
  const stored = env.finish(0);
  assert.strictEqual(await p, true);
  assert.strictEqual(env.ps.dirty, false);
  assert.strictEqual(env.ps.assetId, stored.id);
  assert.match(env.log.toasts.at(-1), /^Saved "A" to the library$/);
  // edit and save again: same Library entry; a rejected write keeps the work unsaved and allows a retry
  env.paint(3);
  p = env.saveToLibrary();
  await tick();
  assert.strictEqual(env.log.puts[1].id, stored.id);
  env.fail(1);
  assert.strictEqual(await p, false);
  assert.strictEqual(env.ps.dirty, true);
  same(env.log.errors, ['Save to Library: QuotaExceededError']);
  assert.strictEqual(env.library.get(stored.id).pixels[0], 1, 'the earlier stored version is unchanged');
  p = env.saveToLibrary();
  await tick();
  assert.strictEqual(env.log.puts.length, 3, 'retry is possible after a failure');
  env.finish(2);
  assert.strictEqual(await p, true);
  assert.strictEqual(env.ps.dirty, false);
  assert.strictEqual(env.library.get(stored.id).pixels[0], 3);
});

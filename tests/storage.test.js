// #5: Library/session writes report IndexedDB failures and only update the cache after commit.
const assert = require('assert');
const { t } = require('./harness.js');
const { createStore, StorageError } = require('../js/suite.js');

const domError = (name) => Object.assign(new Error(`${name} (fake)`), { name });

/** Minimal asynchronous IndexedDB: writes apply on 'complete'; `fail` injects the next failure. */
function fakeIndexedDB() {
  const data = { assets: new Map(), kv: new Map() };
  const ctl = { data, fail: null };
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction(name, mode) {
      const fail = mode === 'readwrite' ? ctl.fail : null;
      if (mode === 'readwrite') ctl.fail = null;
      if (fail === 'closed') throw domError('InvalidStateError');
      const map = data[name];
      const staged = [];
      const tx = {
        error: null,
        aborted: false,
        abort() { this.aborted = true; },
        objectStore: () => ({
          put(v, k) {
            if (fail === 'clone') throw domError('DataCloneError');
            staged.push(() => map.set(k ?? v.id, structuredClone(v)));
            return {};
          },
          delete(k) { staged.push(() => map.delete(k)); return {}; },
          get(k) { const req = {}; staged.push(() => { req.result = structuredClone(map.get(k)); }); return req; },
          getAll() { const req = {}; staged.push(() => { req.result = [...map.values()].map((v) => structuredClone(v)); }); return req; },
        }),
      };
      setTimeout(() => {
        if (fail === 'quota') tx.error = domError('QuotaExceededError');
        if (tx.aborted || fail === 'quota' || fail === 'abort') { tx.onabort?.(); return; }
        staged.forEach((f) => f());
        tx.oncomplete?.();
      }, 1);
      return tx;
    },
  };
  ctl.open = () => {
    const req = { result: database };
    setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }, 1);
    return req;
  };
  return ctl;
}

function makeStore(idb) {
  const events = [];
  let n = 0;
  const s = createStore({ indexedDB: idb, emit: (type, id) => events.push(`${type}:${id}`), uid: () => `id${++n}` });
  return { ...s, events };
}

t('#5 failed Library writes reject, keep cache/events and prior stored data unchanged', async () => {
  const idb = fakeIndexedDB();
  const s = makeStore(idb);
  const v1 = await s.assets.put({ kind: 'palette', name: 'v1', colors: [] });
  assert.deepStrictEqual(s.events, ['put:id1']);
  for (const fail of ['quota', 'clone', 'abort', 'closed']) {
    // a failing update of the saved asset and a failing new asset
    for (const asset of [{ ...v1, name: `v2 ${fail}` }, { kind: 'palette', name: 'new', colors: [] }]) {
      idb.fail = fail;
      const err = await s.assets.put(asset).then(() => null, (e) => e);
      assert.ok(err instanceof StorageError, `${fail}: ${err}`);
      assert.strictEqual(err.reason, { closed: 'closed', quota: 'quota', clone: 'clone', abort: 'abort' }[fail]);
    }
  }
  idb.fail = 'abort';
  await assert.rejects(s.assets.remove(v1.id), StorageError);
  assert.deepStrictEqual(s.assets.list().map((a) => a.name), ['v1']);
  assert.deepStrictEqual(s.events, ['put:id1']);
  assert.strictEqual(s.assets.persistent(), true);
  // a reload still finds the last committed version
  const again = makeStore(idb);
  await again.ready;
  assert.deepStrictEqual(again.assets.list().map((a) => a.name), ['v1']);
});

t('#5 retry after a failed save commits and notifies once', async () => {
  const idb = fakeIndexedDB();
  const s = makeStore(idb);
  idb.fail = 'quota';
  await assert.rejects(s.assets.put({ kind: 'palette', name: 'p', colors: [] }), /quota exceeded/);
  assert.strictEqual(s.assets.list().length, 0);
  const a = await s.assets.put({ kind: 'palette', name: 'p', colors: [] });
  assert.strictEqual(s.assets.get(a.id).name, 'p');
  assert.deepStrictEqual(s.events, [`put:${a.id}`]);
  assert.strictEqual(idb.data.assets.get(a.id).name, 'p');
});

t('#5 session kv.set failures reject and keep the previous session readable', async () => {
  const idb = fakeIndexedDB();
  const s = makeStore(idb);
  await s.kv.set('sess', { text: 'old' });
  for (const fail of ['quota', 'clone', 'abort', 'closed']) {
    idb.fail = fail;
    await assert.rejects(s.kv.set('sess', { text: 'new' }), StorageError);
  }
  assert.deepStrictEqual(await s.kv.get('sess'), { text: 'old' });
  await s.kv.set('sess', { text: 'new' });
  assert.deepStrictEqual(await makeStore(idb).kv.get('sess'), { text: 'new' });
});

t('#5 IndexedDB unavailable at startup -> explicit memory-only session that still works', async () => {
  for (const idb of [null, { open() { throw domError('SecurityError'); } }, { open() { const r = {}; setTimeout(() => r.onerror?.(), 1); return r; } }]) {
    const s = makeStore(idb);
    await s.ready;
    assert.strictEqual(s.assets.persistent(), false);
    assert.strictEqual(s.assets.mode(), 'memory');
    const a = await s.assets.put({ kind: 'palette', name: 'mem', colors: [] });
    assert.strictEqual(s.assets.get(a.id).name, 'mem');
    await s.kv.set('k', 1);
    assert.strictEqual(await s.kv.get('k'), 1);
  }
});

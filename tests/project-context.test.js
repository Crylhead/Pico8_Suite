// #55: read-only active project context (js/project-context-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const C = require('../js/project-context-core.js');

const handle = (perm = 'granted', name = 'demo') => ({
  name, perm, fail: false, ask: 'granted',
  async queryPermission() { if (this.fail) throw new Error('NotFoundError'); return this.perm; },
  async requestPermission() { if (this.fail) throw new Error('NotFoundError'); if (this.ask === 'cancel') throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); this.perm = this.ask; return this.ask; },
});
const memKv = () => { const m = new Map(); return { m, async get(k) { return m.get(k); }, async set(k, v) { m.set(k, v); } }; };

t('#55 no project by default; select, replace and clear each emit exactly one event', async () => {
  const { context, publisher } = C.create({ kv: memKv() });
  const events = [];
  context.subscribe((e) => events.push(e.type));
  assert.strictEqual(context.get().access, 'none');
  await publisher.select({ name: 'A', source: 'cartbuilder', handle: handle() });
  await publisher.select({ name: 'B', source: 'cartbuilder', handle: handle() });
  assert.strictEqual(await publisher.clear('code'), false); // not the owner
  assert.strictEqual(await publisher.clear('cartbuilder'), true);
  assert.deepStrictEqual(events, ['select', 'replace', 'clear']);
  assert.strictEqual(context.get().access, 'none');
});

t('#55 selecting the same handle again does not repeat the event', async () => {
  const { context, publisher } = C.create();
  const h = handle();
  const events = [];
  context.subscribe((e) => events.push(e.type));
  await publisher.select({ name: 'A', source: 'cartbuilder', handle: h });
  await publisher.select({ name: 'A', source: 'cartbuilder', handle: h });
  assert.deepStrictEqual(events, ['select']);
});

t('#55 access is rechecked: revoked, denied and stale handles are explicit states', async () => {
  const { context, publisher } = C.create();
  const h = handle();
  await publisher.select({ name: 'A', source: 'cartbuilder', handle: h });
  const seen = [];
  context.subscribe((e) => seen.push(e.project.access));
  h.perm = 'prompt'; assert.strictEqual((await context.check()).access, 'prompt');
  h.perm = 'denied'; assert.strictEqual((await context.check()).access, 'denied');
  h.fail = true; assert.strictEqual((await context.check()).access, 'stale');
  await context.check(); // unchanged: no extra event
  assert.deepStrictEqual(seen, ['prompt', 'denied', 'stale']);
});

t('#55 reconnect: grant works; cancel and refusal keep the project and select nothing else', async () => {
  const { context, publisher } = C.create();
  const h = handle('prompt');
  await publisher.select({ name: 'A', source: 'cartbuilder', handle: h });
  h.ask = 'cancel';
  assert.strictEqual((await publisher.reconnect()).access, 'prompt'); // cancellation can be retried
  h.fail = false; h.ask = 'denied';
  assert.strictEqual((await publisher.reconnect()).access, 'denied');
  assert.strictEqual(context.get().name, 'A');
  h.ask = 'granted';
  assert.strictEqual((await publisher.reconnect()).access, 'granted');
});

t('#55 after a reload only the remembered reference returns, never as granted without a query', async () => {
  const kv = memKv();
  const first = C.create({ kv });
  const h = handle('granted');
  await first.publisher.select({ name: 'A', source: 'cartbuilder', handle: h });
  assert.deepStrictEqual(Object.keys(kv.m.get(C.KEY)).sort(), ['handle', 'name', 'source']);
  h.perm = 'prompt'; // new page load: permission has lapsed
  const second = C.create({ kv });
  const events = [];
  second.context.subscribe((e) => events.push(e.type));
  const p = await second.publisher.restore();
  assert.strictEqual(p.access, 'prompt');
  assert.deepStrictEqual(events, ['select']);
  // storage failures and junk records are ignored
  const bad = C.create({ kv: { async get() { throw new Error('idb'); }, async set() {} } });
  assert.strictEqual((await bad.publisher.restore()).access, 'none');
  const junk = C.create({ kv: { async get() { return { foo: 1 }; }, async set() {} } });
  assert.strictEqual((await junk.publisher.restore()).access, 'none');
});

t('#55 restore never overrides a project a tool already selected', async () => {
  const kv = memKv();
  kv.m.set(C.KEY, { name: 'Old', source: 'cartbuilder', handle: handle() });
  const { context, publisher } = C.create({ kv });
  await publisher.select({ name: 'New', source: 'cartbuilder', handle: handle() });
  await publisher.restore();
  assert.strictEqual(context.get().name, 'New');
});

t('#55 several consumers are notified, one failing listener does not block others, snapshots are frozen', async () => {
  const { context, publisher } = C.create();
  let a = 0; let b = 0;
  context.subscribe(() => { throw new Error('listener bug'); });
  context.subscribe(() => a++);
  const off = context.subscribe(() => b++);
  const orig = console.error; console.error = () => {};
  let unsupported;
  try { await publisher.select({ name: 'A', source: 'x', handle: null }); off(); await publisher.clear(); unsupported = await publisher.select({ name: 'A', source: 'x' }); } finally { console.error = orig; }
  assert.strictEqual(a, 3);
  assert.strictEqual(b, 1);
  assert.throws(() => { 'use strict'; context.get().name = 'hack'; });
  assert.strictEqual(unsupported.access, 'unsupported');
});

t('#55 latest selection or clear wins over a delayed permission query, including reload', async () => {
  const kv = memKv();
  const { context, publisher } = C.create({ kv });
  let release;
  const slow = handle();
  slow.queryPermission = () => new Promise((resolve) => { release = resolve; });
  const old = publisher.select({ name: 'Old', source: 'cartbuilder', handle: slow });
  await publisher.select({ name: 'New', source: 'cartbuilder', handle: handle() });
  release('granted'); await old;
  assert.strictEqual(context.get().name, 'New');
  assert.strictEqual((await C.create({ kv }).publisher.restore()).name, 'New');
  const pending = publisher.select({ name: 'Cancelled', source: 'cartbuilder', handle: slow });
  await publisher.clear();
  release('granted'); await pending;
  assert.strictEqual(context.get().access, 'none');
  assert.strictEqual((await C.create({ kv }).publisher.restore()).access, 'none');
});

t('#55 delayed storage cannot restore an older project after a newer selection', async () => {
  const writes = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const kv = { async set(k, value) { if (value?.name === 'Old') await gate; writes.push(value); } };
  const { context, publisher } = C.create({ kv });
  const events = [];
  context.subscribe((e) => events.push(e.project.name));
  const old = publisher.select({ name: 'Old', source: 'cartbuilder', handle: handle() });
  await Promise.resolve(); await Promise.resolve();
  const next = publisher.select({ name: 'New', source: 'cartbuilder', handle: handle() });
  await Promise.resolve();
  release(); await Promise.all([old, next]);
  assert.deepStrictEqual(events, ['Old', 'New']);
  assert.strictEqual(writes.at(-1).name, 'New');
});

t('#68 a granted handle whose folder was moved or deleted is stale, on check and on reconnect', async () => {
  const gone = () => ({ name: 'demo', kind: 'directory', perm: 'granted', async queryPermission() { return this.perm; }, async requestPermission() { return 'granted'; },
    // the browser still grants the handle, but reading the folder fails
    async *entries() { throw Object.assign(new Error('A requested file or directory could not be found'), { name: 'NotFoundError' }); } });
  const { context, publisher } = C.create();
  await publisher.select({ name: 'demo', source: 'cartbuilder', handle: gone() });
  assert.strictEqual(context.get().access, 'stale', 'select');
  assert.strictEqual((await context.check()).access, 'stale', 'check');
  assert.strictEqual((await publisher.reconnect()).access, 'stale', 'reconnect');
  // an existing folder (one readable entry, or none) stays granted
  const here = { name: 'ok', kind: 'directory', async queryPermission() { return 'granted'; }, async *entries() { yield ['main.p8', {}]; } };
  await publisher.select({ name: 'ok', source: 'cartbuilder', handle: here });
  assert.strictEqual((await context.check()).access, 'granted');
  const empty = { name: 'empty', kind: 'directory', async queryPermission() { return 'granted'; }, async *entries() {} };
  await publisher.select({ name: 'empty', source: 'cartbuilder', handle: empty });
  assert.strictEqual((await context.check()).access, 'granted');
});

const assert = require('assert');
const { t } = require('./harness.js');
const C = require('../js/minifier-core.js');
const Engine = require('../js/minifier-engine.js');
const { source, engine, result } = require('./minifier-fixtures.js');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function rig() {
  const workers = [], timers = new Map(); let serial = 0;
  const adapter = Engine.create({ setTimer(fn) { timers.set(++serial, fn); return serial; }, clearTimer(id) { timers.delete(id); }, workerFactory() {
    const listeners = { message: new Set(), error: new Set(), messageerror: new Set() };
    const worker = { requests: [], terminated: false, listeners,
      addEventListener: (type, fn) => listeners[type].add(fn), removeEventListener: (type, fn) => listeners[type].delete(fn),
      terminate() { this.terminated = true; }, postMessage(message) { if (this.failSend) throw Error('cannot clone'); this.requests.push(message); },
      emit(type, data) { for (const fn of [...listeners[type]]) fn({ data }); },
      reply(request = this.requests.at(-1), extra = {}) {
        this.emit('message', { protocol: 1, requestId: request.requestId, ...(request.job ? { jobId: request.job.jobId, sourceRevision: request.job.sourceRevision, optionsRevision: request.job.optionsRevision } : {}), type: request.type === 'init' ? 'ready' : 'result', engine: engine(), ...(request.job ? { result: result() } : {}), ...extra });
      },
    };
    workers.push(worker); return worker;
  } });
  return { adapter, workers, timers };
}
async function initialized(r) {
  const p = r.adapter.initialize(); await flush(); r.workers.at(-1).reply(); await p;
}
async function running(r, text = 'cls()') {
  r.adapter.setSource(source(text)); await initialized(r);
  const p = r.adapter.optimize(); await flush(); return { p, worker: r.workers.at(-1) };
}
const failure = (p, code) => assert.rejects(p, (e) => e.code === code);

t('MIN-02 adapter stays lazy and shares initialization; a real ready response gates Optimize', async () => {
  const r = rig(), a = r.adapter;
  a.setSource(source()); a.setOptions({});
  assert.strictEqual(r.workers.length, 0);
  assert.strictEqual(C.describe(a.getState()).canOptimize, false);
  const p = a.initialize(); assert.strictEqual(a.initialize(), p);
  await flush(); assert.strictEqual(r.workers.length, 1);
  assert.strictEqual(r.workers[0].requests.length, 1);
  r.workers[0].reply(); await p;
  assert.ok(C.describe(a.getState()).canOptimize);
  assert.strictEqual(r.timers.size, 0); a.dispose();
});

t('MIN-02 explicit optimize captures before bootstrap; input changes during bootstrap never submit old source', async () => {
  const r = rig(), a = r.adapter;
  a.setSource(source('old()'));
  const rejected = failure(a.optimize(), 'E_STALE'); await flush();
  a.setSource(source('new()')); await rejected;
  const init = a.initialize(); r.workers[0].reply(); await init; await flush();
  assert.strictEqual(r.workers[0].requests.length, 1);
  assert.strictEqual(a.getState().source.files[0].text, 'new()');
  assert.strictEqual(a.getState().status, 'ready'); a.dispose();
});

t('MIN-02 source/options changes terminate active CPU work; retired callbacks cannot replace a newer result', async () => {
  for (const change of [(a) => a.setSource(source('new()')), (a) => a.setOptions({ target: 'characters' })]) {
    const r = rig(), a = r.adapter;
    const old = await running(r); const rejected = failure(old.p, 'E_STALE');
    const callback = [...old.worker.listeners.message][0], oldRequest = old.worker.requests.at(-1);
    change(a); await rejected;
    assert.ok(old.worker.terminated);
    assert.strictEqual(old.worker.listeners.message.size, 0);
    a.setOptions({ target: 'tokens' });
    await initialized(r); const current = a.optimize(); await flush();
    const newer = r.workers.at(-1); newer.reply(); const accepted = await current;
    const before = a.getState();
    callback({ data: { protocol: 1, type: 'error', requestId: oldRequest.requestId, ...oldRequest.job, result: { diagnostics: [{ code: 'E_OLD', message: 'late' }] } } });
    assert.strictEqual(a.getState(), before);
    assert.strictEqual(before.result, accepted); assert.ok(C.canExport(before));
    assert.notStrictEqual(accepted.job.jobId, oldRequest.job.jobId);
    assert.strictEqual(r.timers.size, 0); a.dispose();
  }
});

t('MIN-02 cancellation rejects immediately, terminates worker and permits a fresh explicit run', async () => {
  const r = rig(), a = r.adapter, old = await running(r);
  const late = [...old.worker.listeners.message][0], request = old.worker.requests.at(-1);
  const rejected = failure(old.p, 'E_CANCELLED'); assert.ok(a.cancel()); await rejected;
  assert.ok(old.worker.terminated); assert.strictEqual(a.getState().status, 'cancelled');
  assert.strictEqual(r.timers.size, 0);
  await initialized(r); const p = a.optimize(); await flush(); r.workers.at(-1).reply(undefined, { result: result(4, 4) }); await p;
  const current = a.getState();
  late({ data: { protocol: 1, type: 'result', requestId: request.requestId, ...request.job, engine: engine(), result: result() } });
  assert.strictEqual(a.getState(), current);
  assert.strictEqual(a.getState().status, 'unchanged'); assert.ok(C.canExport(a.getState()));
  assert.strictEqual(a.cancel(), false); assert.ok(C.canExport(a.getState())); a.dispose();
});

t('MIN-02 equivalent settings do not cancel a job, and simultaneous Optimize cannot overtake it', async () => {
  const r = rig(), a = r.adapter, run = await running(r);
  const before = a.getState(); a.setOptions({ profile: 'minimal' });
  assert.strictEqual(a.getState(), before); assert.strictEqual(run.worker.terminated, false);
  await failure(a.optimize(), 'E_BUSY'); run.worker.reply(); const accepted = await run.p;
  assert.ok(Object.isFrozen(accepted.job.files[0])); assert.ok(Object.isFrozen(accepted.metrics.original));
  a.setSource(source('later()')); assert.strictEqual(C.canExport(a.getState()), false); a.dispose();
});

t('MIN-02 malformed identities, protocol, engine versions and output fail closed with fresh-worker recovery', async () => {
  for (const extra of [{ jobId: 'wrong' }, { sourceRevision: -1 }, { protocol: 99 }, { engine: { ...engine(), pythonVersion: 'wrong' } }, { result: { ...result(), flags: [] } }]) {
    const r = rig(), a = r.adapter, run = await running(r);
    const rejected = assert.rejects(run.p);
    run.worker.reply(undefined, extra); await rejected;
    assert.strictEqual(a.getState().status, 'error'); assert.strictEqual(C.canExport(a.getState()), false);
    assert.ok(run.worker.terminated); assert.strictEqual(a.getState().enginePhase, 'cold');
    const retry = a.retry(); await flush(); r.workers.at(-1).reply(); await retry;
    assert.strictEqual(r.workers.length, 2); assert.strictEqual(r.workers[1].requests.length, 1); a.dispose();
  }
});

t('MIN-02 worker crashes, message errors and timeouts clear timers and can retry', async () => {
  for (const mode of ['error', 'messageerror', 'timeout']) {
    const r = rig(), a = r.adapter, run = await running(r);
    const rejected = assert.rejects(run.p);
    if (mode === 'timeout') [...r.timers.values()][0](); else run.worker.emit(mode);
    await rejected;
    assert.strictEqual(a.getState().status, 'error'); assert.ok(run.worker.terminated); assert.strictEqual(r.timers.size, 0);
    const retry = a.retry(); await flush(); r.workers.at(-1).reply(); await retry; a.dispose();
  }
});

t('MIN-02 crashes immediately after a reply cannot re-enable a dead worker or accept pending output', async () => {
  const r = rig(), a = r.adapter;
  const init = assert.rejects(a.initialize()); await flush();
  r.workers[0].reply(); r.workers[0].emit('error'); await init;
  assert.strictEqual(a.getState().enginePhase, 'cold');
  a.setSource(source()); await initialized(r);
  const p = assert.rejects(a.optimize()); await flush();
  r.workers[1].reply(); r.workers[1].emit('error'); await p;
  assert.strictEqual(a.getState().status, 'error'); assert.strictEqual(a.getState().result, null);
  assert.strictEqual(C.canExport(a.getState()), false); a.dispose();
});

t('MIN-02 startup asset errors and synchronous send failures leave a recoverable adapter', async () => {
  for (const mode of ['assets', 'send']) {
    const r = rig(), a = r.adapter;
    if (mode === 'assets') {
      const rejected = failure(a.initialize(), 'E_ENGINE_ASSETS'); await flush();
      r.workers[0].reply(undefined, { type: 'error', engine: undefined, result: { ok: false, diagnostics: [{ severity: 'error', code: 'E_ENGINE_ASSETS', message: 'Missing local assets.' }] } });
      await rejected;
    } else {
      await initialized(r); a.setSource(source()); r.workers[0].failSend = true;
      await failure(a.optimize(), 'E_WORKER_SEND');
    }
    assert.ok(r.workers[0].terminated);
    const retry = a.retry(); await flush(); r.workers.at(-1).reply(); await retry;
    a.dispose();
  }
});

t('MIN-02 source diagnostics stay plain and block current output; unsupported file maps never reach optimize', async () => {
  const r = rig(), a = r.adapter, run = await running(r);
  const rejected = failure(run.p, 'E_PARSE');
  run.worker.reply(undefined, { type: 'error', result: { ok: false, diagnostics: [{ severity: 'error', code: 'E_PARSE', message: '<script>plain text</script>', file: 'demo.lua', line: 1, column: 7 }] } }); await rejected;
  assert.strictEqual(a.getState().diagnostics[0].column, 7); assert.strictEqual(a.getState().status, 'error');
  assert.strictEqual(run.worker.terminated, false);
  a.setSource({ ...source(), files: [...source().files, { path: 'other.lua', text: 'flip()' }] });
  await failure(a.optimize(), 'E_INCLUDE_UNSUPPORTED');
  assert.strictEqual(a.getState().status, 'unsupported');
  assert.strictEqual(run.worker.requests.filter((q) => q.type === 'optimize').length, 1); a.dispose();
});

t('MIN-02 Retry during bootstrap ignores saved old callbacks and dispose is terminal', async () => {
  const r = rig(), a = r.adapter;
  const old = failure(a.initialize(), 'E_CANCELLED'); await flush();
  const worker = r.workers[0], callback = [...worker.listeners.message][0], request = worker.requests[0];
  const retry = a.retry(); await old; await flush();
  callback({ data: { protocol: 1, type: 'ready', requestId: request.requestId, engine: engine() } });
  assert.strictEqual(a.getState().enginePhase, 'loading');
  r.workers[1].reply(); await retry;
  a.setSource(source()); const pending = failure(a.optimize(), 'E_DISPOSED'); await flush(); a.dispose(); await pending;
  const s = a.getState(); callback({ data: {} }); assert.strictEqual(a.getState(), s);
  assert.throws(() => a.setSource(source()), (e) => e.code === 'E_DISPOSED'); assert.strictEqual(r.timers.size, 0);
});

t('MIN-02 observers cannot break cleanup and can invalidate a start before source is sent', async () => {
  const r = rig(), a = r.adapter;
  a.subscribe(() => { throw Error('render failure'); });
  a.setSource(source()); await initialized(r);
  const off = a.subscribe((s) => { if (s.status === 'running') a.setSource(source('new()')); });
  await failure(a.optimize(), 'E_STALE');
  assert.strictEqual(r.workers[0].requests.length, 1);
  off(); a.dispose();
});

t('MIN-11 optional PNG replies are identity-bound; failure/stale output keeps text results safe', async () => {
  const fs = require('fs'), path = require('path'), K = require('../js/code-core.js');
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/minifier/release/representative.min.p8.png'));
  const png = { ok: true, base64: bytes.toString('base64'), pngBytes: bytes.length, compressedBytes: 136, compressedBudgetExclusive: 15360, codeRegionBytes: 15616, width: 160, height: 205 };
  const r = rig(), a = r.adapter;
  const text = K.NEW_CART + 'cls()\n';
  a.setSource({ kind: 'p8', entryPath: 'cart.p8', files: [{ path: 'cart.p8', text }] });
  const init = a.initialize(); await flush(); r.workers.at(-1).reply(undefined, { engine: { ...engine(), capabilities: { ...engine().capabilities, png: true } } }); await init;
  let run = a.optimize(); await flush(); r.workers.at(-1).reply(undefined, { result: { ...result(), cartText: text } }); await run;
  const state = a.getState();
  let pending = a.exportPng(text); await flush(); assert.strictEqual(r.workers.at(-1).requests.at(-1).type, 'png');
  r.workers.at(-1).reply(undefined, { type: 'png', result: png }); assert.strictEqual((await pending).pngBytes, bytes.length); assert.strictEqual(a.getState(), state);
  pending = a.exportPng(text); const invalid = failure(pending, 'E_PNG_INVALID'); await flush();
  r.workers.at(-1).reply(undefined, { type: 'png', result: { ...png, pngBytes: png.pngBytes + 1 } }); await invalid;
  assert.strictEqual(a.getState(), state);
  pending = a.exportPng(text); const refused = failure(pending, 'E_PNG_CAPACITY'); await flush();
  r.workers.at(-1).reply(undefined, { type: 'error', result: { diagnostics: [{ severity: 'error', code: 'E_PNG_CAPACITY', message: 'PNG capacity exceeded' }] } }); await refused;
  assert.strictEqual(a.getState(), state); assert.ok(C.canExport(a.getState()));
  pending = a.exportPng(text); const stale = failure(pending, 'E_EXPORT_STALE'); await flush();
  const worker = r.workers.at(-1); a.setSource(source('newer()')); worker.reply(undefined, { type: 'png', result: png }); await stale;
  assert.strictEqual(C.canExport(a.getState()), false);
  a.setSource({ kind: 'p8', entryPath: 'cart.p8', files: [{ path: 'cart.p8', text }] });
  run = a.optimize(); await flush(); r.workers.at(-1).reply(undefined, { result: { ...result(), cartText: text } }); await run;
  pending = a.exportPng(text); const cancelled = failure(pending, 'E_CANCELLED'); await flush();
  assert.ok(a.cancel(), 'navigation/cancel must stop an active PNG request'); await cancelled;
  assert.ok(r.workers.at(-1).terminated); assert.strictEqual(a.getState().status, 'cancelled'); a.dispose();
});

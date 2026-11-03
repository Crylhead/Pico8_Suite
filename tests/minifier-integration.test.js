// Combined source-bridge -> dependency resolver -> adapter -> exporter contracts.
// Transport replies are pinned real-engine fixtures, not runtime execution in Node.
// test_minifier_native.py verifies those fixtures when the packaged engine is available.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const C = require('../js/minifier-core.js');
const K = require('../js/code-core.js');
const P = require('../js/minifier-project-core.js');
const Engine = require('../js/minifier-engine.js');
const Export = require('../js/minifier-export-core.js');
const goldens = require('./fixtures/minifier/release/engine-results.json');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function transport() {
  const workers = [];
  const adapter = Engine.create({ workerFactory() {
    const listeners = {}, requests = [];
    const worker = {
      requests, terminated: false,
      addEventListener(type, fn) { listeners[type] = fn; },
      removeEventListener(type) { delete listeners[type]; },
      terminate() { this.terminated = true; },
      postMessage(request) {
        requests.push(request);
        if (request.type === 'init') queueMicrotask(() => listeners.message?.({ data: { protocol: 1, requestId: request.requestId, type: 'ready', engine: goldens.engine } }));
      },
      capture(result) {
        const request = requests.at(-1), receive = listeners.message;
        return () => receive({ data: { protocol: 1, requestId: request.requestId, type: 'result', engine: goldens.engine,
          jobId: request.job.jobId, sourceRevision: request.job.sourceRevision, optionsRevision: request.job.optionsRevision, result } });
      },
      crash() { listeners.error?.({}); },
    };
    workers.push(worker); return worker;
  } });
  return { adapter, workers };
}
const prepared = (adapter) => ({ ...C.prepareInput(adapter.getState().source), sourceRevision: adapter.getState().sourceRevision });
async function finish(rig, fixture) {
  await rig.adapter.initialize();
  const promise = rig.adapter.optimize(); await flush();
  rig.workers.at(-1).capture(fixture.result)(); await promise;
}

t('MIN-10 combined dirty editor snapshots resolve into pinned jobs and validated build copies', async () => {
  for (const fixture of goldens.cases) {
    const { source } = fixture, file = source.files.find((f) => f.path === source.entryPath);
    for (const f of source.files) assert.strictEqual(f.text, fs.readFileSync(path.join(__dirname, 'fixtures/minifier', fixture.name === 'project' ? 'project' : '', f.path), 'utf8'), 'recorded source must match the authoring fixture');
    const parts = K.splitCart(file.text), text = source.kind === 'p8' ? parts.lua : file.text;
    const editor = { ready: true, doc: {}, loc: {}, name: source.entryPath, parts, text, savedLua: '-- previous version', selection: { start: 2, end: 5, top: 8 } };
    const bridge = K.createSourceBridge({ read: () => editor, focus() {}, project: (snapshot) => P.resolve(snapshot.source, {
      names: source.files.map((f) => f.path), read: async (name) => source.files.find((f) => f.path === name)?.text,
    }) });
    const capture = bridge.getSnapshot(); assert.ok(capture.dirty);
    const resolved = await bridge.getProjectSnapshot(capture);
    assert.deepStrictEqual(resolved.source, source);
    const rig = transport();
    try {
      rig.adapter.setSource(resolved.source); await finish(rig, fixture);
      const state = rig.adapter.getState(), artifact = Export.build(state, prepared(rig.adapter));
      assert.strictEqual(state.result.job.profile, 'minimal'); assert.strictEqual(state.result.job.target, 'tokens');
      assert.deepStrictEqual(state.result.flags, C.FLAGS);
      assert.strictEqual(artifact.lua.text, fixture.result.lua);
      assert.notStrictEqual(artifact.lua.filename, source.entryPath.split('/').at(-1));
      if (source.kind === 'p8') {
        const original = C.prepareInput(source).original.cart, exported = C.prepareInput({ kind: 'p8', entryPath: artifact.cart.filename, files: [{ path: artifact.cart.filename, text: artifact.cart.text }] });
        assert.strictEqual(exported.original.cart.header, original.header);
        assert.strictEqual(exported.original.cart.nonLua, original.nonLua);
        if (fixture.name === 'representative') assert.strictEqual(artifact.cart.text, fs.readFileSync(path.join(__dirname, 'fixtures/minifier/release/representative.min.p8'), 'utf8'));
      } else assert.strictEqual(artifact.cart, null);
      if (fixture.name === 'project') assert.ok(artifact.warnings.length && resolved.edges.length > source.files.length - 1);
      assert.deepStrictEqual(bridge.getSnapshot(), capture, 'build must not change editor source, selection or save identity');
    } finally { rig.adapter.dispose(); }
  }
});

t('MIN-10 delayed retired jobs cannot export over newer output; crash/retry cannot revive it', async () => {
  const rig = transport(), [lua, cart] = goldens.cases;
  try {
    rig.adapter.setSource(cart.source); await rig.adapter.initialize();
    const pending = rig.adapter.optimize(); const rejected = assert.rejects(pending, (e) => e.code === 'E_STALE'); await flush();
    const oldWorker = rig.workers.at(-1), late = oldWorker.capture(cart.result);
    rig.adapter.setSource(lua.source); await rejected; assert.ok(oldWorker.terminated);
    await finish(rig, lua); const state = rig.adapter.getState(), input = prepared(rig.adapter);
    late(); assert.strictEqual(rig.adapter.getState(), state); assert.strictEqual(Export.build(state, input).lua.text, lua.result.lua);
    rig.workers.at(-1).crash(); assert.strictEqual(Export.inspect(rig.adapter.getState(), input).ok, false);
    assert.deepStrictEqual(rig.adapter.getState().source, lua.source);
    await rig.adapter.retry(); assert.deepStrictEqual(rig.workers.at(-1).requests.map((r) => r.type), ['init']);
    assert.strictEqual(Export.inspect(rig.adapter.getState(), input).ok, false);
    await finish(rig, lua); assert.ok(Export.inspect(rig.adapter.getState(), prepared(rig.adapter)).ok);
    rig.adapter.setOptions({ target: 'characters' }); assert.strictEqual(Export.inspect(rig.adapter.getState(), input).ok, false);
  } finally { rig.adapter.dispose(); }
});

t('MIN-10 a successful worker envelope with corrupted cart data is refused at the export boundary', async () => {
  const fixture = goldens.cases.find((f) => f.name === 'representative'), rig = transport();
  try {
    rig.adapter.setSource(fixture.source);
    const corrupted = { ...fixture, result: { ...fixture.result, cartText: fixture.result.cartText.replace('__map__\n0001', '__map__\n0101') } };
    assert.notStrictEqual(corrupted.result.cartText, fixture.result.cartText, 'corruption fixture must change a real data byte');
    await finish(rig, corrupted); assert.ok(C.canExport(rig.adapter.getState()));
    assert.strictEqual(Export.inspect(rig.adapter.getState(), prepared(rig.adapter)).code, 'E_EXPORT_PRESERVATION');
    await finish(rig, fixture); assert.ok(Export.inspect(rig.adapter.getState(), prepared(rig.adapter)).ok);
  } finally { rig.adapter.dispose(); }
});

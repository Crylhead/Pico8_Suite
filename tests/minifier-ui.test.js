const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const UI = require('../js/minifier.js');
const Engine = require('../js/minifier-engine.js');
const { source, engine, result } = require('./minifier-fixtures.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const markup = html.slice(html.indexOf('<main class="layout-minifier"'), html.indexOf('</main>', html.indexOf('<main class="layout-minifier"')));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function fixture(wide = true, protocol, io = {}) {
  const nodes = new Map(), actions = {}, workers = [], dialogs = [], created = [];
  const doc = { activeElement: null, createElement: () => node(), querySelectorAll(selector) { return [...nodes.values()].filter((n) => n.action && selector.includes(`"${n.action}"`)); } };
  function node(id) {
    return { id, dataset: {}, attrs: {}, listeners: {}, disabled: false, hidden: false, value: '', textContent: '', children: [], ownerDocument: doc,
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type) { delete this.listeners[type]; },
      replaceChildren(...children) { this.children = children; }, contains(other) { return this === other || this.children.includes(other); },
      focus() { doc.activeElement = this; }, closest() { return this; }, querySelectorAll() { return this.children; } };
  }
  for (const m of markup.matchAll(/<[^>]+\sid="([^"]+)"[^>]*>/g)) {
    const n = node(m[1]); n.disabled = /\sdisabled\b/.test(m[0]); n.action = /data-action="([^"]+)"/.exec(m[0])?.[1]; nodes.set(n.id, n);
  }
  for (const [id, values] of [['mnProfile', ['minimal', 'safe', 'aggressive']], ['mnCompareMode', ['compare', 'original', 'optimized']]]) {
    nodes.get(id).children = values.map((value) => Object.assign(node(), { dataset: { value } }));
  }
  for (const side of ['Source', 'Output']) nodes.get(`mn${side}Pane`).children.push(nodes.get(`mn${side}Code`));
  const root = node('root'); root.querySelector = (selector) => { const n = nodes.get(selector.slice(1)); assert.ok(n, selector); return n; };
  const media = { matches: wide, addEventListener(_, fn) { this.change = fn; }, removeEventListener() { this.change = null; } };
  const adapter = Engine.create({ workerFactory() {
    if (protocol === 'file:') return require('../js/minifier-worker-host.js').create({ protocol });
    const listeners = {};
    const w = { requests: [], addEventListener(type, fn) { listeners[type] = fn; }, removeEventListener(type) { delete listeners[type]; }, terminate() { this.terminated = true; },
      postMessage(message) { this.requests.push(message); },
      reply(extra = {}) { const req = this.requests.at(-1); listeners.message({ data: { protocol: 1, requestId: req.requestId, type: req.type === 'init' ? 'ready' : 'result', engine: engine(), ...(req.job ? { jobId: req.job.jobId, sourceRevision: req.job.sourceRevision, optionsRevision: req.job.optionsRevision, result: result() } : {}), ...extra } }); } };
    workers.push(w); return w;
  } });
  const app = { registerActions(more) { Object.assign(actions, more); },
    el(tag, props = {}, ...children) { const n = Object.assign(node(props.id), props, { tag, children }); created.push(n); return n; },
    modal(options) { return new Promise((resolve) => { const d = { ...options, finish: resolve }; dialogs.push(d); options.onOpen?.(d); }); },
    pickFile: async () => null, confirmDialog: async () => true, ...io };
  const view = UI.mount({ root, adapter, media, protocol, app });
  return { view, adapter, nodes, actions, root, workers, media, doc, dialogs, created, $: (id) => nodes.get(id),
    async initialize() { const p = view.initialize(); await flush(); workers.at(-1).reply(); await p; },
    async finish(extra) { const p = actions['mn-optimize'](); await flush(); workers.at(-1).reply(extra); await p; },
  };
}

t('MIN-03 shell uses the real adapter, remains lazy and requires explicit ready + Optimize', async () => {
  const f = fixture();
  f.view.load(source()); assert.strictEqual(f.workers.length, 0);
  assert.ok(f.$('mnOptimize').disabled); assert.ok(/Load the engine/.test(f.$('mnStatus').textContent));
  await f.initialize();
  assert.strictEqual(f.$('mnOptimize').disabled, false);
  assert.strictEqual(f.workers[0].requests.length, 1);
  const p = f.actions['mn-optimize'](); await flush();
  assert.strictEqual(f.root.dataset.state, 'running'); assert.ok(f.$('mnOptimize').disabled); assert.ok(f.$('mnTarget').disabled);
  assert.strictEqual(f.$('mnCancel').disabled, false); assert.strictEqual(f.$('mnOptimize').attrs['aria-busy'], 'true');
  f.workers[0].reply(); await p;
  assert.match(f.$('mnOutputState').textContent, /Current result/);
  assert.strictEqual(f.$('mnTokensBefore').textContent, '4'); assert.strictEqual(f.$('mnTokensAfter').textContent, '3');
  assert.strictEqual(f.$('mnBytesBefore').textContent, '—'); assert.match(f.$('mnBytesBefore').attrs['aria-label'], /Not emitted/);
  for (const id of ['mnUseEditor', 'mnCopy', 'mnDownload']) assert.ok(f.$(id).disabled, id);
  f.view.dispose();
});

t('MIN-03 changing code views and responsive defaults preserves source, output, selection and explicit mode', async () => {
  const f = fixture(); await f.initialize(); f.view.load(source()); await f.finish();
  const original = f.view.getState();
  f.$('mnOutputCode').selectionStart = 2;
  f.$('mnOutputCode').focus();
  f.media.matches = false; f.media.change();
  assert.strictEqual(f.$('mnOutputPane').hidden, true); assert.strictEqual(f.doc.activeElement.dataset.value, 'original');
  f.view.setMode('optimized');
  assert.ok(f.$('mnSourcePane').hidden); assert.strictEqual(f.$('mnOutputPane').hidden, false);
  f.media.matches = true; f.media.change();
  assert.strictEqual(f.$('mnCodeViews').dataset.mode, 'optimized');
  f.actions['mn-view-compare']();
  assert.strictEqual(f.$('mnSourcePane').hidden, false); assert.strictEqual(f.$('mnOutputPane').hidden, false);
  assert.strictEqual(f.$('mnOutputCode').selectionStart, 2); assert.strictEqual(f.view.getState(), original);
  assert.strictEqual(f.workers[0].requests.length, 2); f.view.dispose();
  const phone = fixture(false); assert.strictEqual(phone.$('mnCodeViews').dataset.mode, 'original'); phone.view.dispose();
});

t('MIN-03 source changes mark prior output and measurements stale, including during a new job', async () => {
  const f = fixture(); await f.initialize(); f.view.load(source()); await f.finish();
  const p = f.actions['mn-optimize'](); await flush(); f.view.load(source('flip()')); await p;
  assert.match(f.$('mnOutputState').textContent, /Stale result/); assert.match(f.$('mnMetricsState').textContent, /Stale measurements/);
  assert.strictEqual(f.$('mnOutputCode').value, 'cls()'); assert.strictEqual(f.$('mnSourceCode').value, 'flip()');
  assert.ok(f.$('mnOptimize').disabled); assert.strictEqual(f.$('mnRetry').hidden, false); assert.ok(f.workers[0].terminated);
  f.view.dispose();
});

t('MIN-03 startup failures are visible plain text; Retry loads a new engine without optimizing', async () => {
  const f = fixture(), message = '<img src=x> Missing local runtime; use a localhost server.';
  f.view.load(source()); const p = f.view.initialize(); await flush();
  f.workers[0].reply({ type: 'error', result: { diagnostics: [{ severity: 'error', code: 'E_ENGINE_ASSETS', message }] } }); await p;
  assert.strictEqual(f.root.dataset.state, 'error'); assert.ok(f.$('mnOptimize').disabled);
  assert.ok(f.$('mnStatus').textContent.includes(message)); assert.ok(f.$('mnDiagnosticList').children[0].textContent.includes(message));
  assert.strictEqual(f.$('mnStatus').dataset.tone, 'error'); assert.strictEqual(f.$('mnRetry').disabled, false);
  const retry = f.actions['mn-retry'](); await flush(); f.workers[1].reply(); await retry;
  assert.ok(f.workers[0].terminated); assert.strictEqual(f.workers[1].requests.length, 1); assert.strictEqual(f.root.dataset.state, 'ready');
  await f.finish({ result: result(4, 4) }); assert.match(f.$('mnStatus').textContent, /No token savings/);
  f.view.dispose();
});

t('MIN-03 cancellation is explicit, leaves source intact and releases presenter subscriptions', async () => {
  const f = fixture(); await f.initialize(); f.view.load(source());
  const p = f.actions['mn-optimize'](); await flush(); f.view.cancel(); await p;
  assert.strictEqual(f.root.dataset.state, 'cancelled'); assert.match(f.$('mnStatus').textContent, /cancelled/);
  assert.strictEqual(f.$('mnSourceCode').value, 'cls()'); assert.ok(f.$('mnOptimize').disabled);
  f.view.dispose(); assert.strictEqual(f.media.change, null); assert.strictEqual(f.$('mnCompareMode').listeners.click, undefined);
});

t('#134 file launch shows setup rather than a failed job, suppresses futile Retry and retains input', async () => {
  const f = fixture(true, 'file:');
  assert.strictEqual(f.$('mnLocalSetup').hidden, false);
  f.view.load(source()); await f.view.initialize();
  assert.strictEqual(f.view.getState().status, 'unsupported');
  assert.strictEqual(f.workers.length, 0); assert.ok(f.$('mnRetry').disabled); assert.ok(f.$('mnOptimize').disabled);
  assert.match(f.$('mnStatus').textContent, /Local setup required/); assert.doesNotMatch(f.$('mnStatus').textContent, /failed/);
  await f.actions['mn-retry']();
  f.view.load(source('flip()')); // A different input cannot repair the hosting origin.
  assert.strictEqual(f.$('mnLocalSetup').hidden, false); assert.ok(f.$('mnRetry').disabled);
  assert.strictEqual(f.$('mnSourceCode').value, 'flip()'); f.view.dispose();
});

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const file = (name, text) => ({ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

t('MIN-04 picker Cancel, read/encoding/format failure and declined replacement keep exact current state', async () => {
  let next, confirmations = 0;
  const f = fixture(true, undefined, { pickFile: async () => next, confirmDialog: async () => { confirmations++; return false; } });
  await f.initialize(); f.view.load(source()); await f.finish();
  const before = f.view.getState(), original = f.view.getInput().original;
  const unsupported = { name: 'cart.png', arrayBuffer: () => { throw Error('must not read'); } };
  for (next of [null, { name: 'bad.lua', arrayBuffer: async () => { throw Error('read denied'); } }, file('empty.lua', '  '), file('bad.p8', 'not a cart'), { name: 'bad.lua', arrayBuffer: async () => new Uint8Array([255]) }, unsupported, file('other.lua', 'flip()')]) {
    await f.actions['mn-open']();
    assert.strictEqual(f.view.getState(), before); assert.strictEqual(f.view.getInput().original, original);
    assert.strictEqual(f.$('mnOutputCode').value, 'cls()');
  }
  assert.strictEqual(confirmations, 1); assert.strictEqual(f.workers[0].requests.length, 2); f.view.dispose();
});

t('MIN-04 accepted input is a frozen unsaved snapshot, never a file handle, and import does not optimize', async () => {
  const raw = 'print("♥")\r\n';
  const f = fixture(true, undefined, { pickFile: async () => file('fresh.lua', raw) });
  await f.initialize(); await f.actions['mn-open']();
  assert.strictEqual(f.$('mnSourceCode').value, 'print("♥")\n'); assert.strictEqual(f.$('mnProvenance').textContent, 'Local file');
  assert.strictEqual(f.view.getInput().original.text, raw); assert.strictEqual(f.view.getState().source.files[0].text, raw);
  assert.match(f.$('mnSourceStorage').textContent, /not saved/); assert.ok(Object.isFrozen(f.view.getInput().original));
  assert.strictEqual(f.view.getInput().sourceRevision, f.view.getState().sourceRevision);
  assert.strictEqual(f.workers[0].requests.length, 1); assert.strictEqual(f.$('mnOptimize').disabled, false);
  assert.deepStrictEqual(Object.keys(f.view.getState().source.files[0]).sort(), ['path', 'text']); f.view.dispose();
});

t('MIN-04 newer input, programmatic replacement and cancellation reject late reads without mutating results', async () => {
  let next;
  const f = fixture(true, undefined, { pickFile: async () => next });
  f.view.load(source()); const read = deferred();
  next = { name: 'old.lua', arrayBuffer: () => read.promise };
  const old = f.actions['mn-open'](); await flush();
  next = file('new.lua', 'flip()'); await f.actions['mn-open']();
  const state = f.view.getState(); read.resolve(new TextEncoder().encode('old()')); await old;
  assert.strictEqual(f.view.getState(), state); assert.strictEqual(f.$('mnSourceCode').value, 'flip()');
  for (const cancel of [() => f.actions['mn-cancel'](), () => f.view.load(source('external()'))]) {
    const pending = deferred(); next = { name: 'late.lua', arrayBuffer: () => pending.promise };
    const p = f.actions['mn-open'](); await flush(); cancel(); const kept = f.view.getState();
    pending.resolve(new TextEncoder().encode('late()')); await p; assert.strictEqual(f.view.getState(), kept);
  }
  f.view.dispose();
});

t('MIN-04 a result completed during replacement confirmation is never discarded under an old consent', async () => {
  const consent = deferred();
  const f = fixture(true, undefined, { pickFile: async () => file('new.lua', 'flip()'), confirmDialog: () => consent.promise });
  await f.initialize(); f.view.load(source()); const run = f.actions['mn-optimize'](); await flush();
  const incoming = f.actions['mn-open'](); await flush(); f.workers[0].reply(); await run;
  const completed = f.view.getState(); consent.resolve(true); await incoming;
  assert.strictEqual(f.view.getState(), completed); assert.match(f.$('mnInputStatus').textContent, /changed while confirming/); f.view.dispose();
});

t('MIN-04 paste uses a labelled modal, keeps invalid/empty text there and commits only confirmed input', async () => {
  const f = fixture();
  const p = f.actions['mn-paste']();
  const dialog = f.dialogs.at(-1), text = f.created.find((n) => n.id === 'mnPasteText');
  const problem = f.created.find((n) => n.id === 'mnPasteError'); assert.strictEqual(problem.hidden, true);
  assert.strictEqual(dialog.title, 'Paste Lua'); assert.strictEqual(f.doc.activeElement, text);
  const load = dialog.buttons[1]; text.value = '  ';
  assert.strictEqual(load.validate(), false); assert.strictEqual(text.attrs['aria-invalid'], 'true'); assert.strictEqual(problem.hidden, false); assert.strictEqual(f.view.getState().source, null);
  text.value = 'print("♥")'; assert.ok(load.validate()); assert.strictEqual(problem.hidden, true); dialog.finish(load.value()); await p;
  assert.strictEqual(f.$('mnProvenance').textContent, 'Pasted Lua'); assert.strictEqual(f.view.getState().source.entryPath, 'pasted.lua');
  const before = f.view.getState(); const cancel = f.actions['mn-paste'](); f.dialogs.at(-1).finish(null); await cancel;
  assert.strictEqual(f.view.getState(), before); assert.strictEqual(f.workers.length, 0); f.view.dispose();
});

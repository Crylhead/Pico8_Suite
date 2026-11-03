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

function editorFixture() {
  const K = require('../js/code-core.js');
  const state = { ready: true, doc: {}, loc: {}, name: 'edited.lua', parts: K.splitCart('cls()'), text: 'cls() --dirty', savedLua: 'cls()', selection: { start: 2, end: 4 } };
  let focused = 0, subscriptions = 0;
  const bridge = K.createSourceBridge({ read: () => state, focus: () => focused++ });
  const source = { ...bridge, subscribe(fn) { subscriptions++; const off = bridge.subscribe(fn); return () => { subscriptions--; off(); }; } };
  return { state, source, get focused() { return focused; }, get subscriptions() { return subscriptions; } };
}

function fixture(wide = true, protocol, io = {}) {
  const nodes = new Map(), actions = {}, workers = [], dialogs = [], created = [];
  const doc = { activeElement: null, createElement: () => node(), querySelectorAll(selector) { return [...nodes.values()].filter((n) => n.action && selector.includes(`"${n.action}"`)); } };
  function node(id) {
    return { id, dataset: {}, attrs: {}, listeners: {}, disabled: false, hidden: false, value: '', textContent: '', children: [], ownerDocument: doc,
      setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(type, fn) { this.listeners[type] = fn; }, removeEventListener(type) { delete this.listeners[type]; },
      replaceChildren(...children) { this.children = children; }, contains(other) { return this === other || this.children.includes(other); },
      append(...children) { this.children.push(...children); }, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
      focus() { doc.activeElement = this; }, closest() { return this; }, querySelectorAll() { return this.children; } };
  }
  for (const m of markup.matchAll(/<[^>]+\sid="([^"]+)"[^>]*>/g)) {
    const n = node(m[1]); n.disabled = /\sdisabled\b/.test(m[0]); n.action = /data-action="([^"]+)"/.exec(m[0])?.[1]; nodes.set(n.id, n);
  }
  for (const [id, values] of [['mnProfile', ['minimal', 'safe', 'aggressive']], ['mnCompareMode', ['compare', 'original', 'optimized']], ['mnDiagnosticFilter', ['all', 'error', 'warning', 'info']]]) {
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
      reply(extra = {}) { return this.captureReply(extra)(); },
      captureReply(extra = {}) { const req = this.requests.at(-1), receive = listeners.message; return () => receive({ data: { protocol: 1, requestId: req.requestId, type: req.type === 'init' ? 'ready' : 'result', engine: engine(), ...(req.job ? { jobId: req.job.jobId, sourceRevision: req.job.sourceRevision, optionsRevision: req.job.optionsRevision, result: result() } : {}), ...extra } }); } };
    workers.push(w); return w;
  } });
  const app = { registerActions(more) { Object.assign(actions, more); },
    el(tag, props = {}, ...children) { const n = Object.assign(node(props.id), props, { tag, children }); created.push(n); return n; },
    modal(options) { return new Promise((resolve) => { const d = { ...options, finish: resolve }; dialogs.push(d); options.onOpen?.(d); }); },
    pickFile: async () => null, confirmDialog: async () => true, ...io };
  const view = UI.mount({ root, adapter, media, protocol, app, editorSource: io.editorSource, clipboard: io.clipboard });
  return { view, adapter, nodes, actions, root, workers, media, doc, dialogs, created, $: (id) => nodes.get(id),
    async initialize(extra) { const p = view.initialize(); await flush(); workers.at(-1).reply(extra); await p; },
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
  assert.ok(f.$('mnUseEditor').disabled);
  for (const id of ['mnCopy', 'mnDownload']) assert.strictEqual(f.$(id).disabled, false, id);
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

t('MIN-05 displays valid zero savings, token increases, over-budget counts and visible unavailable reasons', async () => {
  const f = fixture(); await f.initialize(); f.view.load(source());
  await f.finish({ result: result(4, 4) });
  assert.strictEqual(f.$('mnTokensChange').textContent, '0 (0%)'); assert.match(f.$('mnStatus').textContent, /No token savings/);
  assert.strictEqual(f.$('mnBytesChange').textContent, '—'); assert.match(f.$('mnMetricReasons').textContent, /Not emitted/);
  await f.finish({ result: result(4, 5) });
  assert.strictEqual(f.$('mnTokensChange').textContent, 'Increased by 1 (25%)'); assert.strictEqual(f.$('mnStatus').dataset.tone, 'warn');
  const oversized = result(9000, 8500); oversized.metrics.optimized.characters = 65536;
  await f.finish({ result: oversized });
  assert.strictEqual(f.$('mnTokensAfterLimit').textContent, 'Over limit by 308'); assert.strictEqual(f.$('mnCharsAfterLimit').textContent, 'Over limit by 1');
  assert.match(f.$('mnStatus').textContent, /over the code budget/);
  f.view.load(source('flip()')); assert.match(f.$('mnMetricsState').textContent, /Stale measurements/); assert.strictEqual(f.$('mnTokensAfter').textContent, '8500');
  f.view.dispose();
});

t('MIN-05 diagnostics filter plain data and select only the exact current snapshot; old callbacks cannot navigate', async () => {
  const f = fixture(); await f.initialize(); f.view.load(source('print("♥")\nlocal = 1', 'demo.lua'));
  const run = f.actions['mn-optimize'](); await flush();
  f.workers[0].reply({ type: 'error', result: { diagnostics: [
    { severity: 'error', code: 'E_TEST', message: '<img src=x> literal', file: 'demo.lua', line: 2, column: 7 },
    { severity: 'warning', code: 'W_TEST', message: 'warning', file: 'other.lua', line: 1 },
    { severity: 'info', code: 'I_TEST', message: 'info', file: 'demo.lua', line: 999 },
  ] } }); await run;
  const items = f.$('mnDiagnosticList').children;
  assert.ok(items[0].textContent.includes('<img src=x>')); assert.strictEqual(items[0].children[0].type, 'button');
  assert.strictEqual(items[1].children[0].type, undefined); assert.strictEqual(items[2].children[0].type, undefined);
  const location = items[0].children[0]; f.view.setMode('optimized'); location.listeners.click();
  assert.strictEqual(f.$('mnCodeViews').dataset.mode, 'original'); assert.strictEqual(f.doc.activeElement, f.$('mnSourceCode'));
  assert.strictEqual(f.$('mnSourceCode').value.slice(f.$('mnSourceCode').selectionStart, f.$('mnSourceCode').selectionEnd), 'local = 1');
  for (const severity of ['error', 'warning', 'info']) {
    const b = f.$('mnDiagnosticFilter').children.find((b) => b.dataset.value === severity);
    f.$('mnDiagnosticFilter').listeners.click({ target: b });
    assert.strictEqual(f.$('mnDiagnosticList').children.length, 1); assert.ok(f.$('mnDiagnosticList').children[0].textContent.startsWith(severity));
  }
  f.view.load(source('new()')); f.view.setMode('optimized'); const focus = f.doc.activeElement;
  location.listeners.click(); assert.strictEqual(f.$('mnCodeViews').dataset.mode, 'optimized'); assert.strictEqual(f.doc.activeElement, focus);
  f.view.dispose();
});

t('MIN-06 handoff captures dirty live source, asks before replacement and returns without editing', async () => {
  const e = editorFixture(), workspaces = [];
  const f = fixture(true, undefined, { editorSource: e.source, setWorkspace: (ws) => workspaces.push(ws), confirmDialog: async () => false });
  await f.initialize(); const identity = e.source.getSnapshot().identity;
  assert.strictEqual(await f.view.useEditor({ navigate: true }), true);
  assert.deepStrictEqual(workspaces, ['minifier']); assert.strictEqual(e.subscriptions, 1);
  assert.strictEqual(f.$('mnSourceCode').value, e.state.text); assert.match(f.$('mnProvenance').textContent, /From Code Editor.*Unsaved changes/);
  assert.strictEqual(f.view.getInput().editor.identity, identity); assert.strictEqual(f.$('mnReturn').hidden, false);
  await f.finish(); f.actions['mn-return-editor']();
  assert.deepStrictEqual(workspaces, ['minifier', 'code']); assert.strictEqual(e.focused, 1);
  assert.ok(e.source.isCurrent(identity)); assert.strictEqual(e.state.savedLua, 'cls()'); assert.deepStrictEqual(e.state.selection, { start: 2, end: 4 });
  const kept = f.view.getState();
  for (let i = 0; i < 3; i++) assert.strictEqual(await f.actions['mn-use-editor'](), false);
  assert.strictEqual(f.view.getState(), kept); assert.strictEqual(e.subscriptions, 1); assert.strictEqual(f.workers.length, 1);
  f.view.dispose(); assert.strictEqual(e.subscriptions, 0);
});

t('MIN-06 editor changes invalidate a running job and retained result; old replies cannot become current', async () => {
  for (const change of [(s) => { s.text = 'newer()'; }, (s) => { s.doc = {}; s.text = 'replacement()'; s.name = 'replacement.lua'; }]) {
    const e = editorFixture();
    const f = fixture(true, undefined, { editorSource: e.source }); await f.initialize(); await f.actions['mn-use-editor'](); await f.finish();
    const captured = f.view.getInput(), run = f.actions['mn-optimize'](); await flush();
    const old = f.workers[0], lateReply = old.captureReply({ result: result(4, 1) }), kept = f.$('mnOutputCode').value;
    change(e.state); e.source.refresh(); await run;
    assert.ok(old.terminated); assert.ok(f.$('mnOptimize').disabled); assert.match(f.$('mnEditorState').textContent, /Earlier snapshot/);
    assert.match(f.$('mnOutputState').textContent, /Stale result/); assert.strictEqual(f.view.getInput().lua, captured.lua);
    // Even a delivered callback after termination cannot publish a current result.
    lateReply();
    assert.strictEqual(f.$('mnOutputCode').value, kept); assert.strictEqual(e.state.savedLua, 'cls()');
    assert.strictEqual(await f.actions['mn-use-editor'](), true); assert.strictEqual(f.view.getInput().lua, e.state.text);
    assert.match(f.$('mnEditorState').textContent, /snapshot is current/); f.view.dispose();
  }
});

t('MIN-06 pending handoff rejects an editor changed during consent; Cancel and missing source preserve state', async () => {
  const e = editorFixture(); let consent = deferred();
  const f = fixture(true, undefined, { editorSource: e.source, confirmDialog: () => consent.promise });
  await f.initialize(); f.view.load(source('existing()')); const kept = f.view.getState();
  const pending = f.view.useEditor({ navigate: true }); await flush();
  e.state.text = 'later()'; e.source.refresh(); consent.resolve(true); assert.strictEqual(await pending, false);
  assert.strictEqual(f.view.getState(), kept); assert.match(f.$('mnInputStatus').textContent, /Code Editor changed/);
  consent = deferred(); const cancelled = f.actions['mn-use-editor'](); await flush(); f.actions['mn-cancel'](); consent.resolve(true); await cancelled;
  assert.strictEqual(f.view.getState(), kept);
  e.state.text = ''; e.source.refresh(); assert.ok(f.$('mnUseEditor').disabled); assert.match(f.$('mnEditorAvailability').textContent, /nonempty/);
  assert.strictEqual(await f.actions['mn-use-editor'](), false); assert.strictEqual(f.view.getState(), kept);
  f.view.dispose();
});

t('MIN-06 result publication checks live editor identity even before a change notification', async () => {
  const e = editorFixture(), f = fixture(true, undefined, { editorSource: e.source });
  await f.initialize(); await f.actions['mn-use-editor']();
  const run = f.actions['mn-optimize'](); await flush(); e.state.doc = {}; e.state.text = 'next()';
  f.workers[0].reply(); await run;
  assert.match(f.$('mnEditorState').textContent, /Earlier snapshot/); assert.match(f.$('mnOutputState').textContent, /Stale result/);
  assert.ok(f.$('mnOptimize').disabled); assert.strictEqual(e.state.text, 'next()'); f.view.dispose();
});

t('MIN-07 dependency preparation commits a complete plain tree; denied/cancelled reads preserve prior result', async () => {
  const e = editorFixture(); let prepare = async (snapshot) => ({ source: { ...snapshot.source, files: [...snapshot.source.files, { path: 'lib.lua', text: 'print("♥")\r\n' }] }, edges: [{ target: 'lib.lua' }], diagnostics: [], buildCopy: true });
  const editorSource = { ...e.source, getProjectSnapshot: (...args) => prepare(...args) };
  const f = fixture(true, undefined, { editorSource }); await f.initialize({ engine: { ...engine(), capabilities: { ...engine().capabilities, includes: true } } });
  assert.strictEqual(await f.actions['mn-use-editor'](), true); assert.strictEqual(f.view.getInput().source.files.length, 2);
  assert.match(f.$('mnProjectState').textContent, /2 source file/); await f.finish();
  assert.deepStrictEqual(Object.keys(f.workers[0].requests.at(-1).job.files[1]).sort(), ['path', 'text']);
  const kept = f.view.getState();
  prepare = async () => { throw require('../js/minifier-core.js').error('E_INCLUDE_READ', 'Cannot read main.lua → lib.lua'); };
  assert.strictEqual(await f.actions['mn-use-editor'](), false); assert.strictEqual(f.view.getState(), kept);
  assert.match(f.$('mnInputStatus').textContent, /main.lua → lib.lua/);
  const gate = deferred(); prepare = () => gate.promise;
  const pending = f.actions['mn-use-editor'](); await flush(); f.actions['mn-cancel']();
  gate.resolve({ source: source('late()'), edges: [], diagnostics: [], buildCopy: false });
  assert.strictEqual(await pending, false); assert.strictEqual(f.view.getState(), kept); f.view.dispose();
});

t('MIN-08 copy reports real clipboard success or denial and never changes the source/save state', async () => {
  const copied = [], clipboard = { writeText: async (text) => copied.push(text) };
  const f = fixture(true, undefined, { clipboard }); await f.initialize(); f.view.load(source()); await f.finish({ result: result(4, 4) });
  const kept = f.view.getState(); await f.actions['mn-copy']();
  assert.deepStrictEqual(copied, ['cls()']); assert.match(f.$('mnExportStatus').textContent, /Copied optimized Lua/); assert.strictEqual(f.view.getState(), kept);
  clipboard.writeText = async () => { throw Error('denied'); }; await f.actions['mn-copy']();
  assert.match(f.$('mnExportStatus').textContent, /Copy failed.*denied/); assert.strictEqual(f.$('mnExportStatus').dataset.tone, 'error');
  f.view.dispose();
  const unavailable = fixture(); await unavailable.initialize(); unavailable.view.load(source()); await unavailable.finish(); await unavailable.actions['mn-copy']();
  assert.match(unavailable.$('mnExportStatus').textContent, /Copy failed/); unavailable.view.dispose();
});

t('MIN-08 download is a separate named build; cancellation and stale dialogs never download', async () => {
  const downloads = [], f = fixture(true, undefined, { download: (...args) => downloads.push(args) });
  await f.initialize(); f.view.load(source()); await f.finish(); const kept = f.view.getState();
  let pending = f.actions['mn-download'](); assert.strictEqual(f.dialogs.at(-1).title, 'Download optimized build copy');
  assert.strictEqual(f.dialogs.at(-1).buttons.length, 2); f.dialogs.at(-1).finish(null); await pending;
  assert.strictEqual(downloads.length, 0); assert.match(f.$('mnExportStatus').textContent, /cancelled/);
  pending = f.actions['mn-download'](); f.dialogs.at(-1).finish('lua'); await pending;
  assert.deepStrictEqual(downloads[0], ['cls()', 'demo.min.lua', 'text/plain;charset=utf-8']); assert.strictEqual(f.view.getState(), kept);
  assert.match(f.$('mnExportStatus').textContent, /Download requested/); assert.ok(!/Saved/.test(f.$('mnExportStatus').textContent));
  pending = f.actions['mn-download'](); f.view.load(source('newer()')); f.dialogs.at(-1).finish('lua'); await pending;
  assert.strictEqual(downloads.length, 1); assert.match(f.$('mnExportStatus').textContent, /changed while choosing/);
  await f.actions['mn-copy'](); assert.match(f.$('mnExportStatus').textContent, /current successful result/); assert.ok(f.$('mnCopy').disabled); f.view.dispose();
});

t('MIN-08 repeated .p8 downloads retain exact assets, and corrupted worker assets disable both actions', async () => {
  const K = require('../js/code-core.js'), downloads = [];
  const text = K.NEW_CART + 'local x=1\nprint(x)\n__gfx__\n1234\n__music__\n__sfx__\n';
  const raw = { ...result(), lua: 'print(1)', cartText: K.joinCart(K.splitCart(text), 'print(1)') };
  const f = fixture(true, undefined, { download: (...args) => downloads.push(args) }); await f.initialize();
  f.view.load({ kind: 'p8', entryPath: 'demo.p8', files: [{ path: 'demo.p8', text }] }); await f.finish({ result: raw });
  for (let i = 0; i < 2; i++) { const p = f.actions['mn-download'](); f.dialogs.at(-1).finish('cart'); await p; }
  assert.strictEqual(downloads[0][1], 'demo.min.p8'); assert.deepStrictEqual(downloads[0], downloads[1]);
  assert.strictEqual(K.splitCart(downloads[0][0]).tail, K.splitCart(text).tail);
  await f.finish({ result: { ...raw, cartText: raw.cartText.replace('1234', '4321') } });
  assert.ok(f.$('mnCopy').disabled); assert.ok(f.$('mnDownload').disabled); assert.match(f.$('mnExportValidation').textContent, /engine changed cartridge assets/); assert.strictEqual(f.$('mnExportValidation').dataset.tone, 'error');
  await f.actions['mn-download'](); assert.strictEqual(downloads.length, 2); f.view.dispose();
});

t('MIN-08 pending clipboard completion cannot claim a new source was copied', async () => {
  const gate = deferred(), f = fixture(true, undefined, { clipboard: { writeText: () => gate.promise } });
  await f.initialize(); f.view.load(source()); await f.finish();
  const copy = f.actions['mn-copy'](); assert.ok(f.$('mnCopy').disabled); f.view.load(source('newer()')); gate.resolve(); await copy;
  assert.match(f.$('mnExportStatus').textContent, /captured earlier build/); assert.strictEqual(f.$('mnExportStatus').dataset.tone, 'warn');
  assert.strictEqual(f.view.getInput().lua, 'newer()'); f.view.dispose();
});

t('MIN-08 download initiation failure reports failure without claiming Save or losing the result', async () => {
  const f = fixture(true, undefined, { download: () => { throw Error('browser blocked'); } });
  await f.initialize(); f.view.load(source()); await f.finish(); const kept = f.view.getState();
  const pending = f.actions['mn-download'](); f.dialogs.at(-1).finish('lua'); await pending;
  assert.match(f.$('mnExportStatus').textContent, /Download failed/); assert.strictEqual(f.$('mnExportStatus').dataset.tone, 'error');
  assert.strictEqual(f.view.getState(), kept); f.view.dispose();
});


t('MIN-10 export completion restores a disabled opener after render, without stealing later focus', async () => {
  const gate = deferred(), f = fixture(true, undefined, { clipboard: { writeText: () => gate.promise } });
  await f.initialize(); f.view.load(source()); await f.finish();
  const copy = f.$('mnCopy'), download = f.$('mnDownload'), open = f.$('mnOpen');
  for (const node of [copy, download, open]) { node.isConnected = true; node.getClientRects = () => [{}]; }
  f.root.contains = (node) => [copy, download, open].includes(node);
  f.doc.body = {}; f.doc.querySelector = () => null;
  download.focus(); let pending = f.actions['mn-download'](); assert.ok(download.disabled);
  f.doc.activeElement = f.doc.body; f.dialogs.at(-1).finish(null); await pending;
  assert.strictEqual(f.doc.activeElement, download, 'Cancel must restore the now-enabled opener');
  copy.focus(); pending = f.actions['mn-copy'](); f.doc.activeElement = f.doc.body; gate.resolve(); await pending;
  assert.strictEqual(f.doc.activeElement, copy);
  download.focus(); pending = f.actions['mn-download'](); f.view.load(source('newer()'));
  f.doc.activeElement = f.doc.body; f.dialogs.at(-1).finish('lua'); await pending;
  assert.strictEqual(f.doc.activeElement, open, 'stale disabled opener falls back to current Source actions');
  await f.finish(); download.focus(); pending = f.actions['mn-download'](); open.focus();
  f.dialogs.at(-1).finish(null); await pending; assert.strictEqual(f.doc.activeElement, open, 'later focus must not be stolen');
  download.focus(); pending = f.actions['mn-download'](); f.root.hidden = true; f.doc.activeElement = f.doc.body;
  f.dialogs.at(-1).finish(null); await pending; assert.strictEqual(f.doc.activeElement, f.doc.body, 'hidden workspace must not gain focus');
  f.root.hidden = false; download.focus(); pending = f.actions['mn-download'](); f.view.dispose(); f.doc.activeElement = f.doc.body;
  f.dialogs.at(-1).finish(null); await pending; assert.strictEqual(f.doc.activeElement, f.doc.body, 'disposed view must not gain focus');
});

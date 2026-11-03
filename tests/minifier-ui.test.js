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

function fixture(wide = true, protocol) {
  const nodes = new Map(), actions = {}, workers = [];
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
  const view = UI.mount({ root, adapter, media, protocol, app: { registerActions(more) { Object.assign(actions, more); } } });
  return { view, adapter, nodes, actions, root, workers, media, doc, $: (id) => nodes.get(id),
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
  for (const id of ['mnOpen', 'mnPaste', 'mnUseEditor', 'mnCopy', 'mnDownload']) assert.ok(f.$(id).disabled, id);
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

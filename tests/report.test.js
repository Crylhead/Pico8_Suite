// Exercise the actual report actions: each export must match its editable preview.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t } = require('./harness.js');
const D = require('../js/diagnostics-core.js');

t('#63 report copies/downloads only reviewed previews, validates JSON and clears records', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const start = source.indexOf('  function buildReportSummary(');
  const end = source.indexOf('  // Active project context', start);
  const created = []; const downloads = []; const copied = []; const opened = [];
  const diagnostics = D.create();
  diagnostics.report('terrain', 'E_TERRAIN_RENDER', new Error('test failure'));
  let dialog;
  const el = (tag, props = {}, ...children) => {
    const node = { tag, value: '', children, listeners: {}, addEventListener(k, f) { this.listeners[k] = f; }, focus() {}, select() {}, ...props };
    created.push(node); return node;
  };
  const sandbox = {
    diagnostics, el,
    document: { body: { dataset: { workspace: 'extras' } } },
    navigator: { clipboard: { async writeText(s) { copied.push(s); } }, onLine: true },
    window: { open: (...args) => opened.push(args) },
    download: (...args) => downloads.push(args),
    modal: async (options) => { dialog = options; },
    REPO_NEW_ISSUE: 'https://github.com/Crylhead/Pico8_Suite/issues/new?template=bug_report.yml',
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  await sandbox.showReportProblem();
  const area = (label) => created.find((n) => n.attrs?.['aria-label'] === label);
  const summary = area('Report summary preview (editable)');
  const json = area('Diagnostics JSON preview (editable)');
  assert.ok(summary && json, 'both outgoing payloads must be previewed');
  const action = (label) => dialog.actions.find((a) => a.label === label).onClick();
  assert.strictEqual(JSON.parse(json.value).records.length, 1);
  summary.value = 'Reviewed summary'; json.value = '{"records":[]}';
  await action('Copy summary'); action('Download diagnostics');
  assert.deepStrictEqual(copied, ['Reviewed summary']);
  assert.strictEqual(downloads[0][0], '{"records":[]}');
  json.value = '{broken'; action('Download diagnostics');
  assert.strictEqual(downloads.length, 1, 'invalid JSON must not download');
  action('Open GitHub issue form');
  assert.strictEqual(opened[0][0], sandbox.REPO_NEW_ISSUE, 'no report data goes in the URL');
  action('Clear diagnostics');
  assert.strictEqual(diagnostics.size, 0);
  assert.deepStrictEqual(JSON.parse(json.value).records, []);
});

/** Run the real report dialog from js/app.js against fake DOM/modal; returns handles to its parts. */
async function openReport(diagnostics) {
  const source = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
  const start = source.indexOf('  function buildReportSummary(');
  const end = source.indexOf('  // Active project context', start);
  const created = []; let dialog;
  const el = (tag, props = {}, ...children) => {
    const node = { tag, value: '', children, listeners: {}, addEventListener(k, f) { this.listeners[k] = f; }, focus() {}, select() {}, ...props };
    created.push(node); return node;
  };
  const sandbox = {
    diagnostics, el, document: { body: { dataset: { workspace: 'code' } } },
    navigator: { clipboard: { async writeText() {} }, onLine: false }, window: { open: () => null },
    download: () => {}, modal: async (o) => { dialog = o; }, REPO_NEW_ISSUE: 'https://example.invalid/new',
  };
  vm.runInNewContext(source.slice(start, end), sandbox);
  await sandbox.showReportProblem();
  const area = (label) => created.find((n) => n.attrs?.['aria-label'] === label);
  return {
    dialog, summary: area('Report summary preview (editable)'), json: area('Diagnostics JSON preview (editable)'),
    optIn: created.find((n) => n.type === 'checkbox'),
    status: created.find((n) => n.attrs?.role === 'status'),
    action: (label) => dialog.actions.find((a) => a.label === label).onClick(),
  };
}

t('#63 report works with empty diagnostics and offline', async () => {
  const r = await openReport(D.create({ version: '1.0', browser: 'Firefox' }));
  assert.match(r.summary.value, /## Diagnostics \(0 records\)/);
  assert.match(r.summary.value, /Suite version: 1\.0/);
  assert.match(r.summary.value, /Browser: Firefox/);
  assert.match(r.summary.value, /Workspace: code/);
  assert.deepStrictEqual(JSON.parse(r.json.value).records, []);
  r.action('Open GitHub issue form');
  assert.match(r.status.textContent, /offline/);
});

t('#63/#62 default report has the Error ID but no message text; full text only after opt-in', async () => {
  const d = D.create();
  const rec = d.report('code', 'E_RUN', new TypeError('playerSecretName.split is not a function'));
  const r = await openReport(d);
  assert.ok(r.summary.value.includes(rec.id), 'error ID must be in the summary');
  assert.ok(r.summary.value.includes('[…] is not a function'));
  for (const s of [r.summary.value, r.json.value]) assert.ok(!s.includes('playerSecretName'), 'user text leaked by default');
  assert.strictEqual(r.optIn.checked, undefined, 'opt-in is off by default');
  r.optIn.checked = true; r.optIn.listeners.change();
  assert.ok(r.summary.value.includes('playerSecretName') && r.json.value.includes('playerSecretName'));
  assert.strictEqual(JSON.parse(r.json.value).messages, 'sanitized');
  assert.match(r.status.textContent, /names, values or code/);
  r.optIn.checked = false; r.optIn.listeners.change();
  assert.ok(!r.json.value.includes('playerSecretName'));
});

// ---------------------------------------------------------------- #85

/** hostile names in every place an error can carry them; none may reach the default export */
const HOSTILE = ['CustomerSecretProject', 'CustomerSecretFunction', 'CustomerSecretFile', 'PlainObjSecret', 'workerSecretName', 'secret_code', 'SecretSource'];
function hostileLog() {
  const d = D.create({ sessionId: 'S1', appFiles: () => ['app.js', 'suite.js'] });
  const e = new Error('generic failure');
  e.name = 'CustomerSecretProject';
  e.stack = 'Error: generic failure\n    at CustomerSecretFunction (https://host/js/CustomerSecretFile.js:10:5)\n    at Object.run (https://host/js/app.js:20:3)\n    at async load (suite.js:5:6)';
  d.fromErrorEvent({ error: e });
  d.fromRejection({ reason: { name: 'PlainObjSecret', message: 'x', stack: 'at f (CustomerSecretFile.js:1:1)' } });
  const w = new Error('boom'); w.name = 'workerSecretName';
  d.fromErrorEvent({ error: w }, 'worker:terrain');
  d.report('SecretSource Here', 'secret_code', new Error('failed'));
  d.fromErrorEvent({ error: new TypeError('x is not a function') });
  d.fromRejection({ reason: new RangeError('bad') });
  d.fromErrorEvent({ error: Object.assign(new Error('denied'), { name: 'NotAllowedError' }) });
  d.report('terrain', 'E_TERRAIN_RENDER', new Error('render failed'), 'preview render');
  return d;
}

t('#85 default export: no custom error name, plain-object name, stack function or foreign file in any field', () => {
  const d = hostileLog();
  const json = d.exportJSON();
  for (const bad of HOSTILE) assert.ok(!json.includes(bad), `${bad} leaked into the default JSON`);
  const recs = JSON.parse(json).records;
  for (const r of recs) assert.deepStrictEqual(Object.keys(r).sort(), ['code', 'count', 'id', 'last', 'message', 'seq', 'severity', 'source', 'stack', 'state', 'time'], 'only the listed fields');
  assert.deepStrictEqual(recs.map((r) => r.code), ['E_OtherError', 'E_REJECTION_OtherError', 'E_WORKER_OtherError', 'E_APP', 'E_TypeError', 'E_REJECTION_RangeError', 'E_NotAllowedError', 'E_TERRAIN_RENDER']);
  assert.deepStrictEqual(recs.map((r) => r.source), ['window', 'promise', 'worker:terrain', 'app', 'window', 'promise', 'window', 'terrain']);
  assert.strictEqual(recs[0].stack, '(other script)\napp.js:20:3\nsuite.js:5:6', 'own script lines only, without function names');
  assert.strictEqual(recs[1].stack, '(other script)');
  assert.strictEqual(recs[7].state, 'preview render');
});

t('#85 the report summary built from the default bundle carries no hostile names; IDs stay', async () => {
  const d = hostileLog();
  const r = await openReport(d);
  for (const bad of HOSTILE) {
    assert.ok(!r.summary.value.includes(bad), `${bad} leaked into the summary`);
    assert.ok(!r.json.value.includes(bad), `${bad} leaked into the JSON preview`);
  }
  for (const rec of d.read().slice(-8)) assert.ok(r.summary.value.includes(rec.id), 'every Error ID is in the summary');
  assert.match(r.summary.value, /E_TypeError/);
  assert.match(r.summary.value, /E_TERRAIN_RENDER/);
});

t('#85 the explicit opt-in shows the detail truthfully; in-memory IDs are unchanged by the mapping', async () => {
  const d = hostileLog();
  const full = d.exportBundle({ messages: 'sanitized' });
  assert.strictEqual(full.messages, 'sanitized');
  assert.match(full.note, /error names and stack function names included at your request/);
  assert.deepStrictEqual(full.records.slice(0, 4).map((x) => x.code), ['E_CustomerSecretProject', 'E_REJECTION_PlainObjSecret', 'E_WORKER_workerSecretName', 'secret_code']);
  assert.match(full.records[0].stack, /^CustomerSecretFunction \(CustomerSecretFile\.js:10:5\)/);
  // two errors that differ only in their custom name stay separate records (dedupe uses the full name)
  const d2 = D.create({ sessionId: 'S1' });
  const a = new Error('m'); a.name = 'OneName';
  const b = new Error('m'); b.name = 'OtherName';
  d2.fromErrorEvent({ error: a }); d2.fromErrorEvent({ error: b });
  assert.strictEqual(d2.size, 2);
  const r = await openReport(d);
  r.optIn.checked = true; r.optIn.listeners.change();
  assert.ok(r.json.value.includes('CustomerSecretProject') && r.summary.value.includes('CustomerSecretProject'), 'opt-in regenerates both previews with detail');
  r.optIn.checked = false; r.optIn.listeners.change();
  assert.ok(!r.json.value.includes('CustomerSecretProject'), 'unticking restores the safe default');
});

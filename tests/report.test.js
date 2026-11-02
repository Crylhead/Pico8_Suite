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

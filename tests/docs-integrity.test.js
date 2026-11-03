// #69: documentation, help and tour drift checks on the real repository, plus a broken fixture
// proving the checker reports actionable messages.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const { check, builtins, tourCoverage } = require('./docs-integrity.js');
const Help = require('../js/help-core.js');
const Tours = require('../js/tours-data.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('id="wsTabs"');
const workspaces = [...html.slice(start, html.indexOf('appbar-end', start)).matchAll(/data-value="([a-z]+)"/g)].map((m) => m[1]);
const sources = Object.fromEntries([...html.matchAll(/<script[^>]+src="(js\/[^"]+)"/g)].filter((m) => !m[1].includes('tours')).map((m) => [m[1], fs.readFileSync(path.join(__dirname, '..', m[1]), 'utf8')]));
const real = () => ({ html, sources, topics: Help.topics(), controlLookup: Help.control, tours: Tours.TOURS, workspaces });

t('#69 repository: help, tours and shortcuts have no drift', () => {
  const errors = check(real());
  assert.deepStrictEqual(errors, [], `\n${errors.join('\n')}`);
});

t('#69 fixture: a missing help target, dead tour step and undocumented shortcut are reported with actions', () => {
  const broken = real();
  broken.topics = broken.topics.filter((x) => x.ws !== 'audit').concat([{ ...broken.topics[0], id: 'home', controls: [], actions: [] }]);
  broken.tours = [{
    id: 'bad', major: 1,
    steps: [
      { id: 's1', target: '#doesNotExist', title: 't', text: 'x' },
      { id: 's1', target: '.tl-canvas', title: 't', text: 'x' },
      { id: 's3', target: '#projectIndicator', title: 't', text: 'x' },
      { id: 's4', target: '#psCanvas', title: 't', helpId: 'no.such.help' },
    ],
  }];
  broken.html = `${html.replace('data-help-id="studio.tiled"', 'data-help-id="studio.gone"')}`.replace('<kbd>Ctrl+Alt+N</kbd>', '<kbd>Ctrl+Alt+Zq</kbd>');
  const text = check(broken).join('\n');
  for (const needle of [
    'Workspace "audit" has no help topic',
    'Duplicate help topic id "home"',
    'data-help-id="studio.gone"',
    'target #doesNotExist does not exist',
    'duplicate step id',
    'created by JavaScript',
    'hidden by default',
    'helpId "no.such.help"',
    'Ctrl+Alt+Zq',
  ]) assert.ok(text.includes(needle), `missing message: ${needle}\n${text}`);
});

t('#69 a documented exception is honoured', () => {
  const x = real();
  x.topics = x.topics.filter((y) => y.ws !== 'audit');
  assert.ok(check(x).some((e) => e.includes('Workspace "audit"')));
  assert.ok(!check({ ...x, exceptions: { audit: 'covered by Cart Builder help' } }).some((e) => e.includes('Workspace "audit"')));
});

t('#109 built-in inventory discovers bundled registration and tabs without a hard-coded subtool list', () => {
  const tools = builtins(html, sources), keys = tools.map((x) => x.sub ? `${x.ws}/${x.sub}` : x.ws);
  assert.ok(keys.includes('extras/terrain'), 'Terrain is registered by a loaded module, not the static tabs');
  assert.ok(keys.includes('extras/lut')); assert.ok(keys.includes('minifier')); assert.strictEqual(new Set(keys).size, keys.length);
  const added = builtins(html, { ...sources, 'js/fixture.js': "Suite.registerTool({ name: 'Fixture', ws: 'fixture' }); (window.P8ExtraTools ||= []).push({ id: 'bundled', label: 'Fixture' });" });
  const errors = tourCoverage(added, Tours.TOURS).join('\n');
  assert.match(errors, /Built-in "fixture" needs exactly one tour/);
  assert.match(errors, /Built-in "extras\/bundled" needs exactly one tour/);
});

t('#109 missing workspace and dynamic subtool tours fail; real metadata and justified exceptions pass', () => {
  const valid = real(); assert.deepStrictEqual(check(valid), []);
  const missing = { ...valid, tours: valid.tours.filter((x) => !['palette', 'terrain'].includes(x.id)) };
  const errors = check(missing).join('\n');
  assert.match(errors, /Built-in "palette" needs exactly one tour/);
  assert.match(errors, /Built-in "extras\/terrain" needs exactly one tour/);
  assert.deepStrictEqual(check({ ...missing, tourExceptions: { palette: 'Fixture: covered by a dedicated external orientation.', 'extras/terrain': 'Fixture: temporarily unavailable bundled module.' } }), []);
  assert.match(check({ ...missing, tourExceptions: { palette: ' ' } }).join('\n'), /needs a written reason/);
  // Exercise actual runtime registration: a plugin's explicit opt-out remains accepted.
  const vm = require('vm'), { read, fn } = require('./source-extract.js'), registered = [];
  const runtime = { tools: registered, orderWorkspaceTabs() {}, renderHome() {}, document: { dispatchEvent() {} }, CustomEvent: function () {} };
  vm.runInNewContext(fn(read('js/suite.js'), 'registerTool') + "; registerTool({ ws: 'external', tour: false });", runtime);
  assert.strictEqual(registered[0].tour, false);
  assert.strictEqual(registered[0].ws, 'external');
});

t('#109 required area metadata catches incomplete tours and preserves documented overview/follow-up gaps', () => {
  const valid = real();
  const broken = { ...valid, tours: valid.tours.map((tour) => tour.id === 'minifier' ? { ...tour, steps: tour.steps.map((step) => ({ ...step, areas: step.areas?.filter((area) => area !== 'handoff') })) } : tour) };
  assert.match(check(broken).join('\n'), /Tour "minifier" does not cover area "handoff"/);
  const bad = { ...valid, tours: [...valid.tours, { ...valid.tours.find((x) => x.id === 'palette'), id: 'duplicate-context' }] };
  assert.match(check(bad).join('\n'), /Built-in "palette" needs exactly one tour \(found 2\)/);
  assert.deepStrictEqual(check(valid), [], 'Home overview and #105 gaps must be explicit, not silently inferred');
});

t('#109 optional targets and before clicks still need real static or bundled builder evidence', () => {
  const valid = real();
  const withStep = (step) => ({ ...valid, tours: valid.tours.map((tour) => tour.id === 'lut' ? { ...tour, steps: [...tour.steps, { id: 'fixture', text: 'Fixture', ...step }] } : tour) });
  for (const step of [
    { target: '[data-tour-id="gone"]', optional: true },
    { target: '.ex-stgae', conditional: true },
    { target: '#psCanvas', before: { ws: 'extras', click: '#exTabs [data-value="gone-subtool"]' } },
  ]) assert.match(check(withStep(step)).join('\n'), /does not exist in index.html or bundled DOM builders/);
  const dynamic = withStep({ target: '#generated', conditional: true });
  dynamic.sources = { ...sources, 'js/fixture.js': "const node = el('div', { id: 'generated' });" };
  assert.deepStrictEqual(check(dynamic), []);
  const unprepared = withStep({ target: '#generated' }); unprepared.sources = dynamic.sources;
  assert.match(check(unprepared).join('\n'), /created by JavaScript; declare/);
});

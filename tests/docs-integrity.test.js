// #69: documentation, help and tour drift checks on the real repository, plus a broken fixture
// proving the checker reports actionable messages.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const { check } = require('./docs-integrity.js');
const Help = require('../js/help-core.js');
const Tours = require('../js/tours-data.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('id="wsTabs"');
const workspaces = [...html.slice(start, html.indexOf('appbar-end', start)).matchAll(/data-value="([a-z]+)"/g)].map((m) => m[1]);
const real = () => ({ html, topics: Help.topics(), controlLookup: Help.control, tours: Tours.TOURS, workspaces });

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

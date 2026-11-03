const assert = require('assert');
const { t } = require('./harness.js');
const C = require('../js/minifier-core.js');
const { source, engine, result } = require('./minifier-fixtures.js');
const move = C.transition;

t('MIN-05 reporting uses measured zero/increase/percentage data and handles zero or absent baselines honestly', () => {
  assert.strictEqual(C.metricRows(result(4, 4))[0].change, '0 (0%)');
  assert.strictEqual(C.metricRows(result(4, 5))[0].change, 'Increased by 1 (25%)');
  assert.strictEqual(C.metricRows(result(3, 2))[0].change, '1 saved (33.33%)');
  assert.strictEqual(C.metricRows(result(0, 1))[0].change, 'Increased by 1 (percentage unavailable)');
  assert.strictEqual(C.metricRows(result(65535, 65536))[0].change, 'Increased by 1 (<0.01%)');
  assert.strictEqual(C.metricRows(result(65535, 65534))[0].change, '1 saved (<0.01%)');
  const rows = C.metricRows(result());
  assert.strictEqual(rows[2].before, null); assert.strictEqual(rows[2].change, '—'); assert.match(rows[2].beforeReason, /Not emitted/);
  assert.strictEqual(rows[0].limit, 8192); assert.strictEqual(rows[1].limit, 65535); assert.strictEqual(rows[2].limit, null);
  assert.ok(Object.isFrozen(rows[0])); assert.strictEqual(C.metricRows(null)[0].before, null);
  const boundary = result(8192, 8193); boundary.metrics.optimized.characters = 65535;
  assert.strictEqual(C.metricRows(boundary)[0].beforeOver, false); assert.strictEqual(C.metricRows(boundary)[0].afterOver, true);
  assert.strictEqual(C.metricRows(boundary)[1].afterOver, false);
});

function failed(snapshot, diagnostic) {
  const input = C.prepareInput(snapshot);
  let state = move(move(C.initialState(), { type: 'source', source: snapshot }), { type: 'ready', engine: engine() });
  state = move(state, { type: 'start' });
  state = move(state, { type: 'failure', job: state.activeJob, diagnostics: [diagnostic] });
  return { state, input: { ...input, sourceRevision: state.sourceRevision }, diagnostic: state.diagnostics[0] };
}

t('MIN-05 cart file coordinates map to Lua-view lines with CRLF and multi-unit Unicode', () => {
  const text = 'pico-8 cartridge // http://www.pico-8.com\r\nversion 42\r\n__lua__\r\nprint("♥ 🅾️")\r\nlocal = 1\r\n__gfx__\r\n0';
  const r = failed({ kind: 'p8', entryPath: 'bad.p8', files: [{ path: 'bad.p8', text }] }, { file: 'bad.p8', line: 5, column: 7, code: 'E_TEST', message: 'bad' });
  const where = C.diagnosticLocation(r.state, r.input, r.diagnostic);
  assert.strictEqual(where.line, 2); assert.strictEqual(where.reportedLine, 5);
  assert.strictEqual(r.input.lua.slice(where.start, where.end), 'local = 1');
});

t('MIN-05 unknown/out-of-range/startup/stale diagnostic positions never become source actions', () => {
  for (const diagnostic of [{ file: 'missing.lua', line: 1 }, { file: 'demo.lua', line: 9 }, { file: 'demo.lua', line: 0 }, { file: 'javascript:alert(1)', line: 1 }]) {
    const r = failed(source(), { ...diagnostic, message: '<script>literal</script>' });
    assert.strictEqual(C.diagnosticLocation(r.state, r.input, r.diagnostic), null);
  }
  const r = failed(source(), { file: 'demo.lua', line: 1, column: 999, message: 'reported column; select the whole line' });
  assert.ok(C.diagnosticLocation(r.state, r.input, r.diagnostic));
  for (const event of [{ type: 'source', source: source('new()') }, { type: 'options', options: { target: 'characters' } }, { type: 'start' }, { type: 'cancel' }, { type: 'failure', diagnostics: [r.diagnostic] }]) assert.strictEqual(C.diagnosticLocation(move(r.state, event), r.input, r.diagnostic), null);
  assert.strictEqual(C.diagnosticLocation(r.state, { ...r.input, sourceRevision: 999 }, r.diagnostic), null);
});

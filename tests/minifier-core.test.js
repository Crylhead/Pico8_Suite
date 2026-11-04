const assert = require('assert');
const { t } = require('./harness.js');
const C = require('../js/minifier-core.js');
const { source, engine, result } = require('./minifier-fixtures.js');
const move = C.transition;
const ready = () => move(move(C.initialState(), { type: 'source', source: source() }), { type: 'ready', engine: engine() });
const finished = (raw = result()) => {
  const s = move(ready(), { type: 'start' });
  return move(s, { type: 'complete', job: s.activeJob, result: raw });
};

t('MIN-02 immutable source/options snapshots contain only plain contract data', () => {
  const input = source(); input.files[0].handle = { arbitrary: true };
  let s = move(C.initialState(), { type: 'source', source: input });
  input.files[0].text = 'mutated'; input.files.push({ path: 'other.lua', text: 'oops' });
  assert.strictEqual(s.source.files[0].text, 'cls()');
  assert.strictEqual(s.source.files.length, 1);
  assert.strictEqual(s.source.files[0].handle, undefined);
  assert.ok(Object.isFrozen(s.source.files[0]));
  assert.strictEqual(C.describe(s).canOptimize, false);
  s = move(s, { type: 'ready', engine: engine() });
  s = move(s, { type: 'start' });
  assert.deepStrictEqual(Object.keys(s.activeJob).sort(), ['jobId', 'sourceRevision', 'optionsRevision', 'entryPath', 'files', 'kind', 'profile', 'target', 'keepLines', 'renameAggressive', 'reorderAggressive'].sort());
  assert.deepStrictEqual(C.flagsFor(s.options), ['--minify-safe-only', '--no-minify-rename', '--no-minify-lines', '--focus-tokens', '--no-minify-transform']);
  assert.throws(() => move(s, { type: 'start' }), (e) => e.code === 'E_BUSY');
});

t('MIN-02 validates paths, entry files and explicit presets without arbitrary engine flags', () => {
  for (const input of [source('cls()', '../demo.lua'), { ...source(), files: [] }, { ...source(), kind: 'png' }, { ...source(), files: [source().files[0], source().files[0]] }]) assert.throws(() => C.sourceSnapshot(input));
  assert.throws(() => C.settings({ flags: ['--run'] }), (e) => e.code === 'E_OPTIONS_UNSUPPORTED');
  assert.throws(() => move(ready(), { type: 'options', options: null }));
  assert.throws(() => C.settings({ keepLines: 'yes' }), (e) => e.code === 'E_OPTIONS_UNSUPPORTED');
  const s = move(ready(), { type: 'options', options: { profile: 'turbo' } });
  assert.strictEqual(s.status, 'unsupported');
  assert.strictEqual(C.describe(s).canOptimize, false);
  assert.throws(() => move(s, { type: 'start' }), (e) => e.code === 'E_OPTIONS_UNSUPPORTED');
  assert.strictEqual(move(ready(), { type: 'options', options: { target: 'speed' } }).status, 'unsupported');
});

t('#164 levels, focus and switches map to the exact pinned Shrinko8 flags; the default is unchanged', () => {
  const T = '--no-minify-transform';
  assert.deepStrictEqual(C.flagsFor({}), [...C.FLAGS]);
  const cases = [
    [{ profile: 'minimal', target: 'balanced' }, ['--minify-safe-only', '--no-minify-rename', '--no-minify-lines', T]],
    [{ profile: 'minimal', keepLines: true, renameAggressive: true }, [...C.FLAGS]], // Minimal ignores switches that do not apply
    [{ profile: 'safe', target: 'chars' }, ['--minify-safe-only', '--focus-chars', T]],
    [{ profile: 'safe', target: 'tokens', keepLines: true }, ['--minify-safe-only', '--no-minify-lines', '--focus-tokens', T]],
    [{ profile: 'aggressive', target: 'compressed' }, ['--minify', '--rename-safe-only', '--reorder-safe-only', '--focus-compressed', T]],
    [{ profile: 'aggressive', target: 'tokens-chars', renameAggressive: true }, ['--minify', '--reorder-safe-only', '--focus-tokens', '--focus-chars', T]],
    [{ profile: 'aggressive', target: 'tokens-compressed', renameAggressive: true, reorderAggressive: true, keepLines: true }, ['--minify', '--no-minify-lines', '--focus-tokens', '--focus-compressed', T]],
  ];
  for (const [options, flags] of cases) assert.deepStrictEqual(C.flagsFor(options), flags, JSON.stringify(options));
  assert.deepStrictEqual([...C.PROFILES], ['minimal', 'safe', 'aggressive']);
  assert.deepStrictEqual([...C.TARGETS], ['balanced', 'tokens', 'chars', 'compressed', 'tokens-chars', 'tokens-compressed']);
  // A changed option is a new options revision: an earlier reply cannot be accepted for it.
  let st = move(ready(), { type: 'start' }); const job = st.activeJob;
  st = move(st, { type: 'options', options: { profile: 'safe' } });
  assert.strictEqual(move(st, { type: 'complete', job, result: result() }), st);
  st = move(st, { type: 'start' });
  assert.strictEqual(st.activeJob.profile, 'safe');
  assert.throws(() => move(st, { type: 'complete', job: st.activeJob, result: result() }), (e) => e.code === 'E_RESULT_INVALID', 'Minimal flags are not a valid Safe result');
  const safe = move(st, { type: 'complete', job: st.activeJob, result: { ...result(), flags: C.flagsFor({ profile: 'safe' }) } });
  assert.strictEqual(safe.result.job.profile, 'safe');
});

t('MIN-02 one monotonic clock invalidates same-filename replacements and old replies', () => {
  let s = ready();
  s = move(s, { type: 'start' }); const job = s.activeJob;
  s = move(s, { type: 'source', source: source('flip()') });
  assert.ok(s.sourceRevision > Number(job.jobId.split('-')[1]));
  const unchanged = move(s, { type: 'complete', job, result: result() });
  assert.strictEqual(unchanged, s);
  s = move(s, { type: 'options', options: { target: 'characters' } });
  assert.ok(s.optionsRevision > s.sourceRevision);
  const revision = s.revision;
  s = move(s, { type: 'options', options: { target: 'tokens' } });
  assert.ok(s.optionsRevision > revision);
  assert.strictEqual(move(s, { type: 'options', options: {} }), s);
});

t('MIN-02 retains prior results as stale and disables current-result exports for every invalidation', () => {
  const s = finished();
  assert.strictEqual(s.status, 'success'); assert.ok(C.canExport(s));
  for (const event of [{ type: 'source', source: source() }, { type: 'options', options: { target: 'characters' } }, { type: 'start' }, { type: 'cancel' }, { type: 'failure', diagnostics: [{ code: 'E_ENGINE', message: 'failed' }] }]) {
    const changed = move(s, event);
    assert.strictEqual(C.canExport(changed), false);
    assert.strictEqual(changed.result, s.result);
    assert.strictEqual(C.describe(changed).stale, true);
  }
  const stale = move(s, { type: 'source', source: source() });
  assert.strictEqual(stale.status, 'stale');
  assert.strictEqual(move(stale, { type: 'source', source: null }).status, 'empty');
});

t('MIN-02 zero improvement is valid, increases are labelled, missing compressed measures stay unavailable', () => {
  assert.strictEqual(finished(result(4, 4)).status, 'unchanged');
  assert.ok(C.canExport(finished(result(4, 4))));
  assert.strictEqual(finished(result(4, 5)).status, 'success');
  assert.strictEqual(C.metricDelta(4, 4).text, '0 (0%)');
  assert.strictEqual(C.metricDelta(4, 5).text, '1 increase (25%)');
  assert.strictEqual(C.metricDelta(4, 3).text, '1 saved (25%)');
  assert.strictEqual(C.metricDelta(null, 12).available, false);
  assert.strictEqual(C.metricDelta(0, 1).percent, null);
  assert.strictEqual(finished().result.metrics.original.compressedBytes, null);
  assert.strictEqual(finished().result.metrics.original.compressedReason, 'Not emitted by engine.');
});

t('MIN-02 rejects incomplete results and exposes normalized plain diagnostics and distinct filenames', () => {
  for (const raw of [{ ...result(), flags: [] }, { ...result(), metrics: {} }, { ...result(), diagnostics: [{ severity: 'error', message: 'bad' }] }]) assert.throws(() => finished(raw), (e) => e.code === 'E_RESULT_INVALID');
  assert.deepStrictEqual(C.normalizeDiagnostics([{ severity: 'warning', code: 'W_TEST', message: '<b>plain</b>', file: 'demo.lua', line: 2, column: -1, node: {} }]), [{ severity: 'warning', code: 'W_TEST', message: '<b>plain</b>', file: 'demo.lua', line: 2 }]);
  assert.strictEqual(C.outputFilename('folder/demo.P8', 'p8'), 'demo.min.p8');
  assert.strictEqual(C.outputFilename('demo.min.lua', 'lua'), 'demo.min.min.lua');
});

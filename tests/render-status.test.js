// #67: truthful preview / final / stale status (js/render-status-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const R = require('../js/render-status-core.js');

const base = { rev: 5, shownRev: -1, finalRev: -1, previewRunning: false, finalRunning: false, finalScheduled: false, error: '' };
const d = (o) => R.describe({ ...base, ...o });

t('#67 an edit is acknowledged at once as queued, and the older image is labelled stale', () => {
  const q = d({ shownRev: 4, finalRev: 4, previewRunning: true, finalScheduled: true });
  assert.strictEqual(q.state, 'queued');
  assert.strictEqual(q.stale, true);
  assert.match(q.label, /image is stale/);
  assert.strictEqual(q.exportable, false);
  assert.strictEqual(d({ previewRunning: true, finalScheduled: true }).stale, false); // nothing shown: nothing can be stale
});

t('#67 a stale final never reads as current after a newer edit', () => {
  const s = d({ shownRev: 4, finalRev: 4, finalScheduled: true });
  assert.notStrictEqual(s.state, 'final');
  assert.strictEqual(s.exportable, false);
  assert.strictEqual(d({ shownRev: 5, finalRev: 5 }).state, 'final');
  assert.strictEqual(d({ shownRev: 5, finalRev: 5 }).exportable, true);
});

t('#67 preview and final are labelled apart: preview current, final running, final done', () => {
  assert.strictEqual(d({ shownRev: 5, finalScheduled: true }).state, 'preview');
  const run = d({ shownRev: 5, finalRunning: true });
  assert.strictEqual(run.state, 'rendering-final');
  assert.match(run.label, /^Preview · rendering final/);
  assert.strictEqual(run.exportable, false);
  const old = d({ shownRev: 4, finalRunning: true });
  assert.strictEqual(old.label, 'Rendering final…');
  assert.strictEqual(old.stale, true);
});

t('#67 nothing running and an old image is Stale with a way out; errors are actionable and mark the image stale', () => {
  assert.strictEqual(d({ shownRev: 3 }).state, 'stale');
  assert.match(d({ shownRev: 3 }).detail, /Retry/);
  const e = d({ shownRev: 3, error: R.errorText('final', 'S1-ABC1234') });
  assert.strictEqual(e.state, 'error');
  assert.strictEqual(e.stale, true);
  assert.match(e.detail, /Error ID S1-ABC1234/);
  assert.match(e.detail, /stale/);
  assert.match(R.errorText('preview', ''), /Retry re-renders your latest edit.*not lost.*Report a problem/);
  assert.ok(!/DevTools|console/i.test(R.errorText('final', 'X')));
});

t('#67 no invented progress: no state mentions a percentage', () => {
  for (const o of [{}, { previewRunning: true }, { finalRunning: true }, { shownRev: 5, finalRev: 5 }, { error: 'x' }]) {
    const s = d(o);
    assert.ok(!/\d\s?%/.test(`${s.label} ${s.detail}`), s.label);
  }
});

t('#67 input-to-feedback samples are summarised without telemetry', () => {
  assert.deepStrictEqual(R.summarize([]), { n: 0 });
  assert.deepStrictEqual(R.summarize([30, 10, 20, 40, 50]), { n: 5, median: 30, p75: 40, max: 50 });
});

t('#67 actual result handler ignores obsolete errors and keeps Retry until a current final succeeds', () => {
  const fs = require('fs'); const path = require('path'); const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '../js/terrain.js'), 'utf8');
  const code = src.slice(src.indexOf('  function onResult('), src.indexOf('  function changed('));
  const x = { rev: 3, finalRev: -1, shown: null, renderError: '', finalResult: null, lastFinalMs: 0, lastShadeMs: 0,
    window: { P8App: { diagnostics: { report: () => ({ id: 'TEST' }) } } },
    failed: () => { x.renderError = 'Error ID TEST'; }, showResult: (r) => { x.shown = r; } };
  vm.runInNewContext(code, x);
  x.onResult('final', { id: 2, error: 'old failure' });
  assert.strictEqual(x.renderError, '');
  x.onResult('final', { id: 3, error: 'current failure' });
  x.onResult('preview', { id: 3, ms: 1 });
  assert.match(x.renderError, /TEST/);
  x.onResult('final', { id: 2, ms: 1, stages: { shade: 1 } });
  assert.match(x.renderError, /TEST/);
  x.onResult('final', { id: 3, ms: 1, stages: { shade: 1 } });
  assert.strictEqual(x.renderError, '');
  assert.strictEqual(x.finalRev, 3);
});

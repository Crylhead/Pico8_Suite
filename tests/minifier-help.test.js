const assert = require('assert');
const { t } = require('./harness.js');
const Help = require('../js/help-core.js');
const Tours = require('../js/tours-core.js');
const Data = require('../js/tours-data.js');
const Tips = require('../js/ux-tooltips.js');

t('MIN-09 Minifier context and search resolve new controls through the shared help registry', () => {
  assert.strictEqual(Help.context({ ws: 'minifier' }).topic.id, 'minifier');
  for (const id of ['source', 'output', 'advanced', 'cancel', 'retry']) {
    const controlId = `minifier.${id}`;
    const context = Help.context({ ws: 'minifier', controlId });
    assert.strictEqual(context.topic.id, 'minifier'); assert.strictEqual(context.controlId, controlId);
    const concise = Tips.resolveTip(Help, controlId, 'concise');
    const detailed = Tips.resolveTip(Help, controlId, 'detailed');
    assert.ok(concise.text && detailed.text.startsWith(concise.text));
    assert.ok(detailed.text.length > concise.text.length);
    assert.strictEqual(Tips.resolveTip(Help, controlId, 'off'), null);
  }
  for (const query of ['Minifier tour', 'Minifier clipboard', 'Minifier includes', 'Minifier retry']) {
    assert.ok(Help.search(query).some((r) => r.topic.id === 'minifier'), query);
  }
});

t('MIN-09 actual Minifier tour routes locally and skips unavailable panes/handoff without actions', async () => {
  const engine = Tours.create();
  for (const tour of Data.TOURS) assert.ok(engine.register(tour).ok);
  const tour = Tours.forContext(engine.list(), { ws: 'minifier' });
  assert.strictEqual(tour.id, 'minifier');
  assert.ok(tour.steps.every((s) => !s.before || (!s.before.click && s.before.ws === 'minifier')));
  const hidden = new Set(['#mnOutputPane', '#mnReturn']);
  for (const s of tour.steps.filter((s) => hidden.has(s.target))) assert.ok(s.optional);
  const run = engine.run(tour.id, async (step) => hidden.has(step.target) ? null : { el: step.target });
  const shown = [];
  for (let state = await run.start(); state.status === 'running'; state = await run.next()) shown.push(state.step.id);
  assert.deepStrictEqual(shown, ['source', 'options', 'compare', 'metrics', 'diagnostics', 'export']);
  assert.deepStrictEqual(run.state.skipped, ['output', 'editor']);
  const replay = engine.run(tour.id, async (s) => ({ el: s.target }));
  assert.strictEqual((await replay.start()).step.id, 'source');
  await replay.next(); assert.strictEqual((await replay.back()).step.id, 'source'); replay.abort();
  assert.strictEqual(replay.state.status, 'aborted');
});

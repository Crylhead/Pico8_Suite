// #66: Cart Builder preflight list and workflow stages (js/preflight-core.js) on a fake project plan.
const assert = require('assert');
const { t } = require('./harness.js');
const F = require('../js/preflight-core.js');

const plan = (over = {}) => ({
  mode: 'write', prefix: 'demo/', onDisk: new Set(['d0.p8', 'fx1.p8', 'old.p8']),
  carts: [{ name: 'd0.p8', parts: 3 }, { name: 'd1.p8', parts: 1 }],
  rewrites: [{ name: 'fx1.p8', changes: 2 }],
  assets: [{ name: 'logo', exists: true }, { name: 'fresh', exists: false }],
  removedAssets: ['oldname'], manifestExists: true, retire: ['old.p8'],
  kept: [{ cart: 'keep.p8', by: 'fx1.p8:9 reload' }], unresolved: [],
  ...over,
});

t('#66 preflight lists real targets with add / change / retire counts', () => {
  const r = F.build(plan());
  const by = (a) => r.files.filter((f) => f.action === a).map((f) => f.path).sort();
  assert.deepStrictEqual(by('add'), ['assets/fresh.json', 'demo/d1.p8']);
  assert.deepStrictEqual(by('change'), ['assets/logo.json', 'demo/d0.p8', 'demo/fx1.p8', 'demo/suite.json']);
  assert.deepStrictEqual(by('retire'), ['demo/old.p8']);
  assert.deepStrictEqual(by('remove'), ['assets/oldname.json']);
  assert.deepStrictEqual(r.counts, { add: 2, change: 4, retire: 1, remove: 1 });
  assert.strictEqual(r.confirmLabel, 'Write 8 files');
  assert.match(r.summary, /2 added, 4 changed, 1 removed, 1 moved to unused\//);
  assert.match(r.files.find((f) => f.path === 'demo/fx1.p8').why, /2 --@data anchor lines rewritten/);
  assert.match(r.files.find((f) => f.path === 'demo/old.p8').why, /moved to demo\/unused\/old\.p8/);
});

t('#66 flat demo folders have no demo/ prefix; unresolved references and kept carts are surfaced', () => {
  const r = F.build(plan({ prefix: '', unresolved: [{ file: 'fx2.p8', line: 14, call: 'reload(…)', why: 'computed name' }] }));
  assert.ok(r.files.some((f) => f.path === 'd1.p8' && f.action === 'add'));
  assert.ok(r.files.some((f) => f.path === 'suite.json'));
  assert.strictEqual(r.unresolved[0].file, 'fx2.p8');
  assert.ok(r.warnings.some((w) => /1 reference cannot be resolved, so no cart is moved/.test(w)));
  assert.ok(r.warnings.some((w) => /1 old cart stays in place because it is still referenced/.test(w)));
});

t('#66 adopt preflight discloses the first writes: fx anchors, new assets, a new manifest', () => {
  const r = F.build({ mode: 'adopt', prefix: 'demo/', onDisk: new Set(['fx1.p8']), carts: [], rewrites: [{ name: 'fx1.p8', changes: 4 }], assets: [{ name: 'a', exists: false }, { name: 'b', exists: false }], manifestExists: false, retire: [], kept: [], unresolved: [] });
  assert.deepStrictEqual(r.counts, { add: 3, change: 1, retire: 0, remove: 0 });
  assert.ok(r.files.find((f) => f.path === 'demo/suite.json').action === 'add');
  assert.strictEqual(r.confirmLabel, 'Write 4 files');
});

t('#66 stages: read-only analysis first, Commit is done only after a verified write and while nothing changed', () => {
  const s = (o) => Object.fromEntries(F.stages({ open: true, hasProject: true, partCount: 4, unplaced: 0, errors: 0, warnings: 0, needsWrite: false, lastWrite: '', ...o }).map((x) => [x.id, x.status]));
  assert.deepStrictEqual(s({ open: false, hasProject: false }), { analyze: 'todo', plan: 'todo', validate: 'todo', commit: 'todo' });
  assert.deepStrictEqual(s({ hasProject: false }), { analyze: 'current', plan: 'todo', validate: 'todo', commit: 'todo' });
  assert.deepStrictEqual(s({ unplaced: 2 }), { analyze: 'done', plan: 'current', validate: 'todo', commit: 'todo' });
  assert.deepStrictEqual(s({ errors: 1 }), { analyze: 'done', plan: 'done', validate: 'blocked', commit: 'todo' });
  assert.deepStrictEqual(s({ needsWrite: true }), { analyze: 'done', plan: 'done', validate: 'done', commit: 'current' });
  assert.deepStrictEqual(s({ lastWrite: '2 carts' }), { analyze: 'done', plan: 'done', validate: 'done', commit: 'done' });
  assert.strictEqual(s({ needsWrite: true, lastWrite: '2 carts' }).commit, 'current'); // an old success is never shown for new changes
});

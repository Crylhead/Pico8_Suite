// Restartable recovery, including retired carts (issue #40), over tests/fake-fs.js.
// Every failure and interruption here happens during recover() itself, not only during transact().
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/project-core.js');
const { makeFs } = require('./fake-fs.js');

const OLD = { 'd0.p8': 'data1', 'fx.p8': 'fx1', 'suite.json': 'manifest1' };
const NEW = { 'd0.p8': 'data2', 'fx.p8': 'fx2', 'suite.json': 'manifest2' };
const CARTS = { 'old.p8': 'old', 'old2.p8': 'old two' }; // both retired by the write
const JPATH = `demo/${P.JOURNAL}`;
const dirsOf = (fs) => ({
  demo: async () => fs.root.getDirectoryHandle('demo'),
  unused: async (create) => (await fs.root.getDirectoryHandle('demo')).getDirectoryHandle('unused', { create }),
});
const plan = () => ({
  writes: Object.keys(OLD).map((name) => ({ dir: 'demo', name, text: NEW[name], expect: OLD[name] })),
  retire: Object.keys(CARTS).map((name) => ({ from: 'demo', to: 'unused', name })),
});
const journal = (fs) => { const j = fs.snapshot()[JPATH]; return j ? JSON.parse(j) : null; };
const confirm = { confirmRollback: async () => true };

/** the complete old revision: originals and every retired cart back in demo/, nothing left in unused/ */
function isOld(snap, extra = {}) {
  const want = { ...Object.fromEntries(Object.entries({ ...OLD, ...CARTS }).map(([n, v]) => [`demo/${n}`, v])), ...extra };
  return JSON.stringify(Object.keys(snap).sort().map((k) => [k, snap[k]])) === JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]]));
}
function isNew(snap) {
  const want = { ...Object.fromEntries(Object.entries(NEW).map(([n, v]) => [`demo/${n}`, v])), ...Object.fromEntries(Object.entries(CARTS).map(([n, v]) => [`demo/unused/${n}`, v])) };
  return JSON.stringify(Object.keys(snap).sort().map((k) => [k, snap[k]])) === JSON.stringify(Object.keys(want).sort().map((k) => [k, want[k]]));
}
function reopen(snap) {
  const tree = {};
  for (const [path, text] of Object.entries(snap)) {
    const segs = path.split('/');
    let d = tree;
    for (const s of segs.slice(0, -1)) d = d[s] = d[s] || {};
    d[segs[segs.length - 1]] = text;
  }
  return makeFs(tree);
}
/** snapshots before every mutating operation of `run` (each one is "the browser stopped here") */
async function interruptions(fs, run) {
  const snaps = [];
  fs.fail((op) => { if (op !== 'read') snaps.push(fs.snapshot()); return null; });
  const result = await run().catch((e) => e);
  fs.clearFaults();
  snaps.push(fs.snapshot());
  return { snaps, result };
}

/** a successful write that retired both carts, whose clean-up failed: a committed journal stays */
async function committedWithRetiredCarts() {
  const fs = makeFs({ demo: { ...OLD, ...CARTS } });
  fs.fail((op, p) => (op === 'remove' && p === JPATH ? true : null));
  const r = await P.transact(dirsOf(fs), plan());
  assert.deepStrictEqual([r.retired, r.journalKept], [Object.keys(CARTS), true]);
  fs.clearFaults();
  return fs;
}
const denyRestoreOf = (fs, name, times = Infinity) => {
  let n = 0;
  fs.fail((op, p) => (op !== 'read' && p === `demo/${name}` && n++ < times ? true : null));
};

t('#40 a denied cart restore during rollback keeps the obligation: the retry restores the complete old project', async () => {
  const fs = await committedWithRetiredCarts();
  fs.put('demo/fx.p8', 'fx edited elsewhere');
  denyRestoreOf(fs, 'old.p8');
  const first = await P.recover(dirsOf(fs), confirm);
  assert.strictEqual(first.outcome, 'unresolved');
  assert.ok(first.problems.some((p) => /old\.p8/.test(p)), first.problems.join(';'));
  assert.strictEqual(journal(fs).state, 'rolling-back');
  const snap = fs.snapshot();
  assert.strictEqual(snap['demo/unused/old.p8'], 'old', 'the retired copy is not removed while it cannot be restored');
  assert.strictEqual(snap['demo/old2.p8'], 'old two', 'the other cart is restored (partial unretirement)');
  fs.clearFaults();
  const second = await P.recover(dirsOf(fs), confirm);
  assert.deepStrictEqual([second.outcome, second.problems], ['old', []]);
  assert.ok(isOld(fs.snapshot()), JSON.stringify(fs.snapshot()));
  assert.strictEqual(await P.recover(dirsOf(fs)), null, 'journal removed only once complete');
});

t('#40 an interrupted rollback, at every persistent step of recovery itself, finishes on the next recovery', async () => {
  const fs = await committedWithRetiredCarts();
  fs.put('demo/fx.p8', 'fx edited elsewhere');
  const { snaps, result } = await interruptions(fs, () => P.recover(dirsOf(fs), confirm));
  assert.deepStrictEqual([result.outcome, result.problems], ['old', []]);
  assert.ok(snaps.length >= 8, `${snaps.length} steps`);
  for (const [k, snap] of snaps.entries()) {
    const again = reopen(snap);
    // an interruption of the reopened recovery as well (bounded: every step of a second attempt)
    const nested = await interruptions(again, () => P.recover(dirsOf(again), confirm));
    for (const [m, s2] of [...nested.snaps.entries()]) {
      const last = reopen(s2);
      const r = await P.recover(dirsOf(last), confirm);
      assert.ok(!r || !r.problems.length, `#${k}/${m}: ${r && r.problems}`);
      assert.ok(isOld(last.snapshot()), `#${k}/${m}: ${JSON.stringify(last.snapshot())}`);
    }
  }
});

t('#40 a rollback that failed before restoring carts (old payload, carts still in unused/) is not mistaken for the old project', async () => {
  const fs = await committedWithRetiredCarts();
  // the browser stopped after the payload restore: every write holds its original, the journal says rolling-back
  for (const [n, v] of Object.entries(OLD)) fs.put(`demo/${n}`, v);
  const j = journal(fs);
  fs.put(JPATH, JSON.stringify({ ...j, state: 'rolling-back', recovery: 'R' }));
  const r = await P.recover(dirsOf(fs), confirm);
  assert.deepStrictEqual([r.outcome, r.problems], ['old', []]);
  assert.ok(isOld(fs.snapshot()), JSON.stringify(fs.snapshot()));
});

t('#40 a conflicting file at a retired cart\'s place is not overwritten; evidence stays until it is resolved', async () => {
  const fs = await committedWithRetiredCarts();
  fs.put('demo/fx.p8', 'fx edited elsewhere');
  fs.put('demo/old.p8', 'a different cart made meanwhile');
  const r = await P.recover(dirsOf(fs), confirm);
  assert.strictEqual(r.outcome, 'unresolved');
  assert.ok(r.problems.some((p) => /demo\/old\.p8/.test(p) && /other contents|changed/.test(p)), r.problems.join(';'));
  const snap = fs.snapshot();
  assert.strictEqual(snap['demo/old.p8'], 'a different cart made meanwhile', 'the conflicting file is untouched');
  assert.strictEqual(snap['demo/unused/old.p8'], 'old', 'the retired copy stays');
  assert.ok(JSON.parse(snap[JPATH]).retire.some((x) => x.name === 'old.p8' && x.before === 'old'), 'the journal keeps the original');
  assert.strictEqual(snap['demo/old2.p8'], 'old two');
  // the user moves the conflicting file away; the next recovery completes
  await (await fs.root.getDirectoryHandle('demo')).removeEntry('old.p8');
  const again = await P.recover(dirsOf(fs), confirm);
  assert.deepStrictEqual([again.outcome, again.problems], ['old', []]);
  assert.ok(isOld(fs.snapshot()), JSON.stringify(fs.snapshot()));
});

t('#40 an older cart already in unused/ is neither overwritten by retirement nor lost by a rollback', async () => {
  const fs = makeFs({ demo: { ...OLD, ...CARTS, unused: { 'old.p8': 'an older retired old.p8' } } });
  fs.fail((op, p) => (op === 'remove' && p === JPATH ? true : null));
  const r = await P.transact(dirsOf(fs), plan());
  fs.clearFaults();
  assert.deepStrictEqual(r.retired, ['old2.p8']);
  assert.ok(r.retireErrors.some((e) => /old\.p8/.test(e)), r.retireErrors.join(';'));
  let snap = fs.snapshot();
  assert.deepStrictEqual([snap['demo/old.p8'], snap['demo/unused/old.p8']], ['old', 'an older retired old.p8']);
  fs.put('demo/fx.p8', 'fx edited elsewhere');
  const back = await P.recover(dirsOf(fs), confirm);
  assert.deepStrictEqual([back.outcome, back.problems], ['old', []]);
  assert.ok(isOld(fs.snapshot(), { 'demo/unused/old.p8': 'an older retired old.p8' }), JSON.stringify(fs.snapshot()));
});

t('#40 finishing a committed write: interrupted retirement (copy made, source not removed) completes on every reopen', async () => {
  const fs = makeFs({ demo: { ...OLD, ...CARTS } });
  const { snaps } = await interruptions(fs, () => P.transact(dirsOf(fs), plan()));
  const committed = snaps.filter((s) => s[JPATH] && JSON.parse(s[JPATH]).state === 'committed');
  assert.ok(committed.length >= 4);
  for (const [k, snap] of committed.entries()) {
    const again = reopen(snap);
    const nested = await interruptions(again, () => P.recover(dirsOf(again)));
    for (const [m, s2] of nested.snaps.entries()) {
      const last = reopen(s2);
      const r = await P.recover(dirsOf(last));
      assert.ok(!r || !r.problems.length, `#${k}/${m}: ${r && r.problems}`);
      assert.ok(isNew(last.snapshot()), `#${k}/${m}: ${JSON.stringify(last.snapshot())}`);
    }
  }
});

t('#40 a journal from before this fix (no recorded cart originals) still brings carts back from unused/', async () => {
  const fs = await committedWithRetiredCarts();
  const j = journal(fs);
  // the format-2 journal of #31/#32: retire entries without originals, rollback already recorded
  fs.put(JPATH, JSON.stringify({ ...j, format: 2, state: 'rolling-back', retire: j.retire.map(({ from, to, name }) => ({ from, to, name })) }));
  for (const [n, v] of Object.entries(OLD)) fs.put(`demo/${n}`, v);
  denyRestoreOf(fs, 'old2.p8', 1);
  const first = await P.recover(dirsOf(fs), confirm);
  assert.strictEqual(first.outcome, 'unresolved');
  assert.ok(journal(fs).retire.every((x) => 'before' in x), 'the obligation is now recorded in the journal');
  fs.clearFaults();
  const r = await P.recover(dirsOf(fs), confirm);
  assert.deepStrictEqual([r.outcome, r.problems], ['old', []]);
  assert.ok(isOld(fs.snapshot()), JSON.stringify(fs.snapshot()));
});

t('#40 without Web Locks a writer whose journal was taken over during retirement moves no further cart', async () => {
  const fs = makeFs({ demo: { ...OLD, ...CARTS } });
  const theirs = JSON.stringify({ format: 3, id: 'B', state: 'rolling-back', recovery: 'B', writes: [], retire: [] });
  // another tab's recovery marks the journal right after this write copied old.p8 to unused/
  fs.fail((op, p) => { if (op === 'close' && p === 'demo/unused/old.p8') fs.put(JPATH, theirs); return null; });
  const r = await P.transact(dirsOf(fs), plan(), { lock: P.createLock({ locks: null }) });
  const snap = fs.snapshot();
  assert.strictEqual(r.journalKept, true);
  assert.strictEqual(snap[JPATH], theirs, 'the other tab\'s journal survives');
  assert.deepStrictEqual([snap['demo/old.p8'], snap['demo/old2.p8'], snap['demo/unused/old2.p8']], ['old', 'old two', undefined], 'no cart left demo/ after the take-over');
  assert.ok(r.retireErrors.length >= 1, r.retireErrors.join(';'));
});

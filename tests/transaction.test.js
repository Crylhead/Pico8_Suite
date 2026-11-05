// Cart Packer transaction ownership and recovery decisions (issues #31, #32), over tests/fake-fs.js.
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/project-core.js');
const { makeFs } = require('./fake-fs.js');

const OLD = { 'd0.p8': 'data1', 'fx.p8': 'fx1', 'suite.json': 'manifest1' };
const NEW = { 'd0.p8': 'data2', 'fx.p8': 'fx2', 'suite.json': 'manifest2' };
const JPATH = `demo/${P.JOURNAL}`;
const project = () => makeFs({ demo: { ...OLD, 'old.p8': 'old' } });
const dirsOf = (fs) => ({
  demo: async () => fs.root.getDirectoryHandle('demo'),
  unused: async (create) => (await fs.root.getDirectoryHandle('demo')).getDirectoryHandle('unused', { create }),
});
const plan = (v = NEW) => ({
  writes: Object.keys(OLD).map((name) => ({ dir: 'demo', name, text: v[name], expect: OLD[name], stage: name === 'suite.json' ? 'manifest' : 'cart' })),
  retire: [{ from: 'demo', to: 'unused', name: 'old.p8' }],
});
const journalState = (fs) => { const j = fs.snapshot()[JPATH]; return j ? JSON.parse(j).state : null; };
const deferred = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

/** which complete revision the folder holds after recovery: 'old' | 'new' | a description of the mix */
function revision(snap) {
  const at = (n) => snap[`demo/${n}`];
  if (Object.keys(OLD).every((n) => at(n) === OLD[n]) && snap['demo/old.p8'] === 'old' && !snap['demo/unused/old.p8']) return 'old';
  if (Object.keys(NEW).every((n) => at(n) === NEW[n]) && (snap['demo/old.p8'] ?? snap['demo/unused/old.p8']) === 'old') return 'new';
  return `mixed ${JSON.stringify(snap)}`;
}
/** a fresh fake folder from a snapshot ("the browser stopped here; reopen the project") */
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
/** snapshots before every mutating operation of `run` */
async function interruptions(fs, run) {
  const snaps = [fs.snapshot()];
  fs.fail((op) => { if (op !== 'read') snaps.push(fs.snapshot()); return null; });
  await run().catch(() => null);
  snaps.push(fs.snapshot());
  return snaps;
}
/** reopening every interruption point recovers one coherent revision and removes the journal */
async function assertRecoversCoherently(snaps, what) {
  const seen = new Set();
  for (const [k, snap] of snaps.entries()) {
    const fs = reopen(snap);
    const r = await P.recover(dirsOf(fs));
    assert.ok(!r || !r.problems.length, `${what} #${k}: ${r && r.problems}`);
    const rev = revision(fs.snapshot());
    assert.ok(rev === 'old' || rev === 'new', `${what} #${k}: ${rev}`);
    assert.strictEqual(fs.snapshot()[JPATH], undefined, `${what} #${k}: journal removed once coherent`);
    seen.add(rev);
  }
  return seen;
}
// the readback right after the 'committed' marker reached the disk
const committedRead = (fs) => (op, p) => op === 'read' && p === JPATH && journalState(fs) === 'committed';

t('#31 a committed marker that fails its close or readback rolls back completely; nothing is retired', async () => {
  for (const op of ['close', 'read']) {
    const fs = project();
    const start = fs.snapshot();
    let hit = false;
    fs.fail((o, p) => (!hit && o === op && p === JPATH && (op === 'read' ? journalState(fs) === 'committed' : fs.log.filter((l) => l === `close ${JPATH}`).length === 2) ? (hit = true) : null));
    const e = await P.transact(dirsOf(fs), plan()).then(() => null, (x) => x);
    assert.ok(hit, op);
    assert.deepStrictEqual([e.stage, e.restored, e.journalKept], ['commit', true, false], op);
    assert.deepStrictEqual(fs.snapshot(), start, `${op}: old project, old.p8 in place`);
  }
});

t('#31 a partial rollback after a failed commit keeps a rolling-back journal; reopening restores the old project', async () => {
  for (const denied of Object.keys(OLD)) {
    const fs = project();
    const start = fs.snapshot();
    let failed = false;
    let denials = 0;
    fs.fail((op, p) => {
      if (!failed && committedRead(fs)(op, p)) return (failed = true);
      return failed && op !== 'read' && p === `demo/${denied}` && denials++ === 0 ? true : null;
    });
    const e = await P.transact(dirsOf(fs), plan()).then(() => null, (x) => x);
    assert.deepStrictEqual([e.stage, e.restored, e.journalKept], ['commit', false, true], denied);
    assert.strictEqual(journalState(fs), 'rolling-back', `${denied}: the rollback decision is on disk`);
    assert.strictEqual(fs.snapshot()['demo/old.p8'], 'old', 'nothing retired');
    await assert.rejects(P.transact(dirsOf(fs), plan()), /recover/, 'no new write over the pending journal');
    fs.clearFaults();
    const r = await P.recover(dirsOf(fs));
    assert.deepStrictEqual([r.state, r.outcome, r.problems, r.retired], ['rolling-back', 'old', [], []], denied);
    assert.deepStrictEqual(fs.snapshot(), start, `${denied}: complete old project, journal gone`);
  }
});

t('#31 if no rollback can be recorded nothing is restored; reopening finishes the verified new project', async () => {
  const fs = project();
  let failed = false;
  fs.fail((op, p) => {
    if (!failed && committedRead(fs)(op, p)) return (failed = true);
    return failed && p === JPATH ? true : null; // the journal is unreachable from now on
  });
  const e = await P.transact(dirsOf(fs), plan()).then(() => null, (x) => x);
  assert.deepStrictEqual([e.stage, e.restored, e.journalKept], ['commit', false, true]);
  assert.match(e.message, /nothing was restored/);
  assert.strictEqual(revision(fs.snapshot()), 'new', 'every file still holds the new contents');
  fs.clearFaults();
  const r = await P.recover(dirsOf(fs));
  assert.deepStrictEqual([r.outcome, r.retired, r.problems], ['new', ['old.p8'], []]);
  assert.strictEqual(revision(fs.snapshot()), 'new');
  assert.strictEqual(fs.snapshot()[JPATH], undefined);
});

t('#31 every interruption point of a successful write and of a failed commit with partial rollback recovers coherently', async () => {
  const ok = project();
  const okSeen = await assertRecoversCoherently(await interruptions(ok, () => P.transact(dirsOf(ok), plan())), 'success');
  assert.deepStrictEqual([...okSeen].sort(), ['new', 'old']);
  const bad = project();
  let failed = false;
  let denials = 0;
  bad.fail((op, p) => {
    if (!failed && committedRead(bad)(op, p)) return (failed = true);
    return failed && op !== 'read' && p === 'demo/d0.p8' && denials++ === 0 ? true : null;
  });
  const badSeen = await assertRecoversCoherently(await interruptions(bad, () => P.transact(dirsOf(bad), plan())), 'failed commit');
  assert.ok(badSeen.has('old'));
});

t('#31 a committed journal over mixed files is not finished: nothing changes until a rollback is confirmed', async () => {
  const fs = project();
  fs.fail((op, p) => (op === 'remove' && p === JPATH ? true : null)); // the clean-up fails: 'committed' stays
  const done = await P.transact(dirsOf(fs), plan());
  assert.deepStrictEqual([done.retired, done.journalKept], [['old.p8'], true]);
  fs.clearFaults();
  fs.put('demo/fx.p8', 'fx edited elsewhere');
  const mixed = fs.snapshot();
  const r = await P.recover(dirsOf(fs));
  assert.deepStrictEqual([r.outcome, r.mixed, r.retired], ['unresolved', ['demo/fx.p8'], []]);
  assert.deepStrictEqual(fs.snapshot(), mixed, 'no retirement, no removal of the originals');
  assert.strictEqual((await P.recover(dirsOf(fs), { confirmRollback: async () => false })).outcome, 'declined');
  assert.deepStrictEqual(fs.snapshot(), mixed);
  const asked = [];
  const back = await P.recover(dirsOf(fs), { confirmRollback: async (q) => { asked.push(q.reason); return true; } });
  assert.deepStrictEqual([asked, back.outcome, back.problems], [['mixed'], 'old', []]);
  assert.strictEqual(revision(fs.snapshot()), 'old', 'originals and the retired cart are back');
  assert.strictEqual(await P.recover(dirsOf(fs)), null);
});

t('#32 overlapping writers in one page: the second write and a recovery are refused untouched; the first completes', async () => {
  const fs = project();
  const gate = deferred();
  let paused = null;
  fs.hold = (op, p) => (op === 'close' && p === 'demo/fx.p8' && !paused ? (paused = gate.p) : null);
  const a = P.transact(dirsOf(fs), plan(), { id: 'A' });
  while (!paused) await new Promise((r) => setImmediate(r));
  const live = fs.snapshot();
  assert.strictEqual(JSON.parse(live[JPATH]).id, 'A');
  const b = await P.transact(dirsOf(fs), plan({ ...NEW, 'd0.p8': 'B' }), { id: 'B' }).then(() => null, (x) => x);
  assert.deepStrictEqual([b.stage, b.journalKept], ['busy', false]);
  assert.strictEqual((await P.recover(dirsOf(fs))).outcome, 'busy');
  assert.deepStrictEqual(fs.snapshot(), live, 'the refused writer and the recovery touched nothing');
  gate.open();
  assert.deepStrictEqual((await a).retired, ['old.p8']);
  assert.strictEqual(revision(fs.snapshot()), 'new');
  assert.strictEqual(fs.snapshot()[JPATH], undefined);
});

t('#32 two tabs (Web Locks): a writer in one tab refuses another tab\'s write and recovery; interruptions recover', async () => {
  const name = `test-lock-${Math.random()}`;
  const tab1 = P.createLock({ name });
  const tab2 = P.createLock({ name });
  assert.ok(tab1.crossTab, 'Node provides navigator.locks');
  const fs = project();
  const gate = deferred();
  let paused = null;
  const snaps = [];
  fs.fail((op) => { if (op !== 'read') snaps.push(fs.snapshot()); return null; });
  fs.hold = (op, p) => (op === 'write' && p === 'demo/suite.json' && !paused ? (paused = gate.p) : null);
  const a = P.transact(dirsOf(fs), plan(), { lock: tab1 });
  while (!paused) await new Promise((r) => setImmediate(r));
  const live = fs.snapshot();
  const b = await P.transact(dirsOf(fs), plan(), { lock: tab2 }).then(() => null, (x) => x);
  assert.strictEqual(b.stage, 'busy');
  assert.strictEqual((await P.recover(dirsOf(fs), { lock: tab2 })).outcome, 'busy');
  assert.deepStrictEqual(fs.snapshot(), live);
  gate.open();
  await a;
  assert.strictEqual(revision(fs.snapshot()), 'new');
  assert.ok((await P.transact(dirsOf(fs), { writes: [{ dir: 'demo', name: 'fx.p8', text: 'fx3', expect: 'fx2' }] }, { lock: tab2 })).journalKept === false, 'tab 2 writes once tab 1 is done');
  await assertRecoversCoherently(snaps.filter((s) => s['demo/fx.p8'] !== 'fx3'), 'tab 1 write');
});

t('#32 without Web Locks a writer that loses its journal removes nobody else\'s; sequential writes still work', async () => {
  const lock = P.createLock({ locks: null });
  assert.strictEqual(lock.crossTab, false);
  const fs = project();
  const start = fs.snapshot();
  const theirs = JSON.stringify({ format: 2, id: 'B', state: 'writing', writes: [], retire: [] });
  let swapped = false;
  // another tab replaces the journal between A's write and A's readback
  fs.fail((op, p) => { if (!swapped && op === 'read' && p === JPATH && fs.snapshot()[JPATH]) { swapped = true; fs.put(JPATH, theirs); } return null; });
  const e = await P.transact(dirsOf(fs), plan(), { lock, id: 'A' }).then(() => null, (x) => x);
  assert.deepStrictEqual([e.stage, e.restored, e.journalKept], ['journal', true, true]);
  assert.strictEqual(fs.snapshot()[JPATH], theirs, 'the other writer\'s journal survives');
  assert.deepStrictEqual({ ...fs.snapshot(), [JPATH]: undefined }, { ...start, [JPATH]: undefined }, 'A wrote nothing');
  fs.clearFaults();
  await (await fs.root.getDirectoryHandle('demo')).removeEntry(P.JOURNAL); // the other tab finished
  await P.transact(dirsOf(fs), plan({ ...NEW, 'fx.p8': 'x' }), { lock }); // the failure released the lock
  assert.strictEqual(lock.held, false);
  const second = await P.transact(dirsOf(fs), { writes: [{ dir: 'demo', name: 'fx.p8', text: 'fx3', expect: 'x' }] }, { lock });
  assert.deepStrictEqual([second.journalKept, fs.snapshot()['demo/fx.p8']], [false, 'fx3']);
});

t('#32 without Web Locks a recovery in another tab takes over a live write: the writer stops, nothing ends up mixed', async () => {
  const fs = project();
  const gate = deferred();
  let paused = null;
  // tab A has written d0.p8 and is about to write fx.p8 when tab B opens the project and recovers
  fs.hold = (op, p) => (op === 'read' && p === JPATH && fs.snapshot()['demo/d0.p8'] === NEW['d0.p8'] && !paused ? (paused = gate.p) : null);
  const a = P.transact(dirsOf(fs), plan(), { lock: P.createLock({ locks: null }), id: 'A' }).then(() => null, (x) => x);
  while (!paused) await new Promise((r) => setImmediate(r));
  fs.hold = null;
  const r = await P.recover(dirsOf(fs), { lock: P.createLock({ locks: null }), confirmRollback: () => true });
  assert.deepStrictEqual([r.state, r.outcome, r.problems], ['writing', 'old', []]);
  gate.open();
  const e = await a;
  assert.deepStrictEqual([e.stage, e.restored, e.journalKept], ['ownership', true, false]);
  assert.match(e.message, /no longer this write's journal/);
  assert.strictEqual(revision(fs.snapshot()), 'old', 'A wrote nothing after B restored');
  assert.strictEqual(fs.snapshot()[JPATH], undefined);

  // a write still in flight while the other tab's recovery saw only old files and removed the journal
  const fs2 = project();
  const gate2 = deferred();
  let held = null;
  fs2.hold = (op, p) => (op === 'close' && p === 'demo/d0.p8' && !held ? (held = gate2.p) : null);
  const a2 = P.transact(dirsOf(fs2), plan(), { lock: P.createLock({ locks: null }), id: 'A' }).then(() => null, (x) => x);
  while (!held) await new Promise((r) => setImmediate(r));
  fs2.hold = null;
  assert.strictEqual((await P.recover(dirsOf(fs2), { lock: P.createLock({ locks: null }) })).outcome, 'old');
  gate2.open();
  const e2 = await a2;
  assert.deepStrictEqual([e2.stage, e2.restored, e2.journalKept], ['ownership', true, false]);
  assert.match(e2.message, /restored demo\/d0\.p8/);
  assert.strictEqual(revision(fs2.snapshot()), 'old', 'the late write was undone from memory');
});

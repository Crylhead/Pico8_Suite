// Pixel Studio history retention (issue #10): structural and pixel entries, on both
// stacks, share one count/byte budget. Tiny budgets keep the fixture small.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const K = require('../js/studio-core.js');

const px = (n, tag) => ({ kind: 'px', tag, before: new Uint8Array(n), after: new Uint8Array(n) });
const docEntry = (w, h, frames, layers, tag) => {
  const d = K.newDoc(w, h);
  d.layers = Array.from({ length: layers }, (_, i) => ({ name: `L${i}`, visible: true }));
  d.frames = Array.from({ length: frames }, () => ({ cels: Array.from({ length: layers }, () => K.blankCel(w, h)) }));
  return { kind: 'doc', tag, snapshot: d };
};
// Inverse of an entry, as Pixel Studio's applyEntry produces: px patches are reused,
// doc entries come back as a snapshot of the document they replace (`next` sizes it).
const swapper = (next) => (e) => (e.kind === 'px' ? e : { ...next(e), tag: e.tag });
const sum = (n, f) => Array.from({ length: n }, f).reduce((a, b) => a + b, 0);

t('studio.js routes every history change through createHistory', () => {
  const src = fs.readFileSync(path.join(__dirname, '../js/studio.js'), 'utf8');
  assert.doesNotMatch(src, /ps\.(undo|redo)\b/, 'direct ps.undo/ps.redo stack access bypasses the retention policy');
  assert.match(src, /K\.createHistory\(\{ limit: UNDO_LIMIT, maxBytes: UNDO_BYTES \}\)/);
});

t('studio history: undo/redo round trip and exact accounting', () => {
  const h = K.createHistory({ limit: 10, maxBytes: 1000 });
  const doc = docEntry(4, 2, 3, 2, 'layer'); // 3 frames x 2 layers x 8 bytes
  assert.strictEqual(K.historyEntryBytes(doc), 48);
  doc.snapshot.frames[2].cels.pop(); // uneven frames are summed as they are
  assert.strictEqual(K.historyEntryBytes(doc), 40);
  h.record(px(5, 'stroke1'));
  h.record(doc);
  h.record(px(3, 'stroke2'));
  assert.strictEqual(h.bytes, 10 + 40 + 6);
  const order = [];
  const apply = (e) => (order.push(e.tag), swapper(() => docEntry(4, 2, 1, 1))(e));
  while (h.undo(apply));
  assert.deepStrictEqual(order, ['stroke2', 'layer', 'stroke1']);
  assert.deepStrictEqual([h.undoCount, h.redoCount, h.bytes], [0, 3, 10 + 8 + 6]); // redo holds the 1x1 doc
  assert.strictEqual(h.redo(apply).tag, 'stroke1');
  assert.strictEqual(h.redo(apply).tag, 'layer');
  h.record(px(1, 'new')); // a new edit discards the remaining redo
  assert.deepStrictEqual([h.undoCount, h.redoCount, h.bytes], [3, 0, 10 + 8 + 2]);
  assert.strictEqual(h.redo(apply), null);
  h.clear();
  assert.deepStrictEqual([h.undoCount, h.redoCount, h.bytes], [0, 0, 0]);
});

t('studio history: >200 structural and mixed edits stay within count and byte budgets', () => {
  const h = K.createHistory(); // default 200-entry limit; tiny entries
  for (let i = 0; i < 250; i++) h.record(docEntry(2, 2, 1, 1, i));
  assert.strictEqual(h.undoCount, K.HISTORY_LIMIT);
  assert.strictEqual(h.bytes, K.HISTORY_LIMIT * 4);
  const tags = [];
  while (h.undo((e) => (tags.push(e.tag), e)));
  assert.deepStrictEqual([tags[0], tags.at(-1)], [249, 50]); // the oldest 50 were discarded

  const m = K.createHistory({ limit: 1000, maxBytes: 100 });
  for (let i = 0; i < 40; i++) {
    m.record(i % 3 ? px(4, i) : docEntry(3, 3, 2, 1, i)); // 8 or 18 bytes
    assert.ok(m.bytes <= 100, `step ${i}: ${m.bytes} bytes`);
  }
  assert.ok(m.undoCount >= 6);
});

t('studio history: undo/redo snapshots are accounted and an oversized entry is kept alone', () => {
  const h = K.createHistory({ limit: 50, maxBytes: 64 });
  for (let i = 0; i < 4; i++) h.record(docEntry(2, 2, 1, 1, i)); // 4 x 4 bytes
  // Undoing a resize: the redo snapshot (current 6x6 doc = 36 bytes) is larger than the entry.
  const grow = swapper(() => docEntry(6, 6, 1, 1));
  for (let cycle = 0; cycle < 20; cycle++) {
    while (h.undo(grow));
    while (h.redo(grow));
    assert.ok(h.bytes <= 64, `cycle ${cycle}: ${h.bytes} bytes`);
  }
  assert.strictEqual(h.bytes, sum(h.undoCount, () => 36));

  // One entry over the whole budget survives on its own, so the latest step can still be undone.
  h.record(px(100, 'huge'));
  assert.deepStrictEqual([h.undoCount, h.redoCount, h.bytes], [1, 0, 200]);
  assert.strictEqual(h.undo((e) => e).tag, 'huge');
  assert.deepStrictEqual([h.undoCount, h.redoCount, h.bytes], [0, 1, 200]);
  h.record(px(2, 'small')); // recording drops the oversized redo entry
  assert.deepStrictEqual([h.undoCount, h.redoCount, h.bytes], [1, 0, 4]);
});

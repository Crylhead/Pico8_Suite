// #58: shared save / operation status contract (js/doc-status-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const D = require('../js/doc-status-core.js');

const tracker = (mode = 'persistent') => {
  const box = { mode };
  const s = D.create({ storage: () => box.mode, now: () => 1 });
  s.box = box;
  return s;
};
const key = (s) => s.describe().key;

t('#58 new, edited and Library-saved documents have distinct states', () => {
  const s = tracker();
  assert.strictEqual(key(s), 'new');
  assert.strictEqual(s.dirty(), false);
  s.edit();
  assert.deepStrictEqual([key(s), s.dirty()], ['unsaved', true]);
  const tk = s.begin('library');
  assert.strictEqual(key(s), 'saving');
  assert.strictEqual(s.dirty(), true, 'in flight is not saved');
  assert.strictEqual(s.resolve(tk, { name: 'level 1' }), true);
  const v = s.describe();
  assert.deepStrictEqual([v.key, v.label, v.icon, s.dirty()], ['saved-library', 'Saved to Library', '✓', false]);
  s.open({ name: 'cart', target: 'file' });
  assert.strictEqual(s.describe().label, 'Saved to file');
});

t('#58 edits during an in-flight save stay unsaved after it succeeds', () => {
  const s = tracker();
  s.edit();
  const tk = s.begin('library');
  s.edit();
  s.resolve(tk);
  assert.strictEqual(s.dirty(), true);
  assert.strictEqual(key(s), 'unsaved');
});

t('#58 rejection keeps work dirty and a persistent actionable error until a later success', () => {
  const s = tracker();
  s.edit();
  const tk = s.begin('library', { intent: { asNew: false } });
  assert.strictEqual(s.reject(tk, { message: 'Save to Library failed: browser storage is full (quota exceeded)' }), true);
  let v = s.describe();
  assert.deepStrictEqual([v.key, v.tone, v.icon, s.dirty()], ['failed', 'error', '✕', true]);
  assert.deepStrictEqual(v.actions, ['retry', 'dismiss']);
  assert.match(v.detail, /quota exceeded\)\. Your changes are still open and not saved\./);
  assert.deepStrictEqual(s.error().intent, { asNew: false }, 'retry can repeat the same intent');
  s.edit();
  assert.strictEqual(key(s), 'failed', 'still visible after further edits (toasts fade, this does not)');
  const retry = s.begin('library');
  assert.strictEqual(key(s), 'saving');
  s.resolve(retry);
  assert.deepStrictEqual([key(s), s.dirty(), s.error()], ['saved-library', false, null]);
});

t('#58 cancellation and dismissal never mark saved', () => {
  const s = tracker();
  s.edit();
  const tk = s.begin('library');
  s.cancel(tk);
  assert.deepStrictEqual([key(s), s.dirty(), s.pending()], ['unsaved', true, null]);
  const tk2 = s.begin('library');
  s.reject(tk2, { kind: 'conflict', message: 'changed in another tab' });
  const tk3 = s.begin('library');
  s.cancel(tk3);
  assert.strictEqual(key(s), 'conflict', 'cancelling a resolution keeps the conflict');
  s.dismiss();
  assert.deepStrictEqual([key(s), s.dirty()], ['unsaved', true]);
});

t('#58 completions for another document are ignored', () => {
  const s = tracker();
  s.edit();
  const old = s.begin('library');
  const oldSession = s.snapshot();
  s.open({ name: 'other', dirty: true });
  assert.strictEqual(s.resolve(old), false);
  assert.strictEqual(s.reject(old, { message: 'x' }), false);
  assert.strictEqual(s.cancel(old), false);
  assert.strictEqual(s.session(oldSession, false), false);
  assert.deepStrictEqual([key(s), s.dirty(), s.pending(), s.error()], ['unsaved', true, null, null]);
});

t('#58 an older save finishing after a newer one does not regress the saved revision', () => {
  const s = tracker();
  s.edit();
  const a = s.begin('library');
  s.edit();
  const b = s.begin('library');
  s.resolve(b);
  assert.strictEqual(s.dirty(), false);
  assert.strictEqual(s.resolve(a), false);
  assert.strictEqual(s.dirty(), false);
  s.edit();
  const c = s.begin('library');
  s.reject(c, { message: 'quota' });
  assert.strictEqual(s.resolve(a), false, 'a stale success cannot clear a newer failure');
  assert.strictEqual(key(s), 'failed');
});

t('#58 downloads are copies, not saves', () => {
  const s = tracker();
  s.open({ name: 'm', target: 'library' });
  s.edit();
  s.downloaded('m.p8');
  let v = s.describe();
  assert.deepStrictEqual([v.key, v.icon, s.dirty()], ['downloaded', '↓', true]);
  assert.match(v.detail, /not a save; the Library has an older version/);
  s.edit();
  assert.strictEqual(key(s), 'unsaved', 'a later edit is not in the download');
  const fresh = tracker();
  fresh.downloaded('map.png');
  assert.strictEqual(key(fresh), 'downloaded');
  assert.strictEqual(fresh.dirty(), false);
});

t('#58 memory-only and failed session autosave are distinguished from browser-only', () => {
  const s = tracker();
  s.edit();
  const ok = s.snapshot();
  s.session(ok, true);
  assert.deepStrictEqual([key(s), s.atRisk()], ['unsaved', false]);
  assert.match(s.describe().detail, /kept in this browser only/);
  const bad = s.snapshot();
  s.session(bad, false);
  assert.deepStrictEqual([key(s), s.atRisk()], ['memory', true]);
  s.session(ok, true);
  assert.strictEqual(key(s), 'memory', 'an older session result does not hide a newer failure');
  const m = tracker('memory');
  m.edit();
  assert.deepStrictEqual([m.describe().label, m.atRisk()], ['Unsaved · memory only', true]);
  const tk = m.begin('library');
  m.resolve(tk);
  assert.deepStrictEqual([m.describe().label, m.atRisk()], ['In Library · memory only', false]);
});

t('#58 a deleted target or external change becomes a persistent conflict', () => {
  const s = tracker();
  s.open({ name: 'm', target: 'library' });
  s.conflict('The Library copy changed in another tab');
  assert.deepStrictEqual([key(s), s.dirty()], ['conflict', false]);
  const tk = s.begin('library');
  s.resolve(tk);
  assert.strictEqual(key(s), 'saved-library');
  s.lost('The Library copy was deleted');
  assert.deepStrictEqual([key(s), s.dirty()], ['conflict', true]);
  s.dismiss();
  assert.strictEqual(key(s), 'unsaved');
});

t('#58 subscribers are notified; every state has text and an icon', () => {
  const s = tracker();
  let n = 0;
  const off = s.subscribe(() => n++);
  s.edit();
  off();
  s.edit();
  assert.strictEqual(n, 1);
  for (const st of [
    { revision: 0, clean: 0, storage: 'persistent' },
    { revision: 1, clean: 0, dirty: true, storage: 'persistent' },
    { revision: 1, clean: 0, dirty: true, storage: 'memory' },
    { pending: { target: 'project' }, storage: 'persistent' },
    { error: { kind: 'recovery', message: 'Restore the retired carts' }, dirty: true, storage: 'persistent' },
    { saved: { target: 'project' }, storage: 'persistent' },
  ]) {
    const v = D.describe(st);
    assert.ok(v.icon && v.label && v.detail && v.tone, JSON.stringify(v));
  }
});

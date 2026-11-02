// #54: shared UX preferences (js/ux-prefs-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/ux-prefs-core.js');

function memStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    fail: { get: false, set: false, remove: false },
    getItem(k) { if (this.fail.get) throw new Error('SecurityError: denied'); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (this.fail.set) throw new Error('QuotaExceededError'); data.set(k, String(v)); },
    removeItem(k) { if (this.fail.remove) throw new Error('denied'); data.delete(k); },
  };
}
const stored = (s) => JSON.parse(s.data.get(P.KEY));

t('#54 defaults are deterministic and keep the existing Suite', () => {
  const p = P.create({ storage: memStorage() });
  assert.deepStrictEqual(p.get(), { helpLevel: 'concise', autoOfferTours: true, compactNav: false, motion: 'system' });
  assert.deepStrictEqual(p.status(), { persistent: true, error: null, ignored: [] });
  assert.deepStrictEqual(P.create().get(), p.get(), 'memory-only instance has the same defaults');
});

t('#54 a change persists, survives reload and notifies once with the changed keys', () => {
  const s = memStorage();
  const p = P.create({ storage: s });
  const events = [];
  p.subscribe((d) => events.push(d));
  assert.deepStrictEqual(p.set({ helpLevel: 'off', motion: 'reduce' }), { changed: ['helpLevel', 'motion'], saved: true });
  assert.deepStrictEqual(p.set({ helpLevel: 'off' }), { changed: [], saved: true }, 'no-op does not notify');
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0].changed, ['helpLevel', 'motion']);
  assert.strictEqual(events[0].saved, true);
  assert.deepStrictEqual(stored(s), { version: 1, helpLevel: 'off', autoOfferTours: true, compactNav: false, motion: 'reduce' });
  const again = P.create({ storage: s }).get();
  assert.deepStrictEqual([again.helpLevel, again.motion], ['off', 'reduce']);
});

t('#54 reset restores defaults, removes the record and reports the changed keys', () => {
  const s = memStorage();
  const p = P.create({ storage: s });
  p.set({ compactNav: true, autoOfferTours: false });
  const events = [];
  p.subscribe((d) => events.push(d.changed));
  assert.deepStrictEqual(p.reset(), { changed: ['autoOfferTours', 'compactNav'], saved: true });
  assert.deepStrictEqual(p.get(), P.defaults());
  assert.strictEqual(s.data.has(P.KEY), false);
  assert.deepStrictEqual(events, [['autoOfferTours', 'compactNav']]);
});

t('#54 corrupt, invalid and unknown stored values fall back field by field', () => {
  assert.deepStrictEqual(P.create({ storage: memStorage({ [P.KEY]: '{not json' }) }).status().ignored, ['record']);
  assert.deepStrictEqual(P.create({ storage: memStorage({ [P.KEY]: '[1,2]' }) }).get(), P.defaults());
  const p = P.create({ storage: memStorage({ [P.KEY]: JSON.stringify({ version: 1, helpLevel: 'verbose', compactNav: 'yes', motion: 'reduce', stray: 1 }) }) });
  assert.deepStrictEqual(p.get(), { ...P.defaults(), motion: 'reduce' });
  assert.deepStrictEqual(p.status().ignored.sort(), ['compactNav', 'helpLevel', 'stray']);
  const old = P.create({ storage: memStorage({ [P.KEY]: JSON.stringify({ helpLevel: 'detailed' }) }) });
  assert.strictEqual(old.get().helpLevel, 'detailed', 'a record without a version is read as version 1');
});

t('#54 fields from a newer schema version are kept when this version writes', () => {
  const s = memStorage({ [P.KEY]: JSON.stringify({ version: 3, helpLevel: 'off', toursSeen: { suite: 2 } }) });
  const p = P.create({ storage: s });
  assert.strictEqual(p.get().helpLevel, 'off');
  p.set({ compactNav: true });
  assert.deepStrictEqual(stored(s), { toursSeen: { suite: 2 }, version: 3, helpLevel: 'off', autoOfferTours: true, compactNav: true, motion: 'system' });
});

t('#54 invalid set() is rejected without changing state or storage', () => {
  const s = memStorage();
  const p = P.create({ storage: s });
  assert.throws(() => p.set({ helpLevel: 'loud' }), TypeError);
  assert.throws(() => p.set({ compactNav: true, unknown: 1 }), TypeError);
  assert.deepStrictEqual(p.get(), P.defaults());
  assert.strictEqual(s.data.size, 0);
});

t('#54 denied storage: defaults load, changes apply for the page and report non-persistence', () => {
  const s = memStorage({ [P.KEY]: JSON.stringify({ version: 1, helpLevel: 'off' }) });
  s.fail.get = true;
  s.fail.set = true;
  const p = P.create({ storage: s });
  assert.deepStrictEqual(p.get(), P.defaults());
  assert.strictEqual(p.status().persistent, false);
  assert.strictEqual(p.status().error, 'read');
  const events = [];
  p.subscribe((d) => events.push(d));
  assert.deepStrictEqual(p.set({ motion: 'reduce' }), { changed: ['motion'], saved: false });
  assert.strictEqual(p.get().motion, 'reduce');
  assert.strictEqual(events[0].saved, false);
});

t('#54 quota failure on write keeps the page value; the next successful write recovers', () => {
  const s = memStorage();
  const p = P.create({ storage: s });
  s.fail.set = true;
  assert.deepStrictEqual(p.set({ helpLevel: 'detailed' }), { changed: ['helpLevel'], saved: false });
  assert.deepStrictEqual([p.get().helpLevel, p.status().error, p.status().persistent], ['detailed', 'write', false]);
  assert.strictEqual(s.data.has(P.KEY), false);
  s.fail.set = false;
  assert.strictEqual(p.set({ compactNav: true }).saved, true);
  assert.deepStrictEqual([p.status().error, stored(s).helpLevel], [null, 'detailed']);
  s.fail.remove = true;
  assert.strictEqual(p.reset().saved, false, 'a reset that cannot clear storage reports it');
  assert.deepStrictEqual(p.get(), P.defaults());
});

t('#54 reload picks up another tab, and a throwing listener does not block others', () => {
  const s = memStorage();
  const p = P.create({ storage: s });
  const seen = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const offBug = p.subscribe(() => { throw new Error('consumer bug'); });
    p.subscribe((d) => seen.push(d.changed));
    s.data.set(P.KEY, JSON.stringify({ version: 1, compactNav: true }));
    assert.deepStrictEqual(p.reload(), ['compactNav']);
    offBug();
  } finally { console.error = quiet; }
  assert.deepStrictEqual(seen, [['compactNav']]);
  const off = p.subscribe(() => seen.push('late'));
  off();
  p.set({ compactNav: false });
  assert.strictEqual(seen.includes('late'), false, 'unsubscribe stops events');
  assert.strictEqual(P.reducedMotion({ motion: 'system' }, true), true);
  assert.strictEqual(P.reducedMotion({ motion: 'system' }, false), false);
  assert.strictEqual(P.reducedMotion({ motion: 'reduce' }, false), true);
});

// js/ux-prefs-core.js
// Shared, local UX preferences (UX issue #54). create() has no DOM and runs in Node
// (tests/ux-prefs.test.js); js/app.js wires it to localStorage, the Settings dialog and the
// `p8:preferences` document event.
//
// - One schema-versioned record under KEY. Missing, corrupt or invalid fields fall back to the
//   defaults field by field; the defaults keep the Suite exactly as it was before #54.
// - Fields written by a newer schema version (unknown keys) are kept on write, so a downgrade
//   round trip does not erase them.
// - A storage that refuses reads or writes (privacy mode, quota) never throws: the preference
//   still applies for this page and status() reports that it is not persistent.
// - Only these display/help choices are stored: no identifiers, URLs, timestamps or telemetry.

'use strict';

const P8Prefs = (() => {
  const KEY = 'p8suite.uxPrefs';
  const VERSION = 1;

  // helpLevel: optional explanatory help only (hints, future tooltips). Accessible names, labels,
  //   warnings, errors and confirmations are shown at every level.
  // autoOfferTours: whether onboarding tours may offer themselves; replaying them stays available.
  // compactNav: hide the active workspace name box in the workspace bar.
  // motion: 'system' follows the OS reduced-motion setting; 'reduce' always reduces.
  const SCHEMA = Object.freeze({
    helpLevel: Object.freeze(['concise', 'off', 'detailed']),
    autoOfferTours: Object.freeze([true, false]),
    compactNav: Object.freeze([false, true]),
    motion: Object.freeze(['system', 'reduce']),
  });
  // stored version -> function(record) returning the record for version + 1
  const MIGRATIONS = {};

  const defaults = () => Object.fromEntries(Object.entries(SCHEMA).map(([k, values]) => [k, values[0]]));
  const valid = (key, value) => Object.prototype.hasOwnProperty.call(SCHEMA, key) && SCHEMA[key].includes(value);

  /** { prefs, extra, version, ignored[] } from any stored value */
  function normalize(raw) {
    const prefs = defaults();
    const extra = {};
    const ignored = [];
    if (raw == null) return { prefs, extra, version: VERSION, ignored };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { prefs, extra, version: VERSION, ignored: ['record'] };
    let rec = { ...raw };
    let version = Number.isInteger(rec.version) && rec.version > 0 ? rec.version : 1;
    while (version < VERSION && MIGRATIONS[version]) rec = MIGRATIONS[version++](rec);
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'version') continue;
      if (Object.prototype.hasOwnProperty.call(SCHEMA, k)) {
        if (valid(k, v)) prefs[k] = v;
        else ignored.push(k);
      } else if (version > VERSION) extra[k] = v; // written by a newer Suite: keep, do not interpret
      else ignored.push(k);
    }
    return { prefs, extra, version: Math.max(version, VERSION), ignored };
  }

  /** storage: { getItem, setItem, removeItem } (localStorage) or null for memory only */
  function create({ storage = null } = {}) {
    let prefs = defaults();
    let extra = {};
    let version = VERSION;
    let status = { persistent: !!storage, error: null, ignored: [] };
    const listeners = new Set();

    function notify(changed, saved) {
      if (!changed.length) return;
      const detail = { prefs: { ...prefs }, changed: changed.slice(), saved };
      for (const fn of [...listeners]) {
        try { fn(detail); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
      }
    }

    function read() {
      if (!storage) return null;
      let text;
      try { text = storage.getItem(KEY); } catch (e) {
        status = { persistent: false, error: 'read', message: String(e?.message || e), ignored: [] };
        return null;
      }
      if (text == null) return null;
      try { return JSON.parse(text); } catch { return 'corrupt'; }
    }

    function load() {
      const before = prefs;
      status = { persistent: !!storage, error: null, ignored: [] };
      const raw = read();
      const n = normalize(raw === 'corrupt' ? null : raw);
      prefs = n.prefs;
      extra = n.extra;
      version = n.version;
      status.ignored = raw === 'corrupt' ? ['record'] : n.ignored;
      return Object.keys(SCHEMA).filter((k) => before[k] !== prefs[k]);
    }

    function write() {
      if (!storage) return false;
      try {
        storage.setItem(KEY, JSON.stringify({ ...extra, version, ...prefs }));
        status = { ...status, persistent: true, error: null, message: undefined };
        return true;
      } catch (e) {
        status = { ...status, persistent: false, error: 'write', message: String(e?.message || e) };
        return false;
      }
    }

    load();

    return {
      get: () => ({ ...prefs }),
      status: () => ({ ...status, ignored: status.ignored.slice() }),
      /** patch: { key: value }. Throws TypeError for unknown keys / invalid values (a programming error). */
      set(patch) {
        for (const [k, v] of Object.entries(patch || {})) {
          if (!valid(k, v)) throw new TypeError(`Invalid preference ${k}=${JSON.stringify(v)}`);
        }
        const changed = Object.keys(patch || {}).filter((k) => prefs[k] !== patch[k]);
        if (!changed.length) return { changed, saved: status.persistent };
        prefs = { ...prefs, ...patch };
        const saved = write();
        notify(changed, saved);
        return { changed, saved };
      },
      /** back to defaults; removes the stored record (including fields from newer versions) */
      reset() {
        const before = prefs;
        prefs = defaults();
        extra = {};
        version = VERSION;
        let saved = !!storage;
        if (storage) {
          try { storage.removeItem(KEY); status = { persistent: true, error: null, ignored: [] }; } catch (e) {
            saved = false;
            status = { persistent: false, error: 'write', message: String(e?.message || e), ignored: [] };
          }
        }
        const changed = Object.keys(SCHEMA).filter((k) => before[k] !== prefs[k]);
        notify(changed, saved);
        return { changed, saved };
      },
      /** re-read storage (e.g. after another tab changed it); notifies changed keys */
      reload() {
        const changed = load();
        notify(changed, status.persistent);
        return changed;
      },
      subscribe(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  }

  /** true when animations should be reduced: the preference or the OS setting */
  const reducedMotion = (prefs, osReduced) => prefs.motion === 'reduce' || !!osReduced;

  return { create, normalize, defaults, reducedMotion, KEY, VERSION, SCHEMA };
})();

if (typeof module !== 'undefined') module.exports = P8Prefs;

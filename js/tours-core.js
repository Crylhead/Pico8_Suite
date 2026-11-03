// js/tours-core.js
// Quick-tour engine without DOM (UX issue #61); runs in Node (tests/tours.test.js). js/tours.js
// renders it, js/tours-data.js holds the built-in tours.
//
// Tour: { id, title, summary, major, rev?, ws?, sub?, scope?: 'suite'|'tool', steps: [Step] }
//   major: bump only for a meaningful new capability; a user who finished an older major is offered
//          an optional "What's new" (never a forced replay). rev: copy/layout edits, ignored here.
// Step:  { id, target?, before?, title, text?, helpId? }
//   optional / conditional: the target may legitimately be absent (hidden by default / built later by JS)
//   target: CSS selector of a stable id/class/attribute (never nth-child); omitted = centered note.
//   before: { ws?, click? } declarative, harmless navigation (workspace, tab) done before looking.
//   helpId: control id in the help registry; its text is used when `text` is absent.
// A step whose target is missing is skipped; a tour with no usable step does not start.
// Tours never write project data. Progress is one small record: no ids, timestamps or telemetry.

'use strict';

const P8TourCore = (() => {
  const KEY = 'p8suite.tours';
  const VERSION = 1;
  const WELCOME = ['pending', 'started', 'skipped', 'never'];
  const STATUS = ['done', 'skipped'];

  function validate(tour) {
    const errors = [];
    if (!tour || typeof tour.id !== 'string' || !tour.id) return ['tour needs an id'];
    if (!tour.title) errors.push(`${tour.id}: title`);
    if (tour.ws != null && (typeof tour.ws !== 'string' || !tour.ws)) errors.push(`${tour.id}: ws must be a nonempty string`);
    if (tour.sub != null && (!tour.ws || typeof tour.sub !== 'string' || !tour.sub)) errors.push(`${tour.id}: sub needs a workspace and a nonempty string`);
    if (tour.scope != null && !['suite', 'tool'].includes(tour.scope)) errors.push(`${tour.id}: scope must be suite or tool`);
    if (!Number.isInteger(tour.major) || tour.major < 1) errors.push(`${tour.id}: major must be a positive integer`);
    if (!Array.isArray(tour.steps) || !tour.steps.length) errors.push(`${tour.id}: steps`);
    const seen = new Set();
    for (const s of tour.steps || []) {
      if (!s || !s.id) { errors.push(`${tour.id}: step without id`); continue; }
      if (seen.has(s.id)) errors.push(`${tour.id}: duplicate step ${s.id}`);
      seen.add(s.id);
      if (!s.title) errors.push(`${tour.id}/${s.id}: title`);
      if (!s.text && !s.helpId) errors.push(`${tour.id}/${s.id}: text or helpId`);
      if (s.target && /nth-child|nth-of-type/.test(s.target)) errors.push(`${tour.id}/${s.id}: brittle selector`);
    }
    return errors;
  }

  function normalize(raw) {
    const rec = { version: VERSION, welcome: 'pending', tours: {} };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return rec;
    if (WELCOME.includes(raw.welcome)) rec.welcome = raw.welcome;
    if (raw.tours && typeof raw.tours === 'object') {
      for (const [id, v] of Object.entries(raw.tours)) {
        if (v && STATUS.includes(v.status) && Number.isInteger(v.major) && v.major > 0) rec.tours[id] = { status: v.status, major: v.major };
      }
    }
    return rec;
  }

  /** storage: localStorage-like or null. Failing storage never throws; progress then lasts for the page. */
  function create({ storage = null } = {}) {
    const tours = new Map();
    let rec = normalize(null);
    let persistent = !!storage;

    try { if (storage) { const t = storage.getItem(KEY); if (t != null) rec = normalize(JSON.parse(t)); } } catch { persistent = false; }
    const save = () => {
      if (!storage) return false;
      try { storage.setItem(KEY, JSON.stringify(rec)); persistent = true; return true; } catch { persistent = false; return false; }
    };

    function register(tour) {
      const errors = validate(tour);
      if (errors.length) return { ok: false, errors };
      tours.set(tour.id, tour);
      return { ok: true, errors: [] };
    }

    function progress(id) { return rec.tours[id] || null; }

    function setStatus(id, status) {
      const t = tours.get(id);
      if (!t) return false;
      rec.tours[id] = { status, major: t.major };
      save();
      return true;
    }

    /**
     * Should the first-run welcome appear? Only once, only if auto-offers are on, never in the
     * middle of editing (caller passes busy) and not after "Never auto-offer".
     */
    function shouldOfferWelcome({ autoOffer = true, busy = false } = {}) {
      return autoOffer && !busy && rec.welcome === 'pending';
    }

    /** meaningful new capability since the user finished or skipped this tour */
    function whatsNew(id) {
      const t = tours.get(id);
      const p = rec.tours[id];
      return !!(t && p && p.major < t.major);
    }

    /**
     * Step runner. prepare(step) -> Promise<{ el?: Element-like } | null>: applies `before`, looks for the
     * target and returns null if the step cannot be shown (it is then skipped). Steps are resolved lazily,
     * so a tool that is not open yet is not required to exist when the tour starts.
     */
    function run(id, prepare) {
      const tour = tours.get(id);
      if (!tour) throw new Error(`Unknown tour ${id}`);
      const state = { tourId: id, index: -1, step: null, ctx: null, status: 'idle', skipped: [], shown: 0 };

      let movement = 0;
      async function move(dir) {
        const ticket = ++movement;
        if (state.status === 'done' || state.status === 'aborted') return state;
        let i = state.index;
        for (;;) {
          i += dir;
          if (i < 0) { return state; }
          if (i >= tour.steps.length) { state.status = 'done'; state.step = null; state.ctx = null; return state; }
          const step = tour.steps[i];
          let ctx = null;
          try { ctx = await prepare(step); } catch { ctx = null; }
          if (ticket !== movement || state.status === 'aborted') return state;
          if (ctx) {
            state.index = i; state.step = step; state.ctx = ctx; state.status = 'running'; state.shown++;
            return state;
          }
          if (!state.skipped.includes(step.id)) state.skipped.push(step.id);
        }
      }

      return {
        state,
        start: () => move(1),
        next: () => move(1),
        back: () => move(-1),
        /** position among steps that exist right now is unknown ahead of time; report index/total of the plan */
        position: () => ({ index: state.index, total: tour.steps.length }),
        abort() { ++movement; if (state.status !== 'done') state.status = 'aborted'; state.step = null; state.ctx = null; return state; },
        /** record the outcome: finishing marks done, closing early marks skipped; both keep the app usable */
        finish() {
          if (!state.shown) return; // nothing was shown (every target missing): do not record a tour nobody saw
          if (state.status === 'done') setStatus(id, 'done');
          else setStatus(id, 'skipped');
        },
      };
    }

    return {
      register, validate,
      list: () => [...tours.values()],
      get: (id) => tours.get(id) || null,
      progress, whatsNew,
      shouldOfferWelcome,
      setWelcome(v) { if (!WELCOME.includes(v)) throw new TypeError(`Invalid welcome ${v}`); rec.welcome = v; save(); },
      welcome: () => rec.welcome,
      run,
      persistent: () => persistent,
      reset() { rec = normalize(null); try { storage?.removeItem(KEY); } catch { /* ignore */ } },
    };
  }

  /** Exact subtool matches only: an unrelated workspace overview is not that subtool's tour. */
  function forContext(tours, { ws, sub = null } = {}) {
    return ws ? tours.find((t) => t.ws === ws && (t.sub || null) === (sub || null)) || null : null;
  }

  function search(tours, query = '') {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return tours.filter((t) => {
      const text = [t.title, t.summary, t.ws, t.sub, t.scope].filter(Boolean).join(' ').toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  return { create, validate, normalize, forContext, search, KEY, VERSION };
})();

if (typeof module !== 'undefined') module.exports = P8TourCore;

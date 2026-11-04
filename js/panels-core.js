// js/panels-core.js
// Side-panel width model (UX issue #64). No DOM; runs in Node (tests/panels.test.js). js/panels.js
// renders the splitters and applies the widths as the CSS variable --side-w.
//
// - Widths are clamped so neither the side panel nor the central canvas can become unusable:
//   min <= width <= min(max, container - reserve - minCenter).
// - One small record under KEY: { v: 1, panels: { id: { w: number, c: boolean } } }. A corrupt or
//   out-of-range value falls back to the default for that panel only; unknown panels are kept.
// - Storage that throws never breaks the layout; the width then lasts for the page only.

'use strict';

const P8Panels = (() => {
  const KEY = 'p8suite.layout';
  const VERSION = 1;
  const MIN_CENTER = 320; // center grid track; the canvas has its own borders/padding

  /** Grid content width from a border-box DOMRect and computed CSS insets (no DOM dependency). */
  function contentWidth(width, style = {}) {
    const inset = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
      .reduce((sum, key) => sum + (parseFloat(style[key]) || 0), 0);
    return Math.max(0, (Number(width) || 0) - inset);
  }

  /** allowed [lo, hi] for a panel in a container of the given width */
  function bounds(cfg, containerW) {
    const hi = Math.max(cfg.min, Math.min(cfg.max, containerW - (cfg.reserve || 0) - MIN_CENTER));
    return [cfg.min, hi];
  }

  const clamp = (cfg, containerW, w) => {
    const [lo, hi] = bounds(cfg, containerW);
    const n = Number(w);
    if (!Number.isFinite(n)) return Math.min(Math.max(cfg.def, lo), hi);
    return Math.min(Math.max(Math.round(n), lo), hi);
  };

  /** keyboard / pointer step: key -> new width or null (not a resize key) */
  function keyWidth(cfg, containerW, current, key, shift) {
    const [lo, hi] = bounds(cfg, containerW);
    const step = shift ? 64 : 16;
    // the separator sits left of the panel: ArrowLeft makes the panel wider, ArrowRight narrower
    if (key === 'ArrowLeft') return clamp(cfg, containerW, current + step);
    if (key === 'ArrowRight') return clamp(cfg, containerW, current - step);
    if (key === 'Home') return lo;
    if (key === 'End') return hi;
    if (key === '0') return clamp(cfg, containerW, cfg.def);
    return null;
  }

  function parse(text) {
    let rec = null;
    try { rec = JSON.parse(text); } catch { return { v: VERSION, panels: {} }; }
    if (!rec || typeof rec !== 'object' || Array.isArray(rec) || !rec.panels || typeof rec.panels !== 'object') return { v: VERSION, panels: {} };
    const panels = {};
    for (const [id, p] of Object.entries(rec.panels)) {
      if (p && typeof p === 'object') panels[id] = { w: Number.isFinite(p.w) ? p.w : null, c: p.c === true };
    }
    return { v: VERSION, panels };
  }

  /** storage: localStorage-like or null */
  function createStore(storage) {
    let rec = { v: VERSION, panels: {} };
    let persistent = !!storage;
    try { const t = storage && storage.getItem(KEY); if (t != null) rec = parse(t); } catch { persistent = false; }
    const save = () => { try { if (storage) { storage.setItem(KEY, JSON.stringify(rec)); persistent = true; } } catch { persistent = false; } };
    return {
      get: (id) => ({ w: null, c: false, ...(rec.panels[id] || {}) }),
      set(id, patch) { rec.panels[id] = { ...{ w: null, c: false }, ...(rec.panels[id] || {}), ...patch }; save(); },
      reset(id) { if (id) delete rec.panels[id]; else rec.panels = {}; save(); },
      persistent: () => persistent,
    };
  }

  return { KEY, VERSION, MIN_CENTER, contentWidth, bounds, clamp, keyWidth, parse, createStore };
})();

if (typeof module !== 'undefined') module.exports = P8Panels;

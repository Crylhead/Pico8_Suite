// js/ux-tooltips.js
// Optional explanatory tooltips (UX issue #60). The text comes only from the help registry
// (js/help-core.js, stable control ids); elements opt in with data-help-id="studio.tiled".
//
// - Off: no popovers. Concise: the registry text. Detailed: that text plus the registry `detail`
//   (example / note) and a pointer to F1. Labels, warnings, errors and disabled reasons live
//   elsewhere and are never touched.
// - Shown on mouse hover and on keyboard focus (and on focus after a touch tap, which has no
//   hover). Escape or leaving the control hides the tip; the tip never takes focus or pointer
//   events, so it cannot trap focus or block editing.
// - A native `title` on an opted-in control that already has visible text or an aria-label is
//   moved to data-title-orig: the registry tip replaces it so one control never shows two
//   tooltips and Off applies consistently. Controls without such a name keep their title.
// - Unknown ids fail quietly. Preference changes apply without a reload.
//
// resolveTip() is pure and runs in Node (tests/tooltips.test.js).

'use strict';

const P8Tips = (() => {
  const DEFAULTS = { hoverDelay: 600, focusDelay: 250 };

  /** { text, topic } for a level, or null when nothing should be shown */
  function resolveTip(help, id, level) {
    if (!id || level === 'off' || !help) return null;
    let hit = null;
    try { hit = help.control(id); } catch { return null; }
    if (!hit || !hit.control) return null;
    const c = hit.control;
    const label = c.label || c.name || '';
    const base = c.text || '';
    if (!base) return null;
    if (level !== 'detailed') return { label, text: base, topic: hit.topic.id };
    const more = [c.detail, `Press F1 for “${hit.topic.title}” help.`].filter(Boolean).join(' ');
    return { label, text: `${base} ${more}`, topic: hit.topic.id };
  }

  /** where to put a tip of size (w, h) next to rect r in viewport (vw, vh): never over the target */
  function place(r, w, h, vw, vh, gap = 8) {
    const below = r.bottom + gap + h <= vh;
    const above = r.top - gap - h >= 0;
    let top;
    if (below) top = r.bottom + gap; else if (above) top = r.top - gap - h; else top = Math.max(0, vh - h);
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(4, Math.min(left, vw - w - 4));
    return { top, left, side: below ? 'below' : above ? 'above' : 'edge' };
  }

  function init({ prefs, help, delays = {} }) {
    if (typeof document === 'undefined') return null;
    const cfg = { ...DEFAULTS, ...delays };
    const tip = document.createElement('div');
    tip.id = 'p8-tip';
    tip.className = 'ux-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.append(tip);

    let current = null; // { el, prev } element showing the tip
    let timer = 0;
    let lastPointer = 'mouse';

    const level = () => prefs.get().helpLevel;
    const target = (node) => (node && node.closest ? node.closest('[data-help-id]') : null);

    function hide() {
      clearTimeout(timer);
      timer = 0;
      if (current) {
        const { el, prev } = current;
        if (prev == null) el.removeAttribute('aria-describedby'); else el.setAttribute('aria-describedby', prev);
        current = null;
      }
      tip.hidden = true;
    }

    function show(el) {
      const t = resolveTip(help, el.dataset.helpId, level());
      if (!t) return;
      hide();
      tip.textContent = '';
      if (t.label) { const b = document.createElement('strong'); b.textContent = `${t.label}. `; tip.append(b); }
      tip.append(document.createTextNode(t.text));
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const p = place(r, w, h, document.documentElement.clientWidth, document.documentElement.clientHeight);
      tip.style.top = `${p.top}px`;
      tip.style.left = `${p.left}px`;
      current = { el, prev: el.getAttribute('aria-describedby') };
      el.setAttribute('aria-describedby', current.prev ? `${current.prev} ${tip.id}` : tip.id);
    }

    function schedule(el, delay) {
      clearTimeout(timer);
      if (level() === 'off') return;
      timer = setTimeout(() => { if (el.isConnected) show(el); }, delay);
    }

    const quiet = (fn) => (e) => { try { fn(e); } catch (err) { window.P8App?.diagnostics?.report('tooltips', 'E_TIP', err); } };

    document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; hide(); }, true);
    document.addEventListener('pointerover', quiet((e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      const el = target(e.target);
      if (!el || (current && current.el === el)) return;
      if (e.buttons) return; // dragging / painting: stay out of the way
      schedule(el, cfg.hoverDelay);
    }));
    document.addEventListener('pointerout', quiet((e) => {
      const el = target(e.target);
      if (!el || el.contains(e.relatedTarget)) return;
      if (current && current.el === el && document.activeElement === el) return; // keep the focus tip
      hide();
    }));
    document.addEventListener('focusin', quiet((e) => {
      const el = target(e.target);
      if (!el) { hide(); return; }
      let keyboard = false;
      try { keyboard = el.matches(':focus-visible'); } catch { keyboard = true; }
      if (keyboard || lastPointer === 'touch') schedule(el, cfg.focusDelay);
    }));
    document.addEventListener('focusout', quiet((e) => { if (target(e.target)) hide(); }));
    // Escape hides a visible tip first and is then consumed, so it never also closes a dialog or
    // changes the active tool; with no tip showing it passes through untouched.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && current) { e.stopPropagation(); e.preventDefault(); hide(); }
    }, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);

    // one tooltip per control: the registry tip replaces a duplicate native title
    function claimTitles(root = document) {
      for (const el of root.querySelectorAll('[data-help-id][title]')) {
        const named = el.hasAttribute('aria-label') || (el.textContent || '').trim();
        if (!named) continue;
        el.dataset.titleOrig = el.getAttribute('title');
        el.removeAttribute('title');
      }
    }
    claimTitles();

    prefs.subscribe(() => hide());
    return { hide, claimTitles, show, configure: (d) => Object.assign(cfg, d) };
  }

  return { init, resolveTip, place, DEFAULTS };
})();

if (typeof module !== 'undefined') module.exports = P8Tips;

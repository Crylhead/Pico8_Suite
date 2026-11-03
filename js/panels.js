// js/panels.js
// Resizable, collapsible side panels (UX issue #64) for Pixel Studio, Map Editor and Terrain Lab.
// Model and persistence: js/panels-core.js. The width is the CSS variable --side-w on the layout
// element (the grid column reads it, with its old fixed width as the fallback), so without this
// script every layout is exactly as before.
//
// Controls per panel, placed at the panel's left edge (hidden when the layout stacks on narrow screens,
// where every control stays reachable by scrolling):
//  - a separator (role="separator", focusable, aria-valuenow/min/max):
//      drag, or ArrowLeft/ArrowRight (Shift = larger steps), Home / End = narrowest / widest,
//      Enter = hide / show the panel, 0 = default width; double-click = default width
//  - a toggle button "Hide/Show side panel" (aria-expanded). A hidden panel is not lost: the toggle stays.
// Touch and pen drawing on the canvas are unaffected (the splitter sits in the gap beside the panel).

'use strict';

(() => {
  const App = window.P8App;
  const P = P8Panels;
  const { el } = App;

  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const store = P.createStore(storage);

  // layout: element holding the grid; side: the panel; reserve: fixed columns + gaps besides side and canvas
  const PANELS = [
    { id: 'studio', ws: 'studio', layout: () => document.querySelector('.layout-studio'), side: (l) => l.querySelector(':scope > .ps-side'), min: 200, max: 560, def: 272, reserve: 52 + 30, name: 'Pixel Studio' },
    { id: 'map', ws: 'map', layout: () => document.querySelector('.layout-map'), side: (l) => l.querySelector(':scope > .ps-side'), min: 220, max: 560, def: 290, reserve: 52 + 30, name: 'Map Editor' },
    { id: 'terrain', ws: 'extras', layout: () => document.querySelector('.tl-split'), side: (l) => l.querySelector(':scope > .ex-controls'), min: 260, max: 640, def: 380, reserve: 10, name: 'Terrain Lab' },
  ];

  const widthOf = (p, layout) => layout.getBoundingClientRect().width;

  function attach(p) {
    const layout = p.layout();
    if (!layout || layout.dataset.panelsReady) return;
    const side = p.side(layout);
    if (!side) return;
    layout.dataset.panelsReady = '1';
    layout.classList.add('has-splitter');
    if (!side.id) side.id = `${p.id}-side-panel`;

    const sep = el('div', {
      className: 'panel-splitter', tabIndex: 0,
      attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': `Resize ${p.name} side panel`, 'aria-controls': side.id, 'aria-keyshortcuts': 'ArrowLeft ArrowRight Home End Enter' },
      title: 'Drag to resize · arrow keys · Enter hides · double-click resets',
    });
    const toggle = el('button', { type: 'button', className: 'panel-toggle btn btn-sm btn-ghost', attrs: { 'aria-controls': side.id } });
    layout.append(sep, toggle);

    let w = null; // current width (null = default)
    let collapsed = false;

    const cw = () => widthOf(p, layout);
    // the width in effect: the user's choice, else what the CSS default gives right now (it differs per breakpoint)
    const current = () => P.clamp(p, cw(), w == null ? (Math.round(side.getBoundingClientRect().width) || p.def) : w);

    function place() {
      // sit in the gap left of the panel; recompute from the real geometry (panel padding, scrollbars)
      const l = layout.getBoundingClientRect();
      const s = side.getBoundingClientRect();
      const x = collapsed ? l.width - 14 : s.left - l.left - 14;
      sep.style.left = `${Math.max(0, x)}px`;
      sep.style.top = '0';
      sep.style.height = `${l.height}px`;
      toggle.style.left = `${Math.max(0, x - 6)}px`;
    }

    function apply({ persist = true } = {}) {
      // Only a width the user chose is written. Without one the CSS fallback of --side-w applies, so a layout
      // keeps its own responsive default (Pixel Studio: 272 px, 232 px between 861 and 1100 px) and a stored
      // choice is the only thing that changes the layout.
      if (collapsed) layout.style.setProperty('--side-w', '0px');
      else if (w == null) layout.style.removeProperty('--side-w');
      else layout.style.setProperty('--side-w', `${P.clamp(p, cw(), w)}px`);
      // measured after the variable changed: after a reset the default width is in effect, and that is what
      // aria-valuenow/valuetext must announce (measuring first reported the old width)
      const cur = current();
      layout.toggleAttribute('data-side-collapsed', collapsed);
      const [lo, hi] = P.bounds(p, cw());
      sep.setAttribute('aria-valuemin', String(lo));
      sep.setAttribute('aria-valuemax', String(hi));
      sep.setAttribute('aria-valuenow', String(collapsed ? 0 : cur));
      sep.setAttribute('aria-valuetext', collapsed ? 'Side panel hidden' : `${cur} pixels wide`);
      toggle.textContent = collapsed ? '◂' : '▸';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? `Show ${p.name} side panel` : `Hide ${p.name} side panel`;
      toggle.setAttribute('aria-label', label);
      toggle.title = label;
      // hidden controls leave the tab order and the accessibility tree; where the layout stacks (splitter
      // display:none) a stored collapse is ignored so every control stays reachable by scrolling
      const stacked = getComputedStyle(sep).display === 'none';
      side.toggleAttribute('inert', collapsed && !stacked);
      if (stacked && collapsed) layout.style.removeProperty('--side-w');
      requestAnimationFrame(place);
      if (persist) store.set(p.id, { w, c: collapsed });
    }

    const set = (nw) => { w = nw; collapsed = false; apply(); };
    const reset = () => { w = null; collapsed = false; store.reset(p.id); apply({ persist: false }); };

    // restore (corrupt / out-of-range values are clamped or replaced by the default)
    const saved = store.get(p.id);
    w = Number.isFinite(saved.w) ? saved.w : null;
    collapsed = saved.c === true;
    apply({ persist: false });

    sep.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); collapsed = !collapsed; apply(); return; }
      if (collapsed && ['ArrowLeft', 'ArrowRight', 'Home', 'End', '0'].includes(e.key)) collapsed = false;
      const nw = P.keyWidth(p, cw(), current(), e.key, e.shiftKey);
      if (nw == null) return;
      e.preventDefault();
      if (e.key === '0') reset(); else set(nw);
    });
    toggle.addEventListener('click', () => { collapsed = !collapsed; apply(); });
    sep.addEventListener('dblclick', reset);

    sep.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      sep.setPointerCapture(e.pointerId);
      sep.classList.add('dragging');
      const sideRight = side.getBoundingClientRect().right;
      const move = (ev) => set(P.clamp(p, cw(), sideRight - ev.clientX - 5));
      const up = () => {
        sep.classList.remove('dragging');
        sep.removeEventListener('pointermove', move);
        sep.removeEventListener('pointerup', up);
        sep.removeEventListener('pointercancel', up);
      };
      sep.addEventListener('pointermove', move);
      sep.addEventListener('pointerup', up);
      sep.addEventListener('pointercancel', up);
    });

    new ResizeObserver(() => { if (layout.getClientRects().length) apply({ persist: false }); }).observe(layout);
    p.apply = apply;
    p.reset = reset;
  }

  function attachAll() {
    for (const p of PANELS) {
      try { attach(p); } catch (err) { App.diagnostics?.report('panels', 'E_PANEL_ATTACH', err, p.id); }
    }
  }

  attachAll();
  // Terrain Lab builds its split lazily inside Extra Tools
  document.addEventListener('p8:workspace', () => { attachAll(); for (const p of PANELS) p.apply?.({ persist: false }); });
  const body = document.getElementById('exBody');
  if (body) new MutationObserver(attachAll).observe(body, { childList: true, subtree: true });

  window.P8PanelLayout = {
    /** restore every panel to its default width and show it (also used by Settings) */
    resetAll() { store.reset(); for (const p of PANELS) p.reset?.(); },
    persistent: () => store.persistent(),
  };
})();

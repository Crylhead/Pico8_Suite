// js/ux-tooltips.js
// Optional explanatory tooltips (UX issue #60). The text comes only from the help registry
// (js/help-core.js, stable control ids); elements opt in with data-help-id="studio.tiled".
//
// - Off: no popovers. Concise: the registry text. Detailed: that text plus the registry `detail`
//   (example / note) and a pointer to F1. Labels, warnings, errors and disabled reasons live
//   elsewhere and are never touched.
// - Shown on mouse hover and on keyboard focus (and on focus after a touch tap, which has no
//   hover). Escape or leaving both control and tip hides it, unless the control retains focus.
//   Pointer coordinates make the tip hoverable without intercepting canvas clicks or drags.
// - A native `title` on an opted-in control that already has visible text or an aria-label is
//   moved to data-title-orig: the registry tip replaces it so one control never shows two
//   tooltips and Off applies consistently. Controls without such a name keep their title.
// - Disabled controls retaining a native title, and titled children inside help groups, use that
//   native fallback without an additional registry tooltip.
// - Legacy native titles authored in index.html (#107): with Off, a title's optional explanation is
//   dropped while names and shortcut keys stay (offTitle). "Draw (B) · paints the selected tile"
//   becomes "Draw (B)"; "Save into the file (Ctrl+S)" on a button already named Save becomes
//   "Ctrl+S"; a long description on a named control is removed; a control with no other accessible
//   name keeps its title's name part. Titles set by JavaScript (status, values, save state, error
//   details) are never touched, nor is a static title a module has since replaced. Mark an authored
//   title that must always stay with data-title-keep. Concise/Detailed restore the original.
// - Unknown ids fail quietly. Preference changes apply without a reload.
//
// resolveTip() is pure and runs in Node (tests/tooltips.test.js).

'use strict';

const P8Tips = (() => {
  const DEFAULTS = { hoverDelay: 600, focusDelay: 250 };
  // Scripts load at the end of <body>, so this runs once the authored markup exists and before any
  // tool module has set a title of its own: exactly the titles written in index.html.
  const AUTHORED = typeof document !== 'undefined' && typeof document.body?.querySelectorAll === 'function'
    ? new Map([...document.body.querySelectorAll('[title]')].map((el) => [el, el.getAttribute('title')]))
    : new Map();

  // A trailing "(Ctrl+S)", "(F3 / Enter)", "(B)" or "(M twice)" is a shortcut, not an explanation.
  const KEY = String.raw`(?:[^()]*\b(?:Ctrl|Alt|Shift|Cmd|Enter|Esc|Tab|Space|Del|F\d{1,2})\b[^()]*)|[A-Z0-9](?: twice)?`;
  const SHORTCUT = new RegExp(String.raw`\s*\((${KEY})\)\s*$`);
  // "Pixel perfect (P): no L-shaped corners" / "Read the folder again (F5). A folder…": the
  // explanation follows a key in mid-sentence.
  const KEY_THEN_TEXT = new RegExp(String.raw`\((?:${KEY})\)(?=[:.]\s)`);

  /**
   * The native title to keep while help detail is Off (#107): the same string when nothing is
   * optional, a shortened one, or null to remove it. `named`: the control has another accessible
   * name (visible text, aria-label/-labelledby or a label), so the title is not its only name.
   */
  function offTitle(title, named) {
    let head = String(title).split(' · ')[0].trim();
    const cut = KEY_THEN_TEXT.exec(head);
    if (cut) head = head.slice(0, cut.index + cut[0].length);
    if (!named) return head; // the title is the name: keep it, drop only the "· explanation" part
    const m = SHORTCUT.exec(head);
    const core = m ? head.slice(0, m.index) : head;
    if (core.split(/\s+/).filter(Boolean).length <= 3) return head; // a name or name + key
    return m ? m[1] : null;
  }

  function hasName(el) {
    if (el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby')) return true;
    if ((el.textContent || '').trim()) return true;
    return [...(el.labels || [])].some((l) => (l.textContent || '').trim());
  }

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

  /**
   * Where to put a tip of size (w, h) next to rect r in viewport (vw, vh): never over the target.
   * Below, else above, else beside it; when it fits nowhere whole, the larger free side with a
   * maxHeight that stops short of the target. null when not even two lines fit (F1 still has the text).
   */
  function place(r, w, h, vw, vh, gap = 8) {
    const right = r.right ?? r.left + r.width;
    const centered = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, vw - w - 4));
    if (r.bottom + gap + h <= vh) return { top: r.bottom + gap, left: centered, side: 'below' };
    if (r.top - gap - h >= 0) return { top: r.top - gap - h, left: centered, side: 'above' };
    const beside = Math.max(4, Math.min(r.top + (r.bottom - r.top) / 2 - h / 2, vh - h - 4));
    if (right + gap + w <= vw - 4) return { top: beside, left: right + gap, side: 'right' };
    if (r.left - gap - w >= 4) return { top: beside, left: r.left - gap - w, side: 'left' };
    const roomBelow = vh - r.bottom - gap - 4;
    const roomAbove = r.top - gap - 4;
    const MIN = 36; // about two lines
    if (Math.max(roomBelow, roomAbove) < MIN) return null;
    return roomBelow >= roomAbove
      ? { top: r.bottom + gap, left: centered, side: 'below', maxHeight: roomBelow }
      : { top: r.top - gap - roomAbove, left: centered, side: 'above', maxHeight: roomAbove };
  }

  /** Includes the gap to the adjacent tip, so slow pointer travel has no dismissal deadline. */
  function inHoverArea(r, t, side, x, y) {
    const inside = (b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    if (inside(r) || inside(t)) return true;
    const vertical = side === 'above' || side === 'below';
    const gap = vertical
      ? { left: Math.min(r.left, t.left), right: Math.max(r.right, t.right), top: side === 'below' ? r.bottom : t.bottom, bottom: side === 'below' ? t.top : r.top }
      : { top: Math.min(r.top, t.top), bottom: Math.max(r.bottom, t.bottom), left: side === 'right' ? r.right : t.right, right: side === 'right' ? t.left : r.left };
    return inside(gap);
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

    let current = null; // { el, prev, side } element showing the tip
    let timer = 0;
    let pending = null;
    let pointer = null;
    let lastPointer = 'mouse';

    const level = () => prefs.get().helpLevel;
    const target = (node) => (node && node.closest ? node.closest('[data-help-id]') : null);
    const hasNativeTitle = (el) => !!el.getAttribute('title')?.trim();
    const nativeChild = (node) => {
      const owner = target(node), native = node?.closest?.('[title]');
      return owner && native && hasNativeTitle(native) && native !== owner && owner.contains(native);
    };
    // A control hidden after its tip appeared (e.g. a keyboard workspace switch) reports a 0×0 box at
    // the page origin, which would make most of the screen count as "still hovering": treat it as gone.
    const onScreen = (el) => el.isConnected && (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0);
    const focused = () => current && onScreen(current.el) && current.el.contains(document.activeElement);
    const hovered = () => current && pointer && onScreen(current.el) && inHoverArea(current.el.getBoundingClientRect(), tip.getBoundingClientRect(), current.side, pointer.x, pointer.y);
    const rememberPointer = (e) => { pointer = { x: e.clientX, y: e.clientY }; };

    function cancelPending() {
      clearTimeout(timer);
      timer = 0;
      pending = null;
    }

    function hide() {
      cancelPending();
      document.removeEventListener('pointermove', followPointer, true);
      if (current) {
        const { el, prev } = current;
        if (prev == null) el.removeAttribute('aria-describedby'); else el.setAttribute('aria-describedby', prev);
        current = null;
      }
      tip.hidden = true;
    }

    function show(el) {
      // Disabled controls retain their native explanation; do not layer a custom tip over it.
      // Recheck here too: availability can change during the hover/focus delay.
      if (el.disabled && hasNativeTitle(el)) return;
      const t = resolveTip(help, el.dataset.helpId, level());
      if (!t) return;
      hide();
      tip.textContent = '';
      if (t.label) { const b = document.createElement('strong'); b.textContent = `${t.label}. `; tip.append(b); }
      tip.append(document.createTextNode(t.text));
      tip.style.maxHeight = '';
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      const p = place(r, w, h, document.documentElement.clientWidth, document.documentElement.clientHeight);
      if (!p) { tip.hidden = true; return; } // no room that leaves the control visible
      tip.style.top = `${p.top}px`;
      tip.style.left = `${p.left}px`;
      tip.style.maxHeight = p.maxHeight ? `${p.maxHeight}px` : '';
      current = { el, prev: el.getAttribute('aria-describedby'), side: p.side };
      el.setAttribute('aria-describedby', current.prev ? `${current.prev} ${tip.id}` : tip.id);
      document.addEventListener('pointermove', followPointer, true);
    }

    function schedule(el, delay) {
      cancelPending();
      if (level() === 'off' || (el.disabled && hasNativeTitle(el))) return;
      pending = el;
      timer = setTimeout(() => { cancelPending(); if (el.isConnected) show(el); }, delay);
    }

    const quiet = (fn) => (e) => { try { fn(e); } catch (err) { window.P8App?.diagnostics?.report('tooltips', 'E_TIP', err); } };
    const followPointer = quiet((e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      rememberPointer(e);
      if (current && (!onScreen(current.el) || e.buttons || (!focused() && !hovered()))) hide();
    });

    document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; hide(); }, true);
    document.addEventListener('pointerover', quiet((e) => {
      if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      rememberPointer(e);
      // A titled child owns its native name/status; inherited group help must not cover it.
      if (nativeChild(e.target)) { hide(); return; }
      // The visual tip is pointer-transparent: controls beneath it must not replace its text.
      if (current && (focused() || hovered())) return;
      const el = target(e.target);
      if (!el || (current && current.el === el)) return;
      if (e.buttons) return; // dragging / painting: stay out of the way
      if (current) hide();
      schedule(el, cfg.hoverDelay);
    }));
    document.addEventListener('pointerout', quiet((e) => {
      rememberPointer(e);
      if (!e.relatedTarget && current && !focused()) { hide(); return; }
      const el = target(e.target);
      if (!el || el.contains(e.relatedTarget)) return;
      if (pending === el && !el.contains(document.activeElement)) cancelPending();
      if (current && current.el === el && !focused() && (!e.relatedTarget || !hovered())) hide();
    }));
    document.addEventListener('focusin', quiet((e) => {
      if (nativeChild(e.target)) { hide(); return; }
      const el = target(e.target);
      if (!el) { if (!hovered()) hide(); return; }
      if (current && current.el === el) { cancelPending(); return; }
      if (current) hide();
      let keyboard = false;
      try { keyboard = e.target.matches(':focus-visible'); } catch { keyboard = true; }
      if (keyboard || lastPointer === 'touch') schedule(el, cfg.focusDelay);
    }));
    document.addEventListener('focusout', quiet((e) => {
      const el = target(e.target);
      if (!el || el.contains(e.relatedTarget)) return;
      if (pending === el) cancelPending();
      if (current && current.el === el && !hovered()) hide();
    }));
    // Escape hides a visible tip first and is then consumed, so it never also closes a dialog or
    // changes the active tool; with no tip showing it passes through untouched.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && current) { e.stopPropagation(); e.preventDefault(); hide(); }
    }, true);
    window.addEventListener('scroll', hide, true);
    document.addEventListener('p8:workspace', () => hide()); // the control's workspace was just hidden
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);

    // one tooltip per control: the registry tip replaces a duplicate native title. A disabled
    // control keeps it (browsers may show no custom tip on it) until it is enabled and targeted.
    function claim(el) {
      if (typeof el?.hasAttribute !== 'function' || !el.hasAttribute('title') || el.disabled) return;
      const named = el.hasAttribute('aria-label') || (el.textContent || '').trim();
      if (!named) return;
      el.dataset.titleOrig = el.getAttribute('title');
      el.removeAttribute('title');
    }
    function claimTitles(root = document) {
      for (const el of root.querySelectorAll('[data-help-id][title]')) claim(el);
    }
    claimTitles();
    // Controls generated later are claimed when they first become a tip target.
    document.addEventListener('pointerover', (e) => claim(target(e.target)), true);
    document.addEventListener('focusin', (e) => claim(target(e.target)), true);

    // #107: Off also governs the explanations in authored native titles (see offTitle).
    const shortened = new Map(); // element -> the value set while Off (null = removed)
    function applyTitleLevel(authored = AUTHORED) {
      const off = level() === 'off';
      for (const [el, full] of authored) {
        if (el.dataset.titleOrig != null || el.hasAttribute('data-title-keep')) continue; // claimed by a registry tip
        if (off) {
          if (shortened.has(el) || el.getAttribute('title') !== full) continue; // done, or a module owns it now
          const value = offTitle(full, hasName(el));
          if (value === full) continue;
          shortened.set(el, value);
          if (value == null) el.removeAttribute('title'); else el.setAttribute('title', value);
        } else if (shortened.has(el)) {
          const value = shortened.get(el);
          shortened.delete(el);
          if (el.getAttribute('title') === value) el.setAttribute('title', full); // unless a module set a new one
        }
      }
    }
    applyTitleLevel();

    prefs.subscribe(() => { hide(); applyTitleLevel(); });
    return { hide, claimTitles, show, applyTitleLevel, configure: (d) => Object.assign(cfg, d) };
  }

  return { init, resolveTip, place, inHoverArea, offTitle, DEFAULTS };
})();

if (typeof module !== 'undefined') module.exports = P8Tips;

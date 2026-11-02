// js/tours.js
// DOM side of the quick tours (UX issue #61). Engine: js/tours-core.js; built-in tours:
// js/tours-data.js. Never blocks the page: no backdrop, the highlighted element stays usable, the
// card is a non-modal dialog, Escape or the close button ends the tour at any time.

'use strict';

(() => {
  const App = window.P8App;
  const Core = P8TourCore;
  const { el } = App;

  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const engine = Core.create({ storage });
  for (const tour of P8TourData.TOURS) {
    const r = engine.register(tour);
    if (!r.ok) App.diagnostics?.report('tours', 'E_TOUR_INVALID', new Error(r.errors.join('; ')));
  }

  let active = null; // { run, ring, card }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (node) => !!node && node.getClientRects().length > 0 && !node.closest('[hidden]');
  const stepText = (step) => {
    if (step.text) return step.text;
    const hit = step.helpId && P8Help.control(step.helpId);
    return hit ? hit.control.text : '';
  };

  /** applies the step's harmless navigation, then looks for the target; null = skip this step */
  async function prepare(step) {
    const b = step.before || {};
    if (b.ws && document.body.dataset.workspace !== b.ws) { App.setWorkspace(b.ws); await sleep(60); }
    if (b.click) {
      const c = document.querySelector(b.click);
      if (c && c.getAttribute('aria-checked') !== 'true') { c.click(); await sleep(120); }
    }
    if (!step.target) return { el: null };
    const node = document.querySelector(step.target);
    if (!visible(node)) return null;
    return { el: node };
  }

  function position() {
    if (!active) return;
    const { ring, card } = active;
    const node = active.run.state.ctx && active.run.state.ctx.el;
    if (node && visible(node)) {
      const r = node.getBoundingClientRect();
      Object.assign(ring.style, { display: 'block', top: `${r.top - 3}px`, left: `${r.left - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
      const p = P8Tips.place(r, card.offsetWidth, card.offsetHeight, document.documentElement.clientWidth, document.documentElement.clientHeight, 12);
      card.style.top = `${p.top}px`;
      card.style.left = `${p.left}px`;
    } else {
      ring.style.display = 'none';
      card.style.top = `${Math.max(8, (document.documentElement.clientHeight - card.offsetHeight) / 3)}px`;
      card.style.left = `${Math.max(8, (document.documentElement.clientWidth - card.offsetWidth) / 2)}px`;
    }
  }

  function end(finished) {
    if (!active) return;
    const { run, ring, card, opener } = active;
    if (!finished) run.abort();
    run.finish();
    ring.remove();
    card.remove();
    active = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
    if (opener && opener.isConnected) opener.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' && active) { e.preventDefault(); e.stopPropagation(); end(false); }
  }

  function render() {
    if (!active) return;
    const { run, card } = active;
    const s = run.state;
    if (s.status === 'done') { end(true); return; }
    if (s.status !== 'running') { end(false); return; }
    const tour = engine.get(s.tourId);
    const last = s.index >= tour.steps.length - 1;
    const text = stepText(s.step);
    card.replaceChildren(
      el('h2', { id: 'tour-title', textContent: s.step.title }),
      el('p', { textContent: text }),
      el('p', { className: 'muted tour-count', textContent: `${tour.title} · step ${s.index + 1} of ${tour.steps.length}` }),
      el('div', { className: 'tour-buttons' },
        el('button', { type: 'button', className: 'btn btn-sm', textContent: 'Back', disabled: s.index <= 0, onclick: async () => { await run.back(); if (active?.run === run) render(); } }),
        el('button', { type: 'button', className: 'btn btn-sm btn-primary', textContent: last ? 'Finish' : 'Next', onclick: async () => { await run.next(); if (active?.run === run) render(); } }),
        el('button', { type: 'button', className: 'btn btn-sm btn-ghost', textContent: 'Close tour (Esc)', onclick: () => end(false) })));
    const node = s.ctx && s.ctx.el;
    if (node) node.scrollIntoView({ block: 'center', behavior: App.reducedMotion() ? 'auto' : 'smooth' });
    position();
    card.querySelector('.btn-primary')?.focus({ preventScroll: true });
  }

  async function start(id) {
    if (!engine.get(id)) return false;
    if (active) end(false);
    const run = engine.run(id, prepare);
    const card = el('div', { className: 'tour-card', attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tour-title', tabindex: '-1' } });
    const ring = el('div', { className: 'tour-ring', attrs: { 'aria-hidden': 'true' } });
    document.body.append(ring, card);
    active = { run, ring, card, opener: document.activeElement };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    await run.start();
    if (active?.run !== run) return false;
    if (run.state.status !== 'running') {
      end(true);
      App.toast('This tour has nothing to show here right now.', 'info');
      return false;
    }
    render();
    return true;
  }

  async function showTours() {
    const statusOf = (t) => {
      const p = engine.progress(t.id);
      if (!p) return 'Not started';
      return `${p.status === 'done' ? 'Completed' : 'Closed early'}${engine.whatsNew(t.id) ? ' · What’s new' : ''}`;
    };
    const list = el('ul', { className: 'tour-list' }, ...engine.list().map((t) => el('li', {},
      el('div', {}, el('strong', { textContent: t.title }), el('span', { className: 'muted', textContent: ` ${statusOf(t)}` }), el('p', { className: 'hint', textContent: t.summary })),
      el('button', { type: 'button', className: 'btn btn-sm', textContent: engine.progress(t.id) ? 'Replay' : 'Start', attrs: { 'aria-label': `${engine.progress(t.id) ? 'Replay' : 'Start'} ${t.title}` }, dataset: { tour: t.id } }))));
    const body = el('div', {}, el('p', { className: 'hint', textContent: 'Tours are optional and change nothing in your projects. Press Esc to leave one at any time. Turn automatic offers off in Help › Settings.' }), list);
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tour]');
      if (!b) return;
      document.querySelector('dialog.modal[open] button[aria-label="Close"]')?.click();
      setTimeout(() => start(b.dataset.tour), 0);
    });
    await App.modal({ title: 'Quick tours', body, buttons: [{ label: 'Close', value: null, primary: true }] });
  }

  async function offerWelcome() {
    const p = App.prefs.get();
    const busy = !!document.querySelector('dialog[open]') || document.body.dataset.workspace !== 'home';
    if (!engine.shouldOfferWelcome({ autoOffer: p.autoOfferTours && p.helpLevel !== 'off', busy })) return;
    const choice = await App.modal({
      title: 'Welcome to the PICO-8 Dev Suite',
      body: 'Want a one-minute tour of the tools? It is optional, changes nothing, and you can replay it any time from Help › Quick tours.',
      buttons: [
        { label: 'Never auto-offer', value: 'never' },
        { label: 'Explore independently', value: 'skip' },
        { label: 'Start tour', value: 'start', primary: true },
      ],
    });
    if (choice === 'start') { engine.setWelcome('started'); start('suite'); } else if (choice === 'never') { engine.setWelcome('never'); App.prefs.set({ autoOfferTours: false }); } else engine.setWelcome('skipped');
  }

  App.registerActions({ 'quick-tours': showTours });
  window.P8Tours = { register: (t) => engine.register(t), start, list: () => engine.list(), engine };
  // after the first paint, never over a project the user already works in
  setTimeout(() => { offerWelcome().catch((e) => App.diagnostics?.report('tours', 'E_TOUR_WELCOME', e)); }, 1200);
})();

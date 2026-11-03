// #60: tooltip lookup, levels and placement (js/ux-tooltips.js) and registry integrity of data-help-id.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const Tips = require('../js/ux-tooltips.js');
const Help = require('../js/help-core.js');
const vm = require('vm');

// Bounded DOM/event fixture for the real init() adapter, with deterministic timers.
// authored(element): optional; returns the elements carrying a title in the "authored markup" (#107).
function tooltipFixture(source = fs.readFileSync(path.join(__dirname, '../js/ux-tooltips.js'), 'utf8'), { authored } = {}) {
  const events = () => ({
    listeners: new Map(),
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); },
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); },
    emit(type, props = {}) { const e = { clientX: 120, clientY: 110, pointerType: 'mouse', ...props }; for (const fn of [...(this.listeners.get(type) || [])]) fn(e); return e; },
  });
  const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const element = (parent = null) => ({
    parent, dataset: {}, style: {}, attrs: new Map(), children: [], isConnected: true, textContent: '',
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(k, v) { this.attrs.set(k, v); }, getAttribute(k) { return this.attrs.get(k) ?? null; },
    removeAttribute(k) { this.attrs.delete(k); }, hasAttribute(k) { return this.attrs.has(k); },
    contains(n) { return !!n && (n === this || this.contains(n.parent)); },
    closest(selector) {
      if (selector === '[title]') return this.hasAttribute('title') ? this : this.parent?.closest(selector) || null;
      return this.dataset.helpId ? this : this.parent?.closest(selector) || null;
    }, matches() { return true; },
    offsetWidth: 200, offsetHeight: 60,
    getBoundingClientRect() { return this.rect || box(parseFloat(this.style.left), parseFloat(this.style.top), this.offsetWidth, Math.min(this.offsetHeight, parseFloat(this.style.maxHeight) || Infinity)); },
  });
  const body = element();
  const authoredNodes = authored ? authored(element) : [];
  if (authored) body.querySelectorAll = () => authoredNodes;
  const doc = Object.assign(events(), { body, activeElement: body, documentElement: { clientWidth: 800, clientHeight: 600 }, createElement: () => element(), createTextNode: (text) => ({ textContent: text }), querySelectorAll: () => [] });
  const win = events();
  let next = 1, level = 'concise', subscriber;
  const timers = new Map();
  const ctx = vm.createContext({ document: doc, window: win, setTimeout: (fn) => { const id = next++; timers.set(id, fn); return id; }, clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(source, ctx);
  const api = vm.runInContext('P8Tips', ctx).init({ prefs: { get: () => ({ helpLevel: level }), subscribe: (fn) => { subscriber = fn; } }, help: Help });
  const control = element(); control.dataset.helpId = 'studio.tiled'; control.rect = box(100, 100, 100, 20);
  control.matches = () => false; // nonfocusable help wrapper around a focusable child
  const child = element(control);
  const tip = body.children[0];
  return { api, control, child, tip, doc, win, timers,
    flush() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    setLevel(value) { level = value; subscriber(); },
    enter() { doc.emit('pointerover', { target: control }); },
    move(x, y, extra = {}) { doc.emit('pointermove', { target: body, clientX: x, clientY: y, ...extra }); },
    listenerCount() { return doc.listeners.get('pointermove')?.size || 0; },
  };
}

t('#104 pointer crosses control/gap/tooltip without a timeout, then leaving cleans up', () => {
  const f = tooltipFixture();
  f.control.setAttribute('aria-describedby', 'existing-description');
  f.enter(); f.flush();
  assert.strictEqual(f.tip.hidden, false);
  assert.strictEqual(f.control.getAttribute('aria-describedby'), 'existing-description p8-tip');
  f.doc.emit('pointerout', { target: f.control, relatedTarget: f.doc.body, clientX: 150, clientY: 124 });
  f.move(150, 124); f.flush(); // pause indefinitely in the 8px gap
  assert.strictEqual(f.tip.hidden, false);
  f.move(150, 140);
  // The tooltip is pointer-transparent; another help target under its text must not replace it.
  const other = { closest: () => ({ dataset: { helpId: 'studio.transparent' } }) };
  f.doc.emit('pointerover', { target: other, clientX: 150, clientY: 140 }); f.flush();
  assert.strictEqual(f.control.getAttribute('aria-describedby'), 'existing-description p8-tip');
  f.move(150, 124); f.move(150, 110); // return to trigger
  assert.strictEqual(f.tip.hidden, false);
  f.move(700, 500);
  assert.strictEqual(f.tip.hidden, true);
  assert.strictEqual(f.control.getAttribute('aria-describedby'), 'existing-description');
  assert.strictEqual(f.listenerCount(), 0);
  assert.strictEqual(f.timers.size, 0);
});

t('#104 keyboard focus inside a help wrapper persists; Escape dismisses without moving focus', () => {
  const f = tooltipFixture();
  f.doc.activeElement = f.child;
  f.doc.emit('focusin', { target: f.child });
  f.doc.emit('pointerout', { target: f.control, relatedTarget: f.doc.body, clientX: 700, clientY: 500 });
  f.flush();
  f.move(700, 500);
  assert.strictEqual(f.tip.hidden, false);
  let prevented = 0, stopped = 0;
  const escape = { key: 'Escape', preventDefault: () => prevented++, stopPropagation: () => stopped++ };
  f.doc.emit('keydown', escape);
  assert.strictEqual(f.tip.hidden, true);
  assert.strictEqual(f.doc.activeElement, f.child);
  assert.strictEqual(f.control.getAttribute('aria-describedby'), null);
  assert.deepStrictEqual([prevented, stopped, f.listenerCount()], [1, 1, 0]);
  f.doc.emit('keydown', escape);
  assert.deepStrictEqual([prevented, stopped], [1, 1], 'Escape passes through when no tip is visible');

  f.doc.emit('focusin', { target: f.child }); f.flush();
  f.doc.activeElement = f.doc.body;
  f.doc.emit('focusout', { target: f.child, relatedTarget: f.doc.body });
  assert.strictEqual(f.tip.hidden, true);
  f.child.matches = () => false;
  f.control.matches = () => false;
  f.doc.emit('pointerdown', { pointerType: 'touch' });
  f.doc.activeElement = f.child;
  f.doc.emit('focusin', { target: f.child }); f.flush();
  assert.strictEqual(f.tip.hidden, false, 'touch focus still offers optional help');
  f.win.emit('blur');
  assert.strictEqual(f.tip.hidden, true);
  assert.strictEqual(f.listenerCount(), 0);
});

t('#104 focus/hover transitions, dragging, preferences and unavailable targets leave no stale tooltip', () => {
  const f = tooltipFixture();
  f.enter(); f.doc.emit('pointerout', { target: f.control, relatedTarget: f.doc.body, clientX: 700, clientY: 500 }); f.flush();
  assert.strictEqual(f.tip.hidden, true, 'leaving before hover delay cancels the pending tip');
  f.doc.activeElement = f.child; f.doc.emit('focusin', { target: f.child }); f.flush();
  f.move(150, 140); f.doc.activeElement = f.doc.body;
  f.doc.emit('focusout', { target: f.child, relatedTarget: f.doc.body });
  f.doc.emit('focusin', { target: f.doc.body });
  assert.strictEqual(f.tip.hidden, false, 'hovering the tip survives focus leaving the control');
  f.move(150, 140, { buttons: 1 });
  assert.strictEqual(f.tip.hidden, true, 'a drag cannot leave a tooltip above the canvas');
  f.setLevel('off'); f.enter(); f.flush(); assert.strictEqual(f.tip.hidden, true);
  f.setLevel('detailed'); f.enter(); f.flush(); assert.strictEqual(f.tip.hidden, false);
  assert.ok(f.tip.children.some((n) => /F1/.test(n.textContent)));
  f.setLevel('concise'); assert.strictEqual(f.tip.hidden, true);
  assert.strictEqual(f.listenerCount(), 0);
  f.enter(); f.flush(); f.control.isConnected = false; f.move(150, 140);
  assert.strictEqual(f.tip.hidden, true);
  f.control.isConnected = true;
  f.enter(); f.flush();
  f.doc.emit('pointerout', { target: f.doc.body, relatedTarget: null });
  assert.strictEqual(f.tip.hidden, true, 'leaving the browser over the transparent tip dismisses it');
  for (const type of ['scroll', 'resize']) {
    f.enter(); f.flush(); f.win.emit(type);
    assert.strictEqual(f.tip.hidden, true);
    assert.strictEqual(f.listenerCount(), 0);
  }
  f.doc.documentElement.clientHeight = 140;
  f.control.rect = { left: 0, right: 800, top: 10, bottom: 130, width: 800, height: 120 };
  f.enter(); f.flush(); assert.strictEqual(f.tip.hidden, true, 'no room leaves F1 as the fallback');
  assert.strictEqual(f.listenerCount(), 0);
});

t('#104 hover travel works on all four tooltip sides without extending beyond the corridor', () => {
  const r = { left: 100, right: 200, top: 100, bottom: 120 };
  for (const [side, rect, gap, inside] of [
    ['below', { left: 50, right: 250, top: 128, bottom: 188 }, [150, 124], [150, 150]],
    ['above', { left: 50, right: 250, top: 32, bottom: 92 }, [150, 96], [150, 50]],
    ['left', { left: 32, right: 92, top: 60, bottom: 160 }, [96, 110], [50, 110]],
    ['right', { left: 208, right: 268, top: 60, bottom: 160 }, [204, 110], [240, 110]],
  ]) {
    assert.ok(Tips.inHoverArea(r, rect, side, ...gap), side);
    assert.ok(Tips.inHoverArea(r, rect, side, ...inside), side);
    assert.strictEqual(Tips.inHoverArea(r, rect, side, 500, 500), false);
  }
});

t('#104 moving to another control preserves its pending tip after the next pointer move', () => {
  const f = tooltipFixture();
  const next = { ...f.control, attrs: new Map(), dataset: { helpId: 'studio.transparent' }, rect: { left: 400, right: 500, top: 100, bottom: 120, width: 100, height: 20 } };
  f.enter(); f.flush();
  f.doc.emit('pointerover', { target: next, clientX: 450, clientY: 110 });
  f.move(450, 110); f.flush();
  assert.strictEqual(f.tip.hidden, false);
  assert.strictEqual(next.getAttribute('aria-describedby'), 'p8-tip');
  assert.strictEqual(f.control.getAttribute('aria-describedby'), null);
  // A keyboard change of target must likewise not leave the old pointer listener cancelling it.
  f.doc.activeElement = f.child;
  f.doc.emit('focusin', { target: f.child }); f.move(700, 500); f.flush();
  assert.strictEqual(f.tip.hidden, false);
  assert.strictEqual(f.control.getAttribute('aria-describedby'), 'p8-tip');
  assert.strictEqual(next.getAttribute('aria-describedby'), null);
});

t('#60 off shows nothing; concise and detailed read the same registry text', () => {
  assert.strictEqual(Tips.resolveTip(Help, 'studio.tiled', 'off'), null);
  const c = Tips.resolveTip(Help, 'studio.tiled', 'concise');
  const d = Tips.resolveTip(Help, 'studio.tiled', 'detailed');
  assert.ok(c.text.length > 10);
  assert.ok(d.text.startsWith(c.text), 'detailed extends the concise text');
  assert.ok(d.text.length > c.text.length && /F1/.test(d.text));
  assert.strictEqual(c.topic, 'studio');
});

t('#60 unknown ids, missing help and throwing lookups fail quietly', () => {
  assert.strictEqual(Tips.resolveTip(Help, 'no.such.control', 'concise'), null);
  assert.strictEqual(Tips.resolveTip(Help, '', 'concise'), null);
  assert.strictEqual(Tips.resolveTip(null, 'x', 'concise'), null);
  assert.strictEqual(Tips.resolveTip({ control() { throw new Error('boom'); } }, 'x', 'concise'), null);
});

t('#60 placement stays on screen and never covers the target', () => {
  const r = { top: 100, bottom: 120, left: 10, width: 40 };
  const below = Tips.place(r, 200, 50, 800, 600);
  assert.strictEqual(below.side, 'below');
  assert.ok(below.top >= r.bottom);
  assert.ok(below.left >= 4);
  const above = Tips.place({ top: 560, bottom: 580, left: 700, width: 40 }, 200, 50, 800, 600);
  assert.strictEqual(above.side, 'above');
  assert.ok(above.top + 50 <= 560);
  assert.ok(above.left + 200 <= 796);
});

t('#60 when neither below nor above fits, the tip goes beside the target or is shortened, never over it', () => {
  const covers = (p, r, w, h) => p && !(p.left + w <= r.left || r.left + r.width <= p.left || p.top + (p.maxHeight ?? h) <= r.top || r.bottom <= p.top);
  // short, wide viewport: room to the right
  const r1 = { top: 40, bottom: 70, left: 10, width: 100 };
  const p1 = Tips.place(r1, 200, 130, 800, 150);
  assert.strictEqual(p1.side, 'right');
  assert.ok(!covers(p1, r1, 200, 130));
  // narrow and short (320 x 150, the case found in the browser): shortened on the larger side
  const r2 = { top: 58, bottom: 92, left: 27, width: 162 };
  const p2 = Tips.place(r2, 304, 131, 320, 150);
  assert.ok(p2 && p2.maxHeight > 0 && p2.maxHeight < 131, JSON.stringify(p2));
  assert.ok(!covers(p2, r2, 304, 131), JSON.stringify(p2));
  // no room for even two lines anywhere: no tip rather than one over the control
  assert.strictEqual(Tips.place({ top: 20, bottom: 80, left: 10, width: 300 }, 304, 131, 320, 100), null);
});

t('#60 every data-help-id in index.html resolves in the help registry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/data-help-id="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 5, 'example controls are marked');
  for (const id of ids) assert.ok(Tips.resolveTip(Help, id, 'concise'), `no help text for ${id}`);
});

t('#107 Off keeps names and shortcut keys of native titles but drops optional explanations', () => {
  const cases = [
    ['Draw (B) · paints the selected tile or block', false, 'Draw (B)'], // only name: keep the name part
    ['Ellipse select (M twice) · drag inside to move', false, 'Ellipse select (M twice)'],
    ['Draw (B) · paints the selected tile or block', true, 'Draw (B)'],
    ['Save into the file (Ctrl+S)', true, 'Ctrl+S'], // named button: the key is all that is extra
    ['Next (F3 / Enter)', true, 'Next (F3 / Enter)'],
    ['Fit (0)', true, 'Fit (0)'],
    ['Pixel perfect (P): no L-shaped corners in 1-pixel strokes', true, 'Pixel perfect (P)'], // key mid-sentence
    ['Read the folder again (F5). A folder chosen with the button has to be chosen again', true, 'F5'],
    ['Cell grid (8×8 pixels)', true, null], // parenthetical explanation, not a key
    ['Floyd–Steinberg dithering for smoother gradients (creates more unique tiles)', true, null],
    ['A long description that is the only accessible name', false, 'A long description that is the only accessible name'],
  ];
  for (const [title, named, expected] of cases) assert.strictEqual(Tips.offTitle(title, named), expected, title);
});

t('#107 the real adapter applies Off live to authored titles and restores them without a reload', () => {
  let named, tool, keyed, owned, plain, disabled;
  const f = tooltipFixture(undefined, { authored: (element) => {
    const make = (title, props = {}) => { const e = element(); e.setAttribute('title', title); return Object.assign(e, props); };
    named = make('Cell grid (8×8 pixels)', { textContent: 'Grid' });
    tool = make('Draw (B) · paints the selected tile or block');
    keyed = make('Save into the file (Ctrl+S)', { textContent: 'Save' });
    owned = make('Where this map fits in a PICO-8 cart', { textContent: '' });
    plain = make('Fit (0)', { textContent: 'Fit' });
    disabled = make('Re-derive every tile from all its uses', { textContent: 'Auto Generate Tiles', disabled: true });
    disabled.dataset.helpId = 'tiles.autogen';
    return [named, tool, keyed, owned, plain, disabled];
  } });
  // A module replaces a static title with live status after load: never touched afterwards.
  owned.setAttribute('title', 'Fits in __map__ (128×32)');
  f.setLevel('off');
  assert.strictEqual(named.getAttribute('title'), null);
  assert.strictEqual(tool.getAttribute('title'), 'Draw (B)');
  assert.strictEqual(keyed.getAttribute('title'), 'Ctrl+S');
  assert.strictEqual(plain.getAttribute('title'), 'Fit (0)');
  assert.strictEqual(owned.getAttribute('title'), 'Fits in __map__ (128×32)');
  assert.strictEqual(disabled.getAttribute('title'), null, 'an unclaimed registry control follows Off too');
  // While Off, a module sets new text on a shortened control: restoring must keep the module's text.
  tool.setAttribute('title', 'Draw (B) · status from a module');
  f.setLevel('detailed');
  assert.strictEqual(named.getAttribute('title'), 'Cell grid (8×8 pixels)');
  assert.strictEqual(keyed.getAttribute('title'), 'Save into the file (Ctrl+S)');
  assert.strictEqual(tool.getAttribute('title'), 'Draw (B) · status from a module');
  assert.strictEqual(disabled.getAttribute('title'), 'Re-derive every tile from all its uses');
  f.setLevel('off'); f.setLevel('concise');
  assert.strictEqual(named.getAttribute('title'), 'Cell grid (8×8 pixels)', 'repeat toggles are stable');
  // A disabled registry control keeps its native title; once enabled, targeting it claims the
  // title so it never shows both a native and a registry tooltip.
  f.doc.emit('pointerover', { target: disabled });
  assert.strictEqual(disabled.getAttribute('title'), 'Re-derive every tile from all its uses');
  f.flush(); assert.strictEqual(f.tip.hidden, true, 'disabled native explanation must not get a second registry tooltip');
  disabled.disabled = false;
  f.doc.emit('pointerover', { target: disabled });
  assert.strictEqual(disabled.getAttribute('title'), null);
  assert.strictEqual(disabled.dataset.titleOrig, 'Re-derive every tile from all its uses');
  f.flush(); assert.strictEqual(f.tip.hidden, false, 'enabled control uses its single registry tooltip');
  f.setLevel('off'); f.setLevel('concise');
  assert.strictEqual(disabled.getAttribute('title'), null, 'a claimed control is left to the registry tip');
});

t('#107 a native-titled child suppresses inherited group help, including an already visible tip', () => {
  const f = tooltipFixture(); f.enter(); f.flush(); assert.strictEqual(f.tip.hidden, false);
  f.child.setAttribute('title', 'Pixel perfect (P): no L-shaped corners.');
  f.doc.emit('pointerover', { target: f.child }); f.flush();
  assert.strictEqual(f.tip.hidden, true);
  assert.strictEqual(f.child.getAttribute('title'), 'Pixel perfect (P): no L-shaped corners.');
  f.doc.activeElement = f.child; f.doc.emit('focusin', { target: f.child }); f.flush();
  assert.strictEqual(f.tip.hidden, true);
  f.child.setAttribute('title', ''); f.doc.emit('pointerover', { target: f.child }); f.flush();
  assert.strictEqual(f.tip.hidden, false, 'empty builder titles are not native tooltips and must allow group help');
});

t('#107 a control disabled during the hover delay keeps its new native reason without a custom tip', () => {
  const f = tooltipFixture();
  f.enter();
  f.control.disabled = true;
  f.control.setAttribute('title', 'Build unavailable: source changed.');
  f.flush();
  assert.strictEqual(f.tip.hidden, true);
  assert.strictEqual(f.control.getAttribute('title'), 'Build unavailable: source changed.');
  f.setLevel('off'); f.setLevel('detailed');
  assert.strictEqual(f.control.getAttribute('title'), 'Build unavailable: source changed.', 'module-owned reason survives preference changes');
});

// #110: built-in JavaScript builders that set help ids, and contextual help per workspace.
function builderHelpIds() {
  const dir = path.join(__dirname, '..', 'js');
  const skip = new Set(['help-data.js', 'help-core.js', 'ux-tooltips.js', 'tours-data.js', 'tours-core.js', 'tours.js']);
  const found = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !skip.has(f))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/helpId(?:\s*:\s*|\s*=\s*)'([\w.-]+)'/g)) found.push({ file, id: m[1] });
  }
  return found;
}

t('#110 help ids set by built-in JavaScript builders resolve in the help registry', () => {
  const found = builderHelpIds();
  assert.ok(found.length >= 6, `builders carry help ids: ${found.map((x) => x.id)}`);
  for (const { file, id } of found) assert.ok(Tips.resolveTip(Help, id, 'concise'), `${file}: no help text for ${id}`);
});

t('#110 every built-in workspace exposes contextual help for its own controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // Home is itself the task overview (cards and Continue/Tasks/Tools sections); its help is F1.
  const exempt = { home: 'overview page; its own cards and F1 explain it' };
  const mains = [...html.matchAll(/<main\b[^>]*\sdata-ws="([\w-]+)"[^>]*>([\s\S]*?)<\/main>/g)];
  assert.ok(mains.length >= 12, 'all workspaces found');
  const builders = builderHelpIds().map((x) => x.id);
  for (const [, ws, body] of mains) {
    if (exempt[ws]) continue;
    const ids = [...[...body.matchAll(/data-help-id="([^"]+)"/g)].map((m) => m[1]), ...builders];
    const own = ids.filter((id) => Help.control(id)?.topic.ws === ws);
    assert.ok(own.length >= 1, `workspace "${ws}" has no control marked with one of its help ids`);
  }
});

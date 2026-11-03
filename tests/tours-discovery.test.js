const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn, line } = require('./source-extract.js');
const Core = require('../js/tours-core.js');
const Data = require('../js/tours-data.js');

// A hypothetical external Extra Tool without a built-in tour (all built-in tools have one, #103).
const tour = (extra = {}) => ({ id: 'plugin', title: 'Plasma Lab orientation', summary: 'Plasma shapes and exports', major: 1, ws: 'extras', sub: 'plasma', steps: [{ id: 'intro', title: 'Welcome', text: 'Orientation' }], ...extra });

t('#108 current-tour resolution follows live metadata and never substitutes another Extra Tool', () => {
  const engine = Core.create();
  for (const x of Data.TOURS) assert.ok(engine.register(x).ok);
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'home' }).id, 'suite');
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'studio' }).id, 'studio');
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'extras', sub: 'terrain' }).id, 'terrain');
  for (const sub of ['lut', 'wave', 'line']) assert.strictEqual(Core.forContext(engine.list(), { ws: 'extras', sub }).id, sub);
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'extras', sub: 'plasma' }), null);
  assert.ok(engine.register(tour()).ok);
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'extras', sub: 'plasma' }).id, 'plugin');
  engine.register(tour({ id: 'extras-overview', sub: null }));
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'extras', sub: 'missing' }), null);
  assert.strictEqual(Core.forContext(engine.list(), { ws: 'missing' }), null);
  assert.strictEqual(Core.forContext(engine.list()), null);
});

t('#108 search is case-insensitive and metadata remains optional for legacy/global-only tours', () => {
  const list = [...Data.TOURS, tour({ id: 'legacy', ws: undefined, sub: undefined })];
  assert.strictEqual(Core.validate(list.at(-1)).length, 0);
  assert.deepStrictEqual(Core.search(list, ' TERRAIN   seamless ').map((x) => x.id), ['terrain']);
  assert.deepStrictEqual(Core.search(list, 'suite').map((x) => x.id), ['suite']);
  assert.deepStrictEqual(Core.search(list, ''), list);
  assert.deepStrictEqual(Core.search(list, 'no-such-tour'), []);
  assert.ok(Core.validate(tour({ ws: null })).some((e) => /sub/.test(e)));
  assert.ok(Core.validate(tour({ ws: 123 })).some((e) => /ws/.test(e)));
});

// Actual chooser/context actions in a bounded DOM/modal fixture. Browser layout and native
// focus behavior still need the manual checklist; this verifies routing and async handoff.
function setup() {
  const source = read('js/tours.js');
  const nodes = [], starts = [], actions = {}, helpActions = [];
  let modalOpen = false, dialog, resolveModal, sub = 'terrain', focused;
  const document = { body: { dataset: { workspace: 'studio' } } };
  function el(tag, props = {}, ...children) {
    const node = { tag, ...props, children, listeners: {}, isConnected: true,
      append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
      addEventListener(type, cb) { this.listeners[type] = cb; },
      getClientRects: () => [1], closest() { return this.dataset?.tour ? this : null; },
      focus() { focused = this; document.activeElement = this; },
    }; nodes.push(node); return node;
  }
  const helpButton = el('button', { id: 'help-menu' });
  const workspaceButton = el('button', { id: 'current-workspace' });
  document.activeElement = { closest: () => ({ querySelector: () => helpButton }) };
  function close(value = null) { modalOpen = false; resolveModal(value); }
  document.querySelector = (selector) => {
    if (selector.startsWith('#exTabs')) return { dataset: { value: sub } };
    if (selector.startsWith('#wsTabs')) return workspaceButton;
    if (selector.startsWith('dialog.modal')) return { click: () => close() };
    return null;
  };
  const storage = { getItem: () => JSON.stringify({ version: 1, welcome: 'never', tours: { studio: { status: 'done', major: 1 } } }), setItem() {} };
  const engine = Core.create({ storage });
  for (const x of Data.TOURS) engine.register(x);
  const App = {
    el, registerActions: (a) => Object.assign(actions, a), runAction: (name) => helpActions.push(name),
    // Explicit manual tours must not change preferences or depend on automatic-offer settings.
    prefs: { get() { throw Error('manual launch should not consult auto-offer preference'); }, set() { throw Error('preference changed'); } },
    modal: (opts) => { modalOpen = true; dialog = opts; opts.onOpen?.(); return new Promise((resolve) => { resolveModal = resolve; }); },
  };
  const window = { Suite: { tools: () => [{ ws: 'extras', sub: 'plasma', name: 'Plasma Lab' }] } };
  const ctx = vm.createContext({ App, Core, document, window, el, engine,
    start: async (id, opts) => { starts.push({ id, opts, modalOpen }); return true; },
  });
  vm.runInContext(`let active = null, refreshList = null, chooserSeq = 0;
    ${line(source, 'const visible =')}
    ${fn(source, 'returnTarget')}
    ${fn(source, 'restoreOpener')}
    ${fn(source, 'currentContext')}
    ${fn(source, 'tourThisTool')}
    ${fn(source, 'showTours')}
    ${line(source, 'App.registerActions(')}
    ${line(source, 'window.P8Tours =')}`, ctx);
  return { actions, starts, helpActions, nodes, document, helpButton, workspaceButton, close,
    setSub: (value) => { sub = value; }, register: window.P8Tours.register,
    restore: ctx.restoreOpener,
    get dialog() { return dialog; }, get focused() { return focused; },
    get input() { return nodes.findLast((n) => n.type === 'search'); },
    get list() { return nodes.findLast((n) => n.className === 'tour-list'); },
    get count() { return nodes.findLast((n) => n.attrs?.role === 'status'); },
  };
}

t('#108 menu action uses current workspace/tab and gives a visible Help fallback until a tour is registered', async () => {
  const f = setup();
  await f.actions['tour-this-tool'](); assert.strictEqual(f.starts.at(-1).id, 'studio');
  f.document.body.dataset.workspace = 'extras';
  await f.actions['tour-this-tool'](); assert.strictEqual(f.starts.at(-1).id, 'terrain');
  f.setSub('wave');
  await f.actions['tour-this-tool'](); assert.strictEqual(f.starts.at(-1).id, 'wave');
  f.setSub('plasma');
  const missing = f.actions['tour-this-tool']();
  assert.strictEqual(f.dialog.title, 'No tour for this tool yet');
  assert.match(f.dialog.body, /Plasma Lab/);
  f.close('help'); await missing;
  assert.deepStrictEqual(f.helpActions, ['docs']);
  assert.strictEqual(f.focused, f.helpButton);
  f.register(tour());
  await f.actions['tour-this-tool'](); assert.strictEqual(f.starts.at(-1).id, 'plugin');
});

t('#108 chooser filters, keeps progress, refreshes registrations and launches only after its modal closes', async () => {
  const f = setup();
  const showing = f.actions['quick-tours']();
  const total = Data.TOURS.length;
  assert.strictEqual(f.focused, f.input);
  assert.strictEqual(f.count.textContent, `${total} of ${total} tours`);
  const studio = f.list.children.find((li) => li.children[1].dataset.tour === 'studio');
  assert.strictEqual(studio.children[1].textContent, 'Replay');
  assert.match(studio.children[0].children[1].textContent, /Completed.*Current tool/);
  assert.match(f.list.children[0].children[0].children[1].textContent, /Suite overview/);
  f.input.value = 'SEAMLESS'; f.input.listeners.input();
  assert.strictEqual(f.count.textContent, `1 of ${total} tours`);
  f.input.value = 'no-such-tour'; f.input.listeners.input();
  assert.match(f.list.children[0].textContent, /No tours match/);
  f.input.value = ''; f.input.listeners.input();
  f.register(tour()); assert.strictEqual(f.count.textContent, `${total + 1} of ${total + 1} tours`);
  const button = f.list.children.find((li) => li.children[1].dataset.tour === 'plugin').children[1];
  f.list.listeners.click({ target: button });
  assert.strictEqual(f.starts.length, 0, 'no tour before the modal promise settles');
  await showing;
  assert.strictEqual(f.starts[0].id, 'plugin');
  assert.strictEqual(f.starts[0].modalOpen, false);
  assert.strictEqual(f.starts[0].opts.opener, f.helpButton);
  const count = f.count;
  f.register(tour({ id: 'later' }));
  assert.strictEqual(count.textContent, `${total + 1} of ${total + 1} tours`, 'closed selector has no refresh callback');
});

t('#108 cancelling selector starts nothing; focus uses the opener or the current visible workspace', async () => {
  const f = setup(); const showing = f.actions['quick-tours'](); f.close();
  assert.strictEqual(await showing, false);
  assert.strictEqual(f.starts.length, 0);
  assert.strictEqual(f.focused, f.helpButton);
  f.restore({ isConnected: false });
  assert.strictEqual(f.focused, f.workspaceButton);
});

t('#103 declared built-in tours register and resolve to their exact workspace/subtool', () => {
  const engine = Core.create();
  for (const tour of Data.TOURS) assert.deepStrictEqual(engine.register(tour).errors || [], [], tour.id);
  for (const tour of Data.TOURS) {
    assert.strictEqual(Core.forContext(engine.list(), { ws: tour.ws, sub: tour.sub })?.id, tour.id);
  }
  // Missing workspace/subtool and area coverage is audited from bundled sources by docs-integrity.
});

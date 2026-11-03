const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');
const H = require('../js/help-core.js');

t('#106 help resolves explicit topic/control, focused control, subtool and workspace in order', () => {
  assert.strictEqual(H.context({ topicId: 'code', controlId: 'studio.preview', ws: 'extras', sub: 'terrain' }).topic.id, 'code');
  const explicit = H.context({ topicId: 'studio.preview', controlId: 'code.run', ws: 'extras', sub: 'terrain' });
  assert.strictEqual(explicit.topic.id, 'studio');
  assert.strictEqual(explicit.controlId, 'studio.preview');
  const focused = H.context({ controlId: 'extras.terrain.preview', ws: 'extras', sub: 'lut' });
  assert.strictEqual(focused.topic.id, 'extras-terrain');
  assert.strictEqual(focused.controlId, 'extras.terrain.preview');
  for (const sub of ['lut', 'wave', 'line', 'terrain']) {
    assert.strictEqual(H.context({ topicId: 'missing', controlId: 'unknown.control', ws: 'extras', sub }).topic.id, `extras-${sub}`);
    assert.ok(H.search(H.forWorkspace('extras', sub).title).some((r) => r.topic.id === `extras-${sub}`));
  }
  assert.strictEqual(H.forWorkspace('extras', 'plugin-without-help').id, 'extras');
  assert.strictEqual(H.context({ ws: 'code' }).topic.id, 'code');
  assert.strictEqual(H.context({ ws: 'unknown' }).topic, null);
  assert.ok(H.search('whole-number enlargement').some((r) => r.topic.id === 'studio'), 'detailed control explanations are searchable too');
});

// Run the actual showHelp adapter. Existing modal owns Escape, focus trapping and focus return;
// this fixture checks what it receives and the rendered help navigation, not browser layout.
function setup({ ws = 'extras', sub = 'terrain', helpId = null } = {}) {
  let dialog, focus, fullReference;
  const nodes = [];
  function el(tag, props = {}, ...children) {
    const node = { tag, ...props, children, listeners: {},
      append(...kids) { this.children.push(...kids); },
      replaceChildren(...kids) { this.children = kids; },
      addEventListener(type, cb) { this.listeners[type] = cb; },
      focus() { focus = this; }, scrollIntoView() { this.scrolled = true; },
      getAttribute(name) { return this[name] ?? this.attrs?.[name] ?? null; },
      closest() { return this.tag === 'a' ? this : null; },
      querySelector(selector) { return walk(this).find((n) => selector === 'h3' ? n.tag === 'h3' : n.dataset?.helpControl === selector.match(/"([^"]+)"/)?.[1]) || null; },
    };
    nodes.push(node); return node;
  }
  function walk(node) { return [node, ...(node.children || []).flatMap((n) => typeof n === 'object' ? walk(n) : [])]; }
  const document = {
    body: { dataset: { workspace: ws } },
    activeElement: { closest: () => helpId ? { dataset: { helpId } } : null },
    createTextNode: (textContent) => ({ textContent }),
    querySelector: (selector) => selector.startsWith('#exTabs') ? (sub ? { dataset: { value: sub } } : null) : { click() {} },
  };
  const ctx = vm.createContext({ document, P8Help: H, CSS: { escape: (s) => s }, modalSeq: 0, el,
    modal: (opts) => { dialog = opts; opts.onOpen?.(); }, setTimeout: (cb) => cb(), showDocs: (anchor) => { fullReference = anchor; },
  });
  vm.runInContext(fn(read('js/app.js'), 'showHelp'), ctx);
  return { open: (opts) => ctx.showHelp(opts), nodes,
    get dialog() { return dialog; }, get focus() { return focus; }, get fullReference() { return fullReference; },
    get input() { return nodes.find((n) => n.tag === 'input'); },
    get view() { return nodes.find((n) => n.className === 'help-view'); },
    tree: () => walk(dialog.body),
    heading() { return this.view.querySelector('h3').textContent; },
    navigate(href) { this.view.listeners.click({ target: el('a', { href }), preventDefault() {} }); },
  };
}

t('#106 F1 adapter opens each selected Extra Tool and focuses the exact control when present', () => {
  for (const sub of ['lut', 'wave', 'line', 'terrain']) {
    const f = setup({ sub }); f.open();
    assert.strictEqual(f.heading(), H.forWorkspace('extras', sub).title);
    assert.strictEqual(f.focus, f.input);
  }
  const f = setup({ ws: 'studio', helpId: 'studio.preview' }); f.open();
  assert.strictEqual(f.focus.dataset.helpControl, 'studio.preview');
  assert.strictEqual(f.focus.attrs.tabindex, '-1');
  assert.strictEqual(f.focus.scrolled, true);
  assert.ok(f.tree().some((n) => /whole-number enlargement/.test(n.textContent || '')), 'full detail is rendered, not just the short tooltip');
});

t('#106 search clearing, index return and full-reference navigation retain help context', () => {
  const f = setup({ helpId: 'extras.terrain.preview' }); f.open();
  f.input.value = 'wave'; f.input.listeners.input();
  assert.ok(/result/.test(f.heading()));
  f.input.value = ''; f.input.listeners.input();
  assert.strictEqual(f.heading(), 'Terrain Lab');
  f.navigate('#help-index'); assert.strictEqual(f.heading(), 'Help index');
  f.navigate('#help-context');
  assert.strictEqual(f.heading(), 'Terrain Lab');
  assert.strictEqual(f.focus.dataset.helpControl, 'extras.terrain.preview');
  f.navigate('#help-code'); assert.strictEqual(f.heading(), 'Code Editor');
  f.dialog.actions[0].onClick();
  assert.strictEqual(f.fullReference, H.topic('code').legacy, 'full reference follows the topic being read');
  assert.strictEqual(f.dialog.buttons[0].label, 'Close');
});

t('#106 unknown control/subtool falls back safely; explicit links override focused controls', () => {
  const f = setup({ sub: 'unregistered', helpId: 'unknown' }); f.open();
  assert.strictEqual(f.heading(), 'Extra Tools');
  const explicit = setup({ helpId: 'extras.terrain.preview' }); explicit.open({ topic: 'studio.preview' });
  assert.strictEqual(explicit.heading(), 'Pixel Studio');
  assert.strictEqual(explicit.focus.dataset.helpControl, 'studio.preview');
  const unknown = setup({ ws: 'missing', sub: null }); unknown.open();
  assert.strictEqual(unknown.heading(), 'Help index');
});

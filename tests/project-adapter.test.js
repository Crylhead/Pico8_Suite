// #56: "use the active project" adapter (js/project-adapter.js) with fake handles and a minimal DOM stub.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t } = require('./harness.js');
const Ctx = require('../js/project-context-core.js');

const handle = (perm = 'granted') => ({ perm, ask: 'granted', async queryPermission() { return this.perm; }, async requestPermission() { this.perm = this.ask; return this.ask; } });

function load() {
  const listeners = {};
  const mkEl = () => ({ children: [], hidden: false, disabled: false, textContent: '', attrs: {}, listeners: {}, prepend(c) { this.children.unshift(c); }, addEventListener(n, f) { this.listeners[n] = f; }, setAttribute(k, v) { this.attrs[k] = v; } });
  const created = [];
  const el = (tag, props = {}, ...kids) => { const n = Object.assign(mkEl(), props); n.tag = tag; n.kids = kids; created.push(n); return n; };
  const { context, publisher } = Ctx.create();
  const toasts = [];
  const sandbox = {
    window: { P8App: { el, projectContext: context, projectContextPublisher: publisher, toast: (m, k) => toasts.push([m, k]), diagnostics: { report() {} } } },
    document: { addEventListener: (n, f) => { listeners[n] = f; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'project-adapter.js'), 'utf8'), sandbox);
  const host = mkEl();
  return { A: sandbox.window.P8ProjectAdapter, host, publisher, context, toasts, created, listeners };
}
const parts = (created) => ({ text: created.find((n) => n.className === 'project-strip-text'), btn: created.find((n) => n.tag === 'button') });

t('#56 nothing is adopted automatically; the strip says the tool is independent', async () => {
  const x = load();
  let adopted = 0;
  x.A.mount(x.host, { tool: 'Audit', adopt: async () => { adopted++; } });
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: handle() });
  x.listeners['p8:projectcontext']?.();
  const { text, btn } = parts(x.created);
  assert.strictEqual(adopted, 0);
  assert.match(text.textContent, /No project folder open in this tool/);
  assert.strictEqual(btn.hidden, false);
  assert.match(btn.textContent, /Use “demo”/);
});

t('#56 adopting verifies access, calls adopt with the handle and reports the adopted mode', async () => {
  const x = load();
  const h = handle();
  let got = null;
  const link = x.A.mount(x.host, { tool: 'Audit', adopt: async (hh, name) => { got = [hh, name]; return true; } });
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: h });
  link.refresh();
  await parts(x.created).btn.listeners.click();
  assert.deepStrictEqual(got, [h, 'demo']);
  assert.match(parts(x.created).text.textContent, /Working on the active project “demo”/);
  assert.strictEqual(parts(x.created).btn.hidden, true);
});

t('#56 lapsed permission: reconnect first; refusal adopts nothing and explains', async () => {
  const x = load();
  const h = handle('prompt');
  let adopted = 0;
  const link = x.A.mount(x.host, { tool: 'Code Editor', adopt: async () => { adopted++; } });
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: h });
  link.refresh();
  assert.match(parts(x.created).btn.textContent, /Reconnect and use/);
  h.ask = 'denied';
  await parts(x.created).btn.listeners.click();
  assert.strictEqual(adopted, 0);
  assert.strictEqual(x.toasts.length, 1);
  assert.match(x.toasts[0][0], /denied|revoked/i);
  assert.match(parts(x.created).text.textContent, /denied or revoked/);
  assert.strictEqual(parts(x.created).btn.hidden, true);
});

t('#56 a failing adopt keeps the previous mode and reports; an adopt returning false changes nothing', async () => {
  const x = load();
  let mode = 'fail';
  const link = x.A.mount(x.host, { tool: 'Data Carts', adopt: async () => { if (mode === 'fail') throw new Error('read failed'); return false; } });
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: handle() });
  link.refresh();
  await parts(x.created).btn.listeners.click();
  assert.match(x.toasts[0][0], /read failed.*Nothing was changed/);
  mode = 'false';
  await parts(x.created).btn.listeners.click();
  assert.match(parts(x.created).text.textContent, /No project folder open in this tool/);
});

t('#56 own folder picks are independent; stale and name-only projects give actionable text without an action', async () => {
  const x = load();
  const h = handle();
  const link = x.A.mount(x.host, { tool: 'Code Editor', adopt: async () => true });
  link.setMode('independent', 'mine');
  assert.match(parts(x.created).text.textContent, /own folder “mine”/);
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: h });
  h.queryPermission = async () => { throw new Error('gone'); };
  await x.context.check();
  link.refresh();
  assert.match(parts(x.created).text.textContent, /no longer available/);
  assert.strictEqual(parts(x.created).btn.hidden, true);
  await x.publisher.select({ name: 'named', source: 'other' });
  link.refresh();
  assert.match(parts(x.created).text.textContent, /name only/);
});

t('#56 different project handles with the same display name still offer explicit adoption', async () => {
  const x = load();
  const adopted = [];
  const link = x.A.mount(x.host, { tool: 'Audit', adopt: async (h) => { adopted.push(h); return true; } });
  const first = handle(); const second = handle();
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: first });
  await parts(x.created).btn.listeners.click();
  await x.publisher.select({ name: 'demo', source: 'cartbuilder', handle: second });
  link.refresh();
  assert.match(parts(x.created).text.textContent, /previously adopted/);
  assert.strictEqual(parts(x.created).btn.hidden, false);
  await parts(x.created).btn.listeners.click();
  assert.deepStrictEqual(adopted, [first, second]);
});

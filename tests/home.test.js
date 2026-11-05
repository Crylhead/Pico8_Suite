// #68: Home launcher model (js/home-core.js) and registry-driven task metadata.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const H = require('../js/home-core.js');

const tools = [
  { ws: 'studio', name: 'Pixel Studio', tasks: [{ group: 'create', label: 'Draw pixel art' }, { group: 'import', label: 'Import an image' }] },
  { ws: 'code', name: 'Code Editor', tasks: [{ group: 'edit', label: 'Edit code' }] },
  { ws: 'audit', name: 'Project Audit', tasks: [{ group: 'analyze', label: 'Audit a project' }, { group: 'weird', label: 'Fallback task' }, { label: '' }] },
  { ws: 'tiles', name: 'Tile Maker' },
];

t('#68 tasks come from the registered tools, in group order; unknown groups fall back; tools without tasks add nothing', () => {
  const g = H.taskGroups(tools);
  assert.deepStrictEqual(g.map((x) => x.id), ['create', 'edit', 'import', 'analyze']);
  assert.deepStrictEqual(g.find((x) => x.id === 'edit').tasks.map((x) => x.label), ['Edit code', 'Fallback task']);
  assert.strictEqual(g.find((x) => x.id === 'create').tasks[0].ws, 'studio');
  assert.deepStrictEqual(H.taskGroups([{ ws: 'x', name: 'X' }]), []);
});

t('#68 every group in a real registration is known, and the six first-run tasks exist', () => {
  const root = path.join(__dirname, '..', 'js');
  const src = fs.readdirSync(root).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  const labels = [...src.matchAll(/tasks: \[(.*?)\], color/gs)].flatMap((m) => [...m[1].matchAll(/group: '([a-z]+)', label: '([^']+)'/g)].map((x) => ({ group: x[1], label: x[2] })));
  assert.ok(labels.length >= 8, `found ${labels.length}`);
  for (const l of labels) assert.ok(H.GROUPS.some((g) => g.id === l.group), `${l.label}: ${l.group}`);
  const all = labels.map((l) => l.label.toLowerCase()).join('|');
  for (const need of ['pixel art', 'palette', 'terrain', 'code', 'audit', 'pack']) assert.ok(all.includes(need), `no task for "${need}"`);
});

t('#68 continue the last tool only if it still exists and is not Home', () => {
  assert.deepStrictEqual(H.continueEntry('code', tools), { ws: 'code', name: 'Code Editor' });
  assert.strictEqual(H.continueEntry('home', tools), null);
  assert.strictEqual(H.continueEntry('gone', tools), null);
  assert.strictEqual(H.continueEntry(null, tools), null);
});

t('#68 project continuation: each access state has its own safe next step', () => {
  const ws = ['cartbuilder', 'audit'];
  const p = (access) => H.projectEntry({ name: 'demo', source: 'cartbuilder', access }, ws);
  assert.strictEqual(H.projectEntry(null, ws).kind, 'none');
  assert.match(H.projectEntry({ access: 'none' }, ws).text, /No project folder is open/);
  assert.deepStrictEqual([p('granted').kind, p('granted').action, p('granted').ws], ['open', 'open', 'cartbuilder']);
  assert.match(p('granted').text, /Folder-backed.*real files/);
  assert.deepStrictEqual([p('prompt').kind, p('prompt').action], ['reconnect', 'reconnect']);
  assert.match(p('prompt').text, /Nothing is opened until you agree/);
  for (const a of ['denied', 'stale']) { assert.strictEqual(p(a).action, undefined); assert.match(p(a).text, /Open the project again|Choose the project folder again/); }
  assert.strictEqual(p('unsupported').kind, 'name');
  assert.strictEqual(H.projectEntry({ name: 'x', source: 'elsewhere', access: 'granted' }, ws).ws, null);
});

t('#68 storage notice separates browser-only state from files and warns when storage is unavailable', () => {
  assert.strictEqual(H.storageNotice('memory', true).tone, 'warn');
  assert.match(H.storageNotice('memory', false).text, /lost when you close it/);
  const ok = H.storageNotice('indexeddb', false);
  assert.strictEqual(ok.tone, 'info');
  assert.match(ok.text, /this browser only \(not files on disk; nothing saved yet\)/);
  // #193: one line on Home; backing up is the button beside it, project folders are explained in Help
  assert.doesNotMatch(ok.text, /Project folders|Export Library Backup/);
});

t('#68 actual Continue project action rechecks permission before navigating', async () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(__dirname, '../js/suite.js'), 'utf8');
  const code = src.slice(src.indexOf('  function bindHome()'), src.indexOf('  // Palette & Fades integration', src.indexOf('  function bindHome()')));
  const handlers = {}; const opened = []; const warnings = [];
  let access = 'denied'; let checks = 0;
  const x = { $: (id) => ({ addEventListener: (name, f) => { handlers[id] = f; } }),
    document: { addEventListener() {} }, importImageFiles() {}, openLibrary() {}, renderHomeLaunch() {},
    toast: (m) => warnings.push(m),
    App: { projectContext: { async check() { checks++; return { access, message: 'Reconnect first' }; } }, setWorkspace: (ws) => opened.push(ws) } };
  vm.runInNewContext(code, x); x.bindHome();
  const event = { target: { closest: () => ({ dataset: { project: 'open', ws: 'cartbuilder' } }) } };
  await handlers['#homeContinue'](event);
  assert.strictEqual(checks, 1); assert.deepStrictEqual(opened, []); assert.strictEqual(warnings.length, 1);
  access = 'granted'; await handlers['#homeContinue'](event);
  assert.strictEqual(checks, 2); assert.deepStrictEqual(opened, ['cartbuilder']);
});

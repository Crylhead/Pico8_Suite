const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { t } = require('./harness.js');
const P = require('../js/minifier-project-core.js');
const K = require('../js/code-core.js');
const C = require('../js/minifier-core.js');
const A = require('../js/audit-core.js');
const { read, fn } = require('./source-extract.js');
const source = (text, entryPath = 'main.lua') => ({ kind: entryPath.endsWith('.p8') ? 'p8' : 'lua', entryPath, files: [{ path: entryPath, text }] });
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/minifier/project', name), 'utf8');

t('MIN-07 resolves nested/repeated/space/../ and tab sources in order, retaining original bytes', async () => {
  const names = ['main.p8', 'lib/repeat.lua', 'sub/nested.lua', 'shared space.lua', 'code tabs.p8'];
  const reads = [];
  const p = await P.resolve(source(fixture('main.p8'), 'main.p8'), { names, read: async (name) => { reads.push(name); return fixture(name); } });
  assert.deepStrictEqual(reads, names.slice(1)); assert.strictEqual(p.source.files.length, 5);
  assert.deepStrictEqual(p.edges.map((e) => e.target), ['lib/repeat.lua', 'sub/nested.lua', 'shared space.lua', 'lib/repeat.lua', 'code tabs.p8']);
  assert.strictEqual(p.edges.at(-1).tab, 1); assert.ok(p.buildCopy);
  assert.ok(p.source.files.find((f) => f.path === 'shared space.lua').text.endsWith('\r\n'));
  assert.match(p.source.files[0].text, /version 42\r\n/); assert.ok(p.diagnostics.some((d) => d.code === 'W_BUILD_DIRECTIVE'));
  assert.ok(Object.isFrozen(p.source.files[0])); assert.ok(Object.isFrozen(p.edges));
});

t('MIN-07 rejects missing, denied, ambiguous, cyclic and mismatched engine semantics with a chain', async () => {
  const reject = async (text, files, code, entry = 'main.lua') => {
    const map = new Map(Object.entries(files));
    await assert.rejects(P.resolve(source(text, entry), { names: [...map.keys()], read: async (name) => map.get(name) }), (e) => e.code === code && e.message.length > 20);
  };
  await reject('#include missing.lua', {}, 'E_INCLUDE_MISSING');
  await reject('#include lib.lua', { 'lib.lua': null }, 'E_INCLUDE_READ');
  await reject('#include lib.lua', { 'lib.lua': '', 'LIB.lua': '' }, 'E_INCLUDE_AMBIGUOUS');
  await reject('#include a.lua', { 'a.lua': '#include main.lua' }, 'E_INCLUDE_CYCLE');
  await reject('#include ../outside.lua', {}, 'E_INCLUDE_PATH');
  await reject('#include "space name.lua"', { 'space name.lua': 'cls()' }, 'E_INCLUDE_PATH');
  await reject('#include x.lua', { 'x.lua': 'cls()' }, 'E_INCLUDE_SEMANTICS', 'sub/main.lua');
  await reject('#include LIB.lua', { 'lib.lua': 'cls()' }, 'E_INCLUDE_SEMANTICS');
  await reject('#include code tabs.p8:9', { 'code tabs.p8': fixture('code tabs.p8') }, 'E_INCLUDE_TAB');
  await reject('#include tabs.p8:1', { 'tabs.p8': K.NEW_CART + '#include lib.lua\n-->8\ncls()\n', 'lib.lua': 'cls()' }, 'E_INCLUDE_SEMANTICS');
  for (const name of ['/absolute.lua', 'C:/drive.lua', 'a\\b.lua', 'lib', 'file.p8:a', 'foo.lua -- comment']) await reject('#include ' + name, {}, 'E_INCLUDE_PATH');
  for (const text of ['#compile test', '#include', '--$unknown:foo\ncls()']) await reject(text, {}, text.startsWith('--') ? 'E_TRANSFORM_UNSUPPORTED' : 'E_DIRECTIVE_UNSUPPORTED');
  const ignored = await P.resolve(source('local s=[=[\n#include missing.lua\n]=]\n-- #include absent.lua\nprint(s)'));
  assert.strictEqual(ignored.edges.length, 0);
});

t('MIN-07 delayed reads are abandoned when editor changes, and empty dependencies are valid', async () => {
  let finish, current = true;
  const pending = P.resolve(source('#include lib.lua'), { names: ['lib.lua'], live: () => current, read: () => new Promise((r) => { finish = r; }) });
  await Promise.resolve(); current = false; finish('cls()');
  await assert.rejects(pending, (e) => e.code === 'E_STALE');
  const empty = await P.resolve(source('#include empty.lua\ncls()'), { names: ['empty.lua'], read: async () => '' });
  assert.strictEqual(empty.source.files.length, 2);
});

t('MIN-07 actual Code Editor project reader checks granted handles, never asks or rescans, rejects stale reads', async () => {
  const script = read('js/code.js');
  const start = script.indexOf('  const sourceBridge = K.createSourceBridge('), end = script.indexOf('\n  S.codeSource =', start);
  let grants = true, held = null, reads = 0;
  const forbidden = () => { throw Error('no prompt, write, run or scan'); };
  const handle = { queryPermission: async () => grants ? 'granted' : 'denied', requestPermission: forbidden, createWritable: forbidden,
    getFile: async () => { reads++; if (held) await held; return { arrayBuffer: async () => new TextEncoder().encode('print("♥")\r\n') }; } };
  const ed = { doc: {}, loc: {}, name: 'main.lua', parts: K.splitCart(''), text: '#include lib.lua', savedLua: '', rel: 'main.lua', folder: { name: 'demo', entries: forbidden }, folderReady: true, sourceIndex: { ready: true, files: new Map([['lib.lua', handle]]) } };
  const ctx = vm.createContext({ K, P8MinifierCore: C, P8MinifierProject: P, ed, sourceRestoring: false, dom: { ta: { value: ed.text, focus() {} } } });
  vm.runInContext(script.slice(start, end) + '\nthis.bridge = sourceBridge;', ctx);
  const snap = ctx.bridge.getSnapshot(), project = await ctx.bridge.getProjectSnapshot(snap);
  assert.strictEqual(project.source.files[1].text, 'print("♥")\r\n'); assert.strictEqual(reads, 1);
  grants = false; await assert.rejects(ctx.bridge.getProjectSnapshot(snap), (e) => e.code === 'E_INCLUDE_READ'); assert.strictEqual(reads, 1);
  grants = true; let release; held = new Promise((r) => { release = r; });
  const pending = ctx.bridge.getProjectSnapshot(snap); await new Promise(setImmediate);
  ed.folder = { name: 'different' }; release(); await assert.rejects(pending, (e) => e.code === 'E_STALE');
});

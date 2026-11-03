// #111: About consumes the live registry, including subtools/extensions, instead of a stale feature list.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');

t('#111 About reflects tool additions and renames on each open using text nodes', () => {
  const tools = [{ ws: 'code', name: 'Code Editor' }, { ws: 'extras', sub: 'terrain', name: 'Terrain Lab' }];
  let dialog;
  const ctx = vm.createContext({
    window: { Suite: { tools: () => tools.slice() } }, VERSION: 'test-version',
    el: (tag, props, ...children) => ({ tag, ...props, children }),
    modal: (options) => { dialog = options; },
  });
  vm.runInContext(fn(read('js/app.js'), 'showAbout'), ctx);
  const list = () => dialog.body.children.find((node) => node.tag === 'ul').children;
  ctx.showAbout();
  assert.strictEqual(dialog.title, 'About PICO-8 Suite');
  assert.deepStrictEqual(Array.from(list(), (node) => node.textContent), ['Code Editor', 'Terrain Lab']);
  assert.ok(JSON.stringify(dialog.body).includes('test-version'));

  tools[0].name = 'Renamed editor';
  tools.push({ ws: 'extras', sub: 'plugin', name: '<img src=x onerror=alert(1)>' });
  ctx.showAbout();
  assert.deepStrictEqual(Array.from(list(), (node) => node.textContent), ['Renamed editor', 'Terrain Lab', '<img src=x onerror=alert(1)>']);
  assert.ok(list().every((node) => !('innerHTML' in node)), 'registered names stay literal text');
});

// #66: Cart Builder's Commit stage is "done" only when the arrangement matches the manifest on disk.
// Runs the actual renderStages, layoutSig, diskSig and placed from js/project.js with the real
// P8Preflight core; the DOM is replaced by plain objects.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn, line } = require('./source-extract.js');

function setup(pjState) {
  const ctx = vm.createContext({ pjState });
  vm.runInContext(read('js/preflight-core.js'), ctx, { filename: 'js/preflight-core.js' });
  const src = read('js/project.js');
  vm.runInContext(`
    const pj = { root: {}, project: null, parts: [], layout: [], dirtyAssets: new Set(), dirtyTexts: new Set(), writtenSig: null, lastWrite: '', ...pjState };
    const P = { checkAnchors: () => ({ errors: [], warnings: [] }) };
    const anchorFiles = () => [];
    const el = (tag, props = {}, ...kids) => ({ tag, ...props, kids });
    const dom = { stages: { replaceChildren: (...items) => { dom.items = items; } } };
    ${line(src, 'const placed = ')}
    ${line(src, 'const layoutSig = ')}
    ${line(src, 'const diskSig = ', { optional: true })}
    ${fn(src, 'renderStages')}
    const commit = () => { renderStages(); const li = dom.items[3]; return { status: li.className.replace('cb-stage cb-stage-', ''), detail: li.kids[3].textContent }; };
    this.env = { pj, commit };
  `, ctx, { filename: 'cartbuilder-stages-glue.js' });
  return ctx.env;
}

const part = { ref: 'main_atlas.bin', bytes: new Uint8Array(0x200) };

t('#66 right after adoption the auto-packed carts are not shown as committed', () => {
  // adoption wrote suite.json with no carts; auto-pack then arranged d0.p8 in memory only
  const env = setup({ project: { carts: [] }, parts: [part], layout: [{ name: 'd0.p8', items: [{ ref: 'main_atlas.bin' }] }] });
  const c = env.commit();
  assert.strictEqual(c.status, 'current');
  assert.match(c.detail, /Unwritten changes/);
});

t('#66 a project loaded from disk matches its manifest; a changed arrangement needs a write', () => {
  const carts = [{ name: 'd0.p8', items: [{ ref: 'main_atlas.bin', off: 0, len: 0x200 }] }];
  const env = setup({ project: { carts }, parts: [part], layout: [{ name: 'd0.p8', items: [{ ref: 'main_atlas.bin' }] }] });
  assert.deepStrictEqual([env.commit().status, env.commit().detail], ['done', 'Matches the files on disk.']);
  env.pj.layout[0].name = 'd1.p8';
  assert.strictEqual(env.commit().status, 'current', 'an arrangement that differs from disk needs a write');
});

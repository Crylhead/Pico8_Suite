// #61: tour engine, versioning and registry/target drift (js/tours-core.js, js/tours-data.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const Core = require('../js/tours-core.js');
const Data = require('../js/tours-data.js');
const Help = require('../js/help-core.js');

const memStorage = (init = {}) => {
  const d = new Map(Object.entries(init));
  return { d, fail: false, getItem(k) { return d.has(k) ? d.get(k) : null; }, setItem(k, v) { if (this.fail) throw new Error('quota'); d.set(k, v); }, removeItem(k) { d.delete(k); } };
};
const fixture = (major = 1) => ({ id: 'fx', title: 'Fixture', major, steps: [{ id: 'a', title: 'A', text: 'a' }, { id: 'b', target: '#b', title: 'B', text: 'b' }, { id: 'c', target: '#c', title: 'C', text: 'c' }] });

t('#61 steps resolve lazily; a missing target is skipped, not fatal', async () => {
  const eng = Core.create();
  assert.ok(eng.register(fixture()).ok);
  const run = eng.run('fx', async (s) => (s.id === 'b' ? null : { el: s.id }));
  assert.strictEqual((await run.start()).step.id, 'a');
  assert.strictEqual((await run.next()).step.id, 'c'); // b skipped
  assert.deepStrictEqual(run.state.skipped, ['b']);
  assert.strictEqual((await run.back()).step.id, 'a');
  await run.next(); const end = await run.next();
  assert.strictEqual(end.status, 'done');
});

t('#61 a tour whose targets are all gone never shows a step; prepare errors count as missing', async () => {
  const eng = Core.create();
  eng.register(fixture());
  const run = eng.run('fx', async () => { throw new Error('dom gone'); });
  const s = await run.start();
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.shown, 0);
});

t('#61 a tour that showed no step is not recorded as done or skipped', async () => {
  const eng = Core.create();
  eng.register(fixture());
  const run = eng.run('fx', async () => null);
  await run.start();
  run.finish();
  assert.strictEqual(eng.progress('fx'), null);
});

t('#61 abort stops the run without recording completion; finish records skipped or done', async () => {
  const st = memStorage();
  const eng = Core.create({ storage: st });
  eng.register(fixture());
  const r1 = eng.run('fx', async () => ({}));
  await r1.start(); r1.abort(); r1.finish();
  assert.strictEqual(eng.progress('fx').status, 'skipped');
  const r2 = eng.run('fx', async () => ({}));
  await r2.start(); await r2.next(); await r2.next(); await r2.next();
  r2.finish();
  assert.deepStrictEqual(eng.progress('fx'), { status: 'done', major: 1 });
  assert.ok(JSON.parse(st.d.get(Core.KEY)).tours.fx);
});

t('#61 welcome is offered once, only with auto-offer on, never while busy, never after "never"', () => {
  const st = memStorage();
  const eng = Core.create({ storage: st });
  assert.ok(eng.shouldOfferWelcome({ autoOffer: true }));
  assert.ok(!eng.shouldOfferWelcome({ autoOffer: false }));
  assert.ok(!eng.shouldOfferWelcome({ autoOffer: true, busy: true }));
  eng.setWelcome('skipped');
  assert.ok(!Core.create({ storage: st }).shouldOfferWelcome({ autoOffer: true }));
  assert.throws(() => eng.setWelcome('bogus'), TypeError);
});

t('#61 versioning: copy edits keep progress; a new major offers What\'s new without resetting', async () => {
  const st = memStorage();
  const a = Core.create({ storage: st });
  a.register(fixture(1)); const ra = a.run('fx', async () => ({})); await ra.start(); ra.finish();
  const b = Core.create({ storage: st });
  b.register({ ...fixture(1), title: 'Reworded' });
  assert.ok(!b.whatsNew('fx'));
  assert.strictEqual(b.progress('fx').status, 'skipped');
  const c = Core.create({ storage: st });
  c.register(fixture(2));
  assert.ok(c.whatsNew('fx'));
  assert.strictEqual(c.progress('fx').major, 1); // still honored
});

t('#61 corrupt or unavailable storage falls back to safe defaults and never throws', () => {
  const bad = Core.create({ storage: memStorage({ [Core.KEY]: '{not json' }) });
  assert.strictEqual(bad.welcome(), 'pending');
  const junk = Core.create({ storage: memStorage({ [Core.KEY]: JSON.stringify({ welcome: 5, tours: { x: { status: 'zzz', major: 'a' } } }) }) });
  assert.strictEqual(junk.welcome(), 'pending');
  assert.strictEqual(junk.progress('x'), null);
  const st = memStorage(); st.fail = true;
  const eng = Core.create({ storage: st });
  eng.register(fixture());
  assert.doesNotThrow(() => eng.setWelcome('never'));
  assert.strictEqual(eng.welcome(), 'never');
  assert.strictEqual(eng.persistent(), false);
});

t('#61 invalid tour metadata is reported, not thrown; registration of others still works', () => {
  const eng = Core.create();
  assert.ok(!eng.register({ id: 'bad', title: 'x', major: 1, steps: [{ id: 's', title: 's', text: 't', target: 'li:nth-child(2)' }] }).ok);
  assert.ok(!eng.register({ id: 'dup', title: 'x', major: 1, steps: [{ id: 's', title: 's', text: 't' }, { id: 's', title: 's', text: 't' }] }).ok);
  assert.ok(!eng.register(null).ok);
  assert.ok(eng.register(fixture()).ok);
});

t('#61 built-in tours are valid and every target and helpId exists (drift check)', () => {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const src = fs.readdirSync(path.join(root, 'js')).filter((f) => f.endsWith('.js') && !f.startsWith('tours')).map((f) => fs.readFileSync(path.join(root, 'js', f), 'utf8')).join('\n');
  const known = (token) => html.includes(token) || src.includes(token);
  const ids = new Set();
  for (const tour of Data.TOURS) {
    assert.deepStrictEqual(Core.validate(tour), [], tour.id);
    assert.ok(!ids.has(tour.id)); ids.add(tour.id);
    for (const s of tour.steps) {
      if (s.helpId) assert.ok(Help.control(s.helpId), `${tour.id}/${s.id}: helpId ${s.helpId}`);
      for (const sel of [s.target, s.before && s.before.click].filter(Boolean)) {
        for (const m of sel.matchAll(/#([\w-]+)/g)) assert.ok(html.includes(`id="${m[1]}"`), `${tour.id}/${s.id}: #${m[1]}`);
        for (const m of sel.matchAll(/\.([\w-]+)/g)) assert.ok(known(m[1]), `${tour.id}/${s.id}: .${m[1]}`);
        for (const m of sel.matchAll(/data-help-id="([^"]+)"/g)) assert.ok(html.includes(`data-help-id="${m[1]}"`), `${tour.id}/${s.id}: ${m[1]}`);
      }
      if (s.before && s.before.ws) assert.ok(html.includes(`data-value="${s.before.ws}"`), `${tour.id}/${s.id}: ws ${s.before.ws}`);
    }
  }
});

t('#61 registry-backed tour steps have text with ordinary classic-script globals', () => {
  const fs = require('fs'); const path = require('path'); const vm = require('vm');
  const source = fs.readFileSync(path.join(__dirname, '../js/tours.js'), 'utf8');
  const body = source.slice(source.indexOf('  const stepText ='), source.indexOf('  /** applies the step'));
  const sandbox = { window: {}, P8Help: require('../js/help-core.js') };
  vm.runInNewContext(`${body}\nresult = stepText({helpId: 'studio.transparent'});`, sandbox);
  assert.ok(sandbox.result.length > 10, 'const P8Help is not a window property');
});

t('#61 closing during asynchronous target preparation cannot resurrect the tour', async () => {
  let release;
  const engine = require('../js/tours-core.js').create();
  engine.register({ id: 'slow', title: 'Slow', major: 1, steps: [{ id: 's', title: 'Step', text: 'Test' }] });
  const run = engine.run('slow', () => new Promise((resolve) => { release = resolve; }));
  const pending = run.start();
  run.abort(); release({ el: null }); await pending;
  assert.strictEqual(run.state.status, 'aborted');
  assert.strictEqual(run.state.shown, 0);
});

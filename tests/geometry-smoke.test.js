const assert = require('assert');
const { t } = require('./harness.js');

const box = (x = 0, y = 0, width = 30, height = 30) => ({ x, y, width, height });
function sample(ws = 'home', cycle = 0) {
  const ceiling = { home: 1240, palette: 1640 }[ws], width = Math.min(1265, ceiling || Infinity), x = (1265 - width) / 2;
  const chrome = Object.fromEntries(['header', 'brand', 'nav', 'find', 'library', 'theme', 'menus'].map(n => [n, box()]));
  chrome.header = box(0, 0, 1265, 82);
  return { scenario: '1280', theme: 'light', project: 'none', cycle, ws, viewport: { width: 1280, height: 900 }, contentWidth: 1265,
    main: box(x, 82, width, 818), firstRail: x + 16, padding: [16, 16, 16, 16], gap: ceiling ? 16 : 10, pageWidth: 1280,
    host: box(0,82,1280,818), rootY:0, scrolledRootY:0, rootHeight:900, hostScrollWidth:1265, chrome, scrolledChrome: structuredClone(chrome), rows: ['command', 'heading', 'status'].map(role => ({ role, rect: box(16, 98, 100, 28) })), stages: [{ rect: box(16, 150, 400, 500) }], canvases: [{ rect: box(16, 150, 128, 128) }],
  };
}

t('#171 geometry permits documented width tiers and different tool row sizes without a browser dependency', async () => {
  const { checkGeometry } = await import('./geometry-smoke.mjs');
  const rows = [sample('home'), sample('studio'), sample('palette')];
  rows[1].rows[0].rect.height = 80; // Studio's expanded command rows are intentional.
  assert.deepStrictEqual(checkGeometry(rows), []);
  assert.ok(checkGeometry([]).some(s => s.includes('No geometry samples')));
});

t('#171 geometry detects moved navigation, wrong rails, overflow, missing controls and return-visit row jitter', async () => {
  const { checkGeometry } = await import('./geometry-smoke.mjs');
  const first = sample('studio'), second = sample('studio', 1);
  second.chrome.find.x += 20;
  second.scrolledChrome.find.x += 20;
  second.main.width -= 100;
  second.pageWidth = 1400;
  second.rows[0].rect.height += 10;
  second.rows = second.rows.filter(n => n.role !== 'status');
  const result = checkGeometry([first, second]).join('\n');
  for (const message of ['find.x moved', 'width/centering', 'Horizontal page overflow', 'Missing measurable status', 'return visit']) assert.ok(result.includes(message), message);
});

t('#171 saved baseline detects consistent bar/canvas changes and incomplete matrix coverage', async () => {
  const { compareBaseline } = await import('./geometry-smoke.mjs');
  const baseline = [sample('studio'), sample('home')], current = structuredClone(baseline);
  assert.deepStrictEqual(compareBaseline(current, baseline), []);
  current[0].rows[0].rect.height += 4;
  current[0].canvases[0].rect.width -= 16;
  current.pop();
  const failures = compareBaseline(current, baseline).join('\n');
  assert.match(failures, /rows differ/);
  assert.match(failures, /canvases differ/);
  assert.match(failures, /case was not captured/);
  assert.match(compareBaseline(baseline, current).join('\n'), /missing baseline case/);
});

t('#180 geometry rejects document scrolling and an outer scrollbar crossing the app header', async () => {
 const {checkGeometry} = await import('./geometry-smoke.mjs');
 const row=sample(); row.host.y=0; row.rootHeight=1800; row.scrolledRootY=500;
 const failures=checkGeometry([row]).join('\n');
 assert.match(failures,/below the header/); assert.match(failures,/Document scrolling/);
});

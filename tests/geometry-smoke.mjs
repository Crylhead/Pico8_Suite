// Opt-in browser check; no browser dependency is imported by the normal regression suite.
// Usage and manual fallback: docs/GEOMETRY_SMOKE.md.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MODES = Object.freeze({ home: 1240, data: 1240, palette: 1640, tiles: 1640,
  studio: null, map: null, code: null, minifier: null, cartbuilder: null, datacarts: null, audit: null, extras: null });
export const SCENARIOS = Object.freeze([
  { id: '360', width: 360, height: 900, scale: 1 },
  { id: '768', width: 768, height: 900, scale: 1 },
  { id: '1280', width: 1280, height: 900, scale: 1 },
  { id: '1920', width: 1920, height: 900, scale: 1 },
  { id: '200-equivalent', width: 640, height: 450, scale: 2 },
]);
const CHROME = ['header', 'brand', 'nav', 'find', 'library', 'theme', 'menus'];
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 0.5;

/** Validate measured rectangles, independently of CSS class names or screenshot pixels. */
export function checkGeometry(rows) {
  const failures = [], chromeRefs = new Map(), repeatRefs = new Map();
  const fail = (r, message) => failures.push(`${r.scenario}/${r.theme}/${r.project}/${r.ws}${r.sub ? '/' + r.sub : ''}/cycle${r.cycle}: ${message}`);
  if (!rows.length) return ['No geometry samples were captured'];
  for (const r of rows) {
    if (!Object.hasOwn(MODES, r.ws)) { fail(r, 'Unknown workspace; extend the documented contract'); continue; }
    const ceiling = MODES[r.ws], expected = Math.min(r.contentWidth, ceiling ?? Infinity);
    if (!close(r.main.width, expected) || !close(r.main.x, (r.contentWidth - expected) / 2)) fail(r, 'Workspace width/centering differs from its geometry mode');
    if (!close(r.main.y, r.chrome.header.y + r.chrome.header.height)) fail(r, 'Content top differs from header bottom');
    if (!r.padding.every(v => close(v, 16)) || !close(r.gap, ceiling ? 16 : 10)) fail(r, 'Shared gutter/gap differs from the geometry contract');
    if (!close(r.firstRail, r.main.x + 16)) fail(r, 'Major content does not start on the shared rail');
    if (r.pageWidth > r.viewport.width + 1) fail(r, 'Horizontal page overflow');
    const required = r.ws === 'home' ? [] : ['palette', 'data'].includes(r.ws) ? ['heading'] : ['command'];
    if (['studio', 'map', 'code'].includes(r.ws) || r.sub === 'terrain') required.push('status');
    for (const role of required) if (!r.rows.some(n => n.role === role && n.rect.width > 0 && n.rect.height > 0)) fail(r, `Missing measurable ${role} row`);
    const key = `${r.scenario}/${r.theme}`, reference = chromeRefs.get(key) || r.chrome;
    chromeRefs.set(key, reference);
    for (const name of CHROME) {
      const rect = r.chrome[name];
      if (name !== 'nav' || r.viewport.width > 640) {
        if (!(rect.width > 0 && rect.height > 0)) fail(r, `${name} is missing or has no area`);
      }
      for (const field of ['x', 'y', 'width', 'height']) {
        if (!close(rect[field], reference[name][field])) fail(r, `${name}.${field} moved across tool/project switches`);
        if (!close(r.scrolledChrome[name][field], rect[field])) fail(r, `${name}.${field} moved on page scroll`);
      }
    }
    const repeatKey = `${key}/${r.project}/${r.ws}/${r.sub || ''}`;
    const previous = repeatRefs.get(repeatKey);
    if (previous && (previous.rows.length !== r.rows.length || r.rows.some((n, i) => n.role !== previous.rows[i].role || !close(n.rect.height, previous.rows[i].rect.height)))) fail(r, 'Command/header/status heights changed on the return visit');
    repeatRefs.set(repeatKey, r);
  }
  return failures;
}

const sampleKey = r => [r.scenario, r.theme, r.project, r.ws, r.sub || '', r.cycle].join('/');

/** An explicit baseline catches consistent cross-revision changes, not just within-run jumps. */
export function compareBaseline(rows, baseline) {
  const previous = new Map(baseline.map(r => [sampleKey(r), r])), failures = [];
  for (const r of rows) {
    const key = sampleKey(r), old = previous.get(key);
    if (!old) { failures.push(`${key}: missing baseline case`); continue; }
    previous.delete(key);
    const groups = [['chrome', CHROME.map(n => r.chrome[n]), CHROME.map(n => old.chrome[n])],
      ['rows', r.rows.map(n => n.rect), old.rows.map(n => n.rect)],
      ['stages', r.stages.map(n => n.rect), old.stages.map(n => n.rect)],
      ['canvases', r.canvases.map(n => n.rect), old.canvases.map(n => n.rect)]];
    for (const [name, current, before] of groups) {
      if (current.length !== before.length || current.some((rect, i) => ['x', 'y', 'width', 'height'].some(field => !close(rect[field], before[i][field])))) failures.push(`${key}: ${name} differ from saved baseline`);
    }
  }
  for (const key of previous.keys()) failures.push(`${key}: baseline case was not captured`);
  return failures;
}

// Runs inside the tested page; selectors identify roles without imposing equal tool heights.
export function measurePage() {
  const rect = n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const visible = n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden';
  const chrome = Object.fromEntries(Object.entries({ header: '.appbar', brand: '.brand', nav: '#wsTabs', find: '#wsFind', library: '#libraryBtn', theme: '#themeToggle', menus: '.appbar-menus' }).map(([key, selector]) => [key, rect(document.querySelector(selector))]));
  const main = document.querySelector(`main[data-ws="${document.body.dataset.workspace}"]`), style = getComputedStyle(main);
  const collect = (selector, role) => [...main.querySelectorAll(selector)].filter(visible).map(n => ({ role, id: n.id || n.className, rect: rect(n), scrollWidth: n.scrollWidth, clientWidth: n.clientWidth }));
  return { viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio }, contentWidth: document.body.clientWidth,
    chrome, main: rect(main), padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(parseFloat), gap: parseFloat(style.gap),
    firstRail: Math.min(...[...main.children].filter(n => visible(n) && getComputedStyle(n).position !== 'absolute').map(n => rect(n).x)),
    pageWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), scrollHeight: document.documentElement.scrollHeight,
    rows: [...collect('.command-row, .ps-options, .ps-options-row, .ce-bar, .mn-command, .au-top, .dc-top, .ex-head, .tm-bar', 'command'), ...collect('.card-head, .ps-panel-head, .mn-heading-row', 'heading'), ...collect('.ps-status, .tl-statusbar, .status-line, #mnStatus', 'status')],
    stages: collect('.ps-stage, .ce-editor, .ex-stage, .tl-stage, .au-main, .dc-main', 'stage'),
    canvases: [...main.querySelectorAll('canvas')].filter(visible).map(n => { const r = n.getBoundingClientRect(); return { id: n.id, bitmap: [n.width, n.height], rect: rect(n), visibleArea: Math.max(0, Math.min(r.right, innerWidth) - Math.max(0, r.left)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(0, r.top)) }; }),
  };
}

export async function serve(root) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    try {
      const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end('Not found'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/index.html` };
}

async function bounded(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture setup timed out; check for an unexpected prompt')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

export async function fixture(page) {
  await page.waitForFunction(() => window.P8App && window.Suite?.minifier && window.P8StudioDebug);
  await bounded(page.evaluate(async () => {
    P8App.setWorkspace('code', { persist: false });
    const dt = new DataTransfer();
    dt.items.add(new File(['function _draw()\n cls()\n print("geometry fixture",8,8,7)\nend\n'], 'geometry_fixture_with_a_long_filename_for_the_code_editor.lua', { type: 'text/plain' }));
    document.querySelector('#ceText').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    const image = new ImageData(128, 128);
    for (let i = 0; i < image.data.length; i += 4) { image.data[i] = (i / 4 % 128) * 2; image.data[i + 2] = 255; image.data[i + 3] = 255; }
    if (!await Suite.openIn('studio-open', Suite.assetFromImageData(image, 'geometry_image_with_a_long_name.png'), { saved: false })) throw Error('Studio fixture did not load');
    await Suite.minifier.load({ kind: 'lua', entryPath: 'geometry_fixture_with_a_long_filename.lua', files: [{ path: 'geometry_fixture_with_a_long_filename.lua', text: 'print("geometry")' }] });
  }), 30000);
  await page.waitForFunction(() => document.querySelector('#ceFile').textContent.startsWith('geometry_fixture_'));
  return page.evaluate(() => JSON.stringify({ code: document.querySelector('#ceText').value, studio: P8StudioDebug.state().doc, minifier: Suite.minifier.getInput().source }));
}

export async function run() {
  if (process.argv.includes('--help')) {
    console.log('Opt-in geometry smoke: node tests/geometry-smoke.mjs [--out DIRECTORY] [--baseline geometry.json] [--screenshots]\nUses an already available Playwright module/browser; see docs/GEOMETRY_SMOKE.md.');
    return;
  }
  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require(process.env.P8_GEOMETRY_PLAYWRIGHT || 'playwright'); }
  catch { throw Error('Playwright is not available. Set P8_GEOMETRY_PLAYWRIGHT to an existing module path, or use the manual checklist in docs/GEOMETRY_SMOKE.md. Nothing was installed.'); }
  const outIndex = process.argv.indexOf('--out');
  if (outIndex >= 0 && (!process.argv[outIndex + 1] || process.argv[outIndex + 1].startsWith('--'))) throw Error('--out requires a directory');
  const out = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : await fs.mkdtemp(path.join(os.tmpdir(), 'p8-geometry-'));
  const baselineIndex = process.argv.indexOf('--baseline');
  let baseline;
  if (baselineIndex >= 0) {
    if (!process.argv[baselineIndex + 1] || process.argv[baselineIndex + 1].startsWith('--')) throw Error('--baseline requires a geometry.json file');
    const baselinePath = path.resolve(process.argv[baselineIndex + 1]);
    if (baselinePath === path.join(out, 'geometry.json')) throw Error('Use separate baseline and output directories');
    baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    if (baseline.version !== 1 || !Array.isArray(baseline.rows) || !baseline.rows.length || baseline.failures?.length) throw Error('Baseline must be a successful version 1 geometry report');
  }
  await fs.mkdir(out, { recursive: true });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { server, url } = await serve(root);
  let browser;
  const report = { version: 1, created: new Date().toISOString(), scenarios: SCENARIOS, rows: [], errors: [], failures: [], notes: ['200% case emulates reflow and pixel density, not physical browser zoom.', 'Command/status role heights follow the shared bar contract; expanded tool rows remain intentional.'] };
  try { report.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { report.commit = null; }
  try {
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.P8_GEOMETRY_BROWSER_EXECUTABLE ? { executablePath: process.env.P8_GEOMETRY_BROWSER_EXECUTABLE } : {}), args: JSON.parse(process.env.P8_GEOMETRY_BROWSER_ARGS || '[]') });
    report.browser = browser.version();
    for (const scale of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', err => report.errors.push(err.message));
      await page.addInitScript(() => localStorage.setItem('p8suite.uxPrefs', JSON.stringify({ version: 1, autoOfferTours: false, helpLevel: 'off' })));
      await page.goto(url);
      const source = await fixture(page);
      const contexts = await page.evaluate(() => [...document.querySelectorAll('main[data-ws]')].flatMap(n => n.dataset.ws === 'extras' ? [...document.querySelectorAll('#exTabs [data-value]')].map(b => ({ ws: 'extras', sub: b.dataset.value })) : [{ ws: n.dataset.ws }]));
      const missing = Object.keys(MODES).filter(ws => !contexts.some(c => c.ws === ws));
      if (missing.length || !contexts.some(c => c.sub === 'terrain')) throw Error('Missing built-in coverage: ' + missing.join(', ') + '; Terrain required');
      for (const scenario of SCENARIOS.filter(s => s.scale === scale)) {
        await page.setViewportSize({ width: scenario.width, height: scenario.height });
        for (const theme of ['light', 'dark']) for (const project of ['none', 'long']) {
          await page.evaluate(async ({ theme, project }) => {
            document.documentElement.dataset.theme = theme;
            if (project === 'none') await P8App.projectContextPublisher.clear();
            else await P8App.projectContextPublisher.select({ name: 'geometry_project_with_a_long_name_and_access_context', source: 'code' });
          }, { theme, project });
          for (const cycle of [0, 1]) for (const view of (cycle ? contexts.slice().reverse() : contexts)) {
            await page.evaluate(view => { P8App.setWorkspace(view.ws, { persist: false }); if (view.sub) document.querySelector(`#exTabs [data-value="${view.sub}"]`).click(); scrollTo(0, 0); }, view);
            if (view.ws === 'minifier') await page.waitForFunction(() => Suite.minifier.getState().enginePhase !== 'loading', null, { timeout: 30000 });
            // Let resize observers and responsive tool rendering settle before measuring.
            await page.waitForTimeout(150);
            const measured = await page.evaluate(measurePage);
            await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
            const scrolled = await page.evaluate(measurePage);
            const scrolledY = await page.evaluate(() => scrollY);
            await page.evaluate(() => scrollTo(0, 0));
            report.rows.push({ scenario: scenario.id, theme, project, cycle, ...view, ...measured, scrolledChrome: scrolled.chrome, scrolledY });
            if (process.argv.includes('--screenshots') && scenario.id === '1280' && project === 'long' && cycle === 0) await page.screenshot({ path: path.join(out, `${theme}-${view.ws}-${view.sub || 'main'}.png`) });
          }
        }
        console.log(`Captured ${scenario.id}: both themes, project states and return visits`);
      }
      const unchanged = await page.evaluate(() => JSON.stringify({ code: document.querySelector('#ceText').value, studio: P8StudioDebug.state().doc, minifier: Suite.minifier.getInput().source }));
      if (source !== unchanged) report.failures.push('Workspace switching changed a fixture document');
      report.notes.push(`Scale ${scale}: Minifier engine phase ${await page.evaluate(() => Suite.minifier.getState().enginePhase)} (layout check only).`);
      await context.close();
    }
    report.failures.push(...checkGeometry(report.rows), ...report.errors.map(e => 'Page error: ' + e));
    if (baseline) report.failures.push(...compareBaseline(report.rows, baseline.rows));
  } catch (err) { report.failures.push(err.stack || String(err)); }
  finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    await fs.writeFile(path.join(out, 'geometry.json'), JSON.stringify(report, null, 2));
  }
  console.log(`${report.rows.length} cases; ${report.failures.length} failures. Report: ${path.join(out, 'geometry.json')}`);
  if (report.failures.length) { console.error(report.failures.slice(0, 12).join('\n')); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) run().catch(err => { console.error(err.message); process.exitCode = 1; });

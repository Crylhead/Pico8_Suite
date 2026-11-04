// Opt-in #170 audit. Uses the same existing browser setup/isolated fixtures as geometry-smoke.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { serve, fixture, measurePage } from './geometry-smoke.mjs';

const panels = [
  { ws: 'studio', layout: '.layout-studio', side: '.ps-side', center: '.ps-main', breakpoint: 860, defaultWidth: 272 },
  { ws: 'map', layout: '.layout-map', side: '.ps-side', center: '.ps-main', breakpoint: 900, defaultWidth: 290 },
  { ws: 'extras', sub: 'terrain', layout: '.tl-split', side: '.ex-controls', center: '.tl-stage', breakpoint: 1000, defaultWidth: 380 },
];
const views = [{ ws: 'studio' }, { ws: 'map' }, { ws: 'code' }, { ws: 'minifier' }, { ws: 'audit' }, { ws: 'cartbuilder' }, { ws: 'datacarts' }, { ws: 'extras', sub: 'terrain' }];
const widths = [...new Set([320, 360, 768, 1280, ...[640, 699, 860, 900, 1000, 1100, 1200].flatMap(w => [w - 1, w, w + 1])])].sort((a, b) => a - b);
const breakpoint = { studio: 860, map: 900, code: 900, minifier: 699, audit: 1000, cartbuilder: 1000, datacarts: 1000, extras: 1000 };

async function run() {
  if (process.argv.includes('--help')) { console.log('node tests/panel-breakpoints.mjs [--out DIRECTORY]\nUses P8_GEOMETRY_* browser configuration; see docs/GEOMETRY_SMOKE.md.'); return; }
  const require = createRequire(import.meta.url);
  let playwright;
  try { playwright = require(process.env.P8_GEOMETRY_PLAYWRIGHT || 'playwright'); }
  catch { throw Error('Use an existing Playwright module via P8_GEOMETRY_PLAYWRIGHT, or the manual matrix in docs/GEOMETRY_SMOKE.md. Nothing was installed.'); }
  const index = process.argv.indexOf('--out');
  if (index >= 0 && (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))) throw Error('--out needs a directory');
  const out = index >= 0 ? path.resolve(process.argv[index + 1]) : await fs.mkdtemp(path.join(os.tmpdir(), 'p8-panels-'));
  await fs.mkdir(out, { recursive: true });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), { server, url } = await serve(root);
  let browser;
  const report = { version: 1, widths, rows: [], transitions: [], presets: [], errors: [], failures: [], notes: ['640x450 at device scale 2 emulates 200% reflow/pixel density; physical browser zoom is separate.'] };
  const assert = (condition, message) => { if (!condition) report.failures.push(message); };
  try {
    browser = await playwright.chromium.launch({ headless: true, ...(process.env.P8_GEOMETRY_BROWSER_EXECUTABLE ? { executablePath: process.env.P8_GEOMETRY_BROWSER_EXECUTABLE } : {}), args: JSON.parse(process.env.P8_GEOMETRY_BROWSER_ARGS || '[]') });
    report.browser = browser.version();
    for (const scale of [1, 2]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: scale, reducedMotion: 'reduce' }), page = await context.newPage();
      page.on('pageerror', e => report.errors.push(e.message));
      await page.addInitScript(() => localStorage.setItem('p8suite.uxPrefs', JSON.stringify({ version: 1, autoOfferTours: false, helpLevel: 'off' })));
      await page.goto(url); const original = await fixture(page);
      const activate = async view => {
        await page.evaluate(v => { P8App.setWorkspace(v.ws, { persist: false }); if (v.sub) document.querySelector(`#exTabs [data-value="${v.sub}"]`).click(); scrollTo(0, 0); }, view);
        if (view.ws === 'minifier') await page.waitForFunction(() => Suite.minifier.getState().enginePhase !== 'loading', null, { timeout: 30000 });
        await page.waitForTimeout(120);
      };
      const readPanel = async p => page.locator(p.layout).evaluate((n, p) => {
        const side = n.querySelector(p.side), sep = n.querySelector('.panel-splitter'), center = n.querySelector(p.center), r = center.getBoundingClientRect();
        return { side: side.getBoundingClientRect().width, center: r.width, centerHeight: r.height, collapsed: n.hasAttribute('data-side-collapsed'), inert: side.inert, visible: getComputedStyle(side).visibility, splitter: getComputedStyle(sep).display,
          chosen: n.style.getPropertyValue('--side-w'), aria: Number(sep.getAttribute('aria-valuenow')), stored: localStorage.getItem('p8suite.layout') };
      }, p);
      // A saved wide preference must remain a preference, even while the current viewport clamps it.
      for (const p of panels) { await activate(p); await page.locator(`${p.layout} > .panel-splitter`).press('End'); }
      const preferences = await page.evaluate(() => localStorage.getItem('p8suite.layout'));
      const selectedWidths = scale === 1 ? widths : [640];
      for (const width of selectedWidths) for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: scale === 2 ? 450 : 900 });
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const references = new Map();
        for (const cycle of [0, 1]) for (const view of (cycle ? views.slice().reverse() : views)) {
          await activate(view);
          const g = await page.evaluate(measurePage), desktop = width > breakpoint[view.ws], p = panels.find(p => p.ws === view.ws);
          const key = `${scale}/${width}/${theme}/${view.ws}/visit${cycle}`;
          assert(g.pageWidth <= width + 1, key + ': horizontal page overflow');
          for (const canvas of g.canvases.filter(c => ['psCanvas', 'meCanvas'].includes(c.id))) {
            const [w, h] = canvas.bitmap;
            assert(canvas.rect.width > 0 && canvas.rect.height > 0 && Math.abs(w / canvas.rect.width - h / canvas.rect.height) < 0.01, key + ': primary canvas bitmap/display aspect changed');
          }
          const scroll = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: innerHeight, host: document.getElementById('workspaceHost').getBoundingClientRect().y, header: document.querySelector('.appbar').getBoundingClientRect().bottom, body: getComputedStyle(document.body).overflowY }));
          assert(scroll.body === 'hidden' && scroll.height <= scroll.viewport + 1 && Math.abs(scroll.host-scroll.header)<0.5, key + ': unexpected page/pane scroll ownership');
          const panel = p ? await readPanel(p) : null;
          if (panel) {
            assert(desktop ? panel.center >= 319.5 : !panel.inert && panel.visible === 'visible' && panel.splitter === 'none', key + ': unusable center or stacked controls');
            assert(panel.stored === preferences, key + ': viewport/switch rewrote preferred panel width');
            const samples = await page.locator(p.layout).evaluate(async (n, p) => {
              const samples = [];
              for (let i = 0; i < 6; i++) { await new Promise(r => requestAnimationFrame(r)); samples.push([n.querySelector(p.side).getBoundingClientRect().width, n.querySelector(p.center).getBoundingClientRect().width]); }
              return samples;
            }, p);
            assert(samples.every(s => s.every((v, i) => Math.abs(v - samples[0][i]) <= 0.5)), key + ': resize feedback oscillation');
          }
          const reference = references.get(view.ws);
          if (reference) assert(!panel || Math.abs(reference.panel.side - panel.side) <= 0.5, key + ': side width changed on return visit');
          else references.set(view.ws, { panel });
          report.rows.push({ scale, width, theme, cycle, ...view, desktop, scroll, panel, geometry: g });
          if (scale === 1 && theme === 'light' && cycle === 0 && p && [861, 901, 1001, 1280].includes(width)) await page.screenshot({ path: path.join(out, `${view.ws}-${width}.png`) });
        }
        console.log(`Audited ${width}px/${theme}/scale${scale}`);
      }
      const after = await page.evaluate(() => JSON.stringify({ code: document.querySelector('#ceText').value, studio: P8StudioDebug.state().doc, minifier: Suite.minifier.getInput().source }));
      assert(after === original, 'Viewport/tool switching changed a fixture document');
      // Exercise real separators, responsive collapse override, reload persistence and Settings reset API.
      for (const p of panels) {
        const wide = 1280, narrow = p.breakpoint;
        await page.setViewportSize({ width: wide, height: 900 }); await activate(p);
        const desired = await readPanel(p);
        await page.locator(`${p.layout} > .panel-splitter`).press('Enter');
        assert((await readPanel(p)).inert, `${p.ws}: collapsed desktop controls remain focusable`);
        await page.setViewportSize({ width: narrow, height: 900 }); await activate(p);
        const stacked = await readPanel(p);
        assert(!stacked.inert && stacked.visible === 'visible', `${p.ws}: collapse hid stacked controls`);
        await page.reload(); await page.waitForFunction(() => window.P8PanelLayout && window.Suite); await activate(p);
        assert(!(await readPanel(p)).inert, `${p.ws}: restored collapse hides narrow controls`);
        await page.setViewportSize({ width: wide, height: 900 }); await activate(p);
        const restored = await readPanel(p);
        assert(restored.collapsed && restored.inert, `${p.ws}: collapse lost after resize-back/reload`);
        await page.locator(`${p.layout} > .panel-splitter`).press('Enter');
        const shown = await readPanel(p);
        assert(Math.abs(shown.side - desired.side) <= 0.5, `${p.ws}: desired width lost after resize-back/reload`);
        await page.locator(`${p.layout} > .panel-splitter`).press('0');
        const reset = await readPanel(p);
        assert(Math.abs(reset.side - p.defaultWidth) <= 0.5 && !reset.collapsed, `${p.ws}: reset did not restore CSS default`);
        report.transitions.push({ scale, ws: p.ws, desired, stacked, restored, shown, reset });
      }
      await page.evaluate(() => P8PanelLayout.resetAll());
      for (const p of panels) { await activate(p); const state = await readPanel(p); assert(!state.collapsed && Math.abs(state.side - p.defaultWidth) <= 0.5, `${p.ws}: resetAll failed`); }
      for (const [view, width, selector, expected] of [
        [{ ws: 'studio' }, 1100, '.layout-studio > .ps-side', 232], [{ ws: 'studio' }, 1101, '.layout-studio > .ps-side', 272],
        [{ ws: 'minifier' }, 1199, '.mn-options', 250], [{ ws: 'minifier' }, 1200, '.mn-options', 300],
      ]) {
        await page.setViewportSize({ width, height: 900 }); await activate(view);
        const actual = (await page.locator(selector).boundingBox()).width;
        assert(Math.abs(actual - expected) <= 0.5, `${view.ws}/${width}: default width preset changed`);
        report.presets.push({ scale, ws: view.ws, width, expected, actual });
      }
      // Reloads above deliberately restore persisted sessions; the full fixture source was checked before them.
      await context.close();
      report.notes.push(`Scale ${scale} used isolated loaded fixtures (${original.length} serialized characters).`);
    }
    report.failures.push(...report.errors.map(e => 'Page error: ' + e));
  } catch (e) { report.failures.push(e.stack || String(e)); }
  finally { await browser?.close(); await new Promise(r => server.close(r)); await fs.writeFile(path.join(out, 'panels.json'), JSON.stringify(report, null, 2)); }
  console.log(`${report.rows.length} cases, ${report.transitions.length} reload/resize transitions; ${report.failures.length} failures. Report: ${path.join(out, 'panels.json')}`);
  if (report.failures.length) { console.error(report.failures.slice(0, 16).join('\n')); process.exitCode = 1; }
}
run().catch(e => { console.error(e.message); process.exitCode = 1; });

// js/terrain.js
// Terrain Lab (port of terrain_lab_v0_4), a tab of Extra Tools: seamless heightfields for PICO-8.
//   Simple mode: terrain presets, four sliders, brushes, text / image stamps, PICO-8 output.
//   Advanced:    every generation / erosion / light parameter, heightmap import, shape adjustments,
//                stacked erosion passes, full-resolution exports, scene files.
// The engine (js/terrain-core.js, P8Terrain) runs in two Web Workers: a low-resolution preview that
// answers every edit, and the full-resolution final render once editing pauses. Both keep their
// stage caches between jobs (the v0.4 tool restarted the final worker on every change).
// Registers itself with Extra Tools through window.P8ExtraTools (js/extras.js builds the tab).

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const T = P8Terrain;
  const { rgbOf, lum601 } = P8;
  const { el, toast, download, pickFile, decodeImage, confirmDialog, modal } = App;

  const KV = 'extras.terrain';
  const MODE_KEY = 'p8suite.terrain.mode';
  const RESOLUTIONS = [128, 256, 512, 1024];
  const PICO32 = [...Array(16).keys(), ...Array.from({ length: 16 }, (_, i) => 128 + i)];
  const RGB32 = PICO32.map((c) => rgbOf(c));

  const DEFAULTS = {
    seed: 719, resolution: 512, base: 0.48, relief: 0.17, scale: 3, octaves: 5, roughness: 0.52, ridges: 0.15, warp: 0.025, flatness: 0.3,
    palette: 'desert', colorVariation: 0.4, rock: 0.5, azimuth: 315, elevation: 38, normalScale: 2.6, ambient: 0.5, shadow: 0.5, shadowReach: 36,
    invert: 0, gamma: 1, terraces: 0, terraceSoft: 0.3, seaLevel: 0, importId: null, importMix: 1,
  };
  const EROSION_KEYS = ['erosion', 'droplets', 'wind', 'windDirection', 'windSteps', 'thermal'];
  const EROSION = {
    mixed: { erosion: 0.55, droplets: 14000, wind: 0.6, windDirection: 35, windSteps: 16, thermal: 4 },
    water: { erosion: 0.85, droplets: 28000, wind: 0, windDirection: 35, windSteps: 0, thermal: 3 },
    wind: { erosion: 0, droplets: 0, wind: 0.95, windDirection: 35, windSteps: 24, thermal: 2 },
    thermal: { erosion: 0, droplets: 0, wind: 0, windDirection: 35, windSteps: 0, thermal: 16 },
  };
  const MATERIALS = [['desert', 'Sandstone / arid'], ['volcanic', 'Volcanic basalt'], ['moss', 'Temperate grass'], ['alpine', 'Alpine (snow caps)'], ['tropical', 'Tropical (beach, jungle)'], ['lunar', 'Lunar regolith'], ['alien', 'Alien oxide']];

  // Terrain types for Simple mode: generation, look, shape and weathering in one click
  const PRESETS = {
    hills: { label: 'Rolling hills', p: { relief: 0.13, scale: 2, octaves: 5, roughness: 0.45, ridges: 0, warp: 0.02, flatness: 0.25, palette: 'moss', terraces: 0, seaLevel: 0 }, weather: ['water', 0.5] },
    mountains: { label: 'Mountains', p: { relief: 0.3, scale: 3, octaves: 6, roughness: 0.55, ridges: 0.7, warp: 0.03, flatness: 0.1, palette: 'alpine', terraces: 0, seaLevel: 0 }, weather: ['mixed', 0.7] },
    dunes: { label: 'Desert dunes', p: { relief: 0.1, scale: 4, octaves: 3, roughness: 0.4, ridges: 0.4, warp: 0.07, flatness: 0, palette: 'desert', terraces: 0, seaLevel: 0 }, weather: ['wind', 0.8] },
    canyon: { label: 'Canyons / mesas', p: { relief: 0.24, scale: 3, octaves: 5, roughness: 0.5, ridges: 0.25, warp: 0.04, flatness: 0.5, palette: 'desert', terraces: 6, terraceSoft: 0.25, seaLevel: 0 }, weather: ['water', 0.6] },
    islands: { label: 'Islands', p: { relief: 0.2, scale: 2, octaves: 6, roughness: 0.5, ridges: 0.1, warp: 0.04, flatness: 0.2, palette: 'tropical', terraces: 0, seaLevel: 0.45 }, weather: ['water', 0.4] },
    moon: { label: 'Moon craters', p: { relief: 0.07, scale: 4, octaves: 4, roughness: 0.5, ridges: 0, warp: 0.01, flatness: 0.3, palette: 'lunar', terraces: 0, seaLevel: 0 }, weather: ['thermal', 0.3], craters: 14 },
    volcano: { label: 'Volcanic', p: { relief: 0.26, scale: 2, octaves: 6, roughness: 0.55, ridges: 0.55, warp: 0.05, flatness: 0.15, palette: 'volcanic', terraces: 0, seaLevel: 0.12 }, weather: ['mixed', 0.6] },
    alien: { label: 'Alien', p: { relief: 0.2, scale: 3, octaves: 5, roughness: 0.6, ridges: 0.5, warp: 0.08, flatness: 0.2, palette: 'alien', terraces: 3, terraceSoft: 0.5, seaLevel: 0 }, weather: ['wind', 0.5] },
  };

  const TOOLS = [
    ['raise', 'Raise', 'Paint to raise the ground'],
    ['lower', 'Lower', 'Paint to lower the ground'],
    ['smooth', 'Smooth', 'Paint to soften the terrain'],
    ['flatten', 'Flatten', 'Paint to level the ground at the height where the stroke starts'],
    ['roughen', 'Roughen', 'Paint to add fine detail'],
    ['crater', 'Crater', 'Click for a crater with a raised rim'],
    ['text', 'Text', 'Click to emboss or engrave text (options in the side panel)'],
    ['image', 'Image', 'Click to stamp an image or SVG (options in the side panel)'],
    ['erode', 'Rain', 'Paint where water erosion should start (needs an erosion pass)', true],
    ['protect', 'Protect', 'Paint areas erosion should leave alone (needs an erosion pass)', true],
  ];

  // 3x5 pixel font for PICO-8-style lettering: five rows of three, '#' = set
  const PIXEL_FONT = (() => {
    const g = {
    A: '.#. #.# ### #.# #.#', B: '##. #.# ##. #.# ##.', C: '.## #.. #.. #.. .##', D: '##. #.# #.# #.# ##.', E: '### #.. ##. #.. ###', F: '### #.. ##. #.. #..',
    G: '.## #.. #.# #.# .##', H: '#.# #.# ### #.# #.#', I: '### .#. .#. .#. ###', J: '..# ..# ..# #.# .#.', K: '#.# #.# ##. #.# #.#', L: '#.. #.. #.. #.. ###',
    M: '#.# ### ### #.# #.#', N: '##. #.# #.# #.# #.#', O: '.#. #.# #.# #.# .#.', P: '##. #.# ##. #.. #..', Q: '.#. #.# #.# ##. .##', R: '##. #.# ##. #.# #.#',
    S: '.## #.. .#. ..# ##.', T: '### .#. .#. .#. .#.', U: '#.# #.# #.# #.# .##', V: '#.# #.# #.# .#. .#.', W: '#.# #.# ### ### #.#', X: '#.# #.# .#. #.# #.#',
    Y: '#.# #.# .#. .#. .#.', Z: '### ..# .#. #.. ###', 0: '### #.# #.# #.# ###', 1: '.#. ##. .#. .#. ###', 2: '##. ..# .#. #.. ###', 3: '##. ..# .#. ..# ##.',
    4: '#.# #.# ### ..# ..#', 5: '### #.. ##. ..# ##.', 6: '.## #.. ### #.# ###', 7: '### ..# .#. #.. #..', 8: '### #.# ### #.# ###', 9: '### #.# ### ..# ##.',
    '.': '... ... ... ... .#.', ',': '... ... ... .#. #..', '!': '.#. .#. .#. ... .#.', '?': '##. ..# .#. ... .#.', '-': '... ... ### ... ...', '+': '... .#. ### .#. ...',
    ':': '... .#. ... .#. ...', '/': '..# ..# .#. #.. #..', "'": '.#. .#. ... ... ...', '(': '.#. #.. #.. #.. .#.', ')': '.#. ..# ..# ..# .#.', ' ': '... ... ... ... ...',
    '#': '#.# ### #.# ### #.#', '*': '#.# .#. ### .#. #.#', '=': '... ### ... ### ...', '_': '... ... ... ... ###', '<': '..# .#. #.. .#. ..#', '>': '#.. .#. ..# .#. #..',
    };
    for (const k of Object.keys(g)) g[k] = g[k].replace(/ /g, '');
    return g;
  })();

  // ------------------------------------------------------------------ state
  let H = null; // helpers from Extra Tools
  const st = {
    mode: App.store.get(MODE_KEY, 'simple') === 'advanced' ? 'advanced' : 'simple',
    params: { ...DEFAULTS },
    stamps: [], passes: [], strokeStarts: [],
    bitmaps: {},     // id -> {w, h, data: Uint8Array}
    imports: {},     // id -> {size, data: Float32Array}
    importSrc: null, // {w, h, grey: Float32Array, name, method, blend}
    preset: 'custom', weather: { style: 'mixed', amount: 0.6 },
    erosionDraft: { ...EROSION.mixed },
    view: 'color', tile: false, tool: 'raise',
    brush: { r: 0.06, power: 0.55, rim: 0.55, preserve: false },
    text: { text: 'PICO-8', font: 'pixel', weight: 700, italic: false, size: 0.5, depth: 0.5, bevel: 0.25, angle: 0, mode: 'add', weathered: false },
    image: { bmp: null, name: '', size: 0.4, depth: 0.5, bevel: 0.15, angle: 0, mode: 'add', use: 'auto', srcData: null, weathered: false },
    pico: { colors: 'auto16', dither: 'ordered', strength: 0.5, palColors: null, palFades: null, palName: '', shade: 'lit', depth: 0.8, lift: 0.4 },
    previewRes: 256,
  };
  let undoStack = [], redoStack = [];
  let ids = 0;
  const nextId = () => ++ids;

  // ------------------------------------------------------------------ workers
  let rev = 0, finalRev = -1, bitmapsVer = 0, importsVer = 0;
  let finalResult = null, shown = null, lastPicoPal = null;
  let finalTimer = 0, painting = false, lastFinalMs = 200, lastShadeMs = 30;
  // sliders and brushes wait for a pause before the full-resolution render (about one render long);
  // one-off actions (buttons, menus, clicks on the map) start it right away
  const autoDelay = (shadeOnly = false) => (shadeOnly ? Math.min(200, Math.max(40, lastShadeMs * 1.5)) : Math.min(400, Math.max(120, lastFinalMs)));
  const channels = { preview: { worker: null, busy: false, pending: null, sentB: -1, sentI: -1 }, final: { worker: null, busy: false, pending: null, sentB: -1, sentI: -1 } };

  function spawn(which) {
    const ch = channels[which];
    ch.worker = new Worker(T.workerUrl());
    ch.sentB = ch.sentI = -1;
    ch.worker.onmessage = (e) => {
      ch.busy = false;
      onResult(which, e.data);
      if (ch.pending) { const job = ch.pending; ch.pending = null; send(which, job); }
    };
    ch.worker.onerror = (e) => { ch.busy = false; setStatus('Worker error', 'error'); console.error(e.message); };
  }
  function send(which, job) {
    const ch = channels[which];
    if (!ch.worker) spawn(which);
    if (ch.busy) { ch.pending = job; return; }
    // assets go over once per change (an imported 1024² map is 4 MB): bitmaps and imports separately
    if (ch.sentB !== bitmapsVer || ch.sentI !== importsVer) {
      const msg = { type: 'assets' };
      if (ch.sentB !== bitmapsVer) msg.bitmaps = st.bitmaps;
      if (ch.sentI !== importsVer) msg.imports = st.imports;
      ch.worker.postMessage(msg);
      ch.sentB = bitmapsVer; ch.sentI = importsVer;
    }
    ch.busy = true;
    ch.worker.postMessage(job);
  }
  function job(preview) {
    const n = preview ? Math.min(st.params.resolution, st.previewRes) : st.params.resolution;
    return { type: 'build', id: rev, preview, n, scene: { params: { ...st.params }, stamps: st.stamps, passes: st.passes.filter((p) => !p.off), strokeStarts: st.strokeStarts.slice(-8) } };
  }
  function onResult(which, r) {
    if (r.error) { console.error(`terrain ${which}: ${r.error}`); setStatus('Error (see console)', 'error'); return; }
    r.rev = r.id;
    if (which === 'final') {
      if (r.id !== rev) return; // stale: a newer final is pending
      finalResult = r; finalRev = r.id; lastFinalMs = r.ms; lastShadeMs = r.stages.shade;
      showResult(r);
    } else if (finalRev !== rev && (!shown || r.id >= shown.rev)) {
      // show every preview that is newer than what is on screen, even if edits went on meanwhile
      showResult(r);
    }
  }
  function changed({ finalDelay = 0 } = {}) {
    rev++;
    send('preview', job(true));
    scheduleFinal(finalDelay);
    updateStatus();
    persistSoon();
  }
  function scheduleFinal(ms = autoDelay()) {
    clearTimeout(finalTimer);
    finalTimer = setTimeout(() => { if (painting) { scheduleFinal(300); return; } if (finalRev !== rev) send('final', job(false)); }, ms);
  }
  const sliding = (shadeOnly = false) => changed({ finalDelay: autoDelay(shadeOnly) });
  const assetsChanged = (what = 'both') => { if (what !== 'imports') bitmapsVer++; if (what !== 'bitmaps') importsVer++; };

  // ------------------------------------------------------------------ display
  const cache = new Map(); // view -> canvas for the shown result
  let picoOut = null;      // {slots, pal (pico colors), levels, lo, hi} for the shown result

  function showResult(r) {
    shown = r;
    cache.clear();
    picoOut = null;
    updateStatus();
    draw();
    renderPicoInfo();
  }
  function viewCanvas(view) {
    if (!shown) return null;
    if (cache.has(view)) return cache.get(view);
    const r = shown;
    let c;
    if (view === 'pico') {
      const out = pico8();
      c = el('canvas', { width: 128, height: 128 });
      const im = new ImageData(128, 128);
      const rgb = out.pal.map(rgbOf);
      for (let i = 0; i < out.slots.length; i++) { const q = rgb[out.slots[i]]; im.data.set([q[0], q[1], q[2], 255], i * 4); }
      c.getContext('2d').putImageData(im, 0, 0);
    } else {
      const n = r.n;
      c = el('canvas', { width: n, height: n });
      let data;
      if (view === 'height') {
        data = new Uint8ClampedArray(n * n * 4);
        const span = Math.max(1e-6, r.high - r.low);
        for (let i = 0; i < n * n; i++) { const v = ((r.height[i] - r.low) / span) * 255; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
      } else data = view === 'albedo' ? r.albedo : r.color;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), n, n), 0, 0);
    }
    cache.set(view, c);
    return c;
  }

  /**
   * The palette the PICO-8 view uses: {pal (PICO-8 colors, slot order), fades, from, note}.
   *   auto*: the best N of the 32 colors for this terrain; std: the standard 16;
   *   src:<id>: what Palette & Fades / Pixel Studio have open right now (live, see Suite.registerPaletteSource);
   *   library / libimg: a library palette, or the palette (and fades) of a library image.
   * Fade tables come with the palette when it has them, else from Palette & Fades (by slot number).
   */
  function picoPalette(r, rgb) {
    const pm = st.pico.colors;
    let pal = null, fades = null, from = '', note = '';
    if (pm === 'std') { pal = [...Array(16).keys()]; from = 'Standard 16'; }
    else if (pm.startsWith('src:')) {
      const s = S.paletteSource(pm.slice(4)), label = S.paletteSources().find((x) => x.id === pm.slice(4))?.label || pm.slice(4);
      if (s) { pal = s.pal.slice(); fades = s.fades; from = `${label}: ${s.name}`; } else { pal = [...Array(16).keys()]; note = `${label} has nothing open: using the standard 16.`; from = 'Standard 16'; }
    } else if ((pm === 'library' || pm === 'libimg') && st.pico.palColors) { pal = st.pico.palColors.slice(); fades = pm === 'libimg' ? st.pico.palFades : null; from = st.pico.palName || 'Library'; }
    if (pal) {
      if (!fades?.dark && !fades?.bright) {
        const pf = S.paletteSource('palette');
        if (pf?.fades) { fades = pf.fades; if (pm !== 'src:palette') note ||= 'Fade tables from Palette & Fades, used by slot number.'; }
      }
      return { pal, fades, from, note, auto: false };
    }
    const count = Number(pm.replace('auto', '')) || 16;
    // choosing colors is the slow part: only for final renders, previews reuse the last choice
    if (r.preview && lastPicoPal && lastPicoPal.count === count) pal = lastPicoPal.pal;
    else { pal = T.bestColors(rgb, count, RGB32).map((i) => PICO32[i]); if (!r.preview) lastPicoPal = { count, pal }; }
    return { pal, fades: null, from: `Best ${count} of 32`, note: '', auto: true };
  }

  /** PICO-8 version of the shown result: 128x128 slots in the chosen colors, 16 height levels */
  function pico8() {
    if (picoOut) return picoOut;
    const r = shown, rgb = T.downsample(T.rgbOfRgba(r.color), r.n, 128, 3);
    const choice = picoPalette(r, rgb);
    let { pal } = choice;
    const useFades = st.pico.shade === 'fades' && !choice.auto && (choice.fades?.dark || choice.fades?.bright);
    let slots;
    if (useFades) {
      // PICO-8 style: the unlit color picks the slot, the light walks it along the fade tables
      const albedo = T.downsample(T.rgbOfRgba(r.albedo), r.n, 128, 3);
      slots = T.fadeShade(albedo, rgb, 128, pal.map(rgbOf), choice.fades, { depth: st.pico.depth, lift: st.pico.lift, dither: st.pico.dither !== 'none' });
    } else slots = T.quantize(rgb, 128, pal.map(rgbOf), st.pico.dither, st.pico.strength);
    if (choice.auto) {
      // drop colors that cover almost nothing (they only add noise), then map again
      const use = new Uint32Array(pal.length);
      for (const s of slots) use[s]++;
      const keep = pal.filter((_, i) => use[i] >= 41);
      if (keep.length && keep.length < pal.length) { pal = keep; slots = T.quantize(rgb, 128, pal.map(rgbOf), st.pico.dither, st.pico.strength); }
    }
    let note = choice.note;
    if (st.pico.shade === 'fades' && !useFades) note = choice.auto ? 'Fade shading needs a fixed palette (Palette & Fades, Pixel Studio, library, standard).' : 'This palette has no fade tables: define them in Palette & Fades.';
    const hl = T.heightLevels(r.height, r.n, 128, 16);
    picoOut = { slots, pal, levels: hl.levels, lo: hl.lo, hi: hl.hi, fades: useFades ? choice.fades : null, from: choice.from, note };
    return picoOut;
  }
  const refreshPico = () => { picoOut = null; cache.delete('pico'); if (st.view === 'pico') draw(); renderPicoInfo(); };
  /** pal padded to 16 slots (unused slots get the remaining standard colors) */
  const pal16 = (pal) => { const out = pal.slice(0, 16); for (let c = 0; out.length < 16 && c < 16; c++) if (!out.includes(c)) out.push(c); return out; };

  // ------------------------------------------------------------------ stage
  const canvas = el('canvas', { className: 'tl-canvas', attrs: { 'aria-label': 'Terrain preview' } });
  let cursor = null; // {px, py, x, y} in CSS pixels / map units
  let layoutBox = { ox: 0, oy: 0, s: 1 };

  function draw() {
    if (!H) return;
    const { ctx, w, h } = H.fitCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const s = Math.max(1, Math.floor(Math.min(w, h)));
    const ox = Math.floor((w - s) / 2), oy = Math.floor((h - s) / 2);
    layoutBox = { ox, oy, s };
    const src = viewCanvas(st.view);
    if (!src) { ctx.fillStyle = 'rgba(128,128,128,.25)'; ctx.fillRect(ox, oy, s, s); return; }
    ctx.imageSmoothingEnabled = st.view !== 'pico';
    if (st.tile) {
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) ctx.drawImage(src, ox + (x * s) / 2, oy + (y * s) / 2, s / 2, s / 2);
      ctx.strokeStyle = 'rgba(255,255,255,.35)';
      ctx.beginPath(); ctx.moveTo(ox + s / 2, oy); ctx.lineTo(ox + s / 2, oy + s); ctx.moveTo(ox, oy + s / 2); ctx.lineTo(ox + s, oy + s / 2); ctx.stroke();
    } else ctx.drawImage(src, ox, oy, s, s);
    drawCursor(ctx);
  }

  function ghostBitmap() {
    if (st.tool === 'text') return textBitmapCached();
    if (st.tool === 'image') return st.image.bmp ? st.bitmaps[st.image.bmp] || null : null;
    return null;
  }
  const ghostCanvas = new Map();
  function bitmapCanvas(bm) {
    if (ghostCanvas.has(bm)) return ghostCanvas.get(bm);
    const c = el('canvas', { width: bm.w, height: bm.h });
    const im = new ImageData(bm.w, bm.h);
    for (let i = 0; i < bm.data.length; i++) im.data.set([255, 236, 190, bm.data[i] * 0.75], i * 4);
    c.getContext('2d').putImageData(im, 0, 0);
    if (ghostCanvas.size > 8) ghostCanvas.clear();
    ghostCanvas.set(bm, c);
    return c;
  }
  function drawCursor(ctx) {
    if (!cursor) return;
    const { ox, oy, s } = layoutBox, tiles = st.tile ? 2 : 1, ts = s / tiles;
    ctx.save();
    ctx.beginPath(); ctx.rect(ox, oy, s, s); ctx.clip();
    const bm = ghostBitmap();
    for (let ty = 0; ty < tiles; ty++) for (let tx = 0; tx < tiles; tx++) for (let wy = -1; wy <= 1; wy++) for (let wx = -1; wx <= 1; wx++) {
      const cx = ox + (tx + cursor.x + wx) * ts, cy = oy + (ty + cursor.y + wy) * ts;
      if (bm) {
        const o = st.tool === 'text' ? st.text : st.image, bw = o.size * ts, bh = (bw * bm.h) / bm.w;
        if (cx + bw < ox || cy + bw < oy || cx - bw > ox + s || cy - bw > oy + s) continue;
        ctx.save(); ctx.translate(cx, cy); ctx.rotate((o.angle * Math.PI) / 180);
        ctx.drawImage(bitmapCanvas(bm), -bw / 2, -bh / 2, bw, bh);
        ctx.restore();
      } else {
        const r = st.brush.r * ts * (st.tool === 'crater' ? 1.28 : 1);
        if (cx + r < ox || cy + r < oy || cx - r > ox + s || cy - r > oy + s) continue;
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(2, r), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3; ctx.stroke();
        ctx.strokeStyle = 'rgba(255,240,200,.95)'; ctx.lineWidth = 1.2; ctx.stroke();
      }
    }
    ctx.restore();
  }

  function pointerMap(e) {
    const b = canvas.getBoundingClientRect(), { ox, oy, s } = layoutBox;
    const px = e.clientX - b.left - ox, py = e.clientY - b.top - oy;
    if (px < 0 || py < 0 || px >= s || py >= s) return null;
    let x = px / s, y = py / s;
    if (st.tile) { x = (x * 2) % 1; y = (y * 2) % 1; }
    return { x, y };
  }
  /** height of the shown result at map position (bilinear) */
  function heightAt(x, y) {
    if (!shown) return 0.5;
    const n = shown.n, fx = x * n - 0.5, fy = y * n - 0.5, xi = Math.floor(fx), yi = Math.floor(fy), ax = fx - xi, ay = fy - yi, m = n - 1;
    const g = (a, b) => shown.height[(b & m) * n + (a & m)];
    return (g(xi, yi) * (1 - ax) + g(xi + 1, yi) * ax) * (1 - ay) + (g(xi, yi + 1) * (1 - ax) + g(xi + 1, yi + 1) * ax) * ay;
  }

  let lastStamp = null, strokeLevel = 0;
  function addStamp(x, y) {
    const b = st.brush;
    const s = { id: nextId(), tool: st.tool, x, y, r: b.r, power: b.power, rim: b.rim, preserveRidges: st.tool === 'smooth' && b.preserve };
    if (st.tool === 'flatten') s.level = strokeLevel;
    st.stamps.push(s);
    lastStamp = s;
  }
  function placeBitmap(x, y) {
    const isText = st.tool === 'text', o = isText ? st.text : st.image;
    const bmId = isText ? textBitmapId() : o.bmp;
    if (!bmId) { toast(isText ? 'Type some text first.' : 'Load an image or SVG first (side panel).'); return false; }
    const label = isText ? `“${st.text.text.replace(/\s+/g, ' ').slice(0, 24)}”` : o.name || 'image';
    st.stamps.push({ id: nextId(), tool: 'bitmap', src: st.tool, label, bmp: bmId, x, y, size: o.size, angle: o.angle, depth: o.depth, mode: o.mode, level: heightAt(x, y), post: !o.weathered });
    return true;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const m = pointerMap(e);
    if (!m) return;
    canvas.setPointerCapture(e.pointerId);
    pushUndo();
    st.strokeStarts.push(st.stamps.length);
    if (st.strokeStarts.length > 5000) st.strokeStarts.shift();
    const at = posText(m);
    if (st.tool === 'text' || st.tool === 'image') {
      if (placeBitmap(m.x, m.y)) { changed(); renderOps(); setAction(`${st.tool === 'text' ? `Text “${st.text.text.split('\n')[0]}”` : `Image ${st.image.name}`} placed at ${at}`); } else { undoStack.pop(); st.strokeStarts.pop(); }
      return;
    }
    strokeLevel = heightAt(m.x, m.y);
    addStamp(m.x, m.y);
    if (st.tool === 'crater') { changed(); renderOps(); setAction(`Crater at ${at}`); return; }
    painting = true;
    strokeCount = 1;
    setAction(`${toolName()}: painting…`, true);
    sliding();
  });
  canvas.addEventListener('pointermove', (e) => {
    const m = pointerMap(e);
    cursor = m;
    draw();
    showPointer(m);
    if (!painting || !m || !lastStamp) return;
    let dx = Math.abs(m.x - lastStamp.x), dy = Math.abs(m.y - lastStamp.y);
    dx = Math.min(dx, 1 - dx); dy = Math.min(dy, 1 - dy);
    if (Math.hypot(dx, dy) > Math.max(0.004, st.brush.r * 0.28)) { addStamp(m.x, m.y); strokeCount++; setAction(`${toolName()}: painting, ${strokeCount} stamps`, true); sliding(); }
  });
  let strokeCount = 0;
  const endStroke = () => { if (!painting) return; painting = false; lastStamp = null; renderOps(); scheduleFinal(0); setAction(`${toolName()}: stroke of ${strokeCount} stamp${strokeCount === 1 ? '' : 's'} done`); };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', () => { cursor = null; draw(); showPointer(null); });
  canvas.addEventListener('wheel', (e) => {
    if (!e.altKey && !e.shiftKey) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    if (st.tool === 'text' || st.tool === 'image') { const o = st.tool === 'text' ? st.text : st.image; o.size = Math.min(1, Math.max(0.05, o.size * f)); ui.bitmapControls?.(); }
    else { st.brush.r = Math.min(0.3, Math.max(0.01, st.brush.r * f)); ui.brushSize?.set(st.brush.r * 100); }
    draw();
  }, { passive: false });

  // ------------------------------------------------------------------ undo
  // edits (stamps, passes, import) are undoable; actions that also set the sliders (presets, scene
  // files, reset) store the parameters too, so undo brings those back as well. Snapshots keep the
  // imports, import source and stamp bitmaps they use (see P8Terrain.history).
  const snapshot = (withParams = false) => T.history.snapshot(st, withParams);
  function pushUndo(withParams = false) { undoStack.push(snapshot(withParams)); redoStack = []; T.history.trim(undoStack, redoStack); renderUndo(); }
  function restore(s) {
    const c = T.history.restore(st, s);
    if (c.bitmaps || c.imports) assetsChanged(c.bitmaps && c.imports ? 'both' : c.bitmaps ? 'bitmaps' : 'imports');
  }
  function undo() { if (!undoStack.length) return; const s = undoStack.pop(); redoStack.push(snapshot(!!s.params)); restore(s); afterHistory(); setAction(`Undo (${undoStack.length} more)`); }
  function redo() { if (!redoStack.length) return; const s = redoStack.pop(); undoStack.push(snapshot(!!s.params)); restore(s); afterHistory(); setAction(`Redo (${redoStack.length} more)`); }
  function afterHistory() { clearTimeout(ui.retileTimer); syncControls(); renderOps(); renderPasses(); renderUndo(); syncImportUi(); changed(); }

  // ------------------------------------------------------------------ fonts
  // Every installed font: the Local Font Access API lists them all (Chrome / Edge, asks once);
  // without it, a list of common fonts is checked by measuring text against the fallbacks.
  const FONTS_KEY = 'p8suite.terrain.fonts';
  const GENERIC = ['system-ui', 'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy'];
  const COMMON_FONTS = ['Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Cascadia Code', 'Cascadia Mono', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel',
    'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic',
    'Microsoft Sans Serif', 'MV Boli', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Black', 'Segoe UI Semibold', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman',
    'Trebuchet MS', 'Verdana', 'Wingdings', 'Helvetica', 'Helvetica Neue', 'Futura', 'Gill Sans', 'Optima', 'Avenir', 'Avenir Next', 'Menlo', 'Monaco', 'Courier', 'Baskerville', 'Didot',
    'American Typewriter', 'Chalkboard', 'Marker Felt', 'Papyrus', 'Rockwell', 'Copperplate', 'Herculanum', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif',
    'Liberation Mono', 'Ubuntu', 'Ubuntu Mono', 'Noto Sans', 'Noto Serif', 'Roboto', 'Open Sans', 'Fira Code', 'Fira Sans', 'JetBrains Mono', 'Source Code Pro', 'Press Start 2P', 'VT323', 'Silkscreen'];
  const cssFamily = (f) => (GENERIC.includes(f) ? f : `"${String(f).replace(/["\\]/g, '')}"`);
  function installedCommonFonts() {
    const ctx = el('canvas').getContext('2d'), probe = 'mmmmmmmmmmlli WW@#0 ÄÉ', base = {};
    for (const g of ['monospace', 'serif', 'sans-serif']) { ctx.font = `72px ${g}`; base[g] = ctx.measureText(probe).width; }
    return COMMON_FONTS.filter((f) => ['monospace', 'serif', 'sans-serif'].some((g) => { ctx.font = `72px "${f}", ${g}`; return ctx.measureText(probe).width !== base[g]; }));
  }
  let fontList = null;
  function fonts() {
    if (!fontList) { const saved = App.store.get(FONTS_KEY, null); fontList = Array.isArray(saved) && saved.length ? saved : installedCommonFonts(); }
    return fontList;
  }
  async function loadAllFonts() {
    if (!('queryLocalFonts' in window)) { toast('This browser cannot list all fonts (Chrome or Edge can). Type any installed font name instead.'); return; }
    try {
      const list = [...new Set((await window.queryLocalFonts()).map((f) => f.family))].sort((a, b) => a.localeCompare(b));
      if (!list.length) { toast('No fonts were shared (permission denied?).'); return; }
      fontList = list; App.store.set(FONTS_KEY, list); ui.fillFonts?.(); toast(`${list.length} system fonts available.`);
    } catch (err) { toast(`Could not read the fonts: ${err.message}`); }
  }

  // ------------------------------------------------------------------ text / image bitmaps
  let textKey = '', textId = null;
  function textBitmapCached() { const id = textBitmapId(); return id ? st.bitmaps[id] : null; }
  /** bitmap of the current text settings (created once per text / font / bevel) */
  function textBitmapId() {
    const t = st.text, key = JSON.stringify([t.text, t.font, t.bevel, t.weight, t.italic]);
    if (key === textKey && textId && st.bitmaps[textId]) return textId;
    const bm = renderText(t);
    if (!bm) return null;
    textKey = key;
    textId = `t${Date.now().toString(36)}${nextId()}`;
    st.bitmaps[textId] = bm;
    assetsChanged('bitmaps');
    return textId;
  }
  function renderText({ text, font, bevel, weight = 700, italic = false }) {
    const lines = String(text || '').split('\n').filter((l, i, a) => l.length || a.length === 1);
    if (!lines.join('').trim()) return null;
    let c, ctx;
    if (font === 'pixel') {
      const cell = 16, cols = Math.max(...lines.map((l) => l.length)), pad = Math.round(cell * (1 + bevel * 2));
      c = el('canvas', { width: cols * 4 * cell - cell + pad * 2, height: lines.length * 6 * cell - cell + pad * 2 });
      ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      const tmp = el('canvas', { width: c.width, height: c.height }), tc = tmp.getContext('2d');
      tc.fillStyle = '#fff';
      lines.forEach((l, li) => [...l.toUpperCase()].forEach((ch, ci) => {
        const g = PIXEL_FONT[ch] || PIXEL_FONT['?'];
        for (let k = 0; k < 15; k++) if (g[k] === '#') tc.fillRect(pad + (ci * 4 + (k % 3)) * cell, pad + (li * 6 + Math.floor(k / 3)) * cell, cell, cell);
      }));
      ctx.filter = bevel > 0 ? `blur(${bevel * cell * 0.9}px)` : 'none';
      ctx.drawImage(tmp, 0, 0);
    } else {
      const size = 140, f = `${italic ? 'italic ' : ''}${weight} ${size}px ${cssFamily(font)}, sans-serif`, pad = Math.round(size * (0.15 + bevel * 0.4));
      const m = el('canvas').getContext('2d'); m.font = f;
      const w = Math.ceil(Math.max(...lines.map((l) => m.measureText(l).width))) + pad * 2, lh = Math.round(size * 1.15);
      c = el('canvas', { width: Math.max(8, w), height: lines.length * lh + pad * 2 });
      ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.filter = bevel > 0 ? `blur(${bevel * size * 0.12}px)` : 'none';
      ctx.font = f; ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      lines.forEach((l, i) => ctx.fillText(l, c.width / 2, pad + lh * (i + 0.5)));
    }
    return greyOf(ctx.getImageData(0, 0, c.width, c.height), 'red', 1024);
  }
  /** ImageData -> {w, h, data} grey bitmap, longest side at most max (box filtered) */
  function greyOf(im, use, max = 512) {
    const sc = Math.min(1, max / Math.max(im.width, im.height)), w = Math.max(1, Math.round(im.width * sc)), h = Math.max(1, Math.round(im.height * sc));
    const d = im.data, out = new Uint8Array(w * h);
    let hasAlpha = false;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
    const mode = use === 'auto' ? (hasAlpha ? 'alpha' : 'bright') : use;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / sc), x1 = Math.max(x0 + 1, Math.floor((x + 1) / sc)), y0 = Math.floor(y / sc), y1 = Math.max(y0 + 1, Math.floor((y + 1) / sc));
      let acc = 0, cnt = 0;
      for (let yy = y0; yy < Math.min(y1, im.height); yy++) for (let xx = x0; xx < Math.min(x1, im.width); xx++) {
        const o = (yy * im.width + xx) * 4, a = d[o + 3] / 255, l = (0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]);
        acc += mode === 'red' ? d[o] : mode === 'alpha' ? a * 255 : mode === 'dark' ? (255 - l) * a : l * a;
        cnt++;
      }
      out[y * w + x] = cnt ? acc / cnt : 0;
    }
    return { w, h, data: out };
  }
  async function imageDataOf(file) {
    if (/svg/i.test(file.type) || /\.svg$/i.test(file.name)) {
      const url = URL.createObjectURL(file);
      try {
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read the SVG.')); i.src = url; });
        const ratio = im.naturalWidth && im.naturalHeight ? im.naturalWidth / im.naturalHeight : 1;
        const w = ratio >= 1 ? 1024 : Math.round(1024 * ratio), h = ratio >= 1 ? Math.round(1024 / ratio) : 1024;
        const c = el('canvas', { width: w, height: h }), ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(im, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
      } finally { URL.revokeObjectURL(url); }
    }
    return decodeImage(file);
  }
  /** blurred copy of a bitmap for the bevel (done once per image + bevel) */
  function bevelled(src, bevel) {
    if (bevel <= 0) return src;
    const pad = Math.round(Math.max(src.w, src.h) * bevel * 0.08);
    const c = el('canvas', { width: src.w + pad * 2, height: src.h + pad * 2 }), ctx = c.getContext('2d', { willReadFrequently: true });
    const t = el('canvas', { width: src.w, height: src.h }), im = new ImageData(src.w, src.h);
    for (let i = 0; i < src.data.length; i++) im.data.set([src.data[i], src.data[i], src.data[i], 255], i * 4);
    t.getContext('2d').putImageData(im, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.filter = `blur(${Math.max(src.w, src.h) * bevel * 0.03}px)`;
    ctx.drawImage(t, pad, pad);
    return greyOf(ctx.getImageData(0, 0, c.width, c.height), 'red', 1024);
  }
  function setImageBitmap() {
    const o = st.image;
    if (!o.srcData) { o.bmp = null; return; }
    const bm = bevelled(greyOf(o.srcData, o.use, 512), o.bevel);
    const id = `i${Date.now().toString(36)}${nextId()}`;
    st.bitmaps[id] = bm;
    o.bmp = id;
    assetsChanged('bitmaps');
  }
  async function loadImageFile() {
    const f = await pickFile('image/*,.svg');
    if (!f) return;
    try { st.image.srcData = await imageDataOf(f); st.image.name = f.name; setImageBitmap(); ui.bitmapControls?.(); draw(); toast(`${f.name}: click on the map to stamp it.`); } catch (err) { toast(err.message || 'Could not read the image.'); }
  }
  async function loadImageAsset(asset = null) {
    const a = asset || await S.pickAsset({ title: 'Image to stamp on the terrain' });
    if (!a) return;
    st.image.srcData = S.assetImageData(a, { transparent: true }); st.image.name = a.name; setImageBitmap(); ui.bitmapControls?.(); draw();
  }
  /** settings changed while the last stamp is this tool's bitmap: update that stamp in place */
  function updateLastBitmap() {
    const last = st.stamps[st.stamps.length - 1];
    if (!last || last.tool !== 'bitmap' || last.src !== st.tool) { draw(); return; }
    const o = st.tool === 'text' ? st.text : st.image;
    const bmp = st.tool === 'text' ? textBitmapId() : o.bmp;
    if (!bmp) return;
    st.stamps[st.stamps.length - 1] = { ...last, id: nextId(), bmp, size: o.size, angle: o.angle, depth: o.depth, mode: o.mode, post: !o.weathered };
    sliding();
  }

  // ------------------------------------------------------------------ heightmap import
  async function importHeightmap(fromLibrary, asset = null) {
    let im, name;
    if (fromLibrary) {
      const a = asset || await S.pickAsset({ title: 'Heightmap (brightness = height)' });
      if (!a) return;
      im = S.assetImageData(a); name = a.name;
    } else {
      const f = await pickFile('image/*');
      if (!f) return;
      try { im = await decodeImage(f); } catch { toast('Could not read the image.'); return; }
      name = f.name;
    }
    const grey = new Float32Array(im.width * im.height);
    for (let i = 0; i < grey.length; i++) grey[i] = (0.299 * im.data[i * 4] + 0.587 * im.data[i * 4 + 1] + 0.114 * im.data[i * 4 + 2]) / 255;
    pushUndo();
    st.importSrc = { w: im.width, h: im.height, grey, name, method: st.importSrc?.method || 'blend', blend: st.importSrc?.blend ?? 0.25 };
    if (st.params.importMix == null) st.params.importMix = 1;
    retile();
    toast(`${name} is now the base terrain (seamless).`);
    setAction(`Heightmap ${name} imported`);
  }
  /** seamless tile of the import source; patch = new seam settings, committed together with the tile */
  function retile(patch = null) {
    if (!st.importSrc) return;
    const s = patch ? { ...st.importSrc, ...patch } : st.importSrc;
    const size = Math.max(s.w, s.h) >= 1024 ? 1024 : 512;
    const id = `h${Date.now().toString(36)}${nextId()}`;
    // new objects, never edited in place: undo snapshots keep the ones they were taken with
    st.imports = { [id]: { size, data: T.makeTileable(s.grey, s.w, s.h, size, s.method, s.blend) } };
    st.importSrc = s;
    st.params.importId = id;
    assetsChanged('imports');
    syncImportUi();
    changed();
  }
  function removeImport() { pushUndo(); st.params.importId = null; syncImportUi(); changed(); }

  // ------------------------------------------------------------------ presets / weathering
  function applyPreset(key) {
    const pr = PRESETS[key];
    if (!pr) return;
    pushUndo(true);
    Object.assign(st.params, { terraceSoft: 0.3, gamma: 1, invert: 0 }, pr.p);
    st.preset = key;
    st.weather = { style: pr.weather[0], amount: pr.weather[1] };
    setSimpleWeathering();
    if (pr.craters) {
      const rnd = T.rngFactory(st.params.seed + 4242);
      st.strokeStarts.push(st.stamps.length);
      for (let i = 0; i < pr.craters; i++) {
        const r = 0.02 + Math.pow(rnd(), 2.2) * 0.11;
        st.stamps.push({ id: nextId(), tool: 'crater', x: rnd(), y: rnd(), r, power: 0.35 + rnd() * 0.5, rim: 0.4 + rnd() * 0.4, preserveRidges: false });
      }
    }
    syncControls(); renderOps(); renderPasses(); changed();
    setAction(`Terrain type: ${pr.label}`);
  }
  /** Simple mode: one erosion pass of the chosen style, scaled by the amount */
  function setSimpleWeathering() {
    const { style, amount } = st.weather, b = EROSION[style] || EROSION.mixed;
    st.passes = amount > 0 ? [{ id: nextId(), erosion: b.erosion * amount, droplets: Math.round(b.droplets * amount), wind: b.wind * amount, windDirection: b.windDirection, windSteps: Math.round(b.windSteps * amount), thermal: Math.round(b.thermal * amount) }] : [];
  }

  // ------------------------------------------------------------------ exports
  const needFinal = () => {
    if (finalResult && finalRev === rev) return true;
    toast('The final render is still running: try again in a moment.');
    if (finalRev !== rev) scheduleFinal(0);
    return false;
  };
  const baseName = () => `terrain_${st.params.seed}`;
  function pngOf(rgba, n) {
    const c = el('canvas', { width: n, height: n });
    c.getContext('2d').putImageData(new ImageData(rgba, n, n), 0, 0);
    return new Promise((res) => c.toBlob(res, 'image/png'));
  }
  async function exportFull(kind) {
    if (!needFinal()) return;
    const r = finalResult, n = r.n;
    if (kind === 'raw') {
      const out = new Uint8Array(n * n), span = Math.max(1e-6, r.high - r.low);
      for (let i = 0; i < out.length; i++) out[i] = Math.round(((r.height[i] - r.low) / span) * 255);
      download(new Blob([out]), `${baseName()}_height_${n}.raw`);
      return;
    }
    let rgba;
    if (kind === 'height') {
      rgba = new Uint8ClampedArray(n * n * 4);
      const span = Math.max(1e-6, r.high - r.low);
      for (let i = 0; i < n * n; i++) { const v = Math.round(((r.height[i] - r.low) / span) * 255); rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; }
    } else rgba = new Uint8ClampedArray(kind === 'albedo' ? r.albedo : r.color);
    download(await pngOf(rgba, n), `${baseName()}_${kind}_${n}.png`);
  }
  const heightPal = () => [...Array(16).keys()].sort((a, b) => lum601(rgbOf(a)) - lum601(rgbOf(b)));
  async function exportPico(kind) {
    if (!needFinal()) return;
    if (shown !== finalResult) showResult(finalResult);
    const o = pico8();
    if (kind === 'bin') { download(new Blob([Uint8Array.from(T.heightLevels(finalResult.height, finalResult.n, 128, 256).levels)]), `${baseName()}_height_128x128.bin`); return; }
    const pal = kind === 'height' ? heightPal() : pal16(o.pal), slots = kind === 'height' ? o.levels : o.slots;
    const a = S.imageAsset({ name: `${baseName()}_${kind}`, w: 128, h: 128, pixels: slots, pal, transparent: -1, source: 'terrain' });
    download(new Blob([await S.imageAssetToPng(a)], { type: 'image/png' }), `${baseName()}_pico_${kind}.png`);
  }
  async function toLibrary() {
    if (!needFinal()) return;
    if (shown !== finalResult) showResult(finalResult);
    const o = pico8();
    await S.assets.put(colorAsset(o));
    await S.assets.put(S.imageAsset({ name: `${baseName()} height`, w: 128, h: 128, pixels: o.levels.slice(), pal: heightPal(), transparent: -1, source: 'terrain', meta: { terrain: { seed: st.params.seed, heightRange: [o.lo, o.hi], levels: 16 } } }));
    toast('Color map and height map saved to the library (128×128).');
  }
  /** the PICO-8 color map as a library image (with the fade tables it was shaded with) */
  function colorAsset(o) {
    const meta = { terrain: { seed: st.params.seed } };
    if (o.fades) meta.fades = { dark: o.fades.dark || null, bright: o.fades.bright || null, from: 'Terrain Lab' };
    return S.imageAsset({ name: `${baseName()} color`, w: 128, h: 128, pixels: o.slots.slice(), pal: pal16(o.pal), transparent: -1, source: 'terrain', meta });
  }
  async function openColorIn(consumer) {
    if (!needFinal()) return;
    if (shown !== finalResult) showResult(finalResult);
    await S.openIn(consumer, colorAsset(pico8()));
  }

  /** .p8: color map in the sprite sheet, 4-bit heights at 0x2000 (copied to 0x8000), scrolling viewer */
  function cartText() {
    const o = pico8(), pal = pal16(o.pal), C = P8Cart, rom = new Uint8Array(C.ROM_SIZE);
    for (let i = 0; i < 128 * 128; i += 2) { rom[i >> 1] = o.slots[i] | (o.slots[i + 1] << 4); rom[0x2000 + (i >> 1)] = o.levels[i] | (o.levels[i + 1] << 4); }
    const lua = [
      `-- terrain lab: seamless 128x128 terrain (seed ${st.params.seed})`,
      '-- sprite sheet: color map. cart 0x2000-0x3fff: height map, 4 bits per pixel',
      '-- (low nibble = left pixel), copied to 0x8000 at start. hget() = 0..15 (hmin..hmax)',
      `hmin,hmax=${o.lo.toFixed(4)},${o.hi.toFixed(4)}`,
      'function _init()',
      ` pal({[0]=${pal.join(',')}},1)`,
      ' memcpy(0x8000,0x2000,0x2000)',
      ' cx,cy=0,0',
      'end',
      'function hget(x,y)',
      ' local b=@(0x8000+(y&127)*64+(x&127)\\2)',
      ' return x&1==0 and b&15 or b\\16',
      'end',
      'function _update()',
      ' if(btn(0))cx-=1',
      ' if(btn(1))cx+=1',
      ' if(btn(2))cy-=1',
      ' if(btn(3))cy+=1',
      'end',
      'function _draw()',
      ' local x,y=-(cx&127),-(cy&127)',
      ' sspr(0,0,128,128,x,y) sspr(0,0,128,128,x+128,y)',
      ' sspr(0,0,128,128,x,y+128) sspr(0,0,128,128,x+128,y+128)',
      'end',
    ].join('\n');
    return C.writeP8({ rom, lua });
  }
  function exportCart() { if (!needFinal()) return; if (shown !== finalResult) showResult(finalResult); download(cartText(), `${baseName()}.p8`); }

  // ------------------------------------------------------------------ scene files
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  // undo / redo snapshots hold their own bitmap references, so the live store only needs the current ones
  const usedBitmaps = () => T.history.liveBitmapIds(st.stamps, [textId, st.image.bmp]);
  function sceneJson() {
    const used = new Set(st.stamps.filter((s) => s.bmp).map((s) => s.bmp));
    const bitmaps = {};
    for (const id of used) { const b = st.bitmaps[id]; if (b) bitmaps[id] = { w: b.w, h: b.h, data: b64(b.data) }; }
    let imp = null;
    const im = st.params.importId && st.imports[st.params.importId];
    if (im) {
      const u16 = new Uint16Array(im.data.length);
      for (let i = 0; i < u16.length; i++) u16[i] = Math.round(Math.min(1, Math.max(0, im.data[i])) * 65535);
      imp = { id: st.params.importId, size: im.size, data: b64(new Uint8Array(u16.buffer)), name: st.importSrc?.name || '' };
    }
    const range = finalResult && finalRev === rev ? { min: finalResult.low, max: finalResult.high } : null;
    return JSON.stringify({ format: 'terrain-lab-scene', version: 3, params: st.params, stamps: st.stamps, passes: st.passes, bitmaps, import: imp, picoHeightRange: range }, null, 1);
  }
  function loadScene(s) {
    if (s.format !== 'terrain-lab-scene' || !s.params || !Array.isArray(s.stamps)) throw new Error('Not a Terrain Lab scene.');
    const p = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (s.params[k] !== undefined && s.params[k] !== null) p[k] = typeof DEFAULTS[k] === 'number' ? Number(s.params[k]) : s.params[k];
    if (!RESOLUTIONS.includes(p.resolution)) p.resolution = 512;
    if (!T.MATERIALS[p.palette]) p.palette = 'desert';
    const bitmaps = {};
    for (const [id, b] of Object.entries(s.bitmaps || {})) bitmaps[id] = { w: b.w, h: b.h, data: unb64(b.data) };
    const imports = {};
    if (s.import?.data) {
      const u8 = unb64(s.import.data), u16 = new Uint16Array(u8.buffer, u8.byteOffset, u8.length / 2), f = new Float32Array(u16.length);
      for (let i = 0; i < f.length; i++) f[i] = u16[i] / 65535;
      imports[s.import.id] = { size: s.import.size, data: f };
      p.importId = s.import.id;
    } else p.importId = null;
    const tools = new Set(['crater', 'raise', 'lower', 'smooth', 'erode', 'protect', 'flatten', 'roughen', 'bitmap']);
    const stamps = s.stamps.filter((a) => tools.has(a.tool) && Number.isFinite(a.x) && Number.isFinite(a.y) && (a.tool === 'bitmap' ? bitmaps[a.bmp] : Number.isFinite(a.r)))
      .slice(0, 2000).map((a) => ({ ...a, id: nextId(), x: ((a.x % 1) + 1) % 1, y: ((a.y % 1) + 1) % 1, preserveRidges: a.preserveRidges === true }));
    // v0.1/v0.2 scenes weathered every map implicitly
    const old = { erosion: Number(s.params.erosion) || 0, droplets: Number(s.params.droplets) || 0, wind: 0, windDirection: 35, windSteps: 0, thermal: Number(s.params.thermal) || 0 };
    const incoming = Array.isArray(s.passes) ? s.passes : old.erosion || old.thermal ? [old] : [];
    const passes = incoming.slice(0, 6).map((a) => { const q = { id: nextId() }; for (const k of EROSION_KEYS) q[k] = Number.isFinite(Number(a[k])) ? Number(a[k]) : 0; return q; });
    pushUndo(true);
    Object.assign(st, { params: p, stamps, passes, bitmaps, imports, strokeStarts: [], preset: 'custom', importSrc: null });
    for (const k of EROSION_KEYS) if (s.params[k] !== undefined) st.erosionDraft[k] = Number(s.params[k]);
    assetsChanged();
    syncControls(); renderOps(); renderPasses(); syncImportUi(); changed({ finalDelay: 0 });
  }
  async function openSceneFile() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try { loadScene(JSON.parse(await f.text())); toast(`${f.name} loaded.`); } catch (err) { toast(`Could not load the scene: ${err.message}`); }
  }

  // persistence (IndexedDB): the scene with its bitmaps, the import source and the UI choices
  let persistTimer = 0;
  function persistSoon() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const used = usedBitmaps(), bitmaps = {};
      for (const id of Object.keys(st.bitmaps)) if (used.has(id)) bitmaps[id] = st.bitmaps[id]; else delete st.bitmaps[id];
      S.kv.set(KV, {
        v: 3, params: st.params, stamps: st.stamps, passes: st.passes, bitmaps, imports: st.imports, importSrc: st.importSrc,
        preset: st.preset, weather: st.weather, erosionDraft: st.erosionDraft, view: st.view, tile: st.tile, tool: st.tool, brush: st.brush,
        text: st.text, image: { ...st.image, srcData: null }, imageSrc: st.image.srcData ? { w: st.image.srcData.width, h: st.image.srcData.height, data: st.image.srcData.data } : null,
        pico: st.pico, previewRes: st.previewRes, ids,
      }).catch(() => {});
    }, 700);
  }
  function restoreSaved(d) {
    if (!d || d.v !== 3) return false;
    Object.assign(st, {
      params: { ...DEFAULTS, ...d.params }, stamps: d.stamps || [], passes: d.passes || [], bitmaps: d.bitmaps || {}, imports: d.imports || {}, importSrc: d.importSrc || null,
      preset: d.preset || 'custom', weather: d.weather || st.weather, erosionDraft: { ...st.erosionDraft, ...d.erosionDraft }, view: d.view || 'color', tile: !!d.tile,
      tool: TOOLS.some((t) => t[0] === d.tool) ? d.tool : 'raise', brush: { ...st.brush, ...d.brush }, text: { ...st.text, ...d.text }, image: { ...st.image, ...d.image, srcData: null },
      pico: { ...st.pico, ...d.pico }, previewRes: d.previewRes || 256,
    });
    if (d.imageSrc) st.image.srcData = new ImageData(new Uint8ClampedArray(d.imageSrc.data), d.imageSrc.w, d.imageSrc.h);
    ids = Math.max(ids, d.ids || 0, ...st.stamps.map((s) => s.id), ...st.passes.map((p) => p.id || 0));
    assetsChanged();
    return true;
  }

  // ------------------------------------------------------------------ status
  const status = el('span', { className: 'badge tl-status' });
  const stats = el('span', { className: 'tl-sb-stats' });
  const sbAction = el('span', { className: 'tl-sb-action' });
  const sbPos = el('span', { className: 'tl-sb-pos', textContent: '—' });
  const toolName = () => TOOLS.find((x) => x[0] === st.tool)?.[1] || st.tool;
  function idleText() {
    const tool = TOOLS.find((x) => x[0] === st.tool);
    if (!tool) return '';
    if (st.tool === 'text' || st.tool === 'image') return `${tool[1]}: ${tool[2]} · Alt+wheel: size`;
    return `${tool[1]} · size ${(st.brush.r * 100).toFixed(1)}% · strength ${st.brush.power.toFixed(2)} · Alt+wheel or [ ]: size`;
  }
  let actionTimer = 0;
  /** the current action in the status bar; it falls back to the tool hint after a moment */
  function setAction(text, sticky = false) {
    sbAction.textContent = text;
    clearTimeout(actionTimer);
    if (!sticky) actionTimer = setTimeout(() => { sbAction.textContent = idleText(); }, 3000);
  }
  const posText = (m) => { const n = st.params.resolution; return `${Math.floor(m.x * n)}, ${Math.floor(m.y * n)}`; };
  /** pointer position on the heightmap: map pixel, PICO-8 pixel, height, 4-bit level (and color in the PICO-8 view) */
  function showPointer(m) {
    if (!m) { sbPos.textContent = '—'; return; }
    const n = st.params.resolution, px = Math.floor(m.x * 128), py = Math.floor(m.y * 128);
    let s = `x ${Math.floor(m.x * n)} y ${Math.floor(m.y * n)} · PICO-8 ${px}, ${py}`;
    if (shown) {
      const h = heightAt(m.x, m.y), span = Math.max(1e-6, shown.high - shown.low);
      s += ` · height ${h.toFixed(3)} · level ${Math.max(0, Math.min(15, Math.round(((h - shown.low) / span) * 15)))}`;
      if (st.view === 'pico' && picoOut) { const slot = picoOut.slots[py * 128 + px]; s += ` · slot ${slot} = color ${picoOut.pal[slot]}`; }
    }
    sbPos.textContent = s;
  }
  function setStatus(text, cls = '') { status.textContent = text; status.className = `badge tl-status ${cls}`; }
  function updateStatus() {
    if (finalRev === rev && finalResult) {
      setStatus('Final', 'tl-final');
      const s = finalResult.stages;
      stats.textContent = `${finalResult.n}×${finalResult.n} in ${finalResult.ms} ms`;
      stats.title = `terrain ${s.base + s.sculpt} ms, erosion ${s.weather} ms, shading ${s.shade} ms · ${st.stamps.length} edits · ${st.passes.length} erosion pass${st.passes.length === 1 ? '' : 'es'}`;
    } else {
      setStatus('Preview', 'tl-busy');
      stats.textContent = shown ? `${shown.n}×${shown.n} preview in ${shown.ms} ms` : 'Computing…';
      stats.title = `The final ${st.params.resolution}×${st.params.resolution} render follows when you pause`;
    }
    ui.exports?.forEach((b) => { b.disabled = !(finalResult && finalRev === rev); });
  }

  // ------------------------------------------------------------------ UI
  const ui = {};

  function build(helpers) {
    H = helpers;
    const { slider, checkbox, select, btn, group, row } = H;
    const seg = (items, value, onPick, cls = 'seg seg-sm') => {
      const s = el('div', { className: cls, attrs: { role: 'radiogroup' } }, ...items.map(([v, label, title]) => el('button', { type: 'button', textContent: label, title: title || '', dataset: { value: v }, attrs: { role: 'radio', 'aria-checked': String(v === value) } })));
      s.addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (!b) return; for (const x of s.children) x.setAttribute('aria-checked', String(x === b)); onPick(b.dataset.value); });
      s.set = (v) => { for (const x of s.children) x.setAttribute('aria-checked', String(x.dataset.value === v)); };
      return s;
    };
    const adv = (node) => { node.dataset.adv = '1'; return node; };
    const param = (key, label, min, max, step, opts = {}) => {
      const s = slider({ label, min, max, step, value: st.params[key], title: opts.title || '', onInput: (v) => { st.params[key] = v; if (opts.preset !== false) markCustom(); sliding(T.SHADE_KEYS.includes(key)); } });
      (ui.params ||= {})[key] = s;
      return s;
    };
    const markCustom = () => { if (st.preset !== 'custom') { st.preset = 'custom'; ui.preset?.set('custom'); } };

    // ---- stage
    ui.view = seg([['color', 'Lit'], ['albedo', 'Albedo'], ['height', 'Height'], ['pico', 'PICO-8', 'The 128×128 map in PICO-8 colors, as exported']], st.view, (v) => { st.view = v; draw(); persistSoon(); });
    ui.tile = checkbox('2×2', st.tile, (v) => { st.tile = v; draw(); persistSoon(); }, 'Show the map four times to check the seams');
    ui.preview = adv(select('Preview', [['128', '128 (fast)'], ['256', '256']], String(st.previewRes), (v) => { st.previewRes = Number(v); changed(); persistSoon(); }));
    ui.tools = seg(TOOLS.map(([v, l, t]) => [v, l, t]), st.tool, (v) => { st.tool = v; renderToolOptions(); draw(); persistSoon(); }, 'seg seg-sm tl-tools');
    for (const b of ui.tools.children) if (TOOLS.find((t) => t[0] === b.dataset.value)[3]) b.dataset.adv = '1';
    ui.brushSize = slider({ label: 'Size', min: 1, max: 30, step: 0.5, value: st.brush.r * 100, onInput: (v) => { st.brush.r = v / 100; draw(); } });
    ui.brushPower = slider({ label: 'Strength', min: 0.05, max: 1, step: 0.05, value: st.brush.power, onInput: (v) => { st.brush.power = v; } });
    ui.rim = slider({ label: 'Rim', min: 0, max: 1, step: 0.05, value: st.brush.rim, onInput: (v) => { st.brush.rim = v; } });
    ui.preserve = checkbox('Keep sharp ridges', st.brush.preserve, (v) => { st.brush.preserve = v; }, 'Edge-aware smoothing: softens small detail, keeps cliffs and crater rims');
    ui.undoBtn = btn('Undo', undo, { title: 'Ctrl+Z' });
    ui.redoBtn = btn('Redo', redo, { title: 'Ctrl+Y' });
    ui.clearBtn = btn('Clear edits', async () => { if (st.stamps.length && !(await confirmDialog('Remove all brush, text and image edits?'))) return; pushUndo(); st.stamps = []; st.strokeStarts = []; renderOps(); changed(); setAction('All edits removed'); });
    ui.historyBtn = btn('History', openHistory, { title: 'List of all edits: hide, show or delete single strokes' });
    const stage = el('section', { className: 'card ex-stage tl-stage' },
      el('div', { className: 'ex-row tl-bar' }, ui.view, ui.tile, ui.preview, el('span', { className: 'tl-spacer' }), status),
      canvas,
      ui.tools,
      el('div', { className: 'ex-row tl-brush' }, ui.brushSize, ui.brushPower, ui.rim, ui.preserve, el('span', { className: 'tl-spacer' }), ui.undoBtn, ui.redoBtn, ui.historyBtn, ui.clearBtn),
      el('div', { className: 'tl-statusbar', attrs: { role: 'status' } }, sbAction, sbPos, stats));

    // ---- side panel
    ui.mode = seg([['simple', 'Simple'], ['advanced', 'Advanced']], st.mode, (v) => { st.mode = v; App.store.set(MODE_KEY, v); applyMode(); });

    ui.preset = select('Type', [['custom', 'Custom'], ...Object.entries(PRESETS).map(([k, p]) => [k, p.label])], st.preset, (v) => { if (v !== 'custom') applyPreset(v); });
    ui.seed = H.numberField({ label: 'Seed', min: 0, max: 99999999, value: st.params.seed, width: 96, onChange: (v) => { st.params.seed = v; changed(); } });
    const dice = btn('🎲 New', () => { st.params.seed = (Math.random() * 1e8) | 0; ui.seed.set(st.params.seed); if (PRESETS[st.preset]?.craters) { applyPreset(st.preset); return; } changed(); }, { title: 'Random seed' });
    ui.res = adv(select('Final size', RESOLUTIONS.map((r) => [String(r), `${r}×${r}`]), String(st.params.resolution), (v) => { st.params.resolution = Number(v); changed({ finalDelay: 0 }); }));

    // simple sliders map onto several parameters
    ui.sHeight = slider({ label: 'Height', min: 0.02, max: 0.38, step: 0.01, value: st.params.relief, onInput: (v) => { st.params.relief = v; ui.params.relief?.set(v); sliding(); } });
    ui.sSize = slider({ label: 'Feature size', min: 1, max: 10, step: 1, value: 11 - st.params.scale, title: 'Large = few big features, small = many small ones', onInput: (v) => { st.params.scale = 11 - v; ui.params.scale?.set(st.params.scale); markCustom(); sliding(); } });
    ui.sDetail = slider({ label: 'Detail', min: 0, max: 1, step: 0.05, value: (st.params.octaves - 2) / 5, onInput: (v) => { st.params.octaves = Math.round(2 + v * 5); st.params.roughness = +(0.35 + v * 0.3).toFixed(2); ui.params.octaves?.set(st.params.octaves); ui.params.roughness?.set(st.params.roughness); markCustom(); sliding(); } });
    ui.sWeather = slider({ label: 'Weathering', min: 0, max: 1, step: 0.05, value: st.weather.amount, onInput: (v) => { st.weather.amount = v; setSimpleWeathering(); renderPasses(); sliding(); } });
    ui.sStyle = select('Erosion by', [['mixed', 'Water + wind'], ['water', 'Water'], ['wind', 'Wind'], ['thermal', 'Rockfall']], st.weather.style, (v) => { st.weather.style = v; setSimpleWeathering(); renderPasses(); changed(); });
    ui.sSea = param('seaLevel', 'Sea level', 0, 0.8, 0.01, { title: 'Floods everything below this share of the height range (flat water for PICO-8)' });

    const gTerrain = group('Terrain',
      row(ui.preset), row(ui.seed, dice, ui.res),
      el('div', { className: 'tl-simple' }, ui.sHeight, ui.sSize, ui.sDetail, ui.sWeather, row(ui.sStyle)),
      ui.sSea,
      row(btn('Import heightmap…', () => importHeightmap(false), { title: 'An image (brightness = height) becomes the base terrain, made seamless' }), btn('From library…', () => importHeightmap(true))));

    ui.importBox = el('div', { className: 'tl-import' });
    const gImport = group('Imported heightmap', ui.importBox);
    ui.importGroup = gImport;

    const gGen = adv(group('Generation',
      param('base', 'Base level', 0.1, 0.9, 0.01), param('relief', 'Profile height', 0.01, 0.38, 0.01), param('scale', 'Frequency', 1, 10, 1),
      param('octaves', 'Octaves', 1, 7, 1), param('roughness', 'Persistence', 0.2, 0.8, 0.01), param('ridges', 'Ridges', 0, 1, 0.01),
      param('warp', 'Domain warp', 0, 0.09, 0.005), param('flatness', 'Flat lowlands', 0, 1, 0.01)));

    const gShape = adv(group('Shape (after erosion)',
      row(checkbox('Invert', !!st.params.invert, (v) => { st.params.invert = v ? 1 : 0; changed(); })),
      param('gamma', 'Curve', 0.4, 2.5, 0.05, { title: '<1: broad highlands, >1: deep valleys' }),
      param('terraces', 'Terraces', 0, 16, 1, { title: 'Steps; 0 = off' }), param('terraceSoft', 'Step softness', 0, 1, 0.05)));
    ui.invert = gShape.querySelector('input[type="checkbox"]');

    // erosion stack (advanced)
    ui.eDraft = {};
    const draftSlider = (k, label, min, max, step) => (ui.eDraft[k] = slider({ label, min, max, step, value: st.erosionDraft[k], onInput: (v) => { st.erosionDraft[k] = v; ui.ePreset.set('custom'); } }));
    ui.ePreset = select('Preset', [['custom', 'Custom'], ['mixed', 'Mixed'], ['water', 'Water channels'], ['wind', 'Wind-swept'], ['thermal', 'Talus / rockfall']], 'mixed', (v) => { if (EROSION[v]) { Object.assign(st.erosionDraft, EROSION[v]); for (const k of EROSION_KEYS) ui.eDraft[k].set(st.erosionDraft[k]); } });
    ui.passes = el('div', { className: 'tl-ops' });
    const applyPass = (append) => {
      const pass = { id: nextId(), ...st.erosionDraft };
      pushUndo();
      if (append) { if (st.passes.length >= 6) { toast('At most 6 stacked passes.'); undoStack.pop(); return; } st.passes.push(pass); } else if (st.passes.length) st.passes[st.passes.length - 1] = pass; else st.passes.push(pass);
      renderPasses(); changed();
    };
    const gErosion = adv(group('Erosion passes',
      row(ui.ePreset),
      draftSlider('erosion', 'Water', 0, 1, 0.05), draftSlider('droplets', 'Droplets', 0, 48000, 1000), draftSlider('wind', 'Wind', 0, 1, 0.05),
      draftSlider('windDirection', 'Wind dir °', 0, 355, 5), draftSlider('windSteps', 'Wind steps', 0, 28, 1), draftSlider('thermal', 'Rockfall', 0, 18, 1),
      row(btn('Apply / replace', () => applyPass(false), { primary: true, title: 'Replace the last pass with these settings' }), btn('+ Stack', () => applyPass(true), { title: 'Weather the terrain again' })),
      ui.passes));

    ui.material = select('Material', MATERIALS, st.params.palette, (v) => { st.params.palette = v; markCustom(); changed(); });
    ui.params ||= {};
    const sun = slider({ label: 'Sun direction', min: 0, max: 360, step: 5, value: st.params.azimuth, onInput: (v) => { st.params.azimuth = v; sliding(true); } });
    ui.params.azimuth = sun;
    const gLook = group('Look',
      row(ui.material), sun,
      param('elevation', 'Sun height', 10, 85, 1, { preset: false }), param('shadow', 'Shadows', 0, 1, 0.05, { preset: false }),
      adv(el('div', { className: 'tl-adv-look' },
        param('shadowReach', 'Shadow length', 0, 64, 4, { preset: false }), param('ambient', 'Ambient', 0.15, 1, 0.05, { preset: false }),
        param('normalScale', 'Relief light', 0.2, 6, 0.1, { preset: false }), param('colorVariation', 'Variation', 0, 1, 0.05, { preset: false }), param('rock', 'Rock on slopes', 0, 1, 0.05, { preset: false }))));

    // text / image options (shown with their tool)
    ui.textBox = el('div', { className: 'ex-preset-params' });
    ui.imageBox = el('div', { className: 'ex-preset-params' });
    ui.gText = group('Text stamp', ui.textBox);
    ui.gImage = group('Image stamp', ui.imageBox);
    buildBitmapControls();

    // PICO-8 output
    const pickLibPalette = async (v) => {
      if (v === 'library') {
        const a = await S.pickAsset({ title: 'Palette for the PICO-8 map', kind: 'palette', allowImport: false });
        if (!a) return false;
        Object.assign(st.pico, { palColors: a.colors.map((c, i) => (c == null ? i : c)), palFades: null, palName: a.name });
      } else if (v === 'libimg') {
        const a = await S.pickAsset({ title: 'Image whose palette (and fades) the PICO-8 map uses' });
        if (!a) return false;
        Object.assign(st.pico, { palColors: S.normPal(a.pal), palFades: a.meta?.fades ? { dark: a.meta.fades.dark || null, bright: a.meta.fades.bright || null } : null, palName: a.name });
      }
      return true;
    };
    ui.picoColors = select('Colors', [['auto16', 'Best 16 of 32'], ['auto12', 'Best 12 of 32'], ['auto8', 'Best 8 of 32'], ['auto4', 'Best 4 of 32'], ['std', 'Standard 16'],
      ...S.paletteSources().map((s) => [`src:${s.id}`, `${s.label} (live)`]), ['library', 'Library palette…'], ['libimg', 'Library image palette…']], st.pico.colors, async (v) => {
      if (!(await pickLibPalette(v))) { ui.picoColors.set(st.pico.colors); return; }
      st.pico.colors = v; lastPicoPal = null; refreshPico(); persistSoon();
      if (shown) setAction(`PICO-8 colors: ${pico8().from}`);
    });
    ui.picoShade = select('Shading', [['lit', 'Lit colors (nearest)'], ['fades', 'Fade tables (color × light)']], st.pico.shade, (v) => { st.pico.shade = v; renderPicoOptions(); refreshPico(); persistSoon(); });
    ui.picoDepth = slider({ label: 'Shadow depth', min: 0, max: 1, step: 0.05, value: st.pico.depth, title: 'How far full shadow goes into the dark fade', onInput: (v) => { st.pico.depth = v; refreshPico(); } });
    ui.picoLift = slider({ label: 'Highlights', min: 0, max: 1, step: 0.05, value: st.pico.lift, title: 'How far full light goes into the bright fade', onInput: (v) => { st.pico.lift = v; refreshPico(); } });
    ui.dither = select('Dither', [['none', 'None'], ['ordered', 'Ordered (4×4)'], ['diffuse', 'Error diffusion']], st.pico.dither, (v) => { st.pico.dither = v; refreshPico(); persistSoon(); });
    ui.ditherAmt = slider({ label: 'Dither amount', min: 0, max: 1, step: 0.05, value: st.pico.strength, onInput: (v) => { st.pico.strength = v; refreshPico(); } });
    ui.swatches = el('div', { className: 'tl-swatches' });
    ui.picoNote = el('p', { className: 'muted tl-note' });
    const exp = (label, fn, title) => { const b = btn(label, fn, { title }); (ui.exports ||= []).push(b); return b; };
    const gPico = group('PICO-8 output (128×128)',
      row(ui.picoColors), row(ui.picoShade), ui.picoDepth, ui.picoLift, row(ui.dither), ui.ditherAmt, ui.swatches, ui.picoNote,
      row(exp('Save to library', toLibrary, 'Color map and 16-level height map as 128×128 library images'), exp('Export .p8', exportCart, 'Cart: colors in the sprite sheet, heights at 0x2000, scrolling viewer')),
      row(exp('Open in Pixel Studio', () => openColorIn('studio-open'), 'Edit the 128×128 color map (with its palette and fades) in Pixel Studio'),
        exp('Palette & Fades preview', () => openColorIn('palette-preview'), 'Use the color map as the fade preview image (sets the palette)')),
      row(exp('Color PNG', () => exportPico('color')), exp('Height PNG', () => exportPico('height'), '16 height levels as palette indices (sget() = height)')),
      adv(row(exp('Height .bin', () => exportPico('bin'), '128×128 bytes, 256 height levels (for a data cart table)'))),
      el('p', { className: 'muted tl-note', textContent: 'Every output tiles seamlessly. Exports use the final render, not the preview.' }));

    const gFiles = adv(group('Full resolution & scene',
      row(exp('Height PNG', () => exportFull('height')), exp('Lit PNG', () => exportFull('color')), exp('Albedo PNG', () => exportFull('albedo')), exp('Height RAW', () => exportFull('raw'))),
      row(btn('Save scene…', () => download(sceneJson(), `${baseName()}_scene.json`, 'application/json')), btn('Load scene…', openSceneFile),
        btn('Reset', async () => { if (!(await confirmDialog('Reset all settings and remove every edit?'))) return; pushUndo(true); Object.assign(st, { params: { ...DEFAULTS }, stamps: [], passes: [], strokeStarts: [], preset: 'custom' }); syncControls(); renderOps(); renderPasses(); syncImportUi(); changed(); }))));

    const controls = el('section', { className: 'card ex-controls tl-controls' },
      el('div', { className: 'ex-row' }, ui.mode, el('span', { className: 'muted', textContent: 'Simple shows the essentials' })),
      gTerrain, gImport, ui.gText, ui.gImage, gLook, gPico, gGen, gShape, gErosion, gFiles);
    ui.controls = controls;
    ui.panel = el('div', { className: 'ex-split tl-split' }, stage, controls);

    renderToolOptions(); renderOps(); renderPasses(); syncImportUi(); renderUndo(); applyMode();
    return ui.panel;
  }

  function buildBitmapControls() {
    const { slider, select, btn, row } = H;
    const t = st.text, im = st.image;
    const ta = el('textarea', { className: 'tl-text', rows: 2, value: t.text, spellcheck: false, attrs: { 'aria-label': 'Text' } });
    ta.addEventListener('input', () => { t.text = ta.value; updateLastBitmap(); persistSoon(); });
    const common = (o, after) => [
      slider({ label: 'Size', min: 0.05, max: 1, step: 0.01, value: o.size, title: 'Width as a share of the tile (Alt+wheel on the map)', onInput: (v) => { o.size = v; after(); } }),
      slider({ label: 'Angle', min: -180, max: 180, step: 5, value: o.angle, onInput: (v) => { o.angle = v; after(); } }),
      slider({ label: 'Depth', min: -1, max: 1, step: 0.05, value: o.depth, title: '+ raises (emboss), − carves (engrave)', onInput: (v) => { o.depth = v; after(); } }),
      select('Mode', [['add', 'Add to the terrain'], ['plateau', 'Flat plateau']], o.mode, (v) => { o.mode = v; after(); }),
      H.checkbox('Weathered by erosion', o.weathered, (v) => { o.weathered = v; after(); }, 'Off: the stamp goes on after erosion and stays crisp'),
    ];
    const tSliders = common(t, updateLastBitmap);
    const iSliders = common(im, updateLastBitmap);
    const tBevel = slider({ label: 'Bevel', min: 0, max: 1, step: 0.05, value: t.bevel, title: 'Soft edges', onInput: (v) => { t.bevel = v; updateLastBitmap(); } });
    const iBevel = slider({ label: 'Bevel', min: 0, max: 1, step: 0.05, value: im.bevel, onInput: (v) => { im.bevel = v; setImageBitmap(); updateLastBitmap(); } });
    // font: any installed family (type to search), the 3x5 pixel font or a generic family
    const PIXEL = 'Pixel (3×5)';
    if (['sans', 'serif', 'mono'].includes(t.font)) t.font = { sans: 'system-ui', serif: 'Georgia', mono: 'Consolas' }[t.font];
    const listId = `tlFonts${nextId()}`;
    const dl = el('datalist', { id: listId });
    const fontIn = el('input', { type: 'text', className: 'tl-font', value: t.font === 'pixel' ? PIXEL : t.font, spellcheck: false, attrs: { list: listId, 'aria-label': 'Font', placeholder: 'Font name' } });
    const preview = () => {
      ta.style.fontFamily = t.font === 'pixel' ? 'monospace' : `${cssFamily(t.font)}, sans-serif`;
      ta.style.fontWeight = t.font === 'pixel' ? '' : String(t.weight); ta.style.fontStyle = t.italic && t.font !== 'pixel' ? 'italic' : '';
      fontIn.style.fontFamily = ta.style.fontFamily;
    };
    const setFont = () => { const v = fontIn.value.trim(); if (!v) return; t.font = v === PIXEL ? 'pixel' : v; preview(); updateLastBitmap(); persistSoon(); };
    fontIn.addEventListener('change', setFont);
    fontIn.addEventListener('input', () => { if ([PIXEL, ...GENERIC, ...fonts()].includes(fontIn.value)) setFont(); });
    ui.fontCount = el('span', { className: 'muted tl-note' });
    ui.fillFonts = () => { dl.replaceChildren(...[PIXEL, ...GENERIC, ...fonts()].map((f) => el('option', { value: f }))); ui.fontCount.textContent = `${fonts().length} fonts`; };
    const allFonts = btn('All system fonts…', loadAllFonts, { title: 'List every installed font (the browser asks for permission once)' });
    const weight = select('Weight', [['300', 'Light'], ['400', 'Regular'], ['700', 'Bold'], ['900', 'Black']], String(t.weight), (v) => { t.weight = Number(v); preview(); updateLastBitmap(); persistSoon(); });
    const italic = H.checkbox('Italic', t.italic, (v) => { t.italic = v; preview(); updateLastBitmap(); persistSoon(); });
    const font = el('div', { className: 'ex-preset-params' }, el('label', { className: 'field tl-font-field' }, el('span', { textContent: 'Font' }), fontIn), dl, row(weight, italic), row(allFonts, ui.fontCount));
    ui.fillFonts(); preview();
    const use = select('Height from', [['auto', 'Auto (alpha or brightness)'], ['bright', 'Brightness'], ['dark', 'Darkness'], ['alpha', 'Alpha']], im.use, (v) => { im.use = v; setImageBitmap(); updateLastBitmap(); });
    ui.imageName = el('span', { className: 'muted' });
    ui.textBox.append(ta, font, ...tSliders, tBevel, el('p', { className: 'muted tl-note', textContent: 'Click on the map to place. Changes apply to the text placed last; click again for another.' }));
    ui.imageBox.append(row(btn('Load image / SVG…', loadImageFile, { primary: true }), btn('From library…', loadImageAsset)), ui.imageName, row(use), ...iSliders, iBevel,
      el('p', { className: 'muted tl-note', textContent: 'Bright (or opaque) parts become high. Click on the map to place; changes apply to the image placed last.' }));
    ui.bitmapControls = () => {
      ui.imageName.textContent = im.name ? `${im.name}${st.bitmaps[im.bmp] ? ` · ${st.bitmaps[im.bmp].w}×${st.bitmaps[im.bmp].h}` : ''}` : 'No image loaded';
      tSliders[0].set(t.size); iSliders[0].set(im.size);
    };
    ui.bitmapControls();
  }

  function renderToolOptions() {
    setAction(idleText());
    const bm = st.tool === 'text' || st.tool === 'image';
    for (const n of [ui.brushSize, ui.brushPower]) n.hidden = bm;
    ui.rim.hidden = st.tool !== 'crater';
    ui.preserve.hidden = st.tool !== 'smooth';
    ui.gText.hidden = st.tool !== 'text';
    ui.gImage.hidden = st.tool !== 'image';
    ui.tools.set(st.tool);
  }
  // ------------------------------------------------------------------ history window
  const TOOL_NAMES = { raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten', roughen: 'Roughen', crater: 'Crater', erode: 'Rain', protect: 'Protect' };
  /** edits grouped into strokes: [[start, end), …] in stamp order */
  function strokes() {
    const starts = [...new Set([0, ...st.strokeStarts.filter((k) => k < st.stamps.length)])].sort((a, b) => a - b), out = [];
    for (let i = 0; i < starts.length; i++) { const a = starts[i], b = i + 1 < starts.length ? starts[i + 1] : st.stamps.length; if (b > a) out.push([a, b]); }
    return out;
  }
  const strokeName = (s) => (s.tool === 'bitmap' ? `${s.src === 'text' ? 'Text' : 'Image'} ${s.label || ''}`.trim() : TOOL_NAMES[s.tool] || s.tool);
  function setStrokeOff(a, b, off) { st.stamps = st.stamps.map((s, i) => (i >= a && i < b ? { ...s, off } : s)); }
  function deleteStroke(a, b) { st.stamps.splice(a, b - a); st.strokeStarts = st.strokeStarts.filter((k) => k !== a).map((k) => (k > a ? k - (b - a) : k)); }

  let historyBody = null;
  function renderOps() {
    if (ui.historyBtn) { const n = strokes().length; ui.historyBtn.textContent = n ? `History (${n})` : 'History'; }
    if (historyBody) renderHistory();
    renderUndo();
  }
  function renderHistory() {
    const list = strokes();
    const rows = list.map(([a, b], i) => {
      const s = st.stamps[a], on = !s.off;
      const vis = el('input', { type: 'checkbox', checked: on, title: on ? 'Hide this edit' : 'Show this edit' });
      vis.addEventListener('change', () => { pushUndo(); setStrokeOff(a, b, !vis.checked); renderOps(); changed(); setAction(`${strokeName(s)} ${vis.checked ? 'shown' : 'hidden'}`); });
      const del = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', textContent: '×', title: 'Delete this edit' });
      del.onclick = () => { pushUndo(); deleteStroke(a, b); renderOps(); changed(); setAction(`${strokeName(s)} deleted`); };
      const n = st.params.resolution;
      return el('div', { className: `tl-op${on ? '' : ' tl-off'}` },
        el('label', { className: 'check' }, vis, el('span', { textContent: `${i + 1}. ${strokeName(s)}${b - a > 1 ? ` ×${b - a}` : ''}` })),
        el('span', { className: 'muted', textContent: `${Math.floor(s.x * n)}, ${Math.floor(s.y * n)}` }), del);
    }).reverse();
    const passRows = st.passes.map((p, i) => {
      const vis = el('input', { type: 'checkbox', checked: !p.off, title: 'Use this erosion pass' });
      vis.addEventListener('change', () => { pushUndo(); st.passes = st.passes.map((q, k) => (k === i ? { ...q, off: !vis.checked } : q)); renderPasses(); renderOps(); changed(); });
      return el('div', { className: `tl-op${p.off ? ' tl-off' : ''}` }, el('label', { className: 'check' }, vis, el('span', { textContent: `Erosion #${i + 1} · water ${Math.round(p.erosion * 100)}% · wind ${Math.round(p.wind * 100)}% · rockfall ${p.thermal}` })));
    });
    historyBody.replaceChildren(
      el('h4', { className: 'tl-hist-head', textContent: `Edits (${list.length}, newest first)` }),
      rows.length ? el('div', { className: 'tl-hist-list' }, ...rows) : el('p', { className: 'muted tl-note', textContent: 'No edits yet.' }),
      ...(passRows.length ? [el('h4', { className: 'tl-hist-head', textContent: 'Erosion passes (applied after the edits)' }), el('div', { className: 'tl-hist-list' }, ...passRows)] : []));
  }
  async function openHistory() {
    historyBody = el('div', { className: 'tl-history' });
    renderHistory();
    await modal({
      title: 'Terrain edits',
      body: el('div', { className: 'dialog-form' }, el('p', { className: 'muted', textContent: 'Untick an edit to hide it without losing it; × deletes it. Every change can be undone (Ctrl+Z).' }), historyBody),
      actions: [
        { label: 'Show all', onClick: () => { if (!st.stamps.some((s) => s.off)) return; pushUndo(); st.stamps = st.stamps.map((s) => (s.off ? { ...s, off: false } : s)); renderOps(); changed(); } },
        { label: 'Delete hidden', onClick: () => { if (!st.stamps.some((s) => s.off)) return; pushUndo(); for (const [a, b] of strokes().reverse()) if (st.stamps[a].off) deleteStroke(a, b); renderOps(); changed(); } },
      ],
      buttons: [{ label: 'Close', primary: true, value: true }],
    });
    historyBody = null;
  }
  function renderPasses() {
    ui.passes?.replaceChildren(...st.passes.map((p, i) => {
      const x = el('button', { type: 'button', className: 'btn btn-ghost btn-sm', textContent: '×', title: 'Remove this pass' });
      x.onclick = () => { pushUndo(); st.passes.splice(i, 1); renderPasses(); changed(); };
      return el('div', { className: `tl-op${p.off ? ' tl-off' : ''}` }, el('span', { textContent: `#${i + 1} · water ${Math.round(p.erosion * 100)}% · wind ${Math.round(p.wind * 100)}% · rockfall ${p.thermal}${p.off ? ' (off)' : ''}` }), x);
    }));
    if (ui.passes && !st.passes.length) ui.passes.append(el('p', { className: 'muted tl-note', textContent: 'No erosion. Pick a preset and Apply.' }));
  }
  function renderUndo() { if (ui.undoBtn) { ui.undoBtn.disabled = !undoStack.length; ui.redoBtn.disabled = !redoStack.length; ui.clearBtn.disabled = !st.stamps.length; } }
  function renderPicoInfo() {
    if (!ui.swatches) return;
    if (!shown) { ui.swatches.replaceChildren(); return; }
    const o = pico8();
    ui.swatches.replaceChildren(...o.pal.map((c) => el('span', { className: 'tl-sw', title: `PICO-8 color ${c}`, style: `background:rgb(${rgbOf(c).join(',')})` })),
      el('span', { className: 'muted tl-note', textContent: ` ${o.pal.length} color${o.pal.length === 1 ? '' : 's'}` }));
    ui.swatches.title = `Screen palette: pal({[0]=${pal16(o.pal).join(',')}},1)`;
    const fadeInfo = o.fades ? ` · fades: ${[o.fades.dark && 'dark', o.fades.bright && 'bright'].filter(Boolean).join(' + ')}` : '';
    ui.picoNote.textContent = `${o.from}${fadeInfo}${o.note ? ` · ${o.note}` : ''}`;
  }
  function renderPicoOptions() {
    if (!ui.picoShade) return;
    const fades = st.pico.shade === 'fades';
    ui.picoDepth.hidden = !fades; ui.picoLift.hidden = !fades; ui.ditherAmt.hidden = fades;
  }
  function syncImportUi() {
    if (!ui.importBox) return;
    const s = st.importSrc, on = !!st.params.importId;
    ui.importGroup.hidden = !on;
    if (!on) { ui.importBox.replaceChildren(); return; }
    const { slider, select, btn, row } = H;
    const nodes = [el('p', { className: 'muted tl-note', textContent: `${s?.name || 'Imported heightmap'} · made seamless` })];
    if (s) {
      nodes.push(row(select('Seams', [['blend', 'Cross-fade (keeps features)'], ['edges', 'Edge correction (keeps layout)'], ['mirror', 'Mirror 2×2']], s.method, (v) => { clearTimeout(ui.retileTimer); retile({ method: v }); })));
      nodes.push(slider({ label: 'Blend width', min: 0.05, max: 0.5, step: 0.05, value: s.blend, onInput: (v) => { clearTimeout(ui.retileTimer); ui.retileTimer = setTimeout(() => retile({ blend: v }), 200); } }));
    }
    nodes.push(slider({ label: 'Noise ↔ map', min: 0, max: 1, step: 0.05, value: st.params.importMix, title: '0 = generated noise only, 1 = the imported map only', onInput: (v) => { st.params.importMix = v; sliding(); } }));
    nodes.push(row(btn('Remove', removeImport)));
    ui.importBox.replaceChildren(...nodes);
  }
  function syncControls() {
    const p = st.params;
    for (const [k, s] of Object.entries(ui.params || {})) if (p[k] !== undefined) s.set(p[k]);
    ui.seed?.set(p.seed); ui.res?.set(String(p.resolution)); ui.material?.set(p.palette); ui.preset?.set(st.preset);
    ui.sHeight?.set(p.relief); ui.sSize?.set(11 - p.scale); ui.sDetail?.set(Math.min(1, Math.max(0, (p.octaves - 2) / 5)));
    ui.sWeather?.set(st.weather.amount); ui.sStyle?.set(st.weather.style);
    if (ui.invert) ui.invert.checked = !!p.invert;
  }
  function applyMode() {
    const advanced = st.mode === 'advanced';
    ui.controls.classList.toggle('tl-advanced', advanced);
    ui.panel.querySelectorAll('[data-adv]').forEach((n) => { n.classList.toggle('tl-hidden', !advanced); });
    ui.controls.querySelectorAll('.tl-simple').forEach((n) => { n.hidden = advanced; });
    if (!advanced && TOOLS.find((t) => t[0] === st.tool)?.[3]) { st.tool = 'raise'; renderToolOptions(); }
    ui.mode.set(st.mode);
  }

  // ------------------------------------------------------------------ register with Extra Tools
  (window.P8ExtraTools ||= []).push({
    id: 'terrain', label: 'Terrain Lab',
    desc: 'Seamless terrain for PICO-8: noise or imported heightmaps, brushes, text and image stamps, erosion, baked light → 128×128 color + height maps (port of terrain_lab_v0_4).',
    create(helpers) {
      const panel = build(helpers);
      // "Open in" entries for library assets
      S.registerConsumer({ id: 'terrain-heightmap', label: 'Terrain Lab heightmap', kinds: ['image'], open: (a) => { helpers.show(); importHeightmap(true, a); } });
      S.registerConsumer({ id: 'terrain-stamp', label: 'Terrain Lab stamp', kinds: ['image'], open: async (a) => { helpers.show(); st.tool = 'image'; renderToolOptions(); await loadImageAsset(a); } });
      S.registerConsumer({
        id: 'terrain-palette', label: 'Terrain Lab PICO-8 colors', kinds: ['palette', 'image'],
        open: (a) => {
          helpers.show();
          if (a.kind === 'palette') Object.assign(st.pico, { colors: 'library', palColors: a.colors.map((c, i) => (c == null ? i : c)), palFades: null, palName: a.name });
          else Object.assign(st.pico, { colors: 'libimg', palColors: S.normPal(a.pal), palFades: a.meta?.fades ? { dark: a.meta.fades.dark || null, bright: a.meta.fades.bright || null } : null, palName: a.name });
          ui.picoColors.set(st.pico.colors); st.view = 'pico'; ui.view.set('pico'); if (shown) refreshPico(); persistSoon();
          setAction(`PICO-8 colors from ${a.name}`);
        },
      });
      // the first render waits for the saved scene (IndexedDB), and only runs once the tab is open
      let loaded = false, started = false;
      const start = () => { if (started || !loaded) return; started = true; changed(); };
      S.kv.get(KV).then((d) => { if (!restoreSaved(d)) { setSimpleWeathering(); renderPasses(); } else { syncControls(); renderToolOptions(); renderOps(); renderPasses(); syncImportUi(); applyMode(); ui.view.set(st.view); ui.tile.set(st.tile); ui.picoColors.set(st.pico.colors); ui.picoShade.set(st.pico.shade); ui.picoDepth.set(st.pico.depth); ui.picoLift.set(st.pico.lift); renderPicoOptions(); ui.dither.set(st.pico.dither); ui.ditherAmt.set(st.pico.strength); ui.bitmapControls(); } }).catch(() => {}).finally(() => { loaded = true; if (helpers.isActive()) start(); });
      return {
        panel,
        // palettes from other tools are read live: refresh them whenever the tab is shown again
        draw: () => { start(); if (shown && (st.pico.colors.startsWith('src:') || st.pico.shade === 'fades')) refreshPico(); draw(); },
        key(e) {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return true; }
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return true; }
          if (e.ctrlKey || e.metaKey || e.altKey) return false;
          const keys = { r: 'raise', l: 'lower', s: 'smooth', f: 'flatten', g: 'roughen', c: 'crater', t: 'text', i: 'image' };
          const k = keys[e.key.toLowerCase()];
          if (k) { st.tool = k; renderToolOptions(); draw(); return true; }
          if (e.key === '[' || e.key === ']') { st.brush.r = Math.min(0.3, Math.max(0.01, st.brush.r * (e.key === ']' ? 1.15 : 1 / 1.15))); ui.brushSize.set(st.brush.r * 100); draw(); return true; }
          return false;
        },
      };
    },
  });
})();

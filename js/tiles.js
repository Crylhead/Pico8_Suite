// js/tiles.js
// Tile Maker workspace: port of tilemaker/ui (main window, views, tile editor, projects),
// integrated with the palette tool (custom palette, level mapping, fade preview).

'use strict';

(() => {
  const App = window.P8App;
  const T = P8Tiles;
  const { rgbOf, fullPalette, fullPaletteRgb, autoAssignMapping, renderImageFade, sliderToStep, encodeIndexedPng, isValidPico } = P8;
  const { el, $, modal, showMessage, confirmDialog, toast, download, pickFile, decodeImage, formField, sanitizeFilename, store } = App;

  const KEYS = { settings: 'p8pal.tileSettings', recent: 'p8pal.recentTileProjects' };
  const MAX_RECENT = 5;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  const BUDGET = T.VRAM_TILE_BUDGET;

  const saved = store.get(KEYS.settings, {}) || {};

  const tm = {
    name: '',                 // base name of the imported image / project
    original: null,           // RGB image as imported (left view)
    source: null,             // converted 16-color image used for analysis
    colorMode: ['pico8', 'levels', 'nearest'].includes(saved.colorMode) ? saved.colorMode : 'pico8',
    dither: !!saved.dither,
    mapping: Array.isArray(saved.mapping) && saved.mapping.length === 16 ? saved.mapping.map((p) => (isValidPico(p) ? p : null)) : null,
    threshold: Number.isFinite(saved.threshold) ? saved.threshold : 0,
    vpW: saved.vpW || 16,
    vpH: saved.vpH || 16,
    result: null,             // {tiles, map, mapW, mapH, recon, mae, maxAbs}
    vp: null,                 // viewport analysis
    view: 'reconstructed',
    showSelection: false,
    selected: -1,
    zoom: 1,
    panX: 0,
    panY: 0,
    fadeOn: false,
    modified: false,          // tileset edited / auto-generated since last build
    dirty: false,             // unsaved work
    pending: false,           // settings changed since last build
    stale: false,             // custom palette changed since last build
  };

  const dom = {
    colorMode: $('#tmColorMode'),
    mappingBtn: $('#tmMappingBtn'),
    dither: $('#tmDither'),
    thrRange: $('#tmThresholdRange'),
    thr: $('#tmThreshold'),
    rebuild: $('#tmRebuild'),
    autoGen: $('#tmAutoGen'),
    editTiles: $('#tmEditTiles'),
    notice: $('#tmNotice'),
    viewSeg: $('#tmViewSeg'),
    showSel: $('#tmShowSel'),
    fadeWrap: $('#tmFadeWrap'),
    fadeOn: $('#tmFadeOn'),
    fadeSlider: $('#tmFadeSlider'),
    fadeReadout: $('#tmFadeReadout'),
    zoomLabel: $('#tmZoomLabel'),
    origFrame: $('#tmOrigFrame'),
    outFrame: $('#tmOutFrame'),
    origCanvas: $('#tmOrigCanvas'),
    outCanvas: $('#tmOutCanvas'),
    outTitle: $('#tmOutTitle'),
    drop: $('#tmDrop'),
    tileset: $('#tmTilesetCanvas'),
    tilesetMsg: $('#tmTilesetMsg'),
    tilesetCount: $('#tmTilesetCount'),
    heatLegend: $('#tmHeatLegend'),
    vpW: $('#tmVpW'),
    vpH: $('#tmVpH'),
    warning: $('#tmWarning'),
    progress: $('#tmProgress'),
    progressText: $('#tmProgressText'),
    progressBar: $('#tmProgressBar'),
    progressCancel: $('#tmProgressCancel'),
    recentList: $('#recentTilesList'),
    stats: {
      compat: $('#tmCompat'), tiles: $('#tmTiles'), vpMax: $('#tmVpMax'), vpMean: $('#tmVpMean'), imgSize: $('#tmImgSize'),
      grid: $('#tmGrid'), mae: $('#tmMae'), vp: $('#tmVp'), worst: $('#tmVpWorst'),
    },
  };

  const usesCustomPalette = () => tm.colorMode !== 'pico8';

  function persistSettings() {
    store.set(KEYS.settings, {
      colorMode: tm.colorMode, dither: tm.dither, mapping: tm.mapping, threshold: tm.threshold, vpW: tm.vpW, vpH: tm.vpH,
    });
  }

  /** Palette the tiles are exported in: slot index -> rgb (+ pico indices for pal()). */
  function exportPalette() {
    if (!usesCustomPalette()) return { rgb: T.PICO8_STD_RGB, picos: null };
    const custom = App.state.custom;
    return { rgb: fullPaletteRgb(custom), picos: fullPalette(custom) };
  }

  // ------------------------------------------------------------------ //
  // Offscreen images                                                   //
  // ------------------------------------------------------------------ //

  function imageCanvas(img) {
    const c = document.createElement('canvas');
    c.width = img.w;
    c.height = img.h;
    c.getContext('2d').putImageData(T.toImageData(img), 0, 0);
    return c;
  }

  const cache = { orig: null, recon: null, heat: null, fadeSlots: null };

  function invalidate(...keys) {
    for (const k of keys) cache[k] = null;
  }

  function fadeActive() {
    return tm.fadeOn && usesCustomPalette() && tm.result && App.state.fade && tm.view === 'reconstructed';
  }

  function outputSource() {
    const r = tm.result;
    if (!r) return null;
    if (tm.view === 'heatmap') {
      if (!tm.vp) return null;
      if (!cache.heat) cache.heat = imageCanvas(T.heatmapImage(tm.vp, r.mapW, r.mapH));
      return cache.heat;
    }
    if (fadeActive()) {
      const pal = fullPaletteRgb(App.state.custom);
      if (!cache.fadeSlots) cache.fadeSlots = T.imageToSlots(r.recon, pal);
      const { image } = renderImageFade(cache.fadeSlots, r.recon.w, r.recon.h, pal, App.state.fade, sliderToStep(App.state.slider));
      const c = document.createElement('canvas');
      c.width = r.recon.w;
      c.height = r.recon.h;
      c.getContext('2d').putImageData(image, 0, 0);
      return c;
    }
    if (!cache.recon) cache.recon = imageCanvas(r.recon);
    return cache.recon;
  }

  function originalSource() {
    if (!tm.original) return null;
    if (!cache.orig) cache.orig = imageCanvas(tm.original);
    return cache.orig;
  }

  // ------------------------------------------------------------------ //
  // Synchronised zoom/pan views                                        //
  // ------------------------------------------------------------------ //

  const views = [
    { frame: dom.origFrame, canvas: dom.origCanvas, source: originalSource, ox: 0, oy: 0 },
    { frame: dom.outFrame, canvas: dom.outCanvas, source: outputSource, ox: 0, oy: 0 },
  ];

  function contentSize() {
    const a = tm.original;
    const b = tm.result?.recon;
    return { w: Math.max(a?.w || 0, b?.w || 0), h: Math.max(a?.h || 0, b?.h || 0) };
  }

  function clampPan() {
    const { w, h } = contentSize();
    const vw = dom.outFrame.clientWidth || dom.origFrame.clientWidth;
    const vh = dom.outFrame.clientHeight || dom.origFrame.clientHeight;
    tm.panX = Math.max(0, Math.min(tm.panX, w * tm.zoom - vw));
    tm.panY = Math.max(0, Math.min(tm.panY, h * tm.zoom - vh));
  }

  function drawViews() {
    clampPan();
    for (const v of views) drawView(v);
    dom.zoomLabel.textContent = `${Math.round(tm.zoom * 100)}%`;
  }

  let outSourceCache = null;
  function drawView(v, src = v.source()) {
    if (v === views[1]) outSourceCache = src;
    const dpr = window.devicePixelRatio || 1;
    const cw = v.frame.clientWidth;
    const ch = v.frame.clientHeight;
    if (!cw || !ch) return;
    const W = Math.round(cw * dpr);
    const H = Math.round(ch * dpr);
    if (v.canvas.width !== W || v.canvas.height !== H) { v.canvas.width = W; v.canvas.height = H; }
    const ctx = v.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (!src) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = tm.zoom;
    const sw = src.width * z;
    const sh = src.height * z;
    v.ox = sw < cw ? (cw - sw) / 2 : -tm.panX;
    v.oy = sh < ch ? (ch - sh) / 2 : -tm.panY;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, v.ox, v.oy, sw, sh);

    const r = tm.result;
    if (tm.showSelection && tm.selected >= 0 && r) {
      const s = 8 * z;
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      for (let i = 0; i < r.map.length; i++) {
        if (r.map[i] !== tm.selected) continue;
        const x = v.ox + (i % r.mapW) * s;
        const y = v.oy + Math.floor(i / r.mapW) * s;
        if (x > cw || y > ch || x + s < 0 || y + s < 0) continue;
        ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
      }
    }
  }

  function setZoom(z, anchor = null) {
    const { w, h } = contentSize();
    if (!w) return;
    const frame = dom.outFrame;
    const cw = frame.clientWidth;
    const ch = frame.clientHeight;
    const ax = anchor ? anchor.x : cw / 2;
    const ay = anchor ? anchor.y : ch / 2;
    const old = tm.zoom;
    const oldOx = w * old < cw ? (cw - w * old) / 2 : -tm.panX;
    const oldOy = h * old < ch ? (ch - h * old) / 2 : -tm.panY;
    const ix = (ax - oldOx) / old;
    const iy = (ay - oldOy) / old;
    tm.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    tm.panX = ix * tm.zoom - ax;
    tm.panY = iy * tm.zoom - ay;
    drawViews();
  }

  function zoomFit() {
    const { w, h } = contentSize();
    if (!w) return;
    const fit = Math.min(dom.outFrame.clientWidth / w, dom.outFrame.clientHeight / h);
    tm.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit >= 1 ? Math.floor(fit) : fit));
    tm.panX = 0;
    tm.panY = 0;
    drawViews();
  }

  function selectTileAt(v, clientX, clientY) {
    const r = tm.result;
    if (!r) return;
    const rect = v.frame.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - v.ox) / (8 * tm.zoom));
    const y = Math.floor((clientY - rect.top - v.oy) / (8 * tm.zoom));
    if (x < 0 || y < 0 || x >= r.mapW || y >= r.mapH) return;
    selectTile(r.map[y * r.mapW + x], x, y);
  }

  function selectTile(idx, x = null, y = null) {
    tm.selected = idx;
    drawViews();
    drawTileset();
    if (x != null) toast(`Selected tile ${idx} at position (${x}, ${y})`, 'info', 1800);
  }

  function bindView(v) {
    const pointers = new Map();
    let gesture = null;

    v.frame.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tm-drop')) return;
      if (e.button === 2) return;
      try { v.frame.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        gesture = { type: 'pan', x0: e.clientX, y0: e.clientY, px: tm.panX, py: tm.panY, moved: false };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: tm.zoom };
      }
    });
    v.frame.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (gesture.type === 'pan') {
        const dx = e.clientX - gesture.x0;
        const dy = e.clientY - gesture.y0;
        if (!gesture.moved && Math.abs(dx) + Math.abs(dy) > 4) {
          gesture.moved = true;
          v.frame.classList.add('panning');
        }
        if (gesture.moved) {
          tm.panX = gesture.px - dx;
          tm.panY = gesture.py - dy;
          drawViews();
        }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const rect = v.frame.getBoundingClientRect();
        setZoom(gesture.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0), {
          x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top,
        });
      }
    });
    const end = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture?.type === 'pan' && !gesture.moved && e.type === 'pointerup') selectTileAt(v, e.clientX, e.clientY);
      if (!pointers.size) gesture = null;
      else if (gesture?.type === 'pinch') gesture = { type: 'pan', x0: [...pointers.values()][0].x, y0: [...pointers.values()][0].y, px: tm.panX, py: tm.panY, moved: true };
      v.frame.classList.remove('panning');
    };
    v.frame.addEventListener('pointerup', end);
    v.frame.addEventListener('pointercancel', end);
    v.frame.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.tm-drop')) return;
      e.preventDefault();
      selectTileAt(v, e.clientX, e.clientY);
    });
    v.frame.addEventListener('wheel', (e) => {
      if (!contentSize().w) return;
      e.preventDefault();
      const rect = v.frame.getBoundingClientRect();
      setZoom(tm.zoom * (e.deltaY < 0 ? 1.1 : 0.9), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });
  }

  // ------------------------------------------------------------------ //
  // Tileset view                                                       //
  // ------------------------------------------------------------------ //

  const TILESET_MAX = 512;

  function drawTileset() {
    const c = dom.tileset;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#202020';
    ctx.fillRect(0, 0, c.width, c.height);
    const tiles = tm.result?.tiles || [];
    dom.tilesetCount.textContent = tiles.length ? `(${tiles.length})` : '';
    if (!tiles.length || tiles.length > TILESET_MAX) {
      dom.tilesetMsg.hidden = false;
      dom.tilesetMsg.textContent = tiles.length ? `Out of budget!\n${tiles.length} / ${TILESET_MAX} tiles` : '(no tiles)';
      return;
    }
    dom.tilesetMsg.hidden = true;
    const img = ctx.createImageData(8, 8);
    const tmp = document.createElement('canvas');
    tmp.width = 8;
    tmp.height = 8;
    const tctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < TILESET_MAX; i++) {
      const x = (i % 16) * 16;
      const y = Math.floor(i / 16) * 16;
      if (i < tiles.length) {
        const t = tiles[i];
        for (let p = 0, o = 0; p < 192; p += 3, o += 4) {
          img.data[o] = t[p]; img.data[o + 1] = t[p + 1]; img.data[o + 2] = t[p + 2]; img.data[o + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);
        ctx.drawImage(tmp, x, y, 16, 16);
      }
      ctx.strokeStyle = '#404040';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, 15, 15);
    }
    if (tiles.length > 256) {
      // Sprites beyond 255 cannot be exported: mark the budget line and dim the overflow
      ctx.fillStyle = 'rgba(255,0,0,0.25)';
      ctx.fillRect(0, 256, 256, 256);
      ctx.fillStyle = '#ff4040';
      ctx.fillRect(0, 255, 256, 2);
    }
    if (tm.selected >= 0 && tm.selected < tiles.length) {
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.strokeRect((tm.selected % 16) * 16 + 1, Math.floor(tm.selected / 16) * 16 + 1, 14, 14);
    }
  }

  dom.tileset.addEventListener('click', (e) => {
    const r = tm.result;
    if (!r) return;
    const rect = dom.tileset.getBoundingClientRect();
    const scale = dom.tileset.width / rect.width;
    const idx = Math.floor(((e.clientY - rect.top) * scale) / 16) * 16 + Math.floor(((e.clientX - rect.left) * scale) / 16);
    if (idx < r.tiles.length) selectTile(idx);
  });

  // ------------------------------------------------------------------ //
  // Stats (main_window._on_analysis_finished / _recompute_viewport_stats) //
  // ------------------------------------------------------------------ //

  function setStat(node, text, cls = '') {
    node.textContent = text;
    node.className = cls;
  }

  function renderStats() {
    const s = dom.stats;
    const r = tm.result;
    dom.warning.textContent = '';
    dom.warning.className = 'tm-warning warn';
    if (!r) {
      for (const n of Object.values(s)) setStat(n, '–', 'dim');
      return;
    }
    setStat(s.imgSize, `${tm.source.w} × ${tm.source.h}`);
    setStat(s.grid, `${r.mapW} × ${r.mapH} tiles`);
    const fits = r.tiles.length <= BUDGET;
    setStat(s.tiles, `${fits ? '✓' : '✗'} ${r.tiles.length} / ${BUDGET}`, fits ? 'ok' : 'bad');
    const maeCls = r.mae < 1 ? 'ok' : r.mae < 3 ? 'ok-soft' : r.mae < 5 ? 'warn' : 'bad';
    setStat(s.mae, `${r.mae.toFixed(3)} / ${r.maxAbs}`, maeCls);

    const vp = tm.vp;
    if (!vp) {
      for (const n of [s.vp, s.vpMax, s.vpMean, s.worst]) setStat(n, '–', 'dim');
      setStat(s.compat, fits ? '✓ YES' : '? UNKNOWN', fits ? 'ok' : 'warn');
      return;
    }
    setStat(s.vp, `requested ${tm.vpW}×${tm.vpH}, using ${vp.vw}×${vp.vh}`);
    const vpFits = vp.maxUnique <= BUDGET;
    setStat(s.vpMax, `${vpFits ? '✓' : '✗'} ${vp.maxUnique} / ${BUDGET} VRAM`, vpFits ? 'ok' : 'bad');
    setStat(s.vpMean, vp.mean.toFixed(1), vp.mean < BUDGET * 0.7 ? 'ok' : vp.mean < BUDGET * 0.9 ? 'warn' : 'bad');
    setStat(s.worst, vp.worst.length <= 3
      ? vp.worst.map(([x, y]) => `(${x},${y})`).join(', ')
      : `${vp.worst.length} locations (see heatmap)`, vpFits ? 'ok' : 'bad');

    if (fits) setStat(s.compat, '✓ YES (Direct Map)', 'ok');
    else if (vpFits) setStat(s.compat, '✓ YES (Streaming)', 'ok-soft');
    else setStat(s.compat, '✗ NO', 'bad');

    if (!vpFits) {
      dom.warning.textContent = '⚠ Viewport exceeds VRAM budget!\n'
        + `   Peak: ${vp.maxUnique} tiles (needs ${vp.maxUnique - BUDGET} fewer)\n`
        + '   → Increase tile reduction, reduce viewport size, or redesign art.';
    } else if (!fits) {
      dom.warning.textContent = `✓ Viewport fits VRAM budget (avg ${Math.round((vp.mean / BUDGET) * 100)}% usage).\n`
        + '   Streaming is viable with this configuration.';
      dom.warning.className = 'tm-warning ok';
    }
  }

  // ------------------------------------------------------------------ //
  // Controls                                                           //
  // ------------------------------------------------------------------ //

  function renderControls() {
    dom.colorMode.value = tm.colorMode;
    dom.mappingBtn.hidden = tm.colorMode !== 'levels';
    dom.dither.checked = tm.dither;
    dom.dither.disabled = tm.colorMode === 'nearest';
    if (document.activeElement !== dom.thr) dom.thr.value = tm.threshold.toFixed(1);
    dom.thrRange.value = Math.round(tm.threshold * 10);
    dom.vpW.value = tm.vpW;
    dom.vpH.value = tm.vpH;
    const has = !!tm.result;
    dom.autoGen.disabled = !has;
    dom.editTiles.disabled = !has;
    dom.rebuild.disabled = !tm.original;
    dom.rebuild.classList.toggle('pending', !!tm.original && (tm.pending || tm.stale));
    for (const b of dom.viewSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === tm.view));
    dom.outTitle.textContent = tm.view === 'heatmap' ? 'Viewport heatmap' : fadeActive() ? 'Reconstructed · fade preview' : 'Reconstructed';
    dom.heatLegend.hidden = tm.view !== 'heatmap';
    dom.showSel.checked = tm.showSelection;
    dom.fadeWrap.hidden = !usesCustomPalette();
    dom.fadeOn.checked = tm.fadeOn;
    dom.fadeSlider.disabled = !tm.fadeOn;
    dom.fadeSlider.value = App.state.slider;
    const v = App.state.slider;
    dom.fadeReadout.textContent = v === 16 ? 'Normal' : `${v < 16 ? 'Dark' : 'Bright'} · ${sliderToStep(v)}`;
    dom.drop.hidden = !!tm.original;

    const notes = [];
    if (tm.stale) notes.push('The custom palette changed since this tileset was built. Rebuild to apply it.');
    else if (tm.pending && tm.result) notes.push('Settings changed. Press Rebuild to apply them.');
    if (usesCustomPalette() && !App.state.custom.some((p) => p != null)) {
      notes.push('Your custom palette is empty. Add colors in the Palette & Fades workspace, or use the PICO-8 brightness ramp.');
    }
    dom.notice.hidden = !notes.length;
    dom.notice.textContent = notes.join(' ');
  }

  function renderAll() {
    renderControls();
    renderStats();
    drawTileset();
    drawViews();
    renderRecent();
  }

  // ------------------------------------------------------------------ //
  // Analysis                                                           //
  // ------------------------------------------------------------------ //

  function convertSource() {
    const custom = App.state.custom;
    switch (tm.colorMode) {
      case 'levels': {
        const mapping = tm.mapping || autoAssignMapping(custom);
        if (!mapping) throw new Error('The custom palette is empty. Add colors in the Palette & Fades workspace first.');
        return T.convertByLevels(tm.original, mapping.map((p) => rgbOf(p == null ? 0 : p)), tm.dither);
      }
      case 'nearest': {
        const colors = custom.filter((p) => p != null).map(rgbOf);
        if (!colors.length) throw new Error('The custom palette is empty. Add colors in the Palette & Fades workspace first.');
        return T.convertNearest(tm.original, colors);
      }
      default:
        return T.convertByLevels(tm.original, T.PICO8_LEVEL_RGB, tm.dither);
    }
  }

  let job = null;

  function showProgress(text, value) {
    dom.progress.hidden = false;
    dom.progressText.textContent = text;
    dom.progressBar.value = value;
  }

  async function rebuild({ confirmModified = true } = {}) {
    if (!tm.original) {
      toast('No image loaded', 'warn');
      return;
    }
    if (confirmModified && tm.modified) {
      const ok = await confirmDialog('Tileset Modified',
        'Rebuilding will discard all changes made to the tileset.\n\nIt is recommended to save your project first before proceeding.\n\nDo you want to continue?', 'Rebuild');
      if (!ok) return;
    }
    if (job) job.cancelled = true;

    let source;
    try {
      source = convertSource();
    } catch (e) {
      showMessage('Rebuild Error', `Failed to rebuild tiles: ${e.message}`);
      return;
    }

    const myJob = { cancelled: false };
    job = myJob;
    const builder = T.createTilesetBuilder(source, tm.threshold);
    const start = performance.now();
    let last = start;
    while (!builder.step(64)) {
      const now = performance.now();
      if (now - last > 30) {
        if (now - start > 150) showProgress(`Building tileset… ${builder.processed} / ${builder.total} tiles`, builder.processed / builder.total);
        await new Promise((r) => setTimeout(r));
        last = performance.now();
        if (myJob.cancelled) {
          if (job === myJob) { job = null; dom.progress.hidden = true; }
          return;
        }
      }
    }
    if (performance.now() - start > 150) {
      showProgress('Analyzing viewports…', 1);
      await new Promise((r) => setTimeout(r));
    }
    job = null;
    dom.progress.hidden = true;

    const r = builder.result();
    tm.source = source;
    tm.result = { ...r, recon: T.reconstruct(r.tiles, r.map, r.mapW, r.mapH) };
    Object.assign(tm.result, T.errorMetrics(source, tm.result.recon));
    tm.modified = false;
    tm.pending = false;
    tm.stale = false;
    tm.dirty = true;
    tm.selected = -1;
    invalidate('recon', 'heat', 'fadeSlots');
    recomputeViewport();
    renderAll();
    toast(`Rebuilt · ${r.tiles.length} unique tiles (threshold ${tm.threshold.toFixed(1)})`, r.tiles.length > BUDGET ? 'warn' : 'info', 2500);
  }

  function recomputeViewport() {
    const r = tm.result;
    tm.vp = r ? T.analyzeViewport(r.map, r.mapW, r.mapH, tm.vpW, tm.vpH) : null;
    invalidate('heat');
  }

  /** Called when tiles changed but the map did not (editor, auto generate). */
  function tilesChanged() {
    const r = tm.result;
    r.recon = T.reconstruct(r.tiles, r.map, r.mapW, r.mapH);
    Object.assign(r, T.errorMetrics(tm.source, r.recon));
    tm.modified = true;
    tm.dirty = true;
    invalidate('recon', 'fadeSlots');
    renderAll();
  }

  function autoGenerate() {
    const r = tm.result;
    if (!r) {
      showMessage('Error', 'No analysis result available');
      return null;
    }
    const out = T.autoGenerateTiles(r.tiles, r.map, r.mapW, r.mapH, tm.source);
    r.tiles = out.tiles;
    tilesChanged();
    return out;
  }

  // ------------------------------------------------------------------ //
  // Image import + projects                                            //
  // ------------------------------------------------------------------ //

  const baseNameOf = (fileName) => fileName.replace(/\.[^.]+$/, '') || 'tiles';

  async function importImageFile(file) {
    let data;
    try {
      data = await decodeImage(file);
    } catch {
      showMessage('Import Image', 'Failed to load image');
      return;
    }
    await importImageData(data, baseNameOf(file.name));
  }

  async function importImageData(data, name) {
    if (tm.dirty && tm.result && !(await confirmDialog('Import Image', 'Replace the current tile set? Unsaved changes will be lost.', 'Replace'))) return;
    App.setWorkspace('tiles');
    tm.name = name;
    tm.original = T.fromImageData(data);
    tm.result = null;
    tm.vp = null;
    tm.modified = false;
    tm.selected = -1;
    invalidate('orig', 'recon', 'heat', 'fadeSlots');
    renderAll();
    requestAnimationFrame(zoomFit);
    await rebuild({ confirmModified: false });
    requestAnimationFrame(zoomFit);
  }

  async function importImage() {
    const file = await pickFile('image/png,image/jpeg,image/bmp,image/gif,.png,.jpg,.jpeg,.bmp,.gif');
    if (file) importImageFile(file);
  }

  const bytesToB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function inflate(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function imageToPngB64(img) {
    return new Promise((resolve, reject) => {
      imageCanvas(img).toBlob(async (blob) => {
        if (!blob) { reject(new Error('PNG encoding failed')); return; }
        resolve(bytesToB64(new Uint8Array(await blob.arrayBuffer())));
      }, 'image/png');
    });
  }

  async function pngB64ToImage(b64) {
    if (!b64) return null;
    return T.fromImageData(await decodeImage(new Blob([b64ToBytes(b64)], { type: 'image/png' })));
  }

  /** ProjectManager.save_project format (+ web settings under metadata.web). */
  async function projectJson() {
    const r = tm.result;
    const tiles = [];
    for (const t of r.tiles) tiles.push(bytesToB64(await P8.zlibCompress(t)));
    const tileMap = [];
    for (let y = 0; y < r.mapH; y++) tileMap.push(Array.from(r.map.subarray(y * r.mapW, (y + 1) * r.mapW)));
    return JSON.stringify({
      version: '0.1.0',
      metadata: {
        threshold: tm.threshold,
        web: {
          name: tm.name,
          color_mode: tm.colorMode,
          dither: tm.dither,
          mapping: tm.mapping,
          viewport: [tm.vpW, tm.vpH],
          custom_palette: App.state.custom.slice(),
          source_image: await imageToPngB64(tm.original),
          modified: tm.modified,
        },
      },
      tiles,
      tile_map: tileMap,
      reconstructed_image: await imageToPngB64(r.recon),
      original_image: await imageToPngB64(tm.source),
    }, null, 2);
  }

  async function applyProject(text, fallbackName) {
    const p = JSON.parse(text);
    if (!p || !Array.isArray(p.tiles) || !Array.isArray(p.tile_map)) throw new Error('Not a tile project (.p8proj).');
    const tiles = [];
    for (const enc of p.tiles) {
      const t = await inflate(b64ToBytes(enc));
      if (t.length !== T.TILE_BYTES) throw new Error('Unexpected tile data size.');
      tiles.push(t);
    }
    const mapH = p.tile_map.length;
    const mapW = mapH ? p.tile_map[0].length : 0;
    const map = new Int32Array(mapW * mapH);
    p.tile_map.forEach((row, y) => row.forEach((v, x) => { map[y * mapW + x] = Math.max(0, Math.min(tiles.length - 1, v | 0)); }));

    const web = p.metadata?.web || {};
    const source = (await pngB64ToImage(p.original_image)) || T.reconstruct(tiles, map, mapW, mapH);
    const original = (await pngB64ToImage(web.source_image)) || source;

    tm.name = web.name || fallbackName;
    tm.original = original;
    tm.source = source;
    tm.threshold = Number.isFinite(p.metadata?.threshold) ? p.metadata.threshold : tm.threshold;
    if (['pico8', 'levels', 'nearest'].includes(web.color_mode)) tm.colorMode = web.color_mode;
    if (typeof web.dither === 'boolean') tm.dither = web.dither;
    if (Array.isArray(web.mapping) && web.mapping.length === 16) tm.mapping = web.mapping.map((v) => (isValidPico(v) ? v : null));
    if (Array.isArray(web.viewport)) [tm.vpW, tm.vpH] = web.viewport.map((v) => Math.max(1, Math.min(512, v | 0 || 16)));

    tm.result = { tiles, map, mapW, mapH, recon: T.reconstruct(tiles, map, mapW, mapH) };
    Object.assign(tm.result, T.errorMetrics(source, tm.result.recon));
    tm.modified = !!web.modified;
    tm.pending = false;
    tm.stale = false;
    tm.dirty = false;
    tm.selected = -1;
    invalidate('orig', 'recon', 'heat', 'fadeSlots');
    recomputeViewport();
    persistSettings();
    App.setWorkspace('tiles');
    renderAll();
    requestAnimationFrame(zoomFit);

    // A project saved with a different custom palette: offer to restore it
    const pal = Array.isArray(web.custom_palette) ? web.custom_palette.map((v) => (isValidPico(v) ? v : null)) : null;
    if (usesCustomPalette() && pal && JSON.stringify(pal) !== JSON.stringify(App.state.custom)) {
      toast('This project was made with a different custom palette. Exports use the current one.', 'warn', 5000);
    }
  }

  async function openProject() {
    const file = await pickFile('.p8proj,.json,application/json');
    if (!file) return;
    try {
      const text = await file.text();
      await applyProject(text, baseNameOf(file.name));
      addRecent(tm.name, text);
      toast(`Project loaded: ${file.name}`);
    } catch (e) {
      showMessage('Load Error', `Failed to load project.\n\n${e.message}`);
    }
  }

  async function saveProject() {
    if (!tm.result) {
      showMessage('No Project', 'No analysis result to save.');
      return;
    }
    const input = el('input', { type: 'text', value: tm.name || 'tiles', spellcheck: false });
    const name = await modal({
      title: 'Save Tile Project',
      body: el('div', { className: 'dialog-form' }, formField('Project name', input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save .p8proj', primary: true, value: () => input.value.trim() }],
      onOpen: () => input.select(),
    });
    if (!name) return;
    tm.name = name;
    const text = await projectJson();
    download(text, `${sanitizeFilename(name)}.p8proj`, 'application/json');
    addRecent(name, text);
    tm.dirty = false;
    toast(`Project saved: ${sanitizeFilename(name)}.p8proj`);
  }

  function getRecent() {
    const list = store.get(KEYS.recent, []);
    return Array.isArray(list) ? list.filter((r) => r && r.name && typeof r.data === 'string') : [];
  }

  function addRecent(name, data) {
    let list = getRecent().filter((r) => r.name !== name);
    list.unshift({ name, data, time: Date.now() });
    list = list.slice(0, MAX_RECENT);
    // Projects contain images: drop the oldest entries until they fit into localStorage
    while (list.length) {
      try {
        localStorage.setItem(KEYS.recent, JSON.stringify(list));
        break;
      } catch {
        list.pop();
      }
    }
    if (!list.length) toast('Project too large to keep in Recent Tile Projects.', 'warn');
    renderRecent();
  }

  function renderRecent() {
    const list = getRecent();
    dom.recentList.replaceChildren();
    list.forEach((r, i) => {
      const when = new Date(r.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      dom.recentList.append(el('button', { attrs: { role: 'menuitem' }, dataset: { action: 'tiles-recent', index: i }, title: r.name },
        el('span', { textContent: r.name }), el('small', { textContent: when })));
    });
    if (list.length) {
      dom.recentList.append(el('button', { attrs: { role: 'menuitem' }, dataset: { action: 'tiles-recent-clear' }, textContent: 'Clear Recent Tile Projects' }));
    }
  }

  async function openRecent(index) {
    const r = getRecent()[index];
    if (!r) return;
    try {
      await applyProject(r.data, r.name);
      addRecent(r.name, r.data);
    } catch (e) {
      showMessage('Load Error', `Failed to load project.\n\n${e.message}`);
    }
  }

  // ------------------------------------------------------------------ //
  // Exports                                                            //
  // ------------------------------------------------------------------ //

  function requireResult() {
    if (tm.result) return true;
    App.setWorkspace('tiles');
    showMessage('No Data', 'Please import and analyze an image first.');
    return false;
  }

  async function exportPico8() {
    if (!requireResult()) return;
    const { tiles, map, mapW, mapH } = tm.result;
    if (tiles.length > T.MAX_SPRITES) {
      showMessage('Too Many Tiles', `${tiles.length} tiles exceeds the PICO-8 limit of ${T.MAX_SPRITES} sprites.\n\nIncrease the tile reduction (MAE) threshold and rebuild.`);
      return;
    }
    const mode = T.cartMode(tiles.length, mapW, mapH);
    if (mode === 'too-large') {
      showMessage('Map Too Large', `Map size ${mapW}x${mapH} = ${mapW * mapH} cells exceeds maximum supported size of ${T.MAX_LARGE_MAP_CELLS} cells.\n\nPlease reduce the map size.`);
      return;
    }

    const pal = exportPalette();
    const nameInput = el('input', { type: 'text', value: `${tm.name || 'tiles'}_data`, spellcheck: false });
    const viewerCheck = el('input', { type: 'checkbox', checked: true });
    const modeText = mode === 'standard'
      ? `Standard mode: one cart with ${tiles.length} sprites in __gfx__ and the ${mapW}×${mapH} map in __map__.`
        + (mapH > 32 ? ' Map rows 32+ are stored in the shared lower half of the sprite sheet (as PICO-8 does).' : '')
      : `Large map mode (${mapW}×${mapH}): two carts. Sprites go in one, the map is stored as raw bytes (one per cell) in the sprite sheet of the other.`;
    const palText = pal.picos
      ? 'Colors are exported as your custom palette slots. The carts list the matching pal() call.'
      : 'Colors are exported as standard PICO-8 colors 0–15.';
    const res = await modal({
      title: 'Export to PICO-8',
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: modeText }),
        el('p', { className: 'muted', textContent: palText }),
        formField('Cart file name', nameInput),
        el('label', { className: 'check' }, viewerCheck, el('span', { textContent: 'Generate viewer cart (arrow keys to scroll)' }))),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Export .p8', primary: true, value: () => ({ name: nameInput.value, viewer: viewerCheck.checked }) },
      ],
      onOpen: () => nameInput.select(),
    });
    if (!res) return;

    const baseName = sanitizeFilename(res.name.replace(/\.p8$/i, '')) || 'tiles_data';
    const out = T.buildTileCarts({ tiles, map, mapW, mapH, paletteRgb: pal.rgb, palPicos: pal.picos, baseName, viewer: res.viewer });
    if (out.error) {
      showMessage('Export Failed', out.error);
      return;
    }
    out.files.forEach((f, i) => setTimeout(() => download(f.text, f.name), i * 400));
    showMessage('Export Success', `${out.summary}\n\nIf your browser asks, allow multiple downloads.`);
  }

  /** The tiles become the Map Editor's tileset (sprites 0–255), the tile map its map. */
  function sendToMapEditor() {
    if (!requireResult()) return;
    const { tiles, map, mapW, mapH } = tm.result;
    if (tiles.length > T.MAX_SPRITES) {
      showMessage('Too Many Tiles', `${tiles.length} tiles exceeds the ${T.MAX_SPRITES} sprites a map cell can name.

Increase the tile reduction (MAE) threshold and rebuild.`);
      return;
    }
    if (mapW > P8Map.MAX_SIDE || mapH > P8Map.MAX_SIDE) {
      showMessage('Map Too Large', `The Map Editor supports up to ${P8Map.MAX_SIDE}×${P8Map.MAX_SIDE} cells; this map is ${mapW}×${mapH}.`);
      return;
    }
    const pal = exportPalette();
    // map() does not draw tile 0: keep sprite 0 empty and move the tiles up by one when they fit
    const shift = tiles.length < T.MAX_SPRITES ? 1 : 0;
    const mem = T.spriteMemory(shift ? [new Uint8Array(tiles[0].length), ...tiles] : tiles, pal.rgb);
    const sheet = new Uint8Array(128 * 128);
    for (let i = 0; i < mem.length; i++) { sheet[i * 2] = mem[i] & 15; sheet[i * 2 + 1] = mem[i] >> 4; }
    window.P8MapEditor.openAsset({
      kind: 'map', name: tm.name || 'tiles', w: mapW, h: mapH, cells: Uint8Array.from(map, (v) => v + shift),
      sheet, pal: pal.picos || null, sheetName: `${tm.name || 'tiles'} (Tile Maker)`, source: 'tiles',
    });
    if (shift) toast(`Map Editor: ${mapW}×${mapH} map with ${tiles.length} tiles at sprites 1–${tiles.length} (not saved to the library yet)`);
    else toast('Map Editor: 256 tiles, so tile 0 holds a real tile; map() skips tile 0, draw those cells with spr().', 'warn', 6000);
  }

  async function exportSheet() {
    if (!requireResult()) return;
    const pal = exportPalette();
    const mem = T.spriteMemory(tm.result.tiles, pal.rgb);
    const idx = new Uint8Array(128 * 128);
    for (let i = 0; i < mem.length; i++) {
      idx[i * 2] = mem[i] & 15;
      idx[i * 2 + 1] = mem[i] >> 4;
    }
    download(await encodeIndexedPng(128, 128, idx, pal.rgb), `${sanitizeFilename(tm.name || 'tiles')}_sheet.png`);
    if (tm.result.tiles.length > T.MAX_SPRITES) toast(`Only the first ${T.MAX_SPRITES} tiles fit on the sprite sheet.`, 'warn');
  }

  async function exportReconPng() {
    if (!requireResult()) return;
    const pal = exportPalette();
    const r = tm.result.recon;
    download(await encodeIndexedPng(r.w, r.h, T.imageToSlots(r, pal.rgb), pal.rgb), `${sanitizeFilename(tm.name || 'tiles')}_tiles.png`);
  }

  async function exportAseprite(img = tm.result?.recon) {
    if (!img && !requireResult()) return;
    const bytes = await T.asepriteFile(img);
    download(new Blob([bytes], { type: 'application/octet-stream' }), `${sanitizeFilename(tm.name || 'tiles')}.aseprite`);
  }

  // ------------------------------------------------------------------ //
  // Level mapping (shared mapping dialog of the palette tool)          //
  // ------------------------------------------------------------------ //

  async function editMapping() {
    if (!App.state.custom.some((p) => p != null)) {
      showMessage('Level Mapping', 'The custom palette is empty. Add colors in the Palette & Fades workspace first.');
      return;
    }
    const mapping = await App.openMappingDialog(tm.mapping || autoAssignMapping(App.state.custom), 'Brightness Levels → Custom Palette');
    if (!mapping) return;
    tm.mapping = mapping;
    if (tm.colorMode !== 'levels') tm.colorMode = 'levels';
    persistSettings();
    App.setWorkspace('tiles');
    if (tm.original) await rebuild();
    else renderAll();
  }

  // ------------------------------------------------------------------ //
  // Tile editor (ui/tile_editor.py)                                    //
  // ------------------------------------------------------------------ //

  async function openTileEditor() {
    if (!requireResult()) return;
    const r = tm.result;
    const pal = exportPalette();
    const ed = {
      tiles: r.tiles.map((t) => t.slice()),
      idx: Math.max(0, tm.selected),
      data: null,
      undo: [],
      redo: [],
      modified: false,
      outline: false,
      brush: 7,
      erase: false,
      zoom: 40,
    };

    // Left: reconstructed image (2x), click to select tile
    const imgCanvas = el('canvas', { width: r.mapW * 16, height: r.mapH * 16 });
    const outlineBtn = el('button', { className: 'btn', type: 'button', textContent: 'Show Selection', attrs: { 'aria-pressed': 'false' } });
    const regenBtn = el('button', { className: 'btn', type: 'button', textContent: 'Regenerate Tiles' });
    // Right: pixel canvas + controls
    const pix = el('canvas', { className: 'te-pixels', width: 320, height: 320 });
    const zoomRange = el('input', { type: 'range', min: 10, max: 100, value: ed.zoom });
    const idxInput = el('input', { type: 'number', className: 'num', min: 0, max: ed.tiles.length - 1, value: ed.idx });
    const brushes = el('div', { className: 'te-brushes' });
    const eraseBtn = el('button', { className: 'btn', type: 'button', textContent: 'Erase', attrs: { 'aria-pressed': 'false' } });
    const undoBtn = el('button', { className: 'btn', type: 'button', textContent: 'Undo' });
    const redoBtn = el('button', { className: 'btn', type: 'button', textContent: 'Redo' });
    const saveBtn = el('button', { className: 'btn btn-primary', type: 'button', textContent: 'Save Changes' });
    const discardBtn = el('button', { className: 'btn', type: 'button', textContent: 'Discard' });
    const aseBtn = el('button', { className: 'btn', type: 'button', textContent: 'Export to .aseprite' });

    const brushEls = pal.rgb.map((rgb, slot) => {
      const sw = el('div', { className: 'sw', title: `Slot ${slot}` });
      App.paintSwatch(sw, pal.picos ? pal.picos[slot] : slot, false, rgb);
      sw.addEventListener('click', () => { ed.brush = slot; ed.erase = false; renderEditor(); });
      brushes.append(sw);
      return sw;
    });

    const tmpTile = document.createElement('canvas');
    tmpTile.width = 8;
    tmpTile.height = 8;

    function drawImage() {
      const ctx = imgCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      const recon = T.reconstruct(ed.tiles, r.map, r.mapW, r.mapH);
      ctx.drawImage(imageCanvas(recon), 0, 0, imgCanvas.width, imgCanvas.height);
      if (ed.outline) {
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        for (let i = 0; i < r.map.length; i++) {
          if (r.map[i] === ed.idx) ctx.strokeRect((i % r.mapW) * 16 + 1, Math.floor(i / r.mapW) * 16 + 1, 14, 14);
        }
      }
    }

    function drawPixels() {
      const z = ed.zoom;
      pix.width = 8 * z;
      pix.height = 8 * z;
      const ctx = pix.getContext('2d');
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const o = (y * 8 + x) * 3;
          ctx.fillStyle = `rgb(${ed.data[o]},${ed.data[o + 1]},${ed.data[o + 2]})`;
          ctx.fillRect(x * z, y * z, z, z);
        }
      }
      ctx.strokeStyle = '#404040';
      ctx.lineWidth = 1;
      for (let i = 0; i <= 8; i++) {
        ctx.beginPath(); ctx.moveTo(i * z + 0.5, 0); ctx.lineTo(i * z + 0.5, 8 * z); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * z + 0.5); ctx.lineTo(8 * z, i * z + 0.5); ctx.stroke();
      }
    }

    function renderEditor() {
      brushEls.forEach((sw, i) => sw.classList.toggle('selected', !ed.erase && ed.brush === i));
      eraseBtn.setAttribute('aria-pressed', String(ed.erase));
      outlineBtn.setAttribute('aria-pressed', String(ed.outline));
      undoBtn.disabled = !ed.undo.length;
      redoBtn.disabled = !ed.redo.length;
      saveBtn.disabled = !ed.modified;
      discardBtn.disabled = !ed.modified;
      idxInput.value = ed.idx;
      drawPixels();
      drawImage();
    }

    function loadTile(i) {
      ed.idx = Math.max(0, Math.min(ed.tiles.length - 1, i));
      ed.data = ed.tiles[ed.idx].slice();
      ed.modified = false;
      ed.undo = [];
      ed.redo = [];
      renderEditor();
    }

    function saveTile() {
      ed.tiles[ed.idx] = ed.data.slice();
      r.tiles[ed.idx] = ed.data.slice();
      ed.modified = false;
      tilesChanged();
      toast(`Tile ${ed.idx} modified`, 'info', 1500);
      renderEditor();
    }

    async function switchTile(i) {
      if (i === ed.idx) return;
      if (ed.modified) {
        const answer = await modal({
          title: 'Save Changes?',
          body: `Save changes to tile ${ed.idx}?`,
          buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'No', value: 'no' }, { label: 'Yes', value: 'yes', primary: true }],
        });
        if (answer === 'yes') saveTile();
        else if (answer !== 'no') { renderEditor(); return; }
      }
      loadTile(i);
    }

    // Painting: one undo step per stroke
    let painting = false;
    const paintAt = (e) => {
      const rect = pix.getBoundingClientRect();
      const x = Math.floor(((e.clientX - rect.left) / rect.width) * 8);
      const y = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
      if (x < 0 || y < 0 || x > 7 || y > 7) return;
      const rgb = ed.erase ? [0, 0, 0] : pal.rgb[ed.brush];
      const o = (y * 8 + x) * 3;
      if (ed.data[o] === rgb[0] && ed.data[o + 1] === rgb[1] && ed.data[o + 2] === rgb[2]) return;
      ed.data.set(rgb, o);
      ed.modified = true;
      ed.tiles[ed.idx] = ed.data.slice(); // live preview in the image
      renderEditor();
    };
    pix.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try { pix.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      ed.undo.push(ed.data.slice());
      ed.redo = [];
      painting = true;
      paintAt(e);
    });
    pix.addEventListener('pointermove', (e) => { if (painting) paintAt(e); });
    const stop = () => {
      if (!painting) return;
      painting = false;
      const last = ed.undo[ed.undo.length - 1];
      if (last && last.every((v, i) => v === ed.data[i])) ed.undo.pop(); // stroke changed nothing
      renderEditor();
    };
    pix.addEventListener('pointerup', stop);
    pix.addEventListener('pointercancel', stop);

    undoBtn.addEventListener('click', () => {
      if (!ed.undo.length) return;
      ed.redo.push(ed.data.slice());
      ed.data = ed.undo.pop();
      ed.tiles[ed.idx] = ed.data.slice();
      ed.modified = true;
      renderEditor();
    });
    redoBtn.addEventListener('click', () => {
      if (!ed.redo.length) return;
      ed.undo.push(ed.data.slice());
      ed.data = ed.redo.pop();
      ed.tiles[ed.idx] = ed.data.slice();
      ed.modified = true;
      renderEditor();
    });
    saveBtn.addEventListener('click', saveTile);
    discardBtn.addEventListener('click', async () => {
      if (ed.modified && await confirmDialog('Discard Changes?', 'Discard unsaved changes to this tile?')) {
        ed.tiles[ed.idx] = r.tiles[ed.idx].slice();
        loadTile(ed.idx);
      }
    });
    eraseBtn.addEventListener('click', () => { ed.erase = !ed.erase; renderEditor(); });
    outlineBtn.addEventListener('click', () => { ed.outline = !ed.outline; renderEditor(); });
    zoomRange.addEventListener('input', () => { ed.zoom = Number(zoomRange.value); drawPixels(); });
    idxInput.addEventListener('change', () => switchTile(Number(idxInput.value) || 0));
    imgCanvas.addEventListener('click', (e) => {
      const rect = imgCanvas.getBoundingClientRect();
      const x = Math.floor(((e.clientX - rect.left) / rect.width) * r.mapW);
      const y = Math.floor(((e.clientY - rect.top) / rect.height) * r.mapH);
      if (x >= 0 && y >= 0 && x < r.mapW && y < r.mapH) switchTile(r.map[y * r.mapW + x]);
    });
    regenBtn.addEventListener('click', () => {
      const out = autoGenerate();
      if (!out) return;
      ed.tiles = r.tiles.map((t) => t.slice());
      loadTile(ed.idx);
      showMessage('Tiles Optimized', `Generated ${ed.tiles.length} optimized tiles using ${out.paletteSize} colors`);
    });
    aseBtn.addEventListener('click', () => exportAseprite(T.reconstruct(ed.tiles, r.map, r.mapW, r.mapH)));

    const body = el('div', { className: 'te' },
      el('div', {},
        el('div', { className: 'te-image' }, imgCanvas),
        el('div', { className: 'te-row', style: 'margin-top:10px' }, outlineBtn, regenBtn),
        el('p', { className: 'hint', textContent: 'Click a tile in the image to edit it. Painting updates the image live; Save Changes applies the tile to the project.' })),
      el('div', { className: 'te-side' },
        el('div', { className: 'te-row' }, el('span', { className: 'label', textContent: 'Tile index' }), idxInput,
          el('span', { className: 'muted', textContent: `/ ${ed.tiles.length}` })),
        pix,
        el('div', { className: 'te-row' }, el('span', { className: 'label', textContent: 'Zoom' }), zoomRange),
        el('div', {}, el('div', { className: 'label', textContent: 'Brush color (export palette)', style: 'margin-bottom:6px' }), brushes),
        el('div', { className: 'te-row' }, eraseBtn, undoBtn, redoBtn),
        el('div', { className: 'te-row' }, saveBtn, discardBtn),
        aseBtn));

    loadTile(ed.idx);
    await modal({ title: 'Tile Editor – Refine Tiles', body, wide: true, buttons: [{ label: 'Close Editor', value: null }] });
    if (ed.modified && await confirmDialog('Unsaved Tile', `Save changes to tile ${ed.idx}?`, 'Save')) saveTile();
  }

  // ------------------------------------------------------------------ //
  // Bindings                                                           //
  // ------------------------------------------------------------------ //

  function markPending() {
    tm.pending = true;
    persistSettings();
    renderControls();
  }

  function bind() {
    dom.colorMode.addEventListener('change', () => { tm.colorMode = dom.colorMode.value; invalidate('fadeSlots'); markPending(); drawViews(); });
    dom.dither.addEventListener('change', () => { tm.dither = dom.dither.checked; markPending(); });
    const setThreshold = (v) => {
      if (!Number.isFinite(v)) return;
      tm.threshold = Math.round(Math.max(0, Math.min(T.THRESHOLD_MAX, v)) * 10) / 10;
      markPending();
    };
    dom.thrRange.addEventListener('input', () => setThreshold(Number(dom.thrRange.value) / 10));
    dom.thr.addEventListener('input', () => { const v = parseFloat(dom.thr.value); if (Number.isFinite(v)) setThreshold(v); });
    dom.thr.addEventListener('change', () => { dom.thr.value = tm.threshold.toFixed(1); });
    dom.thr.addEventListener('keydown', (e) => { if (e.key === 'Enter') rebuild(); });
    dom.rebuild.addEventListener('click', () => rebuild());
    dom.progressCancel.addEventListener('click', () => {
      if (job) job.cancelled = true;
      dom.progress.hidden = true;
      toast('Analysis canceled', 'warn');
    });

    const vpChange = () => {
      tm.vpW = Math.max(1, Math.min(512, parseInt(dom.vpW.value, 10) || 16));
      tm.vpH = Math.max(1, Math.min(512, parseInt(dom.vpH.value, 10) || 16));
      persistSettings();
      if (!tm.result) return;
      recomputeViewport();
      renderStats();
      drawViews();
    };
    dom.vpW.addEventListener('change', vpChange);
    dom.vpH.addEventListener('change', vpChange);

    dom.viewSeg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      tm.view = b.dataset.value;
      renderControls();
      drawViews();
    });
    dom.showSel.addEventListener('change', () => { tm.showSelection = dom.showSel.checked; drawViews(); });
    dom.fadeOn.addEventListener('change', () => { tm.fadeOn = dom.fadeOn.checked; renderControls(); drawViews(); });
    dom.fadeSlider.addEventListener('input', () => App.setSlider(Number(dom.fadeSlider.value)));

    $('#tmZoomIn').addEventListener('click', () => setZoom(tm.zoom * 2 >= 1 ? Math.floor(tm.zoom) + 1 : tm.zoom * 2));
    $('#tmZoomOut').addEventListener('click', () => setZoom(tm.zoom > 1 ? Math.ceil(tm.zoom) - 1 : tm.zoom / 2));
    $('#tmZoom1').addEventListener('click', () => setZoom(1));
    $('#tmZoomFit').addEventListener('click', zoomFit);

    views.forEach(bindView);

    // Drop an image anywhere on the original view
    dom.origFrame.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dom.origFrame.classList.add('dragover'); }
    });
    dom.origFrame.addEventListener('dragleave', () => dom.origFrame.classList.remove('dragover'));
    dom.origFrame.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.origFrame.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) importImageFile(file);
    });

    new ResizeObserver(() => drawViews()).observe(dom.outFrame);

    // Palette tool integration
    document.addEventListener('p8:palette', () => {
      invalidate('fadeSlots');
      if (tm.result && usesCustomPalette()) tm.stale = true;
      renderControls();
      if (fadeActive()) drawViews();
    });
    const refreshFade = () => {
      renderControls();
      if (fadeActive()) drawView(views[1]);
    };
    document.addEventListener('p8:fade', refreshFade);
    document.addEventListener('p8:slider', refreshFade);
    document.addEventListener('p8:workspace', () => {
      if (document.body.dataset.workspace === 'tiles') {
        renderControls();
        requestAnimationFrame(drawViews);
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (tm.dirty && tm.result) e.preventDefault();
    });
  }

  // ------------------------------------------------------------------ //
  // Suite library                                                      //
  // ------------------------------------------------------------------ //

  const S = window.Suite;

  async function importFromLibrary() {
    const a = await S.pickAsset({ title: 'Tile Maker: Image from Library' });
    if (a) importAsset(a);
  }

  async function sheetToLibrary() {
    if (!requireResult()) return;
    const pal = exportPalette();
    const mem = T.spriteMemory(tm.result.tiles, pal.rgb);
    const pixels = new Uint8Array(128 * 128);
    for (let i = 0; i < mem.length; i++) {
      pixels[i * 2] = mem[i] & 15;
      pixels[i * 2 + 1] = mem[i] >> 4;
    }
    const a = await S.assets.put(S.imageAsset({ name: `${tm.name || 'tiles'} sheet`, w: 128, h: 128, pixels, pal: pal.picos || S.STD_PAL, source: 'tiles' }));
    toast(`Sprite sheet "${a.name}" saved to the library`);
    if (tm.result.tiles.length > T.MAX_SPRITES) toast(`Only the first ${T.MAX_SPRITES} tiles fit on the sprite sheet.`, 'warn');
  }

  async function reconToLibrary() {
    if (!requireResult()) return;
    const pal = exportPalette();
    const r = tm.result.recon;
    if (r.w > S.MAX_IMAGE_SIDE || r.h > S.MAX_IMAGE_SIDE) {
      showMessage('Send to Library', `The reconstructed image is ${r.w}×${r.h}; the library keeps images up to ${S.MAX_IMAGE_SIDE}×${S.MAX_IMAGE_SIDE}.`);
      return;
    }
    const a = await S.assets.put(S.imageAsset({ name: `${tm.name || 'tiles'} tiles`, w: r.w, h: r.h, pixels: T.imageToSlots(r, pal.rgb), pal: pal.picos || S.STD_PAL, source: 'tiles' }));
    toast(`Reconstructed image "${a.name}" saved to the library`);
  }

  /** library image -> tiles; an image with its own palette (and fades) brings them along */
  function importAsset(a) {
    if (S.hasOwnPalette(a)) {
      App.adoptImagePalette(a.pal, a.meta?.fades || null);
      // nearest color in the image's own palette: every pixel keeps its exact color
      tm.colorMode = 'nearest';
      persistSettings();
    }
    return importImageData(S.assetImageData(a), a.name);
  }

  S.registerConsumer({
    id: 'tiles-import', label: 'Tile Maker', kinds: ['image'],
    open: importAsset,
  });
  S.bindAssetDrop(dom.origFrame, (a) => { if (a.kind === 'image') importAsset(a); });

  App.registerActions({
    'tiles-from-library': importFromLibrary,
    'tiles-sheet-to-library': sheetToLibrary,
    'tiles-recon-to-library': reconToLibrary,
    'tiles-import': () => { App.setWorkspace('tiles'); importImage(); },
    'tiles-open': () => openProject(),
    'tiles-save': () => saveProject(),
    'tiles-recent': (d) => openRecent(Number(d.index)),
    'tiles-recent-clear': async () => {
      if (await confirmDialog('Clear Recent Tile Projects', 'Clear all recent tile projects from the list?')) {
        store.set(KEYS.recent, []);
        renderRecent();
      }
    },
    'tiles-export-p8': exportPico8,
    'tiles-export-sheet': exportSheet,
    'tiles-export-png': exportReconPng,
    'tiles-export-aseprite': () => exportAseprite(),
    'tiles-to-map': sendToMapEditor,
    'tiles-edit': openTileEditor,
    'tiles-auto': () => {
      if (!requireResult()) return;
      const out = autoGenerate();
      if (out) showMessage('Tiles Optimized', `Generated ${out.tiles.length} optimized tiles using ${out.paletteSize} colors`);
    },
    'tiles-mapping': editMapping,
  });

  bind();
  renderAll();
})();

// js/map.js
// Map Editor workspace: PICO-8 style tile maps (1 byte per cell) painted with tiles of a
// 128-pixel-wide sprite sheet. Maps are library assets (kind 'map', with their tileset), go into
// carts (__map__, rows 32–63 in the shared sprite area) or, at any size up to 256×256, into
// data carts through the Cart Builder.

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const M = P8Map;
  const { rgbOf, encodeIndexedPng } = P8;
  const { el, $, modal, showMessage, confirmDialog, toast, download, pickFile, formField, sanitizeFilename } = App;

  const T = M.TILE;
  const SESSION_KEY = 'map.session';
  const MAX_UNDO = 100;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 8;
  const SHEET_SCALE = 2;      // tileset panel: 2 screen pixels per sheet pixel

  // ------------------------------------------------------------------ //
  // State                                                              //
  // ------------------------------------------------------------------ //

  const me = {
    map: M.newMap(),
    name: 'map',
    assetId: null,            // library map this one was opened from / saved to
    sheet: new Uint8Array(M.SHEET * 128),
    pal: S.STD_PAL.slice(),
    sheetId: null,            // library image the tileset came from (for Reload)
    sheetName: '',
    stamp: M.sheetStamp(1),   // brush: a block of tile numbers
    sheetSel: { x: 1, y: 0, w: 1, h: 1 }, // brush block on the sheet (tiles), null when picked from the map
    tool: 'pencil',
    zoom: 2,
    panX: 0,
    panY: 0,
    sel: null,                // {x, y, w, h} in cells
    hover: null,              // {x, y} cell
    undo: [],
    redo: [],
    libBase: null,            // `modified` of the library map this document last matched
    libSeen: null,            // external library version already reported as a conflict
    grid: true,
    screens: true,
    numbers: false,
    space: false,
  };

  const dom = {
    stage: $('#meStage'),
    canvas: $('#meCanvas'),
    tools: $('#meTools'),
    name: $('#meName'),
    docStatus: $('#meDocStatus'),
    fit: $('#meFit'),
    grid: $('#meGrid'),
    screens: $('#meScreens'),
    numbers: $('#meNumbers'),
    zoomLabel: $('#meZoomLabel'),
    pos: $('#mePos'),
    tileAt: $('#meTileAt'),
    selInfo: $('#meSelInfo'),
    sheet: $('#meSheet'),
    sheetName: $('#meSheetName'),
    sheetInfo: $('#meSheetInfo'),
    sheetEmpty: $('#meSheetEmpty'),
    sheetReload: $('#meSheetReload'),
    brush: $('#meBrush'),
    brushInfo: $('#meBrushInfo'),
    stats: $('#meStats'),
  };

  const sheetRows = () => me.sheet.length / M.SHEET;

  // saved / unsaved / downloaded / failed state of the open map (shared contract, #58)
  const status = P8DocStatus.create({ storage: () => S.assets.mode() });

  // ------------------------------------------------------------------ //
  // Offscreen images: the sheet in its palette, the whole map at 1:1    //
  // ------------------------------------------------------------------ //

  let sheetCanvas = null;
  let mapCanvas = null;
  let sheetBlank = false;     // #184: me.sheet is one color, so tiles are drawn as placeholders

  /** Placeholder colors from the theme tokens (#184), read whenever the display sheet is built. */
  function placeholderColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return { base: v('--surface-3', '#2b2b33'), hatch: v('--border-strong', '#4a4a55'), text: v('--text', '#fff') };
  }

  /**
   * Draws the tile number centered in a placeholder cell of at least 16 CSS px (#184). View only.
   */
  function placeholderNumber(ctx, v, x, y, size) {
    if (!sheetBlank || !v || size < 16) return;
    ctx.save();
    ctx.font = `${Math.max(7, Math.min(12, Math.floor(size / 2.2)))}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = placeholder.text;
    ctx.fillText(String(v), x + size / 2, y + size / 2 + 0.5);
    ctx.restore();
  }
  let placeholder = placeholderColors();

  /**
   * The sheet in its palette, used only for display. While the sheet is blank (#184) every tile except
   * tile 0 (empty, never drawn by map()) is a hatched placeholder, so painting gives a visible result.
   * me.sheet is never changed, and exports read me.sheet, so no output is affected.
   */
  function buildSheetCanvas() {
    const h = sheetRows();
    sheetCanvas = document.createElement('canvas');
    sheetCanvas.width = M.SHEET;
    sheetCanvas.height = h;
    const img = new ImageData(M.SHEET, h);
    const rgb = S.paletteRgb(me.pal);
    for (let i = 0; i < me.sheet.length; i++) {
      const c = rgb[me.sheet[i] & 15];
      img.data.set([c[0], c[1], c[2], 255], i * 4);
    }
    const ctx = sheetCanvas.getContext('2d');
    ctx.putImageData(img, 0, 0);
    sheetBlank = M.isSheetBlank(me.sheet);
    if (sheetBlank) {
      placeholder = placeholderColors();
      for (let ty = 0; ty < h / T; ty++) {
        for (let tx = 0; tx < 16; tx++) {
          if (!tx && !ty) continue;
          ctx.fillStyle = placeholder.base;
          ctx.fillRect(tx * T, ty * T, T, T);
          ctx.fillStyle = placeholder.hatch;
          for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if ((x + y) % 4 === 0) ctx.fillRect(tx * T + x, ty * T + y, 1, 1);
        }
      }
    }
    dom.sheetInfo.hidden = sheetBlank;
    dom.sheetEmpty.hidden = !sheetBlank;
  }

  /** Redraws map cells x0..x1, y0..y1 (inclusive) into the 1:1 map image. */
  function drawCells(x0 = 0, y0 = 0, x1 = me.map.w - 1, y1 = me.map.h - 1) {
    const ctx = mapCanvas.getContext('2d');
    const rows = sheetRows() / T;
    for (let y = Math.max(0, y0); y <= Math.min(me.map.h - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(me.map.w - 1, x1); x++) {
        const v = me.map.cells[y * me.map.w + x];
        const sy = v >> 4;
        // tile 0 is empty: map() does not draw it
        if (v && sy < rows) ctx.drawImage(sheetCanvas, (v & 15) * T, sy * T, T, T, x * T, y * T, T, T);
        else { ctx.fillStyle = '#000'; ctx.fillRect(x * T, y * T, T, T); }
      }
    }
  }

  function rebuildMapCanvas() {
    mapCanvas = document.createElement('canvas');
    mapCanvas.width = me.map.w * T;
    mapCanvas.height = me.map.h * T;
    drawCells();
  }

  function rebuildAll() {
    buildSheetCanvas();
    rebuildMapCanvas();
    renderAll();
  }

  // ------------------------------------------------------------------ //
  // Rendering                                                          //
  // ------------------------------------------------------------------ //

  let frame = 0;
  const requestRender = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; renderStage(); }); };

  function renderStage() {
    if (document.body.dataset.workspace !== 'map') return;
    const c = dom.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cw = dom.stage.clientWidth;
    const ch = dom.stage.clientHeight;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = me.zoom;
    const W = me.map.w * T * z;
    const H = me.map.h * T * z;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mapCanvas, me.panX, me.panY, W, H);

    const line = (x0, y0, x1, y1) => { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); };
    if (me.grid && z * T >= 6) {
      ctx.beginPath();
      for (let x = 1; x < me.map.w; x++) { const sx = Math.round(me.panX + x * T * z) + 0.5; line(sx, me.panY, sx, me.panY + H); }
      for (let y = 1; y < me.map.h; y++) { const sy = Math.round(me.panY + y * T * z) + 0.5; line(me.panX, sy, me.panX + W, sy); }
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (me.screens) {
      ctx.beginPath();
      for (let x = 16; x < me.map.w; x += 16) { const sx = Math.round(me.panX + x * T * z) + 0.5; line(sx, me.panY, sx, me.panY + H); }
      for (let y = 16; y < me.map.h; y += 16) { const sy = Math.round(me.panY + y * T * z) + 0.5; line(me.panX, sy, me.panX + W, sy); }
      ctx.strokeStyle = 'rgba(41,173,255,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // rows 32–63 of a 128×64 map share memory with sprites 128–255
    if (M.cartFit(me.map) === 'shared') {
      const sy = Math.round(me.panY + M.CART_H * T * z) + 0.5;
      ctx.beginPath();
      line(me.panX, sy, me.panX + W, sy);
      ctx.strokeStyle = 'rgba(255,163,0,0.9)';
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.strokeRect(Math.round(me.panX) - 0.5, Math.round(me.panY) - 0.5, Math.round(W) + 1, Math.round(H) + 1);

    // #184: placeholder cells carry their tile number (unless the Numbers overlay already shows it)
    if (sheetBlank && !(me.numbers && z * T >= 22) && z * T >= 16) {
      const [x0, y0] = cellAt(0, 0, false);
      const [x1, y1] = cellAt(dom.stage.clientWidth, dom.stage.clientHeight, false);
      for (let y = Math.max(0, y0); y <= Math.min(me.map.h - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(me.map.w - 1, x1); x++) {
          const v = me.map.cells[y * me.map.w + x];
          if ((v >> 4) * T < sheetRows()) placeholderNumber(ctx, v, me.panX + x * T * z, me.panY + y * T * z, T * z);
        }
      }
    }
    if (me.numbers && z * T >= 22) {
      ctx.font = `${Math.min(12, Math.floor(z * T / 2.4))}px ui-monospace, monospace`;
      ctx.textBaseline = 'top';
      const [x0, y0] = cellAt(0, 0, false);
      const [x1, y1] = cellAt(dom.stage.clientWidth, dom.stage.clientHeight, false);
      for (let y = Math.max(0, y0); y <= Math.min(me.map.h - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(me.map.w - 1, x1); x++) {
          const v = me.map.cells[y * me.map.w + x];
          if (!v) continue;
          const sx = me.panX + x * T * z + 2;
          const sy = me.panY + y * T * z + 2;
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(sx - 1, sy - 1, ctx.measureText(v).width + 2, 12);
          ctx.fillStyle = '#fff';
          ctx.fillText(v, sx, sy);
        }
      }
    }

    // brush preview / rectangle preview / selection
    const cellRect = (x, y, w, h) => [me.panX + x * T * z, me.panY + y * T * z, w * T * z, h * T * z];
    if (drag?.mode === 'rect' || drag?.mode === 'select' || drag?.mode === 'pick') {
      const r = normRect(drag.x0, drag.y0, drag.x1, drag.y1);
      if (drag.mode === 'rect') {
        ctx.globalAlpha = 0.6;
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) drawTile(ctx, stampValue(drag.x0, drag.y0, x, y), ...cellRect(x, y, 1, 1));
        ctx.globalAlpha = 1;
      }
      outline(ctx, ...cellRect(r.x, r.y, r.w, r.h), drag.mode === 'pick' ? '#ffa300' : '#fff');
    } else if (me.hover && (me.tool === 'pencil' || me.tool === 'rect' || me.tool === 'fill') && !drag?.pan) {
      const { x, y } = me.hover;
      ctx.globalAlpha = 0.55;
      for (let sy = 0; sy < me.stamp.h; sy++) {
        for (let sx = 0; sx < me.stamp.w; sx++) {
          if (M.inside(me.map, x + sx, y + sy)) drawTile(ctx, me.stamp.cells[sy * me.stamp.w + sx], ...cellRect(x + sx, y + sy, 1, 1));
        }
      }
      ctx.globalAlpha = 1;
      outline(ctx, ...cellRect(x, y, me.tool === 'pencil' ? me.stamp.w : 1, me.tool === 'pencil' ? me.stamp.h : 1), '#fff');
    } else if (me.hover) {
      outline(ctx, ...cellRect(me.hover.x, me.hover.y, 1, 1), 'rgba(255,255,255,0.7)');
    }
    if (me.sel) {
      ctx.setLineDash([4, 3]);
      outline(ctx, ...cellRect(me.sel.x, me.sel.y, me.sel.w, me.sel.h), '#fff');
      ctx.lineDashOffset = 4;
      outline(ctx, ...cellRect(me.sel.x, me.sel.y, me.sel.w, me.sel.h), '#000');
      ctx.lineDashOffset = 0;
      ctx.setLineDash([]);
    }
  }

  function drawTile(ctx, v, x, y, w, h) {
    if (!v) { ctx.fillStyle = '#000'; ctx.fillRect(x, y, w, h); } else if ((v >> 4) * T < sheetRows()) ctx.drawImage(sheetCanvas, (v & 15) * T, (v >> 4) * T, T, T, x, y, w, h);
  }

  function outline(ctx, x, y, w, h, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  }

  function renderSheet() {
    const c = dom.sheet;
    const h = sheetRows();
    if (c.height !== h * SHEET_SCALE) c.height = h * SHEET_SCALE;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheetCanvas, 0, 0, M.SHEET * SHEET_SCALE, h * SHEET_SCALE);
    ctx.beginPath();
    for (let x = 1; x < 16; x++) { ctx.moveTo(x * 16 + 0.5, 0); ctx.lineTo(x * 16 + 0.5, c.height); }
    for (let y = 1; y < h / T; y++) { ctx.moveTo(0, y * 16 + 0.5); ctx.lineTo(c.width, y * 16 + 0.5); }
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.stroke();
    if (sheetBlank) for (let v = 1; v < (h / T) * 16 && v < 256; v++) placeholderNumber(ctx, v, (v & 15) * 16, (v >> 4) * 16, 16);
    // the four PICO-8 sprite tabs (64 sprites each)
    ctx.beginPath();
    for (let y = 32; y < h; y += 32) { ctx.moveTo(0, y * SHEET_SCALE + 0.5); ctx.lineTo(c.width, y * SHEET_SCALE + 0.5); }
    ctx.strokeStyle = 'rgba(41,173,255,0.5)';
    ctx.stroke();
    const s = sheetDrag ? normRect(sheetDrag.x0, sheetDrag.y0, sheetDrag.x1, sheetDrag.y1) : me.sheetSel;
    if (s) {
      outline(ctx, s.x * 16 - 1, s.y * 16 - 1, s.w * 16 + 2, s.h * 16 + 2, '#000');
      outline(ctx, s.x * 16, s.y * 16, s.w * 16, s.h * 16, '#fff');
    }
    dom.sheetName.textContent = me.sheetName ? `· ${me.sheetName}` : '';
    dom.sheetReload.disabled = !me.sheetId || !S.assets.get(me.sheetId);
  }

  function renderBrush() {
    const { w, h, cells } = me.stamp;
    const scale = Math.max(1, Math.min(8, Math.floor(128 / (Math.max(w, h) * T))));
    const c = dom.brush;
    c.width = Math.max(T, w * T * scale);
    c.height = Math.max(T, h * T * scale);
    c.style.width = `${c.width}px`;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      drawTile(ctx, cells[y * w + x], x * T * scale, y * T * scale, T * scale, T * scale);
      placeholderNumber(ctx, cells[y * w + x], x * T * scale, y * T * scale, T * scale);
    }
    dom.brushInfo.textContent = w === 1 && h === 1 ? `tile ${cells[0]}` : `${w}×${h} tiles${me.sheetSel ? ` from ${cells[0]}` : ' (from the map)'}`;
  }

  const FIT_TEXT = {
    cart: ['Cart map', '__map__ (128×32 max): any cart can hold it'],
    shared: ['Cart map · shared', 'Rows 32–63 are stored where sprites 128–255 are: the map costs the lower half of the sprite sheet'],
    data: ['Data cart', 'Larger than a cart map (128×64): load the bytes from a data cart (Cart Builder) and draw with your own code'],
  };

  function renderInfo() {
    const fit = M.cartFit(me.map);
    dom.fit.textContent = `${me.map.w}×${me.map.h} · ${FIT_TEXT[fit][0]}`;
    dom.fit.title = FIT_TEXT[fit][1];
    dom.fit.dataset.fit = fit;
    if (document.activeElement !== dom.name) dom.name.value = me.name;
    const use = M.usage(me.map);
    let distinct = 0;
    for (let i = 0; i < 256; i++) if (use[i]) distinct++;
    const lines = [
      `${me.map.w}×${me.map.h} cells · ${me.map.cells.length} bytes`,
      `${distinct} different tiles · ${me.map.cells.length - use[0]} cells not 0`,
      FIT_TEXT[fit][1],
    ];
    if (fit === 'shared' && M.usesUpperSprites(me.map)) lines.push('⚠ The map uses sprites 128–255, but a 128×64 map stores its rows 32–63 there.');
    dom.stats.replaceChildren(...lines.map((t) => el('span', { textContent: t })));
    dom.zoomLabel.textContent = `${Math.round(me.zoom * 100)}%`;
    dom.selInfo.textContent = me.sel ? `selection ${me.sel.w}×${me.sel.h} at ${me.sel.x},${me.sel.y}` : '';
    for (const b of dom.tools.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === me.tool));
    dom.stage.dataset.tool = me.tool;
  }

  function renderStatus() {
    if (!me.hover) { dom.pos.textContent = '–'; dom.tileAt.textContent = ''; return; }
    const { x, y } = me.hover;
    dom.pos.textContent = `cell ${x},${y} · px ${x * T},${y * T} · screen ${Math.floor(x / 16)},${Math.floor(y / 16)}`;
    dom.tileAt.textContent = `tile ${me.map.cells[y * me.map.w + x]}`;
  }

  function renderAll() {
    renderSheet();
    renderBrush();
    renderInfo();
    renderStatus();
    requestRender();
  }

  // ------------------------------------------------------------------ //
  // View                                                               //
  // ------------------------------------------------------------------ //

  /** screen (css px in the stage) -> cell; clamp=false allows cells outside the map */
  function cellAt(sx, sy, clamp = true) {
    let x = Math.floor((sx - me.panX) / (T * me.zoom));
    let y = Math.floor((sy - me.panY) / (T * me.zoom));
    if (clamp) { x = Math.max(0, Math.min(me.map.w - 1, x)); y = Math.max(0, Math.min(me.map.h - 1, y)); }
    return [x, y];
  }

  // #200: as in Pixel Studio, the view refits on stage resize until the user zooms or pans by hand; a
  // manual view is only clamped so part of the map stays on screen.
  let viewAuto = true;

  function clampView() {
    const sw = dom.stage.clientWidth;
    const sh = dom.stage.clientHeight;
    const W = me.map.w * T * me.zoom;
    const H = me.map.h * T * me.zoom;
    // keep at least half of what could be visible: half the stage, or half the document when it is smaller
    const kx = Math.min(W, sw) / 2;
    const ky = Math.min(H, sh) / 2;
    me.panX = Math.round(Math.max(kx - W, Math.min(sw - kx, me.panX)));
    me.panY = Math.round(Math.max(ky - H, Math.min(sh - ky, me.panY)));
  }

  let stageSize = '';
  function onStageResize() {
    const sw = dom.stage.clientWidth;
    const sh = dom.stage.clientHeight;
    if (!sw || !sh) return; // hidden workspace
    const size = `${sw}x${sh}`;
    if (size === stageSize) { requestRender(); return; }
    stageSize = size;
    if (viewAuto) zoomFit(); else { clampView(); requestRender(); }
  }

  function zoomTo(z, cx = dom.stage.clientWidth / 2, cy = dom.stage.clientHeight / 2) {
    viewAuto = false;
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    me.panX = cx - ((cx - me.panX) * z) / me.zoom;
    me.panY = cy - ((cy - me.panY) * z) / me.zoom;
    me.zoom = z;
    renderInfo();
    requestRender();
  }

  const ZOOMS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8];
  const zoomStep = (dir) => zoomTo(dir > 0 ? ZOOMS.find((z) => z > me.zoom + 1e-6) ?? ZOOM_MAX : [...ZOOMS].reverse().find((z) => z < me.zoom - 1e-6) ?? ZOOM_MIN);

  function zoomFit() {
    const cw = dom.stage.clientWidth;
    const ch = dom.stage.clientHeight;
    if (!cw || !ch) return;
    const z = Math.min((cw - 24) / (me.map.w * T), (ch - 24) / (me.map.h * T));
    viewAuto = true;
    me.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z >= 1 ? Math.floor(z * 2) / 2 : z));
    me.panX = Math.round((cw - me.map.w * T * me.zoom) / 2);
    me.panY = Math.round((ch - me.map.h * T * me.zoom) / 2);
    renderInfo();
    requestRender();
  }

  // ------------------------------------------------------------------ //
  // Editing                                                            //
  // ------------------------------------------------------------------ //

  const normRect = (x0, y0, x1, y1) => ({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0) + 1, h: Math.abs(y1 - y0) + 1 });
  const stampValue = (ox, oy, x, y) => {
    const { w, h, cells } = me.stamp;
    return cells[((((y - oy) % h) + h) % h) * w + ((((x - ox) % w) + w) % w)];
  };

  function pushUndo() {
    me.undo.push(M.cloneMap(me.map));
    if (me.undo.length > MAX_UNDO) me.undo.shift();
    me.redo.length = 0;
  }

  function changed({ resized = false } = {}) {
    status.edit();
    if (resized) rebuildMapCanvas();
    renderInfo();
    requestRender();
    scheduleSave();
  }

  function undo() {
    if (!me.undo.length) return;
    me.redo.push(me.map);
    restoreMap(me.undo.pop());
  }

  function redo() {
    if (!me.redo.length) return;
    me.undo.push(me.map);
    restoreMap(me.redo.pop());
  }

  function restoreMap(m) {
    const resized = m.w !== me.map.w || m.h !== me.map.h;
    me.map = m;
    if (me.sel && (me.sel.x + me.sel.w > m.w || me.sel.y + me.sel.h > m.h)) me.sel = null;
    if (resized) rebuildMapCanvas(); else drawCells();
    changed();
  }

  /** Paints the brush footprint at (x,y), its pattern aligned to the stroke origin. */
  function paintAt(x, y, ox, oy) {
    const { w, h } = me.stamp;
    for (let sy = 0; sy < h; sy++) {
      for (let sx = 0; sx < w; sx++) {
        const tx = x + sx;
        const ty = y + sy;
        if (!M.inside(me.map, tx, ty)) continue;
        me.map.cells[ty * me.map.w + tx] = stampValue(ox, oy, tx, ty);
      }
    }
    drawCells(x, y, x + w - 1, y + h - 1);
  }

  /** Cells along a line (so fast strokes leave no gaps), stepping by the brush size. */
  function strokeTo(x, y) {
    const { w, h } = me.stamp;
    let { lx, ly } = drag;
    const steps = Math.max(Math.abs(x - lx) / w, Math.abs(y - ly) / h, 1);
    for (let i = 1; i <= Math.ceil(steps); i++) {
      const t = Math.min(1, i / steps);
      // snap to the brush grid of the stroke so blocks tile seamlessly
      const px = drag.ox + Math.round((lx + (x - lx) * t - drag.ox) / w) * w;
      const py = drag.oy + Math.round((ly + (y - ly) * t - drag.oy) / h) * h;
      paintAt(px, py, drag.ox, drag.oy);
    }
    drag.lx = x;
    drag.ly = y;
  }

  function setStampFromMap(r) {
    me.stamp = M.copyRect(me.map, r.x, r.y, r.w, r.h);
    // a block picked from the map that is a plain sheet block selects it on the sheet too
    const n = me.stamp.cells[0];
    const sheetBlock = M.sheetStamp(n, r.w, r.h);
    me.sheetSel = (n & 15) + r.w <= 16 && sheetBlock.cells.every((v, i) => v === me.stamp.cells[i]) ? { x: n & 15, y: n >> 4, w: r.w, h: r.h } : null;
    renderSheet();
    renderBrush();
  }

  function setTool(t) {
    me.tool = t;
    renderInfo();
    requestRender();
  }

  // pointer handling on the stage
  let drag = null;

  function onDown(e) {
    if (e.button === 2) e.preventDefault();
    dom.canvas.focus({ preventScroll: true });
    try { dom.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const r = dom.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (e.button === 1 || me.space || me.tool === 'hand') {
      drag = { pan: true, sx, sy, px: me.panX, py: me.panY };
      dom.stage.classList.add('panning');
      return;
    }
    const [x, y] = cellAt(sx, sy);
    const [ux, uy] = cellAt(sx, sy, false);
    if (!M.inside(me.map, ux, uy) && me.tool !== 'select') return;
    const tool = e.button === 2 || e.altKey ? 'picker' : me.tool;
    if (tool === 'pencil') {
      pushUndo();
      drag = { mode: 'paint', ox: x, oy: y, lx: x, ly: y };
      paintAt(x, y, x, y);
      changed();
    } else if (tool === 'rect') {
      drag = { mode: 'rect', x0: x, y0: y, x1: x, y1: y };
    } else if (tool === 'fill') {
      pushUndo();
      if (M.floodFill(me.map, me.stamp, x, y)) { drawCells(); changed(); } else me.undo.pop();
    } else if (tool === 'picker') {
      drag = { mode: 'pick', x0: x, y0: y, x1: x, y1: y };
    } else if (tool === 'select') {
      me.sel = null;
      drag = { mode: 'select', x0: x, y0: y, x1: x, y1: y };
    }
    requestRender();
  }

  function onMove(e) {
    const r = dom.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    if (drag?.pan) {
      viewAuto = false;
      me.panX = drag.px + sx - drag.sx;
      me.panY = drag.py + sy - drag.sy;
      requestRender();
      return;
    }
    const [ux, uy] = cellAt(sx, sy, false);
    const hover = M.inside(me.map, ux, uy) ? { x: ux, y: uy } : null;
    if (hover?.x !== me.hover?.x || hover?.y !== me.hover?.y) { me.hover = hover; renderStatus(); requestRender(); }
    if (!drag) return;
    const [x, y] = cellAt(sx, sy);
    if (drag.mode === 'paint') {
      if (x !== drag.lx || y !== drag.ly) { strokeTo(x, y); requestRender(); }
    } else if (drag.x1 !== x || drag.y1 !== y) {
      drag.x1 = x;
      drag.y1 = y;
      if (drag.mode === 'select') dom.selInfo.textContent = `selection ${Math.abs(x - drag.x0) + 1}×${Math.abs(y - drag.y0) + 1}`;
      requestRender();
    }
  }

  function onUp() {
    if (!drag) return;
    const d = drag;
    drag = null;
    dom.stage.classList.remove('panning');
    if (d.mode === 'paint') scheduleSave();
    else if (d.mode === 'rect') {
      pushUndo();
      M.fillRect(me.map, me.stamp, d.x0, d.y0, d.x1, d.y1);
      const r = normRect(d.x0, d.y0, d.x1, d.y1);
      drawCells(r.x, r.y, r.x + r.w - 1, r.y + r.h - 1);
      changed();
    } else if (d.mode === 'pick') {
      setStampFromMap(normRect(d.x0, d.y0, d.x1, d.y1));
      if (me.tool === 'picker') setTool('pencil');
    } else if (d.mode === 'select') {
      me.sel = normRect(d.x0, d.y0, d.x1, d.y1);
    }
    renderInfo();
    requestRender();
  }

  // pointer handling on the tileset
  let sheetDrag = null;

  function sheetTile(e) {
    const r = dom.sheet.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * M.SHEET;
    const py = ((e.clientY - r.top) / r.height) * sheetRows();
    return [Math.max(0, Math.min(15, Math.floor(px / T))), Math.max(0, Math.min(sheetRows() / T - 1, Math.floor(py / T)))];
  }

  function bindSheet() {
    dom.sheet.addEventListener('pointerdown', (e) => {
      try { dom.sheet.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      const [x, y] = sheetTile(e);
      sheetDrag = { x0: x, y0: y, x1: x, y1: y };
      renderSheet();
    });
    dom.sheet.addEventListener('pointermove', (e) => {
      const [x, y] = sheetTile(e);
      dom.sheetInfo.textContent = `sprite ${y * 16 + x}${sheetDrag ? ` · block ${Math.abs(x - sheetDrag.x0) + 1}×${Math.abs(y - sheetDrag.y0) + 1}` : ''}`;
      if (!sheetDrag || (sheetDrag.x1 === x && sheetDrag.y1 === y)) return;
      sheetDrag.x1 = x;
      sheetDrag.y1 = y;
      renderSheet();
    });
    dom.sheet.addEventListener('pointerleave', () => { if (!sheetDrag) dom.sheetInfo.textContent = 'Click a tile, drag to take a block of tiles.'; });
    const up = () => {
      if (!sheetDrag) return;
      const r = normRect(sheetDrag.x0, sheetDrag.y0, sheetDrag.x1, sheetDrag.y1);
      sheetDrag = null;
      me.sheetSel = r;
      me.stamp = M.sheetStamp(r.y * 16 + r.x, r.w, r.h);
      if (me.tool !== 'rect' && me.tool !== 'fill') setTool('pencil');
      renderSheet();
      renderBrush();
    };
    dom.sheet.addEventListener('pointerup', up);
    dom.sheet.addEventListener('pointercancel', up);
    dom.sheet.addEventListener('keydown', (e) => {
      const dirs = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -16, ArrowDown: 16 };
      if (!(e.key in dirs)) return;
      e.preventDefault();
      stepBrush(dirs[e.key]);
    });
  }

  /** Moves a 1×1 brush through the sheet ([ / ] or arrows on the tileset). */
  function stepBrush(d) {
    const n = (me.stamp.cells[0] + d + 256) % 256;
    if (n >> 4 >= sheetRows() / T) return;
    me.stamp = M.sheetStamp(n);
    me.sheetSel = { x: n & 15, y: n >> 4, w: 1, h: 1 };
    renderSheet();
    renderBrush();
    requestRender();
  }

  // ------------------------------------------------------------------ //
  // Selection + clipboard                                              //
  // ------------------------------------------------------------------ //

  let clip = null;

  function copySel() {
    if (!me.sel) { toast('Select cells first (M)', 'warn'); return false; }
    clip = M.copyRect(me.map, me.sel.x, me.sel.y, me.sel.w, me.sel.h);
    setStampFromMap(me.sel);
    toast(`Copied ${me.sel.w}×${me.sel.h} cells: they are the brush now`);
    return true;
  }

  function clearSel() {
    if (!me.sel) return;
    pushUndo();
    M.fillRect(me.map, M.sheetStamp(0), me.sel.x, me.sel.y, me.sel.x + me.sel.w - 1, me.sel.y + me.sel.h - 1);
    drawCells(me.sel.x, me.sel.y, me.sel.x + me.sel.w - 1, me.sel.y + me.sel.h - 1);
    changed();
  }

  function paste() {
    if (!clip) { toast('Nothing copied yet', 'warn'); return; }
    me.stamp = M.cloneMap(clip);
    me.sheetSel = null;
    setTool('pencil');
    renderSheet();
    renderBrush();
    toast('Pasted as the brush: click to place it');
  }

  // ------------------------------------------------------------------ //
  // Documents: new, library, session                                   //
  // ------------------------------------------------------------------ //

  async function confirmDiscard(what) {
    if (!status.dirty()) return true;
    return confirmDialog('Unsaved Changes', `${what}\n\nThe current map has changes that are not saved to the library.`, 'Discard changes');
  }

  function loadMap(m, { name = me.name, assetId = null, dirty = false, libModified = null } = {}) {
    me.map = m;
    me.name = name;
    me.assetId = assetId;
    me.libBase = assetId ? libModified : null;
    me.libSeen = null;
    me.sel = null;
    me.undo.length = 0;
    me.redo.length = 0;
    status.open({ name, target: assetId ? 'library' : null, dirty });
    rebuildMapCanvas();
    zoomFit();
    renderAll();
    scheduleSave();
  }

  function setSheet(pixels, { pal = null, id = null, name = '' } = {}) {
    me.sheet = pixels;
    if (pal) me.pal = S.normPal(pal);
    me.sheetId = id;
    me.sheetName = name;
    if (me.sheetSel && (me.sheetSel.y + me.sheetSel.h) * T > sheetRows()) { me.sheetSel = { x: 1, y: 0, w: 1, h: 1 }; me.stamp = M.sheetStamp(1); }
    rebuildAll();
    status.edit();
    scheduleSave();
  }

  /** the tileset palette is part of the saved map */
  function setPal(pal) {
    me.pal = S.normPal(pal);
    rebuildAll();
    status.edit();
    scheduleSave();
  }

  const SIZE_PRESETS = [
    [128, 32, '128×32 · cart map (__map__)'],
    [128, 64, '128×64 · cart map + shared sprite rows (costs sprites 128–255)'],
    [16, 16, '16×16 · one screen'],
    [256, 32, '256×32 · data cart'],
    [256, 64, '256×64 · data cart'],
    [256, 256, '256×256 · data cart (64 KB, several carts)'],
  ];

  async function sizeDialog(title, w0, h0, okLabel) {
    const w = el('input', { type: 'number', min: 1, max: M.MAX_SIDE, value: w0 });
    const h = el('input', { type: 'number', min: 1, max: M.MAX_SIDE, value: h0 });
    const presets = el('div', { className: 'me-presets' }, ...SIZE_PRESETS.map(([pw, ph, label]) => {
      const b = el('button', { type: 'button', className: 'btn btn-sm', textContent: label });
      b.addEventListener('click', () => { w.value = pw; h.value = ph; });
      return b;
    }));
    const res = await modal({
      title,
      body: el('div', { className: 'dialog-form' }, el('div', { className: 'row-inline' }, formField('Width (cells)', w), formField('Height (cells)', h)), presets,
        el('p', { className: 'muted', textContent: 'One cell is one 8×8 tile; one screen is 16×16 cells. A cart holds 128×32 (128×64 using the shared sprite rows); bigger maps go into data carts.' })),
      buttons: [{ label: 'Cancel', value: null }, { label: okLabel, primary: true, value: () => [Number(w.value), Number(h.value)] }],
      onOpen: () => w.select(),
    });
    if (!res) return null;
    const [mw, mh] = res.map((v) => Math.max(1, Math.min(M.MAX_SIDE, Math.round(v) || 1)));
    return [mw, mh];
  }

  async function newMap() {
    App.setWorkspace('map');
    if (!(await confirmDiscard('Start a new map?'))) return;
    const size = await sizeDialog('New Map', 128, 32, 'Create');
    if (!size) return;
    loadMap(M.newMap(...size), { name: 'map' });
  }

  async function resizeMap() {
    const size = await sizeDialog('Map Size', me.map.w, me.map.h, 'Resize');
    if (!size || (size[0] === me.map.w && size[1] === me.map.h)) return;
    pushUndo();
    me.map = M.resizeMap(me.map, ...size);
    if (me.sel && (me.sel.x + me.sel.w > me.map.w || me.sel.y + me.sel.h > me.map.h)) me.sel = null;
    changed({ resized: true });
    zoomFit();
  }

  async function clearMap() {
    if (!(await confirmDialog('Clear Map', 'Set every cell to tile 0?', 'Clear'))) return;
    pushUndo();
    me.map.cells.fill(0);
    drawCells();
    changed();
  }

  async function replaceTile() {
    const from = el('input', { type: 'number', min: 0, max: 255, value: me.hover ? me.map.cells[me.hover.y * me.map.w + me.hover.x] : 0 });
    const to = el('input', { type: 'number', min: 0, max: 255, value: me.stamp.cells[0] });
    const res = await modal({
      title: 'Replace Tile',
      body: el('div', { className: 'dialog-form' }, el('div', { className: 'row-inline' }, formField('Replace tile', from), formField('with tile', to)),
        el('p', { className: 'muted', textContent: me.sel ? 'Only inside the selection.' : 'In the whole map.' })),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Replace', primary: true, value: () => [Number(from.value) & 255, Number(to.value) & 255] }],
      onOpen: () => from.select(),
    });
    if (!res) return;
    const r = me.sel || { x: 0, y: 0, w: me.map.w, h: me.map.h };
    pushUndo();
    let n = 0;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = y * me.map.w + x;
        if (me.map.cells[i] === res[0]) { me.map.cells[i] = res[1]; n++; }
      }
    }
    if (!n) { me.undo.pop(); toast(`No cell holds tile ${res[0]}`, 'warn'); return; }
    drawCells();
    changed();
    toast(`Replaced ${n} cell(s)`);
  }

  const mapAsset = () => S.assets.get(me.assetId);

  function currentAsset() {
    return {
      kind: 'map', name: me.name, w: me.map.w, h: me.map.h, cells: me.map.cells.slice(),
      sheet: me.sheet.slice(), pal: me.pal.slice(), sheetId: me.sheetId, sheetName: me.sheetName, source: 'map',
    };
  }

  /** the library copy changed since this map last matched it (another tab, Library rename) */
  const libChanged = (a) => Boolean(a && me.libBase != null && a.modified !== me.libBase);

  /**
   * Only a committed write of THIS document marks it saved: edits made meanwhile stay unsaved, a
   * failure keeps a Retry in the status, and a result for a map closed meanwhile changes nothing.
   */
  async function saveToLibrary({ asNew = false } = {}) {
    if (status.pending()) { toast('The map is still being saved…', 'warn'); return false; }
    const doc = status.doc();
    const old = mapAsset();
    if (!asNew && libChanged(old)) {
      const choice = await modal({
        title: 'Library Map Changed',
        body: `"${old.name}" in the Library was changed or renamed elsewhere (another tab or the Library panel) after this map was opened or saved.\n\nOverwrite replaces that Library version with this map. Save as New keeps both.`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Save as New Map', value: 'new' }, { label: 'Overwrite Library Map', value: 'overwrite', danger: true }],
      });
      if (status.doc() !== doc) return false;
      if (!choice) {
        me.libSeen = old.modified;
        status.conflict(`"${old.name}" was changed in the Library after this map was opened or saved, so this map was not saved`);
        return false;
      }
      asNew = choice === 'new';
    }
    const ticket = status.begin('library', { intent: { asNew }, name: me.name });
    const a = await S.assets.put({ ...currentAsset(), ...(!asNew && old ? { id: old.id, created: old.created } : {}) }).catch((e) => {
      status.reject(ticket, { message: e?.message || String(e) });
      S.reportStorageError('Save Map to Library', e);
      return null;
    });
    if (!a) return false;
    if (!status.isCurrent(ticket)) {
      toast(`Saved the previous map "${a.name}" to the library (the open map is unchanged)`);
      return false;
    }
    me.assetId = a.id;
    me.libBase = a.modified;
    me.libSeen = null;
    status.resolve(ticket, { name: a.name });
    renderInfo();
    scheduleSave();
    toast(`Saved map "${a.name}" to the library${status.dirty() ? ' (newer edits are not saved yet)' : ''}`);
    return true;
  }

  // absence from the Library cache only means "deleted" once the Library loaded without error
  let libraryLoaded = false;
  Promise.resolve(S.assets.ready).then(() => { libraryLoaded = !S.assets.loadError?.(); checkLibrary(); }, () => {});

  /** Reports a library copy that was deleted or changed elsewhere while this map is open. */
  function checkLibrary() {
    if (!me.assetId || status.pending()) return;
    const a = mapAsset();
    if (!a) {
      if (libraryLoaded) status.lost(`"${me.name}" is no longer in the Library (deleted in the Library or another tab). Save to add it again`);
      return;
    }
    if (me.libBase == null) { me.libBase = a.modified; return; }
    if (libChanged(a) && me.libSeen !== a.modified) {
      me.libSeen = a.modified;
      status.conflict(`"${a.name}" was changed in the Library (another tab or the Library panel) after this map was opened or saved. Saving asks whether to overwrite it or save a new map`);
    }
  }

  function openAsset(a) {
    App.setWorkspace('map');
    const m = { w: a.w, h: a.h, cells: Uint8Array.from(a.cells) };
    me.sheet = a.sheet ? Uint8Array.from(a.sheet) : new Uint8Array(M.SHEET * 128);
    me.pal = S.normPal(a.pal);
    me.sheetId = a.sheetId || null;
    me.sheetName = a.sheetName || '';
    buildSheetCanvas();
    loadMap(m, { name: a.name, assetId: a.id || null, dirty: !a.id, libModified: a.modified ?? null });
    return true;
  }

  async function openFromLibrary() {
    const a = await S.pickAsset({ title: 'Open Map from Library', kind: 'map', allowImport: false });
    if (!a || !(await confirmDiscard(`Open "${a.name}"?`))) return;
    openAsset(a);
  }

  /** Library images up to 128×128 (width and height multiples of 8) can be tilesets. */
  const tilesetOk = (a) => (a.w <= M.SHEET && a.h <= 128 && a.w % T === 0 && a.h % T === 0 ? true : 'A tileset is an image up to 128×128 with sides that are multiples of 8 (a sprite sheet).');

  function sheetFromImage(a) {
    const h = Math.max(T, a.h);
    const px = new Uint8Array(M.SHEET * h);
    for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) px[y * M.SHEET + x] = a.pixels[y * a.w + x] & 15;
    return px;
  }

  function useImageAsTileset(a) {
    App.setWorkspace('map');
    const ok = tilesetOk(a);
    if (ok !== true) { showMessage('Tileset', ok); return; }
    setSheet(sheetFromImage(a), { pal: a.pal, id: a.id || null, name: a.name });
    toast(`Tileset: ${a.name} (${a.w}×${a.h}, ${(a.w / T) * (a.h / T)} tiles)`);
    return true;
  }

  async function tilesetFromLibrary() {
    const a = await S.pickAsset({ title: 'Tileset from Library (sprite sheet)', filter: tilesetOk });
    if (a) useImageAsTileset(a);
  }

  function reloadTileset() {
    const a = S.assets.get(me.sheetId);
    if (!a) { showMessage('Reload Tileset', 'The tileset image is no longer in the library.'); return; }
    setSheet(sheetFromImage(a), { pal: a.pal, id: a.id, name: a.name });
    toast(`Reloaded ${a.name}`);
  }

  async function readCartFile(title) {
    const file = await pickFile('.p8,text/plain');
    if (!file) return null;
    const text = await file.text();
    if (!M.isCart(text)) { showMessage(title, 'This is not a PICO-8 text cart (.p8).'); return null; }
    return { file, text, cart: M.readCart(text) };
  }

  async function tilesetFromCart() {
    const r = await readCartFile('Tileset from .p8');
    if (!r) return;
    if (!r.cart.hasGfx) { showMessage('Tileset from .p8', 'The cart has no __gfx__ section.'); return; }
    setSheet(r.cart.sheet, { pal: S.STD_PAL, name: r.file.name });
    toast(`Tileset: sprite sheet of ${r.file.name} (standard palette)`);
  }

  async function importCart() {
    App.setWorkspace('map');
    const r = await readCartFile('Import .p8');
    if (r) await importCartText(r.text, r.file.name);
  }

  /** a cart's map + sprite sheet (also used by the Code Editor's Cart menu) */
  async function importCartText(text, fileName) {
    App.setWorkspace('map');
    const r = { file: { name: fileName }, cart: M.readCart(text) };
    if (!r.cart.hasMap && !r.cart.lowerUsed) { showMessage('Import .p8', 'The cart has no map data.'); return; }
    if (!(await confirmDiscard(`Open the map of "${r.file.name}"?`))) return;
    let m = r.cart.map;
    if (r.cart.lowerUsed) {
      const tall = await modal({
        title: 'Map Rows 32–63',
        body: el('p', { textContent: 'The lower half of the sprite sheet (sprites 128–255) has data. PICO-8 shows it as map rows 32–63. Is it part of the map, or sprites?' }),
        buttons: [{ label: 'Sprites: 128×32 map', value: false }, { label: 'Map: 128×64', primary: true, value: true }],
      });
      if (tall == null) return;
      if (tall) m = M.joinLower(r.cart.map, r.cart.lower);
    }
    me.sheet = r.cart.sheet;
    me.pal = S.STD_PAL.slice();
    me.sheetId = null;
    me.sheetName = r.file.name;
    buildSheetCanvas();
    loadMap(m, { name: r.file.name.replace(/\.p8$/i, ''), dirty: true });
    toast(`Imported the ${m.w}×${m.h} map and sprite sheet of ${r.file.name}`);
  }

  async function paletteFromLibrary() {
    const a = await S.pickAsset({ title: 'Palette for the Tileset', kind: 'palette', allowImport: false });
    if (!a) return;
    setPal(a.colors.map((c, i) => c ?? i));
    toast(`Palette: ${a.name}`);
  }

  // session (survives reloads, like the other tools)
  let saveTimer = 0;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 600);
  }

  /** browser-only working copy (not a save); a failure shows the map as memory-only */
  function saveSession() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    const tk = status.snapshot();
    return S.kv.set(SESSION_KEY, { ...currentAsset(), assetId: me.assetId, libModified: me.libBase, dirty: status.dirty() })
      .then(() => status.session(tk, true), (e) => { status.session(tk, false); S.autosaveFailed('Map Editor session')(e); });
  }

  async function restoreSession() {
    const s = await S.kv.get(SESSION_KEY).catch(S.autosaveFailed('Map Editor session'));
    if (!s || !(s.cells instanceof Uint8Array) || s.cells.length !== s.w * s.h) return;
    me.sheet = s.sheet instanceof Uint8Array ? s.sheet : me.sheet;
    me.pal = S.normPal(s.pal);
    me.sheetId = s.sheetId || null;
    me.sheetName = s.sheetName || '';
    buildSheetCanvas();
    loadMap({ w: s.w, h: s.h, cells: s.cells }, { name: s.name || 'map', assetId: s.assetId || null, dirty: Boolean(s.dirty), libModified: s.libModified ?? null });
    checkLibrary();
  }

  // ------------------------------------------------------------------ //
  // Export                                                             //
  // ------------------------------------------------------------------ //

  const fileBase = () => sanitizeFilename(me.name) || 'map';

  /** Asks before a 128×64 map overwrites sprites 128–255 of the sheet. */
  async function okToShare(title) {
    if (M.cartFit(me.map) !== 'shared') return true;
    const lowerSheet = me.sheet.length > 64 * M.SHEET && me.sheet.subarray(64 * M.SHEET).some((v) => v);
    if (!lowerSheet && !M.usesUpperSprites(me.map)) return true;
    return confirmDialog(title, 'This 128×64 map stores rows 32–63 where sprites 128–255 are. Those sprites will be overwritten by map data.\n\nContinue?', 'Continue');
  }

  function notCartSized(title) {
    if (M.cartFit(me.map) !== 'data') return false;
    showMessage(title, `A ${me.map.w}×${me.map.h} map is bigger than a cart's map memory (128×32, or 128×64 with the shared sprite rows).\n\nExport the map bytes (.bin), or add the map to a demo project in the Cart Builder, which packs it into data carts.`);
    return true;
  }

  async function exportCart() {
    if (notCartSized('New .p8 Cart') || !(await okToShare('New .p8 Cart'))) return;
    const text = M.buildCart({ m: me.map, sheet: me.sheet, pal: me.pal, name: me.name });
    download(text, `${fileBase()}.p8`);
    status.downloaded(`${fileBase()}.p8`);
    toast(`Downloaded ${fileBase()}.p8 (map, sprites and a viewer: arrow keys scroll)`);
  }

  async function writeIntoCart() {
    if (notCartSized('Write into .p8')) return;
    const file = await pickFile('.p8,text/plain');
    if (!file) return;
    const text = await file.text();
    if (!M.isCart(text)) { showMessage('Write into .p8', 'This is not a PICO-8 text cart (.p8).'); return; }
    const withSheet = el('input', { type: 'checkbox', checked: true });
    const res = await modal({
      title: `Write into ${file.name}`,
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: `The map replaces __map__${M.cartFit(me.map) === 'shared' ? ' and the shared sprite rows (sprites 128–255)' : ''}. Code, sound and music stay as they are.` }),
        el('label', { className: 'check' }, withSheet, el('span', { textContent: 'Also write the tileset into __gfx__' }))),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Write', primary: true, value: () => ({ sheet: withSheet.checked }) }],
    });
    if (!res || !(await okToShare('Write into .p8'))) return;
    download(M.writeIntoCart(text, me.map, { sheet: res.sheet ? me.sheet : null }), file.name);
    status.downloaded(file.name);
    const palNote = me.pal.some((c, i) => c !== i) ? `\n\nThe tileset uses a custom screen palette. Add to your _init():\n${M.palCode(me.pal, '').join('\n')}` : '';
    showMessage('Write into .p8', `Downloaded ${file.name} with the map${res.sheet ? ' and tileset' : ''}. Replace the original cart with it.${palNote}`);
  }

  function exportBin() {
    const bin = `${fileBase()}_${me.map.w}x${me.map.h}.bin`;
    download(new Blob([M.mapBytes(me.map)], { type: 'application/octet-stream' }), bin);
    status.downloaded(bin);
    toast(`${me.map.cells.length} bytes, row-major, one byte per cell`);
  }

  async function copyHex() {
    try {
      await navigator.clipboard.writeText(M.hexString(me.map));
      toast(`Copied ${me.map.cells.length * 2} hex digits (row-major)`);
    } catch {
      showMessage('Copy', 'The clipboard is not available in this browser.');
    }
  }

  async function exportPng() {
    const w = me.map.w * T;
    const h = me.map.h * T;
    const idx = new Uint8Array(w * h);
    const rows = sheetRows();
    for (let cy = 0; cy < me.map.h; cy++) {
      for (let cx = 0; cx < me.map.w; cx++) {
        const v = me.map.cells[cy * me.map.w + cx];
        const sx = (v & 15) * T;
        const sy = (v >> 4) * T;
        if (!v || sy >= rows) continue;
        for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) idx[(cy * T + y) * w + cx * T + x] = me.sheet[(sy + y) * M.SHEET + sx + x];
      }
    }
    const png = await encodeIndexedPng(w, h, idx, S.paletteRgb(me.pal));
    download(png, `${fileBase()}.png`);
    status.downloaded(`${fileBase()}.png`);
  }

  // ------------------------------------------------------------------ //
  // Keys + bindings                                                    //
  // ------------------------------------------------------------------ //

  const TOOL_KEYS = { b: 'pencil', u: 'rect', g: 'fill', i: 'picker', m: 'select', h: 'hand' };

  function onKey(e, typing) {
    if (e.type === 'keyup') return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && e.altKey && k === 'n') { e.preventDefault(); newMap(); return; }
    if (mod && k === 's') { e.preventDefault(); saveToLibrary({ asNew: e.shiftKey }); return; }
    if (mod && k === 'o') { e.preventDefault(); openFromLibrary(); return; }
    if (mod && k === 'i') { e.preventDefault(); importCart(); return; }
    if (typing) return;
    if (mod && (k === 'z' || k === 'y')) { e.preventDefault(); (k === 'y' || e.shiftKey ? redo : undo)(); return; }
    if (mod && k === 'c') { e.preventDefault(); copySel(); return; }
    if (mod && k === 'x') { e.preventDefault(); if (copySel()) clearSel(); return; }
    if (mod && k === 'v') { e.preventDefault(); paste(); return; }
    if (mod && k === 'a') { e.preventDefault(); me.sel = { x: 0, y: 0, w: me.map.w, h: me.map.h }; setTool('select'); return; }
    if (mod && k === 'd') { e.preventDefault(); me.sel = null; renderInfo(); requestRender(); return; }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSel(); return; }
    if (e.key === 'Escape') { me.sel = null; drag = null; renderInfo(); requestRender(); return; }
    if (e.key === ' ') { e.preventDefault(); me.space = true; dom.stage.classList.add('space'); return; }
    if (TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
    if (e.key === '[' || e.key === ']') { stepBrush(e.key === ']' ? 1 : -1); return; }
    if (e.key === '+' || e.key === '=') { zoomStep(1); return; }
    if (e.key === '-') { zoomStep(-1); return; }
    if (e.key === '0') { zoomFit(); return; }
    if (e.key === '1') { zoomTo(1); }
  }

  function bind() {
    dom.canvas.addEventListener('pointerdown', onDown);
    dom.canvas.addEventListener('pointermove', onMove);
    dom.canvas.addEventListener('pointerup', onUp);
    dom.canvas.addEventListener('pointercancel', onUp);
    dom.canvas.addEventListener('pointerleave', () => { me.hover = null; renderStatus(); requestRender(); });
    dom.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = dom.canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.shiftKey) zoomTo(me.zoom * (e.deltaY < 0 ? 1.25 : 0.8), e.clientX - r.left, e.clientY - r.top);
      else { viewAuto = false; me.panX -= e.deltaY; requestRender(); }
    }, { passive: false });
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ' && me.space) { me.space = false; dom.stage.classList.remove('space'); }
    });
    dom.tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b) setTool(b.dataset.tool);
    });
    dom.name.addEventListener('change', () => {
      me.name = dom.name.value.trim() || 'map';
      status.edit();
      scheduleSave();
    });
    for (const [box, key] of [[dom.grid, 'grid'], [dom.screens, 'screens'], [dom.numbers, 'numbers']]) {
      box.addEventListener('change', () => { me[key] = box.checked; requestRender(); });
    }
    $('#meZoomIn').addEventListener('click', () => zoomStep(1));
    $('#meZoomOut').addEventListener('click', () => zoomStep(-1));
    $('#meZoomFit').addEventListener('click', zoomFit);
    $('#meZoom1').addEventListener('click', () => zoomTo(1));
    new ResizeObserver(onStageResize).observe(dom.stage); // #200: refit or clamp, then render
    bindSheet();
    S.bindAssetDrop(dom.stage, (a) => {
      if (a.kind === 'map') openAsset(a);
      else if (a.kind === 'palette') setPal(a.colors.map((c, i) => c ?? i));
      else useImageAsTileset(a);
    });
    document.addEventListener('p8:workspace', () => { if (document.body.dataset.workspace === 'map') { if (!fitted) { fitted = true; zoomFit(); } renderAll(); } });
    document.addEventListener('p8:assets', (e) => {
      renderSheet();
      const id = e.detail?.id;
      if (!id || id === me.assetId) checkLibrary();
      status.refresh();
    });
    P8DocStatus.mount(dom.docStatus, status, { onRetry: (intent) => saveToLibrary(intent || {}), title: 'Map save status' });
    window.addEventListener('beforeunload', (e) => {
      if (saveTimer) saveSession();
      if (status.atRisk()) { e.preventDefault(); e.returnValue = ''; }
    });
  }
  let fitted = false;

  // ------------------------------------------------------------------ //
  // Suite integration                                                  //
  // ------------------------------------------------------------------ //

  S.registerTool({
    ws: 'map', category: 'create', name: 'Map Editor',
    desc: 'PICO-8 tile maps: paint with tiles or blocks from a sprite sheet, 128×32 / 128×64 cart maps or up to 256×256 for data carts, .p8 in and out.',
    tasks: [{ group: 'create', label: 'Build a map', hint: 'Paint a PICO-8 map with a tileset' }], color: '#29adff', tags: ['map', 'tiles', '.p8'], category: 'create',
  });
  // Send-to destinations (#57): open() does not ask, so `unsaved` triggers the central Replace / Cancel prompt
  const mapUnsaved = () => (status.dirty() ? 'The current map has changes that are not saved to the library.' : false);
  S.registerConsumer({ id: 'map-open', label: 'Map Editor', kinds: ['map'], unsaved: mapUnsaved, accepts: (a) => (a.w <= M.MAX_SIDE && a.h <= M.MAX_SIDE ? true : `The Map Editor supports up to ${M.MAX_SIDE}×${M.MAX_SIDE} cells.`), open: openAsset });
  S.registerConsumer({ id: 'map-tileset', label: 'Map Editor tileset', kinds: ['image'], accepts: tilesetOk, unsaved: mapUnsaved, open: useImageAsTileset });

  App.registerShortcuts('map', onKey);
  App.registerActions({
    'map-new': newMap,
    'map-open': openFromLibrary,
    'map-save': () => saveToLibrary(),
    'map-save-new': () => saveToLibrary({ asNew: true }),
    'map-import-p8': importCart,
    'map-sheet-library': tilesetFromLibrary,
    'map-sheet-p8': tilesetFromCart,
    'map-sheet-reload': reloadTileset,
    'map-pal-library': paletteFromLibrary,
    'map-undo': undo,
    'map-redo': redo,
    'map-cut': () => { if (copySel()) clearSel(); },
    'map-copy': copySel,
    'map-paste': paste,
    'map-delete': clearSel,
    'map-select-all': () => { me.sel = { x: 0, y: 0, w: me.map.w, h: me.map.h }; setTool('select'); },
    'map-deselect': () => { me.sel = null; renderInfo(); requestRender(); },
    'map-replace': replaceTile,
    'map-resize': resizeMap,
    'map-clear': clearMap,
    'map-export-p8': exportCart,
    'map-write-p8': writeIntoCart,
    'map-export-bin': exportBin,
    'map-copy-hex': copyHex,
    'map-export-png': exportPng,
  });

  /**
   * Public entry for other tools (Tile Maker). Opening a map replaces the map, its undo/redo history, tileset
   * and palette, so it always goes through the guarded 'map-open' Send to (#81): an unsaved map gets the
   * Replace / Cancel prompt before anything changes, and the size limit applies. Resolves true when the map
   * was opened; the incoming map stays unsaved (`saved: false` = temporary copy). importCartText asks itself.
   */
  const openAssetGuarded = (a, { saved = false } = {}) => S.openIn('map-open', a, { saved });
  window.P8MapEditor = { openAsset: openAssetGuarded, importCartText };

  buildSheetCanvas();
  rebuildMapCanvas();
  bind();
  renderAll();
  restoreSession();
  // #184: placeholder colors follow the theme (toggle or system setting)
  const rethemePlaceholders = () => { if (sheetBlank) rebuildAll(); };
  new MutationObserver(rethemePlaceholders).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', rethemePlaceholders);
})();

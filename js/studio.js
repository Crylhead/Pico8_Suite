// js/studio.js
// Pixel Studio workspace: a small Aseprite-style pixel editor restricted to what
// PICO-8 can show: 16 slots mapped to the 32 PICO-8 colors, fill patterns,
// layers + frames, sprite sheet / .p8 / [gfx] clipboard in and out.

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const K = P8Studio;
  const { EMPTY } = K;
  const { rgbOf, isValidPico, BASE_INDICES, HIDDEN_INDICES, encodeIndexedPng, quantize, buildDataCart } = P8;
  const { el, $, modal, showMessage, confirmDialog, toast, download, pickFile, decodeImage, formField, sanitizeFilename, store } = App;

  const KEYS = { settings: 'p8suite.studio', session: 'studio.session' };
  const ZOOMS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
  const UNDO_LIMIT = 200;
  const UNDO_BYTES = 160 * 1024 * 1024;
  const DRAW_TOOLS = new Set(['pencil', 'eraser', 'line', 'rect', 'ellipse', 'fill']);
  const SELECT_TOOLS = new Set(['select', 'selellipse', 'lasso', 'polygon', 'wand']);
  // Tools that share one toolbar button (Aseprite style): hover the button to see the others
  const TOOL_GROUPS = [
    { id: 'shapes', label: 'Shapes', tools: ['rect', 'ellipse'] },
    { id: 'select', label: 'Selection tools', tools: ['select', 'selellipse', 'lasso', 'polygon', 'wand'] },
  ];
  // M / Q: pressed again they step to the other tool of their pair
  const KEY_CYCLES = { m: ['select', 'selellipse'], q: ['lasso', 'polygon'] };
  const FLYOUT_DELAY = 500;  // ms of hovering before a group shows its other tools

  const saved = store.get(KEYS.settings, {}) || {};

  // Sieve patterns (from APaint): a 1-bit mask fixed to the canvas grid. Drawing only
  // touches pixels where the mask is set; everything else is left alone.
  const sievePattern = (name, n, fn) => {
    let bits = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) bits += fn(x, y) ? '1' : '0';
    return { name, w: n, h: n, bits };
  };
  const SIEVE_PRESETS = [
    sievePattern('50% checker', 8, (x, y) => (x + y) % 2 === 0),
    sievePattern('Horizontal lines', 8, (x, y) => y % 2 === 0),
    sievePattern('Vertical lines', 8, (x) => x % 2 === 0),
    sievePattern('25% dots', 8, (x, y) => x % 2 === 0 && y % 2 === 0),
    sievePattern('75% (inverse dots)', 8, (x, y) => !(x % 2 === 0 && y % 2 === 0)),
    sievePattern('Diagonal', 8, (x, y) => (x + y) % 4 === 0),
  ];
  const validSieve = (p) => p && typeof p.name === 'string' && p.w > 0 && p.h > 0 && typeof p.bits === 'string' && p.bits.length === p.w * p.h;
  const loadSieves = (list) => (Array.isArray(list) && list.some(validSieve) ? list.filter(validSieve) : SIEVE_PRESETS.map((p) => ({ ...p })));

  const ps = {
    doc: K.newDoc(128, 128),
    name: 'untitled',
    assetId: null,          // library asset this document was opened from / saved to
    dirty: false,
    frame: 0,
    layer: 0,
    tool: 'pencil',
    primary: 7,
    secondary: 0,
    brush: saved.brush || 1,
    filled: !!saved.filled,
    contiguous: saved.contiguous !== false,
    pattern: saved.pattern || 0,
    patternAlt: saved.patternAlt === 'transparent' ? 'transparent' : 'secondary',
    sieve: false,
    sieves: loadSieves(saved.sieves),
    sieveIndex: saved.sieveIndex || 0,
    mirrorX: false,
    mirrorY: false,
    zoom: 4,
    panX: 0,
    panY: 0,
    gridPx: saved.gridPx !== false,
    grid8: saved.grid8 !== false,
    gridSize: saved.gridSize || 8,
    tiled: false,
    onion: !!saved.onion,
    previewScale: saved.previewScale || 0,
    sel: null,              // {x, y, w, h, mask?}: mask = doc-sized Uint8Array for lasso / wand shapes
    floating: null,         // {x, y, w, h, data, lifted}
    xform: null,            // transform of the floating pixels: {src, w, h, cx, cy, sx, sy, angle, kx, ky (shear), orig}
    poly: null,             // polygon lasso in progress: {pts: [[x, y]], mode, base}
    altTool: null,          // tool to return to when Alt (temporary color picker) is released
    rotAlgo: saved.rotAlgo === 'fast' ? 'fast' : 'rotsprite',
    ink: ['lock', 'behind', 'shade', 'fade'].includes(saved.ink) ? saved.ink : 'normal',
    timeline: saved.timeline !== false,
    fades: null,            // fade tables the image brought along ({dark, bright, from}), used by the fade ink
    pixelPerfect: !!saved.pixelPerfect,
    customBrush: null,      // {w, h, data} picked up from a selection (brush 0)
    playing: false,
    undo: [],
    redo: [],
    clip: null,             // internal clipboard {w, h, data}
    hover: null,            // {x, y}
    spaceDown: false,
  };

  const dom = {
    stage: $('#psStage'),
    canvas: $('#psCanvas'),
    tools: $('#psTools'),
    timelineBtn: $('#psTimelineBtn'),
    primary: $('#psPrimary'),
    secondary: $('#psSecondary'),
    swap: $('#psSwap'),
    name: $('#psName'),
    size: $('#psSize'),
    brush: $('#psBrush'),
    brushCustom: $('#psBrushCustom'),
    inkWrap: $('#psInkWrap'),
    ink: $('#psInk'),
    pp: $('#psPP'),
    ppWrap: $('#psPPWrap'),
    xformWrap: $('#psXformWrap'),
    xAngle: $('#psXAngle'),
    xScaleX: $('#psXScaleX'),
    xScaleY: $('#psXScaleY'),
    xAlgo: $('#psXAlgo'),
    xApply: $('#psXApply'),
    xCancel: $('#psXCancel'),
    brushWrap: $('#psBrushWrap'),
    filled: $('#psFilled'),
    filledWrap: $('#psFilledWrap'),
    contig: $('#psContig'),
    contigWrap: $('#psContigWrap'),
    pattern: $('#psPattern'),
    patternAlt: $('#psPatternAlt'),
    patternEdit: $('#psPatternEdit'),
    patternCode: $('#psPatternCode'),
    sieve: $('#psSieve'),
    sieveSel: $('#psSieveSel'),
    sieveEdit: $('#psSieveEdit'),
    mirrorX: $('#psMirrorX'),
    mirrorY: $('#psMirrorY'),
    gridPx: $('#psGridPx'),
    grid8: $('#psGrid8'),
    tiled: $('#psTiled'),
    zoomLabel: $('#psZoomLabel'),
    status: { pos: $('#psPos'), cell: $('#psCell'), color: $('#psColor'), sel: $('#psSelInfo') },
    palette: $('#psPalette'),
    transp: $('#psTransp'),
    preview: $('#psPreview'),
    previewScale: $('#psPreviewScale'),
    layers: $('#psLayers'),
    frames: $('#psFrames'),
    play: $('#psPlay'),
    fps: $('#psFps'),
    onion: $('#psOnion'),
    frameInfo: $('#psFrameInfo'),
  };
  const ctx = dom.canvas.getContext('2d');

  // ------------------------------------------------------------------ //
  // Accessors                                                          //
  // ------------------------------------------------------------------ //

  const doc = () => ps.doc;
  const cel = (f = ps.frame, l = ps.layer) => ps.doc.frames[f].cels[l];
  const palRgb = () => ps.doc.pal.map(rgbOf);
  const inDoc = (x, y) => x >= 0 && y >= 0 && x < ps.doc.w && y < ps.doc.h;
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  const mod = (a, n) => ((a % n) + n) % n;
  /** In tiled view, coordinates outside the canvas wrap around (draw across the edges). */
  const wrapPt = (x, y) => (ps.tiled ? [mod(x, ps.doc.w), mod(y, ps.doc.h)] : [x, y]);
  const activeSieve = () => ps.sieves[Math.min(ps.sieveIndex, ps.sieves.length - 1)];
  function sieveAllows(x, y) {
    if (!ps.sieve) return true;
    const p = activeSieve();
    return !p || p.bits[mod(y, p.h) * p.w + mod(x, p.w)] === '1';
  }

  function persistSettings() {
    store.set(KEYS.settings, {
      brush: ps.brush, filled: ps.filled, contiguous: ps.contiguous, pattern: ps.pattern, patternAlt: ps.patternAlt,
      gridPx: ps.gridPx, grid8: ps.grid8, gridSize: ps.gridSize, onion: ps.onion, previewScale: ps.previewScale,
      sieves: ps.sieves, sieveIndex: ps.sieveIndex, rotAlgo: ps.rotAlgo, ink: ps.ink, pixelPerfect: ps.pixelPerfect,
      timeline: ps.timeline,
    });
  }

  // ------------------------------------------------------------------ //
  // Composite (doc -> RGBA offscreen canvas, updated per dirty rect)   //
  // ------------------------------------------------------------------ //

  const comp = document.createElement('canvas');
  const compCtx = comp.getContext('2d');
  let compImg = null;
  let overlay = null;        // Uint8Array(w*h) of shape preview pixels (EMPTY = none)
  let overlayBox = null;     // [x0, y0, x1, y1) of the overlay content
  let rgbCache = palRgb();
  let dirtyBox = null;
  let frameQueued = false;
  let onionCache = new Map(); // frame -> canvas

  function rebuildComposite() {
    const d = ps.doc;
    comp.width = d.w;
    comp.height = d.h;
    compImg = new ImageData(d.w, d.h);
    overlay = new Uint8Array(d.w * d.h).fill(EMPTY);
    overlayBox = null;
    rgbCache = palRgb();
    onionCache = new Map();
    recompose(0, 0, d.w, d.h);
  }

  function recompose(x0, y0, x1, y1) {
    const d = ps.doc;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(d.w, x1); y1 = Math.min(d.h, y1);
    if (x1 <= x0 || y1 <= y0) return;
    const cels = d.frames[ps.frame].cels;
    const vis = [];
    for (let l = d.layers.length - 1; l >= 0; l--) if (d.layers[l].visible) vis.push(cels[l]);
    const fl = ps.floating;
    const px = compImg.data;
    const rgb = rgbCache;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * d.w + x;
        let v = overlay[i];
        if (v === EMPTY && fl && x >= fl.x && y >= fl.y && x < fl.x + fl.w && y < fl.y + fl.h) v = fl.data[(y - fl.y) * fl.w + (x - fl.x)];
        if (v === EMPTY) {
          for (let k = 0; k < vis.length; k++) {
            const c = vis[k][i];
            if (c !== EMPTY) { v = c; break; }
          }
        }
        const o = i * 4;
        if (v === EMPTY) {
          px[o + 3] = 0;
        } else {
          const c = rgb[v & 15];
          px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
        }
      }
    }
    compCtx.putImageData(compImg, 0, 0, x0, y0, x1 - x0, y1 - y0);
  }

  /** Marks doc pixels as changed; recomposited + redrawn on the next animation frame. */
  function dirty(x0, y0, x1 = x0 + 1, y1 = y0 + 1) {
    if (!dirtyBox) dirtyBox = [x0, y0, x1, y1];
    else {
      dirtyBox[0] = Math.min(dirtyBox[0], x0); dirtyBox[1] = Math.min(dirtyBox[1], y0);
      dirtyBox[2] = Math.max(dirtyBox[2], x1); dirtyBox[3] = Math.max(dirtyBox[3], y1);
    }
    requestDraw();
  }
  const dirtyAll = () => dirty(0, 0, ps.doc.w, ps.doc.h);

  function requestDraw() {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      if (dirtyBox) {
        const [a, b, c, d] = dirtyBox;
        dirtyBox = null;
        recompose(a, b, c, d);
      }
      draw();
      drawPreview();
    });
  }

  function frameCanvas(f) {
    if (onionCache.has(f)) return onionCache.get(f);
    const d = ps.doc;
    const flat = K.flatten(d, f);
    const img = new ImageData(d.w, d.h);
    const rgb = rgbCache;
    for (let i = 0; i < flat.length; i++) {
      const v = flat[i];
      if (v === EMPTY) continue;
      const c = rgb[v & 15];
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    const c = document.createElement('canvas');
    c.width = d.w;
    c.height = d.h;
    c.getContext('2d').putImageData(img, 0, 0);
    onionCache.set(f, c);
    return c;
  }

  // ------------------------------------------------------------------ //
  // Main canvas drawing                                                //
  // ------------------------------------------------------------------ //

  let checker = null;
  function checkerPattern() {
    if (checker) return checker;
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#3a3a42';
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = '#2a2a30';
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    checker = ctx.createPattern(c, 'repeat');
    return checker;
  }

  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(dom.stage.clientWidth * dpr));
    const h = Math.max(1, Math.round(dom.stage.clientHeight * dpr));
    if (dom.canvas.width !== w || dom.canvas.height !== h) {
      dom.canvas.width = w;
      dom.canvas.height = h;
    }
    return dpr;
  }

  function draw() {
    if (document.body.dataset.workspace !== 'studio') return;
    const dpr = fitCanvas();
    const d = ps.doc;
    const cw = dom.canvas.width / dpr;
    const ch = dom.canvas.height / dpr;
    const z = ps.zoom;
    const ox = ps.panX;
    const oy = ps.panY;
    const W = d.w * z;
    const H = d.h * z;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = false;

    const pat = checkerPattern();
    pat.setTransform?.(new DOMMatrix().translate(ox, oy));
    const drawImageAt = (x, y, alpha) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = pat;
      ctx.fillRect(x, y, W, H);
      if (ps.onion && d.frames.length > 1 && alpha === 1) {
        ctx.globalAlpha = 0.28;
        if (ps.frame > 0) ctx.drawImage(frameCanvas(ps.frame - 1), x, y, W, H);
        if (ps.frame < d.frames.length - 1) ctx.drawImage(frameCanvas(ps.frame + 1), x, y, W, H);
        ctx.globalAlpha = 1;
      }
      ctx.drawImage(comp, x, y, W, H);
      ctx.globalAlpha = 1;
    };

    if (ps.tiled) {
      for (let ty = -1; ty <= 1; ty++) for (let tx = -1; tx <= 1; tx++) if (tx || ty) drawImageAt(ox + tx * W, oy + ty * H, 0.55);
    }
    drawImageAt(ox, oy, 1);

    // Visible pixel range
    const vx0 = Math.max(0, Math.floor(-ox / z));
    const vy0 = Math.max(0, Math.floor(-oy / z));
    const vx1 = Math.min(d.w, Math.ceil((cw - ox) / z));
    const vy1 = Math.min(d.h, Math.ceil((ch - oy) / z));
    const line = 1 / dpr;

    if (ps.gridPx && z >= 6) {
      ctx.fillStyle = 'rgba(128,128,140,0.22)';
      for (let x = vx0; x <= vx1; x++) ctx.fillRect(ox + x * z, oy + vy0 * z, line, (vy1 - vy0) * z);
      for (let y = vy0; y <= vy1; y++) ctx.fillRect(ox + vx0 * z, oy + y * z, (vx1 - vx0) * z, line);
    }
    if (ps.grid8 && ps.gridSize * z >= 6) {
      const g = ps.gridSize;
      ctx.fillStyle = 'rgba(41,173,255,0.45)';
      for (let x = Math.ceil(vx0 / g) * g; x <= vx1; x += g) ctx.fillRect(ox + x * z, oy + vy0 * z, line, (vy1 - vy0) * z);
      for (let y = Math.ceil(vy0 / g) * g; y <= vy1; y += g) ctx.fillRect(ox + vx0 * z, oy + y * z, (vx1 - vx0) * z, line);
    }
    // PICO-8 screen size marker on large canvases
    if (d.w > 128 || d.h > 128) {
      ctx.strokeStyle = 'rgba(255,163,0,0.55)';
      ctx.lineWidth = line;
      ctx.setLineDash([4, 4]);
      for (let y = 0; y < d.h; y += 128) for (let x = 0; x < d.w; x += 128) ctx.strokeRect(ox + x * z, oy + y * z, Math.min(128, d.w - x) * z, Math.min(128, d.h - y) * z);
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = 'rgba(160,160,175,0.6)';
    ctx.lineWidth = line;
    ctx.strokeRect(ox - line, oy - line, W + 2 * line, H + 2 * line);

    // Mirror axes
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = 'rgba(255,0,77,0.7)';
    if (ps.mirrorX) { ctx.beginPath(); ctx.moveTo(ox + W / 2, oy); ctx.lineTo(ox + W / 2, oy + H); ctx.stroke(); }
    if (ps.mirrorY) { ctx.beginPath(); ctx.moveTo(ox, oy + H / 2); ctx.lineTo(ox + W, oy + H / 2); ctx.stroke(); }
    ctx.setLineDash([]);

    // Lasso path while drawing
    if (drag?.tool === 'lasso' && drag.pts.length > 1) {
      ctx.beginPath();
      drag.pts.forEach(([x, y], i) => (i ? ctx.lineTo(ox + (x + 0.5) * z, oy + (y + 0.5) * z) : ctx.moveTo(ox + (x + 0.5) * z, oy + (y + 0.5) * z)));
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Polygon lasso in progress: corners, then a rubber band to the pointer
    if (ps.poly) {
      const pts = ps.poly.pts;
      const c = (x, y) => [ox + (x + 0.5) * z, oy + (y + 0.5) * z];
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(...c(x, y)) : ctx.moveTo(...c(x, y))));
      if (ps.hover) ctx.lineTo(...c(ps.hover.x, ps.hover.y));
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.setLineDash([]);
      const [fx, fy] = c(...pts[0]);
      const closing = pts.length > 2 && ps.hover && Math.abs(ps.hover.x - pts[0][0]) <= 1 && Math.abs(ps.hover.y - pts[0][1]) <= 1;
      ctx.fillStyle = closing ? '#ffec27' : '#fff';
      ctx.fillRect(Math.round(fx) - 3, Math.round(fy) - 3, 6, 6);
      ctx.strokeRect(Math.round(fx) - 3.5, Math.round(fy) - 3.5, 7, 7);
    }

    // Shaped selection (lasso / wand): its outline
    if (ps.sel?.mask && !ps.floating) {
      const m = ps.sel.mask;
      const s = ps.sel;
      ctx.beginPath();
      for (let y = s.y; y <= s.y + s.h; y++) {
        for (let x = s.x; x <= s.x + s.w; x++) {
          const a = inDoc(x, y) && m[y * d.w + x];
          const left = inDoc(x - 1, y) && m[y * d.w + x - 1];
          const up = inDoc(x, y - 1) && m[(y - 1) * d.w + x];
          if (!!a !== !!left) { ctx.moveTo(ox + x * z + 0.5, oy + y * z); ctx.lineTo(ox + x * z + 0.5, oy + (y + 1) * z); }
          if (!!a !== !!up) { ctx.moveTo(ox + x * z, oy + y * z + 0.5); ctx.lineTo(ox + (x + 1) * z, oy + y * z + 0.5); }
        }
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.stroke();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Selection / floating selection
    const box = ps.floating || (ps.sel?.mask ? null : ps.sel);
    if (box) {
      const x = ox + box.x * z;
      const y = oy + box.y * z;
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#000';
      ctx.strokeRect(x + 0.5, y + 0.5, box.w * z - 1, box.h * z - 1);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = ps.floating ? '#ffec27' : '#fff';
      ctx.strokeRect(x + 0.5, y + 0.5, box.w * z - 1, box.h * z - 1);
      ctx.setLineDash([]);
    }

    // Transform handles (every selection tool): scale on the squares, rotate just outside a corner
    if (SELECT_TOOLS.has(ps.tool) && !ps.poly && (ps.floating || ps.sel) && !(drag && SELECTING_DRAGS.has(drag.tool))) {
      const fr = xformFrame();
      if (fr) {
        const scr = (q) => [ox + q.x * z, oy + q.y * z];
        if (ps.xform && (ps.xform.angle || ps.xform.kx || ps.xform.ky)) {
          ctx.beginPath();
          fr.corners.forEach((c, i) => { const [sx, sy] = scr(c); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
          ctx.closePath();
          ctx.strokeStyle = '#ffec27';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        for (const hd of fr.handles) {
          const [sx, sy] = scr(hd);
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1;
          ctx.fillRect(Math.round(sx) - HANDLE + 0.5, Math.round(sy) - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1);
          ctx.strokeRect(Math.round(sx) - HANDLE + 0.5, Math.round(sy) - HANDLE + 0.5, HANDLE * 2 - 1, HANDLE * 2 - 1);
        }
      }
    }

    // Brush cursor: the pixels the next click would set, then an outline
    const h = ps.hover;
    if (h && DRAW_TOOLS.has(ps.tool) && ps.tool !== 'fill' && !drag?.pan && !ps.spaceDown) {
      const s = ps.tool === 'line' || ps.tool === 'rect' || ps.tool === 'ellipse' ? 1 : ps.brush;
      const cb = s === 0 ? ps.customBrush : null;
      const bw = cb ? cb.w : s;
      const bh = cb ? cb.h : s;
      const offX = cb ? Math.floor(cb.w / 2) : Math.floor((s - 1) / 2);
      const offY = cb ? Math.floor(cb.h / 2) : offX;
      if (!drag) drawBrushPreview(h, s, ox, oy, z);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ox + (h.x - offX) * z + 0.5, oy + (h.y - offY) * z + 0.5, bw * z - 1, bh * z - 1);
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.strokeRect(ox + (h.x - offX) * z - 0.5, oy + (h.y - offY) * z - 0.5, bw * z + 1, bh * z + 1);
    }
  }

  function drawBrushPreview(h, size, ox, oy, z) {
    const d = ps.doc;
    const erase = ps.tool === 'eraser';
    const sel = ps.floating ? null : ps.sel;
    const offs = ps.tiled ? [-1, 0, 1] : [0];
    const seen = new Set();
    brushPixels(h.x, h.y, size, (px, py, bv) => {
      const [x, y] = wrapPt(px, py);
      const k = y * 65536 + x;
      if (!inDoc(x, y) || seen.has(k) || !sieveAllows(x, y) || (sel && !selHas(sel, x, y))) return;
      seen.add(k);
      const v = erase ? EMPTY : bv != null ? bv : patterned(x, y, ps.primary, ps.secondary);
      if (v == null) return;
      ctx.fillStyle = v === EMPTY ? 'rgba(255,255,255,0.35)' : `rgb(${rgbCache[v & 15]})`;
      for (const ty of offs) for (const tx of offs) ctx.fillRect(ox + (x + tx * d.w) * z, oy + (y + ty * d.h) * z, z, z);
    });
  }

  function drawPreview() {
    const c = dom.preview;
    const d = ps.doc;
    const box = 176;
    const auto = Math.max(1, Math.floor(box / Math.max(d.w, d.h)));
    const s = ps.previewScale || auto;
    const fit = Math.min(1, box / (d.w * s), box / (d.h * s));
    const w = Math.max(1, Math.round(d.w * s * fit));
    const h = Math.max(1, Math.round(d.h * s * fit));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = fit < 1;
    const t = d.transparent >= 0 ? d.transparent : 0;
    const bg = rgbCache[t];
    g.fillStyle = `rgb(${bg})`;
    g.fillRect(0, 0, w, h);
    g.drawImage(comp, 0, 0, w, h);
  }

  // ------------------------------------------------------------------ //
  // View: zoom + pan                                                   //
  // ------------------------------------------------------------------ //

  function setZoom(z, ax = null, ay = null) {
    z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    if (ax == null) { ax = dom.stage.clientWidth / 2; ay = dom.stage.clientHeight / 2; }
    const ix = (ax - ps.panX) / ps.zoom;
    const iy = (ay - ps.panY) / ps.zoom;
    ps.zoom = z;
    ps.panX = Math.round(ax - ix * z);
    ps.panY = Math.round(ay - iy * z);
    dom.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    requestDraw();
  }

  function stepZoom(dir, ax, ay) {
    const z = ps.zoom;
    const next = dir > 0 ? ZOOMS.find((v) => v > z + 1e-6) : [...ZOOMS].reverse().find((v) => v < z - 1e-6);
    if (next) setZoom(next, ax, ay);
  }

  function zoomFit() {
    const d = ps.doc;
    const sw = dom.stage.clientWidth - 32;
    const sh = dom.stage.clientHeight - 32;
    if (sw <= 0 || sh <= 0) return;
    const z = [...ZOOMS].reverse().find((v) => d.w * v <= sw && d.h * v <= sh) || ZOOMS[0];
    ps.zoom = z;
    ps.panX = Math.round((dom.stage.clientWidth - d.w * z) / 2);
    ps.panY = Math.round((dom.stage.clientHeight - d.h * z) / 2);
    dom.zoomLabel.textContent = `${Math.round(z * 100)}%`;
    requestDraw();
  }

  const toPixel = (clientX, clientY) => {
    const r = dom.canvas.getBoundingClientRect();
    return { x: Math.floor((clientX - r.left - ps.panX) / ps.zoom), y: Math.floor((clientY - r.top - ps.panY) / ps.zoom) };
  };

  // ------------------------------------------------------------------ //
  // Undo / redo                                                        //
  // ------------------------------------------------------------------ //
  //
  // { kind:'px', frame, layer, x, y, w, h, before, after }  pixel patch
  // { kind:'doc', snapshot, frame, layer }                   whole document (structure changes)

  const entryBytes = (e) => (e.kind === 'px' ? e.before.length * 2 : e.snapshot.frames.length * e.snapshot.layers.length * e.snapshot.w * e.snapshot.h);

  function pushUndo(entry) {
    ps.undo.push(entry);
    ps.redo = [];
    let bytes = ps.undo.reduce((s, e) => s + entryBytes(e), 0);
    while (ps.undo.length > UNDO_LIMIT || (bytes > UNDO_BYTES && ps.undo.length > 1)) bytes -= entryBytes(ps.undo.shift());
    changed();
  }

  function applyEntry(e, from, to) {
    if (e.kind === 'px') {
      ps.frame = Math.min(e.frame, ps.doc.frames.length - 1);
      ps.layer = Math.min(e.layer, ps.doc.layers.length - 1);
      K.blit(e[to], e.w, e.h, cel(e.frame, e.layer), ps.doc.w, ps.doc.h, e.x, e.y);
      onionCache = new Map();
      renderFrameChrome();
      dirty(e.x, e.y, e.x + e.w, e.y + e.h);
      scheduleThumb(e.frame);
      return e;
    }
    const cur = ps.doc;
    const curState = { frame: ps.frame, layer: ps.layer };
    ps.doc = e.snapshot;
    ps.frame = Math.min(e.frame, ps.doc.frames.length - 1);
    ps.layer = Math.min(e.layer, ps.doc.layers.length - 1);
    afterDocReplaced();
    return { kind: 'doc', snapshot: cur, ...curState };
  }

  function undo() {
    if (ps.floating) {
      // Drop the floating pixels first; a lifted selection is restored by undoing the lift.
      const lifted = ps.floating.lifted;
      ps.floating = null;
      dirtyAll();
      if (!lifted) return;
    }
    const e = ps.undo.pop();
    if (!e) return;
    const r = applyEntry(e, 'after', 'before');
    ps.redo.push(r);
    changed();
  }

  function redo() {
    commitFloating();
    const e = ps.redo.pop();
    if (!e) return;
    const r = applyEntry(e, 'before', 'after');
    ps.undo.push(r);
    changed();
  }

  /** Records a structural change: fn mutates ps.doc (or returns a new doc). */
  function docOp(fn) {
    commitFloating();
    const snapshot = K.cloneDoc(ps.doc);
    const entry = { kind: 'doc', snapshot, frame: ps.frame, layer: ps.layer };
    const res = fn(ps.doc);
    if (res === false) return;
    if (res && res !== true) ps.doc = res;
    ps.undo.push(entry);
    ps.redo = [];
    ps.frame = Math.min(ps.frame, ps.doc.frames.length - 1);
    ps.layer = Math.min(ps.layer, ps.doc.layers.length - 1);
    afterDocReplaced();
    changed();
  }

  // ------------------------------------------------------------------ //
  // Pixel edits                                                        //
  // ------------------------------------------------------------------ //

  let edit = null;

  function beginEdit() {
    return { frame: ps.frame, layer: ps.layer, before: cel().slice(), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  }

  function endEdit(e) {
    if (!e || e.x1 < e.x0) return;
    const w = e.x1 - e.x0 + 1;
    const h = e.y1 - e.y0 + 1;
    const c = cel(e.frame, e.layer);
    pushUndo({
      kind: 'px', frame: e.frame, layer: e.layer, x: e.x0, y: e.y0, w, h,
      before: K.crop(e.before, ps.doc.w, e.x0, e.y0, w, h),
      after: K.crop(c, ps.doc.w, e.x0, e.y0, w, h),
    });
    onionCache.delete(e.frame);
    scheduleThumb(e.frame);
  }

  /** Writes one pixel into the current cel (respecting the selection clip). */
  function setPx(e, x, y, v) {
    if (!inDoc(x, y)) return;
    const s = ps.sel;
    if (s && !ps.floating && !selHas(s, x, y)) return;
    const c = cel(e.frame, e.layer);
    const i = y * ps.doc.w + x;
    if (c[i] === v) return;
    c[i] = v;
    if (x < e.x0) e.x0 = x;
    if (y < e.y0) e.y0 = y;
    if (x > e.x1) e.x1 = x;
    if (y > e.y1) e.y1 = y;
    dirty(x, y);
  }

  /** Color for (x,y) after the fill pattern; null = leave the pixel alone. */
  function patterned(x, y, color, alt) {
    if (color === EMPTY || !ps.pattern || !K.patternBit(ps.pattern, x, y)) return color;
    return ps.patternAlt === 'transparent' ? null : alt;
  }

  /** Calls put(x, y) for every pixel the brush covers at (x,y), mirrored as configured. */
  /** Calls put(x, y, brushColor) for every pixel the brush covers at (x,y); size 0 = the custom brush. */
  function brushPixels(x, y, size, put) {
    const d = ps.doc;
    const cb = size === 0 ? ps.customBrush : null;
    const bw = cb ? cb.w : size;
    const bh = cb ? cb.h : size;
    const ox = cb ? Math.floor(cb.w / 2) : Math.floor((size - 1) / 2);
    const oy = cb ? Math.floor(cb.h / 2) : ox;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const bv = cb ? cb.data[by * cb.w + bx] : null;
        if (cb && bv === EMPTY) continue;
        const px = x - ox + bx;
        const py = y - oy + by;
        put(px, py, bv);
        if (ps.mirrorX) put(d.w - 1 - px, py, bv);
        if (ps.mirrorY) put(px, d.h - 1 - py, bv);
        if (ps.mirrorX && ps.mirrorY) put(d.w - 1 - px, d.h - 1 - py, bv);
      }
    }
  }

  /** palette slots ordered dark -> bright by their screen color (shade ink steps along it) */
  function shadeRamp() {
    return [...Array(16).keys()].sort((a, b) => P8.lum709(P8.rgbOf(ps.doc.pal[a]) || [0, 0, 0]) - P8.lum709(P8.rgbOf(ps.doc.pal[b]) || [0, 0, 0]) || a - b);
  }

  /**
   * Fade ink: the next slot of each slot along the bright and the dark fade ({brighter, darker},
   * 16 slots each). The tables come from the image (fades it brought from a data cart) or from
   * Palette & Fades. A missing direction is the other one walked backwards.
   */
  let fadeWarned = false;
  function fadeShadeMap() {
    const own = ps.fades;
    const sets = own || App.fadeSets();
    const next = (f) => {
      if (!f) return null;
      return Array.from({ length: 16 }, (_, c) => {
        for (const row of f.tables) { const v = row[c] & 15; if (v !== c) return v; }
        return c;
      });
    };
    let darker = next(sets.dark);
    let brighter = next(sets.bright);
    const back = (m) => Array.from({ length: 16 }, (_, c) => { const i = m.findIndex((v, s) => v === c && s !== c); return i < 0 ? c : i; });
    if (!darker && brighter) darker = back(brighter);
    if (!brighter && darker) brighter = back(darker);
    if (!darker) {
      if (!fadeWarned) { toast('No fades to shade along: define them in Palette & Fades. Using the palette brightness.', 'warn', 4000); fadeWarned = true; }
      return null;
    }
    if (!own && !fadeWarned && sets.palette.some((p, i) => p != null && p !== ps.doc.pal[i])) {
      toast('The image palette differs from the Palette & Fades palette: its fades are used by slot number.', 'warn', 4000);
      fadeWarned = true;
    }
    return { darker, brighter };
  }

  /**
   * Ink (Aseprite / Deluxe Paint): normal; lock = only on filled pixels; behind = only on empty
   * pixels; shade = the pixel one step brighter (left button) / darker (right) along the palette;
   * fade = the same along the fade tables.
   */
  function inked(e, x, y, v, which) {
    const cur = cel(e.frame, e.layer)[y * ps.doc.w + x];
    const empty = cur === EMPTY;
    if (ps.ink === 'lock' && empty) return null;
    if (ps.ink === 'behind' && !empty) return null;
    if ((ps.ink === 'shade' || ps.ink === 'fade') && v !== EMPTY) {
      if (empty) return null;
      const k = y * ps.doc.w + x;
      e.shaded ||= new Set();
      if (e.shaded.has(k)) return null; // once per stroke
      e.shaded.add(k);
      if (ps.ink === 'fade') {
        if (e.fadeMap === undefined) e.fadeMap = fadeShadeMap();
        if (e.fadeMap) return (which === 'secondary' ? e.fadeMap.darker : e.fadeMap.brighter)[cur & 15];
      }
      const r = e.ramp ||= shadeRamp();
      const i = r.indexOf(cur);
      return r[Math.max(0, Math.min(15, i + (which === 'secondary' ? -1 : 1)))];
    }
    return v;
  }

  function stamp(e, x, y, color, alt, which = 'primary') {
    brushPixels(x, y, ps.brush, (px, py, bv) => {
      [px, py] = wrapPt(px, py);
      if (!sieveAllows(px, py) || !inDoc(px, py)) return;
      // custom brush: its own colors (the eraser erases its shape)
      let v = bv != null ? (color === EMPTY ? EMPTY : bv) : patterned(px, py, color, alt);
      if (v == null) return;
      v = inked(e, px, py, v, which);
      if (v != null) setPx(e, px, py, v);
    });
  }

  /** pixel perfect (Aseprite): drop the middle pixel of an L-shaped corner in a 1 px stroke */
  function pixelPerfect(d, p) {
    if (!ps.pixelPerfect || ps.brush !== 1 || d.tool !== 'pencil') return;
    const pts = d.pts;
    if (pts.length && pts[pts.length - 1].x === p.x && pts[pts.length - 1].y === p.y) return;
    pts.push(p);
    if (pts.length < 3) return;
    const [a, b, c] = pts.slice(-3);
    if (Math.abs(a.x - c.x) === 1 && Math.abs(a.y - c.y) === 1 && (b.x === a.x || b.x === c.x) && (b.y === a.y || b.y === c.y)) {
      const e = d.edit;
      brushPixels(b.x, b.y, 1, (px, py) => { [px, py] = wrapPt(px, py); if (inDoc(px, py) && !(px === c.x && py === c.y) && !(px === a.x && py === a.y)) setPx(e, px, py, e.before[py * ps.doc.w + px]); });
      pts.splice(pts.length - 2, 1);
    }
  }

  // Shape preview (overlay) ------------------------------------------- //

  function clearOverlay() {
    if (!overlayBox) return;
    const [x0, y0, x1, y1] = overlayBox;
    const w = ps.doc.w;
    for (let y = y0; y < y1; y++) overlay.fill(EMPTY, y * w + x0, y * w + x1);
    overlayBox = null;
    dirty(x0, y0, x1, y1);
  }

  function setOverlay(points) {
    clearOverlay();
    const d = ps.doc;
    const s = ps.sel;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y, v] of points) {
      if (!inDoc(x, y)) continue;
      if (s && !selHas(s, x, y)) continue;
      overlay[y * d.w + x] = v;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    if (x1 >= x0) {
      overlayBox = [x0, y0, x1 + 1, y1 + 1];
      dirty(x0, y0, x1 + 1, y1 + 1);
    }
  }

  /**
   * ink: the stroke's ink context ({frame, layer}, kept for the whole drag so the fade / shade
   * ramps are worked out once); every preview starts with no pixel shaded yet.
   */
  function shapePoints(tool, a, b, color, alt, shift, which = 'primary', ink = { frame: ps.frame, layer: ps.layer }) {
    ink.shaded = null;
    let { x: x1, y: y1 } = b;
    const { x: x0, y: y0 } = a;
    if (shift && tool === 'line') {
      // snap to 0/45/90 degrees
      const dx = x1 - x0;
      const dy = y1 - y0;
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.max(Math.abs(dx), Math.abs(dy));
      x1 = x0 + Math.round(Math.cos(ang) * len);
      y1 = y0 + Math.round(Math.sin(ang) * len);
    } else if (shift) {
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + Math.sign(x1 - x0 || 1) * s;
      y1 = y0 + Math.sign(y1 - y0 || 1) * s;
    }
    const pts = [];
    const seen = new Set();
    const add = (x, y) => {
      [x, y] = wrapPt(x, y);
      const k = y * 65536 + x;
      if (seen.has(k)) return;
      seen.add(k);
      if (!sieveAllows(x, y)) return;
      let v = patterned(x, y, color, alt);
      if (v != null) v = inked(ink, x, y, v, which);
      if (v != null) pts.push([x, y, v]);
    };
    const plot = (x, y) => brushPixels(x, y, 1, add);
    if (tool === 'line') K.line(x0, y0, x1, y1, plot);
    else if (tool === 'rect') K.rect(x0, y0, x1, y1, ps.filled, plot);
    else K.ellipse(x0, y0, x1, y1, ps.filled, plot);
    return pts;
  }

  function commitOverlay() {
    if (!overlayBox) return;
    const e = beginEdit();
    const [x0, y0, x1, y1] = overlayBox;
    const w = ps.doc.w;
    const c = cel();
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * w + x;
        const v = overlay[i];
        if (v === EMPTY || c[i] === v) continue;
        c[i] = v;
        if (x < e.x0) e.x0 = x;
        if (y < e.y0) e.y0 = y;
        if (x > e.x1) e.x1 = x;
        if (y > e.y1) e.y1 = y;
      }
    }
    clearOverlay();
    endEdit(e);
  }

  function floodFill(x, y, color, alt, which = 'primary') {
    [x, y] = wrapPt(x, y);
    if (!inDoc(x, y)) return;
    const d = ps.doc;
    const e = beginEdit();
    const region = K.fillRegion(cel(), d.w, d.h, x, y, ps.contiguous);
    for (const i of region) {
      const px = i % d.w;
      const py = (i - px) / d.w;
      if (!sieveAllows(px, py)) continue;
      let v = patterned(px, py, color, alt);
      if (v != null) v = inked(e, px, py, v, which);
      if (v != null) setPx(e, px, py, v);
    }
    endEdit(e);
  }

  /** Top-most visible pixel at (x,y) of the current frame. */
  function pixelAt(x, y) {
    const d = ps.doc;
    const i = y * d.w + x;
    const cels = d.frames[ps.frame].cels;
    for (let l = d.layers.length - 1; l >= 0; l--) {
      if (d.layers[l].visible && cels[l][i] !== EMPTY) return cels[l][i];
    }
    return EMPTY;
  }

  function pickColor(x, y, which) {
    [x, y] = wrapPt(x, y);
    if (!inDoc(x, y)) return;
    const v = pixelAt(x, y);
    const slot = v === EMPTY ? (ps.doc.transparent >= 0 ? ps.doc.transparent : 0) : v;
    if (which === 'secondary') ps.secondary = slot;
    else ps.primary = slot;
    renderColors();
  }

  // ------------------------------------------------------------------ //
  // Selection + floating pixels                                        //
  // ------------------------------------------------------------------ //

  const inBox = (b, x, y) => b && x >= b.x && y >= b.y && x < b.x + b.w && y < b.y + b.h;
  /** inside the selection (its box, and its mask for lasso / wand shapes) */
  const selHas = (s, x, y) => inBox(s, x, y) && (!s.mask || s.mask[y * ps.doc.w + x] === 1);
  /** the selection as a doc-sized mask (rectangles too) */
  function selMask(s = ps.sel) {
    if (!s) return null;
    if (s.mask) return s.mask;
    const d = ps.doc;
    const m = new Uint8Array(d.w * d.h);
    for (let y = s.y; y < s.y + s.h; y++) m.fill(1, y * d.w + s.x, y * d.w + s.x + s.w);
    return m;
  }
  /** mask -> selection (box + mask) or null */
  function selFromMask(m) {
    const d = ps.doc;
    const b = m && K.maskBox(m, d.w, d.h);
    if (!b) return null;
    let full = true;
    for (let y = b.y; y < b.y + b.h && full; y++) for (let x = b.x; x < b.x + b.w; x++) if (!m[y * d.w + x]) { full = false; break; }
    return full ? b : { ...b, mask: m };
  }
  /** Shift adds, Alt subtracts, Shift+Alt intersects (Aseprite) */
  const selModeOf = (e) => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');

  function clampSel(s) {
    const d = ps.doc;
    const x0 = Math.max(0, s.x);
    const y0 = Math.max(0, s.y);
    const x1 = Math.min(d.w, s.x + s.w);
    const y1 = Math.min(d.h, s.y + s.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  /** Cuts the selected pixels of the current layer into a floating selection. */
  function liftSelection() {
    if (ps.floating || !ps.sel) return;
    const s = ps.sel;
    const d = ps.doc;
    const data = K.crop(cel(), d.w, s.x, s.y, s.w, s.h);
    if (s.mask) for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (!s.mask[(s.y + y) * d.w + s.x + x]) data[y * s.w + x] = EMPTY;
    const e = beginEdit();
    ps.sel = null; // so setPx isn't clipped
    for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) if (!s.mask || s.mask[y * d.w + x]) setPx(e, x, y, EMPTY);
    endEdit(e);
    ps.floating = { ...s, data, lifted: e.x1 >= e.x0 };
    dirty(s.x, s.y, s.x + s.w, s.y + s.h);
  }

  function commitFloating() {
    const f = ps.floating;
    if (!f) return;
    ps.floating = null;
    ps.xform = null;
    const e = beginEdit();
    const sel = ps.sel;
    ps.sel = null;
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const v = f.data[y * f.w + x];
        if (v !== EMPTY) setPx(e, f.x + x, f.y + y, v);
      }
    }
    endEdit(e);
    // the selection keeps the shape of the pixels that were placed
    const d = ps.doc;
    let m = null;
    if (f.data.includes(EMPTY)) {
      m = new Uint8Array(d.w * d.h);
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (f.data[y * f.w + x] !== EMPTY && inDoc(f.x + x, f.y + y)) m[(f.y + y) * d.w + f.x + x] = 1;
    }
    ps.sel = (m ? selFromMask(m) : clampSel(f)) || sel;
    dirty(f.x, f.y, f.x + f.w, f.y + f.h);
    renderStatus();
  }

  function deselect() {
    commitFloating();
    ps.sel = null;
    requestDraw();
    renderStatus();
  }

  function selectAll() {
    commitFloating();
    ps.sel = { x: 0, y: 0, w: ps.doc.w, h: ps.doc.h };
    requestDraw();
    renderStatus();
  }

  function deleteSelection() {
    if (ps.floating) {
      const f = ps.floating;
      ps.floating = null;
      ps.sel = null;
      dirty(f.x, f.y, f.x + f.w, f.y + f.h);
      return;
    }
    const s = ps.sel;
    if (!s) return;
    const e = beginEdit();
    for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) setPx(e, x, y, EMPTY); // setPx keeps to the mask
    endEdit(e);
  }

  function invertSelection() {
    commitFloating();
    const d = ps.doc;
    const m = selMask() || new Uint8Array(d.w * d.h);
    ps.sel = selFromMask(Uint8Array.from(m, (v) => 1 - v));
    requestDraw();
    renderStatus();
  }

  /** every pixel of the primary color on the current layer */
  function selectColor() {
    commitFloating();
    const d = ps.doc;
    ps.sel = selFromMask(Uint8Array.from(cel(), (v) => (v === ps.primary ? 1 : 0)));
    if (!ps.sel) toast(`No pixel of color ${ps.primary} on this layer`, 'info');
    setTool(SELECT_TOOLS.has(ps.tool) ? ps.tool : 'select');
    renderStatus();
  }

  function moveFloatingBy(dx, dy) {
    if (!ps.floating) {
      if (!ps.sel) return;
      liftSelection();
    }
    const f = ps.floating;
    dirty(f.x, f.y, f.x + f.w, f.y + f.h);
    f.x += dx;
    f.y += dy;
    if (ps.xform) { ps.xform.cx += dx; ps.xform.cy += dy; }
    dirty(f.x, f.y, f.x + f.w, f.y + f.h);
    renderStatus();
  }

  // Free transform (handles on the selection) ------------------------- //

  function startXform() {
    if (!ps.floating) liftSelection();
    const f = ps.floating;
    if (!f) return null;
    if (!ps.xform) ps.xform = { src: f.data.slice(), w: f.w, h: f.h, cx: f.x + f.w / 2, cy: f.y + f.h / 2, sx: 1, sy: 1, angle: 0, kx: 0, ky: 0, orig: { ...f, data: f.data.slice() } };
    return ps.xform;
  }

  /** recomputes the floating pixels from the transform (always from the original pixels) */
  function applyXform() {
    const t = ps.xform;
    const f = ps.floating;
    if (!t || !f) return;
    dirty(f.x, f.y, f.x + f.w, f.y + f.h);
    const r = K.transformBlock(t.src, t.w, t.h, { sx: t.sx, sy: t.sy, angle: t.angle, kx: t.kx, ky: t.ky, algo: ps.rotAlgo });
    f.data = r.data;
    f.w = r.w;
    f.h = r.h;
    f.x = Math.round(t.cx - r.w / 2);
    f.y = Math.round(t.cy - r.h / 2);
    dirty(f.x, f.y, f.x + f.w, f.y + f.h);
    renderXform();
    renderStatus();
  }

  function cancelXform() {
    const t = ps.xform;
    if (!t) return false;
    const f = ps.floating;
    if (f) dirty(f.x, f.y, f.x + f.w, f.y + f.h);
    ps.floating = { ...t.orig, data: t.orig.data.slice() };
    ps.xform = null;
    dirty(t.orig.x, t.orig.y, t.orig.x + t.orig.w, t.orig.y + t.orig.h);
    renderXform();
    return true;
  }

  /** corners / edge middles of the (scaled, sheared, rotated) transform box in doc coordinates, + the center */
  function xformFrame() {
    const t = ps.xform;
    const b = ps.floating || ps.sel;
    if (!b) return null;
    const cx = t ? t.cx : b.x + b.w / 2;
    const cy = t ? t.cy : b.y + b.h / 2;
    const W = t ? t.w * t.sx : b.w;
    const H = t ? t.h * t.sy : b.h;
    const kx = t?.kx || 0;
    const ky = t?.ky || 0;
    const a = ((t ? t.angle : 0) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const pt = (hx, hy) => {
      const lx = (hx * W) / 2;
      const ly = (hy * H) / 2;
      const ux = lx + kx * ly;
      const uy = ly + ky * lx;
      return { hx, hy, x: cx + ux * cos - uy * sin, y: cy + ux * sin + uy * cos };
    };
    /** doc point -> box coordinates (unrotated, unsheared; the box spans ±W/2, ±H/2) */
    const local = (x, y) => {
      const qx = (x - cx) * cos + (y - cy) * sin;
      const qy = -(x - cx) * sin + (y - cy) * cos;
      const det = 1 - kx * ky || 1e-9;
      return { x: (qx - kx * qy) / det, y: (qy - ky * qx) / det };
    };
    const handles = [];
    for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) if (hx || hy) handles.push(pt(hx, hy));
    return { cx, cy, W, H, a, cos, sin, kx, ky, pt, local, handles, corners: [pt(-1, -1), pt(1, -1), pt(1, 1), pt(-1, 1)] };
  }

  const HANDLE = 5; // px on screen
  const ROTATE_ZONE = 28; // px outside the box that rotate
  const SELECTING_DRAGS = new Set(['select', 'selellipse', 'lasso', 'move']);

  /** resize cursor for a direction on screen (angle in radians) */
  function resizeCursor(ang) {
    const d = ((((ang * 180) / Math.PI) % 180) + 180) % 180;
    return d < 22.5 || d >= 157.5 ? 'ew-resize' : d < 67.5 ? 'nwse-resize' : d < 112.5 ? 'ns-resize' : 'nesw-resize';
  }

  /**
   * What the pointer would do with a selection tool, like Aseprite: on a square = scale (Ctrl on
   * a side square = shear), inside or on the edge of the box = move, just outside = rotate.
   * -> {kind: 'scale' | 'shear' | 'rotate' | 'move', hx, hy, cursor} | null
   */
  function xformHit(clientX, clientY, ctrl = false) {
    if (!SELECT_TOOLS.has(ps.tool) || ps.poly || !(ps.floating || ps.sel)) return null;
    const fr = xformFrame();
    if (!fr) return null;
    const r = dom.canvas.getBoundingClientRect();
    const sx = clientX - r.left;
    const sy = clientY - r.top;
    const scr = (p) => ({ x: ps.panX + p.x * ps.zoom, y: ps.panY + p.y * ps.zoom });
    const c = scr({ x: fr.cx, y: fr.cy });
    for (const h of fr.handles) {
      const q = scr(h);
      if (Math.abs(q.x - sx) > HANDLE + 2 || Math.abs(q.y - sy) > HANDLE + 2) continue;
      if (ctrl && (!h.hx || !h.hy)) {
        // shear moves the side along itself
        const along = h.hy ? Math.atan2(fr.sin, fr.cos) : Math.atan2(fr.cos, -fr.sin);
        return { kind: 'shear', hx: h.hx, hy: h.hy, cursor: resizeCursor(along) };
      }
      return { kind: 'scale', hx: h.hx, hy: h.hy, cursor: resizeCursor(Math.atan2(q.y - c.y, q.x - c.x)) };
    }
    const p = toDoc(clientX, clientY);
    const l = fr.local(p.x, p.y);
    const out = Math.hypot(Math.max(0, Math.abs(l.x) - Math.abs(fr.W) / 2), Math.max(0, Math.abs(l.y) - Math.abs(fr.H) / 2)) * ps.zoom;
    if (out <= 3) return { kind: 'move', cursor: 'move' };
    if (out <= ROTATE_ZONE) return { kind: 'rotate', cursor: ROTATE_CURSOR };
    return null;
  }

  // circular arrow; the hot spot is its middle
  const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g fill='none' stroke-linecap='round' stroke-linejoin='round'><path d='M18.5 12a6.5 6.5 0 1 1-2-4.7' stroke='white' stroke-width='4'/><path d='M18.5 12a6.5 6.5 0 1 1-2-4.7' stroke='black' stroke-width='1.6'/><path d='M17.5 3.5v4.5H13' stroke='white' stroke-width='4'/><path d='M17.5 3.5v4.5H13' stroke='black' stroke-width='1.6'/></g></svg>")}") 12 12, crosshair`;

  let lastPointer = null; // for refreshing the cursor when Ctrl is pressed or released

  /** pointer cursor over the canvas: transform cursors around a selection, else the tool's (CSS) */
  function updateCursor(clientX, clientY, ctrl) {
    lastPointer = { clientX, clientY };
    const hit = !drag && !ps.spaceDown ? xformHit(clientX, clientY, ctrl) : null;
    const cursor = hit ? hit.cursor : '';
    if (dom.canvas.style.cursor !== cursor) dom.canvas.style.cursor = cursor;
  }

  function renderXform() {
    const on = SELECT_TOOLS.has(ps.tool) && Boolean(ps.xform && ps.floating);
    dom.xformWrap.hidden = !on;
    if (!on) return;
    const t = ps.xform;
    if (document.activeElement !== dom.xAngle) dom.xAngle.value = String(Math.round(t.angle * 10) / 10);
    if (document.activeElement !== dom.xScaleX) dom.xScaleX.value = String(Math.round(t.sx * 1000) / 10);
    if (document.activeElement !== dom.xScaleY) dom.xScaleY.value = String(Math.round(t.sy * 1000) / 10);
    dom.xAlgo.value = ps.rotAlgo;
  }

  // Custom brush (Deluxe Paint style: pick up a selection, paint with it) -- //

  function brushFromSelection() {
    const p = selectionPixels();
    if (!p.data.some((v) => v !== EMPTY)) { toast('The selection is empty', 'warn'); return; }
    // trim empty borders
    let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.data[y * p.w + x] !== EMPTY) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    ps.customBrush = { w, h, data: K.crop(p.data, p.w, x0, y0, w, h) };
    ps.brush = 0;
    deselect();
    setTool('pencil');
    renderOptions();
    toast(`Brush ${w}×${h} picked up. Paint with it (pencil); the eraser erases its shape. Brush sizes 1–4 switch back.`, 'info', 3000);
  }

  function flipBrush(kind) {
    const b = ps.customBrush;
    if (!b) { toast('Pick up a brush first (Ctrl+B with a selection)', 'info'); return; }
    b.data = kind === 'h' ? K.flipH(b.data, b.w, b.h) : K.flipV(b.data, b.w, b.h);
    requestDraw();
  }

  // Effects --------------------------------------------------------- //

  async function outlineDialog() {
    const diag = el('input', { type: 'checkbox' });
    const ok = await App.modal({
      title: 'Outline',
      body: el('div', { className: 'dialog-form' },
        el('p', { className: 'muted', textContent: `Draws color ${ps.primary} around every filled pixel of the ${ps.floating || ps.sel ? 'selection' : 'current layer'} (empty and transparent pixels count as empty).` }),
        el('label', { className: 'check' }, diag, el('span', { textContent: 'Diagonal neighbours too (8 instead of 4)' }))),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Outline', primary: true, value: true }],
    });
    if (ok) outlineFx(diag.checked);
  }

  function outlineFx(diagonal) {
    const d = ps.doc;
    const t = d.transparent;
    const empty = (v) => v === EMPTY || v === t;
    if (ps.sel || ps.floating) {
      if (ps.xform) commitXformInPlace();
      if (!ps.floating) liftSelection();
      const f = ps.floating;
      dirty(f.x, f.y, f.x + f.w, f.y + f.h);
      const r = K.outline(f.data, f.w, f.h, ps.primary, diagonal, empty);
      ps.floating = { ...f, x: f.x - 1, y: f.y - 1, w: r.w, h: r.h, data: r.data };
      dirty(f.x - 1, f.y - 1, f.x + f.w + 1, f.y + f.h + 1);
      setTool('select');
      return;
    }
    const c = cel();
    const r = K.outline(c, d.w, d.h, ps.primary, diagonal, empty);
    const e = beginEdit();
    for (let y = 0; y < d.h; y++) for (let x = 0; x < d.w; x++) { const v = r.data[(y + 1) * r.w + x + 1]; if (v !== c[y * d.w + x]) setPx(e, x, y, v); }
    endEdit(e);
  }

  /** bakes the current transform into the floating pixels (keeps them floating) */
  function commitXformInPlace() {
    ps.xform = null;
    renderXform();
  }

  /** Pixels for copy / export of the current selection (or the whole layer). */
  function selectionPixels({ merged = false } = {}) {
    if (ps.floating) return { w: ps.floating.w, h: ps.floating.h, data: ps.floating.data.slice() };
    const d = ps.doc;
    const src = merged ? K.flatten(d, ps.frame) : cel();
    const s = ps.sel || { x: 0, y: 0, w: d.w, h: d.h };
    const data = K.crop(src, d.w, s.x, s.y, s.w, s.h);
    if (s.mask) for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (!s.mask[(s.y + y) * d.w + s.x + x]) data[y * s.w + x] = EMPTY;
    return { w: s.w, h: s.h, data };
  }

  const toSlots = (data) => {
    const t = ps.doc.transparent >= 0 ? ps.doc.transparent : 0;
    return Uint8Array.from(data, (v) => (v === EMPTY ? t : v));
  };

  async function copySelection({ cut = false, merged = false } = {}) {
    const p = selectionPixels({ merged });
    ps.clip = p;
    if (p.w <= 255 && p.h <= 255) {
      try {
        await navigator.clipboard.writeText(K.toGfxClip(toSlots(p.data), p.w, p.h));
      } catch { /* internal clipboard still works */ }
    }
    if (cut) deleteSelection();
    toast(`Copied ${p.w}×${p.h}${p.w <= 128 && p.h <= 128 ? ' (paste into the PICO-8 sprite editor with Ctrl+V)' : ''}`, 'info', 2200);
  }

  function pasteFloating(p) {
    commitFloating();
    const d = ps.doc;
    if (ps.doc.layers[ps.layer] && !ps.doc.layers[ps.layer].visible) ps.doc.layers[ps.layer].visible = true;
    let x = 0;
    let y = 0;
    if (ps.sel) { x = ps.sel.x; y = ps.sel.y; } else {
      // top-left of the visible area
      x = Math.max(0, Math.min(d.w - 1, Math.floor(-ps.panX / ps.zoom)));
      y = Math.max(0, Math.min(d.h - 1, Math.floor(-ps.panY / ps.zoom)));
    }
    ps.sel = null;
    ps.floating = { x, y, w: p.w, h: p.h, data: p.data.slice(), lifted: false };
    setTool('select');
    dirty(x, y, x + p.w, y + p.h);
    renderLayers();
    renderStatus();
  }

  async function pasteFromEvent(e) {
    const text = e.clipboardData?.getData('text') || '';
    const gfx = K.parseGfxClip(text);
    if (gfx) {
      pasteFloating({ w: gfx.w, h: gfx.h, data: gfx.pixels });
      toast(`Pasted PICO-8 graphics ${gfx.w}×${gfx.h}`, 'info', 1800);
      return;
    }
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      try {
        const img = await decodeImage(file);
        pasteFloating({ w: img.width, h: img.height, data: quantizeImage(img) });
        toast(`Pasted image ${img.width}×${img.height} (nearest palette colors)`, 'info', 1800);
      } catch {
        toast('Could not read the pasted image', 'error');
      }
      return;
    }
    if (ps.clip) pasteFloating(ps.clip);
  }

  async function pasteFromMenu() {
    try {
      const text = await navigator.clipboard.readText();
      const gfx = K.parseGfxClip(text);
      if (gfx) { pasteFloating({ w: gfx.w, h: gfx.h, data: gfx.pixels }); return; }
    } catch { /* permission denied: fall back to the internal clipboard */ }
    if (ps.clip) pasteFloating(ps.clip);
    else toast('Nothing to paste. Copy in PICO-8 (Ctrl+C in the sprite editor) and press Ctrl+V here.', 'warn');
  }

  /** RGBA -> slot indices (nearest color of the current palette, transparent -> EMPTY). */
  function quantizeImage(img) {
    const out = quantize(img, palRgb());
    for (let i = 0; i < out.length; i++) if (img.data[i * 4 + 3] < 128) out[i] = EMPTY;
    return out;
  }

  // Transform selection / layer -------------------------------------- //

  function transform(kind) {
    if (ps.xform) commitXformInPlace();
    if (ps.sel && !ps.floating) liftSelection();
    const f = ps.floating;
    if (f) {
      dirty(f.x, f.y, f.x + f.w, f.y + f.h);
      if (kind === 'flipH') f.data = K.flipH(f.data, f.w, f.h);
      else if (kind === 'flipV') f.data = K.flipV(f.data, f.w, f.h);
      else {
        const r = K.rotateCW(f.data, f.w, f.h);
        const cx = f.x + f.w / 2;
        const cy = f.y + f.h / 2;
        f.data = r.data; f.w = r.w; f.h = r.h;
        f.x = Math.round(cx - f.w / 2);
        f.y = Math.round(cy - f.h / 2);
      }
      dirty(f.x, f.y, f.x + f.w, f.y + f.h);
      return;
    }
    const d = ps.doc;
    if (kind === 'rotate' && d.w !== d.h) { rotateCanvas(); return; }
    const c = cel();
    const out = kind === 'flipH' ? K.flipH(c, d.w, d.h) : kind === 'flipV' ? K.flipV(c, d.w, d.h) : K.rotateCW(c, d.w, d.h).data;
    const e = beginEdit();
    for (let i = 0; i < out.length; i++) if (c[i] !== out[i]) setPx(e, i % d.w, Math.floor(i / d.w), out[i]);
    endEdit(e);
  }

  function flipCanvas(kind) {
    docOp((d) => {
      for (const f of d.frames) f.cels = f.cels.map((c) => (kind === 'flipH' ? K.flipH(c, d.w, d.h) : K.flipV(c, d.w, d.h)));
    });
  }

  function rotateCanvas() {
    docOp((d) => {
      const out = { ...d, w: d.h, h: d.w };
      out.frames = d.frames.map((f) => ({ ...f, cels: f.cels.map((c) => K.rotateCW(c, d.w, d.h).data) }));
      return out;
    });
  }

  // ------------------------------------------------------------------ //
  // Pointer input                                                      //
  // ------------------------------------------------------------------ //

  let drag = null;
  const pointers = new Map();
  let pinch = null;

  function cancelStroke() {
    if (!drag) return;
    if (drag.edit) {
      // revert the partial stroke
      const e = drag.edit;
      cel(e.frame, e.layer).set(e.before);
      dirtyAll();
    }
    clearOverlay();
    drag = null;
  }

  function onPointerDown(e) {
    dom.canvas.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { dom.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }

    if (pointers.size === 2) {
      cancelStroke();
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
        zoom: ps.zoom, panX: ps.panX, panY: ps.panY,
      };
      return;
    }
    if (pointers.size > 2) return;

    const p = toPixel(e.clientX, e.clientY);
    const which = e.button === 2 ? 'secondary' : 'primary';
    const color = which === 'secondary' ? ps.secondary : ps.primary;
    const alt = which === 'secondary' ? ps.primary : ps.secondary;

    if (e.button === 1 || ps.spaceDown || ps.tool === 'hand') {
      drag = { pan: true, x0: e.clientX, y0: e.clientY, px: ps.panX, py: ps.panY };
      dom.stage.classList.add('panning');
      return;
    }
    if (e.button !== 0 && e.button !== 2) return;

    const tool = e.altKey && DRAW_TOOLS.has(ps.tool) ? 'picker' : ps.tool;

    if (tool === 'picker') {
      pickColor(p.x, p.y, which);
      drag = { tool, which };
      return;
    }
    // around a selection every selection tool transforms it (Shift / Alt keep making selections)
    if (SELECT_TOOLS.has(tool) && !ps.poly) {
      const hit = xformHit(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
      const mods = e.shiftKey || e.altKey;
      if (hit && (hit.kind === 'scale' || hit.kind === 'shear' || (hit.kind === 'rotate' && !mods))) {
        dom.canvas.style.cursor = hit.cursor;
        startXformDrag(hit, e);
        return;
      }
      if (hit?.kind === 'move' && !mods) { startMoveDrag(p); return; }
    }
    if (tool === 'select' || tool === 'selellipse') {
      startSelectDrag(p, selModeOf(e), tool);
      return;
    }
    if (tool === 'polygon') {
      polygonClick(p, e);
      return;
    }
    if (tool === 'wand') {
      commitFloating();
      if (!inDoc(p.x, p.y)) return;
      const d = ps.doc;
      const m = K.wandMask(cel(), d.w, d.h, p.x, p.y, ps.contiguous);
      ps.sel = selFromMask(K.combineMask(selModeOf(e), selMask(), m));
      requestDraw();
      renderStatus();
      return;
    }
    if (tool === 'lasso') {
      const mode = selModeOf(e);
      if (mode === 'replace' && ps.sel && selHas(ps.sel, p.x, p.y) || (ps.floating && inBox(ps.floating, p.x, p.y))) { startSelectDrag(p, 'replace'); return; }
      commitFloating();
      drag = { tool: 'lasso', pts: [[p.x, p.y]], mode, base: selMask() };
      requestDraw();
      return;
    }
    if (!ps.doc.layers[ps.layer].visible) {
      toast('The current layer is hidden. Show it to draw on it.', 'warn');
      return;
    }
    commitFloating();
    if (tool === 'fill') {
      floodFill(p.x, p.y, color, alt, which);
      return;
    }
    if (tool === 'pencil' || tool === 'eraser') {
      const ed = beginEdit();
      const c = tool === 'eraser' ? EMPTY : color;
      stamp(ed, p.x, p.y, c, alt, which);
      drag = { tool, edit: ed, last: p, color: c, alt, which, pts: [] };
      pixelPerfect(drag, p);
      return;
    }
    // line / rect / ellipse
    drag = { tool, start: p, color, alt, shift: e.shiftKey, which, ink: { frame: ps.frame, layer: ps.layer } };
    setOverlay(shapePoints(tool, p, p, color, alt, e.shiftKey, which, drag.ink));
  }

  function startMoveDrag(p) {
    if (!ps.floating) liftSelection();
    const f = ps.floating;
    if (!f) return;
    dom.canvas.style.cursor = 'move';
    drag = { tool: 'move', start: p, fx: f.x, fy: f.y, cx: ps.xform?.cx, cy: ps.xform?.cy };
  }

  function startSelectDrag(p, mode = 'replace', shape = 'select') {
    const inside = ps.floating ? inBox(ps.floating, p.x, p.y) : ps.sel && selHas(ps.sel, p.x, p.y);
    if (inside && mode === 'replace') { startMoveDrag(p); return; }
    commitFloating();
    drag = { tool: shape, start: p, mode, base: mode === 'replace' ? null : selMask() };
    if (shape === 'selellipse') setEllipseSel(p, p); else setRectSel(p, p);
    requestDraw();
  }

  function setEllipseSel(a, b) {
    const d = ps.doc;
    const m = new Uint8Array(d.w * d.h);
    K.ellipse(a.x, a.y, b.x, b.y, true, (x, y) => { if (inDoc(x, y)) m[y * d.w + x] = 1; });
    ps.sel = selFromMask(K.combineMask(drag?.mode || 'replace', drag?.base, m));
  }

  // Polygon lasso: click the corners; double-click, Enter or a click on the first corner closes it
  function polygonClick(p, e) {
    const poly = ps.poly;
    if (!poly) {
      const mode = selModeOf(e);
      if (mode === 'replace' && ((ps.sel && selHas(ps.sel, p.x, p.y)) || (ps.floating && inBox(ps.floating, p.x, p.y)))) { startSelectDrag(p, 'replace'); return; }
      commitFloating();
      ps.poly = { pts: [[p.x, p.y]], mode, base: selMask() };
      requestDraw();
      return;
    }
    const [fx, fy] = poly.pts[0];
    if (poly.pts.length > 2 && Math.abs(p.x - fx) <= 1 && Math.abs(p.y - fy) <= 1) { closePolygon(); return; }
    const last = poly.pts[poly.pts.length - 1];
    if (last[0] !== p.x || last[1] !== p.y) poly.pts.push([p.x, p.y]);
    if (e.detail >= 2) { closePolygon(); return; }
    requestDraw();
  }

  function closePolygon() {
    const poly = ps.poly;
    if (!poly) return;
    ps.poly = null;
    const d = ps.doc;
    ps.sel = poly.pts.length > 2 ? selFromMask(K.combineMask(poly.mode, poly.base, K.polygonMask(poly.pts, d.w, d.h))) : poly.mode === 'replace' ? null : ps.sel;
    renderStatus();
    requestDraw();
  }

  function cancelPolygon() {
    if (!ps.poly) return false;
    ps.poly = null;
    requestDraw();
    return true;
  }

  function setRectSel(a, b) {
    const r = clampSel({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x) + 1, h: Math.abs(b.y - a.y) + 1 });
    ps.sel = drag?.mode && drag.mode !== 'replace' && r ? selFromMask(K.combineMask(drag.mode, drag.base, selMask(r))) : r;
  }

  function startXformDrag(hit, e) {
    const t = startXform();
    if (!t) return;
    const fr = xformFrame();
    const p = toDoc(e.clientX, e.clientY);
    if (hit.kind === 'rotate') {
      drag = { tool: 'rotate', a0: t.angle, start: Math.atan2(p.y - t.cy, p.x - t.cx) };
      return;
    }
    if (hit.kind === 'shear') {
      drag = { tool: 'shear', hx: hit.hx, hy: hit.hy, p0: p, kx0: t.kx, ky0: t.ky, cx0: t.cx, cy0: t.cy, W: fr.W, H: fr.H };
      return;
    }
    // the opposite handle stays where it is
    drag = { tool: 'scale', hx: hit.hx, hy: hit.hy, W0: fr.W, H0: fr.H, anchor: fr.pt(-hit.hx, -hit.hy) };
  }

  /** client -> doc coordinates (fractional) */
  function toDoc(clientX, clientY) {
    const r = dom.canvas.getBoundingClientRect();
    return { x: (clientX - r.left - ps.panX) / ps.zoom, y: (clientY - r.top - ps.panY) / ps.zoom };
  }

  function xformMove(e) {
    const t = ps.xform;
    if (!t) return;
    const p = toDoc(e.clientX, e.clientY);
    const a = (t.angle * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    if (drag.tool === 'rotate') {
      let deg = drag.a0 + ((Math.atan2(p.y - t.cy, p.x - t.cx) - drag.start) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      t.angle = ((deg % 360) + 540) % 360 - 180;
    } else if (drag.tool === 'shear') {
      // the dragged side slides along itself, the opposite side stays
      const dx = p.x - drag.p0.x;
      const dy = p.y - drag.p0.y;
      const qx = dx * cos + dy * sin;
      const qy = -dx * sin + dy * cos;
      if (drag.hy) {
        t.kx = drag.kx0 + (drag.hy * qx) / drag.H;
        t.cx = drag.cx0 + (qx / 2) * cos;
        t.cy = drag.cy0 + (qx / 2) * sin;
      } else {
        t.ky = drag.ky0 + (drag.hx * qy) / drag.W;
        t.cx = drag.cx0 - (qy / 2) * sin;
        t.cy = drag.cy0 + (qy / 2) * cos;
      }
      if (e.shiftKey) { t.kx = Math.round(t.kx * 4) / 4; t.ky = Math.round(t.ky * 4) / 4; }
    } else {
      const kx = t.kx || 0;
      const ky = t.ky || 0;
      const det = 1 - kx * ky || 1e-9;
      const dx = p.x - drag.anchor.x;
      const dy = p.y - drag.anchor.y;
      const rx = dx * cos + dy * sin;
      const ry = -dx * sin + dy * cos;
      const qx = (rx - kx * ry) / det;
      const qy = (ry - ky * rx) / det;
      let W = drag.hx ? qx / drag.hx : drag.W0;
      let H = drag.hy ? qy / drag.hy : drag.H0;
      if (e.shiftKey && drag.hx && drag.hy) {
        // keep the aspect ratio
        const k = Math.max(Math.abs(W / drag.W0), Math.abs(H / drag.H0));
        W = Math.sign(W || 1) * Math.abs(drag.W0) * k;
        H = Math.sign(H || 1) * Math.abs(drag.H0) * k;
      }
      // whole pixels, never zero
      W = Math.sign(W || 1) * Math.max(1, Math.round(Math.abs(W)));
      H = Math.sign(H || 1) * Math.max(1, Math.round(Math.abs(H)));
      t.sx = W / t.w;
      t.sy = H / t.h;
      // center = anchor + R * shear * (half the new size along the dragged axes)
      const lx = drag.hx ? (drag.hx * W) / 2 : 0;
      const ly = drag.hy ? (drag.hy * H) / 2 : 0;
      const ux = lx + kx * ly;
      const uy = ly + ky * lx;
      t.cx = drag.anchor.x + ux * cos - uy * sin;
      t.cy = drag.anchor.y + ux * sin + uy * cos;
    }
    applyXform();
  }

  function onPointerMove(e) {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const r = dom.canvas.getBoundingClientRect();
      const z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], pinch.zoom * (dist / pinch.dist)));
      const ix = (pinch.mx - r.left - pinch.panX) / pinch.zoom;
      const iy = (pinch.my - r.top - pinch.panY) / pinch.zoom;
      ps.zoom = z;
      ps.panX = Math.round(mx - r.left - ix * z);
      ps.panY = Math.round(my - r.top - iy * z);
      dom.zoomLabel.textContent = `${Math.round(z * 100)}%`;
      requestDraw();
      return;
    }

    const p = toPixel(e.clientX, e.clientY);
    const hoverChanged = !ps.hover || ps.hover.x !== p.x || ps.hover.y !== p.y;
    ps.hover = p;
    if (hoverChanged) { renderStatus(); if (!drag || ps.poly) requestDraw(); }
    if (!drag) updateCursor(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    if (!drag) return;

    if (drag.pan) {
      ps.panX = drag.px + (e.clientX - drag.x0);
      ps.panY = drag.py + (e.clientY - drag.y0);
      requestDraw();
      return;
    }
    if (drag.tool === 'scale' || drag.tool === 'rotate' || drag.tool === 'shear') { xformMove(e); return; }
    if (!hoverChanged) return;
    switch (drag.tool) {
      case 'picker':
        pickColor(p.x, p.y, drag.which);
        break;
      case 'pencil':
      case 'eraser': {
        const d = drag;
        K.line(d.last.x, d.last.y, p.x, p.y, (x, y) => { stamp(d.edit, x, y, d.color, d.alt, d.which); pixelPerfect(d, { x, y }); });
        d.last = p;
        break;
      }
      case 'lasso': {
        const last = drag.pts[drag.pts.length - 1];
        if (last[0] !== p.x || last[1] !== p.y) drag.pts.push([p.x, p.y]);
        requestDraw();
        break;
      }
      case 'line':
      case 'rect':
      case 'ellipse':
        setOverlay(shapePoints(drag.tool, drag.start, p, drag.color, drag.alt, e.shiftKey, drag.which, drag.ink));
        break;
      case 'select':
      case 'selellipse': {
        if (drag.tool === 'select') setRectSel(drag.start, p); else setEllipseSel(drag.start, p);
        requestDraw();
        renderStatus();
        break;
      }
      case 'move': {
        const f = ps.floating;
        if (!f) break;
        dirty(f.x, f.y, f.x + f.w, f.y + f.h);
        f.x = drag.fx + (p.x - drag.start.x);
        f.y = drag.fy + (p.y - drag.start.y);
        if (ps.xform) { ps.xform.cx = drag.cx + (p.x - drag.start.x); ps.xform.cy = drag.cy + (p.y - drag.start.y); }
        dirty(f.x, f.y, f.x + f.w, f.y + f.h);
        renderStatus();
        break;
      }
      default:
    }
  }

  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      drag = null;
      return;
    }
    const d = drag;
    drag = null;
    dom.stage.classList.remove('panning');
    if (!d) return;
    updateCursor(e.clientX, e.clientY, e.ctrlKey || e.metaKey);
    if (d.edit) endEdit(d.edit);
    else if (d.tool === 'line' || d.tool === 'rect' || d.tool === 'ellipse') commitOverlay();
    else if (d.tool === 'lasso') {
      const dm = ps.doc;
      ps.sel = d.pts.length > 2 ? selFromMask(K.combineMask(d.mode, d.base, K.polygonMask(d.pts, dm.w, dm.h))) : d.mode === 'replace' ? null : ps.sel;
      renderStatus();
    }
    requestDraw();
  }

  function onWheel(e) {
    e.preventDefault();
    const r = dom.canvas.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
      if (!e.ctrlKey && !e.metaKey && e.shiftKey) {
        ps.panX -= e.deltaY;
        requestDraw();
        return;
      }
      stepZoom(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
    } else {
      ps.panX -= e.deltaX;
      requestDraw();
    }
  }

  // ------------------------------------------------------------------ //
  // Tools + options UI                                                 //
  // ------------------------------------------------------------------ //

  function setTool(t) {
    if (!SELECT_TOOLS.has(t)) commitFloating();
    if (t !== 'polygon') cancelPolygon();
    if (t !== 'picker') ps.altTool = null;
    ps.tool = t;
    showInGroup(t);
    dom.canvas.style.cursor = '';
    for (const b of dom.tools.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === t));
    dom.brushWrap.hidden = !(t === 'pencil' || t === 'eraser');
    // ink: every tool that puts colors down; pixel perfect only makes sense for freehand strokes
    dom.inkWrap.hidden = !['pencil', 'line', 'rect', 'ellipse', 'fill'].includes(t);
    dom.ppWrap.hidden = t !== 'pencil';
    dom.filledWrap.hidden = !(t === 'rect' || t === 'ellipse');
    dom.contigWrap.hidden = !(t === 'fill' || t === 'wand');
    renderXform();
    dom.stage.dataset.tool = t;
    requestDraw();
  }

  /**
   * Grouped tools: the toolbar shows one button per group (the group's last used tool, with a
   * small triangle). Hovering it for a moment, a right-click or a long press shows the others
   * in a flyout to the right.
   */
  const groupOf = (t) => TOOL_GROUPS.find((g) => g.tools.includes(t));
  const groupEls = new Map(); // group id -> {wrap, face, fly}

  function buildToolGroups() {
    for (const g of TOOL_GROUPS) {
      const buttons = g.tools.map((t) => dom.tools.querySelector(`.ps-tool[data-tool="${t}"]`));
      const wrap = el('div', { className: 'ps-tool-group', dataset: { group: g.id } });
      buttons[0].before(wrap);
      const face = buttons[0].cloneNode(true);
      face.classList.add('ps-tool-face');
      face.setAttribute('aria-haspopup', 'true');
      face.setAttribute('aria-expanded', 'false');
      const fly = el('div', { className: 'ps-flyout', attrs: { role: 'group', 'aria-label': g.label } }, ...buttons);
      wrap.append(face, fly);
      groupEls.set(g.id, { wrap, face, fly });

      let timer = 0;
      const open = () => {
        clearTimeout(timer);
        for (const other of groupEls.values()) if (other.wrap !== wrap) closeFlyout(other);
        const r = face.getBoundingClientRect();
        fly.style.left = `${r.right + 4}px`;
        fly.style.top = `${r.top - 5}px`;
        wrap.classList.add('open');
        face.setAttribute('aria-expanded', 'true');
      };
      wrap.addEventListener('pointerenter', (e) => {
        clearTimeout(timer);
        if (e.pointerType === 'mouse' && !wrap.classList.contains('open')) timer = setTimeout(open, FLYOUT_DELAY);
      });
      wrap.addEventListener('pointerleave', () => {
        clearTimeout(timer);
        timer = setTimeout(() => closeFlyout(groupEls.get(g.id)), 250);
      });
      // touch: long press opens it; mouse: right-click opens it at once
      face.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse') { clearTimeout(timer); timer = setTimeout(open, FLYOUT_DELAY); }
      });
      face.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse' && !wrap.classList.contains('open')) clearTimeout(timer); });
      face.addEventListener('contextmenu', (e) => { e.preventDefault(); open(); });
      face.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight') return;
        e.preventDefault();
        open();
        fly.querySelector('.ps-tool')?.focus();
      });
      fly.addEventListener('click', () => closeFlyout(groupEls.get(g.id)));
      fly.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'ArrowLeft') { e.stopPropagation(); closeFlyout(groupEls.get(g.id)); face.focus(); }
      });
    }
  }

  function closeFlyout(g) {
    if (!g?.wrap.classList.contains('open')) return;
    g.wrap.classList.remove('open');
    g.face.setAttribute('aria-expanded', 'false');
  }

  /** The group's button shows the chosen tool (icon, tooltip, shortcut). */
  function showInGroup(t) {
    const g = groupOf(t);
    const ge = g && groupEls.get(g.id);
    if (!ge) return;
    const src = ge.fly.querySelector(`.ps-tool[data-tool="${t}"]`);
    ge.face.dataset.tool = t;
    ge.face.innerHTML = src.innerHTML;
    ge.face.title = `${src.title} · hover for more`;
    ge.face.setAttribute('aria-label', src.getAttribute('aria-label'));
  }

  function renderOptions() {
    for (const b of dom.brush.querySelectorAll('button')) b.setAttribute('aria-checked', String(Number(b.dataset.value) === ps.brush));
    dom.brushCustom.hidden = !ps.customBrush;
    if (ps.customBrush) dom.brushCustom.title = `Custom brush ${ps.customBrush.w}×${ps.customBrush.h} (Ctrl+B picks one up)`;
    if (ps.brush === 0 && !ps.customBrush) ps.brush = 1;
    dom.ink.value = ps.ink;
    dom.pp.checked = ps.pixelPerfect;
    dom.filled.checked = ps.filled;
    dom.contig.checked = ps.contiguous;
    const preset = K.PATTERNS.find((p) => p.value === ps.pattern);
    dom.pattern.value = preset ? String(preset.value) : 'custom';
    dom.patternAlt.value = ps.patternAlt;
    dom.patternAlt.disabled = !ps.pattern;
    dom.patternCode.textContent = ps.pattern ? `fillp(${K.patternHex(ps.pattern)}${ps.patternAlt === 'transparent' ? '|0b.1' : ''})` : '';
    dom.sieve.setAttribute('aria-pressed', String(ps.sieve));
    dom.sieveSel.replaceChildren(...ps.sieves.map((p, i) => el('option', { value: String(i), textContent: p.name })));
    dom.sieveSel.value = String(Math.min(ps.sieveIndex, ps.sieves.length - 1));
    dom.mirrorX.setAttribute('aria-pressed', String(ps.mirrorX));
    dom.mirrorY.setAttribute('aria-pressed', String(ps.mirrorY));
    dom.gridPx.setAttribute('aria-pressed', String(ps.gridPx));
    dom.grid8.setAttribute('aria-pressed', String(ps.grid8));
    dom.grid8.textContent = `${ps.gridSize}×${ps.gridSize}`;
    dom.tiled.setAttribute('aria-pressed', String(ps.tiled));
    dom.onion.setAttribute('aria-pressed', String(ps.onion));
    for (const b of dom.previewScale.querySelectorAll('button')) b.setAttribute('aria-checked', String(Number(b.dataset.value) === ps.previewScale));
  }

  async function editPattern() {
    let value = ps.pattern;
    const grid = el('div', { className: 'pattern-grid' });
    const code = el('code', {});
    const cells = [];
    const render = () => {
      cells.forEach((c, i) => c.setAttribute('aria-pressed', String(!!((value >> (15 - i)) & 1))));
      code.textContent = `fillp(${K.patternHex(value)})`;
    };
    for (let i = 0; i < 16; i++) {
      const c = el('button', { type: 'button', className: 'pattern-cell', attrs: { 'aria-label': `Bit ${15 - i}` } });
      c.addEventListener('click', () => { value ^= 1 << (15 - i); render(); });
      cells.push(c);
      grid.append(c);
    }
    render();
    const res = await modal({
      title: 'Fill Pattern',
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: 'Toggle the 4×4 cells. Marked cells use the secondary color (or stay transparent), like fillp() in PICO-8.' }),
        grid, el('p', {}, code)),
      actions: [{ label: 'Invert', onClick: () => { value = (~value) & 0xffff; render(); } }, { label: 'Clear', onClick: () => { value = 0; render(); } }],
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => value }],
    });
    if (res == null) return;
    ps.pattern = res;
    persistSettings();
    renderOptions();
  }

  /** Sieve manager: pick, add, edit and remove patterns (like APaint's sieve panel). */
  async function editSieves() {
    const list = ps.sieves.map((p) => ({ ...p }));
    let idx = Math.min(ps.sieveIndex, list.length - 1);
    let cur = null;   // pattern being edited: {w, h, cells: Uint8Array}
    let painting = null;
    const name = el('input', { type: 'text', className: 'input', attrs: { 'aria-label': 'Pattern name', spellcheck: 'false' } });
    const size = el('select', { className: 'select select-sm', attrs: { 'aria-label': 'Pattern size' } },
      ...[2, 3, 4, 5, 6, 8, 16].map((n) => el('option', { value: String(n), textContent: `${n}×${n}` })));
    const pick = el('select', { className: 'select', attrs: { 'aria-label': 'Sieve patterns', size: '7' } });
    const grid = el('div', { className: 'sieve-grid' });
    const pct = el('p', { className: 'muted' });

    const commit = () => {
      list[idx] = { name: name.value.trim() || 'Custom', w: cur.w, h: cur.h, bits: Array.from(cur.cells).join('') };
    };
    const renderList = () => {
      pick.replaceChildren(...list.map((p, i) => el('option', { value: String(i), textContent: p.name })));
      pick.value = String(idx);
    };
    const renderGrid = () => {
      const cell = cur.w > 8 ? 14 : 26;
      grid.style.gridTemplateColumns = `repeat(${cur.w}, ${cell}px)`;
      grid.replaceChildren(...Array.from(cur.cells, (v, i) => el('button', {
        type: 'button', className: 'sieve-cell', dataset: { i: String(i) }, style: `width:${cell}px;height:${cell}px`,
        attrs: { 'aria-pressed': String(!!v), 'aria-label': `Cell ${i % cur.w}, ${Math.floor(i / cur.w)}` },
      })));
      const on = cur.cells.reduce((sum, v) => sum + v, 0);
      pct.textContent = `${Math.round((on / cur.cells.length) * 100)}% of the pixels can be painted.`;
    };
    const load = () => {
      const p = list[idx];
      cur = { w: p.w, h: p.h, cells: Uint8Array.from(p.bits, (b) => (b === '1' ? 1 : 0)) };
      name.value = p.name;
      size.value = String(p.w);
      renderGrid();
    };
    const setCell = (b, v) => {
      cur.cells[Number(b.dataset.i)] = v;
      b.setAttribute('aria-pressed', String(!!v));
    };
    const endPaint = () => {
      if (painting == null) return;
      painting = null;
      commit();
      renderGrid();
    };
    grid.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.sieve-cell');
      if (!b) return;
      e.preventDefault();
      grid.releasePointerCapture?.(e.pointerId);
      painting = cur.cells[Number(b.dataset.i)] ? 0 : 1;
      setCell(b, painting);
    });
    grid.addEventListener('pointerover', (e) => {
      const b = e.target.closest('.sieve-cell');
      if (b && painting != null) setCell(b, painting);
    });
    grid.addEventListener('pointerup', endPaint);
    grid.addEventListener('pointerleave', endPaint);
    grid.addEventListener('keydown', (e) => {
      const b = e.target.closest('.sieve-cell');
      if (!b || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      setCell(b, cur.cells[Number(b.dataset.i)] ? 0 : 1);
      commit();
      renderGrid();
      grid.querySelector(`[data-i="${b.dataset.i}"]`)?.focus();
    });
    name.addEventListener('input', () => { commit(); renderList(); });
    size.addEventListener('change', () => {
      const n = Number(size.value);
      const cells = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) cells[y * n + x] = cur.cells[(y % cur.h) * cur.w + (x % cur.w)];
      cur = { w: n, h: n, cells };
      commit();
      renderGrid();
    });
    pick.addEventListener('change', () => { idx = Number(pick.value); load(); });
    const btn = (label, title, fn) => el('button', { type: 'button', className: 'btn btn-sm', textContent: label, title, onclick: fn });

    renderList();
    load();
    const res = await modal({
      title: 'Sieve',
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: 'With the sieve on, the drawing tools (pencil, eraser, shapes, fill) only change the marked pixels and leave the others as they are. The pattern repeats over the whole canvas from 0,0. Drag across the cells to set or clear them.' }),
        el('div', { className: 'sieve-cols' },
          el('div', { className: 'sieve-list' }, pick,
            el('div', { className: 'ps-panel-actions' },
              btn('Add', 'New empty 4×4 pattern', () => { list.push(sievePattern(`Custom ${list.length + 1}`, 4, () => false)); idx = list.length - 1; renderList(); load(); }),
              btn('Duplicate', 'Copy the selected pattern', () => { list.push({ ...list[idx], name: `${list[idx].name} copy` }); idx = list.length - 1; renderList(); load(); }),
              btn('Remove', 'Delete the selected pattern', () => { if (list.length < 2) return; list.splice(idx, 1); idx = Math.min(idx, list.length - 1); renderList(); load(); }),
              btn('Presets', 'Add any missing built-in patterns', () => { for (const p of SIEVE_PRESETS) if (!list.some((q) => q.name === p.name)) list.push({ ...p }); renderList(); }))),
          el('div', { className: 'sieve-edit' },
            el('div', { className: 'ps-panel-actions' }, name, size),
            grid, pct))),
      actions: [
        { label: 'Invert', onClick: () => { cur.cells = cur.cells.map((v) => 1 - v); commit(); renderGrid(); } },
        { label: 'Clear', onClick: () => { cur.cells.fill(0); commit(); renderGrid(); } },
      ],
      buttons: [{ label: 'Cancel', value: null }, { label: 'Use sieve', primary: true, value: () => true }],
    });
    if (!res) return;
    ps.sieves = list;
    ps.sieveIndex = idx;
    ps.sieve = true;
    persistSettings();
    renderOptions();
    requestDraw();
  }

  // ------------------------------------------------------------------ //
  // Palette panel                                                      //
  // ------------------------------------------------------------------ //

  function swatchStyle(node, slot) {
    const rgb = rgbOf(ps.doc.pal[slot]);
    node.style.background = `rgb(${rgb})`;
    node.classList.toggle('light', rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150);
  }

  function renderPalette() {
    const d = ps.doc;
    dom.palette.replaceChildren();
    for (let i = 0; i < 16; i++) {
      const b = el('button', {
        type: 'button', className: 'ps-sw', dataset: { slot: i },
        title: `Slot ${i} → color ${d.pal[i]}${i === d.transparent ? ' (transparent)' : ''}\nLeft click: primary · Right click: secondary · Double click: change color`,
      }, el('span', { className: 'ps-sw-n', textContent: i }));
      swatchStyle(b, i);
      if (i === ps.primary) b.classList.add('primary');
      if (i === ps.secondary) b.classList.add('secondary');
      if (i === d.transparent) b.classList.add('transparent');
      if (d.pal[i] !== i) b.classList.add('remapped');
      dom.palette.append(b);
    }
    dom.transp.replaceChildren(el('option', { value: '-1', textContent: 'none' }),
      ...Array.from({ length: 16 }, (_, i) => el('option', { value: String(i), textContent: `slot ${i}` })));
    dom.transp.value = String(d.transparent);
    renderColors();
  }

  function renderColors() {
    swatchStyle(dom.primary, ps.primary);
    swatchStyle(dom.secondary, ps.secondary);
    dom.primary.textContent = ps.primary;
    dom.secondary.textContent = ps.secondary;
    for (const b of dom.palette.querySelectorAll('.ps-sw')) {
      const s = Number(b.dataset.slot);
      b.classList.toggle('primary', s === ps.primary);
      b.classList.toggle('secondary', s === ps.secondary);
    }
  }

  function setPalette(pal, transparent = ps.doc.transparent) {
    const next = S.normPal(pal);
    if (next.every((p, i) => p === ps.doc.pal[i]) && transparent === ps.doc.transparent) return;
    docOp((d) => { d.pal = next; d.transparent = transparent; });
  }

  async function remapSlot(slot) {
    let chosen = ps.doc.pal[slot];
    const mk = (p) => {
      const b = el('button', { type: 'button', className: 'ps-sw ps-sw-pick', dataset: { pico: p }, title: `Color ${p}`, textContent: p });
      const rgb = rgbOf(p);
      b.style.background = `rgb(${rgb})`;
      b.classList.toggle('light', rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150);
      return b;
    };
    const base = el('div', { className: 'ps-pick-grid' }, ...BASE_INDICES.map(mk));
    const hidden = el('div', { className: 'ps-pick-grid' }, ...HIDDEN_INDICES.map(mk));
    const mark = () => {
      for (const b of [...base.children, ...hidden.children]) b.classList.toggle('primary', Number(b.dataset.pico) === chosen);
    };
    mark();
    const body = el('div', { className: 'dialog-form' },
      el('p', { textContent: `Pick the screen color for slot ${slot}. Pixels keep their slot, so the change shows everywhere this slot is used (like pal(${slot},c,1) in PICO-8).` }),
      el('h3', { textContent: 'Base colors (0–15)' }), base,
      el('h3', { textContent: 'Hidden colors (128–143)' }), hidden);
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pico]');
      if (!b) return;
      chosen = Number(b.dataset.pico);
      mark();
    });
    body.addEventListener('dblclick', (e) => { if (e.target.closest('[data-pico]')) body.closest('dialog')?.querySelector('.modal-foot .btn-primary')?.click(); });
    const res = await modal({
      title: `Slot ${slot} color`,
      body,
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => chosen }],
    });
    if (res == null) return;
    const pal = ps.doc.pal.slice();
    pal[slot] = res;
    setPalette(pal);
  }

  async function paletteFromLibrary() {
    const a = await S.pickAsset({ title: 'Palette from Library', kind: 'palette', allowImport: false });
    if (a) applyPaletteColors(a.colors, a.name);
  }

  function applyPaletteColors(colors, label) {
    const pal = Array.from({ length: 16 }, (_, i) => (isValidPico(colors[i]) ? colors[i] : ps.doc.pal[i]));
    setPalette(pal);
    toast(`Palette: ${label}`);
  }

  function paletteFromPaletteTool() {
    const custom = App.state.custom;
    if (!custom.some((p) => p != null)) {
      showMessage('Palette & Fades', 'The custom palette in Palette & Fades is empty.');
      return;
    }
    applyPaletteColors(custom, 'custom palette from Palette & Fades');
  }

  async function savePaletteToLibrary() {
    await S.assets.put(S.paletteAsset({ name: `${ps.name} palette`, colors: ps.doc.pal, source: 'studio' }));
    toast('Saved the palette to the library');
  }

  async function replaceColor() {
    const from = el('select', { className: 'select' }, ...Array.from({ length: 16 }, (_, i) => el('option', { value: i, textContent: `slot ${i}` })));
    const to = el('select', { className: 'select' }, ...Array.from({ length: 16 }, (_, i) => el('option', { value: i, textContent: `slot ${i}` })));
    from.value = String(ps.primary);
    to.value = String(ps.secondary);
    const scope = el('select', { className: 'select' },
      el('option', { value: 'cel', textContent: 'Current layer, current frame' }),
      el('option', { value: 'all', textContent: 'All layers and frames' }));
    const res = await modal({
      title: 'Replace Color',
      body: el('div', { className: 'dialog-form' }, formField('Replace', from), formField('With', to), formField('In', scope)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Replace', primary: true, value: () => ({ a: Number(from.value), b: Number(to.value), all: scope.value === 'all' }) }],
    });
    if (!res || res.a === res.b) return;
    if (res.all) {
      docOp((d) => { for (const f of d.frames) for (const c of f.cels) for (let i = 0; i < c.length; i++) if (c[i] === res.a) c[i] = res.b; });
    } else {
      commitFloating();
      const e = beginEdit();
      const c = cel();
      const w = ps.doc.w;
      for (let i = 0; i < c.length; i++) if (c[i] === res.a) setPx(e, i % w, Math.floor(i / w), res.b);
      endEdit(e);
    }
  }

  // ------------------------------------------------------------------ //
  // Layers                                                             //
  // ------------------------------------------------------------------ //

  function renderLayers() {
    const d = ps.doc;
    dom.layers.replaceChildren();
    for (let l = d.layers.length - 1; l >= 0; l--) {
      const layer = d.layers[l];
      const eye = el('button', { type: 'button', className: 'btn btn-ghost icon-btn ps-eye', dataset: { eye: l }, attrs: { 'aria-pressed': String(layer.visible), 'aria-label': layer.visible ? 'Hide layer' : 'Show layer' }, textContent: layer.visible ? '◉' : '○' });
      const row = el('div', { className: `ps-layer${l === ps.layer ? ' selected' : ''}`, dataset: { layer: l }, attrs: { role: 'button', tabindex: '0' } },
        eye, el('span', { className: 'ps-layer-name', textContent: layer.name }));
      dom.layers.append(row);
    }
  }

  function selectLayer(l) {
    commitFloating();
    ps.layer = l;
    renderLayers();
  }

  async function renameLayer(l) {
    const input = el('input', { type: 'text', value: ps.doc.layers[l].name, spellcheck: false });
    const name = await modal({
      title: 'Rename Layer',
      body: el('div', { className: 'dialog-form' }, formField('Name', input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => input.value.trim() }],
      onOpen: () => input.select(),
    });
    if (name) docOp((d) => { d.layers[l].name = name; });
  }

  const layerOps = {
    add: () => docOp((d) => {
      const at = ps.layer + 1;
      d.layers.splice(at, 0, { name: `Layer ${d.layers.length + 1}`, visible: true });
      for (const f of d.frames) f.cels.splice(at, 0, K.blankCel(d.w, d.h));
      ps.layer = at;
    }),
    duplicate: () => docOp((d) => {
      const at = ps.layer + 1;
      d.layers.splice(at, 0, { ...d.layers[ps.layer], name: `${d.layers[ps.layer].name} copy` });
      for (const f of d.frames) f.cels.splice(at, 0, f.cels[ps.layer].slice());
      ps.layer = at;
    }),
    remove: () => {
      if (ps.doc.layers.length < 2) { toast('A document needs at least one layer', 'warn'); return; }
      docOp((d) => {
        d.layers.splice(ps.layer, 1);
        for (const f of d.frames) f.cels.splice(ps.layer, 1);
        ps.layer = Math.max(0, ps.layer - 1);
      });
    },
    up: () => {
      if (ps.layer >= ps.doc.layers.length - 1) return;
      docOp((d) => { swapLayers(d, ps.layer, ps.layer + 1); ps.layer++; });
    },
    down: () => {
      if (ps.layer <= 0) return;
      docOp((d) => { swapLayers(d, ps.layer, ps.layer - 1); ps.layer--; });
    },
    merge: () => {
      if (ps.layer <= 0) { toast('Select a layer above another one to merge down', 'warn'); return; }
      docOp((d) => {
        const l = ps.layer;
        for (const f of d.frames) {
          const top = f.cels[l];
          const below = f.cels[l - 1];
          for (let i = 0; i < top.length; i++) if (top[i] !== EMPTY) below[i] = top[i];
          f.cels.splice(l, 1);
        }
        d.layers.splice(l, 1);
        ps.layer = l - 1;
      });
    },
    flatten: () => {
      if (ps.doc.layers.length < 2) return;
      docOp((d) => {
        d.frames.forEach((f, i) => { f.cels = [K.flatten(d, i)]; });
        d.layers = [{ name: 'Layer 1', visible: true }];
        ps.layer = 0;
      });
    },
  };

  function swapLayers(d, a, b) {
    [d.layers[a], d.layers[b]] = [d.layers[b], d.layers[a]];
    for (const f of d.frames) [f.cels[a], f.cels[b]] = [f.cels[b], f.cels[a]];
  }

  // ------------------------------------------------------------------ //
  // Frames + playback                                                  //
  // ------------------------------------------------------------------ //

  const thumbTimers = new Map();

  function frameThumb(f) {
    const size = 44;
    const c = el('canvas', { className: 'ps-frame-thumb' });
    c.width = size;
    c.height = size;
    paintThumb(c, f);
    return c;
  }

  function paintThumb(c, f) {
    const d = ps.doc;
    if (!d.frames[f]) return;
    const g = c.getContext('2d');
    const size = c.width;
    g.clearRect(0, 0, size, size);
    const s = Math.min(size / d.w, size / d.h);
    const w = Math.max(1, Math.round(d.w * s));
    const h = Math.max(1, Math.round(d.h * s));
    const t = d.transparent >= 0 ? d.transparent : 0;
    g.fillStyle = `rgb(${rgbCache[t]})`;
    const x = Math.floor((size - w) / 2);
    const y = Math.floor((size - h) / 2);
    g.fillRect(x, y, w, h);
    g.imageSmoothingEnabled = s < 1;
    onionCache.delete(f);
    g.drawImage(frameCanvas(f), x, y, w, h);
  }

  function scheduleThumb(f) {
    clearTimeout(thumbTimers.get(f));
    thumbTimers.set(f, setTimeout(() => {
      thumbTimers.delete(f);
      const c = dom.frames.querySelector(`[data-frame="${f}"] canvas`);
      if (c) paintThumb(c, f);
    }, 250));
  }

  function renderFrames() {
    const d = ps.doc;
    dom.frames.replaceChildren(...d.frames.map((_, f) => el('button', {
      type: 'button', className: `ps-frame${f === ps.frame ? ' selected' : ''}`, dataset: { frame: f }, title: `Frame ${f + 1}`,
    }, frameThumb(f), el('span', { textContent: f + 1 }))));
    renderFrameChrome();
  }

  function renderFrameChrome() {
    for (const b of dom.frames.querySelectorAll('.ps-frame')) b.classList.toggle('selected', Number(b.dataset.frame) === ps.frame);
    dom.frameInfo.textContent = `${ps.frame + 1} / ${ps.doc.frames.length}`;
    dom.fps.value = ps.doc.fps;
    dom.play.textContent = ps.playing ? '⏸ Pause' : '▶ Play';
    dom.play.setAttribute('aria-pressed', String(ps.playing));
  }

  function selectFrame(f) {
    f = Math.max(0, Math.min(ps.doc.frames.length - 1, f));
    if (f === ps.frame) return;
    commitFloating();
    clearOverlay();
    ps.frame = f;
    renderFrameChrome();
    dirtyAll();
    dom.frames.querySelector(`[data-frame="${f}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  const frameOps = {
    add: () => docOp((d) => {
      d.frames.splice(ps.frame + 1, 0, { cels: d.layers.map(() => K.blankCel(d.w, d.h)) });
      ps.frame++;
    }),
    duplicate: () => docOp((d) => {
      d.frames.splice(ps.frame + 1, 0, { ...d.frames[ps.frame], cels: d.frames[ps.frame].cels.map((c) => c.slice()) });
      ps.frame++;
    }),
    remove: () => {
      if (ps.doc.frames.length < 2) { toast('A document needs at least one frame', 'warn'); return; }
      docOp((d) => { d.frames.splice(ps.frame, 1); ps.frame = Math.max(0, ps.frame - 1); });
    },
    left: () => {
      if (ps.frame <= 0) return;
      docOp((d) => { [d.frames[ps.frame - 1], d.frames[ps.frame]] = [d.frames[ps.frame], d.frames[ps.frame - 1]]; ps.frame--; });
    },
    right: () => {
      if (ps.frame >= ps.doc.frames.length - 1) return;
      docOp((d) => { [d.frames[ps.frame + 1], d.frames[ps.frame]] = [d.frames[ps.frame], d.frames[ps.frame + 1]]; ps.frame++; });
    },
  };

  let playTimer = 0;
  function setPlaying(on) {
    ps.playing = on && ps.doc.frames.length > 1;
    clearInterval(playTimer);
    if (ps.playing) {
      commitFloating();
      playTimer = setInterval(() => {
        ps.frame = (ps.frame + 1) % ps.doc.frames.length;
        renderFrameChrome();
        dirtyAll();
      }, 1000 / Math.max(1, ps.doc.fps));
    }
    renderFrameChrome();
  }

  // ------------------------------------------------------------------ //
  // Document lifecycle                                                 //
  // ------------------------------------------------------------------ //

  function afterDocReplaced() {
    clearOverlay();
    rebuildComposite();
    renderPalette();
    renderLayers();
    renderFrames();
    renderTitle();
    requestDraw();
  }

  function renderTitle() {
    dom.name.value = ps.name;
    dom.size.textContent = `${ps.doc.w}×${ps.doc.h}${ps.dirty ? ' · edited' : ''}${ps.assetId ? '' : ' · not in library'}`;
  }

  let sessionTimer = 0;
  function changed() {
    ps.dirty = true;
    renderTitle();
    clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 1200);
  }

  function saveSession() {
    S.kv.set(KEYS.session, { doc: ps.doc, name: ps.name, assetId: ps.assetId, dirty: ps.dirty, primary: ps.primary, secondary: ps.secondary });
  }

  async function restoreSession() {
    const s = await S.kv.get(KEYS.session);
    if (!s?.doc?.frames?.length) return false;
    loadDoc(s.doc, { name: s.name, assetId: s.assetId, dirty: s.dirty });
    if (Number.isInteger(s.primary)) ps.primary = s.primary & 15;
    if (Number.isInteger(s.secondary)) ps.secondary = s.secondary & 15;
    renderColors();
    return true;
  }

  function loadDoc(d, { name = 'untitled', assetId = null, dirty = false, fades = null } = {}) {
    setPlaying(false);
    ps.doc = d;
    ps.fades = fades;
    ps.name = name;
    ps.assetId = assetId;
    ps.dirty = dirty;
    ps.frame = 0;
    ps.layer = d.layers.length - 1;
    ps.sel = null;
    ps.floating = null;
    ps.undo = [];
    ps.redo = [];
    afterDocReplaced();
    requestAnimationFrame(zoomFit);
    saveSession();
  }

  async function confirmDiscard(what = 'Replace the current image?') {
    if (!ps.dirty) return true;
    return confirmDialog('Unsaved Changes', `${what}\n\nThe current image has changes that are not saved to the library.`, 'Discard changes');
  }

  const SIZE_PRESETS = [
    ['8x8', 'Sprite 8×8'], ['16x16', 'Sprite 16×16 (2×2)'], ['24x24', 'Sprite 24×24 (3×3)'], ['32x32', 'Sprite 32×32 (4×4)'],
    ['64x64', '64×64 (8×8 sprites)'], ['128x128', 'Screen / full sprite sheet 128×128'], ['128x64', 'Sprite sheet top half 128×64 (sprites 0–127)'],
    ['128x32', 'One sprite sheet tab 128×32 (64 sprites)'], ['256x128', '2 screens wide 256×128'], ['128x256', '2 screens tall 128×256'],
    ['1024x256', 'Map, top half in pixels (128×32 tiles)'], ['1024x512', 'Full map in pixels (128×64 tiles)'], ['custom', 'Custom…'],
  ];

  async function newDocument() {
    if (!(await confirmDiscard('Start a new image?'))) return;
    const preset = el('select', { className: 'select' }, ...SIZE_PRESETS.map(([v, t]) => el('option', { value: v, textContent: t })));
    preset.value = saved.lastSize || '128x128';
    const w = el('input', { type: 'number', min: 1, max: K.MAX_SIDE, value: 128 });
    const h = el('input', { type: 'number', min: 1, max: K.MAX_SIDE, value: 128 });
    const keepPal = el('input', { type: 'checkbox', checked: true });
    const name = el('input', { type: 'text', value: 'untitled', spellcheck: false });
    const customRow = el('div', { className: 'row-inline' }, formField('Width', w), formField('Height', h));
    const sync = () => {
      const custom = preset.value === 'custom';
      customRow.hidden = !custom;
      if (!custom) {
        const [pw, ph] = preset.value.split('x').map(Number);
        w.value = pw;
        h.value = ph;
      }
    };
    preset.addEventListener('change', sync);
    sync();
    const res = await modal({
      title: 'New Image',
      body: el('div', { className: 'dialog-form' },
        formField('Name', name),
        formField('Size', preset),
        customRow,
        el('p', { className: 'muted', textContent: `Any size up to ${K.MAX_SIDE}×${K.MAX_SIDE}. Multiples of 8 line up with PICO-8 sprites and map tiles; images larger than 128×128 can be exported as data carts or packed into tiles with the Tile Maker.` }),
        el('label', { className: 'check' }, keepPal, el('span', { textContent: 'Keep the current palette' }))),
      buttons: [{ label: 'Cancel', value: null }, {
        label: 'Create', primary: true,
        value: () => ({ w: clampInt(Number(w.value) || 128, 1, K.MAX_SIDE), h: clampInt(Number(h.value) || 128, 1, K.MAX_SIDE), name: name.value.trim() || 'untitled', preset: preset.value }),
      }],
    });
    if (!res) return;
    saved.lastSize = res.preset;
    store.set(KEYS.settings, { ...store.get(KEYS.settings, {}), lastSize: res.preset });
    loadDoc(K.newDoc(res.w, res.h, { pal: keepPal.checked ? ps.doc.pal : null, transparent: keepPal.checked ? ps.doc.transparent : 0 }), { name: res.name });
  }

  function currentAsset() {
    const d = ps.doc;
    return S.imageAsset({
      name: ps.name, w: d.w, h: d.h, pixels: K.flattenSlots(d, 0), pal: d.pal, transparent: d.transparent, source: 'studio', doc: K.cloneDoc(d),
      meta: ps.fades ? { fades: ps.fades } : null,
    });
  }

  async function saveToLibrary({ asNew = false } = {}) {
    commitFloating();
    const a = currentAsset();
    if (!asNew && ps.assetId && S.assets.get(ps.assetId)) {
      const old = S.assets.get(ps.assetId);
      a.id = old.id;
      a.created = old.created;
    }
    const stored = await S.assets.put(a);
    ps.assetId = stored.id;
    ps.dirty = false;
    renderTitle();
    saveSession();
    toast(`Saved "${ps.name}" to the library`);
  }

  async function openAsset(a) {
    if (!(await confirmDiscard(`Open "${a.name}"?`))) return;
    App.setWorkspace('studio');
    loadDoc(K.docFromAsset(a), { name: a.name, assetId: a.source === 'studio' ? a.id : null, fades: a.meta?.fades || null });
    if (a.source !== 'studio') toast('Opened a copy: Save to Library creates a Pixel Studio image', 'info', 2600);
  }

  async function openFromLibrary() {
    const a = await S.pickAsset({ title: 'Open from Library' });
    if (a) openAsset(a);
  }

  async function importImage(file = null) {
    file = file || (await pickFile('image/png,image/jpeg,image/bmp,image/gif,.png,.jpg,.jpeg,.bmp,.gif'));
    if (!file) return;
    let img;
    try {
      img = await decodeImage(file);
    } catch {
      showMessage('Import Image', 'Could not decode the image.');
      return;
    }
    if (img.width > K.MAX_SIDE || img.height > K.MAX_SIDE) {
      showMessage('Import Image', `The image is ${img.width}×${img.height}. Pixel Studio supports up to ${K.MAX_SIDE}×${K.MAX_SIDE}.\n\nUse the Tile Maker for larger images.`);
      return;
    }
    if (!(await confirmDiscard(`Open "${file.name}"?`))) return;
    const d = K.newDoc(img.width, img.height, { pal: ps.doc.pal, transparent: ps.doc.transparent });
    d.frames[0].cels[0] = quantizeImage(img);
    loadDoc(d, { name: file.name.replace(/\.[^.]+$/, ''), dirty: true });
    toast('Colors were matched to the nearest color of the current palette', 'info', 2600);
  }

  async function importCart() {
    const file = await pickFile('.p8,text/plain');
    if (!file) return;
    const text = await file.text();
    if (!K.isCart(text)) { showMessage('Import .p8', 'This is not a PICO-8 text cart (.p8).'); return; }
    const gfx = K.gfxFromCart(text);
    if (!gfx) { showMessage('Import .p8', 'The cart has no __gfx__ section.'); return; }
    if (!(await confirmDiscard(`Open the sprite sheet of "${file.name}"?`))) return;
    const d = K.newDoc(gfx.w, gfx.h);
    d.frames[0].cels[0] = gfx.pixels;
    d.layers[0].name = 'Sprite sheet';
    loadDoc(d, { name: file.name.replace(/\.p8$/i, ''), dirty: true });
    toast(`Loaded ${gfx.w}×${gfx.h} sprite sheet (standard palette)`);
  }

  // ------------------------------------------------------------------ //
  // Exports                                                            //
  // ------------------------------------------------------------------ //

  const scaleIndices = (src, w, h, s) => {
    if (s === 1) return src;
    const out = new Uint8Array(w * s * h * s);
    for (let y = 0; y < h * s; y++) for (let x = 0; x < w * s; x++) out[y * w * s + x] = src[Math.floor(y / s) * w + Math.floor(x / s)];
    return out;
  };

  async function exportPng() {
    commitFloating();
    const d = ps.doc;
    const scale = el('select', { className: 'select' }, ...[1, 2, 3, 4, 6, 8].map((s) => el('option', { value: s, textContent: `${s}× (${d.w * s}×${d.h * s})` })));
    const what = el('select', { className: 'select' },
      el('option', { value: 'frame', textContent: 'Current frame' }),
      el('option', { value: 'strip', textContent: `All frames side by side (${d.frames.length})` }),
      el('option', { value: 'files', textContent: 'All frames as separate files' }));
    what.disabled = d.frames.length < 2;
    const transp = el('input', { type: 'checkbox', checked: d.transparent >= 0 });
    const res = await modal({
      title: 'Export PNG',
      body: el('div', { className: 'dialog-form' }, formField('Scale', scale), formField('Frames', what),
        el('label', { className: 'check' }, transp, el('span', { textContent: 'Transparent color stays transparent' }))),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Export', primary: true, value: () => ({ s: Number(scale.value), what: what.value, t: transp.checked }) }],
    });
    if (!res) return;
    const rgb = palRgb();
    const t = res.t && d.transparent >= 0 ? d.transparent : -1;
    const base = sanitizeFilename(ps.name);
    const one = async (pixels, w, h, suffix) => download(await encodeIndexedPng(w * res.s, h * res.s, scaleIndices(pixels, w, h, res.s), rgb, t), `${base}${suffix}.png`);
    if (res.what === 'frame') await one(K.flattenSlots(d, ps.frame), d.w, d.h, d.frames.length > 1 ? `_${ps.frame + 1}` : '');
    else if (res.what === 'files') d.frames.forEach((_, f) => setTimeout(() => one(K.flattenSlots(d, f), d.w, d.h, `_${f + 1}`), f * 300));
    else {
      const W = d.w * d.frames.length;
      const strip = new Uint8Array(W * d.h);
      d.frames.forEach((_, f) => K.blit(K.flattenSlots(d, f), d.w, d.h, strip, W, d.h, f * d.w, 0));
      await one(strip, W, d.h, '_strip');
    }
  }

  async function copyGfx() {
    commitFloating();
    const p = selectionPixels({ merged: true });
    if (p.w > 128 || p.h > 128) {
      showMessage('Copy for PICO-8', `The ${ps.sel ? 'selection' : 'image'} is ${p.w}×${p.h}. The PICO-8 sprite editor takes at most 128×128.\n\nSelect a smaller area first.`);
      return;
    }
    const text = K.toGfxClip(toSlots(p.data), p.w, p.h);
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${p.w}×${p.h} as PICO-8 [gfx]. Paste it in the PICO-8 sprite editor with Ctrl+V.`, 'info', 3200);
    } catch {
      App.codeDialog('PICO-8 graphics', text, `${sanitizeFilename(ps.name)}.txt`);
    }
  }

  /** Dialog: where on the sprite sheet + what to place. Returns {slots,w,h,dx,dy,anim} or null. */
  async function sheetPlacement(title, verb) {
    commitFloating();
    const d = ps.doc;
    const multi = d.frames.length > 1;
    const sprite = el('input', { type: 'number', min: 0, max: 255, value: saved.lastSprite || 0 });
    const what = el('select', { className: 'select' },
      el('option', { value: 'frame', textContent: 'Current frame' }),
      el('option', { value: 'frames', textContent: `All ${d.frames.length} frames as sprites (animation)` }));
    what.disabled = !multi;
    if (multi && d.w <= 64 && d.h <= 64) what.value = 'frames';
    const info = el('p', { className: 'muted' });
    const upd = () => {
      const n = clampInt(Number(sprite.value) || 0, 0, 255);
      info.textContent = `Sprite ${n} = sheet position ${(n % 16) * 8}, ${Math.floor(n / 16) * 8}. Sprites 128–255 share memory with the lower half of the map.`;
    };
    sprite.addEventListener('input', upd);
    upd();
    const res = await modal({
      title,
      body: el('div', { className: 'dialog-form' }, formField('Start at sprite', sprite), formField('Content', what), info),
      buttons: [{ label: 'Cancel', value: null }, { label: verb, primary: true, value: () => ({ n: clampInt(Number(sprite.value) || 0, 0, 255), frames: what.value === 'frames' }) }],
    });
    if (!res) return null;
    saved.lastSprite = res.n;
    store.set(KEYS.settings, { ...store.get(KEYS.settings, {}), lastSprite: res.n });
    const dx = (res.n % 16) * 8;
    const dy = Math.floor(res.n / 16) * 8;
    if (!res.frames) {
      if (dx + d.w > 128 || dy + d.h > 128) {
        showMessage(title, `A ${d.w}×${d.h} image does not fit on the sprite sheet at sprite ${res.n} (${dx},${dy}).\n\nChoose a smaller start sprite, or export a data cart instead.`);
        return null;
      }
      return { slots: K.flattenSlots(d, ps.frame), w: d.w, h: d.h, dx, dy, anim: null };
    }
    const sheet = K.framesToSheet(d.frames.map((_, f) => K.flattenSlots(d, f)), d.w, d.h, res.n);
    if (sheet.error) { showMessage(title, sheet.error); return null; }
    // Place only the rows the frames occupy so the rest of an existing sheet stays untouched
    return {
      slots: sheet.pixels, w: 128, h: sheet.h, dx: 0, dy: 0, frameLayout: sheet,
      anim: { frames: sheet.positions.map((p) => p.spr), fw: Math.ceil(d.w / 8), fh: Math.ceil(d.h / 8), pw: d.w, ph: d.h, fps: d.fps, spr: sheet.spr },
    };
  }

  async function exportCart() {
    const d = ps.doc;
    if (d.w > 128 || d.h > 128) {
      commitFloating();
      const bytes = Math.ceil(d.w / 2) * d.h;
      if (bytes > 0x4300) {
        showMessage('Export .p8', `${d.w}×${d.h} needs ${bytes} bytes; a data cart holds 17152 (0x4300).\n\nUse the Tile Maker to pack it into tiles + map instead (File → Send to Tile Maker).`);
        return;
      }
      const ok = await confirmDialog('Export Data Cart', `${d.w}×${d.h} is larger than the sprite sheet. Export it as a raw data cart (${bytes} bytes, 4 bits per pixel, from 0x0000)?\n\nThe Palette & Fades viewer and memcpy-style loaders read this layout.`, 'Export');
      if (!ok) return;
      download(buildDataCart(K.flattenSlots(d, ps.frame), d.w, d.h), `${sanitizeFilename(ps.name)}_data.p8`);
      return;
    }
    const p = await sheetPlacement('Export .p8 Cart', 'Export');
    if (!p) return;
    const cart = K.buildGfxCart({
      slots: p.slots, w: p.w, h: p.h, dx: p.dx, dy: p.dy, pal: d.pal, transparent: d.transparent, name: ps.name,
      anim: p.anim,
    });
    download(cart, `${sanitizeFilename(ps.name)}.p8`);
    if (p.anim) toast(`Frames at sprites ${p.anim.frames.join(', ')}`, 'info', 4000);
  }

  async function writeIntoCart() {
    const d = ps.doc;
    if (d.w > 128 || d.h > 128) { showMessage('Write into .p8', 'Only images up to 128×128 fit on the sprite sheet.'); return; }
    const file = await pickFile('.p8,text/plain');
    if (!file) return;
    const text = await file.text();
    if (!K.isCart(text)) { showMessage('Write into .p8', 'This is not a PICO-8 text cart (.p8).'); return; }
    const p = await sheetPlacement(`Write into ${file.name}`, 'Write');
    if (!p) return;
    let out = text;
    if (p.frameLayout) {
      // write each frame separately so sprites between them are kept
      const lay = p.frameLayout;
      d.frames.forEach((_, f) => {
        const pos = lay.positions[f];
        out = K.writeGfxIntoCart(out, K.flattenSlots(d, f), d.w, d.h, pos.x, pos.y);
      });
    } else {
      out = K.writeGfxIntoCart(out, p.slots, p.w, p.h, p.dx, p.dy);
    }
    download(out, file.name);
    const palNote = d.pal.some((c, i) => c !== i) ? `\n\nThis image uses a custom screen palette. Add to your _init():\n${K.palCode(d.pal, ' ').join('\n')}` : '';
    showMessage('Write into .p8', `Downloaded ${file.name} with the new graphics${p.anim ? ` (frames at sprites ${p.anim.frames.join(', ')})` : ''}.\n\nReplace the original cart with it (or load it in PICO-8 and save).${palNote}`);
  }

  async function sendToTiles() {
    commitFloating();
    await S.openIn('tiles-import', currentAsset());
  }

  async function sendToPreview() {
    commitFloating();
    await S.openIn('palette-preview', currentAsset());
  }

  async function framesToLibrarySheet() {
    const p = await sheetPlacement('Frames → Sprite Sheet', 'Create');
    if (!p) return;
    const d = ps.doc;
    const pixels = new Uint8Array(128 * 128);
    K.blit(p.slots, p.w, p.h, pixels, 128, 128, p.dx, p.dy);
    await S.assets.put(S.imageAsset({ name: `${ps.name} sheet`, w: 128, h: 128, pixels, pal: d.pal, transparent: d.transparent, source: 'studio' }));
    toast(p.anim ? `Sheet saved to the library: frames at sprites ${p.anim.frames.join(', ')}` : 'Sheet saved to the library');
  }

  // ------------------------------------------------------------------ //
  // Canvas size                                                        //
  // ------------------------------------------------------------------ //

  async function canvasSize() {
    const d = ps.doc;
    const w = el('input', { type: 'number', min: 1, max: K.MAX_SIDE, value: d.w });
    const h = el('input', { type: 'number', min: 1, max: K.MAX_SIDE, value: d.h });
    let anchor = [0, 0];
    const grid = el('div', { className: 'anchor-grid' });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const b = el('button', { type: 'button', className: 'anchor-cell', dataset: { ax: x / 2, ay: y / 2 } });
        grid.append(b);
      }
    }
    const mark = () => { for (const b of grid.children) b.setAttribute('aria-pressed', String(Number(b.dataset.ax) === anchor[0] && Number(b.dataset.ay) === anchor[1])); };
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.anchor-cell');
      if (b) { anchor = [Number(b.dataset.ax), Number(b.dataset.ay)]; mark(); }
    });
    mark();
    const res = await modal({
      title: 'Canvas Size',
      body: el('div', { className: 'dialog-form' },
        el('div', { className: 'row-inline' }, formField('Width', w), formField('Height', h)),
        el('p', { className: 'muted', textContent: 'Anchor: where the existing pixels stay.' }), grid),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Resize', primary: true, value: () => ({ w: clampInt(Number(w.value) || d.w, 1, K.MAX_SIDE), h: clampInt(Number(h.value) || d.h, 1, K.MAX_SIDE) }) }],
    });
    if (!res || (res.w === d.w && res.h === d.h)) return;
    ps.sel = null;
    docOp((doc) => K.resizeDoc(doc, res.w, res.h, anchor[0], anchor[1]));
    requestAnimationFrame(zoomFit);
  }

  async function scaleCanvas() {
    const d = ps.doc;
    const f = el('select', { className: 'select' }, ...[2, 3, 4].map((s) => el('option', { value: s, textContent: `${s}× → ${d.w * s}×${d.h * s}` })));
    const res = await modal({
      title: 'Scale Up',
      body: el('div', { className: 'dialog-form' }, formField('Factor', f)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Scale', primary: true, value: () => Number(f.value) }],
    });
    if (!res) return;
    if (d.w * res > K.MAX_SIDE || d.h * res > K.MAX_SIDE) { showMessage('Scale Up', `The result would exceed ${K.MAX_SIDE}×${K.MAX_SIDE}.`); return; }
    ps.sel = null;
    docOp((doc) => K.scaleDoc(doc, res));
    requestAnimationFrame(zoomFit);
  }

  // ------------------------------------------------------------------ //
  // Status bar                                                         //
  // ------------------------------------------------------------------ //

  function renderStatus() {
    const d = ps.doc;
    let h = ps.hover;
    if (h) { const [x, y] = wrapPt(h.x, h.y); h = { x, y }; }
    if (h && inDoc(h.x, h.y)) {
      dom.status.pos.textContent = `${h.x}, ${h.y}`;
      const cx = Math.floor(h.x / 8);
      const cy = Math.floor(h.y / 8);
      const spr = d.w <= 128 && d.h <= 128 ? ` · spr ${cy * 16 + cx}` : '';
      dom.status.cell.textContent = `cell ${cx}, ${cy}${spr}`;
      const v = pixelAt(h.x, h.y);
      dom.status.color.textContent = v === EMPTY ? 'empty' : `slot ${v} = color ${d.pal[v]}`;
    } else {
      dom.status.pos.textContent = '–';
      dom.status.cell.textContent = '';
      dom.status.color.textContent = '';
    }
    const b = ps.floating || ps.sel;
    dom.status.sel.textContent = b ? `${ps.floating ? 'moving' : 'selection'} ${b.w}×${b.h} at ${b.x}, ${b.y}` : '';
  }

  // ------------------------------------------------------------------ //
  // Keyboard                                                           //
  // ------------------------------------------------------------------ //

  const TOOL_KEYS = { b: 'pencil', e: 'eraser', l: 'line', u: 'rect', o: 'ellipse', g: 'fill', i: 'picker', m: 'select', q: 'lasso', w: 'wand', h: 'hand' };

  function onKey(e, typing) {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.type === 'keyup') return;
    if (fullView) { fullViewKey(e); return; }
    if (typing) return;
    if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey && (e.target === dom.canvas || e.target === document.body)) { e.preventDefault(); setTimeline(!ps.timeline); return; }
    if ((e.key === 'f' || e.key === 'F' || e.key === 'F8') && !mod && !e.altKey) { e.preventDefault(); openFullView(); return; }
    // hold Alt with a drawing tool: color picker until Alt is released
    if (e.key === 'Alt' && !mod && !e.shiftKey) {
      e.preventDefault();
      if (!ps.altTool && DRAW_TOOLS.has(ps.tool) && !drag) {
        const prev = ps.tool;
        setTool('picker');
        ps.altTool = prev;
      }
      return;
    }
    if (mod) {
      const run = (fn) => { e.preventDefault(); fn(); };
      if (key === 'z' && !e.shiftKey) return run(undo);
      if ((key === 'z' && e.shiftKey) || key === 'y') return run(redo);
      if (key === 's') return run(() => saveToLibrary({ asNew: e.shiftKey }));
      if (key === 'o') return run(openFromLibrary);
      if (key === 'n' && e.altKey) return run(newDocument);
      if (key === 'i' && !e.shiftKey) return run(() => importImage());
      if (key === 'a') return run(selectAll);
      if (key === 'd') return run(deselect);
      if (key === 'i' && e.shiftKey) return run(invertSelection);
      if (key === 'b') return run(brushFromSelection);
      if (key === 'c' && e.shiftKey) return run(copyGfx);
      if (key === 'c') return run(() => copySelection({ merged: false }));
      if (key === 'x') return run(() => copySelection({ cut: true }));
      // Ctrl+V: handled by the paste event (gives access to the clipboard without a permission prompt)
      return;
    }
    if (e.key === ' ') { e.preventDefault(); if (!ps.spaceDown) { ps.spaceDown = true; dom.stage.classList.add('space'); } return; }
    if (e.key === 'Escape') { if (cancelPolygon() || cancelXform()) return; if (ps.floating || ps.sel) deselect(); return; }
    if (e.key === 'Enter') { e.preventDefault(); if (ps.poly) closePolygon(); else if (ps.floating) commitFloating(); else setPlaying(!ps.playing); return; }
    if (e.key === 'Backspace' && ps.poly) {
      e.preventDefault();
      ps.poly.pts.pop();
      if (!ps.poly.pts.length) ps.poly = null;
      requestDraw();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key.startsWith('Arrow') && (ps.sel || ps.floating)) {
      e.preventDefault();
      const s = e.shiftKey ? 8 : 1;
      moveFloatingBy(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0);
      return;
    }
    // M / Q pick a selection tool; pressed again they step to the other tool of the pair
    const cycle = !e.altKey && KEY_CYCLES[key];
    if (cycle) {
      setTool(cycle.includes(ps.tool) ? cycle[(cycle.indexOf(ps.tool) + 1) % cycle.length] : cycle[0]);
      return;
    }
    if (TOOL_KEYS[key] && !e.altKey) { setTool(TOOL_KEYS[key]); return; }
    switch (e.key) {
      case 'x': case 'X': [ps.primary, ps.secondary] = [ps.secondary, ps.primary]; renderColors(); break;
      case '[': ps.brush = Math.max(1, ps.brush - 1); persistSettings(); renderOptions(); requestDraw(); break;
      case 'p': case 'P': ps.pixelPerfect = !ps.pixelPerfect; persistSettings(); renderOptions(); toast(`Pixel perfect ${ps.pixelPerfect ? 'on' : 'off'}`); break;
      case ']': ps.brush = Math.min(4, ps.brush + 1); persistSettings(); renderOptions(); requestDraw(); break;
      case '+': case '=': stepZoom(1); break;
      case '-': stepZoom(-1); break;
      case '0': zoomFit(); break;
      case '1': setZoom(1); break;
      case ',': selectFrame(ps.frame - 1); break;
      case '.': selectFrame(ps.frame + 1); break;
      case "'": ps.grid8 = !ps.grid8; persistSettings(); renderOptions(); requestDraw(); break;
      case 'v': case 'V': ps.sieve = !ps.sieve; renderOptions(); requestDraw(); break;
      default:
    }
  }

  // ------------------------------------------------------------------ //
  // Binding                                                            //
  // ------------------------------------------------------------------ //

  function bind() {
    const c = dom.canvas;
    c.addEventListener('pointerdown', onPointerDown);
    c.addEventListener('pointermove', onPointerMove);
    c.addEventListener('pointerup', onPointerUp);
    c.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; cancelStroke(); });
    c.addEventListener('pointerleave', () => { ps.hover = null; renderStatus(); requestDraw(); });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', onWheel, { passive: false });
    new ResizeObserver(() => requestDraw()).observe(dom.stage);

    buildToolGroups();
    dom.timelineBtn.addEventListener('click', () => setTimeline(!ps.timeline));
    $('#psFullBtn').addEventListener('click', openFullView);
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fullView) closeFullView(); });
    dom.tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b) setTool(b.dataset.tool);
    });
    dom.swap.addEventListener('click', () => { [ps.primary, ps.secondary] = [ps.secondary, ps.primary]; renderColors(); });

    dom.name.addEventListener('change', () => { ps.name = dom.name.value.trim() || 'untitled'; changed(); });

    dom.brush.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      ps.brush = Number(b.dataset.value);
      persistSettings();
      renderOptions();
    });
    dom.filled.addEventListener('change', () => { ps.filled = dom.filled.checked; persistSettings(); });
    dom.contig.addEventListener('change', () => { ps.contiguous = dom.contig.checked; persistSettings(); });
    dom.ink.addEventListener('change', () => { ps.ink = dom.ink.value; persistSettings(); });
    dom.pp.addEventListener('change', () => { ps.pixelPerfect = dom.pp.checked; persistSettings(); });
    // transform values typed in (angle in degrees, scale in %)
    const xformInput = () => {
      const t = ps.xform;
      if (!t) return;
      const a = Number(dom.xAngle.value);
      const sx = Number(dom.xScaleX.value) / 100;
      const sy = Number(dom.xScaleY.value) / 100;
      if (Number.isFinite(a)) t.angle = a;
      if (Number.isFinite(sx) && sx) t.sx = sx;
      if (Number.isFinite(sy) && sy) t.sy = sy;
      applyXform();
    };
    for (const i of [dom.xAngle, dom.xScaleX, dom.xScaleY]) i.addEventListener('change', xformInput);
    dom.xAlgo.addEventListener('change', () => { ps.rotAlgo = dom.xAlgo.value; persistSettings(); applyXform(); });
    dom.xApply.addEventListener('click', commitFloating);
    dom.xCancel.addEventListener('click', () => { cancelXform(); requestDraw(); });
    dom.pattern.replaceChildren(...K.PATTERNS.map((p) => el('option', { value: String(p.value), textContent: p.name })), el('option', { value: 'custom', textContent: 'Custom…' }));
    dom.pattern.addEventListener('change', () => {
      if (dom.pattern.value === 'custom') { editPattern(); return; }
      ps.pattern = Number(dom.pattern.value);
      persistSettings();
      renderOptions();
    });
    dom.patternEdit.addEventListener('click', editPattern);
    dom.patternAlt.addEventListener('change', () => { ps.patternAlt = dom.patternAlt.value; persistSettings(); renderOptions(); });
    dom.sieveSel.addEventListener('change', () => { ps.sieveIndex = Number(dom.sieveSel.value); ps.sieve = true; persistSettings(); renderOptions(); requestDraw(); });
    dom.sieveEdit.addEventListener('click', editSieves);
    const toggle = (btn, key, persist = true) => btn.addEventListener('click', () => {
      ps[key] = !ps[key];
      if (persist) persistSettings();
      renderOptions();
      requestDraw();
    });
    toggle(dom.mirrorX, 'mirrorX', false);
    toggle(dom.mirrorY, 'mirrorY', false);
    toggle(dom.gridPx, 'gridPx');
    toggle(dom.tiled, 'tiled', false);
    toggle(dom.sieve, 'sieve', false);
    toggle(dom.onion, 'onion');
    dom.grid8.addEventListener('click', () => {
      // off -> 8 -> 16 -> off
      if (!ps.grid8) { ps.grid8 = true; ps.gridSize = 8; } else if (ps.gridSize === 8) ps.gridSize = 16; else ps.grid8 = false;
      persistSettings();
      renderOptions();
      requestDraw();
    });
    $('#psZoomIn').addEventListener('click', () => stepZoom(1));
    $('#psZoomOut').addEventListener('click', () => stepZoom(-1));
    $('#psZoomFit').addEventListener('click', zoomFit);
    $('#psZoom1').addEventListener('click', () => setZoom(1));
    dom.previewScale.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      ps.previewScale = Number(b.dataset.value);
      persistSettings();
      renderOptions();
      requestDraw();
    });

    // Palette
    dom.palette.addEventListener('click', (e) => {
      const b = e.target.closest('.ps-sw');
      if (!b) return;
      ps.primary = Number(b.dataset.slot);
      renderColors();
    });
    dom.palette.addEventListener('contextmenu', (e) => {
      const b = e.target.closest('.ps-sw');
      if (!b) return;
      e.preventDefault();
      ps.secondary = Number(b.dataset.slot);
      renderColors();
    });
    dom.palette.addEventListener('dblclick', (e) => {
      const b = e.target.closest('.ps-sw');
      if (b) remapSlot(Number(b.dataset.slot));
    });
    dom.transp.addEventListener('change', () => setPalette(ps.doc.pal, Number(dom.transp.value)));
    $('#psPalEdit').addEventListener('click', () => remapSlot(ps.primary));
    $('#psPalFromTool').addEventListener('click', paletteFromPaletteTool);
    $('#psPalFromLib').addEventListener('click', paletteFromLibrary);
    $('#psPalSave').addEventListener('click', savePaletteToLibrary);
    $('#psPalReset').addEventListener('click', () => setPalette(S.STD_PAL));

    // Layers
    dom.layers.addEventListener('click', (e) => {
      const eye = e.target.closest('[data-eye]');
      if (eye) {
        const l = Number(eye.dataset.eye);
        ps.doc.layers[l].visible = !ps.doc.layers[l].visible;
        changed();
        renderLayers();
        onionCache = new Map();
        dirtyAll();
        return;
      }
      const row = e.target.closest('[data-layer]');
      if (row) selectLayer(Number(row.dataset.layer));
    });
    dom.layers.addEventListener('dblclick', (e) => {
      const row = e.target.closest('[data-layer]');
      if (row && !e.target.closest('[data-eye]')) renameLayer(Number(row.dataset.layer));
    });
    dom.layers.addEventListener('keydown', (e) => {
      const row = e.target.closest('[data-layer]');
      if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectLayer(Number(row.dataset.layer)); }
    });
    for (const [id, op] of Object.entries({ psLayerAdd: 'add', psLayerDup: 'duplicate', psLayerDel: 'remove', psLayerUp: 'up', psLayerDown: 'down', psLayerMerge: 'merge' })) {
      $(`#${id}`).addEventListener('click', () => layerOps[op]());
    }

    // Frames
    dom.frames.addEventListener('click', (e) => {
      const b = e.target.closest('[data-frame]');
      if (b) { setPlaying(false); selectFrame(Number(b.dataset.frame)); }
    });
    for (const [id, op] of Object.entries({ psFrameAdd: 'add', psFrameDup: 'duplicate', psFrameDel: 'remove', psFrameLeft: 'left', psFrameRight: 'right' })) {
      $(`#${id}`).addEventListener('click', () => { setPlaying(false); frameOps[op](); });
    }
    dom.play.addEventListener('click', () => setPlaying(!ps.playing));
    dom.fps.addEventListener('change', () => {
      const v = clampInt(Number(dom.fps.value) || 8, 1, 60);
      if (v !== ps.doc.fps) { ps.doc.fps = v; changed(); }
      dom.fps.value = v;
      if (ps.playing) setPlaying(true);
    });

    // Drops: image files and library assets
    dom.stage.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dom.stage.classList.add('dragover'); }
    });
    dom.stage.addEventListener('dragleave', () => dom.stage.classList.remove('dragover'));
    dom.stage.addEventListener('drop', (e) => {
      dom.stage.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      if (/\.p8$/i.test(file.name)) importCartFile(file);
      else importImage(file);
    });
    S.bindAssetDrop(dom.stage, (a) => (a.kind === 'palette' ? applyPaletteColors(a.colors, a.name) : openAsset(a)));

    const endAlt = () => {
      if (!ps.altTool) return;
      const prev = ps.altTool;
      ps.altTool = null;
      if (ps.tool === 'picker') setTool(prev);
    };
    for (const type of ['keydown', 'keyup']) {
      document.addEventListener(type, (e) => {
        if (e.key === 'Control' && lastPointer && document.body.dataset.workspace === 'studio') updateCursor(lastPointer.clientX, lastPointer.clientY, type === 'keydown');
      });
    }
    document.addEventListener('keyup', (e) => {
      if (e.key === ' ') { ps.spaceDown = false; dom.stage.classList.remove('space'); }
      if (e.key === 'Alt' && ps.altTool) { e.preventDefault(); endAlt(); }
    });
    window.addEventListener('blur', () => { ps.spaceDown = false; dom.stage.classList.remove('space'); endAlt(); });
    document.addEventListener('paste', (e) => {
      if (document.body.dataset.workspace !== 'studio' || App.isTyping(e.target) || document.querySelector('dialog[open]')) return;
      e.preventDefault();
      pasteFromEvent(e);
    });

    document.addEventListener('p8:workspace', () => {
      if (document.body.dataset.workspace !== 'studio') { setPlaying(false); return; }
      requestDraw();
      if (!ps.viewed) { ps.viewed = true; requestAnimationFrame(zoomFit); }
    });
    window.addEventListener('beforeunload', () => saveSession());
  }

  // ------------------------------------------------------------------ //
  // Timeline toggle + full screen view                                 //
  // ------------------------------------------------------------------ //

  function setTimeline(on) {
    ps.timeline = on;
    $('main.layout-studio').classList.toggle('no-timeline', !on);
    dom.timelineBtn.setAttribute('aria-pressed', String(on));
    persistSettings();
    requestDraw();
  }

  let fullView = null; // {root, canvas, hint, zoom, panX, panY, drag, raf}

  function openFullView() {
    if (fullView) return;
    const canvas = el('canvas');
    const hint = el('div', { className: 'ps-fullview-hint', textContent: 'Drag to pan · wheel or + / − to zoom · 0 fit · 1 100% · Esc exits' });
    const root = el('div', { className: 'ps-fullview', attrs: { role: 'dialog', 'aria-label': 'Full screen view', tabindex: '-1' } }, canvas, hint);
    document.body.append(root);
    fullView = { root, canvas, hint, zoom: 1, panX: 0, panY: 0, drag: null, raf: 0 };
    fullFit();
    root.addEventListener('pointerdown', (e) => {
      try { root.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      fullView.drag = { x: e.clientX, y: e.clientY, px: fullView.panX, py: fullView.panY };
      root.classList.add('panning');
    });
    root.addEventListener('pointermove', (e) => {
      const g = fullView?.drag;
      if (!g) return;
      fullView.panX = g.px + e.clientX - g.x;
      fullView.panY = g.py + e.clientY - g.y;
    });
    const up = () => { if (fullView) { fullView.drag = null; root.classList.remove('panning'); } };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('wheel', (e) => { e.preventDefault(); fullZoom(e.deltaY < 0 ? 1 : -1, e.clientX, e.clientY); }, { passive: false });
    root.addEventListener('dblclick', closeFullView);
    root.focus();
    // real full screen when the browser allows it; leaving it (Esc) closes the view
    root.requestFullscreen?.().catch(() => { /* stays a full-window view */ });
    setTimeout(() => hint.classList.add('gone'), 2500);
    const loop = () => { if (!fullView) return; drawFullView(); fullView.raf = requestAnimationFrame(loop); };
    loop();
  }

  function closeFullView() {
    if (!fullView) return;
    cancelAnimationFrame(fullView.raf);
    fullView.root.remove();
    fullView = null;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    dom.canvas.focus({ preventScroll: true });
  }

  function fullFit() {
    const f = fullView;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const z = Math.min((W - 40) / ps.doc.w, (H - 40) / ps.doc.h);
    f.zoom = z >= 1 ? Math.floor(z) : z;
    f.panX = Math.round((W - ps.doc.w * f.zoom) / 2);
    f.panY = Math.round((H - ps.doc.h * f.zoom) / 2);
  }

  function fullZoom(dir, cx = window.innerWidth / 2, cy = window.innerHeight / 2, to = null) {
    const f = fullView;
    const z = to ?? (dir > 0 ? ZOOMS.find((v) => v > f.zoom + 1e-6) ?? ZOOMS[ZOOMS.length - 1] : [...ZOOMS].reverse().find((v) => v < f.zoom - 1e-6) ?? ZOOMS[0]);
    f.panX = Math.round(cx - ((cx - f.panX) * z) / f.zoom);
    f.panY = Math.round(cy - ((cy - f.panY) * z) / f.zoom);
    f.zoom = z;
  }

  function fullViewKey(e) {
    const k = e.key;
    if (k === 'Escape' || k === 'f' || k === 'F' || k === 'F8') { e.preventDefault(); closeFullView(); return; }
    if (k === '+' || k === '=') fullZoom(1);
    else if (k === '-') fullZoom(-1);
    else if (k === '0') fullFit();
    else if (k === '1') fullZoom(0, undefined, undefined, 1);
    else if (k === 'Enter') setPlaying(!ps.playing);
    else return;
    e.preventDefault();
  }

  function drawFullView() {
    const f = fullView;
    const c = f.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr);
    const h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(comp, f.panX, f.panY, ps.doc.w * f.zoom, ps.doc.h * f.zoom);
  }

  async function importCartFile(file) {
    const text = await file.text();
    const gfx = K.isCart(text) && K.gfxFromCart(text);
    if (!gfx) { showMessage('Import .p8', 'No sprite sheet (__gfx__) found in this cart.'); return; }
    if (!(await confirmDiscard(`Open the sprite sheet of "${file.name}"?`))) return;
    const d = K.newDoc(gfx.w, gfx.h);
    d.frames[0].cels[0] = gfx.pixels;
    d.layers[0].name = 'Sprite sheet';
    loadDoc(d, { name: file.name.replace(/\.p8$/i, ''), dirty: true });
  }

  // ------------------------------------------------------------------ //
  // Suite integration                                                  //
  // ------------------------------------------------------------------ //

  S.registerTool({
    ws: 'studio', name: 'Pixel Studio',
    desc: 'Pixel editor limited to PICO-8: 16 of 32 colors, fill patterns, layers, frames + onion skin, sprite sheet, .p8 and [gfx] clipboard.',
    color: '#29adff', tags: ['draw', 'sprites', 'animation'],
  });
  S.registerConsumer({
    id: 'studio-open', label: 'Pixel Studio', kinds: ['image'],
    accepts: (a) => (a.w <= K.MAX_SIDE && a.h <= K.MAX_SIDE ? true : `Pixel Studio supports up to ${K.MAX_SIDE}×${K.MAX_SIDE}.`),
    open: openAsset,
  });
  S.registerConsumer({
    id: 'studio-palette', label: 'Pixel Studio palette', kinds: ['palette'],
    open: (a) => { App.setWorkspace('studio'); applyPaletteColors(a.colors, a.name); },
  });

  S.registerPaletteSource({
    id: 'studio', label: 'Pixel Studio',
    get: () => (ps.doc ? { pal: ps.doc.pal.slice(), fades: ps.fades ? { dark: ps.fades.dark || null, bright: ps.fades.bright || null } : null, name: ps.name } : null),
  });

  // state access for tests (pixel -> client coordinates of a pixel center)
  window.P8StudioDebug = {
    state: () => ps,
    client: (x, y) => { const r = dom.canvas.getBoundingClientRect(); return { clientX: r.left + ps.panX + (x + 0.5) * ps.zoom, clientY: r.top + ps.panY + (y + 0.5) * ps.zoom }; },
    cel: () => cel(),
  };

  App.registerShortcuts('studio', onKey);
  App.registerActions({
    'ps-new': () => { App.setWorkspace('studio'); newDocument(); },
    'ps-open': openFromLibrary,
    'ps-import': () => importImage(),
    'ps-import-p8': importCart,
    'ps-save': () => saveToLibrary(),
    'ps-save-new': () => saveToLibrary({ asNew: true }),
    'ps-export-png': exportPng,
    'ps-export-p8': exportCart,
    'ps-write-p8': writeIntoCart,
    'ps-copy-gfx': copyGfx,
    'ps-paste': pasteFromMenu,
    'ps-sheet': framesToLibrarySheet,
    'ps-to-tiles': sendToTiles,
    'ps-to-preview': sendToPreview,
    'ps-undo': undo,
    'ps-redo': redo,
    'ps-cut': () => copySelection({ cut: true }),
    'ps-copy': () => copySelection(),
    'ps-select-all': selectAll,
    'ps-deselect': deselect,
    'ps-delete': deleteSelection,
    'ps-import-cart-file': ({ file }) => { App.setWorkspace('studio'); importCartFile(file); },
    'ps-full-view': () => { App.setWorkspace('studio'); openFullView(); },
    'ps-toggle-timeline': () => setTimeline(!ps.timeline),
    'ps-flip-h': () => transform('flipH'),
    'ps-flip-v': () => transform('flipV'),
    'ps-rotate': () => transform('rotate'),
    'ps-invert-sel': invertSelection,
    'ps-select-color': selectColor,
    'ps-brush-from-sel': brushFromSelection,
    'ps-brush-flip-h': () => flipBrush('h'),
    'ps-brush-flip-v': () => flipBrush('v'),
    'ps-outline': outlineDialog,
    'ps-replace-color': replaceColor,
    'ps-canvas-size': canvasSize,
    'ps-scale': scaleCanvas,
    'ps-canvas-flip-h': () => flipCanvas('flipH'),
    'ps-canvas-flip-v': () => flipCanvas('flipV'),
    'ps-canvas-rotate': rotateCanvas,
    'ps-flatten': () => layerOps.flatten(),
  });

  bind();
  setTool('pencil');
  setTimeline(ps.timeline);
  renderOptions();
  rebuildComposite();
  renderPalette();
  renderLayers();
  renderFrames();
  renderTitle();
  setZoom(ps.zoom);
  S.assets.ready.then(restoreSession);
})();

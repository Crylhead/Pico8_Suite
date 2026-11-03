// js/studio-core.js
// Pixel Studio logic (no DOM access): documents with layers and frames, raster
// primitives, PICO-8 fill patterns, [gfx] clipboard and .p8 cart reading/writing.

'use strict';

const P8Studio = (() => {
  const EMPTY = 255; // "no pixel" in a cel (shows the layers below / transparency)
  const MAX_SIDE = 1024;
  const SHEET = 128;
  const hex = '0123456789abcdef';

  /** Preview dimensions in CSS pixels; 0 (including legacy Auto) means Fit. */
  function previewSize(w, h, mode, viewportW, viewportH) {
    let scale = mode === 1 || mode === 2 ? mode : Math.min(viewportW / w, viewportH / h);
    if (!Number.isFinite(scale) || scale <= 0) return null; // hidden panel
    if (mode !== 1 && mode !== 2 && scale >= 1) scale = Math.floor(scale);
    return { w: Math.max(1, Math.floor(w * scale)), h: Math.max(1, Math.floor(h * scale)), scale };
  }

  // ------------------------------------------------------------------ //
  // Documents                                                          //
  // ------------------------------------------------------------------ //
  //
  // doc = { w, h, pal:[16 pico], transparent: slot|-1, fps,
  //         layers:[{name, visible}], frames:[{cels:[Uint8Array(w*h) per layer]}] }
  // layers[0] is the bottom layer.

  const blankCel = (w, h) => new Uint8Array(w * h).fill(EMPTY);

  function newDoc(w, h, { pal = null, transparent = 0, fps = 8 } = {}) {
    return {
      w, h,
      pal: pal ? pal.slice() : Array.from({ length: 16 }, (_, i) => i),
      transparent,
      fps,
      layers: [{ name: 'Layer 1', visible: true }],
      frames: [{ cels: [blankCel(w, h)] }],
    };
  }

  function cloneDoc(d) {
    return {
      ...d,
      pal: d.pal.slice(),
      layers: d.layers.map((l) => ({ ...l })),
      frames: d.frames.map((f) => ({ ...f, cels: f.cels.map((c) => c.slice()) })),
    };
  }

  /** Top-most visible pixel per position (EMPTY where all layers are empty). */
  function flatten(d, frame, { onlyVisible = true } = {}) {
    const n = d.w * d.h;
    const out = new Uint8Array(n).fill(EMPTY);
    const cels = d.frames[frame].cels;
    for (let l = 0; l < d.layers.length; l++) {
      if (onlyVisible && !d.layers[l].visible) continue;
      const c = cels[l];
      for (let i = 0; i < n; i++) if (c[i] !== EMPTY) out[i] = c[i];
    }
    return out;
  }

  /** Flattened slot indices (empty -> transparent color, or 0). */
  function flattenSlots(d, frame) {
    const out = flatten(d, frame);
    const t = d.transparent >= 0 ? d.transparent : 0;
    for (let i = 0; i < out.length; i++) if (out[i] === EMPTY) out[i] = t;
    return out;
  }

  /** Library image asset -> document (keeps layers/frames when the asset has them). */
  function docFromAsset(a) {
    if (a.doc && a.doc.w === a.w && a.doc.h === a.h) return cloneDoc({ ...a.doc, pal: a.pal, transparent: a.transparent });
    const d = newDoc(a.w, a.h, { pal: a.pal, transparent: a.transparent ?? 0 });
    d.frames[0].cels[0] = Uint8Array.from(a.pixels, (v) => v & 15);
    return d;
  }

  function resizeDoc(d, w, h, ax = 0, ay = 0) {
    const ox = Math.round((w - d.w) * ax);
    const oy = Math.round((h - d.h) * ay);
    const out = { ...cloneDoc(d), w, h };
    out.frames = d.frames.map((f) => ({ ...f, cels: f.cels.map((c) => blit(c, d.w, d.h, blankCel(w, h), w, h, ox, oy)) }));
    return out;
  }

  function scaleDoc(d, factor) {
    const w = d.w * factor;
    const h = d.h * factor;
    const out = { ...cloneDoc(d), w, h };
    out.frames = d.frames.map((f) => ({
      ...f,
      cels: f.cels.map((c) => {
        const o = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = c[Math.floor(y / factor) * d.w + Math.floor(x / factor)];
        return o;
      }),
    }));
    return out;
  }

  /** Copies src (sw×sh) into dst at (dx,dy), skipping EMPTY when transparent=true. Returns dst. */
  function blit(src, sw, sh, dst, dw, dh, dx, dy, transparent = false) {
    for (let y = 0; y < sh; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= dh) continue;
      for (let x = 0; x < sw; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= dw) continue;
        const v = src[y * sw + x];
        if (transparent && v === EMPTY) continue;
        dst[ty * dw + tx] = v;
      }
    }
    return dst;
  }

  function crop(src, sw, x0, y0, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(src.subarray((y0 + y) * sw + x0, (y0 + y) * sw + x0 + w), y * w);
    return out;
  }

  function flipH(a, w, h) {
    const o = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = a[y * w + (w - 1 - x)];
    return o;
  }

  function flipV(a, w, h) {
    const o = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) o.set(a.subarray((h - 1 - y) * w, (h - y) * w), y * w);
    return o;
  }

  /** Rotates 90° clockwise: returns {data, w, h} with swapped size. */
  function rotateCW(a, w, h) {
    const o = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + (h - 1 - y)] = a[y * w + x];
    return { data: o, w: h, h: w };
  }

  // ------------------------------------------------------------------ //
  // Raster primitives (call plot(x, y) per pixel)                       //
  // ------------------------------------------------------------------ //

  function line(x0, y0, x1, y1, plot) {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      plot(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  const norm = (x0, y0, x1, y1) => [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];

  function rect(x0, y0, x1, y1, filled, plot) {
    [x0, y0, x1, y1] = norm(x0, y0, x1, y1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (filled || y === y0 || y === y1 || x === x0 || x === x1) plot(x, y);
      }
    }
  }

  /** Ellipse inscribed in the box; outline = inside pixels with a 4-neighbour outside. */
  function ellipse(x0, y0, x1, y1, filled, plot) {
    [x0, y0, x1, y1] = norm(x0, y0, x1, y1);
    const cx = (x0 + x1 + 1) / 2;
    const cy = (y0 + y1 + 1) / 2;
    const rx = (x1 - x0 + 1) / 2;
    const ry = (y1 - y0 + 1) / 2;
    const inside = (x, y) => {
      if (x < x0 || x > x1 || y < y0 || y > y1) return false;
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      return nx * nx + ny * ny <= 1.0001;
    };
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!inside(x, y)) continue;
        if (filled || !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) plot(x, y);
      }
    }
  }

  /** 4-way flood fill region (contiguous) or all matching pixels: returns Uint32Array of indices. */
  function fillRegion(cel, w, h, x, y, contiguous = true) {
    const target = cel[y * w + x];
    if (!contiguous) {
      const out = [];
      for (let i = 0; i < cel.length; i++) if (cel[i] === target) out.push(i);
      return out;
    }
    const seen = new Uint8Array(w * h);
    const out = [];
    const stack = [y * w + x];
    seen[y * w + x] = 1;
    while (stack.length) {
      const i = stack.pop();
      out.push(i);
      const px = i % w;
      const py = (i - px) / w;
      if (px > 0 && !seen[i - 1] && cel[i - 1] === target) { seen[i - 1] = 1; stack.push(i - 1); }
      if (px < w - 1 && !seen[i + 1] && cel[i + 1] === target) { seen[i + 1] = 1; stack.push(i + 1); }
      if (py > 0 && !seen[i - w] && cel[i - w] === target) { seen[i - w] = 1; stack.push(i - w); }
      if (py < h - 1 && !seen[i + w] && cel[i + w] === target) { seen[i + w] = 1; stack.push(i + w); }
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // Fill patterns (fillp)                                              //
  // ------------------------------------------------------------------ //
  // Bit 15 is the top-left pixel of the 4×4 pattern, bit 0 the bottom-right
  // (same as PICO-8). Set bits use the secondary color (or stay transparent).

  const PATTERNS = [
    { name: 'Solid', value: 0x0000 },
    { name: 'Checker', value: 0x5a5a },
    { name: '25%', value: 0x8282 },
    { name: '75%', value: 0x7d7d },
    { name: '12.5%', value: 0x8020 },
    { name: 'H lines', value: 0xf0f0 },
    { name: 'V lines', value: 0xaaaa },
    { name: 'Diagonal', value: 0x8421 },
    { name: 'Diagonal 2', value: 0x1248 },
    { name: 'Grid', value: 0xf888 },
  ];

  const patternBit = (pattern, x, y) => (pattern >> (15 - (((y & 3) << 2) | (x & 3)))) & 1;
  const patternHex = (v) => `0x${v.toString(16).padStart(4, '0')}`;

  // ------------------------------------------------------------------ //
  // PICO-8 clipboard ([gfx]WWHH + one hex digit per pixel + [/gfx])     //
  // ------------------------------------------------------------------ //

  function toGfxClip(slots, w, h) {
    let s = `[gfx]${w.toString(16).padStart(2, '0')}${h.toString(16).padStart(2, '0')}`;
    for (let i = 0; i < w * h; i++) s += hex[slots[i] & 15];
    return `${s}[/gfx]`;
  }

  function parseGfxClip(text) {
    const m = /\[gfx\]([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]*)\[\/gfx\]/i.exec(text || '');
    if (!m) return null;
    const w = parseInt(m[1], 16) || 256;
    const h = parseInt(m[2], 16) || 256;
    const body = m[3];
    if (body.length < w * h) return null;
    const pixels = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) pixels[i] = parseInt(body[i], 16);
    return { w, h, pixels };
  }

  // ------------------------------------------------------------------ //
  // .p8 carts                                                          //
  // ------------------------------------------------------------------ //

  const SECTION_ORDER = ['__lua__', '__gfx__', '__label__', '__gff__', '__map__', '__sfx__', '__music__'];

  /** -> { head: [lines before the first section], sections: [{name, lines}] } */
  function parseCart(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const head = [];
    const sections = [];
    let cur = null;
    for (const line of lines) {
      if (/^__[a-z0-9]+__$/.test(line)) {
        cur = { name: line, lines: [] };
        sections.push(cur);
      } else if (cur) cur.lines.push(line);
      else head.push(line);
    }
    // drop trailing blank lines of each section (re-added on write)
    for (const s of sections) while (s.lines.length && s.lines[s.lines.length - 1] === '') s.lines.pop();
    return { head, sections };
  }

  function writeCart(cart) {
    const parts = [cart.head.join('\n')];
    for (const s of cart.sections) parts.push(`${s.name}\n${s.lines.join('\n')}`);
    return `${parts.join('\n')}\n`;
  }

  const isCart = (text) => /^pico-8 cartridge/.test(text);

  /** __gfx__ (or __label__) of a cart -> {w:128, h:rows, pixels}. */
  function gfxFromCart(text, section = '__gfx__') {
    const cart = parseCart(text);
    const s = cart.sections.find((x) => x.name === section);
    if (!s) return null;
    const rows = s.lines.filter((l) => /^[0-9a-v]+$/i.test(l)).slice(0, 128);
    if (!rows.length) return null;
    const h = rows.length;
    const pixels = new Uint8Array(SHEET * h);
    const base32 = section === '__label__';
    rows.forEach((r, y) => {
      for (let x = 0; x < SHEET; x++) {
        const v = parseInt(r[x] || '0', base32 ? 32 : 16);
        pixels[y * SHEET + x] = Number.isFinite(v) ? v & 15 : 0;
      }
    });
    return { w: SHEET, h, pixels };
  }

  /** Writes w×h slots into the cart's __gfx__ at (dx,dy); creates the section when missing. */
  function writeGfxIntoCart(text, slots, w, h, dx, dy) {
    const cart = parseCart(text);
    let s = cart.sections.find((x) => x.name === '__gfx__');
    if (!s) {
      s = { name: '__gfx__', lines: [] };
      const at = cart.sections.findIndex((x) => SECTION_ORDER.indexOf(x.name) > 1);
      if (at < 0) cart.sections.push(s);
      else cart.sections.splice(at, 0, s);
    }
    const rows = s.lines.filter((l) => /^[0-9a-f]*$/i.test(l)).map((l) => l.padEnd(SHEET, '0').slice(0, SHEET).split(''));
    const need = Math.min(SHEET, dy + h);
    while (rows.length < need) rows.push('0'.repeat(SHEET).split(''));
    for (let y = 0; y < h; y++) {
      const ty = dy + y;
      if (ty < 0 || ty >= SHEET) continue;
      for (let x = 0; x < w; x++) {
        const tx = dx + x;
        if (tx < 0 || tx >= SHEET) continue;
        rows[ty][tx] = hex[slots[y * w + x] & 15];
      }
    }
    s.lines = rows.map((r) => r.join(''));
    return writeCart(cart);
  }

  /** pal() calls for a screen palette that differs from the default. */
  function palCode(pal, indent = '') {
    const out = [];
    pal.forEach((p, i) => { if (p !== i) out.push(`${indent}pal(${i},${p},1)`); });
    return out;
  }

  /** New cart with the image (≤128×128) at (dx,dy) of the sprite sheet + a small viewer. */
  function buildGfxCart({ slots, w, h, dx = 0, dy = 0, pal, transparent, name, anim = null }) {
    const sprN = (dy / 8) * 16 + dx / 8;
    const aligned = dx % 8 === 0 && dy % 8 === 0 && w % 8 === 0 && h % 8 === 0;
    const lua = [
      `-- ${name || 'image'}: ${w}x${h} px at sheet ${dx},${dy}` + (aligned ? ` (sprite ${sprN}, ${w / 8}x${h / 8} sprites)` : ''),
      '-- made with the pico-8 dev suite (pixel studio)',
      '',
    ];
    if (anim) {
      lua.push(`anim={${anim.frames.join(',')}}`, `fw,fh=${anim.fw},${anim.fh}`, `fps=${anim.fps}`, '');
    }
    lua.push('function _update() end', '', 'function _draw()', ' cls(1)');
    lua.push(...palCode(pal, ' '));
    if (transparent >= 0 && transparent !== 0) lua.push(' palt(0,false)', ` palt(${transparent},true)`);
    if (transparent < 0) lua.push(' palt(0,false)');
    if (anim) {
      lua.push(' local f=anim[flr(t()*fps)%#anim+1]');
      lua.push(anim.spr ? ` spr(f,64-fw*4,64-fh*4,fw,fh)` : ` sspr(f%16*8,f\\16*8,${anim.pw},${anim.ph},64-${anim.pw}/2,64-${anim.ph}/2)`);
    } else {
      const x = Math.max(0, Math.floor((128 - w) / 2));
      const y = Math.max(0, Math.floor((128 - h) / 2));
      lua.push(aligned ? ` spr(${sprN},${x},${y},${w / 8},${h / 8})` : ` sspr(${dx},${dy},${w},${h},${x},${y})`);
    }
    lua.push('end');
    const base = `pico-8 cartridge // http://www.pico-8.com\nversion 41\n__lua__\n${lua.join('\n')}\n`;
    return writeGfxIntoCart(base, slots, w, h, dx, dy);
  }

  /**
   * Lays out frames (fw×fh) on a 128-wide sheet starting at sprite `start`.
   * Returns {w:128, h, pixels, positions:[{x,y,spr}], spr: whether spr() can draw them} or {error}.
   */
  function framesToSheet(frames, fw, fh, start = 0) {
    if (fw > SHEET || fh > SHEET) return { error: 'Frames must be at most 128×128 to fit on the sprite sheet.' };
    const aligned = fw % 8 === 0 && fh % 8 === 0;
    const cellW = aligned ? fw : Math.ceil(fw / 8) * 8;
    const cellH = aligned ? fh : Math.ceil(fh / 8) * 8;
    const cols = Math.floor(SHEET / cellW);
    const sx = (start % 16) * 8;
    const sy = Math.floor(start / 16) * 8;
    const positions = [];
    let col = Math.ceil(sx / cellW);
    let y = sy;
    for (let i = 0; i < frames.length; i++) {
      if (col >= cols) { col = 0; y += cellH; }
      positions.push({ x: col * cellW, y, spr: (y / 8) * 16 + (col * cellW) / 8 });
      col++;
    }
    const h = positions.length ? positions[positions.length - 1].y + cellH : 0;
    if (h > SHEET) return { error: `${frames.length} frames of ${fw}×${fh} need ${h} rows, but the sprite sheet has 128.` };
    const pixels = new Uint8Array(SHEET * h);
    frames.forEach((f, i) => blit(f, fw, fh, pixels, SHEET, h, positions[i].x, positions[i].y));
    return { w: SHEET, h, pixels, positions, spr: aligned };
  }

  // ------------------------------------------------------------------ //
  // Transform: scale / rotate a pixel block (Aseprite style)           //
  // ------------------------------------------------------------------ //

  /** Scale2x (EPX / AdvMAME2x): doubles a block, keeping diagonals sharp. EMPTY is a color. */
  function scale2x(a, w, h) {
    const W = w * 2;
    const o = new Uint8Array(W * h * 2);
    const at = (x, y) => a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = a[y * w + x];
        const A = at(x, y - 1);
        const B = at(x + 1, y);
        const C = at(x - 1, y);
        const D = at(x, y + 1);
        let e0 = p, e1 = p, e2 = p, e3 = p;
        if (C === A && C !== D && A !== B) e0 = A;
        if (A === B && A !== C && B !== D) e1 = B;
        if (D === C && D !== B && C !== A) e2 = C;
        if (B === D && B !== A && D !== C) e3 = D;
        const i = y * 2 * W + x * 2;
        o[i] = e0; o[i + 1] = e1; o[i + W] = e2; o[i + W + 1] = e3;
      }
    }
    return o;
  }

  /**
   * Scales (sx, sy; negative = flip), shears (kx: x += kx*y, ky: y += ky*x) and rotates (angle in
   * degrees, clockwise) a w×h block around its center. algo 'rotsprite': Scale2x three times before sampling (Aseprite's
   * RotSprite), so rotated pixel art keeps clean edges; 'fast': nearest neighbour.
   * -> {data, w, h, dx, dy}: the new block and its top-left relative to the old top-left.
   */
  function transformBlock(src, w, h, { sx = 1, sy = 1, angle = 0, kx = 0, ky = 0, algo = 'fast' } = {}) {
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // local point -> scale -> shear (x += kx*y, y += ky*x) -> rotate
    const fwd = (x, y) => {
      const a = x * sx;
      const b = y * sy;
      const c = a + kx * b;
      const d = b + ky * a;
      return [c * cos - d * sin, c * sin + d * cos];
    };
    // bounding box of the transformed block
    let ex = 0;
    let ey = 0;
    for (const [cx, cy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
      const [x, y] = fwd(cx, cy);
      ex = Math.max(ex, Math.abs(x));
      ey = Math.max(ey, Math.abs(y));
    }
    const W = Math.max(1, Math.round(ex * 2));
    const H = Math.max(1, Math.round(ey * 2));
    const det = 1 - kx * ky || 1e-9;
    const right = Math.abs(((angle % 90) + 90) % 90) < 1e-9 && !kx && !ky;
    let s = src;
    let f = 1;
    if (algo === 'rotsprite' && !right) { s = scale2x(scale2x(scale2x(src, w, h), w * 2, h * 2), w * 4, h * 4); f = 8; }
    const sw = w * f;
    const out = new Uint8Array(W * H).fill(EMPTY);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // dest pixel center -> unrotate -> unshear -> unscale -> source
        const px = x + 0.5 - W / 2;
        const py = y + 0.5 - H / 2;
        const qx = px * cos + py * sin;
        const qy = -px * sin + py * cos;
        const ux = (qx - kx * qy) / det / sx;
        const uy = (qy - ky * qx) / det / sy;
        const u = Math.floor((ux + w / 2) * f);
        const v = Math.floor((uy + h / 2) * f);
        if (u >= 0 && v >= 0 && u < sw && v < h * f) out[y * W + x] = s[v * sw + u];
      }
    }
    return { data: out, w: W, h: H, dx: Math.round(w / 2 - W / 2), dy: Math.round(h / 2 - H / 2) };
  }

  // ------------------------------------------------------------------ //
  // Selection masks (doc-sized Uint8Array, 1 = selected)               //
  // ------------------------------------------------------------------ //

  /** Lasso: the polygon through `pts` (pixel coordinates), filled (even-odd) plus its outline. */
  function polygonMask(pts, w, h) {
    const m = new Uint8Array(w * h);
    if (!pts.length) return m;
    for (let y = 0; y < h; y++) {
      const cy = y + 0.5;
      const xs = [];
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i];
        const [bx, by] = pts[(i + 1) % pts.length];
        const y0 = ay + 0.5;
        const y1 = by + 0.5;
        if ((y0 <= cy && y1 > cy) || (y1 <= cy && y0 > cy)) xs.push(ax + 0.5 + ((cy - y0) / (y1 - y0)) * (bx - ax));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) m[y * w + x] = 1;
      }
    }
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      line(ax, ay, bx, by, (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) m[y * w + x] = 1; });
    }
    return m;
  }

  /** Magic wand: pixels with the value at (x,y); contiguous (4 neighbours) or the whole cel. */
  function wandMask(cel, w, h, x, y, contiguous = true) {
    const m = new Uint8Array(w * h);
    const v = cel[y * w + x];
    if (!contiguous) { for (let i = 0; i < cel.length; i++) if (cel[i] === v) m[i] = 1; return m; }
    const stack = [y * w + x];
    m[y * w + x] = 1;
    while (stack.length) {
      const i = stack.pop();
      const px = i % w;
      const py = (i - px) / w;
      const nb = [px > 0 ? i - 1 : -1, px < w - 1 ? i + 1 : -1, py > 0 ? i - w : -1, py < h - 1 ? i + w : -1];
      for (const j of nb) if (j >= 0 && !m[j] && cel[j] === v) { m[j] = 1; stack.push(j); }
    }
    return m;
  }

  /** mask -> bounding box {x, y, w, h} or null */
  function maskBox(m, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** combine selection masks: 'replace' | 'add' | 'subtract' | 'intersect' */
  function combineMask(mode, a, b) {
    if (mode === 'replace' || !a) return b;
    const o = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) o[i] = mode === 'add' ? a[i] | b[i] : mode === 'subtract' ? a[i] & ~b[i] & 1 : a[i] & b[i];
    return o;
  }

  // ------------------------------------------------------------------ //
  // Effects                                                            //
  // ------------------------------------------------------------------ //

  /**
   * Outline: every empty pixel next to a filled one gets `color` (4 neighbours, or 8 with
   * `diagonal`). The block grows by one pixel on every side. -> {data, w, h} (top-left -1,-1)
   */
  function outline(a, w, h, color, diagonal = false, isEmpty = (v) => v === EMPTY) {
    const W = w + 2;
    const H = h + 2;
    const o = new Uint8Array(W * H).fill(EMPTY);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[(y + 1) * W + x + 1] = a[y * w + x];
    const filled = (x, y) => x >= 1 && y >= 1 && x <= w && y <= h && !isEmpty(a[(y - 1) * w + (x - 1)]);
    const out = o.slice();
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (filled(x, y)) continue;
        const n4 = filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1);
        const n8 = diagonal && (filled(x - 1, y - 1) || filled(x + 1, y - 1) || filled(x - 1, y + 1) || filled(x + 1, y + 1));
        if (n4 || n8) out[y * W + x] = color;
      }
    }
    return { data: out, w: W, h: H };
  }

  // ------------------------------------------------------------------ //
  // Undo / redo history                                                //
  // ------------------------------------------------------------------ //
  //
  // Entries are { kind:'px', before, after, ... } pixel patches or { kind:'doc', snapshot, ... }
  // whole-document snapshots; the history only needs their size. One retention policy covers
  // both stacks: at most `limit` entries and `maxBytes` bytes across undo + redo combined.
  // When over a limit, the entry farthest from the current state (oldest undo or deepest redo)
  // is discarded first. The entry just recorded, undone or redone is never discarded, so a
  // single entry larger than `maxBytes` is kept on its own and everything else is dropped.

  const HISTORY_LIMIT = 200;
  const HISTORY_BYTES = 160 * 1024 * 1024;

  function historyEntryBytes(e) {
    if (e.kind === 'px') return e.before.byteLength + e.after.byteLength;
    let n = 0;
    for (const f of e.snapshot.frames) for (const c of f.cels) n += c.byteLength;
    return n;
  }

  function createHistory({ limit = HISTORY_LIMIT, maxBytes = HISTORY_BYTES, sizeOf = historyEntryBytes } = {}) {
    const undo = [];
    const redo = [];
    let bytes = 0;
    const sizes = new WeakMap();
    const size = (e) => {
      let n = sizes.get(e);
      if (n === undefined) sizes.set(e, (n = sizeOf(e)));
      return n;
    };
    const add = (stack, e) => {
      stack.push(e);
      bytes += size(e);
    };
    const take = (stack, i) => {
      const [e] = stack.splice(i, 1);
      bytes -= size(e);
      return e;
    };
    // Drops far entries until both limits hold; `keep` (the newest entry) always survives.
    function trim(keep) {
      while (undo.length + redo.length > 1 && (undo.length + redo.length > limit || bytes > maxBytes)) {
        const fromUndo = undo.length && undo[0] !== keep && (undo.length >= redo.length || redo[0] === keep);
        take(fromUndo ? undo : redo, 0);
      }
    }
    function step(from, to, apply) {
      const e = from.pop();
      if (!e) return null;
      bytes -= size(e);
      const r = apply(e);
      add(to, r);
      trim(r);
      return r;
    }
    return {
      /** Records a new edit: clears redo, then applies the retention policy. */
      record(e) {
        while (redo.length) take(redo, redo.length - 1);
        add(undo, e);
        trim(e);
      },
      /** apply(entry) restores the entry and returns the inverse entry for the other stack. */
      undo: (apply) => step(undo, redo, apply),
      redo: (apply) => step(redo, undo, apply),
      clear() {
        undo.length = 0;
        redo.length = 0;
        bytes = 0;
      },
      get undoCount() { return undo.length; },
      get redoCount() { return redo.length; },
      get bytes() { return bytes; },
      limit, maxBytes,
    };
  }

  return {
    EMPTY, MAX_SIDE, SHEET, previewSize,
    HISTORY_LIMIT, HISTORY_BYTES, historyEntryBytes, createHistory,
    blankCel, newDoc, cloneDoc, flatten, flattenSlots, docFromAsset, resizeDoc, scaleDoc, blit, crop, flipH, flipV, rotateCW,
    line, rect, ellipse, fillRegion,
    scale2x, transformBlock, polygonMask, wandMask, maskBox, combineMask, outline,
    PATTERNS, patternBit, patternHex,
    toGfxClip, parseGfxClip,
    parseCart, writeCart, isCart, gfxFromCart, writeGfxIntoCart, palCode, buildGfxCart, framesToSheet,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Studio;

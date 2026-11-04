// js/map-core.js
// Map Editor model: PICO-8 style tile maps (1 byte per cell) drawn with a 128-pixel-wide
// sprite sheet, editing operations, and .p8 reading / writing. No DOM; runs in Node for tests.
//
// A cart's map is 128×32 cells in __map__ (0x2000). Rows 32–63 live in the lower half of the
// sprite sheet (0x1000–0x1fff, sprites 128–255), so a 128×64 map costs those sprites.
// Bigger maps (up to 256×256) are raw bytes for data carts (Cart Builder).

'use strict';

const P8Map = (() => {
  const SHEET = 128;          // sprite sheet width in pixels
  const TILE = 8;
  const MAX_SIDE = 256;       // cells per side
  const CART_W = 128;         // __map__ width
  const CART_H = 32;          // rows in __map__
  const SHARED_H = 64;        // rows when the shared sprite area is used as well
  const hex = '0123456789abcdef';
  const h2 = (b) => hex[(b >> 4) & 15] + hex[b & 15];

  // ------------------------------------------------------------------ //
  // Model                                                              //
  // ------------------------------------------------------------------ //

  /** { w, h, cells: Uint8Array(w*h) } */
  function newMap(w = CART_W, h = CART_H, fill = 0) {
    const cells = new Uint8Array(w * h);
    if (fill) cells.fill(fill);
    return { w, h, cells };
  }

  const cloneMap = (m) => ({ w: m.w, h: m.h, cells: m.cells.slice() });

  /** Resizes keeping the top-left corner; new cells get `fill`. */
  function resizeMap(m, w, h, fill = 0) {
    const out = newMap(w, h, fill);
    for (let y = 0; y < Math.min(h, m.h); y++) out.cells.set(m.cells.subarray(y * m.w, y * m.w + Math.min(w, m.w)), y * w);
    return out;
  }

  const inside = (m, x, y) => x >= 0 && y >= 0 && x < m.w && y < m.h;

  /**
   * A stamp is a block of tiles {w, h, cells} (1×1 for a single tile). Painting with it repeats
   * the block from an origin, so dragging keeps the pattern aligned like PICO-8's map editor.
   */
  const stampAt = (stamp, ox, oy, x, y) => stamp.cells[(((y - oy) % stamp.h) + stamp.h) % stamp.h * stamp.w + ((((x - ox) % stamp.w) + stamp.w) % stamp.w)];

  /** Paints the stamp with its top-left cell at (x,y). Returns true when a cell changed. */
  function paintStamp(m, stamp, x, y) {
    let changed = false;
    for (let sy = 0; sy < stamp.h; sy++) {
      for (let sx = 0; sx < stamp.w; sx++) {
        const tx = x + sx;
        const ty = y + sy;
        if (!inside(m, tx, ty)) continue;
        const v = stamp.cells[sy * stamp.w + sx];
        if (m.cells[ty * m.w + tx] !== v) { m.cells[ty * m.w + tx] = v; changed = true; }
      }
    }
    return changed;
  }

  /** Fills the rectangle (inclusive corners, any order) with the stamp pattern, aligned to the first corner. */
  function fillRect(m, stamp, x0, y0, x1, y1) {
    const ax = Math.max(0, Math.min(x0, x1));
    const bx = Math.min(m.w - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1));
    const by = Math.min(m.h - 1, Math.max(y0, y1));
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) m.cells[y * m.w + x] = stampAt(stamp, x0, y0, x, y);
  }

  /** 4-connected flood fill of the cells that hold the start cell's tile, with the stamp pattern. */
  function floodFill(m, stamp, x, y) {
    if (!inside(m, x, y)) return false;
    const target = m.cells[y * m.w + x];
    if (stamp.w === 1 && stamp.h === 1 && stamp.cells[0] === target) return false;
    const seen = new Uint8Array(m.w * m.h);
    const stack = [y * m.w + x];
    seen[stack[0]] = 1;
    while (stack.length) {
      const i = stack.pop();
      const cx = i % m.w;
      const cy = (i - cx) / m.w;
      m.cells[i] = stampAt(stamp, x, y, cx, cy);
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
        if (!inside(m, nx, ny)) continue;
        const j = ny * m.w + nx;
        if (!seen[j] && m.cells[j] === target) { seen[j] = 1; stack.push(j); }
      }
    }
    return true;
  }

  /** Cells of a rectangle as a stamp (clipped to the map). */
  function copyRect(m, x, y, w, h) {
    const out = newMap(w, h);
    for (let sy = 0; sy < h; sy++) for (let sx = 0; sx < w; sx++) if (inside(m, x + sx, y + sy)) out.cells[sy * w + sx] = m.cells[(y + sy) * m.w + x + sx];
    return out;
  }

  /** Tiles of the sprite sheet block (sprite n at the top-left, w×h sprites) as a stamp. */
  function sheetStamp(n, w = 1, h = 1) {
    const out = newMap(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.cells[y * w + x] = (n + y * 16 + x) & 255;
    return out;
  }

  /** Every tile number used by the map -> count. */
  function usage(m) {
    const n = new Uint32Array(256);
    for (const v of m.cells) n[v]++;
    return n;
  }

  /** Uses sprites 128–255 (needed when the map takes rows 32–63 of a cart). */
  const usesUpperSprites = (m) => m.cells.some((v) => v >= 128);

  /** 'cart' (__map__ only) | 'shared' (rows 32–63 in the sprite sheet) | 'data' (bigger: data cart bytes) */
  function cartFit(m) {
    if (m.w <= CART_W && m.h <= CART_H) return 'cart';
    if (m.w <= CART_W && m.h <= SHARED_H) return 'shared';
    return 'data';
  }

  // ------------------------------------------------------------------ //
  // Bytes                                                              //
  // ------------------------------------------------------------------ //

  /** Row-major map bytes: the `.map` part of a `tiles` asset (identical to __map__ at width 128). */
  const mapBytes = (m) => m.cells.slice();

  /**
   * #184: a sheet is blank when every pixel has the same palette slot (any single color, not only 0):
   * its tiles all look alike, so painting shows no visible change. An empty sheet is blank too.
   */
  function isSheetBlank(pixels) {
    for (let i = 1; i < pixels.length; i++) if (pixels[i] !== pixels[0]) return false;
    return true;
  }

  /** Sheet pixels (128 wide, 4-bit slots) -> PICO-8 memory bytes (low nibble = left pixel). */
  function sheetBytes(pixels, h = pixels.length / SHEET) {
    const out = new Uint8Array((SHEET >> 1) * h);
    for (let i = 0; i < out.length; i++) out[i] = (pixels[i * 2] & 15) | ((pixels[i * 2 + 1] & 15) << 4);
    return out;
  }

  /** Map as Lua hex string(s): one string, read back with `tonum("0x"..sub(s,i*2+1,i*2+2))` or poke loops. */
  function hexString(m) {
    let s = '';
    for (const v of m.cells) s += h2(v);
    return s;
  }

  // ------------------------------------------------------------------ //
  // .p8 carts                                                          //
  // ------------------------------------------------------------------ //

  const SECTION_ORDER = ['__lua__', '__gfx__', '__label__', '__gff__', '__map__', '__sfx__', '__music__'];

  function parseCart(text) {
    const head = [];
    const sections = [];
    let cur = null;
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
      if (/^__[a-z0-9]+__$/.test(line)) { cur = { name: line, lines: [] }; sections.push(cur); } else if (cur) cur.lines.push(line); else head.push(line);
    }
    for (const s of sections) while (s.lines.length && s.lines[s.lines.length - 1] === '') s.lines.pop();
    return { head, sections };
  }

  const writeCart = (cart) => `${[cart.head.join('\n'), ...cart.sections.map((s) => `${s.name}\n${s.lines.join('\n')}`)].join('\n')}\n`;

  const isCart = (text) => /^pico-8 cartridge/.test(text);

  function section(cart, name, create = false) {
    let s = cart.sections.find((x) => x.name === name);
    if (!s && create) {
      s = { name, lines: [] };
      const rank = SECTION_ORDER.indexOf(name);
      const at = cart.sections.findIndex((x) => SECTION_ORDER.indexOf(x.name) > rank);
      if (at < 0) cart.sections.push(s); else cart.sections.splice(at, 0, s);
    }
    return s || null;
  }

  const hexRows = (s, n, len) => {
    const rows = (s ? s.lines : []).filter((l) => /^[0-9a-f]*$/i.test(l)).slice(0, n).map((l) => l.toLowerCase().padEnd(len, '0').slice(0, len));
    while (rows.length < n) rows.push('0'.repeat(len));
    return rows;
  };

  /**
   * .p8 text -> { sheet: Uint8Array(128*128) slots, map: 128×32 cells, lower: 128×32 cells read from
   * the shared sprite rows (what PICO-8's map shows at rows 32–63), lowerUsed, hasMap, hasGfx, flags }.
   */
  function readCart(text) {
    const cart = parseCart(text);
    const gfxS = section(cart, '__gfx__');
    const mapS = section(cart, '__map__');
    const gff = hexRows(section(cart, '__gff__'), 2, 256).join('');
    const gfx = hexRows(gfxS, 128, SHEET);
    const sheet = new Uint8Array(SHEET * 128);
    gfx.forEach((r, y) => { for (let x = 0; x < SHEET; x++) sheet[y * SHEET + x] = parseInt(r[x], 16); });
    const map = newMap(CART_W, CART_H);
    hexRows(mapS, CART_H, 256).forEach((r, y) => { for (let x = 0; x < CART_W; x++) map.cells[y * CART_W + x] = parseInt(r.substr(x * 2, 2), 16); });
    // map row 32+k = gfx bytes 0x1000 + k*128: two sheet rows (64 + 2k, 65 + 2k), low nibble first
    const lower = newMap(CART_W, CART_H);
    let lowerUsed = false;
    for (let y = 0; y < CART_H; y++) {
      for (let x = 0; x < CART_W; x++) {
        const px = (x * 2) % SHEET;
        const py = 64 + y * 2 + (x >= 64 ? 1 : 0);
        const v = sheet[py * SHEET + px] | (sheet[py * SHEET + px + 1] << 4);
        lower.cells[y * CART_W + x] = v;
        if (v) lowerUsed = true;
      }
    }
    const flags = new Uint8Array(256);
    for (let i = 0; i < 256; i++) flags[i] = parseInt(gff.substr(i * 2, 2), 16);
    return { sheet, map, lower, lowerUsed, hasMap: Boolean(mapS), hasGfx: Boolean(gfxS), flags };
  }

  /** 128×64 map from a cart's __map__ plus its shared sprite rows. */
  function joinLower(top, lower) {
    const m = newMap(CART_W, SHARED_H);
    m.cells.set(top.cells, 0);
    m.cells.set(lower.cells, CART_W * CART_H);
    return m;
  }

  /**
   * Writes the map (fit 'cart' or 'shared') into a .p8 text, keeping every other section.
   * sheet (optional): 128-wide slot pixels written to __gfx__ first (rows the map's shared part
   * overwrites are written over again). Returns the new text.
   */
  function writeIntoCart(text, m, { sheet = null } = {}) {
    const fit = cartFit(m);
    if (fit === 'data') throw new Error(`A ${m.w}×${m.h} map does not fit a cart's map memory (at most 128×64).`);
    const cart = parseCart(text);
    const full = resizeMap(m, CART_W, fit === 'shared' ? SHARED_H : CART_H);

    const mapS = section(cart, '__map__', true);
    const rows = [];
    for (let y = 0; y < CART_H; y++) {
      let r = '';
      for (let x = 0; x < CART_W; x++) r += h2(full.cells[y * CART_W + x]);
      rows.push(r);
    }
    while (rows.length && /^0+$/.test(rows[rows.length - 1])) rows.pop();
    mapS.lines = rows;

    if (sheet || fit === 'shared') {
      const gfxS = section(cart, '__gfx__', true);
      const g = hexRows(gfxS, 128, SHEET).map((r) => r.split(''));
      if (sheet) {
        const sh = Math.min(128, sheet.length / SHEET);
        for (let y = 0; y < sh; y++) for (let x = 0; x < SHEET; x++) g[y][x] = hex[sheet[y * SHEET + x] & 15];
      }
      if (fit === 'shared') {
        for (let y = 0; y < CART_H; y++) {
          for (let x = 0; x < CART_W; x++) {
            const v = full.cells[(CART_H + y) * CART_W + x];
            const px = (x * 2) % SHEET;
            const py = 64 + y * 2 + (x >= 64 ? 1 : 0);
            g[py][px] = hex[v & 15];
            g[py][px + 1] = hex[v >> 4];
          }
        }
      }
      const lines = g.map((r) => r.join(''));
      while (lines.length && /^0+$/.test(lines[lines.length - 1])) lines.pop();
      gfxS.lines = lines;
    }
    return writeCart(cart);
  }

  /** pal() lines for a screen palette that differs from the standard one. */
  function palCode(pal, indent = ' ') {
    const out = [];
    (pal || []).forEach((p, i) => { if (p !== i) out.push(`${indent}pal(${i},${p},1)`); });
    return out;
  }

  /** New cart: sprite sheet + map + a viewer (arrow keys scroll). */
  function buildCart({ m, sheet, pal = null, name = 'map' }) {
    const fit = cartFit(m);
    const lua = [
      `-- ${name}: ${m.w}x${m.h} map${fit === 'shared' ? ' (rows 32+ use sprites 128-255 memory)' : ''}`,
      '-- made with the pico-8 dev suite (map editor)',
      '-- arrow keys: scroll',
      '',
      'cx,cy=0,0',
      '',
      'function _update()',
      ' if btn(0) then cx-=2 end',
      ' if btn(1) then cx+=2 end',
      ' if btn(2) then cy-=2 end',
      ' if btn(3) then cy+=2 end',
      ` cx=mid(0,cx,${Math.max(0, m.w * TILE - 128)})`,
      ` cy=mid(0,cy,${Math.max(0, m.h * TILE - 128)})`,
      'end',
      '',
      'function _draw()',
      ' cls()',
      ...palCode(pal),
      ' camera(cx,cy)',
      ` map(0,0,0,0,${m.w},${m.h})`,
      ' camera()',
      'end',
    ];
    const text = `pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n${lua.join('\n')}\n`;
    return writeIntoCart(text, m, { sheet });
  }

  return {
    SHEET, TILE, MAX_SIDE, CART_W, CART_H, SHARED_H,
    newMap, cloneMap, resizeMap, inside, paintStamp, fillRect, floodFill, copyRect, sheetStamp, usage, usesUpperSprites, cartFit,
    mapBytes, sheetBytes, hexString, isSheetBlank,
    parseCart, writeCart, isCart, readCart, joinLower, writeIntoCart, palCode, buildCart,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Map;

// js/tiles-core.js
// Pure logic for the Tile Maker workspace (no DOM access).
// Ported from tilemaker/core/*.py. Images are {w, h, rgb: Uint8Array(w*h*3)},
// tiles are Uint8Array(8*8*3) in row-major RGB order.

'use strict';

const P8Tiles = (() => {
  const { rgbOf, lum709, zlibCompress } = P8;

  const TILE = 8;
  const TILE_BYTES = TILE * TILE * 3;
  const VRAM_TILE_BUDGET = 256;
  const MAX_SPRITES = 256;
  const MAX_LARGE_MAP_CELLS = 8192;
  const THRESHOLD_MAX = 100;
  const CACHE_SIZE = 20;

  const fround = Math.fround;

  // PICO-8 base colors sorted by BT.709 brightness (greyscale_converter.PICO8_GRAYSCALE_PALETTE)
  const PICO8_LEVEL_ORDER = Array.from({ length: 16 }, (_, i) => i)
    .sort((a, b) => lum709(rgbOf(a)) - lum709(rgbOf(b)));
  const PICO8_LEVEL_RGB = PICO8_LEVEL_ORDER.map(rgbOf);
  const PICO8_STD_RGB = Array.from({ length: 16 }, (_, i) => rgbOf(i));

  // ------------------------------------------------------------------ //
  // Images                                                             //
  // ------------------------------------------------------------------ //

  function fromImageData(imageData) {
    const { width: w, height: h, data } = imageData;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
      rgb[i] = data[o]; rgb[i + 1] = data[o + 1]; rgb[i + 2] = data[o + 2];
    }
    return { w, h, rgb };
  }

  function toImageData(img) {
    const out = new ImageData(img.w, img.h);
    const d = out.data;
    for (let i = 0, o = 0; i < img.rgb.length; i += 3, o += 4) {
      d[o] = img.rgb[i]; d[o + 1] = img.rgb[i + 1]; d[o + 2] = img.rgb[i + 2]; d[o + 3] = 255;
    }
    return out;
  }

  const grayOf = (r, g, b) => Math.trunc(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const levelOf = (gray) => Math.max(0, Math.min(15, Math.trunc((gray / 255.0) * 15)));

  /**
   * greyscale_converter.convert_to_pico8_grayscale, generalised to any 16-level color ramp.
   * levelRgb[level] = color used for brightness level 0..15.
   */
  function convertByLevels(img, levelRgb, dither) {
    const { w, h } = img;
    const src = img.rgb;
    const n = w * h;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) gray[i] = grayOf(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);

    const levels = new Uint8Array(n);
    if (dither) {
      const levelGray = levelRgb.map(([r, g, b]) => grayOf(r, g, b));
      const add = (i, err, num) => { gray[i] = fround(gray[i] + fround(fround(err * num) / 16)); };
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const old = Math.max(0, Math.min(255, gray[i]));
          const level = levelOf(Math.trunc(old));
          levels[i] = level;
          const err = fround(old - levelGray[level]);
          if (x + 1 < w) add(i + 1, err, 7);
          if (y + 1 < h) {
            if (x > 0) add(i + w - 1, err, 3);
            add(i + w, err, 5);
            if (x + 1 < w) add(i + w + 1, err, 1);
          }
        }
      }
    } else {
      for (let i = 0; i < n; i++) levels[i] = levelOf(Math.max(0, Math.min(255, Math.trunc(gray[i]))));
    }

    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) rgb.set(levelRgb[levels[i]], i * 3);
    return { w, h, rgb };
  }

  function nearestRgbIndex(r, g, b, paletteRgb) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < paletteRgb.length; i++) {
      const p = paletteRgb[i];
      const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  /** Map every pixel to the nearest palette color. */
  function convertNearest(img, paletteRgb) {
    const rgb = new Uint8Array(img.rgb.length);
    const cache = new Map();
    for (let i = 0; i < rgb.length; i += 3) {
      const key = (img.rgb[i] << 16) | (img.rgb[i + 1] << 8) | img.rgb[i + 2];
      let idx = cache.get(key);
      if (idx === undefined) {
        idx = nearestRgbIndex(img.rgb[i], img.rgb[i + 1], img.rgb[i + 2], paletteRgb);
        cache.set(key, idx);
      }
      rgb.set(paletteRgb[idx], i);
    }
    return { w: img.w, h: img.h, rgb };
  }

  /** Slot index per pixel for an image already made of palette colors. */
  function imageToSlots(img, paletteRgb) {
    const out = new Uint8Array(img.w * img.h);
    const cache = new Map();
    for (let p = 0, i = 0; p < out.length; p++, i += 3) {
      const key = (img.rgb[i] << 16) | (img.rgb[i + 1] << 8) | img.rgb[i + 2];
      let idx = cache.get(key);
      if (idx === undefined) {
        idx = nearestRgbIndex(img.rgb[i], img.rgb[i + 1], img.rgb[i + 2], paletteRgb);
        cache.set(key, idx);
      }
      out[p] = idx;
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // Tiles                                                              //
  // ------------------------------------------------------------------ //

  /** tile_analyzer.image_to_tile_grid (pads with black to a multiple of 8). */
  function tileGrid(img) {
    const mapW = Math.ceil(img.w / TILE);
    const mapH = Math.ceil(img.h / TILE);
    const tiles = [];
    for (let ty = 0; ty < mapH; ty++) {
      for (let tx = 0; tx < mapW; tx++) {
        const t = new Uint8Array(TILE_BYTES);
        for (let y = 0; y < TILE; y++) {
          const sy = ty * TILE + y;
          if (sy >= img.h) break;
          for (let x = 0; x < TILE; x++) {
            const sx = tx * TILE + x;
            if (sx >= img.w) break;
            const s = (sy * img.w + sx) * 3;
            const d = (y * TILE + x) * 3;
            t[d] = img.rgb[s]; t[d + 1] = img.rgb[s + 1]; t[d + 2] = img.rgb[s + 2];
          }
        }
        tiles.push(t);
      }
    }
    return { tiles, mapW, mapH };
  }

  function tileMae(a, b) {
    let s = 0;
    for (let i = 0; i < TILE_BYTES; i++) s += Math.abs(a[i] - b[i]);
    return s / TILE_BYTES;
  }

  /**
   * tile_analyzer.build_tileset as a resumable builder (MAE threshold merging with a
   * 20-entry LRU cache), so the UI can run it in chunks with progress + cancel.
   */
  function createTilesetBuilder(img, threshold) {
    const { tiles: grid, mapW, mapH } = tileGrid(img);
    const total = grid.length;
    const unique = [];
    const map = new Int32Array(total).fill(-1);
    const cache = []; // tile indices, oldest first
    let pos = 0;

    function step(maxTiles = Infinity) {
      const end = Math.min(total, pos + maxTiles);
      for (; pos < end; pos++) {
        const cur = grid[pos];
        let bestIdx = -1;
        let bestMae = Infinity;
        for (let k = cache.length - 1; k >= 0; k--) {
          const idx = cache[k];
          const m = tileMae(cur, unique[idx]);
          if (m < bestMae) {
            bestMae = m;
            bestIdx = idx;
            if (m <= threshold) break;
          }
        }
        if (bestMae > threshold) {
          const cached = new Set(cache);
          for (let idx = 0; idx < unique.length; idx++) {
            if (cached.has(idx)) continue;
            const m = tileMae(cur, unique[idx]);
            if (m < bestMae) {
              bestMae = m;
              bestIdx = idx;
              if (m <= threshold) break;
            }
          }
        }
        if (bestMae <= threshold && bestIdx !== -1) {
          map[pos] = bestIdx;
          const ci = cache.indexOf(bestIdx);
          if (ci >= 0) cache.splice(ci, 1);
          cache.push(bestIdx);
        } else {
          map[pos] = unique.length;
          cache.push(unique.length);
          unique.push(cur.slice());
        }
        if (cache.length > CACHE_SIZE) cache.shift();
      }
      return pos >= total;
    }

    return {
      total,
      get processed() { return pos; },
      step,
      result: () => ({ tiles: unique, map, mapW, mapH }),
    };
  }

  function buildTileset(img, threshold) {
    const b = createTilesetBuilder(img, threshold);
    b.step();
    return b.result();
  }

  /** tile_analyzer.reconstruct_image */
  function reconstruct(tiles, map, mapW, mapH) {
    if (!tiles.length || !map.length) return { w: TILE, h: TILE, rgb: new Uint8Array(TILE_BYTES) };
    const w = mapW * TILE;
    const h = mapH * TILE;
    const rgb = new Uint8Array(w * h * 3);
    for (let ty = 0; ty < mapH; ty++) {
      for (let tx = 0; tx < mapW; tx++) {
        const t = tiles[map[ty * mapW + tx]];
        if (!t) continue;
        for (let y = 0; y < TILE; y++) {
          rgb.set(t.subarray(y * TILE * 3, (y + 1) * TILE * 3), ((ty * TILE + y) * w + tx * TILE) * 3);
        }
      }
    }
    return { w, h, rgb };
  }

  /** MAE / max abs error over the source area (works for sizes that are not multiples of 8). */
  function errorMetrics(src, recon) {
    let sum = 0;
    let max = 0;
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const a = (y * src.w + x) * 3;
        const b = (y * recon.w + x) * 3;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(src.rgb[a + c] - recon.rgb[b + c]);
          sum += d;
          if (d > max) max = d;
        }
      }
    }
    const n = src.w * src.h * 3;
    return { mae: n ? sum / n : 0, maxAbs: max };
  }

  // ------------------------------------------------------------------ //
  // Viewport analysis + heatmap                                        //
  // ------------------------------------------------------------------ //

  /** viewport_analyzer.analyze_viewport_detailed (sliding window, same results). */
  function analyzeViewport(map, mapW, mapH, vwReq, vhReq) {
    if (!mapW || !mapH) {
      return { heat: new Int32Array(1), hw: 1, hh: 1, vw: 1, vh: 1, maxUnique: 0, worst: [], mean: 0 };
    }
    const vw = Math.max(1, Math.min(vwReq, mapW));
    const vh = Math.max(1, Math.min(vhReq, mapH));
    let maxId = 0;
    for (let i = 0; i < map.length; i++) if (map[i] > maxId) maxId = map[i];

    if (vw === mapW && vh === mapH) {
      const u = new Set(map).size;
      return { heat: Int32Array.of(u), hw: 1, hh: 1, vw, vh, maxUnique: u, worst: [[0, 0]], mean: u };
    }

    const hw = mapW - vw + 1;
    const hh = mapH - vh + 1;
    const heat = new Int32Array(hw * hh);
    const counts = new Int32Array(maxId + 1);
    let distinct = 0;
    const addCell = (v) => { if (counts[v]++ === 0) distinct++; };
    const removeCell = (v) => { if (--counts[v] === 0) distinct--; };
    const column = (x, top, fn) => { for (let y = top; y < top + vh; y++) fn(map[y * mapW + x]); };

    let maxUnique = 0;
    let worst = [];
    let total = 0;
    for (let top = 0; top < hh; top++) {
      for (let x = 0; x < vw; x++) column(x, top, addCell);
      for (let left = 0; left < hw; left++) {
        if (left > 0) {
          column(left - 1, top, removeCell);
          column(left + vw - 1, top, addCell);
        }
        heat[top * hw + left] = distinct;
        total += distinct;
        if (distinct > maxUnique) { maxUnique = distinct; worst = [[left, top]]; }
        else if (distinct === maxUnique) worst.push([left, top]);
      }
      for (let x = hw - 1; x < hw - 1 + vw; x++) column(x, top, removeCell);
    }
    return { heat, hw, hh, vw, vh, maxUnique, worst, mean: total / (hw * hh) };
  }

  /** viewport_analyzer.generate_heatmap_image -> full-size RGB image (8px per tile). */
  function heatmapImage(vp, mapW, mapH, budget = VRAM_TILE_BUDGET) {
    const { heat, hw, hh, vw, vh } = vp;
    // 2D prefix sums so every tile can average the viewports covering it
    const P = new Float64Array((hh + 1) * (hw + 1));
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        P[(y + 1) * (hw + 1) + x + 1] = heat[y * hw + x] + P[y * (hw + 1) + x + 1] + P[(y + 1) * (hw + 1) + x] - P[y * (hw + 1) + x];
      }
    }
    const w = mapW * TILE;
    const h = mapH * TILE;
    const rgb = new Uint8Array(w * h * 3);
    for (let ty = 0; ty < mapH; ty++) {
      for (let tx = 0; tx < mapW; tx++) {
        const y0 = Math.max(0, ty - vh + 1), y1 = Math.min(hh - 1, ty);
        const x0 = Math.max(0, tx - vw + 1), x1 = Math.min(hw - 1, tx);
        let val = 0;
        if (y0 <= y1 && x0 <= x1) {
          const sum = P[(y1 + 1) * (hw + 1) + x1 + 1] - P[y0 * (hw + 1) + x1 + 1] - P[(y1 + 1) * (hw + 1) + x0] + P[y0 * (hw + 1) + x0];
          val = fround(fround(sum) / ((y1 - y0 + 1) * (x1 - x0 + 1)));
        }
        const c = heatColor(fround(val / budget));
        for (let y = 0; y < TILE; y++) {
          for (let x = 0; x < TILE; x++) rgb.set(c, ((ty * TILE + y) * w + tx * TILE + x) * 3);
        }
      }
    }
    return { w, h, rgb };
  }

  function heatColor(v) {
    if (v <= 0.5) return [Math.trunc(fround(fround(v * 2) * 255)), 255, 0];
    if (v <= 0.9) return [255, Math.trunc(fround(255 - fround(fround(fround(v - 0.5) / 0.4) * 90))), 0];
    if (v <= 1.0) return [255, Math.trunc(fround(165 - fround(fround(fround(v - 0.9) / 0.1) * 165))), 0];
    const t = Math.min(fround(fround(v - 1.0) / 0.5), 1.0);
    return [Math.trunc(fround(255 - fround(t * 127))), 0, 0];
  }

  // ------------------------------------------------------------------ //
  // Auto Generate Tiles                                                //
  // ------------------------------------------------------------------ //

  function weightedNearest(color, palette) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const dr = (palette[i][0] - color[0]) * 0.3;
      const dg = (palette[i][1] - color[1]) * 0.59;
      const db = (palette[i][2] - color[2]) * 0.11;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return palette[best];
  }

  /** main_window._on_auto_generate_tiles: per-pixel median across all uses, snapped to the image colors. */
  function autoGenerateTiles(tiles, map, mapW, mapH, source) {
    const seen = new Map();
    for (let i = 0; i < source.rgb.length; i += 3) {
      const key = (source.rgb[i] << 16) | (source.rgb[i + 1] << 8) | source.rgb[i + 2];
      if (!seen.has(key)) seen.set(key, [source.rgb[i], source.rgb[i + 1], source.rgb[i + 2]]);
    }
    let unique = [...seen.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    let palette = unique;
    if (unique.length > 16) {
      const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      const sorted = unique.map((c, i) => [lum(c), i]).sort((a, b) => a[0] - b[0]).map(([, i]) => unique[i]);
      const step = Math.floor(unique.length / 16);
      palette = sorted.filter((_, i) => i % step === 0).slice(0, 16);
    }

    const grid = tileGrid(source);
    const usage = new Map();
    for (let i = 0; i < map.length; i++) {
      if (!usage.has(map[i])) usage.set(map[i], []);
      usage.get(map[i]).push(i);
    }

    const out = tiles.map((t) => t.slice());
    const values = [];
    for (const [idx, positions] of usage) {
      if (idx < 0 || idx >= out.length) continue;
      const tile = new Uint8Array(TILE_BYTES);
      for (let p = 0; p < TILE * TILE; p++) {
        const med = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          values.length = 0;
          for (const pos of positions) values.push(grid.tiles[pos][p * 3 + c]);
          values.sort((a, b) => a - b);
          const m = values.length >> 1;
          med[c] = Math.trunc(values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2);
        }
        tile.set(weightedNearest(med, palette), p * 3);
      }
      out[idx] = tile;
    }
    return { tiles: out, paletteSize: palette.length };
  }

  // ------------------------------------------------------------------ //
  // PICO-8 cart export                                                 //
  // ------------------------------------------------------------------ //

  const CART_HEADER = 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__';

  function tileToSlots(tile, paletteRgb) {
    const out = new Uint8Array(TILE * TILE);
    for (let p = 0; p < out.length; p++) out[p] = nearestRgbIndex(tile[p * 3], tile[p * 3 + 1], tile[p * 3 + 2], paletteRgb);
    return out;
  }

  /** Sprite-sheet memory (0x0000-0x1fff) with tiles placed 16 per row. */
  function spriteMemory(tiles, paletteRgb) {
    const mem = new Uint8Array(0x2000);
    tiles.slice(0, MAX_SPRITES).forEach((tile, i) => {
      const slots = tileToSlots(tile, paletteRgb);
      const sx = (i % 16) * TILE;
      const sy = Math.floor(i / 16) * TILE;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x += 2) {
          mem[(sy + y) * 64 + ((sx + x) >> 1)] = slots[y * TILE + x] | (slots[y * TILE + x + 1] << 4);
        }
      }
    });
    return mem;
  }

  /** __gfx__ text: 128 lines, one hex digit per pixel (low nibble first). */
  function gfxSection(mem) {
    const lines = ['__gfx__'];
    for (let line = 0; line < 128; line++) {
      let s = '';
      for (let b = 0; b < 64; b++) {
        const v = mem[line * 64 + b];
        s += (v & 15).toString(16) + (v >> 4).toString(16);
      }
      lines.push(s);
    }
    return lines.join('\n');
  }

  const hexByte = (v) => v.toString(16).padStart(2, '0');

  function palComment(palPicos) {
    if (!palPicos) return [];
    return [`-- screen palette: pal({[0]=${palPicos.join(',')}},1)`];
  }

  function palCode(palPicos) {
    if (!palPicos) return '';
    return palPicos.map((p, i) => (p !== i ? ` pal(${i},${p},1)\n` : '')).join('');
  }

  /**
   * pico8_exporter.export_to_pico8 (fixed):
   * - standard mode keeps map rows 32..63 in the shared lower sprite memory (needs <=128 tiles)
   * - large maps are stored as raw bytes, one byte per cell, in the sprite sheet of a second cart
   * Returns {files:[{name,text}], mode, summary} or {error}.
   */
  function buildTileCarts({ tiles, map, mapW, mapH, paletteRgb, palPicos = null, baseName, viewer = true }) {
    if (!tiles.length) return { error: 'No tiles to export' };
    if (tiles.length > MAX_SPRITES) {
      return { error: `Too many tiles (${tiles.length}). PICO-8 supports max ${MAX_SPRITES} sprites.` };
    }
    const mode = cartMode(tiles.length, mapW, mapH);
    if (mode === 'too-large') {
      return { error: `Map too large (${mapW}x${mapH} = ${mapW * mapH} cells). Maximum supported: ${MAX_LARGE_MAP_CELLS} cells when using sprite data storage.` };
    }

    const mem = spriteMemory(tiles, paletteRgb);
    const files = [];

    if (mode === 'standard') {
      const mapLines = ['__map__'];
      for (let y = 0; y < Math.min(mapH, 32); y++) {
        let s = '';
        for (let x = 0; x < mapW; x++) s += hexByte(Math.max(0, Math.min(255, map[y * mapW + x])));
        mapLines.push(s);
      }
      for (let y = 32; y < mapH; y++) {
        for (let x = 0; x < mapW; x++) mem[0x1000 + (y - 32) * 128 + x] = map[y * mapW + x];
      }
      const lua = [
        CART_HEADER,
        '-- tile data cart',
        '-- generated by p8 tile packer',
        `-- ${tiles.length} sprites, ${mapW}x${mapH} map${mapH > 32 ? ' (rows 32+ live in shared sprite memory 0x1000)' : ''}`,
        ...palComment(palPicos),
        '',
      ];
      files.push({ name: `${baseName}.p8`, text: [...lua, gfxSection(mem), '', mapLines.join('\n'), ''].join('\n') });
      if (viewer) files.push({ name: `${baseName}_viewer.p8`, text: standardViewer(baseName, mapW, mapH, palPicos) });
    } else {
      files.push({
        name: `${baseName}_sprites.p8`,
        text: [CART_HEADER, '-- sprite sheet data', '-- generated by p8 tile packer', ...palComment(palPicos), '', gfxSection(mem), ''].join('\n'),
      });
      const mapMem = new Uint8Array(0x2000);
      for (let i = 0; i < mapW * mapH; i++) mapMem[i] = map[i];
      files.push({
        name: `${baseName}_map.p8`,
        text: [
          CART_HEADER,
          `-- map data cart (${mapW}x${mapH})`,
          '-- generated by p8 tile packer',
          '-- map data encoded in sprite sheet',
          `-- cell(x,y) = byte at y*${mapW}+x, e.g. reload(0x8000,0,${mapW * mapH},"${baseName}_map.p8")`,
          `--             then peek(0x8000+y*${mapW}+x)`,
          '',
          gfxSection(mapMem),
          '',
        ].join('\n'),
      });
      if (viewer) files.push({ name: `${baseName}_viewer.p8`, text: largeViewer(baseName, mapW, mapH, palPicos) });
    }

    const summary = mode === 'standard'
      ? `Data cart: ${files[0].name}`
      : `Sprites cart: ${files[0].name}\nMap data cart: ${files[1].name}\n\nLarge map mode (${mapW}x${mapH}): map data encoded in sprite sheet.`;
    return { files, mode, summary: viewer ? `${summary}\nViewer cart: ${baseName}_viewer.p8` : summary };
  }

  /** 'standard' | 'large' | 'too-large' */
  function cartMode(tileCount, mapW, mapH) {
    const large = mapW > 128 || mapH > 64 || (mapH > 32 && tileCount > 128);
    if (!large) return 'standard';
    return mapW * mapH > MAX_LARGE_MAP_CELLS ? 'too-large' : 'large';
  }

  const viewerUpdate = (mapW, mapH) => `function _update()
 if(btn(0)) cx=max(0,cx-2)
 if(btn(1)) cx=min(${Math.max(0, mapW * 8 - 128)},cx+2)
 if(btn(2)) cy=max(0,cy-2)
 if(btn(3)) cy=min(${Math.max(0, mapH * 8 - 128)},cy+2)
end`;

  const viewerDraw = (mapW, mapH, cellExpr) => `function _draw()
 cls()
 local tx0,ty0=flr(cx/8),flr(cy/8)
 for ty=ty0,min(${mapH - 1},ty0+16) do
  for tx=tx0,min(${mapW - 1},tx0+16) do
   spr(${cellExpr},tx*8-cx,ty*8-cy)
  end
 end
 rectfill(0,0,40,6,0)
 print(flr(cx/8)..","..flr(cy/8),1,1,7)
end`;

  function standardViewer(baseName, mapW, mapH, palPicos) {
    return `${CART_HEADER}
-- tile map viewer
-- loads sprites + map from ${baseName}.p8
-- arrows: scroll
cx,cy=0,0

function _init()
 reload(0x0,0x0,0x3000,"${baseName}.p8")
${palCode(palPicos)}end

${viewerUpdate(mapW, mapH)}

${viewerDraw(mapW, mapH, 'mget(tx,ty)')}
`;
  }

  function largeViewer(baseName, mapW, mapH, palPicos) {
    return `${CART_HEADER}
-- large tile map viewer (${mapW}x${mapH})
-- sprites from ${baseName}_sprites.p8
-- map bytes from ${baseName}_map.p8 -> 0x8000
-- arrows: scroll
cx,cy=0,0

function _init()
 reload(0x0,0x0,0x2000,"${baseName}_sprites.p8")
 reload(0x8000,0x0,${mapW * mapH},"${baseName}_map.p8")
${palCode(palPicos)}end

${viewerUpdate(mapW, mapH)}

${viewerDraw(mapW, mapH, `peek(0x8000+ty*${mapW}+tx)`)}
`;
  }

  // ------------------------------------------------------------------ //
  // Aseprite export (aseprite_exporter.AsepriteExporter.export)        //
  // ------------------------------------------------------------------ //

  class ByteWriter {
    constructor() { this.buf = new Uint8Array(1024); this.len = 0; }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    byte(v) { this.ensure(1); this.buf[this.len++] = v & 255; }
    word(v) { this.byte(v); this.byte(v >> 8); }
    dword(v) { this.word(v & 0xffff); this.word((v >>> 16) & 0xffff); }
    bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.len); this.len += arr.length; }
    zeros(n) { this.bytes(new Uint8Array(n)); }
    string(s) { const e = new TextEncoder().encode(s); this.word(e.length); this.bytes(e); }
    patchDword(at, v) { this.buf[at] = v & 255; this.buf[at + 1] = (v >> 8) & 255; this.buf[at + 2] = (v >> 16) & 255; this.buf[at + 3] = (v >>> 24) & 255; }
    result() { return this.buf.slice(0, this.len); }
  }

  async function asepriteFile(img) {
    const rgba = new Uint8Array(img.w * img.h * 4);
    for (let i = 0, o = 0; i < img.rgb.length; i += 3, o += 4) {
      rgba[o] = img.rgb[i]; rgba[o + 1] = img.rgb[i + 1]; rgba[o + 2] = img.rgb[i + 2]; rgba[o + 3] = 255;
    }
    const pixels = await zlibCompress(rgba);
    const wr = new ByteWriter();
    // File header (128 bytes)
    wr.dword(0); wr.word(0xa5e0); wr.word(1); wr.word(img.w); wr.word(img.h); wr.word(32);
    wr.dword(1); wr.word(100); wr.dword(0); wr.dword(0); wr.byte(0); wr.zeros(3); wr.word(0);
    wr.byte(1); wr.byte(1);
    wr.zeros(128 - wr.len);
    // Frame header
    const frame = wr.len;
    wr.dword(0); wr.word(0xf1fa); wr.word(2); wr.word(100); wr.zeros(6);
    // Layer chunk
    let chunk = wr.len;
    wr.dword(0); wr.word(0x2004);
    wr.word(1); wr.word(0); wr.word(0); wr.word(0); wr.word(0); wr.word(0); wr.byte(255); wr.zeros(3);
    wr.string('Image');
    wr.patchDword(chunk, wr.len - chunk);
    // Cel chunk (compressed image)
    chunk = wr.len;
    wr.dword(0); wr.word(0x2005);
    wr.word(0); wr.word(0); wr.word(0); wr.byte(255); wr.word(2); wr.zeros(7);
    wr.word(img.w); wr.word(img.h); wr.bytes(pixels);
    wr.patchDword(chunk, wr.len - chunk);
    wr.patchDword(frame, wr.len - frame);
    wr.patchDword(0, wr.len);
    return wr.result();
  }

  return {
    TILE, TILE_BYTES, VRAM_TILE_BUDGET, MAX_SPRITES, MAX_LARGE_MAP_CELLS, THRESHOLD_MAX,
    PICO8_LEVEL_ORDER, PICO8_LEVEL_RGB, PICO8_STD_RGB,
    fromImageData, toImageData, grayOf, levelOf, convertByLevels, convertNearest, imageToSlots, nearestRgbIndex,
    tileGrid, tileMae, createTilesetBuilder, buildTileset, reconstruct, errorMetrics,
    analyzeViewport, heatmapImage, autoGenerateTiles,
    tileToSlots, spriteMemory, gfxSection, cartMode, buildTileCarts, asepriteFile,
  };
})();

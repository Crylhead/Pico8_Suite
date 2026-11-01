// js/core.js
// Pure logic for the PICO-8 Palette Tool (no DOM access).
// Ported 1:1 from the Python version (core/*.py + export handlers) so that
// generated fade tables, Lua exports, presets and carts are identical.

'use strict';

const P8 = (() => {
  // ------------------------------------------------------------------ //
  // System palette                                                     //
  // ------------------------------------------------------------------ //

  const SYSTEM_COLORS = [
    // Base palette (0..15)
    [0, [0, 0, 0]], [1, [29, 43, 83]], [2, [126, 37, 83]], [3, [0, 135, 81]],
    [4, [171, 82, 54]], [5, [95, 87, 79]], [6, [194, 195, 199]], [7, [255, 241, 232]],
    [8, [255, 0, 77]], [9, [255, 163, 0]], [10, [255, 236, 39]], [11, [0, 228, 54]],
    [12, [41, 173, 255]], [13, [131, 118, 156]], [14, [255, 119, 168]], [15, [255, 204, 170]],
    // Hidden / extended palette (128..143)
    [128, [41, 24, 20]], [129, [17, 29, 53]], [130, [66, 33, 54]], [131, [18, 83, 89]],
    [132, [116, 47, 41]], [133, [73, 51, 59]], [134, [162, 136, 121]], [135, [243, 239, 125]],
    [136, [190, 18, 80]], [137, [255, 108, 36]], [138, [168, 231, 46]], [139, [0, 181, 67]],
    [140, [6, 90, 181]], [141, [117, 70, 101]], [142, [255, 110, 89]], [143, [255, 157, 129]],
  ];

  const RGB = new Map(SYSTEM_COLORS);
  const BASE_INDICES = SYSTEM_COLORS.slice(0, 16).map(([i]) => i);
  const HIDDEN_INDICES = SYSTEM_COLORS.slice(16).map(([i]) => i);

  // Default ramp presets (shipped config.json)
  const DEFAULT_RAMP_PRESETS = [
    [0, 129, 1, 131, 140, 13, 134, 12, 6, 7],
    [0, 128, 130, 2, 141, 136, 8, 137, 142, 143, 15, 7],
    [0, 129, 131, 3, 139, 11, 138, 10, 135, 7],
    [0, 128, 130, 132, 4, 137, 9, 10, 135, 7],
    [0, 129, 1, 140, 12, 6, 7],
    [0, 128, 130, 2, 141, 136, 8, 137, 9, 10, 135, 7],
    [0, 128, 129, 130, 2, 141, 136, 8, 14, 143, 15, 135, 7],
    [0, 129, 1, 2, 136, 8, 14, 143, 15, 7],
    [0, 129, 1, 131, 3, 139, 11, 138, 10, 135, 7],
    [0, 129, 1, 2, 4, 8, 14, 143, 15, 7],
    [0, 1, 133, 5, 134, 13, 6, 7],
  ];

  const BAYER_4 = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const PATTERN_SIZE = 4;
  const TILE_X = 2;
  const BAYER_PHASE_X = 1;

  const STOPS_PER_ROW = 15;
  const FADE_STEPS = 32;

  const rgbOf = (pico) => (pico == null ? null : RGB.get(pico) || null);
  const isValidPico = (pico) => Number.isInteger(pico) && RGB.has(pico);
  const lum601 = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
  const lum709 = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const hex2 = (b) => ((b >> 4) & 15).toString(16) + (b & 15).toString(16);

  // Python 3 round(): round half to even
  function pyRound(x) {
    const f = Math.floor(x);
    const diff = x - f;
    if (diff > 0.5) return f + 1;
    if (diff < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  const emptyPalette = () => Array(16).fill(null);
  const emptyStops = () => Array.from({ length: 16 }, () => Array(STOPS_PER_ROW).fill(null));
  const cloneStops = (stops) => stops.map((row) => row.slice());

  /** 16 entries, empty slots filled with PICO-8 black (pico 0). */
  const fullPalette = (palette) => palette.map((p) => (p == null ? 0 : p));
  const fullPaletteRgb = (palette) => fullPalette(palette).map(rgbOf);
  const usedColorIndices = (palette) =>
    palette.map((p, i) => (p == null ? -1 : i)).filter((i) => i >= 0);

  function slotIndexOfPico(palette, pico) {
    if (pico == null) return null;
    const i = palette.indexOf(pico);
    return i < 0 ? null : i;
  }

  // ------------------------------------------------------------------ //
  // Fade target selection                                              //
  // ------------------------------------------------------------------ //

  /** Palette16.find_fade_target_slot */
  function findFadeTargetSlot(palette) {
    for (let i = 0; i < 16; i++) {
      if (palette[i] === 0 || palette[i] === 128) return i;
    }
    let darkestIdx = null;
    let darkestLum = null;
    for (let i = 0; i < 16; i++) {
      if (palette[i] == null) continue;
      const lum = lum601(rgbOf(palette[i]));
      if (darkestLum === null || lum < darkestLum) {
        darkestLum = lum;
        darkestIdx = i;
      }
    }
    return darkestIdx;
  }

  /** PaletteHelpers.resolve_target_slot */
  function resolveTargetSlot(palette, targetPico, direction) {
    if (targetPico != null) {
      const idx = palette.indexOf(targetPico);
      if (idx >= 0) return idx;
    }
    const filled = [];
    palette.forEach((p, i) => { if (p != null) filled.push([i, p]); });
    if (!filled.length) return null;

    let best = filled[0][0];
    if (direction === 'bright') {
      let maxLum = -1;
      for (const [i, p] of filled) {
        const lum = lum709(rgbOf(p));
        if (lum > maxLum) { maxLum = lum; best = i; }
      }
    } else {
      let minLum = Infinity;
      for (const [i, p] of filled) {
        const lum = lum709(rgbOf(p));
        if (lum < minLum) { minLum = lum; best = i; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ //
  // Ramps + fade generation                                            //
  // ------------------------------------------------------------------ //

  /** core.ramps.build_slot_ramps */
  function buildSlotRamps(palette, stopEntries, targetSlot) {
    if (stopEntries.length !== 16) {
      throw new Error(`Expected 16 rows of ramp stops, got ${stopEntries.length}.`);
    }
    const slotByPico = new Map();
    palette.forEach((p, idx) => {
      if (p != null && !slotByPico.has(p)) slotByPico.set(p, idx);
    });

    if (targetSlot == null) targetSlot = findFadeTargetSlot(palette);
    if (targetSlot == null) targetSlot = 0;

    const ramps = [];
    for (let row = 0; row < 16; row++) {
      const stops = [row];
      for (const pico of stopEntries[row]) {
        if (pico == null || !slotByPico.has(pico)) continue;
        const slot = slotByPico.get(pico);
        if (slot !== stops[stops.length - 1]) stops.push(slot);
      }
      if (!stops.includes(targetSlot)) stops.push(targetSlot);
      ramps.push(stops);
    }
    return ramps;
  }

  /** FadeGenerator.generate_with_ramps -> {tables, coverage} */
  function generateWithRamps(ramps, cfg) {
    if (ramps.length !== 16) throw new Error('Expected 16 ramps (one for each palette index).');

    let maxSegments = 0;
    for (const stops of ramps) {
      if (!stops || stops.length <= 1) continue;
      maxSegments = Math.max(maxSegments, stops.length - 1);
    }
    if (maxSegments === 0) maxSegments = 1;

    const stepsTotal = cfg.steps;
    const baseSegSteps = Math.floor(stepsTotal / maxSegments);
    const extra = stepsTotal % maxSegments;
    const segmentSteps = [];
    for (let s = 0; s < maxSegments; s++) segmentSteps.push(baseSegSteps + (s < extra ? 1 : 0));

    const hiLo = [];
    for (let c = 0; c < 16; c++) {
      let stops = ramps[c];
      if (!stops || !stops.length) stops = [c, c];
      if (stops.length === 1) stops = [stops[0], stops[0]];
      const segments = [];
      for (let i = 0; i < stops.length - 1; i++) segments.push([stops[i], stops[i + 1]]);
      const target = stops[stops.length - 1];
      const list = [];
      for (let s = 0; s < maxSegments; s++) list.push(s < segments.length ? segments[s] : [target, target]);
      hiLo.push(list);
    }

    let covMin = Math.max(0, Math.min(16, cfg.covMin));
    let covMax = Math.max(0, Math.min(16, cfg.covMax));
    if (covMin > covMax) [covMin, covMax] = [covMax, covMin];

    const tables = [];
    const coverage = [];
    const gamma = cfg.gamma;

    for (let seg = 0; seg < maxSegments; seg++) {
      const localSteps = segmentSteps[seg];
      if (localSteps <= 0) continue;
      for (let sl = 0; sl < localSteps; sl++) {
        const isFirst = seg === 0 && sl === 0;
        const isFinal = seg === maxSegments - 1 && sl === localSteps - 1;
        const u = localSteps > 1 ? sl / (localSteps - 1) : 0;
        let frac = Math.pow(1 - u, gamma);
        frac = Math.max(0, Math.min(1, frac));

        let cov;
        if (isFirst) cov = 16;
        else if (isFinal) cov = 0;
        else cov = Math.max(0, Math.min(16, pyRound(covMin + frac * (covMax - covMin))));
        coverage.push(cov);

        const row = [];
        for (let c = 0; c < 16; c++) {
          const [hi, lo] = hiLo[c][seg];
          let packed;
          if (isFirst) {
            const s = hiLo[c][0][0] & 15;
            packed = (s << 4) | s;
          } else if (isFinal) {
            const t = hiLo[c][maxSegments - 1][1] & 15;
            packed = (t << 4) | t;
          } else {
            packed = ((hi & 15) << 4) | (lo & 15);
          }
          row.push(packed);
        }
        tables.push(row);
      }
    }
    return { tables, coverage };
  }

  /** FadeGenerator.combine_two_sided (N steps each -> N+1 steps) */
  function combineTwoSided(dark, bright) {
    if (dark.tables.length !== bright.tables.length) {
      throw new Error(
        `dark and bright FadeData must have same steps (got ${dark.tables.length} and ${bright.tables.length})`
      );
    }
    const n = dark.tables.length;
    const half = Math.floor(n / 2);
    const identity = Array.from({ length: 16 }, (_, c) => ((c & 15) << 4) | (c & 15));
    const tables = [];
    const coverage = [];
    for (let stage = 0; stage < n + 1; stage++) {
      if (stage === half) {
        tables.push(identity.slice());
        coverage.push(0);
      } else if (stage < half) {
        let d = 31 - Math.trunc((stage / 15.0) * 30);
        if (d === 0) d = 1;
        if (d >= dark.tables.length) d = dark.tables.length - 1;
        tables.push(dark.tables[d].slice());
        coverage.push(dark.coverage[d]);
      } else {
        const offset = stage - half;
        let b = Math.trunc(((offset - 1) / 15.0) * 31);
        if (b === 0) b = 1;
        if (b >= bright.tables.length) b = bright.tables.length - 1;
        tables.push(bright.tables[b].slice());
        coverage.push(bright.coverage[b]);
      }
    }
    return { tables, coverage };
  }

  /** Slider (0..31, 16 = normal) -> fade step for the image preview. */
  function sliderToStep(value) {
    let step;
    if (value < 16) {
      step = 31 - Math.trunc((value / 15.0) * 30);
      if (step === 0) step = 1;
    } else if (value === 16) {
      step = 0;
    } else {
      step = Math.trunc(((value - 16) / 15.0) * 31);
      if (step === 0) step = 1;
    }
    return step;
  }

  // ------------------------------------------------------------------ //
  // Auto fill                                                          //
  // ------------------------------------------------------------------ //

  function findBestRamp(base, allRamps, lumByPico, target, direction) {
    let bestMatch = [];
    let bestScore = -1;
    const baseLum = lumByPico.has(base) ? lumByPico.get(base) : 0;

    for (const ramp of allRamps) {
      if (!ramp || !ramp.length || !ramp.includes(base)) continue;
      for (const check of [ramp, ramp.slice().reverse()]) {
        const bi = check.indexOf(base);
        const slice = check.slice(bi);
        if (slice.length <= 1) continue;

        const filtered = [];
        let prev = base;
        let prevLum = baseLum;
        for (const c of slice.slice(1)) {
          if (!lumByPico.has(c) || c === prev || c === target) continue;
          const l = lumByPico.get(c);
          if (direction === 'dark' ? l < prevLum : l > prevLum) {
            filtered.push(c);
            prev = c;
            prevLum = l;
          }
        }
        if (filtered.length > bestScore) {
          bestScore = filtered.length;
          bestMatch = filtered;
        }
      }
    }
    return bestMatch;
  }

  /** FadePanel.on_auto_fill -> new 16x15 stop grid, or null if palette empty. */
  function autoFillStops(palette, direction, rampPresets) {
    const lumByPico = new Map();
    for (const p of palette) if (p != null) lumByPico.set(p, lum601(rgbOf(p)));
    if (!lumByPico.size) return null;

    let target = null;
    let best = null;
    for (const [p, l] of lumByPico) {
      if (best === null || (direction === 'dark' ? l < best : l > best)) {
        best = l;
        target = p;
      }
    }

    const stops = [];
    for (let row = 0; row < 16; row++) {
      const base = palette[row];
      const rowStops = [];
      if (base != null) {
        for (const c of findBestRamp(base, rampPresets, lumByPico, target, direction)) {
          if (c === base) continue;
          rowStops.push(c);
          if (rowStops.length >= STOPS_PER_ROW) break;
        }
      }
      while (rowStops.length < STOPS_PER_ROW) rowStops.push(null);
      stops.push(rowStops);
    }
    return stops;
  }

  // ------------------------------------------------------------------ //
  // Text exports                                                       //
  // ------------------------------------------------------------------ //

  function paletteToLua(entries) {
    if (!entries.length) return '-- (no colors selected)\n';
    return [
      '-- Custom PICO-8 screen palette',
      '-- System palette indices (0..15 or 128..143)',
      `local custom_palette = { ${entries.join(', ')} }`,
      '',
      '-- Apply as screen palette (#1):',
      'for i=0,#custom_palette-1 do',
      '  pal(i, custom_palette[i+1], 1)',
      'end',
      '',
    ].join('\n');
  }

  function paletteToGpl(entries, name = 'PICO8 Custom Palette', columns = 16) {
    if (columns < 0) columns = 0;
    const lines = ['GIMP Palette', `Name: ${name}`, `Columns: ${columns}`, '# Generated by PICO-8 palette tool'];
    for (const p of entries) {
      const [r, g, b] = rgbOf(p);
      const pad = (n) => String(n).padStart(3, ' ');
      lines.push(`${pad(r)} ${pad(g)} ${pad(b)} ${String(p).padStart(3, '0')}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  function fadeToLua(fades, usedColors = null) {
    const colors = usedColors == null ? Array.from({ length: 16 }, (_, i) => i) : usedColors.slice().sort((a, b) => a - b);
    const lines = [
      '-- fade tables: fadetables[step+1][color+1] = packed (hi<<4 | lo)',
      `-- exporting ${colors.length} colors: [${colors.join(', ')}]`,
      'fadetables = {',
    ];
    fades.tables.forEach((row, s) => {
      const rowStr = colors.map((i) => '0x' + row[i].toString(16).padStart(2, '0')).join(', ');
      lines.push(`  -- step ${s}`);
      lines.push(`  {${rowStr}},`);
    });
    lines.push('}', '', '-- coverage levels: coverage[step+1] = threshold (0..16)', 'coverage = {');
    lines.push(`  ${fades.coverage.join(', ')}`);
    lines.push('}', '');
    return lines.join('\n');
  }

  // ------------------------------------------------------------------ //
  // Pixel rendering                                                    //
  // ------------------------------------------------------------------ //

  /** FadePreviewWidget._render_base_image -> ImageData (128x128 for 32 steps). */
  function renderFade(paletteRgb, fades, orientation) {
    const cols = paletteRgb.length;
    const steps = fades.tables.length;
    const horizontal = orientation === 'horizontal';
    const w = horizontal ? steps * PATTERN_SIZE : cols * PATTERN_SIZE * TILE_X;
    const h = horizontal ? cols * PATTERN_SIZE * TILE_X : steps * PATTERN_SIZE;
    const img = new ImageData(w, h);
    const d = img.data;
    const black = rgbOf(0);
    const toRgb = (i) => paletteRgb[i] || black;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let step, col, lx, ly;
        if (horizontal) {
          col = Math.min(Math.floor(y / (PATTERN_SIZE * TILE_X)), cols - 1);
          ly = (y + BAYER_PHASE_X) % PATTERN_SIZE;
          step = Math.floor(x / PATTERN_SIZE);
          lx = x % PATTERN_SIZE;
        } else {
          step = Math.floor(y / PATTERN_SIZE);
          ly = y % PATTERN_SIZE;
          col = Math.min(Math.floor(x / (PATTERN_SIZE * TILE_X)), cols - 1);
          lx = (x + BAYER_PHASE_X) % PATTERN_SIZE;
        }
        const packed = fades.tables[step][col];
        const rgb = BAYER_4[ly][lx] < fades.coverage[step] ? toRgb((packed >> 4) & 15) : toRgb(packed & 15);
        const o = (y * w + x) * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    return img;
  }

  /** Nearest palette slot by Euclidean RGB distance (first wins on ties). */
  function nearestSlot(r, g, b, paletteRgb) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < paletteRgb.length; i++) {
      const p = paletteRgb[i];
      const dist = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2;
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    return best;
  }

  /** ImageFadePreviewWidget.load_base_image -> slot index per pixel. */
  function quantize(imageData, paletteRgb) {
    const { width, height, data } = imageData;
    const out = new Uint8Array(width * height);
    const cache = new Map();
    for (let i = 0, o = 0; i < out.length; i++, o += 4) {
      const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      let slot = cache.get(key);
      if (slot === undefined) {
        slot = nearestSlot(data[o], data[o + 1], data[o + 2], paletteRgb);
        cache.set(key, slot);
      }
      out[i] = slot;
    }
    return out;
  }

  /** ImageFadePreviewWidget._render_preview -> {image, slots} */
  function renderImageFade(indices, width, height, paletteRgb, fades, step) {
    step = Math.max(0, Math.min(step, fades.tables.length - 1));
    const row = fades.tables[step];
    const cov = fades.coverage[step];
    const image = new ImageData(width, height);
    const slots = new Uint8Array(width * height);
    const d = image.data;
    for (let y = 0; y < height; y++) {
      const by = y % PATTERN_SIZE;
      for (let x = 0; x < width; x++) {
        const bx = (x + BAYER_PHASE_X) % PATTERN_SIZE;
        const i = y * width + x;
        const packed = row[indices[i]];
        const slot = BAYER_4[by][bx] < cov ? (packed >> 4) & 15 : packed & 15;
        const rgb = paletteRgb[slot];
        slots[i] = slot;
        const o = i * 4;
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    return { image, slots };
  }

  const isValidPreviewSize = (w, h) =>
    (w === 128 && h === 128) || (w === 128 && h === 256) || (w === 256 && h === 128);

  // ------------------------------------------------------------------ //
  // Greyscale conversion                                               //
  // ------------------------------------------------------------------ //

  const perceivedBrightness = (rgb) => 0.6 * lum601(rgb) + 0.4 * Math.max(...rgb);

  /** GreyscaleMappingDialog._auto_assign_default -> 16 picos (or null if palette empty) */
  function autoAssignMapping(palette) {
    const colors = palette.filter((p) => p != null);
    if (!colors.length) return null;
    const sorted = colors
      .map((p, i) => ({ p, i, b: perceivedBrightness(rgbOf(p)) }))
      .sort((a, b) => a.b - b.b || a.i - b.i)
      .map((e) => e.p);
    const n = sorted.length;
    const mapping = [];
    for (let g = 0; g < 16; g++) {
      const idx = Math.max(0, Math.min(pyRound((g / 15.0) * (n - 1)), n - 1));
      mapping.push(sorted[idx]);
    }
    return mapping;
  }

  /** GreyscaleConverterHandler._convert_image_manual -> ImageData */
  function convertGreyscaleManual(imageData, mapping, blackPoint, whitePoint, outDark, outBright, dither) {
    const { width, height, data } = imageData;
    outDark = Math.max(0, Math.min(outDark, 15));
    outBright = Math.max(outDark, Math.min(outBright, 15));
    const out = new ImageData(width, height);
    const d = out.data;
    const rgbForLevel = (lvl) => rgbOf(mapping[lvl]) || [0, 0, 0];
    const range = outBright - outDark;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const grey = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
        const clamped = Math.max(blackPoint, Math.min(whitePoint, grey));
        const norm = whitePoint > blackPoint ? (clamped - blackPoint) / (whitePoint - blackPoint) : 0.5;

        let lower, upper, blend;
        if (range === 0) {
          lower = upper = outDark;
          blend = 0;
        } else {
          const pos = outDark + norm * range;
          lower = Math.trunc(pos);
          upper = Math.min(lower + 1, outBright);
          blend = pos - lower;
          lower = Math.max(outDark, Math.min(lower, outBright));
          upper = Math.max(outDark, Math.min(upper, outBright));
        }

        let useUpper;
        if (dither) useUpper = BAYER_4[y % 4][x % 4] / 16.0 < blend;
        else useUpper = blend >= 0.5;

        const rgb = rgbForLevel(useUpper ? upper : lower);
        d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // PNG import (palette extraction)                                    //
  // ------------------------------------------------------------------ //

  /** Returns the ordered PLTE colors of an indexed PNG, or null. */
  function parsePngPalette(buffer) {
    const bytes = new Uint8Array(buffer);
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || sig.some((v, i) => bytes[i] !== v)) return null;
    const view = new DataView(buffer);
    let pos = 8;
    let colorType = -1;
    while (pos + 8 <= bytes.length) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      const data = pos + 8;
      if (type === 'IHDR') colorType = bytes[data + 9];
      if (type === 'PLTE') {
        if (colorType !== 3) return null;
        const colors = [];
        for (let i = 0; i + 2 < len && colors.length < 256; i += 3) {
          colors.push([bytes[data + i], bytes[data + i + 1], bytes[data + i + 2]]);
        }
        return colors;
      }
      if (type === 'IDAT' || type === 'IEND') return null;
      pos = data + len + 4;
    }
    return null;
  }

  function uniqueColors(imageData) {
    const seen = new Set();
    const out = [];
    const d = imageData.data;
    for (let o = 0; o < d.length; o += 4) {
      const key = (d[o] << 16) | (d[o + 1] << 8) | d[o + 2];
      if (!seen.has(key)) { seen.add(key); out.push([d[o], d[o + 1], d[o + 2]]); }
    }
    return out;
  }

  /** PaletteImportHandler._match_colors_to_pico8 */
  function matchColorsToPico8(colors, ordered) {
    const found = [];
    const unmatched = [];
    const matched = new Set();
    for (const rgb of colors) {
      let closest = null;
      let minDist = Infinity;
      for (const [pico, prgb] of SYSTEM_COLORS) {
        const dist = Math.sqrt((rgb[0] - prgb[0]) ** 2 + (rgb[1] - prgb[1]) ** 2 + (rgb[2] - prgb[2]) ** 2);
        if (dist < minDist) { minDist = dist; closest = pico; }
      }
      if (minDist < 35.0) {
        if (ordered) found.push(closest);
        else if (!matched.has(closest)) { matched.add(closest); found.push(closest); }
      } else {
        unmatched.push({ rgb, closest, distance: minDist });
      }
    }
    return { found, unmatched };
  }

  // ------------------------------------------------------------------ //
  // PNG export (indexed)                                               //
  // ------------------------------------------------------------------ //

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  async function zlibCompress(data) {
    if (typeof CompressionStream !== 'undefined') {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // Fallback: zlib stream with uncompressed (stored) deflate blocks
    const blocks = Math.ceil(data.length / 65535) || 1;
    const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
    out[0] = 0x78; out[1] = 0x01;
    let o = 2;
    for (let b = 0; b < blocks; b++) {
      const start = b * 65535;
      const len = Math.min(65535, data.length - start);
      out[o++] = b === blocks - 1 ? 1 : 0;
      out[o++] = len & 255; out[o++] = len >> 8;
      out[o++] = ~len & 255; out[o++] = (~len >> 8) & 255;
      out.set(data.subarray(start, start + len), o);
      o += len;
    }
    let a = 1, b2 = 0;
    for (let i = 0; i < data.length; i++) { a = (a + data[i]) % 65521; b2 = (b2 + a) % 65521; }
    const adler = ((b2 << 16) | a) >>> 0;
    out[o++] = adler >>> 24; out[o++] = (adler >>> 16) & 255; out[o++] = (adler >>> 8) & 255; out[o++] = adler & 255;
    return out;
  }

  function pngChunk(type, data) {
    const chunk = new Uint8Array(12 + data.length);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
  }

  /** 8-bit indexed PNG with a 16-entry PLTE (+ tRNS when transparentIndex >= 0). */
  async function encodeIndexedPng(width, height, indices, paletteRgb, transparentIndex = -1) {
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, width); v.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

    const plte = new Uint8Array(paletteRgb.length * 3);
    paletteRgb.forEach((rgb, i) => plte.set(rgb, i * 3));

    const raw = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
      raw[y * (width + 1)] = 0;
      raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    }
    const idat = await zlibCompress(raw);
    const trns = [];
    if (transparentIndex >= 0 && transparentIndex < paletteRgb.length) {
      const alpha = new Uint8Array(transparentIndex + 1).fill(255);
      alpha[transparentIndex] = 0;
      trns.push(pngChunk('tRNS', alpha));
    }
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    return new Blob(
      [sig, pngChunk('IHDR', ihdr), pngChunk('PLTE', plte), ...trns, pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))],
      { type: 'image/png' }
    );
  }

  // ------------------------------------------------------------------ //
  // .p8 cart export                                                    //
  // ------------------------------------------------------------------ //

  /** Packs slot indices like the Python exporter (left pixel in low nibble). */
  function imageToCartBytes(indices, width, height) {
    const bytes = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x += 2) {
        const a = indices[y * width + x];
        const b = x + 1 < width ? indices[y * width + x + 1] : 0;
        bytes.push((b << 4) | a);
      }
    }
    return bytes;
  }

  /** FadeExportHandler._write_data_to_cart_sections (exportRawData port). */
  function writeCartSections(data) {
    const sections = {};
    const size = data.length;
    let pos = 0;

    if (pos < size) {
      const lines = [];
      let total = Math.min(size - pos, 0x2000);
      while (total > 0) {
        const len = Math.min(64, total);
        let line = '';
        for (let k = 0; k < len; k++) {
          const byte = data[pos++];
          line += (byte & 15).toString(16) + (byte >> 4).toString(16);
        }
        total -= len;
        lines.push(line);
      }
      sections.__gfx__ = lines.join('\n');
    }

    if (size > 0x2000 && pos < size) {
      const lines = [];
      let total = Math.min(size - pos, 0x1000);
      while (total > 0) {
        const len = Math.min(128, total);
        let line = '';
        for (let k = 0; k < len; k++) line += hex2(data[pos++]);
        total -= len;
        lines.push(line);
      }
      sections.__map__ = lines.join('\n');
    }

    if (size > 0x3000 && pos < size) {
      const lines = [];
      let written = 0;
      while (written < 0x100) {
        const len = Math.min(128, 0x100 - written);
        let line = '';
        for (let k = 0; k < len; k++) {
          let byte = 0;
          if (pos < size) byte = data[pos++];
          line += hex2(byte);
        }
        written += len;
        lines.push(line);
      }
      sections.__gff__ = lines.join('\n');
    }

    if (size > 0x3100 && pos < size) {
      const lines = [];
      let written = 0;
      while (written < 0x100) {
        let b0, b1, b2, b3;
        if (pos + 3 < size) {
          b0 = data[pos]; b1 = data[pos + 1]; b2 = data[pos + 2]; b3 = data[pos + 3];
          pos += 4;
        } else {
          b0 = pos < size ? data[pos] : 0;
          pos += 1;
          b1 = pos < size ? data[pos] : 0;
          pos += pos < size ? 1 : 0;
          b2 = pos < size ? data[pos] : 0;
          pos += pos < size ? 1 : 0;
          b3 = pos < size ? data[pos] : 0;
          pos += pos < size ? 1 : 0;
        }
        const flags =
          (((b3 & 128) >> 7) << 3) | (((b2 & 128) >> 7) << 2) | (((b1 & 128) >> 7) << 1) | ((b0 & 128) >> 7);
        lines.push(`${hex2(flags)} ${hex2(b0 & 127)}${hex2(b1 & 127)}${hex2(b2 & 127)}${hex2(b3 & 127)}`);
        written += 4;
      }
      sections.__music__ = lines.join('\n');
    }

    if (size > 0x3200 && pos < size) {
      const lines = [];
      let total = Math.min(size - pos, 0x1100);
      while (total > 0 && pos < size) {
        let line = '';
        for (let j = 0; j < 4; j++) line += hex2(pos + 64 + j < size ? data[pos + 64 + j] : 0);
        for (let j = 0; j < 32; j++) {
          let lsb, msb;
          if (pos + 1 < size) {
            lsb = data[pos]; msb = data[pos + 1];
            pos += 2;
          } else {
            lsb = pos < size ? data[pos] : 0;
            pos += pos < size ? 1 : 0;
            msb = 0;
          }
          const pitch = lsb & 0x3f;
          let waveform = ((msb & 0x80) >> 4) | ((msb & 0x01) << 2) | ((lsb & 0xc0) >> 6);
          waveform = Math.max(0, Math.min(15, waveform));
          const volume = (msb & 0x0e) >> 1;
          const effect = (msb & 0x70) >> 4;
          line += hex2(pitch) + waveform.toString(16) + volume.toString(16) + effect.toString(16);
        }
        lines.push(line);
        total -= 68;
        pos += 4;
      }
      sections.__sfx__ = lines.join('\n');
    }
    return sections;
  }

  function buildDataCart(indices, width, height) {
    const used = [...new Set(indices)].sort((a, b) => a - b);
    const paletteCode = `-- pal(${used.join(',')})`;
    const sections = writeCartSections(imageToCartBytes(indices, width, height));
    let cart = `pico-8 cartridge // http://www.pico-8.com\nversion 41\n__lua__\n-- image data cart\n${paletteCode}\n\n`;
    if (sections.__gfx__) cart += `__gfx__\n${sections.__gfx__}\n`;
    if (sections.__map__) cart += `\n__map__\n${sections.__map__}\n`;
    if (sections.__gff__) cart += `\n__gff__\n${sections.__gff__}\n`;
    if (sections.__music__) cart += `\n__music__\n${sections.__music__}\n\n`;
    if (sections.__sfx__) cart += `\n__sfx__\n${sections.__sfx__}\n\n`;
    return cart;
  }

  function buildViewerCart(width, height, dataName, paletteEntries) {
    const maxScrollX = Math.max(0, width - 128);
    const maxScrollY = Math.max(0, height - 128);
    const totalBytes = Math.min(Math.floor((width * height) / 2), 0x4300);
    const palLines = ['  -- apply palette'];
    paletteEntries.forEach((p, i) => { if (p != null && p !== i) palLines.push(`  pal(${i},${p},1)`); });
    const paletteCode = palLines.join('\n');

    return `pico-8 cartridge // http://www.pico-8.com
version 41
__lua__
-- image viewer
${paletteCode}

scroll_x=0
scroll_y=0

function _init()
  -- apply palette
${paletteCode}
  -- load entire image data from data cart
  reload(0x0000, 0x0000, 0x${totalBytes.toString(16)}, "${dataName}.p8")
end

function _update()
  if btn(0) then scroll_x=max(0,scroll_x-2) end
  if btn(1) then scroll_x=min(${maxScrollX},scroll_x+2) end
  if btn(2) then scroll_y=max(0,scroll_y-2) end
  if btn(3) then scroll_y=min(${maxScrollY},scroll_y+2) end
end

function _draw()
  cls(0)
  for y=0,127 do
    for x=0,127 do
      local img_x=scroll_x+x
      local img_y=scroll_y+y
      if img_x<${width} and img_y<${height} then
        local addr=img_y*${Math.floor(width / 2)}+flr(img_x/2)
        local byte_val=peek(addr)
        local col
        -- note: __gfx__ stores low nibble=left pixel, high nibble=right pixel
        if img_x%2==0 then
          col=band(byte_val,0xf)
        else
          col=shr(byte_val,4)
        end
        pset(x,y,col)
      end
    end
  end
end

__gfx__
`;
  }

  // ------------------------------------------------------------------ //
  // Presets (.p8pal / .json, version 4)                                //
  // ------------------------------------------------------------------ //

  function presetToDict(p) {
    return {
      version: 4,
      palette_name: p.palette_name,
      palette_indices: p.palette_indices,
      fade_target_index: p.fade_target_index,
      ramps: p.ramps,
      steps: p.steps,
      gamma: p.gamma,
      cov_min: p.cov_min,
      cov_max: p.cov_max,
      dark_ramps: p.dark_ramps,
      dark_target_index: p.dark_target_index,
      bright_ramps: p.bright_ramps,
      bright_target_index: p.bright_target_index,
    };
  }

  /** FadePreset.from_dict, plus sanitising of values coming from disk. */
  function presetFromDict(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Preset must be a JSON object.');
    const version = Number(data.version ?? 1);
    const pico = (v) => (isValidPico(v) ? v : null);
    const slot = (v) => (Number.isInteger(v) && v >= 0 && v < 16 ? v : null);
    const normRamps = (raw) => {
      if (!Array.isArray(raw)) return null;
      return Array.from({ length: 16 }, (_, r) => {
        const row = Array.isArray(raw[r]) ? raw[r] : [];
        return Array.from({ length: STOPS_PER_ROW }, (_, c) => pico(row[c]));
      });
    };

    const paletteRaw = Array.isArray(data.palette_indices) ? data.palette_indices : [];
    const palette_indices = Array.from({ length: 16 }, (_, i) => pico(paletteRaw[i]));
    const ramps = normRamps(data.ramps) || emptyStops();
    const fade_target_index = slot(data.fade_target_index);
    const gamma = Number.isFinite(Number(data.gamma)) ? Number(data.gamma) : 1.0;
    const cov_min = version >= 3 ? parseInt(data.cov_min ?? 0, 10) || 0 : 0;
    const cov_max = version >= 3 ? (Number.isFinite(parseInt(data.cov_max, 10)) ? parseInt(data.cov_max, 10) : 16) : 16;

    let dark_ramps, dark_target_index, bright_ramps = null, bright_target_index = null;
    if (version >= 4) {
      dark_ramps = normRamps(data.dark_ramps);
      dark_target_index = slot(data.dark_target_index);
      bright_ramps = normRamps(data.bright_ramps);
      bright_target_index = slot(data.bright_target_index);
    } else {
      dark_ramps = ramps;
      dark_target_index = fade_target_index;
    }

    return {
      palette_name: typeof data.palette_name === 'string' ? data.palette_name : 'Untitled Palette',
      palette_indices,
      fade_target_index,
      ramps,
      steps: parseInt(data.steps ?? 32, 10) || 32,
      gamma,
      cov_min,
      cov_max,
      dark_ramps,
      dark_target_index,
      bright_ramps,
      bright_target_index,
    };
  }

  /** ConfigManager._save_config format (one ramp per line). */
  function rampPresetsToConfigJson(presets) {
    const lines = presets.map((r, i) => `    ${JSON.stringify(r).replace(/,/g, ', ')}${i < presets.length - 1 ? ',' : ''}`);
    return `{\n  "version": "1.0.1",\n  "ramp_presets": [\n${lines.join('\n')}${lines.length ? '\n' : ''}  ]\n}\n`;
  }

  function rampPresetsFromConfig(data) {
    const list = Array.isArray(data) ? data : data && data.ramp_presets;
    if (!Array.isArray(list)) throw new Error('No "ramp_presets" list found.');
    return list
      .filter(Array.isArray)
      .map((r) => r.filter(isValidPico))
      .filter((r) => r.length);
  }

  return {
    SYSTEM_COLORS, BASE_INDICES, HIDDEN_INDICES, DEFAULT_RAMP_PRESETS, STOPS_PER_ROW, FADE_STEPS,
    rgbOf, isValidPico, lum601, lum709, pyRound,
    emptyPalette, emptyStops, cloneStops, fullPalette, fullPaletteRgb, usedColorIndices, slotIndexOfPico,
    findFadeTargetSlot, resolveTargetSlot, buildSlotRamps, generateWithRamps, combineTwoSided, sliderToStep,
    autoFillStops, paletteToLua, paletteToGpl, fadeToLua,
    renderFade, nearestSlot, quantize, renderImageFade, isValidPreviewSize,
    autoAssignMapping, convertGreyscaleManual,
    parsePngPalette, uniqueColors, matchColorsToPico8, encodeIndexedPng, zlibCompress, crc32,
    buildDataCart, buildViewerCart,
    presetToDict, presetFromDict, rampPresetsToConfigJson, rampPresetsFromConfig,
  };
})();

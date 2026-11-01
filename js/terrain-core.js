// js/terrain-core.js
// Terrain Lab engine (port of terrain_lab_v0_4): seamless heightfield from periodic noise or an imported
// heightmap, sculpt stamps (incl. text / image stamps), water / wind / thermal erosion, shape adjustments,
// baked lighting and the PICO-8 conversion (128x128 colors in 16 of the 32 colors, 4-bit heights).
//
// P8TerrainEngine() is self-contained (no globals), so the same source runs in the Web Workers
// (P8Terrain.workerUrl()) and in Node for tests. Every stage of a build is cached separately:
//   fields (noise) -> base -> sculpt (stamps, incremental + stroke checkpoints) -> weather -> adjust -> shade
// A lighting change only re-shades; a new brush stamp only applies that stamp (plus weathering, if any).

'use strict';

function P8TerrainEngine() {
  const TAU = Math.PI * 2;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const wrap = (v, n) => { v %= n; return v < 0 ? v + n : v; };

  // ---------------------------------------------------------------- noise
  function hash(x, y, s) {
    let h = Math.imul(x ^ s, 374761393) + Math.imul(y ^ s, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  const G = new Float64Array([1, 0, -1, 0, 0, 1, 0, -1, 0.7071, 0.7071, -0.7071, 0.7071, 0.7071, -0.7071, -0.7071, -0.7071]);
  /** gradient index (x2) for every lattice point of a periodic noise with period p */
  function gradTable(p, s) {
    const t = new Uint8Array(p * p);
    for (let y = 0; y < p; y++) for (let x = 0; x < p; x++) t[y * p + x] = (hash(x, y, s) & 7) * 2;
    return t;
  }
  /** periodic gradient noise (period p lattice cells), same values as v0.4's noise() */
  function noiseT(x, y, p, t) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    let x0 = xi % p; if (x0 < 0) x0 += p;
    let y0 = yi % p; if (y0 < 0) y0 += p;
    const x1 = x0 + 1 === p ? 0 : x0 + 1, y1 = y0 + 1 === p ? 0 : y0 + 1;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    let g = t[y0 * p + x0]; const a = G[g] * fx + G[g + 1] * fy;
    g = t[y0 * p + x1]; const b = G[g] * (fx - 1) + G[g + 1] * fy;
    g = t[y1 * p + x0]; const c = G[g] * fx + G[g + 1] * (fy - 1);
    g = t[y1 * p + x1]; const d = G[g] * (fx - 1) + G[g + 1] * (fy - 1);
    return (a + (b - a) * u + (c - a + (d - c - b + a) * u) * v) * 1.55;
  }
  const tables = new Map();
  const table = (p, s) => { const k = `${p}:${s}`; let t = tables.get(k); if (!t) { if (tables.size > 64) tables.clear(); t = gradTable(p, s); tables.set(k, t); } return t; };

  function rngFactory(s) { let k = (s ^ 0x9e3779b9) >>> 0; return () => { k ^= k << 13; k ^= k >>> 17; k ^= k << 5; return (k >>> 0) / 4294967296; }; }

  // ---------------------------------------------------------------- caches
  let fieldCache = null, baseCache = null, sculptCache = null, weatherCache = null, adjustCache = null, shadeCache = null;
  const bitmaps = new Map();   // id -> {w, h, data: Uint8Array}
  const imports = new Map();   // id -> {size, data: Float32Array 0..1}
  const importCache = new Map(); // `${id}:${n}` -> Float32Array

  function getFields(p, n, seed) {
    const key = [n, seed, p.scale, p.octaves, p.warp].join(':');
    if (fieldCache && fieldCache.key === key) return fieldCache;
    const size = n * n, oct = p.octaves | 0;
    const layers = Array.from({ length: oct }, () => new Float32Array(size)), variation = new Float32Array(size);
    const freqs = layers.map((_, o) => p.scale * Math.pow(2, o));
    const lt = freqs.map((f, o) => table(f, seed + o * 77));
    const w0 = table(2, seed + 60), w1 = table(2, seed + 61), vt = table(24, seed + 913);
    let i = 0;
    for (let y = 0; y < n; y++) {
      const v = y / n;
      for (let x = 0; x < n; x++, i++) {
        const u = x / n;
        const wx = p.warp ? p.warp * noiseT(u * 2, v * 2, 2, w0) : 0, wy = p.warp ? p.warp * noiseT(u * 2, v * 2, 2, w1) : 0;
        for (let o = 0; o < oct; o++) layers[o][i] = noiseT((u + wx) * freqs[o], (v + wy) * freqs[o], freqs[o], lt[o]);
        variation[i] = noiseT(u * 24, v * 24, 24, vt);
      }
    }
    fieldCache = { key, layers, variation };
    baseCache = null;
    return fieldCache;
  }

  /** imported heightmap resampled (periodic bilinear) to n x n */
  function importAt(id, n) {
    const k = `${id}:${n}`;
    if (importCache.has(k)) return importCache.get(k);
    const im = imports.get(id);
    if (!im) return null;
    const out = new Float32Array(n * n), m = im.size, s = m / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[y * n + x] = bilinear(im.data, m, (x + 0.5) * s - 0.5, (y + 0.5) * s - 0.5);
    if (importCache.size > 8) importCache.clear();
    importCache.set(k, out);
    return out;
  }

  function getBase(p, n, seed) {
    const fields = getFields(p, n, seed);
    const imp = p.importId ? `${p.importId}:${p.importMix}` : '';
    const key = [fields.key, p.base, p.relief, p.roughness, p.ridges, p.flatness, imp].join(':');
    if (baseCache && baseCache.key === key) return baseCache;
    const size = n * n, h = new Float32Array(size), oct = fields.layers.length, amps = new Float64Array(oct);
    let amp = 1, total = 0;
    for (let o = 0; o < oct; o++) { amps[o] = amp; total += amp; amp *= p.roughness; }
    const ridges = p.ridges, flat = 1 + p.flatness * 1.8, relief = p.relief * 1.45, base = p.base;
    const im = p.importId ? importAt(p.importId, n) : null, mix = im ? clamp(+p.importMix) : 0;
    for (let i = 0; i < size; i++) {
      let value = 0;
      for (let o = 0; o < oct; o++) { const a = fields.layers[o][i]; value += (a * (1 - ridges) + (1 - 2 * Math.abs(a)) * ridges) * amps[o]; }
      let q = value / total;
      q = Math.sign(q) * Math.pow(Math.abs(q), flat);
      let v = base + q * relief;
      // imported heights span the same range as noise at full profile height: base +- 1.45 * relief
      if (im) v = v * (1 - mix) + (base + (im[i] * 2 - 1) * relief) * mix;
      h[i] = clamp(v, 0.002, 0.998);
    }
    baseCache = { key, h };
    return baseCache;
  }

  // ---------------------------------------------------------------- sampling (n is a power of two)
  function bilinear(a, n, x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const x0 = wrap(xi, n), y0 = wrap(yi, n), x1 = x0 + 1 === n ? 0 : x0 + 1, y1 = y0 + 1 === n ? 0 : y0 + 1;
    return a[y0 * n + x0] * (1 - fx) * (1 - fy) + a[y0 * n + x1] * fx * (1 - fy) + a[y1 * n + x0] * (1 - fx) * fy + a[y1 * n + x1] * fx * fy;
  }

  // ---------------------------------------------------------------- stamps
  /** v0.4 smoothing (5x5 Gaussian scaled to the brush, optional bilateral), on a local copy only */
  function smoothStamp(h, n, s, r, cx, cy) {
    const mask = n - 1, extent = r * 1.28, extent2 = extent * extent;
    const stride = Math.max(1, Math.round(r * 0.165)), offsets = [-2 * stride, -stride, 0, stride, 2 * stride];
    const weights = [1, 4, 6, 4, 1], preserve = !!s.preserveRidges;
    const threshold = 0.0125, invThreshold2 = 1 / (threshold * threshold);
    const strength = clamp(s.power * 1.35, 0, 1), featherStart = 0.78;
    // the filter reads the unmodified heights: copy the window it can reach
    const x0 = Math.ceil(cx - extent) - 2 * stride, y0 = Math.ceil(cy - extent) - 2 * stride;
    const W = Math.floor(cx + extent) + 2 * stride - x0 + 1, H = Math.floor(cy + extent) + 2 * stride - y0 + 1;
    const src = new Float32Array(W * H);
    for (let yy = 0; yy < H; yy++) { const row = ((y0 + yy) & mask) * n; for (let xx = 0; xx < W; xx++) src[yy * W + xx] = h[row + ((x0 + xx) & mask)]; }
    for (let y = Math.ceil(cy - extent); y <= Math.floor(cy + extent); y++) {
      const dy = y - cy, dy2 = dy * dy, row = (y & mask) * n;
      for (let x = Math.ceil(cx - extent); x <= Math.floor(cx + extent); x++) {
        const dx = x - cx, d2 = dx * dx + dy2;
        if (d2 >= extent2) continue;
        const dist = Math.sqrt(d2) / r;
        let fade = clamp((1.28 - dist) / (1.28 - featherStart));
        fade = fade * fade * (3 - 2 * fade);
        const id = row + (x & mask), lx = x - x0, ly = y - y0, center = src[ly * W + lx];
        let acc = 0, wsum = 0;
        for (let j = 0; j < 5; j++) {
          const sy = (ly + offsets[j]) * W + lx, wy = weights[j];
          for (let i = 0; i < 5; i++) {
            const v = src[sy + offsets[i]];
            let w = wy * weights[i];
            if (preserve) { const delta = v - center, z = delta * delta * invThreshold2; w /= 1 + z * z; }
            acc += v * w; wsum += w;
          }
        }
        h[id] = center + (acc / wsum - center) * fade * strength;
      }
    }
  }

  /** text / image stamp: a grey bitmap (0..255) placed at x,y, size = width in tiles, angle in degrees */
  function bitmapStamp(h, n, s) {
    const bm = bitmaps.get(s.bmp);
    if (!bm) return;
    const mask = n - 1, W = Math.max(1, s.size * n), H = W * bm.h / bm.w;
    const cx = s.x * n, cy = s.y * n, a = (s.angle || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    const R = Math.hypot(W, H) / 2 + 1, depth = s.depth * 0.15, plateau = s.mode === 'plateau';
    const level = clamp((s.level ?? 0.5) + depth);
    const sx = bm.w / W, sy = bm.h / H, d = bm.data, bw = bm.w, bh = bm.h;
    for (let y = Math.ceil(cy - R); y <= Math.floor(cy + R); y++) {
      const py = y - cy, row = (y & mask) * n;
      for (let x = Math.ceil(cx - R); x <= Math.floor(cx + R); x++) {
        const px = x - cx;
        // rotate back into the bitmap's frame
        const u = (px * ca + py * sa) * sx + bw / 2 - 0.5, v = (-px * sa + py * ca) * sy + bh / 2 - 0.5;
        if (u <= -1 || v <= -1 || u >= bw || v >= bh) continue;
        const ui = Math.floor(u), vi = Math.floor(v), fu = u - ui, fv = v - vi;
        const in0 = vi >= 0, in1 = vi + 1 < bh, l0 = ui >= 0, l1 = ui + 1 < bw, r0 = vi * bw, r1 = r0 + bw;
        const a00 = in0 && l0 ? d[r0 + ui] : 0, a10 = in0 && l1 ? d[r0 + ui + 1] : 0, a01 = in1 && l0 ? d[r1 + ui] : 0, a11 = in1 && l1 ? d[r1 + ui + 1] : 0;
        const al = ((a00 * (1 - fu) + a10 * fu) * (1 - fv) + (a01 * (1 - fu) + a11 * fu) * fv) / 255;
        if (al <= 0) continue;
        const id = row + (x & mask);
        h[id] = plateau ? h[id] + (level - h[id]) * al : h[id] + depth * al;
      }
    }
  }

  function applyStamp(h, wet, protect, n, s) {
    if (s.tool === 'bitmap') { bitmapStamp(h, n, s); return; }
    const mask = n - 1, r = Math.max(1, s.r * n), cx = s.x * n, cy = s.y * n, k = s.power;
    if (s.tool === 'crater') {
      for (let y = Math.ceil(cy - r * 1.28); y <= Math.floor(cy + r * 1.28); y++) {
        const row = (y & mask) * n;
        for (let x = Math.ceil(cx - r * 1.28); x <= Math.floor(cx + r * 1.28); x++) {
          const px = x - cx, py = y - cy, d2 = (px * px + py * py) / (r * r);
          if (d2 > 1.6384) continue;
          const d = Math.sqrt(d2);
          const bowl = d < 1 ? -k * 0.115 * Math.pow(1 - d2, 2) : 0;
          const rim = k * 0.115 * s.rim * Math.exp(-Math.pow((d - 0.93) / 0.155, 2)) * 0.49;
          h[row + (x & mask)] += bowl + rim;
        }
      }
      return;
    }
    if (s.tool === 'smooth') { smoothStamp(h, n, s, r, cx, cy); return; }
    const rough = s.tool === 'roughen' ? table(64, (s.id * 7919) | 0) : null;
    for (let y = Math.ceil(cy - r); y <= Math.floor(cy + r); y++) {
      const row = (y & mask) * n;
      for (let x = Math.ceil(cx - r); x <= Math.floor(cx + r); x++) {
        const dx = (x - cx) / r, dy = (y - cy) / r, d2 = dx * dx + dy * dy;
        if (d2 >= 1) continue;
        const w = (1 - d2) * (1 - d2) * k, id = row + (x & mask);
        if (s.tool === 'raise') h[id] += w * 0.013;
        else if (s.tool === 'lower') h[id] -= w * 0.013;
        else if (s.tool === 'flatten') h[id] += (s.level - h[id]) * w * 0.5;
        else if (s.tool === 'roughen') h[id] += w * 0.012 * noiseT(((x & mask) / n) * 64, ((y & mask) / n) * 64, 64, rough);
        else if (s.tool === 'erode' && wet) wet[id] = clamp(wet[id] + w * 0.85, 0, 2);
        else if (s.tool === 'protect' && protect) protect[id] = clamp(protect[id] + w, 0, 1);
      }
    }
  }

  // ---------------------------------------------------------------- weathering (v0.4 models, masked indexing)
  function erode(h, wet, protect, n, p, stamps, rng, maxSteps = 46) {
    const count = Math.round(p.droplets * p.erosion);
    if (!count) return;
    const mask = n - 1, sources = stamps.filter((s) => s.tool === 'erode');
    for (let d = 0; d < count; d++) {
      let x = rng() * n, y = rng() * n;
      if (sources.length && rng() < 0.72) {
        const s = sources[(rng() * sources.length) | 0], a = TAU * rng(), r = Math.sqrt(rng()) * s.r * n;
        x = wrap(s.x * n + Math.cos(a) * r, n); y = wrap(s.y * n + Math.sin(a) * r, n);
      }
      let dx = 0, dy = 0, speed = 1, water = 1, sediment = 0;
      for (let step = 0; step < maxSteps; step++) {
        // height and gradient at (x, y)
        const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
        const x0 = ix & mask, x1 = (ix + 1) & mask, r0 = (iy & mask) * n, r1 = ((iy + 1) & mask) * n;
        const i00 = r0 + x0, i10 = r0 + x1, i01 = r1 + x0, i11 = r1 + x1;
        const h00 = h[i00], h10 = h[i10], h01 = h[i01], h11 = h[i11];
        const hc = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
        dx = dx * 0.35 - ((h10 - h00) * (1 - fy) + (h11 - h01) * fy) * 0.65;
        dy = dy * 0.35 - ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * 0.65;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-9) { const a = rng() * TAU; dx = Math.cos(a); dy = Math.sin(a); } else { dx /= len; dy /= len; }
        let nx = x + dx, ny = y + dy;
        if (nx < 0) nx += n; else if (nx >= n) nx -= n;
        if (ny < 0) ny += n; else if (ny >= n) ny -= n;
        // height at the next position
        const jx = Math.floor(nx), jy = Math.floor(ny), gx = nx - jx, gy = ny - jy;
        const q0 = (jy & mask) * n, q1 = ((jy + 1) & mask) * n, k0 = jx & mask, k1 = (jx + 1) & mask;
        const hn = h[q0 + k0] * (1 - gx) * (1 - gy) + h[q0 + k1] * gx * (1 - gy) + h[q1 + k0] * (1 - gx) * gy + h[q1 + k1] * gx * gy;
        const delta = hn - hc, id = (Math.round(y) & mask) * n + (Math.round(x) & mask);
        const local = clamp((1 + wet[id] * 2) * (1 - protect[id] * 0.95), 0.02, 5), cap = Math.max(-delta * speed * water * 8, 0.00003);
        let amount;
        if (sediment > cap || delta > 0) { amount = delta > 0 ? Math.min(sediment, delta) * 0.5 : (sediment - cap) * 0.28; sediment -= amount; }
        else { amount = -Math.min((cap - sediment) * 0.22, 0.0017 * local) * p.erosion * local; sediment -= amount; }
        // deposit (amount > 0) or erode (amount < 0) bilinearly at (x, y)
        h[i00] += amount * (1 - fx) * (1 - fy); h[i10] += amount * fx * (1 - fy); h[i01] += amount * (1 - fx) * fy; h[i11] += amount * fx * fy;
        speed = Math.sqrt(Math.max(0.1, speed * speed + Math.max(-delta, 0) * 3));
        water *= 0.97; x = nx; y = ny;
        if (water < 0.08) break;
      }
    }
  }

  function thermal(h, n, iterations) {
    if (!iterations) return;
    const delta = new Float32Array(n * n), mask = n - 1;
    for (let k = 0; k < iterations; k++) {
      delta.fill(0);
      for (let y = 0; y < n; y++) {
        const row = y * n, up = ((y - 1) & mask) * n, down = ((y + 1) & mask) * n;
        for (let x = 0; x < n; x++) {
          const i = row + x, h0 = h[i], a = row + ((x - 1) & mask), b = row + ((x + 1) & mask), c = up + x, d = down + x;
          let v = h0 - h[a] - 0.0013; if (v > 0) { v *= 0.07; delta[i] -= v; delta[a] += v; }
          v = h0 - h[b] - 0.0013; if (v > 0) { v *= 0.07; delta[i] -= v; delta[b] += v; }
          v = h0 - h[c] - 0.0013; if (v > 0) { v *= 0.07; delta[i] -= v; delta[c] += v; }
          v = h0 - h[d] - 0.0013; if (v > 0) { v *= 0.07; delta[i] -= v; delta[d] += v; }
        }
      }
      for (let i = 0; i < h.length; i++) h[i] += delta[i];
    }
  }

  function windErode(h, wet, protect, n, p) {
    const strength = clamp(+p.wind || 0), steps = Math.max(0, Math.round(+p.windSteps || 0));
    if (!strength || !steps) return;
    const mask = n - 1, angle = (+p.windDirection || 0) * Math.PI / 180, hop = Math.max(2, Math.round(n / 192 * (1 + strength)));
    let dx = Math.round(Math.cos(angle) * hop);
    const dy = Math.round(Math.sin(angle) * hop);
    if (dx === 0 && dy === 0) dx = 1;
    const size = n * n, diff = new Float32Array(size), amplitude = strength * 0.48;
    // protection and wetness do not change during the pass
    const local = new Float64Array(size).fill(1), damp = new Float64Array(size).fill(1);
    if (protect) for (let i = 0; i < size; i++) local[i] = Math.max(0.03, 1 - protect[i] * 0.96);
    if (wet) for (let i = 0; i < size; i++) damp[i] = Math.max(0.25, 1 - wet[i] * 0.45);
    // column offsets of the upwind source and downwind destination, per x
    const xp = new Int32Array(n), xd = new Int32Array(n);
    for (let x = 0; x < n; x++) { xp[x] = (x - dx) & mask; xd[x] = (x + dx) & mask; }
    for (let t = 0; t < steps; t++) {
      diff.fill(0);
      for (let y = 0; y < n; y++) {
        const row = y * n, up = ((y - dy) & mask) * n, down = ((y + dy) & mask) * n;
        for (let x = 0; x < n; x++) {
          const i = row + x;
          let rise = h[i] - h[up + xp[x]];
          if (rise < 0) rise = 0;
          let m = amplitude * (0.0001 + rise * 0.31);
          if (m > 0.0035) m = 0.0035;
          const amount = m * local[i] * damp[i];
          diff[i] -= amount; diff[down + xd[x]] += amount;
        }
      }
      for (let i = 0; i < size; i++) h[i] += diff[i];
    }
  }

  function applyWeathering(h, wet, protect, n, pass, stamps, seed, idx, preview) {
    const water = clamp(Number(pass.erosion) || 0), drops = Math.max(0, Math.round(Number(pass.droplets) || 0));
    if (water && drops) {
      const q = { erosion: water, droplets: preview ? Math.min(900, Math.round(drops * 0.07)) : drops };
      erode(h, wet, protect, n, q, stamps, rngFactory(seed + 31 + idx * 12289), preview ? 20 : 46);
    }
    const windPass = preview ? { ...pass, windSteps: Math.min(5, Math.ceil((+pass.windSteps || 0) * 0.25)) } : pass;
    windErode(h, wet, protect, n, windPass);
    thermal(h, n, preview ? Math.min(2, Math.ceil((+pass.thermal || 0) * 0.3)) : (+pass.thermal || 0));
  }

  // ---------------------------------------------------------------- stages
  const MAX_CHECKPOINTS = 8;
  /** stamps applied on top of the base; reuses the previous result or a stroke checkpoint */
  function getSculpt(base, n, stamps, strokeStarts) {
    const ids = stamps.map((s) => s.id);
    const needAux = stamps.some((s) => s.tool === 'erode' || s.tool === 'protect');
    let c = sculptCache;
    if (!c || c.base !== base.key || c.n !== n || c.aux !== needAux) {
      c = sculptCache = { base: base.key, n, aux: needAux, ids: [], h: base.h.slice(), wet: needAux ? new Float32Array(n * n) : null, protect: needAux ? new Float32Array(n * n) : null, checkpoints: [] };
    }
    const prefix = (a, b, k) => { if (a.length < k || b.length < k) return false; for (let i = 0; i < k; i++) if (a[i] !== b[i]) return false; return true; };
    if (!prefix(ids, c.ids, c.ids.length)) {
      // restore the longest checkpoint that still matches (undo of the last strokes), else start over
      let best = null;
      for (const cp of c.checkpoints) if (cp.ids.length <= ids.length && prefix(ids, cp.ids, cp.ids.length) && (!best || cp.ids.length > best.ids.length)) best = cp;
      c.ids = best ? best.ids.slice() : [];
      c.h = best ? best.h.slice() : base.h.slice();
      if (needAux) { c.wet = best ? best.wet.slice() : new Float32Array(n * n); c.protect = best ? best.protect.slice() : new Float32Array(n * n); }
      c.checkpoints = c.checkpoints.filter((cp) => prefix(ids, cp.ids, cp.ids.length));
    }
    const starts = new Set(strokeStarts || []);
    for (let k = c.ids.length; k < stamps.length; k++) {
      if (starts.has(k) && !c.checkpoints.some((cp) => cp.ids.length === k)) {
        c.checkpoints.push({ ids: c.ids.slice(), h: c.h.slice(), wet: c.wet?.slice(), protect: c.protect?.slice() });
        if (c.checkpoints.length > MAX_CHECKPOINTS) c.checkpoints.shift();
      }
      applyStamp(c.h, c.wet, c.protect, n, stamps[k]);
      c.ids.push(stamps[k].id);
    }
    return { key: `${base.key}|${ids.join(',')}`, h: c.h, wet: c.wet, protect: c.protect };
  }

  function getWeather(sculpt, n, stamps, passes, seed, preview) {
    if (!passes.length) return { key: sculpt.key, h: sculpt.h };
    const key = `${sculpt.key}|${JSON.stringify(passes)}|${seed}|${preview}`;
    if (weatherCache && weatherCache.key === key) return weatherCache;
    const h = sculpt.h.slice();
    const wet = sculpt.wet ? sculpt.wet.slice() : new Float32Array(n * n), protect = sculpt.protect ? sculpt.protect.slice() : new Float32Array(n * n);
    for (let j = 0; j < passes.length; j++) applyWeathering(h, wet, protect, n, passes[j], stamps, seed, j, preview);
    weatherCache = { key, h };
    return weatherCache;
  }

  /** stamps marked `post` (crisp text / images) go on after the weathering */
  let postCache = null;
  function getPost(weather, post) {
    if (!post.length) return weather;
    const key = `${weather.key}|post:${post.map((s) => s.id).join(',')}`;
    if (postCache && postCache.key === key) return postCache;
    const h = weather.h.slice(), n = Math.round(Math.sqrt(h.length));
    for (const s of post) applyStamp(h, null, null, n, s);
    postCache = { key, h };
    return postCache;
  }

  const ADJUST_KEYS = ['invert', 'gamma', 'terraces', 'terraceSoft', 'seaLevel'];
  /** shape adjustments on the normalized height (0 = lowest, 1 = highest point of the map) */
  function getAdjust(weather, p) {
    const key = `${weather.key}|${ADJUST_KEYS.map((k) => p[k]).join(':')}`;
    if (adjustCache && adjustCache.key === key) return adjustCache;
    const src = weather.h, h = new Float32Array(src.length);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < src.length; i++) { const v = clamp(src[i]); h[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const inv = !!p.invert, gamma = +p.gamma || 1, steps = Math.round(+p.terraces || 0), soft = clamp(+p.terraceSoft || 0), sea = clamp(+p.seaLevel || 0);
    const water = sea > 0 ? new Uint8Array(src.length) : null;
    if (inv || gamma !== 1 || steps > 0 || sea > 0) {
      const range = Math.max(1e-6, hi - lo);
      for (let i = 0; i < h.length; i++) {
        let t = (h[i] - lo) / range;
        if (inv) t = 1 - t;
        if (gamma !== 1) t = Math.pow(t, gamma);
        if (steps > 0) {
          const f = t * steps, k = Math.floor(f), fr = f - k;
          // flat treads with a riser of width "soft" (0 = hard step)
          const rise = soft > 0 ? clamp((fr - (1 - soft)) / soft) : 0;
          t = Math.min(1, (k + rise * rise * (3 - 2 * rise)) / steps);
        }
        if (water && t <= sea) { t = sea; water[i] = 1; }
        h[i] = lo + t * range;
      }
    }
    adjustCache = { key, h, water, lo, hi };
    return adjustCache;
  }

  const MATERIALS = {
    desert: { c: [[39, 35, 37], [87, 77, 70], [141, 124, 99], [185, 165, 122], [221, 202, 163], [244, 224, 181]], rock: 0.56, water: [40, 92, 128] },
    volcanic: { c: [[17, 20, 25], [43, 46, 49], [70, 66, 66], [103, 87, 78], [145, 117, 97], [190, 157, 128]], rock: 0.58, water: [180, 60, 20] },
    moss: { c: [[23, 43, 43], [43, 72, 56], [76, 105, 71], [117, 126, 82], [154, 144, 102], [206, 186, 145]], rock: 0.56, water: [36, 84, 120] },
    lunar: { c: [[27, 30, 38], [58, 65, 76], [98, 108, 116], [140, 145, 148], [187, 189, 188], [227, 226, 216]], rock: 0.68, water: [50, 56, 70] },
    alien: { c: [[28, 25, 48], [69, 39, 72], [110, 65, 99], [164, 90, 112], [209, 135, 119], [245, 186, 147]], rock: 0.56, water: [40, 160, 140] },
    alpine: { c: [[34, 52, 40], [58, 88, 52], [96, 110, 70], [118, 112, 104], [170, 170, 172], [246, 248, 252]], rock: 0.6, water: [34, 88, 140] },
    tropical: { c: [[220, 200, 140], [168, 176, 92], [72, 140, 60], [44, 108, 52], [96, 98, 84], [160, 150, 130]], rock: 0.6, water: [30, 120, 190] },
  };
  const SHADE_KEYS = ['palette', 'colorVariation', 'rock', 'azimuth', 'elevation', 'normalScale', 'ambient', 'shadow', 'shadowReach'];

  function shade(p, adj, n, variation, preview) {
    const key = `${adj.key}|${SHADE_KEYS.map((k) => p[k]).join(':')}|${preview}`;
    if (shadeCache && shadeCache.key === key) return shadeCache;
    const h = adj.h, mask = n - 1, size = n * n, light = new Uint8ClampedArray(size * 4), albedo = new Uint8ClampedArray(size * 4);
    const mat = MATERIALS[p.palette] || MATERIALS.desert, palette = mat.c;
    const az = p.azimuth * Math.PI / 180, el = p.elevation * Math.PI / 180;
    const lx = Math.cos(az) * Math.cos(el), ly = Math.sin(az) * Math.cos(el), lz = Math.sin(el);
    const scale = n * 0.5 * p.normalScale, ambient = p.ambient, reach = p.shadowReach, opacity = p.shadow;
    // shadow ray steps scale with the resolution, so preview and final look alike
    const reachPx = reach * n / 512;
    const steps = reach > 0 && opacity > 0 ? Math.min(preview ? 8 : 18, Math.ceil(reachPx / 3)) : 0;
    const sxr = new Int32Array(steps), syr = new Int32Array(steps), zr = new Float32Array(steps);
    for (let j = 1; j <= steps; j++) {
      const dist = j * reachPx / steps;
      sxr[j - 1] = Math.round(Math.cos(az) * dist); syr[j - 1] = Math.round(Math.sin(az) * dist);
      zr[j - 1] = Math.tan(el) * dist / n / p.normalScale;
    }
    const m0 = p.base - p.relief * 0.65, m1 = p.base + p.relief * 0.7, invRange = 1 / Math.max(0.01, m1 - m0), rock = p.rock;
    const rockShade = mat.rock, variationStrength = p.colorVariation * 0.12, top = palette.length - 1;
    const water = adj.water, wc = mat.water;
    for (let y = 0; y < n; y++) {
      const row = y * n, up = ((y - 1) & mask) * n, down = ((y + 1) & mask) * n;
      for (let x = 0; x < n; x++) {
        const idx = row + x, o = idx * 4, ht = h[idx];
        const sx = (h[row + ((x + 1) & mask)] - h[row + ((x - 1) & mask)]) * scale;
        const sy = (h[down + x] - h[up + x]) * scale, inv = 1 / Math.sqrt(1 + sx * sx + sy * sy);
        const diffuse = clamp((-sx * lx - sy * ly + lz) * inv);
        let r, g, bl;
        if (water && water[idx]) {
          const v = variation[idx] * 0.08 + 1;
          r = wc[0] * v; g = wc[1] * v; bl = wc[2] * v;
        } else {
          const t = clamp((ht - m0) * invRange + variation[idx] * variationStrength) * top;
          const k = Math.min(top - 1, Math.floor(t)), f = t - k, a = palette[k], b = palette[k + 1];
          const steep = clamp((Math.sqrt(sx * sx + sy * sy) - 0.18) * 0.7) * rock, mix = 1 - steep * (1 - rockShade);
          r = (a[0] + (b[0] - a[0]) * f) * mix; g = (a[1] + (b[1] - a[1]) * f) * mix; bl = (a[2] + (b[2] - a[2]) * f) * mix;
        }
        let sh = ambient + (1 - ambient) * diffuse * 1.25;
        for (let j = 0; j < steps; j++) {
          const xx = (x + sxr[j]) & mask, yy = (y + syr[j]) & mask;
          if (h[yy * n + xx] - ht > zr[j]) { sh *= 1 - opacity * 0.78; break; }
        }
        albedo[o] = r; albedo[o + 1] = g; albedo[o + 2] = bl; albedo[o + 3] = 255;
        light[o] = r * sh; light[o + 1] = g * sh; light[o + 2] = bl * sh; light[o + 3] = 255;
      }
    }
    shadeCache = { key, light, albedo };
    return shadeCache;
  }

  /** full build of a scene: {params, stamps, passes, strokeStarts}; n = params.resolution */
  function build(scene, preview, n = scene.params.resolution) {
    const p = scene.params, seed = p.seed | 0, all = scene.stamps || [], passes = scene.passes || [];
    // stroke starts index the full list: map them onto the stamps that go in before the weathering
    const stamps = [], post = [], index = new Int32Array(all.length + 1);
    // hidden edits (`off`, switched in the history window) are left out
    for (let i = 0; i < all.length; i++) { index[i] = stamps.length; if (!all[i].off) (all[i].post ? post : stamps).push(all[i]); }
    index[all.length] = stamps.length;
    const starts = (scene.strokeStarts || []).filter((k) => k <= all.length).map((k) => index[k]);
    const t = [performance.now()];
    const base = getBase(p, n, seed); t.push(performance.now());
    const sculpt = getSculpt(base, n, stamps, starts); t.push(performance.now());
    const weather = getPost(getWeather(sculpt, n, stamps, passes, seed, preview), post); t.push(performance.now());
    const adj = getAdjust(weather, p); t.push(performance.now());
    const sh = shade(p, adj, n, fieldCache.variation, preview); t.push(performance.now());
    const ms = (i) => Math.round(t[i + 1] - t[i]);
    return { n, height: adj.h, water: adj.water, color: sh.light, albedo: sh.albedo, low: adj.lo, high: adj.hi, ms: Math.round(t[5] - t[0]), stages: { base: ms(0), sculpt: ms(1), weather: ms(2), adjust: ms(3), shade: ms(4) } };
  }

  /** worker protocol: {type:'assets', bitmaps, imports} | {type:'build', id, preview, scene, n} */
  function handle(msg, post) {
    if (msg.type === 'assets') {
      // assets never change under the same id: replace the set, keep every cache
      if (msg.bitmaps) { bitmaps.clear(); for (const [k, v] of Object.entries(msg.bitmaps)) bitmaps.set(k, v); }
      if (msg.imports) { imports.clear(); for (const [k, v] of Object.entries(msg.imports)) imports.set(k, v); for (const k of [...importCache.keys()]) if (!imports.has(k.split(':')[0])) importCache.delete(k); }
      return;
    }
    try {
      const r = build(msg.scene, !!msg.preview, msg.n);
      // the caches keep their arrays: send copies
      const height = r.height.slice(), color = r.color.slice(), albedo = r.albedo.slice(), water = r.water ? r.water.slice() : null;
      const tr = [height.buffer, color.buffer, albedo.buffer];
      if (water) tr.push(water.buffer);
      post({ id: msg.id, preview: !!msg.preview, n: r.n, height, color, albedo, water, low: r.low, high: r.high, ms: r.ms, stages: r.stages }, tr);
    } catch (err) {
      post({ id: msg.id, preview: !!msg.preview, error: String(err.stack || err) });
    }
  }

  // ---------------------------------------------------------------- heightmap import -> seamless tile
  /**
   * Grey values (0..1, w x h) -> seamless size x size tile.
   *   'blend':  cross-fade with a copy shifted by half a tile, so every seam lands where the
   *             other copy is continuous (keeps all features, softens a band of width blend)
   *   'edges':  linear correction per row and column so opposite edges meet (keeps the layout)
   *   'mirror': mirrored 2x2 (always seamless, features repeat mirrored)
   */
  function makeTileable(grey, w, h, size, method = 'blend', blend = 0.25) {
    // center square crop, resampled to size
    const side = Math.min(w, h), ox = (w - side) / 2, oy = (h - side) / 2;
    const sample = (x, y) => {
      x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
      const xi = Math.min(w - 2, Math.floor(x)), yi = Math.min(h - 2, Math.floor(y)), fx = x - xi, fy = y - yi;
      if (w < 2 || h < 2) return grey[0];
      return (grey[yi * w + xi] * (1 - fx) + grey[yi * w + xi + 1] * fx) * (1 - fy) + (grey[(yi + 1) * w + xi] * (1 - fx) + grey[(yi + 1) * w + xi + 1] * fx) * fy;
    };
    const out = new Float32Array(size * size);
    if (method === 'mirror') {
      const half = size / 2, s = side / half;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const mx = x < half ? x : size - 1 - x, my = y < half ? y : size - 1 - y;
        out[y * size + x] = sample(ox + (mx + 0.5) * s - 0.5, oy + (my + 0.5) * s - 0.5);
      }
      return out;
    }
    const s = side / size, src = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) src[y * size + x] = sample(ox + (x + 0.5) * s - 0.5, oy + (y + 0.5) * s - 0.5);
    if (method === 'edges') {
      out.set(src);
      for (let y = 0; y < size; y++) {
        const r = y * size, d = out[r + size - 1] - out[r];
        for (let x = 0; x < size; x++) out[r + x] -= d * (x / (size - 1) - 0.5);
      }
      for (let x = 0; x < size; x++) {
        const d = out[(size - 1) * size + x] - out[x];
        for (let y = 0; y < size; y++) out[y * size + x] -= d * (y / (size - 1) - 0.5);
      }
      // the last row/column now equal the first: blend them one pixel apart
      for (let y = 0; y < size; y++) { const r = y * size; const m = (out[r] + out[r + size - 1]) / 2; out[r] = out[r] * 0.5 + m * 0.5; out[r + size - 1] = out[r + size - 1] * 0.5 + m * 0.5; }
      normalize(out);
      return out;
    }
    // separable: blend with a copy shifted by half a tile along x (weight from the x distance to the
    // left/right edge only), then the same along y. Each step is seamless in its direction and keeps
    // the other one, and no point has a seam in both copies.
    const b = Math.max(1, clamp(blend, 0.02, 0.5) * size), half = size / 2;
    const wt = new Float32Array(size);
    for (let i = 0; i < size; i++) { const v = clamp(Math.min(i + 0.5, size - 0.5 - i) / b); wt[i] = v * v * (3 - 2 * v); }
    const tx = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const w = wt[x], sx = (x + half) % size;
      tx[y * size + x] = src[y * size + x] * w + src[y * size + sx] * (1 - w);
    }
    for (let y = 0; y < size; y++) {
      const w = wt[y], sy = (y + half) % size;
      for (let x = 0; x < size; x++) out[y * size + x] = tx[y * size + x] * w + tx[sy * size + x] * (1 - w);
    }
    normalize(out);
    return out;
  }
  function normalize(a) {
    let lo = Infinity, hi = -Infinity;
    for (const v of a) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const r = hi - lo || 1;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - lo) / r;
    return a;
  }

  // ---------------------------------------------------------------- PICO-8 conversion
  /** box average of a square n x n array (channels per pixel) to m x m */
  function downsample(arr, n, m, ch) {
    const out = new Float32Array(m * m * ch), ratio = n / m;
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const sx0 = Math.round(x * ratio), sx1 = Math.max(sx0 + 1, Math.round((x + 1) * ratio)), sy0 = Math.round(y * ratio), sy1 = Math.max(sy0 + 1, Math.round((y + 1) * ratio));
      const count = (sx1 - sx0) * (sy1 - sy0), di = (y * m + x) * ch;
      for (let iy = sy0; iy < sy1; iy++) for (let ix = sx0; ix < sx1; ix++) { const idx = ((iy % n) * n + (ix % n)) * ch; for (let c = 0; c < ch; c++) out[di + c] += arr[idx + c]; }
      for (let c = 0; c < ch; c++) out[di + c] /= count;
    }
    return out;
  }
  const dist = (r, g, b, c) => { const dr = r - c[0], dg = g - c[1], db = b - c[2]; return dr * dr * 0.29 + dg * dg * 0.56 + db * db * 0.15; };

  /**
   * The `count` PICO-8 colors (of the 32 in `rgb32`) that represent an RGB image best:
   * greedy farthest-error selection on a color histogram, then swap refinement.
   * Returns indices into rgb32, sorted dark to bright.
   */
  function bestColors(rgb, count, rgb32, allowed = null) {
    const bins = new Map();
    for (let i = 0; i < rgb.length; i += 3) {
      const k = ((rgb[i] >> 3) << 10) | ((rgb[i + 1] >> 3) << 5) | (rgb[i + 2] >> 3);
      const b = bins.get(k);
      if (b) { b[0] += rgb[i]; b[1] += rgb[i + 1]; b[2] += rgb[i + 2]; b[3]++; } else bins.set(k, [rgb[i], rgb[i + 1], rgb[i + 2], 1]);
    }
    const pts = [...bins.values()].map((b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3], b[3]]);
    const cand = allowed || rgb32.map((_, i) => i);
    const D = cand.map((c) => pts.map((q) => dist(q[0], q[1], q[2], rgb32[c])));
    const err = (set) => { let e = 0; for (let j = 0; j < pts.length; j++) { let m = Infinity; for (const s of set) if (D[s][j] < m) m = D[s][j]; e += m * pts[j][3]; } return e; };
    const chosen = [];
    const cur = new Float64Array(pts.length).fill(Infinity);
    for (let k = 0; k < Math.min(count, cand.length); k++) {
      let best = -1, be = Infinity;
      for (let c = 0; c < cand.length; c++) {
        if (chosen.includes(c)) continue;
        let e = 0;
        for (let j = 0; j < pts.length; j++) e += Math.min(cur[j], D[c][j]) * pts[j][3];
        if (e < be) { be = e; best = c; }
      }
      chosen.push(best);
      for (let j = 0; j < pts.length; j++) cur[j] = Math.min(cur[j], D[best][j]);
    }
    // swap refinement: replace a chosen color by an unused one while that lowers the error
    let total = err(chosen);
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let a = 0; a < chosen.length; a++) for (let c = 0; c < cand.length; c++) {
        if (chosen.includes(c)) continue;
        const trial = chosen.slice(); trial[a] = c;
        const e = err(trial);
        if (e < total - 1e-6) { total = e; chosen[a] = c; improved = true; }
      }
      if (!improved) break;
    }
    const lum = (c) => 0.299 * rgb32[c][0] + 0.587 * rgb32[c][1] + 0.114 * rgb32[c][2];
    return chosen.map((c) => cand[c]).sort((a, b) => lum(a) - lum(b));
  }

  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  /**
   * RGB (m x m x 3 floats) -> slot per pixel for the palette `colors` (RGB triples).
   * dither: 'none' | 'ordered' (4x4 Bayer, strength 0..1) | 'diffuse' (Floyd-Steinberg, wraps around
   * the edges so the result stays seamless).
   */
  function quantize(rgb, m, colors, dither = 'ordered', strength = 0.5) {
    const out = new Uint8Array(m * m), k = colors.length;
    const nearest = (r, g, b) => { let best = 0, sc = Infinity; for (let j = 0; j < k; j++) { const s = dist(r, g, b, colors[j]); if (s < sc) { sc = s; best = j; } } return best; };
    if (dither === 'diffuse') {
      const e = Float32Array.from(rgb);
      const add = (x, y, f, er, eg, eb) => { const i = (((y + m) % m) * m + ((x + m) % m)) * 3; e[i] += er * f; e[i + 1] += eg * f; e[i + 2] += eb * f; };
      for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
        const i = (y * m + x) * 3, r = e[i], g = e[i + 1], b = e[i + 2], s = nearest(r, g, b), c = colors[s];
        out[y * m + x] = s;
        const er = (r - c[0]) * strength, eg = (g - c[1]) * strength, eb = (b - c[2]) * strength;
        add(x + 1, y, 7 / 16, er, eg, eb); add(x - 1, y + 1, 3 / 16, er, eg, eb); add(x, y + 1, 5 / 16, er, eg, eb); add(x + 1, y + 1, 1 / 16, er, eg, eb);
      }
      return out;
    }
    const amp = dither === 'ordered' ? strength * 48 : 0;
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const i = (y * m + x) * 3, b = amp ? (BAYER[(y & 3) * 4 + (x & 3)] / 15 - 0.5) * amp : 0;
      out[y * m + x] = nearest(rgb[i] + b, rgb[i + 1] + b, rgb[i + 2] + b);
    }
    return out;
  }

  /**
   * PICO-8 style shading with fade tables (Palette & Fades format: tables[step][slot], low nibble = the
   * slot at that step, step 0 = unchanged): the unlit color picks the slot, the light picks the fade
   * step, and a 4x4 Bayer pattern dithers between two neighbouring steps (seamless).
   *   albedo, lit: m x m x 3 floats;  colors: RGB of the 16 slots;  fades: {dark, bright} (either may be null)
   *   depth: how far full shadow goes into the dark fade (0..1); lift: how far full light goes into the bright one
   */
  function fadeShade(albedo, lit, m, colors, fades, { depth = 1, lift = 0.5, dither = true } = {}) {
    const out = new Uint8Array(m * m), k = colors.length;
    const lum = (a, i) => 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
    const step = (tables, s, slot, x, y) => {
      const last = tables.length - 1, f = Math.min(last, Math.max(0, s)), i0 = Math.floor(f), fr = f - i0;
      const i = dither && fr > 0 && BAYER[(y & 3) * 4 + (x & 3)] / 16 < fr ? Math.min(last, i0 + 1) : i0;
      return tables[i][slot] & 15;
    };
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) {
      const j = (y * m + x) * 3;
      let best = 0, sc = Infinity;
      for (let c = 0; c < k; c++) { const s = dist(albedo[j], albedo[j + 1], albedo[j + 2], colors[c]); if (s < sc) { sc = s; best = c; } }
      const L = lum(lit, j) / Math.max(1, lum(albedo, j));
      let slot = best;
      if (L < 1 && fades.dark) slot = step(fades.dark.tables, (1 - L) * depth * (fades.dark.tables.length - 1), best, x, y);
      else if (L > 1 && fades.bright) slot = step(fades.bright.tables, (L - 1) * 2 * lift * (fades.bright.tables.length - 1), best, x, y);
      out[y * m + x] = slot;
    }
    return out;
  }

  /** heights (n x n) -> m x m levels 0..levels-1 between the map's lowest and highest point */
  function heightLevels(height, n, m, levels = 16) {
    const d = downsample(height, n, m, 1);
    let lo = Infinity, hi = -Infinity;
    for (const v of d) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const inv = (levels - 1) / Math.max(1e-6, hi - lo), out = new Uint8Array(m * m);
    for (let i = 0; i < out.length; i++) out[i] = clamp(Math.round((d[i] - lo) * inv), 0, levels - 1);
    return { levels: out, lo, hi };
  }

  /** RGBA -> RGB float array */
  function rgbOfRgba(rgba) { const out = new Float32Array((rgba.length / 4) * 3); for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2]; } return out; }

  function reset() { fieldCache = baseCache = sculptCache = weatherCache = postCache = adjustCache = shadeCache = null; }

  return {
    MATERIALS, ADJUST_KEYS, SHADE_KEYS,
    build, handle, reset, makeTileable, normalize, downsample, bestColors, quantize, fadeShade, heightLevels, rgbOfRgba,
    applyStamp, erode, windErode, thermal, getFields, getBase, rngFactory, noiseT, gradTable,
    setAssets: (msg) => handle({ type: 'assets', ...msg }),
  };
}

/**
 * Undo / redo snapshots for the Terrain Lab UI (DOM-free, not part of the worker engine).
 * A snapshot keeps references to every resource it needs: the imports map, the import source
 * (grey pixels + seam settings) and the bitmaps its stamps use. These objects are treated as
 * immutable by terrain.js (retile / seam changes / scene loads build new ones), so sharing them
 * costs no copies, and pruning or replacing the live stores never breaks an older snapshot.
 * Retained memory is bounded by trim(): oldest entries go first once the budget is exceeded.
 */
const P8TerrainHistory = (() => {
  const MAX_ENTRIES = 100;
  const BUDGET_BYTES = 256 * 1024 * 1024;

  /** the bitmaps the stamps reference, as {id: bitmap} (shared references) */
  function bitmapRefs(stamps, bitmaps) {
    const out = {};
    for (const s of stamps) if (s.bmp && bitmaps[s.bmp]) out[s.bmp] = bitmaps[s.bmp];
    return out;
  }
  /** withPico: also the PICO-8 output settings (scene loads replace them) */
  function snapshot(st, withParams = false, withPico = false) {
    return {
      stamps: st.stamps.slice(), passes: st.passes.map((p) => ({ ...p })), strokeStarts: st.strokeStarts.slice(), importId: st.params.importId, importMix: st.params.importMix,
      params: withParams ? { ...st.params } : null, preset: st.preset, weather: { ...st.weather },
      imports: st.imports, importSrc: st.importSrc, bitmaps: bitmapRefs(st.stamps, st.bitmaps), pico: withPico ? { ...st.pico } : null,
    };
  }
  /** puts a snapshot back into st; returns what changed besides the edits (worker assets, output settings) */
  function restore(st, s) {
    st.stamps = s.stamps; st.passes = s.passes; st.strokeStarts = s.strokeStarts;
    if (s.params) { st.params = { ...s.params }; st.preset = s.preset; st.weather = { ...s.weather }; }
    st.params.importId = s.importId; st.params.importMix = s.importMix;
    const changed = { bitmaps: false, imports: st.imports !== s.imports, pico: !!s.pico };
    st.imports = s.imports; st.importSrc = s.importSrc;
    if (s.pico) st.pico = { ...s.pico };
    for (const [id, b] of Object.entries(s.bitmaps || {})) if (st.bitmaps[id] !== b) { st.bitmaps[id] = b; changed.bitmaps = true; }
    return changed;
  }
  /** bytes of the distinct large arrays (imports, import sources, bitmaps) the snapshots hold */
  function retainedBytes(snaps) {
    const seen = new Set();
    let bytes = 0;
    const add = (a) => { if (a && a.buffer && !seen.has(a.buffer)) { seen.add(a.buffer); bytes += a.buffer.byteLength; } };
    for (const s of snaps) {
      for (const im of Object.values(s.imports || {})) add(im && im.data);
      add(s.importSrc && s.importSrc.grey);
      for (const b of Object.values(s.bitmaps || {})) add(b && b.data);
    }
    return bytes;
  }
  /** drops the oldest undo entries (then the farthest redo entries) over the entry count or memory budget */
  function trim(undo, redo, { max = MAX_ENTRIES, budget = BUDGET_BYTES } = {}) {
    while (undo.length > max) undo.shift();
    while (redo.length > max) redo.shift();
    while ((undo.length || redo.length) && retainedBytes([...undo, ...redo]) > budget) (undo.length ? undo : redo).shift();
  }
  /** bitmap ids that must stay in the live store: current stamps plus extra ids (tool bitmaps) */
  function liveBitmapIds(stamps, extra = []) {
    const used = new Set();
    for (const s of stamps) if (s.bmp) used.add(s.bmp);
    for (const id of extra) if (id) used.add(id);
    return used;
  }
  return { MAX_ENTRIES, BUDGET_BYTES, snapshot, restore, retainedBytes, trim, liveBitmapIds, bitmapRefs };
})();

/**
 * PICO-8 output recipe of a scene file (DOM-free). Scene format v4 adds `pico`:
 *   {colors, dither, strength, shade, depth, lift, palette}
 *   colors:  the mode as chosen (auto16/12/8/4, std, library, libimg, frozen, src:<live source id>)
 *   palette: null for the auto modes, else the fixed palette in slot order and the fade tables the
 *            output used {colors, fades, name, external, link}. external = it was read from another
 *            tool (a live source, or fades borrowed from Palette & Fades); link = the live source.
 * Loading turns every external palette into the frozen snapshot ('frozen' mode, link kept), so
 * a scene renders the same in any session; going live again is an explicit Colors choice.
 * Older scenes (v0.4, v1-v3) have no recipe and get PICO_DEFAULTS, never the current settings.
 */
const P8TerrainScene = (() => {
  const VERSION = 4;
  const PICO_DEFAULTS = Object.freeze({ colors: 'auto16', dither: 'ordered', strength: 0.5, palColors: null, palFades: null, palName: '', shade: 'lit', depth: 0.8, lift: 0.4, link: null });
  const AUTO = /^auto(16|12|8|4)$/, LIVE = /^src:[\w.-]+$/;
  const STD = Array.from({ length: 16 }, (_, i) => i);
  const unit = (v, d) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : d);
  const isColor = (c) => Number.isInteger(c) && ((c >= 0 && c < 16) || (c >= 128 && c < 144));
  /** validated copy of a palette (1-16 PICO-8 colors in slot order) or null */
  const cleanPal = (a) => (Array.isArray(a) && a.length >= 1 && a.length <= 16 && a.every(isColor) ? a.slice() : null);
  function cleanTable(f) {
    if (!f || !Array.isArray(f.tables) || !f.tables.length || f.tables.length > 64) return null;
    if (!f.tables.every((r) => Array.isArray(r) && r.length >= 16 && r.every((v) => Number.isInteger(v) && v >= 0 && v < 256))) return null;
    const out = { tables: f.tables.map((r) => r.slice()) };
    if (Array.isArray(f.coverage) && f.coverage.every(Number.isFinite)) out.coverage = f.coverage.slice();
    return out;
  }
  /** validated deep copy of {dark, bright} fade tables, or null when there are none */
  function cleanFades(f) {
    if (!f) return null;
    const dark = cleanTable(f.dark), bright = cleanTable(f.bright);
    return dark || bright ? { dark, bright } : null;
  }

  /**
   * The fixed palette a recipe uses: {pal, fades, from, note, external}, or null for the auto modes.
   * sources: {get(id) -> {pal, fades, name} | null, label(id)}: the live palettes of other tools.
   */
  function resolveFixed(pico, sources) {
    const pm = pico.colors || '';
    const label = (id) => (sources.label && sources.label(id)) || id;
    let pal = null, fades = null, from = '', note = '', external = false;
    if (pm === 'frozen' && pico.palColors) {
      // a snapshot never borrows from other tools
      const hint = pico.link && LIVE.test(pico.link) ? ` Choose “${label(pico.link.slice(4))} (live)” under Colors to use the live palette.` : '';
      return { pal: pico.palColors.slice(), fades: pico.palFades || null, from: pico.palName || 'Saved snapshot', note: `Saved snapshot.${hint}`, external: false };
    }
    if (pm === 'std') { pal = STD.slice(); from = 'Standard 16'; }
    else if (LIVE.test(pm)) {
      const id = pm.slice(4), s = sources.get(id);
      external = true;
      if (s) { pal = s.pal.slice(); fades = s.fades; from = `${label(id)}: ${s.name}`; } else { pal = STD.slice(); note = `${label(id)} has nothing open: using the standard 16.`; from = 'Standard 16'; }
    } else if ((pm === 'library' || pm === 'libimg') && pico.palColors) { pal = pico.palColors.slice(); fades = pm === 'libimg' ? pico.palFades : null; from = pico.palName || 'Library'; }
    if (!pal) return null;
    if (!fades?.dark && !fades?.bright) {
      const pf = sources.get('palette');
      if (pf?.fades) {
        fades = pf.fades;
        if (pm !== 'src:palette') note ||= 'Fade tables from Palette & Fades, used by slot number.';
        if (pico.shade === 'fades') external = true;
      }
    }
    return { pal, fades, from, note, external };
  }

  /** the scene file's `pico` recipe; resolved = resolveFixed() at save time */
  function encodePico(pico, resolved) {
    const pm = pico.colors;
    const out = { colors: pm, dither: pico.dither, strength: pico.strength, shade: pico.shade, depth: pico.depth, lift: pico.lift, palette: null };
    if (resolved) {
      const frozen = resolved.external || pm === 'frozen';
      out.palette = {
        colors: resolved.pal.slice(), fades: cleanFades(frozen ? resolved.fades : pm === 'libimg' ? pico.palFades : null), name: resolved.from,
        external: !!resolved.external, link: LIVE.test(pm) ? pm : pm === 'frozen' && LIVE.test(pico.link || '') ? pico.link : null,
      };
    }
    return out;
  }

  /** st.pico for a parsed scene file: its recipe (v4) or the defaults (older versions) */
  function decodePico(scene) {
    const out = { ...PICO_DEFAULTS };
    const p = scene && Number(scene.version) >= 4 ? scene.pico : null;
    if (!p || typeof p !== 'object') return out;
    if (['none', 'ordered', 'diffuse'].includes(p.dither)) out.dither = p.dither;
    if (['lit', 'fades'].includes(p.shade)) out.shade = p.shade;
    out.strength = unit(p.strength, out.strength); out.depth = unit(p.depth, out.depth); out.lift = unit(p.lift, out.lift);
    const pm = String(p.colors || ''), sp = p.palette && typeof p.palette === 'object' ? p.palette : null, pal = sp && cleanPal(sp.colors);
    const name = sp && typeof sp.name === 'string' ? sp.name.slice(0, 200) : '';
    if (AUTO.test(pm)) out.colors = pm;
    else if (pal && (LIVE.test(pm) || pm === 'frozen' || sp.external === true)) {
      const link = LIVE.test(pm) ? pm : LIVE.test(sp.link || '') ? sp.link : null;
      Object.assign(out, { colors: 'frozen', palColors: pal, palFades: cleanFades(sp.fades), palName: name || 'Saved snapshot', link });
    } else if (pm === 'std') out.colors = 'std';
    else if (pal && (pm === 'library' || pm === 'libimg')) Object.assign(out, { colors: pm, palColors: pal, palFades: pm === 'libimg' ? cleanFades(sp.fades) : null, palName: name });
    return out;
  }
  return { VERSION, PICO_DEFAULTS, resolveFixed, encodePico, decodePico, cleanFades, cleanPal };
})();

const P8Terrain = (() => {
  const E = P8TerrainEngine();
  let url = null;
  /** Blob URL of a worker running the same engine (works from file:// too) */
  function workerUrl() {
    if (!url) {
      const src = `'use strict';\n${P8TerrainEngine.toString()}\nconst E = P8TerrainEngine();\nonmessage = (e) => E.handle(e.data, (m, t) => postMessage(m, t));\n`;
      url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    }
    return url;
  }
  return { ...E, workerUrl, history: P8TerrainHistory, scene: P8TerrainScene };
})();

if (typeof module !== 'undefined') module.exports = P8Terrain;

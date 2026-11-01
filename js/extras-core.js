// js/extras-core.js
// Pure logic of the Extra Tools (no DOM, runs in Node for tests):
//   Line Tool      <- line_tool/line_utils.py
//   Wave Designer  <- osc_designer/{dsp,oscillators,preset,export}.py
//   LUT Creator    <- lut_creator/{core,export}/*.py (2D motion paths, 3D ball formations)

'use strict';

const P8Extras = (() => {
  // ------------------------------------------------------------------ //
  // Python compatibility                                               //
  // ------------------------------------------------------------------ //

  /** Python 3 round(): halves go to the even neighbour. */
  function pyRound(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
  }

  /** Python's random.Random(seed) (MT19937 + init_by_array) so seeds give the same numbers as the desktop tools. */
  function pyRandom(seed = 0) {
    const N = 624;
    const mt = new Uint32Array(N);
    let mti = N + 1;

    function initGenrand(s) {
      mt[0] = s >>> 0;
      for (mti = 1; mti < N; mti++) {
        const prev = mt[mti - 1] ^ (mt[mti - 1] >>> 30);
        mt[mti] = (Math.imul(1812433253, prev) + mti) >>> 0;
      }
    }

    function initByArray(key) {
      initGenrand(19650218);
      let i = 1;
      let j = 0;
      for (let k = Math.max(N, key.length); k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
        i++; j++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
        if (j >= key.length) j = 0;
      }
      for (let k = N - 1; k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
        i++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      }
      mt[0] = 0x80000000;
    }

    function genrand() {
      if (mti >= N) {
        let kk = 0;
        for (; kk < N - 397; kk++) {
          const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
          mt[kk] = mt[kk + 397] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        }
        for (; kk < N - 1; kk++) {
          const y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
          mt[kk] = mt[kk + (397 - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        }
        const y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
        mt[N - 1] = mt[396] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        mti = 0;
      }
      let y = mt[mti++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }

    // seed(int): absolute value split into 32-bit words, least significant first
    let n = Math.abs(Math.trunc(seed));
    const key = [];
    do { key.push(n % 0x100000000); n = Math.floor(n / 0x100000000); } while (n > 0);
    initByArray(key);

    return {
      random() {
        const a = genrand() >>> 5;
        const b = genrand() >>> 6;
        return (a * 67108864 + b) / 9007199254740992;
      },
      /** Not bit-identical to Python's randint (only used for "Randomize"). */
      randint(lo, hi) { return lo + Math.floor(this.random() * (hi - lo + 1)); },
      choice(list) { return list[Math.floor(this.random() * list.length)]; },
    };
  }

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const frac = (x) => x - Math.floor(x);
  const hex2 = (b) => (b & 255).toString(16).padStart(2, '0');

  // ------------------------------------------------------------------ //
  // Line Tool                                                          //
  // ------------------------------------------------------------------ //

  const clampPixel = (v) => clamp(v, 0, 127);

  /** Bresenham, inclusive end points. */
  function rasterizeLine(x0, y0, x1, y1) {
    const pts = [];
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }

  /** Offsets with 0 near the centre: n=2 -> [-1,0], n=3 -> [-1,0,1], n=4 -> [-2..1]. */
  function arrayIndices(count) {
    const out = [];
    for (let i = -Math.floor(count / 2); i < count - Math.floor(count / 2); i++) out.push(i);
    return out;
  }

  /** `count` parallel lines, 1 px apart, perpendicular to the drawn one. */
  function lineArray(x0, y0, x1, y1, count) {
    if (count <= 1) return [[x0, y0, x1, y1]];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len === 0) return Array.from({ length: count }, () => [x0, y0, x1, y1]);
    const nx = -dy / len;
    const ny = dx / len;
    return arrayIndices(count).map((o) => [
      clampPixel(pyRound(x0 + nx * o)), clampPixel(pyRound(y0 + ny * o)),
      clampPixel(pyRound(x1 + nx * o)), clampPixel(pyRound(y1 + ny * o)),
    ]);
  }

  /** lines: [{x0,y0,x1,y1,c}] -> Lua. format 'keyed' ({x0=..,c=..}) or 'compact' ({x0,y0,x1,y1,c}). */
  function linesToLua(lines, { format = 'keyed', name = 'lines', drawFn = true } = {}) {
    const rows = lines.map((l) => (format === 'compact'
      ? `{${l.x0},${l.y0},${l.x1},${l.y1},${l.c}}`
      : `{x0=${l.x0},y0=${l.y0},x1=${l.x1},y1=${l.y1},c=${l.c}}`));
    let out = `${name}={\n  ${rows.join(',\n  ')}\n}\n`;
    if (drawFn) {
      out += format === 'compact'
        ? `\nfunction draw_${name}()\n  for l in all(${name}) do\n    line(l[1],l[2],l[3],l[4],l[5])\n  end\nend\n`
        : `\nfunction draw_${name}()\n  for l in all(${name}) do\n    line(l.x0,l.y0,l.x1,l.y1,l.c)\n  end\nend\n`;
    }
    return out;
  }

  // ------------------------------------------------------------------ //
  // Wave Designer                                                      //
  // ------------------------------------------------------------------ //

  const WAVE_DEFAULTS = {
    name: 'preset',
    a_sin: 1.0, a_sqr: 0.0, a_tri: 0.0, a_saw: 0.0, a_noi: 0.0,
    f_sin: 1, f_sqr: 1, f_tri: 1, f_saw: 1,
    ph_sin: 0.0, ph_sqr: 0.0, ph_tri: 0.0, ph_saw: 0.0,
    duty: 0.5,
    noise_seed: 1, noise_lp: 0.35,
    dc: 0.0, gain: 1.0, lp: 0.5, sh_step: 1, crush_bits: 0, clip_amt: 0.0, do_norm: true,
    xy_off: 0.25,
  };

  /** [key, label, min, max, step, isInt] grouped like the desktop window. */
  const WAVE_PARAMS = {
    Mix: [
      ['a_sin', 'Sine', 0, 2, 0.05], ['a_sqr', 'Square', 0, 2, 0.05], ['a_tri', 'Triangle', 0, 2, 0.05],
      ['a_saw', 'Saw', 0, 2, 0.05], ['a_noi', 'Noise', 0, 1, 0.02],
    ],
    Oscillators: [
      ['f_sin', 'Sin freq', 1, 16, 1, true], ['ph_sin', 'Sin phase', 0, 1, 0.01],
      ['f_sqr', 'Sqr freq', 1, 16, 1, true], ['ph_sqr', 'Sqr phase', 0, 1, 0.01], ['duty', 'Sqr duty', 0.05, 0.95, 0.01],
      ['f_tri', 'Tri freq', 1, 16, 1, true], ['ph_tri', 'Tri phase', 0, 1, 0.01],
      ['f_saw', 'Saw freq', 1, 16, 1, true], ['ph_saw', 'Saw phase', 0, 1, 0.01],
    ],
    'Post-processing': [
      ['noise_seed', 'Noise seed', 0, 9999, 1, true], ['noise_lp', 'Noise LP', 0, 1, 0.02],
      ['dc', 'DC offset', -1, 1, 0.02], ['gain', 'Gain', 0, 3, 0.05], ['lp', 'Lowpass', 0, 1, 0.02],
      ['sh_step', 'Sample hold', 1, 32, 1, true], ['crush_bits', 'Bitcrush', 0, 8, 1, true],
      ['clip_amt', 'Soft clip', 0, 3, 0.05], ['xy_off', 'XY offset', 0, 1, 0.01],
    ],
  };

  /** The 16 starting presets of the desktop tool. */
  function defaultWavePresets() {
    return Array.from({ length: 16 }, (_, i) => ({ ...WAVE_DEFAULTS, name: `p${i + 1}`, noise_seed: 1000 + i * 37, a_sin: 1.0, f_sin: 1 + (i % 4) }));
  }

  const oscSine = (ph) => Math.sin(ph * 2 * Math.PI);
  const oscSquare = (ph, duty) => (frac(ph) < duty ? 1 : -1);
  const oscTri = (ph) => 1 - 4 * Math.abs(frac(ph) - 0.5);
  const oscSaw = (ph) => frac(ph) * 2 - 1;
  const softclip = (x, amt) => (amt <= 0 ? x : x / (1 + amt * Math.abs(x)));
  function bitcrush(x, bits) {
    if (bits <= 0) return x;
    const levels = 1 << bits;
    const v = pyRound((x * 0.5 + 0.5) * (levels - 1));
    return (v / (levels - 1) - 0.5) * 2;
  }
  function sampleHold(s, step) {
    if (step <= 1) return s;
    let hold = s[0];
    return s.map((v, i) => { if (i % step === 0) hold = v; return hold; });
  }
  function onePoleLowpass(s, a) {
    a = clamp(a, 0, 1);
    let y = 0;
    return s.map((x) => { y += (x - y) * a; return y; });
  }
  function normalize(s, peak = 0.98) {
    const pk = Math.max(1e-9, ...s.map(Math.abs));
    const g = peak / pk;
    return s.map((v) => clamp(v * g, -1, 1));
  }
  const q8 = (x) => pyRound((clamp(x, -1, 1) * 0.5 + 0.5) * 255);

  function noiseTable(seed, n = 256) {
    const rng = pyRandom(seed);
    return Array.from({ length: n }, () => rng.random() * 2 - 1);
  }

  function renderWave(p, n = 256) {
    const noi = onePoleLowpass(noiseTable(p.noise_seed, n), p.noise_lp);
    let out = new Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      let s = 0;
      if (p.a_sin) s += p.a_sin * oscSine(t * p.f_sin + p.ph_sin);
      if (p.a_sqr) s += p.a_sqr * oscSquare(t * p.f_sqr + p.ph_sqr, p.duty);
      if (p.a_tri) s += p.a_tri * oscTri(t * p.f_tri + p.ph_tri);
      if (p.a_saw) s += p.a_saw * oscSaw(t * p.f_saw + p.ph_saw);
      if (p.a_noi) s += p.a_noi * noi[i];
      out[i] = clamp((s + p.dc) * p.gain, -2, 2);
    }
    out = sampleHold(out, Math.max(1, Math.trunc(p.sh_step)));
    out = onePoleLowpass(out, p.lp);
    if (p.crush_bits > 0) out = out.map((s) => bitcrush(s, Math.trunc(p.crush_bits)));
    if (p.clip_amt > 0) out = out.map((s) => softclip(s, p.clip_amt));
    out = out.map((s) => clamp(s, -1, 1));
    if (p.do_norm) out = normalize(out, 0.98);
    return out;
  }

  /** Same knob ranges as the desktop "Randomize Current" (not bit-identical). */
  function randomizeWave(p, seed = (Math.random() * 1e9) | 0) {
    const rng = pyRandom(seed);
    return {
      ...p,
      a_sin: rng.random() * 1.5, a_tri: rng.random() * 1.2, a_saw: rng.random() * 1.2, a_sqr: rng.random() * 1.0, a_noi: rng.random() * 0.25,
      f_sin: rng.randint(1, 8), f_tri: rng.randint(1, 8), f_saw: rng.randint(1, 8), f_sqr: rng.randint(1, 8),
      ph_sin: rng.random(), ph_tri: rng.random(), ph_saw: rng.random(), ph_sqr: rng.random(),
      duty: 0.2 + rng.random() * 0.6, noise_seed: rng.randint(0, 9999), noise_lp: rng.random() * 0.8,
      dc: (rng.random() - 0.5) * 0.2, gain: 0.6 + rng.random() * 1.8, lp: 0.2 + rng.random() * 0.8,
      sh_step: rng.choice([1, 1, 1, 2, 2, 4, 8]), crush_bits: rng.choice([0, 0, 0, 4, 5, 6, 7]),
      clip_amt: rng.random() * 1.5, xy_off: rng.random(), do_norm: true,
    };
  }

  /** export.write_waves_p8: 16 x 256 unsigned bytes in __map__ (0x2000..0x2fff). */
  function wavesCart(waves) {
    if (waves.length !== 16) throw new Error('Expected 16 waves.');
    const bytes = [];
    for (const w of waves) {
      if (w.length !== 256) throw new Error('Expected 256 samples per wave.');
      for (const v of w) bytes.push(q8(v));
    }
    const map = [];
    for (let y = 0; y < 32; y++) map.push(bytes.slice(y * 128, (y + 1) * 128).map(hex2).join(''));
    return 'pico-8 cartridge // http://www.pico-8.com\n'
      + 'version 41\n'
      + '__lua__\n'
      + '-- data cart: 16x256 mono waveforms stored in __map__\n'
      + 'function _init() end\n'
      + 'function _update() end\n'
      + "function _draw() cls() print('waves.p8',54,60,7) end\n"
      + '\n'
      + `__gfx__\n${Array(128).fill('0'.repeat(128)).join('\n')}\n`
      + `__map__\n${map.join('\n')}\n`
      + `__sfx__\n${Array(64).fill('0'.repeat(168)).join('\n')}\n`
      + `__music__\n${Array(64).fill('0'.repeat(8)).join('\n')}\n`;
  }

  function wavesLoader(cartName = 'waves.p8') {
    return [
      `-- 16 waves x 256 samples from ${cartName} (__map__ = 0x2000)`,
      `reload(0x8000,0x2000,0x1000,"${cartName}")`,
      '',
      '-- w: 0..15, i: sample (wraps at 256) -> -1..1',
      'function wave(w,i)',
      '  return @(0x8000+w*256+(i&255))/127.5-1',
      'end',
      '',
    ].join('\n');
  }

  // ------------------------------------------------------------------ //
  // LUT Creator: 2D motion paths                                       //
  // ------------------------------------------------------------------ //

  const DEFAULT_CURVE = [[24, 96], [44, 24], [84, 24], [104, 96]];

  function circleComponent(n, radius = 30, turns = 1) {
    const dx = new Array(n).fill(0);
    const dy = new Array(n).fill(0);
    if (n <= 0 || radius === 0 || turns === 0) return [dx, dy];
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * turns * (i / n);
      dx[i] = radius * Math.cos(a);
      dy[i] = radius * Math.sin(a);
    }
    return [dx, dy];
  }

  function verticalSineComponent(n, amplitude = 10, turns = 1) {
    const dx = new Array(n).fill(0);
    const dy = new Array(n).fill(0);
    if (n <= 0 || amplitude === 0 || turns === 0) return [dx, dy];
    for (let i = 0; i < n; i++) dy[i] = amplitude * Math.sin(2 * Math.PI * turns * (i / n));
    return [dx, dy];
  }

  function figure8Component(n, amplitude = 20, turns = 1) {
    const dx = new Array(n).fill(0);
    const dy = new Array(n).fill(0);
    if (n <= 0 || amplitude === 0 || turns === 0) return [dx, dy];
    for (let i = 0; i < n; i++) {
      const a = 2 * Math.PI * turns * (i / n);
      dx[i] = amplitude * Math.sin(a);
      dy[i] = amplitude * Math.sin(2 * a);
    }
    return [dx, dy];
  }

  function catmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    const f = (k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
    return [f(0), f(1)];
  }

  function curveSegment(pts, i, closed) {
    const c = pts.length;
    if (closed) return [pts[(i - 1 + c) % c], pts[i % c], pts[(i + 1) % c], pts[(i + 2) % c]];
    const p1 = pts[i];
    const p2 = pts[Math.min(i + 1, c - 1)];
    return [i > 0 ? pts[i - 1] : p1, p1, p2, i + 2 < c ? pts[i + 2] : p2];
  }

  /** Catmull-Rom spline through the control points (absolute 0..127 coordinates). */
  function curveComponent(pts, n, closed = false) {
    if (n <= 0 || !pts.length) return [new Array(Math.max(n, 0)).fill(0), new Array(Math.max(n, 0)).fill(0)];
    if (pts.length === 1) return [new Array(n).fill(pts[0][0]), new Array(n).fill(pts[0][1])];
    const xs = [];
    const ys = [];
    if (pts.length === 2) {
      for (let i = 0; i < n; i++) {
        const t = i / Math.max(n - 1, 1);
        xs.push(pts[0][0] + (pts[1][0] - pts[0][0]) * t);
        ys.push(pts[0][1] + (pts[1][1] - pts[0][1]) * t);
      }
      return [xs, ys];
    }
    const segs = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const g = (i / Math.max(n - 1, 1)) * segs;
      const s = Math.min(Math.floor(g), segs - 1);
      const [x, y] = catmullRom(...curveSegment(pts, s, closed), g - s);
      xs.push(x);
      ys.push(y);
    }
    return [xs, ys];
  }

  function enforceSeamlessLoop(xs, ys) {
    const n = xs.length;
    if (n <= 1) return [xs, ys];
    const dx = xs[n - 1] - xs[0];
    const dy = ys[n - 1] - ys[0];
    if (dx === 0 && dy === 0) return [xs, ys];
    return [xs.map((v, i) => v - dx * (i / (n - 1))), ys.map((v, i) => v - dy * (i / (n - 1)))];
  }

  const MOTION_DEFAULTS = {
    length: 128, loop: true,
    circle: { on: true, radius: 30, turns: 1 },
    sine: { on: true, amp: 10, turns: 2 },
    fig8: { on: false, amp: 20, turns: 1 },
    curve: { on: false, closed: false, points: DEFAULT_CURVE.map((p) => [...p]) },
  };

  /** Motion2DTab.regenerate: returns {x, y} around the screen centre (64,64). */
  function buildMotion(s) {
    const n = Math.max(0, Math.trunc(s.length));
    if (!n) return { x: [], y: [] };
    const comps = [];
    if (s.circle.on) comps.push(circleComponent(n, s.circle.radius, s.circle.turns));
    if (s.sine.on) comps.push(verticalSineComponent(n, s.sine.amp, s.sine.turns));
    if (s.fig8.on) comps.push(figure8Component(n, s.fig8.amp, s.fig8.turns));
    if (s.curve.on) {
      const [cx, cy] = curveComponent(s.curve.points, n, s.curve.closed);
      comps.push([cx.map((v) => v - 64), cy.map((v) => v - 64)]);
    }
    let x = new Array(n).fill(64);
    let y = new Array(n).fill(64);
    for (const [dx, dy] of comps) for (let i = 0; i < n; i++) { x[i] += dx[i]; y[i] += dy[i]; }
    if (s.loop) [x, y] = enforceSeamlessLoop(x, y);
    return { x, y };
  }

  function writeArray(name, values, fmt) {
    let out = `  ${name}={`;
    values.forEach((v, i) => {
      if (i % 8 === 0) out += '\n    ';
      out += `${fmt(v)},`;
    });
    return `${out}\n  },\n`;
  }

  /** export_motion_2d */
  function motionToLua(x, y) {
    return `-- 2D Motion Path LUT\n-- Length: ${x.length}\n\nmotion_lut={\n  n=${x.length},\n`
      + writeArray('x', x, (v) => v.toFixed(2))
      + writeArray('y', y, (v) => v.toFixed(2))
      + '}\n';
  }

  // POD (Picotron) text ------------------------------------------------ //

  function podScalar(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v == null) return 'nil';
    if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    if (!Number.isInteger(v)) return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    return String(v);
  }
  const podKey = (k) => (/^\d+$/.test(String(k)) ? `[${k}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `["${String(k).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);

  function toPod(v, indent = 0) {
    const ind = '  '.repeat(indent);
    const next = '  '.repeat(indent + 1);
    if (Array.isArray(v)) {
      if (!v.length) return '{}';
      if (v.every((x) => typeof x !== 'object' || x === null)) return `{${v.map(podScalar).join(', ')}}`;
      return `{\n${v.map((x) => `${next}${toPod(x, indent + 1)},`).join('\n')}\n${ind}}`;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      return `{\n${keys.map((k) => `${next}${podKey(k)}=${toPod(v[k], indent + 1)},`).join('\n')}\n${ind}}`;
    }
    return podScalar(v);
  }

  const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

  function motionToPod(x, y) {
    return `${toPod({ format: 'lut_creator_motion_2d', version: 1, motion_lut: { n: x.length, x: x.map((v) => round(v, 4)), y: y.map((v) => round(v, 4)) } })}\n`;
  }

  // ------------------------------------------------------------------ //
  // LUT Creator: 3D ball formations                                    //
  // ------------------------------------------------------------------ //

  const FORMATION_PRESETS = ['random', 'sphere', 'rings', 'spiral', 'grid', 'layers', '3dModel'];

  const SIZE_DISTRIBUTIONS = {
    sphere: ['Top->Bottom', 'Bottom->Top', 'Equator->Poles', 'Poles->Equator', 'Hemisphere', 'Alternate Hemisphere', 'Random'],
    rings: ['Inside->Outside', 'Outside->Inside', 'Alternate Ring', 'Alternate Row', 'Random'],
    spiral: ['Start->End', 'End->Start', 'Small-Big-Small (Wave)', 'Big-Small-Big (Wave)', 'Smooth Wave', 'Top->Bottom', 'Bottom->Top', 'Alternate', 'Random'],
    grid: ['Layer (Inside->Outside)', 'Layer (Outside->Inside)', 'Top->Bottom', 'Bottom->Top', 'Alternate Layer', 'Alternate Theta', 'Alternate Phi', 'Random'],
    layers: ['Top->Bottom', 'Bottom->Top', 'Alternate Layer', 'Alternate Row', 'Random'],
    '3dModel': ['Random', 'Alternate', 'Sine', 'Top->Down', 'Inner->Outer'],
  };

  /** [key, label, min, max, step] per preset (besides size min/max/distribution). */
  const PRESET_FIELDS = {
    random: [['seed', 'Seed', 0, 9999, 1], ['pole_clearance', 'Pole clearance', 0, 0.4, 0.01], ['min_spacing', 'Min spacing', 0, 30, 0.5]],
    sphere: [['pole_clearance', 'Pole clearance', 0, 0.4, 0.01]],
    rings: [['ring_count', 'Rings', 2, 12, 1]],
    spiral: [['rotations', 'Rotations', 1, 10, 1], ['vertical_cycles', 'Vertical cycles', 1, 8, 1], ['pole_clearance', 'Pole clearance', 0, 0.4, 0.01]],
    grid: [['radial_layers', 'Radial layers', 2, 8, 1], ['theta_divs', 'Theta divisions', 4, 16, 1], ['phi_divs', 'Phi divisions', 3, 12, 1], ['pole_clearance', 'Pole clearance', 0, 0.4, 0.01]],
    layers: [['layer_count', 'Layers', 4, 20, 1], ['pole_clearance', 'Pole clearance', 0, 0.4, 0.01]],
    '3dModel': [['rotation_x', 'Rotate X°', -180, 180, 5], ['rotation_y', 'Rotate Y°', -180, 180, 5], ['rotation_z', 'Rotate Z°', -180, 180, 5]],
  };

  function defaultPresetParams() {
    return {
      sphere: { pole_clearance: 0, size_min: 5, size_max: 10, size_distribution: 'Top->Bottom' },
      rings: { ring_count: 6, size_min: 5, size_max: 10, size_distribution: 'Inside->Outside' },
      spiral: { rotations: 5, vertical_cycles: 3, pole_clearance: 0, size_min: 5, size_max: 10, size_distribution: 'Start->End' },
      grid: { radial_layers: 4, theta_divs: 8, phi_divs: 6, pole_clearance: 0, size_min: 5, size_max: 10, size_distribution: 'Layer (Inside->Outside)' },
      layers: { layer_count: 10, pole_clearance: 0, size_min: 5, size_max: 10, size_distribution: 'Top->Bottom' },
      random: { seed: 42, pole_clearance: 0, min_spacing: 0, size_min: 5, size_max: 10 },
      '3dModel': { placement_mode: 'Vertices', size_min: 5, size_max: 10, size_distribution: 'Random', size_direction: 'min->max', rotation_x: 0, rotation_y: 0, rotation_z: 0 },
    };
  }

  function newFormationSettings() {
    return { preset: 'random', n_balls: 128, r_min: 46, r_max: 64, spd_min: 0.001, spd_max: 0.003, params: defaultPresetParams() };
  }

  /** ba: azimuth 0..1, bb: elevation 0..1 (0 = south pole, 0.5 = equator, 1 = north pole). */
  function sphericalToXyz(r, ba, bb) {
    const th = ba * 2 * Math.PI;
    const ph = bb * Math.PI - Math.PI / 2;
    return [r * Math.cos(ph) * Math.cos(th), r * Math.cos(ph) * Math.sin(th), r * Math.sin(ph)];
  }

  // OBJ models ---------------------------------------------------------- //

  function parseObj(text) {
    const vertices = [];
    const faces = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      if (line.startsWith('v ')) {
        const p = line.split(/\s+/);
        if (p.length < 4) continue;
        const v = [Number(p[1]), Number(p[2]), Number(p[3])];
        if (v.some((n) => !Number.isFinite(n))) throw new Error(`Bad vertex: ${line}`);
        vertices.push(v);
      } else if (line.startsWith('f ')) {
        const face = [];
        for (const part of line.split(/\s+/).slice(1)) {
          const tok = part.split('/')[0];
          if (!tok) continue;
          const raw = parseInt(tok, 10);
          if (!Number.isFinite(raw)) continue;
          const idx = raw > 0 ? raw - 1 : vertices.length + raw;
          if (idx >= 0 && idx < vertices.length) face.push(idx);
        }
        if (face.length >= 3) faces.push(face);
      }
    }
    if (!vertices.length) throw new Error('The OBJ file does not contain any vertices.');
    return { vertices, faces };
  }

  function modelPoints(model, mode) {
    const { vertices, faces } = model;
    if (mode === 'Vertices') return vertices.slice();
    if (mode === 'Face Centers') {
      return faces.map((f) => {
        const s = [0, 0, 0];
        for (const i of f) for (let k = 0; k < 3; k++) s[k] += vertices[i][k];
        return s.map((v) => v / f.length);
      });
    }
    return [];
  }

  function modelEdges(model) {
    const seen = new Set();
    const edges = [];
    for (const f of model.faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i];
        const b = f[(i + 1) % f.length];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([model.vertices[a], model.vertices[b]]);
      }
    }
    return edges;
  }

  function evenlyDownsample(points, target) {
    if (target >= points.length) return points.slice();
    const out = [];
    let last = -1;
    for (let i = 0; i < target; i++) {
      let idx = Math.trunc(((i + 0.5) * points.length) / target);
      idx = Math.min(Math.max(idx, 0), points.length - 1);
      if (idx === last && idx + 1 < points.length) idx++;
      out.push(points[idx]);
      last = idx;
    }
    return out;
  }

  function gridRepresentatives(points, res, b) {
    const span = [Math.max(b[1] - b[0], 1e-9), Math.max(b[3] - b[2], 1e-9), Math.max(b[5] - b[4], 1e-9)];
    const mins = [b[0], b[2], b[4]];
    const cells = new Map();
    for (const p of points) {
      const idx = [0, 1, 2].map((k) => Math.min(res - 1, Math.max(0, Math.trunc(((p[k] - mins[k]) / span[k]) * res))));
      let d = 0;
      for (let k = 0; k < 3; k++) {
        const c = mins[k] + ((idx[k] + 0.5) / res) * span[k];
        d += (p[k] - c) ** 2;
      }
      const key = (idx[0] * res + idx[1]) * res + idx[2];
      const cur = cells.get(key);
      if (!cur || d < cur[0]) cells.set(key, [d, p]);
    }
    return [...cells.keys()].sort((a, c) => a - c).map((k) => cells.get(k)[1]);
  }

  function centroidPoint(points) {
    const c = [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k], 0) / points.length);
    let best = points[0];
    let bd = Infinity;
    for (const p of points) {
      const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** Adaptive voxel sampling: roughly even spatial distribution of `target` points. */
  function samplePointsByGrid(points, target) {
    if (target <= 0 || !points.length) return [];
    if (target >= points.length) return points.slice();
    if (target === 1) return [centroidPoint(points)];
    const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (const p of points) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < b[k * 2]) b[k * 2] = p[k];
        if (p[k] > b[k * 2 + 1]) b[k * 2 + 1] = p[k];
      }
    }
    let above = null;
    let below = null;
    let lo = 1;
    let hi = Math.max(2, pyRound(points.length ** (1 / 3)) * 4);
    while (lo <= hi) {
      const res = (lo + hi) >> 1;
      const s = gridRepresentatives(points, res, b);
      if (s.length >= target) { above = s; lo = res + 1; } else { below = s; hi = res - 1; }
    }
    if (above) return above.length === target ? above : evenlyDownsample(above, target);
    if (below) {
      const used = new Set(below);
      const rest = points.filter((p) => !used.has(p));
      const need = target - below.length;
      if (need <= 0 || !rest.length) return below.slice();
      return below.concat(evenlyDownsample(rest, Math.min(need, rest.length)));
    }
    return evenlyDownsample(points, target);
  }

  function sampleEdgePoints(edges, target) {
    if (target <= 0 || !edges.length) return [];
    const w = [];
    let total = 0;
    for (const [a, b] of edges) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      if (len <= 1e-9) continue;
      total += len;
      w.push([total, a, b, len]);
    }
    if (!w.length) return [];
    const out = [];
    let ei = 0;
    let prev = 0;
    for (let i = 0; i < target; i++) {
      const dist = ((i + 0.5) / target) * total;
      while (ei < w.length - 1 && dist > w[ei][0]) { prev = w[ei][0]; ei++; }
      const [, a, b, len] = w[ei];
      const t = (dist - prev) / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
    }
    return out;
  }

  function rotatePoints(points, rx, ry, rz) {
    const [cx, sx] = [Math.cos((rx * Math.PI) / 180), Math.sin((rx * Math.PI) / 180)];
    const [cy, sy] = [Math.cos((ry * Math.PI) / 180), Math.sin((ry * Math.PI) / 180)];
    const [cz, sz] = [Math.cos((rz * Math.PI) / 180), Math.sin((rz * Math.PI) / 180)];
    return points.map(([x, y, z]) => {
      const y1 = y * cx - z * sx;
      const z1 = y * sx + z * cx;
      const x2 = x * cy + z1 * sy;
      const z2 = -x * sy + z1 * cy;
      return [x2 * cz - y1 * sz, x2 * sz + y1 * cz, z2];
    });
  }

  function fitPoints(points, rMax) {
    const mid = [0, 1, 2].map((k) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const p of points) { if (p[k] < lo) lo = p[k]; if (p[k] > hi) hi = p[k]; }
      return (lo + hi) / 2;
    });
    const c = points.map((p) => [p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]]);
    const maxD = Math.max(...c.map((p) => Math.hypot(...p)));
    if (maxD <= 1e-9) return c;
    const s = rMax > 0 ? rMax / maxD : 1;
    return c.map((p) => p.map((v) => v * s));
  }

  function modelSizes(points, min, max, dist, dir, note) {
    const n = points.length;
    if (!n) return [];
    if (min === max) return new Array(n).fill(min);
    const rng = pyRandom(42);
    const span = max - min;
    const directed = (t) => (dir === 'max->min' ? max - t * span : min + t * span);
    if (dist === 'Alternate') return points.map((_, i) => (i % 2 === 0 ? max : min));
    if (dist === 'Sine') return n === 1 ? [max] : points.map((_, i) => min + ((Math.sin((i / (n - 1)) * 2 * Math.PI - Math.PI / 2) + 1) * 0.5) * span);
    if (dist === 'Top->Down') {
      const zs = points.map((p) => p[2]);
      const lo = Math.min(...zs);
      const sp = Math.max(...zs) - lo;
      if (sp <= 1e-9) return points.map(() => directed(0.5));
      return zs.map((z) => directed(1 - (z - lo) / sp));
    }
    if (dist === 'Inner->Outer') {
      const rs = points.map((p) => Math.hypot(...p));
      const lo = Math.min(...rs);
      const sp = Math.max(...rs) - lo;
      if (sp <= 1e-9) {
        note.text = 'Inner->Outer has no visible effect because all sampled points are at the same distance from the center.';
        return new Array(n).fill(min + span * 0.5);
      }
      return rs.map((r) => directed((r - lo) / sp));
    }
    return points.map(() => min + rng.random() * span);
  }

  /**
   * BallFormation.generate. s = newFormationSettings(); model = parseObj(...) for '3dModel'.
   * Returns {preset, br0, br, ba, bb, bc, bda, bdb, bdc, error, info}.
   */
  function generateFormation(s, model = null) {
    const f = { preset: s.preset, br0: [], br: [], ba: [], bb: [], bc: [], bda: [], bdb: [], bdc: [], error: '', info: '' };
    const p = { ...defaultPresetParams()[s.preset], ...(s.params[s.preset] || {}) };
    const { n_balls: n, r_min: rMin, r_max: rMax, spd_min: sMin, spd_max: sMax } = s;
    const rng = pyRandom(s.preset === 'random' ? p.seed : 42);
    const rnd = () => rng.random();
    const spd = () => sMin + rnd() * (sMax - sMin);
    const sMn = p.size_min;
    const sMx = p.size_max;
    const lerp = (t) => sMn + t * (sMx - sMn);
    const lerpInv = (t) => sMx - t * (sMx - sMn);
    const push = (r, size, a, b, c, da, db, dc) => {
      f.br0.push(r); f.br.push(size); f.ba.push(a); f.bb.push(b); f.bc.push(c); f.bda.push(da); f.bdb.push(db); f.bdc.push(dc);
    };
    const clearance = (v) => (p.pole_clearance > 0 ? p.pole_clearance + v * (1 - 2 * p.pole_clearance) : v);

    switch (s.preset) {
      case 'random': {
        const phMin = p.pole_clearance;
        const phMax = 1 - p.pole_clearance;
        const xyz = [];
        const add = () => {
          const r = rMin + rnd() * (rMax - rMin);
          const th = rnd();
          const ph = phMin + rnd() * (phMax - phMin);
          return [r, th, ph];
        };
        const finish = ([r, th, ph]) => {
          push(r, lerp(rnd()), th, ph, rnd(),
            (sMin + rnd() * (sMax - sMin)) * (0.7 + rnd() * 0.6),
            (sMin + rnd() * (sMax - sMin)) * (0.6 + rnd() * 0.8),
            (sMin + rnd() * (sMax - sMin)) * (0.5 + rnd() * 1.1));
          xyz.push(sphericalToXyz(r, th, ph));
        };
        let attempts = 0;
        while (f.br0.length < n && attempts < n * 100) {
          attempts++;
          const c = add();
          if (p.min_spacing > 0 && f.br0.length) {
            const q = sphericalToXyz(c[0], c[1], c[2]);
            if (xyz.some((e) => Math.hypot(q[0] - e[0], q[1] - e[1], q[2] - e[2]) < p.min_spacing)) continue;
          }
          finish(c);
        }
        if (f.br0.length < n) f.info = `Only ${f.br0.length} balls fit with min spacing ${p.min_spacing}; the rest ignore it.`;
        while (f.br0.length < n) finish(add());
        break;
      }
      case 'sphere': {
        const golden = (1 + Math.sqrt(5)) / 2;
        const avgR = (rMin + rMax) / 2;
        for (let i = 0; i < n; i++) {
          const theta = (2 * Math.PI * i) / golden;
          const phiFib = Math.acos(1 - (2 * (i + 0.5)) / n);
          const thN = frac(theta / (2 * Math.PI));
          let v = (Math.cos(phiFib) + 1) / 2;
          v = clearance(v);
          const d = Math.abs(v - 0.5) * 2;
          const size = {
            'Top->Bottom': () => lerpInv(v), 'Bottom->Top': () => lerp(v),
            'Equator->Poles': () => lerpInv(d), 'Poles->Equator': () => lerp(d),
            Hemisphere: () => (v < 0.5 ? sMn : sMx),
            'Alternate Hemisphere': () => (((v < 0.5 ? 0 : 1) + (thN < 0.5 ? 0 : 1)) % 2 === 0 ? sMn : sMx),
          }[p.size_distribution] || (() => lerp(rnd()));
          push(avgR, size(), thN, v, rnd(), spd(), spd(), spd());
        }
        break;
      }
      case 'rings': {
        const rings = p.ring_count;
        const per = Math.max(Math.floor(n / Math.max(rings, 1)), 1);
        for (let i = 0; i < n; i++) {
          const ring = Math.min(Math.floor(i / per), rings - 1);
          const row = i % per;
          const t = ring / Math.max(rings - 1, 1);
          const size = {
            'Inside->Outside': () => lerp(t), 'Outside->Inside': () => lerpInv(t),
            'Alternate Ring': () => (ring % 2 === 0 ? sMn : sMx), 'Alternate Row': () => (row % 2 === 0 ? sMn : sMx),
          }[p.size_distribution] || (() => lerp(rnd()));
          push(rMin + t * (rMax - rMin), size(), row / Math.max(per, 1), 0.5, rnd(), sMin + t * (sMax - sMin), 0, spd());
        }
        break;
      }
      case 'spiral': {
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const v = clearance(Math.sin(t * p.vertical_cycles * Math.PI * 2) * 0.45 + 0.5);
          const w = Math.abs(2 * t - 1);
          const size = {
            'Start->End': () => lerp(t), 'End->Start': () => lerpInv(t),
            'Small-Big-Small (Wave)': () => lerp(w), 'Big-Small-Big (Wave)': () => lerpInv(w),
            'Smooth Wave': () => lerp((Math.sin(t * Math.PI * 4) + 1) / 2),
            // both use the same formula in the desktop tool
            'Top->Bottom': () => lerpInv(v), 'Bottom->Top': () => lerpInv(v),
            Alternate: () => (i % 2 === 0 ? sMn : sMx),
          }[p.size_distribution] || (() => lerp(rnd()));
          push(rMin + t * (rMax - rMin), size(), frac(t * p.rotations), v, t, sMin + (1 - t) * (sMax - sMin), sMin * 0.5, spd());
        }
        break;
      }
      case 'grid': {
        const L = p.radial_layers;
        outer: for (let layer = 0; layer < L; layer++) {
          const lt = layer / Math.max(L - 1, 1);
          const r = rMin + lt * (rMax - rMin);
          for (let ti = 0; ti < p.theta_divs; ti++) {
            for (let pi = 0; pi < p.phi_divs; pi++) {
              if (f.br0.length >= n) break outer;
              const pt = pi / Math.max(p.phi_divs - 1, 1);
              const size = {
                'Layer (Inside->Outside)': () => lerp(lt), 'Layer (Outside->Inside)': () => lerpInv(lt),
                'Top->Bottom': () => lerp(pt), 'Bottom->Top': () => lerpInv(pt),
                'Alternate Layer': () => (layer % 2 === 0 ? sMn : sMx), 'Alternate Theta': () => (ti % 2 === 0 ? sMn : sMx),
                'Alternate Phi': () => (pi % 2 === 0 ? sMn : sMx),
              }[p.size_distribution] || (() => lerp(rnd()));
              push(r, size(), ti / p.theta_divs, clearance(pt), rnd(), spd(), spd(), spd());
            }
          }
        }
        if (f.br0.length < n) f.info = `The grid holds ${f.br0.length} balls (layers × theta × phi).`;
        break;
      }
      case 'layers': {
        const L = p.layer_count;
        const per = Math.max(Math.floor(n / Math.max(L, 1)), 1);
        const avgR = (rMin + rMax) / 2;
        for (let i = 0; i < n; i++) {
          const layer = Math.min(Math.floor(i / per), L - 1);
          const row = i % per;
          const lt = layer / Math.max(L - 1, 1);
          const size = {
            'Top->Bottom': () => lerp(lt), 'Bottom->Top': () => lerpInv(lt),
            'Alternate Layer': () => (layer % 2 === 0 ? sMn : sMx), 'Alternate Row': () => (row % 2 === 0 ? sMn : sMx),
          }[p.size_distribution] || (() => lerp(rnd()));
          push(avgR, size(), frac(row / Math.max(per, 1) + layer * 0.08), clearance(1 - lt), layer / L, sMin + (1 - lt) * (sMax - sMin), sMin * 0.2, spd());
        }
        break;
      }
      case '3dModel': {
        if (!model) { f.error = 'Choose an OBJ file to place balls on a model.'; break; }
        const mode = p.placement_mode;
        const pts = mode === 'Edges' ? sampleEdgePoints(modelEdges(model), n) : samplePointsByGrid(modelPoints(model, mode), n);
        if (!pts.length) { f.error = `No ${mode.toLowerCase()} were found in the OBJ mesh.`; break; }
        const fitted = fitPoints(rotatePoints(pts, p.rotation_x, p.rotation_y, p.rotation_z), rMax);
        const note = { text: '' };
        const sizes = modelSizes(fitted, sMn, sMx, p.size_distribution, p.size_direction, note);
        fitted.forEach(([x, y, z], i) => {
          const r = Math.hypot(x, y, z);
          const th = r > 0 ? Math.atan2(y, x) / (2 * Math.PI) : 0;
          const ph = (Math.atan2(z, Math.hypot(x, y)) + Math.PI / 2) / Math.PI;
          push(r, sizes[i], frac(th), clamp(ph, 0, 1), 0, 0, 0, 0);
        });
        const src = mode === 'Edges' ? `${modelEdges(model).length} edges` : `${modelPoints(model, mode).length} ${mode.toLowerCase()}`;
        f.info = [`${fitted.length} of ${n} balls placed (source: ${src}).`, note.text].filter(Boolean).join(' ');
        break;
      }
      default:
        f.error = `Unknown preset ${s.preset}`;
    }
    return f;
  }

  /** PreviewWidget3D.step_animation (one frame; dir = +1 / -1, speed multiplier). Mutates f. */
  function stepFormation(f, poleClearance = 0, dir = 1) {
    for (let i = 0; i < f.ba.length; i++) {
      f.ba[i] = frac(f.ba[i] + f.bda[i] * dir);
      if (poleClearance > 0 && f.bdb[i] !== 0) {
        const cur = f.bb[i];
        let v = cur >= 0.75 ? (cur - 0.75) + 0.5 : cur <= 0.25 ? cur + 0.5 : (cur - 0.25) * 2;
        v += f.bdb[i] * dir * 2;
        if (1 - 2 * poleClearance > 0) {
          while (v < poleClearance || v > 1 - poleClearance) {
            if (v < poleClearance) v = poleClearance + (poleClearance - v);
            else v = (1 - poleClearance) - (v - (1 - poleClearance));
            f.bdb[i] = -f.bdb[i];
          }
        }
        f.bb[i] = frac(0.25 + v * 0.5);
      } else {
        f.bb[i] = frac(f.bb[i] + f.bdb[i] * dir);
      }
      f.bc[i] = frac(f.bc[i] + f.bdc[i] * dir);
    }
    return f;
  }

  const formationXyz = (f) => f.br0.map((r, i) => sphericalToXyz(r, f.ba[i], f.bb[i]));

  /** Snapshot of the visible frame for a slot (what save_to_slot stores). */
  function formationSlot(f, settings) {
    const xyz = formationXyz(f);
    return {
      preset: f.preset, n: f.br0.length,
      x: xyz.map((p) => p[0]), y: xyz.map((p) => p[1]), z: xyz.map((p) => p[2]),
      br0: f.br0.slice(), br: f.br.slice(), ba: f.ba.slice(), bb: f.bb.slice(), bc: f.bc.slice(),
      bda: f.bda.slice(), bdb: f.bdb.slice(), bdc: f.bdc.slice(),
      settings: JSON.parse(JSON.stringify(settings)),
    };
  }

  const EXPORT_DEFAULTS = { include_sizes: true, include_oscillation: false, include_speeds: false, include_spherical: false, use_fixed_point: true };

  /** _pack_formations_to_binary: per ball x,y,z(,size) as 8.8 little-endian int16. Returns {bytes, entries}. */
  function packFormations(slots, opts) {
    const bytes = [];
    const entries = [];
    const put16 = (v) => { const n = Math.trunc(v * 256) & 0xffff; bytes.push(n & 255, n >> 8); };
    for (const [num, s] of slots) {
      const offset = bytes.length;
      for (let i = 0; i < s.n; i++) {
        put16(s.x[i]); put16(s.y[i]); put16(s.z[i]);
        if (opts.include_sizes) put16(s.br[i]);
      }
      entries.push({ slot: num, preset: s.preset, n: s.n, offset, size: bytes.length - offset });
    }
    return { bytes, entries };
  }

  const GFX_LIMIT = 0x2000;

  /** export_formation_slots_p8: version 43, empty __lua__, data in __gfx__ (nibble-swapped). */
  function formationsCart(bytes) {
    if (bytes.length > GFX_LIMIT) throw new Error(`The data is ${bytes.length} bytes; the __gfx__ section holds ${GFX_LIMIT}. Use fewer balls or slots, or leave out the sizes.`);
    const b = bytes.length % 2 ? bytes.concat([0]) : bytes;
    let hex = '';
    for (const v of b) hex += (v & 15).toString(16) + (v >> 4).toString(16);
    const lines = [];
    for (let i = 0; i < hex.length; i += 128) lines.push(hex.slice(i, i + 128).padEnd(128, '0'));
    return `pico-8 cartridge // http://www.pico-8.com\nversion 43\n__lua__\n\n__gfx__\n${lines.join('\n')}\n`;
  }

  function formationsLoader(entries, opts, cartName = 'formations.p8', total = 0) {
    const bpb = opts.include_sizes ? 8 : 6;
    const list = entries.map((e) => `  [${e.slot}]={offset=${e.offset},n=${e.n}}, -- ${e.preset}`).join('\n');
    return [
      `-- ball formations from ${cartName} (${bpb} bytes per ball: x,y,z${opts.include_sizes ? ',size' : ''} as 8.8 fixed point)`,
      'formations={',
      list,
      '}',
      '',
      'function load_formations()',
      `  reload(0x8000,0x0,${total || '0x2000'},"${cartName}")`,
      'end',
      '',
      'function rd16(a)',
      '  return peek2(a)>>8 -- signed 8.8, little-endian',
      'end',
      '',
      '-- fills the global tables x,y,z,br for one slot',
      'function load_formation(slot)',
      '  local fm=formations[slot]',
      '  local a=0x8000+fm.offset',
      '  x,y,z,br={},{},{},{}',
      '  for i=1,fm.n do',
      '    x[i]=rd16(a) y[i]=rd16(a+2) z[i]=rd16(a+4)',
      opts.include_sizes ? `    br[i]=rd16(a+6)\n    a+=${bpb}` : `    br[i]=5\n    a+=${bpb}`,
      '  end',
      'end',
      '',
    ].join('\n');
  }

  /** export_formation_slots / _write_array: Lua tables with the selected arrays. */
  function formationsToLua(slots, opts) {
    const fixed = opts.use_fixed_point;
    const T = (s) => (v) => Math.trunc(v * s);
    let out = '-- PICO-8 3D Ball Formation Data\n-- Generated by LUT Creator\n';
    out += `-- Total formations: ${slots.length}\n`;
    out += fixed ? '-- Format: fixed-point integers\n--   coordinates and sizes: x256, angles: x1000, speeds: x10000\n\n' : '-- Format: floating-point numbers\n\n';
    for (const [num, s] of slots) {
      const name = `formation_${s.preset}_${num}`;
      const inc = ['xyz', opts.include_sizes && 'sizes', opts.include_oscillation && 'oscillation', opts.include_speeds && 'speeds', opts.include_spherical && 'spherical'].filter(Boolean);
      out += `-- Slot ${num}: ${s.preset}, ${s.n} balls\n-- Data: ${inc.join(', ')}\n${name}={\n  n=${s.n},\n`;
      const arr = (key, values, scale, digits) => {
        out += writeArray(key, fixed ? values.map(T(scale)) : values, fixed ? String : (v) => v.toFixed(digits));
      };
      arr('x', s.x, 256, 2); arr('y', s.y, 256, 2); arr('z', s.z, 256, 2);
      if (opts.include_sizes) arr('br', s.br, 256, 4);
      if (opts.include_oscillation) arr('bc', s.bc, 1000, 6);
      if (opts.include_speeds) { arr('bda', s.bda, 10000, 6); arr('bdb', s.bdb, 10000, 6); arr('bdc', s.bdc, 10000, 6); }
      if (opts.include_spherical) { arr('ba', s.ba, 1000, 6); arr('bb', s.bb, 1000, 6); arr('br0', s.br0, 256, 4); }
      out += '}\n\n';
    }
    return out;
  }

  /** export_formation_slots_pod */
  function formationsToPod(slots, opts) {
    const fixed = opts.use_fixed_point;
    const sc = (vals, s, d) => (fixed ? vals.map((v) => Math.trunc(v * s)) : vals.map((v) => round(v, d)));
    const formations = {};
    for (const [num, s] of slots) {
      const r = { preset: s.preset, n: s.n, x: sc(s.x, 256, 4), y: sc(s.y, 256, 4), z: sc(s.z, 256, 4) };
      if (opts.include_sizes) r.br = sc(s.br, 256, 4);
      if (opts.include_oscillation) r.bc = sc(s.bc, 1000, 6);
      if (opts.include_speeds) { r.bda = sc(s.bda, 10000, 6); r.bdb = sc(s.bdb, 10000, 6); r.bdc = sc(s.bdc, 10000, 6); }
      if (opts.include_spherical) { r.ba = sc(s.ba, 1000, 6); r.bb = sc(s.bb, 1000, 6); r.br0 = sc(s.br0, 256, 4); }
      formations[num] = r;
    }
    const eo = Object.fromEntries(Object.keys(EXPORT_DEFAULTS).map((k) => [k, !!opts[k]]));
    return `${toPod({ format: 'lut_creator_formation_3d', version: 1, export_options: eo, formations })}\n`;
  }

  return {
    pyRound, pyRandom,
    // line tool
    rasterizeLine, lineArray, linesToLua,
    // wave designer
    WAVE_DEFAULTS, WAVE_PARAMS, defaultWavePresets, renderWave, randomizeWave, q8, wavesCart, wavesLoader,
    // LUT 2D
    DEFAULT_CURVE, MOTION_DEFAULTS, curveComponent, buildMotion, enforceSeamlessLoop, motionToLua, motionToPod, toPod,
    // LUT 3D
    FORMATION_PRESETS, SIZE_DISTRIBUTIONS, PRESET_FIELDS, EXPORT_DEFAULTS, GFX_LIMIT,
    defaultPresetParams, newFormationSettings, generateFormation, stepFormation, formationXyz, formationSlot, sphericalToXyz,
    parseObj, packFormations, formationsCart, formationsLoader, formationsToLua, formationsToPod,
  };
})();

if (typeof module !== 'undefined') module.exports = P8Extras;

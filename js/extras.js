// js/extras.js
// Extra Tools workspace: smaller special-purpose tools behind one tab bar.
//   LUT Creator   (lut_creator)  - 2D motion paths + 3D ball formations as lookup tables
//   Wave Designer (osc_designer) - 16 scope waveforms -> waves.p8 data cart
//   Line Tool     (line_tool)    - 128x128 line drawing -> Lua line tables
//   + tools from other files that register in window.P8ExtraTools (js/terrain.js: Terrain Lab)
// Logic lives in js/extras-core.js (P8Extras).

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const X = P8Extras;
  const { rgbOf } = P8;
  const { el, $, toast, download, pickFile, store, confirmDialog, modal, showMessage } = App;

  const KEYS = { tab: 'p8suite.extras.tab', line: 'p8suite.extras.line', wave: 'extras.wave', lut: 'extras.lut' };
  const PICO = Array.from({ length: 16 }, (_, i) => `rgb(${rgbOf(i)})`);
  const TOOLS = {
    lut: 'Lookup tables for PICO-8 effects: 2D motion paths and 3D ball formations (port of lut_creator).',
    wave: '16 animated scope waveforms, exported as a waves.p8 data cart (port of osc_designer).',
    line: '128×128 line drawing for vector-style effects, exported as a Lua table (port of line_tool).',
  };

  const active = () => document.body.dataset.workspace === 'extras';
  let tab = store.get(KEYS.tab, 'lut');

  // ------------------------------------------------------------------ //
  // Small UI helpers                                                   //
  // ------------------------------------------------------------------ //

  const decimals = (step) => (String(step).split('.')[1] || '').length;

  /** Range slider with a value read-out. get() returns the current number. */
  function slider({ label, min, max, step = 1, value, onInput, title = '' }) {
    const input = el('input', { type: 'range', min, max, step, value, attrs: { 'aria-label': label } });
    const out = el('output', { className: 'ex-val' });
    const d = decimals(step);
    const show = () => { out.textContent = Number(input.value).toFixed(d); };
    input.addEventListener('input', () => { show(); onInput(Number(input.value)); });
    show();
    const node = el('label', { className: 'ex-slider', title }, el('span', { textContent: label }), input, out);
    node.set = (v) => { input.value = v; show(); };
    return node;
  }

  function numberField({ label, min, max, step = 1, value, onChange, width = 72 }) {
    const input = el('input', { type: 'number', min, max, step, value, inputMode: 'numeric', style: `width:${width}px` });
    input.addEventListener('change', () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) v = Number(min);
      v = Math.min(Number(max), Math.max(Number(min), v));
      input.value = v;
      onChange(v);
    });
    const node = el('label', { className: 'field' }, el('span', { textContent: label }), input);
    node.set = (v) => { input.value = v; };
    return node;
  }

  function checkbox(label, checked, onChange, title = '') {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    const node = el('label', { className: 'check', title }, input, el('span', { textContent: label }));
    node.set = (v) => { input.checked = v; };
    return node;
  }

  function select(label, options, value, onChange) {
    const s = el('select', { className: 'select select-sm', attrs: { 'aria-label': label } },
      ...options.map((o) => (Array.isArray(o) ? el('option', { value: o[0], textContent: o[1] }) : el('option', { value: o, textContent: o }))));
    s.value = value;
    s.addEventListener('change', () => onChange(s.value));
    const node = el('label', { className: 'field' }, el('span', { textContent: label }), s);
    node.set = (v) => { s.value = v; };
    node.select = s;
    return node;
  }

  const btn = (label, onClick, { primary = false, title = '' } = {}) => el('button', { type: 'button', className: `btn btn-sm${primary ? ' btn-primary' : ''}`, textContent: label, title, onclick: onClick });
  const group = (title, ...children) => el('fieldset', { className: 'ex-group' }, el('legend', { textContent: title }), ...children);
  const row = (...children) => el('div', { className: 'ex-row' }, ...children);

  /** Code output dialog with copy / download. */
  async function showCode(title, code, filename, note = '') {
    const ta = el('textarea', { className: 'code-out', readOnly: true, spellcheck: false, value: code, rows: 18 });
    await modal({
      title,
      wide: true,
      body: el('div', { className: 'dialog-form' }, note ? el('p', { className: 'muted', textContent: note }) : null, ta),
      actions: [
        { label: 'Copy', onClick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied to the clipboard.'); } catch { ta.select(); } } },
        { label: `Download ${filename.slice(filename.lastIndexOf('.'))}`, onClick: () => download(code, filename) },
      ],
      buttons: [{ label: 'Close', primary: true, value: true }],
    });
  }

  /** Canvas sized to its box at device resolution; returns {ctx, w, h} in CSS pixels. */
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // ================================================================== //
  // Line Tool                                                          //
  // ================================================================== //

  const line = (() => {
    const savedLine = store.get(KEYS.line, {}) || {};
    const st = {
      lines: Array.isArray(savedLine.lines) ? savedLine.lines : [],
      redo: [],
      color: savedLine.color ?? 7,
      mode: savedLine.mode || 'single',
      count: savedLine.count || 4,
      cycle: savedLine.cycle !== false,
      vector: savedLine.vector !== false,
      pixel: savedLine.pixel !== false,
      bg: savedLine.bg ?? 0,
      format: savedLine.format || 'keyed',
      name: savedLine.name || 'lines',
      drag: null,
      trace: null,        // canvas of a library image shown under the lines
      traceAlpha: 0.4,
    };
    const canvas = el('canvas', { className: 'ex-line-canvas', tabIndex: 0, attrs: { 'aria-label': 'Line canvas, 128 by 128 pixels' } });
    const info = el('p', { className: 'muted ex-info' });
    const palette = el('div', { className: 'ex-palette', role: 'radiogroup', attrs: { 'aria-label': 'Line color' } });
    let view = { s: 4, ox: 0, oy: 0 };

    const persist = () => store.set(KEYS.line, { lines: st.lines, color: st.color, mode: st.mode, count: st.count, cycle: st.cycle, vector: st.vector, pixel: st.pixel, bg: st.bg, format: st.format, name: st.name });

    function renderPalette() {
      palette.replaceChildren(...PICO.map((c, i) => el('button', {
        type: 'button', className: 'ex-sw', style: `--sw:${c}`, dataset: { c: String(i) }, title: `Color ${i}`,
        attrs: { role: 'radio', 'aria-checked': String(i === st.color), 'aria-label': `Color ${i}` },
      })));
    }

    const toPx = (e) => {
      const r = canvas.getBoundingClientRect();
      return [
        Math.max(0, Math.min(127, Math.floor((e.clientX - r.left - view.ox) / view.s))),
        Math.max(0, Math.min(127, Math.floor((e.clientY - r.top - view.oy) / view.s))),
      ];
    };

    function snap(a, b, shift) {
      if (!shift) return b;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.max(Math.abs(dx), Math.abs(dy));
      return [Math.max(0, Math.min(127, a[0] + Math.round(Math.cos(ang) * len))), Math.max(0, Math.min(127, a[1] + Math.round(Math.sin(ang) * len)))];
    }

    function pending(a, b) {
      const set = st.mode === 'array' ? X.lineArray(a[0], a[1], b[0], b[1], st.count) : [[a[0], a[1], b[0], b[1]]];
      return set.map(([x0, y0, x1, y1], i) => ({ x0, y0, x1, y1, c: st.mode === 'array' && st.cycle ? (st.color + i) % 16 : st.color }));
    }

    function draw() {
      const { ctx, w, h } = fitCanvas(canvas);
      const s = Math.max(1, Math.floor(Math.min(w, h) / 128 * (window.devicePixelRatio || 1)) / (window.devicePixelRatio || 1));
      view = { s, ox: Math.round((w - 128 * s) / 2), oy: Math.round((h - 128 * s) / 2) };
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = PICO[st.bg];
      ctx.fillRect(view.ox, view.oy, 128 * s, 128 * s);
      if (st.trace) {
        ctx.globalAlpha = st.traceAlpha;
        ctx.drawImage(st.trace, view.ox, view.oy, 128 * s, 128 * s);
        ctx.globalAlpha = 1;
      }
      const all = st.drag?.preview ? st.lines.concat(st.drag.preview) : st.lines;
      if (st.pixel) {
        for (const l of all) {
          ctx.fillStyle = PICO[l.c];
          for (const [x, y] of X.rasterizeLine(l.x0, l.y0, l.x1, l.y1)) ctx.fillRect(view.ox + x * s, view.oy + y * s, s, s);
        }
      }
      if (s >= 5) {
        ctx.fillStyle = 'rgba(128,128,140,0.18)';
        for (let i = 0; i <= 128; i++) {
          ctx.fillRect(view.ox + i * s, view.oy, 1, 128 * s);
          ctx.fillRect(view.ox, view.oy + i * s, 128 * s, 1);
        }
      }
      if (st.vector) {
        ctx.lineWidth = 1;
        for (const l of all) {
          ctx.strokeStyle = st.pixel ? 'rgba(255,255,255,0.75)' : PICO[l.c];
          ctx.beginPath();
          ctx.moveTo(view.ox + (l.x0 + 0.5) * s, view.oy + (l.y0 + 0.5) * s);
          ctx.lineTo(view.ox + (l.x1 + 0.5) * s, view.oy + (l.y1 + 0.5) * s);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = 'rgba(160,160,175,0.7)';
      ctx.strokeRect(view.ox - 0.5, view.oy - 0.5, 128 * s + 1, 128 * s + 1);
      const last = st.lines[st.lines.length - 1];
      info.textContent = `${st.lines.length} lines${last ? ` · last (${last.x0},${last.y0}) → (${last.x1},${last.y1})` : ''}${st.drag?.preview ? ` · drawing (${st.drag.a[0]},${st.drag.a[1]}) → (${st.drag.b[0]},${st.drag.b[1]})` : ''}`;
    }

    function commit(newLines) {
      st.lines.push(...newLines);
      st.redo = [];
      persist();
      draw();
    }
    function undo() { const l = st.lines.pop(); if (l) { st.redo.push(l); persist(); draw(); } }
    function redo() { const l = st.redo.pop(); if (l) { st.lines.push(l); persist(); draw(); } }

    async function clearAll() {
      if (!st.lines.length || !(await confirmDialog('Clear lines', `Remove all ${st.lines.length} lines?`, 'Clear'))) return;
      st.redo = st.lines.reverse();
      st.lines = [];
      persist();
      draw();
    }

    function exportLua() {
      if (!st.lines.length) { toast('Draw some lines first.', 'warn'); return; }
      const name = st.name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'lines';
      showCode('Line data', X.linesToLua(st.lines, { format: st.format, name }), `${name}.lua`,
        `Colors are PICO-8 color numbers. Call draw_${name}() in _draw().`);
    }

    async function toLibrary() {
      if (!st.lines.length) { toast('Draw some lines first.', 'warn'); return; }
      const px = new Uint8Array(128 * 128).fill(st.bg);
      for (const l of st.lines) for (const [x, y] of X.rasterizeLine(l.x0, l.y0, l.x1, l.y1)) px[y * 128 + x] = l.c;
      await S.assets.put(S.imageAsset({ name: st.name || 'lines', w: 128, h: 128, pixels: px, transparent: st.bg, source: 'line-tool' }));
      toast('Saved the pixel view to the library.');
    }

    async function traceImage() {
      const a = await S.pickAsset({ title: 'Image to trace (shown under the lines)' });
      if (!a) return;
      st.trace = S.assetCanvas(a);
      traceRow.hidden = false;
      draw();
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      const p = toPx(e);
      st.drag = { a: p, b: p, preview: null };
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!st.drag) return;
      const b = snap(st.drag.a, toPx(e), e.shiftKey);
      st.drag.b = b;
      st.drag.preview = b[0] === st.drag.a[0] && b[1] === st.drag.a[1] ? null : pending(st.drag.a, b);
      draw();
    });
    const end = () => {
      const d = st.drag;
      st.drag = null;
      if (d?.preview) commit(d.preview); else draw();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => { st.drag = null; draw(); });
    palette.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      st.color = Number(b.dataset.c);
      persist();
      renderPalette();
    });

    const countField = numberField({ label: 'Lines', min: 2, max: 128, value: st.count, onChange: (v) => { st.count = v; persist(); } });
    const modeSel = select('Mode', [['single', '1 px line'], ['array', 'Array of parallel lines']], st.mode, (v) => { st.mode = v; countWrap.hidden = v !== 'array'; persist(); });
    const countWrap = row(countField, checkbox('Cycle colors', st.cycle, (v) => { st.cycle = v; persist(); }, 'Each parallel line uses the next PICO-8 color'));
    countWrap.hidden = st.mode !== 'array';
    const traceRow = row(slider({ label: 'Trace opacity', min: 0.1, max: 1, step: 0.05, value: st.traceAlpha, onInput: (v) => { st.traceAlpha = v; draw(); } }),
      btn('Remove', () => { st.trace = null; traceRow.hidden = true; draw(); }));
    traceRow.hidden = true;

    const panel = el('div', { className: 'ex-split' },
      el('section', { className: 'card ex-stage' }, canvas, info),
      el('section', { className: 'card ex-controls' },
        group('Color', palette, row(select('Background', PICO.map((_, i) => [String(i), `color ${i}`]), String(st.bg), (v) => { st.bg = Number(v); persist(); draw(); }))),
        group('Line', modeSel, countWrap, el('p', { className: 'muted', textContent: 'Drag on the canvas to draw. Shift snaps to 45°.' })),
        group('View',
          row(checkbox('Vector', st.vector, (v) => { st.vector = v; persist(); draw(); }), checkbox('Pixels', st.pixel, (v) => { st.pixel = v; persist(); draw(); })),
          row(btn('Trace library image…', traceImage, { title: 'Show a library image under the lines (not exported)' })), traceRow),
        group('Edit', row(btn('Undo', undo, { title: 'Ctrl+Z' }), btn('Redo', redo, { title: 'Ctrl+Y' }), btn('Clear', clearAll))),
        group('Export',
          row(el('label', { className: 'field' }, el('span', { textContent: 'Table name' }), (() => {
            const i = el('input', { type: 'text', value: st.name, spellcheck: false, style: 'width:110px' });
            i.addEventListener('change', () => { st.name = i.value.trim() || 'lines'; persist(); });
            return i;
          })()),
          select('Format', [['keyed', '{x0=,y0=,x1=,y1=,c=}'], ['compact', '{x0,y0,x1,y1,c}']], st.format, (v) => { st.format = v; persist(); })),
          row(btn('Export Lua…', exportLua, { primary: true }), btn('Pixels → Library', toLibrary)))));

    renderPalette();
    return {
      panel, draw,
      key(e) {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return true; }
        if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return true; }
        return false;
      },
    };
  })();

  // ================================================================== //
  // Wave Designer                                                      //
  // ================================================================== //

  const wave = (() => {
    const st = {
      presets: X.defaultWavePresets(),
      idx: 0,
      cache: [],
      playing: true,
      speed: 0.25,
      phase: 0,
      t: 0,
      xyRatio: 1.13, xyRot: 0.18, xyWob: 0.1,
    };
    const timeCv = el('canvas', { className: 'ex-scope', attrs: { 'aria-label': 'Waveform over time' } });
    const xyCv = el('canvas', { className: 'ex-scope', attrs: { 'aria-label': 'XY scope' } });
    const strip = el('div', { className: 'ex-wave-strip', attrs: { 'aria-label': 'All 16 presets' } });
    const status = el('p', { className: 'muted ex-info' });
    const presetSel = el('select', { className: 'select', attrs: { 'aria-label': 'Preset' } });
    const nameInput = el('input', { type: 'text', spellcheck: false, attrs: { 'aria-label': 'Preset name' }, style: 'width:120px' });
    const controls = {};
    let saveTimer = 0;

    const cur = () => st.presets[st.idx];
    const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => S.kv.set(KEYS.wave, { presets: st.presets, idx: st.idx }), 300); };

    function refresh() {
      st.cache[st.idx] = X.renderWave(cur());
      const w = st.cache[st.idx];
      const pk = Math.max(...w.map(Math.abs));
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      status.textContent = `Peak ${pk.toFixed(3)} · mean ${mean.toFixed(3)} · preset ${st.idx + 1}/16`;
      paintThumb(st.idx);
    }

    function paintThumb(i) {
      const c = strip.children[i]?.querySelector('canvas');
      if (!c) return;
      const w = st.cache[i] || (st.cache[i] = X.renderWave(st.presets[i]));
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, 64, 32);
      g.strokeStyle = PICO[11];
      g.beginPath();
      w.forEach((v, k) => { const x = (k / 255) * 63; const y = 16 - v * 14; if (k) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    }

    function renderStrip() {
      strip.replaceChildren(...st.presets.map((p, i) => el('button', {
        type: 'button', className: 'ex-wave-thumb', dataset: { i: String(i) }, title: `${i + 1}: ${p.name}`,
        attrs: { 'aria-pressed': String(i === st.idx) },
      }, el('canvas', { width: 64, height: 32 }), el('span', { textContent: String(i + 1).padStart(2, '0') }))));
      st.presets.forEach((_, i) => paintThumb(i));
    }

    function loadUi() {
      presetSel.replaceChildren(...st.presets.map((p, i) => el('option', { value: String(i), textContent: `${String(i + 1).padStart(2, '0')} - ${p.name}` })));
      presetSel.value = String(st.idx);
      nameInput.value = cur().name;
      for (const [k, c] of Object.entries(controls)) c.set(cur()[k]);
      for (const b of strip.children) b.setAttribute('aria-pressed', String(Number(b.dataset.i) === st.idx));
      refresh();
    }

    function selectPreset(i) {
      st.idx = (i + 16) % 16;
      loadUi();
      save();
    }

    function drawScope(cv, mode) {
      const { ctx, w, h } = fitCanvas(cv);
      const side = Math.min(w, h);
      const x0 = (w - side) / 2;
      const y0 = (h - side) / 2;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(x0, y0, side, side);
      const cx = x0 + side / 2;
      const cy = y0 + side / 2;
      ctx.strokeStyle = 'rgb(45,70,75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, cy); ctx.lineTo(x0 + side, cy); ctx.moveTo(cx, y0); ctx.lineTo(cx, y0 + side);
      ctx.stroke();
      const s = st.cache[st.idx];
      if (!s) return;
      const n = s.length;
      const start = Math.floor(st.phase * n) % n;
      const amp = side * 0.42;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, side, side);
      ctx.clip();
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (mode === 'time') {
        const breath = 1 + 0.06 * Math.sin(st.t * 2 * Math.PI * 0.37);
        const yshift = 0.03 * Math.sin(st.t * 2 * Math.PI * 0.23) * amp;
        ctx.strokeStyle = PICO[11];
        for (let i = 0; i < n; i++) {
          const x = x0 + (i * (side - 1)) / (n - 1);
          const y = cy - (s[(start + i) % n] * breath * amp + yshift);
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
      } else {
        const off = cur().xy_off + st.xyWob * Math.sin(st.t * 2 * Math.PI * 0.17);
        const offi = ((Math.floor(off * n) % n) + n) % n;
        const startY = Math.floor(st.phase * st.xyRatio * n) % n;
        const ang = st.t * 2 * Math.PI * st.xyRot;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        ctx.strokeStyle = PICO[12];
        for (let i = 0; i < n; i++) {
          const a = s[(start + i) % n];
          const b = s[(startY + i + offi) % n];
          const x = cx + (a * ca - b * sa) * amp;
          const y = cy - (a * sa + b * ca) * amp;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgb(180,180,180)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(mode === 'time' ? 'TIME' : 'XY (animated)', x0 + 8, y0 + 18);
    }

    function draw() { drawScope(timeCv, 'time'); drawScope(xyCv, 'xy'); }

    function tick(dt) {
      st.t += dt;
      if (st.playing) st.phase = (st.phase + st.speed * dt) % 1;
      draw();
    }

    function exportCart() {
      const waves = st.presets.map((p) => X.renderWave(p));
      download(X.wavesCart(waves), 'waves.p8');
      toast('waves.p8 downloaded. The loader snippet is under “Loader code”.');
    }

    function copyNext() {
      const dst = (st.idx + 1) % 16;
      st.presets[dst] = { ...cur(), name: st.presets[dst].name };
      st.cache[dst] = null;
      paintThumb(dst);
      save();
      toast(`Copied preset ${st.idx + 1} → ${dst + 1}`);
    }

    function setPreset(p) {
      st.presets[st.idx] = p;
      loadUi();
      save();
    }

    async function loadProject() {
      const f = await pickFile('.json,application/json');
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const list = Array.isArray(data) ? data : data.presets;
        if (!Array.isArray(list) || !list.length) throw new Error('No "presets" list found.');
        st.presets = Array.from({ length: 16 }, (_, i) => ({ ...X.WAVE_DEFAULTS, name: `p${i + 1}`, ...(list[i] || {}) }));
        st.cache = [];
        st.idx = 0;
        renderStrip();
        loadUi();
        save();
        toast(`Loaded ${f.name}`);
      } catch (err) {
        showMessage('Load project', `Could not read ${f.name}:\n${err.message}`);
      }
    }

    const groups = Object.entries(X.WAVE_PARAMS).map(([title, params]) => group(title, ...params.map(([key, label, min, max, step]) => {
      const c = slider({ label, min, max, step, value: cur()[key], onInput: (v) => { cur()[key] = v; refresh(); save(); } });
      controls[key] = c;
      return c;
    })));
    controls.do_norm = checkbox('Normalize', cur().do_norm, (v) => { cur().do_norm = v; refresh(); save(); });
    groups[2].append(controls.do_norm);

    presetSel.addEventListener('change', () => selectPreset(Number(presetSel.value)));
    nameInput.addEventListener('change', () => {
      cur().name = nameInput.value.trim() || `p${st.idx + 1}`;
      loadUi();
      save();
    });
    strip.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) selectPreset(Number(b.dataset.i));
    });
    const speed = slider({ label: 'Speed', min: 0, max: 2, step: 0.01, value: st.speed, onInput: (v) => { st.speed = v; } });

    const panel = el('div', { className: 'ex-wave' },
      el('section', { className: 'card ex-wave-top' },
        row(el('label', { className: 'field' }, el('span', { textContent: 'Preset' }), presetSel), el('label', { className: 'field' }, el('span', { textContent: 'Name' }), nameInput),
          btn('Randomize', () => setPreset(X.randomizeWave(cur())), { title: 'Random values for this preset (Ctrl+R)' }),
          btn('Copy to next', copyNext, { title: 'Copy this preset into the next slot (Ctrl+D)' }),
          btn('Reset', () => setPreset({ ...X.WAVE_DEFAULTS, name: cur().name, noise_seed: 1000 + st.idx * 37, f_sin: 1 + (st.idx % 4) })),
          el('span', { className: 'spacer' }),
          btn('Load…', loadProject, { title: 'Load a project (.json)' }),
          btn('Save…', () => download(JSON.stringify({ format: 'wave_designer', version: 1, presets: st.presets }, null, 2), 'waves_project.json'), { title: 'Save all 16 presets as .json' }),
          btn('Loader code', () => showCode('Reading waves.p8', X.wavesLoader('waves.p8'), 'waves_loader.lua', 'Each wave is 256 unsigned bytes (0 = -1, 255 = +1) in the __map__ section of waves.p8.')),
          btn('Export waves.p8', exportCart, { primary: true, title: 'All 16 waves as a PICO-8 data cart (Ctrl+E)' })),
        strip),
      el('section', { className: 'card ex-wave-scopes' },
        el('div', { className: 'ex-scopes' }, timeCv, xyCv),
        row(checkbox('Play', st.playing, (v) => { st.playing = v; }), speed, el('span', { className: 'spacer' }), status)),
      el('section', { className: 'ex-wave-groups' }, ...groups));

    S.kv.get(KEYS.wave).then((d) => {
      if (d && Array.isArray(d.presets) && d.presets.length === 16) {
        st.presets = d.presets.map((p) => ({ ...X.WAVE_DEFAULTS, ...p }));
        st.idx = Math.min(15, d.idx || 0);
        st.cache = [];
      }
      renderStrip();
      loadUi();
    });
    renderStrip();
    loadUi();

    return {
      panel, draw, tick,
      key(e) {
        const mod = e.ctrlKey || e.metaKey;
        const k = e.key.toLowerCase();
        if (mod && k === 'r') { e.preventDefault(); setPreset(X.randomizeWave(cur())); return true; }
        if (mod && k === 'd') { e.preventDefault(); copyNext(); return true; }
        if (mod && k === 'e') { e.preventDefault(); exportCart(); return true; }
        if (!mod && (e.key === 'PageDown' || e.key === 'PageUp')) { e.preventDefault(); selectPreset(st.idx + (e.key === 'PageDown' ? 1 : -1)); return true; }
        return false;
      },
    };
  })();

  // ================================================================== //
  // LUT Creator                                                        //
  // ================================================================== //

  const lut = (() => {
    const st = {
      mode: '2d',
      aspect: 'pico8',
      // 2D
      motion: JSON.parse(JSON.stringify(X.MOTION_DEFAULTS)),
      path: { x: [], y: [] },
      frame: 0,
      dragPoint: -1,
      // 3D
      settings: X.newFormationSettings(),
      model: null,
      modelName: '',
      form: null,
      initial: null,
      slots: {},          // slot number -> formationSlot()
      slot: 1,
      exportOpts: { ...X.EXPORT_DEFAULTS },
      animate: false,
      rotate: true,
      camSpeed: 1,
      ballSpeed: 1,
      camAngle: 0,
      yaw: 0.6,
      pitch: 0.5,
      dist: 200,
      overlaps: false,
      overlapSet: null,
    };
    let saveTimer = 0;
    const save = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => S.kv.set(KEYS.lut, {
        mode: st.mode, aspect: st.aspect, motion: st.motion, settings: st.settings, slots: st.slots, slot: st.slot, exportOpts: st.exportOpts,
      }), 400);
    };

    const screen = () => (st.aspect === 'picotron' ? { w: 480, h: 270 } : { w: 128, h: 128 });

    // ---------------- 2D ---------------- //

    const cv2 = el('canvas', { className: 'ex-lut-canvas', attrs: { 'aria-label': 'Motion path preview' } });
    const info2 = el('p', { className: 'muted ex-info' });
    let map2 = { s: 1, ox: 0, oy: 0 };

    function regen2d() {
      st.path = X.buildMotion(st.motion);
      st.frame = 0;
      const n = st.path.x.length;
      const xs = st.path.x;
      const ys = st.path.y;
      const range = n ? `x ${Math.min(...xs).toFixed(1)}…${Math.max(...xs).toFixed(1)}, y ${Math.min(...ys).toFixed(1)}…${Math.max(...ys).toFixed(1)}` : '';
      info2.textContent = `LUT length ${n}${range ? ` · ${range}` : ''}${st.motion.curve.on ? ` · ${st.motion.curve.points.length} curve points${st.motion.curve.closed ? ' (closed)' : ''}` : ''}`;
      save();
    }

    function draw2d() {
      const { ctx, w, h } = fitCanvas(cv2);
      const sc = screen();
      const s = Math.min((w - 16) / sc.w, (h - 16) / sc.h);
      map2 = { s, ox: (w - sc.w * s) / 2, oy: (h - sc.h * s) / 2 };
      const P = (x, y) => [map2.ox + x * s, map2.oy + y * s];
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(map2.ox, map2.oy, sc.w * s, sc.h * s);
      ctx.strokeStyle = 'rgba(41,173,255,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...P(sc.w / 2, 0)); ctx.lineTo(...P(sc.w / 2, sc.h));
      ctx.moveTo(...P(0, sc.h / 2)); ctx.lineTo(...P(sc.w, sc.h / 2));
      ctx.stroke();
      const { x, y } = st.path;
      const n = x.length;
      if (n) {
        ctx.strokeStyle = PICO[13];
        ctx.beginPath();
        for (let i = 0; i < n; i++) { const p = P(x[i], y[i]); if (i) ctx.lineTo(...p); else ctx.moveTo(...p); }
        if (st.motion.loop) ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = PICO[6];
        const dot = Math.max(1, s * 0.5);
        for (let i = 0; i < n; i++) { const p = P(x[i], y[i]); ctx.fillRect(p[0] - dot / 2, p[1] - dot / 2, dot, dot); }
        const f = st.frame % n;
        const p = P(x[f], y[f]);
        ctx.fillStyle = PICO[8];
        ctx.beginPath();
        ctx.arc(p[0], p[1], Math.max(4, s * 2), 0, Math.PI * 2);
        ctx.fill();
      }
      if (st.motion.curve.on) {
        const pts = st.motion.curve.points;
        ctx.strokeStyle = 'rgba(255,236,39,0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        pts.forEach(([px, py], i) => { const p = P(px, py); if (i) ctx.lineTo(...p); else ctx.moveTo(...p); });
        ctx.stroke();
        ctx.setLineDash([]);
        pts.forEach(([px, py], i) => {
          const p = P(px, py);
          ctx.fillStyle = i === st.dragPoint ? PICO[7] : PICO[10];
          ctx.strokeStyle = '#000';
          ctx.beginPath();
          ctx.arc(p[0], p[1], 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#000';
          ctx.font = 'bold 9px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(i + 1), p[0], p[1] + 3);
          ctx.textAlign = 'start';
        });
      }
    }

    const toLogical = (e) => {
      const r = cv2.getBoundingClientRect();
      return [(e.clientX - r.left - map2.ox) / map2.s, (e.clientY - r.top - map2.oy) / map2.s];
    };
    cv2.addEventListener('pointerdown', (e) => {
      if (!st.motion.curve.on) return;
      const [lx, ly] = toLogical(e);
      const hit = 8 / map2.s;
      let best = -1;
      let bd = Infinity;
      st.motion.curve.points.forEach(([px, py], i) => { const d = Math.hypot(px - lx, py - ly); if (d < bd) { bd = d; best = i; } });
      if (best < 0 || bd > hit) return;
      st.dragPoint = best;
      cv2.setPointerCapture(e.pointerId);
    });
    cv2.addEventListener('pointermove', (e) => {
      if (st.dragPoint < 0) return;
      const sc = screen();
      const [lx, ly] = toLogical(e);
      st.motion.curve.points[st.dragPoint] = [Math.round(Math.max(0, Math.min(sc.w, lx)) * 10) / 10, Math.round(Math.max(0, Math.min(sc.h, ly)) * 10) / 10];
      regen2d();
    });
    const endDrag = () => { if (st.dragPoint >= 0) { st.dragPoint = -1; regen2d(); } };
    cv2.addEventListener('pointerup', endDrag);
    cv2.addEventListener('pointercancel', endDrag);

    const comp2 = (title, key, fields) => {
      const c = st.motion[key];
      return group(title, checkbox('Enabled', c.on, (v) => { c.on = v; regen2d(); }),
        ...fields.map(([k, label, min, max]) => slider({ label, min, max, step: 1, value: c[k], onInput: (v) => { c[k] = v; regen2d(); } })));
    };

    function controls2d() {
      const m = st.motion;
      const curve = m.curve;
      return [
        group('LUT', numberField({ label: 'Length', min: 4, max: 2048, value: m.length, onChange: (v) => { m.length = v; regen2d(); } }),
          checkbox('Force seamless loop', m.loop, (v) => { m.loop = v; regen2d(); }, 'Bend the path so the last point meets the first')),
        comp2('Circle', 'circle', [['radius', 'Radius', 0, 64], ['turns', 'Turns', 0, 10]]),
        comp2('Vertical sine', 'sine', [['amp', 'Amplitude', 0, 64], ['turns', 'Turns', 0, 10]]),
        comp2('Figure-8', 'fig8', [['amp', 'Amplitude', 0, 64], ['turns', 'Turns', 0, 10]]),
        group('Curve',
          row(checkbox('Enabled', curve.on, (v) => { curve.on = v; regen2d(); }), checkbox('Closed loop', curve.closed, (v) => { curve.closed = v; regen2d(); })),
          row(btn('Add point', () => {
            if (curve.points.length >= 16) return;
            const p = curve.points;
            p.push(p.length >= 2 ? [(p[p.length - 2][0] + p[p.length - 1][0]) / 2, (p[p.length - 2][1] + p[p.length - 1][1]) / 2] : [64, 64]);
            regen2d();
          }), btn('Remove point', () => { if (curve.points.length > 2) { curve.points.pop(); regen2d(); } }),
          btn('Reset', () => { curve.points = X.DEFAULT_CURVE.map((p) => [...p]); regen2d(); })),
          el('p', { className: 'muted', textContent: 'Drag the yellow points in the preview. The curve is added relative to the screen centre.' })),
        group('Export',
          row(btn('Lua table…', () => {
            if (!st.path.x.length) return;
            showCode('motion_lut', X.motionToLua(st.path.x, st.path.y), 'motion_lut.lua', 'motion_lut.x[i], motion_lut.y[i] for i=1,motion_lut.n (screen coordinates).');
          }, { primary: true }),
          btn('Picotron POD', () => download(X.motionToPod(st.path.x, st.path.y), 'motion_lut.pod')))),
      ];
    }

    // ---------------- 3D ---------------- //

    const cv3 = el('canvas', { className: 'ex-lut-canvas', attrs: { 'aria-label': '3D ball formation preview' } });
    const info3 = el('p', { className: 'muted ex-info' });
    const presetBox = el('div', { className: 'ex-preset-params' });
    const slotInfo = el('span', { className: 'muted' });

    const poleClearance = () => st.settings.params[st.settings.preset]?.pole_clearance || 0;

    function regen3d() {
      const s = st.settings;
      st.form = X.generateFormation(s, s.preset === '3dModel' ? st.model : null);
      st.initial = { ba: st.form.ba.slice(), bb: st.form.bb.slice(), bc: st.form.bc.slice(), bdb: st.form.bdb.slice() };
      st.overlapSet = null;
      update3dInfo();
      save();
    }

    function update3dInfo() {
      const f = st.form;
      if (!f) return;
      info3.textContent = f.error || `${f.preset}: ${f.br0.length} balls${f.info ? ` · ${f.info}` : ''}`;
      info3.classList.toggle('ex-error', !!f.error);
    }

    function computeOverlaps() {
      const f = st.form;
      const xyz = X.formationXyz(f);
      const set = new Set();
      const n = xyz.length;
      if (n > 3000) return set;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const d = Math.hypot(xyz[i][0] - xyz[j][0], xyz[i][1] - xyz[j][1], xyz[i][2] - xyz[j][2]);
          if (d < (f.br[i] * 0.25 + f.br[j] * 0.25) * 0.9) { set.add(i); set.add(j); }
        }
      }
      return set;
    }

    function draw3d() {
      const { ctx, w, h } = fitCanvas(cv3);
      const sc = screen();
      const s = Math.min((w - 16) / sc.w, (h - 16) / sc.h);
      const vw = sc.w * s;
      const vh = sc.h * s;
      const ox = (w - vw) / 2;
      const oy = (h - vh) / 2;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      ctx.fillRect(ox, oy, vw, vh);
      const f = st.form;
      if (!f || !f.br0.length) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, vw, vh);
      ctx.clip();
      const focal = (vh / 2) / Math.tan(Math.PI / 6);
      const cy = Math.cos(st.yaw + st.camAngle);
      const sy = Math.sin(st.yaw + st.camAngle);
      const ce = Math.cos(st.pitch);
      const se = Math.sin(st.pitch);
      const proj = (x, y, z) => {
        const xr = x * cy - y * sy;
        const yr = x * sy + y * cy;
        const d = st.dist + yr * ce - z * se;
        const k = focal / Math.max(1, d);
        return [ox + vw / 2 + xr * k, oy + vh / 2 - (yr * se + z * ce) * k, d, k];
      };
      // ground grid (like the desktop GL grid: 200 units, 10 per line)
      ctx.strokeStyle = 'rgba(120,120,140,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let g = -100; g <= 100; g += 10) {
        let a = proj(g, -100, 0); let b = proj(g, 100, 0);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        a = proj(-100, g, 0); b = proj(100, g, 0);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      }
      ctx.stroke();
      if (st.overlaps && !st.overlapSet) st.overlapSet = computeOverlaps();
      const balls = X.formationXyz(f).map(([x, y, z], i) => [...proj(x, y, z), i]);
      balls.sort((a, b) => b[2] - a[2]);
      const dMin = st.dist - 130;
      for (const [px, py, d, k, i] of balls) {
        const r = Math.max(0.75, f.br[i] * 0.25 * k);
        const shade = Math.max(0.35, Math.min(1, 1 - (d - dMin) / 260));
        const red = st.overlaps && st.overlapSet?.has(i);
        ctx.fillStyle = red ? `rgba(255,${Math.round(40 * shade)},${Math.round(60 * shade)},0.9)` : `rgba(${Math.round(255 * shade)},${Math.round(255 * shade)},${Math.round(255 * shade)},0.85)`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    let orbit = null;
    cv3.addEventListener('pointerdown', (e) => { orbit = { x: e.clientX, y: e.clientY, yaw: st.yaw, pitch: st.pitch }; cv3.setPointerCapture(e.pointerId); });
    cv3.addEventListener('pointermove', (e) => {
      if (!orbit) return;
      st.yaw = orbit.yaw - (e.clientX - orbit.x) * 0.01;
      st.pitch = Math.max(-1.5, Math.min(1.5, orbit.pitch + (e.clientY - orbit.y) * 0.01));
      if (!running()) draw3d();
    });
    cv3.addEventListener('pointerup', () => { orbit = null; });
    cv3.addEventListener('wheel', (e) => {
      e.preventDefault();
      st.dist = Math.max(60, Math.min(800, st.dist * (e.deltaY > 0 ? 1.1 : 1 / 1.1)));
      if (!running()) draw3d();
    }, { passive: false });

    function step(dir) {
      X.stepFormation(st.form, poleClearance(), dir);
      st.overlapSet = null;
      draw3d();
    }

    function resetFrame() {
      if (!st.initial) return;
      Object.assign(st.form, { ba: st.initial.ba.slice(), bb: st.initial.bb.slice(), bc: st.initial.bc.slice(), bdb: st.initial.bdb.slice() });
      st.overlapSet = null;
      draw3d();
    }

    function renderPresetParams() {
      const s = st.settings;
      const p = s.params[s.preset];
      const nodes = X.PRESET_FIELDS[s.preset].map(([key, label, min, max, stp]) => slider({ label, min, max, step: stp, value: p[key], onInput: (v) => { p[key] = v; regen3d(); } }));
      const sizeMin = slider({ label: 'Size min', min: 1, max: 20, step: 1, value: p.size_min, onInput: (v) => { p.size_min = v; if (p.size_max < v) { p.size_max = v; sizeMax.set(v); } regen3d(); } });
      const sizeMax = slider({ label: 'Size max', min: 1, max: 20, step: 1, value: p.size_max, onInput: (v) => { p.size_max = v; if (p.size_min > v) { p.size_min = v; sizeMin.set(v); } regen3d(); } });
      nodes.push(sizeMin, sizeMax);
      if (X.SIZE_DISTRIBUTIONS[s.preset]) nodes.push(select('Size distribution', X.SIZE_DISTRIBUTIONS[s.preset], p.size_distribution, (v) => { p.size_distribution = v; regen3d(); }));
      if (s.preset === '3dModel') {
        nodes.unshift(
          row(btn('Choose OBJ file…', chooseModel), el('span', { className: 'muted', textContent: st.modelName || 'no model loaded' })),
          select('Place balls on', ['Vertices', 'Edges', 'Face Centers'], p.placement_mode, (v) => { p.placement_mode = v; regen3d(); }));
        nodes.push(select('Direction', ['min->max', 'max->min'], p.size_direction, (v) => { p.size_direction = v; regen3d(); }));
      }
      presetBox.replaceChildren(...nodes);
    }

    async function chooseModel() {
      const f = await pickFile('.obj');
      if (!f) return;
      try {
        st.model = X.parseObj(await f.text());
        st.modelName = `${f.name} (${st.model.vertices.length} vertices, ${st.model.faces.length} faces)`;
        regen3d();
        renderPresetParams();
      } catch (err) {
        showMessage('OBJ file', `Could not read ${f.name}:\n${err.message}`);
      }
    }

    function renderSlotInfo() {
      const sl = st.slots[st.slot];
      slotInfo.textContent = sl ? `${sl.preset}, ${sl.n} balls` : '(empty)';
      const filled = Object.keys(st.slots).map(Number).sort((a, b) => a - b);
      slotsList.textContent = filled.length ? `Filled: ${filled.map((k) => `${k} (${st.slots[k].preset})`).join(', ')}` : 'No slots filled yet.';
    }

    function saveSlot() {
      if (!st.form?.br0.length) { toast('Nothing to save.', 'warn'); return; }
      const moved = st.initial && st.form.ba.some((v, i) => Math.abs(v - st.initial.ba[i]) > 0.001 || Math.abs(st.form.bb[i] - st.initial.bb[i]) > 0.001);
      st.slots[st.slot] = X.formationSlot(st.form, st.settings);
      renderSlotInfo();
      save();
      toast(`Saved to slot ${st.slot} (${moved ? 'current animation frame' : 'initial positions'}).`);
    }

    function loadSlot() {
      const sl = st.slots[st.slot];
      if (!sl) { toast(`Slot ${st.slot} is empty.`, 'warn'); return; }
      st.settings = JSON.parse(JSON.stringify(sl.settings));
      st.form = { preset: sl.preset, br0: sl.br0.slice(), br: sl.br.slice(), ba: sl.ba.slice(), bb: sl.bb.slice(), bc: sl.bc.slice(), bda: sl.bda.slice(), bdb: sl.bdb.slice(), bdc: sl.bdc.slice(), error: '', info: `loaded from slot ${st.slot}` };
      st.initial = { ba: sl.ba.slice(), bb: sl.bb.slice(), bc: sl.bc.slice(), bdb: sl.bdb.slice() };
      st.overlapSet = null;
      render3dControls();
      update3dInfo();
      save();
    }

    async function clearSlot() {
      if (!st.slots[st.slot]) return;
      if (!(await confirmDialog('Clear slot', `Remove the ${st.slots[st.slot].preset} formation from slot ${st.slot}?`, 'Clear'))) return;
      delete st.slots[st.slot];
      renderSlotInfo();
      save();
    }

    const filledSlots = () => Object.keys(st.slots).map(Number).sort((a, b) => a - b).map((k) => [k, st.slots[k]]);

    function exportCart() {
      const slots = filledSlots();
      if (!slots.length) { toast('Save at least one formation to a slot first.', 'warn'); return; }
      const { bytes, entries } = X.packFormations(slots, st.exportOpts);
      let cart;
      try {
        cart = X.formationsCart(bytes);
      } catch (err) {
        showMessage('Export', err.message);
        return;
      }
      download(cart, 'formations.p8');
      showCode('Loading formations.p8', X.formationsLoader(entries, st.exportOpts, 'formations.p8', `0x${bytes.length.toString(16).padStart(4, '0')}`), 'formations_loader.lua',
        `${bytes.length} bytes in __gfx__ (${Math.round((bytes.length / X.GFX_LIMIT) * 100)}% of 8 KB). formations.p8 was downloaded; this code reads it.`);
    }

    const slotSel = numberField({ label: 'Slot', min: 1, max: 20, value: st.slot, onChange: (v) => { st.slot = v; renderSlotInfo(); save(); } });
    const slotsList = el('p', { className: 'muted' });
    const ctrl3 = el('div', { className: 'ex-controls-body' });

    function render3dControls() {
      const s = st.settings;
      const opts = st.exportOpts;
      const optBox = (key, label, title) => checkbox(label, opts[key], (v) => { opts[key] = v; save(); }, title);
      ctrl3.replaceChildren(
        group('Preset', select('Formation', X.FORMATION_PRESETS, s.preset, (v) => { s.preset = v; renderPresetParams(); regen3d(); })),
        group('Global',
          numberField({ label: 'Balls', min: 1, max: 4096, value: s.n_balls, onChange: (v) => { s.n_balls = v; regen3d(); } }),
          slider({ label: 'Radius min', min: 30, max: 100, step: 1, value: s.r_min, onInput: (v) => { s.r_min = v; if (s.r_max < v) s.r_max = v; regen3d(); } }),
          slider({ label: 'Radius max', min: 40, max: 120, step: 1, value: s.r_max, onInput: (v) => { s.r_max = Math.max(v, s.r_min); regen3d(); } })),
        group('Preset parameters', presetBox),
        group('Slots', row(slotSel, slotInfo), row(btn('Save to slot', saveSlot, { primary: true, title: 'Stores the formation as it is shown now (also mid-animation)' }), btn('Load', loadSlot), btn('Clear', clearSlot)), slotsList),
        group('Export',
          optBox('include_sizes', 'Sizes (br)', 'Data cart: 8 instead of 6 bytes per ball'),
          optBox('include_oscillation', 'Oscillation (bc)', 'Lua / POD only'),
          optBox('include_speeds', 'Speeds (bda, bdb, bdc)', 'Lua / POD only'),
          optBox('include_spherical', 'Spherical (ba, bb, br0)', 'Lua / POD only'),
          optBox('use_fixed_point', 'Fixed-point integers', 'Lua / POD: integers (x256, x1000, x10000) instead of floats'),
          row(btn('PICO-8 data cart', exportCart, { primary: true, title: 'formations.p8 with every filled slot in __gfx__' }),
            btn('Lua tables…', () => { const sl = filledSlots(); if (!sl.length) { toast('Save at least one formation to a slot first.', 'warn'); return; } showCode('Formations as Lua', X.formationsToLua(sl, opts), 'formations.lua'); }),
            btn('Picotron POD', () => { const sl = filledSlots(); if (!sl.length) { toast('Save at least one formation to a slot first.', 'warn'); return; } download(X.formationsToPod(sl, opts), 'formations.pod'); }))));
      renderPresetParams();
      renderSlotInfo();
    }

    // ---------------- shared ---------------- //

    const modeSeg = el('div', { className: 'seg', role: 'radiogroup', attrs: { 'aria-label': 'LUT type' } },
      el('button', { type: 'button', role: 'radio', dataset: { value: '2d' }, textContent: '2D motion path' }),
      el('button', { type: 'button', role: 'radio', dataset: { value: '3d' }, textContent: '3D ball formation' }));
    const aspectSeg = el('div', { className: 'seg seg-sm', role: 'radiogroup', attrs: { 'aria-label': 'Preview screen' } },
      el('button', { type: 'button', role: 'radio', dataset: { value: 'pico8' }, textContent: 'PICO-8 1:1' }),
      el('button', { type: 'button', role: 'radio', dataset: { value: 'picotron' }, textContent: 'Picotron 16:9' }));
    const ctrl2 = el('div', { className: 'ex-controls-body' });
    const play3 = btn('', () => { st.animate = !st.animate; renderTransport(); }, { title: 'Animate the balls along their orbits (Space)' });
    const cam3 = btn('', () => { st.rotate = !st.rotate; renderTransport(); }, { title: 'Rotate the camera' });
    const transport = row(play3, btn('−', () => step(-1), { title: 'One frame back' }), btn('+', () => step(1), { title: 'One frame forward' }), btn('↺', resetFrame, { title: 'Back to the generated positions' }),
      cam3,
      slider({ label: 'Ball speed', min: -5, max: 5, step: 0.1, value: st.ballSpeed, onInput: (v) => { st.ballSpeed = v; } }),
      slider({ label: 'Camera', min: -5, max: 5, step: 0.1, value: st.camSpeed, onInput: (v) => { st.camSpeed = v; } }),
      checkbox('Show overlaps', st.overlaps, (v) => { st.overlaps = v; st.overlapSet = null; draw3d(); }, 'Red: balls that overlap other balls'));

    function renderTransport() {
      play3.textContent = st.animate ? '⏸ Balls' : '▶ Balls';
      play3.setAttribute('aria-pressed', String(st.animate));
      cam3.textContent = st.rotate ? '⏸ Camera' : '▶ Camera';
      cam3.setAttribute('aria-pressed', String(st.rotate));
    }

    const stage = el('section', { className: 'card ex-stage' });
    const controls = el('section', { className: 'card ex-controls' });

    function renderMode() {
      for (const b of modeSeg.children) b.setAttribute('aria-checked', String(b.dataset.value === st.mode));
      for (const b of aspectSeg.children) b.setAttribute('aria-checked', String(b.dataset.value === st.aspect));
      const is2 = st.mode === '2d';
      stage.replaceChildren(...[row(modeSeg, el('span', { className: 'spacer' }), aspectSeg), is2 ? cv2 : cv3, is2 ? null : transport, is2 ? info2 : info3].filter(Boolean));
      controls.replaceChildren(is2 ? ctrl2 : ctrl3);
      draw();
    }

    modeSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (b) { st.mode = b.dataset.value; renderMode(); save(); } });
    aspectSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (b) { st.aspect = b.dataset.value; renderMode(); save(); } });

    const running = () => st.mode === '3d' && (st.animate || st.rotate);

    function draw() { if (st.mode === '2d') draw2d(); else draw3d(); }

    let acc = 0;
    function tick(dt) {
      acc += dt;
      if (acc < 1 / 30) return;   // the desktop tool runs at ~30 fps
      acc = 0;
      if (st.mode === '2d') {
        if (st.path.x.length) st.frame = (st.frame + 1) % st.path.x.length;
        draw2d();
        return;
      }
      if (st.animate && st.form) {
        // the desktop preview scales the per-frame step by the speed multiplier
        X.stepFormation(st.form, poleClearance(), st.ballSpeed);
        st.overlapSet = null;
      }
      if (st.rotate) st.camAngle = (st.camAngle + 0.02 * st.camSpeed) % (2 * Math.PI);
      draw3d();
    }

    function init(saved) {
      if (saved) {
        st.mode = saved.mode === '3d' ? '3d' : '2d';
        st.aspect = saved.aspect === 'picotron' ? 'picotron' : 'pico8';
        if (saved.motion) st.motion = { ...JSON.parse(JSON.stringify(X.MOTION_DEFAULTS)), ...saved.motion };
        if (saved.settings) {
          const d = X.newFormationSettings();
          st.settings = { ...d, ...saved.settings, params: { ...d.params } };
          for (const k of Object.keys(d.params)) st.settings.params[k] = { ...d.params[k], ...(saved.settings.params?.[k] || {}) };
        }
        if (saved.slots) st.slots = saved.slots;
        if (saved.slot) st.slot = saved.slot;
        if (saved.exportOpts) st.exportOpts = { ...X.EXPORT_DEFAULTS, ...saved.exportOpts };
      }
      if (st.settings.preset === '3dModel' && !st.model) st.settings.preset = 'random';
      ctrl2.replaceChildren(...controls2d());
      slotSel.set(st.slot);
      regen2d();
      regen3d();
      render3dControls();
      renderTransport();
      renderMode();
    }

    init(null);
    S.kv.get(KEYS.lut).then((d) => { if (d) init(d); });

    return {
      panel: el('div', { className: 'ex-split' }, stage, controls),
      draw, tick,
      key(e) {
        if (st.mode === '3d' && e.key === ' ' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); st.animate = !st.animate; renderTransport(); return true; }
        return false;
      },
    };
  })();

  // ================================================================== //
  // Workspace                                                          //
  // ================================================================== //

  const tools = { lut, wave, line };
  const dom = { tabs: $('#exTabs'), desc: $('#exDesc'), body: $('#exBody') };

  // Tools in their own files: window.P8ExtraTools = [{id, label, desc, create(helpers) -> {panel, draw, tick?, key}}]
  const helpers = { slider, numberField, checkbox, select, btn, group, row, showCode, fitCanvas };
  for (const ext of window.P8ExtraTools || []) {
    TOOLS[ext.id] = ext.desc;
    tools[ext.id] = ext.create({ ...helpers, isActive: () => active() && tab === ext.id, show: () => { App.setWorkspace('extras'); setTab(ext.id); } });
    const n = Object.keys(tools).length;
    dom.tabs.append(el('button', { textContent: ext.label, title: `Alt+${n}`, dataset: { value: ext.id }, attrs: { role: 'radio', 'aria-checked': 'false' } }));
  }
  if (!TOOLS[tab]) tab = 'lut';
  for (const [k, t] of Object.entries(tools)) { t.panel.dataset.ex = k; dom.body.append(t.panel); }

  function setTab(t) {
    tab = t;
    store.set(KEYS.tab, t);
    for (const b of dom.tabs.querySelectorAll('[data-value]')) b.setAttribute('aria-checked', String(b.dataset.value === t));
    for (const [k, tool] of Object.entries(tools)) tool.panel.hidden = k !== t;
    dom.desc.textContent = TOOLS[t];
    requestAnimationFrame(() => tools[t].draw());
  }

  dom.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (b) setTab(b.dataset.value);
  });

  let last = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (!active() || document.hidden) return;
    tools[tab].tick?.(dt);
  }
  requestAnimationFrame(loop);

  new ResizeObserver(() => { if (active()) tools[tab].draw(); }).observe(dom.body);
  document.addEventListener('p8:workspace', () => { if (active()) setTab(tab); });

  App.registerShortcuts('extras', (e, typing) => {
    if (typing || e.type === 'keyup') return;
    if (tools[tab].key(e)) return;
    const order = Object.keys(tools);
    if (e.altKey && /^[1-9]$/.test(e.key) && order[Number(e.key) - 1]) { e.preventDefault(); setTab(order[Number(e.key) - 1]); }
  });

  S.registerTool({ ws: 'extras', name: 'Extra Tools', desc: 'LUT Creator (motion paths, 3D ball formations), Wave Designer (scope waveforms → data cart), Line Tool (vector lines → Lua) and Terrain Lab (seamless terrain → 128×128 color + height maps).', color: '#ff77a8', tags: ['LUT', 'waves', 'lines', 'terrain'] });

  setTab(tab);
})();

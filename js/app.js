// js/app.js
// UI controller for the PICO-8 Palette Tool web version.
// Mirrors the behaviour of palette_ui.py / ui/*.py on top of the pure logic in core.js.

'use strict';

(() => {
  const {
    BASE_INDICES, HIDDEN_INDICES, DEFAULT_RAMP_PRESETS, STOPS_PER_ROW, FADE_STEPS,
    rgbOf, isValidPico, lum709, emptyPalette, emptyStops, cloneStops, fullPalette, fullPaletteRgb,
    usedColorIndices, slotIndexOfPico, resolveTargetSlot, buildSlotRamps, generateWithRamps, combineTwoSided,
    sliderToStep, autoFillStops, paletteToLua, paletteToGpl, fadeToLua, renderFade, quantize, renderImageFade,
    isValidPreviewSize, autoAssignMapping, convertGreyscaleManual, parsePngPalette, uniqueColors,
    matchColorsToPico8, encodeIndexedPng, buildDataCart, buildViewerCart, presetToDict, presetFromDict,
    rampPresetsToConfigJson, rampPresetsFromConfig,
  } = P8;

  const VERSION = '2.0.0';
  const KEYS = {
    ramps: 'p8pal.rampPresets',
    recent: 'p8pal.recentProjects',
    session: 'p8pal.session',
    theme: 'p8pal.theme',
    indices: 'p8pal.showIndices',
    workspace: 'p8pal.workspace',
    lastTool: 'p8pal.lastTool',   // last workspace other than Home (Home's "Continue", #68)
  };
  const MAX_RECENT = 5;
  const LONG_PRESS_MS = 500;

  // Swatch roles (same names as ColorSwatch roles in the Python version)
  const DROP_TARGETS = new Set(['palette_slot', 'ramp_slot', 'fade_target', 'greyscale_assignment']);
  const CLEARABLE = new Set(['palette_slot', 'ramp_slot', 'fade_target', 'greyscale_assignment']);
  const NOT_DRAGGABLE = new Set(['greyscale_display']);

  // ------------------------------------------------------------------ //
  // Small helpers                                                      //
  // ------------------------------------------------------------------ //

  const $ = (sel, root = document) => root.querySelector(sel);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    const { dataset, attrs, ...rest } = props;
    Object.assign(node, rest);
    if (dataset) Object.assign(node.dataset, dataset);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
    },
  };

  const sanitizeFilename = (name) => name.trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ') || 'untitled';

  function loadRampPresets() {
    const saved = store.get(KEYS.ramps, null);
    if (saved) {
      try { return rampPresetsFromConfig(saved); } catch { /* fall back to defaults */ }
    }
    return DEFAULT_RAMP_PRESETS.map((r) => r.slice());
  }

  // ------------------------------------------------------------------ //
  // State                                                              //
  // ------------------------------------------------------------------ //

  const state = {
    custom: emptyPalette(),       // normal custom palette (pico index per slot)
    ramp: emptyPalette(),         // ramp-mode palette
    mode: 'normal',               // 'normal' | 'ramp'
    rampIndex: 0,                 // 1-based loaded ramp preset, 0 = new
    rampPresets: loadRampPresets(),
    stops: emptyStops(),          // ramp editor contents (16 x 15 pico|null)
    savedNormalStops: null,
    target: null,                 // "Fade to" swatch (pico|null)
    direction: 'dark',
    dirStops: { dark: null, bright: null },
    dirTargets: { dark: null, bright: null }, // slot indices
    gamma: 1.0,
    covMin: 0,
    covMax: 16,
    fade: null,                   // {tables, coverage}
    imported: null,               // fade tables an image brought along: {dark, bright, from, sig: {dark, bright}}
    slider: 16,
    orientation: 'vertical',
    showIndices: true,
    selected: null,               // selected palette slot index
    img: null,                    // {src: ImageData, w, h, indices, scrollX, scrollY}
    grey: null,                   // {src, mapping, dither, inBlack, inWhite, outDark, outBright}
    useDither: true,
    presetName: '',
  };

  const activePalette = () => (state.mode === 'ramp' ? state.ramp : state.custom);

  // ------------------------------------------------------------------ //
  // DOM references                                                     //
  // ------------------------------------------------------------------ //

  const dom = {
    baseGrid: $('#baseGrid'),
    hiddenGrid: $('#hiddenGrid'),
    paletteSlots: $('#paletteSlots'),
    rampEditor: $('#rampEditor'),
    fadeTarget: $('#fadeTarget'),
    modeSeg: $('#modeSeg'),
    dirSeg: $('#dirSeg'),
    rampTools: $('#rampTools'),
    rampStatus: $('#rampStatus'),
    paletteHint: $('#paletteHint'),
    gradientCanvas: $('#gradientCanvas'),
    imageCanvas: $('#imageCanvas'),
    imageFrame: $('#imageFrame'),
    imageEmpty: $('#imageEmpty'),
    scrollHint: $('#scrollHint'),
    orientationBtn: $('#orientationBtn'),
    gammaInput: $('#gammaInput'),
    covMinInput: $('#covMinInput'),
    covMaxInput: $('#covMaxInput'),
    fadeSlider: $('#fadeSlider'),
    sliderReadout: $('#sliderReadout'),
    greyControls: $('#greyControls'),
    greyInBlack: $('#greyInBlack'),
    greyInWhite: $('#greyInWhite'),
    greyOutDark: $('#greyOutDark'),
    greyOutBright: $('#greyOutBright'),
    loadedPreset: $('#loadedPreset'),
    toggleIndices: $('#toggleIndices'),
    themeToggle: $('#themeToggle'),
    reassignItem: $('#reassignItem'),
    recentList: $('#recentList'),
    toasts: $('#toasts'),
    system: [],
    slots: [],
    rampBase: [],
    rampStops: [],
  };

  // ------------------------------------------------------------------ //
  // Building the static UI                                             //
  // ------------------------------------------------------------------ //

  function makeSwatch(role, data = {}, focusable = false) {
    const node = el('div', { className: 'sw empty', dataset: { role, ...data } });
    if (focusable) node.tabIndex = 0;
    return node;
  }

  function buildSystemPalette() {
    for (const [grid, indices] of [[dom.baseGrid, BASE_INDICES], [dom.hiddenGrid, HIDDEN_INDICES]]) {
      for (const pico of indices) {
        const sw = makeSwatch('system', { pico }, true);
        grid.append(sw);
        dom.system.push(sw);
      }
    }
  }

  function buildPaletteSlots() {
    for (let i = 0; i < 16; i++) {
      const sw = makeSwatch('palette_slot', { i }, true);
      dom.paletteSlots.append(sw);
      dom.slots.push(sw);
    }
  }

  function buildRampEditor() {
    for (let block = 0; block < 2; block++) {
      const blockEl = el('div', { className: 'ramp-block' });
      const head = el('div', { className: 'ramp-head', attrs: { 'aria-hidden': 'true' } },
        el('span'), el('span', { textContent: 'B' }), el('span'));
      for (let c = 1; c <= STOPS_PER_ROW; c++) head.append(el('span', { textContent: String(c) }));
      blockEl.append(head);

      for (let local = 0; local < 8; local++) {
        const r = block * 8 + local;
        const row = el('div', { className: 'ramp-row' });
        row.append(el('span', { className: 'row-label', textContent: String(r) }));
        const base = makeSwatch('ramp_base', { r });
        dom.rampBase[r] = base;
        row.append(base, el('span'));
        dom.rampStops[r] = [];
        for (let c = 0; c < STOPS_PER_ROW; c++) {
          const sw = makeSwatch('ramp_slot', { r, c });
          dom.rampStops[r][c] = sw;
          row.append(sw);
        }
        blockEl.append(row);
      }
      dom.rampEditor.append(blockEl);
    }
  }

  // ------------------------------------------------------------------ //
  // Rendering                                                          //
  // ------------------------------------------------------------------ //

  function paintSwatch(node, pico, showIndex, rgbOverride = null) {
    const rgb = rgbOverride || rgbOf(pico);
    if (!rgb) {
      node.classList.add('empty');
      node.classList.remove('light');
      node.style.backgroundColor = '';
      node.textContent = '';
      node.title = 'Empty';
      return;
    }
    node.classList.remove('empty');
    node.style.backgroundColor = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    node.classList.toggle('light', lum709(rgb) >= 128);
    const hasIndex = pico != null && pico >= 0;
    node.textContent = showIndex && hasIndex ? String(pico) : '';
    const hex = rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
    node.title = hasIndex ? `Color ${pico} · #${hex}` : `Grey ${rgb[0]} · #${hex}`;
  }

  function renderSwatches() {
    const pal = activePalette();
    dom.system.forEach((sw) => paintSwatch(sw, +sw.dataset.pico, state.showIndices));
    dom.slots.forEach((sw, i) => {
      paintSwatch(sw, pal[i], state.showIndices);
      sw.classList.toggle('selected', state.selected === i);
    });
    for (let r = 0; r < 16; r++) {
      paintSwatch(dom.rampBase[r], pal[r], false);
      for (let c = 0; c < STOPS_PER_ROW; c++) paintSwatch(dom.rampStops[r][c], state.stops[r][c], false);
    }
    paintSwatch(dom.fadeTarget, state.target, false);
    if (mapDlg) renderMapping();
  }

  function setSeg(seg, value) {
    for (const b of seg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === value));
  }

  function setInput(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  function renderControls() {
    setSeg(dom.modeSeg, state.mode);
    setSeg(dom.dirSeg, state.direction);

    const ramp = state.mode === 'ramp';
    dom.rampTools.hidden = !ramp;
    dom.rampStatus.hidden = !ramp;
    dom.rampStatus.textContent = state.rampIndex === 0
      ? 'Ramp: New'
      : `Ramp: #${state.rampIndex} of ${state.rampPresets.length}`;
    dom.paletteHint.textContent = ramp
      ? 'Ramp mode: build a gradient here and save it as a ramp preset for Auto Fill. Your normal palette is kept.'
      : 'Drag slots to reorder. Right-click (or long-press) to clear. Drag a slot onto the ramp grid to add a fade stop.';

    setInput(dom.gammaInput, state.gamma.toFixed(2));
    setInput(dom.covMinInput, state.covMin);
    setInput(dom.covMaxInput, state.covMax);

    dom.fadeSlider.value = state.slider;
    renderSliderReadout();
    dom.orientationBtn.textContent = state.orientation === 'vertical' ? '↔ Horizontal' : '↕ Vertical';

    dom.loadedPreset.hidden = !state.presetName;
    dom.loadedPreset.textContent = state.presetName ? `Loaded: ${state.presetName}` : '';
    dom.loadedPreset.title = dom.loadedPreset.textContent;

    dom.toggleIndices.textContent = state.showIndices ? 'Hide indices' : 'Show indices';
    dom.toggleIndices.setAttribute('aria-pressed', String(state.showIndices));

    dom.reassignItem.disabled = !state.grey;
    dom.greyControls.hidden = !state.grey;
    if (state.grey) {
      setInput(dom.greyInBlack, state.grey.inBlack);
      setInput(dom.greyInWhite, state.grey.inWhite);
      setInput(dom.greyOutDark, state.grey.outDark);
      setInput(dom.greyOutBright, state.grey.outBright);
    }
    renderImageChrome();
  }

  function renderSliderReadout() {
    const v = state.slider;
    const step = sliderToStep(v);
    dom.sliderReadout.textContent = v === 16 ? 'Normal' : `${v < 16 ? 'Dark' : 'Bright'} · step ${step}`;
  }

  function renderImageChrome() {
    const img = state.img;
    dom.imageEmpty.hidden = !!img;
    const scrollable = !!img && (img.w > 128 || img.h > 128);
    dom.imageFrame.classList.toggle('scrollable', scrollable);
    dom.scrollHint.hidden = !scrollable;
  }

  function renderAll() {
    renderControls();
    renderSwatches();
  }

  // ------------------------------------------------------------------ //
  // Fade generation + previews                                         //
  // ------------------------------------------------------------------ //

  // an imported fade (from the image's data cart) is used per direction while the palette
  // and that direction's ramps are unchanged; any edit generates the fades again
  const fadeSig = (stops) => JSON.stringify([state.custom, stops, state.gamma, state.covMin, state.covMax, state.mode]);

  function generateFade() {
    const imp = state.imported;
    if (imp && imp[state.direction]) {
      if (fadeSig(state.stops) === imp.sig[state.direction]) {
        const f = imp[state.direction];
        state.fade = { tables: f.tables.map((r) => r.slice()), coverage: f.coverage.slice() };
        drawGradient();
        drawImagePreview();
        emit('p8:fade');
        return;
      }
      imp[state.direction] = null;
      toast(`Edited: the ${state.direction} fade is generated again (no longer the table from ${imp.from}).`, 'info', 3200);
    }
    let target = resolveTargetSlot(state.custom, state.target, state.direction);
    if (target == null) target = 0;
    try {
      const ramps = buildSlotRamps(state.custom, state.stops, target);
      state.fade = generateWithRamps(ramps, {
        steps: FADE_STEPS, gamma: state.gamma, covMin: state.covMin, covMax: state.covMax,
      });
    } catch (e) {
      showMessage('Fade generator', e.message, 'error');
      return;
    }
    drawGradient();
    drawImagePreview();
    scheduleAutosave();
    emit('p8:fade');
  }

  /** Notifies other workspaces (Tile Maker) about palette / fade changes. */
  function emit(name, detail) {
    document.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
  }

  function drawGradient() {
    if (!state.fade) return;
    const img = renderFade(fullPaletteRgb(activePalette()), state.fade, state.orientation);
    const c = dom.gradientCanvas;
    if (c.width !== img.width || c.height !== img.height) { c.width = img.width; c.height = img.height; }
    c.getContext('2d').putImageData(img, 0, 0);
  }

  const offscreen = document.createElement('canvas');

  function drawImagePreview() {
    const c = dom.imageCanvas;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    const img = state.img;
    if (!img || !state.fade) return;

    const { image } = renderImageFade(img.indices, img.w, img.h, fullPaletteRgb(activePalette()), state.fade, sliderToStep(state.slider));
    offscreen.width = img.w;
    offscreen.height = img.h;
    offscreen.getContext('2d').putImageData(image, 0, 0);

    // 2x scale, 256x256 viewport, scrollable for 128x256 / 256x128 images
    const tw = img.w * 2;
    const th = img.h * 2;
    const vw = Math.min(256, tw);
    const vh = Math.min(256, th);
    img.scrollX = Math.round(clamp(img.scrollX, 0, tw - vw) / 2) * 2;
    img.scrollY = Math.round(clamp(img.scrollY, 0, th - vh) / 2) * 2;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(offscreen, img.scrollX / 2, img.scrollY / 2, vw / 2, vh / 2, (256 - vw) / 2, (256 - vh) / 2, vw, vh);
  }

  function setPreviewImage(imageData, { keepScroll = false, indices = null } = {}) {
    if (!isValidPreviewSize(imageData.width, imageData.height)) {
      throw new Error('Preview image must be 128x128, 128x256, or 256x128 pixels.');
    }
    const prev = state.img;
    state.img = {
      src: imageData,
      w: imageData.width,
      h: imageData.height,
      // given slot indices keep duplicate colors in their own slots (images that carry a palette)
      indices: indices && indices.length === imageData.width * imageData.height ? Uint8Array.from(indices, (v) => v & 15) : quantize(imageData, fullPaletteRgb(activePalette())),
      scrollX: keepScroll && prev ? prev.scrollX : 0,
      scrollY: keepScroll && prev ? prev.scrollY : 0,
    };
    renderImageChrome();
    drawImagePreview();
  }

  /** PalettePanel.palette_changed -> FadePanel.on_palette_changed */
  function onPaletteChanged() {
    clearInvalidStops();
    if (state.img) state.img.indices = quantize(state.img.src, fullPaletteRgb(activePalette()));
    renderSwatches();
    generateFade();
    emit('p8:palette');
  }

  function clearInvalidStops() {
    const valid = new Set(state.custom.filter((p) => p != null));
    for (const row of state.stops) {
      for (let c = 0; c < row.length; c++) if (row[c] != null && !valid.has(row[c])) row[c] = null;
    }
  }

  // ------------------------------------------------------------------ //
  // Swatch model access (shared by drag & drop, clicks, clearing)      //
  // ------------------------------------------------------------------ //

  let mapDlg = null; // open greyscale mapping dialog state

  function refOf(node) {
    const d = node.dataset;
    const num = (v) => (v == null ? null : Number(v));
    return { node, role: d.role, i: num(d.i), r: num(d.r), c: num(d.c), pico: num(d.pico) };
  }

  function getColor(ref) {
    switch (ref.role) {
      case 'system': return ref.pico;
      case 'palette_slot': return activePalette()[ref.i];
      case 'ramp_base': return activePalette()[ref.r];
      case 'ramp_slot': return state.stops[ref.r][ref.c];
      case 'fade_target': return state.target;
      case 'source_palette': return state.custom[ref.i];
      case 'greyscale_assignment': return mapDlg ? mapDlg.mapping[ref.i] : null;
      default: return null;
    }
  }

  /** Sets a swatch value and returns which part of the app needs updating. */
  function setColor(ref, pico) {
    switch (ref.role) {
      case 'palette_slot': activePalette()[ref.i] = pico; return 'palette';
      case 'ramp_slot': state.stops[ref.r][ref.c] = pico; return 'fade';
      case 'fade_target': state.target = pico; return 'fade';
      case 'greyscale_assignment': if (mapDlg) mapDlg.mapping[ref.i] = pico; return 'mapping';
      default: return null;
    }
  }

  function commit(kinds) {
    const k = new Set([].concat(kinds).filter(Boolean));
    if (k.has('palette')) onPaletteChanged();
    else if (k.has('fade')) { renderSwatches(); generateFade(); }
    if (k.has('mapping')) renderMapping();
  }

  function clearSwatch(ref) {
    if (!CLEARABLE.has(ref.role) || getColor(ref) == null) return false;
    commit(setColor(ref, null));
    return true;
  }

  /** ColorSwatch.dropEvent rules. Returns a function performing the drop, or null if not allowed. */
  function planDrop(src, tgt) {
    const sr = src.role;
    const tr = tgt.role;
    if (!DROP_TARGETS.has(tr) || NOT_DRAGGABLE.has(sr)) return null;
    if (tr === 'greyscale_assignment' && !mapDlg) return null;
    const entry = getColor(src);
    if (entry == null || src.node === tgt.node) return null;

    const copy = () => setColor(tgt, entry);
    const swap = () => {
      const old = getColor(tgt);
      return [setColor(tgt, entry), setColor(src, old)];
    };

    if (tr === 'fade_target') return copy;                                   // always copy
    if (sr === 'palette_slot' && tr === 'palette_slot') {                    // reorder (shift)
      return () => { reorderPalette(src.i, tgt.i); return 'palette'; };
    }
    if (sr === 'system' && tr === 'ramp_slot') return null;                  // blocked
    if (sr === 'ramp_slot' && tr === 'ramp_slot') return swap;               // swap
    if (sr === 'greyscale_assignment' && tr === 'greyscale_assignment') return swap;
    if (tr === 'greyscale_assignment') {
      return sr === 'source_palette' || sr === 'palette_slot' ? copy : null;
    }
    return copy;                                                             // everything else copies
  }

  /** PalettePanel.reorder_palette_slots + _reorder_fade_stops */
  function reorderPalette(from, to) {
    if (from === to) return;
    const pal = activePalette();
    const [color] = pal.splice(from, 1);
    pal.splice(to, 0, color);
    const [row] = state.stops.splice(from, 1);
    state.stops.splice(to, 0, row);
    if (state.selected === from) state.selected = to;
  }

  function onSwatchClick(ref) {
    if (ref.role === 'system') {
      const pal = activePalette();
      const i = state.selected != null ? state.selected : pal.indexOf(null);
      if (i < 0) {
        toast('All 16 slots are filled. Select a slot to replace its color.', 'warn');
        return;
      }
      pal[i] = ref.pico;
      commit('palette');
    } else if (ref.role === 'palette_slot') {
      state.selected = state.selected === ref.i ? null : ref.i;
      renderSwatches();
    } else if (ref.role === 'greyscale_assignment' && mapDlg) {
      mapDlg.selected = mapDlg.selected === ref.i ? null : ref.i;
      renderMapping();
    } else if (ref.role === 'source_palette' && mapDlg) {
      const color = getColor(ref);
      if (color == null) return;
      let i = mapDlg.selected != null ? mapDlg.selected : mapDlg.mapping.indexOf(null);
      if (i < 0) return;
      mapDlg.mapping[i] = color;
      if (mapDlg.selected != null) mapDlg.selected = i < 15 ? i + 1 : null;
      renderMapping();
    }
  }

  // ------------------------------------------------------------------ //
  // Pointer-based drag & drop (mouse, pen and touch)                   //
  // ------------------------------------------------------------------ //

  let drag = null;

  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    drag.ghost?.remove();
    drag.ref.node.classList.remove('drag-source');
    drag.over?.classList.remove('drop-ok');
    document.body.style.cursor = '';
    drag = null;
  }

  function dropTargetAt(x, y) {
    const node = document.elementFromPoint(x, y)?.closest('.sw');
    return node ? refOf(node) : null;
  }

  document.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.sw');
    if (!node || e.button !== 0) return;
    if (e.pointerType === 'mouse') e.preventDefault(); // no text selection while dragging
    endDrag();
    const ref = refOf(node);
    drag = { ref, id: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, ghost: null, over: null, suppressClick: false };
    if (e.pointerType !== 'mouse' && CLEARABLE.has(ref.role) && getColor(ref) != null) {
      drag.timer = setTimeout(() => {
        if (drag && !drag.started && clearSwatch(ref)) {
          drag.suppressClick = true;
          navigator.vibrate?.(15);
        }
      }, LONG_PRESS_MS);
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) <= 4) return;
      clearTimeout(drag.timer);
      const color = getColor(drag.ref);
      if (color == null || NOT_DRAGGABLE.has(drag.ref.role)) { drag = null; return; }
      drag.started = true;
      const small = drag.ref.role === 'ramp_base' || drag.ref.role === 'ramp_slot';
      drag.size = small ? 18 : 32;
      const rgb = rgbOf(color);
      drag.ghost = el('div', { className: 'drag-ghost' });
      Object.assign(drag.ghost.style, {
        width: `${drag.size}px`, height: `${drag.size}px`, background: `rgb(${rgb.join(',')})`,
      });
      (drag.ref.node.closest('dialog') || document.body).append(drag.ghost);
      drag.ref.node.classList.add('drag-source');
      document.body.style.cursor = 'grabbing';
    }
    e.preventDefault();
    drag.ghost.style.transform = `translate(${e.clientX - drag.size / 2}px, ${e.clientY - drag.size / 2}px)`;
    const tgt = dropTargetAt(e.clientX, e.clientY);
    const node = tgt && planDrop(drag.ref, tgt) ? tgt.node : null;
    if (node !== drag.over) {
      drag.over?.classList.remove('drop-ok');
      node?.classList.add('drop-ok');
      drag.over = node;
    }
  }, { passive: false });

  document.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    endDrag();
    if (d.started) {
      const tgt = dropTargetAt(e.clientX, e.clientY);
      const action = tgt && planDrop(d.ref, tgt);
      if (action) commit(action());
    } else if (!d.suppressClick) {
      onSwatchClick(d.ref);
    }
  });

  document.addEventListener('pointercancel', endDrag);

  document.addEventListener('contextmenu', (e) => {
    const node = e.target.closest('.sw');
    if (!node) return;
    e.preventDefault();
    if (clearSwatch(refOf(node)) && drag) drag.suppressClick = true;
  });

  // ------------------------------------------------------------------ //
  // Palette mode + ramp presets                                        //
  // ------------------------------------------------------------------ //

  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    state.selected = null;
    if (mode === 'ramp') {
      state.savedNormalStops = cloneStops(state.stops);
      state.stops = emptyStops();
    } else if (state.savedNormalStops) {
      state.stops = state.savedNormalStops;
      state.savedNormalStops = null;
    }
    renderControls();
    onPaletteChanged();
  }

  function persistRampPresets() {
    store.set(KEYS.ramps, state.rampPresets);
  }

  function saveRampPreset() {
    const colors = state.ramp.filter((p) => p != null);
    if (!colors.length) {
      showMessage('Empty Palette', 'Cannot save an empty palette as a ramp preset.\nPlease add some colors first.', 'warn');
      return;
    }
    const total = () => state.rampPresets.length;
    if (state.rampIndex > 0 && state.rampIndex <= total()) {
      state.rampPresets[state.rampIndex - 1] = colors;
      persistRampPresets();
      toast(`Ramp preset #${state.rampIndex} updated · ${colors.length} color(s) · ${total()} presets total`);
    } else {
      const key = JSON.stringify(colors);
      const existing = state.rampPresets.findIndex((r) => JSON.stringify(r) === key);
      if (existing >= 0) {
        state.rampIndex = existing + 1;
        showMessage('Ramp Already in Database', `This color ramp already exists in the database as preset #${existing + 1}`);
      } else {
        state.rampPresets.push(colors);
        persistRampPresets();
        state.rampIndex = total();
        toast(`Color ramp saved as preset #${total()} · ${colors.length} color(s)`);
      }
    }
    renderControls();
  }

  function stepRamp(delta) {
    const total = state.rampPresets.length;
    if (!total) {
      showMessage('No Ramps', 'No ramp presets saved yet.');
      return;
    }
    if (delta < 0) state.rampIndex = state.rampIndex <= 1 ? total : state.rampIndex - 1;
    else state.rampIndex = state.rampIndex >= total ? 1 : state.rampIndex + 1;
    const ramp = state.rampPresets[state.rampIndex - 1];
    state.ramp = emptyPalette();
    ramp.slice(0, 16).forEach((p, i) => { if (isValidPico(p)) state.ramp[i] = p; });
    renderControls();
    commit('palette');
  }

  function newRamp() {
    state.ramp = emptyPalette();
    state.rampIndex = 0;
    renderControls();
    commit('palette');
  }

  // ------------------------------------------------------------------ //
  // Direction handling                                                 //
  // ------------------------------------------------------------------ //

  /** FadePanel._on_direction_changed / slider-driven switch. */
  function switchDirection(newDir, { fromSlider = false } = {}) {
    if (newDir === state.direction) return;
    state.dirStops[state.direction] = cloneStops(state.stops);
    state.dirTargets[state.direction] = slotIndexOfPico(state.custom, state.target);
    state.direction = newDir;
    const stops = state.dirStops[newDir];
    state.stops = stops ? cloneStops(stops) : emptyStops();
    const t = state.dirTargets[newDir];
    state.target = t != null ? state.custom[t] : null;
    if (!fromSlider) state.slider = 16;
    renderAll();
    generateFade();
  }

  function autoFill() {
    const stops = autoFillStops(state.custom, state.direction, state.rampPresets);
    if (!stops) {
      toast('Add colors to the custom palette first.', 'warn');
      return;
    }
    state.stops = stops;
    renderSwatches();
    generateFade();
  }

  // ------------------------------------------------------------------ //
  // Presets / projects                                                 //
  // ------------------------------------------------------------------ //

  /** FadePresetHandler.capture_preset */
  function capturePreset() {
    const editorStops = state.mode === 'ramp' && state.savedNormalStops ? state.savedNormalStops : state.stops;
    state.dirStops[state.direction] = cloneStops(editorStops);
    if (state.target != null) state.dirTargets[state.direction] = slotIndexOfPico(state.custom, state.target);
    const dark = state.dirStops.dark ? cloneStops(state.dirStops.dark) : null;
    const bright = state.dirStops.bright ? cloneStops(state.dirStops.bright) : null;
    return {
      palette_name: state.presetName || 'Untitled Palette',
      palette_indices: state.custom.slice(),
      fade_target_index: state.dirTargets.dark,
      ramps: dark || [],
      steps: FADE_STEPS,
      gamma: state.gamma,
      cov_min: state.covMin,
      cov_max: state.covMax,
      dark_ramps: dark,
      dark_target_index: state.dirTargets.dark,
      bright_ramps: bright,
      bright_target_index: state.dirTargets.bright,
    };
  }

  /** FadePresetHandler.apply_preset */
  function applyPreset(p) {
    state.mode = 'normal';
    state.savedNormalStops = null;
    state.selected = null;
    state.custom = p.palette_indices.slice();
    state.dirStops = {
      dark: p.dark_ramps ? cloneStops(p.dark_ramps) : null,
      bright: p.bright_ramps ? cloneStops(p.bright_ramps) : null,
    };
    state.dirTargets = { dark: p.dark_target_index, bright: p.bright_target_index };
    const cur = state.dirStops[state.direction];
    state.stops = cur ? cloneStops(cur) : emptyStops();
    const t = state.dirTargets[state.direction];
    state.target = t != null ? state.custom[t] : null;
    state.gamma = Math.round(clamp(p.gamma, 0.2, 5) * 100) / 100;
    state.covMin = clamp(Math.round(p.cov_min), 0, 16);
    state.covMax = clamp(Math.round(p.cov_max), 0, 16);
    state.presetName = p.palette_name;
    renderControls();
    onPaletteChanged();
  }

  function getRecent() {
    const list = store.get(KEYS.recent, []);
    return Array.isArray(list) ? list.filter((r) => r && r.name && r.data) : [];
  }

  function addRecent(name, data) {
    const list = getRecent().filter((r) => r.name !== name);
    list.unshift({ name, data, time: Date.now() });
    store.set(KEYS.recent, list.slice(0, MAX_RECENT));
    renderRecent();
  }

  function renderRecent() {
    const list = getRecent();
    dom.recentList.replaceChildren();
    if (!list.length) {
      dom.recentList.append(el('div', { className: 'menu-empty', textContent: 'No recent projects' }));
      return;
    }
    list.forEach((r, i) => {
      const when = new Date(r.time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      dom.recentList.append(el('button', {
        attrs: { role: 'menuitem' }, dataset: { action: 'recent-open', index: i }, title: r.name,
      }, el('span', { textContent: r.name }), el('small', { textContent: when })));
    });
    dom.recentList.append(el('button', {
      attrs: { role: 'menuitem' }, dataset: { action: 'recent-clear' }, textContent: 'Clear Recent Projects',
    }));
  }

  let autosaveTimer = 0;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      store.set(KEYS.session, {
        preset: presetToDict(capturePreset()),
        presetName: state.presetName,
        direction: state.direction,
        mode: state.mode,
        ramp: state.ramp,
        rampIndex: state.rampIndex,
        orientation: state.orientation,
      });
    }, 400);
  }

  function restoreSession() {
    const s = store.get(KEYS.session, null);
    if (!s || !s.preset) return;
    try {
      state.direction = s.direction === 'bright' ? 'bright' : 'dark';
      state.orientation = s.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      if (Array.isArray(s.ramp)) state.ramp = Array.from({ length: 16 }, (_, i) => (isValidPico(s.ramp[i]) ? s.ramp[i] : null));
      state.rampIndex = Number.isInteger(s.rampIndex) && s.rampIndex <= state.rampPresets.length ? Math.max(0, s.rampIndex) : 0;
      applyPreset(presetFromDict(s.preset));
      state.presetName = typeof s.presetName === 'string' ? s.presetName : '';
      if (s.mode === 'ramp') setMode('ramp');
      renderControls();
    } catch {
      store.remove(KEYS.session);
    }
  }

  // ------------------------------------------------------------------ //
  // Dialogs, toasts, files                                             //
  // ------------------------------------------------------------------ //

  function toast(message, kind = 'info', ms = 3400) {
    const t = el('div', { className: `toast ${kind}`, textContent: message });
    if (kind === 'error' || kind === 'warn') t.setAttribute('role', 'alert');
    dom.toasts.append(t);
    setTimeout(() => t.remove(), ms);
  }

  /**
   * Generic modal. buttons: [{label, value, primary, danger, validate}] close the dialog;
   * actions: [{label, onClick, primary}] stay open (left side).
   * alert: announce as an alertdialog (warnings, errors, destructive confirmations; implied by a danger button).
   * The dialog is named by its title, a string body describes it, and focus returns to the opener on close.
   */
  let modalSeq = 0;
  function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], actions = [], wide = false, alert = false, onOpen }) {
    return new Promise((resolve) => {
      const id = `modal-${++modalSeq}`;
      const opener = document.activeElement;
      const dlg = el('dialog', { className: `modal${wide ? ' wide' : ''}`, attrs: { 'aria-labelledby': `${id}-title` } });
      if (alert || buttons.some((b) => b.danger)) dlg.setAttribute('role', 'alertdialog');
      const closeBtn = el('button', { type: 'button', className: 'btn btn-ghost icon-btn', textContent: '✕', attrs: { 'aria-label': 'Close' } });
      const head = el('header', { className: 'modal-head' }, el('h2', { id: `${id}-title`, textContent: title }), closeBtn);
      const bodyEl = el('div', { className: 'modal-body' });
      if (typeof body === 'string') {
        bodyEl.append(el('pre', { id: `${id}-desc`, className: 'msg', textContent: body }));
        dlg.setAttribute('aria-describedby', `${id}-desc`);
      } else if (body) bodyEl.append(body);
      const foot = el('footer', { className: 'modal-foot' });

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        dlg.close();
        dlg.remove();
        restoreFocus(opener);
        resolve(value);
      };
      dlg.finish = finish; // lets action handlers close the dialog with a result

      if (actions.length) {
        const left = el('div', { className: 'left' });
        for (const a of actions) {
          const b = el('button', { type: 'button', className: `btn${a.primary ? ' btn-primary' : ''}`, textContent: a.label });
          b.addEventListener('click', () => a.onClick(dlg));
          left.append(b);
        }
        foot.append(left);
      }
      for (const b of buttons) {
        const btn = el('button', {
          type: 'button',
          className: `btn${b.primary ? ' btn-primary' : ''}${b.danger ? ' btn-danger' : ''}`,
          textContent: b.label,
        });
        btn.addEventListener('click', async () => {
          if (b.validate && !(await b.validate())) return;
          finish(typeof b.value === 'function' ? b.value() : b.value);
        });
        foot.append(btn);
      }
      closeBtn.addEventListener('click', () => finish(null));
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
      dlg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
          e.preventDefault();
          foot.querySelector('.btn-primary')?.click();
        }
      });

      dlg.append(head, bodyEl, foot);
      document.body.append(dlg);
      dlg.showModal();
      onOpen?.(dlg);
    });
  }

  /** focus back to the control that opened a dialog/menu, if it is still usable */
  function restoreFocus(node) {
    if (!node || node === document.body || !node.isConnected || node.disabled || !node.getClientRects().length) return false;
    if (node.closest('dialog') && !node.closest('dialog').open) return false;
    node.focus({ preventScroll: true });
    return true;
  }

  const showMessage = (title, message, kind) => modal({ title, body: message, alert: kind === 'error' || kind === 'warn' });

  const confirmDialog = (title, message, yes = 'Yes', no = 'No') =>
    modal({ title, body: message, buttons: [{ label: no, value: false }, { label: yes, value: true, primary: true }] })
      .then((v) => v === true);

  async function copyText(text, textarea) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      textarea.select();
      document.execCommand('copy');
    }
    toast('Copied to clipboard');
  }

  function codeDialog(title, text, filename) {
    const ta = el('textarea', { className: 'code-out', readOnly: true, value: text, spellcheck: false });
    return modal({
      title,
      body: ta,
      wide: true,
      actions: [
        { label: 'Copy to clipboard', onClick: () => copyText(text, ta) },
        { label: `Download ${filename}`, primary: true, onClick: () => download(text, filename) },
      ],
      buttons: [{ label: 'Close', value: null }],
    });
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const input = el('input', { type: 'file', accept });
      input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
  }

  function download(data, filename, type = 'text/plain;charset=utf-8') {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function decodeImage(blob) {
    let source;
    try {
      source = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    } catch {
      source = await new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const im = new Image();
        im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
        im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image.')); };
        im.src = url;
      });
    }
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    source.close?.();
    return ctx.getImageData(0, 0, c.width, c.height);
  }

  function formField(labelText, input) {
    return el('label', { className: 'row' }, el('span', { textContent: labelText }), input);
  }

  // ------------------------------------------------------------------ //
  // File menu actions                                                  //
  // ------------------------------------------------------------------ //

  async function newProject() {
    const ok = await confirmDialog('New Project', 'Clear all colors and settings?\n\nThis will reset everything to default.');
    if (!ok) return;
    Object.assign(state, {
      custom: emptyPalette(),
      ramp: emptyPalette(),
      mode: 'normal',
      rampIndex: 0,
      stops: emptyStops(),
      savedNormalStops: null,
      target: null,
      direction: 'dark',
      dirStops: { dark: null, bright: null },
      dirTargets: { dark: null, bright: null },
      gamma: 1.0,
      covMin: 0,
      covMax: 16,
      slider: 16,
      selected: null,
      img: null,
      grey: null,
      presetName: '',
    });
    store.remove(KEYS.session);
    renderAll();
    generateFade();
  }

  async function openProject() {
    const file = await pickFile('.p8pal,.json,application/json');
    if (!file) return;
    let preset;
    try {
      preset = presetFromDict(JSON.parse(await file.text()));
    } catch (e) {
      showMessage('Error', `Invalid preset file:\n${e.message}`);
      return;
    }
    applyPreset(preset);
    addRecent(preset.palette_name, presetToDict(preset));
    toast(`Loaded “${preset.palette_name}”`);
  }

  function openRecent(index) {
    const r = getRecent()[index];
    if (!r) return;
    try {
      const preset = presetFromDict(r.data);
      applyPreset(preset);
      addRecent(r.name, r.data);
    } catch (e) {
      showMessage('Error', `Could not load preset:\n${e.message}`);
    }
  }

  async function clearRecent() {
    if (await confirmDialog('Clear Recent Projects', 'Clear all recent projects from the list?')) {
      store.set(KEYS.recent, []);
      renderRecent();
    }
  }

  async function saveProject() {
    const input = el('input', { type: 'text', value: state.presetName || 'preset', spellcheck: false });
    const name = await modal({
      title: 'Save Project',
      body: el('div', { className: 'dialog-form' },
        formField('Project name (used as palette name and file name)', input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save .p8pal', primary: true, value: () => input.value.trim() }],
      onOpen: () => input.select(),
    });
    if (!name) return;
    state.presetName = name;
    const dict = presetToDict({ ...capturePreset(), palette_name: name });
    download(JSON.stringify(dict, null, 2), `${sanitizeFilename(name)}.p8pal`, 'application/json');
    addRecent(name, dict);
    renderControls();
    scheduleAutosave();
    toast(`Palette preset '${name}' saved successfully!`);
  }

  async function importFromPng() {
    const file = await pickFile('image/png,.png');
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      let colors = parsePngPalette(buffer);
      const ordered = !!colors;
      let imageData = null;
      try { imageData = await decodeImage(file); } catch { /* handled below */ }
      if (!colors) {
        if (!imageData) { showMessage('Import', 'Failed to load image.'); return; }
        colors = uniqueColors(imageData);
      }

      const { found, unmatched } = matchColorsToPico8(colors, ordered);
      if (!found.length) {
        showMessage('Import', 'No valid PICO-8 colors found in the image.\n\nMake sure the image uses exact PICO-8 palette colors.');
        return;
      }

      if (state.mode !== 'normal') setMode('normal');
      state.custom = Array.from({ length: 16 }, (_, i) => (i < found.length ? found[i] : null));
      state.selected = null;
      onPaletteChanged();

      if (imageData && isValidPreviewSize(imageData.width, imageData.height)) {
        state.grey = null;
        setPreviewImage(imageData);
        renderControls();
      }

      let msg = `Imported ${found.length} PICO-8 colors.`;
      if (found.length > 16) msg += '\n(Only first 16 were used.)';
      if (unmatched.length) {
        msg += `\n\n${unmatched.length} color(s) were too different from PICO-8 colors and were skipped.`;
        msg += '\n\nUnmatched colors (showing first 3):';
        for (const u of unmatched.slice(0, 3)) {
          msg += `\n  RGB(${u.rgb.join(', ')}) → closest: P8#${u.closest} RGB(${rgbOf(u.closest).join(', ')}), distance=${u.distance.toFixed(1)}`;
        }
      }
      showMessage('Import Complete', msg);
    } catch (e) {
      showMessage('Error', `Failed to import palette:\n${e.message}`);
    }
  }

  async function loadPreviewFromFile(file) {
    let data;
    try {
      data = await decodeImage(file);
    } catch {
      showMessage('Error', 'Could not load image.');
      return;
    }
    try {
      setPreviewImage(data);
    } catch (e) {
      showMessage('Error', `Error loading preview image:\n${e.message}`);
      return;
    }
    state.grey = null;
    renderControls();
  }

  async function loadPreviewImage() {
    const file = await pickFile('image/png,.png');
    if (file) loadPreviewFromFile(file);
  }

  // ------------------------------------------------------------------ //
  // Greyscale conversion                                               //
  // ------------------------------------------------------------------ //

  function renderMapping() {
    if (!mapDlg) return;
    mapDlg.els.assign.forEach((sw, i) => {
      paintSwatch(sw, mapDlg.mapping[i], true);
      sw.classList.toggle('selected', mapDlg.selected === i);
    });
    mapDlg.els.source.forEach((sw, i) => paintSwatch(sw, state.custom[i], true));
  }

  /** GreyscaleMappingDialog -> 16 picos (or null if cancelled). */
  async function openMappingDialog(initial = null, title = 'Manual Greyscale to Palette Mapping') {
    const mapping = initial ? initial.slice() : autoAssignMapping(state.custom) || Array(16).fill(null);
    mapDlg = { mapping, selected: null, els: { assign: [], source: [] } };

    const greyRow = el('div', { className: 'map-row grey' });
    for (let i = 0; i < 16; i++) {
      const g = Math.trunc((i / 15.0) * 255);
      const sw = makeSwatch('greyscale_display', { i });
      paintSwatch(sw, -1, false, [g, g, g]);
      greyRow.append(sw);
    }
    const assignRow = el('div', { className: 'map-row' });
    const sourceRow = el('div', { className: 'map-row map-palette' });
    for (let i = 0; i < 16; i++) {
      const a = makeSwatch('greyscale_assignment', { i }, true);
      mapDlg.els.assign.push(a);
      assignRow.append(a);
      const s = makeSwatch('source_palette', { i }, true);
      mapDlg.els.source.push(s);
      sourceRow.append(s);
    }

    const body = el('div', {},
      el('p', { textContent: 'Drag colors from your custom palette to the assignment slots below the greyscale swatches. The image will be converted using this mapping. Right-click (or long-press) an assignment slot to clear it.' }),
      el('section', { className: 'map-section' }, el('h3', { textContent: 'Greyscale levels (black → white)' }), greyRow),
      el('section', { className: 'map-section' }, el('h3', { textContent: 'Assigned palette colors' }), assignRow),
      el('section', { className: 'map-section' }, el('h3', { textContent: 'Custom palette (drag from here, or select a slot above and tap a color)' }), sourceRow),
    );
    renderMapping();

    try {
      return await modal({
        title,
        body,
        wide: true,
        actions: [
          {
            label: 'Auto-Assign by Brightness',
            onClick: () => {
              const m = autoAssignMapping(state.custom);
              if (!m) {
                showMessage('No Palette Colors', 'The custom palette is empty. Please add colors to the palette first.');
                return;
              }
              mapDlg.mapping = m;
              renderMapping();
            },
          },
          { label: 'Clear All', onClick: () => { mapDlg.mapping = Array(16).fill(null); renderMapping(); } },
        ],
        buttons: [
          { label: 'Cancel', value: null },
          {
            label: 'OK',
            primary: true,
            value: () => mapDlg.mapping.slice(),
            validate: () => {
              const empty = mapDlg.mapping.filter((p) => p == null).length;
              if (!empty) return true;
              return confirmDialog('Incomplete Mapping',
                `${empty} greyscale level(s) have no assigned color.\n\nMissing assignments will use black (color 0).\n\nContinue anyway?`);
            },
          },
        ],
      });
    } finally {
      mapDlg = null;
    }
  }

  function applyGreyConversion({ keepScroll = true } = {}) {
    const g = state.grey;
    if (!g) return;
    const converted = convertGreyscaleManual(g.src, g.mapping, g.inBlack, g.inWhite, g.outDark, g.outBright, g.dither);
    setPreviewImage(converted, { keepScroll });
  }

  async function convertGreyscale() {
    if (!state.custom.some((p) => p != null)) {
      showMessage('Convert Greyscale', 'Please populate the custom palette first before converting a greyscale image.');
      return;
    }
    const file = await pickFile('image/png,image/jpeg,image/bmp,.png,.jpg,.jpeg,.bmp');
    if (!file) return;

    const check = el('input', { type: 'checkbox', checked: state.useDither });
    const ok = await modal({
      title: 'Greyscale Conversion Options',
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: 'Choose dithering option for the greyscale image:' }),
        el('label', { className: 'check', title: 'Dithering creates smoother gradients by blending colors. Disabling it gives a more posterized look.' },
          check, el('span', { textContent: 'Enable dithering (smooth gradients)' }))),
      buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: true }],
    });
    if (!ok) return;
    state.useDither = check.checked;

    const mapping = await openMappingDialog();
    if (!mapping) return;

    let src;
    try {
      src = await decodeImage(file);
    } catch {
      showMessage('Error', `Failed to load image:\n${file.name}`);
      return;
    }
    if (!isValidPreviewSize(src.width, src.height)) {
      showMessage('Invalid Dimensions', `Image must be 128x128, 128x256, or 256x128 pixels.\nCurrent size: ${src.width}x${src.height}`);
      return;
    }

    state.grey = { src, mapping, dither: state.useDither, inBlack: 0, inWhite: 255, outDark: 0, outBright: 15 };
    state.slider = 16;
    try {
      applyGreyConversion({ keepScroll: false });
    } catch (e) {
      state.grey = null;
      showMessage('Error', `Failed to convert greyscale image:\n${e.message}`);
      return;
    }
    renderControls();
    showMessage('Convert Greyscale',
      `Successfully converted greyscale image.\nSize: ${src.width}x${src.height}\n\n` +
      "Use 'Input Range' to adjust greyscale levels (0-255) mapped.\n" +
      "Use 'Output Range' to select which of your 16 manual assignments to use (0-15).\n" +
      "Use 'Tool → Reassign Greyscale Colors' to change color assignments.");
  }

  async function reassignGreyscale() {
    if (!state.grey) return;
    const mapping = await openMappingDialog(state.grey.mapping);
    if (!mapping || !state.grey) return;
    state.grey.mapping = mapping;
    applyGreyConversion();
  }

  /** FadePanel._on_greyscale_range_changed */
  function onGreyRange(sender) {
    const g = state.grey;
    if (!g) return;
    const read = (input, lo, hi, fallback) => {
      const v = parseInt(input.value, 10);
      return Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
    };
    let inB = read(dom.greyInBlack, 0, 255, g.inBlack);
    let inW = read(dom.greyInWhite, 0, 255, g.inWhite);
    let oD = read(dom.greyOutDark, 0, 15, g.outDark);
    let oB = read(dom.greyOutBright, 0, 15, g.outBright);

    if (inB >= inW) {
      if (sender === 'inBlack') {
        inB = Math.max(0, inW - 1);
        if (inB >= inW) inW = inB + 1;
      } else {
        inW = Math.min(255, inB + 1);
        if (inB >= inW) inB = inW - 1;
      }
    }
    if (oD > oB) {
      if (sender === 'outDark') oD = oB;
      else oB = oD;
    }
    Object.assign(g, { inBlack: inB, inWhite: inW, outDark: oD, outBright: oB });
    for (const [input, v] of [[dom.greyInBlack, inB], [dom.greyInWhite, inW], [dom.greyOutDark, oD], [dom.greyOutBright, oB]]) {
      input.value = v;
    }
    applyGreyConversion();
  }

  // ------------------------------------------------------------------ //
  // Export actions                                                     //
  // ------------------------------------------------------------------ //

  function exportPaletteLua() {
    const entries = state.custom.filter((p) => p != null);
    if (!entries.length) {
      showMessage('Export Lua', 'No colors in custom palette.');
      return;
    }
    codeDialog('Export Palette (Lua)', paletteToLua(entries), 'pico8_palette.lua');
  }

  async function exportPaletteGpl() {
    const entries = state.custom.filter((p) => p != null);
    if (!entries.length) {
      showMessage('Export .gpl', 'No colors in custom palette.');
      return;
    }
    const nameInput = el('input', { type: 'text', value: state.presetName || 'PICO8 Custom', spellcheck: false });
    const colsInput = el('input', { type: 'number', min: 1, max: 32, step: 1, value: 16 });
    const res = await modal({
      title: 'GPL Export Settings',
      body: el('div', { className: 'dialog-form' },
        formField('Palette name', nameInput),
        formField('Number of columns in palette layout (1–32)', colsInput)),
      buttons: [
        { label: 'Cancel', value: null },
        {
          label: 'Export',
          primary: true,
          value: () => ({
            name: nameInput.value.trim() || 'PICO8 Custom',
            columns: clamp(parseInt(colsInput.value, 10) || 16, 1, 32),
          }),
        },
      ],
      onOpen: () => nameInput.select(),
    });
    if (!res) return;
    codeDialog('Export Palette (.gpl)', paletteToGpl(entries, res.name, res.columns), `${sanitizeFilename(res.name)}.gpl`);
  }

  function exportFadePng() {
    if (!state.fade) {
      showMessage('Export fades', 'No fade tables generated yet.');
      return;
    }
    const base = renderFade(fullPaletteRgb(activePalette()), state.fade, state.orientation);
    const src = el('canvas', { width: base.width, height: base.height });
    src.getContext('2d').putImageData(base, 0, 0);
    const scale = 4;
    const out = el('canvas', { width: base.width * scale, height: base.height * scale });
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      if (!blob) { showMessage('Error', 'Failed to save PNG.'); return; }
      download(blob, 'pico8_fades.png');
      toast('Saved pico8_fades.png (512×512)');
    }, 'image/png');
  }

  /** FadeExportHandler.export_two_sided_fade */
  function exportTwoSided() {
    const editorStops = state.mode === 'ramp' && state.savedNormalStops ? state.savedNormalStops : state.stops;
    state.dirStops[state.direction] = cloneStops(editorStops);
    if (state.target != null) state.dirTargets[state.direction] = slotIndexOfPico(state.custom, state.target);

    for (const dir of ['dark', 'bright']) {
      const other = dir === 'dark' ? 'Dark' : 'Bright';
      if (!state.dirStops[dir]) {
        showMessage('Export two-sided', `Direction '${dir}' has no ramps defined.\n\nSwitch the direction to ${other} and set up its fade ramps first.`);
        return;
      }
      if (state.dirTargets[dir] == null) {
        showMessage('Export two-sided', `Direction '${dir}' has no 'Fade to' target set.\n\nSwitch the direction to ${other} and drop a palette color onto “Fade to”.`);
        return;
      }
    }

    const cfg = { steps: FADE_STEPS, gamma: state.gamma, covMin: state.covMin, covMax: state.covMax };
    const dark = generateWithRamps(buildSlotRamps(state.custom, state.dirStops.dark, state.dirTargets.dark), cfg);
    const bright = generateWithRamps(buildSlotRamps(state.custom, state.dirStops.bright, state.dirTargets.bright), cfg);
    const lua = fadeToLua(combineTwoSided(dark, bright), usedColorIndices(activePalette()));
    codeDialog('Export Two-Sided Fade (Lua)', lua, 'pico8_two_sided_fades.lua');
  }

  async function exportImagePng() {
    if (!state.img) {
      showMessage('Export Image', 'No preview image loaded. Please load an image first.');
      return;
    }
    const img = state.img;
    const pal = fullPaletteRgb(activePalette());
    const { slots } = renderImageFade(img.indices, img.w, img.h, pal, state.fade, sliderToStep(state.slider));
    // Same color -> first matching palette index (as the nearest-color pass in the desktop app)
    const canon = pal.map((rgb) => pal.findIndex((o) => o[0] === rgb[0] && o[1] === rgb[1] && o[2] === rgb[2]));
    const indexed = slots.map((s) => canon[s]);
    try {
      download(await encodeIndexedPng(img.w, img.h, indexed, pal), 'image.png');
      toast('Image exported as indexed PNG (image.png)');
    } catch (e) {
      showMessage('Export Failed', `Failed to save image:\n${e.message}`);
    }
  }

  async function exportImageP8() {
    if (!state.img) {
      showMessage('Export Image', 'No image loaded. Please load an image first.');
      return;
    }
    const nameInput = el('input', { type: 'text', value: 'image_data', spellcheck: false });
    const viewerCheck = el('input', { type: 'checkbox', checked: true });
    const res = await modal({
      title: 'Export Image Options',
      body: el('div', { className: 'dialog-form' },
        formField('Cart file name', nameInput),
        el('label', { className: 'check' }, viewerCheck, el('span', { textContent: 'Generate separate viewer cart' }))),
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Export .p8', primary: true, value: () => ({ name: nameInput.value, viewer: viewerCheck.checked }) },
      ],
      onOpen: () => nameInput.select(),
    });
    if (!res) return;

    const base = sanitizeFilename(res.name.replace(/\.p8$/i, '')) || 'image_data';
    const { indices, w, h } = state.img;
    download(buildDataCart(indices, w, h), `${base}.p8`);
    const files = [`${base}.p8`];
    if (res.viewer) {
      const viewer = buildViewerCart(w, h, base, fullPalette(activePalette()));
      setTimeout(() => download(viewer, `${base}_viewer.p8`), 400);
      files.push(`${base}_viewer.p8`);
    }
    toast(`Exported ${files.join(' + ')}`);
  }

  // ------------------------------------------------------------------ //
  // Tool menu: ramp preset storage                                     //
  // ------------------------------------------------------------------ //

  async function importRampPresets() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let list;
    try {
      list = rampPresetsFromConfig(JSON.parse(await file.text()));
    } catch (e) {
      showMessage('Import Ramp Presets', `Could not read ramp presets:\n${e.message}`);
      return;
    }
    const how = await modal({
      title: 'Import Ramp Presets',
      body: `Found ${list.length} ramp preset(s).\n\nMerge them into your ${state.rampPresets.length} existing presets (duplicates skipped), or replace all?`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Replace all', value: 'replace', danger: true },
        { label: 'Merge', value: 'merge', primary: true },
      ],
    });
    if (!how) return;
    if (how === 'replace') {
      state.rampPresets = list;
    } else {
      const keys = new Set(state.rampPresets.map((r) => JSON.stringify(r)));
      for (const r of list) {
        const k = JSON.stringify(r);
        if (!keys.has(k)) { keys.add(k); state.rampPresets.push(r); }
      }
    }
    state.rampIndex = 0;
    persistRampPresets();
    renderControls();
    toast(`Ramp presets: ${state.rampPresets.length} total`);
  }

  function exportRampPresets() {
    download(rampPresetsToConfigJson(state.rampPresets), 'config.json', 'application/json');
  }

  async function resetRampPresets() {
    const ok = await confirmDialog('Reset Ramp Presets',
      `Replace your ${state.rampPresets.length} ramp preset(s) with the ${DEFAULT_RAMP_PRESETS.length} defaults?`, 'Reset');
    if (!ok) return;
    state.rampPresets = DEFAULT_RAMP_PRESETS.map((r) => r.slice());
    state.rampIndex = 0;
    persistRampPresets();
    renderControls();
  }

  // ------------------------------------------------------------------ //
  // Help                                                               //
  // ------------------------------------------------------------------ //

  /** Long-form reference (#docsTemplate); `anchor` scrolls to a section, e.g. 'doc-code'. */
  function showDocs(anchor) {
    const content = $('#docsTemplate').content.cloneNode(true);
    const wrap = el('div', {}, content);
    wrap.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      e.preventDefault();
      wrap.querySelector(a.getAttribute('href'))?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
    modal({
      title: 'Full documentation', body: wrap, wide: true,
      actions: [{ label: 'Search Help', onClick: () => { document.querySelector('dialog.modal[open] button[aria-label="Close"]')?.click(); setTimeout(() => showHelp(), 0); } }],
      buttons: [{ label: 'Close', value: null, primary: true }],
    });
    if (typeof anchor === 'string') setTimeout(() => wrap.querySelector(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: 'start' }), 0);
  }

  // ------------------------------------------------------------------ //
  // Help (#59, js/help-core.js + js/help-data.js)                      //
  // ------------------------------------------------------------------ //

  /** F1: focused feature, selected subtool, then workspace; explicit topics take precedence. */
  function showHelp({ topic: startTopic, query = '' } = {}) {
    const ws = document.body.dataset.workspace;
    const initial = P8Help.context({ topicId: startTopic, ws,
      controlId: document.activeElement?.closest('[data-help-id]')?.dataset.helpId,
      sub: ws === 'extras' ? document.querySelector('#exTabs [aria-checked="true"]')?.dataset.value : null,
    });
    const first = initial.topic;
    let active = initial;
    const searchId = `help-search-${++modalSeq}`;
    const input = el('input', { type: 'search', id: searchId, placeholder: 'Search tools, controls, tasks, shortcuts', value: query, attrs: { 'aria-label': 'Search Help', autocomplete: 'off' } });
    const view = el('div', { className: 'help-view', attrs: { 'aria-live': 'polite' } });
    const list = (topics) => el('ul', { className: 'help-list' }, ...topics.map((t) =>
      el('li', {}, el('a', { href: `#help-${t.id}`, textContent: t.title, dataset: { topic: t.id } }), el('span', { className: 'muted', textContent: ` ${t.summary}` }))));
    const section = (title, items) => (items.length ? [el('h4', { textContent: title }), ...items] : []);
    const kb = (keys) => el('kbd', { textContent: keys });
    const contextLink = () => first ? el('p', {}, el('a', { href: '#help-context', textContent: `Return to ${first.title}` })) : '';
    const feature = (c, name) => el('li', { dataset: { helpControl: c.id }, attrs: { tabindex: '-1' } },
      el('b', { textContent: `${name}. ` }), document.createTextNode(c.text),
      c.detail ? el('p', { textContent: c.detail }) : '');
    const focusTopic = () => {
      const node = (active.controlId && view.querySelector(`[data-help-control="${CSS.escape(active.controlId)}"]`)) || view.querySelector('h3');
      node?.focus({ preventScroll: true });
      node?.scrollIntoView({ block: 'nearest' });
    };

    function showIndex() {
      const { tools, guides, reference } = P8Help.toc();
      view.replaceChildren(el('h3', { textContent: 'Help index', attrs: { tabindex: '-1' } }), contextLink(),
        el('h4', { textContent: 'Tools' }), list(tools), el('h4', { textContent: 'Guides' }), list(guides), el('h4', { textContent: 'Reference' }), list(reference));
    }

    function showResults(q) {
      const found = P8Help.search(q);
      if (!found.length) {
        view.replaceChildren(el('h3', { textContent: 'No results', attrs: { tabindex: '-1' } }), contextLink(),
          el('p', { textContent: `Nothing in Help matches “${q}”. Try a tool name (Pixel Studio), a task (count tokens) or a control (tile reduction), or browse the index.` }),
          el('p', {}, el('a', { href: '#help-index', textContent: 'Browse the Help index' }), document.createTextNode(' · '), el('a', { href: '#help-full', textContent: 'Open the full documentation' })));
        return;
      }
      view.replaceChildren(el('h3', { textContent: `${found.length} result${found.length === 1 ? '' : 's'}`, attrs: { tabindex: '-1' } }), contextLink(), list(found.map((r) => r.topic)));
    }

    function showTopic(t, controlId = null) {
      active = { topic: t, controlId };
      const kids = [
        el('p', { className: 'muted' }, el('a', { href: '#help-index', textContent: '← Help index' })),
        el('h3', { textContent: t.title, attrs: { tabindex: '-1' } }),
        el('p', { textContent: t.summary }),
      ];
      if (t.inputs.length) kids.push(el('p', {}, el('b', { textContent: 'Inputs: ' }), document.createTextNode(t.inputs.join(', '))));
      if (t.outputs.length) kids.push(el('p', {}, el('b', { textContent: 'Outputs: ' }), document.createTextNode(t.outputs.join(', '))));
      if (t.tasks.length) kids.push(el('p', {}, el('b', { textContent: 'Typical tasks: ' }), document.createTextNode(t.tasks.join('; '))));
      kids.push(...section('Key actions', [el('ul', {}, ...t.actions.map((a) => feature(a, a.name)))].filter(() => t.actions.length)));
      kids.push(...section('Controls', [el('ul', {}, ...t.controls.map((c) => feature(c, c.label)))].filter(() => t.controls.length)));
      kids.push(...section('Shortcuts', [el('table', { className: 'keys' }, ...t.shortcuts.map(([k, d]) => el('tr', {}, el('td', {}, kb(k)), el('td', { textContent: d }))))].filter(() => t.shortcuts.length)));
      kids.push(...section('Restrictions', [el('ul', {}, ...t.restrictions.map((r) => el('li', { textContent: r })))].filter(() => t.restrictions.length)));
      const rel = t.related.map((id) => P8Help.topic(id)).filter(Boolean);
      if (rel.length) {
        const p = el('p', {}, el('b', { textContent: 'Related: ' }));
        rel.forEach((r, i) => p.append(i ? document.createTextNode(', ') : '', el('a', { href: `#help-${r.id}`, textContent: r.title, dataset: { topic: r.id } })));
        kids.push(p);
      }
      if (t.legacy) kids.push(el('p', {}, el('a', { href: `#help-full:${t.legacy}`, textContent: 'Detailed reference for this topic (full documentation)' })));
      view.replaceChildren(...kids);
    }

    const render = () => { const q = input.value.trim(); if (q) showResults(q); else if (active.topic) showTopic(active.topic, active.controlId); else showIndex(); };
    function go(href) {
      if (href === '#help-index') { input.value = ''; showIndex(); } else if (href === '#help-context') { input.value = ''; if (first) showTopic(first, initial.controlId); } else if (href === '#help-full') { closeAnd(() => showDocs()); return; } else if (href.startsWith('#help-full:')) { closeAnd(() => showDocs(href.slice(11))); return; } else {
        const next = P8Help.context({ topicId: href.slice(6) });
        if (next.topic) { input.value = ''; showTopic(next.topic, next.controlId); }
      }
      if (href === '#help-index') view.querySelector('h3')?.focus(); else focusTopic();
    }
    const closeAnd = (fn) => { document.querySelector('dialog.modal[open] button[aria-label="Close"]')?.click(); setTimeout(fn, 0); };

    input.addEventListener('input', render);
    view.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#help-"]');
      if (!a) return;
      e.preventDefault();
      go(a.getAttribute('href'));
    });
    const body = el('div', { className: 'help' }, el('label', { className: 'help-search', htmlFor: searchId }, el('span', { textContent: 'Search' }), input), view);
    if (query.trim()) showResults(query.trim()); else if (first) showTopic(first, initial.controlId); else showIndex();
    modal({
      title: 'Help', body, wide: true,
      actions: [{ label: 'Full documentation', onClick: () => closeAnd(() => showDocs(active.topic?.legacy)) }],
      buttons: [{ label: 'Close', value: null, primary: true }],
      onOpen: () => { if (!query.trim() && initial.controlId) focusTopic(); else input.focus(); },
    });
  }

  // ------------------------------------------------------------------ //
  // Diagnostics (#62, js/diagnostics-core.js) and Report a problem (#63) //
  // ------------------------------------------------------------------ //

  // the Suite's own scripts (local <script src>, read at export time so later tags count) and the page itself:
  // only their stack lines are exported by default (#85)
  const ownScripts = () => [...document.scripts].map((s) => s.getAttribute('src')).filter((src) => src && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src))
    .map((src) => src.split(/[?#]/)[0].split('/').pop()).concat('index.html');
  const diagnostics = P8Diag.create({ browser: P8Diag.browserFamily(navigator.userAgent), version: VERSION, appFiles: ownScripts });
  diagnostics.install(window);
  const REPO_NEW_ISSUE = 'https://github.com/Crylhead/Pico8_Suite/issues/new?template=bug_report.yml';

  /** Plain-text summary: the user's description plus sanitized diagnostics. Never contains project content. */
  function buildReportSummary(fields, bundle) {
    const f = (k) => (fields[k] || '').trim() || '(not provided)';
    const lines = [
      '## Problem', f('what'), '', '## Steps to reproduce', f('steps'), '',
      '## Expected / actual', `Expected: ${f('expected')}`, `Actual: ${f('actual')}`, '',
      '## Environment', `Suite version: ${bundle.app.version}`, `Browser: ${bundle.app.browser}`,
      `Workspace: ${fields.tool || 'unknown'}`, '', `## Diagnostics (${bundle.records.length} record${bundle.records.length === 1 ? '' : 's'})`,
    ];
    for (const r of bundle.records.slice(-10)) {
      lines.push(`- ${r.id} ${r.time} [${r.source}] ${r.code}${r.count > 1 ? ` x${r.count}` : ''}: ${r.message}`);
    }
    return lines.join('\n');
  }

  async function showReportProblem() {
    const area = (label, ph, rows = 2) => {
      const ta = el('textarea', { rows, placeholder: ph, maxLength: 1000, className: 'report-field' });
      return { ta, node: el('label', { className: 'report-row' }, el('span', { textContent: label }), ta) };
    };
    const what = area('What went wrong?', 'A short description');
    const steps = area('Steps to reproduce', '1. ... 2. ...', 3);
    const expected = area('Expected', 'What you expected');
    const actual = area('Actual', 'What happened instead');
    const preview = el('textarea', { rows: 10, className: 'report-preview', attrs: { 'aria-label': 'Report summary preview (editable)' } });
    // #62: by default error messages are reduced to generic words; full scrubbed text is opt-in
    const fullMessages = el('input', { type: 'checkbox' });
    const exportOpts = () => ({ messages: fullMessages.checked ? 'sanitized' : 'redacted' });
    const jsonPreview = el('textarea', { rows: 8, className: 'report-preview', value: diagnostics.exportJSON(exportOpts()), attrs: { 'aria-label': 'Diagnostics JSON preview (editable)' } });
    const note = el('p', { className: 'hint', textContent: 'Nothing is sent automatically. Copy summary copies exactly the summary preview; Download diagnostics downloads exactly the JSON preview. Review and edit each separately. The issue-form link contains no report data; add attachments yourself. Descriptions may contain anything you type. By default, error messages keep only generic error words (other words appear as […]), error types are standard names or OtherError, and stacks list only the Suite’s own script lines. JavaScript hooks cannot recover a crashed tab or process.' });
    const status = el('p', { className: 'hint', attrs: { role: 'status', 'aria-live': 'polite' } });
    const refresh = () => {
      preview.value = buildReportSummary({
        what: what.ta.value, steps: steps.ta.value, expected: expected.ta.value, actual: actual.ta.value, tool: document.body.dataset.workspace,
      }, diagnostics.exportBundle(exportOpts()));
    };
    for (const a of [what, steps, expected, actual]) a.ta.addEventListener('input', refresh);
    fullMessages.addEventListener('change', () => {
      jsonPreview.value = diagnostics.exportJSON(exportOpts());
      refresh();
      status.textContent = fullMessages.checked
        ? 'Full error details included (messages, error names, stack function names). They may contain names, values or code from your work: review both previews. Earlier edits to the previews were replaced.'
        : 'Error details reduced to the safe default again. Earlier edits to the previews were replaced.';
    });
    refresh();
    const body = el('div', { className: 'report-form' }, note, what.node, steps.node, expected.node, actual.node,
      el('label', { className: 'check' }, fullMessages, el('span', { textContent: 'Include full error details: messages, error names and stack function names (scrubbed, but may contain private details; regenerates both previews)' })),
      el('label', { className: 'report-row' }, el('span', { textContent: 'Summary preview' }), preview),
      el('label', { className: 'report-row' }, el('span', { textContent: 'Diagnostics JSON preview (edit or remove records before downloading)' }), jsonPreview), status);
    const say = (m) => { status.textContent = m; };
    await modal({
      title: 'Report a problem', body, wide: true,
      actions: [
        {
          label: 'Copy summary',
          onClick: async () => {
            try { await navigator.clipboard.writeText(preview.value); say('Summary copied to the clipboard.'); } catch { preview.select(); say('Copying is blocked here: the text is selected, press Ctrl+C.'); }
          },
        },
        {
          label: 'Download diagnostics',
          onClick: () => {
            try { JSON.parse(jsonPreview.value); } catch { say('The diagnostics preview must be valid JSON. Fix it before downloading.'); jsonPreview.focus(); return; }
            download(jsonPreview.value, `pico8-suite-diagnostics-${Date.now()}.json`, 'application/json');
            say('The reviewed diagnostics JSON was downloaded. Attach it only if you wish.');
          },
        },
        {
          label: 'Open GitHub issue form',
          onClick: () => {
            const w = window.open(REPO_NEW_ISSUE, '_blank', 'noopener');
            say(w || navigator.onLine
              ? 'GitHub was opened in a new tab (if your browser allowed it). Paste the summary there and attach the diagnostics file yourself if you wish; nothing was transmitted.'
              : 'You appear to be offline. Copy the summary and report later.');
          },
        },
        { label: 'Clear diagnostics', onClick: () => { diagnostics.clear(); jsonPreview.value = diagnostics.exportJSON(exportOpts()); refresh(); say('Diagnostics cleared.'); } },
      ],
      buttons: [{ label: 'Close', value: null, primary: true }],
    });
  }

  // ------------------------------------------------------------------ //
  // Active project context (#55, js/project-context-core.js)           //
  // ------------------------------------------------------------------ //

  // Suite.kv is created after this file loads, so it is looked up on use
  const projectCtx = P8ProjectContext.create({
    kv: { get: (k) => window.Suite.kv.get(k), set: (k, v) => window.Suite.kv.set(k, v) },
  });
  const ACCESS_LABEL = { granted: '', prompt: 'reconnect needed', denied: 'access denied', stale: 'folder unavailable', unsupported: 'name only' };

  /** Shell indicator: names the project and its access state; it never claims anything was saved. */
  function renderProjectIndicator(p = projectCtx.context.get()) {
    const node = $('#projectIndicator');
    if (!node) return;
    node.hidden = p.access === 'none';
    if (node.hidden) { node.textContent = ''; node.removeAttribute('title'); return; }
    const note = ACCESS_LABEL[p.access];
    node.textContent = `Project: ${p.name}${note ? ` (${note})` : ''}`;
    node.title = `${node.textContent} — ${p.message}`;
    node.dataset.access = p.access;
  }

  function bindProjectContext() {
    projectCtx.context.subscribe((d) => {
      renderProjectIndicator(d.project);
      // not 'p8:project': Project Audit already uses that name ({ root }) to hand its scan to Data Carts
      document.dispatchEvent(new CustomEvent('p8:projectcontext', { detail: d }));
    });
    // a remembered reference comes back as "reconnect needed" until permission is verified. Suite.kv exists only
    // after suite.js has loaded (it loads after this file), so restoring waits for the page to finish loading.
    const restore = () => Promise.resolve(window.Suite?.assets?.ready).catch(() => {}).then(() => projectCtx.publisher.restore()).catch(() => {});
    if (document.readyState === 'complete') restore(); else window.addEventListener('load', restore, { once: true });
    // permission can change while the page is in the background
    window.addEventListener('focus', () => { projectCtx.context.check().catch(() => {}); });
  }

  // ------------------------------------------------------------------ //
  // UX preferences (#54, js/ux-prefs-core.js)                          //
  // ------------------------------------------------------------------ //

  const prefs = P8Prefs.create({ storage: (() => { try { return window.localStorage; } catch { return null; } })() });
  const osReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  /** true when the preference or the OS asks for reduced motion */
  const reducedMotion = () => P8Prefs.reducedMotion(prefs.get(), osReducedMotion?.matches);

  // <html data-help-level="off|concise|detailed" data-motion="system|reduce" data-compact-nav>
  function applyPrefs(p = prefs.get()) {
    const root = document.documentElement;
    root.dataset.helpLevel = p.helpLevel;
    root.dataset.motion = p.motion;
    root.toggleAttribute('data-compact-nav', p.compactNav);
  }

  function bindPrefs() {
    applyPrefs();
    prefs.subscribe((detail) => {
      applyPrefs(detail.prefs);
      document.dispatchEvent(new CustomEvent('p8:preferences', { detail }));
    });
    window.addEventListener('storage', (e) => { if (e.key === P8Prefs.KEY || e.key === null) prefs.reload(); });
  }

  function prefsStorageNote() {
    const s = prefs.status();
    if (!s.persistent) return '⚠ This browser is not storing settings (storage is blocked or full). Changes apply until you reload the page.';
    if (s.ignored.length) return 'Some stored settings were invalid and use their defaults.';
    return '';
  }

  function showSettings() {
    let n = 0;
    const section = (title, control, desc, described = control) => {
      const id = `settings-${++n}`;
      described.setAttribute('aria-describedby', `${id}-desc`);
      return el('section', { className: 'settings-row' },
        el('h3', { textContent: title }), control, el('p', { className: 'hint', id: `${id}-desc`, textContent: desc }));
    };
    const seg = (label, options) => el('div', { className: 'seg', attrs: { role: 'radiogroup', 'aria-label': label } },
      ...options.map(([value, text]) => el('button', { type: 'button', textContent: text, dataset: { value }, attrs: { role: 'radio', 'aria-checked': 'false' } })));
    const check = (input, text) => el('label', { className: 'check' }, input, el('span', { textContent: text }));

    const theme = seg('Theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]);
    const help = seg('Help detail', [['off', 'Off'], ['concise', 'Concise'], ['detailed', 'Detailed']]);
    const motion = seg('Animation', [['system', 'Follow system'], ['reduce', 'Reduce']]);
    const tours = el('input', { type: 'checkbox' });
    const compact = el('input', { type: 'checkbox' });
    const note = el('p', { className: 'hint settings-note', attrs: { role: 'status' } });
    const motionDesc = 'Turns off interface transitions and pulsing indicators.';

    const body = el('div', { className: 'dialog-form settings' },
      section('Theme', theme, 'Same as the theme button in the toolbar.'),
      section('Help detail', help, 'Optional hints and tooltips. Labels, warnings, errors and confirmations are always shown.'),
      section('Guided tours', check(tours, 'Offer tours automatically'), 'When off, tours never offer themselves automatically. Replay them any time from Help → Quick tours.', tours),
      section('Workspace bar', check(compact, 'Compact: icons only'), 'Hides the workspace names in the bar (the active name and, on wide screens, every tab\'s name). Each tab keeps its tooltip and accessible name, and Find tool (Ctrl+K) lists every tool by name.', compact),
      section('Animation', motion, motionDesc),
      note);

    const mark = (g, v) => { for (const b of g.querySelectorAll('[role=radio]')) b.setAttribute('aria-checked', String(b.dataset.value === v)); };
    const sync = () => {
      const p = prefs.get();
      mark(theme, store.get(KEYS.theme, 'system'));
      mark(help, p.helpLevel);
      mark(motion, p.motion);
      tours.checked = p.autoOfferTours;
      compact.checked = p.compactNav;
      motion.nextElementSibling.textContent = osReducedMotion?.matches ? `${motionDesc} Your system already asks for reduced motion, which is always respected.` : motionDesc;
      note.textContent = prefsStorageNote();
      note.classList.toggle('warn', !prefs.status().persistent);
    };
    const pick = (g, fn) => g.addEventListener('click', (e) => {
      const b = e.target.closest('[role=radio]');
      if (b) { fn(b.dataset.value); sync(); }
    });
    pick(theme, (v) => { store.set(KEYS.theme, v); applyTheme(v); });
    pick(help, (v) => prefs.set({ helpLevel: v }));
    pick(motion, (v) => prefs.set({ motion: v }));
    tours.addEventListener('change', () => { prefs.set({ autoOfferTours: tours.checked }); sync(); });
    compact.addEventListener('change', () => { prefs.set({ compactNav: compact.checked }); sync(); });
    sync();

    return modal({
      title: 'Settings',
      body,
      actions: [{ label: 'Reset to defaults', onClick: () => {
        prefs.reset();
        window.P8PanelLayout?.resetAll(); // side panel widths and hidden panels (#64)
        store.remove(KEYS.theme);
        applyTheme('system');
        sync();
        if (!note.textContent) note.textContent = 'Settings reset to defaults.';
      } }],
      buttons: [{ label: 'Done', value: true, primary: true }],
    });
  }

  function showAbout() {
    const tools = window.Suite?.tools?.() || [];
    const body = el('div', {},
      el('p', {}, el('b', { textContent: 'Web app version: ' }), VERSION),
      el('p', {}, el('b', { textContent: 'Author: ' }), 'Acryl'),
      el('p', { textContent: 'A browser-based PICO-8 development toolchain for pixel art, palettes, tiles, maps, Lua code, terrain, cartridge building and project inspection. The shared Library connects images, palettes and maps between tools.' }),
      el('p', { textContent: 'Run in PICO-8 additionally needs the optional local Python bridge and an installed PICO-8. A remotely hosted copy does not connect to the bridge automatically. Folder access depends on browser support.' }),
      el('p', { textContent: 'Tools in this copy:' }),
      el('ul', { className: 'about-list' }, ...tools.map((tool) => el('li', { textContent: tool.name }))));
    modal({ title: 'About PICO-8 Suite', body });
  }

  // ------------------------------------------------------------------ //
  // Menus + shortcuts                                                  //
  // ------------------------------------------------------------------ //

  const actions = {
    'new': newProject,
    'open': openProject,
    'save': saveProject,
    'recent-open': (d) => openRecent(Number(d.index)),
    'recent-clear': clearRecent,
    'import-png': importFromPng,
    'convert-greyscale': convertGreyscale,
    'export-palette-lua': exportPaletteLua,
    'export-palette-gpl': exportPaletteGpl,
    'export-fade-png': exportFadePng,
    'export-two-sided': exportTwoSided,
    'export-image-png': exportImagePng,
    'export-image-p8': exportImageP8,
    'reassign-greyscale': reassignGreyscale,
    'import-ramps': importRampPresets,
    'export-ramps': exportRampPresets,
    'reset-ramps': resetRampPresets,
    'docs': () => showHelp(),
    'docs-full': () => showDocs(),
    'settings': showSettings,
    'report-problem': showReportProblem,
    'about': showAbout,
  };

  function closeMenus() {
    for (const m of document.querySelectorAll('.menu.open')) {
      m.classList.remove('open');
      m.querySelector('.menu-btn').setAttribute('aria-expanded', 'false');
    }
  }

  const menuItems = (menu) => [...menu.querySelectorAll('.menu-pop button:not(:disabled)')].filter((b) => !b.hidden);

  // Keep the existing anchored popover inside the visible page, including the scrollbar rail.
  function fitMenu(menu) {
    const pop = menu.querySelector('.menu-pop');
    pop.style.left = '0px';
    const r = pop.getBoundingClientRect();
    const edge = Math.min(document.documentElement.clientWidth, document.body.clientWidth) - 8;
    pop.style.left = `${Math.max(8 - r.left, Math.min(0, edge - r.right))}px`;
    pop.style.maxHeight = `${Math.max(0, window.innerHeight - r.top - 8)}px`;
  }

  /** focus: 'first' | 'last' | null (pointer opening leaves focus on the button) */
  function openMenu(menu, focus = null) {
    closeMenus();
    menu.classList.add('open');
    menu.querySelector('.menu-btn').setAttribute('aria-expanded', 'true');
    fitMenu(menu);
    const items = menuItems(menu);
    if (focus) items[focus === 'last' ? items.length - 1 : 0]?.focus();
  }

  // Menu buttons follow the WAI-ARIA APG menu button pattern: Enter/Space/Down open on the first
  // item, Up on the last; inside, Up/Down/Home/End move, Left/Right switch to the neighbouring
  // menu, Escape closes and returns to the button, Tab closes and moves on.
  function bindMenus() {
    window.addEventListener('resize', () => {
      const open = document.querySelector('.menu.open');
      if (open) fitMenu(open);
    });
    const visibleMenus = () => [...document.querySelectorAll('#menubar .menu')].filter((m) => m.getClientRects().length);
    for (const menu of document.querySelectorAll('.menu')) {
      const btn = menu.querySelector('.menu-btn');
      btn.addEventListener('click', (e) => {
        if (menu.classList.contains('open')) closeMenus();
        else openMenu(menu, e.detail === 0 ? 'first' : null); // detail 0: keyboard activation
      });
      btn.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse' && document.querySelector('.menu.open') && !menu.classList.contains('open')) openMenu(menu);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          openMenu(menu, e.key === 'ArrowUp' ? 'last' : 'first');
        } else if (e.key === 'Escape' && menu.classList.contains('open')) {
          e.stopPropagation();
          closeMenus();
        }
      });
      menu.querySelector('.menu-pop').addEventListener('keydown', (e) => {
        const items = menuItems(menu);
        const i = items.indexOf(document.activeElement);
        const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
        if (move !== undefined) {
          items[(move + items.length) % items.length]?.focus();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const list = visibleMenus();
          const next = list[(list.indexOf(menu) + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
          if (next) openMenu(next, 'first');
        } else if (e.key === 'Escape') {
          closeMenus();
          btn.focus();
        } else if (e.key === 'Tab') {
          closeMenus();
          btn.focus(); // the default Tab action then continues from the button
          e.stopPropagation();
          return;
        } else return;
        e.preventDefault();
        e.stopPropagation(); // keep workspace shortcuts (e.g. arrow nudging) out of menu navigation
      });
    }
    document.addEventListener('click', (e) => {
      const item = e.target.closest('[data-action]');
      if (item && !item.closest('dialog')) {
        const menu = item.closest('.menu');
        // return focus to the menu button first, so dialogs opened by the action restore it
        if (menu && menu.contains(document.activeElement)) menu.querySelector('.menu-btn').focus({ preventScroll: true });
        closeMenus();
        if (!item.disabled) actions[item.dataset.action]?.(item.dataset);
        return;
      }
      if (!e.target.closest('.menu')) closeMenus();
    });
  }

  // Radio groups ([role=radiogroup] segmented controls, workspace tabs, ...) use a roving
  // tabindex: only the checked (else first enabled) radio is a Tab stop, and Arrow keys/Home/End
  // move focus and select by clicking, so each owner's click handler stays the single code path.
  const groupRadios = (g) => [...g.querySelectorAll('[role=radio]')].filter((r) => r.closest('[role=radiogroup]') === g);
  function syncRadioGroup(g) {
    const radios = groupRadios(g);
    const usable = radios.filter((r) => !r.disabled && !r.hidden);
    const stop = usable.find((r) => r.getAttribute('aria-checked') === 'true') || usable[0];
    for (const r of radios) {
      const want = r === stop ? 0 : -1;
      if (r.tabIndex !== want) r.tabIndex = want;
    }
  }
  function bindRadioGroups() {
    for (const g of document.querySelectorAll('[role=radiogroup]')) syncRadioGroup(g);
    new MutationObserver((records) => {
      const groups = new Set();
      for (const m of records) {
        const own = m.target.closest?.('[role=radiogroup]');
        if (own) groups.add(own);
        if (m.type !== 'childList') continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1 || !n.querySelector('[role=radio]')) continue;
          for (const g of n.querySelectorAll('[role=radiogroup]')) groups.add(g);
          if (n.matches('[role=radiogroup]')) groups.add(n);
        }
      }
      for (const g of groups) syncRadioGroup(g);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked', 'disabled', 'hidden'] });
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const radio = e.target.closest?.('[role=radio]');
      const g = radio?.closest('[role=radiogroup]');
      if (!g) return;
      const items = groupRadios(g).filter((r) => !r.disabled && r.getClientRects().length);
      const i = items.indexOf(radio);
      const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
      if (to === undefined || !items.length) return;
      e.preventDefault();
      e.stopPropagation(); // capture phase: workspace shortcuts never see radio navigation keys
      const next = items[(to + items.length) % items.length];
      if (next === radio) return;
      next.focus();
      if (next.getAttribute('aria-checked') !== 'true') next.click();
    }, true);
  }

  const isTyping = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const ACTIVATABLE = 'button, a[href], select, summary, input[type=checkbox], input[type=radio], [role=button], [role=menuitem], [role=radio], [role=checkbox], [role=switch], [role=tab]';

  let pointerFocus = null; // the control that received focus from the latest pointer press
  function bindShortcuts() {
    document.addEventListener('pointerdown', (e) => { const label = e.target.closest?.('label'); pointerFocus = (label?.control || e.target.closest?.(ACTIVATABLE)) || null; }, true);
    document.addEventListener('focusin', (e) => { if (e.target !== pointerFocus) pointerFocus = null; }, true);
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('dialog[open]')) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('sw')) {
          e.preventDefault();
          onSwatchClick(refOf(e.target));
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.target.classList?.contains('sw')) {
          clearSwatch(refOf(e.target));
        }
        return;
      }
      // Find tool (#53, js/suite.js) in every workspace, also while typing: the text stays as it is
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k' && actions['find-tool']) {
        e.preventDefault();
        closeMenus();
        actions['find-tool']();
        return;
      }
      const own = shortcutHandlers[document.body.dataset.workspace];
      if (own) {
        if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
        if (e.key === 'Escape' && document.querySelector('.menu.open')) { closeMenus(); return; }
        // a control focused by keyboard/script keeps Enter/Space for its own activation; one focused by
        // a pointer press does not, so e.g. Space-panning after clicking a tool button still works
        if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.(ACTIVATABLE) && e.target !== pointerFocus) return;
        own(e, isTyping(e.target));
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && e.altKey && key === 'n') { e.preventDefault(); newProject(); return; }
      if (mod && !e.altKey && !e.shiftKey) {
        const tiles = document.body.dataset.workspace === 'tiles';
        const run = (paletteFn, tilesAction) => {
          e.preventDefault();
          if (tiles && actions[tilesAction]) actions[tilesAction]();
          else paletteFn();
        };
        if (key === 'o') { run(openProject, 'tiles-open'); return; }
        if (key === 's') { run(saveProject, 'tiles-save'); return; }
        if (key === 'i') { run(importFromPng, 'tiles-import'); return; }
      }
      if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
      if (e.key === 'Escape') {
        closeMenus();
        if (state.selected != null) { state.selected = null; renderSwatches(); }
        return;
      }
      if (isTyping(e.target)) return;
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('sw')) {
        e.preventDefault();
        onSwatchClick(refOf(e.target));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (e.target.classList?.contains('sw') && clearSwatch(refOf(e.target))) return;
        if (state.selected != null) clearSwatch({ role: 'palette_slot', i: state.selected });
      }
    });
  }

  // ------------------------------------------------------------------ //
  // Control bindings                                                   //
  // ------------------------------------------------------------------ //

  function bindNumber(input, { min, max, decimals = 0 }, apply) {
    const read = () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) return null;
      const c = clamp(v, min, max);
      return decimals ? Number(c.toFixed(decimals)) : Math.round(c);
    };
    input.addEventListener('input', () => {
      const v = read();
      if (v != null) apply(v);
    });
    input.addEventListener('change', () => {
      const v = read();
      if (v != null) {
        input.value = decimals ? v.toFixed(decimals) : v;
        apply(v);
      } else {
        input.blur();
        renderControls();
      }
    });
  }

  /** click selection; Arrow/Home/End keys come from bindRadioGroups (role=radiogroup) */
  function bindSeg(seg, onChange) {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (b) onChange(b.dataset.value);
    });
  }

  function applyTheme(mode) {
    const root = document.documentElement;
    if (mode === 'light' || mode === 'dark') root.dataset.theme = mode;
    else delete root.dataset.theme;
    dom.themeToggle.title = `Theme: ${mode === 'light' || mode === 'dark' ? mode : 'system'}`;
    dom.themeToggle.setAttribute('aria-label', `${dom.themeToggle.title}. Change theme`);
  }

  function bindControls() {
    bindSeg(dom.modeSeg, setMode);
    bindSeg(dom.dirSeg, (dir) => switchDirection(dir));

    $('#saveRampBtn').addEventListener('click', saveRampPreset);
    $('#prevRampBtn').addEventListener('click', () => stepRamp(-1));
    $('#nextRampBtn').addEventListener('click', () => stepRamp(1));
    $('#newRampBtn').addEventListener('click', newRamp);
    $('#autoFillBtn').addEventListener('click', autoFill);
    $('#loadImageBtn').addEventListener('click', loadPreviewImage);

    dom.orientationBtn.addEventListener('click', () => {
      state.orientation = state.orientation === 'vertical' ? 'horizontal' : 'vertical';
      renderControls();
      drawGradient();
      scheduleAutosave();
    });

    bindNumber(dom.gammaInput, { min: 0.2, max: 5, decimals: 2 }, (v) => { if (v !== state.gamma) { state.gamma = v; generateFade(); } });
    bindNumber(dom.covMinInput, { min: 0, max: 16 }, (v) => { if (v !== state.covMin) { state.covMin = v; generateFade(); } });
    bindNumber(dom.covMaxInput, { min: 0, max: 16 }, (v) => { if (v !== state.covMax) { state.covMax = v; generateFade(); } });

    dom.fadeSlider.addEventListener('input', () => setSlider(Number(dom.fadeSlider.value)));

    for (const [input, sender] of [
      [dom.greyInBlack, 'inBlack'], [dom.greyInWhite, 'inWhite'], [dom.greyOutDark, 'outDark'], [dom.greyOutBright, 'outBright'],
    ]) {
      input.addEventListener('change', () => onGreyRange(sender));
    }

    dom.toggleIndices.addEventListener('click', () => {
      state.showIndices = !state.showIndices;
      store.set(KEYS.indices, state.showIndices);
      renderControls();
      renderSwatches();
    });

    dom.themeToggle.addEventListener('click', () => {
      const order = ['system', 'light', 'dark'];
      const cur = store.get(KEYS.theme, 'system');
      const next = order[(order.indexOf(cur) + 1) % order.length];
      store.set(KEYS.theme, next);
      applyTheme(next);
      toast(`Theme: ${next}`, 'info', 1500);
    });

    // Image preview: drag to scroll + drop a PNG file
    let scroll = null;
    const canvas = dom.imageCanvas;
    canvas.addEventListener('pointerdown', (e) => {
      const img = state.img;
      if (!img || (img.w <= 128 && img.h <= 128)) return;
      scroll = { id: e.pointerId, x0: e.clientX, y0: e.clientY, sx: img.scrollX, sy: img.scrollY };
      canvas.setPointerCapture(e.pointerId);
      dom.imageFrame.classList.add('scrolling');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!scroll || e.pointerId !== scroll.id || !state.img) return;
      const ratio = canvas.width / canvas.clientWidth;
      state.img.scrollX = scroll.sx - (e.clientX - scroll.x0) * ratio;
      state.img.scrollY = scroll.sy - (e.clientY - scroll.y0) * ratio;
      drawImagePreview();
    });
    const endScroll = () => { scroll = null; dom.imageFrame.classList.remove('scrolling'); };
    canvas.addEventListener('pointerup', endScroll);
    canvas.addEventListener('pointercancel', endScroll);

    dom.imageFrame.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) {
        e.preventDefault();
        dom.imageFrame.classList.add('dragover');
      }
    });
    dom.imageFrame.addEventListener('dragleave', () => dom.imageFrame.classList.remove('dragover'));
    dom.imageFrame.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.imageFrame.classList.remove('dragover');
      const file = e.dataTransfer?.files?.[0];
      if (file) loadPreviewFromFile(file);
    });
    // Don't navigate away when a file is dropped elsewhere on the page
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  /** Fade slider (0..31, 16 = normal); shared by the image preview and the Tile Maker fade preview. */
  function setSlider(v) {
    state.slider = clamp(Math.round(v), 0, 31);
    dom.fadeSlider.value = state.slider;
    const desired = state.slider <= 15 ? 'dark' : 'bright';
    if (desired !== state.direction) switchDirection(desired, { fromSlider: true });
    else drawImagePreview();
    renderSliderReadout();
    emit('p8:slider');
  }

  // ------------------------------------------------------------------ //
  // Workspaces (Palette & Fades | Tile Maker)                          //
  // ------------------------------------------------------------------ //

  // Every <main data-ws="..."> is a workspace; elements with data-show="ws1 ws2" (menus, menu
  // entries, app bar buttons) are only visible in the listed workspaces.
  const workspaces = () => [...document.querySelectorAll('main[data-ws]')].map((m) => m.dataset.ws);
  const shortcutHandlers = {};
  const APP_TITLE = document.title;

  // Remember outer offsets before hiding a view: hiding it can clamp the host scroll.
  const workspaceScroll = new Map(), lastWorkspaceView = new Map();
  let changingWorkspace = false;
  function rememberWorkspaceScroll(host) {
    if (host?.dataset.view) workspaceScroll.set(host.dataset.view, { top: host.scrollTop, left: host.scrollLeft });
  }
  function restoreWorkspaceScroll(host) {
    const saved = workspaceScroll.get(host.dataset.view);
    host.scrollTo({ top: saved?.top || 0, left: saved?.left || 0, behavior: 'instant' });
  }
  function setWorkspaceView(ws, sub) {
    const host = document.getElementById('workspaceHost'), key = sub ? `${ws}/${sub}` : ws;
    if (host && host.dataset.view !== key) {
      host.dataset.view = key;
      if (!changingWorkspace) restoreWorkspaceScroll(host);
    }
    lastWorkspaceView.set(ws, key);
  }
  document.addEventListener('keydown', (event) => {
    if (!['PageDown', 'PageUp'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    if (document.querySelector('dialog[open], .menu.open')) return;
    if (event.target !== document.body && !event.target.closest?.('.appbar')) return;
    const host = document.getElementById('workspaceHost');
    if (!host || host.scrollHeight <= host.clientHeight + 1) return;
    event.preventDefault();
    host.focus({ preventScroll: true });
    host.scrollBy({ top: host.clientHeight * 0.9 * (event.key === 'PageDown' ? 1 : -1), behavior: 'instant' });
  });
  /**
   * Shows workspace `ws`. `sub` names a part of it (an Extra Tools tab): it is passed on in the
   * `p8:workspace` event detail {ws, sub} and the address becomes #ws/sub (see js/nav-core.js).
   */
  function setWorkspace(ws, { persist = true, sub = null } = {}) {
    if (!workspaces().includes(ws)) { ws = 'home'; sub = null; }
    const focused = document.activeElement;
    const host = document.getElementById('workspaceHost');
    rememberWorkspaceScroll(host);
    changingWorkspace = true;
    if (host) host.dataset.view = sub ? `${ws}/${sub}` : lastWorkspaceView.get(ws) || ws;
    document.body.dataset.workspace = ws;
    for (const main of document.querySelectorAll('main[data-ws]')) main.hidden = main.dataset.ws !== ws;
    for (const node of document.querySelectorAll('[data-show]')) node.hidden = !node.dataset.show.split(/\s+/).includes(ws);
    for (const tab of document.querySelectorAll('#wsTabs [data-value]')) {
      tab.setAttribute('aria-checked', String(tab.dataset.value === ws));
    }
    for (const name of document.querySelectorAll('#wsTitle span')) name.classList.toggle('on', name.dataset.ws === ws);
    // focus inside the workspace/menu that was just hidden would fall back to <body>: keep it on the tab
    if (focused && focused !== document.body && !focused.getClientRects().length) {
      document.querySelector(`#wsTabs [data-value="${ws}"]`)?.focus({ preventScroll: true });
    }
    const name = document.querySelector(`#wsTabs [data-value="${ws}"]`)?.getAttribute('aria-label');
    document.title = ws === 'home' || !name ? APP_TITLE : `${name} – ${APP_TITLE}`;
    if (persist) {
      store.set(KEYS.workspace, ws);
      if (ws !== 'home') store.set(KEYS.lastTool, ws);
      setRoute(ws, sub);
    }
    emit('p8:workspace', { ws, sub });
    changingWorkspace = false;
    if (host) restoreWorkspaceScroll(host);
  }

  /** the address for a deep link to the current view; only while `ws` is the open workspace */
  function setRoute(ws, sub = null) {
    if (document.body.dataset.workspace !== ws) return;
    setWorkspaceView(ws, sub);
    const hash = P8Nav.formatRoute(ws, sub);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function openRoute(hash, fallback) {
    const r = P8Nav.parseRoute(hash);
    if (r.ws) setWorkspace(r.ws, { sub: r.sub });
    else setWorkspace(fallback);
  }

  // ------------------------------------------------------------------ //
  // Init                                                               //
  // ------------------------------------------------------------------ //

  function init() {
    applyTheme(store.get(KEYS.theme, 'system'));
    bindPrefs();
    P8Tips.init({ prefs, help: P8Help });
    bindProjectContext();
    state.showIndices = store.get(KEYS.indices, true) !== false;

    buildSystemPalette();
    buildPaletteSlots();
    buildRampEditor();
    bindMenus();
    bindRadioGroups();
    bindShortcuts();
    bindControls();
    renderRecent();

    // the title frame holds every tab's name (stacked), so it is always as wide as the longest one;
    // each tab also gets its name as a label, shown on wide screens (css/suite.css)
    $('#wsTitle').replaceChildren(...[...document.querySelectorAll('#wsTabs [data-value]')].map((tab) => {
      if (!tab.querySelector('.ws-tab-label')) tab.append(el('span', { className: 'ws-tab-label', textContent: tab.getAttribute('aria-label') }));
      const name = document.createElement('span');
      name.dataset.ws = tab.dataset.value;
      name.textContent = tab.getAttribute('aria-label');
      return name;
    }));
    bindSeg($('#wsTabs'), (ws) => setWorkspace(ws));
    window.addEventListener('hashchange', () => openRoute(location.hash, 'home'));
    openRoute(location.hash, store.get(KEYS.workspace, 'home'));

    restoreSession();
    renderAll();
    generateFade();
  }

  /** Replaces the custom palette (16 pico indices or null) as if the user had edited it. */
  function setCustomPalette(colors) {
    if (state.mode === 'ramp') setMode('normal');
    state.custom = Array.from({ length: 16 }, (_, i) => (isValidPico(colors[i]) ? colors[i] : null));
    state.selected = null;
    onPaletteChanged();
    scheduleAutosave();
  }

  /** ramps (stops per slot) + "Fade to" slot that an imported fade table walks through */
  function stopsFromTable(f) {
    const stops = emptyStops();
    if (!f) return { stops, target: null };
    for (let c = 0; c < 16; c++) {
      const seq = [];
      for (const row of f.tables) { const slot = row[c] & 15; if (seq[seq.length - 1] !== slot) seq.push(slot); }
      seq.slice(1, 1 + STOPS_PER_ROW).forEach((slot, k) => { stops[c][k] = state.custom[slot] ?? null; });
    }
    // "Fade to": the slot most rows end on
    const end = f.tables[f.tables.length - 1].map((v) => v & 15);
    const target = [...new Set(end)].sort((a, b) => end.filter((x) => x === b).length - end.filter((x) => x === a).length)[0];
    return { stops, target };
  }

  /**
   * An image that brings its own screen palette (and fade tables {dark, bright, from}, 32 x 16
   * packed each): sets the custom palette, replaces the ramps of both directions (from the
   * tables, or empty: ramps of another palette mean nothing here), and uses the tables on the
   * slider until the palette or a direction's ramps are edited.
   */
  function adoptImagePalette(pal, f = null) {
    setCustomPalette(pal);
    const dark = stopsFromTable(f?.dark);
    const bright = stopsFromTable(f?.bright);
    state.dirStops = { dark: dark.stops, bright: bright.stops };
    state.dirTargets = { dark: dark.target, bright: bright.target };
    const mine = state.direction === 'dark' ? dark : bright;
    state.stops = cloneStops(mine.stops);
    state.target = mine.target != null ? state.custom[mine.target] : null;
    state.imported = f ? {
      dark: f.dark, bright: f.bright, from: f.from,
      sig: { dark: fadeSig(dark.stops), bright: fadeSig(bright.stops) },
    } : null;
    renderAll();
    generateFade();
  }

  /** Loads an ImageData into the image preview (throws on unsupported sizes). */
  function loadPreviewImageData(imageData, indices = null) {
    setPreviewImage(imageData, { indices });
    state.grey = null;
    renderControls();
  }

  /**
   * Both fade directions of the current palette ({tables, coverage} or null), for Pixel Studio's
   * fade shade ink. palette: the 16 screen colors the tables' slots refer to.
   */
  function fadeSets() {
    const out = { dark: null, bright: null, palette: fullPalette(state.custom) };
    out[state.direction] = state.fade;
    const other = state.direction === 'dark' ? 'bright' : 'dark';
    if (state.dirStops[other] && state.dirTargets[other] != null) {
      try {
        out[other] = generateWithRamps(buildSlotRamps(state.custom, state.dirStops[other], state.dirTargets[other]),
          { steps: FADE_STEPS, gamma: state.gamma, covMin: state.covMin, covMax: state.covMax });
      } catch { /* that direction is incomplete */ }
    }
    return out;
  }

  // Shared API for the other workspaces (js/tiles.js, js/suite.js, js/studio.js, ...)
  window.P8App = {
    VERSION,
    state,
    activePalette,
    setSlider,
    setWorkspace,
    setRoute,
    rememberWorkspaceScroll: () => { if (!changingWorkspace) rememberWorkspaceScroll(document.getElementById('workspaceHost')); },
    setCustomPalette,
    loadPreviewImageData,
    adoptImagePalette,
    fadeSets,
    registerActions: (more) => Object.assign(actions, more),
    registerShortcuts: (ws, handler) => { shortcutHandlers[ws] = handler; },
    runAction: (name, data = {}) => actions[name]?.(data),
    isTyping,
    openMappingDialog,
    paintSwatch,
    modal,
    showMessage,
    showSettings,
    /** Local error log (#62): report(source, code, error, state), watchWorker(worker, source), read(), clear(), exportJSON() */
    diagnostics,
    /**
     * Active project (#55), read-only for consumers: projectContext.get() / check() / subscribe(fn).
     * Tools that open a project report it through projectContextPublisher.select({ name, source, handle }) / clear(source).
     * The context never writes, scans or opens anything; see EXTENDING.md.
     */
    projectContext: projectCtx.context,
    projectContextPublisher: projectCtx.publisher,
    /** UX preferences: get(), set(patch), reset(), status(), subscribe(fn) -> unsubscribe; see EXTENDING.md */
    prefs,
    reducedMotion,
    confirmDialog,
    codeDialog,
    toast,
    download,
    pickFile,
    decodeImage,
    formField,
    sanitizeFilename,
    store,
    /** localStorage key names (read-only use by Home: lastTool) */
    KEYS,
    el,
    $,
  };

  init();
})();

// js/datacarts.js
// Data Carts workspace:
//   Inspect - what each cart holds in 0x0000-0x42ff (exactly as reload() sees it), which ranges
//             the project's code reloads, and how much space nobody reads.
//   Pack    - build a new data cart from ranges of existing carts, library images and files;
//             raw by default, LZ per entry on request; writes the .p8 and the reload() lines.

'use strict';

(() => {
  const App = window.P8App;
  const S = window.Suite;
  const C = P8Cart;
  const { rgbOf } = P8;
  const { el, $, toast, download, pickFile, showMessage, modal } = App;

  const ROM = C.ROM_SIZE;
  const hex4 = (n) => `0x${(n >>> 0).toString(16).padStart(4, '0')}`;
  const kb = (n) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  const REGION_HUE = { gfx: [41, 173, 255], map: [0, 228, 54], gff: [255, 236, 39], music: [255, 119, 168], sfx: [255, 163, 0] };
  const regionOf = (a) => C.REGIONS.find((r) => a >= r.start && a < r.end) || C.REGIONS[C.REGIONS.length - 1];
  const ALL32 = [...P8.BASE_INDICES, ...P8.HIDDEN_INDICES];
  const VALID = new Set(ALL32);
  const STD = Array.from({ length: 16 }, (_, i) => i);
  const V = P8DataView;

  const dc = {
    carts: new Map(),     // name -> {name, path, rom, used, reads: [], size}
    order: [],
    sel: null,
    mode: 'inspect',
    onlyData: true,
    view: { start: 0, len: 0x2000, as: 'img4', width: 128 },
    pack: [],             // {label, bytes, lz, src}
    // #56: the cart list follows Project Audit's scans (the shared project folder) until the user opens
    // .p8 files here; then a scan elsewhere never replaces them. Open Project Folder / Use resume following.
    followProject: true,
    followRequested: false, // Open Project Folder / Use pressed here: the next scan arriving while Data Carts is open
    packName: 'pack.p8',
    packStart: 0,
    secs: [],             // sections of the selected cart (datacarts-core)
    secId: null,          // selected section, null = custom range
    pal: { key: 'std', colors: STD.slice() },   // screen palette for 4-bit images
    fade: null,           // {key, cart, base, rows, row}: pal(..,2) row the image is drawn through
    palInfo: null,        // palette candidates of the selected section
  };

  const dom = {
    open: $('#dcOpen'), files: $('#dcFiles'), root: $('#dcRoot'), status: $('#dcStatus'),
    modeSeg: $('#dcMode'), only: $('#dcOnlyData'), list: $('#dcList'),
    inspect: $('#dcInspect'), pack: $('#dcPack'),
    title: $('#dcTitle'), stats: $('#dcStats'), map: $('#dcMap'), legend: $('#dcLegend'),
    reads: $('#dcReads'), secList: $('#dcSecs'),
    vStart: $('#dcStart'), vLen: $('#dcLen'), vAs: $('#dcAs'), vWidth: $('#dcWidth'), vWidthWrap: $('#dcWidthWrap'),
    viewer: $('#dcViewer'), hexOut: $('#dcHex'), vInfo: $('#dcViewInfo'),
    viewerWrap: $('#dcViewerWrap'), viewerEmpty: $('#dcViewerEmpty'), mapEmpty: $('#dcMapEmpty'),
    toLib: $('#dcToLib'), toLayers: $('#dcToLayers'), addPack: $('#dcAddPack'), dlBin: $('#dcDlBin'),
    palRow: $('#dcPalRow'), palSel: $('#dcPal'), swatches: $('#dcSwatches'), palLua: $('#dcPalLua'),
    secondary: $('#dcSecondary'),
    fadeWrap: $('#dcFadeWrap'), fadeSel: $('#dcFade'), rowWrap: $('#dcRowWrap'), rowIn: $('#dcRow'),
    packList: $('#dcPackList'), packBar: $('#dcPackBar'), packInfo: $('#dcPackInfo'), packNameIn: $('#dcPackName'),
    packAddLib: $('#dcPackAddLib'), packAddFile: $('#dcPackAddFile'), packDl: $('#dcPackDl'), packLua: $('#dcPackLua'),
  };

  // ------------------------------------------------------------------ //
  // Loading carts                                                      //
  // ------------------------------------------------------------------ //

  /** files: Map(path -> text). Parses every .p8 and attributes reload() calls to target carts. */
  function loadProject(files, root) {
    dc.carts = new Map();
    const p8 = [...files.keys()].filter((p) => /\.p8$/i.test(p)).sort();
    for (const path of p8) {
      const text = files.get(path);
      let parsed;
      try { parsed = C.parseP8(text); } catch (err) { continue; }
      const name = path.slice(path.lastIndexOf('/') + 1);
      const luaAt = text.split(/\r?\n/).findIndex((l) => /^__lua__\s*$/.test(l)) + 1; // file line of the code's first line - 1
      dc.carts.set(name.toLowerCase(), { name, path, rom: parsed.rom, used: C.usedMask(parsed.rom), lua: parsed.lua, luaAt, reads: [], size: text.length });
    }
    const names = [...dc.carts.values()].map((c) => c.name);
    for (const c of dc.carts.values()) {
      // comments (block ones too) do not call reload()
      for (const r of C.findReloads(V.stripComments(c.lua))) {
        const target = C.reloadTarget(r.fileExpr, c.lua);
        if (!target) continue;
        for (const n of names.filter(target.match)) {
          const t = dc.carts.get(n.toLowerCase());
          const src = r.src ?? 0;
          const len = r.len ?? ROM - src;
          t.reads.push({ from: c.name, line: r.line + c.luaAt, text: r.text, src, len: Math.max(0, Math.min(len, ROM - src)), dest: r.dest, inferred: target.inferred || r.src == null || r.len == null });
        }
      }
    }
    for (const c of dc.carts.values()) {
      c.readMask = new Uint8Array(ROM);
      for (const r of c.reads) c.readMask.fill(1, r.src, r.src + r.len);
      // the cart's own code reads its data straight from memory (sget, mget, @0x2000, memcpy, ..)
      c.own = V.ownReads(c);
      c.ownMask = V.ownMask(c.own);
      // reads whose bytes are unknown: computed addresses / included code, inferred reload() ranges
      c.uncertain = [...(c.own.unresolved || []), ...c.reads.filter((r) => r.inferred).map((r) => `reload() ${r.from}:${r.line} (inferred)`)];
      c.usedBytes = c.used.reduce((s, v) => s + v, 0);
      c.readBytes = c.readMask.reduce((s, v) => s + v, 0);
      let lost = 0, ownBytes = 0, anyRead = 0;
      for (let i = 0; i < ROM; i++) {
        if (c.used[i] && c.ownMask[i]) ownBytes++;
        if (c.readMask[i] || c.ownMask[i]) anyRead++;
        if (c.used[i] && !c.readMask[i] && !c.ownMask[i]) lost++;
      }
      c.ownBytes = ownBytes;
      c.anyReadBytes = anyRead;
      c.unreadContent = lost;
      // reloaded by someone, data its own code reads, or no code apart from comments
      c.isData = c.reads.length > 0 || c.ownBytes > 0 || !V.stripComments(c.lua).trim();
    }
    dc.root = root;
    dc.sel = dc.sel && dc.carts.has(dc.sel) ? dc.sel : [...dc.carts.values()].find((c) => c.isData)?.name.toLowerCase() || null;
    renderAll();
  }

  async function openFiles() {
    const input = el('input', { type: 'file', accept: '.p8', multiple: true });
    input.addEventListener('change', async () => {
      const files = new Map();
      for (const f of input.files) files.set(f.name, await f.text());
      if (!files.size) return;
      dc.followProject = false;
      loadProject(files, `${files.size} file${files.size === 1 ? '' : 's'}`);
    });
    input.click();
  }

  // ------------------------------------------------------------------ //
  // List + map                                                         //
  // ------------------------------------------------------------------ //

  const cur = () => (dc.sel ? dc.carts.get(dc.sel) : null);
  const curSec = () => dc.secs.find((s) => s.id === dc.secId) || null;

  function renderList() {
    const items = [...dc.carts.values()].filter((c) => !dc.onlyData || c.isData);
    dom.list.replaceChildren(...(items.length ? items.map((c) => el('button', {
      type: 'button', className: 'dc-item', dataset: { name: c.name.toLowerCase() },
      attrs: { 'aria-pressed': String(c.name.toLowerCase() === dc.sel) },
    },
    el('span', { className: 'dc-item-name', textContent: c.name }),
    el('span', { className: 'dc-item-bar' }, el('i', { className: 'read', style: `width:${(c.readBytes / ROM) * 100}%` }), el('i', { className: 'used', style: `width:${(c.usedBytes / ROM) * 100}%` })),
    el('span', { className: 'muted dc-item-meta', textContent: `${kb(c.usedBytes)} data · ${c.reads.length ? `${kb(c.readBytes)} read` : c.ownBytes ? 'read by its own code' : 'not reloaded'}${c.uncertain.length ? ' · uncertain reads' : ''}` }))) : [el('p', { className: 'muted', textContent: dc.carts.size ? 'No data carts. Untick “Only data carts” to see all carts.' : 'Open Project Folder… reads the same folder as Project Audit (read only), or Open .p8 Files… loads single carts. Packed carts are downloads.' })]));
  }

  const CELL = 128; // bytes per map row
  function drawMap() {
    const c = cur();
    const cv = dom.map;
    dom.mapEmpty.hidden = !!c; // #187: no cart is not the same as an all-black memory map
    const rows = Math.ceil(ROM / CELL);
    cv.width = CELL;
    cv.height = rows;
    const g = cv.getContext('2d');
    const img = g.createImageData(CELL, rows);
    for (let i = 0; i < CELL * rows; i++) {
      const o = i * 4;
      if (i >= ROM || !c) { img.data[o + 3] = 0; continue; }
      const used = c.used[i];
      // read = covered by a reload() or read by the cart's own code (sget, @0x2000, ..)
      const read = c.readMask[i] || c.ownMask[i];
      const base = REGION_HUE[regionOf(i).id];
      let rgb;
      if (used && read) rgb = base;
      else if (used) rgb = [255, 0, 77];
      else if (read) rgb = base.map((v) => v * 0.35);
      else rgb = base.map((v) => v * 0.12);
      img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    if (!c) return;
    // section borders, then the viewed range
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    for (const s of dc.secs) {
      const y = Math.floor(s.start / CELL);
      g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(CELL, y + 0.5); g.stroke();
    }
    const { start, len } = dc.view;
    const y0 = Math.floor(start / CELL);
    const y1 = Math.ceil((start + len) / CELL);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, y0, CELL, Math.max(1, y1 - y0));
    g.strokeStyle = '#fff';
    g.strokeRect(0.5, y0 + 0.5, CELL - 1, Math.max(1, y1 - y0) - 1);
  }

  function renderInspect() {
    const c = cur();
    if (!c) {
      dom.title.textContent = 'No cart selected';
      dom.stats.replaceChildren();
      dom.secList.replaceChildren(el('p', { className: 'muted', textContent: 'Select a cart.' }));
      dom.reads.replaceChildren();
      drawMap();
      renderViewer();
      return;
    }
    dom.title.textContent = c.name;
    if (dc.secsFor !== c) {
      dc.secsFor = c;
      dc.secs = V.sections(c, dc.carts);
      dc.layers = V.layerInfo(c, dc.carts, dc.secs);
      const first = dc.secs.find((s) => s.kind === 'img') || dc.secs[0];
      if (first) selectSection(first.id, false); else { dc.secId = null; setRange(0, 0x2000, false); }
    }
    const stat = (label, v, title = '') => el('div', { className: 'au-stat', title }, el('strong', { textContent: v }), el('span', { className: 'muted', textContent: label }));
    const reloads = new Set(c.reads.map((r) => `${r.from}:${r.line}`)).size;
    dom.stats.replaceChildren(...[
      stat('data in the cart', kb(c.usedBytes), 'Bytes that differ from an empty cart'),
      stat('read by reload()', c.reads.length ? kb(c.readBytes) : '–', 'Union of all reload() ranges that point to this cart'),
      c.ownBytes ? stat('read by its own code', kb(c.ownBytes), `When this cart runs, its data is already in memory and its code reads it directly:\n${C.REGIONS.filter((r) => c.own[r.id]).map((r) => `${r.name}: ${c.own[r.id].how.join(', ')}${c.own[r.id].whole ? ' (whole region: approximation)' : ' (exact ranges)'}`).join('\n')}`) : null,
      stat('no read detected', kb(ROM - c.anyReadBytes), `Bytes in 0x0000-0x42ff for which no reload() range and no read in the cart's own code was found. A heuristic, not proof that the space is free: computed addresses, included code and code outside this folder are not followed${c.uncertain.length ? ' (this cart has uncertain reads)' : ''}. Check the code before putting other data there.`),
      stat('reload() calls', String(reloads)),
      c.uncertain.length ? stat('uncertain reads', String(c.uncertain.length), `Reads whose bytes could not be worked out; any range may be read:\n${c.uncertain.join('\n')}`) : null,
      c.unreadContent ? stat('data, no read detected', kb(c.unreadContent), 'Bytes with content that no reload() range covers and no read found in the cart\'s own code covers (red in the map). Not proof that nothing reads them.') : null].filter(Boolean));
    renderSections();
    dom.reads.replaceChildren(...(c.reads.length ? c.reads.map((r) => el('div', { className: 'dc-read' },
      el('code', { textContent: `${hex4(r.src)}–${hex4(r.src + r.len - 1)}` }), el('span', { textContent: ` ${kb(r.len)}` }),
      el('span', { className: 'muted', textContent: ` · ${r.from}:${r.line}${r.inferred ? ' (inferred)' : ''}` }),
      el('code', { className: 'dc-read-code', textContent: r.text }))) : [el('p', { className: 'muted', textContent: 'No reload() in the project points to this cart.' })]));
    drawMap();
    renderViewer();
  }

  const KIND = { img: 'image', pal: 'palette table', hex: 'data' };
  function renderSections() {
    const c = cur();
    dom.secList.replaceChildren(...(dc.secs.length ? dc.secs.map((s) => el('button', {
      type: 'button', className: 'dc-sec', dataset: { id: s.id }, attrs: { 'aria-pressed': String(s.id === dc.secId) },
      title: `${hex4(s.start)}–${hex4(s.start + s.len - 1)}${s.fx ? ` · cut out by ${s.fx}${s.alsoFx ? ` (also ${s.alsoFx.join(', ')})` : ''}` : ''}`,
    },
    el('span', { className: 'dc-sec-name', textContent: s.label }),
    el('span', { className: 'muted', textContent: `${s.fx ? s.fx.replace(/\.p8$/i, '') : c?.reads.length ? 'no read detected' : 'not reloaded'} · ${KIND[s.kind]} · ${hex4(s.start)} +${kb(s.len)}` }))) : [el('p', { className: 'muted', textContent: 'No sections found.' })]),
    el('button', { type: 'button', className: 'dc-sec', dataset: { id: '' }, attrs: { 'aria-pressed': String(dc.secId == null) }, title: 'Any range: type Start / Length below, or drag on the map' },
      el('span', { className: 'dc-sec-name', textContent: 'Custom range' }), el('span', { className: 'muted', textContent: `${hex4(dc.view.start)} +${kb(dc.view.len)}` })));
  }

  // per cart + section view settings (palette, fade row, view type)
  const secKey = (id) => `p8suite.dc.view.${cur()?.name.toLowerCase()}@${id ?? 'custom'}`;
  function saveSecView() {
    App.store.set(secKey(dc.secId), { pal: dc.pal, fade: dc.fade && { key: dc.fade.key, row: dc.fade.row }, as: dc.view.as, width: dc.view.width });
  }

  function selectSection(id, render = true) {
    const c = cur();
    const s = dc.secs.find((x) => x.id === id);
    dc.secId = s ? s.id : null;
    if (s) { dc.view.start = s.start; dc.view.len = s.len; }
    dc.palInfo = c ? V.sectionPalettes(s || { start: dc.view.start, len: dc.view.len, fx: readerAt(dc.view.start), store: null }, c, dc.carts) : { screen: [], fades: [], auto: {} };
    const saved = App.store.get(secKey(dc.secId), null);
    const auto = dc.palInfo.screen.find((p) => p.key === dc.palInfo.auto.screen);
    // a remembered "PICO-8 default" gives way to a palette found in the code (it may have been
    // saved only because nothing was found then)
    const savedPal = saved?.pal?.colors?.length === 16 && !(saved.pal.key === 'std' && auto) ? saved.pal : null;
    dc.pal = savedPal || (auto ? { key: auto.key, colors: auto.colors.slice() } : { key: 'std', colors: STD.slice() });
    const fk = saved ? saved.fade?.key : dc.palInfo.auto.fade;
    const f = fk && dc.palInfo.fades.find((x) => x.key === fk);
    dc.fade = f ? { ...f, row: saved?.fade?.row ?? f.row } : null;
    // own data read as numbers (sget, @addr): show the values, not palette colors
    const ownAs = s?.own?.values ? (s.start < 0x2000 ? 'img4g' : 'img8') : null;
    dc.view.as = saved?.as || ownAs || (s ? { img: 'img4', pal: 'tab', hex: 'hex' }[s.kind] : dc.view.as);
    dc.view.width = saved?.width || s?.own?.width || 128;
    dom.vAs.value = dc.view.as;
    dom.vWidth.value = String(dc.view.width);
    if (render) { renderSections(); drawMap(); renderViewer(); }
  }

  const readerAt = (a) => cur()?.reads.find((r) => a >= r.src && a < r.src + r.len)?.from || null;

  /** a range typed in or dragged on the map: a custom view (keeps the current palette) */
  function setRange(start, len, render = true) {
    dc.view.start = Math.max(0, Math.min(ROM - 1, start | 0));
    dc.view.len = Math.max(1, Math.min(ROM - dc.view.start, len | 0));
    const s = dc.secs.find((x) => x.start === dc.view.start && x.len === dc.view.len);
    if (s) return selectSection(s.id, render);
    dc.secId = null;
    if (render) { renderSections(); drawMap(); renderViewer(); }
  }

  // ------------------------------------------------------------------ //
  // Range viewer                                                       //
  // ------------------------------------------------------------------ //

  const viewBytes = () => {
    const c = cur();
    if (!c) return new Uint8Array(0);
    const s = Math.max(0, Math.min(ROM, dc.view.start));
    return c.rom.subarray(s, Math.min(ROM, s + dc.view.len));
  };

  /** 4bpp (low nibble = left pixel, like PICO-8 memory) -> palette indices. */
  function bytesTo4bpp(b, w) {
    const bpr = w >> 1;
    const h = Math.ceil(b.length / bpr);
    const px = new Uint8Array(w * h);
    for (let i = 0; i < b.length; i++) {
      const y = Math.floor(i / bpr);
      const x = (i % bpr) * 2;
      px[y * w + x] = b[i] & 15;
      px[y * w + x + 1] = b[i] >> 4;
    }
    return { w, h, px };
  }

  /** the 16 screen colors the image is shown with (after the fade row, if one is set) */
  const shownColors = () => V.effectiveColors(dc.pal.colors, dc.fade, dc.carts);

  function renderViewer() {
    const b = viewBytes();
    const { as, width } = dc.view;
    const isImg = as === 'img4' || as === 'img4g' || as === 'img8';
    dom.vWidthWrap.hidden = !isImg;
    dom.toLib.hidden = as !== 'img4';
    const li = dc.layers;
    dom.toLayers.hidden = !(li && (dc.secId === li.image.id || dc.secId === li.mask.id));
    if (li) dom.toLayers.title = `Rebuild the ${li.layers} layer${li.layers === 1 ? '' : 's'} ${li.fx} draws from “${li.image.label}” and “${li.mask.label}”, as a layered image in Pixel Studio`;
    renderPal();
    dom.hexOut.hidden = as !== 'hex';
    dom.viewer.hidden = as === 'hex';
    dom.vStart.value = hex4(dc.view.start);
    dom.vLen.value = hex4(dc.view.len);
    const reg = regionOf(dc.view.start);
    const sec = dc.secs?.find((x) => x.id === dc.secId);
    const ownNote = sec?.own ? ` · read by the cart's own code${sec.own.whole ? ' (whole region: approximation)' : ''}: ${sec.own.how.join(', ')}${sec.own.values ? ' (as values: they may be data, not colors)' : ''}` : '';
    dom.vInfo.textContent = b.length ? `${b.length} bytes · ${reg.name}${dc.view.start + b.length > reg.end ? ' and following' : ''}${as === 'img4' || as === 'img4g' ? ` · ${width}×${Math.ceil(b.length / (width >> 1))} px` : as === 'tab' ? ` · ${Math.ceil(b.length / 16)} rows of 16` : ''}${ownNote}` : '';
    // #187: no bytes selected says so; selected bytes always show as data, even when they are all black
    dom.viewerEmpty.hidden = b.length > 0;
    dom.viewerWrap.classList.toggle('is-empty', !b.length);
    if (!b.length) {
      dom.viewerEmpty.textContent = cur() ? 'Select a section or an address range to view its bytes.' : 'Select a cart to view its data.';
      dom.viewer.width = 1; dom.viewer.height = 1; dom.hexOut.textContent = ''; return;
    }
    if (as === 'hex') {
      const lines = [];
      const n = Math.min(b.length, 4096);
      for (let i = 0; i < n; i += 16) {
        const row = Array.from(b.subarray(i, i + 16));
        lines.push(`${hex4(dc.view.start + i)}  ${row.map((v) => v.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  ${row.map((v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '.')).join('')}`);
      }
      if (b.length > n) lines.push(`… ${b.length - n} more bytes (download the range to see all)`);
      dom.hexOut.textContent = lines.join('\n');
      return;
    }
    const cv = dom.viewer;
    const g = cv.getContext('2d');
    if (as === 'tab') {
      // palette / fade tables: 16 bytes per row; a screen color per byte, or the two
      // nibbles (dither pairs) through the current screen palette
      const rows = Math.ceil(b.length / 16);
      const scr = dc.pal.colors;
      cv.width = 16 * 2;
      cv.height = rows;
      const img = new ImageData(32, rows);
      for (let i = 0; i < b.length; i++) {
        const v = b[i];
        const lo = VALID.has(v) ? rgbOf(v) : rgbOf(scr[v & 15]) || [0, 0, 0];
        const hi = VALID.has(v) ? lo : rgbOf(scr[v >> 4]) || [0, 0, 0];
        const o = (Math.floor(i / 16) * 32 + (i % 16) * 2) * 4;
        img.data.set([...lo, 255, ...hi, 255], o);
      }
      g.putImageData(img, 0, 0);
      cv.classList.add('pixel', 'dc-tab');
      return;
    }
    cv.classList.remove('dc-tab');
    if (isImg) {
      let w;
      let h;
      let img;
      if (as === 'img4' || as === 'img4g') {
        const r = bytesTo4bpp(b, width);
        ({ w, h } = r);
        img = new ImageData(w, h);
        // img4g: the 16 values as a grey ramp (data that is not a picture)
        const rgb = as === 'img4g' ? Array.from({ length: 16 }, (_, v) => [v * 17, v * 17, v * 17]) : shownColors().map((p) => rgbOf(p) || [0, 0, 0]);
        for (let i = 0; i < r.px.length; i++) { const c = rgb[r.px[i]]; img.data.set([c[0], c[1], c[2], 255], i * 4); }
      } else {
        w = width;
        h = Math.ceil(b.length / w);
        img = new ImageData(w, h);
        for (let i = 0; i < b.length; i++) img.data.set([b[i], b[i], b[i], 255], i * 4);
      }
      cv.width = w;
      cv.height = h;
      g.putImageData(img, 0, 0);
      cv.classList.add('pixel');
      return;
    }
    // plots
    cv.classList.remove('pixel');
    const step = as === 'p32' ? 4 : as === 'p16' ? 2 : 1;
    const vals = [];
    for (let i = 0; i + step <= b.length; i += step) {
      if (step === 1) vals.push(b[i] > 127 ? b[i] - 256 : b[i]);
      else if (step === 2) { const v = b[i] | (b[i + 1] << 8); vals.push((v > 32767 ? v - 65536 : v) / 256); } else vals.push((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) / 65536);
    }
    const W = Math.max(320, Math.min(2048, vals.length));
    const H = 220;
    cv.width = W;
    cv.height = H;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo || 1;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(160,160,175,0.4)';
    if (lo < 0 && hi > 0) { const zy = H - 6 - ((0 - lo) / span) * (H - 12); g.beginPath(); g.moveTo(0, zy); g.lineTo(W, zy); g.stroke(); }
    g.strokeStyle = 'rgb(0,228,54)';
    g.beginPath();
    vals.forEach((v, i) => { const x = (i / Math.max(1, vals.length - 1)) * (W - 1); const y = H - 6 - ((v - lo) / span) * (H - 12); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    g.stroke();
    g.fillStyle = 'rgb(200,200,210)';
    g.font = '12px system-ui, sans-serif';
    g.fillText(`${vals.length} values · min ${+lo.toFixed(4)} · max ${+hi.toFixed(4)}`, 6, 14);
  }

  async function viewToLibrary() {
    const c = cur();
    const b = viewBytes();
    if (!c || !b.length) return;
    const { w, h, px } = bytesTo4bpp(b, dc.view.width);
    // without a fade row shown, the fx's fade table goes along (Palette & Fades / Tile Maker use it)
    const fades = dc.fade ? null : fadesFor(curSec());
    if (!(await S.assets.put(S.imageAsset({ name: `${c.name.replace(/\.p8$/i, '')} ${hex4(dc.view.start)}`, w, h, pixels: px, pal: shownColors(), transparent: -1, source: 'data-carts', meta: fades ? { fades } : null })).catch((e) => S.reportStorageError('Range to Library', e)))) return;
    toast('Saved the range as an image in the library.');
  }

  /** fade tables of the fx that uses `sec` (its palette / fade table section in this cart) */
  function fadesFor(sec) {
    const c = cur();
    const t = sec && dc.secs.find((s) => s.kind === 'pal' && s.fx && s.fx === sec.fx);
    return t ? V.fadeFromTable(c, t) : null;
  }

  /** the fx's layers (color image + mask) -> layered library image, opened in Pixel Studio */
  async function layersToStudio() {
    const c = cur();
    const li = dc.layers;
    if (!c || !li) return;
    const count = el('input', { type: 'number', min: 1, max: 16, value: String(li.layers), style: 'width:72px' });
    const split = el('input', { type: 'checkbox' });
    const ok = await modal({
      title: `Layers of ${c.name}`,
      body: el('div', { className: 'dialog-form' },
        el('p', { textContent: `${li.fx} draws this image in ${li.layers} layer${li.layers === 1 ? '' : 's'}${li.counted ? ' (count from its code)' : ' (count from the mask)'}, each with its own fade: layer 1 is “${li.image.label}”; the mask “${li.mask.label}” (values 0–${li.maxMask}) takes pixels with mask value 1…n-1 out of layer n.` }),
        el('label', { className: 'field' }, el('span', { textContent: 'Layers' }), count),
        el('label', { className: 'check' }, split, el('span', { textContent: 'Each pixel only on its top layer (the fx keeps them on the lower layers too)' }))),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Open in Pixel Studio', primary: true, value: true }],
    });
    if (!ok) return;
    const n = Math.max(1, Math.min(16, Number(count.value) | 0));
    const cels = V.buildLayers(c, li, n, split.checked);
    const w = 128;
    const h = Math.ceil(li.image.len / 64);
    // the image section's own palette (screen palette of the fx), not the current view's
    const pi = V.sectionPalettes(li.image, c, dc.carts);
    const pal = (pi.screen.find((p) => p.key === pi.auto.screen) || { colors: STD }).colors.slice();
    const doc = { w, h, pal, transparent: 0, fps: 8, layers: cels.map((_, i) => ({ name: i ? `Layer ${i + 1} (mask ${i + 1}+)` : 'Layer 1 (base)', visible: true })), frames: [{ cels }] };
    const pixels = new Uint8Array(w * h);
    for (const cel of cels) for (let i = 0; i < pixels.length; i++) if (cel[i] !== V.EMPTY) pixels[i] = cel[i];
    const fades = fadesFor(li.image);
    const a = S.imageAsset({ name: `${c.name.replace(/\.p8$/i, '')} layers`, w, h, pixels, pal, transparent: 0, source: 'data-carts', doc, meta: fades ? { fades } : null });
    if (!(await S.assets.put(a).catch((e) => S.reportStorageError('Layers to Pixel Studio', e)))) return;
    await S.openIn('studio-open', a);
  }

  // ------------------------------------------------------------------ //
  // Screen palette + fade row for 4-bit images                         //
  // ------------------------------------------------------------------ //
  //
  // Candidates come from datacarts-core (the fx code that cuts the section out):
  // pal(..,1) tables / loops / tables read from the data, and pal(..,2) fade rows.
  // Fallbacks: a palette table at Start, a library palette, edited slots, pasted Lua.

  const palLuaText = (p) => `{[0]=${p.join(',')}}`;

  function setPal(key, colors) {
    dc.pal = { key, colors: colors.slice() };
    saveSecView();
    renderViewer();
  }

  function renderPal() {
    const info = dc.palInfo || { screen: [], fades: [] };
    dom.palRow.hidden = !(dc.view.as === 'img4' || dc.view.as === 'tab');
    const opt = (value, label) => el('option', { value, textContent: label });
    const code = info.screen.filter((p) => !p.data);
    const data = info.screen.filter((p) => p.data);
    const groups = [
      opt('std', 'PICO-8 default'),
      code.length ? el('optgroup', { label: 'Set by the fx code' }, ...code.map((p) => opt(p.key, p.label))) : null,
      data.length ? el('optgroup', { label: 'Tables in this cart' }, ...data.map((p) => opt(p.key, p.label))) : null,
      el('optgroup', { label: 'Other' }, opt('view', `Read a palette table at Start (${hex4(dc.view.start)})`), opt('lib', 'Library palette…'),
        dc.pal.key.startsWith('at:') ? opt(dc.pal.key, `16 bytes at ${hex4(Number(dc.pal.key.slice(3)))}`) : null,
        dc.pal.key === 'custom' || dc.pal.key.startsWith('lib:') ? opt(dc.pal.key, dc.pal.key === 'custom' ? 'Custom' : `Library: ${dc.pal.key.slice(4)}`) : null),
    ];
    dom.palSel.replaceChildren(...groups.filter(Boolean));
    dom.palSel.value = dc.pal.key;
    if (dom.palSel.value !== dc.pal.key) dom.palSel.value = 'std';
    dom.swatches.replaceChildren(...dc.pal.colors.map((p, i) => {
      const [r, g, b] = rgbOf(p) || [0, 0, 0];
      return el('button', { type: 'button', className: 'dc-sw', title: `slot ${i} → color ${p} (click to change)`, style: `background:rgb(${r},${g},${b})`, dataset: { slot: String(i) } });
    }));
    if (document.activeElement !== dom.palLua) dom.palLua.value = palLuaText(dc.pal.colors);
    // fade table (pal(..,2) rows the fx draws this section with)
    dom.fadeWrap.hidden = !info.fades.length || dc.view.as !== 'img4';
    dom.fadeSel.replaceChildren(opt('', 'none'), ...info.fades.map((f) => opt(f.key, f.label)));
    dom.fadeSel.value = dc.fade?.key || '';
    dom.rowWrap.hidden = !dc.fade || dc.view.as !== 'img4';
    // colors set at run time through the secondary palette: say so, the palette alone can't show it
    const sec2 = info.secondary || [];
    dom.secondary.hidden = !sec2.length || dc.view.as !== 'img4';
    if (sec2.length) {
      const where = sec2.slice(0, 3).map((u) => `${u.fx.replace(/\.p8$/i, '')}:${u.line} ${u.text.length > 60 ? `${u.text.slice(0, 57)}…` : u.text}`);
      dom.secondary.textContent = `The fx colors these pixels at run time through the secondary palette (${where.join(' · ')}${sec2.length > 3 ? ` · +${sec2.length - 3} more` : ''}). Their values are lookups (materials, shades), not colors, so no single palette shows them as the effect does. Click the swatches to give each value the color you want to see.`;
    }
    if (dc.fade) { dom.rowIn.max = String(dc.fade.rows - 1); if (document.activeElement !== dom.rowIn) dom.rowIn.value = String(dc.fade.row); }
  }

  async function choosePal(key) {
    const c = cur();
    if (key === 'std') return setPal('std', STD);
    if (key === 'view') {
      const v = c ? Array.from(c.rom.subarray(dc.view.start, dc.view.start + 16)) : [];
      if (v.length < 16 || !v.every((x) => VALID.has(x))) { showMessage('Palette', `This option reads a palette that is stored in the cart as 16 bytes, one screen color (0–15 or 128–143) per slot. The bytes at Start (${hex4(dc.view.start)}) are image data, not a palette.

Set Start to the address where the palette table begins (the “palette table” sections in the list are such tables), then choose this option again. Palettes the fx code sets are listed in the menu automatically when the project folder (with the fx carts) is open.`); return renderPal(); }
      return setPal(`at:${dc.view.start}`, v);
    }
    if (key === 'lib') {
      const a = await S.pickAsset({ title: 'Palette for the data view', kind: 'palette', allowImport: false });
      if (!a) return renderPal();
      return setPal(`lib:${a.name}`, a.colors.map((v, i) => v ?? i));
    }
    const cand = dc.palInfo?.screen.find((p) => p.key === key);
    if (cand) setPal(key, cand.colors);
  }

  async function editSlot(slot) {
    const pick = await modal({
      title: `Slot ${slot}: screen color`,
      body: el('div', { className: 'dc-pick' }, ...ALL32.map((p) => {
        const [r, g, b] = rgbOf(p);
        return el('button', { type: 'button', className: 'dc-sw', title: String(p), style: `background:rgb(${r},${g},${b})`, dataset: { pico: String(p) }, attrs: { 'aria-pressed': String(p === dc.pal.colors[slot]) } });
      })),
      buttons: [{ label: 'Cancel', value: null }],
      onOpen: (dlg) => dlg.addEventListener('click', (e) => { const b = e.target.closest('[data-pico]'); if (b) dlg.finish(Number(b.dataset.pico)); }),
    });
    if (pick == null) return;
    const colors = dc.pal.colors.slice();
    colors[slot] = pick;
    setPal('custom', colors);
  }

  // ------------------------------------------------------------------ //
  // Packer                                                             //
  // ------------------------------------------------------------------ //

  const stored = (e) => (e.lz ? (e.lzBytes ||= C.lzEncode(e.bytes)) : e.bytes);
  const safeName = (s) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').toLowerCase() || 'data';

  function layout() {
    let off = dc.packStart;
    return dc.pack.map((e) => { const s = stored(e); const r = { e, off, size: s.length }; off += s.length; return r; });
  }

  function renderPack() {
    const lay = layout();
    const total = lay.length ? lay[lay.length - 1].off + lay[lay.length - 1].size : dc.packStart;
    const over = total > ROM;
    dom.packBar.style.setProperty('--pct', `${Math.min(100, (total / ROM) * 100)}%`);
    dom.packBar.dataset.level = over ? 'over' : total > ROM * 0.9 ? 'high' : 'ok';
    dom.packInfo.textContent = `${total.toLocaleString('en-US')} of ${ROM.toLocaleString('en-US')} bytes (${Math.round((total / ROM) * 100)}%)${over ? ' · too big: remove entries or pack them with LZ' : ''}`;
    dom.packDl.disabled = !lay.length || over;
    dom.packLua.disabled = !lay.length || over;
    dom.packList.replaceChildren(...(lay.length ? lay.map(({ e, off, size }, i) => el('div', { className: 'dc-pack-row' },
      el('input', { type: 'text', value: e.label, spellcheck: false, className: 'dc-pack-label', dataset: { i: String(i), k: 'label' }, attrs: { 'aria-label': 'Entry name' } }),
      el('span', { className: 'muted', textContent: e.src }),
      el('code', { textContent: `${hex4(off)} +${hex4(size)}` }),
      el('label', { className: 'check', title: 'Store LZ-compressed (needs the 60-token unlz() function at runtime)' },
        el('input', { type: 'checkbox', checked: e.lz, dataset: { i: String(i), k: 'lz' } }),
        el('span', { textContent: e.lz ? `LZ ${Math.round((size / e.bytes.length) * 100)}%` : 'LZ' })),
      el('span', { className: 'dc-pack-btns' },
        el('button', { type: 'button', className: 'btn btn-sm', textContent: '▲', title: 'Move up', dataset: { i: String(i), act: 'up' } }),
        el('button', { type: 'button', className: 'btn btn-sm', textContent: '▼', title: 'Move down', dataset: { i: String(i), act: 'down' } }),
        el('button', { type: 'button', className: 'btn btn-sm', textContent: '✕', title: 'Remove', dataset: { i: String(i), act: 'del' } }))))
      : [el('p', { className: 'muted', textContent: 'Add ranges from the inspector (“Add to pack”), library images or files. Entries are placed one after another from address 0.' })]));
  }

  function packRom() {
    const rom = C.defaultRom();
    for (const { e, off } of layout()) rom.set(stored(e), off);
    return rom;
  }

  function packLua() {
    const cart = dc.packName;
    const lay = layout();
    const anyLz = lay.some((l) => l.e.lz);
    const lines = [`-- ${cart}: ${lay.length} entries, packed by the PICO-8 Dev Suite`];
    for (const { e, off, size } of lay) {
      const n = safeName(e.label);
      lines.push(e.lz
        ? `-- ${n}: ${e.bytes.length} bytes, LZ-packed to ${size}; tmp = ${size} free bytes that do not overlap dest\nreload(tmp,${hex4(off)},${hex4(size)},"${cart}") unlz(tmp,dest)`
        : `-- ${n}: ${size} bytes\nreload(dest,${hex4(off)},${hex4(size)},"${cart}")`);
    }
    if (anyLz) lines.push('', '-- needed once for LZ entries (60 tokens)', C.LZ_LUA);
    return lines.join('\n');
  }

  /** Layout manifest stored as comments in the data cart's own __lua__ (reload() never reads code, so it costs nothing). */
  function manifest() {
    return ['-- data cart: pico8 dev suite pack v1', ...layout().map(({ e, off, size }) => `-- ${hex4(off)} ${hex4(size)} ${e.lz ? 'lz' : 'raw'} ${e.bytes.length} ${safeName(e.label)}`)].join('\n');
  }

  function addPack(label, bytes, src) {
    if (!bytes.length) return;
    dc.pack.push({ label, bytes: Uint8Array.from(bytes), lz: false, src });
    renderPack();
    toast(`Added ${label} (${bytes.length} bytes) to the pack.`);
  }

  async function addLibraryImage() {
    const a = await S.pickAsset({ title: 'Image to pack (4 bits per pixel, PICO-8 memory layout)' });
    if (!a) return;
    const w = a.w + (a.w & 1);
    const out = new Uint8Array((w >> 1) * a.h);
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x += 2) {
        const lo = a.pixels[y * a.w + x] & 15;
        const hi = x + 1 < a.w ? a.pixels[y * a.w + x + 1] & 15 : 0;
        out[y * (w >> 1) + (x >> 1)] = lo | (hi << 4);
      }
    }
    addPack(a.name, out, `image ${a.w}×${a.h}`);
  }

  async function addFile() {
    const f = await pickFile('');
    if (!f) return;
    addPack(f.name.replace(/\.[^.]*$/, ''), new Uint8Array(await f.arrayBuffer()), `file ${f.name}`);
  }

  /** Reads what PICO-8 will see from the written cart and compares it with the layout. */
  function verifyPack(text) {
    const back = C.parseP8(text).rom;
    for (const { e, off, size } of layout()) {
      const got = back.subarray(off, off + size);
      const want = stored(e);
      if (got.some((v, i) => v !== want[i])) return `${e.label} differs after writing`;
      if (e.lz) {
        const d = C.lzDecode(back, off).data;
        if (d.length !== e.bytes.length || d.some((v, i) => v !== e.bytes[i])) return `${e.label} does not unpack correctly`;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ //
  // Rendering + binding                                                //
  // ------------------------------------------------------------------ //

  function renderAll() {
    dom.root.textContent = dc.root || '';
    dom.status.textContent = dc.carts.size ? `${dc.carts.size} carts · ${[...dc.carts.values()].filter((c) => c.isData).length} data carts` : '';
    for (const b of dom.modeSeg.querySelectorAll('[data-value]')) b.setAttribute('aria-checked', String(b.dataset.value === dc.mode));
    dom.inspect.hidden = dc.mode !== 'inspect';
    dom.pack.hidden = dc.mode !== 'pack';
    renderList();
    renderInspect();
    renderPack();
  }

  const parseHex = (s) => C.parseNum(s.startsWith('0x') || /^\d+$/.test(s) ? s : `0x${s}`);

  function bind() {
    // the picker belongs to Project Audit and gives no cancel signal: following resumes only when its scan
    // arrives while Data Carts is still open, so a cancelled picker changes nothing
    dom.open.addEventListener('click', () => { dc.followRequested = true; window.P8Project?.choose(); });
    dom.files.addEventListener('click', openFiles);
    dom.only.addEventListener('change', () => { dc.onlyData = dom.only.checked; renderList(); });
    dom.modeSeg.addEventListener('click', (e) => { const b = e.target.closest('[data-value]'); if (b) { dc.mode = b.dataset.value; renderAll(); } });
    dom.list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-name]');
      if (!b) return;
      dc.sel = b.dataset.name;
      renderList();
      renderInspect();
    });
    // map: click = the section there, drag = any range (whole 128-byte rows)
    const mapAddr = (e) => {
      const r = dom.map.getBoundingClientRect();
      const row = Math.max(0, Math.min(dom.map.height - 1, Math.floor(((e.clientY - r.top) / r.height) * dom.map.height)));
      const col = Math.max(0, Math.min(CELL - 1, Math.floor(((e.clientX - r.left) / r.width) * CELL)));
      return { row, a: row * CELL + col };
    };
    const secAt = (a) => dc.secs.filter((x) => a >= x.start && a < x.start + x.len).sort((x, y) => x.len - y.len)[0];
    let drag = null;
    dom.map.addEventListener('pointerdown', (e) => {
      if (!cur()) return;
      drag = { row: mapAddr(e).row, moved: false };
      try { dom.map.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    });
    dom.map.addEventListener('pointermove', (e) => {
      const { row, a } = mapAddr(e);
      if (!drag) {
        const s = cur() && secAt(a);
        dom.map.title = a < ROM ? `${hex4(a)} · ${regionOf(a).name}${s ? ` · ${s.label}` : ''}` : '';
        return;
      }
      if (row === drag.row && !drag.moved) return;
      drag.moved = true;
      const r0 = Math.min(row, drag.row);
      const r1 = Math.max(row, drag.row) + 1;
      setRange(r0 * CELL, Math.min(ROM, r1 * CELL) - r0 * CELL);
    });
    dom.map.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const { moved } = drag;
      drag = null;
      if (moved) return;
      const { a } = mapAddr(e);
      const s = secAt(a);
      if (s) selectSection(s.id);
      else { const reg = regionOf(a); setRange(reg.start, Math.min(ROM, reg.end) - reg.start); }
    });
    dom.secList.addEventListener('click', (e) => {
      const b = e.target.closest('[data-id]');
      if (!b) return;
      if (b.dataset.id) selectSection(b.dataset.id); else { dc.secId = null; renderSections(); }
    });
    dom.fadeSel.addEventListener('change', () => {
      const f = dc.palInfo?.fades.find((x) => x.key === dom.fadeSel.value);
      dc.fade = f ? { ...f } : null;
      saveSecView();
      renderViewer();
    });
    dom.rowIn.addEventListener('input', () => {
      if (!dc.fade) return;
      dc.fade.row = Math.max(0, Math.min(dc.fade.rows - 1, Number(dom.rowIn.value) | 0));
      saveSecView();
      renderViewer();
    });
    dom.palSel.addEventListener('change', () => choosePal(dom.palSel.value));
    dom.swatches.addEventListener('click', (e) => { const b = e.target.closest('[data-slot]'); if (b) editSlot(Number(b.dataset.slot)); });
    dom.palLua.addEventListener('change', () => {
      const p = V.parseLuaPal(dom.palLua.value);
      if (p) setPal('custom', p); else { toast('Not a palette: use {[0]=0,129,…} or 16 numbers (0–15, 128–143).'); renderPal(); }
    });
    dom.vStart.addEventListener('change', () => { const v = parseHex(dom.vStart.value.trim()); if (v != null) setRange(v, dc.view.len); else renderViewer(); });
    dom.vLen.addEventListener('change', () => { const v = parseHex(dom.vLen.value.trim()); if (v != null) setRange(dc.view.start, v); else renderViewer(); });
    dom.vAs.addEventListener('change', () => { dc.view.as = dom.vAs.value; saveSecView(); renderViewer(); });
    dom.vWidth.addEventListener('change', () => { dc.view.width = Number(dom.vWidth.value); saveSecView(); renderViewer(); });
    dom.toLib.addEventListener('click', viewToLibrary);
    dom.toLayers.addEventListener('click', layersToStudio);
    dom.dlBin.addEventListener('click', () => { const c = cur(); if (c) download(new Blob([viewBytes()]), `${c.name.replace(/\.p8$/i, '')}_${hex4(dc.view.start)}.bin`); });
    dom.addPack.addEventListener('click', () => { const c = cur(); if (c) addPack(`${c.name.replace(/\.p8$/i, '')}_${hex4(dc.view.start).slice(2)}`, viewBytes(), `${c.name} ${hex4(dc.view.start)}`); });

    dom.packNameIn.addEventListener('change', () => { dc.packName = (dom.packNameIn.value.trim() || 'pack').replace(/(\.p8)?$/i, '.p8'); dom.packNameIn.value = dc.packName; });
    dom.packList.addEventListener('change', (e) => {
      const t = e.target;
      const i = Number(t.dataset.i);
      if (t.dataset.k === 'lz') { dc.pack[i].lz = t.checked; renderPack(); }
      if (t.dataset.k === 'label') dc.pack[i].label = t.value.trim() || dc.pack[i].label;
    });
    dom.packList.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const i = Number(b.dataset.i);
      const p = dc.pack;
      if (b.dataset.act === 'del') p.splice(i, 1);
      if (b.dataset.act === 'up' && i > 0) [p[i - 1], p[i]] = [p[i], p[i - 1]];
      if (b.dataset.act === 'down' && i < p.length - 1) [p[i + 1], p[i]] = [p[i], p[i + 1]];
      renderPack();
    });
    dom.packAddLib.addEventListener('click', addLibraryImage);
    dom.packAddFile.addEventListener('click', addFile);
    dom.packDl.addEventListener('click', () => {
      const text = C.writeP8({ rom: packRom(), lua: manifest() });
      const err = verifyPack(text);
      if (err) { showMessage('Pack', `The written cart failed its check: ${err}. Nothing was saved.`); return; }
      download(text, dc.packName);
      toast(`${dc.packName} written and checked.`);
    });
    dom.packLua.addEventListener('click', async () => {
      const code = packLua();
      const ta = el('textarea', { className: 'code-out', readOnly: true, spellcheck: false, value: code, rows: 14 });
      await modal({
        title: `reload() lines for ${dc.packName}`, wide: true,
        body: el('div', { className: 'dialog-form' }, el('p', { className: 'muted', textContent: 'Replace “dest” with the address each entry goes to (and “tmp” with free scratch memory for LZ entries). Raw entries cost nothing beyond the reload(); LZ entries need unlz() once.' }), ta),
        actions: [{ label: 'Copy', onClick: async () => { try { await navigator.clipboard.writeText(code); toast('Copied.'); } catch { ta.select(); } } }],
        buttons: [{ label: 'Close', primary: true, value: true }],
      });
    });

    document.addEventListener('p8:project', () => {
      // the folder arrives a moment later (analyse() fills it); load on the next tick
      setTimeout(() => {
        const P = window.P8Project;
        if (!P?.files) return;
        if (dc.followRequested && document.body.dataset.workspace === 'datacarts') dc.followProject = true;
        dc.followRequested = false;
        if (!dc.followProject) {
          // carts the user opened here stay; say how to switch instead of replacing them (#56)
          dom.status.textContent = `Project Audit scanned “${P.root}”. Your opened files stay here; use Open Project Folder… to show that project instead.`;
          return;
        }
        loadProject(P.files, P.root);
        projectLink?.setMode(P.adopted ? 'adopted' : 'independent', P.root);
      }, 0);
    });
    document.addEventListener('p8:workspace', () => {
      if (document.body.dataset.workspace !== 'datacarts') { dc.followRequested = false; return; }
      const P = window.P8Project;
      if (P?.files && !dc.carts.size && dc.followProject) loadProject(P.files, P.root);
    });
  }

  // #56: Data Carts shows what Project Audit scanned; adopting the active project scans it there.
  // The pack list (bytes you collected) is kept: only the cart list is replaced, as with any rescan.
  let projectLink = null;
  if (window.P8ProjectAdapter) {
    projectLink = window.P8ProjectAdapter.mount(document.querySelector('main[data-ws="datacarts"] .dc-top'), {
      tool: 'Data Carts',
      // adopting here scans the folder in Project Audit (Data Carts reads it from there), and says so
      adopt: async (h) => {
        if (!window.P8Project?.use) return false;
        dc.followRequested = true;
        const ok = await window.P8Project.use(h);
        if (!ok) dc.followRequested = false;
        if (ok) toast(`Data Carts and Project Audit now show “${h.name}” (Data Carts reads the project folder through Project Audit).`, 'info', 4200);
        return ok;
      },
    });
  }

  S.registerTool({ ws: 'datacarts', category: 'inspect', name: 'Data Carts', desc: 'See what every data cart holds and which ranges the code reloads; pack new data carts and get the reload() lines.', tasks: [{ group: 'analyze', label: 'Inspect data carts', hint: 'What each cart holds and what reload() reads' }], color: '#ffa300', tags: ['reload', 'memory map', 'pack'] });

  bind();
  renderAll();
})();

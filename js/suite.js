// js/suite.js
// PICO-8 Dev Suite hub: shared asset library, tool registry, "Open in…" routing,
// asset picker, library drawer, backups and the Home workspace.
//
// Every tool talks to the others through window.Suite:
//   Suite.assets.put(asset) / get(id) / list(kind) / remove(id)   shared library (IndexedDB)
//   Suite.registerConsumer({...})                                   "Open in <tool>" entries
//   Suite.pickAsset({...})                                          library picker dialog
//   document 'p8:assets' event                                      library changed (also from other tabs)

'use strict';

(() => {
  const App = window.P8App;
  const { rgbOf, isValidPico, quantize, encodeIndexedPng } = P8;
  const { el, $, modal, showMessage, confirmDialog, toast, download, pickFile, decodeImage, formField, sanitizeFilename, store } = App;

  const DB_NAME = 'p8suite';
  const DB_STORE = 'assets';
  const KV_STORE = 'kv';
  const STD_PAL = Array.from({ length: 16 }, (_, i) => i);
  const MAX_IMAGE_SIDE = 1024;

  // ------------------------------------------------------------------ //
  // Asset model                                                        //
  // ------------------------------------------------------------------ //
  //
  // image:   { id, kind:'image', name, w, h, pixels:Uint8Array (slot 0..15 per pixel),
  //            pal:[16 pico colors, slot -> screen color], transparent:slot|-1,
  //            doc?: Pixel Studio document (layers/frames), source, created, modified }
  // palette: { id, kind:'palette', name, colors:[16 pico|null], source, created, modified }
  // map:     { id, kind:'map', name, w, h, cells:Uint8Array (tile per cell), sheet:Uint8Array
  //            (128-wide tileset, slot per pixel), pal, sheetId?, sheetName?, source, ... } (js/map.js)

  const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const normPal = (pal) => Array.from({ length: 16 }, (_, i) => (isValidPico(pal?.[i]) ? pal[i] : i));

  function imageAsset({ name = 'image', w, h, pixels, pal = STD_PAL, transparent = 0, source = 'import', doc = null, meta = null }) {
    return { kind: 'image', name, w, h, pixels, pal: normPal(pal), transparent, source, doc, meta };
  }

  function paletteAsset({ name = 'palette', colors, source = 'palette' }) {
    return { kind: 'palette', name, colors: Array.from({ length: 16 }, (_, i) => (isValidPico(colors?.[i]) ? colors[i] : null)), source };
  }

  const paletteRgb = (pal) => normPal(pal).map(rgbOf);

  function assetImageData(a, { transparent = false } = {}) {
    const out = new ImageData(a.w, a.h);
    const rgb = paletteRgb(a.pal);
    const d = out.data;
    for (let i = 0, o = 0; i < a.pixels.length; i++, o += 4) {
      const s = a.pixels[i] & 15;
      const c = rgb[s];
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2];
      d[o + 3] = transparent && s === a.transparent ? 0 : 255;
    }
    return out;
  }

  function assetCanvas(a, opts) {
    const c = document.createElement('canvas');
    c.width = a.w;
    c.height = a.h;
    c.getContext('2d').putImageData(assetImageData(a, opts), 0, 0);
    return c;
  }

  /** Thumbnail canvas (integer scaled, letterboxed) for library lists. */
  function thumbnail(a, size = 64) {
    const c = el('canvas', { className: 'thumb' });
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d');
    if (a.kind === 'palette') {
      const cell = size / 4;
      a.colors.forEach((p, i) => {
        const rgb = rgbOf(p) || [24, 24, 28];
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.fillRect((i % 4) * cell, Math.floor(i / 4) * cell, cell, cell);
      });
      return c;
    }
    const src = a.kind === 'map' ? mapCanvas(a) : assetCanvas(a, { transparent: true });
    const scale = Math.min(size / a.w, size / a.h);
    const s = scale >= 1 ? Math.floor(scale) : scale;
    const w = Math.max(1, Math.round(a.w * s));
    const h = Math.max(1, Math.round(a.h * s));
    ctx.imageSmoothingEnabled = scale < 1;
    ctx.drawImage(src, Math.floor((size - w) / 2), Math.floor((size - h) / 2), w, h);
    return c;
  }

  /** Map asset at one pixel per cell: the color in the middle of each cell's tile. */
  function mapCanvas(a) {
    const out = new ImageData(a.w, a.h);
    const rgb = paletteRgb(a.pal);
    const rows = a.sheet ? a.sheet.length / 128 : 0;
    for (let i = 0; i < a.cells.length; i++) {
      const v = a.cells[i];
      const y = (v >> 4) * 8 + 4;
      const c = v && y < rows ? rgb[a.sheet[y * 128 + (v & 15) * 8 + 4] & 15] : [0, 0, 0];
      out.data.set([c[0], c[1], c[2], 255], i * 4);
    }
    const c = document.createElement('canvas');
    c.width = a.w;
    c.height = a.h;
    c.getContext('2d').putImageData(out, 0, 0);
    return c;
  }

  /** Any RGBA image -> image asset, quantized to the given screen palette (nearest color). */
  function assetFromImageData(imageData, name, pal = STD_PAL) {
    const p = normPal(pal);
    const pixels = quantize(imageData, p.map(rgbOf));
    // Fully transparent pixels become slot 0 (PICO-8's default transparent color)
    const d = imageData.data;
    for (let i = 0; i < pixels.length; i++) if (d[i * 4 + 3] < 128) pixels[i] = 0;
    return imageAsset({ name, w: imageData.width, h: imageData.height, pixels, pal: p, source: 'import' });
  }

  async function imageAssetToPng(a) {
    return encodeIndexedPng(a.w, a.h, a.pixels, paletteRgb(a.pal), a.transparent);
  }

  // ------------------------------------------------------------------ //
  // Storage (IndexedDB, falls back to memory)                          //
  // ------------------------------------------------------------------ //

  const cache = new Map();
  let db = null;
  let channel = null;

  function openDb() {
    return new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, 1);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(DB_STORE)) d.createObjectStore(DB_STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(KV_STORE)) d.createObjectStore(KV_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }

  function tx(mode, fn, storeName = DB_STORE) {
    if (!db) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        t.oncomplete = () => resolve(req?.result ?? null);
        t.onerror = () => resolve(null);
        t.onabort = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  function emitAssets(type, id, remote = false) {
    document.dispatchEvent(new CustomEvent('p8:assets', { detail: { type, id, remote } }));
    if (!remote) {
      try { channel?.postMessage({ type, id }); } catch { /* ignore */ }
    }
  }

  const assets = {
    ready: null,
    list(kind = null) {
      return [...cache.values()].filter((a) => !kind || a.kind === kind).sort((a, b) => b.modified - a.modified);
    },
    get: (id) => cache.get(id) || null,
    /** Inserts or updates (keeps id when present). Returns the stored asset. */
    async put(asset) {
      const now = Date.now();
      const a = { ...asset, id: asset.id || uid(), created: asset.created || now, modified: now };
      cache.set(a.id, a);
      await tx('readwrite', (s) => s.put(a));
      emitAssets('put', a.id);
      return a;
    },
    async remove(id) {
      cache.delete(id);
      await tx('readwrite', (s) => s.delete(id));
      emitAssets('remove', id);
    },
    async rename(id, name) {
      const a = cache.get(id);
      if (a) return assets.put({ ...a, name });
      return null;
    },
    persistent: () => !!db,
  };

  /** Small key/value store for tool sessions (too large for localStorage). */
  const memKv = new Map();
  const kv = {
    async get(key) {
      await assets.ready;
      return db ? tx('readonly', (s) => s.get(key), KV_STORE) : memKv.get(key) ?? null;
    },
    async set(key, value) {
      await assets.ready;
      if (db) await tx('readwrite', (s) => s.put(value, key), KV_STORE);
      else memKv.set(key, value);
    },
  };

  async function loadAll() {
    db = await openDb();
    const all = (await tx('readonly', (s) => s.getAll())) || [];
    for (const a of all) cache.set(a.id, a);
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('p8suite-assets');
      channel.onmessage = async ({ data }) => {
        if (data.type === 'remove') cache.delete(data.id);
        else {
          const a = await tx('readonly', (s) => s.get(data.id));
          if (a) cache.set(a.id, a);
        }
        emitAssets(data.type, data.id, true);
      };
    }
    emitAssets('load', null, true);
  }

  // ------------------------------------------------------------------ //
  // Backup (JSON with base64 typed arrays)                             //
  // ------------------------------------------------------------------ //

  const bytesToB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const toJson = (value) => JSON.stringify(value, (k, v) => (v instanceof Uint8Array ? { __u8: bytesToB64(v) } : v));
  const fromJson = (text) => JSON.parse(text, (k, v) => (v && typeof v === 'object' && typeof v.__u8 === 'string' ? b64ToBytes(v.__u8) : v));

  async function exportBackup() {
    const list = assets.list();
    if (!list.length) { showMessage('Export Library', 'The library is empty.'); return; }
    const data = { format: 'p8suite-library', version: 1, exported: new Date().toISOString(), assets: list };
    download(toJson(data), `p8suite_library_${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    toast(`Exported ${list.length} asset(s)`);
  }

  async function importBackup() {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    let data;
    try {
      data = fromJson(await file.text());
    } catch {
      showMessage('Import Library', 'The file is not a valid library backup.');
      return;
    }
    if (data?.format !== 'p8suite-library' || !Array.isArray(data.assets)) {
      showMessage('Import Library', 'The file is not a PICO-8 Dev Suite library backup.');
      return;
    }
    let n = 0;
    for (const a of data.assets) {
      if (!a || !['image', 'palette', 'map'].includes(a.kind)) continue;
      if (a.kind === 'image' && !(a.pixels instanceof Uint8Array && a.pixels.length === a.w * a.h)) continue;
      if (a.kind === 'map' && !(a.cells instanceof Uint8Array && a.cells.length === a.w * a.h)) continue;
      const existing = cache.get(a.id);
      await assets.put({ ...a, id: existing ? uid() : a.id });
      n++;
    }
    toast(`Imported ${n} asset(s)`);
  }

  // ------------------------------------------------------------------ //
  // Consumers ("Open in <tool>")                                       //
  // ------------------------------------------------------------------ //

  const consumers = [];

  /**
   * Live palettes the tools offer each other (what is open right now, not a library copy):
   * { id, label, get() -> { pal: [16 PICO-8 colors], fades: {dark, bright} | null, name } | null }
   * Palette & Fades registers its custom palette and fades below, Pixel Studio its open image.
   */
  const paletteSources = [];
  const registerPaletteSource = (s) => { paletteSources.push(s); };
  const paletteSource = (id) => { const s = paletteSources.find((x) => x.id === id); try { return s ? s.get() : null; } catch { return null; } };

  /**
   * { id, label, kinds:['image'|'palette'], accepts?(asset) -> true | 'reason why not', open(asset) }
   */
  function registerConsumer(c) {
    consumers.push(c);
  }

  function consumersFor(a) {
    return consumers
      .filter((c) => c.kinds.includes(a.kind))
      .map((c) => ({ c, ok: c.accepts ? c.accepts(a) : true }));
  }

  async function openIn(consumerId, a) {
    const c = consumers.find((x) => x.id === consumerId);
    if (!c) return;
    const ok = c.accepts ? c.accepts(a) : true;
    if (ok !== true) { showMessage(c.label, ok); return; }
    closeLibrary();
    await c.open(a);
  }

  // ------------------------------------------------------------------ //
  // Picker dialog                                                      //
  // ------------------------------------------------------------------ //

  const sizeText = (a) => (a.kind === 'image' ? `${a.w}×${a.h}` : a.kind === 'map' ? `${a.w}×${a.h} map` : '16 colors');
  const KIND_PLURAL = { image: 'images', palette: 'palettes', map: 'maps' };

  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const SOURCE_NAMES = { studio: 'Pixel Studio', tiles: 'Tile Maker', palette: 'Palette & Fades', map: 'Map Editor', import: 'Imported', nibble: 'Nibble Split', cart: 'Cart' };

  function assetCard(a, { compact = false } = {}) {
    return el('button', { type: 'button', className: `asset-card${compact ? ' compact' : ''}`, dataset: { id: a.id }, title: a.name },
      thumbnail(a, compact ? 48 : 72),
      el('span', { className: 'asset-name', textContent: a.name }),
      el('span', { className: 'asset-meta', textContent: `${sizeText(a)} · ${SOURCE_NAMES[a.source] || a.source || ''}` }));
  }

  /**
   * Opens the library picker. filter(asset) -> true | 'reason' (disabled with tooltip).
   * Returns the chosen asset or null.
   */
  async function pickAsset({ title = 'Choose from Library', kind = 'image', filter = null, allowImport = true } = {}) {
    let chosen = null;
    const grid = el('div', { className: 'asset-grid' });
    const search = el('input', { type: 'search', placeholder: 'Filter by name…', className: 'asset-search', spellcheck: false });

    const render = () => {
      grid.replaceChildren();
      const q = search.value.trim().toLowerCase();
      const list = assets.list(kind).filter((a) => !q || a.name.toLowerCase().includes(q));
      if (!list.length) {
        grid.append(el('p', { className: 'muted asset-empty', textContent: assets.list(kind).length ? 'No match.' : `No ${KIND_PLURAL[kind] || 'assets'} in the library yet.` }));
        return;
      }
      for (const a of list) {
        const card = assetCard(a);
        const ok = filter ? filter(a) : true;
        if (ok !== true) {
          card.disabled = true;
          card.title = `${a.name}\n${ok}`;
        }
        grid.append(card);
      }
    };
    search.addEventListener('input', render);

    const body = el('div', { className: 'picker' }, search, grid);
    const onAssets = () => render();
    document.addEventListener('p8:assets', onAssets);
    render();

    const actions = [];
    if (allowImport && kind === 'image') {
      actions.push({
        label: 'Import image file…',
        onClick: async () => {
          const added = await importImageFiles();
          if (added.length) render();
        },
      });
    }
    try {
      await modal({
        title,
        body,
        wide: true,
        actions,
        buttons: [{ label: 'Cancel', value: null }],
        onOpen: (dlg) => {
          grid.addEventListener('click', (e) => {
            const card = e.target.closest('.asset-card');
            if (!card || card.disabled) return;
            chosen = assets.get(card.dataset.id);
            dlg.finish(chosen);
          });
          search.focus();
        },
      });
    } finally {
      document.removeEventListener('p8:assets', onAssets);
    }
    return chosen;
  }

  /** File picker -> image assets (quantized to the standard palette). */
  async function importImageFiles(files = null) {
    if (!files) {
      const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/bmp,image/gif,.png,.jpg,.jpeg,.bmp,.gif', multiple: true });
      files = await new Promise((resolve) => {
        input.addEventListener('change', () => resolve([...input.files]), { once: true });
        input.addEventListener('cancel', () => resolve([]), { once: true });
        input.click();
      });
    }
    const added = [];
    for (const file of files) {
      try {
        const data = await decodeImage(file);
        if (data.width > MAX_IMAGE_SIDE || data.height > MAX_IMAGE_SIDE) {
          toast(`${file.name}: larger than ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE}, skipped`, 'warn');
          continue;
        }
        added.push(await assets.put(assetFromImageData(data, file.name.replace(/\.[^.]+$/, ''))));
      } catch {
        toast(`${file.name}: could not decode`, 'error');
      }
    }
    if (added.length) toast(`Added ${added.length} image(s) to the library (nearest PICO-8 colors)`);
    return added;
  }

  // ------------------------------------------------------------------ //
  // Asset details dialog                                               //
  // ------------------------------------------------------------------ //

  async function showAsset(a) {
    const big = thumbnail(a, 192);
    big.classList.add('thumb-big');
    const nameInput = el('input', { type: 'text', value: a.name, spellcheck: false });
    const info = el('p', { className: 'muted', textContent: `${sizeText(a)} · ${SOURCE_NAMES[a.source] || a.source || ''} · modified ${ago(a.modified)}` });
    if (a.kind === 'image' && a.doc) info.textContent += ` · ${a.doc.layers.length} layer(s), ${a.doc.frames.length} frame(s)`;

    const openRow = el('div', { className: 'asset-open' });
    for (const { c, ok } of consumersFor(a)) {
      const b = el('button', { type: 'button', className: 'btn', textContent: c.label });
      if (ok !== true) { b.disabled = true; b.title = ok; }
      b.addEventListener('click', () => {
        rename();
        dlgRef?.finish(true);
        openIn(c.id, assets.get(a.id) || a);
      });
      openRow.append(b);
    }
    let dlgRef = null;

    const body = el('div', { className: 'asset-detail' },
      big,
      el('div', { className: 'asset-detail-side' },
        formField('Name', nameInput),
        info,
        el('h3', { textContent: 'Open in' }),
        openRow));

    let deleted = false;
    const rename = () => {
      const n = nameInput.value.trim();
      if (!deleted && n && n !== a.name && assets.get(a.id)) { a.name = n; assets.rename(a.id, n); }
    };

    await modal({
      title: { palette: 'Palette', map: 'Map' }[a.kind] || 'Image',
      body,
      wide: true,
      onOpen: (dlg) => { dlgRef = dlg; },
      actions: [
        ...(a.kind === 'image' ? [{ label: 'Download PNG', onClick: async () => download(await imageAssetToPng(a), `${sanitizeFilename(a.name)}.png`) }] : []),
        {
          label: 'Duplicate',
          onClick: async (dlg) => {
            const { id, created, ...rest } = assets.get(a.id) || a;
            await assets.put({ ...rest, name: `${rest.name} copy` });
            toast('Duplicated');
            dlg.finish(true);
          },
        },
        {
          label: 'Delete',
          onClick: async (dlg) => {
            if (await confirmDialog('Delete Asset', `Delete "${a.name}" from the library?\n\nThis cannot be undone.`, 'Delete')) {
              deleted = true;
              await assets.remove(a.id);
              dlg.finish(true);
            }
          },
        },
      ],
      buttons: [{ label: 'Close', value: true, primary: true }],
    });
    rename();
  }

  // ------------------------------------------------------------------ //
  // Library drawer                                                     //
  // ------------------------------------------------------------------ //

  const drawer = {
    root: $('#library'),
    list: $('#libraryList'),
    count: $('#libraryCount'),
    kind: 'all',
    search: $('#librarySearch'),
  };

  function renderLibrary() {
    const total = assets.list().length;
    drawer.count.textContent = total ? String(total) : '';
    if (drawer.root.hidden) return;
    const q = drawer.search.value.trim().toLowerCase();
    const list = assets.list(drawer.kind === 'all' ? null : drawer.kind).filter((a) => !q || a.name.toLowerCase().includes(q));
    drawer.list.replaceChildren();
    if (!list.length) {
      drawer.list.append(el('div', { className: 'asset-empty muted' },
        el('p', { textContent: total ? 'No match.' : 'The library is empty.' }),
        el('p', { textContent: 'Save from Pixel Studio, the Map Editor or Palette & Fades, send results from the Tile Maker, or import image files.' })));
    }
    for (const a of list) {
      const card = assetCard(a, { compact: true });
      card.draggable = true;
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-p8asset', a.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      const del = el('button', { type: 'button', className: 'asset-del', title: `Delete "${a.name}"`, attrs: { 'aria-label': `Delete ${a.name}` }, dataset: { del: a.id } });
      del.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10M9 9v4M11 9v4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      drawer.list.append(el('div', { className: 'asset-item' }, card, del));
    }
    if (!assets.persistent()) {
      drawer.list.append(el('p', { className: 'hint', textContent: 'Browser storage is unavailable: the library only lives until this page is closed. Use Export to keep it.' }));
    }
  }

  function openLibrary() {
    drawer.root.hidden = false;
    $('#libraryBtn').setAttribute('aria-pressed', 'true');
    renderLibrary();
  }

  function closeLibrary() {
    drawer.root.hidden = true;
    $('#libraryBtn').setAttribute('aria-pressed', 'false');
  }

  function bindLibrary() {
    $('#libraryBtn').addEventListener('click', () => (drawer.root.hidden ? openLibrary() : closeLibrary()));
    $('#libraryClose').addEventListener('click', closeLibrary);
    drawer.search.addEventListener('input', renderLibrary);
    $('#libraryKind').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-value]');
      if (!b) return;
      drawer.kind = b.dataset.value;
      for (const x of $('#libraryKind').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b));
      renderLibrary();
    });
    drawer.list.addEventListener('click', async (e) => {
      const del = e.target.closest('.asset-del');
      if (del) {
        const a = assets.get(del.dataset.del);
        if (a && await confirmDialog('Delete Asset', `Delete "${a.name}" from the library?

This cannot be undone.`, 'Delete')) {
          await assets.remove(a.id);
          toast(`Deleted "${a.name}"`);
        }
        return;
      }
      const card = e.target.closest('.asset-card');
      const a = card && assets.get(card.dataset.id);
      if (a) showAsset(a);
    });
    $('#libraryImport').addEventListener('click', () => importImageFiles());
    $('#libraryExport').addEventListener('click', exportBackup);
    $('#libraryRestore').addEventListener('click', importBackup);
    // Drop image files onto the drawer to import them
    drawer.root.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); drawer.root.classList.add('dragover'); }
    });
    drawer.root.addEventListener('dragleave', () => drawer.root.classList.remove('dragover'));
    drawer.root.addEventListener('drop', (e) => {
      drawer.root.classList.remove('dragover');
      const files = [...(e.dataTransfer?.files || [])];
      if (!files.length) return;
      e.preventDefault();
      importImageFiles(files);
    });
    document.addEventListener('p8:assets', () => { renderLibrary(); renderHome(); });
  }

  /** Lets an element accept library assets dragged from the drawer. */
  function bindAssetDrop(node, onAsset) {
    node.addEventListener('dragover', (e) => {
      if ([...(e.dataTransfer?.types || [])].includes('application/x-p8asset')) {
        e.preventDefault();
        node.classList.add('dragover');
      }
    });
    node.addEventListener('dragleave', () => node.classList.remove('dragover'));
    node.addEventListener('drop', (e) => {
      const id = e.dataTransfer?.getData('application/x-p8asset');
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      node.classList.remove('dragover');
      const a = assets.get(id);
      if (a) onAsset(a);
    });
  }

  // ------------------------------------------------------------------ //
  // Tool registry + Home workspace                                     //
  // ------------------------------------------------------------------ //

  const tools = [];

  /** { ws, name, desc, color, tags:[] } — shown as a card on the Home page. */
  function registerTool(t) {
    tools.push(t);
    renderHome();
  }

  // Desktop tools in this repository that are not part of the web suite.
  const DESKTOP_TOOLS = [
    { name: 'Filename Optimizer', dir: 'filename_optimizer', desc: 'Batch-renames carts and updates code references (writes files, so it stays a desktop tool).' },
  ];

  function renderHome() {
    const grid = $('#homeTools');
    if (!grid) return;
    grid.replaceChildren(...tools.map((t) => el('button', { type: 'button', className: 'tool-card', dataset: { ws: t.ws }, style: `--tool:${t.color}` },
      el('span', { className: 'tool-dot', attrs: { 'aria-hidden': 'true' } }),
      el('strong', { textContent: t.name }),
      el('span', { className: 'tool-desc', textContent: t.desc }),
      el('span', { className: 'tool-tags' }, ...(t.tags || []).map((x) => el('span', { className: 'badge', textContent: x }))))));

    const recent = $('#homeRecent');
    const list = assets.list().slice(0, 12);
    recent.replaceChildren(...(list.length
      ? list.map((a) => assetCard(a))
      : [el('p', { className: 'muted asset-empty', textContent: 'Nothing yet. Everything you save to the library shows up here and in every tool.' })]));

    $('#homeDesktop').replaceChildren(...DESKTOP_TOOLS.map((t) => el('li', {},
      el('strong', { textContent: t.name }), ' ', el('code', { textContent: `${t.dir}/` }), el('span', { className: 'muted', textContent: ` · ${t.desc}` }))));
  }

  function bindHome() {
    $('#homeTools').addEventListener('click', (e) => {
      const card = e.target.closest('.tool-card');
      if (card) App.setWorkspace(card.dataset.ws);
    });
    $('#homeRecent').addEventListener('click', (e) => {
      const card = e.target.closest('.asset-card');
      const a = card && assets.get(card.dataset.id);
      if (a) showAsset(a);
    });
    $('#homeImport').addEventListener('click', () => importImageFiles());
    $('#homeLibrary').addEventListener('click', openLibrary);
  }

  // ------------------------------------------------------------------ //
  // Palette & Fades integration                                        //
  // ------------------------------------------------------------------ //

  const PREVIEW_SIZES = new Set(['128x128', '128x256', '256x128']);
  /** the image's palette differs from the standard one (or it brings fades): tools should use it */
  const hasOwnPalette = (a) => a.kind === 'image' && (Boolean(a.meta?.fades) || normPal(a.pal).some((p, i) => p !== STD_PAL[i]));

  registerConsumer({
    id: 'palette-preview',
    label: 'Palette & Fades preview',
    kinds: ['image'],
    accepts: (a) => (PREVIEW_SIZES.has(`${a.w}x${a.h}`) ? true : 'The fade preview needs a 128×128, 128×256 or 256×128 image.'),
    open: (a) => {
      App.setWorkspace('palette');
      try {
        // an image with its own screen palette (data carts, Pixel Studio) sets the custom
        // palette, and the fade tables it brought along replace the generated fades
        const own = hasOwnPalette(a);
        if (own) App.adoptImagePalette(normPal(a.pal), a.meta?.fades || null);
        App.loadPreviewImageData(assetImageData(a), own ? a.pixels : null);
        toast(own ? `Preview: ${a.name}, with its palette${a.meta?.fades ? ` and fades (${a.meta.fades.from})` : ''}` : `Preview: ${a.name}`);
      } catch (e) {
        showMessage('Preview', e.message);
      }
    },
  });

  registerConsumer({
    id: 'palette-load',
    label: 'Palette & Fades',
    kinds: ['palette'],
    open: (a) => {
      App.setWorkspace('palette');
      App.setCustomPalette(a.colors);
      toast(`Loaded palette "${a.name}"`);
    },
  });

  registerPaletteSource({
    id: 'palette', label: 'Palette & Fades',
    get: () => {
      if (!App.state.custom.some((p) => p != null)) return null;
      const f = App.fadeSets();
      return { pal: normPal(App.state.custom), fades: f.dark || f.bright ? { dark: f.dark, bright: f.bright } : null, name: App.state.presetName || 'Palette & Fades' };
    },
  });

  async function savePaletteToLibrary() {
    const colors = App.state.custom;
    if (!colors.some((p) => p != null)) { showMessage('Save Palette', 'The custom palette is empty.'); return; }
    const input = el('input', { type: 'text', value: App.state.presetName || 'palette', spellcheck: false });
    const name = await modal({
      title: 'Save Palette to Library',
      body: el('div', { className: 'dialog-form' }, formField('Name', input)),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', primary: true, value: () => input.value.trim() || 'palette' }],
      onOpen: () => input.select(),
    });
    if (!name) return;
    await assets.put(paletteAsset({ name, colors }));
    toast(`Saved palette "${name}" to the library`);
  }

  async function paletteFromLibrary() {
    const a = await pickAsset({ title: 'Load Palette from Library', kind: 'palette', allowImport: false });
    if (a) openIn('palette-load', a);
  }

  async function previewFromLibrary() {
    const a = await pickAsset({
      title: 'Preview Image from Library',
      filter: (x) => (PREVIEW_SIZES.has(`${x.w}x${x.h}`) ? true : 'Needs 128×128, 128×256 or 256×128'),
    });
    if (a) openIn('palette-preview', a);
  }

  async function previewToLibrary() {
    const img = App.state.img;
    if (!img) { showMessage('Save Preview', 'Load a preview image first.'); return; }
    const pal = App.activePalette().map((p, i) => (p == null ? i : p));
    await assets.put(imageAsset({ name: 'preview', w: img.w, h: img.h, pixels: img.indices.slice(), pal, source: 'palette' }));
    toast('Saved the preview image (custom palette slots) to the library');
  }

  App.registerActions({
    'library-open': openLibrary,
    'library-import': () => importImageFiles(),
    'library-export': exportBackup,
    'library-restore': importBackup,
    'palette-to-library': savePaletteToLibrary,
    'palette-from-library': paletteFromLibrary,
    'preview-from-library': previewFromLibrary,
    'preview-to-library': previewToLibrary,
  });

  // ------------------------------------------------------------------ //
  // Public API                                                         //
  // ------------------------------------------------------------------ //

  window.Suite = {
    STD_PAL,
    MAX_IMAGE_SIDE,
    assets,
    kv,
    imageAsset,
    paletteAsset,
    paletteRgb,
    normPal,
    assetImageData,
    assetCanvas,
    assetFromImageData,
    imageAssetToPng,
    thumbnail,
    registerConsumer,
    registerPaletteSource,
    paletteSources: () => paletteSources.slice(),
    paletteSource,
    hasOwnPalette,
    consumersFor,
    openIn,
    pickAsset,
    showAsset,
    importImageFiles,
    bindAssetDrop,
    registerTool,
    openLibrary,
    closeLibrary,
    toJson,
    fromJson,
  };

  bindLibrary();
  bindHome();
  registerTool({ ws: 'palette', name: 'Palette & Fades', desc: '16-color custom palettes from all 32 PICO-8 colors, dark/bright fade tables, greyscale conversion.', color: '#ff004d', tags: ['palette', 'fades', 'Lua'] });
  registerTool({ ws: 'tiles', name: 'Tile Maker', desc: 'Packs images into 8×8 tiles + map, VRAM viewport heatmap, tile editor, .p8 carts.', color: '#00e436', tags: ['tiles', 'map', '.p8'] });
  assets.ready = loadAll();
})();

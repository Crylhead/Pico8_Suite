// js/suite.js
// PICO-8 Dev Suite hub: shared asset library, tool registry, "Open in…" routing,
// asset picker, library drawer, backups and the Home workspace.
//
// Every tool talks to the others through window.Suite:
//   Suite.assets.put(asset) / get(id) / list(kind) / remove(id)   shared library (IndexedDB;
//                                                                   writes reject on failure, see P8Storage)
//   Suite.kv.get(key) / set(key, value)                             tool sessions (same contract)
//   Suite.reportStorageError(title, err) / autosaveFailed(label)    standard failure messages
//   Suite.registerConsumer({...})                                   "Send to… / Open in…" destinations
//   Suite.destinationsFor(asset) / sendDialog(asset, {saved}) / openIn(id, asset, {saved})   (#57, js/transfer-core.js)
//   Suite.pickAsset({...})                                          library picker dialog
//   Suite.registerTool({ ws, name, desc, tags, category, tasks })     Home card, task shortcuts (#68), navigation (#53)
//   Suite.tools()                                                   registered tool metadata
//   document 'p8:assets' event                                      library changed (also from other tabs)

'use strict';

/**
 * Durable storage core (no DOM; tests/storage.test.js runs it in Node with a fake indexedDB).
 *
 * Outcome contract:
 * - Writes (assets.put/remove/rename, kv.set) resolve only after the IndexedDB transaction has
 *   committed ('complete'). Any failure (quota, DataCloneError, abort, closed connection or a
 *   synchronous throw) rejects with a StorageError { name: 'StorageError', op, reason, cause }
 *   where reason is 'quota' | 'clone' | 'abort' | 'closed' | 'error'. A rejected write changes
 *   neither the cache nor the stored record (IndexedDB rolls the transaction back) and emits no
 *   event, so the previous stored data stays readable and callers must keep their work dirty.
 * - Reads (kv.get, the startup load) reject the same way on failure rather than looking empty.
 * - Memory-only mode: when IndexedDB cannot be opened at startup, writes go to memory and resolve;
 *   mode() is 'memory' and persistent() is false, so the UI can label the session as temporary.
 *   A failed write while IndexedDB is open never falls back to memory.
 */
const P8Storage = (() => {
  const DB_NAME = 'p8suite';
  const DB_STORE = 'assets';
  const KV_STORE = 'kv';

  const REASONS = {
    quota: 'browser storage is full (quota exceeded)',
    clone: 'the data cannot be stored by the browser (DataCloneError)',
    abort: 'the browser aborted the storage transaction',
    closed: 'the browser storage connection is closed',
    error: 'browser storage reported an error',
  };

  function classify(e) {
    if (!e) return 'abort';
    switch (e.name) {
      case 'QuotaExceededError': case 'NS_ERROR_DOM_QUOTA_REACHED': return 'quota';
      case 'DataCloneError': return 'clone';
      case 'AbortError': return 'abort';
      case 'InvalidStateError': case 'TransactionInactiveError': return 'closed';
      default: return 'error';
    }
  }

  class StorageError extends Error {
    constructor(op, cause) {
      const reason = classify(cause);
      super(`${op} failed: ${REASONS[reason]}${cause?.message ? ` (${cause.message})` : ''}`);
      this.name = 'StorageError';
      this.op = op;
      this.reason = reason;
      this.cause = cause;
    }
  }

  /** IndexedDB connection, or null when it is unavailable (memory-only session). */
  function openDb(idb) {
    return new Promise((resolve) => {
      let req;
      try {
        req = idb.open(DB_NAME, 1);
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

  /** One transaction: resolves with the request result after 'complete', rejects otherwise. */
  function tx(db, op, storeName, mode, fn) {
    return new Promise((resolve, reject) => {
      let t = null;
      let done = false;
      const fail = (e) => { if (!done) { done = true; reject(e instanceof StorageError ? e : new StorageError(op, e)); } };
      try {
        t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        t.oncomplete = () => { if (!done) { done = true; resolve(req ? req.result : undefined); } };
        t.onerror = (ev) => fail(ev?.target?.error || t.error);
        t.onabort = () => fail(t.error);
      } catch (e) {
        try { t?.abort(); } catch { /* already finished */ }
        fail(e);
      }
    });
  }

  function createStore({ indexedDB = null, emit = () => {}, uid, now = () => Date.now() } = {}) {
    const cache = new Map();
    const memKv = new Map();
    let db = null;
    let mode = 'pending';
    let loadError = null;

    const ready = (async () => {
      db = indexedDB ? await openDb(indexedDB) : null;
      mode = db ? 'persistent' : 'memory';
      if (!db) return;
      try {
        for (const a of (await tx(db, 'Load Library', DB_STORE, 'readonly', (s) => s.getAll())) || []) cache.set(a.id, a);
      } catch (e) {
        loadError = e;
      }
    })();

    const assets = {
      ready,
      list(kind = null) {
        return [...cache.values()].filter((a) => !kind || a.kind === kind).sort((a, b) => b.modified - a.modified);
      },
      get: (id) => cache.get(id) || null,
      /** Inserts or updates (keeps id when present). Resolves with the committed asset; rejects with a StorageError. */
      async put(asset) {
        await ready;
        const t = now();
        const a = { ...asset, id: asset.id || uid(), created: asset.created || t, modified: t };
        if (db) await tx(db, 'Save to Library', DB_STORE, 'readwrite', (s) => s.put(a));
        cache.set(a.id, a);
        emit('put', a.id);
        return a;
      },
      async remove(id) {
        await ready;
        if (db) await tx(db, 'Delete from Library', DB_STORE, 'readwrite', (s) => s.delete(id));
        cache.delete(id);
        emit('remove', id);
      },
      async rename(id, name) {
        const a = cache.get(id);
        return a ? assets.put({ ...a, name }) : null;
      },
      /** rereads one stored asset into the cache (another tab changed or deleted it) */
      async refresh(id) {
        await ready;
        if (!db) return cache.get(id) || null;
        const a = await tx(db, 'Read Library', DB_STORE, 'readonly', (s) => s.get(id));
        if (a) cache.set(id, a);
        else cache.delete(id);
        return a || null;
      },
      persistent: () => mode === 'persistent',
      mode: () => mode,
      loadError: () => loadError,
    };

    /** Small key/value store for tool sessions (too large for localStorage). */
    const kv = {
      async get(key) {
        await ready;
        return db ? (await tx(db, 'Read session', KV_STORE, 'readonly', (s) => s.get(key))) ?? null : memKv.get(key) ?? null;
      },
      async set(key, value) {
        await ready;
        if (db) await tx(db, 'Save session', KV_STORE, 'readwrite', (s) => s.put(value, key));
        else memKv.set(key, value);
      },
    };

    return { ready, assets, kv };
  }

  return { StorageError, createStore, REASONS };
})();

if (typeof module !== 'undefined') module.exports = P8Storage;

(() => {
  if (typeof window === 'undefined') return;
  const App = window.P8App;
  const { rgbOf, isValidPico, quantize, encodeIndexedPng } = P8;
  const { el, $, modal, showMessage, confirmDialog, toast, download, pickFile, decodeImage, formField, sanitizeFilename, store } = App;

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

  let channel = null;

  function emitAssets(type, id, remote = false) {
    document.dispatchEvent(new CustomEvent('p8:assets', { detail: { type, id, remote } }));
    if (!remote) {
      try { channel?.postMessage({ type, id }); } catch { /* ignore */ }
    }
  }

  let idb = null;
  try { idb = window.indexedDB || null; } catch { /* access denied: memory-only session */ }
  const storage = P8Storage.createStore({ indexedDB: idb, emit: (type, id) => emitAssets(type, id), uid });
  const { assets } = storage;

  // a failed autosave is reported once until a later session save succeeds
  const autosaveWarned = new Set();
  const kv = {
    get: storage.kv.get,
    async set(key, value) {
      await storage.kv.set(key, value);
      autosaveWarned.clear();
    },
  };

  /**
   * Shows why a browser-storage read/write failed. Callers keep their work dirty / unsaved.
   * autosave: true -> one toast per label until a session save succeeds again (sessions are
   * saved in the background; S.autosaveFailed(label) is the matching .catch handler).
   */
  function reportStorageError(title, e, { autosave = false } = {}) {
    const why = e?.message || String(e);
    if (autosave) {
      if (autosaveWarned.has(title)) return;
      autosaveWarned.add(title);
      console.error(e);
      toast(`${title}: ${why}. Keep this tab open and save or export your work.`, 'error', 8000);
      return;
    }
    console.error(e);
    showMessage(title, `${why}\n\nNothing was marked as saved and your work is still open. Free browser storage (for example export the Library, then delete unused assets) and try again, or download/export the work instead.`, 'error');
  }
  const autosaveFailed = (title) => (e) => reportStorageError(title, e, { autosave: true });

  async function loadAll() {
    await storage.ready;
    if (!assets.persistent()) toast('Browser storage is unavailable: this is a memory-only session. Export the Library and download your work before closing the page.', 'warn', 8000);
    else if (assets.loadError()) reportStorageError('Library', assets.loadError());
    if ('BroadcastChannel' in window) {
      channel = new BroadcastChannel('p8suite-assets');
      channel.onmessage = async ({ data }) => {
        await assets.refresh(data.id).catch(() => null);
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
      const existing = assets.get(a.id);
      try {
        await assets.put({ ...a, id: existing ? uid() : a.id });
      } catch (e) {
        reportStorageError(`Import Library (stopped after ${n} asset(s))`, e);
        return;
      }
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
   * Destination for "Send to… / Open in…" (#57, js/transfer-core.js):
   * { id, label, kinds:['image'|'palette'|'map'], accepts?(asset) -> true | 'reason why not',
   *   unsaved?() -> false | 'description' (central Replace / Cancel prompt; omit if open() asks itself),
   *   open(asset) -> Promise<boolean|void> (return false when the user cancelled, true when it opened) }
   */
  function registerConsumer(c) {
    consumers.push(c);
  }

  /** every registered destination for an asset, available first, each unavailable one with its exact reason */
  const destinationsFor = (a) => P8Transfer.destinations(consumers, a);

  function consumersFor(a) {
    return consumers
      .filter((c) => c.kinds.includes(a.kind))
      .map((c) => ({ c, ok: c.accepts ? c.accepts(a) : true }));
  }

  /**
   * Sends an asset to a destination (#57). `saved`: the asset is a Library entry (true) or a temporary
   * copy of what a tool currently shows (false); the success message says which. Cancel and failure
   * never report success and leave source and destination as they were.
   */
  async function openIn(consumerId, a, { saved = true } = {}) {
    const c = consumers.find((x) => x.id === consumerId);
    const r = await P8Transfer.send(c, a, { confirm: (m) => confirmDialog('Replace unsaved work?', m, 'Replace') });
    if (r.status === 'done') {
      closeLibrary();
      if (r.confirmed) toast(P8Transfer.doneMessage(c, a, { saved }), 'info', 5200);
    } else if (r.status === 'cancelled') toast(r.message);
    else showMessage(c ? c.label : 'Send to…', r.message);
    return r.status === 'done';
  }

  /**
   * One list of destinations for an asset: buttons for the available ones, and for the others a button that
   * stays focusable (aria-disabled) with its reason as visible text, so keyboard and touch users can read it.
   */
  function destinationList(a, onPick) {
    const rows = destinationsFor(a);
    const list = el('ul', { className: 'send-list' });
    for (const d of rows) {
      const b = el('button', { type: 'button', className: 'btn', textContent: d.label });
      const li = el('li', {}, b);
      if (d.ok) b.addEventListener('click', () => onPick(d.id));
      else {
        const why = el('span', { className: 'send-reason muted', id: `send-why-${d.id}`, textContent: d.reason });
        b.setAttribute('aria-disabled', 'true');
        b.setAttribute('aria-describedby', why.id);
        b.classList.add('is-unavailable');
        b.addEventListener('click', (e) => e.preventDefault());
        li.append(why);
      }
      list.append(li);
    }
    return list;
  }

  /** "Send to…" for any asset or temporary copy (Pixel Studio's File menu uses it) */
  async function sendDialog(a, { saved = true } = {}) {
    let close = () => {};
    const body = el('div', { className: 'send-dialog' },
      el('p', { className: 'muted', textContent: saved ? `“${a.name}” stays in the Library; the destination gets a copy.` : `“${a.name}” is what the tool shows now. The destination gets a temporary copy that is not saved to the Library.` }),
      destinationList(a, (id) => { close(); setTimeout(() => openIn(id, a, { saved }), 0); }));
    await modal({ title: 'Send to…', body, buttons: [{ label: 'Cancel', value: null, primary: true }], onOpen: (dlg) => { close = () => dlg.querySelector('button[aria-label="Close"]')?.click(); } });
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
      let data;
      try {
        data = await decodeImage(file);
      } catch {
        toast(`${file.name}: could not decode`, 'error');
        continue;
      }
      if (data.width > MAX_IMAGE_SIDE || data.height > MAX_IMAGE_SIDE) {
        toast(`${file.name}: larger than ${MAX_IMAGE_SIDE}×${MAX_IMAGE_SIDE}, skipped`, 'warn');
        continue;
      }
      try {
        added.push(await assets.put(assetFromImageData(data, file.name.replace(/\.[^.]+$/, ''))));
      } catch (e) {
        reportStorageError(`Import ${file.name}`, e);
        break;
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

    const openRow = destinationList(a, (id) => {
      rename();
      dlgRef?.finish(true);
      openIn(id, assets.get(a.id) || a);
    });
    let dlgRef = null;

    const body = el('div', { className: 'asset-detail' },
      big,
      el('div', { className: 'asset-detail-side' },
        formField('Name', nameInput),
        info,
        el('h3', { textContent: 'Send to / Open in' }),
        openRow));

    let deleted = false;
    const rename = () => {
      const n = nameInput.value.trim();
      if (!deleted && n && n !== a.name && assets.get(a.id)) assets.rename(a.id, n).then(() => { a.name = n; }, (e) => reportStorageError('Rename Asset', e));
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
            try {
              await assets.put({ ...rest, name: `${rest.name} copy` });
            } catch (e) {
              reportStorageError('Duplicate Asset', e);
              return;
            }
            toast('Duplicated');
            dlg.finish(true);
          },
        },
        {
          label: 'Delete',
          onClick: async (dlg) => {
            if (await confirmDialog('Delete Asset', `Delete "${a.name}" from the library?\n\nThis cannot be undone.`, 'Delete')) {
              try {
                await assets.remove(a.id);
              } catch (e) {
                reportStorageError('Delete Asset', e);
                return;
              }
              deleted = true;
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
      drawer.list.append(el('p', { className: 'hint', textContent: 'Memory-only session: browser storage is unavailable, so the library and tool sessions only live until this page is closed. Use Export to keep it.' }));
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
          try {
            await assets.remove(a.id);
          } catch (err) {
            reportStorageError('Delete Asset', err);
            return;
          }
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

  /**
   * { ws, name, desc, color, tags:[], category, sub?, tasks? }. category: 'create' | 'develop' | 'inspect' |
   * 'utilities' (P8Nav.CATEGORIES; anything else is listed under Utilities). Without `sub` the tool
   * is a workspace: a card on Home and a group in the workspace bar. With `sub` it is a part of
   * workspace `ws` (an Extra Tools tab) that Find tool lists and opens through #ws/sub.
   */
  function registerTool(t) {
    tools.push(t);
    orderWorkspaceTabs();
    renderHome();
    document.dispatchEvent(new CustomEvent('p8:tool', { detail: { ws: t.ws } }));
  }

  // ------------------------------------------------------------------ //
  // Workspace navigation (#53): grouped bar, Find tool (Ctrl+K)        //
  // ------------------------------------------------------------------ //

  const wsTabs = () => [...document.querySelectorAll('#wsTabs [role=radio][data-value]')];
  const barOrder = () => wsTabs().map((b) => b.dataset.value);
  const workspaceTools = () => tools.filter((t) => !t.sub);

  /** Sorts the workspace tabs by category (unregistered tabs such as Home first) and separates the groups. */
  let markupOrder = null; // tie-break: the tabs' order in index.html, stable while tools register
  function orderWorkspaceTabs() {
    const bar = $('#wsTabs');
    if (!bar) return;
    const byWs = new Map(workspaceTools().map((t) => [t.ws, t]));
    const tabs = wsTabs();
    markupOrder ||= new Map(tabs.map((b, i) => [b, i]));
    const rank = new Map(P8Nav.CATEGORIES.map((c, i) => [c.id, i]));
    const key = (b) => (byWs.has(b.dataset.value) ? rank.get(P8Nav.categoryOf(byWs.get(b.dataset.value))) : -1);
    const sorted = tabs.map((b) => ({ b, i: markupOrder.get(b) ?? 1e9, k: key(b) })).sort((x, y) => x.k - y.k || x.i - y.i);
    const focused = bar.contains(document.activeElement) ? document.activeElement : null;
    bar.querySelectorAll('.ws-sep').forEach((s) => s.remove());
    let prev = null;
    for (const { b, k } of sorted) {
      if (prev !== null && k !== prev) bar.append(el('span', { className: 'ws-sep', attrs: { 'aria-hidden': 'true' } }));
      bar.append(b);
      const cat = byWs.has(b.dataset.value) ? P8Nav.category(P8Nav.categoryOf(byWs.get(b.dataset.value))).label : '';
      b.title = cat ? `${b.getAttribute('aria-label')} · ${cat}` : b.getAttribute('aria-label');
      prev = k;
    }
    focused?.focus({ preventScroll: true });
  }

  /** a copy of a workspace tab's icon, with its internal ids (masks) made unique */
  let iconSeq = 0;
  function tabIcon(ws) {
    const svg = document.querySelector(`#wsTabs [data-value="${ws}"] svg`);
    if (!svg) return el('span', { className: 'ws-icon-blank', attrs: { 'aria-hidden': 'true' } });
    const copy = svg.cloneNode(true);
    const n = ++iconSeq;
    for (const node of copy.querySelectorAll('[id]')) {
      const old = node.id;
      node.id = `${old}-c${n}`;
      for (const user of copy.querySelectorAll(`[mask="url(#${old})"], [clip-path="url(#${old})"]`)) {
        for (const a of ['mask', 'clip-path']) if (user.getAttribute(a) === `url(#${old})`) user.setAttribute(a, `url(#${node.id})`);
      }
    }
    return copy;
  }

  function currentView() {
    return { ws: document.body.dataset.workspace || 'home', sub: P8Nav.parseRoute(location.hash).sub };
  }

  /** the workspace bar's Find tool button: on phones it also names the open workspace */
  function updateFindButton() {
    const btn = $('#wsFind');
    if (!btn) return;
    const { ws } = currentView();
    const name = document.querySelector(`#wsTabs [data-value="${ws}"]`)?.getAttribute('aria-label') || 'Home';
    btn.setAttribute('aria-label', `Find tool (current: ${name})`);
    const label = btn.querySelector('.ws-find-current');
    label.replaceChildren(tabIcon(ws), el('span', { textContent: name }));
  }

  const HOME_ENTRY = { ws: 'home', name: 'Home', desc: 'Start page: every tool, recent library assets and how the tools work together.', tags: ['start'] };

  /** Ctrl+K / the magnifier button: search every workspace and Extra Tools tool, open the chosen one. */
  let findOpen = false;
  async function findTool() {
    if (findOpen) return;
    findOpen = true;
    const order = barOrder();
    const entries = tools.slice();
    const now = currentView();
    const id = `wsfind-${Date.now().toString(36)}`;
    const input = el('input', {
      type: 'text', id: `${id}-q`, className: 'ws-find-input', autocomplete: 'off', spellcheck: false,
      placeholder: 'Tool name or task, e.g. map, tokens, fade',
      attrs: { role: 'combobox', 'aria-expanded': 'true', 'aria-controls': `${id}-list`, 'aria-autocomplete': 'list', 'aria-describedby': `${id}-help` },
    });
    const list = el('div', { id: `${id}-list`, className: 'ws-find-list', attrs: { role: 'listbox', 'aria-label': 'Tools' } });
    const status = el('p', { className: 'ws-find-status', attrs: { role: 'status' } });
    const body = el('div', { className: 'ws-find-dialog' },
      el('label', { className: 'ws-find-label', htmlFor: input.id, textContent: 'Search tools' }),
      input,
      el('p', { id: `${id}-help`, className: 'hint', textContent: '↑ ↓ choose · Enter opens · Esc closes. Searches names and descriptions.' }),
      status,
      list);

    let shown = [];
    let active = 0;
    const isCurrent = (e) => e.ws === now.ws && (!e.sub || e.sub === now.sub);
    const optionId = (i) => `${id}-o${i}`;

    function option(e, i, flat = true) {
      const parent = e.sub ? workspaceTools().find((t) => t.ws === e.ws)?.name : null;
      const where = flat && e.ws !== 'home' ? [P8Nav.category(P8Nav.categoryOf(e)).label] : [];
      if (parent) where.push(`in ${parent}`);
      return el('div', { id: optionId(i), className: 'ws-find-option', dataset: { i: String(i) }, attrs: { role: 'option', 'aria-selected': 'false' } },
        tabIcon(e.ws),
        el('span', { className: 'ws-find-text' },
          el('span', { className: 'ws-find-name' }, e.name,
            where.length ? el('span', { className: 'ws-find-where', textContent: ` · ${where.join(' · ')}` }) : null,
            isCurrent(e) ? el('span', { className: 'badge ws-find-now', textContent: 'Open now' }) : null),
          el('span', { className: 'ws-find-desc', textContent: e.desc || '' })));
    }

    function setActive(i) {
      if (!shown.length) { input.removeAttribute('aria-activedescendant'); return; }
      active = (i + shown.length) % shown.length;
      for (const o of list.querySelectorAll('[role=option]')) o.setAttribute('aria-selected', String(o.dataset.i === String(active)));
      input.setAttribute('aria-activedescendant', optionId(active));
      list.querySelector(`#${optionId(active)}`)?.scrollIntoView({ block: 'nearest' });
    }

    function render() {
      const q = input.value.trim();
      const found = P8Nav.search(entries, q, order);
      if (q) {
        shown = (P8Nav.search([HOME_ENTRY], q).length ? [HOME_ENTRY] : []).concat(found);
        list.replaceChildren(...shown.map((e, i) => option(e, i)));
      } else {
        const groups = P8Nav.group(found, order);
        shown = [HOME_ENTRY].concat(...groups.map((g) => g.entries));
        let i = 1;
        list.replaceChildren(option(HOME_ENTRY, 0, false), ...groups.map((g, gi) => el('div', { className: 'ws-find-group', attrs: { role: 'group', 'aria-labelledby': `${id}-g${gi}` } },
          el('div', { id: `${id}-g${gi}`, className: 'ws-find-heading', textContent: g.category.label }),
          ...g.entries.map((e) => option(e, i++, false)))));
      }
      list.hidden = !shown.length;
      input.setAttribute('aria-expanded', String(shown.length > 0));
      status.classList.toggle('ws-find-empty', !shown.length);
      status.textContent = !shown.length
        ? `No tool matches “${q}”. Try another word, or clear the search to list every tool.`
        : q ? `${shown.length} of ${entries.length + 1} tools match.` : `${shown.length} tools.`;
      // without a query the open tool (its Extra Tools tab if one is open) is preselected
      const exact = shown.findIndex((e) => e.ws === now.ws && e.sub && e.sub === now.sub);
      setActive(q ? 0 : exact >= 0 ? exact : Math.max(0, shown.findIndex((e) => e.ws === now.ws && !e.sub)));
    }

    let dialog = null;
    const choose = (i) => { if (shown[i]) dialog?.finish(shown[i]); };
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
      const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 5, PageUp: -5 }[e.key];
      if (step && shown.length) {
        e.preventDefault();
        setActive(Math.abs(step) > 1 ? Math.max(0, Math.min(shown.length - 1, active + step)) : active + step);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        choose(active);
      }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (and the typed text) in the search field
    list.addEventListener('click', (e) => {
      const o = e.target.closest('[role=option]');
      if (o) choose(Number(o.dataset.i));
    });
    render();

    const picked = await App.modal({
      title: 'Find tool',
      body,
      buttons: [{ label: 'Cancel', value: null }],
      onOpen: (dlg) => { dialog = dlg; dlg.classList.add('ws-find-modal'); input.focus(); },
    });
    findOpen = false;
    if (!picked || isCurrent(picked)) return;
    App.setWorkspace(picked.ws, { sub: picked.sub || null });
    // focus that was on <body> or in the hidden workspace goes to the new workspace's tab
    const f = document.activeElement;
    if (!f || f === document.body || !f.getClientRects().length) {
      const tab = document.querySelector(`#wsTabs [data-value="${picked.ws}"]`);
      (tab?.getClientRects().length ? tab : $('#wsFind'))?.focus({ preventScroll: true });
    }
  }

  function bindNavigation() {
    $('#wsFind')?.addEventListener('click', findTool);
    App.registerActions({ 'find-tool': findTool });
    document.addEventListener('p8:workspace', updateFindButton);
    window.addEventListener('hashchange', updateFindButton);
    updateFindButton();
  }

  // Historical Demotools desktop tools; not bundled in this standalone repository.
  const DESKTOP_TOOLS = [
    { name: 'Filename Optimizer', dir: 'Demotools/filename_optimizer', desc: 'External historical tool; not included here. Batch-renames carts and updates code references.' },
  ];

  /**
   * Home (#68): "Continue" (last tool, active project), task shortcuts grouped from the registry and the
   * storage notice. Nothing here opens a folder or changes another tool's work: a shortcut only switches
   * to the tool (and, for a tab inside a tool, selects that tab).
   */
  function renderHomeLaunch() {
    const cont = $('#homeContinue');
    if (!cont) return;
    const rows = [];
    const last = P8Home.continueEntry(App.store.get(App.KEYS.lastTool, null), tools);
    if (last) rows.push(el('button', { type: 'button', className: 'btn btn-primary', textContent: `Continue in ${last.name}`, dataset: { ws: last.ws } }));
    const wsIds = tools.map((t) => t.ws);
    const p = P8Home.projectEntry(App.projectContext.get(), wsIds);
    if (p.action) {
      rows.push(el('button', { type: 'button', className: 'btn', textContent: p.label, dataset: { project: p.action, ws: p.ws || '' }, disabled: p.action === 'open' && !p.ws }));
    }
    rows.push(el('p', { className: `home-note${p.kind === 'blocked' || p.kind === 'missing' ? ' home-note-warn' : ''}`, textContent: p.text }));
    if (!last) rows.unshift(el('p', { className: 'muted', textContent: 'Pick a task below to start. Your last tool will be offered here next time.' }));
    cont.replaceChildren(...rows);

    const note = P8Home.storageNotice(assets.mode(), assets.list().length > 0);
    const sn = $('#homeStorage');
    sn.textContent = note.text;
    sn.classList.toggle('home-note-warn', note.tone === 'warn');
    if (note.tone === 'warn') sn.setAttribute('role', 'alert'); else sn.removeAttribute('role');

    const box = $('#homeTasks');
    box.replaceChildren(...P8Home.taskGroups(tools).map((g) => el('section', { className: 'home-task-group', attrs: { 'aria-label': g.label } },
      el('h4', { textContent: g.label }),
      ...g.tasks.map((k) => el('button', { type: 'button', className: 'home-task', dataset: { ws: k.ws, ...(k.open?.click ? { click: k.open.click } : {}) } },
        el('strong', { textContent: k.label }),
        el('span', { className: 'muted', textContent: ` ${k.tool}${k.hint ? ` · ${k.hint}` : ''}` }))))));
  }

  function renderHome() {
    renderHomeLaunch();
    const grid = $('#homeTools');
    if (!grid) return;
    const card = (t) => el('button', { type: 'button', className: 'tool-card', dataset: { ws: t.ws }, style: `--tool:${t.color}` },
      el('span', { className: 'tool-dot', attrs: { 'aria-hidden': 'true' } }),
      el('strong', { textContent: t.name }),
      el('span', { className: 'tool-desc', textContent: t.desc }),
      el('span', { className: 'tool-tags' }, ...(t.tags || []).map((x) => el('span', { className: 'badge', textContent: x }))));
    grid.replaceChildren(...P8Nav.group(workspaceTools(), barOrder()).map((g) => el('section', { className: 'tool-group', attrs: { 'aria-labelledby': `home-cat-${g.category.id}` } },
      el('h4', { id: `home-cat-${g.category.id}` }, g.category.label, el('span', { className: 'muted', textContent: ` · ${g.category.desc}` })),
      el('div', { className: 'tool-grid' }, ...g.entries.map(card)))));

    const recent = $('#homeRecent');
    const list = assets.list().slice(0, 12);
    recent.replaceChildren(...(list.length
      ? list.map((a) => assetCard(a))
      : [el('p', { className: 'muted asset-empty', textContent: 'Nothing yet. Everything you save to the library shows up here and in every tool.' })]));

    $('#homeDesktop').replaceChildren(...DESKTOP_TOOLS.map((t) => el('li', {},
      el('strong', { textContent: t.name }), ' ', el('code', { textContent: `${t.dir}/` }), el('span', { className: 'muted', textContent: ` · ${t.desc}` }))));
  }

  function bindHome() {
    $('#homeTasks').addEventListener('click', (e) => {
      const b = e.target.closest('.home-task');
      if (!b) return;
      App.setWorkspace(b.dataset.ws);
      if (b.dataset.click) setTimeout(() => document.querySelector(b.dataset.click)?.click(), 0);
    });
    $('#homeContinue').addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.project === 'open') {
        const r = await App.projectContext.check();
        renderHomeLaunch();
        if (r.access !== 'granted') { toast(r.message, 'warn'); return; }
      }
      if (b.dataset.project === 'reconnect') {
        // the click is the permission request; the project is only used if the browser grants it
        const r = await App.projectContextPublisher.reconnect();
        renderHomeLaunch();
        if (r.access !== 'granted') { toast(r.message, 'warn'); return; }
      }
      if (b.dataset.ws) App.setWorkspace(b.dataset.ws);
    });
    document.addEventListener('p8:projectcontext', renderHomeLaunch);
    document.addEventListener('p8:assets', renderHomeLaunch);
    document.addEventListener('p8:workspace', () => { if (document.body.dataset.workspace === 'home') renderHomeLaunch(); });
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
    try {
      await assets.put(paletteAsset({ name, colors }));
    } catch (e) {
      reportStorageError('Save Palette', e);
      return;
    }
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
    try {
      await assets.put(imageAsset({ name: 'preview', w: img.w, h: img.h, pixels: img.indices.slice(), pal, source: 'palette' }));
    } catch (e) {
      reportStorageError('Save Preview', e);
      return;
    }
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
    StorageError: P8Storage.StorageError,
    reportStorageError,
    autosaveFailed,
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
    destinationsFor,
    sendDialog,
    openIn,
    pickAsset,
    showAsset,
    importImageFiles,
    bindAssetDrop,
    registerTool,
    /** registered tool metadata { ws, name, desc, tags, category } in registration order */
    tools: () => tools.slice(),
    openLibrary,
    closeLibrary,
    toJson,
    fromJson,
  };

  bindLibrary();
  bindHome();
  bindNavigation();
  registerTool({ ws: 'palette', category: 'create', name: 'Palette & Fades', desc: '16-color custom palettes from all 32 PICO-8 colors, dark/bright fade tables, greyscale conversion.', tasks: [{ group: 'create', label: 'Make a palette', hint: '16 of the 32 PICO-8 colors, with fade tables' }], color: '#ff004d', tags: ['palette', 'fades', 'Lua'] });
  registerTool({ ws: 'tiles', category: 'create', name: 'Tile Maker', desc: 'Packs images into 8×8 tiles + map, VRAM viewport heatmap, tile editor, .p8 carts.', tasks: [{ group: 'create', label: 'Turn an image into tiles', hint: 'Tile sheet and map from any picture' }], color: '#00e436', tags: ['tiles', 'map', '.p8'] });
  assets.ready = loadAll();
})();


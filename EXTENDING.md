# Adding a tool to the suite

A tool is a workspace (`<main data-ws="...">`) plus a script that registers itself with `window.Suite` and `window.P8App`. Data Tools (`js/datatools.js`) is a small, complete example.

## 1. Markup (`index.html`)

```html
<!-- tab (in #wsTabs): a 20×20 icon; the name shows only while the tab is active -->
<button role="radio" data-value="mytool" aria-checked="false" title="My Tool" aria-label="My Tool"><svg viewBox="0 0 20 20" aria-hidden="true">…</svg><span>My Tool</span></button>

<!-- workspace -->
<main class="layout-mytool" data-ws="mytool" hidden> … </main>

<!-- optional menu, only visible in this workspace -->
<div class="menu" data-show="mytool"> … <button role="menuitem" data-action="mytool-export">Export…</button> </div>
```

Every element with `data-show="ws1 ws2"` is hidden outside the listed workspaces. Load the script after `js/suite.js`.

## 2. Script

```js
(() => {
  const App = window.P8App;
  const S = window.Suite;
  const element = document.querySelector('[data-ws="mytool"]');

  function load(asset) { /* Copy the accepted data into this tool's model. */ }
  async function exportSomething() { /* Prepare and download the tool's result. */ }
  async function pickImage() {
    const asset = await S.pickAsset({ title: 'Choose an image', kind: 'image' });
    if (asset) load(asset);
  }

  S.registerTool({ ws: 'mytool', name: 'My Tool', desc: 'What it does.', color: '#ff77a8', tags: ['image'] });
  App.registerActions({ 'mytool-export': exportSomething, 'mytool-pick': pickImage });
  App.registerShortcuts('mytool', (e, typing) => { /* Ignore typing unless handling an editor shortcut. */ });

  S.registerConsumer({
    id: 'mytool', label: 'My Tool', kinds: ['image'],
    accepts: (a) => a.w <= 128 ? true : 'Needs 128 px or less',
    open: async (a) => {
      // Confirm replacing unsaved work here, before mutating this tool or shared state.
      App.setWorkspace('mytool');
      load(a);
    },
  });
  S.bindAssetDrop(element, (asset) => S.openIn('mytool', asset));
  document.addEventListener('p8:assets', (e) => { /* e.detail: {type, id, remote} */ });
})();
```

Publish an indexed image with `await S.assets.put(S.imageAsset({ name, w, h, pixels, pal, transparent: 0, source: 'mytool' }))`, or a palette with `S.paletteAsset({ name, colors })`, inside an async action. Await `S.assets.ready` before reading startup Library data. Consumers must guard unsaved target work themselves; the registry does not do this automatically.

### Storage outcomes

`S.assets.put`, `remove`, `rename` and `S.kv.set` resolve only after the IndexedDB transaction has committed. Any failure (quota exceeded, `DataCloneError`, an aborted transaction, a closed connection or a synchronous throw) **rejects** with an `S.StorageError` (`op`, `reason`: `'quota' | 'clone' | 'abort' | 'closed' | 'error'`, `cause`). A rejected write leaves the Library cache and the previously stored record unchanged and emits no `p8:assets` event. `S.kv.get` also rejects when it cannot read, instead of looking empty. Only mark work as saved after the promise resolves; on rejection keep it dirty and report the failure:

```js
const stored = await S.assets.put(asset).catch((e) => S.reportStorageError('Save to Library', e));
if (!stored) return; // still dirty: the user can free space and retry, or export instead
dirty = false;
```

Background session saves use `S.kv.set(key, value).catch(S.autosaveFailed('My Tool session'))`, which shows one toast until a session save succeeds again.

When IndexedDB cannot be opened at startup the suite runs an explicit **memory-only session**: writes succeed in memory, `S.assets.persistent()` is `false` and `S.assets.mode()` is `'memory'`; the suite shows a warning and the Library labels it. A write that fails while IndexedDB is open never falls back to memory.

### Document save status

`js/doc-status-core.js` (`P8DocStatus`) is the shared save/operation state contract (#58). It tracks one open document and shows a badge with an icon and text for each state: not saved, unsaved, saving, saved (Library/file/project), downloaded copy, memory-only, failed, conflict. Use it instead of a plain `dirty` flag. The Map Editor (`js/map.js`) is the reference adapter.

```js
const status = P8DocStatus.create({ storage: () => S.assets.mode() });
status.open({ name, target: assetId ? 'library' : null });         // new or opened document (dirty: true for a restored unsaved copy)
// on every edit: status.edit();   confirm discard with: status.dirty()

async function save() {
  if (status.pending()) return false;                               // re-entry guard
  const doc = status.doc(), ticket = status.begin('library', { name }); // take ticket and snapshot together
  const asset = buildAsset();
  try { await S.assets.put(asset); }
  catch (e) { status.reject(ticket, { message: e.message }); S.reportStorageError('Save to Library', e); return false; }
  if (status.doc() !== doc) return false;                           // another document was opened meanwhile
  status.resolve(ticket, { name: asset.name });                     // edits made during the save stay unsaved
  return true;
}

status.downloaded(fileName);                // a download is a copy, never a save
const tk = status.snapshot();               // background session write: not a save
S.kv.set(KEY, data).then(() => status.session(tk, true), (e) => status.session(tk, false));
status.conflict(message); status.lost(message); // Library copy changed / deleted elsewhere
P8DocStatus.mount(hostEl, status, { title: 'Map save status', onRetry: save });
addEventListener('beforeunload', (e) => { if (status.atRisk()) e.preventDefault(); });
```

Results for an older document or an older save ticket are ignored, and an error stays visible until a later save succeeds or the user dismisses it. Tests: `tests/doc-status.test.js`.

## UI tokens and primitives

Style new controls with the shared tokens and primitives from [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) (live reference: `docs/design-system.html`) instead of new colours, sizes or focus styles. Use `.btn`, `.seg[role=radiogroup]`, `label.field`, `.select`, `fieldset.panel-group` > `legend.panel-heading`, `p.status-line[data-tone]`, `.notice[data-tone]` and `progress.progress`. Express state with attributes: `aria-pressed`/`aria-checked` (selected), `aria-busy` (busy), `disabled`, `aria-invalid` + `aria-describedby` (error). Use `--status-error` for error text, because `--danger` is not text-safe. Keep tool-specific selectors under the tool's own prefix.

## Live palettes between tools

Besides the library, tools can offer what is open right now. `S.registerPaletteSource({ id, label, get })` publishes a palette; `get()` returns `{ pal, fades, name }` or `null`. Here `pal` holds 16 PICO-8 colors and `fades` is `{ dark, bright }`, each fade table in the Palette & Fades format or `null`. `S.paletteSources()` lists the sources and `S.paletteSource(id)` reads one. Palette & Fades (`palette`) and Pixel Studio (`studio`) register theirs, and Terrain Lab uses them for its PICO-8 view.

## Asset model

| Field | Image | Palette |
|---|---|---|
| `kind` | `'image'` | `'palette'` |
| data | `w`, `h`, `pixels` (Uint8Array of slots 0–15), `pal` (16 PICO-8 colors), `transparent` (slot or -1), optional `doc` (Pixel Studio layers/frames) | `colors` (16 entries, each a PICO-8 color or null) |
| common | `id`, `name`, `source`, `created`, `modified` | |

Map assets use `kind: 'map'`, `w`, `h`, `cells` (Uint8Array of tile IDs), `sheet` (128-pixel-wide slot pixels), `pal`, and optional `sheetId` / `sheetName`; see `js/map.js`. There is no generic map constructor in Suite.

Helpers: `S.assetImageData(a)` (RGBA), `S.assetCanvas(a)`, `S.thumbnail(a, size)`, `S.assetFromImageData(imageData, name, pal)` (nearest-color quantize), `S.imageAssetToPng(a)`.

For tool state that is too large for `localStorage`, use `S.kv.get(key)` / `S.kv.set(key, value)` (IndexedDB; failures reject as described under [Storage outcomes](#storage-outcomes)).

## Extra Tools and historical desktop tools

LUT Creator, Wave Designer, Line Tool and Project Audit were ported from Demotools. `filename_optimizer`, `rocket_optimizer`, the demo framework and its release builder are not bundled in this standalone repository.

A small tool that does not need its own workspace can go into Extra Tools. Either add it to `js/extras.js` (build its panel with the helpers at the top of the file, add it to the internal `tools` object and add a button in `#exTabs`), or keep it in its own file loaded before `js/extras.js` and register it; Terrain Lab (`js/terrain.js`) does this:

```js
(window.P8ExtraTools ||= []).push({
  id: 'mytool', label: 'My Tool', desc: 'One line under the tabs.',
  // helpers: slider, numberField, checkbox, select, btn, group, row, showCode, fitCanvas, isActive(), show()
  create(helpers) { return { panel, draw() {}, tick(dt) {}, key(e) { return false; } }; },
});
```

For registered plug-ins, Extra Tools adds the tab (with the next <kbd>Alt</kbd>+number), shows the panel and calls `draw()` when the tab opens or resizes, `tick(dt)` every frame while it is visible and `key(e)` for key presses (return `true` when handled).


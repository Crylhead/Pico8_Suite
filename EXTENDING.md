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

### Keyboard and accessibility contract

The shell provides keyboard behavior for standard markup; use it instead of custom key handling (details and the manual regression script: [docs/ACCESSIBILITY.md](docs/ACCESSIBILITY.md)):

- **Option groups:** `role="radiogroup"` (with an `aria-label`) containing `role="radio"` buttons with `aria-checked`. Select in a `click` listener and update `aria-checked`. The shell maintains the roving tabindex and Arrow/Home/End keys, including for groups created later.
- **Menus:** `.menu` > `.menu-btn` (`aria-haspopup="menu"`) + `.menu-pop[role=menu]` with `role="menuitem"` buttons. Keyboard handling and focus return are automatic.
- **Dialogs:** use `App.modal({ title, body, buttons, alert })` / `App.showMessage(title, msg, 'error')`. The title names the dialog, and focus returns to the opener. Pass `alert: true` (or a `danger` button) for warnings, errors and destructive confirmations.
- **Shortcuts:** `App.registerShortcuts(ws, handler)` does not receive `Enter`/`Space` aimed at a keyboard-focused button, checkbox, link, select or menu/radio item, nor arrow keys inside an option group or open menu.
- Every icon-only control needs an `aria-label`. Never rely on color or `title` (hover) alone for state, warnings or errors.

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

### UX preferences

`js/ux-prefs-core.js` (`P8Prefs`) holds the user's display/help choices in one schema-versioned `localStorage` record (`p8suite.uxPrefs`); the shell exposes the instance as `P8App.prefs` and edits it in **Help › Settings…** (`P8App.showSettings()`). Invalid or corrupt fields fall back to their defaults one by one, fields from a newer schema version survive a write, and blocked storage never throws (`prefs.status().persistent === false`; the preference still applies for the page). Only these choices are stored, no identifiers or telemetry.

| Field | Values (first = default) | Effect |
| --- | --- | --- |
| `helpLevel` | `concise`, `off`, `detailed` | `<html data-help-level>`; elements with `.help-optional` hide at `off`, `.help-detailed` show only at `detailed` |
| `autoOfferTours` | `true`, `false` | for onboarding tours (#61): never auto-offer when `false`; replaying stays available |
| `compactNav` | `false`, `true` | `<html data-compact-nav>` hides the workspace name box |
| `motion` | `system`, `reduce` | `<html data-motion>`; `P8App.reducedMotion()` is also true when the OS asks for reduced motion |

```js
P8App.prefs.get().helpLevel;                       // read (a copy)
P8App.prefs.set({ helpLevel: 'off' });             // → { changed: ['helpLevel'], saved: true }; invalid values throw TypeError
document.addEventListener('p8:preferences', (e) => { /* e.detail: { prefs, changed, saved } */ });
el.scrollIntoView({ behavior: P8App.reducedMotion() ? 'auto' : 'smooth' });
```

Use `.help-optional` / `.help-detailed` only for purely explanatory text. Never put labels, accessible names, warnings, errors, status or save feedback in them: those must stay visible at every help level. A new field needs a `SCHEMA` entry whose first value reproduces the previous behaviour, a Settings control, documentation here and in the F1 help, and (for an incompatible change) a `VERSION` bump with a `MIGRATIONS` step. Tests: `tests/ux-prefs.test.js`.

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


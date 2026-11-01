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
  const App = window.P8App;   // dialogs, toasts, downloads, workspaces, actions
  const S = window.Suite;     // library, picker, consumers, Home cards

  // Card on the Home page
  S.registerTool({ ws: 'mytool', name: 'My Tool', desc: 'What it does.', color: '#ff77a8', tags: ['…'] });

  // Menu / button actions (data-action="…")
  App.registerActions({ 'mytool-export': exportSomething });

  // Optional: own keyboard handling while this workspace is active
  App.registerShortcuts('mytool', (e, typing) => { /* e is the keydown event */ });

  // Accept library assets ("Open in → My Tool")
  S.registerConsumer({
    id: 'mytool', label: 'My Tool', kinds: ['image'],
    accepts: (a) => (a.w <= 128 ? true : 'Needs 128 px or less'),   // true or a reason
    open: (a) => { App.setWorkspace('mytool'); load(a); },
  });

  // Pick from the library / accept drag & drop from the library drawer
  const a = await S.pickAsset({ title: 'Choose an image', filter: (x) => true });
  S.bindAssetDrop(element, (asset) => load(asset));

  // Publish results
  await S.assets.put(S.imageAsset({ name, w, h, pixels, pal, transparent: 0, source: 'mytool' }));
  await S.assets.put(S.paletteAsset({ name, colors }));

  // React to library changes (also from other browser tabs)
  document.addEventListener('p8:assets', (e) => { /* e.detail = {type, id} */ });
})();
```

## Live palettes between tools

Besides the library, tools can offer what is open right now. `S.registerPaletteSource({ id, label, get })` publishes a palette; `get()` returns `{ pal, fades, name }` or `null`. Here `pal` holds 16 PICO-8 colors and `fades` is `{ dark, bright }`, each fade table in the Palette & Fades format or `null`. `S.paletteSources()` lists the sources and `S.paletteSource(id)` reads one. Palette & Fades (`palette`) and Pixel Studio (`studio`) register theirs, and Terrain Lab uses them for its PICO-8 view.

## Asset model

| Field | Image | Palette |
|---|---|---|
| `kind` | `'image'` | `'palette'` |
| data | `w`, `h`, `pixels` (Uint8Array of slots 0–15), `pal` (16 PICO-8 colors), `transparent` (slot or -1), optional `doc` (Pixel Studio layers/frames) | `colors` (16 PICO-8 colors or null) |
| common | `id`, `name`, `source`, `created`, `modified` | |

Helpers: `S.assetImageData(a)` (RGBA), `S.assetCanvas(a)`, `S.thumbnail(a, size)`, `S.assetFromImageData(imageData, name, pal)` (nearest-color quantize), `S.imageAssetToPng(a)`.

For tool state that is too large for `localStorage`, use `S.kv.get(key)` / `S.kv.set(key, value)` (IndexedDB).

## Candidates from this repository

`lut_creator`, `osc_designer`, `line_tool` (Extra Tools) and `project_audit` are ported. `filename_optimizer` renames files and rewrites code, so it stays a desktop tool; `rocket_optimizer` is covered by the Rocket integration in the demo itself.

A small tool that does not need its own workspace can go into Extra Tools. Either add it to `js/extras.js` (build its panel with the helpers at the top of the file, add it to the `tools` object and the `#exTabs` buttons), or keep it in its own file loaded before `js/extras.js` and register it; Terrain Lab (`js/terrain.js`) does this:

```js
(window.P8ExtraTools ||= []).push({
  id: 'mytool', label: 'My Tool', desc: 'One line under the tabs.',
  // helpers: slider, numberField, checkbox, select, btn, group, row, showCode, fitCanvas, isActive(), show()
  create(helpers) { return { panel, draw() {}, tick(dt) {}, key(e) { return false; } }; },
});
```

Extra Tools adds the tab (with the next <kbd>Alt</kbd>+number), shows the panel and calls `draw()` when the tab opens or resizes, `tick(dt)` every frame while it is visible and `key(e)` for key presses (return `true` when handled).

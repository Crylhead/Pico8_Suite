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

Publish an indexed image with `await S.assets.put(S.imageAsset({ name, w, h, pixels, pal, transparent: 0, source: 'mytool' }))`, or a palette with `S.paletteAsset({ name, colors })`, inside an async action. Await `S.assets.ready` before reading startup Library data. Current storage errors can be swallowed; [#5](https://github.com/Crylhead/Pico8_Suite/issues/5) tracks reliable durable-save outcomes. Consumers must guard unsaved target work themselves; the registry does not do this automatically.

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

For tool state that is too large for `localStorage`, use `S.kv.get(key)` / `S.kv.set(key, value)` (IndexedDB).

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


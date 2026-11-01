# PICO-8 Dev Suite

Browser-based PICO-8 graphics suite. It grew out of `palette_tool_web` and puts several tools behind one app bar, connected by a shared asset library.

| Tool | What it does |
|---|---|
| **Pixel Studio** (new) | Pixel editor restricted to PICO-8: 16 slots mapped to the 32 PICO-8 colors, `fillp()` patterns, a sieve (APaint-style dither mask), brush preview under the cursor, tiled view you can draw across, layers, frames with onion skin, canvases from 1×1 to 1024×1024, `[gfx]` clipboard in/out, `.p8` sprite sheet import, new carts and writing into existing carts |
| **Palette & Fades** | Port of `palette_tool`: custom palettes, dark/bright fade tables, greyscale conversion, Lua/GPL/PNG/.p8 exports |
| **Tile Maker** | Port of `tilemaker`: 8×8 tile packing, VRAM heatmap, tile editor, .p8/Aseprite/PNG exports |
| **Map Editor** | PICO-8 tile maps painted with tiles or blocks of a sprite sheet (library image, `.p8` `__gfx__` or Tile Maker result): draw, rectangle and flood fill, pick, select / copy as brush, undo. 128×32 cart maps, 128×64 with the shared sprite rows, up to 256×256 for data carts. `.p8` import, new cart with viewer, write into an existing cart, map bytes / hex / PNG; maps are library assets and go into Cart Builder projects as `tiles` assets |
| **Code Editor** | PICO-8 Lua editor for the `__lua__` section of a `.p8` (or a `.lua` file): PICO-8 syntax highlighting, API completion and signature hints, auto-indent, find / replace, code tabs (`-->8`), function list, live token / character count. Saves straight back into the cart (Chrome / Edge) without touching the other sections. Folders with `#include` followed (tokens counted). **Run** (Ctrl+R) starts the cart in PICO-8 through `tools/pico8_bridge.py` and shows `printh()` output |
| **Data Tools** | Ports of `binary_data_converter` (bytes → PICO-8 string literal; library images added as input) and `nibble_converter` (greyscale → hi/lo nibble images) |
| **Project Audit** | Port of `project_audit`: scans a project folder (picked or dropped, read in the browser) for tokens / characters per cart with `#include` expanded, includes in both directions, `load` / `run` / `reload` / `cstore` references, used and unused carts; CSV / JSON export |
| **Cart Builder** | A demo project folder (read/write): adopts its data as assets, packs them into data carts (drag or auto-pack, LZ per part), writes and checks the carts and rewrites the `--@data` anchor lines the fx load from. See `docs/PROJECT_MODEL.md` |
| **Data Carts** | Exact reader / writer for the cart data area (0x0000–0x42ff incl. `__sfx__` / `__music__`), memory map per cart with the ranges the project's `reload()` calls read, sections per cart (what each fx cuts out with `mem_store`), viewer in the palette and fade row the fx uses (read from its code and data), hex, fixed-point plots, packer for new data carts (raw or LZ per entry) with generated `reload()` lines |
| **Extra Tools** | Smaller tools behind one tab bar: **LUT Creator** (port of `lut_creator`: 2D motion paths, 3D ball formations incl. OBJ models, slots, `.p8` data cart / Lua / Picotron POD), **Wave Designer** (port of `osc_designer`: 16 scope waveforms → `waves.p8`), **Line Tool** (port of `line_tool`: 128×128 lines → Lua table, pixels → library), **Terrain Lab** (port of `terrain_lab_v0_4`: seamless terrain from noise or an imported heightmap, brushes, text / image / SVG stamps, erosion, terraces and sea level, baked light → 128×128 PICO-8 color map in the best 16/12/8/4 of 32 colors or the live palette of Palette & Fades / Pixel Studio, optionally shaded along their fade tables, + 16-level height map, `.p8` viewer cart, library; history window, status bar, any installed font) |

There is no build step and no dependencies. Running carts from the Code Editor needs the local helper `tools/pico8_bridge.py` (Python standard library only; double-click `tools/run_pico8_bridge.bat`), because a web page cannot start PICO-8 itself. Open `index.html` in a browser, or host the folder on any static web server.

## How the tools talk to each other

- **Live palettes**: Palette & Fades and Pixel Studio publish the palette (and fade tables) they have open (`Suite.registerPaletteSource`); Terrain Lab's PICO-8 view reads them directly, without a trip through the library.
- **Library** (top right): every saved image, palette and map, stored in the browser (IndexedDB) and synced between open tabs. Click an asset to open it in any tool that can use it, or drag its thumbnail onto a tool's canvas.
- An image asset holds palette **slots** (0–15 per pixel), the **screen palette** (slot → one of the 32 PICO-8 colors) and the **transparent slot**: the same model as PICO-8 memory + `pal()` / `palt()`. Pixel Studio images also keep their layers and frames.
- Typical round trips:
  - Pixel Studio → File → Send to → Tile Maker, then Export → Tile Sprite Sheet → Library → open the sheet in Pixel Studio.
  - Palette & Fades palette → Pixel Studio palette panel → *From Palette & Fades* (or save it to the library).
  - Any library image → Data Tools → string literal for your cart.
- **Back up** with Library → Export Library Backup (one JSON file). Clearing site data in the browser deletes the library.

## Files

- `index.html`: shell, all workspaces, in-app documentation (F1)
- `css/style.css`: base styles and the Palette / Tile Maker layouts (from `palette_tool_web`)
- `css/suite.css`: library, Home, Pixel Studio and Data Tools
- `js/core.js`, `js/app.js`: palette logic and the shell (workspaces, menus, dialogs, `window.P8App`)
- `js/suite.js`: asset library, "Open in…" registry, asset picker, Home page (`window.Suite`)
- `js/tiles-core.js`, `js/tiles.js`: Tile Maker
- `js/studio-core.js`, `js/studio.js`: Pixel Studio (pure logic / UI)
- `js/datatools.js`: Data Tools
- `js/audit-core.js`, `js/audit.js`: Project Audit (pure logic / UI)
- `js/extras-core.js`, `js/extras.js`: Extra Tools (pure logic / UI)
- `js/terrain-core.js`, `js/terrain.js`: Terrain Lab engine (runs in two Web Workers and in Node) / UI, a tab of Extra Tools
- `docs/COMPRESSION.md`: which data cart compression the suite offers, and the PICO-8 measurements behind it
- `js/project-core.js`, `js/project.js`: demo projects, anchors, packing (pure logic) / Cart Builder UI
- `js/datacarts-core.js`: sections and palettes of data carts, read from the fx code (pure logic)
- `js/cart-core.js`, `js/datacarts.js`: .p8 data area reader / writer, `reload()` analysis, LZ codec (pure logic) / Data Carts UI
- `EXTENDING.md`: how to add a tool

## Changes compared to `palette_tool_web`

- New workspaces: Home, Pixel Studio, Data Tools. Menus and shortcuts now belong to a workspace (`data-show`, `P8App.registerShortcuts`).
- Palette & Fades: preview image from the library, palette and preview image to the library.
- Tile Maker: import from the library (picker or drag & drop), sprite sheet and reconstructed image to the library.
- PNG export (`P8.encodeIndexedPng`) can write a transparent color.
- Dialog action buttons can close their dialog with `dlg.finish(value)`.

## Reviews

Code reviews and agent remediation instructions live in the repository's [reviews directory](../../reviews/README.md).

- [PICO-8 suite health review — 2026-10-31](../../reviews/2026-10-31-pico8-suite-79fef49.md), reviewed at commit [79fef49a607141ee86def6a0b7fff122ebed4b6f](https://github.com/Crylhead/Demotools/commit/79fef49a607141ee86def6a0b7fff122ebed4b6f): prioritized findings, reproductions, fix guidance and acceptance checks.
- [Workflow and menu UX review — 2026-10-31](../../reviews/2026-10-31-pico8-suite-ux-c086077.md), reviewed at [c086077151122f78055fc287b5ff5977f8e92402](https://github.com/Crylhead/Demotools/commit/c086077151122f78055fc287b5ff5977f8e92402): transfer matrix, menu vocabulary, linked editing, design references and phased acceptance checks.
- [Suite-wide UX blueprint — 2026-10-31](../../reviews/2026-10-31-suite-wide-ux-c45211f.md), reviewed at [c45211f3058e01b1aa424c49f1779d5048810536](https://github.com/Crylhead/Demotools/commit/c45211f3058e01b1aa424c49f1779d5048810536): per-tool workflows, shared UX rules, seven implementation work packages and ten required journeys across the whole suite.
- Every review must identify the full source commit SHA it examined. See the [review template](../../reviews/REVIEW_TEMPLATE.md); fixes record their own commit separately.

## Testing notes

- `studio-core.js` (clipboard format, cart reading/writing, sprite layout, raster primitives) is covered by a Node test script used during development; all checks pass.
- The UI flows (drawing, selection, layers, frames, undo/redo, dialogs, paste, session restore, library round trips across all tools, light/dark theme, phone width) were run in headless Chrome without console errors.
- `cart-core.js` was checked against PICO-8 0.2.7 itself: all 113 `.p8` files of the Modulator and Nuova standalone demos read to the same bytes PICO-8 loads with `reload()`, and the same carts rewritten by `writeP8()` load identically (226/226). A pack made in the browser (raw + LZ entries) was read back in PICO-8 and matched the source carts.
- `terrain-core.js` gives the same heights as `terrain_lab_v0_4` bit for bit (512 and 1024, with and without erosion, on the v0.4 sample scene). In Chrome, against v0.4 at 512 with a mixed erosion pass: a light change reaches the final render in 0.14 s instead of 0.72 s, a brush stroke 0.10 s after release instead of 0.62 s, a new seed in 0.12 s instead of 0.42 s. The exported `.p8` was read back in PICO-8 (sprite sheet and `hget()` match).
- `extras-core.js` matches the Python tools (waves, motion paths, formations, `.p8` exports byte for byte); `audit-core.js` matches `project_audit` on 69 real carts (except the deliberate `..` token count).
- Not yet checked inside PICO-8 itself: pasting `[gfx]` clipboard text into the sprite editor and running the generated viewer carts. The `__gfx__` text layout matches the Tile Maker carts, which were verified in PICO-8.

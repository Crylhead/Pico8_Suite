# PICO-8 Dev Suite

Browser-based PICO-8 graphics suite, developed in this standalone repository. It grew out of `palette_tool_web` in Crylhead/Demotools and puts several tools behind one app bar, connected by a shared asset library.

| Tool | What it does |
|---|---|
| **Pixel Studio** | Pixel editor restricted to PICO-8: 16 slots mapped to the 32 PICO-8 colors, `fillp()` patterns, a sieve (APaint-style dither mask), brush preview under the cursor, tiled view you can draw across, layers, frames with onion skin, canvases from 1×1 to 1024×1024, `[gfx]` clipboard in/out, `.p8` sprite sheet import, new carts and writing into existing carts |
| **Palette & Fades** | Port of `palette_tool`: custom palettes, dark/bright fade tables, greyscale conversion, Lua/GPL/PNG/.p8 exports |
| **Tile Maker** | Port of `tilemaker`: 8×8 tile packing, VRAM heatmap, tile editor, .p8/Aseprite/PNG exports |
| **Map Editor** | PICO-8 tile maps painted with tiles or blocks of a sprite sheet (library image, `.p8` `__gfx__` or Tile Maker result): draw, rectangle and flood fill, pick, select / copy as brush, undo. 128×32 cart maps, 128×64 with the shared sprite rows, up to 256×256 for raw-byte export. Cart Builder accepts a map part only up to 17,152 bytes; larger maps need splitting outside the current UI. `.p8` import, new cart with viewer, write into an existing cart, map bytes / hex / PNG; maps are library assets and go into Cart Builder projects as `tiles` assets |
| **Code Editor** | PICO-8 Lua editor for the `__lua__` section of a `.p8` (or a `.lua` file): PICO-8 syntax highlighting, API completion and signature hints, auto-indent, find / replace, code tabs (`-->8`), function list, live estimated token / character count. Saves into the cart in Chrome / Edge: just before writing it rereads the file, keeps sprite/map/sound changes made meanwhile in PICO-8 or another tab, and asks (overwrite / reload / cancel) if the file's code itself changed; edits typed during a save stay unsaved. Folders with `#include` followed (tokens counted like Project Audit: repeated includes count each time, `.p8:N` tabs separately, cycles stop); moving to another file of the folder saves the one you leave, and code typed during that save keeps it open (opening other code never drops unsaved edits without asking). **Run** (Ctrl+R) saves and starts the cart in PICO-8 (it stops instead, asking you to Run again, if code was typed during that save, if the save had to go to another file through Save As, or if another file was opened or saved meanwhile; Save As into another file drops the old folder path and include parent) through `tools/pico8_bridge.py` and shows `printh()` output |
| **Minifier** | Open UTF-8 .p8 / .lua files or paste Lua into an unsaved page-only snapshot; compare actual local Shrinko8 output with Minimal + Tokens, read-only views, Cancel and Retry. Original files stay unchanged. Code Editor’s **Cart → Minify…** / **Use current editor** copies unsaved code; **Back to Code Editor** preserves its content, caret, save state and undo history. Later editor changes mark the snapshot earlier. Dedicated exports follow separately |
| **Data Tools** | Ports of `binary_data_converter` (bytes → PICO-8 string literal; library images added as input) and `nibble_converter` (greyscale → hi/lo nibble images) |
| **Project Audit** | Port of `project_audit`: scans a project folder (picked or dropped, read in the browser) for estimated tokens / characters per cart with `#include` expanded, includes in both directions, `load` / `run` / `reload` / `cstore` references, used and unused carts; CSV / JSON export |
| **Cart Builder** | A demo project folder (read/write): adopts its data as assets, packs them into data carts (drag or auto-pack, LZ per part), checks generated cart text before writing and rewrites the `--@data` anchor lines the fx load from. See `docs/PROJECT_MODEL.md` |
| **Data Carts** | Exact reader / writer for the cart data area (0x0000–0x42ff incl. `__sfx__` / `__music__`), memory map per cart with the ranges the project's `reload()` calls read, sections per cart (what each fx cuts out with `mem_store`), viewer in the palette and fade row the fx uses (read from its code and data), hex, fixed-point plots, packer for new data carts (raw or LZ per entry) with generated `reload()` lines |
| **Extra Tools** | Smaller tools behind one tab bar: **LUT Creator** (port of `lut_creator`: 2D motion paths, 3D ball formations incl. OBJ models, slots, `.p8` data cart / Lua / Picotron POD), **Wave Designer** (port of `osc_designer`: 16 scope waveforms → `waves.p8`), **Line Tool** (port of `line_tool`: 128×128 lines → Lua table, pixels → library), **Terrain Lab** (port of `terrain_lab_v0_4`: seamless terrain from noise or an imported heightmap, brushes, text / image / SVG stamps, erosion, terraces and sea level, baked light → 128×128 PICO-8 color map in the best 16/12/8/4 of 32 colors or the live palette of Palette & Fades / Pixel Studio, optionally shaded along their fade tables, + 16-level height map, `.p8` viewer cart, library; history window, status bar, any installed font) |

## Minifier workspace — staged implementation

**Develop → Minifier** now provides the native read-only comparison workspace with real local Shrinko8 integration, **Minimal** profile and **Tokens** focus. Compare / Original / Optimized views, actual same-job counts with savings/increases, budget checks, unavailable reasons and filtered diagnostics use the shared job adapter. Reliable diagnostic locations select the current read-only source line; stale results are labelled. Opening the workspace initializes the engine but never optimizes automatically.

**Open file…** accepts UTF-8 `.p8` / `.lua`; **Paste Lua…** loads a snapshot named `pasted.lua`. Cartridge intake retains the full original text and non-Lua data; the comparison shows Lua. Replacing a snapshot asks first. Cancelled/failed input leaves the current source/result untouched, and import never optimizes or saves automatically. Lua syntax is checked on explicit Optimize. Snapshots are page-only and lost on reload. **Use current editor, Copy optimized Lua and Download remain unavailable** until their roadmap steps; includes and PNG imports are unsupported. See [roadmap #130](https://github.com/Crylhead/Pico8_Suite/issues/130) and [engine packaging/setup](docs/MINIFIER_ENGINE.md).

- [Minifier UI/UX technical specification](docs/MINIFIER_UI_SPEC.md)
- [Minifier navigation icon (SVG)](assets/icons/minifier.svg)

## Run locally

The basic tools have no build step or package installation and can open directly from `index.html`. **Minifier requires HTTP(S) and packaged Shrinko8/Pyodide assets.**

**On Windows, double-click [Start_Pico8_Suite.bat](Start_Pico8_Suite.bat)** (Python 3.9+). On any supported platform you can run:

```sh
python tools/serve_suite.py
```

This optional local launcher verifies the runtime files, prepares missing/outdated pinned assets, starts a static server on `127.0.0.1:8000` and opens Minifier. Keep its window open; Ctrl+C stops it. First setup needs Internet or the two pinned local archives; valid installed assets are reused offline. It does not start PICO-8 or its Run bridge. Browser-hosted copies need no Python service.

**Browser Library/session data is separate for file:// and localhost.** Export a Library backup from the old address and import it at the new one; it does not move automatically. Keep using the same host and port. A busy port stops startup without opening another service or choosing a new origin. You can explicitly choose a stable alternative with `python tools/serve_suite.py --port 8001`; `--no-browser` prints the URL only. Offline setup accepts `--shrinko-archive /path/shrinko8-pinned.tar.gz --pyodide-archive /path/pyodide-314.0.7.tgz` ([pins/setup](docs/MINIFIER_ENGINE.md)).

For basic tools, or when runtime assets are already packaged, you can still serve the repository root manually:

```sh
python -m http.server 8000 --bind 127.0.0.1
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Keep using the same host and port: browser storage belongs to that origin. Chrome or Edge is needed for Cart Builder's writable folder access and Code Editor's in-place saves; other browsers can use supported import/download workflows. Clipboard, folder access and installed-font features depend on browser permissions and a secure context (localhost or HTTPS). Browser restrictions can prevent writing protected folders such as `AppData`; use a separate working copy of your demo.

**Run in PICO-8** is optional and needs your own PICO-8 installation plus Python 3:

```sh
python tools/pico8_bridge.py --pico8 "C:/path/to/pico8.exe" --root "C:/path/to/demo"
```

On Windows, double-click `tools/run_pico8_bridge.bat` for auto-detection. Keep the helper window open while using Run. It listens on `127.0.0.1:8708` and prints a random **pairing token** each time it starts: in the Code Editor choose *Cart → Set Up Run…*, paste the token and press **Pair** (once per bridge session; the token is kept only for that browser tab's session). Without a valid token the bridge refuses to run, stop or report output, and its status reply omits local paths. It also requires the `Host` to be `127.0.0.1:<port>` or `localhost:<port>` and accepts browser origins only from a local file (`null`/`file://`) or `http(s)://localhost` / `http(s)://127.0.0.1` on any port, so not an arbitrary hosted HTTPS page. Loopback binding and this origin filter are defense in depth, not authentication; the token is. It searches PICO-8's carts folder and each `--root`; unmatched carts run from a temporary copy under `_suite_run/`, where neighboring includes/data carts may be missing.

The app can be hosted on a static server for the browser tools. A remote host does not make the local Run helper available automatically. Development checks use Node.js and Python; see [CONTRIBUTING.md](CONTRIBUTING.md).

## How the tools talk to each other

- **Live palettes**: Palette & Fades and Pixel Studio publish the palette (and fade tables) they have open (`Suite.registerPaletteSource`); Terrain Lab's PICO-8 view reads them directly, without a trip through the library.
- **Library** (top right): every saved image, palette and map, stored in the browser (IndexedDB) and synced between open tabs. Click an asset to open it in any tool that can use it, or drag its thumbnail onto a tool's canvas.
- An image asset holds palette **slots** (0–15 per pixel), the **screen palette** (slot → one of the 32 PICO-8 colors) and the **transparent slot**: the same model as PICO-8 memory + `pal()` / `palt()`. Pixel Studio images also keep their layers and frames.
- Typical round trips:
  - Pixel Studio → File → Send to → Tile Maker, then Export → Tile Sprite Sheet → Library → open the sheet in Pixel Studio.
  - Palette & Fades palette → Pixel Studio palette panel → *From Palette & Fades* (or save it to the library).
  - Any library image → Data Tools → string literal for your cart.
- **Back up** with Library → Export Library Backup (one JSON file of saved assets). This does not include every tool's working session, settings or project-folder files. Export before changing host/port/browser or clearing site data. When IndexedDB is unavailable at startup the session is memory-only (a warning appears and the Library says so). If a browser-storage save fails (for example storage is full), the suite reports it and leaves the work unsaved so you can free space and retry, or export/download it.

## Files

- `index.html`: shell, all workspaces, in-app documentation (F1)
- `css/style.css`: base styles and the Palette / Tile Maker layouts (from `palette_tool_web`)
- `css/suite.css`: library, Home, Pixel Studio and Data Tools
- `js/core.js`, `js/app.js`: palette logic and the shell (workspaces, menus, dialogs, `window.P8App`)
- `js/suite.js`: asset library, "Open in…" registry, asset picker, Home page (`window.Suite`)
- `js/tiles-core.js`, `js/tiles.js`: Tile Maker
- `js/studio-core.js`, `js/studio.js`: Pixel Studio (pure logic / UI)
- `js/map-core.js`, `js/map.js`: Map Editor (pure logic / UI)
- `js/code-core.js`, `js/code.js`: Code Editor (pure logic / UI)
- `js/datatools.js`: Data Tools
- `js/doc-status-core.js`: shared save / operation status contract and status badge (`P8DocStatus`; Map Editor uses it, see EXTENDING.md)
- `js/ux-prefs-core.js`: shared UX preferences (`P8Prefs`: help detail, tours, compact workspace bar, reduced motion) behind Help › Settings…, see EXTENDING.md
- `js/audit-core.js`, `js/audit.js`: Project Audit (pure logic / UI)
- `js/extras-core.js`, `js/extras.js`: Extra Tools (pure logic / UI)
- `js/terrain-core.js`, `js/terrain.js`: Terrain Lab engine (runs in two Web Workers and in Node) / UI, a tab of Extra Tools
- `docs/ACCESSIBILITY.md`: shared keyboard/focus/dialog behavior, measured contrast and target sizes, known canvas limitations and the manual keyboard regression script
- `docs/COMPRESSION.md`: which data cart compression the suite offers, and the PICO-8 measurements behind it
- `docs/DESIGN_SYSTEM.md`: shared UI tokens (colour, spacing, type, focus, states) and component primitives, with the live reference page `docs/design-system.html`
- `js/project-core.js`, `js/project.js`: demo projects, anchors, packing (pure logic) / Cart Builder UI
- `js/datacarts-core.js`: sections and palettes of data carts, read from the fx code (pure logic)
- `js/cart-core.js`, `js/datacarts.js`: .p8 data area reader / writer, `reload()` analysis, LZ codec (pure logic) / Data Carts UI
- `tools/pico8_bridge.py`, `tools/run_pico8_bridge.bat`: optional local PICO-8 launcher
- `tests/regress.js`: six focused regression checks
- `EXTENDING.md`: how to add a tool
- `CONTRIBUTING.md`: setup, checks and focused agent/collaborator workflow

## Changes compared to `palette_tool_web`

- New workspaces: Home, Pixel Studio, Data Tools. Menus and shortcuts now belong to a workspace (`data-show`, `P8App.registerShortcuts`).
- Palette & Fades: preview image from the library, palette and preview image to the library.
- Tile Maker: import from the library (picker or drag & drop), sprite sheet and reconstructed image to the library.
- PNG export (`P8.encodeIndexedPng`) can write a transparent color.
- Dialog action buttons can close their dialog with `dlg.finish(value)`.

## UI/UX roadmap and agent work packages

The [UI/UX development plan](docs/UX_DEVELOPMENT_PLAN.md) defines the Suite's product design philosophy, shared acceptance criteria, staged experience improvements, a living documentation/help contract, optional tooltips and versioned onboarding, and user-controlled diagnostic/bug-reporting workflows. Its [18 focused issues](docs/UX_DEVELOPMENT_PLAN.md#github-work-package-index-18-independently-assignable-issues) can be assigned to coding agents with explicit dependencies and exclusions. This roadmap preserves expert features, PICO-8 compatibility, standalone tool usage and the zero-build architecture. The #40–#44 correctness fixes have merged; current correctness follow-ups are tracked separately from the UX backlog in the latest review below.

## Reviews and current work

The [2026-11-03 UI/UX source review](docs/UX_REVIEW_2026-11-03.md) investigates Pixel Studio preview scales, tour coverage for each workspace/subtool, contextual help, optional tooltips and current onboarding inconsistencies. New independently scoped issues [#102–#111](https://github.com/Crylhead/Pico8_Suite/issues?q=is%3Aissue+is%3Aopen+UX) are ordered by severity, with reproducible evidence and acceptance checks. This is a source audit, not a claim of full runtime/browser verification.

Start with the [2026-11-03 integrated review](docs/HEALTH_REVIEW_2026-11-03_fd31e3c.md), reviewed at [fd31e3cbfdc77d0944cdc1966883282807f452de](https://github.com/Crylhead/Pico8_Suite/commit/fd31e3cbfdc77d0944cdc1966883282807f452de). Original issues #1–#14 and follow-ups #30–#35/#40–#44 have merged fixes. Six new findings are tracked as [#80–#85](https://github.com/Crylhead/Pico8_Suite/issues): Pixel Studio save identity/revisions, unguarded map replacement, unsafe list-helper assumptions, stale folder/Run context, import cancellation changing palettes, and diagnostics metadata privacy. Prioritize #80–#82. Each issue includes evidence and focused acceptance checks. The [third](docs/HEALTH_REVIEW_2026-11-02_72f6e02.md), [second](docs/HEALTH_REVIEW_2026-11-01_ca36c07.md) and [initial](docs/HEALTH_REVIEW_2026-11-01.md) reviews retain their historical source SHAs.

The earlier reviews remain in Demotools, not this repository. Their [historical index](https://github.com/Crylhead/Demotools/blob/4a2855b99efb2e7a265961c63f1ac809adea3ed2/reviews/README.md) includes the health reassessment, Tile Maker reconstruction plan and permanent **Send to + Library** UX proposal. Those are historical findings/design proposals. The current Suite has registry-backed Send to actions; a permanent Asset Dock/Output Shelf remains a separate proposal.

Every new review should record the full source commit SHA, methods, results and validation limits. Record fix commits separately; do not change the reviewed SHA.

## Testing

Run the committed regression entry point from the repository root:

```sh
node tests/regress.js
```

On 2026-11-03 the integrated review ran **205 JavaScript regressions and five Python bridge tests**, all passing. Every `js/*.js` passed `node --check`, the bridge passed syntax compilation, and static HTML checks passed (402 unique IDs, 43 local script/style references). [GitHub Actions](.github/workflows/ci.yml) runs these checks on PRs and pushes to `main`. Additional core/actual-function probes reproduced #80–#85, so passing tests does not establish complete coverage. This review could not run browser checks because the executable was absent; Windows and PICO-8 runtime checks were not performed. Earlier contributors' browser walkthroughs are documented separately in the [UX changelog](docs/UX_CHANGELOG.md). See [CONTRIBUTING.md](CONTRIBUTING.md) for commands and the [current review](docs/HEALTH_REVIEW_2026-11-03_fd31e3c.md) for evidence and limits.

### Minifier engine foundation

[Engine, adapter and workspace documentation](docs/MINIFIER_ENGINE.md) covers the pinned Shrinko8/Pyodide module worker, local asset packaging, real `.lua`/`.p8` fixtures and browser results. The native workspace shell is implemented; remaining workflows follow [roadmap #130](https://github.com/Crylhead/Pico8_Suite/issues/130). Package assets with `python tools/package_minifier.py` before using the Minifier engine or running real-engine checks; the other Suite tools need no packaging step.

### Historical validation reports

The following reports were inherited from development in Demotools. Their complete fixtures, browser automation and PICO-8 benchmarks are not included here and were **not rerun** for the standalone repository review. They are historical evidence, not a current clean bill of health.

- `studio-core.js` (clipboard format, cart reading/writing, sprite layout, raster primitives) was reported covered by a Node test script used during development; that full script is not included here.
- The UI flows (drawing, selection, layers, frames, undo/redo, dialogs, paste, session restore, library round trips across all tools, light/dark theme, phone width) were run in headless Chrome without console errors.
- `cart-core.js` was checked against PICO-8 0.2.7 itself: all 113 `.p8` files of the Modulator and Nuova standalone demos read to the same bytes PICO-8 loads with `reload()`, and the same carts rewritten by `writeP8()` load identically (226/226). A pack made in the browser (raw + LZ entries) was read back in PICO-8 and matched the source carts.
- `terrain-core.js` gives the same heights as `terrain_lab_v0_4` bit for bit (512 and 1024, with and without erosion, on the v0.4 sample scene). In Chrome, against v0.4 at 512 with a mixed erosion pass: a light change reaches the final render in 0.14 s instead of 0.72 s, a brush stroke 0.10 s after release instead of 0.62 s, a new seed in 0.12 s instead of 0.42 s. The exported `.p8` was read back in PICO-8 (sprite sheet and `hget()` match).
- `extras-core.js` matches the Python tools (waves, motion paths, formations, `.p8` exports byte for byte); `audit-core.js` matches `project_audit` on 69 real carts (except the deliberate `..` token count).
- Not yet checked inside PICO-8 itself: pasting `[gfx]` clipboard text into the sprite editor and running the generated viewer carts. The `__gfx__` text layout matches the Tile Maker carts, which were verified in PICO-8.



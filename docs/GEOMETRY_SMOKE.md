# Cross-workspace geometry smoke (#171)

Use this for shared header, workspace rails, command/status sizing or panel geometry changes. It is opt-in developer tooling, not an application dependency or a default CI browser job. The existing static server/no-build workflow is unchanged. Tests do not establish PICO-8 export/runtime correctness.

## Run with an existing browser setup

`tests/geometry-smoke.mjs` uses Node's built-in HTTP server on an ephemeral loopback port, an **already available** Playwright module and Chromium/browser executable. It installs and downloads nothing. If those are unavailable, use the manual matrix below and report the gap.

```sh
node tests/geometry-smoke.mjs --help
node tests/geometry-smoke.mjs --out ../geometry-before --screenshots
# After an implementation change, using the same browser/OS/fonts:
node tests/geometry-smoke.mjs --out ../geometry-after --baseline ../geometry-before/geometry.json --screenshots
```

If the module or browser lives outside the repository, point to it rather than adding a package/build system. For example in PowerShell (replace the paths with existing installations):

```powershell
$env:P8_GEOMETRY_PLAYWRIGHT = 'C:\existing-tools\node_modules\playwright'
$env:P8_GEOMETRY_BROWSER_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/geometry-smoke.mjs --out ..\geometry-before --screenshots
```

Bash uses `P8_GEOMETRY_PLAYWRIGHT=/existing/node_modules/playwright P8_GEOMETRY_BROWSER_EXECUTABLE=/existing/chromium node tests/geometry-smoke.mjs ...`. `P8_GEOMETRY_BROWSER_ARGS` optionally accepts a JSON array of browser flags for a configured environment; they must support multiple isolated contexts (avoid single-process mode). Do not reuse a signed-in browser profile. The runner creates nonpersistent, isolated browser contexts; project/image/Lua fixtures remain local to them and no user project directory is opened or written. It closes the browser/server even on failure.

Without `--out`, output goes to a new OS temporary directory (printed at completion). `geometry.json` records browser version, checkout commit, scenario metadata, rectangles, page errors, engine-phase notes and failures. `--screenshots` adds a 1280px screenshot per tool/context in light/dark (30 captures). Output and baseline directories must differ. Do not commit machine-specific reports, screenshots or browser caches as source fixtures; attach relevant evidence to a review or summarize measured differences.

Exit status is nonzero for setup/browser/page failures, missing coverage, contract violations or baseline differences. A partial report is retained for a failure after server startup. Do not treat a partial or failed report as an accepted baseline.

## Matrix and assertions

One page/window is reused across tool switches and widths for the normal-scale matrix. A second isolated context repeats all tools at doubled device scale for the zoom equivalent. Both contexts load the same deterministic fixture through the actual Code drop and Studio asset-transfer adapters, plus Minifier source intake. A long project name is published through the real project-context API. No modal confirmation is bypassed; unexpected prompts fail setup rather than overwriting anything.

| Axis | Coverage |
| --- | --- |
| Workspaces | All 12 built-ins; Extra Tools expands into LUT, Wave, Line and Terrain (15 contexts total) |
| Normal viewport | 360×900, 768×900, 1280×900, 1920×900 CSS px |
| 200% equivalent | 640×450 CSS px, device scale 2: reflow/pixel density of a 1280×900 window at 200%; not physical browser zoom |
| Appearance/context | Light/dark; no project / long project name; loaded 128×128 image, long Lua filename and Minifier input |
| Repeat | Forward visit then reverse return visit; top-of-page and scroll-to-bottom chrome measurements |

The complete matrix is **600 cases**: 15 contexts × 5 viewport scenarios × 2 themes × 2 project states × 2 visits. Missing built-ins/Terrain or page errors fail. Minifier optimization is not run: the report records its engine phase, including unavailable local optional assets. Use the same pinned runtime availability for baseline comparisons; real-engine correctness belongs to the separate Minifier gate.

Every case measures actual DOMRects for header, brand, tab strip, Find, Library, theme, menu row, main wrapper, command/header/status rows, stages and canvases. Canvas records include bitmap dimensions and visible viewport area. Scrolling checks use the stationary chrome at the bottom of the workspace host; main/content coordinates are recorded at the top. The document must never scroll; desktop panes can correctly have no outer workspace scroll.

| Difference | Rule |
| --- | --- |
| Main widths / rails | Fail deviations from the [fluid or centered contract](DESIGN_SYSTEM.md#workspace-geometry-168), existing 1240/1640px tiers, 16px gutter and mode gaps. Widths use available workspace-host width, including any reserved scrollbar rail. |
| Header/nav movement | Fail >0.5 CSS px changes in x/y/width/height at the same scenario/theme across tools, project states or page scroll. Content must start at the header bottom. Compact hidden tabs are allowed at ≤640px; other primary controls need positive area. |
| Page overflow | Fail root scrolling, a host that does not fill the area below the header, or horizontal host/document overflow >1px. Internal scrollable pixel stages, tab strips and cart rows are permitted. |
| Command/status/header roles | Require visible role rectangles; fail height changes >0.5px on the return visit in the same context. Different tools may have different row counts/heights (Studio has two options rows). Sizes follow the [shared bar contract](DESIGN_SYSTEM.md#workspace-bar-roles-169), including explicit expanded regions. |
| Stages / canvases | Record geometry and visible area; specialized pan/zoom, aspect and internal scroll remain tool-owned. A baseline comparison flags rectangle changes for review; it does not compare animated pixel content. The [panel breakpoint audit](#panel-breakpoint-audit-170) exercises saved/collapsed states separately. |
| Saved baseline | `--baseline` compares every matching scenario/theme/project/tool/subtool/visit. Changed chrome, row, stage or canvas rectangles, or missing/extra cases, fail. |

The default checks catch current-contract violations and within-run jitter. The saved baseline additionally catches a consistent change across revisions (for example every toolbar growing by 4px). Baselines are environment-specific, not universal golden screenshots. Review intentional changes against their issue and design contract, then capture a new accepted baseline; do not silently widen tolerance or bless a failed run. The normal regression harness also checks the validator with deliberately moved navigation, changed bars/canvases, overflow and missing coverage.

## Manual fallback and physical zoom

Use a disposable/incognito session on a separate local origin. Load an image and Lua source with long names; select a disposable project, then clear/reselect it. Keep the same window while visiting Home → Studio → Code → Palette → Minifier → Map → Tile → Cart Packer → Cart Inspector → Audit → Converters → all Extra Tools tabs, and then return in reverse order.

At 360/768/1280/1536/1920 CSS px, in both themes, record the controls/rows above with DevTools `getBoundingClientRect()` or before/after screenshots. Compare at identical viewport and scroll positions. Scroll a dashboard to the bottom, return to an editor and check the shared chrome/scrollbar rail stays put. Check each stage remains useful and all primary actions can be reached by scrolling/keyboard. Open the rightmost menu and a long menu in a short window; its final item and Escape return must remain reachable.

Editor view on resize (#200): in Pixel Studio and Map Editor, load at 1440×900, resize the window to 390×844 and back. Without a manual zoom or pan the document refits both ways, centered with a margin. After a manual zoom or pan, zoom is kept, and pan is kept unless the document would cover less than half of the stage (then it is pulled back). **Fit** (`0`) makes the view automatic again.

Repeat at **physical 200% browser zoom**, including a short window. Record the actual CSS viewport (`innerWidth`/`innerHeight`) and zoom separately. If only the automated reflow equivalent was run, say so; it does not cover native browser zoom, OS font differences, touch, or physical scrollbar behavior. For an unexpected difference, record the viewport/theme/project state/tool, DOMRects, screenshot and console errors before expanding the fix.


## Recorded validation

2026-11-04, Chromium 153.0.8010.0 on Linux/headless, application base `eee00e4`: the 600-case capture and a second 600-case run against that saved baseline both passed with zero differences, page errors or fixture mutations. All 30 light/dark screenshots were captured; representative Home/Studio/Terrain views were inspected. A real-page CSS injection moving Find by 12px and another increasing Studio command-row height were both detected. The normal harness passed 346 tests, including three validator/baseline regressions; missing-module and baseline-overwrite error paths also passed. Physical browser zoom and native Windows/macOS were not exercised.


## Panel breakpoint audit (#170)

With the same existing `P8_GEOMETRY_*` browser configuration, run:

```sh
node tests/panel-breakpoints.mjs --out ../panel-geometry
```

This reuses the geometry server, loaded Code/Studio/Minifier fixtures and measurement routine; no new dependency is required. It writes `panels.json` plus screenshots at representative desktop boundaries. Default coverage: **832 cases** (eight tools, 25 widths, two themes and two return visits, plus the 640×450/device-scale-2 case), six collapsed/reload/resize-back transitions and eight default-preset assertions. The tools are Studio, Map, Terrain, Code, Minifier, Audit, Cart Packer and Cart Inspector. Widths include 320/360/768/1280 and minus/at/plus 1 around 640/699/860/900/1000/1100/1200px.

Actual side/center rectangles are sampled over six frames to detect resize feedback. Checks cover the 320px desktop center track, unchanged stored preference under viewport clamps, return-visit widths, expected workspace/pane scrolling and horizontal overflow. Loaded documents must remain unchanged before deliberate reloads. Primary Studio/Map bitmap/display scale ratios must match within 0.01 (fractional pixel rounding). The real separators exercise collapse, stacked visibility/inert state, reload persistence, resize-back, keyboard reset and `resetAll`; CSS defaults are checked at Studio 1100/1101 and Minifier 1199/1200. The normal regression harness separately tests content-width/bounds arithmetic and storage failure cases.

Manual fallback: repeat those adjacent widths in one disposable window, drag/keyboard-resize each available splitter, hide the panel, narrow until it stacks, reload and widen again. The controls must stay available while stacked and the chosen width/collapse must return on desktop. Reset on both sides of the breakpoint; narrow and widen after reset to check the CSS defaults. Scroll the workspace and individual panes to the final action, checking that a desktop editor does not gain a root page scroller. At 320px visit each Extra Tool and select the wrapped tabs by keyboard. Inspect a loaded square image/map through the resize and record rectangles/screenshots. Repeat at physical 200% browser zoom when available; the automated case only emulates reflow/pixel density. Use the [recorded comparison](UX_RELEASE_CHECKLIST.md#panel-breakpoint-stability-170) as a reference, not a platform-independent golden image.

Version 2 reports enforce #180: the root cannot scroll, the outer scrollbar starts below both app bars, and width measurements use the host client width. Version 1 reports encode the superseded document-scroll model and cannot be used as baselines. The matrix also includes a 1536×712 CSS viewport at 1.25 device scale to approximate the supplied screenshots; this is not a physical OS/browser zoom test.

Interaction check: `node tests/workspace-scroll.mjs` uses the same `P8_GEOMETRY_*` configuration. It checks header paging, first visits, per-tool and Extra Tools offsets, and unchanged fixture documents.

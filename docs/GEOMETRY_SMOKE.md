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

Every case measures actual DOMRects for header, brand, tab strip, Find, Library, theme, menu row, main wrapper, command/header/status rows, stages and canvases. Canvas records include bitmap dimensions and visible viewport area. Scrolling checks use the sticky chrome at the bottom of the document; main/content coordinates are recorded at the top. Pane-scroll tools can correctly have no document scroll.

| Difference | Rule |
| --- | --- |
| Main widths / rails | Fail deviations from the [fluid or centered contract](DESIGN_SYSTEM.md#workspace-geometry-168), existing 1240/1640px tiers, 16px gutter and mode gaps. Widths use available document width, including any reserved scrollbar rail. |
| Header/nav movement | Fail >0.5 CSS px changes in x/y/width/height at the same scenario/theme across tools, project states or page scroll. Content must start at the header bottom. Compact hidden tabs are allowed at ≤640px; other primary controls need positive area. |
| Page overflow | Fail horizontal document overflow >1px. Internal scrollable pixel stages, tab strips and cart rows are permitted. |
| Command/status/header roles | Require visible role rectangles; fail height changes >0.5px on the return visit in the same context. Different tools may have different row counts/heights (Studio has two options rows). Cross-tool token normalization remains #169. |
| Stages / canvases | Record geometry and visible area; specialized pan/zoom, aspect and internal scroll remain tool-owned. A baseline comparison flags rectangle changes for review; it does not compare animated pixel content. The broader breakpoint/panel-state audit remains #170. |
| Saved baseline | `--baseline` compares every matching scenario/theme/project/tool/subtool/visit. Changed chrome, row, stage or canvas rectangles, or missing/extra cases, fail. |

The default checks catch current-contract violations and within-run jitter. The saved baseline additionally catches a consistent change across revisions (for example every toolbar growing by 4px). Baselines are environment-specific, not universal golden screenshots. Review intentional changes against their issue and design contract, then capture a new accepted baseline; do not silently widen tolerance or bless a failed run. The normal regression harness also checks the validator with deliberately moved navigation, changed bars/canvases, overflow and missing coverage.

## Manual fallback and physical zoom

Use a disposable/incognito session on a separate local origin. Load an image and Lua source with long names; select a disposable project, then clear/reselect it. Keep the same window while visiting Home → Studio → Code → Palette → Minifier → Map → Tile → Cart Builder → Data Carts → Audit → Data Tools → all Extra Tools tabs, and then return in reverse order.

At 360/768/1280/1920 CSS px, in both themes, record the controls/rows above with DevTools `getBoundingClientRect()` or before/after screenshots. Compare at identical viewport and scroll positions. Scroll a dashboard to the bottom, return to an editor and check the shared chrome/scrollbar rail stays put. Check each stage remains useful and all primary actions can be reached by scrolling/keyboard. Open the rightmost menu and a long menu in a short window; its final item and Escape return must remain reachable.

Repeat at **physical 200% browser zoom**, including a short window. Record the actual CSS viewport (`innerWidth`/`innerHeight`) and zoom separately. If only the automated reflow equivalent was run, say so; it does not cover native browser zoom, OS font differences, touch, or physical scrollbar behavior. For an unexpected difference, record the viewport/theme/project state/tool, DOMRects, screenshot and console errors before expanding the fix.


## Recorded validation

2026-11-04, Chromium 153.0.8010.0 on Linux/headless, application base `eee00e4`: the 600-case capture and a second 600-case run against that saved baseline both passed with zero differences, page errors or fixture mutations. All 30 light/dark screenshots were captured; representative Home/Studio/Terrain views were inspected. A real-page CSS injection moving Find by 12px and another increasing Studio command-row height were both detected. The normal harness passed 346 tests, including three validator/baseline regressions; missing-module and baseline-overwrite error paths also passed. Physical browser zoom and native Windows/macOS were not exercised.

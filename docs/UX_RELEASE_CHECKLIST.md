# UX release checklist

Use this before a release or a larger UX change (see [UX_DEVELOPMENT_PLAN.md](UX_DEVELOPMENT_PLAN.md), Definition of Done). Use a disposable project copy and a supported browser (Chrome or Edge for folder access). Record what you ran and what you could not run; do not claim untested items.

## Automated (offline, no browser)

- `node tests/regress.js` once on the final state. It includes `tests/docs-integrity.test.js`, which fails with an actionable message for: a built-in workspace/subtool without exactly one tour, missing declared tour areas without justified exceptions, a workspace without a help topic, duplicate help/control ids, a `data-help-id` without help text, a tour step or before.click whose stable ID/class/data target no longer has markup/builder evidence (even when optional), is hidden by default or JS-built without `optional`/`conditional`, an unknown `helpId`, or a menu shortcut missing from the help.
- `node tests/check-static.js` when `index.html` ids or script/style references changed.
- A documentation-only change needs only a diff review, link check and `git diff --check`; do not run the full suite for it.

## Optional cross-workspace geometry

For shared layout changes, run [the repeatable browser matrix](GEOMETRY_SMOKE.md) with an available browser setup, or follow its manual fallback. Save the baseline before editing and use `--baseline` for the changed revision; record environment, output summary and intentional differences. This is separate from the default offline checks.

## Adding or changing a tool (same PR)

1. **Help topic** in `js/help-data.js` (`kind: 'tool'`, `ws` = the workspace id): purpose, inputs, outputs, actions, restrictions, shortcuts, related. Bump `rev`.
2. **Stable ids** for controls/actions (`tool.control`); mark essential controls with `data-help-id` only if they should have tooltips. A rename needs an `ALIASES` entry.
3. **Shortcuts:** every shortcut shown in a menu is listed in the topic (or the F1 keyboard section).
4. **Tour:** required for built-in workspaces and Extra Tools tabs (#103/#109), optional for external plugins (`tour: false` explicitly opts out without blocking registration). Use literal ws/sub registration IDs in bundled modules so the audit discovers them. Tag highlighted steps with `areas` covering work, controls, input, output and a safe handoff; document legitimate `areaExceptions` with reasons. Home uses the Suite overview; the Extra Tools overview delegates to subtool tours. Give each step a stable `id`, a non-brittle `target`, `optional`/`conditional` where it can legitimately be absent, and bump the tour `major` only for a meaningful new capability (offers "What's new"); copy edits keep it.
5. `EXTENDING.md` / `docs/` updated if a contract changed; the long-form F1 section updated or its parity noted.

## Human test plan (about 20 minutes)

Run each on the affected surface and note pass/fail; baseline tasks from the UX plan apply.

| Area | Check |
| --- | --- |
| Save / Run | Edit Lua in the Code Editor, Save, Run (with the bridge if available): the saved file is the one that runs; a failed save shows an error, never "Saved". |
| Transfers | Save an image to the Library, Open in another tool; an incompatible target explains why; the Library asset stays unchanged. |
| Permission loss | Revoke folder permission for the active project: the app bar shows "reconnect needed" or "access denied", edits stay in memory, no success message. |
| Onboarding | Clear `p8suite.tours`: the welcome appears once on Home; Start, Skip and "Never auto-offer" behave; Esc ends a tour; Help › Quick tours replays; a renamed/missing target is skipped. |
| Help / tooltips | F1 opens the current tool's topic; search finds a control name; Off hides tips but not labels, errors or warnings. Move slowly from a control through the gap onto its tip and back: it stays open; leaving both closes it unless the control retains focus. Verify keyboard focus on a child control, Esc dismissal without editing/focus changes, live Off/Concise/Detailed changes and canvas painting/dragging. Repeat at 200% zoom and a narrow/short viewport; the tip must not cover the trigger, and F1 provides the text when there is no room. |
| About | Help › About lists the registered workspaces and Extra Tools tabs, labels the web app version and distinguishes the optional local Run bridge. Check offline at 320 CSS px, close with Esc and verify focus returns to the opener. |
| Report preview | Help › Report a problem: review both the text and JSON previews for private information; remove a JSON record and verify the download omits it; Copy exports only the edited text summary; invalid JSON cannot download; GitHub opens only on click. A synthetic error appears in the summary once. |
| Keyboard | Tab through the app bar, menus, dialogs and a tool; focus is visible, option groups use arrow keys, dialogs return focus on close. See `docs/ACCESSIBILITY.md`. |
| Responsive | At 1280, 768 and 320 CSS px and 200% zoom: no lost controls, no horizontal page scroll, dialogs usable. |

## Tour discovery (#108)

1. On Home and in Pixel Studio, use Help › Tour this tool. In Extra Tools select Terrain Lab and repeat; the selected subtool’s tour must start. Close with Esc and verify focus returns to the visible Help menu button. Repeat from a deep link and with automatic offers disabled.
2. On a tool without a tour (only possible for an external plugin since #103), the same action must explain that no tour exists and offer Read Help / Browse Quick tours. Neither choice changes document content.
3. Open Quick tours, search by tool/subject, try a query with no results, clear it and replay a completed tour. Verify progress, Suite overview / Tool tour and Current tool labels. The selector must close before the tour starts. Cancel the selector and verify focus return. At 320 CSS px, the search and Start/Replay buttons must remain usable; repeat in both themes.

## Tool-area tours (#103)

For each tour, start it from its tool with Help › Tour this tool, and once from Help › Quick tours on a different tool. Step through to Finish, then replay and leave with Esc midway. Expected each time: the tour opens its own workspace/tab, highlights the named areas (hidden or not-yet-built areas such as the PICO-8 output, nibble results or a data cart range are skipped), changes no document, selection or file, and focus returns to the opener. Repeat a few tours at 320 CSS px, in both themes and with reduced motion: the card stays whole on screen with Back/Next/Close reachable.

| Tour | Areas to see highlighted |
| --- | --- |
| Palette & Fades | system palette, custom slots, Normal/Ramp, fade generator, gradient preview, fade slider, menu bar (save/export/Library) |
| Tile Maker | import bar, tile reduction, views, viewport heatmap switch, stats, Edit Tiles, Export to PICO-8 |
| Map Editor | tools, name/save badge, Size…, map canvas, tileset, brush, menu bar |
| Code Editor | editor, code tabs, Save, Run, token meter, Files, Functions, Sprites → Pixel Studio |
| Cart Builder | project folder, Add Image, parts, stages, Auto-pack, report, Write Carts |
| Project Audit | Choose Project Folder, carts table, columns, details, Export CSV |
| Data Carts | Open Project Folder, Inspect/Pack, cart list; with a cart open also the memory map, viewer and output buttons |
| Data Tools | Binary → string card, input mode, generated code, nibble card |
| Extra Tools overview | tabs, description, tool area; the panel splitter step appears only while the Terrain Lab tab is selected |
| LUT Creator / Wave Designer / Line Tool | the tab is selected first; preview/stage and controls (Wave: presets, thumbnail strip, scopes, parameter groups) |
| Suite / Minifier | existing overview and source/options/comparison/exports tours |
| Pixel Studio (#105) | tools, canvas/zoom, options/ink, palette/transparency, preview scale, layers, frames (when visible), status and File/Export workflow |
| Terrain Lab (#105) | canvas, mode, terrain/import, generation (Advanced), brushes/stamps, erosion (Advanced), look, status, PICO-8/Library output, full-resolution/scene files (Advanced) |

## Editor-area tours (#105)

1. Replay Pixel Studio with the timeline shown, then hidden. The frame strip is highlighted only when visible; the count explains skipped areas and Back returns to an available target. Keep drawing, active layer/frame, selection, undo history and view settings unchanged while only advancing the tour.
2. Replay Terrain in Simple, then explicitly select Advanced outside the tour and replay. Generation, erosion and scene-file panels appear only in Advanced. The tour must retain that mode, tool, parameters, stamps and passes; it must never import, paint, apply erosion, export or reset. Check Text/Image stamp options are described without changing the selected tool.
3. Use Tab/Shift+Tab, Enter and Escape with optional Help Off. Next/Back/Close stay reachable; Esc closes and restores focus. Complete once, then replay from Quick tours.
4. At 320 CSS px, a 320 px high viewport, light/dark and reduced motion, check each tour card and its buttons remain reachable by scrolling. At 200% zoom (or equivalent 640 CSS px viewport), check no new horizontal overflow or blocked controls.
5. Verify preview Fit/1×/2× wording matches the Preview scale help. Export descriptions distinguish editable Library/scene copies from flattened PNG/.p8 output and Preview from Final. Do not trigger a real export or replace user work just to run a tour.

## Contextual F1 help (#106)

1. In Pixel Studio, focus a Preview scale button or the Transparent select and press F1. Help must focus/scroll to that exact explanation (including detailed text). Esc must return focus to the original control without editing the image. Repeat with optional hints Off.
2. Select each Extra Tools tab (LUT, Wave, Line, Terrain), focus a control without a help ID and press F1. Each opens its own subject. Check a known focused help ID takes precedence, and an unknown ID or an extension without a subtopic falls back safely.
3. Search for another tool, clear the query, browse the index and use Return to the original context. Follow a related topic, then Full documentation: the reference must follow the topic being read. Repeat keyboard-only and at 320 CSS px; help remains local/offline.

## Help detail browser acceptance (#107)

Recorded 2026-11-04 with Chromium 153.0.8010.0 on Linux/headless, using a disposable local session based on `612883a` plus the #107 follow-up. In each workspace, the real Settings dialog ran **Off → Concise → Detailed → Off → Concise**, without reloading. Mouse hover and keyboard focus matched the registry at each level; Detailed included its F1 pointer, Off showed no custom tip, and Escape dismissed a tip without moving focus.

| Workspace | Registry control checked | Authored native title with Off | Reenable result |
| --- | --- | --- | --- |
| Pixel Studio | Ink select/group | Pixel perfect keeps `Pixel perfect (P)` | Full child title restored; no inherited Ink tip over it |
| Tile Maker | Threshold | Disabled Auto Generate Tiles explanation removed | Native explanation restored, custom tip suppressed while disabled |
| Map Editor | Size… | Draw keeps `Draw (B)` | Full native explanation restored; icon name retained |
| Project Audit | Choose Project Folder… | Rescan keeps `F5` | Full native explanation restored |

Additional checks passed: importing/building an 8×8 test image enabled Auto Generate Tiles, after which its native title was claimed and exactly one registry tip appeared; empty-title buttons in Terrain's dynamically built mode group allowed registry help and obeyed Off; the live Map fit status survived preference changes; a tap on the already-selected Pixel Studio Preview radio supplied a hint in Concise and none in Off; icon names and Preview F1 help remained available. No browser JavaScript errors occurred. Focused regressions cover disabled controls, a control disabled during the delay, nested native ownership and empty-title builders.

These checks inspect actual browser DOM/title state and custom popovers; operating-system native-tooltip pixels were not captured. Touch was browser-emulated. Physical touch devices and other browser engines remain untested. This record completes the outstanding #154 browser follow-up and documents the two overlap fixes; it does not claim the broader #110 all-control walkthrough.

## Contextual help on primary controls (#110)

With Help detail Concise, hover and keyboard-focus one marked control per workspace and check that exactly one tooltip appears (no browser tooltip beside it) and that it matches F1: Pixel Studio Ink, Sieve, Remap…, Layers; Palette & Fades Normal/Ramp, Dark/Bright, Auto Fill, Gamma, fade slider; Tile Maker Import Image…, threshold, Rebuild, view switch, Edit Tiles…; Map Editor Size…, Reload tileset; Code Editor Run, Save, token meter; Data Tools Convert, Image File…; Project Audit Choose Project Folder…, columns, details view; Data Carts Inspect/Pack, Show as; Cart Builder stages and a part’s Move…; Extra Tools LUT type, Wave Export waves.p8, Line Export Lua…, Terrain Simple/Advanced and the Terrain splitter. Switch to Off: none of these tips appears and every control keeps its name. Switch to Detailed: the same text plus the F1 pointer.

## Pixel Studio preview scale (#102)

On disposable images sized 64×64, 128×128 (including the default sheet), 256×256, 128×256 and 1024×512:

1. Compare **Fit / 1× / 2×**. Fixed modes must display exactly the source dimensions multiplied by 1 or 2, as shown in the readout; larger images scroll instead of shrinking. Fit must show the whole image and use integer enlargement when possible.
2. Resize the side panel and repeat at 1280, 768 and 320 CSS px and 200% browser zoom, in dark and light themes. Fit must recalculate, fixed scales must stay unchanged, and the page must not gain horizontal overflow from the preview.
3. Tab to the scale group and use arrow keys to change modes. Tab to the preview and scroll with arrow/Page/Home/End keys, including with a canvas selection active; selection pixels must stay unchanged. Reload to check the selected mode persists; legacy stored `previewScale: 0` selects Fit.
4. Paint, toggle a layer, change frames and play animation. Verify the preview follows the current composite, retains transparency background behavior and stays sharp at 1×/2×. Changing preview scale must not change main-canvas zoom or document pixels.
5. Focus the scale group with optional help enabled, search F1 for Preview scale and replay the Pixel Studio tour; all must describe the same Fit/1×/2× behavior.

## Cart Builder viewport (#167)

At 360/768/1280/1920 CSS px, compare Cart Builder → Data Carts → Code Editor → Cart Builder in one window. Above 1000px, Cart Builder fills the viewport below the same header; at/below 1000px it deliberately uses document scrolling. With many parts and report rows, scroll Parts and the main report independently on desktop, reach the final action by keyboard, and check that the horizontal cart row keeps 430px charts. In narrow mode, Parts caps at 240px and document scrolling reaches the main report. Repeat in light/dark, a short viewport and a 640 CSS px reflow viewport (equivalent layout width to 200% zoom of 1280px).

Quick browser-console regression assertions after each switch/resize:

```js
P8App.setWorkspace('cartbuilder');
await new Promise(requestAnimationFrame);
const body = getComputedStyle(document.body);
const main = document.querySelector('main[data-ws="cartbuilder"]');
console.assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Unexpected page overflow');
if (innerWidth > 1000) {
  console.assert(body.display === 'flex' && body.overflowY === 'hidden', 'Desktop scroll owner');
  console.assert(Math.abs(main.getBoundingClientRect().bottom - innerHeight) <= 1, 'Grid must fill viewport');
} else {
  console.assert(body.display === 'block' && body.overflowY === 'visible', 'Document scroll owner');
}
```

Recorded 2026-11-04, Chromium 153.0.8010.0 on Linux/headless, base `62cdbdd` plus the fix. Empty workspace measurements at 800px viewport height:

| Width | Cart Builder height before → after | Result |
| --- | --- | --- |
| 360 | 711.11 → 711.11px | Document scrolling retained |
| 768 | 446.36 → 446.36px | Document scrolling retained |
| 1280 | 228.92 → 721.16px | Now matches Data Carts / Code viewport fill |
| 1920 | 228.92 → 721.16px | Now matches Data Carts / Code viewport fill |

Four empty cases and ten populated light/dark cases passed DOMRect/scroll assertions, plus a 1280×420 short-viewport check. At fixed widths, repeated switches kept header height/width and content top within 1px. Parts and main scroll positions were independent; last report actions remained focus-reachable; charts stayed 430px high; no page horizontal overflow or browser errors occurred. Populated cases used passive layout fixtures with the real classes (60 parts, 16 charts, 45 report rows), not project writes or packing verification. Screenshots were compared before/after. Physical browser zoom, native Windows scrollbars and other engines remain untested; the 640px case verifies equivalent CSS reflow width.

## Preview-frame alignment (#172)

Compare Tile Maker and Palette & Fades at 360/768/1280/1920 CSS px, in light/dark, first empty and then with a portrait image. Include long captions and the extra greyscale-settings block. In Tile Maker, compared image frames must share caption/frame rows; above 1100px the native-width sheet's outer frame shares their top/bottom edges. Below that breakpoint it gets a separate bounded frame. Focus the tileset region and use PageDown/arrow keys when it overflows. Its canvas must retain its display pixel scale. In Palette, side-by-side card borders and square-window edges must align even when one has extra settings; on phones the cards stack and controls wrap. Drag a loaded portrait/landscape preview to verify existing panning, and check Pixel Studio's separate 192px sidebar remains unchanged.

Recorded 2026-11-04, Chromium 153.0.8010.0 on Linux/headless, base `408f4de` plus the fix: 32 before and 32 after cases (two workspaces × four widths × two themes × empty/loaded), with screenshot captures and representative visual comparison. Loaded cases imported a deterministic 128×256 PNG through the actual tool controls. Long caption text and the visible extra-settings block were layout fixtures; no conversion or packing code was changed.

| Loaded, long-caption case | Before | After |
| --- | --- | --- |
| Tile Maker at 1280px | Original/Reconstructed tops differed by 17.4px; native sheet frame was 512px high | All frame tops/bottoms align; 463px comparison/frame height, native canvas width still 256px |
| Tile Maker at 1920px | Comparison height 527.5px vs 512px sheet frame | Shared frame height 643px, with the native-width sheet column retained |
| Palette at 768/1280/1920px | Square-window tops differed by 20.3px | Window tops/bottoms and card heights match |
| Phone layouts | Separate stacked views | Stacking retained; square windows and wrapped actions remain within the page |

After-case DOMRect assertions passed for square comparisons, paired-frame edges, native tileset canvas dimensions, non-distorted Palette pixel scale, control bounds and page overflow. Keyboard scrolling of the sheet passed. A separate four-color Palette import verified that portrait panning changes the displayed pixels, its phone window stays square, and the Pixel Studio sidebar remains 192px. No browser JavaScript errors occurred. Other browser engines, physical touch and older browsers without CSS subgrid remain untested.

## Handoff

State exactly which automated checks ran and which human rows were covered; list gaps once (for example "no PICO-8 available", "touch not tested").


## Workspace geometry (#168)

Recorded 2026-11-04, Chromium 153.0.8010.0 on Linux/headless, base `574443f` plus this fix. Compare each tool at the same viewport/theme, with tours and tooltips off. Check wrapper edges independently of tool-specific card padding. At 1920px the regular dashboard wrapper is x=340/width=1240, the wide dashboard is x=140/width=1640, and the fluid wrapper is x=0/width=1920; the first content rails are respectively 356, 156 and 16px.

| Workspace / screenshot comparison | Before → after outer padding (top/right/bottom/left) | Before → after outer gap | Width behavior |
| --- | --- | --- | --- |
| Home | 22/16/40/16 → 16/16/16/16 | 22 → 16 | Centered 1240px, unchanged |
| Palette & Fades | 16 all → 16 all | 16 → 16 | Centered 1640px, unchanged |
| Tile Maker | 16 all → 16 all | 16 → 16 | Centered 1640px, unchanged |
| Data Tools | 16 all → 16 all | 16 → 16 | Centered 1240px, unchanged |
| Pixel Studio | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Map Editor | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Code Editor | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Minifier | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Project Audit | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Cart Builder | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Data Carts | 10 all → 16 all | 10 → 10 | Fluid, unchanged |
| Extra Tools: LUT / Wave / Line / Terrain | 10 all → 16 all | 10 → 10 | Fluid, unchanged |

Baseline: 75 measured cases (15 contexts × 360/640/768/1280/1920px, light). Final: 150 cases (same widths, light/dark). Each final case checks mode, centering/width ceiling, four gutters, gap and absence of horizontal page overflow. Before/after screenshots at 1280×900/light were compared across every built-in workspace and all four Extra Tools tabs; narrow final screenshots at 360×900/dark also checked stacking. Home becomes slightly more compact vertically; editors move their cards 6px inward, with useful stages still filling the remaining area. Existing dashboard ceilings and specialized grids remain intact.

A further 15-context pass at 640×450 CSS px and device scale 2 checks the reflow/pixel-density equivalent of a 1280×900 window at 200% zoom. It passes the same geometry and horizontal-overflow assertions. This emulates doubled-scale reflow; physical browser zoom and native Windows/macOS were not exercised.

Pixel Studio, Map and Terrain keyboard separators were resized, collapsed, switched away/back, restored and reset: chosen widths and collapse survive the switch. Code source, Pixel Studio document and a loaded/optimized Minifier input remained unchanged after switching. Rendering/packing algorithms and canvas scaling were not modified. To repeat manually, load representative assets, visit all contexts at the widths above, resize/collapse panels and scroll the existing panes; at 200% zoom confirm the last action is reachable and pixel content keeps its aspect.


## Shared header geometry (#166)

Recorded 2026-11-04 with Chromium 153.0.8010.0 on Linux/headless, base `6366d75` plus this fix. Baseline: 216 cases (12 workspaces × six widths × absent/short/long project context). Final: 432 cases including light/dark, a loaded Lua file with a long filename, and a long preset context fixture alongside the project/indices controls. Project changes use the real project-context publisher. Every final case compares actual x/y/width/height of the header, brand, navigation, Find tool, Library, theme and menu row to the same-width/theme reference, with 0.5px tolerance; all pass. No horizontal page overflow or page errors; source remains unchanged after switching. Every main wrapper starts at the measured header bottom. A separate 36-case 768px run with browser scrollbar hiding disabled also passes at 82px.

| CSS viewport width | Baseline total header height range (px) | Final height (px) |
| --- | --- | --- |
| 360 | 77.14–150.28 | 134 |
| 640 | 77.14–79.14 | 134 |
| 768 | 160.33–162.33 | 82 |
| 1280 | 78.84–80.84 | 82 |
| 1440 | 78.84–80.84 | 82 |
| 1920 | 78.84–127.14 | 82 |

The compact mode intentionally reserves two menu lines plus a context line even for Home; at 640px this uses more height than before, keeping switches stable without clipping menus/context. Desktop navigation no longer competes with project text, and the 768px strip scrolls within its slot instead of pushing navigation into extra rows. Before/after screenshots compared Home, Studio and Palette at 360/768/1280px. The root scrollbar gutter reserves 15px in this browser; layout is relative to document content width. Overlay scrollbar systems can reserve zero.

A further 72 cases (all tools × three project states × both themes) at 640×450 CSS px/device scale 2 pass the same assertions: the layout/pixel-density equivalent of a 1280×900 window at 200% zoom. Physical browser zoom and native Windows/macOS were not exercised.

All visible menus in all 12 workspaces were opened by keyboard at 360×900, 768×900, 1280×900 and 640×450: popovers fit within the page with an 8px inset, their lists scroll in short viewports, and Escape restores button focus. Home/End, neighbouring-menu arrows, refit of an open menu after resize, Ctrl+K → Terrain, theme toggle, Library open/close and workspace-tab arrow selection passed. Library's own Close button is used while its drawer overlays the header.

To repeat manually, switch Home → Studio → Code → Palette → Minifier → the remaining tools at each width. Use a long project/preset/file name; toggle project presence and compare header controls/content top. Scroll a dashboard then switch back to an editor: the reserved scrollbar rail must keep the header x positions stable. At 200% zoom, open menus near the right edge, scroll to their final item, Escape back to the trigger, and reach Find tool/Library/theme by keyboard. Preserve the workspace and command-row contracts documented separately in this file.

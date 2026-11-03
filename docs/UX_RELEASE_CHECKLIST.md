# UX release checklist

Use this before a release or a larger UX change (see [UX_DEVELOPMENT_PLAN.md](UX_DEVELOPMENT_PLAN.md), Definition of Done). Use a disposable project copy and a supported browser (Chrome or Edge for folder access). Record what you ran and what you could not run; do not claim untested items.

## Automated (offline, no browser)

- `node tests/regress.js` once on the final state. It includes `tests/docs-integrity.test.js`, which fails with an actionable message for: a built-in workspace/subtool without exactly one tour, missing declared tour areas without justified exceptions, a workspace without a help topic, duplicate help/control ids, a `data-help-id` without help text, a tour step or before.click whose stable ID/class/data target no longer has markup/builder evidence (even when optional), is hidden by default or JS-built without `optional`/`conditional`, an unknown `helpId`, or a menu shortcut missing from the help.
- `node tests/check-static.js` when `index.html` ids or script/style references changed.
- A documentation-only change needs only a diff review, link check and `git diff --check`; do not run the full suite for it.

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
| Extra Tools overview | tabs, description, tool area, panel splitter (wide screens) |
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

## Contextual help on primary controls (#110)

With Help detail Concise, hover and keyboard-focus one marked control per workspace and check that exactly one tooltip appears (no browser tooltip beside it) and that it matches F1: Pixel Studio Ink, Sieve, Remap…, Layers; Palette & Fades Normal/Ramp, Dark/Bright, Auto Fill, Gamma, fade slider; Tile Maker Import Image…, threshold, Rebuild, view switch, Edit Tiles…; Map Editor Size…, Reload tileset; Code Editor Run, Save, token meter; Data Tools Convert, Image File…; Project Audit Choose Project Folder…, columns, details view; Data Carts Inspect/Pack, Show as; Cart Builder stages and a part’s Move…; Extra Tools LUT type, Wave Export waves.p8, Line Export Lua…, Terrain Simple/Advanced and the Terrain splitter. Switch to Off: none of these tips appears and every control keeps its name. Switch to Detailed: the same text plus the F1 pointer.

## Pixel Studio preview scale (#102)

On disposable images sized 64×64, 128×128 (including the default sheet), 256×256, 128×256 and 1024×512:

1. Compare **Fit / 1× / 2×**. Fixed modes must display exactly the source dimensions multiplied by 1 or 2, as shown in the readout; larger images scroll instead of shrinking. Fit must show the whole image and use integer enlargement when possible.
2. Resize the side panel and repeat at 1280, 768 and 320 CSS px and 200% browser zoom, in dark and light themes. Fit must recalculate, fixed scales must stay unchanged, and the page must not gain horizontal overflow from the preview.
3. Tab to the scale group and use arrow keys to change modes. Tab to the preview and scroll with arrow/Page/Home/End keys, including with a canvas selection active; selection pixels must stay unchanged. Reload to check the selected mode persists; legacy stored `previewScale: 0` selects Fit.
4. Paint, toggle a layer, change frames and play animation. Verify the preview follows the current composite, retains transparency background behavior and stays sharp at 1×/2×. Changing preview scale must not change main-canvas zoom or document pixels.
5. Focus the scale group with optional help enabled, search F1 for Preview scale and replay the Pixel Studio tour; all must describe the same Fit/1×/2× behavior.

## Handoff

State exactly which automated checks ran and which human rows were covered; list gaps once (for example "no PICO-8 available", "touch not tested").

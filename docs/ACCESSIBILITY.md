# Keyboard and accessibility notes

Status of the shared shell (issue #65). These are measured improvements, not a claim of full WCAG 2.2 AA conformance: no automated scanner or screen reader run has been recorded yet.

## Shared shell contract (`js/app.js`)

| Area | Behavior |
| --- | --- |
| Option groups (`role="radiogroup"` / `role="radio"`) | Roving tabindex: only the checked radio (else the first enabled one) is a Tab stop. `←` `→` `↑` `↓` `Home` `End` move focus and select by calling the radio's `click()`, so the owner's click handler stays the only selection code path. Groups created later (Extras, Terrain, Library) are synced by a `MutationObserver`. These keys are handled in the capture phase and do not reach workspace shortcuts (e.g. Pixel Studio's arrow nudge). |
| Workspace tabs | One Tab stop; arrows switch workspace. If a workspace switch hides the focused element (a menu or a control in the old workspace), focus moves to the new workspace's tab instead of being lost. Category separators are `aria-hidden` and skipped by the arrows. Entering the Code Editor by keyboard from the tabs leaves focus on the tab (a pointer switch still focuses the editor). The tab's `title` adds its category; `document.title` names the open tool. |
| Find tool (`#wsFind`, `Ctrl`/`⌘`+`K`) | Button with `aria-haspopup="dialog"` and `aria-keyshortcuts`; its accessible name includes the open tool. Opens a `P8App.modal` with an APG combobox: the input (`role="combobox"`, `aria-controls`, `aria-activedescendant`) keeps focus while `↑` `↓` `PageUp` `PageDown` move the active `role="option"` in a `role="listbox"` (grouped by `role="group"` per category when the query is empty). A `role="status"` line announces the match count or the empty result. `Enter` opens, `Esc` closes without switching and restores focus to the opener; after a switch focus goes to the new tab (or this button when the tabs are hidden). At ≤640px the tabs are hidden and this button, labelled with the current tool, is the route to every tool. |
| Menus (`.menu` / `.menu-btn` / `.menu-pop`) | APG menu button: `Enter`/`Space`/`↓` open on the first item, `↑` on the last. Inside: `↑` `↓` `Home` `End`, `←` `→` to the neighbouring visible menu, `Esc` closes and returns to the menu button, `Tab` closes and continues from the button. Activating an item first returns focus to its menu button, so a dialog opened by the item restores focus there. |
| Dialogs (`P8App.modal`) | Named by the title (`aria-labelledby`); a string body is the description (`aria-describedby`). `role="alertdialog"` for `alert: true`, `showMessage(title, msg, 'error' \| 'warn')` and any dialog with a `danger` button. Native `showModal()` keeps focus inside; on close focus returns to the opener if it is still visible. |
| Toasts | The region is `aria-live="polite"`; `error`/`warn` toasts are `role="alert"`. Persistent status (for example save status, #58) must not rely on toasts alone. |
| Library drawer (`#library`) | Above 640px it starts below the app bar (measured edge) so **Library** stays clickable, and stacks under menu popovers; at 640px and below it is full-screen with ✕. Opening focuses the filter; closing with focus inside returns it to **Library**, whose `aria-pressed` follows the state. `Esc` precedence: tooltip, tour, dialog, open menu, then the drawer. In the filter the first `Esc` clears the text. Outside the drawer, `Esc` on a canvas, in a text field or in Full View keeps its tool meaning (#192). |
| Tab / Shift+Tab | Never a workspace shortcut: they always move focus, including from a drawing canvas (#194). Pixel Studio's timeline toggle is `T`. Drawing canvases show a `:focus-visible` ring for keyboard focus only. |
| Enter / Space | Workspace shortcut handlers do not receive `Enter`/`Space` aimed at a button, link, select, checkbox or menu/radio item that was focused by keyboard or script, so the control activates. A control focused by a pointer press still passes them to the workspace (Space-drag panning after clicking a tool button keeps working). |

## Measured evidence (2026-11-02, Chromium via Playwright)

- **Target size (WCAG 2.5.8, 24×24 CSS px minimum):** workspace tabs 36×30, menu buttons ≥57×25, icon buttons 32×32. The segmented buttons figure (36×30) held for the workspace tabs only; tool-level controls are measured per type in [Target size per control type](#target-size-per-control-type-195).
- **Text contrast (4.5:1)** of shell tokens on `--bg`, `--surface`, `--surface-2` and `--surface-3`: `--text` ≥11.5 (dark) and ≥14.2 (light); `--muted` ≥5.1 / ≥5.1; `--accent` ≥5.7 / ≥5.6.
- **Focus indicator (3:1 non-text):** a 2px `--accent` outline (≥5.6:1 on every surface in both themes). Menu items now also get an inset accent ring, not only a pale background.
- **Fixed:** white text on `.btn-danger` was 3.9:1 on `#ff004d`; the button now uses `#e0003f` (4.95:1; 3.5:1 against the dark surface).
- **Status icons:** the save-status contract (#58) pairs every state with an icon and text.

## Target size per control type (#195)

Measured 2026-11-05 in headless Chrome at 1440×900 and 1280×800 in both themes. A browser script visits every workspace and the four Extra Tools. For each visible control it measures the effective hit area by hit-testing outward from the centre with `elementFromPoint`, so `::after` hit extensions count and covered parts do not. It treats a checkbox inside its `<label>` as one target. A control under 24px also passes when a 24px circle on its centre touches no other target, which is the SC 2.5.8 spacing exception.

All minimums come from one token, `--target-min: 24px`. Rather than growing the visible control, the fix prefers an invisible hit area, so every command bar, panel header and status bar kept its measured height.

| Control type | Before (main) | Now | How |
| --- | --- | --- | --- |
| Segmented buttons in command bars and panel headers (Brush size, Preview Fit/1×/2×, Data Carts Inspect/Pack, Palette mode and direction, Tiles view, Audit view) | 20px tall (Brush **1** 23×20) | pill still 20px, hit area 24px tall, ≥24px wide | `::after` over the group's 2px padding; `min-width` |
| Other segmented buttons (`.seg`, `.seg-sm`: LUT preview screen, Terrain view/brush, Simple/Advanced) | 20–23px tall | ≥24×24 | `min-height`/`min-width` |
| Small buttons (`.btn-sm`) | 24px or more where measured, not guaranteed | ≥24px tall | `min-height` |
| Checkboxes with a label (`.check`) | label 22px, box 16×16 | label 24px tall, box 16×16 | the whole label is the target |
| Range sliders | 16px tall | 24px tall, same track and thumb | `height` |
| Pixel Studio layer visibility (◉) | 25×19 | 25×25 hit area, same look | `::after` inside the layer row's padding |
| Code outline entries (`.ce-fn`) | 21px tall | 24px tall | `min-height` |
| Home collapsible headings | 19px tall | 24px tall | `min-height` |
| Data Carts palette field | 20px tall | 24px tall | `min-height` |
| Workspace tabs, menu buttons, icon buttons | 36×30, ≥57×25, 32×32 | unchanged | — |

**Documented exceptions:**
- **Data Carts palette swatches** (`.dc-swatches`) stay 18×18 so the 16-slot row stays compact. Their gap is now 6px, a 24px pitch, so they meet the spacing exception. Before, the 2px gap failed it.
- **Canvases** are excluded: pixel, tileset, map, terrain preview and memory map. Their content is not a set of separate targets.
- **Inline links** inside a sentence fall under the inline exception.

**Not covered:** the audit measures each workspace in its default state at desktop widths. Open dialogs, the Library drawer, menus and narrow layouts were not part of this pass.

## Second pass (UX roadmap batch, 2026-11-02)

Fixed in this pass:

- **Text contrast:** a new token `--danger-text` (`#ff6b8e` dark, `#c0002f` light, ≥5.1:1 on every shell surface) is used for error *text* (`.au-warn`, `.tl-status.error`); `--danger` stays for fills, borders and icons. Light-theme `--ok` `#0f6b31`, `--warn` `#9a4507`, `--bad` `#c81e1e` now reach ≥4.8:1 on `--bg`, `--surface`, `--surface-2` and `--surface-3` (computed from the tokens; not a scanner result).
- **Missing name:** the Palette & Fades fade slider (`#fadeSlider`) had no accessible name; it is now "Fade position". A DOM scan of every button, radio, menu item, input, select and separator found no other unnamed visible control (hidden file inputs and unused buttons excluded).
- **New surfaces follow the shared contract:** the *Go to tool* quick switch and *Send to…* dialogs are `P8App.modal` dialogs (title, focus trap, focus return, Esc); the quick tour card is a non-modal `role="dialog"` that never blocks the page and ends with Esc; tooltips (`role="tooltip"`, `aria-describedby`) appear on keyboard focus as well as hover and never carry the only copy of essential information; unavailable *Send to* destinations stay focusable (`aria-disabled`) with the reason as visible text; the side-panel splitter is a focusable `role="separator"` with `aria-valuenow/min/max` and arrow/Home/End/Enter/0 keys.
- **Non-hover access:** every tooltip text is also in the F1 help registry; error and disabled-reason texts are visible text, not `title` only.

Still open:

- Full WCAG 2.2 AA conformance is **not** claimed. No axe/scanner run and no screen-reader run were possible in this environment, so announcements (live regions, dialog names) were verified by reading the DOM, not by listening.
- Contrast of tool-specific canvas overlays and the Terrain Lab/Extra Tools text styles was not re-measured.

## Canvas and pointer limitations

The pixel, map, tile and terrain canvases are drawing surfaces. Their pixel content has no text alternative, and drawing itself needs a pointer. Existing keyboard paths include tool shortcuts, `[`/`]` and arrow keys on the Map Editor tileset, arrow nudging of Pixel Studio selections, and menu commands for transforms. Non-drag fallbacks still to be defined, each as a separate tool issue (not part of #65):

1. **Palette & Fades:** reorder and assign colors without dragging swatches.
2. **Pixel Studio:** move or resize a selection and reorder layers/frames entirely by keyboard, with feedback on the position or size.
3. **Map Editor:** place a tile at a keyboard-chosen cell and select a rectangle without dragging.
4. **Cart Builder:** move an asset between carts without drag (auto-pack already covers the common case).
5. **Library:** send an asset to a tool without drag-and-drop (menus and buttons exist; check coverage per asset type).
6. **Resizable panels (#64):** done: the splitter is keyboard operable (see `js/panels.js`). Remaining: none for panel width.

## Manual keyboard-only regression script

Run this in a desktop browser (light and dark theme) after changes to `js/app.js`, `index.html` shell markup or shared CSS. Do not use the mouse unless a step says so.

1. Load `index.html#home` and press `Tab` from the page start. Expected: the first stop is the selected workspace tab, the next is **Find tool**, then **Library**, and the visible focus ring is clear.
2. `Shift+Tab` back to the workspace tabs and press `→`, `End`, `Home` and `←`. Expected: the workspace changes each time (also onto and past Code Editor), `←` from Home wraps to Extra Tools, and focus stays on the selected tab.
3. Switch to Pixel Studio. `Tab` to **File** and press `Enter`. Expected: the menu opens with focus on the first item. Press `↑`: focus wraps to the last item. Press `→`: the Edit menu opens. Press `End`, then `Esc`: the menu closes and focus is back on **Edit**.
4. Press `↑` on **Edit** and `Enter` on **Outline…**. Expected: the dialog is announced by its title and focus is inside it; `Tab` never reaches the page behind it (only the dialog and the browser's own controls). Press `Esc`: focus returns to **Edit**.
5. Open **File** and activate **Tile Maker**. Expected: the Tile Maker opens and focus is on its workspace tab (not lost to the page).
6. In any menu press `Tab`. Expected: the menu closes and focus moves to the next menu button.
7. In Pixel Studio, `Tab` to the **Brush** size buttons and press `→`. Expected: the brush changes and no selection is nudged. Then click a tool button with the mouse and hold `Space` over the canvas. Expected: pan mode, as before.
8. Trigger a storage error (or run `P8App.showMessage('t', 'm', 'error')`). Expected: it is announced as an alert dialog with its message; closing it returns focus to the previous control.
9. Toggle the theme with the keyboard. Expected: the button's accessible name states the current theme, and a toast announces the change.
10. In the Code Editor type a character, press `Ctrl+K`, type `terrain`, check the status line, then press `Esc`. Expected: focus is back in the editor and the code is unchanged. Press `Ctrl+K` again, type `terrain` and `Enter`. Expected: Extra Tools opens on Terrain Lab, the address is `#extras/terrain` and focus is on the Extra Tools tab. Type `qqzzx`: the status says no tool matches.
11. Repeat steps 1–3 at a 360px-wide viewport. Expected: no focus target is hidden behind other content; the first stop is the **Find tool** button (named with the current tool), which lists every tool.

12. Press `Ctrl+K`. Expected: *Go to tool* opens with focus in the search field; type `tokens`, `↓` moves into the results, `Enter` opens the tool and focus lands on its workspace tab; `Esc` closes the dialog with focus back on the opener.
13. In Pixel Studio `Tab` to the side-panel splitter ("Resize Pixel Studio side panel"). `←`/`→` change the width, `Home`/`End` jump, `Enter` hides the panel (its controls leave the tab order) and again shows it, `0` (or a double-click) resets, and the splitter then announces the default width, not the previous one. Reload: the width is kept.
14. Open **File › Send to › All destinations…**. Expected: unavailable destinations are reachable with `Tab`, announce their reason, and activating them does nothing; an available one asks "Replace unsaved work?" only if the destination holds unsaved changes.
15. Open **Help › Quick tours…**, start a tour with the keyboard, move with `Next`, leave with `Esc`. Expected: the page stays usable throughout, focus returns to the opener.
16. In Pixel Studio `Tab` to the drawing canvas. Expected: a focus ring shows on it. `Tab` moves on to the next control and `Shift+Tab` back; the timeline does not change. With focus on the canvas press `T`: the timeline hides and shows, and **Timeline** in the status bar follows. Typing `t` in a text field does not toggle it. Clicking or drawing on the canvas with the mouse shows no ring.
17. At a width above 640px, `Tab` to **Library** and press `Enter`. Expected: the drawer opens below the app bar with focus in the filter, and **Library** is pressed and still clickable. Type text and press `Esc`: the filter clears. `Esc` again: the drawer closes and focus is on **Library**. Reopen it, open a menu and press `Esc`: only the menu closes. Select pixels on the Pixel Studio canvas and press `Esc` there: the selection clears and the drawer stays. At 390px the drawer is full-screen and ✕ or `Esc` closes it.

Record the browser, theme, any screen reader used and the results in the PR. If no screen reader is available, say so.

## Keyboard script run (2026-11-03, headless Chrome via the DevTools protocol)

Steps 1–15 above were run on `main` at `6076843` plus this change, using real key events (`Tab`, `Shift+Tab`, arrows, `Home`/`End`, `Enter` with its carriage-return text, `Esc`, `Ctrl+K`, typed text) from a temporary script outside the repo. Viewports were 1700×950 and 360×740. **Result: all 15 steps pass**, and no exception or diagnostics record was produced. Specifics:

- Workspace tabs form one Tab stop; arrows, `Home`, `End` and the wrap all switch the workspace and keep focus on the tab, including across Code Editor. Radio groups (Brush size) have exactly one Tab stop before and after an arrow selection, and no selection nudge happens.
- Menus open on the first item (`Enter`) or the last (`↑`). `→` opens the neighbouring menu. `Esc` and `Tab` close the menu and return focus to, or continue from, the menu button. A menu action that switches workspace (File › Send to › Tile Maker) leaves focus on the new tab.
- Edit › Outline… is a modal `dialog` named "Outline"; 25 `Tab` presses never left it, and `Esc` returned focus to **Edit**. `showMessage(…, 'error')` is an `alertdialog` with a name and description, and focus returns after `Esc`. The theme toggle names the current theme ("Theme: light. Change theme"), and the change is announced through the polite toast region.
- `Ctrl+K` from the Code Editor: the status announces the match count, `Esc` restores focus to the editor with the code unchanged, `Enter` routes to `#extras/terrain` with focus on the Extra Tools tab, and the empty result is announced. *Send to…* unavailable destinations are Tab-reachable with `aria-describedby` reasons. A quick tour starts and advances by keyboard, `Esc` ends it, and focus returns to **Help**.
- At 360 px the first Tab stop is **Find tool (current: Map Editor)**, and the focused control is not covered by other content.
- **Contrast** (computed in the page from rendered colours, alpha-blended over the effective background, for app-bar buttons, menu buttons, workspace tabs, `.btn`, hints, muted text, `kbd` and status text): the minimum is 5.76:1 in dark and 5.31:1 in light, with no failure. The focus ring is a solid 2 px outline at 7.64:1 in dark and 5.87:1 in light against the app bar.

**Fixed in this pass:** after a splitter reset (`0` or double-click), `aria-valuenow`/`aria-valuetext` still announced the previous width (e.g. "560 pixels wide") while the panel was back at its 272 px default. `js/panels.js` measured the width before removing the `--side-w` override; it now measures afterwards. The run was repeated in the browser: reset announces 272, matching the rendered width. This needs real layout, so there is no Node regression for it.

**Not available:** a screen reader (NVDA, JAWS or VoiceOver) and an axe/automated scanner. Announcements were verified from roles, names, `aria-*` relationships and live-region attributes in the DOM, not by listening. Touch input and non-Chromium browsers were not tested. Full WCAG 2.2 AA conformance is still **not** claimed.

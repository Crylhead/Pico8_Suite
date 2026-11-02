# Keyboard and accessibility notes

Status of the shared shell (issue #65). These are measured improvements, not a claim of full WCAG 2.2 AA conformance: no automated scanner or screen reader run has been recorded yet.

## Shared shell contract (`js/app.js`)

| Area | Behavior |
| --- | --- |
| Option groups (`role="radiogroup"` / `role="radio"`) | Roving tabindex: only the checked radio (else the first enabled one) is a Tab stop. `←` `→` `↑` `↓` `Home` `End` move focus and select by calling the radio's `click()`, so the owner's click handler stays the only selection code path. Groups created later (Extras, Terrain, Library) are synced by a `MutationObserver`. These keys are handled in the capture phase and do not reach workspace shortcuts (e.g. Pixel Studio's arrow nudge). |
| Workspace tabs | One Tab stop; arrows switch workspace. If a workspace switch hides the focused element (a menu or a control in the old workspace), focus moves to the new workspace's tab instead of being lost. |
| Menus (`.menu` / `.menu-btn` / `.menu-pop`) | APG menu button: `Enter`/`Space`/`↓` open on the first item, `↑` on the last. Inside: `↑` `↓` `Home` `End`, `←` `→` to the neighbouring visible menu, `Esc` closes and returns to the menu button, `Tab` closes and continues from the button. Activating an item first returns focus to its menu button, so a dialog opened by the item restores focus there. |
| Dialogs (`P8App.modal`) | Named by the title (`aria-labelledby`); a string body is the description (`aria-describedby`). `role="alertdialog"` for `alert: true`, `showMessage(title, msg, 'error' \| 'warn')` and any dialog with a `danger` button. Native `showModal()` keeps focus inside; on close focus returns to the opener if it is still visible. |
| Toasts | The region is `aria-live="polite"`; `error`/`warn` toasts are `role="alert"`. Persistent status (for example save status, #58) must not rely on toasts alone. |
| Enter / Space | Workspace shortcut handlers do not receive `Enter`/`Space` aimed at a button, link, select, checkbox or menu/radio item that was focused by keyboard or script, so the control activates. A control focused by a pointer press still passes them to the workspace (Space-drag panning after clicking a tool button keeps working). |

## Measured evidence (2026-11-02, Chromium via Playwright)

- **Target size (WCAG 2.5.8, 24×24 CSS px minimum):** workspace tabs 36×30, menu buttons ≥57×25, icon buttons 32×32, segmented buttons 36×30.
- **Text contrast (4.5:1)** of shell tokens on `--bg`, `--surface`, `--surface-2` and `--surface-3`: `--text` ≥11.5 (dark) and ≥14.2 (light); `--muted` ≥5.1 / ≥5.1; `--accent` ≥5.7 / ≥5.6.
- **Focus indicator (3:1 non-text):** a 2px `--accent` outline (≥5.6:1 on every surface in both themes). Menu items now also get an inset accent ring, not only a pale background.
- **Fixed:** white text on `.btn-danger` was 3.9:1 on `#ff004d`; the button now uses `#e0003f` (4.95:1; 3.5:1 against the dark surface).
- **Status icons:** the save-status contract (#58) pairs every state with an icon and text.

## Known findings outside the shell (follow-up)

- `--danger` (#ff004d) used as **text** (`.au-warn`, `.ex-info.ex-error`, `.tl-status.error`) reaches 3.3–4.8:1, below 4.5:1 on some surfaces. These rules belong to the tool modules and the design system (#52).
- In the light theme, `--ok`, `--warn` and `--bad` reach 4.2–4.4:1 on `--bg`/`--surface-3` (≥4.8:1 on `--surface`, where panels show them). Re-check with the #52 token set.

## Canvas and pointer limitations

The pixel, map, tile and terrain canvases are drawing surfaces. Their pixel content has no text alternative, and drawing itself needs a pointer. Existing keyboard paths include tool shortcuts, `[`/`]` and arrow keys on the Map Editor tileset, arrow nudging of Pixel Studio selections, and menu commands for transforms. Non-drag fallbacks still to be defined, each as a separate tool issue (not part of #65):

1. **Palette & Fades:** reorder and assign colors without dragging swatches.
2. **Pixel Studio:** move or resize a selection and reorder layers/frames entirely by keyboard, with feedback on the position or size.
3. **Map Editor:** place a tile at a keyboard-chosen cell and select a rectangle without dragging.
4. **Cart Builder:** move an asset between carts without drag (auto-pack already covers the common case).
5. **Library:** send an asset to a tool without drag-and-drop (menus and buttons exist; check coverage per asset type).
6. **Resizable panels (#64):** resize by keyboard.

## Manual keyboard-only regression script

Run this in a desktop browser (light and dark theme) after changes to `js/app.js`, `index.html` shell markup or shared CSS. Do not use the mouse unless a step says so.

1. Load `index.html#home` and press `Tab` from the page start. Expected: the first stop is the selected workspace tab, the next is **Library**, and the visible focus ring is clear.
2. `Shift+Tab` back to the workspace tabs and press `→`, `End`, `Home` and `←`. Expected: the workspace changes each time, `←` from Home wraps to Extra Tools, and focus stays on the selected tab.
3. Switch to Pixel Studio. `Tab` to **File** and press `Enter`. Expected: the menu opens with focus on the first item. Press `↑`: focus wraps to the last item. Press `→`: the Edit menu opens. Press `End`, then `Esc`: the menu closes and focus is back on **Edit**.
4. Press `↑` on **Edit** and `Enter` on **Outline…**. Expected: the dialog is announced by its title and focus is inside it; `Tab` never reaches the page behind it (only the dialog and the browser's own controls). Press `Esc`: focus returns to **Edit**.
5. Open **File** and activate **Tile Maker**. Expected: the Tile Maker opens and focus is on its workspace tab (not lost to the page).
6. In any menu press `Tab`. Expected: the menu closes and focus moves to the next menu button.
7. In Pixel Studio, `Tab` to the **Brush** size buttons and press `→`. Expected: the brush changes and no selection is nudged. Then click a tool button with the mouse and hold `Space` over the canvas. Expected: pan mode, as before.
8. Trigger a storage error (or run `P8App.showMessage('t', 'm', 'error')`). Expected: it is announced as an alert dialog with its message; closing it returns focus to the previous control.
9. Toggle the theme with the keyboard. Expected: the button's accessible name states the current theme, and a toast announces the change.
10. Repeat steps 1–3 at a 360px-wide viewport. Expected: no focus target is hidden behind other content.

Record the browser, theme, any screen reader used and the results in the PR. If no screen reader is available, say so.

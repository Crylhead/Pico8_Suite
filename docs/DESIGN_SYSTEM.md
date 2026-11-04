# UI design tokens and component states

Shared visual contract for the suite's non-canvas UI (#52). Tokens live in `css/style.css` (scales, focus, theme colours) and `css/suite.css` (`--status-*`). Open [design-system.html](design-system.html) through the local server (`/docs/design-system.html`) to see every primitive and state in both themes.

Adopt tokens and primitives incrementally when you touch a surface. Do not re-skin workspaces wholesale, and keep specialist UI (pixel grids, swatches, code editor, canvases) on its own styles.

## Tokens

| Group | Tokens | Values / notes |
| --- | --- | --- |
| Surfaces | `--bg`, `--surface`, `--surface-2`, `--surface-3` | Page → panel → inset → control. Dark and light values; light applies to `data-theme="light"` and to the system light theme unless `data-theme="dark"`. |
| Lines | `--border`, `--border-strong` | Panel outline / control outline |
| Text | `--text`, `--muted` | Muted text is ≥ 5.1:1 on every surface in both themes |
| Accent | `--accent`, `--accent-ink`, `--accent-soft` | Primary action, focus, selection tint; `--accent-ink` is text on accent |
| Status text | `--status-ok`, `--status-warn`, `--status-error` | ≥ 4.5:1 on every surface in both themes (`--status-error`: dark `#ff6b81` 5.1–6.9:1, light `#c0002f` 5.4–6.4:1) |
| Status fill | `--danger`, `--ok`, `--warn`, `--bad` | Borders, fills, icons. `--danger` is **not** text-safe (as low as 3.3:1); use `--status-error` for error text |
| Spacing | `--space-1` … `--space-7` | 2, 4, 6, 8, 10, 12, 16 px (the gaps already used across the suite) |
| Type | `--fs-xs`, `--fs-sm`, `--fs-md`, `--fs-base`, `--fs-lg` | 11, 12, 13, 14, 15 px; `--font` UI stack and `--mono` code stack (system fonts only, nothing downloaded) |
| Weight | `--fw-control`, `--fw-label`, `--fw-heading` | 550 (buttons, segments), 600 (labels, panel headings), 650 (h1–h3) |
| Radius | `--radius-xs`, `--radius-ctl`, `--radius-sm`, `--radius` | 4, 6, 8, 12 px |
| Focus | `--focus-width`, `--focus-color`, `--focus-offset` | 2px `--accent`, offset 2px. `prefers-contrast: more`: 3px in `--ring` (white/near-black). `forced-colors: active`: `Highlight` |
| Disabled | `--disabled-opacity` | 0.45 |

## Primitives and states

| Primitive | Markup | Hover | Focus | Selected | Busy | Disabled | Error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Button | `button.btn` (+ `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`, `.icon-btn`) | accent border | focus ring (`:focus-visible`) | `aria-pressed="true"`: accent tint + border | `aria-busy="true"` (+ `aria-disabled`): pulsing dot, progress cursor; reduced motion stops the pulse | `disabled`: faded | — (use `.btn-danger` for destructive actions) |
| Segmented control / option group | `.seg[role=radiogroup]` > `button[role=radio][aria-checked]` | unselected text brightens | focus ring; one Tab stop, arrows select | `aria-checked="true"`: raised surface | — | `disabled`: faded, skipped by arrows | — |
| Field | `label.field` > text + `input`; `select.select`; `input.num` | — | focus ring | — | — | `disabled`: faded | `aria-invalid="true"` (+ `aria-describedby` → message): danger border; pair with an error `.status-line` |
| Panel group | `fieldset.panel-group` > `legend.panel-heading` (or a `div` + `h3.panel-heading`) | — | — | — | set `aria-busy` on the panel while it recomputes | `fieldset disabled` disables its controls | — |
| Status line | `p.status-line` with optional `data-tone="ok" \| "warn" \| "error"` | — | — | — | — | — | tone adds the status colour **and** a ✓/⚠ symbol (hidden from screen readers), so it is never colour-only |
| Notice | `p.notice` with optional `data-tone="warn" \| "error"` | — | — | — | — | — | coloured left edge + tint; put the meaning in the text |
| Progress | `progress.progress` (with an accessible name) | — | — | — | determinate or indeterminate | — | — |

Rules:

- Never convey state by colour or hover (`title`) alone; pair it with text, a symbol or an ARIA state.
- Focus styles use `:focus-visible` and the focus tokens; do not remove outlines without an equivalent replacement.
- Announcements: dialogs and toasts are covered by the shell (`App.modal`, `App.toast`); a `.status-line` that is the only report of a one-off result may use `role="status"`, but do not put live regions on text that updates during drags or sliders.
- Document-save state uses `P8DocStatus` and `.doc-status` (see [EXTENDING.md](../EXTENDING.md#document-save-status)), not ad-hoc status lines.

## Shared app chrome (#166)

The header has separate navigation and menu/context slots. Tool-specific context must not participate in sizing the primary navigation row.

| Slot | Contract |
| --- | --- |
| Primary row | `--chrome-nav-height`: 48px minimum; grid slots for brand, shrinkable tab strip, Find tool and global actions. Tabs retain their icon/button sizes and scroll rather than wrapping. The overlapping workspace-name frame remains intact. |
| Menu row above 640px | `--chrome-menu-height`: 33px minimum; 26px menu buttons (`--chrome-menu-line`) and a reserved context rail, `min(38%, 400px)`. Empty context space stays reserved. |
| Menu/context at or below 640px | Existing logo/Find tool navigation; reserve two 26px menu lines and a separate 28px context row (`--chrome-context-height`), including when empty. This deliberately trades a little height for stable tool switches and reachable controls. |
| Project / preset context | Shares the bounded menu rail with indices; names ellipsize without widening navigation. Full project/access text stays in the live status and title. Consumer project strips and Home notes wrap long names. |
| Popovers | Preserve anchored menus and keyboard behavior; fit horizontally inside the page with an 8px inset and vertically inside the remaining viewport. Long lists scroll; opening or resizing refits the popover. |
| Scrollbar rail | Root `scrollbar-gutter: stable` reserves classic scrollbar space across document/pane tools. Overlay-scrollbar browsers use their normal behavior. All workspace centering uses available document width, not an assumed viewport width. |

At standard font settings the total header is 82px above 640px and 134px at/below 640px, including borders. These are measured outcomes of minimum row sizes, not clipped fixed-height containers; enlarged/custom fonts may require more space. Menu labels keep wrapping available, and no workspace hides global menus or navigation to fit. Same-width workspace and project-state switches must preserve primary-control DOMRects and the content top. See [the recorded browser checks](UX_RELEASE_CHECKLIST.md#shared-header-geometry-166).

## Workspace geometry (#168)

Every built-in workspace declares one of two outer layout modes on its existing `main` wrapper. Widths include the gutters (`border-box`); centering uses the available document width.

| Mode | Markup | Width | Outer gap |
| --- | --- | --- | --- |
| Fluid editor | `data-layout="fluid"` | Full available width, no maximum | `--workspace-gap-editor`: 10px |
| Centered dashboard/form | `data-layout="dashboard"` | `--workspace-width-default`: 1240px maximum | `--workspace-gap-dashboard`: 16px |

Both modes use `--workspace-gutter` (16px) on all four edges. A dashboard can add `data-width-tier="wide"` for `--workspace-width-wide` (1640px): Palette compares images and settings side by side; Tile Maker compares source/output alongside a native sheet. This is a justified width tier within the dashboard mode, not a third mode. Editors retain maximum useful working area.

| Workspace | Mode / ceiling | Existing scroll ownership |
| --- | --- | --- |
| Home | Dashboard / 1240px | Document |
| Palette & Fades | Dashboard, wide / 1640px | Document |
| Tile Maker | Dashboard, wide / 1640px | Document |
| Data Tools | Dashboard / 1240px | Document |
| Pixel Studio | Fluid | Independent panes above 860px; document at/below |
| Map Editor | Fluid | Independent panes above 900px; document at/below |
| Code Editor | Fluid | Independent panes above 900px; document at/below |
| Minifier | Fluid | Independent panes above 699px; document at/below |
| Project Audit | Fluid | Independent panes above 1000px; document at/below |
| Cart Builder | Fluid | Independent panes above 1000px; document at/below |
| Data Carts | Fluid | Independent panes above 1000px; document at/below |
| Extra Tools (all four tabs) | Fluid | Independent panes above 1000px; document at/below |

The shared rule governs only the outer wrapper. Keep specialized grids, panel widths/collapse, internal spacing, canvas aspect/zoom and scroll owners in tool styles. Legacy `.layout-*` geometry remains a fallback for extensions without the mode annotation; new tools must declare a mode. See [EXTENDING.md](../EXTENDING.md#workspace-geometry) and the [before/after checks](UX_RELEASE_CHECKLIST.md#workspace-geometry-168).

Command/status rows (#169), the broader panel-breakpoint audit (#170) and a reusable visual-regression runner (#171) remain separate work.

## Data-cart workspace sizing (#167)

Cart Builder and Data Carts share `.layout-dc` and the same body sizing rules in `css/suite.css`:

| Width | Body / grid | Scroll ownership |
| --- | --- | --- |
| Above 1000 CSS px | Viewport-height column; the grid fills the remainder below the app chrome, with `min-height: 0` | Parts/cart list and main visualization/report scroll within their own panes; the page stays fixed |
| At or below 1000 CSS px | Document-height body; top controls, side list and main area stack | The document scrolls; both lists cap at 240px with their own scrolling, keeping the main area reachable |

Capacity charts keep their fixed 430px height and horizontal scrolling for multiple carts. Do not stretch chart data or change packing to fit the viewport. Command rows can wrap as their controls require; this contract does not force identical command content or row counts. Keep the shared Cart Builder/Data Carts body selectors together when changing their breakpoint behavior. See the [browser regression checklist](UX_RELEASE_CHECKLIST.md#cart-builder-viewport-167).

## Preview frame roles (#172)

Normalize the outer frame, not the pixel data. Reuse the shared spacing/radius tokens and these roles instead of assigning all canvases one height:

| Role | Existing surface / sizing contract | Content behavior |
| --- | --- | --- |
| Sidebar thumbnail | Pixel Studio `.ps-preview-box`, `--preview-sidebar-size: 192px` high | Existing Fit/1×/2× controls choose the pixel scale; large images scroll |
| Square comparison | Palette `.canvas-frame` uses `--preview-square-size: 256px`; Tile Maker `.tm-frame` uses available column width with a square aspect | Existing drawing code preserves image aspect and nearest-neighbor rendering; portrait/landscape content is panned or letterboxed, never stretched |
| Primary editing stage | Pixel/Map `.ps-stage` and Extra Tools/Terrain stages remain fluid in their workspace | Specialized zoom, pan and canvas sizing remain owned by each tool; no fixed preview height is imposed |
| Native sheet | Tile Maker `.tm-tileset-frame` bounds the native-width sheet (`--preview-sheet-width: 256px`) | The canvas retains its intrinsic display scale; the outer frame scrolls, with a keyboard-focusable, named region |

Tile Maker uses shared caption and frame rows (CSS subgrid): long captions reserve the same space above compared views. Above 1100px the 256px sheet column shares the comparison frame's top/bottom edges; size containment keeps its bitmap from dictating that row's height. At 641–1100px the comparison pair stays together and the sheet moves to a separate 256px square frame. At 640px and below the views stack. Only the sheet's outer frame changes size; canvas bitmap dimensions and tile packing do not.

Palette cards share caption, image, action and settings rows. Preview images remain square; the settings row takes the height needed by either card, so extra greyscale controls do not shift the image edges. Actions wrap at their normal control height. On phones the cards stack and may have different heights according to their own settings; matching heights across separate rows would add empty space. The two `.preview-settings` wrappers group existing controls without changing their IDs or event ownership.

## Adoption

| Surface | Status |
| --- | --- |
| Shell buttons, segmented controls, fields, selects | Focus, weight and disabled values come from the tokens (no visual change) |
| Extra Tools control panels (LUT Creator, Wave Designer, Line Tool, Terrain Lab via the shared `group()` helper) | `.panel-group`/`.panel-heading`; result lines use `.status-line`; the 3D formation error uses `data-tone="error"` (pilot) |
| Other workspaces | Unchanged; adopt when touched |

Verification for the pilot: computed styles of every fieldset, legend, info line, button, segment, field and select in the four Extra Tools were identical to `main` in both themes; only the error line changed (contrast-safe colour plus ⚠).

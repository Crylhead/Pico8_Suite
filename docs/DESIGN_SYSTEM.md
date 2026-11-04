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

Responsive panel and scroll behavior is documented below (#170). Use the [opt-in geometry matrix](GEOMETRY_SMOKE.md) for shared layout changes.

## Responsive panels and scroll ownership (#170)

Tool breakpoints reflect different working-area needs; do not unify them. Above each stacking breakpoint the document stays fixed and tool panes scroll independently; at/below it the document scrolls. Explicit inner lists/cart rows can still scroll in narrow mode. The root scrollbar rail and workspace gutters remain shared.

| Tool | Stacks at/below (CSS px) | Desktop side/control width |
| --- | --- | --- |
| Pixel Studio | 860 | Default 232px through 1100px, then 272px; user range 200–560px |
| Map Editor | 900 | Default 290px; user range 220–560px |
| Terrain / Extra Tools | 1000 | Terrain default 380px; user range 260–640px; other Extra Tools retain their own internal grids |
| Code Editor | 900 | 280px fixed rail |
| Minifier | 699 | 250px from 700–1199px with stacked comparison panes; 300px from 1200px |
| Project Audit | 1000 | 360px fixed rail |
| Cart Builder / Data Carts | 1000 | 280px fixed rail; narrow lists cap at 240px, cart charts keep native sizing/scrolling |

The resizable panels share a 320px minimum **center grid track**, leaving 318px inside Pixel/Map's existing 1px borders. Bounds use border-box width minus computed horizontal padding/borders. Only then subtract fixed toolbar columns/gaps (52px + two 10px gaps for Pixel/Map; one 10px gap for Terrain). Outer gutters must never be counted as stage room. This fixes the formerly 298px center/296px canvas at the first desktop width.

A saved width is the user's preference, not the currently clamped width. Narrowing or switching tools may temporarily limit it; widening restores it. A stored collapse is ignored while stacked: the controls are visible, are not inert, and can be reached through document scrolling. The collapsed state resumes on resize-back; Enter/toggle restores the chosen width. Reset removes that preference and returns to the current CSS default, including Studio's 1100px preset transition. Storage format and the #64 resize model are unchanged.

Extra Tools' tab group wraps within its available width at small sizes instead of extending the document. Keyboard tab selection/order is unchanged. Use the [repeatable audit and manual fallback](GEOMETRY_SMOKE.md#panel-breakpoint-audit-170) and [recorded measurements/screenshots](UX_RELEASE_CHECKLIST.md#panel-breakpoint-stability-170).

## Workspace bar roles (#169)

Use minima and explicit overflow policies, not fixed heights that crop controls. These tokens in `css/style.css` apply to existing wrappers; editor font/bitmap/zoom and internal pane ownership remain tool-specific.

| Role / token | Contract |
| --- | --- |
| Command / `--bar-command-min` | 40px minimum, 6px vertical and 10px horizontal padding (`--bar-pad-y/x`); 6px row / 10px column gap (`--bar-row-gap`, `--bar-gap`). `.command-row` wraps by default; `.command-row-inset` removes duplicate horizontal padding inside a padded card. |
| Heading / `--bar-heading-min` | 28px minimum for `.card-head`, `.ps-panel-head` and `.mn-heading-row`; 18px text line (`--bar-line`). Palette's 30px color swatch can grow its heading to 30px. Long headings/controls can wrap. |
| Status / `--bar-status-min` | 32px minimum; 18px line, 2px vertical / 10px horizontal inset, shared gaps and top divider. Pixel/Map/Code use `.ps-status`; Terrain uses the same tokens. Groups wrap rather than hiding action buttons. |
| Small controls / `--bar-control-min` | 26px minimum for buttons, selects, numbers and names inside these roles; 13px UI text / 18px line. Segmented children are 20px plus their existing 6px frame. Pixel chips, checkbox/range controls, and bitmap content retain their specialized sizes. |

| Surface | Explicit expansion / overflow policy |
| --- | --- |
| Pixel Studio | Two 40px-minimum options rows plus their dividers; `.command-row-scroll` retains horizontal scrolling and focus reveal. Status metadata reserves a stable flex basis; control groups wrap as whole groups. Pointer changes do not change row allocation. |
| Map / Code | Command rows wrap when necessary; file/name readouts shrink or ellipsize. Status readouts/meters remain available and can occupy another row. Pixel and Map share command insets, dividers and status sizing, without forcing their total row counts to match. |
| Terrain | View and brush rows use command sizing. Coordinates and render details have reserved two-line heights and can scroll by keyboard; render feedback/Retry share a reserved command slot. Its status row grows to fit this expanded readout, independently of pointer text. |
| Minifier | Above 699px, source/commands reserves `--bar-expanded-command` = 240px, capped at 35dvh, with overflow scrolling. Heading and action rows use the shared minima. At/below 699px it grows in the document. |
| Audit | Above 1000px the expanded command region reserves 180px (same variable locally overridden), capped at 35dvh, including primary/column rows and context. Long content scrolls. Narrow mode grows in the document. |
| Cart Builder / Data Carts | Same policy as Audit, with a 112px desktop region for their command workflow. More rows or long context scroll inside that region; narrow mode grows in the document. |

Expanded command regions are named, keyboard-focusable areas: Page Down/Up and normal focus scrolling reach their contents. Their reserved heights keep text updates from consuming additional stage area. All minima can grow for controls/text where no explicit scrolling region is declared; no pixel canvas is stretched to equalize bars. `.card-head` retains the card's own boundary; edge-to-edge command/status rows keep their existing 1px divider. See the [recorded comparison](UX_RELEASE_CHECKLIST.md#workspace-bars-169).

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

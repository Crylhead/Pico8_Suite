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

## Adoption

| Surface | Status |
| --- | --- |
| Shell buttons, segmented controls, fields, selects | Focus, weight and disabled values come from the tokens (no visual change) |
| Extra Tools control panels (LUT Creator, Wave Designer, Line Tool, Terrain Lab via the shared `group()` helper) | `.panel-group`/`.panel-heading`; result lines use `.status-line`; the 3D formation error uses `data-tone="error"` (pilot) |
| Other workspaces | Unchanged; adopt when touched |

Verification for the pilot: computed styles of every fieldset, legend, info line, button, segment, field and select in the four Extra Tools were identical to `main` in both themes; only the error line changed (contrast-safe colour plus ⚠).

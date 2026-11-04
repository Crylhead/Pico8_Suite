# Shared Studio indices (#181)

Pixel Studio uses the same menu-row **Indices** state toggle (a fixed label with `aria-pressed`; it was Hide/Show indices before #197) and `p8pal.showIndices` preference as Palette & Fades and Tile Maker. The shared `p8:indices` event notifies Studio; rebuilding/restoring its palette also reads the current preference. Only visible palette labels change. Explicit accessible slot/color names stay present with Help off, and the swatch buttons are retained so focus is not lost.

Run `node tests/studio-indices.mjs` with the existing `P8_GEOMETRY_PLAYWRIGHT`, `P8_GEOMETRY_BROWSER_EXECUTABLE` and `P8_GEOMETRY_BROWSER_ARGS` configuration from [GEOMETRY_SMOKE.md](GEOMETRY_SMOKE.md). Optional `P8_INDICES_SCREENSHOTS` names an existing output directory. No browser or dependency is installed.

Verified in Chromium 153/Linux at 1536×712 CSS pixels with DPR 1.25: mouse click, Space/Enter, both themes, immediate labels and button pressed/text state, all three tool switches, palette-button focus preservation, accessible slot/color names, false preference restored on reload, and unchanged loaded Studio document (pixels, palette, frames and layers). Density emulation is not physical browser zoom. Static references, JS syntax and the full regression suite also passed.

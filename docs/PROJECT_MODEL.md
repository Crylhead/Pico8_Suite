# Demo projects in the suite: phase 1 spec

Goal: the suite knows a demo's data (images, palettes, fades, tiles, maps, tables), packs it into data carts, and tells the fx code where each piece is. No guessing about addresses or formats, and no extra tokens.

Decided with the user (2026-10-28):
- The project folder is wherever the user puts it (any folder outside `AppData`, so the browser may write to it).
- The fx find their data through `--@data` anchor comments.
- Maps follow PICO-8 / Modulator / Nuova (8-bit cells). Bigger maps in data carts are an option.
- Order: project model and cart builder first, then the live tile link, then the map editor.

## 1. Project folder

The user picks the folder once (File System Access API, read/write). The suite remembers the handle in IndexedDB and asks for permission again on the next visit. The layout is demoframe's, plus two entries:

| Path | Content |
|---|---|
| `demo/` | fx carts, data carts (generated ones too), `main.p8`, … |
| `demo/suite.json` | the project file: assets, carts, layout (below) |
| `assets/` | asset sources, one file per asset (`<name>.json`, versioned) |
| `music/`, `tools/`, `release/` | as in demoframe |

A project can also be adopted from an existing demo. The Data Carts analysis (sections + `reload()` lines) proposes assets and anchors, and the user confirms. Nuova and Modulator are the first test cases.

## 2. Asset types and their bytes

Every asset has a `name` (Lua-identifier style), a `type`, and its parts. A part is a run of bytes that one `reload()` brings in. Encodings are header-less: the project file knows sizes, and the fx code knows its own formats.

| Type | Parts | Bytes |
|---|---|---|
| `image` | `.img` | w×h pixels, row-major, 2 pixels per byte, low nibble = left pixel (PICO-8 memory layout). w is even. 128-wide images are sprite-sheet compatible. |
| `layered` | `.img`, `.mask`, `.fades` | `.img` as `image`. `.mask` is the same size; a pixel's value is its layer (Modulator's skull format). The layer count is stored in the project, and the fx code has it too. |
| `palette` | `.pal` | 16 bytes, screen colors (0–15, 128–143) |
| `fades` | `.fades` | Row 0 = screen palette. Rows 1…2N = `pal(…,2)` rows of packed color pairs (low nibble = this level, high nibble = next brighter level). Row N+1 = no fade. Default N = 16: 33 rows, 528 bytes (Modulator's format, read with `memread_table8(16)` and `fillp` dither). |
| `tiles` | `.gfx`, `.map` | `.gfx`: 8×8 tiles in sprite-sheet layout (128 px wide `image`). `.map`: cells row-major, 1 byte per cell (PICO-8 map; at width 128 identical to `__map__`). Option: 2 bytes per cell (little-endian) for more than 256 tiles. |
| `table` | `.bin` | raw bytes (uv maps, line data, waves, …) |

Options per part: `lz` (byte LZ from `cart-core.js`; the fx needs the 60-token `unlz()` once). Which codecs the suite offers, and why: `docs/COMPRESSION.md`.

Images carry their palette and, if any, their fades (asset `meta`), so every tool shows them in the right colors. This already works between Data Carts, Pixel Studio, Palette & Fades and Tile Maker.

## 3. Anchors: how the fx find their data (0 tokens)

The fx code keeps its own `reload()` calls. A comment names the part:

```lua
reload(0,0x2000,0x2000,"d1.p8") --@data seqgrid.img
reload(0x8000,0x2300,0x2000,"spr_logocolor.p8") --@data litcntr_bg.img
reload(tmp,0x0123,0x0456,"d2.p8") unlz(tmp,0x8000) --@data wormhole.uv
```

A range inside a bigger part of the same cart is anchored as `--@data asset.part+offset`. `demo/suite.json` stores every part's cart, offset and length, so `build.py` can check the lines without decoding assets.

When the builder places the parts, it rewrites the source address, length and cart name of each anchored line in the fx `.p8` files. It never changes the destination: where the data goes in memory is the fx's business.
- Comments cost no tokens, and dev, test and release builds read the same lines.
- `build.py` checks that every anchor's part exists in `suite.json` and fits the line, and fails the release build otherwise.
- Errors the builder reports:
  - an anchor naming a missing part
  - a part no anchor uses (a warning: wasted cart space)
  - a part whose length differs from the line's

### Cart sets

A loop over a literal list of carts reads every cart with the same line:

```lua
local cartnames={"d0.p8", "d1.p8", "d2.p8"} -- rewritten by the builder
reload(0x0,0x0000,0x4300,cartnames[i]) --@data skull_cartnames[]
```

The asset (type `cartset`) has one part per cart (`c1`, `c2`, …). Its parts always sit at offset 0, one per cart. Other parts may fill the rest of those carts.

### Segments

A part can hold several things: Logolit's part is a 16 KB image plus tables, Litcntr's holds sprites, tiles and a fade table. `meta.segments[part]` lists them (`name`, `off`, `len`, `kind`: img / pal / hex, the palette the fx shows an image in). The suite uses this to open a segment in its palette in the other tools, and to write an edited one back into the part (same size).

## 4. Cart builder ("stacks")

A new workspace:
- **Left:** the project's parts, with size, type and a thumbnail.
- **Middle:** the data carts as stacks of 0x4300 bytes, with the gfx / map / flags / music / sfx bands. Each part is a block; the free space is visible.
- **Manual:** drag parts onto stacks and reorder them. The LZ toggle per part shows the size it would have.
- **Auto-pack:** best-fit decreasing, fewest carts first, then fewest `reload()` calls. Constraints:
  - parts with the same `group` go into the same cart, next to each other (one `reload()` can cover them)
  - pinned parts (cart + offset) stay where they are
  - generated cart names are `<prefix><n>.p8` (default `d`); the prefix must not clash with the music carts (`m<n>`, `p<n>`)
- **Write:** writes the carts into `demo/`, rewrites the anchors, saves `suite.json`, reads every cart back and compares it byte for byte.
- **Report:** carts, bytes used and free, number of `reload()` calls at boot, LZ token cost.

Flat demo folders (`main.p8` directly in the folder, like Modulator's) work too: the folder itself is `demo/`.

## 5. Out of scope for phase 1

- Live tile editing between Pixel Studio and Tile Maker (phase 2).
- The map editor (phase 3). A first version exists: the Map Editor workspace edits 8-bit maps up to 256×256 and adds them to a project as `tiles` assets (`.gfx` + `.map`).
- Running PICO-8 from the browser. Byte checks happen in the suite, timing checks stay in PICO-8 (see the optimization notes in `carts/Notes`).

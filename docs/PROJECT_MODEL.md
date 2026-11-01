# Demo project model and Cart Builder

This describes the implementation in the standalone Pico8_Suite repository as reviewed on 2026-11-01 at [1432860512e85a13dab0d1bd2ff0b4d4de780a05](https://github.com/Crylhead/Pico8_Suite/commit/1432860512e85a13dab0d1bd2ff0b4d4de780a05). It replaces the older phase-1 proposal. Open defects are tracked in the [health review](HEALTH_REVIEW_2026-11-01.md); implemented behavior below is not a guarantee that those defects are resolved.

## Folder and persistence

Cart Builder uses Chrome/Edge's File System Access API with read/write permission. Pick a project containing `demo/`, or a flat folder containing `main.p8`. Work in a browser-writable location; protected locations such as `AppData` may be rejected. The selected folder handle is remembered in IndexedDB; reconnect if permission must be granted again.

| Path | Current use |
| --- | --- |
| `demo/*.p8` | FX and data carts; Cart Builder scans this directory, not arbitrary nested FX folders. |
| `demo/suite.json` | Project format version 1, prefix, generated cart layout, unmanaged carts and adoption bookkeeping. |
| `assets/<name>.json` | One asset per file, at the selected project root; parts are stored as base64 bytes. |
| `demo/unused/` | Source/previously generated carts retired by Write Carts. |
| `demo/suite.journal.json` | Present only while a write is in progress or after one was interrupted; holds the original file contents for recovery. |
| `music/`, `tools/`, `release/` | Optional directories belonging to the external demo framework; the Suite does not provide them. |

For a flat project, replace `demo/` with the selected folder itself; `assets/` and `unused/` are then children of that folder. `suite.json` stores each placed part's ref, offset, stored length and LZ flag.

Opening a folder reads its files. **Adopt writes immediately:** it adds anchors to FX carts, creates asset files and writes `suite.json`, then prepares an automatic layout. It does not wait for Write Carts. Later asset edits and rearrangements are staged in memory until Write Carts.

Adoption recognizes literal cart names and supported literal cart lists. Music/track carts and unsupported computed references are left outside conversion and reported where detected.

Source and length must be literal integer arithmetic (numbers, parentheses, `+ - * / \ % & | ^^ << >> >>>`) that stays an integer in PICO-8's 16-bit range, and the read must lie inside the 0x4300-byte data area. Any name, call, fraction or overflow, such as `frame*0x200`, leaves the line unchanged with the reason listed under **Left as they are**. A cart that such a line still reads stays in `demo/` and is not recorded as adopted. If a computed cart name cannot be traced to specific carts, no source cart is recorded as adopted. The preview evaluator used for palette/segment guesses is separate and still treats unknown names as 0. Remaining-reference checks and recoverable writes still need fixes ([#2](https://github.com/Crylhead/Pico8_Suite/issues/2), [#3](https://github.com/Crylhead/Pico8_Suite/issues/3), [#4](https://github.com/Crylhead/Pico8_Suite/issues/4)).

## Assets and bytes

An asset has `format`, `name`, `type`, `meta`, and `parts`. Each part contains `bytes`, `lz` and optional `group`. Names use Lua-identifier-style text; `asset.part` identifies a part. The FX is responsible for interpreting the headerless raw bytes.

| Type | Conventional parts | Representation |
| --- | --- | --- |
| `image` | `img` | Two palette slots per byte, low nibble = left pixel; even-width rows. 128-wide images match sprite-sheet memory layout. |
| `layered` | `img`, `mask`, `fades` | Image plus layer mask and fade bytes, interpreted by the consuming FX. |
| `palette` | `pal` | 16 screen-color bytes: 0–15 or 128–143. |
| `fades` | `fades` | Demo-specific packed palette/fade rows. The Modulator convention uses a screen-palette row followed by packed secondary-palette color pairs. |
| `tiles` | `gfx`, `map` | 128-pixel-wide sheet packed as 4-bit slots; map cells are row-major **8-bit** tile IDs. At width 128, map bytes match `__map__`. |
| `table` | `bin` | Raw bytes such as UV tables, lines or waves. |
| `cartset` | `c1`, `c2`, … | Ordered parts corresponding to a literal list of source carts. These parts remain raw. |

These are supported type names/conventions, not separate creation wizards for every type. Existing-demo adoption and the Add Image / Add Map / Add File actions create the appropriate assets. Assets may contain arbitrary named parts.

The Map Editor supports up to 256×256 cells for editing/export, but **Add Map currently rejects a map part over 0x4300 (17,152) bytes**. It does not split large maps automatically. Two-byte tile IDs and more than 256 tiles are not implemented. Add File has the same one-part capacity limit. General images can also exceed one cart; packing reports oversized parts.

A part may be stored raw or byte-LZ compressed. Raw is the default; LZ needs the generated `unlz()` decoder in the FX. Gamma LZ and target-cart-count compression remain planned; see [COMPRESSION.md](COMPRESSION.md).

Image/palette metadata can carry screen colors and inferred segment information. This does not establish a lossless universal fade round trip: Add Image currently reduces incoming fade metadata to a flag. Preserve actual fade bytes as project parts when the FX needs them.

## Anchors and rewriting

The FX keeps its own destination address and loading code:

```lua
reload(0x8000,0x2000,0x2000,"source.p8") --@data background.img
reload(tmp,0x0123,0x0456,"source.p8") unlz(tmp,0x8000) --@data wormhole.bin
```

A bare `--@data asset.part` follows the whole stored part, including its length. For raw parts, `--@data asset.part+offset` denotes a subrange: the existing call keeps its own length. Explicit `+0` also means a subrange. The offset must lie inside the part, and the length must be positive and end within the part. An out-of-range or overflowing range is reported and nothing is written; it is not clamped. Offsets always count raw part bytes.

The decoder expects a complete LZ stream. For an LZ-packed part, a ranged anchor is accepted only if it is `+0` with exactly the stored (packed) length; any other range is rejected before writing. Use a bare anchor instead, which follows the packed length. The LZ checkbox stays off while any anchor reads the part as a range.

Write Carts rewrites the source address, stored length and cart name, leaving the destination expression unchanged. The builder owns those three arguments, so an anchored line must use a literal source, length and (for a single part) a literal cart name. A computed one is reported and nothing is written, rather than being replaced by a fixed value. Anchors are comments and add no Lua tokens. Current validation checks missing refs, computed anchored arguments, unused-part warnings, raw/LZ call consistency and cart-set offsets; it is not a complete static verifier of arbitrary Lua.

### Cart sets

```lua
local cartnames={"d0.p8","d1.p8"}
reload(0,0,0x4300,cartnames[i]) --@data skull_cartnames[]
```

The builder rewrites the literal list and reload source/length. Auto-pack places each set part at offset zero in its own cart; other parts may fill remaining space. Manual layouts must keep set parts at a common offset.

### Segments and editing

`meta.segments[part]` describes regions inside a part: name, offset, length and kind (`img`, `pal`, `hex`), with optional width/palette. Data Carts analysis infers these from FX code; they are not guaranteed exact.

**→ Library** publishes a segment for editing. **← Library** applies an edited image of the same byte size, or a palette row, back into that part. Write Carts commits the edited bytes to the demo. This is an explicit round trip, not automatic synchronization.

## Packing and writing

- Each data cart has 0x4300 bytes, spanning gfx, map, flags, music and SFX.
- Drag parts between stacks to arrange them manually. Offsets are recomputed contiguously within each stack.
- Auto-pack uses best-fit decreasing after placing cart sets. Grouped parts stay adjacent. This is a heuristic, not a proof of the smallest possible cart count.
- Generated names are `<prefix><n>.p8`, default prefix `d`; foreign cart names are reserved.
- Pinned offsets are **not implemented**. Auto-pack replaces the manual arrangement.
- Write Carts checks placement/capacity, builds and parses generated cart strings for byte/LZ comparison, computes anchor rewrites, requests confirmation, then writes carts/FX/assets/manifest and retires old carts as one recoverable write (see *Recoverable writes*).

### Retiring old carts

Retirement candidates are carts the project wrote before, or adopted, that the new layout no longer uses. A candidate moves to `unused/` only if the **final** sources no longer reference it. The final sources are every demo cart after its anchor rewrite, the new data carts and top-level `.lua` files. A candidate that stays is scanned as a source too, so carts it references also stay.

- References counted are the cart argument of `reload()` and `cstore()` (4th) and `load()` (1st), plus `#include` lines. The scan ignores comments, and calls may span lines. `run()` takes a parameter string, not a cart, so it is not counted. A name without an extension also matches `<name>.p8`.
- Names are resolved as in adoption: literals, a variable assigned once to a literal, `"m"..i..".p8"` patterns and `list[i]` with a literal list.
- A reference that cannot be resolved keeps **every** candidate in place. This covers a computed name, a variable assigned more than once, and an `#include` that is neither a demo cart nor a top-level `.lua` file.
- The Write confirmation lists the carts that will move, the carts that stay with the line that references them, and any unresolved references.
- Carts that stay are no longer owned by the project afterwards. Their names are reserved, and later writes never overwrite or retire them.

Partial adoption does not grant permission to retire a cart: a source cart is retired only when this check passes at write time.

### Recoverable writes

Write Carts and Adopt change several files. Both go through `P8Project.transact()`:

1. **Preflight.** Every target file is read and its current contents kept. A read error stops the write before anything changes.
2. **Journal.** The original contents go to `demo/suite.journal.json` (next to `suite.json`).
3. **Write.** Order: data carts, FX carts, assets (including removal of renamed asset files), then `suite.json` last. Each file is **read back from disk** and compared with what was written.
4. **Commit.** The journal is marked `committed`.
5. **Retire.** Only now do old carts move to `unused/`: copied, read back, then removed. A cart that cannot be moved stays where it is and is reported.
6. **Clean up.** The journal is removed.

If any write or readback fails, every file touched so far is restored, and the journal goes once the restore succeeds. The in-memory project stays dirty, so you can try again. If the restore also fails (or the browser stops mid-write), the journal stays. Cart Builder then refuses further writes until the project is reopened.

On opening, a leftover `writing` journal offers to restore the original contents. A `committed` journal only finishes the retirement. The File System Access API has no atomic rename, so a single file is only as atomic as the browser's swap-file `close()`; the journal is what makes the whole operation recoverable.

### External edits

When it opens the folder, Cart Builder keeps the raw text of every demo `.p8`, `suite.json` and `assets/*.json` as its disk baseline. Write Carts and Adopt compare the disk against that baseline in the preflight. A conflict is any of the following:
- a file it writes, or one its result depends on, now reads differently;
- a file has appeared;
- a file has gone.

On a conflict nothing is written. The dialog lists the files, the disk keeps the external version and Cart Builder keeps its own changes in memory. Opening the folder again continues from the disk versions. Cancelling the confirmation writes nothing. After a successful write the baseline becomes what was written.

The check runs immediately before the journal and the writes. An edit in the short window between that check and the writes themselves is not detected.

There is **no `tools/build.py` release builder in this repository**. Anchor validation runs in Cart Builder; if the surrounding demo framework supplies a release checker, configure and run it there separately.

## Related tools and future work

Map Editor and Code Editor/Run already exist; they are no longer future phases. Run uses the optional Python bridge and your installed PICO-8. Byte checks in JavaScript do not replace running the generated demo in PICO-8.

Live tile editing, shared document/revision semantics and a permanent Send to action remain design proposals. See the [historical review index](https://github.com/Crylhead/Demotools/blob/4a2855b99efb2e7a265961c63f1ac809adea3ed2/reviews/README.md); do not treat those proposals as delivered features.


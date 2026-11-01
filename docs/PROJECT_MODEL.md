# Demo project model and Cart Builder

This describes the implementation in the standalone Pico8_Suite repository as re-reviewed on 2026-11-01 at [ca36c07f2e770055f2c0f69a62bde4142a4dea2f](https://github.com/Crylhead/Pico8_Suite/commit/ca36c07f2e770055f2c0f69a62bde4142a4dea2f). It replaces the older phase-1 proposal. Open defects are tracked in the [health review](HEALTH_REVIEW_2026-11-01_ca36c07.md); implemented behavior below is not a guarantee that those defects are resolved.

## Folder and persistence

Cart Builder uses Chrome/Edge's File System Access API with read/write permission. Pick a project containing `demo/`, or a flat folder containing `main.p8`. Work in a browser-writable location; protected locations such as `AppData` may be rejected. The selected folder handle is remembered in IndexedDB; reconnect if permission must be granted again.

| Path | Current use |
| --- | --- |
| `demo/*.p8` | FX and data carts; Cart Builder scans this directory, not arbitrary nested FX folders. |
| `demo/suite.json` | Project format version 1, prefix, generated cart layout, unmanaged carts and adoption bookkeeping. |
| `assets/<name>.json` | One asset per file, at the selected project root; parts are stored as base64 bytes. |
| `demo/unused/` | Source/previously generated carts retired by Write Carts. |
| `demo/suite.journal.json` | Present only while a write is in progress or after one was interrupted; holds the original file contents, digests of the new contents and the write's state for recovery. |
| `music/`, `tools/`, `release/` | Optional directories belonging to the external demo framework; the Suite does not provide them. |

For a flat project, replace `demo/` with the selected folder itself; `assets/` and `unused/` are then children of that folder. `suite.json` stores each placed part's ref, offset, stored length and LZ flag.

Opening a folder reads its files. **Adopt writes immediately:** it adds anchors to FX carts, creates asset files and writes `suite.json`, then prepares an automatic layout. It does not wait for Write Carts. Later asset edits and rearrangements are staged in memory until Write Carts.

Adoption recognizes literal cart names and supported literal cart lists. Music/track carts and unsupported computed references are left outside conversion and reported where detected.

Source and length must be literal integer arithmetic (numbers, parentheses, `+ - * / \ % & | ^^ << >> >>>`) that stays an integer in PICO-8's 16-bit range, and the read must lie inside the 0x4300-byte data area. Any name, call, fraction or overflow, such as `frame*0x200`, leaves the line unchanged with the reason listed under **Left as they are**. A cart that such a line still reads stays in `demo/` and is not recorded as adopted. If a computed cart name cannot be traced to specific carts, no source cart is recorded as adopted. The preview evaluator used for palette/segment guesses is separate and still treats unknown names as 0. Remaining-reference checks, baseline conflicts and journaled writes have been implemented. Their outstanding edge cases are [#31](https://github.com/Crylhead/Pico8_Suite/issues/31), [#32](https://github.com/Crylhead/Pico8_Suite/issues/32) and [#33](https://github.com/Crylhead/Pico8_Suite/issues/33).

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

Write Carts rewrites the source address, stored length and cart name, leaving the destination expression unchanged. The builder owns those three arguments, so an anchored line must use a literal source, length and (for a single part) a literal cart name. A computed one is reported and nothing is written, rather than being replaced by a fixed value. Anchors are comments and add no Lua tokens. Current validation checks missing refs, computed anchored arguments, unused-part warnings, raw/LZ call consistency and cart-set offsets; it is not a complete static verifier of arbitrary Lua. The anchor parser currently accepts some invalid suffix prefixes (for example `+frame` or `+-1` can become a bare ref); [#34](https://github.com/Crylhead/Pico8_Suite/issues/34) tracks strict whole-payload validation.

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

Partial adoption does not grant permission to retire a cart: a source cart is retired only when this check passes at write time. Current limitation: the scan misses valid string-call forms such as `load"old.p8"`; [#33](https://github.com/Crylhead/Pico8_Suite/issues/33) tracks that unsafe retirement case.

### Recoverable writes

Write Carts and Adopt change several files. Both go through `P8Project.transact()`:

1. **Lock.** The whole write, from preflight to clean-up, holds the Cart Builder write lock (see *One writer at a time*).
2. **Preflight.** Every target file is read and its current contents kept. A read error, an existing journal or a baseline conflict stops the write before anything changes.
3. **Journal.** `demo/suite.journal.json` (next to `suite.json`) records a random write id, the state `writing`, the original contents of every target and a digest (length plus a 64-bit non-cryptographic hash) of its new contents. It is read back before any other file changes.
4. **Write.** Order: data carts, FX carts, assets (including removal of renamed asset files), then `suite.json` last. Each file is **read back from disk** and compared with what was written.
5. **Commit.** The journal is marked `committed` and read back.
6. **Retire.** Only now do old carts move to `unused/`: copied, read back, then removed. A cart that cannot be moved stays where it is and is reported.
7. **Clean up.** The journal is removed if it is still this write's journal (same id).

If a write or readback fails before the commit, the journal still says `writing`, and the transaction restores every file touched so far. If the `committed` marker fails to close or to read back, it may or may not be on disk; the journal is first marked `rolling-back` (and read back), and only then are the originals restored. If even that marker cannot be written, nothing is restored: every file keeps its verified new contents and the journal stays for recovery to finish or undo. The journal is removed only once the folder holds one coherent revision. A write that fails keeps the in-memory project dirty, so you can try again; while a journal remains, Cart Builder refuses further writes until the project is reopened.

On opening, recovery takes the same lock and decides from the files, not from the marker alone:

| Journal state | Files now hold | Recovery |
| --- | --- | --- |
| `committed` | every new content (digests match) | Finishes the retirement, then removes the journal. |
| any | every original content | Nothing to restore or retire; removes the journal. |
| `writing` or `rolling-back` | anything else | Asks, then restores the originals (journal marked `rolling-back` first). |
| `committed` | neither revision (for example a file edited after the commit) | Changes nothing and lists the files. Only if you confirm does it restore the originals and move retired carts back from `unused/`. |
| empty file | — | The browser stopped while creating the journal, before any other file changed; removes it. |

An unreadable journal, an unknown state or any restore failure leaves the journal (with the originals) in place and reports it. Journals written before this format carry no digests, so a leftover `committed` one is treated as unverifiable: it is finished only if every file still holds its original contents (then nothing is retired), otherwise you are asked as for a mixed folder. The File System Access API has no atomic rename; correctness relies on each file's close replacing its contents as a whole, as Chrome/Edge do through a swap file.

#### One writer at a time

A Cart Builder write, Adopt or recovery never runs alongside another. In one page, the actions and folder switching are disabled while one runs, and `transact()`/`recover()` refuse a second caller at once (`busy`, nothing touched) instead of queueing a write computed from an older state. Across tabs of the same origin the lock is the Web Locks API (`navigator.locks`, available in every browser that can write folders). A browser without Web Locks only serializes the page; another tab is then detected only on a best-effort basis. A write checks before every file, every journal update and its clean-up that the journal on disk is still exactly the text it wrote; a recovery marks the journal with its own id before restoring. A write that finds the journal changed or gone stops at once (stage `ownership`) and never deletes another writer's journal. If another tab's journal or recovery marker is there, it touches nothing and leaves the decision to that tab. If the journal is gone (a recovery restored the originals and removed it while this write was still in flight), it puts every file that still holds its own new contents back to the original it keeps in memory. Not covered: a file write landing just after another tab's recovery restored that file but before it removed the journal, and the `committed` marker overwriting another tab's `rolling-back` marker between the check and the write. The File System Access API has no compare-and-swap to close these windows, which is why Web Locks are used wherever they exist. Other programs (PICO-8, an editor, another browser profile) are not covered by the lock; their edits are detected as baseline conflicts below.

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


# Demo project model and Cart Builder

This describes the implementation in the standalone Pico8_Suite repository as re-reviewed on 2026-11-02 at [72f6e029412ce06afe0576bd60f59aca0d44c52f](https://github.com/Crylhead/Pico8_Suite/commit/72f6e029412ce06afe0576bd60f59aca0d44c52f). It replaces the older phase-1 proposal. Open defects and fix provenance are tracked in the [current health review](HEALTH_REVIEW_2026-11-02_72f6e02.md); implemented behavior below is not a guarantee that those defects are resolved.

## Folder and persistence

Cart Builder uses Chrome/Edge's File System Access API with read/write permission. Pick a project containing `demo/`, or a flat folder containing `main.p8`. Work in a browser-writable location; protected locations such as `AppData` may be rejected. The selected folder handle is remembered in IndexedDB; reconnect if permission must be granted again.

| Path | Current use |
| --- | --- |
| `demo/*.p8` | FX and data carts; Cart Builder scans this directory, not arbitrary nested FX folders. |
| `demo/suite.json` | Project format version 1, prefix, generated cart layout, unmanaged carts and adoption bookkeeping. |
| `assets/<name>.json` | One asset per file, at the selected project root; parts are stored as base64 bytes. |
| `demo/unused/` | Source/previously generated carts retired by Write Carts. |
| `demo/suite.journal.json` | Present only while a write is in progress or after one was interrupted; holds the original file contents, the original contents at both places of every cart it retires, digests of the new contents and the write's state for recovery. |
| `music/`, `tools/`, `release/` | Optional directories belonging to the external demo framework; the Suite does not provide them. |

For a flat project, replace `demo/` with the selected folder itself; `assets/` and `unused/` are then children of that folder. `suite.json` stores each placed part's ref, offset, stored length and LZ flag.

Opening a folder reads its files. **Adopt writes immediately:** it adds anchors to FX carts, creates asset files and writes `suite.json`, then prepares an automatic layout. It does not wait for Write Carts. Later asset edits and rearrangements are staged in memory until Write Carts.

Adoption recognizes literal cart names and supported literal cart lists. Music/track carts and unsupported computed references are left outside conversion and reported where detected.

Source and length must be literal integer arithmetic (numbers, parentheses, `+ - * / \ % & | ^^ << >> >>>`) that stays an integer in PICO-8's 16-bit range, and the read must lie inside the 0x4300-byte data area. Any name, call, fraction or overflow, such as `frame*0x200`, leaves the line unchanged with the reason listed under **Left as they are**. A cart that such a line still reads stays in `demo/` and is not recorded as adopted. If a computed cart name cannot be traced to specific carts, no source cart is recorded as adopted. The preview evaluator used for palette/segment guesses is separate and still treats unknown names as 0. Remaining-reference checks, baseline conflicts and journaled writes have been implemented. Their limits are described under *Retiring old carts* and *Recoverable writes* below.

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

Write Carts rewrites the source address, stored length and cart name, leaving the destination expression unchanged. The builder owns those three arguments, so an anchored line must use a literal source, length and (for a single part) a literal cart name. A computed one is reported and nothing is written, rather than being replaced by a fixed value. Anchors are comments and add no Lua tokens. Current validation checks the anchor syntax, missing refs, computed anchored arguments, unused-part warnings, raw/LZ call consistency and cart-set offsets; it is not a complete static verifier of arbitrary Lua.

**Where anchors are found.** Anchors are discovered through the shared Lua lexer (the Code Editor's), consistently by Write Carts, the check, Adopt and asset renames. The marker `--@data` (not followed by a letter, digit or `_`) counts only inside a real `--` line comment of the cart's Lua. The same text inside a quoted string (including escaped quotes), a long string `[[…]]`/`[=[…]=]` of any level or a long comment `--[[…]]` is data, never an anchor, and is never rewritten. The anchored call is the single executable `reload()` on the comment's line; a `reload` inside a string or comment is not a call. A line with more than one executable `reload()`, or an anchored `reload()` spread over several lines, is rejected with its line and a reason instead of guessing which call is meant; nothing is written.

**Anchor syntax.** The whole payload after the marker is parsed:

```
--@data <asset>.<part>                  whole part
--@data <asset>.<part> + <offset>       subrange; spaces around + are optional
--@data <asset>[]                       cart set (no offset)
<offset> = decimal digits or 0x hex digits, 0..0xffff
```

After the payload only whitespace may follow, or whitespace and then `--` with free text (`--@data bg.img -- title picture`). Anything else makes the anchor malformed: for example `+-1`, `+frame`, `+0x10*2`, `+0x`, `+0xg`, `+` without an offset, an offset over 0xffff, `x.bin--note` (no space), `x.bin junk`, an offset on a cart set, a payload that is not `asset.part`/`asset[]` (or nothing), and a second `--@data` on the line. A malformed anchor is never read as a shorter one: Write Carts and the check list it with its file and line, the line is left unchanged and nothing is written. Adopt does not add a second anchor to such a line; it lists it under **Left as they are** and keeps the cart that line reads in place.

### Cart sets

```lua
local cartnames={"d0.p8","d1.p8"}
reload(0,0,0x4300,cartnames[i]) --@data skull_cartnames[]
```

The builder rewrites the literal list and reload source/length. Auto-pack places each set part at offset zero in its own cart; other parts may fill remaining space. Manual layouts must keep set parts at a common offset.

The anchored call's cart argument must be `name[index]`, and `name` must be proven to hold a literal list in the executable code (comments and strings never count as a binding):

- exactly one assignment `name={…}` or `local name={…}`, whose table literal is the whole value (not `{…}..x`, not part of a longer expression);
- every entry a plain quoted or long-bracket string without escapes, separated by `,` or `;` (comments between entries are allowed). `{"old.p8",other}`, `{"old.p8"..suffix}`, `{f()}`, keyed entries and an empty list are rejected;
- every other use of `name` only reads it: `name[i]` (never assigned, also not as a target of `name[i],x=…`), `#name`, `all(name)`, `ipairs(name)`, `pairs(name)`, `count(name)` — the last four only while that helper is PICO-8's builtin: if the code defines, assigns or declares a function, local, parameter or loop variable of that name anywhere, uses `_ENV`/`_G`, or has an `#include`, the helper may change the list and the list is not proven (#82; fields such as `o.count` and table keys `{count=…}` do not count). Any other use (`name[1]="x"`, `add(name,…)`, `del(…)`, passing it to a function, a second assignment, an assignment inside a function that sits in a table or call, a target of a multiple assignment, including targets such as `f().x`, `(t).x` or `g"k".x`) is rejected;
- a global `name` is rejected when the code uses `_ENV`/`_G` or has an `#include` that could change it; a local proves only uses after its declaration and inside its own block (`function`/`do`/`repeat` … `end`/`until`, and each `then`/`elseif`/`else` branch separately; PICO-8's shorthand `if (c) x` / `while (c) x` is `if c then x end`, a block that ends with its line). Outside that block another `name` applies, so the use is rejected. A local declared on a shorthand line after an explicit `end`/`until` is rejected, because which block that `end` closes is unclear.

A rejected list is reported with the file, the line and the reason; the list, the call and every cart it names stay unchanged and in place. When the list keeps its entry count, each entry string is replaced in place, keeping separators and comments; a list with comments whose length must change is rejected rather than rebuilt. Two set anchors that would rewrite the same list are rejected. Adopt applies the same rules.

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

Retirement candidates are carts the project wrote before, or adopted, that the new layout no longer uses. A candidate moves to `unused/` only if the **final** sources no longer reference it. The final sources are every demo cart after its anchor rewrite, the new data carts and top-level `.lua` files. A candidate that stays is scanned as a source too, so carts it references also stay. This includes a candidate that stays because this write rewrites its anchors: it is a source from the start of the analysis, not removed from the moves afterwards.

- References counted are the cart argument of `reload()` and `cstore()` (4th) and `load()` (1st), plus `#include` lines. The Lua is read with the shared lexer (the Code Editor's, also used by Project Audit), so comments, string contents and `#include` text inside strings or comments of any long-bracket level are not references, and calls may span lines. `run()` takes a parameter string, not a cart, so it is not counted. A name without an extension also matches `<name>.p8`.
- Lua's call forms with a single string argument count like the parenthesized call: `load"old.p8"`, `load'old.p8'`, `load [[old.p8]]` and `load[==[old.p8]==]` keep `old.p8` as `load("old.p8")` does (and `load"old"` keeps `old.p8`). A long-bracket literal inside parentheses, `load([[old.p8]])`, is read as a literal too. `reload"x"`, `cstore{…}` and the like pass one argument, so they name no other cart.
- Member calls (`obj.load"x"`, `obj:load("x")`) and definitions (`function load(…)`, `local load=…`, `load=…`) are not the PICO-8 function and are not counted. `_ENV.load(…)` and `_G.reload(…)` are the PICO-8 functions and are counted. Indexing the globals table (`_G["load"]`, `_ENV[k]`) or using it as a value (`__index=_ENV`, `local g=_G`) is an unresolved reference: the functions may be called through it.
- A name counts as resolved only when the executable code proves it: a literal string, a variable with exactly one assignment whose value is itself resolved (no other write, including targets of multiple assignments at any nesting; no `_ENV`/`_G` or `#include` that could change a global; a local only within its own block), a concatenation `..` whose every fragment is resolved (a fragment of unknown value, such as `"m"..i..".p8"` or `name..".p8"` with `name` assigned twice, is **not** assumed to be a number), and `list[i]` with a proven literal list (see *Cart sets*: a list that is mutated, reassigned, passed to a function or has computed entries is not proven). Data Carts' palette/segment previews still use the approximate preview resolver and mark those reads *inferred*; it is never used for retirement or adoption.
- A reference that cannot be resolved keeps **every** candidate in place and is listed. This covers a computed name, a variable assigned more than once, a string with escapes, `load{…}` (a table instead of a name), any other use of `load`, `reload` or `cstore` that is not a call (`local f=load`, `pcall(load,"x.p8")`: the cart it is later called with cannot be traced), and an `#include` that is neither a demo cart nor a top-level `.lua` file.
- The Write confirmation lists the carts that will move, the carts that stay with the line that references them, and any unresolved references.
- Carts that stay are no longer owned by the project afterwards. Their names are reserved, and later writes never overwrite or retire them.

Partial adoption does not grant permission to retire a cart: a source cart is retired only when this check passes at write time. The scan is lexical, not a Lua evaluator: a local name that shadows `load` may still be treated as the PICO-8 function (conservatively retaining carts); member calls are excluded as described above. Uncertainty never permits a move: a computed cart name with an unknown fragment keeps every candidate in place, even when the intended carts are obvious to a reader (for example `load("m"..i..".p8")`). Write such names as a literal list (`local ms={"m1.p8","m2.p8"} load(ms[i])`) to let unreferenced carts retire. Adoption traces the cart an unanchored line reads with the same rules; an unresolved one records no source cart as adopted.

### Recoverable writes

Write Carts and Adopt change several files. Both go through `P8Project.transact()`:

1. **Lock.** The whole write, from preflight to clean-up, holds the Cart Builder write lock (see *One writer at a time*).
2. **Preflight.** Every target file is read and its current contents kept, and so is every cart to retire, both in `demo/` and at its place in `unused/`. A read error, an existing journal, a baseline conflict or a file that would be both written and retired stops the write before anything changes.
3. **Journal.** `demo/suite.journal.json` (next to `suite.json`, format 3) records a random write id, the state `writing`, the original contents of every target, a digest (length plus a 64-bit non-cryptographic hash) of its new contents, and for every cart to retire what `demo/` and `unused/` held under its name. It is read back before any other file changes.
4. **Write.** Order: data carts, FX carts, assets (including removal of renamed asset files), then `suite.json` last. Each file is **read back from disk** and compared with what was written.
5. **Commit.** The journal is marked `committed` and read back.
6. **Retire.** Only now do old carts move to `unused/`: copied, read back, then removed. A cart that cannot be moved stays where it is and is reported. An older file of the same name already in `unused/` is never overwritten: that cart stays in `demo/` and is reported. Before every move the write checks that the journal is still its own; once it is not, no further cart moves.
7. **Clean up.** The journal is removed if it is still this write's journal (same id).

If a write or readback fails before the commit, the journal still says `writing`, and the transaction restores every file touched so far. If the `committed` marker fails to close or to read back, it may or may not be on disk; the journal is first marked `rolling-back` (and read back), and only then are the originals restored. If even that marker cannot be written, nothing is restored: every file keeps its verified new contents and the journal stays for recovery to finish or undo. The journal is removed only once the folder holds one coherent revision. A write that fails keeps the in-memory project dirty, so you can try again; while a journal remains, Cart Builder refuses further writes until the project is reopened.

On opening, recovery takes the same lock and decides from the files, not from the marker alone:

| Journal state | Files now hold | Recovery |
| --- | --- | --- |
| `committed` | every new content (digests match) | Finishes the retirement from wherever it stopped (a copy already in `unused/` is reused), then removes the journal. |
| any | every original content, and every retired cart back in `demo/` with `unused/` as it was | Nothing to restore; removes the journal. |
| `writing` or `rolling-back` | anything else | Asks, then restores the originals **and** moves every retired cart back (journal marked `rolling-back` first). |
| `committed` | neither revision (for example a file edited after the commit) | Changes nothing and lists the files. Only if you confirm does it restore the originals and move retired carts back from `unused/`. |
| empty file | — | The browser stopped while creating the journal, before any other file changed; removes it. |

"Original" covers the retired carts: the old revision is reached only when every written file holds its original contents (or is absent again) **and** every retired cart is back in `demo/` with the contents it had, and this write's copies are gone from `unused/` (an older file of the same name there is put back). Because the journal records those originals from the start, the obligation does not depend on the marker: a rollback that fails or stops part-way (after its `rolling-back` marker, after restoring the files, or between copying a cart back and removing its `unused/` copy) leaves the journal, and the next recovery carries on from what the files hold. After restoring, recovery reads the whole folder back and removes the journal only if it is the complete old (or, when finishing, the complete new) revision.

Recovery never overwrites a file it did not write. If `demo/` holds a different file where a retired cart belongs, the rollback leaves it and the `unused/` copy alone, reports it and keeps the journal (which still holds the original); move the other file away and reopen the project. An empty file where a cart was being created is the residue of an interrupted copy and is completed or removed. When finishing a write, a cart whose `demo/` copy was edited (or recreated) after the write started stays in place (reported, not an error); a copy of the original already in `unused/` is kept there, because the files alone cannot show whether it is the only one left. Only an empty residue is removed.

An unreadable journal, an unknown state or any restore failure leaves the journal (with the originals) in place and reports it. Format 1 journals carry no digests, so a leftover `committed` one is treated as unverifiable: it is finished only if every file still holds its original contents (then nothing is retired), otherwise you are asked as for a mixed folder. Format 2 journals do not record the retired carts' originals: recovery reconstructs that obligation from the folder (a cart found only in `unused/` is moved back) and writes it into the journal with the `rolling-back` marker, so later retries keep it. The File System Access API has no atomic rename; correctness relies on each file's close replacing its contents as a whole, as Chrome/Edge do through a swap file.

#### One writer at a time

A Cart Builder write, Adopt or recovery never runs alongside another. In one page, the actions and folder switching are disabled while one runs, and `transact()`/`recover()` refuse a second caller at once (`busy`, nothing touched) instead of queueing a write computed from an older state. Across tabs of the same origin the lock is the Web Locks API (`navigator.locks`, available in every browser that can write folders). A browser without Web Locks only serializes the page; another tab is then detected only on a best-effort basis. A write checks before every file, every journal update, every cart move and its clean-up that the journal on disk is still exactly the text it wrote; a recovery marks the journal with its own id before restoring and checks before every change that the journal is still the one it wrote or read. A write that finds the journal changed or gone stops at once (stage `ownership`) and never deletes another writer's journal. If another tab's journal or recovery marker is there, it touches nothing and leaves the decision to that tab. If the journal is gone (a recovery restored the originals and removed it while this write was still in flight), it puts every file that still holds its own new contents back to the original it keeps in memory. Not covered: a file write landing just after another tab's recovery restored that file but before it removed the journal, and the `committed` marker overwriting another tab's `rolling-back` marker between the check and the write. The File System Access API has no compare-and-swap to close these windows, which is why Web Locks are used wherever they exist. Other programs (PICO-8, an editor, another browser profile) are not covered by the lock; their edits are detected as baseline conflicts below.

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


## Cart Builder workflow and preflight (UX #66)

The Cart Builder UI is organised as four stages, shown as a strip above the stacks (`js/preflight-core.js`, `stages()`):

1. **Analyze** (read-only): opening a folder reads `demo/`, `assets/` and `demo/suite.json`. Nothing is written.
2. **Plan**: place every part into a data cart. Besides drag-and-drop and Auto-pack, each part has **Move…** (cart, "A new cart" or "Not placed"), which uses the same `moveTo()` as a drop.
3. **Validate**: the report below the stacks and the existing checks (anchors, sizes, byte-for-byte cart check). Errors block writing.
4. **Commit**: **Write Carts** first opens a preflight dialog (`build()`), generated from the plan `writeAll()` already computed: every file target with its action (added / changed / removed / moved to `unused/`), counts, the carts that stay because they are still referenced, and unresolved references (which prevent any cart from being moved). Only the confirm button writes. Cancel or Esc writes nothing and keeps the in-memory arrangement. The strip shows *Commit: done* only after a verified write and only while nothing changed since.

**Adopt** is the one action that writes before "Write Carts": its preflight dialog lists the anchor edits per fx cart, the new `assets/*.json` files and `demo/suite.json` before the first byte is written.

Unchanged by this UX layer (issues #40–#44 own them): plan validation, `P.transact`, journaling and recovery, retirement analysis, anchor rewriting and the resulting bytes. The preflight only presents the same data; it never writes or computes a different plan.

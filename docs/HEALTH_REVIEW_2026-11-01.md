# Standalone repository health review — 2026-11-01

- **Repository:** Crylhead/Pico8_Suite
- **Scope:** all four original Markdown documents, F1/Home/help text, all 23 JavaScript files, HTML/CSS asset wiring, optional Python bridge and committed tests.
- **Reviewed branch:** main
- **Reviewed commit:** [1432860512e85a13dab0d1bd2ff0b4d4de780a05](https://github.com/Crylhead/Pico8_Suite/commit/1432860512e85a13dab0d1bd2ff0b4d4de780a05)
- **Snapshot:** all 33 tracked source files fetched at the committed SHA above. No uncommitted application changes formed the reviewed baseline. The later documentation/help-text commit is separate from this source SHA.
- **Reviewer:** Codex
- **Assessment:** the plain-JavaScript core/UI separation is useful and the existing regression runner passes, but cart mutation, durable save reporting and history recovery have concrete correctness gaps. The repository is not yet protected by CI. Address data preservation before broad UX restructuring.

## Actionable issues

P1 means work/data can be lost or a supported generated demo can change behavior; P2 covers incorrect analysis, reproducibility, bounded memory, bridge hardening and missing automation. Priority is in each title so it remains visible without custom labels.

| Issue | Priority | Work item | Evidence |
| --- | --- | --- | --- |
| [#1](https://github.com/Crylhead/Pico8_Suite/issues/1) | P1 | Reject unresolved expressions before adopting or rewriting reload ranges | Executed focused probe; source inspection |
| [#2](https://github.com/Crylhead/Pico8_Suite/issues/2) | P1 | Keep source carts while skipped or unanchored consumers still reference them | Executed focused probe; source inspection |
| [#3](https://github.com/Crylhead/Pico8_Suite/issues/3) | P1 | Make multi-file Cart Builder writes recoverable after a failed operation | Source inspection |
| [#4](https://github.com/Crylhead/Pico8_Suite/issues/4) | P1 | Detect external edits before writing carts or saving a cart's Lua section | Source inspection |
| [#5](https://github.com/Crylhead/Pico8_Suite/issues/5) | P1 | Report IndexedDB failures and retain dirty state until durable saving succeeds | Executed focused probe; source inspection |
| [#6](https://github.com/Crylhead/Pico8_Suite/issues/6) | P1 | Keep edits made during an asynchronous Code Editor save marked unsaved | Executed focused probe; source inspection |
| [#7](https://github.com/Crylhead/Pico8_Suite/issues/7) | P1 | Reject compressed subrange anchors and invalid raw anchor offsets | Executed focused probe; source inspection |
| [#8](https://github.com/Crylhead/Pico8_Suite/issues/8) | P2 | Save Terrain Lab's PICO-8 output settings and palette dependencies in scene files | Source inspection |
| [#9](https://github.com/Crylhead/Pico8_Suite/issues/9) | P1 | Preserve Terrain bitmap and heightmap sources across Undo and Redo | Executed focused probe; source inspection |
| [#10](https://github.com/Crylhead/Pico8_Suite/issues/10) | P2 | Apply Pixel Studio history limits to structural edits and redo snapshots | Source inspection |
| [#11](https://github.com/Crylhead/Pico8_Suite/issues/11) | P2 | Make Audit token and include analysis respect Lua long brackets and PICO-8 cart tabs | Executed focused probe; source inspection |
| [#12](https://github.com/Crylhead/Pico8_Suite/issues/12) | P2 | Fix Data Carts read-range analysis and label uncertain space honestly | Executed focused probe; source inspection |
| [#13](https://github.com/Crylhead/Pico8_Suite/issues/13) | P2 | Authenticate the local PICO-8 bridge and validate request hosts | Source inspection |
| [#14](https://github.com/Crylhead/Pico8_Suite/issues/14) | P2 | Run the existing small regression suite and syntax checks in GitHub Actions | Source inspection |

Each issue contains the pinned source, observed failure or explicit static rationale, requested scope and acceptance checks. No coding agent was assigned or implementation job launched by this review.

### Suggested implementation order

1. Establish the small CI gate (#14), preserving the six existing cases.
2. Coordinate #1/#2/#3/#4/#7 as one Cart Builder sequence: conservative adoption, reference-safe retirement, disk conflicts, recoverable install and valid raw/LZ ranges. These share files and should not be rewritten independently without coordination.
3. Fix storage outcomes (#5), Code Editor save revisions (#6) and Terrain resource retention (#9).
4. Complete scene recipes (#8), memory limits (#10), consistent lexical/range analysis (#11/#12) and local bridge pairing/validation (#13).

Keep each PR focused; a few meaningful fixtures are preferable to large repetitive test suites. Preserve raw-default compression, byte-LZ compatibility, palette slots and existing useful transfer routes.

## Executed observations

The following used the actual core functions or extracted actual UI/storage functions in isolated Node VM contexts with fake I/O. They are diagnostics, not browser end-to-end tests.

| Area | Input / fault | Observed result |
| --- | --- | --- |
| Dynamic adoption (#1) | `reload(0,frame*0x200,0x200,"atlas.p8")` | Unknown frame evaluated to 0; adoption made an anchor and rewriting replaced the dynamic address with a fixed one. |
| Remaining consumers (#2) | One literal atlas reload plus one using a variable cart name | atlas.p8 listed as adopted, variable read skipped. Retirement condition would move it; real deletion was not run. |
| Storage (#5) | A fake IndexedDB transaction throws | assets.put resolved with an asset, cache contained it, notification emitted and persistent() stayed true. |
| Async save (#6) | Delay writeHandle; change editor from old to new before completion | Disk payload was old; savedLua became new and dirty was false. |
| Compressed slice (#7) | Repeated 100-byte part; LZ enabled; anchor +5 with length 10 | Stream packed to 22 bytes; rewrite read from byte 5 for 10 bytes; validation returned no error. |
| Terrain history (#9) | Snapshot scene A, replace bitmap/import stores, Undo | Previous import ID/stamp bitmap returned, but both backing resources were missing. |
| Token estimates (#11) | `x=1` versus the same code after a level-1 long comment | 3 versus 7 tokens. Equivalent `[[x y]]` / `[=[x y]=]` string forms counted as 3 / 8 in assignments. |
| Own-data reads (#12) | Populated ROM, memcpy source 0x2000 length 0x2000 | Only map region marked, missing intersected flags/music/SFX. A block-comment sget also incorrectly marked gfx. |

The full filesystem install/retirement sequence, actual quota aborts, browser save dialogs, retained-memory pressure and bridge exploitability were not exercised. Their issue descriptions distinguish source findings from executed observations.

## Checks run

Review environment: Node.js 24.22.1, Python 3.12.14.

| Check | Result |
| --- | --- |
| `node tests/regress.js` | 6/6 passed. |
| `node --check` on all `js/*.js` | All 23 passed. |
| `python -m py_compile tools/pico8_bridge.py` | Passed. |
| HTML IDs and script/style references | 392 unique IDs; all 25 local script/style references exist. |
| Byte-LZ JS round trips | 24/24 passed: lengths 0, 1, 2, 3, 127, 128, 129, 17152; zero, periodic and seeded byte data. |
| Arbitrary ROM write/parse round trips | 4/4 passed: zeros, 0xff, byte ramp and seeded data over 0x4300 bytes. |
| Markdown local file links | Checked after documentation edits; targets exist. |

The focused failure probes are temporary review diagnostics, not an expanded committed suite. Default automated regression coverage remains the six existing cases. Fixes should add durable focused regressions as requested in each issue.

No PICO-8 executable checks, Chrome GUI/worker journeys, Windows filesystem permission tests, full accessibility review or performance measurements were run. JavaScript round trips show internal consistency, not independent PICO-8 compatibility. The original README's larger parity/performance numbers remain clearly labeled historical reports.

## Documentation corrections

- Replaced broken parent-directory review links with a current local review and verified historical Demotools references.
- Added standalone setup, local server/origin, browser capability, optional bridge and developer-check instructions.
- Added missing Map/Code module entries and explicit contributor guidance.
- Replaced the old phase-1 project proposal with current behavior: adoption writes immediately, offsets are recomputed, there is no pinned placement or 16-bit map support, large map parts are rejected, and generated carts are verified in memory before disk writes.
- Removed claims that this checkout includes a release builder, benchmark harness or desktop tools. Corrected those references in F1/Home/help messages too.
- Corrected the extension example's invalid await usage and included map assets.
- Distinguished raw/byte LZ implementation from planned gamma/target-cart compression. Identified the inherited benchmark's inconsistent category count (35 reported total versus 36 categorized); no replacement measurement was invented.
- Clarified that Library backups cover saved assets, scene JSON omits PICO-8 output settings, and shared browser persistence is not proof of a successful write.

This documentation commit does not fix the code defects above. Informational text/comments in index.html, suite.js, project.js and code.js, plus bridge docstrings/launcher comments, change only guidance.

## Earlier findings and design proposals

Verified historical source: [Demotools review index](https://github.com/Crylhead/Demotools/blob/4a2855b99efb2e7a265961c63f1ac809adea3ed2/reviews/README.md). Earlier reviewed SHAs remain in those records.

Some historical findings have progressed in this imported snapshot:

- **P8S-002:** explicit +0 raw subranges retain their original length; three current regressions pass.
- **P8S-008:** repeated/diamond includes expand correctly and true cycles stop; three current regressions pass. Other lexical/tab issues remain (#11).
- **P8S-006:** Save now returns saved/downloaded/cancelled and folder switching/Run check that result. The previous missing-outcome failure path is addressed in source; this review found a separate revision race (#6).
- **P8S-010:** a six-case harness now exists; CI and broader failure coverage remain (#14).

The earlier health findings still relevant here map to the issue bodies. Older reports are not automatically current evidence. Their wider UX and numeric-height recommendations remain historical backlog context, not a claim that all were revalidated in this pass.

The [Tile Maker reconstruction plan](https://github.com/Crylhead/Demotools/blob/4a2855b99efb2e7a265961c63f1ac809adea3ed2/reviews/2026-10-31-tilemaker-map-workflow-4abe8a9.md) and [Send to + Library visual proposal](https://github.com/Crylhead/Demotools/blob/4a2855b99efb2e7a265961c63f1ac809adea3ed2/reviews/2026-10-31-suite-send-to-ux-68cd506.md) are preserved as external references. The latter offers Quick Send, Asset Dock and Output Shelf. Documentation was authorized previously; a final variant has not been selected. Do not silently promote that proposal to an approved redesign while fixing these correctness issues.

For a later review, create a new dated report with its own full source SHA. Record each resolution's fix commit and validation separately; preserve this snapshot's provenance.


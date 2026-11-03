# Integrated code review — 2026-11-03

Reviewed source: [`fd31e3cbfdc77d0944cdc1966883282807f452de`](https://github.com/Crylhead/Pico8_Suite/commit/fd31e3cbfdc77d0944cdc1966883282807f452de), the fetched `main` for this review. This report proposes no implementation changes and closes no issues.

The original fixes and the new UX features are integrated, but six further correctness gaps are reproducible. Passing the existing suite does not cover these cases.

## Findings and order

| Priority | Issue | Confirmed behavior |
| --- | --- | --- |
| P1 | [#80](https://github.com/Crylhead/Pico8_Suite/issues/80) | Pixel Studio save completion clears newer edits' dirty state and can attach the previous image's Library ID to another document. |
| P1 | [#81](https://github.com/Crylhead/Pico8_Suite/issues/81) | Tile Maker's direct Map Editor send replaces an unsaved map and clears undo without asking. |
| P1 | [#82](https://github.com/Crylhead/Pico8_Suite/issues/82) | A redefined list helper defeats immutability analysis, permitting retirement/adoption of a cart still read by executable code. |
| P2 | [#83](https://github.com/Crylhead/Pico8_Suite/issues/83) | Changing Code Editor folders preserves a stale include parent; Run can launch an unrelated cart from the new folder. |
| P2 | [#84](https://github.com/Crylhead/Pico8_Suite/issues/84) | Cancelling a Tile Maker import still adopts its palette/fades and persists a changed color mode. |
| P2 | [#85](https://github.com/Crylhead/Pico8_Suite/issues/85) | Default diagnostics redact messages but retain arbitrary error-name and stack identifiers. |

Prioritize #80/#81/#82. Coordinate #81 and #84 because both concern actual transfer adapters. Keep #82 under one parser owner. These are specific defects; broader UX acceptance items already open as #56/#57/#60/#61/#64–#68 remain separate work.

## Methods and validation

Repository instructions, current source, existing tests and related issues/PRs were inspected. Baseline checks ran once on the reviewed source:

| Check | Result |
| --- | --- |
| `node tests/regress.js` | 205 passed |
| `node tests/check-static.js` | 402 unique IDs; 43 local script/style references resolve |
| `node --check` on all 41 `js/*.js` files | Passed |
| `python -m py_compile tools/pico8_bridge.py` | Passed |
| `python -m unittest discover -s tests -p 'test_*.py' -q` | 5 passed |

Additional bounded probes executed current core modules and extracted actual UI functions in Node VM contexts with minimal UI stubs, delayed fake storage and existing fake-handle/editor fixtures. These probes asserted stored pixels, open document identity, dirty flags, prompts, final map contents/history, settings writes, rewritten source, retirement/adoption results, diagnostic fields and an actual `/run` payload. No application/test implementation was changed; temporary probes were kept outside the repository.

A browser launch was attempted once. Playwright is installed, but its Chromium executable is absent; no browser was downloaded. Native Chrome/Edge pickers, cross-tab interaction, Windows, touch/screen-reader behavior and PICO-8 runtime/export validation were not performed. Earlier contributors' browser evidence in PRs/changelogs remains attributed historical evidence, not a check rerun here. Runtime consequences described below follow the source and controlled probes; no real user files or private data were used.

## #80 — Pixel Studio asynchronous Library saves

Source: [`js/studio.js:2516`](https://github.com/Crylhead/Pico8_Suite/blob/fd31e3cbfdc77d0944cdc1966883282807f452de/js/studio.js#L2516).

`saveToLibrary()` captures an asset, awaits `S.assets.put()`, then unconditionally sets `ps.assetId` and clears `ps.dirty`. It does not check which document/revision was saved.

Two probes ran actual `currentAsset/saveToLibrary/confirmDiscard` with the real studio core:

- Save A with pixel slot 1; pause storage completion; paint slot 7; complete. Stored pixel: 1; open pixel: 7; dirty: false. `confirmDiscard()` returns true without prompting.
- Start saving A, then replace the working document with dirty B before completion. B receives A's asset ID and becomes clean. A subsequent normal save of B can overwrite A's entry.

Completion must belong to its captured document/revision. Newer edits must remain dirty, a replaced document must keep its own ID, and overlapping saves must be serialized or refused. Test normal/rejected saves and the actual replacement guard, rather than only a saver helper. Map Editor's existing ticket-based status is relevant precedent.

## #81 — Direct send bypasses the map replacement guard

Source: [`js/tiles.js:894`](https://github.com/Crylhead/Pico8_Suite/blob/fd31e3cbfdc77d0944cdc1966883282807f452de/js/tiles.js#L894), `js/map.js` public `openAsset/loadMap`.

The registered `map-open` consumer has an unsaved-work check, but Tile Maker calls `P8MapEditor.openAsset()` directly. That replaces the map and empties undo/redo.

An actual-function probe sent a tiny Tile Maker result through the real map opener/status tracker: dirty map cell 99 became incoming cell 1, its name changed, undo count became zero, prompt count was zero. No generic transfer-core test can catch this bypass unless it exercises that action's wiring.

Use a common guarded replacement path. Cancel must preserve map, tileset, palette, IDs and history; accepted transfer must preserve existing tile-0 shifting and unsaved incoming state. Keep the direct-send feature.

## #82 — Callee spelling is not proof of list immutability

Source: [`js/project-core.js:312`](https://github.com/Crylhead/Pico8_Suite/blob/fd31e3cbfdc77d0944cdc1966883282807f452de/js/project-core.js#L312).

`bindingOf()` allows a complete table argument to `all/ipairs/pairs/count` solely by name. The following user-defined helper changes the list through a different parameter name:

```lua
local cs={"old.p8"}
function count(t)
 t[1]="other.p8"
 return #t
end
print(count(cs))
reload(0,0,10,cs[1]) --@data x[]
```

`P8Project.retirement(['old.p8','other.p8'], [{name:'main.lua',text:lua}])` keeps only `old.p8`, retires `other.p8`, and reports no uncertainty. The reload uses `other.p8` after the helper mutates the list. `rewriteAnchors()` accepts and changes the initializer without error. A separate `adopt()` fixture containing a literal read of `other.p8` plus the computed read fully adopts that cart despite the remaining read.

Prove that an allowed helper is the trusted builtin, or reject/retain conservatively when it may be overridden. Cover global redefinition and local shadowing across all allowed helper names. Share the rule across retirement, adoption, cart-set checking and rewriting. A full interpreter is not required. Follow-up to #41/#42 and merged #48/#50/#51.

## #83 — Folder switches preserve an unrelated include parent

Source: [`js/code.js:892`](https://github.com/Crylhead/Pico8_Suite/blob/fd31e3cbfdc77d0944cdc1966883282807f452de/js/code.js#L892), `runTarget()` at line 1059.

Open folder A's `src/common.lua` from its `main.p8`, then switch to B while retaining the open document. B also has an unrelated `main.p8` and cannot resolve A's file handle. `useFolder()` leaves the old `parent` in both picker/adoption modes. Ordinary picking also leaves the old `rel`; adoption clears only `rel`.

Using the existing editor fixture and real saver/transitions, actual `useFolder/runTarget/runCart` saved the open Lua to A as `a=2\n`, then sent `/run` with `{name:'main.p8', text:<B's print("B unrelated") cart>}`. The parent lookup does not verify an include relationship.

Invalidate/recompute folder-relative metadata on every folder switch while preserving the working document/handle. Verify any parent relationship before Run, and bind pending folder scans/target reads and caches to folder identity. Exercise both entry points and a switch during an asynchronous read. Follow-up to #44/#56.

## #84 — Cancelled Tile Maker import changes settings first

Source: [`js/tiles.js:1328`](https://github.com/Crylhead/Pico8_Suite/blob/fd31e3cbfdc77d0944cdc1966883282807f452de/js/tiles.js#L1328).

`importAsset()` adopts an image's palette/fades, sets nearest-color mode and persists settings before `importImageData()` asks whether to replace dirty work.

Running those actual functions through `P8Transfer.send()` and declining replacement returned `cancelled` with an unchanged-state message. The old image stayed, but palette `[0,1,2]` became `[3,4,5]`, `colorMode` became `nearest`, and one settings write occurred. Real palette adoption also replaces shared fade setup and can mark the existing tiles stale.

Obtain replacement consent before these mutations. Test whole-state preservation on Cancel, successful own-palette/no-palette imports and failures before replacement is committed. Cover send/drop/import routes sharing this consumer. Related to #57, independently fixable from #81 once shared transfer ownership is agreed.

## #85 — Diagnostics metadata escapes message privacy controls

Source: `js/diagnostics-core.js`, especially `sanitizeStack`, `fromErrorEvent/fromRejection`, and `exportBundle`.

```js
const d = require('./js/diagnostics-core.js').create({ sessionId: 'TEST' });
const e = new Error('generic failure');
e.name = 'CustomerSecretProject';
e.stack = 'Error: generic failure\n    at CustomerSecretFunction (https://host/js/CustomerSecretFile.js:10:5)';
d.fromErrorEvent({ error: e });
console.log(d.exportBundle().records);
```

Default output includes `code: 'E_CustomerSecretProject'` and `stack: 'CustomerSecretFunction (CustomerSecretFile.js:10:5)'` although `message` correctly becomes `[…] failure`. The report summary also includes codes. Error names/rejection objects and stack identifiers are not necessarily fixed application metadata.

Use a finite safe error taxonomy and known application stack metadata, or redact/omit untrusted fields by default. Explicit opt-in may add reviewed detail. Assert privacy across the entire export and summary, while retaining useful standard error types/IDs. This follows closed #62/#63 after #77/#78; message-only tests do not establish the complete export contract. No report is uploaded automatically.

## Provenance and handoff

Original issues #1–#14, #30–#35 and #40–#44 have merged implementations. The #40–#44 batch arrived through #47/#48/#49, followed by integrated fixes #50/#51. Subsequent shell/status/preferences/navigation work and the UX batch #76 are on this source, followed by diagnostics/report/help changes #77/#78/#79. Historical reviews retain their original SHAs and results.

This review records six new follow-ups, not a reversal of all previous fixes. It does not establish complete correctness or UX acceptance. Implement each issue with focused actual-boundary regression cases, then the checks required by `AGENTS.md`; avoid rebuilding infrastructure or rerunning unrelated checks per small edit. No code fixes or issue closures are part of this documentation PR.

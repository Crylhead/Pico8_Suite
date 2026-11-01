# Post-fix code review — 2026-11-01

- **Repository:** Crylhead/Pico8_Suite
- **Reviewed branch:** main
- **Reviewed commit:** [ca36c07f2e770055f2c0f69a62bde4142a4dea2f](https://github.com/Crylhead/Pico8_Suite/commit/ca36c07f2e770055f2c0f69a62bde4142a4dea2f)
- **Scope:** the integrated fixes for issues #1–#14, all 48 tracked files, the current test/CI setup, and failure/transition cases around the changed save, adoption, retirement and recovery paths.
- **Snapshot:** every file fetched at the SHA above before review edits. The later documentation commit is separate.
- **Method:** source inspection, the committed JS/Python suites, static asset/link checks, additional actual-function probes with isolated VM/fake filesystem I/O, and GitHub PR/issue/Actions metadata.
- **Reviewer:** Codex.

## Result

All original issues are closed and their PRs are merged. The work materially improves the application: durable storage errors are explicit, the saver tracks revisions, project writes have a journal, Terrain files include their output recipe, history memory is bounded and CI now runs meaningful focused checks.

**The integrated code still has five reproduced P1 correctness gaps and one P2 Code Editor analysis gap.** Passing CI does not exercise those specific cases. They are filed as follow-up issues; the original records remain intact.

## Follow-up issues

| Issue | Priority | Finding |
| --- | --- | --- |
| [#30](https://github.com/Crylhead/Pico8_Suite/issues/30) | P1 | Guard Code Editor file switching against edits typed during its automatic save |
| [#31](https://github.com/Crylhead/Pico8_Suite/issues/31) | P1 | Keep recovery in rollback mode when committing the journal fails after its marker was written |
| [#32](https://github.com/Crylhead/Pico8_Suite/issues/32) | P1 | Serialize project transactions and prevent one writer from deleting another writer's recovery journal |
| [#33](https://github.com/Crylhead/Pico8_Suite/issues/33) | P1 | Recognize Lua string-call load syntax before retiring referenced carts |
| [#34](https://github.com/Crylhead/Pico8_Suite/issues/34) | P1 | Validate the complete anchor suffix instead of accepting a valid prefix and rewriting different bytes |
| [#35](https://github.com/Crylhead/Pico8_Suite/issues/35) | P2 | Use an active include stack in the Code Editor meter so repeated files and separate tabs count correctly |

Implement #31/#32 with coordinated ownership of the transaction/recovery state machine. #30 needs a test around the actual document transition, beyond the saver helper. #33/#34 should share the existing lexical/validation infrastructure where appropriate. #35 can proceed independently.

No application implementation was changed by this review. The documentation updates point to this report, correct the stale README claim that CI does not exist, and qualify the affected behavior until the follow-ups are fixed.

## Reproduced findings

### #30 — A correctly dirty save can still be discarded by navigation

The actual `openRel()` from `js/code.js` was run in a Node VM with the current `P8Code.createSaver` and fake I/O:

1. A has saved `x=1`; edit it to `x=2`.
2. Open B from the folder list; pause A's automatic save.
3. Type `x=3` while the save is pending, then let it complete.

The file received `x=2\n`. The saver correctly recorded that revision and left `x=3` dirty. But `openRel()` checked only the outcome `saved`, loaded B and discarded the new text. No discard confirmation was called. This is an actual transition-function reproduction with simulated I/O, not a GUI journey.

`runCart()` has the related missing post-save revision check: the payload closure can observe newer unsaved text after the save. That path was statically inspected, not launched in PICO-8. Guard incoming drop/programmatic code opens consistently too.

### #31 — A failed commit can recover as if it succeeded

Using `P.transact()`, `P.recover()` and the committed `tests/fake-fs.js`:

1. Start with `d0=data1`, `fx=fx1`, `manifest=manifest1` and `old.p8`.
2. Write `data2`, `fx2` and `manifest2`.
3. Allow the `committed` journal marker to close, then fail its readback.
4. Allow rollback of FX/manifest, but deny the d0 restore once.

The transaction reports partial restoration and says the journal retains the originals. Its disk state is still `committed`. On reopening, recovery retires `old.p8`, deletes the journal and reports no problems, leaving:

| File | Actual after recovery | Old coherent version |
| --- | --- | --- |
| d0 | data2 | data1 |
| fx | fx1 | fx1 |
| manifest | manifest1 | manifest1 |

The remaining original data backup is discarded. The commit/rollback decision must remain durable across this failure boundary.

### #32 — One writer can delete another writer's live journal

Two concurrent transactions were started over the same fake project and same expected baseline, with deterministic `now()` values A and B. Both passed the absence preflight. Writer A then saw B's journal during its verification, failed and unconditionally deleted that journal in its error cleanup.

A captured interruption point during B's work contained `x=B`, `suite.json=old` and **no journal**. Reopening that captured snapshot returned `recover() === null` and left the mixed project untouched.

The actual `project.js` actions have no in-flight operation guard, and the journal has no exclusive owner. The probe directly establishes a shared-project transaction race; a double-click/two-tab GUI reproduction was not run. A lock must cover the whole operation and cleanup must verify ownership.

### #33 — Valid Lua load syntax is invisible to retirement

These calls must keep `old.p8`, but only the first does:

| main Lua | Current retirement decision |
| --- | --- |
| `load("old.p8")` | Keep |
| `load"old.p8"` | Retire |
| `load'old.p8'` | Retire |
| `load [[old.p8]]` | Retire |

The last three returned no unresolved-reference warning. This was executed against `P.retirement()`. The scanner only recognizes parenthesized calls; valid Lua string-call syntax must be accounted for before moving files.

### #34 — Range validation accepts an incorrectly parsed anchor

For a raw 100-byte `x.bin` placed at 0x100, starting from `reload(0,0,10,"old.p8")`:

| Anchor suffix | Actual rewritten source / length | Error |
| --- | --- | --- |
| `+-1` | 0x100 / 100 | None |
| `+frame` | 0x100 / 100 | None |
| `+0x10*2` | 0x110 / 10 | None |
| `+0x10` | 0x110 / 10 | None; valid control |

The first two are downgraded to bare anchors, widening a 10-byte read to 100. The third accepts only a numeric prefix. The new bounds validator cannot reject syntax that the parser has silently dropped. The whole anchor payload needs validation.

### #35 — The editor still counts repeated includes only once

The actual `resolveIncludes()` was run in isolation with the current core modules:

```lua
#include lib.lua
#include lib.lua
```

With `lib.lua` containing `y=2`, the Code Editor reports 3 included tokens instead of 6 and `found: [true, false]`. Its global `seen` set deduplicates paths instead of tracking the active recursion stack, and does not distinguish cart tabs.

Audit's expansion is fixed and its tests pass. This is an existing remaining editor integration bug; it is not a regression in the new Audit implementation.

## Revalidation of the original backlog

“Pass” below means the stated current fixture/path passed or the cited source behavior was rechecked. It is not proof of every browser/runtime behavior or a claim that all acceptance criteria were exhaustively verified.

| Original issue | Fix PR | Current disposition |
| --- | --- | --- |
| #1 | [#16](https://github.com/Crylhead/Pico8_Suite/pull/16) | Original dynamic/out-of-range fixtures pass; no new failure found in those paths. |
| #2 | [#21](https://github.com/Crylhead/Pico8_Suite/pull/21) | Partial: parenthesized references are guarded; shorthand load calls remain unsafe (#33). |
| #3 | [#25](https://github.com/Crylhead/Pico8_Suite/pull/25) | Partial: ordinary stage failures recover; commit-marker/rollback and concurrent-writer cases fail (#31/#32). |
| #4 | [#26](https://github.com/Crylhead/Pico8_Suite/pull/26) | Baseline-conflict fixtures pass; Code Editor merge/cancel fixtures also pass via PR #28. Concurrent transactions remain #32. |
| #5 | [#27](https://github.com/Crylhead/Pico8_Suite/pull/27) | Quota/clone/abort/closed/retry and explicit memory-only fixtures pass. |
| #6 | [#28](https://github.com/Crylhead/Pico8_Suite/pull/28) | Partial: createSaver retains the correct saved revision; openRel can still discard a newer revision (#30). |
| #7 | [#18](https://github.com/Crylhead/Pico8_Suite/pull/18) | Partial: validated raw/LZ ranges are checked; unsupported suffixes can bypass parsing (#34). |
| #8 | [#22](https://github.com/Crylhead/Pico8_Suite/pull/22) | Portable output recipe and frozen live-palette fixtures pass. |
| #9 | [#19](https://github.com/Crylhead/Pico8_Suite/pull/19) | Import/bitmap resource restoration and retention-budget fixtures pass. |
| #10 | [#20](https://github.com/Crylhead/Pico8_Suite/pull/20) | Structural/pixel undo/redo accounting and retention fixtures pass. |
| #11 | [#17](https://github.com/Crylhead/Pico8_Suite/pull/17) | Audit long-bracket/tab/repetition fixtures pass. Code Editor meter still deduplicates includes (#35). |
| #12 | [#24](https://github.com/Crylhead/Pico8_Suite/pull/24) | Literal cross-region reads and comment/string masking fixtures pass. |
| #13 | [#23](https://github.com/Crylhead/Pico8_Suite/pull/23) | Five bridge tests pass for pairing, Host/Origin/request validation and process concurrency. |
| #14 | [#15](https://github.com/Crylhead/Pico8_Suite/pull/15) | 43 JS regressions, five bridge tests, syntax/static checks and the current main Actions run pass. |

PR #4's Code Editor half is in PR #28; the table's PR #26 covers the Cart Builder half. Four original issue areas (#2/#3/#6/#7) are explicitly partial because the new reproductions reach related unhandled cases.

## Validation

Environment: Node.js 24.22.1 and Python 3.12.14.

| Check | Result |
| --- | --- |
| `node tests/regress.js` | **43/43 passed** across the actual integrated tree. |
| `python -m unittest discover -s tests -p 'test_*.py' -v` | **5/5 passed**, fake process launcher; no PICO-8 process started. |
| `node --check` over all 23 `js/*.js` | Passed. |
| `python -m py_compile tools/pico8_bridge.py` | Passed. |
| `node tests/check-static.js` | 392 unique IDs; all 25 local script/style references exist. |
| Existing Markdown file links | All local targets existed before the review updates; checked again afterwards. |
| Additional byte-LZ JS vectors | 24/24 encode/decode round trips passed: lengths 0, 1, 2, 3, 127, 128, 129, 17152; zero/periodic/seeded bytes. |
| Long-bracket token controls | Ordinary/commented x=1 and equivalent long string assignments now all count 3; decoder still estimates 60 tokens. |
| Six follow-up diagnostics | Executed as described above; actual source functions with isolated I/O/VM adapters. |
| [GitHub Actions run 41344175937](https://github.com/Crylhead/Pico8_Suite/actions/runs/41344175937) | Completed successfully on exactly ca36c07f2e770055f2c0f69a62bde4142a4dea2f. |

The new failure probes are review diagnostics, not additional committed tests; they must become focused regressions in their fixes. Do not reproduce them on a real demo folder.

A browser smoke test was attempted, but Playwright's Chromium executable is not installed in this environment, so **no browser journey ran in this review**. No Windows file-picker/permission checks, PICO-8 execution, visual QA or performance benchmark was performed. Prior PR authors' browser results remain their reported evidence, not independently rerun tests here. JavaScript round trips establish internal consistency only.

## Merge provenance

The PR metadata below was read from GitHub. Most fixes were merged into stacked branches and then integrated into `main` by PR #15 at the reviewed SHA. The current source files, not branch labels or issue closure alone, were used for verification.

| Fix PR | Recorded merge base | Full recorded merge commit |
| --- | --- | --- |
| #16 | `fix/14-ci` | [3eb9e6f5db48508268dab54a619efb067d10c72e](https://github.com/Crylhead/Pico8_Suite/commit/3eb9e6f5db48508268dab54a619efb067d10c72e) |
| #21 | `fix/7-anchor-ranges` | [5014c2ab2f8a2168e4fa9fa350eef50f08f9acf8](https://github.com/Crylhead/Pico8_Suite/commit/5014c2ab2f8a2168e4fa9fa350eef50f08f9acf8) |
| #25 | `fix/14-ci` | [851d62f3b61374605e05131959bcfbd3ca7b6802](https://github.com/Crylhead/Pico8_Suite/commit/851d62f3b61374605e05131959bcfbd3ca7b6802) |
| #26 | `fix/3-recoverable-writes` | [8a5d79708cdbeaa13fa2ea910bfe3a5c8d4a8cb1](https://github.com/Crylhead/Pico8_Suite/commit/8a5d79708cdbeaa13fa2ea910bfe3a5c8d4a8cb1) |
| #27 | `fix/14-ci` | [c890d39b467ad27c4e772053afe822842b37313e](https://github.com/Crylhead/Pico8_Suite/commit/c890d39b467ad27c4e772053afe822842b37313e) |
| #28 | `fix/14-ci` | [02e53928e83401f1cdd36d0a5e7935b5d3693992](https://github.com/Crylhead/Pico8_Suite/commit/02e53928e83401f1cdd36d0a5e7935b5d3693992) |
| #18 | `fix/14-ci` | [ab7b97e23c1a6d4367e01b14bbe0d39dc525a6c1](https://github.com/Crylhead/Pico8_Suite/commit/ab7b97e23c1a6d4367e01b14bbe0d39dc525a6c1) |
| #22 | `fix/9-terrain-history` | [a9afb15de68e9b1f21c64d4abf8f6f40685041ff](https://github.com/Crylhead/Pico8_Suite/commit/a9afb15de68e9b1f21c64d4abf8f6f40685041ff) |
| #19 | `fix/14-ci` | [2c129f578b6124b4b99f2700209695652e2e40de](https://github.com/Crylhead/Pico8_Suite/commit/2c129f578b6124b4b99f2700209695652e2e40de) |
| #20 | `fix/14-ci` | [50857d909a99a45fb5167baa62051d7ef8342d21](https://github.com/Crylhead/Pico8_Suite/commit/50857d909a99a45fb5167baa62051d7ef8342d21) |
| #17 | `fix/14-ci` | [d0bf1cdb8e620f0bbb707a99b8dfdf211f13b71a](https://github.com/Crylhead/Pico8_Suite/commit/d0bf1cdb8e620f0bbb707a99b8dfdf211f13b71a) |
| #24 | `fix/11-lua-lexical` | [a366ac0ec3dc3f97af0085ddc97e6061cd6cf602](https://github.com/Crylhead/Pico8_Suite/commit/a366ac0ec3dc3f97af0085ddc97e6061cd6cf602) |
| #23 | `fix/14-ci` | [6cc76c39f467b21aa64da1c0ab40689bf3bec063](https://github.com/Crylhead/Pico8_Suite/commit/6cc76c39f467b21aa64da1c0ab40689bf3bec063) |
| #15 | `main` | [ca36c07f2e770055f2c0f69a62bde4142a4dea2f](https://github.com/Crylhead/Pico8_Suite/commit/ca36c07f2e770055f2c0f69a62bde4142a4dea2f) |

PR #28 also implements #4's Code Editor portion. The earlier report's “open PRs at the time of writing” appendix is historical; it is preserved at [HEALTH_REVIEW_2026-11-01.md](HEALTH_REVIEW_2026-11-01.md).

## Next review

Keep this reviewed SHA unchanged. Record follow-up fix commits and their regression evidence separately. A later reassessment should get its own source-pinned report and explicitly rerun #30–#35 alongside the existing suite.


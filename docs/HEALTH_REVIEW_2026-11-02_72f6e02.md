# Third code review — 2026-11-02

- **Repository / branch:** Crylhead/Pico8_Suite, main.
- **Reviewed source:** [72f6e029412ce06afe0576bd60f59aca0d44c52f](https://github.com/Crylhead/Pico8_Suite/commit/72f6e029412ce06afe0576bd60f59aca0d44c52f), before the documentation changes recording this review.
- **Scope:** integrated fixes for #30–#35, their tests, transaction/recovery lifecycle, destructive reference analysis, anchor/cart-set rewriting, Code Editor transitions and Run. This was a targeted integrated review, not an exhaustive re-audit of every tool.
- **Method:** source inspection, current committed checks, GitHub issue/PR/Actions metadata, and additional Node probes against actual core/UI functions with fake filesystem/handle I/O.
- **Reviewer:** Codex.

## Result

All six previous follow-up issues are closed and their four implementation PRs are merged. Their original regression fixtures now pass. The baseline is **68 JavaScript regressions and five Python bridge tests, all passing**; the reviewed main CI run also succeeded.

**Five further problems were reproduced: three P1 correctness gaps and two P2 gaps.** They are outside the passing regression fixtures. No application implementation or committed test behavior was changed by this review.

| Issue | Priority | Finding |
| --- | --- | --- |
| [#40](https://github.com/Crylhead/Pico8_Suite/issues/40) | P1 | Retrying/interruption of recovery loses the obligation to restore retired carts; it can delete the journal and report the old project restored while a required cart remains in `unused/`. |
| [#41](https://github.com/Crylhead/Pico8_Suite/issues/41) | P1 | Retirement uses heuristic computed-name and table resolution as proof that carts are unreferenced. |
| [#42](https://github.com/Crylhead/Pico8_Suite/issues/42) | P1 | Cart-set parsing accepts computed/mixed lists and can rewrite a commented-out binding instead of the executable one. |
| [#43](https://github.com/Crylhead/Pico8_Suite/issues/43) | P2 | Anchor scanning rewrites apparent calls inside long strings/comments and can mistake quoted data for an anchor. |
| [#44](https://github.com/Crylhead/Pico8_Suite/issues/44) | P2 | Run keeps its pre-save target after fallback Save As; the editor's relative path/parent context also stays stale. |

Prioritize #40, then #41/#42. Coordinate #41–#43 because they share project parsing and conservative mutation requirements. #44 can be handled separately in Code Editor. Do not repeat or replace the completed original fixes.

## Revalidation and fix provenance

| Previous issue | Merged PR / source commit | Current evidence |
| --- | --- | --- |
| #30 | [#39](https://github.com/Crylhead/Pico8_Suite/pull/39), `89507c955650bfc267d58b48e6832ef62c36adbf` | Delayed autosave typing stays open/dirty; unchanged navigation, cancellation, incoming opens, supersession and ordinary Run fixtures pass. Save As target/context remains #44. |
| #31 | [#38](https://github.com/Crylhead/Pico8_Suite/pull/38), `72f6e029412ce06afe0576bd60f59aca0d44c52f` | Commit-marker errors persist the rollback decision; ordinary partial rollback and transaction interruption fixtures pass. Repeated/interrupted recovery after retirement remains #40. |
| #32 | [#38](https://github.com/Crylhead/Pico8_Suite/pull/38), `72f6e029412ce06afe0576bd60f59aca0d44c52f` | Same-page exclusivity, Web Locks sessions, refused-writer cleanup and tested ownership loss fixtures pass. The documented best-effort fallback without Web Locks still has limitations; no claim of universal filesystem exclusion is made. |
| #33 | [#37](https://github.com/Crylhead/Pico8_Suite/pull/37), `2b084965123e5201e6ae13ca9a7cbd7ba6d4151e` | Quoted/long-bracket string-call loads now keep their targets; comments/member calls and transitive fixture paths pass. Broader target inference remains #41. |
| #34 | [#37](https://github.com/Crylhead/Pico8_Suite/pull/37), `2b084965123e5201e6ae13ca9a7cbd7ba6d4151e` | Whole suffixes reject negative/computed/incomplete/trailing syntax; valid bare/sliced/cart-set fixtures pass. Executable binding/discovery boundaries remain #42/#43. |
| #35 | [#36](https://github.com/Crylhead/Pico8_Suite/pull/36), `7c421d92f4a19c24a40d1174df0ba2e36c84f231` | Actual editor-meter fixtures pass for repeated/diamond includes, separate tabs, cycles, missing targets and agreement with Audit. No new failure reproduced in this scope. |

“Pass” means the stated fixture/path passed, not that every acceptance criterion has been independently exercised in a browser or PICO-8.

## Reproduced findings

### #40 — Recovery itself is not restartable across retired-cart restoration

The actual `transact()` / `recover()` ran over `tests/fake-fs.js`:

1. Successfully write new FX/manifest contents and retire `old.p8`; deny journal removal so the committed journal remains.
2. Change FX externally and confirm rollback on reopening.
3. Deny restoring `demo/old.p8`. Recovery restores FX/manifest, reports an unresolved error, and leaves a `rolling-back` journal.
4. Remove the fault and recover again.

Observed second result: `outcome: 'old'`, `problems: []`, journal deleted, but `old.p8` still exists only under `demo/unused/`. The restored old project can require it in its original location.

`recoverLocked()`'s `allOld` shortcut examines only `writes[]`. Its retirement undo is conditional on the state originally read being `committed`; after recovery persists `rolling-back`, a later recovery loses that condition. The full restore obligation must survive retries and interruption, and journal cleanup must verify both payloads and required cart locations. See [source](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/project-core.js#L1049).

The executed denial/retry establishes the failure directly. Interruption after the same durable marker reaches the same faulty branch; new tests should snapshot recovery steps themselves, not only transaction steps.

### #41 — Approximate target inference is unsafe for retirement

The actual `retirement()` over candidates `old.p8` and `other.p8` returns both in `retire` with no unresolved warning for:

```lua
name="old"
load(name..".p8")
```

The preview resolver substitutes a digits-only pattern for every nonliteral concatenation fragment. A string fragment can instead name `old.p8`, which must stay. `reload(0,0,10,name..".p8")` has the same failure.

This fixture keeps `old.p8` but retires the actually loaded `other.p8`, again with no warning:

```lua
local xs={"old.p8"}
xs[1]="other.p8"
load(xs[1])
```

An initial literal table is not an exhaustive runtime set after mutation. Destructive decisions need provable targets or conservative retention with an uncertainty report. Audit adoption's `mayRead()` use of the same helper too. Sources: [retirement](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/project-core.js#L716), [preview resolver](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/cart-core.js#L339).

### #42 — A cart list is accepted without validating its elements or executable binding

Calling actual `rewriteAnchors()` with a cart-set placement `{off:0,len:10,carts:['d1.p8']}` on:

```lua
local cs={"old.p8",other}
reload(0,0,10,cs[i]) --@data x[]
```

returns `errors: []` and replaces the list with `{"d1.p8"}`, deleting `other`. `{"old.p8"..suffix}` also loses its suffix. The parser harvests quoted substrings rather than validating the complete list.

With this input it changes the comment, leaves the live list untouched, and reports success:

```lua
-- cs={"decoy.p8"}
local cs={"old.p8"}
reload(0,0,10,cs[i]) --@data x[]
```

Both adoption and rewriting use [listLiteral()](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/project-core.js#L109). Parse a supported complete executable literal, reject uncertainty/ambiguity before mutation, and retain source references on rejection.

### #43 — Anchor recognition is line-based even inside literal/comment bodies

Actual `rewriteAnchors()` with `x.bin` placed at 0x100, length 100, rewrites **both** apparent calls in this input without an error:

```lua
local template=[=[
reload(0,0,10,"old.p8") --@data x.bin
]=]
reload(0,0,10,"old.p8") --@data x.bin
```

The first call is literal data and must remain unchanged. Levelled long comments have the same discovery problem. Discover real executable calls and their actual trailing anchor comments using the existing shared lexer, consistently across find/check/rewrite/adopt. Source: [project-core.js](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/project-core.js#L87).

### #44 — A save into another file does not update Run's earlier target

The fake editor/handles from `tests/code-transitions.test.js` were reused with its actual extracted `runTarget()` / `runCart()` and real saver/transition helpers:

1. Open `a.p8` containing `x=1`; edit to `x=2`.
2. Reject A's write, let the fallback Save As picker return `b.p8`, then complete Run.

Observed:

| State | Value |
| --- | --- |
| Editor handle/name | `b.p8` |
| Editor relative path | `a.p8` (stale) |
| Disk A Lua | `x=1` |
| Disk B Lua | `x=2` |
| `/run` payload | name `a.p8`, cart text containing `x=2` |

The target is captured before the save; the saver updates name/handle but leaves relative path/parent metadata unchanged. The bridge matches basename plus contents, so this payload cannot find the newly saved B under its name and can fall back to a temporary copy without neighbors. The wrong payload was executed in the probe; the resulting PICO-8 launch was not performed. Recompute/validate the saved target and folder identity, or stop for a clear retry after Save As. Sources: [runCart](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/code.js#L1026), [save commit](https://github.com/Crylhead/Pico8_Suite/blob/72f6e029412ce06afe0576bd60f59aca0d44c52f/js/code.js#L779).

## Validation and limits

Environment: Node.js 24.22.1, Python 3.12.14, Linux. Every failure injection used disposable/in-memory fixtures; no user demo folder or real PICO-8 process was used.

| Check | Result |
| --- | --- |
| `node tests/regress.js` | 68 passed |
| `node tests/check-static.js` | 392 unique HTML IDs; 25 local script/style references exist |
| `node --check` for every `js/*.js` | Passed |
| `python -m py_compile tools/pico8_bridge.py` | Passed |
| `python -m unittest discover -s tests -p 'test_*.py' -v` | Five passed |
| `git diff --check` | Passed |
| Additional core/actual-function probes | Reproduced #40–#44; results above |
| [Reviewed main Actions run](https://github.com/Crylhead/Pico8_Suite/actions/runs/41363283700) | Success, head SHA matches reviewed source |
| Browser smoke/interactive filesystem validation | Attempted, unavailable: installed Playwright has no Chromium executable; no browser journey completed |
| Windows / installed PICO-8 / generated-demo runtime | Not performed |

The original [standalone review](HEALTH_REVIEW_2026-11-01.md) and [second review](HEALTH_REVIEW_2026-11-01_ca36c07.md) retain their original source SHAs and findings as historical records. New fixes should record provenance separately and add focused failure/success fixtures rather than expanding into a broad refactor.

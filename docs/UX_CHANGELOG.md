# UX roadmap implementation log

## Archive author report (supplied 2026-11-02)

The original implementation notes and browser measurements below came with the uploaded archive. They are provenance, not independent integration-test results. The integration section at the end describes the GitHub-bound result.

What was changed for the UX issues #53–#69 (except the correctness issues #40–#44, which were not touched), where, how it was checked and what is still open. The source files carry the same issue numbers in their comments. Issues #52, #54, #58 were already in the archive tree and are only referenced.

Checks used for the whole batch: `node tests/regress.js` (189 cases at the end, 0 failures), `node --check js/*.js`, `node tests/check-static.js`. Browser checks were made in the desktop app's Browser pane (Chromium); there was **no PICO-8, no Chrome/Edge folder-permission prompt, no real touch device, no screen reader and no axe run**, so those gaps are stated per issue.

| Issue | Status | New files | Changed files |
| --- | --- | --- | --- |
| #53 Navigation | superseded during integration by merged PR #75 | archive navigation excluded | existing GitHub routes, search and subtools preserved |
| #55 Project context | done | `js/project-context-core.js`, `tests/project-context.test.js` | `js/app.js`, `js/project.js` (Cart Builder publishes), `index.html`, `css/suite.css` |
| #56 Project adapters | done | `js/project-adapter.js`, `tests/project-adapter.test.js` | `js/code.js`, `js/audit.js`, `js/datacarts.js`, `index.html`, `css/suite.css` |
| #57 Send to / Open in | done | `js/transfer-core.js`, `tests/transfer.test.js` | `js/suite.js`, `js/studio.js`, `js/tiles.js`, `js/map.js`, `index.html`, `css/suite.css` |
| #59 Help registry | done | `js/help-data.js`, `js/help-core.js`, `tests/help.test.js` | `js/app.js`, `index.html`, `css/suite.css` |
| #60 Tooltips | done | `js/ux-tooltips.js`, `tests/tooltips.test.js` | `js/app.js`, `index.html`, `js/help-data.js`, `css/suite.css` |
| #61 Tours | done | `js/tours-core.js`, `js/tours-data.js`, `js/tours.js`, `tests/tours.test.js` | `index.html`, `css/suite.css` |
| #62 Diagnostics | done | `js/diagnostics-core.js`, `tests/diagnostics.test.js` | `js/app.js`, `js/terrain.js`, `index.html` |
| #63 Report a problem | done | `.github/ISSUE_TEMPLATE/bug_report.yml` | `js/app.js`, `index.html`, `css/suite.css` |
| #64 Resizable panels | done | `js/panels-core.js`, `js/panels.js`, `tests/panels.test.js` | `css/suite.css` (`--side-w`), `js/app.js` (Settings reset), `index.html` |
| #65 Keyboard / WCAG | second pass done, no full claim | – | `css/style.css`, `css/suite.css`, `index.html` (`fadeSlider` name), `docs/ACCESSIBILITY.md` |
| #66 Cart Builder UX | done (presentation) | `js/preflight-core.js`, `tests/preflight.test.js` | `js/project.js`, `index.html`, `css/suite.css`, `docs/PROJECT_MODEL.md` |
| #67 Terrain responsiveness | done | `js/render-status-core.js`, `tests/render-status.test.js`, `docs/PERFORMANCE_BASELINE_TERRAIN.md` | `js/terrain.js`, `js/diagnostics-core.js`, `css/suite.css` |
| #68 Home launcher | done | `js/home-core.js`, `tests/home.test.js` | `js/suite.js`, `js/app.js`, `index.html`, `css/suite.css`, tool registrations (`tasks`) |
| #69 Drift checks | done | `tests/docs-integrity.js`, `tests/docs-integrity.test.js`, `docs/UX_RELEASE_CHECKLIST.md` | `CONTRIBUTING.md`, `EXTENDING.md`, tour metadata |

## Behaviour changes users will notice

- **Workspace bar (#53):** integration retains merged PR #75, including `#ws/sub` routes and Extra Tools search entries. Text labels use its 1600 px breakpoint; Find tool uses Ctrl/⌘+K. The archive’s duplicate navigation UI and CSS were excluded.
- **Help (#59, #60, #61):** F1 opens the topic of the current tool with a search box and a link to the unchanged long-form documentation; optional tooltips follow the Settings help level; **Help › Quick tours…** replays tours; a one-time welcome offers *Start tour / Explore independently / Never auto-offer*.
- **Problems (#62, #63):** errors are kept in a bounded, sanitized, in-memory log; **Help › Report a problem…** builds an editable summary (copy, JSON download, GitHub form). Nothing is sent automatically.
- **Projects (#55, #56):** the app bar names the active project and its access state. Code Editor, Project Audit and Data Carts show a strip "Working on …/own folder/none" with an opt-in *Use "<project>"* (or *Reconnect and use*). Nothing is adopted automatically.
- **Send to (#57):** every destination is listed; unavailable ones stay focusable with the exact reason as visible text; a destination with unsaved work asks Replace / Cancel; success names the target and says temporary or saved; cancel and failure never report success. Pixel Studio has **File › Send to › All destinations…**.
- **Panels (#64):** a splitter (drag, arrows, Home/End, Enter hide/show, `0`/double-click reset) for the side panels of Pixel Studio, Map Editor and Terrain Lab; widths persist; narrow layouts keep stacking as before.
- **Cart Builder (#66):** a four-step strip (Analyze / Plan / Validate / Commit); Write Carts and Adopt open a preflight list of every file target (added / changed / removed / moved to `unused/`) with counts and unresolved references; every part has **Move…** (no drag needed). The write itself is untouched.
- **Terrain Lab (#67):** the badge shows Queued / Preview / Preview · rendering final… / Final / Stale / Render failed; a stale image gets a dashed frame; exports need *Final*; a worker failure shows an Error ID and **Retry**.
- **Home (#68):** Continue (last tool, project Reconnect/Continue with permission-aware states), task shortcuts, storage notice that separates browser-only state from files.

## Bugs found and fixed while doing this

- **Event name collision** (own change in #55): the project-context event was first named `p8:project`, which Project Audit already uses (`{ root }`) to hand its scan to Data Carts. Renamed to `p8:projectcontext`.
- **Data Carts strip landed in Cart Builder** (#56): the selector `.layout-dc .dc-top` matches both workspaces; now `main[data-ws="datacarts"] .dc-top`.
- **Undocumented shortcut** (found by the #69 check): `Ctrl+Shift+S` (Save as…) of Pixel Studio, Map Editor and Code Editor was in menus but not in the help.
- **Missing accessible name** (#65): `#fadeSlider` had none ("Fade position").
- **Contrast** (#65): error text used `--danger` (3.3–4.8:1); new `--danger-text`; light-theme `--ok/--warn/--bad` darkened to ≥4.8:1.
- **Silent lost cancel** (#57): Pixel Studio and Tile Maker `open()` now return `false` on cancel so a cancelled send is not reported as done.
- **Keyboard shortcut was undocumented in tours/tests** and **stale Terrain status** ("Preview" while an older image was shown) fixed by #67.

## Known gaps (not done or not verifiable here)

- No real Chrome/Edge folder-permission run for #55/#56/#66: adoption, reconnect and the Cart Builder preflight were verified with fake handles in unit tests and, for #56/#55, with an in-page fake directory handle. The preflight dialog itself was not driven against a real project folder.
- Touch / pen behaviour of the panel splitter, tooltips and the tour card was not tested on a device; 200 % zoom and 320 px reflow were only checked for horizontal overflow and the stacked layouts.
- #65 does not claim WCAG 2.2 AA conformance; no axe or screen reader run. See `docs/ACCESSIBILITY.md`.
- #66: integration uses the already merged #40–#44 correctness code. The transaction, recovery, retirement and lexer core modules are unchanged; the new preflight presents the existing mutation plan.
- #67: the next-frame (INP-like) samples could not be captured in a background pane; only the synchronous acknowledgement and total times are recorded (`docs/PERFORMANCE_BASELINE_TERRAIN.md`). There is no "before" baseline for the old badge.
- Navigation icons and tab order still live in `index.html`; categories, names and task shortcuts come from the registry (#53/#68).
- `.claude/launch.json` was excluded from the GitHub integration as a local development artifact.

## Review pass (second look at the batch above)

A line-by-line re-read of the new modules plus browser probes found these defects in the batch itself; all are fixed:

| # | Defect | Effect | Fix | Check |
| --- | --- | --- | --- | --- |
| 1 | `js/panels.js` wrote `--side-w` with the 272 px default even when the user had chosen nothing | Pixel Studio's side panel was 272 px instead of its own 232 px at 861–1100 px: a layout change without any user action; arrow keys also started from the wrong width | the variable is written only for a width the user chose or a collapse; otherwise the CSS fallback applies; keyboard steps start from the width in effect | browser at 1000 px: default 232, ArrowLeft → 248, `0` removes the variable |
| 2 | `js/app.js` restored the remembered project during `init()`, before `suite.js` (which provides `Suite.kv`) was loaded | the restore threw inside a try/catch, so a remembered project never came back after a reload (#55) | restore waits for the page `load` and for `Suite.assets.ready` | browser: a stored record shows as "Project: … (name only)" after reload; unit tests use a fake kv and could not see this |
| 3 | `js/tours-core.js` `finish()` recorded a tour as done/skipped even when no step could be shown (all targets missing) | a tour nobody saw was marked completed and never offered again as new | `finish()` records nothing when no step was shown | `tests/tours.test.js` (new case, one existing case adjusted to start the run) |
| 4 | `js/terrain.js`: after a worker error the dead worker stayed in its channel | the next edit was posted to nothing and the badge stayed on "Queued" with no Retry | `failed()` terminates and replaces the worker; the next edit or Retry renders | browser: simulated worker error → "Render failed" + Retry → "Final" |
| 5 | Terrain "Send to" used the default `saved: true` for a temporary colour map | the success message claimed "The Library copy is unchanged" for something that is not in the Library | `openIn(..., { saved: false })` | wording covered by `tests/transfer.test.js` |
| 6 | minor | unused parameter `saved` in `destinationList`; redundant condition in `tours.js` | removed | – |

Probed and found sound (no change): all eleven workspaces and the new dialogs (Go to tool, Help, Report a problem, Quick tours, Send to) produce no captured errors in `P8App.diagnostics`; no `innerHTML`, `eval` or dynamic `Function` in any new file; every new script is loaded before its first use; `node --check` runs over every new file in CI's existing loop; horizontal overflow checks in all workspaces at the smallest viewport the pane allows (371 px, not 320).

Still not covered by tests (browser-only behaviour): the panel splitter geometry, the tour card placement and the Terrain Lab status transitions were verified by hand in the Browser pane, not by automated tests.

## Independent GitHub integration verification (2026-11-02)

Integrated against `main` at `334c310eb179bad6d2848bdb56cfdd2fba756666` (PRs #70–#75 already merged). This is one combined UX PR because the archive's help, tours, project, Home and shared-shell changes depend on each other. It does not merge itself into `main`.

- Preserved PR #75's navigation module, navigation regressions, responsive search, Extra Tools entries and `#ws/sub` deep links. Excluded the archive's duplicate `js/nav.js`, quick-switch button and CSS. Kept task metadata for the new Home launcher.
- Preserved the merged #40–#44 fixes. `project-core.js`, `code-core.js`, the Python bridge, existing correctness tests and CI configuration are unchanged.
- Fixed defects discovered during integration: project selection/clear races (including ordered persistence), distinct folders sharing a display name, retryable permission cancellation, report downloads ignoring the editable preview, empty registry-backed tour text (`const P8Help` is not `window.P8Help`), asynchronous tours reviving after close, cached Home permission claims and obsolete Terrain results clearing current failures. Terrain failure IDs are now visible in the status text as well as the tooltip.
- Added separate editable text/JSON report previews. Copy and Download export exactly their corresponding preview; invalid JSON is refused. No report data goes in the GitHub URL. Redaction now handles paths containing spaces, short quoted strings and common API-key spellings, with a bounded input size. **Regex redaction still cannot guarantee removal of arbitrary unquoted source/value text from an exception; #62 stays open.** Review remains necessary before any export.
- Corrected the help's stale Code Editor save description to reflect its existing external-edit conflict protection. Updated the tour setting description and removed obsolete navigation implementation instructions.

### Checks performed on the combined result

- `node tests/regress.js`: **200 passed, 0 failed**. Includes existing save/Run, recovery, transaction, retirement and lexer regressions, archive tests and the new integration regressions.
- `node tests/check-static.js`: **402 unique IDs, 43 local script/style references resolve**.
- `node --check` over every `js/*.js`: passed.
- GitHub bug-report template: parsed YAML and unique field IDs checked.
- `git diff --check`: passed.

No browser executable, PICO-8 runtime, real folder-permission dialog, screen reader or touch device was available for this independent pass. The archive author's browser/performance claims above were not repeated. Python files were unchanged; bridge tests remain part of normal CI.

### Issue disposition

The automated evidence completes #55 (read-only project-context API) and #69 (offline documentation/tour guards and release checklist). These may be closed against the linked PR under the maintainer's instruction; the code remains on the PR branch until merge.

Keep these issues open rather than treating a green model test as full acceptance:

| Issue | Remaining acceptance evidence/work |
| --- | --- |
| #56 | Real folder-adoption/permission walkthrough. Data Carts currently delegates adoption to Project Audit and therefore replaces its scan too; independence between those tools needs review. |
| #57 | Addressed in the follow-up below (browser journey; prompt buttons fixed). |
| #59 | Addressed in the follow-up below (browser F1/search/legacy/keyboard walkthrough). |
| #60 | Browser hover/focus/Escape, touch and narrow-viewport checks. |
| #61 | Browser welcome/replay/keyboard/missing-target smoke; asynchronous engine cancellation and help-text lookup are covered by regressions. |
| #62 | Addressed in the follow-up below (allowlisted default export). Manual browser check of the Report dialog opt-in remains. |
| #63 | Addressed in the follow-up below (browser/offline walkthrough, issue-form fields). |
| #64 | Actual 320/768/1280 layouts, 200% zoom, theme and pointer/touch checks. |
| #65 | Shared-shell browser keyboard/focus/contrast walkthrough; screen-reader check where available. |
| #66 | Disposable folder happy path, cancellation, permission denial and preflight-to-actual-write comparison. |
| #67 | Foreground before/after input-to-paint and frame-pacing evidence at 256/512/1024; independent worker retry smoke. Archive timings are attributed, not independently reproduced. |
| #68 | First-run/returning-user browser journey, task navigation and narrow-layout checks. |

## Follow-up: #62 default diagnostics export is allowlist-based (2026-11-03)

The integration above left #62's privacy criterion open because regex scrubbing cannot remove arbitrary unquoted text from an exception (for example `playerName.split is not a function` or `Unexpected identifier hunter2`).

- `exportBundle()` / `exportJSON()` now default to `messages: 'redacted'`: each message keeps only a fixed vocabulary of generic error words, numbers of up to five digits, punctuation and the scrubber's placeholders; every other word (identifiers, names, values, non-ASCII words) becomes `[…]`. The bundle records which mode was used (`messages`).
- Full scrubbed text is an explicit opt-in: **Report a problem › Include full error messages** (off by default) regenerates both previews with it and warns that it may contain private details.
- Exported `state` is reduced to plain word characters; stack frames keep a function name only when it is a JavaScript identifier/member chain.
- In-memory `read()` records, Error IDs and de-duplication are unchanged, so local failure UI (e.g. Terrain Lab's Error ID) behaves as before.
- Regressions in `tests/diagnostics.test.js`: hostile unquoted identifiers/values/non-ASCII text, opt-in bounds and scrubbing, stack function-name filtering.

## Follow-up: #63 Report a problem validation (2026-11-03)

Builds on the #62 follow-up above (allowlisted default export).

- **Issue form** (`.github/ISSUE_TEMPLATE/bug_report.yml`): separate required *Affected workspace / tool*, optional *Suite version* and *Browser and version*, required *Expected vs. actual*, an *Attachments* field explaining that files are added manually, and a required privacy confirmation. The privacy notice says the issue is public. No YAML parser was available offline; the file was checked for ambiguous plain scalars and duplicate IDs, and renders on GitHub only after merge to the default branch.
- **Regressions** (`tests/report.test.js`): the real dialog code with empty diagnostics while offline (environment fields, zero records, offline GitHub message), and a recorded error whose summary carries the Error ID but not the message's user text until *Include full error messages* is ticked, and again after it is unticked.
- **Browser walkthrough** (headless Chrome via the DevTools protocol, local `http.server`, temporary script outside the repo): no errors on load. With empty diagnostics, Help › Report a problem shows zero records and the environment section, and focuses Close. While offline, *Open GitHub issue form* reports the offline state and opens only the bare template URL. In headless Chrome, *Copy summary* reaches the select-and-press-Ctrl+C fallback. A synthetic window error and an unhandled rejection with hostile text (identifier, Windows user path, token-like word) appear with Error IDs and `[…]`/`[path]` placeholders, and nothing hostile leaks into either preview. The opt-in shows full text (path still scrubbed) and a warning. After typing a description, *Clear diagnostics* and Close, localStorage, sessionStorage and IndexedDB hold none of the description, message text or error codes. The app threw no other exceptions. Not covered: a real clipboard grant, a real download prompt, a screen reader.

## Follow-up: #57 Send to… browser journey (2026-11-03)

Headless Chrome on `main` at `c532fbc`, driven over the DevTools protocol against a local `http.server`, using a temporary script outside the repo.

**Defect found and fixed:** the central unsaved-work prompt said *"Replace it … or cancel and keep both as they are?"*, but its buttons were **No** / **Replace**. The issue specifies Replace / Cancel. `confirmDialog(title, message, yes, no = 'No')` now takes an optional cancel label (existing callers are unchanged), and `Suite.openIn` passes `'Cancel'`. Initial focus stays on the dialog's ✕ button, so Enter and Escape do not replace. Regression: `tests/transfer.test.js` runs the real `openIn` from `js/suite.js` and checks the labels; Cancel neither opens nor reports success, and Replace opens with the temporary-copy wording. The test fails before the fix and passes after it.

**Journey results:**
- **Pixel Studio › File › Send to › All destinations…** lists all 12 registered consumers, available ones first. The three unavailable ones remain Tab-focusable with `aria-disabled`, a visible reason and `aria-describedby`. Clicking one does nothing.
- **Happy path to Map Editor tileset:** sends a 128×128 image without opening the Library. The toast names the target and says *temporary copy*, and the Pixel Studio source pixels are unchanged.
- **Happy path to Tile Maker** (File › Send to › Tile Maker): imports and rebuilds, with the same temporary-copy wording.
- **Unsupported dimensions:** a 100×60 image disables the fade preview and the Map Editor tileset with exact size reasons. A 2048×16 image also disables Pixel Studio (*supports up to 1024×1024*). No conversion is offered silently.
- **Unsaved destination:** with an unsaved map open, sending a tileset prompts Replace / Cancel. **Cancel** closes everything, toasts *"Cancelled. … unchanged"*, and leaves the map unsaved (the next send prompts again). **Replace** applies the tileset. The workspace switches only after confirmation.
- **Failing destination** (a test consumer that throws): an error dialog says *"… could not open … Nothing was changed."*, `openIn` returns `false` and no success toast appears.
- **Library:** storing still works, and an asset's details dialog lists the same destinations. Sending from it says *"The Library copy is unchanged"*, and the stored asset is intact.
- No exceptions were thrown, and `P8App.diagnostics` stayed empty.

**Noted, not changed:** Pixel Studio lists itself as a destination for its own image (harmless; it reopens the same picture). Touch input and screen reader announcement were not checked.

## Follow-up: #59 Help registry browser walkthrough (2026-11-03)

Headless Chrome, driven over the DevTools protocol with real key events, against a local `http.server`. The script was temporary and kept outside the repo. No code change was needed. Results on `main` at `c532fbc`:

- **F1 in every workspace tab** (all 11: Home, Pixel Studio, Palette & Fades, Tile Maker, Map Editor, Code Editor, Cart Builder, Project Audit, Data Carts, Data Tools, Extra Tools) opens Help on that workspace's canonical topic (`P8Help.forWorkspace`), with focus in the search field; Escape closes it. F1 also works while typing in a Code Editor field, and F1 inside an open Help dialog does not stack a second dialog.
- **Search** finds controls, tasks and shortcuts: *tile reduction* → Tile Maker; *count tokens* → Project Audit, Code Editor; *ctrl+r* → Code Editor; *report* → Report a problem first. *zzzqqq* gives the "No results" state with suggestions and working *Browse the Help index* / *Open the full documentation* links. The index link clears the query and moves focus to the heading.
- **Keyboard:** Tab from the search field reaches the first index link, and Enter opens that topic and focuses its heading. Related-topic and *← Help index* links work.
- **Legacy reference:** Code Editor's *Detailed reference* opens Full documentation scrolled to `#doc-code`, and *Search Help* returns to Help with a single dialog open.
- **Offline:** with network emulated offline, Help › Help and search work (everything is local).
- **Narrow layout:** at 360 px the dialog fits (326 px) without horizontal page overflow.
- Escape in a non-empty search field first clears the query (native `type=search` behavior); a second Escape closes the dialog.
- No exceptions were thrown, and `P8App.diagnostics` stayed empty throughout.

Not covered: screen reader announcement of the live region, touch input, and a real non-Chromium browser.


## Integrated review follow-ups (2026-11-03)

The [review of `fd31e3c`](HEALTH_REVIEW_2026-11-03_fd31e3c.md) reproduced six further correctness gaps, tracked in #80–#85. Specific UX integration findings are the unguarded existing Tile Maker → Map Editor send (#81), stale include-parent context after Code Editor folder adoption/picking (#83), and palette/settings changes before Tile Maker import cancellation (#84). Default diagnostics message allowlisting remains in place, but arbitrary error names and identifier-shaped stack metadata still appear in default exports (#85); this limits the complete privacy claim made for #62/#63. No diagnostic upload occurs automatically.

The review passed 205 JS regressions, five bridge tests, syntax and static HTML checks. These new findings came from actual-function/core probes with controlled fake I/O. The review had no working browser executable, so it does not repeat or replace the attributed browser evidence above. No implementation changed in the review documentation PR.

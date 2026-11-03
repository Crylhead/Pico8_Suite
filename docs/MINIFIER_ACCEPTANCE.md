# Minifier core acceptance record — MIN-10 / #128

**Date:** 2026-11-03. **Integrated baseline:** `b92d03cab15de6c237d9963eaf7cf5528986becd` (MIN-01–MIN-09 merged). This change adds fixtures, combined regressions and this record, and fixes the export focus-return defect found by the keyboard acceptance check.

**Release status: BLOCKED — real installed PICO-8 verification is still required.** Do not close #128 or the core roadmap tracker #130 based on parser, Node or headless-browser checks alone. PNG export remains optional MIN-11 / #129 and is not implemented.

## Environment and scope of evidence

| Component | Tested version / constraint |
| --- | --- |
| Browser | Headless Chromium 153.0.8010.0, Linux, using the existing session browser runner |
| Browser engine | Shrinko8 1.2.7f, commit `fb6e66827d481020857d7548fdd9dd0171315a86` |
| Browser Python | Pyodide 314.0.7 / Python 3.14.2, from the pinned local assets |
| Native comparison | Same pinned Shrinko8 modules, Python 3.12.14 |
| Other browsers / OS | Firefox, WebKit, native Windows/macOS browser sessions not exercised here |
| Accessibility | Browser labels/roles, keyboard interactions, focus and forced-colors checked; no NVDA/VoiceOver user session |
| PICO-8 | Not installed on PATH or in the accessible runtime/workspace locations checked; no executable or console version to report |

All processing requests in the browser checks were same-origin GETs; no source upload or external processing was used. The worker crash, delayed replies and rare increased-budget values were explicit test injections, described below. Those injections are not Suite features and are not included in production scripts.

## Automated contracts

`tests/minifier-integration.test.js` connects the real Code Editor snapshot bridge, include resolver, job adapter, metrics/result validation and exporter. Its transport supplies **recorded actual pinned-engine responses**, rather than pretending to run Python in Node. It covers:

- Dirty `.lua`, representative `.p8` and five-file project captures, including repeated/nested paths, CRLF, tab includes, P8SCII and source-only hints; fixed Minimal + Tokens jobs and flags; immutable editor/selection/save context; exact cartridge envelopes; distinct build names.
- A late reply from an actual retired adapter owner arriving after a newer accepted result; exporting the newer snapshot only; worker crash, source retention and explicit retry without automatic submission; option changes disabling export.
- A structurally successful worker envelope with a changed map byte being refused by export preservation checks; a later valid result recovering.

`tests/fixtures/minifier/release/engine-results.json` records the actual engine metadata, immutable sources, flags, output, counts and diagnostics. `test_release_integration_goldens_match_the_pinned_real_engine` reruns every case through the real pinned Python bridge and compares the entire response. The existing independent-native-reader test now also exercises the representative cart: generated output is built through the JavaScript exporter and parsed using Shrinko8's separate Python cart reader, comparing ROM, version, label and code.

The `.min.p8` companion was downloaded through the actual browser workspace. The integration regression compares it to the validated exporter output. Its original header and all non-Lua text match the authoring fixture exactly.

Expected actual token counts:

| Fixture | Before | After |
| --- | ---: | ---: |
| `sample.lua` | 16 | 11 |
| `release/representative.p8` | 56 | 55 |
| `project/main.p8` and its resolved tree | 21 | 16 |

Run from the repository root:

```sh
# Prepare pinned local assets once (Internet or the documented pinned archives).
python tools/package_minifier.py

# Combined contracts and the existing harness.
node -e "require('./tests/minifier-integration.test.js'); require('./tests/harness.js').run()"
node tests/regress.js
node tests/check-static.js
node --check tests/minifier-integration.test.js
python -m py_compile tests/test_minifier_native.py
python -m unittest discover -s tests -p test_minifier_native.py -v
git diff --check
```

A clean checkout without packaged assets **skips** the native engine tests by their existing rule. A skipped native suite is not real-engine evidence; package assets and ensure all nine tests run. No new test framework, npm dependency or broad CI change is introduced.

Final local results: **317 JavaScript regressions passed**, **9 real-engine Python tests passed**, static HTML/reference checks passed, changed test syntax and relative documentation links passed, and `git diff --check` passed. Changed production JavaScript is limited to Minifier export focus restoration and its help text. The native suite was actually run with packaged assets, not skipped.

## Integration defect fixed

The keyboard-only journey found that Cancel/Escape in Download left focus on the page body: Minifier disabled the opener before the shared dialog captured it, and that control was still disabled when shared restoration ran. The presenter now captures the export opener first and restores it only after re-enabling controls. A stale disabled opener falls back to Source actions. Later focus, another open dialog, a hidden workspace or a disposed view prevents restoration from stealing focus. Clipboard completion uses the same guard. The focused regression fails against the pre-fix presenter and passes with the correction; shared modal code is unchanged.

## Browser acceptance scenarios

Use `python tools/serve_suite.py` and its localhost URL. The following actions describe reproducible browser checks and their evidence boundaries. For full equivalence, the installed-console gate below must still pass.

| Scenario | Reproduction / observation | Status |
| --- | --- | --- |
| Fresh HTTP and engine failure | Fresh Minifier page; block `vendor/pyodide/runtime/pyodide.mjs` before startup. Helpful error shown. Unblock and Retry: a fresh worker reaches ready without submitting a source job. | Passed in Chromium |
| Cached, offline after load | Initialize and optimize a complete project, switch browser offline, optimize the captured tree again. The result and eligible exports remain available. Re-enable network before testing fresh-worker retry. | Passed; initialized session only, not a cold offline reload claim |
| Input, paste and cancellation | Pick `.lua` and `.p8`; cancel the native file input; decline replacement; submit empty/invalid paste then valid Unicode/tabbed Lua. Previous work survives cancelled/failed input; syntax errors appear only on explicit Optimize. Reload leaves no imported source. | Passed in Chromium |
| Actual defaults and zero saving | Inspect real worker jobs/results for the fixed flags. Optimize `cls()`; display is `0 (0%)` and valid export remains available. | Passed |
| Negative saving and budget overflow | An isolated presenter fixture reports 8,192→8,193 tokens and 65,535→65,536 characters; UI says Increased/Over limit and `<0.01%`, not false zero savings. | Passed, synthetic display fixture; no claim the real engine produced these counts |
| Includes and directives | Open `tests/fixtures/minifier/project` in Code Editor, capture dirty `main.p8`, optimize. Five plain text files, 21→16 tokens; repeated/nested/tab/P8SCII content correct. Denied access or missing dependency retains the old source/result; no rescan, write or permission request during handoff. Cycles and unsafe forms are covered by resolver/real-engine regressions and explicitly refused. | Passed; failure permissions injected using test file handles |
| Worker crash | A test-only worker listener throws on a marked optimization before normal dispatch. The real browser worker emits an error; export disables, source stays, Retry initializes a fresh worker without resubmitting. | Passed, injected actual worker exception |
| Stale input/options | Hold an actual worker result, replace source, initialize/run a new worker, then release the saved old callback. New result stays unchanged. Change options through the test-exposed adapter; export immediately disables. | Passed, delayed real reply / adapter test hook; unsupported focus cannot be selected in the production UI |
| Independent cart/data preservation | Browser-download the representative `.min.p8` under its distinct name; verify exact original header/non-Lua envelope, then decode exporter output with the independent native cart reader. Changed map output is refused by integration/export tests. | Passed for gfx/map/flags/SFX/music/label/version/code |
| Editor return | Capture dirty editor code using Cart → Minify…, optimize, Back. Compare buffer, caret, save identity and dirty flag; invoke native Undo and verify the typed edit is undone. Handoff never requests filesystem access. | Passed in Chromium |
| Navigation | Open Home, find Minifier, use Ctrl+K/Find tool and its keyboard selection, and open `#minifier` directly. Existing workspace navigation preserves work. | Passed in Chromium |
| Help/tour/hints | F1 on the workspace and known control, Help search, Concise/Detailed/Off; labels/warnings remain with hints off. Help → Tour this tool, Quick tours search/replay, Escape, focus and hidden output/handoff skips. | Passed on the unchanged MIN-09 Help/Tour/Tooltip modules; see PR #141 |
| Keyboard-only export journey | At 375×667, use only Tab/Enter to Paste Lua, load `cls()`, Optimize, arrow-select Optimized, Copy, open Download, Escape, then F1/Escape. The export opener regains focus after cancellation. | Passed in Chromium after the focus fix |
| Layouts/themes | 1440, 900 and 375px widths in Light, Dark and System (including system-dark); no horizontal page overflow or horizontally clipped visible action controls. Hidden Retry is intentionally excluded from geometry assertions. Forced-colors keeps notices and controls perceivable. Read-only viewers retain associated labels and groups/statuses retain names/roles. | Passed in Chromium; keyboard/labels are not a full screen-reader audit |

The Minifier remains Minimal + Tokens only. Output is an optimized build copy, source-only directives may be removed, and there is no automatic Run/Save/Cart Builder transformation. Asset checks do not prove visual/audio/runtime equivalence. See [the user guide](MINIFIER.md) for includes, storage, hosting and export limitations.

## Required installed PICO-8 gate — NOT RUN

Fixtures ready for this check:

- Authoring cart: [representative.p8](../tests/fixtures/minifier/release/representative.p8)
- Actual browser-exported build: [representative.min.p8](../tests/fixtures/minifier/release/representative.min.p8)

Delivered SHA-256 values (verify these before recording console results):

| Cart | SHA-256 |
| --- | --- |
| `representative.p8` | `d1df75ae3df0f61ee034727044ae058d9ec825f380fbad48a8bb1ede6a3e65b8` |
| `representative.min.p8` | `2f65d52ca92ed5bc9b81a0060892ba4bcc5d32dc1c6dddcf2c94809b7dfb1b34` |

Both contain a short startup SFX, a white/red two-tile map, a moving sprite, an animated yellow line and `minifier ♥` text. These are **intended observations**, not behavior observed in PICO-8 here. The graphics, map, flags, SFX, music and label sections carry explicit data for preservation checks. The two code tabs are authoring structure; minified output may merge code tabs while retaining executable behavior.

1. Record OS, executable path and exact installed PICO-8 version from its startup/help screen. Record browser/version used for the build if regenerating it.
2. Place both carts in an accessible PICO-8 cart folder. In the console, `load representative.p8`, then `run`. Observe for at least 20 seconds, including several animation wraps. Note visual errors, startup tone, Unicode text and runtime errors.
3. Stop, `load representative.min.p8`, then `run`. Repeat the same observations. Compare rendering/motion, startup sound and error behavior against the authoring cart. Inspect graphics, map, flags, sound/music and label data in PICO-8's editors as appropriate. Record `info` budget counts and any platform/version differences.
4. Reopen the authoring file in the Suite and confirm it remains original. Do not replace it with the optimized build. Record cart hashes, version, observed result and any differences in this log or a linked #128 comment.
5. Only after the comparison passes and any attributable defects are fixed/retested, mark this gate passed. Close #128 and #130 only when all other required checks are also satisfied. Do not infer success from the independent parser or lack of a syntax error.

| Required evidence | Result |
| --- | --- |
| Installed executable/version | Unavailable in this environment |
| Authoring cart observed in PICO-8 | Not run |
| Optimized cart observed in PICO-8 | Not run |
| Visual/audio/runtime comparison | Pending |
| Core release decision | Blocked pending the above evidence |

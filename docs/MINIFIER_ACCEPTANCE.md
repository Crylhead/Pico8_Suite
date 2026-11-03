# Minifier core acceptance record — MIN-10 / #128

**Date:** 2026-11-03. **Historical MIN-10 baseline:** `b92d03cab15de6c237d9963eaf7cf5528986becd` (MIN-01–MIN-09 merged). PR #142 added fixtures, combined regressions and this record, and fixed the export focus-return defect found by the keyboard acceptance check. The stage-specific counts and results below remain that historical evidence; later PNG results are recorded separately.

**Core release gate: PASSED for the representative cart.** On 2026-11-03 the user confirmed matching original and optimized behavior, including the startup tone, in installed Windows PICO-8 0.2.7. This completes the outstanding runtime requirement for #128 and core tracker #130 together with the previously merged implementation and automated/browser checks. Optional PNG export MIN-11 is also implemented: [PR #144](https://github.com/Crylhead/Pico8_Suite/pull/144) is merged and [#129](https://github.com/Crylhead/Pico8_Suite/issues/129) is closed after the separate user-run PNG check. See [PNG verification](MINIFIER_PNG.md). This result does not guarantee equivalence for arbitrary cartridges.

## Environment and scope of evidence

| Component | Tested version / constraint |
| --- | --- |
| Browser | Headless Chromium 153.0.8010.0, Linux, using the existing session browser runner |
| Browser engine | Shrinko8 1.2.7f, commit `fb6e66827d481020857d7548fdd9dd0171315a86` |
| Browser Python | Pyodide 314.0.7 / Python 3.14.2, from the pinned local assets |
| Native comparison | Same pinned Shrinko8 modules, Python 3.12.14 |
| Other browsers / OS | Firefox, WebKit, native Windows/macOS browser sessions not exercised here |
| Accessibility | Browser labels/roles, keyboard interactions, focus and forced-colors checked; no NVDA/VoiceOver user session |
| PICO-8 | User-run Windows PICO-8 0.2.7; version visible in the supplied console screenshot. No executable path was supplied. PICO-8 remains unavailable in the assistant environment. |

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

### Continuous real-engine gate (#145)

The paragraphs above record the original #128 evidence. Since #145, CI separates two levels of checks:

| Job | Runs on | What it proves |
| --- | --- | --- |
| `checks` (fast) | Every PR, push to `main`, `v*` tag | JS regressions, syntax, static references, bridge/package Python tests. The engine bundle is not packaged here, so the native and PNG suites report **skipped**; a skip is not a pass. |
| `minifier-native` (*Minifier real-engine checks*) | Same triggers, plus manual dispatch | Fetches only the archives pinned in `vendor/minifier-lock.json` (CI cache keyed on that file), runs `tools/package_minifier.py` (verifies archive, bundle and runtime SHA-256), then `tests/run_minifier_native.py`. |

`tests/run_minifier_native.py` fails if `engine.zip` is missing or differs from the lock, if any test is skipped/failed/errored, or if the executed count differs from its explicit `EXPECTED` table (12 native, 5 PNG since #148; update it deliberately when tests change). It requires the test-only Pillow reader (CI pins `Pillow==12.1.0`) so the independent PNG decode runs. `--negative-controls` reruns the release and corpus goldens tests against an engine copy with the optimizer disabled and the independent PNG-reader test against an encoder copy that flips payload bits; it fails unless both are detected. Archives are downloaded only by CI or the developer packaging step, never by the user-facing page, and no user cartridge or PICO-8 runtime file is involved.

A release must be tagged `v*` from a commit whose `minifier-native` job passed; the tag push reruns it. Repository owners should mark *Minifier real-engine checks* as a required status check for `main`.

Known local limitation: on Windows, the native suite has pre-existing environment failures (default cp1252 file decoding, and the case-insensitive filesystem in the `X.lua` include case). Use `PYTHONUTF8=1`; the case-sensitivity case is authoritative on the Linux CI runner and the browser's case-sensitive Pyodide filesystem.

```sh
python tools/package_minifier.py
python tests/run_minifier_native.py
python tests/run_minifier_native.py --negative-controls
```

## Compatibility corpus (#148)

`tests/fixtures/minifier/corpus/` holds small, self-authored carts (CC0; `assets.p8` reuses the release fixture's data sections). No proprietary PICO-8 engine, ROM or third-party cart is included. `manifest.json` lists each case and what it covers; `engine-results.json` records the pinned engine's complete result for each.

| Case | Covers | PNG |
| --- | --- | --- |
| `shorthand.p8` | `?`, `if (…)`, `while (…)`, compound assignment, `\` and `\=`, `^^`, `>>>`, `<<>`, `~`, `@`/`%`/`$` peeks, `..=`, `!=` | yes |
| `strings.p8` | multiline `[[ ]]`, `[==[ ]==]` containing `]]` and `--`, escapes, P8SCII glyphs, `\^` control code, `#include` and `--[[` inside strings | yes |
| `scopes.p8` | code tabs, local/global shadowing, closures, varargs, `goto`, metatables, `cartdata`/`dset`/`dget`, multi-value `poke` | yes |
| `assets.p8` | `__gfx__`, `__map__`, `__gff__`, `__sfx__`, `__music__`, `__label__`, `__meta:title__` | yes |
| `inc/main.p8` | repeated `#include`, includes from two folders | no |
| `plain.lua` | `.lua` entry, constant folding, local function | no |

Negative cases (inline in `manifest.json`): unsupported compiler hint and `#compile` directive, missing include, case-ambiguous include, missing code tab, Lua syntax error and invalid cart header. Each must fail with its specific code and an actionable message, return no Lua or cart text, and leave the exporter unable to build.

Automated checks, all in the real-engine gate (`tests/test_minifier_native.py`, `tests/test_minifier_png.py`):

- every positive case equals its recorded result (output, metrics, diagnostics, fixed Minimal + Tokens flags); two runs are identical; the pinned upstream CLI produces the same text and token/character counts;
- every `.p8` case, exported through the actual JavaScript exporter, keeps ROM (gfx/map/flags/SFX/music), version, label, metadata and the exact non-Lua text, compared with Shrinko8's independent reader;
- every PNG-eligible case decodes back from `.p8.png` to the same ROM, code, label and version (a cart without `__label__` gets a blank label image, as in every `.p8.png`);
- the negatives above.

Sources are read with CRLF normalized to LF. After deliberately changing a fixture or the engine pin, run `python tests/minifier_corpus.py --write` (packaged engine required) and review the diff; it reproduces the committed file byte for byte.

**Finding:** PICO-8 0.2.7 rejects `#include` inside an included file ("unexpected symbol near '#'"), while the pinned engine and the Minifier resolve nested includes (see `project/sub/nested.lua`). The optimized, flattened build runs; the original project does not run in PICO-8 itself. The corpus include cart therefore keeps every `#include` in the cart.

### Runtime parity run — performed 2026-11-04

Performed by a Claude Code session on Windows 11 with the installed **PICO-8 v0.2.7** (version from the installed manual), using `pico8 -x` on the unmodified carts. Each runtime cart prints one console line on its first drawn frame: its computed values and a checksum of the whole 128×128 screen (`fb`). Originals ran from the fixture folder; optimized carts were built through the JavaScript exporter from the recorded results.

| Cart | Original and optimized `.min.p8` console line (identical) |
| --- | --- |
| shorthand | `sum=15210.5 fb=0xbae6.5278` |
| strings | `checks=17,20,8,3,23,21,6,65,135 fb=0x3870.b9bb` |
| scopes | `cnt=3 n=3 2nd=5 sh=10 g=1 loops=4 mt=42 pk=6 cdata=7 fb=0x60bb.3d59` |
| assets | `flags=2 cell=1 px=8 fb=0x3798.67c1` |
| includes | `total=6 twice=8 deep=14` |

All ten carts booted cleanly. The `.min.p8.png` builds of `shorthand` and `assets` also loaded in PICO-8 and printed the same lines.

Not covered by this run: audio (the assets cart starts `music(0)`; sound was not compared), input-driven behavior, frames after the first, other PICO-8 versions, macOS/Linux PICO-8, and browser engines. `scopes.p8` creates a `p8suite_corpus_v1` cartdata file in PICO-8's own data folder. The lockstep control harness available to the session timed out at boot on these carts (and on the release cart), so console reports were used instead.

### Manual checklist (not yet performed)

For each runtime cart, open the original and the exported `.min.p8` in PICO-8, note the version, and compare: the screen after a few seconds, the console line, and for `assets` the music. Repeat `assets` and `shorthand` from `.min.p8.png`. Record results here only after doing them.

## Integration defect fixed

The keyboard-only journey found that Cancel/Escape in Download left focus on the page body: Minifier disabled the opener before the shared dialog captured it, and that control was still disabled when shared restoration ran. The presenter now captures the export opener first and restores it only after re-enabling controls. A stale disabled opener falls back to Source actions. Later focus, another open dialog, a hidden workspace or a disposed view prevents restoration from stealing focus. Clipboard completion uses the same guard. The focused regression fails against the pre-fix presenter and passes with the correction; shared modal code is unchanged.

## Browser acceptance scenarios

Use `python tools/serve_suite.py` and its localhost URL. The following actions describe reproducible browser checks and their evidence boundaries. The installed-console comparison below supplies the additional runtime evidence for the representative cart.

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

## Installed PICO-8 gate — PASSED via user comparison

Fixtures ready for this check:

- Authoring cart: [representative.p8](../tests/fixtures/minifier/release/representative.p8)
- Actual browser-exported build: [representative.min.p8](../tests/fixtures/minifier/release/representative.min.p8)

Delivered SHA-256 values (verify these before recording console results):

| Cart | SHA-256 |
| --- | --- |
| `representative.p8` | `d1df75ae3df0f61ee034727044ae058d9ec825f380fbad48a8bb1ede6a3e65b8` |
| `representative.min.p8` | `2f65d52ca92ed5bc9b81a0060892ba4bcc5d32dc1c6dddcf2c94809b7dfb1b34` |

Both contain a short startup SFX, a white/red two-tile map, a moving sprite, an animated yellow line and `minifier ♥` text. Both recordings show the expected visual elements and animation. The user explicitly confirmed matching behavior and startup tone; audio is reported by the user, not inferred from silent GIFs. The graphics, map, flags, SFX, music and label sections carry explicit data for preservation checks. The two code tabs are authoring structure; minified output may merge code tabs while retaining executable behavior.

### Procedure for future repetitions

1. Record OS, executable path and exact installed PICO-8 version from its startup/help screen. Record browser/version used for the build if regenerating it.
2. Place both carts in an accessible PICO-8 cart folder. In the console, `load representative.p8`, then `run`. Observe for at least 20 seconds, including several animation wraps. Note visual errors, startup tone, Unicode text and runtime errors.
3. Stop, `load representative.min.p8`, then `run`. Repeat the same observations. Compare rendering/motion, startup sound and error behavior against the authoring cart. Inspect graphics, map, flags, sound/music and label data in PICO-8's editors as appropriate. Record `info` budget counts and any platform/version differences.
4. Reopen the authoring file in the Suite and confirm it remains original. Do not replace it with the optimized build. Record cart hashes, version, observed result and any differences in this log or a linked #128 comment.
5. Only after the comparison passes and any attributable defects are fixed/retested, mark this gate passed. Close #128 and #130 only when all other required checks are also satisfied. Do not infer success from the independent parser or lack of a syntax error.

| Required evidence | Result |
| --- | --- |
| Installed executable/version | User-run Windows PICO-8 0.2.7; screenshot confirms version; full executable path not supplied |
| Authoring cart observed in PICO-8 | User-supplied recording and confirmation; expected sprite/map/line/text visible |
| Optimized cart observed in PICO-8 | User-supplied recording and confirmation; expected sprite/map/line/text visible, no runtime error reported |
| Visual/audio/runtime comparison | User confirms “exactly the same .. with startup tone and everything” |
| Core release decision | Core representative-cart gate passed; optional PNG was subsequently verified and merged in #144, closing #129 |


### Evidence provenance and limits

The optimized-cart recording (`PICO-8_0.gif`) and original-cart recording (`PICO-8_1.gif`) each contain 479 frames / 14.37 seconds. Inspected frames show the expected animation and heart glyph. The user first confirmed that the optimized cart runs, then tested the supplied original cart and explicitly confirmed matching behavior including the startup tone. This is installed-console evidence supplied by the user; the assistant did not execute PICO-8 locally. No longer test duration, local executable path, console `info` readout or audio recording is claimed. The earlier syntax error came from treating cartridge text as code and was resolved by loading the `.p8` file as a cartridge.

The fixture SHA-256 values above identify the delivered repository files; the user did not independently report local hashes. The independent parser/data checks and all 317 JavaScript / 9 native-engine checks remain the evidence recorded earlier. Runtime confirmation applies to these representative carts in PICO-8 0.2.7. Other cartridges and OS/browser engines need their own appropriate validation. PNG output subsequently received its separate representative-fixture check, recorded in [MINIFIER_PNG.md](MINIFIER_PNG.md).

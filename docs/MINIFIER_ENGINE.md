# Minifier engine foundation and job adapter — MIN-01 / #119, MIN-02 / #120

**Current verification status:** the representative original, optimized text cart and generated PNG were confirmed to work with matching visuals/startup tone by the user in Windows PICO-8 0.2.7 on 2026-11-03. See [the acceptance record](MINIFIER_ACCEPTANCE.md) for evidence and limits. Earlier stage-specific notes below retain the release gates that were pending when those checks ran. Optional PNG export #129 now uses the local standard-library encoder; see [PNG dependencies and verification](MINIFIER_PNG.md).

Real Shrinko8 runs in a local browser **module Web Worker**. The DOM-free model and adapter below manage application jobs, revisions and cancellation. The native Develop → Minifier workspace accepts standalone UTF-8 `.p8` / `.lua` files, pasted Lua and immutable live Code Editor snapshots (including unsaved edits). The handoff returns to the existing editor without applying output; later editor changes invalidate its job/result. Project includes are supported through already-authorized Code Editor folder handles; validated separate build-copy exports are available after preservation checks. See [the handoff API](../EXTENDING.md#minifier-jobs).

## Pins and package scope

| Component | Pin | Distribution |
| --- | --- | --- |
| Shrinko8 | 1.2.7f, `fb6e66827d481020857d7548fdd9dd0171315a86` | 24 unchanged MIT-licensed Python modules; deterministic stored ZIP, **518,437 bytes** |
| Pyodide | 314.0.7 | Official npm archive; required local files below |
| CPython inside Pyodide | 3.14.2 | Standard library and WASM runtime |
| Additional Python packages | None | No Pillow, micropip or lupaz8 |

[`vendor/minifier-lock.json`](../vendor/minifier-lock.json) records exact archive URLs, archive hashes, per-runtime-file hashes/sizes, module allowlist and resulting engine ZIP hash. License texts and notices are in [`vendor/shrinko8`](../vendor/shrinko8) and [`vendor/pyodide`](../vendor/pyodide).

| Required Pyodide file | Bytes |
| --- | ---: |
| pyodide.mjs | 17,931 |
| pyodide.asm.mjs | 1,250,344 |
| pyodide.asm.wasm | 9,598,218 |
| python_stdlib.zip | 2,545,637 |
| pyodide-lock.json | 119,077 |
| Runtime subtotal | **13,531,207** |
| Runtime plus Shrinko8 ZIP | **14,049,644** |

These are decoded local asset sizes, excluding the small bridge/worker/manifest files and HTTP compression. To avoid adding approximately 14 MB of generated runtime binaries to this small repository, the implementation uses the **deterministic local packaging strategy**. Generated `vendor/*/runtime/` folders are ignored by Git. They must be included when distributing/hosting the functional Minifier; a fresh clone without packaging cannot initialize it. It does not silently fall back to a CDN.

## Package, serve and verify

For local use, double-click `Start_Pico8_Suite.bat` on Windows (Python 3.9+) or run `python tools/serve_suite.py`. The optional helper binds only to loopback at port 8000, validates existing assets against the lock, prepares missing/outdated assets with the same verified packager, then opens `http://127.0.0.1:8000/index.html#minifier`. It serves static files; source still goes only to the browser worker. Hosted deployments do not require this Python helper.

Valid assets need no download, so subsequent starts can be offline. First setup can use the existing `--shrinko-archive` / `--pyodide-archive` flags with pinned archives. `--no-browser` prints the URL without launching a browser. A busy port or failed verification stops startup; no unrelated server is opened and the port never changes silently. `--port 8001` is an explicit alternative and creates a different browser storage origin. Module MIME types are fixed for `.js`, `.mjs` and `.wasm`, including Windows MIME registry differences. The server refuses unrelated Host headers, directory listings, hidden files and paths resolving outside the Suite folder.

Direct `file://` is still unsupported by this engine contract. The workspace shows **Local setup required**, with launcher instructions and futile Retry disabled, instead of presenting a failed optimization. The file tab and its source are retained. Library/session data belongs to each address: export/import a Library backup when switching to localhost; no silent migration is attempted.

Local startup proof (#134): actual Chromium 153.0.8010.0 on Linux showed setup at file:// (900/375 px, no page overflow), then opened the real helper's localhost link. Cold setup used the pinned local archives; the real engine became ready and matched the Lua CLI fixture. Restart with inaccessible archive paths reused installed assets without downloading. The file tab's source remained intact and localhost did not silently inherit its storage. No browser errors, cross-origin runtime requests or source uploads occurred. The Windows batch wrapper was reviewed but not executed on Windows in this environment.

For manual packaging/hosting instead of the launcher:

From the repository root, with Python 3.9+ for the packaging utility:

```sh
python tools/package_minifier.py
python -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/tests/minifier-worker-smoke.html` and choose **Run worker fixtures**. The developer packaging step downloads only the pinned dependency archives; it does not read or upload user sources. All files/hashes are verified before installation. No npm, bundler or Python bridge is required to use the deployed browser worker. The other Suite tools retain their normal no-build startup.

For reproducible packaging without Internet access, obtain the exact archives in the lock file on a connected machine and supply them locally:

```sh
python tools/package_minifier.py --shrinko-archive /path/shrinko8-pinned.tar.gz --pyodide-archive /path/pyodide-314.0.7.tgz
python -m unittest discover -s tests -p 'test_minifier*.py' -v
```

Both archives must match the pinned SHA-256 values. No archive paths/links are extracted wholesale; only allowlisted regular files are read. Native engine tests explicitly skip when the generated engine ZIP is absent. Packaging/integration checks must install the assets first; a skipped real-engine test is not release evidence.

The fixture compares browser output to checked-in `sample.min.lua` / `sample.min.p8` reference outputs from an independent direct invocation of the pinned CLI. The Python tests repeat that comparison, and a JS regression checks the cart/data sections with the Suite's separate cartridge parser. This is evidence for these fixtures, not a guarantee of equivalence for arbitrary carts. The later representative-cart user-run PICO-8 validation completed #128; see [the acceptance record](MINIFIER_ACCEPTANCE.md).

## Exact engine invocation and compiler policy

The fixed CLI argument array is input, output, explicit input/output format, then:

```text
--minify-safe-only --no-minify-rename --no-minify-lines --focus-tokens --no-minify-transform
--input-count --count --parsable-count --error-format common
```

No submitted source is interpolated into Python or a shell command. The bridge calls `shrinko8.main(argv)`; native tests invoke the CLI separately with the identical flags. Only the documented levels/focus choices (below) and `.lua` / `.p8` trees with a matching relative entry file are accepted. MIN-07 supplies reachable dependencies as plain paths/text; missing, ambiguous or unsupported includes fail explicitly. Other profiles/targets/formats return unsupported diagnostics rather than ignored options or partial success.

**Important measured behavior:** `--no-minify-transform` alone does not reject compiler requests. On the pinned engine, `--$switch-compiler:parens8` followed by ordinary Lua succeeds with the transform disabled, ignoring the requested compilation. Therefore the bridge uses Shrinko8's actual tokenizer to find compiler/dynamic-include/alias/sublanguage/placeholder comments and refuses them before optimization. Compiler-looking strings are accepted as strings. The upstream compiler scripts and Parens-8 runtime are not packaged.

The pinned parsable counter identifies output as `count:None:…`, not `count:output:…`. The bridge normalizes its actual counts. Source compressed size is not emitted for these plain-text inputs: it is `null` with a reason. Output compressed code size is reported separately, never confused with PNG/file length.

## Worker contract for MIN-02

Load `js/minifier-worker-host.js` lazily and call `P8MinifierWorkerHost.create()`. It constructs the local **module** worker with no runtime initialization until a message is sent. Pyodide 314.0.7 rejects classic workers; do not remove `{type:'module'}`. The shell includes the host/adapter scripts; the module worker and Python/WASM initialize lazily when Minifier is first opened. Opening it never submits source automatically.

Requests:

```js
worker.postMessage({ protocol: 1, type: 'init', requestId: 'init-1' });
worker.postMessage({ protocol: 1, type: 'optimize', requestId: 'run-1', job: {
  jobId: 'job-1', sourceRevision: 1, optionsRevision: 0,
  entryPath: 'demo.p8', files: [{ path: 'demo.p8', text: cartText }],
  kind: 'p8', profile: 'minimal', target: 'tokens'
} });
```

Replies preserve `requestId`, `jobId`, `sourceRevision`, `optionsRevision` and `protocol`. `type` is `ready`, `result`, `png` or `error`. The optional `png` request/reply uses the same job identity; see [MIN-11](#optional-png-export--min-11) and the [public adapter contract](../EXTENDING.md#minifier-jobs). Ready includes pinned engine versions, capabilities, measured initialization time and allocated WASM heap bytes. Optimization replies contain `result`:

```text
{ok, lua?, cartText?, metrics?: {original, optimized}, diagnostics, flags?}
metric values: {tokens, characters, compressedBytes, compressedReason?}
diagnostic: {severity: 'error'|'warning', code, message, file?, line?, column?}
```

Errors do not contain generated output. Submitted Lua is parsed/minified, never executed. There is no eval/custom-script/editor interface. Requests are serialized inside one worker. Output text/diagnostics are plain data, never trusted HTML.

The MIN-02 adapter owns immutable application snapshots, stale-result rejection, capability validation, cancellation, retry/dispose and application state transitions. **Echoed revisions alone are not a stale-result guard.** The adapter also checks request identity and the actual worker instance. Cancellation terminates the worker; Retry creates a fresh one and sends `init`. No failure changes the Suite shell or an editor document.

## Shared model and adapter — MIN-02

Load classic scripts in this order: `js/minifier-core.js`, `js/minifier-worker-host.js`, `js/minifier-engine.js`. They export `P8MinifierCore`, `P8MinifierWorkerHost` and `P8MinifierEngine`; core and adapter also support CommonJS for Node tests. Loading them, changing source/settings or subscribing never constructs a worker. `index.html` now loads these small scripts and `js/minifier.js`; the runtime starts only when Minifier is first opened. Other tools do not load Python/WASM. The workspace reuses one adapter; [EXTENDING.md](../EXTENDING.md#minifier-jobs) describes its intake API and unavailable workflows.

```js
const minifier = P8MinifierEngine.create();
const unsubscribe = minifier.subscribe((state) => {
  const controls = P8MinifierCore.describe(state);
  // Render plain text diagnostics and controls. No automatic optimize/export here.
});
minifier.setSource({ kind: 'lua', entryPath: 'demo.lua',
  files: [{ path: 'demo.lua', text: 'cls()' }] });
await minifier.initialize(); // await actual worker readiness before enabling Optimize
// Only the user's Optimize action calls this:
const result = await minifier.optimize();
// result: {job, engine, lua, cartText, metrics, diagnostics, flags}, deeply frozen
// On teardown: unsubscribe(); minifier.dispose();
```

Callers must handle rejected promises. Cancellation rejects with `E_CANCELLED`, input/settings changes reject an active optimization with `E_STALE`, and disposal rejects it with `E_DISPOSED`. Engine errors carry plain `diagnostics`; normal parse errors keep the worker available. Invalid protocol/output, crashes, message errors and timeouts discard it. The default per-request timeout is 120 seconds; tests can inject `workerFactory`, `setTimer`, `clearTimer` and `timeoutMs`.

| API | Behavior |
| --- | --- |
| `getState()` / `subscribe(fn)` | Immutable current state / unsubscribe function; observer errors cannot break transport cleanup |
| `setSource(snapshotOrNull)` | Copies relative file paths/text only; replaces the document even if the filename is unchanged |
| `setOptions({profile?, target?, keepLines?, renameAggressive?, reorderAggressive?})` | Validates named options; defaults Minimal + Tokens; identical settings are a no-op |
| `initialize()` | Shared pending promise; initializes only, never sends source |
| `optimize()` | Captures an immutable job before any await; initializes lazily if needed; rejects simultaneous runs |
| `cancel()` | Terminates pending initialization/CPU work and rejects it; idle cancellation is a no-op |
| `retry()` | Replaces the worker and initializes it; a new Optimize action is still required |
| `dispose()` | Terminates work and clears observers; terminal, create another adapter to reuse |

Option mapping (#164):

| Level | Flags | Focus | Flags |
| --- | --- | --- | --- |
| **Minimal** (default) | `--minify-safe-only --no-minify-rename --no-minify-lines` | Balanced | none |
| Safe | `--minify-safe-only` | **Tokens** (default) | `--focus-tokens` |
| Aggressive | `--minify` plus `--rename-safe-only` / `--reorder-safe-only` unless *Rename/Reorder aggressively* is on | Character count / Compressed size | `--focus-chars` / `--focus-compressed` |
| *Keep linebreaks* (Safe/Aggressive) | `--no-minify-lines` | Tokens & characters / Tokens & compressed | both focus flags |

`--no-minify-transform` is always added (compiler transforms stay unsupported). `js/minifier-core.js` `flagsFor()` and `suite_bridge.py` `flags_for()` produce identical lists; a native test checks every combination and CLI parity per level × focus.

The default is unchanged: Minimal + Tokens maps to the five flags documented above. Unsupported names produce `unsupported`, and unknown settings keys are rejected rather than silently passed to the CLI. The current engine advertises `includes: true`; MIN-07 validates the immutable file map and upstream preprocessing before accepting output. Older workers advertising `includes: false` continue to reject multi-file jobs.

One monotonic clock supplies `sourceRevision`, `optionsRevision` and job identities. A source/options change invalidates the active job immediately. During bootstrap, the source-free initialization can finish for the newly loaded input; after source has been posted, the worker is terminated. Replaced workers' saved callbacks and out-of-order request replies cannot make old output current.

`state.status` is one of `empty`, `loading`, `ready`, `running`, `success`, `unchanged`, `stale`, `cancelled`, `error`, `unsupported`. A loaded source may be `ready` while `enginePhase` is still `cold`; **use `describe(state).canOptimize`**, which requires an actual initialized engine. `describe` also supplies `busy`, `stale` and `canExport`. Prior output is retained for review but loses current-result eligibility during a run, after input/settings changes, or on cancellation/error. An equal token count is valid `unchanged` output; increased counts remain valid and `metricDelta` labels them as an increase. Missing measurements stay `null` with an explanation; zero delta formats as `0 (0%)`.

`canExport(state)` is the default **current revision guard**, not an exporter or proof of cart preservation. The implemented MIN-08 exporter performs content/preservation checks and requires the explicit user export action. `outputFilename(path, kind)` suggests a distinct `.min.lua` / `.min.p8` name; it writes nothing. No core/adapter action saves, downloads, executes Lua or modifies Code Editor.

Historical MIN-02 validation: 18 focused Node regressions cover immutable snapshots, all state categories, preset flags, stale/cancelled callbacks, malformed replies, crash-after-reply races, timeouts and fresh-worker retry. A real Chromium 153.0.8010.0 adapter check matched both CLI fixtures below, retained the invalid fixture's file/line/column, cancelled after an optimize message was posted, then initialized a second worker and accepted a zero-token-saving `cls()` result (2 → 2 tokens). It used only same-origin GET requests. At this stage real PICO-8 validation was still pending; the later #128 evidence is in [the acceptance record](MINIFIER_ACCEPTANCE.md).

## Hosting and offline behavior

Historical MIN-05 report proof: **291 JS regressions passed**. Actual Chromium 153.0.8010.0 on Linux reported 16 → 11 tokens (`5 saved (31.25%)`) and 130 → 46 characters (`84 saved (64.62%)`) for the CLI fixture; missing source compression stayed unavailable with a visible reason. Real `cls()` output showed valid `0 (0%)`. A CRLF cart error at file line 4 selected Lua-view line 1 using the keyboard, with no model/route mutation; a retained old location callback could not navigate a newer source. An HTML-looking filename stayed literal text. UI-only fixtures covered increases, over-budget counts, tiny changes (`<0.01%`) and multiple severities. Reports fit 1440 / 900 / 375 px in Light / Dark / System and were inspected in forced-colors/reduced-motion mode. Table naming, live-status semantics and keyboard filtering were checked; screen-reader speech and other browsers were not tested here. These checks do not replace the PICO-8 release gate.

Historical MIN-04 intake proof: **286 JS regressions passed**, including new structural/encoding and transactional intake cases. Actual Chromium 153.0.8010.0 on Linux imported both CLI fixtures through the file picker and produced matching engine output. A CRLF cartridge retained exact original/header/non-Lua text; a CRLF Lua view kept its selection across an input-error render. Empty paste, unsupported/malformed input, picker Cancel, declined replacement and Escape retained current work. Pasted heart P8SCII/code tabs survived the real engine, invalid Lua reported file/line/column on explicit Optimize, and a 375px paste dialog/long filename did not overflow. Reload returned to empty, confirming page-only storage. No browser errors, foreign runtime requests or source uploads occurred. Intake validates text/structure; Lua parsing stays with the engine on explicit Optimize.

Historical MIN-03 workspace verification: **277 Node regressions passed**, including five presenter tests, plus static HTML and changed-JS syntax checks. Actual Chromium 153.0.8010.0 checks covered 1440 / 900 / 375 px in Light / Dark / System (light OS preference), with no page overflow or clipped buttons; forced-colors/reduced-motion presentation and visible keyboard focus were also inspected. A fixture supplied through `Suite.minifier.load` produced the exact CLI reference through the real Optimize button. Home, Find tool, `#minifier`, workspace arrows, view arrows, read-only selection, menus, F1 and missing-runtime Retry worked without browser errors. The initial page did not fetch runtime assets before Minifier entry. This does not substitute for screen-reader speech testing, other browsers or the PICO-8 release gate.

- All runtime, source-bundle and bridge requests use fixed same-origin paths. No `loadPackage`, micropip, CDN execution, source upload or remote processing is used.
- Serve the complete packaged folder over HTTP(S), preferably localhost or HTTPS. `file://` is rejected by the host helper before Worker construction, with the existing localhost setup command. Asset SHA verification requires a secure context (`https://` or loopback HTTP).
- An initialized worker has the runtime/modules in memory and can optimize already supplied source with browser networking disabled; this was verified. Terminating/reloading loses that memory.
- Fresh startup needs the local asset server to be reachable. A locally served installation needs no Internet connection. A fresh remote load while the browser is offline is not guaranteed: no service worker/cache-install workflow is added, and a live worker's offline success is not a promise of fresh-load offline availability.
- Missing assets return `E_ENGINE_ASSETS`, integrity/version mismatches return explicit errors, and a fresh worker can retry. Optimize requires a real `ready` response; downloads also require a current validated result and, for PNG, its optional encoder capability.

## Historical MIN-01 proof results — 2026-11-03

Verified in headless **Chromium 153.0.8010.0 on Linux**, served by a local HTTP fixture server. This is a developer test browser, not a shipped runtime dependency. Other browsers and PICO-8 itself were not tested during this foundation stage; subsequent user-run PICO-8 results are in the [acceptance record](MINIFIER_ACCEPTANCE.md) and [PNG verification notes](MINIFIER_PNG.md).

| Fixture | Tokens before → after | Characters before → after | Output compressed code |
| --- | ---: | ---: | ---: |
| sample.lua | 16 → 11 | 130 → 46 | 54 bytes |
| sample.p8 | 15 → 10 | 66 → 40 | 51 bytes |
| invalid.lua | Refused | `identifier expected`, file `invalid.lua`, line 1, column 7 | No output |

Successful browser outputs matched the native CLI reference files exactly. The `.p8` fixture's graphics/map/flags content remained intact under the independent Suite parser. A native `cls()` fixture produced zero token improvement and remained valid; a heart P8SCII string was accepted. Neither result implies all cart behavior has been runtime-verified.

Measured cold worker startup: **2,836 ms**. Allocated WASM heap after initialization: **31,457,280 bytes (30 MiB)**. This is one environment/sample, not a performance budget or peak/full process-memory measurement. JS overhead, transient fetch buffers, browser code caches and peak optimization memory are not included.

Additional actual browser checks: zero runtime requests before explicit initialization; zero cross-origin requests (foreign requests were blocked); optimization from cached source after switching networking off; deliberate local runtime 404 gave `E_ENGINE_ASSETS`; restoring availability and creating a fresh worker succeeded. The smoke page remains available for manual reproduction. JS and Python regressions cover protocol failures, asset corruption/path checks, compiler-hint policy and CLI parity.

## Historical MIN-01 PNG / pico8.dat investigation

No `pico8.dat`, Pillow or Lua execution package is needed by the verified `.lua` / `.p8` pipeline. The pinned standard PNG writer uses Pillow plus `template.png` / `font.png` resources; none are packaged here. Its ordinary PNG path does not itself require `pico8.dat`; that is used by other upstream export-runtime workflows. That finding described the upstream image-writer path before MIN-11. The implemented Suite path now uses the pinned ROM serializer plus a standard-library PNG envelope, with no Pillow, template/font files or `pico8.dat`; it was verified through native/browser checks and a user-run PICO-8 fixture comparison. See [the current PNG contract and evidence](MINIFIER_PNG.md). No proprietary runtime data is requested or distributed by this foundation.

Upstream references: [Shrinko8 pinned source](https://github.com/thisismypassport/shrinko8/tree/fb6e66827d481020857d7548fdd9dd0171315a86), [pinned CLI flags/processing](https://github.com/thisismypassport/shrinko8/blob/fb6e66827d481020857d7548fdd9dd0171315a86/run_shrinko.py), [PNG writer](https://github.com/thisismypassport/shrinko8/blob/fb6e66827d481020857d7548fdd9dd0171315a86/pico_cart.py), [Pyodide distribution/deployment](https://pyodide.org/en/stable/usage/downloading-and-deploying.html).


## Project includes — MIN-07

The editor handoff captures a complete, immutable virtual input tree. It reads reachable dependencies from the existing exact-case folder index, queries granted read access only, decodes UTF-8 strictly and rechecks the editor/folder/intake identity after awaits. No folder enumeration, permission request, save or Run is part of the handoff. Missing, denied, ambiguous, cyclic or stale dependencies preserve the prior Minifier source/result. Standalone Open/Paste have no neighboring-file authority; use the Code Editor folder workflow. Disk changes after capture require explicit refresh.

The unchanged pinned Shrinko8 handles actual expansion. The Suite bridge creates an isolated file tree, confines all recursive reads to its allowlist, bounds expansion and compares its preprocessing notifications with directives identified by the real tokenizer. Unknown compiler/preprocessor requests block builds. `--@data` and other `--@` comments emit a build-copy warning; generated code may remove source directives and is never applied to authoring files. Before and After counts use exactly the same resolved job tree; the editor estimate is not used.

| Input form | Verified behavior / boundary |
| --- | --- |
| Nested and repeated includes | Resolve in source order; repeated code expands each time, file text is read once |
| Relative paths, spaces, `./`, `../` within project | Exact paths with explicit `.lua` / `.p8` extensions; no URL decoding or source rewrite |
| Case mismatch, case-colliding files | Refused; Suite lookup is case-insensitive, but the worker filesystem is case-sensitive |
| Root fallback or inferred extension | Refused; Audit can find a fallback that upstream does not use |
| Quoted, backslash, drive/absolute or escaping paths | Refused; upstream does not remove quotes and no file outside the supplied tree is authorized |
| `.p8:0–9` | Supported for ordinary nonempty tab boundaries in carts without includes; actual fixture selects tab 1 |
| Hex `:a–f`, decimal `:10+`, missing tabs | Refused: Suite parses decimal tab suffixes, upstream parses one hexadecimal digit |
| Tab carts with includes, recursive tabs, unusual separators | Refused: upstream preprocesses whole carts before selecting tabs, unlike Suite’s selected-unit traversal |
| `#include` text in comments/strings | Shared lexer ignores it. Upstream’s preprocessor mishandles a level-one long string in a tested case; notifier mismatch blocks that build |
| Cartridge version, P8SCII, LF/CRLF | Raw inputs remain unchanged in the snapshot; actual fixture retains version 42 and heart glyph, with CLI-identical output/counts |

`tests/fixtures/minifier/project` exercises nested/repeated paths, spaces, `../`, CRLF, P8SCII, tab selection and `--@data`. Native tests compare actual CLI output and both counts with the bridge, plus refusal cases. Browser verification uses the real packaged Pyodide worker. These checks do not replace #128’s real PICO-8 release validation.


## Validated build-copy exports — MIN-08

`js/minifier-export-core.js` validates the exact successful job/source snapshot and produces frozen `.min.lua` and, for cart input, `.min.p8` artifacts. Copy contains only Lua. Download is a browser operation, never an in-place save; stale/cancelled/failed/incomplete results and preservation failures cannot export. A source/result change while the format dialog is open stops the download. Clipboard denial/unavailability reports failure; source state remains unchanged.

Shrinko8 normalizes asset sections and may add `__meta:title__` metadata. The exporter checks its decoded ROM/version and optimized Lua, then builds the final cartridge using **only optimized Lua** inside the **exact original header and non-Lua text**. It checks that final envelope and independently decodes ROM/label/version/section presence through `P8Cart`. Empty graphics/sound sections, unknown data sections and metadata survive exactly. Generated Lua uses the original Lua-marker line ending; copied/downloaded Lua retains the result text. The section readers now recognize colon-bearing metadata boundaries, covered by the real comment-only/empty-output case. Empty optimized code is valid; empty source intake remains rejected.

`--@data` and keep/preserve hints warn that output is an **optimized build copy**, not an editable project round trip. Keep original authoring files. Code budgets remain visible; data/format validation is not a runtime-equivalence claim. Native tests run real minification, generate artifacts through the actual JavaScript exporter, and read those files with Shrinko8’s independent Python cartridge reader, comparing complete ROM, label pixels, version and code. LF/CRLF, all data regions, metadata and empty sections/output are covered. Representative-fixture user-run PICO-8 checks completed #128 and #129; see the [acceptance record](MINIFIER_ACCEPTANCE.md) and [PNG verification](MINIFIER_PNG.md) for their exact scope.


## Optional PNG export — MIN-11

`vendor/shrinko8/suite_png.py` wraps the pinned upstream `write_cart_to_rom` serializer/compressor in a Suite-owned standard-library RGBA PNG encoder. `minifier-worker.js` loads this optional local module independently: failure leaves the core engine ready with `capabilities.png=false`. Ordinary Optimize results/schema are unchanged. A revision-bound `png` worker request carries the validated text-cart artifact; `adapter.exportPng(cartText)` verifies identity, versions, bounds and metadata on reply. PNG export errors do not replace the accepted text/Lua result. Source changes, new jobs and disposal are rechecked before download. See [MINIFIER_PNG.md](MINIFIER_PNG.md) for dependencies, measured cost, published/physical capacity limits and the separate installed-console gate.

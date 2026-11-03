# Minifier engine foundation and job adapter — MIN-01 / #119, MIN-02 / #120

Real Shrinko8 runs in a local browser **module Web Worker**. The DOM-free model and adapter below manage application jobs, revisions and cancellation. MIN-03 adds the native Develop → Minifier comparison shell. User source intake, editor handoff and validated output actions remain subsequent roadmap steps.

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

These are decoded local asset sizes, excluding the small bridge/worker/manifest files and HTTP compression. To avoid adding approximately 14 MB of generated runtime binaries to this small repository, this issue uses the explicitly permitted **deterministic local packaging strategy**. Generated `vendor/*/runtime/` folders are ignored by Git. They must be included when distributing/hosting the functional Minifier; a fresh clone without packaging cannot initialize it. It does not silently fall back to a CDN.

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

The fixture compares browser output to checked-in `sample.min.lua` / `sample.min.p8` reference outputs from an independent direct invocation of the pinned CLI. The Python tests repeat that comparison, and a JS regression checks the cart/data sections with the Suite's separate cartridge parser. This is evidence for these fixtures, not a guarantee of equivalence for arbitrary carts. Real PICO-8 runtime validation remains a MIN-10 release gate (#128).

## Exact engine invocation and compiler policy

The fixed CLI argument array is input, output, explicit input/output format, then:

```text
--minify-safe-only --no-minify-rename --no-minify-lines --focus-tokens --no-minify-transform
--input-count --count --parsable-count --error-format common
```

No submitted source is interpolated into Python or a shell command. The bridge calls `shrinko8.main(argv)`; native tests invoke the CLI separately with the identical flags. Only **Minimal + Tokens**, standalone `.lua` / `.p8` and one relative entry file are accepted at this stage. Other profiles/targets/formats and includes return explicit unsupported diagnostics rather than ignored options or partial success.

**Important measured behavior:** `--no-minify-transform` alone does not reject compiler requests. On the pinned engine, `--$switch-compiler:parens8` followed by ordinary Lua succeeds with the transform disabled, ignoring the requested compilation. Therefore the bridge uses Shrinko8's actual tokenizer to find compiler/dynamic-include/alias/sublanguage/placeholder comments and refuses them before optimization. Compiler-looking strings are accepted as strings. The upstream compiler scripts and Parens-8 runtime are not packaged.

The pinned parsable counter identifies output as `count:None:…`, not `count:output:…`. The bridge normalizes its actual counts. Source compressed size is not emitted for these plain-text inputs: it is `null` with a reason. Output compressed code size is reported separately, never confused with PNG/file length.

## Worker contract for MIN-02

Load `js/minifier-worker-host.js` lazily and call `P8MinifierWorkerHost.create()`. It constructs the local **module** worker with no runtime initialization until a message is sent. Pyodide 314.0.7 rejects classic workers; do not remove `{type:'module'}`. The worker is not referenced from `index.html` yet, so other tools do not load Python or WASM.

Requests:

```js
worker.postMessage({ protocol: 1, type: 'init', requestId: 'init-1' });
worker.postMessage({ protocol: 1, type: 'optimize', requestId: 'run-1', job: {
  jobId: 'job-1', sourceRevision: 1, optionsRevision: 0,
  entryPath: 'demo.p8', files: [{ path: 'demo.p8', text: cartText }],
  kind: 'p8', profile: 'minimal', target: 'tokens'
} });
```

Replies preserve `requestId`, `jobId`, `sourceRevision`, `optionsRevision` and `protocol`. `type` is `ready`, `result` or `error`. Ready includes pinned engine versions, capabilities, measured initialization time and allocated WASM heap bytes. Optimization replies contain `result`:

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
| `setOptions({profile?, target?})` | Validates named options; defaults Minimal + Tokens; identical settings are a no-op |
| `initialize()` | Shared pending promise; initializes only, never sends source |
| `optimize()` | Captures an immutable job before any await; initializes lazily if needed; rejects simultaneous runs |
| `cancel()` | Terminates pending initialization/CPU work and rejects it; idle cancellation is a no-op |
| `retry()` | Replaces the worker and initializes it; a new Optimize action is still required |
| `dispose()` | Terminates work and clears observers; terminal, create another adapter to reuse |

Only Minimal + Tokens is mapped, to the five flags documented above. Unsupported names produce `unsupported`, and unknown settings keys are rejected rather than silently passed to the CLI. The current engine refuses multiple-file/include jobs explicitly; the immutable file-map contract is ready for MIN-07, but does not claim to resolve includes now.

One monotonic clock supplies `sourceRevision`, `optionsRevision` and job identities. A source/options change invalidates the active job immediately. During bootstrap, the source-free initialization can finish for the newly loaded input; after source has been posted, the worker is terminated. Replaced workers' saved callbacks and out-of-order request replies cannot make old output current.

`state.status` is one of `empty`, `loading`, `ready`, `running`, `success`, `unchanged`, `stale`, `cancelled`, `error`, `unsupported`. A loaded source may be `ready` while `enginePhase` is still `cold`; **use `describe(state).canOptimize`**, which requires an actual initialized engine. `describe` also supplies `busy`, `stale` and `canExport`. Prior output is retained for review but loses current-result eligibility during a run, after input/settings changes, or on cancellation/error. An equal token count is valid `unchanged` output; increased counts remain valid and `metricDelta` labels them as an increase. Missing measurements stay `null` with an explanation; zero delta formats as `0 (0%)`.

`canExport(state)` is the default **current revision guard**, not an exporter or proof of cart preservation. MIN-08 must still validate supported content, preserve non-Lua sections, and obtain the explicit user export action. `outputFilename(path, kind)` suggests a distinct `.min.lua` / `.min.p8` name; it writes nothing. No core/adapter action saves, downloads, executes Lua or modifies Code Editor.

Validation: 18 focused Node regressions cover immutable snapshots, all state categories, preset flags, stale/cancelled callbacks, malformed replies, crash-after-reply races, timeouts and fresh-worker retry. A real Chromium 153.0.8010.0 adapter check matched both CLI fixtures below, retained the invalid fixture's file/line/column, cancelled after an optimize message was posted, then initialized a second worker and accepted a zero-token-saving `cls()` result (2 → 2 tokens). It used only same-origin GET requests. Real PICO-8 validation remains #128.

## Hosting and offline behavior

MIN-03 workspace verification: **277 Node regressions passed**, including five presenter tests, plus static HTML and changed-JS syntax checks. Actual Chromium 153.0.8010.0 checks covered 1440 / 900 / 375 px in Light / Dark / System (light OS preference), with no page overflow or clipped buttons; forced-colors/reduced-motion presentation and visible keyboard focus were also inspected. A fixture supplied through `Suite.minifier.load` produced the exact CLI reference through the real Optimize button. Home, Find tool, `#minifier`, workspace arrows, view arrows, read-only selection, menus, F1 and missing-runtime Retry worked without browser errors. The initial page did not fetch runtime assets before Minifier entry. This does not substitute for screen-reader speech testing, other browsers or the PICO-8 release gate.

- All runtime, source-bundle and bridge requests use fixed same-origin paths. No `loadPackage`, micropip, CDN execution, source upload or remote processing is used.
- Serve the complete packaged folder over HTTP(S), preferably localhost or HTTPS. `file://` is rejected by the host helper before Worker construction, with the existing localhost setup command. Asset SHA verification requires a secure context (`https://` or loopback HTTP).
- An initialized worker has the runtime/modules in memory and can optimize already supplied source with browser networking disabled; this was verified. Terminating/reloading loses that memory.
- Fresh startup needs the local asset server to be reachable. A locally served installation needs no Internet connection. A fresh remote load while the browser is offline is not guaranteed: no service worker/cache-install workflow is added, and a live worker's offline success is not a promise of fresh-load offline availability.
- Missing assets return `E_ENGINE_ASSETS`, integrity/version mismatches return explicit errors, and a fresh worker can retry. Never enable a future Optimize/Download UI merely because these JS files exist; await a real `ready` response.

## Actual proof results — 2026-11-03

Verified in headless **Chromium 153.0.8010.0 on Linux**, served by a local HTTP fixture server. This is a developer test browser, not a shipped runtime dependency. Other browsers and PICO-8 itself were not tested in this issue.

| Fixture | Tokens before → after | Characters before → after | Output compressed code |
| --- | ---: | ---: | ---: |
| sample.lua | 16 → 11 | 130 → 46 | 54 bytes |
| sample.p8 | 15 → 10 | 66 → 40 | 51 bytes |
| invalid.lua | Refused | `identifier expected`, file `invalid.lua`, line 1, column 7 | No output |

Successful browser outputs matched the native CLI reference files exactly. The `.p8` fixture's graphics/map/flags content remained intact under the independent Suite parser. A native `cls()` fixture produced zero token improvement and remained valid; a heart P8SCII string was accepted. Neither result implies all cart behavior has been runtime-verified.

Measured cold worker startup: **2,836 ms**. Allocated WASM heap after initialization: **31,457,280 bytes (30 MiB)**. This is one environment/sample, not a performance budget or peak/full process-memory measurement. JS overhead, transient fetch buffers, browser code caches and peak optimization memory are not included.

Additional actual browser checks: zero runtime requests before explicit initialization; zero cross-origin requests (foreign requests were blocked); optimization from cached source after switching networking off; deliberate local runtime 404 gave `E_ENGINE_ASSETS`; restoring availability and creating a fresh worker succeeded. The smoke page remains available for manual reproduction. JS and Python regressions cover protocol failures, asset corruption/path checks, compiler-hint policy and CLI parity.

## Optional PNG / pico8.dat findings

No `pico8.dat`, Pillow or Lua execution package is needed by the verified `.lua` / `.p8` pipeline. The pinned standard PNG writer uses Pillow plus `template.png` / `font.png` resources; none are packaged here. Its ordinary PNG path does not itself require `pico8.dat`; that is used by other upstream export-runtime workflows. PNG remains explicitly unsupported until #129 packages and verifies the appropriate dependencies/assets and tests output in real PICO-8. No proprietary runtime data is requested or distributed by this foundation.

Upstream references: [Shrinko8 pinned source](https://github.com/thisismypassport/shrinko8/tree/fb6e66827d481020857d7548fdd9dd0171315a86), [pinned CLI flags/processing](https://github.com/thisismypassport/shrinko8/blob/fb6e66827d481020857d7548fdd9dd0171315a86/run_shrinko.py), [PNG writer](https://github.com/thisismypassport/shrinko8/blob/fb6e66827d481020857d7548fdd9dd0171315a86/pico_cart.py), [Pyodide distribution/deployment](https://pyodide.org/en/stable/usage/downloading-and-deploying.html).

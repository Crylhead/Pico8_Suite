# Minifier engine foundation — MIN-01 / #119

Real Shrinko8 runs in a local browser **module Web Worker**. This foundation has no production workspace, editor handoff or download UI. MIN-02 (#120) adds the application job/revision/cancellation adapter; subsequent roadmap issues build the user-facing workflows.

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

MIN-02 owns immutable application snapshots, stale-result rejection, options validation beyond this capability set, cancellation, retry/dispose and UI state transitions. **Echoed revisions alone are not a stale-result guard.** Cancellation should terminate this worker; retry should create a fresh one and send `init`. Initialization failure clears the internal bootstrap promise; no failure changes the Suite shell or an editor document.

## Hosting and offline behavior

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

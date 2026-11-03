// MIN-01: fixed, same-origin Shrinko8/Pyodide worker. Nothing loads until a message requests it.
'use strict';
(() => {
  const PROTOCOL = 1;
  const local = (path) => new URL(path, self.location.href);
  let initialization = null;
  let queue = Promise.resolve();

  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  async function get(url, binary = false) {
    const response = await fetch(url);
    if (!response.ok) throw failure('E_ENGINE_ASSETS', 'Local Minifier assets are missing or unavailable. Run python tools/package_minifier.py, serve this complete folder over HTTP(S), then Retry with a fresh worker.');
    return binary ? response.arrayBuffer() : response.json();
  }

  async function initialize() {
    const start = performance.now();
    if (!['http:', 'https:'].includes(self.location.protocol)) throw failure('E_LOCAL_HTTP', 'Minifier needs a localhost HTTP server; file:// workers are unsupported.');
    const lock = await get(local('../vendor/minifier-lock.json'));
    const runtimeURL = local('../vendor/pyodide/runtime/');
    // Paths are fixed by this module, never supplied in a message or fetched from a CDN.
    let loadPyodide;
    try { ({ loadPyodide } = await import(new URL('pyodide.mjs', runtimeURL).href)); }
    catch (error) { throw failure('E_ENGINE_ASSETS', `Cannot load the packaged Python runtime (${error.name}: ${error.message}). Run python tools/package_minifier.py and Retry with a fresh worker.`); }
    const python = await loadPyodide({ indexURL: runtimeURL.href, stdout: () => {}, stderr: () => {} });
    if (python.version !== lock.pyodide.version) throw failure('E_ENGINE_VERSION', 'Packaged Pyodide version does not match vendor/minifier-lock.json. Repackage the runtime.');
    const bundle = await get(local('../vendor/shrinko8/runtime/engine.zip'), true);
    if (!self.crypto?.subtle) throw failure('E_SECURE_CONTEXT', 'Minifier needs HTTPS or http://127.0.0.1 for local asset verification.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bundle))].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (digest !== lock.shrinko8.bundleSha256) throw failure('E_ENGINE_INTEGRITY', 'The local Shrinko8 bundle does not match its pin. Repackage it before retrying.');
    python.unpackArchive(bundle, 'zip', { extractDir: '/suite-engine' });
    const bridgeResponse = await fetch(local('../vendor/shrinko8/suite_bridge.py'));
    if (!bridgeResponse.ok) throw failure('E_ENGINE_ASSETS', 'The Suite Minifier bridge is missing. Restore the complete Suite folder.');
    python.FS.writeFile('/suite-engine/suite_bridge.py', await bridgeResponse.text());
    const sys = python.pyimport('sys');
    sys.path.insert(0, '/suite-engine');
    sys.destroy();
    const bridge = python.pyimport('suite_bridge');
    let png = null;
    try {
      const response = await fetch(local('../vendor/shrinko8/suite_png.py'));
      if (response.ok) {
        python.FS.writeFile('/suite-engine/suite_png.py', await response.text());
        png = python.pyimport('suite_png');
      }
    } catch (_) { /* Optional PNG must not prevent text/Lua processing. */ }
    const info = JSON.parse(bridge.engine_info());
    if (info.version !== lock.shrinko8.version || info.pythonVersion !== lock.pyodide.pythonVersion) throw failure('E_ENGINE_VERSION', 'Packaged Python/Shrinko8 versions do not match their pins.');
    return { python, bridge, png, metadata: {
      shrinko8Version: info.version, shrinko8Commit: lock.shrinko8.commit,
      pyodideVersion: python.version, pythonVersion: info.pythonVersion,
      startupMs: Math.round(performance.now() - start), wasmHeapBytes: python._module.HEAP8.byteLength,
      capabilities: { p8: true, lua: true, png: !!png, includes: true, profiles: ['minimal'], targets: ['tokens'] },
    } };
  }

  function engine() {
    if (!initialization) initialization = initialize().catch((error) => { initialization = null; throw error; });
    return initialization;
  }

  async function handle(message) {
    const envelope = { protocol: PROTOCOL, requestId: message?.requestId,
      jobId: message?.job?.jobId, sourceRevision: message?.job?.sourceRevision, optionsRevision: message?.job?.optionsRevision };
    try {
      if (message?.protocol !== PROTOCOL || !['init', 'optimize', 'png'].includes(message?.type)) throw failure('E_PROTOCOL', 'Unsupported Minifier worker request. Use protocol 1 and init/optimize/png.');
      if (message.type !== 'init' && (!message.job || typeof message.job !== 'object')) throw failure('E_INPUT_INVALID', 'Processing/export requests need a plain job snapshot.');
      const ready = await engine();
      if (message.type === 'init') {
        self.postMessage({ ...envelope, type: 'ready', engine: ready.metadata });
      } else if (message.type === 'png') {
        if (!ready.png) throw failure('E_PNG_UNAVAILABLE', 'Optional PNG encoder is unavailable. Restore vendor/shrinko8/suite_png.py and Retry; text exports remain available.');
        const result = JSON.parse(ready.png.export_png(message.job.cartText));
        self.postMessage({ ...envelope, type: result.ok ? 'png' : 'error', engine: ready.metadata, result });
      } else {
        const result = JSON.parse(ready.bridge.optimize(JSON.stringify(message.job)));
        self.postMessage({ ...envelope, type: result.ok ? 'result' : 'error', engine: ready.metadata, result });
      }
    } catch (error) {
      self.postMessage({ ...envelope, type: 'error', result: { ok: false, diagnostics: [{ severity: 'error', code: error.code || 'E_ENGINE_LOAD', message: error.code ? error.message : 'Minifier initialization failed. Check locally packaged assets and Retry with a fresh worker.' }] } });
    }
  }

  self.addEventListener('message', (event) => { queue = queue.then(() => handle(event.data)); });
})();

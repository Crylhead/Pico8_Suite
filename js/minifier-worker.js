// MIN-01: fixed Shrinko8/Pyodide worker. Nothing loads until a message requests it.
// Two ways in, same checks (#162):
// - HTTP(S): a module worker that fetches the packaged runtime from this Suite folder.
// - file:// (index.html opened directly): browsers refuse module workers and file fetches there, so
//   js/minifier-worker-host.js starts this same function from a blob URL and posts one bootstrap
//   message with the files it loaded through classic scripts (vendor/pyodide/runtime/file-assets.js,
//   written by tools/package_minifier.py, and vendor/shrinko8/suite-sources.js). The worker answers
//   Pyodide's own requests from that memory only; nothing is fetched from disk or the network.
'use strict';
function P8MinifierWorkerMain(self) {
  const PROTOCOL = 1;
  const local = (path) => new URL(path, self.location.href);
  const fileMode = self.location.protocol === 'blob:';
  let initialization = null;
  let queue = Promise.resolve();
  let receiveBootstrap;
  const bootstrap = new Promise((resolve) => { receiveBootstrap = resolve; });

  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  async function get(url, binary = false) {
    const response = await fetch(url);
    if (!response.ok) throw failure('E_ENGINE_ASSETS', 'Local Minifier assets are missing or unavailable. Run python tools/package_minifier.py, serve this complete folder over HTTP(S), then Retry with a fresh worker.');
    return binary ? response.arrayBuffer() : response.json();
  }
  const bytes = (base64) => { const s = atob(base64), out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; };
  const moduleURL = (text) => URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));

  /** Everything initialize() needs, from the Suite folder (HTTP) or from the bootstrap message (file://). */
  async function sources() {
    if (!fileMode) {
      if (!['http:', 'https:'].includes(self.location.protocol)) throw failure('E_LOCAL_HTTP', 'Minifier needs index.html opened directly or a localhost HTTP server.');
      const lock = await get(local('../vendor/minifier-lock.json'));
      const runtimeURL = local('../vendor/pyodide/runtime/');
      const text = async (path, optional = false) => {
        const response = await fetch(local(path));
        if (response.ok) return response.text();
        if (optional) return null;
        throw failure('E_ENGINE_ASSETS', 'The Suite Minifier bridge is missing. Restore the complete Suite folder.');
      };
      return {
        pins: { pyodideVersion: lock.pyodide.version, pythonVersion: lock.pyodide.pythonVersion, shrinko8Version: lock.shrinko8.version, shrinko8Commit: lock.shrinko8.commit, bundleSha256: lock.shrinko8.bundleSha256 },
        loadPyodide: async () => (await import(new URL('pyodide.mjs', runtimeURL).href)).loadPyodide,
        options: { indexURL: runtimeURL.href },
        bundle: () => get(local('../vendor/shrinko8/runtime/engine.zip'), true),
        bridge: () => text('../vendor/shrinko8/suite_bridge.py'),
        png: () => text('../vendor/shrinko8/suite_png.py', true).catch(() => null),
      };
    }
    const boot = await bootstrap;
    if (boot.error) throw failure(boot.error.code, boot.error.message);
    const { files } = boot.assets, suite = boot.sources;
    const memory = { 'pyodide.asm.wasm': ['application/wasm', files['pyodide.asm.wasm']], 'python_stdlib.zip': ['application/zip', files['python_stdlib.zip']] };
    const BASE = 'https://pico8-suite.invalid/runtime/'; // never contacted: every request below it is answered from memory
    const realFetch = self.fetch.bind(self);
    self.fetch = async (input, init) => {
      const href = String(typeof Request !== 'undefined' && input instanceof Request ? input.url : input);
      if (!href.startsWith(BASE)) return realFetch(input, init);
      const hit = memory[href.slice(BASE.length)];
      if (!hit) throw failure('E_ENGINE_ASSETS', `The file:// engine bundle has no ${href.slice(BASE.length)}. Run python tools/package_minifier.py again.`);
      return new Response(bytes(hit[1]), { headers: { 'content-type': hit[0] } });
    };
    // Pyodide refuses classic workers by probing importScripts; its module-worker path only needs
    // import(), which works here from blob URLs.
    self.importScripts = () => { throw new TypeError('importScripts is unavailable in the Minifier worker'); };
    return {
      pins: suite.pins,
      loadPyodide: async () => (await import(moduleURL(files['pyodide.mjs']))).loadPyodide,
      options: { indexURL: BASE, lockFileContents: files['pyodide-lock.json'], stdLibURL: BASE + 'python_stdlib.zip',
        createPyodideModule: (await import(moduleURL(files['pyodide.asm.mjs']))).default },
      bundle: async () => bytes(files['engine.zip']).buffer,
      bridge: async () => suite.python['suite_bridge.py'],
      png: async () => suite.python['suite_png.py'] || null,
    };
  }

  async function initialize() {
    const start = performance.now();
    const src = await sources();
    // Paths are fixed by this module, never supplied in a job message or fetched from a CDN.
    let loadPyodide;
    try { loadPyodide = await src.loadPyodide(); }
    catch (error) { throw failure('E_ENGINE_ASSETS', `Cannot load the packaged Python runtime (${error.name}: ${error.message}). Run python tools/package_minifier.py and Retry with a fresh worker.`); }
    const python = await loadPyodide({ ...src.options, stdout: () => {}, stderr: () => {} });
    if (python.version !== src.pins.pyodideVersion) throw failure('E_ENGINE_VERSION', 'Packaged Pyodide version does not match vendor/minifier-lock.json. Repackage the runtime.');
    const bundle = await src.bundle();
    if (!self.crypto?.subtle) throw failure('E_SECURE_CONTEXT', 'Minifier needs index.html opened directly, HTTPS or http://127.0.0.1 for local asset verification.');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bundle))].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (digest !== src.pins.bundleSha256) throw failure('E_ENGINE_INTEGRITY', 'The local Shrinko8 bundle does not match its pin. Repackage it before retrying.');
    python.unpackArchive(bundle, 'zip', { extractDir: '/suite-engine' });
    python.FS.writeFile('/suite-engine/suite_bridge.py', await src.bridge());
    const sys = python.pyimport('sys');
    sys.path.insert(0, '/suite-engine');
    sys.destroy();
    const bridge = python.pyimport('suite_bridge');
    let png = null;
    try {
      const text = await src.png();
      if (text) {
        python.FS.writeFile('/suite-engine/suite_png.py', text);
        png = python.pyimport('suite_png');
      }
    } catch (_) { /* Optional PNG must not prevent text/Lua processing. */ }
    const info = JSON.parse(bridge.engine_info());
    if (info.version !== src.pins.shrinko8Version || info.pythonVersion !== src.pins.pythonVersion) throw failure('E_ENGINE_VERSION', 'Packaged Python/Shrinko8 versions do not match their pins.');
    return { python, bridge, png, metadata: {
      shrinko8Version: info.version, shrinko8Commit: src.pins.shrinko8Commit,
      pyodideVersion: python.version, pythonVersion: info.pythonVersion,
      startupMs: Math.round(performance.now() - start), wasmHeapBytes: python._module.HEAP8.byteLength,
      capabilities: { p8: true, lua: true, png: !!png, includes: true, profiles: ['minimal', 'safe', 'aggressive'], targets: ['balanced', 'tokens', 'chars', 'compressed', 'tokens-chars', 'tokens-compressed'] },
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

  self.addEventListener('message', (event) => {
    // The host's one-time file:// bootstrap is not a job; it may arrive before or after 'init'.
    if (fileMode && event.data?.type === 'p8-bootstrap') { receiveBootstrap(event.data); return; }
    queue = queue.then(() => handle(event.data));
  });
}
// In a worker this runs; on the page (file:// host) it only provides the function's source.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) P8MinifierWorkerMain(self);

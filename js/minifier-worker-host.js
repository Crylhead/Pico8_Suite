// MIN-01 worker construction only; the job/revision/cancellation adapter belongs to MIN-02.
// #162: index.html opened directly (file://) gets the same worker started from a blob URL plus one
// bootstrap message carrying the packaged runtime, which is loaded through classic scripts because
// browsers block module workers, import() and fetch of local files on file:// pages.
'use strict';
const P8MinifierWorkerHost = (() => {
  const script = typeof document !== 'undefined' ? document.currentScript?.src : null;
  const SETUP = 'Minifier engine files are not prepared yet. Run python tools/package_minifier.py once in the Suite folder (Python 3.9+; the first run downloads the pinned engine or uses the pinned archives), then choose Retry engine or reload this page. No server is needed afterwards.';
  let assetsLoad = null;

  /** Loads vendor/pyodide/runtime/file-assets.js once; resolves its data or null when it is missing. */
  function loadFileAssets(doc = globalThis.document, scope = globalThis) {
    if (scope.P8MinifierFileAssets) return Promise.resolve(scope.P8MinifierFileAssets);
    if (!assetsLoad) {
      assetsLoad = new Promise((resolve) => {
        const tag = doc.createElement('script');
        tag.src = new URL('../vendor/pyodide/runtime/file-assets.js', script || new URL('js/minifier-worker-host.js', scope.location.href)).href;
        tag.onload = () => resolve(scope.P8MinifierFileAssets || null);
        tag.onerror = () => resolve(null);
        doc.head.append(tag);
      }).then((assets) => { if (!assets) assetsLoad = null; return assets; }); // a later Retry may find it after setup
    }
    return assetsLoad;
  }

  function bootstrapMessage(assets, sources) {
    if (!sources || !sources.pins || !sources.python) return { type: 'p8-bootstrap', error: { code: 'E_ENGINE_ASSETS', message: 'vendor/shrinko8/suite-sources.js is missing. Restore the complete Suite folder.' } };
    if (!assets || assets.format !== 1 || !assets.files) return { type: 'p8-bootstrap', error: { code: 'E_FILE_SETUP', message: SETUP } };
    if (assets.pyodideVersion !== sources.pins.pyodideVersion || assets.bundleSha256 !== sources.pins.bundleSha256) {
      return { type: 'p8-bootstrap', error: { code: 'E_FILE_SETUP', message: 'The prepared engine files belong to a different engine version. Run python tools/package_minifier.py again, then reload this page.' } };
    }
    return { type: 'p8-bootstrap', assets, sources };
  }

  function createFileWorker({ WorkerCtor, scope = globalThis, doc = globalThis.document }) {
    const main = scope.P8MinifierWorkerMain;
    if (typeof main !== 'function' || typeof scope.Blob !== 'function' || !scope.URL?.createObjectURL) {
      const error = new Error('This browser cannot start the Minifier from a directly opened file. Use Chrome or Edge, or the optional local launcher.');
      error.code = 'E_WORKER_UNAVAILABLE';
      throw error;
    }
    const url = scope.URL.createObjectURL(new scope.Blob([`'use strict';\n(${main.toString()})(self);\n`], { type: 'text/javascript' }));
    const worker = new WorkerCtor(url, { name: 'Pico8 Suite Minifier' });
    loadFileAssets(doc, scope).then((assets) => worker.postMessage(bootstrapMessage(assets, scope.P8MinifierSuiteSources)));
    return worker;
  }

  function create({ protocol = globalThis.location?.protocol, WorkerCtor = globalThis.Worker, url, scope, doc } = {}) {
    if (!['file:', 'http:', 'https:'].includes(protocol)) {
      const error = new Error('Minifier runs when index.html is opened directly or from a localhost HTTP server; this address type is unsupported.');
      error.code = 'E_LOCAL_HTTP';
      throw error;
    }
    if (typeof WorkerCtor !== 'function') {
      const error = new Error('This browser does not support Web Workers. Other Suite tools remain available.');
      error.code = 'E_WORKER_UNAVAILABLE';
      throw error;
    }
    if (protocol === 'file:') return createFileWorker({ WorkerCtor, scope, doc });
    return new WorkerCtor(url || new URL('minifier-worker.js', script || new URL('js/minifier-worker-host.js', globalThis.location.href)), { type: 'module', name: 'Pico8 Suite Minifier' });
  }
  return { create, bootstrapMessage, SETUP };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierWorkerHost;

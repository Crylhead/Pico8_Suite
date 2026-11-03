// MIN-01 worker construction only; the job/revision/cancellation adapter belongs to MIN-02.
'use strict';
const P8MinifierWorkerHost = (() => {
  const script = typeof document !== 'undefined' ? document.currentScript?.src : null;
  function create({ protocol = globalThis.location?.protocol, WorkerCtor = globalThis.Worker, url } = {}) {
    if (!['http:', 'https:'].includes(protocol)) {
      const error = new Error('Minifier needs HTTP(S). Serve the Suite with python -m http.server 8000 --bind 127.0.0.1 and open http://127.0.0.1:8000; file:// workers are unsupported.');
      error.code = 'E_LOCAL_HTTP';
      throw error;
    }
    if (typeof WorkerCtor !== 'function') {
      const error = new Error('This browser does not support Web Workers. Other Suite tools remain available.');
      error.code = 'E_WORKER_UNAVAILABLE';
      throw error;
    }
    return new WorkerCtor(url || new URL('minifier-worker.js', script || new URL('js/minifier-worker-host.js', globalThis.location.href)), { type: 'module', name: 'Pico8 Suite Minifier' });
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierWorkerHost;

// Reproducible real browser worker fixture; no mock optimization and no user code execution.
'use strict';
const P8MinifierSmoke = (() => {
  let worker = null, next = 0, pending = new Map(), cached = null;
  function dispose() {
    worker?.terminate(); worker = null;
    for (const ticket of pending.values()) { clearTimeout(ticket.timeout); ticket.reject(new Error('Test worker terminated')); }
    pending.clear();
  }
  function request(type, job) {
    const requestId = ++next;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('Worker fixture timed out')); }, 60000);
      pending.set(requestId, { resolve, reject, timeout });
      worker.postMessage({ protocol: 1, requestId, type, job });
    });
  }
  function job(path, text) {
    return { jobId: path, sourceRevision: 1, optionsRevision: 0, entryPath: path, kind: path.endsWith('.p8') ? 'p8' : 'lua', profile: 'minimal', target: 'tokens', files: [{ path, text }] };
  }
  async function run() {
    dispose();
    worker = P8MinifierWorkerHost.create();
    worker.onmessage = ({ data }) => {
      const ticket = pending.get(data.requestId);
      if (ticket) { clearTimeout(ticket.timeout); pending.delete(data.requestId); ticket.resolve(data); }
    };
    worker.onerror = () => { for (const ticket of pending.values()) { clearTimeout(ticket.timeout); ticket.reject(new Error('Worker failed to load; check local HTTP hosting and packaged assets.')); } pending.clear(); };
    const ready = await request('init');
    if (ready.type !== 'ready') throw new Error(JSON.stringify(ready));
    const inputs = await Promise.all(['sample.lua', 'sample.p8', 'invalid.lua'].map(async (name) => {
      const response = await fetch(`fixtures/minifier/${name}`);
      if (!response.ok) throw new Error('Missing fixture ' + name);
      return [name, await response.text()];
    }));
    const results = [];
    for (const [path, text] of inputs) results.push(await request('optimize', job(path, text)));
    for (const item of results.slice(0, 2)) {
      if (item.type !== 'result' || !item.result.ok || !item.result.lua || !Number.isInteger(item.result.metrics.optimized.tokens)) throw new Error('Real fixture failed: ' + JSON.stringify(item));
      const name = item.jobId.replace(/\.(p8|lua)$/, '.min.$1');
      const reference = await fetch(`fixtures/minifier/${name}`);
      if (!reference.ok || (item.result.cartText || item.result.lua) !== await reference.text()) throw new Error('Browser output differs from pinned CLI reference: ' + name);
    }
    if (results[2].type !== 'error' || !results[2].result.diagnostics.some((d) => d.line === 1 && d.column > 0)) throw new Error('Invalid source was not diagnosed');
    const transform = await request('optimize', job('compiler.lua', '--$switch-compiler:parens8\nprint(1)'));
    if (transform.result.diagnostics[0].code !== 'E_TRANSFORM_UNSUPPORTED') throw new Error('Compiler hint was not refused');
    cached = job(inputs[0][0], inputs[0][1]);
    return { passed: true, engine: ready.engine, results, transform };
  }
  async function offline() {
    if (!worker || !cached) throw new Error('Run the fixtures first, then switch the browser offline.');
    const result = await request('optimize', cached);
    if (result.type !== 'result') throw new Error(JSON.stringify(result));
    return { passed: true, result };
  }
  return { run, offline, dispose };
})();
document.querySelector('#run').onclick = async () => {
  const result = document.querySelector('#result');
  result.textContent = 'Loading local runtime and running real fixtures…';
  try { result.textContent = JSON.stringify(await P8MinifierSmoke.run(), null, 2); document.querySelector('#offline').disabled = false; }
  catch (error) { result.textContent = error.message; }
};
document.querySelector('#offline').onclick = async () => {
  try { document.querySelector('#result').textContent = JSON.stringify(await P8MinifierSmoke.offline(), null, 2); }
  catch (error) { document.querySelector('#result').textContent = error.message; }
};
document.querySelector('#dispose').onclick = () => { P8MinifierSmoke.dispose(); document.querySelector('#offline').disabled = true; document.querySelector('#result').textContent = 'Test worker terminated.'; };

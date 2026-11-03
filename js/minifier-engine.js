// MIN-02: lazy worker adapter. Input changes invalidate jobs; only optimize() submits source.
'use strict';
const P8MinifierEngine = (() => {
  const Core = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  const defaultWorker = () => {
    const host = typeof P8MinifierWorkerHost !== 'undefined' ? P8MinifierWorkerHost : require('./minifier-worker-host.js');
    return host.create();
  };

  function create({ workerFactory = defaultWorker, timeoutMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Core.error('E_CONFIG', 'Worker timeout must be positive.');
    let state = Core.initialState(), worker = null, detach = null;
    let initialization = null, operation = null, disposed = false, requestSerial = 0;
    const listeners = new Set(), pending = new Map();
    const alive = () => { if (disposed) throw Core.error('E_DISPOSED', 'This Minifier adapter has been disposed.'); };
    const publish = (next) => {
      state = next;
      for (const listener of [...listeners]) {
        // Observers must not interrupt cancellation, transport cleanup or result validation.
        try { listener(state); } catch (_) { /* An observer owns its rendering errors. */ }
      }
      return state;
    };
    const diagnostics = (e) => Core.normalizeDiagnostics(e.diagnostics?.length ? e.diagnostics : [{ severity: 'error', code: e.code || 'E_WORKER', message: e.code ? e.message : 'The local Minifier worker failed. Retry to create a fresh worker.' }]);
    const settle = (id, err, value) => {
      const ticket = pending.get(id);
      if (!ticket) return;
      pending.delete(id); clearTimer(ticket.timer);
      if (err) ticket.reject(err); else ticket.resolve(value);
    };
    function dropWorker(err, owner = worker) {
      if (!owner || owner !== worker) return;
      worker = null;
      if (detach) detach();
      detach = null;
      try { owner.terminate(); } catch (_) { /* Reject requests even if termination fails. */ }
      for (const [id, ticket] of pending) if (ticket.owner === owner) settle(id, err);
    }
    function fatal(err, owner) {
      if (owner !== worker || disposed) return;
      err.workerFatal = true;
      const op = operation;
      operation = null;
      dropWorker(err, owner);
      if (op) op.reject(err);
      // Invalidate synchronously, including a reply already settled but not yet consumed.
      publish(Core.transition(state, { type: 'failure', diagnostics: diagnostics(err), engineReset: true }));
    }
    function receive(owner, message) {
      if (owner !== worker || disposed) return;
      const ticket = pending.get(message?.requestId);
      if (!ticket || ticket.owner !== owner) return;
      try {
        if (message.protocol !== 1 || (message.type !== 'error' && message.type !== ({ init: 'ready', optimize: 'result', png: 'png' })[ticket.type])) throw Core.error('E_PROTOCOL', 'Unexpected Minifier worker reply.');
        if (ticket.job && !Core.sameJob(ticket.job, message)) throw Core.error('E_RESULT_IDENTITY', 'Worker reply does not match the submitted source/options job.');
        if (ticket.job && Core.engineKey(Core.engineSnapshot(message.engine)) !== Core.engineKey(state.engine)) throw Core.error('E_ENGINE_VERSION', 'Worker reply changed engine versions during a job.');
        if (message.type === 'error') {
          const ds = Core.normalizeDiagnostics(message.result?.diagnostics);
          const first = ds[0];
          settle(message.requestId, Core.error(first?.code || 'E_ENGINE', first?.message || 'The Minifier worker refused this request.', ds.length ? ds : undefined));
        } else settle(message.requestId, null, ticket.type === 'init' ? Core.engineSnapshot(message.engine) : message.result);
      } catch (err) { fatal(err, owner); }
    }
    function ensureWorker() {
      if (worker) return worker;
      const owner = workerFactory();
      worker = owner;
      const message = (event) => receive(owner, event.data);
      const crash = () => fatal(Core.error('E_WORKER', 'The local Minifier worker stopped unexpectedly. Retry to create a fresh worker.'), owner);
      const unreadable = () => fatal(Core.error('E_PROTOCOL', 'The Minifier worker sent an unreadable reply.'), owner);
      // Save cleanup before attaching, so initialization failures remain recoverable.
      detach = () => {
        owner.removeEventListener('message', message);
        owner.removeEventListener('error', crash);
        owner.removeEventListener('messageerror', unreadable);
      };
      owner.addEventListener('message', message);
      owner.addEventListener('error', crash);
      owner.addEventListener('messageerror', unreadable);
      return owner;
    }
    function send(type, job) {
      const owner = ensureWorker();
      const requestId = ++requestSerial;
      return new Promise((resolve, reject) => {
        const ticket = { owner, type, job, resolve, reject, timer: null };
        pending.set(requestId, ticket);
        ticket.timer = setTimer(() => fatal(Core.error('E_TIMEOUT', 'The Minifier worker timed out. Retry to create a fresh worker.'), owner), timeoutMs);
        try { owner.postMessage({ protocol: 1, type, requestId, ...(job ? { job } : {}) }); }
        catch (_) { fatal(Core.error('E_WORKER_SEND', 'Cannot send the job to the local Minifier worker. Retry with a fresh worker.'), owner); }
      });
    }
    function initialize() {
      alive();
      if (initialization) return initialization;
      if (worker && state.enginePhase === 'ready') return Promise.resolve(state.engine);
      const promise = Promise.resolve().then(() => {
        if (initialization !== promise || disposed) throw Core.error('E_CANCELLED', 'Initialization was cancelled.');
        return send('init');
      }).then((engine) => {
        if (initialization !== promise || disposed) throw Core.error('E_CANCELLED', 'Initialization was cancelled.');
        if (!worker) throw Core.error('E_WORKER', 'The Minifier worker stopped during initialization.');
        if (initialization === promise && !disposed) publish(Core.transition(state, { type: 'ready', engine }));
        return engine;
      }).catch((err) => {
        if (initialization === promise && !disposed) {
          dropWorker(err);
          publish(Core.transition(state, { type: 'failure', diagnostics: diagnostics(err), engineReset: true }));
        }
        throw err;
      }).finally(() => { if (initialization === promise) initialization = null; });
      initialization = promise;
      publish(Core.transition(state, { type: 'loading' }));
      return promise;
    }
    function capabilityCheck(job) {
      const c = state.engine.capabilities;
      if (!c[job.kind]) throw Core.error('E_FORMAT_UNSUPPORTED', 'This engine cannot optimize the selected file format.');
      if (!c.profiles.includes(job.profile) || !c.targets.includes(job.target)) throw Core.error('E_OPTIONS_UNSUPPORTED', 'This engine does not support the selected profile/target.');
      if (!c.includes && job.files.length !== 1) throw Core.error('E_INCLUDE_UNSUPPORTED', 'This engine supports one standalone source file; include resolution is not available yet.');
    }
    function optimize() {
      alive();
      if (operation) return Promise.reject(Core.error('E_BUSY', 'An optimization is already active.'));
      let next;
      try { next = Core.transition(state, { type: 'start' }); }
      catch (err) { return Promise.reject(err); }
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const op = { job: next.activeJob, sent: false, resolve, reject };
      operation = op;
      publish(next);
      // Capture the immutable job before initialization awaits; never read live source here.
      (async () => {
        try {
          if (operation !== op) return;
          await initialize();
          if (operation !== op) return;
          capabilityCheck(op.job);
          op.sent = true;
          const result = await send('optimize', op.job);
          if (operation !== op) return;
          let completed;
          try { completed = Core.transition(state, { type: 'complete', job: op.job, result }); }
          catch (err) { err.workerFatal = true; dropWorker(err); throw err; }
          publish(completed);
          if (operation === op) { operation = null; op.resolve(completed.result); }
        } catch (err) {
          if (operation !== op) return;
          operation = null;
          publish(Core.transition(state, { type: 'failure', job: op.job, diagnostics: diagnostics(err), engineReset: !!err.workerFatal || !worker }));
          op.reject(err);
        }
      })();
      return promise;
    }
    async function exportPng(cartText) {
      alive();
      const result = state.result;
      if (!Core.canExport(state) || !state.engine.capabilities.png || result.job.kind !== 'p8') throw Core.error('E_PNG_UNAVAILABLE', 'PNG needs a current cartridge result and the optional local encoder. Lua/.p8 exports remain available.');
      if (typeof cartText !== 'string') throw Core.error('E_PNG_INPUT', 'PNG needs a validated complete text cartridge.');
      const raw = await send('png', { ...result.job, cartText });
      if (disposed || !Core.canExport(state) || state.result !== result) throw Core.error('E_EXPORT_STALE', 'Source or result changed during PNG generation. Nothing was downloaded.');
      if (raw?.ok !== true || typeof raw.base64 !== 'string' || raw.base64.length > 2_000_000 || !/^iVBORw0KGgo[A-Za-z0-9+/=]*$/.test(raw.base64) || !Number.isSafeInteger(raw.pngBytes) || raw.pngBytes < 45 || raw.width !== 160 || raw.height !== 205 || !Number.isSafeInteger(raw.compressedBytes) || raw.compressedBytes < 0 || raw.compressedBudgetExclusive !== 15360 || raw.compressedBytes >= raw.compressedBudgetExclusive || raw.codeRegionBytes !== 15616) throw Core.error('E_PNG_INVALID', 'The PNG encoder returned an invalid or over-capacity image. Nothing was downloaded.');
      let bytes;
      try { bytes = Uint8Array.from(atob(raw.base64), (c) => c.charCodeAt(0)); }
      catch (_) { throw Core.error('E_PNG_INVALID', 'PNG binary data is invalid. Nothing was downloaded.'); }
      const header = new DataView(bytes.buffer);
      if (bytes.length !== raw.pngBytes || bytes.length < 33 || header.getUint32(0) !== 0x89504e47 || header.getUint32(4) !== 0x0d0a1a0a || header.getUint32(8) !== 13 || header.getUint32(12) !== 0x49484452 || header.getUint32(16) !== 160 || header.getUint32(20) !== 205 || bytes[24] !== 8 || bytes[25] !== 6) throw Core.error('E_PNG_INVALID', 'PNG header or byte length disagrees with the encoder. Nothing was downloaded.');
      return Object.freeze({ ...raw });
    }
    function change(event) {
      alive();
      const next = Core.transition(state, { ...event, engineReset: !!operation?.sent });
      if (next === state) return state;
      const op = operation;
      operation = null;
      if (op) {
        const err = Core.error('E_STALE', 'Source or options changed before this optimization finished.');
        if (op.sent) { initialization = null; dropWorker(err); }
        op.reject(err);
      }
      return publish(next);
    }
    function invalidate(type, err) {
      initialization = null;
      const op = operation; operation = null;
      dropWorker(err);
      if (op) op.reject(err);
      publish(Core.transition(state, { type }));
    }
    function cancel() {
      alive();
      if (!initialization && !operation && ![...pending.values()].some((ticket) => ticket.type === 'png')) return false;
      invalidate('cancel', Core.error('E_CANCELLED', 'Minifier work was cancelled.'));
      return true;
    }
    function retry() {
      alive();
      invalidate('reset', Core.error('E_CANCELLED', 'Minifier work was replaced by Retry.'));
      return initialize(); // A retry initializes only; source is submitted by explicit optimize().
    }
    function dispose() {
      if (disposed) return;
      // Mark terminal before notifications so subscribers cannot start replacement work.
      disposed = true;
      invalidate('cancel', Core.error('E_DISPOSED', 'This Minifier adapter has been disposed.'));
      listeners.clear();
    }
    return Object.freeze({ getState: () => state,
      subscribe(listener) { alive(); if (typeof listener !== 'function') throw TypeError('Expected a state listener.'); listeners.add(listener); return () => listeners.delete(listener); },
      setSource: (source) => change({ type: 'source', source }),
      setOptions: (options) => change({ type: 'options', options }),
      initialize, optimize, exportPng, cancel, retry, dispose });
  }
  return { create };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierEngine;

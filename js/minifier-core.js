// MIN-02: immutable, DOM-free Minifier model. No worker, filesystem or export side effects.
'use strict';
const P8MinifierCore = (() => {
  const DEFAULTS = Object.freeze({ profile: 'minimal', target: 'tokens' });
  const FLAGS = Object.freeze(['--minify-safe-only', '--no-minify-rename', '--no-minify-lines', '--focus-tokens', '--no-minify-transform']);
  const STATES = Object.freeze(['empty', 'loading', 'ready', 'running', 'success', 'unchanged', 'stale', 'cancelled', 'error', 'unsupported']);
  const engineFields = ['shrinko8Version', 'shrinko8Commit', 'pyodideVersion', 'pythonVersion'];
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze); Object.freeze(value);
    }
    return value;
  };
  const error = (code, message, diagnostics) => Object.assign(new Error(message), { code, diagnostics: diagnostics || [{ severity: 'error', code, message }] });
  const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const count = (v) => Number.isSafeInteger(v) && v >= 0;

  function settings(raw = {}) {
    if (!record(raw) || Object.keys(raw).some((k) => !['profile', 'target'].includes(k))) throw error('E_OPTIONS_UNSUPPORTED', 'Only profile and target settings are supported.');
    const value = { ...DEFAULTS, ...raw };
    if (typeof value.profile !== 'string' || typeof value.target !== 'string') throw error('E_OPTIONS_UNSUPPORTED', 'Profile and target must be named settings.');
    return freeze(value);
  }
  function validateSettings(raw = {}) {
    try {
      const value = settings(raw);
      if (value.profile !== 'minimal' || value.target !== 'tokens') throw error('E_OPTIONS_UNSUPPORTED', 'This pinned worker supports Minimal + Tokens only.');
      return { ok: true, value, diagnostics: [] };
    } catch (e) { return { ok: false, diagnostics: e.diagnostics }; }
  }
  function flagsFor(raw) {
    const v = validateSettings(raw);
    if (!v.ok) throw error('E_OPTIONS_UNSUPPORTED', v.diagnostics[0].message);
    return FLAGS;
  }

  function sourceSnapshot(raw) {
    if (raw === null) return null;
    const pathOK = (p) => typeof p === 'string' && p && !/[\\:\0]/.test(p) && p.split('/').every((x) => x && x !== '.' && x !== '..');
    if (!record(raw) || !['lua', 'p8'].includes(raw.kind)) throw error('E_FORMAT_UNSUPPORTED', 'Use a plain .lua or .p8 source snapshot.');
    if (!pathOK(raw.entryPath) || !raw.entryPath.toLowerCase().endsWith('.' + raw.kind) || !Array.isArray(raw.files) || !raw.files.length) throw error('E_INPUT_INVALID', 'Source needs a relative entry path and a file-text map.');
    const seen = new Set();
    const files = raw.files.map((f) => {
      if (!record(f) || !pathOK(f.path) || typeof f.text !== 'string' || seen.has(f.path)) throw error('E_INPUT_INVALID', 'Source files need unique relative paths and plain text.');
      seen.add(f.path);
      return { path: f.path, text: f.text };
    });
    if (!seen.has(raw.entryPath)) throw error('E_INPUT_INVALID', 'The entry file is missing from the source snapshot.');
    return freeze({ entryPath: raw.entryPath, files, kind: raw.kind });
  }
  const hasSource = (s) => !!s.source?.files.find((f) => f.path === s.source.entryPath)?.text.trim();

  function normalizeDiagnostics(raw) {
    if (!Array.isArray(raw)) return freeze([]);
    return freeze(raw.map((d) => {
      d = record(d) ? d : {};
      const v = { severity: ['error', 'warning', 'info'].includes(d.severity) ? d.severity : 'error', code: typeof d.code === 'string' ? d.code : 'E_ENGINE', message: typeof d.message === 'string' ? d.message : 'The engine returned an unspecified diagnostic.' };
      if (typeof d.file === 'string' && d.file) v.file = d.file;
      if (count(d.line) && d.line > 0) v.line = d.line;
      if (count(d.column) && d.column > 0) v.column = d.column;
      return v;
    }));
  }
  function engineSnapshot(raw) {
    if (!record(raw) || engineFields.some((k) => typeof raw[k] !== 'string' || !raw[k]) || !record(raw.capabilities)) throw error('E_PROTOCOL', 'Worker engine/version metadata is incomplete.');
    const c = raw.capabilities;
    if (!Array.isArray(c.profiles) || !Array.isArray(c.targets) || !c.profiles.every((x) => typeof x === 'string') || !c.targets.every((x) => typeof x === 'string')) throw error('E_PROTOCOL', 'Worker capabilities are incomplete.');
    return freeze({ ...Object.fromEntries(engineFields.map((k) => [k, raw[k]])),
      startupMs: Number.isFinite(raw.startupMs) && raw.startupMs >= 0 ? raw.startupMs : null,
      wasmHeapBytes: count(raw.wasmHeapBytes) ? raw.wasmHeapBytes : null,
      capabilities: { lua: c.lua === true, p8: c.p8 === true, png: c.png === true, includes: c.includes === true, profiles: [...c.profiles], targets: [...c.targets] } });
  }
  const engineKey = (raw) => engineFields.map((k) => raw?.[k]).join('|');
  const sameJob = (a, b) => !!a && !!b && a.jobId === b.jobId && a.sourceRevision === b.sourceRevision && a.optionsRevision === b.optionsRevision;

  function resultSnapshot(job, engine, raw) {
    if (!record(raw) || raw.ok !== true || typeof raw.lua !== 'string' || (job.kind === 'p8' && typeof raw.cartText !== 'string') || !Array.isArray(raw.flags) || JSON.stringify(raw.flags) !== JSON.stringify(flagsFor(jobOptions(job)))) throw error('E_RESULT_INVALID', 'The worker returned incomplete output or unexpected optimization flags.');
    const metrics = {};
    for (const side of ['original', 'optimized']) {
      const m = raw.metrics?.[side];
      if (!record(m) || !count(m.tokens) || !count(m.characters) || (m.compressedBytes != null && !count(m.compressedBytes))) throw error('E_RESULT_INVALID', 'The worker returned invalid or missing metrics.');
      metrics[side] = { tokens: m.tokens, characters: m.characters, compressedBytes: m.compressedBytes ?? null };
      if (metrics[side].compressedBytes === null) metrics[side].compressedReason = typeof m.compressedReason === 'string' ? m.compressedReason : 'The engine did not provide this measure.';
    }
    const diagnostics = normalizeDiagnostics(raw.diagnostics);
    if (diagnostics.some((d) => d.severity === 'error')) throw error('E_RESULT_INVALID', 'An output containing errors cannot be accepted as current.', diagnostics);
    return freeze({ job, engine, lua: raw.lua, cartText: job.kind === 'p8' ? raw.cartText : null, metrics, diagnostics, flags: [...raw.flags] });
  }
  const jobOptions = (job) => ({ profile: job.profile, target: job.target });
  const idle = (s) => !validateSettings(s.options).ok ? 'unsupported' : s.enginePhase === 'loading' ? 'loading' : !hasSource(s) ? 'empty' : s.result ? 'stale' : 'ready';
  function initialState() {
    return freeze({ revision: 0, sourceRevision: 0, optionsRevision: 0, source: null, options: DEFAULTS, engine: null, enginePhase: 'cold', status: 'empty', latestJobId: null, activeJob: null, result: null, diagnostics: [] });
  }
  function transition(s, e) {
    let n = { ...s };
    if (e.type === 'source' || e.type === 'options') {
      if (e.type === 'source') n.source = sourceSnapshot(e.source);
      else {
        settings(e.options);
        n.options = settings({ ...s.options, ...e.options });
        if (JSON.stringify(n.options) === JSON.stringify(s.options)) return s;
      }
      n.revision++;
      n[e.type === 'source' ? 'sourceRevision' : 'optionsRevision'] = n.revision;
      n.activeJob = null; n.latestJobId = null;
      n.diagnostics = e.type === 'options' ? validateSettings(n.options).diagnostics : [];
      if (e.engineReset) { n.enginePhase = 'cold'; n.engine = null; }
      n.status = idle(n);
    } else if (e.type === 'loading') {
      n.enginePhase = 'loading'; n.status = 'loading'; n.diagnostics = [];
    } else if (e.type === 'ready') {
      n.engine = engineSnapshot(e.engine); n.enginePhase = 'ready';
      n.status = n.activeJob ? 'running' : idle(n);
    } else if (e.type === 'start') {
      if (s.activeJob) throw error('E_BUSY', 'An optimization is already active.');
      if (!hasSource(s)) throw error('E_EMPTY', 'Load nonempty source before optimizing.');
      flagsFor(s.options);
      n.revision++;
      n.activeJob = freeze({ jobId: `minifier-${n.revision}`, sourceRevision: s.sourceRevision, optionsRevision: s.optionsRevision, ...s.source, ...s.options });
      n.latestJobId = n.activeJob.jobId;
      n.status = s.enginePhase === 'ready' ? 'running' : 'loading'; n.diagnostics = [];
    } else if (e.type === 'complete') {
      if (!sameJob(s.activeJob, e.job) || e.job.sourceRevision !== s.sourceRevision || e.job.optionsRevision !== s.optionsRevision) return s;
      if (s.enginePhase !== 'ready' || !s.engine) throw error('E_RESULT_INVALID', 'Output arrived before engine initialization.');
      n.result = resultSnapshot(s.activeJob, s.engine, e.result);
      n.activeJob = null; n.diagnostics = n.result.diagnostics;
      n.status = n.result.metrics.original.tokens === n.result.metrics.optimized.tokens ? 'unchanged' : 'success';
    } else if (e.type === 'failure') {
      if (e.job && !sameJob(s.activeJob, e.job)) return s;
      n.activeJob = null; n.diagnostics = normalizeDiagnostics(e.diagnostics);
      if (e.engineReset) { n.enginePhase = 'cold'; n.engine = null; }
      n.status = n.diagnostics.some((d) => /UNSUPPORTED/.test(d.code)) ? 'unsupported' : 'error';
    } else if (e.type === 'cancel' || e.type === 'reset') {
      n.revision++; n.activeJob = null; n.latestJobId = null; n.engine = null; n.enginePhase = 'cold'; n.diagnostics = [];
      n.status = e.type === 'cancel' ? 'cancelled' : idle(n);
    } else throw error('E_STATE_EVENT', 'Unknown Minifier state transition.');
    return freeze(n);
  }
  function canExport(s) {
    return ['success', 'unchanged'].includes(s.status) && !!s.result && !s.activeJob && s.result.job.jobId === s.latestJobId && s.result.job.sourceRevision === s.sourceRevision && s.result.job.optionsRevision === s.optionsRevision;
  }
  function describe(s) {
    return freeze({ state: s.status, busy: ['loading', 'running'].includes(s.status), stale: !!s.result && !canExport(s), canExport: canExport(s), canOptimize: hasSource(s) && s.enginePhase === 'ready' && !['loading', 'running', 'unsupported'].includes(s.status) && validateSettings(s.options).ok });
  }
  function metricDelta(before, after) {
    if (!count(before) || !count(after)) return freeze({ available: false, text: '—', reason: 'Comparable engine measurements are unavailable.', saved: null, percent: null });
    const saved = before - after;
    const percent = before === 0 ? (after === 0 ? 0 : null) : Math.abs(saved) * 100 / before;
    const percentText = percent === null ? 'percentage unavailable' : `${Number(percent.toFixed(2))}%`;
    return freeze({ available: true, saved, percent, direction: saved < 0 ? 'increase' : saved > 0 ? 'saved' : 'unchanged', text: saved === 0 ? '0 (0%)' : `${Math.abs(saved)} ${saved < 0 ? 'increase' : 'saved'} (${percentText})` });
  }
  function outputFilename(path, kind) {
    if (!['lua', 'p8'].includes(kind)) throw error('E_FORMAT_UNSUPPORTED', 'Only .lua/.p8 output names are supported.');
    const base = String(path || 'untitled').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/\.(?:p8|lua)$/i, '') || 'untitled';
    return `${base}.min.${kind}`;
  }
  return { DEFAULTS, FLAGS, STATES, settings, validateSettings, flagsFor, sourceSnapshot, normalizeDiagnostics, engineSnapshot, engineKey, sameJob, resultSnapshot, initialState, transition, describe, canExport, metricDelta, outputFilename, error };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierCore;

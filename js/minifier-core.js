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

  function inputKind(name) {
    if (typeof name !== 'string' || !/\.(?:lua|p8)$/i.test(name)) throw error('E_FORMAT_UNSUPPORTED', 'Open a .lua file or a PICO-8 text cartridge (.p8). PNG cartridges and other formats are not supported.');
    return name.toLowerCase().endsWith('.p8') ? 'p8' : 'lua';
  }
  function decodeText(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch (_) { throw error('E_INPUT_ENCODING', 'This file is not valid UTF-8 text. Save it as a UTF-8 .lua or .p8 text file before importing.'); }
  }
  function prepareInput(raw, { allowEmpty = false } = {}) {
    const source = sourceSnapshot(raw);
    if (!source) return null;
    const Code = typeof P8Code !== 'undefined' ? P8Code : require('./code-core.js');
    const text = source.files.find((f) => f.path === source.entryPath).text;
    if (text.includes('\0')) throw error('E_INPUT_ENCODING', 'Source contains NUL bytes. Open a UTF-8 .lua or .p8 text file, not a binary cartridge.');
    let lua = text, original = { text, cart: null };
    if (source.kind === 'p8') {
      const parts = Code.splitCart(text);
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      const version = /^version[ \t]+(\d+)[ \t]*$/.exec(lines[1] || '');
      if (!/^pico-8 cartridge(?:\s|$)/.test(lines[0]) || !version || !Number.isSafeInteger(Number(version[1]))) throw error('E_CART_HEADER', 'A .p8 file must start with the PICO-8 cartridge header and a numeric version line. Save the cart as a text .p8 file in PICO-8.');
      if (parts.head === null || parts.head.split('\n').slice(2, -2).some((line) => line.trim()) || parts.sections.includes('lua') || new Set(parts.sections).size !== parts.sections.length) throw error('E_CART_SECTIONS', 'The cartridge needs one __lua__ section after its version header and unique section markers. Check missing, misplaced or duplicate delimiters.');
      // splitCart normalizes newlines. Map its boundaries back to raw text to retain exact non-Lua bytes.
      const rawOffset = (offset) => {
        let i = 0;
        for (let n = 0; n < offset && i < text.length; n++, i++) if (text[i] === '\r' && text[i + 1] === '\n') i++;
        return i;
      };
      const tailStart = rawOffset(text.replace(/\r\n?/g, '\n').length - parts.tail.length);
      lua = parts.lua;
      original = { text, cart: { version: Number(version[1]), header: text.slice(0, rawOffset(parts.head.length)), nonLua: text.slice(tailStart), sections: [...parts.sections], crlf: parts.crlf } };
    } else if (/^\ufeff?pico-8 cartridge(?:\s|$)/.test(text)) {
      throw error('E_FORMAT_UNSUPPORTED', 'This looks like a complete cartridge. Open it with a .p8 filename instead of treating it as Lua.');
    }
    if (!allowEmpty && !lua.trim()) throw error('E_EMPTY', 'Source has no Lua code. Choose a nonempty .lua file or a .p8 cartridge with code.');
    return freeze({ source, lua, tabs: Code.codeTabs(lua), original });
  }
  function textInput(name, text) {
    const kind = inputKind(name);
    return prepareInput({ kind, entryPath: name, files: [{ path: name, text }] });
  }

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
    return freeze({ revision: 0, sourceRevision: 0, optionsRevision: 0, source: null, options: DEFAULTS, engine: null, enginePhase: 'cold', status: 'empty', latestJobId: null, activeJob: null, result: null, diagnosticJob: null, diagnostics: [] });
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
      n.diagnosticJob = null;
      n.diagnostics = e.type === 'options' ? validateSettings(n.options).diagnostics : [];
      if (e.engineReset) { n.enginePhase = 'cold'; n.engine = null; }
      n.status = idle(n);
    } else if (e.type === 'loading') {
      n.enginePhase = 'loading'; n.status = 'loading'; n.diagnostics = []; n.diagnosticJob = null;
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
      n.status = s.enginePhase === 'ready' ? 'running' : 'loading'; n.diagnostics = []; n.diagnosticJob = null;
    } else if (e.type === 'complete') {
      if (!sameJob(s.activeJob, e.job) || e.job.sourceRevision !== s.sourceRevision || e.job.optionsRevision !== s.optionsRevision) return s;
      if (s.enginePhase !== 'ready' || !s.engine) throw error('E_RESULT_INVALID', 'Output arrived before engine initialization.');
      n.result = resultSnapshot(s.activeJob, s.engine, e.result);
      n.activeJob = null; n.diagnostics = n.result.diagnostics;
      n.diagnosticJob = n.result.job;
      n.status = n.result.metrics.original.tokens === n.result.metrics.optimized.tokens ? 'unchanged' : 'success';
    } else if (e.type === 'failure') {
      if (e.job && !sameJob(s.activeJob, e.job)) return s;
      n.activeJob = null; n.diagnostics = normalizeDiagnostics(e.diagnostics);
      n.diagnosticJob = e.job ? s.activeJob : null;
      if (e.engineReset) { n.enginePhase = 'cold'; n.engine = null; }
      n.status = n.diagnostics.some((d) => /UNSUPPORTED/.test(d.code) || d.code === 'E_LOCAL_HTTP') ? 'unsupported' : 'error';
    } else if (e.type === 'cancel' || e.type === 'reset') {
      n.revision++; n.activeJob = null; n.latestJobId = null; n.engine = null; n.enginePhase = 'cold'; n.diagnostics = []; n.diagnosticJob = null;
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
  const formatPercent = (percent) => percent === null ? 'percentage unavailable' : percent > 0 && percent < 0.01 ? '<0.01%' : `${Number(percent.toFixed(2))}%`;
  function metricDelta(before, after) {
    if (!count(before) || !count(after)) return freeze({ available: false, text: '—', reason: 'Comparable engine measurements are unavailable.', saved: null, percent: null });
    const saved = before - after;
    const percent = before === 0 ? (after === 0 ? 0 : null) : Math.abs(saved) * 100 / before;
    const percentText = formatPercent(percent);
    return freeze({ available: true, saved, percent, direction: saved < 0 ? 'increase' : saved > 0 ? 'saved' : 'unchanged', text: saved === 0 ? '0 (0%)' : `${Math.abs(saved)} ${saved < 0 ? 'increase' : 'saved'} (${percentText})` });
  }
  function outputFilename(path, kind) {
    if (!['lua', 'p8'].includes(kind)) throw error('E_FORMAT_UNSUPPORTED', 'Only .lua/.p8 output names are supported.');
    const base = String(path || 'untitled').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/\.(?:p8|lua)$/i, '') || 'untitled';
    return `${base}.min.${kind}`;
  }
  function metricRows(result) {
    return freeze([['Tokens', 'tokens', 8192], ['Characters', 'characters', 65535], ['Compressed code bytes', 'compressedBytes', null]].map(([label, key, limit]) => {
      const original = result?.metrics?.original, optimized = result?.metrics?.optimized;
      const before = count(original?.[key]) ? original[key] : null, after = count(optimized?.[key]) ? optimized[key] : null;
      const reason = (side) => key === 'compressedBytes' && typeof side?.compressedReason === 'string' ? side.compressedReason : 'No engine measurement is available.';
      const delta = metricDelta(before, after);
      const percent = formatPercent(delta.percent);
      const change = delta.direction === 'increase' ? `Increased by ${-delta.saved} (${percent})` : delta.text;
      return { label, key, limit, before, after, beforeReason: before === null ? reason(original) : '', afterReason: after === null ? reason(optimized) : '',
        delta, change, beforeOver: limit !== null && before !== null && before > limit, afterOver: limit !== null && after !== null && after > limit };
    }));
  }
  function diagnosticLocation(state, input, diagnostic) {
    const job = state.diagnosticJob;
    if (!job || !input || !state.diagnostics.includes(diagnostic) || job.jobId !== state.latestJobId || job.sourceRevision !== state.sourceRevision || job.optionsRevision !== state.optionsRevision || input.sourceRevision !== state.sourceRevision || diagnostic.file !== job.entryPath || input.source.entryPath !== job.entryPath || !count(diagnostic.line) || diagnostic.line < 1) return null;
    const text = job.files.find((f) => f.path === job.entryPath)?.text;
    if (input.source.files.find((f) => f.path === job.entryPath)?.text !== text) return null;
    let line = diagnostic.line;
    if (job.kind === 'p8') {
      if (!input.original.cart) return null;
      line -= input.original.cart.header.replace(/\r\n?/g, '\n').split('\n').length - 1;
    }
    const lines = input.lua.replace(/\r\n?/g, '\n').split('\n');
    if (line < 1 || line > lines.length) return null;
    const start = lines.slice(0, line - 1).reduce((n, value) => n + value.length + 1, 0);
    // Select the whole line: engine columns count P8SCII, while DOM offsets count UTF-16.
    return freeze({ file: diagnostic.file, reportedLine: diagnostic.line, line, start, end: start + lines[line - 1].length });
  }
  return { DEFAULTS, FLAGS, STATES, settings, validateSettings, flagsFor, sourceSnapshot, inputKind, decodeText, prepareInput, textInput, normalizeDiagnostics, engineSnapshot, engineKey, sameJob, resultSnapshot, initialState, transition, describe, canExport, metricDelta, metricRows, diagnosticLocation, outputFilename, error };
})();
if (typeof module !== 'undefined') module.exports = P8MinifierCore;

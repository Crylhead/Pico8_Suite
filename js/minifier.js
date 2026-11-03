// MIN-03: native DOM presenter. Intake, detailed reports, editor handoff and exports follow separately.
'use strict';
const P8Minifier = (() => {
  const Core = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  function mount({ root, adapter, app, media, protocol = globalThis.location?.protocol }) {
    const $ = (id) => root.querySelector('#' + id);
    const radios = (id) => [...$(id).querySelectorAll('[role=radio]')];
    let mode = media.matches ? 'compare' : 'original', explicitMode = false;
    let origin = 'In-memory source', previousDiagnostics = null;
    const needsLocalSetup = (s) => protocol === 'file:' || s.diagnostics.some((d) => d.code === 'E_LOCAL_HTTP');
    const setValue = (node, value) => { if (node.value !== value) node.value = value; };
    const actionButtons = (action, disabled) => {
      for (const button of root.ownerDocument.querySelectorAll(`[data-action="${action}"]`)) button.disabled = disabled;
    };
    function setMode(next, explicit = true) {
      if (!['compare', 'original', 'optimized'].includes(next)) return;
      mode = next; explicitMode ||= explicit;
      for (const b of radios('mnCompareMode')) b.setAttribute('aria-checked', String(b.dataset.value === mode));
      $('mnCodeViews').dataset.mode = mode;
      $('mnSourcePane').hidden = mode === 'optimized';
      $('mnOutputPane').hidden = mode === 'original';
      // Resizing may hide a focused read-only pane; keep focus on the selected view control.
      const focused = root.ownerDocument.activeElement;
      if (($('mnSourcePane').hidden && $('mnSourcePane').contains(focused)) || ($('mnOutputPane').hidden && $('mnOutputPane').contains(focused))) {
        radios('mnCompareMode').find((b) => b.dataset.value === mode)?.focus({ preventScroll: true });
      }
    }
    function statusText(s) {
      if (needsLocalSetup(s)) return 'Local setup required. Start the local Suite launcher to use Minifier.';
      if (s.status === 'ready' && s.enginePhase === 'cold') return 'Source loaded. Engine not ready. Load the engine to optimize.';
      const messages = {
        empty: 'No source loaded.', loading: 'Loading Minifier engine…', running: 'Optimizing tokens…',
        ready: 'Ready to optimize.', success: 'Optimization complete.', unchanged: 'No token savings found in Minimal mode.',
        stale: 'Options or input changed. Optimize again.', cancelled: 'Optimization cancelled. Original source unchanged.',
        error: 'Minifier failed.', unsupported: 'Unsupported input or settings.',
      };
      let text = messages[s.status];
      if (['error', 'unsupported'].includes(s.status)) text += ' ' + (s.diagnostics[0]?.message || 'Check diagnostics and retry.');
      else if (s.enginePhase === 'cold' && ['ready', 'stale', 'cancelled'].includes(s.status)) text += ' Load the engine to optimize.';
      return text;
    }
    function render(s) {
      const controls = Core.describe(s), current = controls.canExport;
      const localSetup = needsLocalSetup(s);
      $('mnLocalSetup').hidden = !localSetup;
      root.dataset.state = s.status;
      $('mnSourceName').textContent = s.source ? s.source.entryPath.split('/').pop() : 'No source selected';
      $('mnProvenance').textContent = s.source ? origin : '';
      setValue($('mnSourceCode'), s.source?.files.find((f) => f.path === s.source.entryPath)?.text || '');
      setValue($('mnOutputCode'), s.result ? (s.result.job.kind === 'p8' ? s.result.cartText : s.result.lua) : '');
      $('mnOutputState').textContent = !s.result ? 'No result.' : current ? 'Current result · generated build copy.' : 'Stale result · this is an earlier snapshot.';
      $('mnOutputState').dataset.tone = s.result && !current ? 'warn' : '';
      $('mnOutputPane').dataset.stale = String(!!s.result && !current);
      $('mnStatus').textContent = statusText(s);
      $('mnStatus').dataset.tone = localSetup ? 'warn' : ['error', 'unsupported'].includes(s.status) ? 'error' : ['cancelled', 'stale'].includes(s.status) ? 'warn' : ['success', 'unchanged'].includes(s.status) ? 'ok' : '';
      actionButtons('mn-optimize', localSetup || !controls.canOptimize);
      actionButtons('mn-cancel', !controls.busy);
      actionButtons('mn-retry', controls.busy || localSetup);
      $('mnOptimize').setAttribute('aria-busy', String(controls.busy));
      $('mnProgress').hidden = !controls.busy;
      $('mnTarget').disabled = controls.busy;
      setValue($('mnTarget'), s.options.target);
      for (const b of radios('mnProfile')) {
        b.disabled = controls.busy || b.dataset.value !== 'minimal';
        b.setAttribute('aria-checked', String(b.dataset.value === s.options.profile));
      }
      const retryText = s.status === 'error' ? 'Retry engine' : 'Load engine';
      for (const b of root.ownerDocument.querySelectorAll('[data-action="mn-retry"]')) b.textContent = retryText;
      $('mnRetry').hidden = localSetup || (s.enginePhase === 'ready' && s.status !== 'error');
      $('mnEngine').textContent = s.engine ? `Shrinko8 ${s.engine.shrinko8Version} · Pyodide ${s.engine.pyodideVersion}` : s.enginePhase === 'loading' ? 'Engine initializing locally…' : 'Engine not ready.';
      $('mnFlags').textContent = Core.validateSettings(s.options).ok ? Core.flagsFor(s.options).join(' ') : 'Unsupported settings.';
      // Only actual engine measurements are shown. Limits, deltas and filtering belong to MIN-05.
      $('mnMetricsState').textContent = !s.result ? 'No measurements.' : current ? 'Current result · code counts, not whole-file sizes.' : 'Stale measurements · earlier snapshot.';
      for (const [id, key] of [['Tokens', 'tokens'], ['Chars', 'characters'], ['Bytes', 'compressedBytes']]) {
        for (const [suffix, side] of [['Before', 'original'], ['After', 'optimized']]) {
          const m = s.result?.metrics[side];
          const cell = $('mn' + id + suffix);
          cell.textContent = m?.[key] == null ? '—' : String(m[key]);
          cell.setAttribute('aria-label', m?.[key] == null ? `${key}: unavailable. ${key === 'compressedBytes' ? m?.compressedReason || 'No engine measurement.' : 'No engine measurement.'}` : `${key}: ${m[key]}`);
        }
      }
      if (previousDiagnostics !== s.diagnostics) {
        previousDiagnostics = s.diagnostics;
        $('mnDiagnosticsSummary').textContent = `Diagnostics (${s.diagnostics.length})`;
        $('mnDiagnosticList').replaceChildren(...(s.diagnostics.length ? s.diagnostics.map((d) => {
          const li = root.ownerDocument.createElement('li');
          li.textContent = `${d.severity}: ${d.code} — ${d.message}`;
          return li;
        }) : [Object.assign(root.ownerDocument.createElement('li'), { textContent: 'No diagnostics.' })]));
        if (s.diagnostics.length) $('mnDiagnostics').open = true;
      }
      // Dedicated output actions await MIN-08 content/preservation validation.
      $('mnCopy').disabled = true; $('mnDownload').disabled = true;
    }
    const swallow = (fn) => { try { return Promise.resolve(fn()).catch(() => {}); } catch (_) { return Promise.resolve(); } };
    const actions = {
      'mn-optimize': () => { if (Core.describe(adapter.getState()).canOptimize) return swallow(() => adapter.optimize()); },
      'mn-cancel': () => adapter.cancel(),
      'mn-retry': () => { const s = adapter.getState(); if (!Core.describe(s).busy && !needsLocalSetup(s)) return swallow(() => adapter.retry()); },
      ...Object.fromEntries(['compare', 'original', 'optimized'].map((view) => ['mn-view-' + view, () => setMode(view)])),
    };
    app.registerActions(actions);
    const onView = (e) => {
      const b = e.target.closest('[role=radio]');
      if (b && !b.disabled) setMode(b.dataset.value);
    };
    const onProfile = (e) => {
      const b = e.target.closest('[role=radio]');
      if (b && !b.disabled) adapter.setOptions({ profile: b.dataset.value });
    };
    const onTarget = () => adapter.setOptions({ target: $('mnTarget').value });
    const onResize = () => { if (!explicitMode) setMode(media.matches ? 'compare' : 'original', false); };
    $('mnCompareMode').addEventListener('click', onView);
    $('mnProfile').addEventListener('click', onProfile);
    $('mnTarget').addEventListener('change', onTarget);
    media.addEventListener('change', onResize);
    const unsubscribe = adapter.subscribe(render);
    setMode(mode, false); render(adapter.getState());
    return Object.freeze({
      load(snapshot, { provenance = 'In-memory source' } = {}) {
        adapter.setSource(snapshot);
        origin = ['In-memory source', 'Local file', 'Pasted Lua', 'Code Editor', 'Project folder'].includes(provenance) ? provenance : 'In-memory source';
        render(adapter.getState());
      },
      getState: adapter.getState, initialize: () => swallow(() => adapter.initialize()), setMode,
      cancel: adapter.cancel,
      dispose() {
        unsubscribe(); media.removeEventListener('change', onResize);
        $('mnCompareMode').removeEventListener('click', onView);
        $('mnProfile').removeEventListener('click', onProfile);
        $('mnTarget').removeEventListener('change', onTarget);
        adapter.dispose();
      },
    });
  }
  return { mount };
})();
if (typeof module !== 'undefined') module.exports = P8Minifier;

if (typeof window !== 'undefined' && window.Suite && window.P8App) (() => {
  const App = window.P8App, S = window.Suite;
  const root = document.querySelector('main[data-ws="minifier"]');
  S.registerTool({ ws: 'minifier', category: 'develop', name: 'Minifier',
    desc: 'Compare original and generated PICO-8 code with local Shrinko8, Minimal profile and Tokens focus. Source import and exports are not available yet.',
    tags: ['minify', 'optimize', 'tokens', 'shrinko8', 'lua', 'cartridge'] });
  const view = P8Minifier.mount({ root, adapter: P8MinifierEngine.create(), app: App, media: matchMedia('(min-width: 1200px)') });
  let attempted = false;
  const entered = () => {
    if (document.body.dataset.workspace === 'minifier') {
      if (!attempted) { attempted = true; view.initialize(); }
    } else view.cancel();
  };
  S.minifier = Object.freeze({ ...view, dispose() { document.removeEventListener('p8:workspace', entered); view.dispose(); } });
  document.addEventListener('p8:workspace', entered);
  entered();
})();

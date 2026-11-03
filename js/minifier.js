// MIN-03: native DOM presenter. Intake, detailed reports, editor handoff and exports follow separately.
'use strict';
const P8Minifier = (() => {
  const Core = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  function mount({ root, adapter, app, media, protocol = globalThis.location?.protocol }) {
    const $ = (id) => root.querySelector('#' + id);
    const radios = (id) => [...$(id).querySelectorAll('[role=radio]')];
    let mode = media.matches ? 'compare' : 'original', explicitMode = false;
    let origin = 'In-memory source', previousDiagnostics = null, input = null;
    let intakeSerial = 0, intakePending = false, disposed = false;
    const needsLocalSetup = (s) => protocol === 'file:' || s.diagnostics.some((d) => d.code === 'E_LOCAL_HTTP');
    const setValue = (node, value) => {
      // Textareas expose LF even after assigning CRLF. Compare display text so renders keep selection/scroll.
      const display = value.replace(/\r\n?/g, '\n');
      if (node.value !== display) node.value = display;
    };
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
      setValue($('mnSourceCode'), input?.lua || '');
      setValue($('mnOutputCode'), s.result?.lua || '');
      $('mnSourceStorage').textContent = s.source ? 'In-memory snapshot · not saved to a file or Library. Original files unchanged.' : 'Open a .p8 / .lua file or paste Lua to begin.';
      $('mnOutputState').textContent = !s.result ? 'No result.' : current ? 'Current result · generated build copy.' : 'Stale result · this is an earlier snapshot.';
      $('mnOutputState').dataset.tone = s.result && !current ? 'warn' : '';
      $('mnOutputPane').dataset.stale = String(!!s.result && !current);
      $('mnStatus').textContent = statusText(s);
      $('mnStatus').dataset.tone = localSetup ? 'warn' : ['error', 'unsupported'].includes(s.status) ? 'error' : ['cancelled', 'stale'].includes(s.status) ? 'warn' : ['success', 'unchanged'].includes(s.status) ? 'ok' : '';
      actionButtons('mn-optimize', intakePending || localSetup || !controls.canOptimize);
      actionButtons('mn-cancel', !controls.busy && !intakePending);
      for (const b of root.ownerDocument.querySelectorAll('[data-action="mn-cancel"]')) b.textContent = intakePending ? 'Cancel input' : 'Cancel';
      actionButtons('mn-retry', intakePending || controls.busy || localSetup);
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
    const provenance = (value) => ['In-memory source', 'Local file', 'Pasted Lua', 'Code Editor', 'Project folder'].includes(value) ? value : 'In-memory source';
    const inputStatus = (text, tone = '') => { $('mnInputStatus').textContent = text; $('mnInputStatus').dataset.tone = tone; };
    function commit(prepared, from) {
      const previous = input, previousOrigin = origin;
      input = prepared; origin = provenance(from);
      try { adapter.setSource(prepared?.source || null); }
      catch (err) { input = previous; origin = previousOrigin; throw err; }
      render(adapter.getState());
    }
    function cancelIntake() {
      intakeSerial++;
      if (intakePending) {
        intakePending = false;
        inputStatus('Source intake cancelled. Current source and result kept.');
        render(adapter.getState());
      }
    }
    async function replaceFrom(prepare, from) {
      const ticket = ++intakeSerial, sourceRevision = adapter.getState().sourceRevision;
      const live = () => !disposed && ticket === intakeSerial && sourceRevision === adapter.getState().sourceRevision;
      intakePending = true;
      inputStatus('Waiting for input. Current source and result kept.'); render(adapter.getState());
      try {
        const prepared = await prepare(() => live());
        if (!live()) return;
        if (!prepared) { inputStatus('No source imported. Current source and result kept.'); return; }
        const before = adapter.getState();
        if (before.source) {
          const accepted = await app.confirmDialog('Replace Minifier source?', `Replace “${before.source.entryPath}” with “${prepared.source.entryPath}”?\n\nThe current snapshot is not saved to a file or Library.${before.result ? ' Its result has not been exported and will be marked stale.' : ''} Original files are unchanged.`, 'Replace source', 'Keep current');
          if (!live()) return;
          const now = adapter.getState();
          if (!accepted) { inputStatus('Current source and result kept.'); return; }
          if (now.revision !== before.revision || now.result !== before.result || now.activeJob !== before.activeJob) {
            inputStatus('The source or result changed while confirming. Open or paste again to replace it.', 'warn'); return;
          }
        }
        commit(prepared, from);
        inputStatus(`Loaded ${prepared.source.entryPath} · ${from}. Lua syntax is checked when you choose Optimize.`);
      } catch (err) {
        if (live()) inputStatus(`Input not loaded: ${err.code ? err.message : 'The file could not be read. Choose it again.'} Current source and result kept.`, 'error');
      } finally {
        if (ticket === intakeSerial) { intakePending = false; render(adapter.getState()); }
      }
    }
    function openFile() {
      return replaceFrom(async (live) => {
        const file = await app.pickFile('.p8,.lua');
        if (!file || !live()) return null;
        Core.inputKind(file.name); // Refuse unsupported names before reading any bytes.
        inputStatus('Reading source… Current source and result kept.');
        const bytes = await file.arrayBuffer();
        if (!live()) return null;
        return Core.textInput(file.name, Core.decodeText(bytes));
      }, 'Local file');
    }
    function pasteLua() {
      return replaceFrom(async () => {
        const text = app.el('textarea', { id: 'mnPasteText', className: 'code-out', spellcheck: false, attrs: { 'aria-describedby': 'mnPasteHint mnPasteError' } });
        const problem = app.el('p', { id: 'mnPasteError', className: 'status-line', hidden: true, dataset: { tone: 'error' }, attrs: { role: 'alert' } });
        let prepared;
        return app.modal({ title: 'Paste Lua', wide: true,
          body: app.el('div', {}, app.el('label', { htmlFor: 'mnPasteText', textContent: 'Lua source' }),
            app.el('p', { id: 'mnPasteHint', textContent: 'Loads a page-only snapshot named pasted.lua. Lua syntax is checked on Optimize; nothing is saved or run.' }), text, problem),
          buttons: [{ label: 'Cancel', value: null }, { label: 'Load Lua', primary: true, value: () => prepared,
            validate() {
              try { prepared = Core.textInput('pasted.lua', text.value); text.setAttribute('aria-invalid', 'false'); problem.hidden = true; problem.textContent = ''; return true; }
              catch (err) { text.setAttribute('aria-invalid', 'true'); problem.hidden = false; problem.textContent = err.message; text.focus(); return false; }
            } }], onOpen: () => text.focus(),
        });
      }, 'Pasted Lua');
    }
    const swallow = (fn) => { try { return Promise.resolve(fn()).catch(() => {}); } catch (_) { return Promise.resolve(); } };
    const actions = {
      'mn-open': openFile, 'mn-paste': pasteLua,
      'mn-optimize': () => { if (!intakePending && Core.describe(adapter.getState()).canOptimize) return swallow(() => adapter.optimize()); },
      'mn-cancel': () => { if (intakePending) cancelIntake(); else adapter.cancel(); },
      'mn-retry': () => { const s = adapter.getState(); if (!intakePending && !Core.describe(s).busy && !needsLocalSetup(s)) return swallow(() => adapter.retry()); },
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
        const prepared = Core.prepareInput(snapshot);
        cancelIntake(); commit(prepared, provenance);
        inputStatus(snapshot ? 'Source snapshot loaded. Original files unchanged.' : 'Source cleared.');
      },
      getInput: () => input ? Object.freeze({ ...input, sourceRevision: adapter.getState().sourceRevision }) : null,
      getState: adapter.getState, initialize: () => swallow(() => adapter.initialize()), setMode,
      cancel() { cancelIntake(); return adapter.cancel(); },
      dispose() {
        disposed = true; cancelIntake();
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
    desc: 'Open .p8 / .lua files or paste Lua, then compare local Shrinko8 output with Minimal profile and Tokens focus. Original files are unchanged; dedicated exports follow separately.',
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

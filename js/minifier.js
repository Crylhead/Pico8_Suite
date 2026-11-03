// Native Minifier: immutable intake, truthful reports and revision-bound source locations.
'use strict';
const P8Minifier = (() => {
  const Core = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  function mount({ root, adapter, app, media, protocol = globalThis.location?.protocol, editorSource = null }) {
    const $ = (id) => root.querySelector('#' + id);
    const radios = (id) => [...$(id).querySelectorAll('[role=radio]')];
    let mode = media.matches ? 'compare' : 'original', explicitMode = false;
    let origin = 'In-memory source', previousDiagnostics = null, input = null;
    let diagnosticFilter = 'all', renderedDiagnostics = null, renderedFilter = null, renderedDiagnosticJob = null;
    let intakeSerial = 0, intakePending = false, disposed = false;
    let editorStale = false;
    const editorStatus = () => editorSource?.getStatus() || { available: false, reason: 'Open or type nonempty source in Code Editor first.' };
    function invalidateEditor() {
      if (input?.editor && !editorStale && !editorSource?.isCurrent(input.editor.identity)) {
        editorStale = true;
        adapter.setSource(input.source); // Keep the captured text, invalidate result/job identities immediately.
        return true;
      }
      return false;
    }
    const needsLocalSetup = (s) => protocol === 'file:' || s.diagnostics.some((d) => d.code === 'E_LOCAL_HTTP');
    const setValue = (node, value) => {
      // Textareas expose LF even after assigning CRLF. Compare display text so renders keep selection/scroll.
      const display = value.replace(/\r\n?/g, '\n');
      if (node.value !== display) node.value = display;
    };
    const currentInput = (s) => input ? Object.freeze({ ...input, sourceRevision: s.sourceRevision }) : null;
    const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
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
    function statusText(s, rows) {
      if (needsLocalSetup(s)) return 'Local setup required. Start the local Suite launcher to use Minifier.';
      if (editorStale) return 'Earlier Code Editor snapshot. Use current editor to refresh before optimizing.';
      if (s.status === 'ready' && s.enginePhase === 'cold') return 'Source loaded. Engine not ready. Load the engine to optimize.';
      const messages = {
        empty: 'No source loaded.', loading: 'Loading Minifier engine…', running: 'Optimizing tokens…',
        ready: 'Ready to optimize.', success: 'Optimization complete.', unchanged: 'No token savings found in Minimal mode.',
        stale: 'Options or input changed. Optimize again.', cancelled: 'Optimization cancelled. Original source unchanged.',
        error: 'Minifier failed.', unsupported: 'Unsupported input or settings.',
      };
      let text = messages[s.status];
      if (Core.canExport(s)) {
        if (rows[0].delta.direction === 'increase') text += ' Token count increased; review the result.';
        if (rows.some((row) => row.afterOver)) text += ' Output is over the code budget. See measurements.';
      }
      if (['error', 'unsupported'].includes(s.status)) text += ' ' + (s.diagnostics[0]?.message || 'Check diagnostics and retry.');
      else if (s.enginePhase === 'cold' && ['ready', 'stale', 'cancelled'].includes(s.status)) text += ' Load the engine to optimize.';
      return text;
    }
    function renderDiagnostics(s) {
      if (previousDiagnostics !== s.diagnostics) {
        previousDiagnostics = s.diagnostics; diagnosticFilter = 'all';
        if (s.diagnostics.length) $('mnDiagnostics').open = true;
      }
      setText($('mnDiagnosticsSummary'), `Diagnostics (${s.diagnostics.length})`);
      const labels = { all: 'All', error: 'Errors', warning: 'Warnings', info: 'Info' };
      for (const b of radios('mnDiagnosticFilter')) {
        const severity = b.dataset.value;
        b.setAttribute('aria-checked', String(severity === diagnosticFilter));
        setText(b, `${labels[severity]} (${severity === 'all' ? s.diagnostics.length : s.diagnostics.filter((d) => d.severity === severity).length})`);
      }
      if (renderedDiagnostics === s.diagnostics && renderedFilter === diagnosticFilter && renderedDiagnosticJob === s.diagnosticJob) return;
      renderedDiagnostics = s.diagnostics; renderedFilter = diagnosticFilter; renderedDiagnosticJob = s.diagnosticJob;
      const shown = s.diagnostics.filter((d) => diagnosticFilter === 'all' || d.severity === diagnosticFilter);
      setText($('mnDiagnosticsShown'), !s.diagnostics.length ? 'No diagnostics.' : `${shown.length} of ${s.diagnostics.length} diagnostics shown · ${labels[diagnosticFilter]}.`);
      const items = shown.map((d) => {
        const li = root.ownerDocument.createElement('li'); li.textContent = `${d.severity}: ${d.code} — ${d.message}`;
        const location = Core.diagnosticLocation(s, currentInput(s), d);
        if (location) {
          const button = root.ownerDocument.createElement('button');
          button.type = 'button'; button.className = 'btn btn-ghost btn-sm mn-diagnostic-location';
          button.dataset.helpId = 'minifier.location';
          button.textContent = `${d.file}:${d.line}${d.column ? ':' + d.column : ''}`;
          button.setAttribute('aria-label', `Select source line ${location.line} for ${button.textContent}`);
          button.addEventListener('click', () => {
            const now = adapter.getState(), target = Core.diagnosticLocation(now, currentInput(now), d);
            if (!target) return; // Saved callbacks from a different job/revision cannot navigate current source.
            setMode('original');
            const code = $('mnSourceCode'); code.focus(); code.setSelectionRange(target.start, target.end);
            const height = parseFloat(root.ownerDocument.defaultView?.getComputedStyle(code).lineHeight) || 18;
            code.scrollTop = Math.max(0, (target.line - 2) * height); code.scrollIntoView?.({ block: 'nearest' });
          });
          li.append(button);
        } else if (d.file || d.line) {
          const where = root.ownerDocument.createElement('span');
          where.textContent = ` Reported location: ${d.file || 'unknown file'}${d.line ? ':' + d.line : ''}${d.column ? ':' + d.column : ''}`;
          li.append(where);
        }
        return li;
      });
      if (!items.length) items.push(Object.assign(root.ownerDocument.createElement('li'), { textContent: s.diagnostics.length ? 'No diagnostics match this filter.' : 'No diagnostics.' }));
      $('mnDiagnosticList').replaceChildren(...items);
    }
    function render(s) {
      if (invalidateEditor()) return; // The nested invalidation render owns the new state, including late replies.
      const controls = Core.describe(s), current = controls.canExport;
      const rows = Core.metricRows(s.result);
      const reportWarning = current && (rows[0].delta.direction === 'increase' || rows.some((row) => row.afterOver));
      const localSetup = needsLocalSetup(s);
      $('mnLocalSetup').hidden = !localSetup;
      root.dataset.state = s.status;
      $('mnSourceName').textContent = s.source ? s.source.entryPath.split('/').pop() : 'No source selected';
      $('mnProvenance').textContent = input?.editor ? `From Code Editor${input.editor.dirty ? ' · Unsaved changes at capture' : ''}` : s.source ? origin : '';
      const editor = editorStatus();
      $('mnUseEditor').disabled = !editor.available || intakePending;
      setText($('mnEditorAvailability'), editor.available ? 'Use current editor copies its live buffer. Nothing is saved or applied back.' : editor.reason);
      $('mnReturn').hidden = !input?.editor;
      $('mnEditorState').hidden = !input?.editor;
      setText($('mnEditorState'), editorStale ? 'Earlier snapshot: Code Editor or its file context changed. Back returns to the current editor document; no output has been applied.' : input?.editor ? 'Editor snapshot is current. Back to Code Editor preserves its existing editing context.' : '');
      $('mnEditorState').dataset.tone = editorStale ? 'warn' : '';
      const project = input?.project;
      $('mnProjectState').hidden = !project;
      setText($('mnProjectState'), project ? `${input.source.files.length} source file(s) captured${project.edges.length ? ' · includes resolved in source order' : ''}. Measurements use the resolved build copy. ${project.buildCopy ? 'Source-only directives may be removed; keep the original project.' : ''}` : '');
      $('mnProjectState').dataset.tone = project?.diagnostics.length ? 'warn' : '';
      setValue($('mnSourceCode'), input?.lua || '');
      setValue($('mnOutputCode'), s.result?.lua || '');
      $('mnSourceStorage').textContent = s.source ? 'In-memory snapshot · not saved to a file or Library. Original files unchanged.' : 'Open a .p8 / .lua file or paste Lua to begin.';
      $('mnOutputState').textContent = !s.result ? 'No result.' : current ? 'Current result · generated build copy.' : 'Stale result · this is an earlier snapshot.';
      $('mnOutputState').dataset.tone = s.result && !current ? 'warn' : '';
      $('mnOutputPane').dataset.stale = String(!!s.result && !current);
      setText($('mnStatus'), statusText(s, rows));
      $('mnStatus').dataset.tone = localSetup || editorStale || reportWarning ? 'warn' : ['error', 'unsupported'].includes(s.status) ? 'error' : ['cancelled', 'stale'].includes(s.status) ? 'warn' : ['success', 'unchanged'].includes(s.status) ? 'ok' : '';
      actionButtons('mn-optimize', editorStale || intakePending || localSetup || !controls.canOptimize);
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
      setText($('mnMetricsState'), !s.result ? 'No measurements. Choose Optimize to measure with Shrinko8.' : `${current ? 'Current result' : 'Stale measurements · earlier snapshot'} · Shrinko8 ${s.result.engine.shrinko8Version} · Lua code from “${s.result.job.entryPath}”.`);
      const reasons = [];
      for (const [index, id] of ['Tokens', 'Chars', 'Bytes'].entries()) {
        const row = rows[index];
        for (const [suffix, side] of [['Before', 'original'], ['After', 'optimized']]) {
          const value = side === 'original' ? row.before : row.after, reason = side === 'original' ? row.beforeReason : row.afterReason;
          const cell = $('mn' + id + suffix);
          setText(cell, value === null ? '—' : String(value));
          cell.setAttribute('aria-label', value === null ? `${row.label}: unavailable. ${reason}` : `${row.label}: ${value}`);
          if (s.result && value === null) reasons.push(`${row.label}, ${suffix.toLowerCase()}: ${reason}`);
          if (row.limit !== null) {
            const over = side === 'original' ? row.beforeOver : row.afterOver;
            const budget = $('mn' + id + suffix + 'Limit');
            setText(budget, value === null ? '' : over ? `Over limit by ${value - row.limit}` : 'Within limit');
            budget.dataset.tone = over ? 'warn' : '';
          }
        }
        setText($('mn' + id + 'Change'), row.change);
        $('mn' + id + 'Change').dataset.tone = row.delta.direction === 'increase' ? 'warn' : '';
      }
      setText($('mnMetricReasons'), reasons.join(' ')); $('mnMetricReasons').hidden = !reasons.length;
      renderDiagnostics(s);
      // Dedicated output actions await MIN-08 content/preservation validation.
      $('mnCopy').disabled = true; $('mnDownload').disabled = true;
    }
    const provenance = (value) => ['In-memory source', 'Local file', 'Pasted Lua', 'Code Editor', 'Project folder'].includes(value) ? value : 'In-memory source';
    const inputStatus = (text, tone = '') => { $('mnInputStatus').textContent = text; $('mnInputStatus').dataset.tone = tone; };
    function commit(prepared, from) {
      const previous = input, previousOrigin = origin, previousStale = editorStale;
      input = prepared; origin = provenance(from); editorStale = false;
      try { adapter.setSource(prepared?.source || null); }
      catch (err) { input = previous; origin = previousOrigin; editorStale = previousStale; throw err; }
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
        if (prepared.editor && !editorSource?.isCurrent(prepared.editor.identity)) {
          inputStatus('Code Editor changed before the handoff completed. Choose Use current editor again.', 'warn'); return;
        }
        commit(prepared, from);
        inputStatus(`Loaded ${prepared.source.entryPath} · ${from}. Lua syntax is checked when you choose Optimize.`);
        return true;
      } catch (err) {
        if (live()) inputStatus(`Input not loaded: ${err.code ? err.message : 'The file could not be read. Choose it again.'} Current source and result kept.`, 'error');
      } finally {
        if (ticket === intakeSerial) { intakePending = false; render(adapter.getState()); }
      }
    }
    async function useEditor({ navigate = false } = {}) {
      if (!editorStatus().available) {
        cancelIntake(); inputStatus(editorStatus().reason, 'warn'); render(adapter.getState());
        if (navigate) app.showMessage?.('Minifier', editorStatus().reason);
        return false;
      }
      let captured = null, problem = null;
      const loaded = await replaceFrom(async (live) => {
        try {
          captured = editorSource.getSnapshot();
          if (!captured) return null;
          const project = await editorSource.getProjectSnapshot(captured, { live });
          return Object.freeze({ ...Core.prepareInput(project.source), editor: captured, project });
        } catch (err) { problem = err; throw err; }
      }, 'Code Editor');
      if (loaded) {
        if (navigate) app.setWorkspace?.('minifier');
        if (adapter.getState().enginePhase === 'cold' && !needsLocalSetup(adapter.getState())) swallow(() => adapter.initialize());
      } else if (navigate && problem) app.showMessage?.('Minifier', problem.message, 'error');
      else if (navigate && captured && !editorSource.isCurrent(captured.identity)) app.toast?.('Code Editor changed before the handoff completed. Choose Minify again.', 'warn');
      return loaded === true;
    }
    function returnToEditor() {
      if (!input?.editor || !editorSource) return;
      app.setWorkspace?.('code'); editorSource.focusCurrent();
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
      'mn-use-editor': () => useEditor(), 'mn-return-editor': returnToEditor,
      'mn-optimize': () => { if (!invalidateEditor() && !editorStale && !intakePending && Core.describe(adapter.getState()).canOptimize) return swallow(() => adapter.optimize()); },
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
    const onDiagnosticFilter = (e) => {
      const b = e.target.closest('[role=radio]');
      if (b && ['all', 'error', 'warning', 'info'].includes(b.dataset.value)) { diagnosticFilter = b.dataset.value; renderDiagnostics(adapter.getState()); }
    };
    const onResize = () => { if (!explicitMode) setMode(media.matches ? 'compare' : 'original', false); };
    $('mnCompareMode').addEventListener('click', onView);
    $('mnProfile').addEventListener('click', onProfile);
    $('mnTarget').addEventListener('change', onTarget);
    $('mnDiagnosticFilter').addEventListener('click', onDiagnosticFilter);
    media.addEventListener('change', onResize);
    const unsubscribe = adapter.subscribe(render);
    const unsubscribeEditor = editorSource?.subscribe(() => { if (!disposed && !invalidateEditor()) render(adapter.getState()); }) || (() => {});
    setMode(mode, false); render(adapter.getState());
    return Object.freeze({
      load(snapshot, { provenance = 'In-memory source' } = {}) {
        const prepared = Core.prepareInput(snapshot);
        cancelIntake(); commit(prepared, provenance);
        inputStatus(snapshot ? 'Source snapshot loaded. Original files unchanged.' : 'Source cleared.');
      },
      getInput: () => currentInput(adapter.getState()), useEditor,
      getState: adapter.getState, initialize: () => swallow(() => adapter.initialize()), setMode,
      cancel() { cancelIntake(); return adapter.cancel(); },
      dispose() {
        disposed = true; cancelIntake();
        unsubscribeEditor();
        unsubscribe(); media.removeEventListener('change', onResize);
        $('mnCompareMode').removeEventListener('click', onView);
        $('mnProfile').removeEventListener('click', onProfile);
        $('mnTarget').removeEventListener('change', onTarget);
        $('mnDiagnosticFilter').removeEventListener('click', onDiagnosticFilter);
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
    desc: 'Use the live Code Editor buffer, open .p8 / .lua files or paste Lua, then compare local Shrinko8 output with Minimal profile and Tokens focus. Original files are unchanged; dedicated exports follow separately.',
    tags: ['minify', 'optimize', 'tokens', 'shrinko8', 'lua', 'cartridge'] });
  const view = P8Minifier.mount({ root, adapter: P8MinifierEngine.create(), app: App, media: matchMedia('(min-width: 1200px)'), editorSource: S.codeSource });
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

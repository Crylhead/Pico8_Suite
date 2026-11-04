// Native Minifier: immutable intake, truthful reports and revision-bound source locations.
'use strict';
const P8Minifier = (() => {
  const Core = typeof P8MinifierCore !== 'undefined' ? P8MinifierCore : require('./minifier-core.js');
  const Export = typeof P8MinifierExport !== 'undefined' ? P8MinifierExport : require('./minifier-export-core.js');
  const Lua = typeof P8Code !== 'undefined' ? P8Code : require('./code-core.js');
  const SYNTAX_LIMIT = 200000; // characters; larger text stays plain so rendering never stalls the page
  const PROFILE_TEXT = {
    minimal: 'Minimal keeps variable names and line breaks to make the result easier to debug. It may still change expressions, comments, and spacing.',
    safe: 'Safe also renames variables (locals and globals, never PICO-8 callbacks or built-ins) and removes spaces and line breaks, using only changes Shrinko8 considers always safe. Table field names are kept.',
    aggressive: 'Aggressive also allows changes Shrinko8 cannot prove safe. Rename aggressively also renames table fields, so code that reaches fields or globals through strings (t["name"], _ENV) breaks; Reorder aggressively reorders statements more freely. Test the result in PICO-8.',
  };
  const FOCUS_TEXT = {
    balanced: 'Balanced reduces tokens, characters and compressed size without favoring one.',
    tokens: 'Focusing on tokens may leave character or compressed size unchanged—or increase them.',
    chars: 'Focusing on characters may leave tokens or compressed size unchanged—or increase them.',
    compressed: 'Focusing on compressed size may leave tokens or characters unchanged—or increase them.',
    'tokens-chars': 'Focusing on tokens and characters may leave compressed size unchanged—or increase it.',
    'tokens-compressed': 'Focusing on tokens and compressed size may leave characters unchanged—or increase them.',
  };
  function mount({ root, adapter, app, media, protocol = globalThis.location?.protocol, editorSource = null, clipboard = globalThis.navigator?.clipboard }) {
    const $ = (id) => root.querySelector('#' + id);
    const radios = (id) => [...$(id).querySelectorAll('[role=radio]')];
    let mode = media.matches ? 'compare' : 'original', explicitMode = false;
    let origin = 'In-memory source', previousDiagnostics = null, input = null;
    let diagnosticFilter = 'all', renderedDiagnostics = null, renderedFilter = null, renderedDiagnosticJob = null;
    let intakeSerial = 0, intakePending = false, disposed = false;
    let editorStale = false;
    let validationState = null, validationInput = null, validation = null, exportPending = false, pngPending = false, exportReport = null;
    function exportCheck(s = adapter.getState()) {
      if (validationState !== s || validationInput !== input) {
        validationState = s; validationInput = input; validation = Export.inspect(s, currentInput(s));
      }
      return validation;
    }
    function reportExport(text, tone = '') { exportReport = { state: adapter.getState(), text, tone }; render(adapter.getState()); }
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
    // #147: an aria-hidden highlighted copy sits behind each read-only textarea. The textarea stays
    // the accessible plain-text control (selection, copy, focus, diagnostics); its text is drawn
    // transparent only while the copy is current. Runs become text nodes, never markup.
    const painted = new Map();
    function followScroll(area, layer) {
      const code = layer.children[0];
      if (code && code.style) code.style.transform = `translate(${-area.scrollLeft || 0}px, ${-area.scrollTop || 0}px)`;
    }
    function paintSyntax(paneId, area, layerId) {
      const pane = $(paneId), layer = $(layerId);
      const text = area.value;
      if (painted.get(layerId) === text) return;
      painted.set(layerId, text);
      if (!text || text.length > SYNTAX_LIMIT) { layer.replaceChildren(); pane.dataset.syntax = 'off'; return; }
      try {
        const doc = root.ownerDocument;
        const code = doc.createElement('code');
        for (const [cls, part] of Core.syntaxRuns(text, Lua.lex)) {
          if (!cls) { code.append(part); continue; }
          const span = doc.createElement('span');
          span.className = cls;
          span.textContent = part;
          code.append(span);
        }
        layer.replaceChildren(code);
        pane.dataset.syntax = 'on';
        followScroll(area, layer);
      } catch (error) {
        layer.replaceChildren();
        pane.dataset.syntax = 'off'; // plain text remains fully readable
        app?.diagnostics?.report?.('minifier', 'E_SYNTAX_VIEW', error);
      }
    }
    for (const [areaId, layerId] of [['mnSourceCode', 'mnSourceHl'], ['mnOutputCode', 'mnOutputHl']]) {
      const area = $(areaId), layer = $(layerId);
      area.addEventListener('scroll', () => followScroll(area, layer));
    }
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
        empty: 'No source loaded.', loading: 'Loading Minifier engine…', running: 'Optimizing…',
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
      paintSyntax('mnSourcePane', $('mnSourceCode'), 'mnSourceHl');
      paintSyntax('mnOutputPane', $('mnOutputCode'), 'mnOutputHl');
      $('mnSourceStorage').textContent = s.source ? 'In-memory snapshot · not saved to a file or Library. Original files unchanged.' : 'Open a .p8 / .lua file or paste Lua to begin.';
      $('mnOutputState').textContent = !s.result ? 'No result.' : current ? 'Current result · generated build copy.' : 'Stale result · this is an earlier snapshot.';
      $('mnOutputState').dataset.tone = s.result && !current ? 'warn' : '';
      $('mnOutputPane').dataset.stale = String(!!s.result && !current);
      setText($('mnStatus'), statusText(s, rows));
      $('mnStatus').dataset.tone = localSetup || editorStale || reportWarning ? 'warn' : ['error', 'unsupported'].includes(s.status) ? 'error' : ['cancelled', 'stale'].includes(s.status) ? 'warn' : ['success', 'unchanged'].includes(s.status) ? 'ok' : '';
      actionButtons('mn-optimize', editorStale || intakePending || localSetup || !controls.canOptimize);
      actionButtons('mn-cancel', !controls.busy && !intakePending && !pngPending);
      for (const b of root.ownerDocument.querySelectorAll('[data-action="mn-cancel"]')) b.textContent = intakePending ? 'Cancel input' : 'Cancel';
      actionButtons('mn-retry', intakePending || controls.busy || localSetup);
      $('mnOptimize').setAttribute('aria-busy', String(controls.busy));
      $('mnProgress').hidden = !controls.busy && !pngPending;
      $('mnTarget').disabled = controls.busy;
      setValue($('mnTarget'), s.options.target);
      for (const b of radios('mnProfile')) {
        b.disabled = controls.busy;
        b.setAttribute('aria-checked', String(b.dataset.value === s.options.profile));
      }
      // #164: Minimal always keeps linebreaks; the rename/reorder switches only apply to Aggressive.
      const minimal = s.options.profile === 'minimal', aggressive = s.options.profile === 'aggressive';
      $('mnKeepLines').checked = minimal || s.options.keepLines;
      $('mnKeepLines').disabled = controls.busy || minimal;
      $('mnAggressiveOptions').hidden = !aggressive;
      $('mnRenameAggressive').checked = s.options.renameAggressive;
      $('mnReorderAggressive').checked = s.options.reorderAggressive;
      $('mnRenameAggressive').disabled = $('mnReorderAggressive').disabled = controls.busy;
      setText($('mnModeText'), PROFILE_TEXT[s.options.profile] || '');
      setText($('mnSupported'), FOCUS_TEXT[s.options.target] || '');
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
      const checked = exportCheck(s), enabled = checked.ok && !editorStale && !intakePending && !exportPending && !disposed;
      actionButtons('mn-copy', !enabled); actionButtons('mn-download', !enabled);
      const budgets = checked.ok ? checked.artifacts.budgets : null;
      const preservation = checked.ok && checked.artifacts.cart ? 'Cartridge data/format preservation checks passed.' : 'Lua/source consistency checks passed.';
      setText($('mnExportValidation'), editorStale ? 'Earlier editor snapshot. Refresh and optimize before exporting.' : checked.ok ? `${preservation} ${budgets.textOver ? 'Over-budget debugging output: token/character limits are exceeded.' : 'Tokens and characters are within limits; PNG compression is checked separately.'} These checks do not establish runtime compatibility.` : checked.reason);
      $('mnExportValidation').dataset.tone = checked.ok && !editorStale ? budgets.warnings.length ? 'warn' : 'ok' : s.result ? checked.code === 'E_EXPORT_STALE' || editorStale ? 'warn' : 'error' : '';
      const exportWarnings = checked.ok ? [...budgets.warnings, ...checked.artifacts.warnings] : [];
      setText($('mnExportWarnings'), exportWarnings.join(' '));
      $('mnExportWarnings').hidden = !exportWarnings.length;
      setText($('mnExportStatus'), exportReport?.state === s ? exportReport.text : '');
      $('mnExportStatus').dataset.tone = exportReport?.state === s ? exportReport.tone : '';
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
    function exportCapture() {
      if (invalidateEditor() || editorStale || intakePending || disposed) throw Core.error('E_EXPORT_STALE', 'Source changed or input is pending. Refresh and optimize before exporting.');
      const state = adapter.getState(), checked = exportCheck(state);
      if (!checked.ok) throw Core.error(checked.code, checked.reason);
      return { result: state.result, sourceRevision: state.sourceRevision, optionsRevision: state.optionsRevision, artifacts: checked.artifacts };
    }
    function captureCurrent(capture) {
      invalidateEditor();
      const now = adapter.getState();
      return !disposed && !root.hidden && !editorStale && !intakePending && Core.canExport(now) && capture.result === now.result && capture.sourceRevision === now.sourceRevision && capture.optionsRevision === now.optionsRevision;
    }
    function restoreExportFocus(opener) {
      const doc = root.ownerDocument, active = doc.activeElement;
      // Export renders disable the opener before the shared modal captures/restores it.
      // Restore after re-enabling, without stealing focus from later user navigation/dialogs.
      if (disposed || root.hidden || !root.contains(opener) || doc.querySelector?.('dialog[open]') || (active && active !== doc.body && active !== opener)) return;
      const usable = (node) => node?.isConnected && !node.disabled && node.getClientRects().length;
      const target = usable(opener) ? opener : $('mnOpen');
      if (usable(target)) target.focus({ preventScroll: true });
    }
    async function copyLua() {
      if (exportPending) return;
      let capture;
      try { capture = exportCapture(); } catch (err) { reportExport(err.message, 'error'); return; }
      const opener = root.ownerDocument.activeElement;
      exportPending = true; reportExport('Copying optimized Lua…');
      try {
        if (!clipboard?.writeText) throw Core.error('E_CLIPBOARD', 'Clipboard access is unavailable. Select the read-only optimized Lua and copy it with your keyboard.');
        await clipboard.writeText(capture.artifacts.lua.text);
        if (disposed) return;
        const current = captureCurrent(capture);
        reportExport(current ? 'Copied optimized Lua · build copy. Original source unchanged.' : 'Copied the captured earlier build. Source changed meanwhile; refresh before exporting again.', current ? 'ok' : 'warn');
      } catch (_) { if (!disposed) reportExport('Copy failed: clipboard access is unavailable or denied. Select the read-only optimized Lua and copy it with your keyboard.', 'error'); }
      finally { exportPending = false; pngPending = false; if (!disposed) { render(adapter.getState()); restoreExportFocus(opener); } }
    }
    async function downloadBuild() {
      if (exportPending) return;
      let capture;
      try { capture = exportCapture(); } catch (err) { reportExport(err.message, 'error'); return; }
      const opener = root.ownerDocument.activeElement;
      exportPending = true; reportExport('Choose a build-copy download. Original source unchanged.');
      try {
        const { artifacts } = capture, { budgets } = artifacts;
        const pngEncoder = !!artifacts.cart && adapter.getState().engine?.capabilities.png && typeof adapter.exportPng === 'function';
        const pngAvailable = pngEncoder && !budgets.pngBlocked;
        const pngReason = !artifacts.cart ? 'PNG needs a complete .p8 source cartridge.' : !pngEncoder ? 'PNG unavailable: optional local encoder is missing. Text/Lua exports remain available.' : budgets.pngBlocked ? 'PNG blocked by the code budgets listed above. Lua and text .p8 debugging copies remain available.' : 'PNG carries cartridge code, ROM and label. Text-only metadata is not retained. Code capacity is checked before download.';
        const budgetNotice = budgets.warnings.length ? '\n\nCode budget warning:\n' + budgets.warnings.join('\n') + (budgets.textOver && artifacts.cart ? `\n${artifacts.cart.filename} exceeds PICO-8 token/character limits. Choose Download .p8 for debugging only to retain an inspection copy; it is not a compatible build.` : '') : '';
        const choice = await app.modal({ title: 'Download optimized build copy',
          body: `Downloads a separate generated artifact, never a project Save. Keep the original editable source.${artifacts.cart ? ' The .p8 retains the original header and all non-Lua text exactly.' : ' Lua input has no complete source cartridge; only .lua is offered.'}${budgetNotice}${artifacts.warnings.length ? '\n\n' + artifacts.warnings.join('\n') : ''}\n\n${pngReason}`,
          buttons: [{ label: 'Cancel', value: null }, { label: `Download ${artifacts.lua.filename}`, value: 'lua', primary: !artifacts.cart || budgets.textOver }, ...(artifacts.cart ? [{ label: budgets.textOver ? 'Download .p8 for debugging only' : `Download ${artifacts.cart.filename}`, value: budgets.textOver ? 'cart-debug' : 'cart', primary: !budgets.textOver }] : []), ...(pngAvailable ? [{ label: `Download ${artifacts.cart.filename}.png`, value: 'png' }] : [])] });
        if (disposed) return;
        if (!choice) { reportExport('Download cancelled. Original source unchanged.'); return; }
        if (!captureCurrent(capture)) throw Core.error('E_EXPORT_STALE', 'Source or result changed while choosing a download. Optimize the current source again; nothing was downloaded.');
        if (choice === 'png' && pngAvailable) {
          pngPending = true; reportExport('Encoding and verifying PNG cartridge…');
          const png = await adapter.exportPng(artifacts.cart.text);
          if (!captureCurrent(capture)) throw Core.error('E_EXPORT_STALE', 'Source or result changed during PNG generation. Nothing was downloaded.');
          const bytes = Uint8Array.from(atob(png.base64), (c) => c.charCodeAt(0));
          if (bytes.length !== png.pngBytes) throw Core.error('E_PNG_INVALID', 'PNG byte length does not match the verified result. Nothing was downloaded.');
          const filename = artifacts.cart.filename + '.png';
          app.download(bytes, filename, 'image/png');
          reportExport(`Download requested: ${filename} · build copy. Compressed code: ${png.compressedBytes} bytes (must be <${png.compressedBudgetExclusive}); PNG image: ${png.pngBytes} bytes. Original source unchanged.`, 'ok');
          return;
        }
        if (choice === 'cart' && budgets.textOver) throw Core.error('E_EXPORT_BUDGET', 'This cart exceeds PICO-8 code budgets. Use the explicit debugging-copy choice; nothing was downloaded.');
        const debugCart = choice === 'cart-debug' && budgets.textOver;
        const artifact = choice === 'lua' ? artifacts.lua : (choice === 'cart' || debugCart) ? artifacts.cart : null;
        if (!artifact) throw Core.error('E_EXPORT_INVALID', 'Choose an available build format.');
        app.download(artifact.text, artifact.filename, artifact.type);
        reportExport(`Download requested: ${artifact.filename} · ${debugCart ? 'over-budget debugging copy; not a PICO-8-compatible build' : 'build copy'}. Browser download controls completion; original source is unchanged.`, debugCart ? 'warn' : 'ok');
      } catch (err) { if (!disposed) reportExport(err.code ? err.message : 'Download failed. The browser could not start the build-copy download. Original source unchanged.', 'error'); }
      finally { exportPending = false; pngPending = false; if (!disposed) { render(adapter.getState()); restoreExportFocus(opener); } }
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
      'mn-copy': copyLua, 'mn-download': downloadBuild,
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
    const onSwitch = (e) => {
      const key = { mnKeepLines: 'keepLines', mnRenameAggressive: 'renameAggressive', mnReorderAggressive: 'reorderAggressive' }[e.target?.id];
      if (key && !e.target.disabled) adapter.setOptions({ [key]: !!e.target.checked });
    };
    const onDiagnosticFilter = (e) => {
      const b = e.target.closest('[role=radio]');
      if (b && ['all', 'error', 'warning', 'info'].includes(b.dataset.value)) { diagnosticFilter = b.dataset.value; renderDiagnostics(adapter.getState()); }
    };
    const onResize = () => { if (!explicitMode) setMode(media.matches ? 'compare' : 'original', false); };
    $('mnCompareMode').addEventListener('click', onView);
    $('mnProfile').addEventListener('click', onProfile);
    $('mnTarget').addEventListener('change', onTarget);
    for (const id of ['mnKeepLines', 'mnRenameAggressive', 'mnReorderAggressive']) $(id).addEventListener('change', onSwitch);
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
        for (const id of ['mnKeepLines', 'mnRenameAggressive', 'mnReorderAggressive']) $(id).removeEventListener('change', onSwitch);
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
    desc: 'Use the live Code Editor buffer, open .p8 / .lua files or paste Lua, then compare local Shrinko8 output (Minimal, Safe or Aggressive; tokens, characters or compressed size). Copy validated Lua or download a separate .lua/.p8 build copy. Original files are unchanged.',
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

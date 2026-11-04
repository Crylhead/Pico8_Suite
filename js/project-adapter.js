// js/project-adapter.js
// "Use the active project" strip for Code Editor, Project Audit and Data Carts (UX issue #56).
// Consumes the read-only context (P8App.projectContext, js/project-context-core.js, #55).
//
// - Opt-in only: nothing is adopted automatically. Each tool keeps its own folder picker and its
//   import / drop modes, which also work in browsers without the File System Access API.
// - A tool that adopts the project switches only its own folder/scan. It never writes, and the
//   adapter never touches another tool's documents (a Code Editor document stays open and unsaved
//   edits stay in memory).
// - Access is verified (context.check()) right before adopting. A lapsed permission offers
//   "Reconnect and use" (a click, so the browser may ask); denied or stale handles say what to do.
// - The strip always states whether the tool is working on the project, on its own folder, or on none.
//
// mount(host, { tool, adopt(handle, name) -> Promise<boolean|void>, confirm?: () -> Promise<boolean> })
//   returns { setMode('independent'|'adopted', name), refresh() }

'use strict';

(() => {
  const App = window.P8App;
  const { el } = App;
  const ctx = App.projectContext;
  const pub = App.projectContextPublisher;

  function mount(host, { tool, adopt, confirm }) {
    const text = el('span', { className: 'project-strip-text' });
    const btn = el('button', { type: 'button', className: 'btn btn-sm', hidden: true });
    const strip = el('div', { className: 'project-strip', attrs: { role: 'group', 'aria-label': 'Active project' } }, text, btn);
    host.prepend(strip);

    let mode = 'independent';
    let adoptedName = '';
    let adoptedId = null;
    let ownName = '';
    let busy = false;

    function describe() {
      const p = ctx.get();
      const own = mode === 'adopted' ? `Working on ${adoptedId === p.id ? 'the active' : 'a previously adopted'} project “${adoptedName}”.` : (ownName ? `Working on its own folder “${ownName}”.` : 'No project folder open in this tool.');
      if (p.access === 'none') return { msg: own, action: null };
      const same = mode === 'adopted' && adoptedId === p.id;
      if (same && p.access === 'granted') return { msg: `${own} Independent of other tools’ documents.`, action: null };
      switch (p.access) {
        case 'granted': return { msg: `${own} Active project: “${p.name}” (from ${p.source}).`, action: `Use “${p.name}”` };
        case 'prompt': return { msg: `${own} Active project “${p.name}” needs access again.`, action: `Reconnect and use “${p.name}”` };
        case 'denied': return { msg: `${own} Access to “${p.name}” was denied or revoked. Choose “Reconnect” in ${p.source} or pick the folder here.`, action: null };
        case 'stale': return { msg: `${own} The folder of “${p.name}” is no longer available. Choose it again in ${p.source}, or pick a folder here.`, action: null };
        default: return { msg: `${own} Active project: “${p.name}” (name only: this browser gives no folder access; use the folder or file picker here).`, action: null };
      }
    }

    function refresh() {
      const d = describe();
      text.textContent = d.msg;
      btn.hidden = !d.action;
      btn.disabled = busy;
      if (d.action) { btn.textContent = d.action; btn.setAttribute('aria-label', `${d.action} in ${tool}`); }
    }

    async function use() {
      if (busy) return;
      busy = true; refresh();
      try {
        let p = ctx.get();
        if (p.access === 'prompt') p = await pub.reconnect(); // inside the click: the browser may ask
        else p = await ctx.check();
        if (p.access !== 'granted' || !p.handle) { App.toast(p.message, 'warn'); return; }
        if (confirm && !(await confirm(p))) return;      // e.g. the tool holds work this would replace
        const ok = await adopt(p.handle, p.name);
        if (ok === false) return;
        mode = 'adopted'; adoptedName = p.name; adoptedId = p.id; ownName = '';
      } catch (err) {
        App.diagnostics?.report(tool, 'E_PROJECT_ADOPT', err, 'adopting project');
        App.toast(`${tool} could not use the project: ${err && err.message ? err.message : 'unknown error'}. Nothing was changed.`, 'warn');
      } finally { busy = false; refresh(); }
    }

    btn.addEventListener('click', use);
    document.addEventListener('p8:projectcontext', refresh);
    refresh();
    return {
      /** the tool opened a folder on its own: say so, the shared project stays unchanged */
      setMode(m, name = '') { mode = m; adoptedId = m === 'adopted' ? ctx.get().id : null; adoptedName = m === 'adopted' ? name : ''; ownName = m === 'independent' ? name : ''; refresh(); },
      refresh,
    };
  }

  window.P8ProjectAdapter = { mount };
})();

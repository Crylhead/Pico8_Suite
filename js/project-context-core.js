// js/project-context-core.js
// Optional, explicit, read-only "active project" reference (UX issue #55). create() has no DOM and
// runs in Node (tests/project-context.test.js); js/app.js exposes it as P8App.projectContext.
//
// - The context only *names* a project folder: display name, source tool, root handle (when the
//   browser has one) and an access state. It owns no files, writes nothing, scans nothing and
//   never loads a project by itself. Tools may ignore it completely (standalone workflows).
// - Consumers use `context` (get, check, subscribe). Tools that open a project use `publisher`
//   (select, clear, markAccess, remember, restore). Consumers cannot select or clear.
// - Access is never trusted from the past: check() re-queries the handle each time it matters.
//   States: 'none' (no project), 'granted', 'prompt' (needs the user to reconnect), 'denied',
//   'stale' (the handle no longer works), 'unsupported' (no handle API: name only).
// - After a reload only { name, source, handle } is remembered (kv, same origin) and restored
//   as 'prompt' until permission is verified. Nothing falls back to another folder.

'use strict';

const P8ProjectContext = (() => {
  const KV_KEY = 'projectContext.v1';

  const ACCESS = Object.freeze(['none', 'granted', 'prompt', 'denied', 'stale', 'unsupported']);
  const MESSAGES = Object.freeze({
    none: 'No active project.',
    granted: 'Folder access is available.',
    prompt: 'Folder access must be granted again. Open the tool that owns the project and choose Reconnect.',
    denied: 'Folder access was denied or revoked. Reconnect to use the project again.',
    stale: 'The remembered folder is no longer available. Choose the project folder again.',
    unsupported: 'This browser gives no folder handle; the project is known by name only.',
  });

  /**
   * Permission belongs to the handle, not to the folder: a moved, renamed or deleted folder still answers
   * "granted" (#68). With access granted, reading one entry (or the file) proves the folder is still there;
   * a failure means it is gone ('stale'). Handles without these methods are not probed.
   */
  const canProbe = (handle) => typeof handle.entries === 'function' || typeof handle.getFile === 'function';
  async function stillThere(handle) {
    try {
      if (typeof handle.entries === 'function') { for await (const entry of handle.entries()) { void entry; break; } } else if (typeof handle.getFile === 'function') await handle.getFile();
      return true;
    } catch { return false; }
  }

  async function queryAccess(handle, mode = 'readwrite') {
    if (!handle) return 'unsupported';
    if (typeof handle.queryPermission !== 'function') return 'unsupported';
    try {
      const r = await handle.queryPermission({ mode });
      if (r === 'granted') return !canProbe(handle) || (await stillThere(handle)) ? 'granted' : 'stale';
      return r === 'denied' ? 'denied' : 'prompt';
    } catch { return 'stale'; }
  }

  /** kv: { get(key), set(key, value) } (Suite.kv) or null. now/clock are not needed: no timestamps. */
  function create({ kv = null, mode = 'readwrite' } = {}) {
    let project = null;       // { name, source, handle, access, id }
    let seq = 0;
    let intent = 0; // latest select/clear wins, even while an older permission query is pending
    let persistence = Promise.resolve();
    const listeners = new Set();

    const describe = (p) => (p ? Object.freeze({
      id: p.id, name: p.name, source: p.source, handle: p.handle || null,
      access: p.access, message: MESSAGES[p.access],
    }) : Object.freeze({ id: 0, name: '', source: '', handle: null, access: 'none', message: MESSAGES.none }));

    function emit(type, previous) {
      const detail = Object.freeze({ type, project: describe(project), previous: describe(previous) });
      for (const fn of [...listeners]) {
        try { fn(detail); } catch (e) { if (typeof console !== 'undefined') console.error(e); }
      }
    }

    const persist = async (p) => {
      if (!kv) return false;
      const record = p ? { name: p.name, source: p.source, handle: p.handle || null } : null;
      persistence = persistence.then(() => kv.set(KV_KEY, record)).then(() => true, () => false);
      return persistence;
    };

    const context = {
      /** frozen snapshot; `access` is the last known state, call check() before relying on it */
      get: () => describe(project),
      /** re-queries the handle now; updates and announces the state if it changed */
      async check() {
        const p = project;
        if (!p) return describe(null);
        const access = await queryAccess(p.handle, mode);
        if (project === p && access !== p.access) {
          const previous = project;
          project = { ...p, access };
          emit('access', previous);
        }
        return describe(project);
      },
      /** fn(detail) with detail { type: 'select'|'replace'|'clear'|'access', project, previous } -> unsubscribe */
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };

    const publisher = {
      /** the tool opened a project. Same handle again only refreshes access (no duplicate event). */
      async select({ name, source, handle = null }) {
        if (!name || !source) throw new TypeError('select() needs name and source');
        const ticket = ++intent;
        const access = await queryAccess(handle, mode);
        if (ticket !== intent) return context.get();
        const previous = project;
        let same = !!(previous && previous.handle && handle && previous.source === source);
        if (same && previous.handle !== handle) {
          // a handle restored from storage is a different object for the same folder
          try { same = typeof handle.isSameEntry === 'function' ? !!(await handle.isSameEntry(previous.handle)) : false; } catch { same = false; }
        }
        if (ticket !== intent || project !== previous) return context.get();
        if (same) {
          if (previous.access !== access || previous.name !== name) {
            project = { ...previous, name, access };
            emit('access', previous);
          }
          return context.get();
        }
        project = { id: ++seq, name: String(name), source: String(source), handle, access };
        emit(previous ? 'replace' : 'select', previous);
        await persist(project);
        return context.get();
      },
      /** only the tool that published the project may clear it (or any tool with source omitted) */
      async clear(source) {
        if (source && (!project || project.source !== source)) return false;
        ++intent;
        if (!project) { await persist(null); return false; }
        const previous = project;
        project = null;
        emit('clear', previous);
        await persist(null);
        return true;
      },
      /** the owner learned the access state itself (e.g. permission just granted or refused) */
      markAccess(source, access) {
        if (!ACCESS.includes(access) || access === 'none') throw new TypeError(`Invalid access ${access}`);
        if (!project || project.source !== source || project.access === access) return false;
        const previous = project;
        project = { ...project, access };
        emit('access', previous);
        return true;
      },
      /**
       * Asks the browser for permission (call from a user gesture). Cancel or refusal keeps the
       * project and reports 'prompt'/'denied'; it never selects another folder.
       */
      async reconnect() {
        const p = project;
        if (!p || !p.handle || typeof p.handle.requestPermission !== 'function') return context.get();
        let access;
        try {
          const r = await p.handle.requestPermission({ mode });
          // granted for a folder that no longer exists is still unusable (#68)
          access = r === 'granted' ? (!canProbe(p.handle) || (await stillThere(p.handle)) ? 'granted' : 'stale') : r === 'denied' ? 'denied' : 'prompt';
        } catch (err) { access = err && err.name === 'AbortError' ? 'prompt' : 'stale'; }
        if (project === p && access !== p.access) {
          const previous = project;
          project = { ...p, access };
          emit('access', previous);
        }
        return context.get();
      },
      /**
       * After a reload: the remembered reference comes back with its handle but never as
       * 'granted' without a fresh query. Does nothing if a project is already active.
       */
      async restore() {
        if (project || !kv) return context.get();
        const ticket = intent;
        let rec = null;
        try { rec = await kv.get(KV_KEY); } catch { return context.get(); }
        if (ticket !== intent || project || !rec || typeof rec !== 'object' || !rec.name || !rec.source) return context.get();
        const access = rec.handle ? await queryAccess(rec.handle, mode) : 'unsupported';
        if (ticket !== intent || project) return context.get();
        project = { id: ++seq, name: String(rec.name), source: String(rec.source), handle: rec.handle || null, access };
        emit('select', null);
        return context.get();
      },
    };

    return { context, publisher };
  }

  return { create, MESSAGES, ACCESS, KEY: KV_KEY };
})();

if (typeof module !== 'undefined') module.exports = P8ProjectContext;

// js/doc-status-core.js
// Shared save / operation status contract for editor documents (UX issue #58).
// create() and describe() have no DOM and run in Node (tests/doc-status.test.js); mount() is the
// small DOM badge adapter used by workspaces.
//
// A tracker follows ONE working document at a time:
// - open() starts a new document identity (any earlier ticket becomes foreign) and revision 0.
// - edit() bumps the revision. dirty() is true until a save of the current revision is confirmed.
// - begin(target) returns a ticket bound to the document identity and revision being written.
//   Take the ticket and the data snapshot in the same synchronous step.
// - resolve(ticket) marks THAT revision saved, only for the current document and only if no newer
//   save already completed. Edits made while the save was in flight stay unsaved.
// - reject(ticket, {kind, message}) records a persistent actionable error ('failed', 'conflict'
//   or 'recovery'); it stays until a later save succeeds, dismiss() or open().
// - cancel(ticket) ends the operation without changing saved/dirty state or an existing error.
// - downloaded(name) records a download of the current revision. A download is a copy whose
//   destination the page cannot confirm; it never marks the document saved.
// - session(ticket, ok) records a background (browser session) autosave; it is not a save either.
// - lost(message) says the saved target disappeared (for example the Library asset was deleted).
// Results arriving for another document identity are ignored and return false.

'use strict';

const P8DocStatus = (() => {
  const TARGETS = {
    library: { saved: 'Saved to Library', where: 'the Library' },
    file: { saved: 'Saved to file', where: 'the file' },
    project: { saved: 'Saved to project file', where: 'the project file' },
  };
  const ERRORS = {
    failed: { icon: '✕', label: 'Save failed' },
    conflict: { icon: '⚠', label: 'Conflict' },
    recovery: { icon: '!', label: 'Recovery required' },
  };

  function create({ storage = () => 'persistent', now = () => Date.now() } = {}) {
    let seq = 0;
    let s = null;
    const listeners = new Set();
    const notify = () => { for (const fn of listeners) fn(api); };

    function open({ name = '', target = null, dirty = false } = {}) {
      s = {
        doc: { name },            // identity token: compared by reference
        name,
        revision: 0,
        clean: dirty ? -1 : 0,    // revision that matches the last confirmed target (-1: none)
        saved: target ? { target, name, revision: 0, seq: 0, at: null } : null,
        pending: null,
        error: null,
        download: null,
        session: null,
      };
      notify();
      return s.doc;
    }

    const current = (ticket) => Boolean(ticket && s && ticket.doc === s.doc);

    const api = {
      open,
      /** a change to the working document; returns the new revision */
      edit() {
        s.revision++;
        notify();
        return s.revision;
      },
      dirty: () => s.revision !== s.clean,
      doc: () => s.doc,
      revision: () => s.revision,
      pending: () => s.pending,
      error: () => s.error,
      isCurrent: current,
      /** a ticket for background work bound to this document/revision (no status change) */
      snapshot: () => ({ doc: s.doc, revision: s.revision, seq: ++seq }),

      begin(target, { intent = null, name = s.name } = {}) {
        const ticket = { doc: s.doc, revision: s.revision, target, intent, name, seq: ++seq };
        s.pending = ticket;
        notify();
        return ticket;
      },
      resolve(ticket, { target = ticket.target, name = ticket.name } = {}) {
        if (!current(ticket)) return false;
        if (s.pending === ticket) s.pending = null;
        if (s.saved && s.saved.seq > ticket.seq) { notify(); return false; }
        s.saved = { target, name, revision: ticket.revision, seq: ticket.seq, at: now() };
        s.clean = ticket.revision;
        if (s.error && s.error.seq <= ticket.seq) s.error = null;
        notify();
        return true;
      },
      reject(ticket, { kind = 'failed', message = '' } = {}) {
        if (!current(ticket)) return false;
        if (s.pending === ticket) s.pending = null;
        s.error = { kind: ERRORS[kind] ? kind : 'failed', message, intent: ticket.intent, target: ticket.target, seq: ticket.seq, at: now() };
        notify();
        return true;
      },
      cancel(ticket) {
        if (!current(ticket)) return false;
        if (s.pending === ticket) s.pending = null;
        notify();
        return true;
      },
      downloaded(name) {
        s.download = { name, revision: s.revision, at: now() };
        notify();
      },
      session(ticket, ok) {
        if (!current(ticket)) return false;
        if (s.session && s.session.seq > ticket.seq) return false;
        s.session = { ok: Boolean(ok), revision: ticket.revision, seq: ticket.seq };
        notify();
        return true;
      },
      /** the saved target is gone (deleted elsewhere): the document is unsaved again */
      lost(message = '') {
        if (!s.saved) return;
        s.saved = null;
        s.clean = -1;
        if (message) s.error = { kind: 'conflict', message, intent: null, target: null, seq: seq, at: now() };
        notify();
      },
      /** another writer changed the saved target: persistent conflict until resolved */
      conflict(message) {
        s.error = { kind: 'conflict', message, intent: null, target: s.saved?.target || null, seq: seq, at: now() };
        notify();
      },
      dismiss() { if (s.error) { s.error = null; notify(); } },
      /** re-render subscribers (for example after the storage mode became known) */
      refresh: notify,
      /** unsaved work that a closed tab would lose (memory-only, or the session autosave failed) */
      atRisk: () => api.dirty() && (storage() === 'memory' || (s.session && !s.session.ok) || false),
      state: () => ({ ...s, storage: storage(), dirty: api.dirty() }),
      describe: () => describe(api.state()),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    };
    open();
    return api;
  }

  /**
   * View model for a status display: { key, icon, label, detail, tone, actions }.
   * tone: 'ok' | 'info' | 'warn' | 'error' | 'busy' (always paired with an icon and text).
   * actions: subset of ['retry', 'dismiss'] that apply to the shown state.
   */
  function describe(st) {
    const memory = st.storage === 'memory';
    const where = (t) => TARGETS[t]?.where || 'the target';
    if (st.pending) {
      return { key: 'saving', icon: '…', label: 'Saving…', tone: 'busy', actions: [],
        detail: `Saving to ${where(st.pending.target)}. Nothing is saved until this completes.` };
    }
    if (st.error) {
      const e = ERRORS[st.error.kind];
      const tail = st.dirty ? ' Your changes are still open and not saved.' : '';
      return { key: st.error.kind, icon: e.icon, label: e.label, tone: 'error', actions: ['retry', 'dismiss'],
        detail: `${(st.error.message || e.label).replace(/\.\s*$/, '')}.${tail}` };
    }
    if (st.dirty) {
      if (st.download && st.download.revision === st.revision) {
        return { key: 'downloaded', icon: '↓', label: 'Downloaded copy', tone: 'warn', actions: [],
          detail: `${st.download.name}: download started for this version. A download is a copy (the browser decides where it goes) and is not a save; ${st.saved ? `${where(st.saved.target)} has an older version` : 'it is not in the Library'}.` };
      }
      if (memory || (st.session && !st.session.ok)) {
        return { key: 'memory', icon: '⚠', label: 'Unsaved · memory only', tone: 'warn', actions: [],
          detail: memory
            ? 'Unsaved changes are only in memory (browser storage is unavailable). Closing the tab loses them: save or export.'
            : 'Unsaved changes: the browser session autosave failed, so they are only in memory. Save or export before closing the tab.' };
      }
      return { key: 'unsaved', icon: '●', label: 'Unsaved changes', tone: 'warn', actions: [],
        detail: `Unsaved changes. The working session is kept in this browser only (not a backup)${st.saved ? `; ${where(st.saved.target)} has an older version` : ''}.` };
    }
    if (st.saved) {
      const t = TARGETS[st.saved.target] || { saved: 'Saved', where: 'the target' };
      if (memory && st.saved.target === 'library') {
        return { key: 'saved-memory', icon: '⚠', label: 'In Library · memory only', tone: 'warn', actions: [],
          detail: 'Saved to the Library, but the Library is memory-only in this session. Export the Library or download your work before closing the tab.' };
      }
      return { key: `saved-${st.saved.target}`, icon: '✓', label: t.saved, tone: 'ok', actions: [],
        detail: st.saved.target === 'library'
          ? `${t.saved}${st.saved.name ? ` as "${st.saved.name}"` : ''}. The Library is stored in this browser; export a Library backup to keep a portable copy.`
          : `${t.saved}${st.saved.name ? ` (${st.saved.name})` : ''}.` };
    }
    if (st.download && st.download.revision === st.revision) {
      return { key: 'downloaded', icon: '↓', label: 'Downloaded copy', tone: 'info', actions: [],
        detail: `${st.download.name}: download started. A download is a copy and is not a save; this document is not in the Library.` };
    }
    return { key: 'new', icon: '○', label: 'Not saved', tone: 'info', actions: [],
      detail: memory ? 'New document, kept only in memory (browser storage is unavailable).' : 'New document: not saved anywhere yet.' };
  }

  /**
   * DOM badge for a tracker. host: an empty element (it receives the class 'doc-status').
   * onRetry(intent): repeat the failed/conflicting save. details(view): optional, called by the
   * badge button (defaults to P8App.showMessage). Returns an unsubscribe function.
   */
  function mount(host, tracker, { onRetry = null, details = null, title = 'Save status' } = {}) {
    const doc = host.ownerDocument;
    const mk = (tag, cls, attrs = {}) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      return n;
    };
    host.classList.add('doc-status');
    const main = mk('button', 'doc-status-main', { type: 'button' });
    const icon = mk('span', 'doc-status-icon', { 'aria-hidden': 'true' });
    const text = mk('span', 'doc-status-text');
    main.append(icon, text);
    const live = mk('span', 'sr-only', { role: 'status' });
    const retry = mk('button', 'btn btn-sm doc-status-act', { type: 'button' });
    retry.textContent = 'Retry';
    const dismiss = mk('button', 'btn btn-ghost btn-sm doc-status-act', { type: 'button', 'aria-label': 'Dismiss save error' });
    dismiss.textContent = '✕';
    host.replaceChildren(main, retry, dismiss, live);
    let view = null;
    const show = () => {
      if (details) return details(view);
      const App = typeof window !== 'undefined' && window.P8App;
      if (App?.showMessage) App.showMessage(title, `${view.label}\n\n${view.detail}`);
    };
    main.addEventListener('click', show);
    retry.addEventListener('click', () => onRetry?.(tracker.error()?.intent ?? null));
    dismiss.addEventListener('click', () => tracker.dismiss());
    const render = () => {
      view = tracker.describe();
      host.dataset.state = view.key;
      host.dataset.tone = view.tone;
      icon.textContent = view.icon;
      text.textContent = view.label;
      main.title = `${view.detail} (click for details)`;
      main.setAttribute('aria-label', `${title}: ${view.label}. Details`);
      retry.hidden = !(onRetry && view.actions.includes('retry'));
      retry.textContent = view.key === 'conflict' ? 'Resolve…' : 'Retry';
      dismiss.hidden = !view.actions.includes('dismiss');
      // announce state changes only, not every edit of an already unsaved document
      if (live.textContent !== view.label) live.textContent = view.label;
    };
    render();
    return tracker.subscribe(render);
  }

  return { create, describe, mount, TARGETS };
})();

if (typeof module !== 'undefined') module.exports = P8DocStatus;

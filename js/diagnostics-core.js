// js/diagnostics-core.js
// Bounded, privacy-preserving local diagnostics (UX issue #62). create() has no DOM and runs in
// Node (tests/diagnostics.test.js); js/app.js installs the window hooks.
//
// - Records live only in an in-memory ring buffer. Nothing is stored, uploaded or sent.
// - Messages and stacks are sanitized deterministically and conservatively: paths, URLs, tokens,
//   e-mail addresses, long hex/base64 runs and quoted strings are replaced; fields are truncated.
// - Capture never throws: errors inside this module are swallowed.
// - A JavaScript error is not a tab crash. Hooks cannot see a crashed tab or process, and the
//   buffer is lost when the tab closes.

'use strict';

const P8Diag = (() => {
  const MAX_RECORDS = 100;
  const MAX_MESSAGE = 300;
  const MAX_STACK = 1200;
  const MAX_FIELD = 80;
  const SEVERITIES = Object.freeze(['error', 'warning', 'info']);

  /** Conservative scrubbing of arbitrary text. Deterministic: same input, same output. */
  function sanitize(text, max = MAX_MESSAGE) {
    if (text == null) return '';
    let s;
    try { s = typeof text === 'string' ? text : String(text); } catch { return '[unprintable]'; }
    s = s.slice(0, 16384)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(/\bfile:\/\/[^\r\n'\")\]>]*/gi, '[path]')             // file URLs may contain spaces
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'")\]>]*/gi, '[url]')              // URLs (incl. file:, blob:)
      .replace(/\b(?:data|blob):[^\s'")\]>]*/gi, '[url]')
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/\b[A-Za-z]:[\\/][^\r\n'")\]>:]*/g, '[path]')                  // paths may contain spaces
      .replace(/(?:^|[\s(@=])\\\\[^\r\n'")\]>]+/g, ' [path]')
      .replace(/(?:^|[\s(@=])(?:\/[\w.@~-]+){2,}[^\r\n'\")\]>]*/g, ' [path]')                  // /home/x/y
      .replace(/(?:^|[\s(@=])~\/[^\s'")\]>]*/g, ' [path]')
      .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|key|secret|password|passwd|pairing|auth|bearer|cookie)\b\s*[:=]?\s*[^\s,;]{4,}/gi, '[secret]')
      .replace(/\b[0-9a-f]{16,}\b/gi, '[hex]')
      .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[blob]')
      .replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, '"[text]"');          // quoted user strings
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
  }

  /** Stack frames reduced to "function (file.js:line:col)" with the directory removed. */
  function sanitizeStack(stack) {
    if (typeof stack !== 'string' || !stack) return '';
    const lines = stack.split('\n').slice(0, 12).map((ln) => {
      const m = /^\s*(?:at\s+)?(?:(.*?)\s*[@(])?\s*(?:[^\s()@]*[\\/])?([\w.-]+\.(?:js|mjs|html)):(\d+)(?::(\d+))?\)?\s*$/.exec(ln);
      if (!m) return '';
      const fn = sanitize(m[1] || '', 40).replace(/[()]/g, '');
      return `${fn ? `${fn} ` : ''}(${m[2]}:${m[3]}${m[4] ? `:${m[4]}` : ''})`;
    }).filter(Boolean);
    const out = lines.join('\n');
    return out.length > MAX_STACK ? `${out.slice(0, MAX_STACK)}…[truncated]` : out;
  }

  /** Stable short hash (FNV-1a) for de-duplication and the user-visible Error ID. */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36).toUpperCase().padStart(7, '0');
  }

  const token = (v, fallback) => {
    const s = sanitize(v, MAX_FIELD).replace(/[^\w.:-]+/g, '-').replace(/^-+|-+$/g, '');
    return s || fallback;
  };

  /**
   * opts: { now: () => ms, browser: string, version: string, sessionId: string }
   * All environment access is injected so the core stays testable.
   */
  function create({ now = () => Date.now(), browser = 'unknown', version = 'unknown', sessionId } = {}) {
    const session = sessionId || hash(`${now()}:${Math.random()}`).slice(0, 4);
    let records = [];
    let seq = 0;
    const lastSeen = new Map(); // dedupe key -> record

    /**
     * input: { source, severity, code, message, stack, state }
     * Returns the stored (or merged duplicate) record, or null if nothing could be captured.
     */
    function capture(input) {
      try {
        const i = input || {};
        const severity = SEVERITIES.includes(i.severity) ? i.severity : 'error';
        const source = token(i.source, 'app');
        const code = token(i.code, 'E_UNKNOWN');
        const message = sanitize(i.message);
        const stack = sanitizeStack(i.stack);
        const dedupe = `${source}|${code}|${message}|${stack.split('\n')[0] || ''}`;
        const prev = lastSeen.get(dedupe);
        if (prev && records.includes(prev)) {
          prev.count++;
          prev.last = now();
          return prev;
        }
        const rec = {
          id: `${session}-${hash(dedupe)}`,
          seq: ++seq,
          time: new Date(now()).toISOString(),
          last: now(),
          count: 1,
          severity, source, code, message, stack,
          state: sanitize(i.state, MAX_FIELD),
        };
        records.push(rec);
        lastSeen.set(dedupe, rec);
        if (records.length > MAX_RECORDS) {
          const dropped = records.splice(0, records.length - MAX_RECORDS);
          for (const [k, v] of lastSeen) if (dropped.includes(v)) lastSeen.delete(k);
        }
        return rec;
      } catch { return null; }
    }

    /** window 'error' event or a worker 'error' event. */
    function fromErrorEvent(ev, source = 'window') {
      try {
        const err = ev && ev.error;
        const name = err && err.name ? err.name : 'Error';
        return capture({
          source, code: source === 'window' ? `E_${name}` : `E_WORKER_${name}`,
          message: (err && err.message) || (ev && ev.message) || 'Script error',
          stack: err && err.stack,
        });
      } catch { return null; }
    }

    function fromRejection(ev, source = 'promise') {
      try {
        const r = ev && ev.reason;
        const isErr = r && typeof r === 'object' && ('message' in r || 'stack' in r);
        return capture({
          source, code: `E_REJECTION${isErr && r.name ? `_${r.name}` : ''}`,
          message: isErr ? r.message : (typeof r === 'string' ? r : 'Unhandled rejection'),
          stack: isErr ? r.stack : '',
        });
      } catch { return null; }
    }

    /** worker 'messageerror': a message could not be deserialized (no payload is recorded). */
    const fromMessageError = (source = 'worker') =>
      capture({ source, code: 'E_WORKER_MESSAGEERROR', message: 'A worker message could not be deserialized' });

    /** Explicit tool failure, e.g. report('terrain', 'E_TERRAIN_BUILD', err, 'rebuilding'). */
    function report(source, code, error, state) {
      try {
        const obj = error && typeof error === 'object';
        return capture({ source, code, state, message: obj ? error.message : error, stack: obj ? error.stack : '' });
      } catch { return null; }
    }

    /** Attach to a Worker: separate error and messageerror handling. Returns a detach function. */
    function watchWorker(worker, source = 'worker', onRecord = null) {
      // onRecord(record) tells the owner the Error ID so it can show it next to a Retry action (#67)
      const tell = (rec) => { try { if (onRecord && rec) onRecord(rec); } catch { /* never break the page */ } };
      const onError = (ev) => tell(fromErrorEvent(ev, source));
      const onMsgErr = () => tell(fromMessageError(source));
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onMsgErr);
      return () => { worker.removeEventListener('error', onError); worker.removeEventListener('messageerror', onMsgErr); };
    }

    /** Install window hooks. Window errors and rejections only; callable once. */
    function install(win) {
      const onErr = (ev) => {
        // Resource load failures (img/script) arrive without ev.error and without a message.
        if (!ev.error && !ev.message) return;
        fromErrorEvent(ev, 'window');
      };
      const onRej = (ev) => fromRejection(ev);
      win.addEventListener('error', onErr);
      win.addEventListener('unhandledrejection', onRej);
      return () => { win.removeEventListener('error', onErr); win.removeEventListener('unhandledrejection', onRej); };
    }

    /** Default export bundle: metadata and sanitized records only. */
    function exportBundle() {
      return {
        format: 'pico8-suite-diagnostics',
        formatVersion: 1,
        generated: new Date(now()).toISOString(),
        session,
        app: { version: sanitize(version, MAX_FIELD), browser: sanitize(browser, MAX_FIELD) },
        note: 'Sanitized, local-only error summaries. No project content, file paths or storage contents are included. '
          + 'JavaScript hooks cannot capture a crashed tab or process, and this log is lost when the tab closes.',
        records: records.map((r) => ({ ...r })),
      };
    }

    return {
      capture, report, fromErrorEvent, fromRejection, fromMessageError, watchWorker, install,
      read: () => records.map((r) => ({ ...r })),
      clear() { records = []; lastSeen.clear(); },
      exportBundle,
      exportJSON: () => JSON.stringify(exportBundle(), null, 2),
      get size() { return records.length; },
    };
  }

  /** Browser family from a user-agent string; no version or platform detail. */
  function browserFamily(ua) {
    const s = String(ua || '');
    if (/Edg\//.test(s)) return 'Edge';
    if (/Firefox\//.test(s)) return 'Firefox';
    if (/Chrome\//.test(s)) return 'Chrome';
    if (/Safari\//.test(s)) return 'Safari';
    return 'unknown';
  }

  return { create, sanitize, sanitizeStack, browserFamily, MAX_RECORDS };
})();

if (typeof module !== 'undefined') module.exports = P8Diag;

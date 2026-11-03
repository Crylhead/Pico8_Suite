// js/diagnostics-core.js
// Bounded, privacy-preserving local diagnostics (UX issue #62). create() has no DOM and runs in
// Node (tests/diagnostics.test.js); js/app.js installs the window hooks.
//
// - Records live only in an in-memory ring buffer. Nothing is stored, uploaded or sent.
// - Messages and stacks are sanitized deterministically and conservatively: paths, URLs, tokens,
//   e-mail addresses, long hex/base64 runs and quoted strings are replaced; fields are truncated.
// - Because scrubbing is best effort, the default export goes further: messages keep only an
//   allowlist of generic error words (redactMessage). Full scrubbed text is an explicit opt-in.
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

  // Allowlist for the default export (#62). Regex scrubbing above is best effort: an exception can
  // carry arbitrary unquoted user text ("Unexpected token mysecret", "foo.bar is not a function").
  // The default bundle therefore keeps only generic error words, small numbers and the redaction
  // placeholders; every other word becomes "[…]". Adding a word here must never admit user data:
  // only generic English/engine vocabulary, no identifiers or names.
  const SAFE_WORDS = new Set((
    'a an the of to in on at for from by with without into as is are was were be been not no nor or and '
    + 'but if than then this that it its can cannot could would should must may might does do did has have had '
    + 'error errors exception failed failure fail fails unable invalid unexpected unknown missing empty expected '
    + 'undefined null nan true false object function property properties method value values argument arguments '
    + 'parameter type types read reading write writing written set setting get getting assign assignment '
    + 'constant variable defined declared initialization initialized before after access accessing lexical '
    + 'declaration constructor class instance prototype iterable iterator callable reference range length '
    + 'array string number bigint symbol boolean index offset size count maximum minimum max min limit exceeded '
    + 'call calls stack too much many large small long short out over under end input output token tokens json '
    + 'syntax parse parsing position line column character characters end data '
    + 'identifier keyword statement expression operator literal regular template '
    + 'load loading loaded save saving saved open opening opened close closed create created delete deleted '
    + 'remove removed rename move copy copied decode decoding encode encoding render rendering rebuild '
    + 'file files folder folders directory path name names image images bitmap canvas palette colour colours '
    + 'color colors tile tiles map maps sprite sprites gfx sound music cart carts project projects scene '
    + 'workspace journal recovery permission permissions denied granted handle handles request requests '
    + 'worker workers message messages network fetch timeout timed aborted abort cancelled canceled '
    + 'operation operations quota storage blocked busy changed holds bytes byte data custom fades first add '
    + 'deserialized serialized clone cloned transfer script resource module import export'
  ).split(/\s+/));

  const PLACEHOLDER = /^(?:\[(?:path|url|email|secret|hex|blob|unprintable)\]|"\[text\]"|…\[truncated\])$/;

  /** Default-export form of a (sanitized) message: allowlisted words only, deterministic. */
  function redactMessage(text, max = MAX_MESSAGE) {
    const s = sanitize(text, max);
    const out = [];
    for (const part of s.split(/(\[(?:path|url|email|secret|hex|blob|unprintable)\]|"\[text\]"|…\[truncated\]|[^\w\u0080-￿["…]+)/u)) {
      if (!part) continue;
      let keep;
      if (PLACEHOLDER.test(part)) keep = part;                                                // sanitize() output
      else if (/^[^\w\u0080-￿]+$/u.test(part)) keep = part.replace(/[^\s.,:;()!?-]/g, ''); // punctuation only
      else if (/^\d{1,5}$/.test(part) || SAFE_WORDS.has(part.toLowerCase())) keep = part;
      else keep = '[…]';
      out.push(keep);
    }
    // "foo.bar baz" -> one "[…]": collapse runs of unknown words joined by punctuation/space
    return out.join('').replace(/\[…\](?:[\s.,:;()!?-]*\[…\])+/g, '[…]').replace(/\s+/g, ' ').trim();
  }

  /** Developer-supplied operation state, restricted to plain word characters for export. */
  const stateText = (v) => sanitize(v, MAX_FIELD).replace(/[^\w .:-]+/g, ' ').replace(/\s+/g, ' ').trim();

  /** Stack frames reduced to "function (file.js:line:col)" with the directory removed. */
  function sanitizeStack(stack) {
    if (typeof stack !== 'string' || !stack) return '';
    const lines = stack.split('\n').slice(0, 12).map((ln) => {
      const m = /^\s*(?:at\s+)?(?:(.*?)\s*[@(])?\s*(?:[^\s()@]*[\\/])?([\w.-]+\.(?:js|mjs|html)):(\d+)(?::(\d+))?\)?\s*$/.exec(ln);
      if (!m) return '';
      // function names must look like JS identifiers/member chains; anything else is dropped
      const raw = sanitize(m[1] || '', 40).replace(/[()]/g, '').replace(/^async\s+|^new\s+/, '');
      const fn = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$<][\w$<>]*)*$/.test(raw) ? raw : '';
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

  // Default export schema (#85): every field is either generated here, chosen from a finite list or written
  // by the app itself. Error names are mutable and a rejection reason can be any object, so a runtime name
  // is kept only when it is a JavaScript or DOMException type; anything else becomes OtherError.
  const KNOWN_NAMES = new Set(('Error TypeError RangeError SyntaxError ReferenceError EvalError URIError AggregateError InternalError '
    + 'AbortError NotAllowedError NotFoundError NotReadableError NotSupportedError QuotaExceededError SecurityError InvalidStateError '
    + 'InvalidAccessError InvalidModificationError NoModificationAllowedError TypeMismatchError DataCloneError DataError EncodingError '
    + 'NetworkError TimeoutError OperationError ConstraintError TransactionInactiveError ReadOnlyError VersionError UnknownError')
    .split(' '));
  const knownName = (n) => { try { return KNOWN_NAMES.has(String(n)) ? String(n) : 'OtherError'; } catch { return 'OtherError'; } };
  /** codes the app passes to report(): E_ plus upper-case words */
  const APP_CODE = /^E_[A-Z][A-Z0-9_]{0,40}$/;
  /** sources the app uses: 'window', 'promise', a tool id, 'worker:terrain' */
  const APP_SOURCE = /^[a-z][a-z0-9-]{0,30}(?::[a-z][a-z0-9-]{0,30})?$/;

  /**
   * Default-export stack: file:line:col for the Suite's own scripts only, without function names (a
   * function name can come from data, e.g. a computed method key). Other frames become "(other script)".
   */
  function appStack(stack, appFiles) {
    const out = [];
    for (const ln of String(stack || '').split('\n')) {
      const m = /\(([\w.-]+\.(?:js|mjs|html)):(\d+)(?::(\d+))?\)$/.exec(ln);
      if (!m) continue;
      const frame = appFiles.has(m[1].toLowerCase()) ? `${m[1]}:${m[2]}${m[3] ? `:${m[3]}` : ''}` : '(other script)';
      if (out[out.length - 1] !== frame) out.push(frame);
    }
    return out.join('\n');
  }

  /**
   * opts: { now: () => ms, browser: string, version: string, sessionId: string,
   *         appFiles: () => iterable of the Suite's own script basenames (read at export time) }
   * All environment access is injected so the core stays testable.
   */
  function create({ now = () => Date.now(), browser = 'unknown', version = 'unknown', sessionId, appFiles = () => [] } = {}) {
    const session = sessionId || hash(`${now()}:${Math.random()}`).slice(0, 4);
    let records = [];
    let seq = 0;
    const lastSeen = new Map(); // dedupe key -> record

    /**
     * input: { source, severity, code, detailCode?, message, stack, state }
     * `code` must be a safe code (APP_CODE, or built from knownName); `detailCode` is the same code with the
     * runtime error name, exported only with the full-messages opt-in.
     * Returns the stored (or merged duplicate) record, or null if nothing could be captured.
     */
    function capture(input) {
      try {
        const i = input || {};
        const severity = SEVERITIES.includes(i.severity) ? i.severity : 'error';
        const source = token(i.source, 'app');
        const rawCode = token(i.code, 'E_UNKNOWN');
        const code = i.detailCode != null || APP_CODE.test(rawCode) ? rawCode : 'E_APP';
        const detailCode = i.detailCode != null ? token(i.detailCode, code) : rawCode;
        const message = sanitize(i.message);
        const stack = sanitizeStack(i.stack);
        const dedupe = `${source}|${detailCode}|${message}|${stack.split('\n')[0] || ''}`;
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
        if (detailCode !== code) rec.detailCode = detailCode;
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
        const prefix = source === 'window' ? 'E_' : 'E_WORKER_';
        return capture({
          source, code: `${prefix}${knownName(name)}`, detailCode: `${prefix}${name}`,
          message: (err && err.message) || (ev && ev.message) || 'Script error',
          stack: err && err.stack,
        });
      } catch { return null; }
    }

    function fromRejection(ev, source = 'promise') {
      try {
        const r = ev && ev.reason;
        const isErr = r && typeof r === 'object' && ('message' in r || 'stack' in r);
        const name = isErr && r.name ? r.name : null;
        return capture({
          source, code: `E_REJECTION${name ? `_${knownName(name)}` : ''}`, detailCode: `E_REJECTION${name ? `_${name}` : ''}`,
          message: isErr ? r.message : (typeof r === 'string' ? r : 'Unhandled rejection'),
          stack: isErr ? r.stack : '',
        });
      } catch { return null; }
    }

    /** worker 'messageerror': a message could not be deserialized (no payload is recorded). */
    const fromMessageError = (source = 'worker') =>
      capture({ source, code: 'E_WORKER_MESSAGEERROR', detailCode: 'E_WORKER_MESSAGEERROR', message: 'A worker message could not be deserialized' });

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

    /**
     * Export bundle. Default (messages: 'redacted'): each message is reduced to allowlisted generic
     * words (redactMessage), so arbitrary error text never leaves by default. messages: 'sanitized'
     * is an explicit user opt-in that includes the regex-scrubbed text, which may still hold
     * private details and must be reviewed.
     */
    function exportBundle({ messages = 'redacted' } = {}) {
      const full = messages === 'sanitized';
      let own = new Set();
      try { own = new Set([...appFiles()].map((f) => String(f).toLowerCase())); } catch { /* none known */ }
      // every default field is listed explicitly (#85): nothing from a record is spread unchecked
      const safe = (r) => ({
        id: r.id, seq: r.seq, time: r.time, last: r.last, count: r.count, severity: r.severity,
        source: APP_SOURCE.test(r.source) ? r.source : 'app',
        code: r.code,
        message: redactMessage(r.message),
        stack: appStack(r.stack, own),
        state: stateText(r.state),
      });
      const detailed = (r) => ({ ...safe(r), code: r.detailCode || r.code, message: r.message, stack: r.stack });
      return {
        format: 'pico8-suite-diagnostics',
        formatVersion: 1,
        generated: new Date(now()).toISOString(),
        session,
        app: { version: token(version, 'unknown'), browser: token(browser, 'unknown') },
        messages: full ? 'sanitized' : 'redacted',
        note: (full
          ? 'Local-only error summaries with scrubbed message text, error names and stack function names included at your request; they can still contain private details, review them. '
          : 'Local-only error summaries. Message text is reduced to generic error words (other words appear as […]); error types are standard names or OtherError; stacks list only the Suite\'s own script lines. ')
          + 'No project content, file paths or storage contents are collected. '
          + 'JavaScript hooks cannot capture a crashed tab or process, and this log is lost when the tab closes.',
        records: records.map(full ? detailed : safe),
      };
    }

    return {
      capture, report, fromErrorEvent, fromRejection, fromMessageError, watchWorker, install,
      read: () => records.map((r) => ({ ...r })),
      clear() { records = []; lastSeen.clear(); },
      exportBundle,
      exportJSON: (opts) => JSON.stringify(exportBundle(opts), null, 2),
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

  return { create, sanitize, redactMessage, sanitizeStack, browserFamily, MAX_RECORDS };
})();

if (typeof module !== 'undefined') module.exports = P8Diag;

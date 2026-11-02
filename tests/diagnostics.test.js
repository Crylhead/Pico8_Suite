// #62: bounded, privacy-preserving diagnostics (js/diagnostics-core.js).
const assert = require('assert');
const { t } = require('./harness.js');
const D = require('../js/diagnostics-core.js');

const mk = () => { let n = 1700000000000; return D.create({ now: () => (n += 1000), browser: 'Chrome', version: 'test', sessionId: 'S1' }); };

t('#62 window error becomes one timestamped record with a stable id; duplicates are merged', () => {
  const d = mk();
  const err = new TypeError('x is undefined');
  const a = d.fromErrorEvent({ error: err });
  const b = d.fromErrorEvent({ error: err });
  assert.strictEqual(d.size, 1);
  assert.strictEqual(a, b);
  assert.strictEqual(a.count, 2);
  assert.match(a.id, /^S1-[0-9A-Z]{7}$/);
  assert.strictEqual(a.code, 'E_TypeError');
  assert.ok(!Number.isNaN(Date.parse(a.time)));
});

t('#62 rejection, worker error and messageerror are captured separately', () => {
  const d = mk();
  d.fromRejection({ reason: new RangeError('bad') });
  d.fromRejection({ reason: 'plain' });
  d.fromErrorEvent({ message: 'boom' }, 'worker:terrain');
  d.fromMessageError('worker:terrain');
  const codes = d.read().map((r) => r.code);
  assert.deepStrictEqual(codes, ['E_REJECTION_RangeError', 'E_REJECTION', 'E_WORKER_Error', 'E_WORKER_MESSAGEERROR']);
});

t('#62 sanitization removes paths, urls, tokens, e-mail and quoted user text', () => {
  const s = D.sanitize('Failed C:\\Users\\Anna\\carts\\game.p8 at https://x.test/a?token=abc123 for anna@mail.com, token=SECRETVALUE1 "my secret lua code here" /home/anna/proj/x.p8');
  for (const bad of ['Anna', 'anna', 'game.p8', 'x.test', 'SECRETVALUE1', 'secret lua', 'proj']) assert.ok(!s.includes(bad), `${bad} leaked: ${s}`);
  assert.strictEqual(D.sanitize('Failed C:\\Users\\Anna\\a.p8'), D.sanitize('Failed C:\\Users\\Anna\\a.p8'));
});

t('#62 long fields are truncated and stacks keep only function and file:line', () => {
  assert.ok(D.sanitize('a '.repeat(2000)).length < 330);
  const st = D.sanitizeStack('TypeError: x\n    at foo (https://host/dir/js/app.js:10:5)\n    at C:\\Users\\Anna\\proj\\code.js:3:1');
  assert.ok(st.includes('foo (app.js:10:5)'));
  assert.ok(!/Anna|host|dir/.test(st), st);
});

t('#62 ring buffer stays bounded and drops the oldest records', () => {
  const d = mk();
  for (let i = 0; i < D.MAX_RECORDS + 25; i++) d.report('t', 'E_X', new Error(`m${i}`));
  assert.strictEqual(d.size, D.MAX_RECORDS);
  assert.strictEqual(d.read()[0].message, 'm25');
});

t('#62 capture never throws, even for hostile input', () => {
  const d = mk();
  const hostile = { get message() { throw new Error('no'); }, get stack() { throw new Error('no'); } };
  assert.doesNotThrow(() => d.report('t', 'E_X', hostile));
  assert.doesNotThrow(() => d.fromErrorEvent(null));
  assert.doesNotThrow(() => d.capture(undefined));
});

t('#62 export bundle is local metadata only; clear empties the log', () => {
  const d = mk();
  d.report('code', 'E_SAVE', new Error('save failed for "my game title is long"'), 'saving');
  const b = JSON.parse(d.exportJSON());
  assert.strictEqual(b.format, 'pico8-suite-diagnostics');
  assert.deepStrictEqual(Object.keys(b.records[0]).sort(), ['code', 'count', 'id', 'last', 'message', 'seq', 'severity', 'source', 'stack', 'state', 'time']);
  assert.ok(!JSON.stringify(b).includes('my game title'));
  assert.match(b.note, /crashed tab/);
  d.clear();
  assert.strictEqual(d.size, 0);
});

t('#62 install attaches window listeners, ignores resource errors and detaches', () => {
  const d = mk();
  const handlers = {};
  const win = { addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; } };
  const off = d.install(win);
  handlers.error({ target: {} });
  assert.strictEqual(d.size, 0);
  handlers.error({ error: new Error('real') });
  handlers.unhandledrejection({ reason: new Error('async') });
  assert.strictEqual(d.size, 2);
  off();
  assert.deepStrictEqual(Object.keys(handlers), []);
});

t('#67 watchWorker hands the Error ID to the owner; a throwing callback never breaks capture', () => {
  const d = mk();
  const h = {};
  const w = { addEventListener: (n, f) => { h[n] = f; }, removeEventListener: () => {} };
  const ids = [];
  d.watchWorker(w, 'worker:terrain', (rec) => ids.push(rec.id));
  h.error({ message: 'worker died' });
  assert.match(ids[0], /^S1-[0-9A-Z]{7}$/);
  const w2 = { addEventListener: (n, f) => { h[`2${n}`] = f; }, removeEventListener: () => {} };
  d.watchWorker(w2, 'worker:x', () => { throw new Error('ui bug'); });
  assert.doesNotThrow(() => h['2error']({ message: 'again' }));
  assert.strictEqual(d.size, 2);
});

t('#62 watchWorker records error and messageerror and detaches', () => {
  const d = mk();
  const h = {};
  const w = { addEventListener: (n, f) => { h[n] = f; }, removeEventListener: (n) => { delete h[n]; } };
  const off = d.watchWorker(w, 'worker:terrain');
  h.error({ message: 'worker died' });
  h.messageerror({});
  assert.strictEqual(d.size, 2);
  off();
  assert.deepStrictEqual(Object.keys(h), []);
});

t('#62 paths containing spaces, short quoted values and API-key spellings are scrubbed', () => {
  for (const s of ['Failed /home/Alice/My Demo/cart.p8', 'Failed C:\\Users\\Alice\\My Demo\\cart.p8', 'Failed file:///home/Alice/My Demo/cart.p8', 'Value "xy"', 'api_key=abcdefghi']) {
    const scrubbed = D.sanitize(s);
    assert.ok(!/Alice|Demo|cart\.p8|xy|abcdefghi/.test(scrubbed), scrubbed);
  }
});

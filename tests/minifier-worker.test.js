const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');
const Host = require('../js/minifier-worker-host.js');

t('MIN-01 host is lazy, creates a module worker, and diagnoses file URLs before construction', () => {
  let constructed = 0;
  class WorkerCtor { constructor(url, options) { constructed++; this.url = url; this.options = options; } }
  assert.strictEqual(constructed, 0);
  assert.throws(() => Host.create({ protocol: 'file:', WorkerCtor, url: 'unused' }), (e) => e.code === 'E_LOCAL_HTTP' && /Start_Pico8_Suite.bat/.test(e.message) && /serve_suite\.py/.test(e.message));
  assert.strictEqual(constructed, 0);
  const worker = Host.create({ protocol: 'https:', WorkerCtor, url: '/js/minifier-worker.js' });
  assert.strictEqual(constructed, 1);
  assert.strictEqual(worker.options.type, 'module');
  assert.throws(() => Host.create({ protocol: 'http:', WorkerCtor: null }), (e) => e.code === 'E_WORKER_UNAVAILABLE');
});

t('MIN-01 invalid worker messages return structured errors without loading any runtime', async () => {
  const replies = [];
  let receive, fetches = 0;
  const ctx = vm.createContext({ URL, self: { location: { href: 'http://localhost/js/minifier-worker.js' },
    addEventListener: (_, cb) => { receive = cb; }, postMessage: (value) => replies.push(value) },
    fetch: () => { fetches++; throw Error('unexpected load'); },
  });
  vm.runInContext(read('js/minifier-worker.js'), ctx);
  receive({ data: { protocol: 99, requestId: 'bad' } });
  receive({ data: { protocol: 1, type: 'optimize', requestId: 'empty' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(fetches, 0);
  assert.deepStrictEqual(replies.map((r) => [r.requestId, r.result.diagnostics[0].code]), [['bad', 'E_PROTOCOL'], ['empty', 'E_INPUT_INVALID']]);
});

t('MIN-01 failed initialization can retry; reply envelopes retain exact source/options identity', async () => {
  const replies = [];
  let calls = 0;
  const ctx = vm.createContext({ PROTOCOL: 1,
    self: { postMessage: (value) => replies.push(value) },
    failure: (code, message) => Object.assign(new Error(message), { code }),
    initialize: async () => {
      if (++calls === 1) throw Object.assign(new Error('missing local assets'), { code: 'E_ENGINE_ASSETS' });
      return { metadata: { shrinko8Version: 'fixture' }, bridge: { optimize: () => JSON.stringify({ ok: true, lua: 'fixture' }) } };
    },
  });
  const source = read('js/minifier-worker.js');
  vm.runInContext(`let initialization = null; ${fn(source, 'engine')} ${fn(source, 'handle')}`, ctx);
  await ctx.handle({ protocol: 1, type: 'init', requestId: 1 });
  await ctx.handle({ protocol: 1, type: 'init', requestId: 2 });
  await ctx.handle({ protocol: 1, type: 'optimize', requestId: 3, job: { jobId: 'cart-a', sourceRevision: 17, optionsRevision: 4 } });
  assert.deepStrictEqual(replies.map((r) => r.type), ['error', 'ready', 'result']);
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual([replies[2].requestId, replies[2].jobId, replies[2].sourceRevision, replies[2].optionsRevision], [3, 'cart-a', 17, 4]);
});

t('MIN-01 independent Suite cartridge parser accepts CLI reference and retains fixture non-Lua sections', () => {
  const Code = require('../js/code-core.js');
  const source = Code.splitCart(read('tests/fixtures/minifier/sample.p8'));
  const output = Code.splitCart(read('tests/fixtures/minifier/sample.min.p8'));
  assert.ok(output.head.startsWith('pico-8 cartridge'));
  assert.match(output.head, /version 42/);
  assert.deepStrictEqual(output.sections, ['gfx', 'map', 'gff']);
  assert.strictEqual(output.tail, source.tail);
  assert.notStrictEqual(output.lua, source.lua);
});

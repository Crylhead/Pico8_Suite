const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn } = require('./source-extract.js');
const Host = require('../js/minifier-worker-host.js');

t('MIN-01 host is lazy, creates a module worker over HTTP(S) and diagnoses unsupported address types', () => {
  let constructed = 0;
  class WorkerCtor { constructor(url, options) { constructed++; this.url = url; this.options = options; } }
  assert.strictEqual(constructed, 0);
  assert.throws(() => Host.create({ protocol: 'chrome-extension:', WorkerCtor, url: 'unused' }), (e) => e.code === 'E_LOCAL_HTTP');
  assert.strictEqual(constructed, 0);
  const worker = Host.create({ protocol: 'https:', WorkerCtor, url: '/js/minifier-worker.js' });
  assert.strictEqual(constructed, 1);
  assert.strictEqual(worker.options.type, 'module');
  assert.throws(() => Host.create({ protocol: 'http:', WorkerCtor: null }), (e) => e.code === 'E_WORKER_UNAVAILABLE');
});

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

t('#162 file:// host starts the same worker from a blob and bootstraps it with the prepared bundle or an actionable setup error', async () => {
  class WorkerCtor { constructor(url, options) { this.url = url; this.options = options; this.posted = []; } postMessage(m) { this.posted.push(m); } }
  const blobs = [], scripts = [];
  const sources = { pins: { pyodideVersion: '314.0.7', bundleSha256: 'ab' }, python: { 'suite_bridge.py': '' } };
  const scope = { P8MinifierWorkerMain: function P8MinifierWorkerMain(self) { return self; }, P8MinifierSuiteSources: sources,
    Blob: class { constructor(parts) { blobs.push(parts.join('')); } }, URL: { createObjectURL: () => 'blob:null/worker' }, location: { href: 'file:///C:/Suite/index.html' } };
  const doc = { createElement: () => ({}), head: { append: (tag) => scripts.push(tag) } };
  const missing = Host.create({ protocol: 'file:', WorkerCtor, scope, doc });
  assert.strictEqual(missing.url, 'blob:null/worker');
  assert.strictEqual(missing.options.type, undefined, 'file:// pages can only start classic blob workers');
  assert.match(blobs[0], /^'use strict';\n\(function P8MinifierWorkerMain\(self\)/);
  assert.match(blobs[0], /\)\(self\);\n$/);
  assert.strictEqual(scripts[0].src, 'file:///C:/Suite/vendor/pyodide/runtime/file-assets.js');
  scripts[0].onerror(); await settle();
  assert.strictEqual(missing.posted.length, 1);
  assert.strictEqual(missing.posted[0].type, 'p8-bootstrap');
  assert.strictEqual(missing.posted[0].error.code, 'E_FILE_SETUP');
  assert.match(missing.posted[0].error.message, /python tools\/package_minifier\.py/);
  // After the one-time setup, Retry's fresh worker loads the bundle (the failed load is not cached).
  const ready = Host.create({ protocol: 'file:', WorkerCtor, scope, doc });
  scope.P8MinifierFileAssets = { format: 1, pyodideVersion: '314.0.7', bundleSha256: 'ab', files: { 'pyodide.mjs': '' } };
  scripts[1].onload(); await settle();
  assert.strictEqual(ready.posted[0].assets, scope.P8MinifierFileAssets);
  assert.strictEqual(ready.posted[0].sources, sources);
  // Prepared files from another engine pin are refused rather than silently used.
  assert.strictEqual(Host.bootstrapMessage({ ...scope.P8MinifierFileAssets, bundleSha256: 'cd' }, sources).error.code, 'E_FILE_SETUP');
  assert.strictEqual(Host.bootstrapMessage(scope.P8MinifierFileAssets, null).error.code, 'E_ENGINE_ASSETS');
  assert.throws(() => Host.create({ protocol: 'file:', WorkerCtor, scope: { ...scope, P8MinifierWorkerMain: undefined }, doc }), (e) => e.code === 'E_WORKER_UNAVAILABLE');
});

t('#162 a file:// worker waits for its bootstrap and turns missing setup into a structured error without loading anything', async () => {
  const replies = [];
  let receive, fetches = 0;
  const self = { location: { href: 'blob:null/worker', protocol: 'blob:' }, addEventListener: (_, cb) => { receive = cb; }, postMessage: (value) => replies.push(value) };
  const ctx = vm.createContext({ URL, self, performance: { now: () => 0 }, fetch: () => { fetches++; throw Error('unexpected load'); } });
  vm.runInContext(read('js/minifier-worker.js') + '\nP8MinifierWorkerMain(self);', ctx);
  receive({ data: { protocol: 1, type: 'init', requestId: 'early' } });
  await settle();
  assert.strictEqual(replies.length, 0, 'init before the bootstrap waits instead of failing');
  receive({ data: Host.bootstrapMessage(null, { pins: {}, python: {} }) });
  await settle();
  assert.deepStrictEqual(replies.map((r) => [r.requestId, r.type, r.result.diagnostics[0].code]), [['early', 'error', 'E_FILE_SETUP']]);
  assert.match(replies[0].result.diagnostics[0].message, /package_minifier\.py/);
  assert.strictEqual(fetches, 0);
});

t('MIN-01 invalid worker messages return structured errors without loading any runtime', async () => {
  const replies = [];
  let receive, fetches = 0;
  const ctx = vm.createContext({ URL, self: { location: { href: 'http://localhost/js/minifier-worker.js' },
    addEventListener: (_, cb) => { receive = cb; }, postMessage: (value) => replies.push(value) },
    fetch: () => { fetches++; throw Error('unexpected load'); },
  });
  vm.runInContext(read('js/minifier-worker.js') + '\nP8MinifierWorkerMain(self);', ctx);
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

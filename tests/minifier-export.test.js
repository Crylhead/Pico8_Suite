const assert = require('assert');
const { t } = require('./harness.js');
const C = require('../js/minifier-core.js');
const E = require('../js/minifier-export-core.js');
const K = require('../js/code-core.js');
const Cart = require('../js/cart-core.js');
const { source, engine, result } = require('./minifier-fixtures.js');
const complete = (snapshot, raw = result()) => {
  let state = C.transition(C.initialState(), { type: 'source', source: snapshot });
  state = C.transition(state, { type: 'ready', engine: engine() }); state = C.transition(state, { type: 'start' });
  state = C.transition(state, { type: 'complete', job: state.activeJob, result: raw });
  return { state, input: { ...C.prepareInput(snapshot), sourceRevision: state.sourceRevision } };
};
const cartSource = (text) => ({ kind: 'p8', entryPath: 'folder/demo.p8', files: [{ path: 'folder/demo.p8', text }] });
const cartridge = () => K.NEW_CART + 'print("♥") --@data keep.bin\n-->8\ncls()\n__gfx__\n12345678\n__map__\n0011fe\n__gff__\n00ff\n__music__\n03 00010203\n__sfx__\n00100000' + '01873'.repeat(32) + '\n__label__\n0123456789abcdef\n__data__\n00ff1122\n__meta:title__\nHeart test\n';

t('MIN-08 exports preserve exact headers, all non-Lua data, P8SCII, tabs and line endings', () => {
  for (const newline of ['\n', '\r\n']) {
    const text = cartridge().replace(/\n/g, newline), lua = 'print("♥")\n-->8\ncls()';
    const raw = { ...result(), lua, cartText: K.joinCart(K.splitCart(text), lua) };
    const { state, input } = complete(cartSource(text), raw), before = JSON.stringify(input);
    const artifact = E.build(state, input);
    assert.strictEqual(artifact.lua.text, lua); assert.strictEqual(artifact.lua.filename, 'demo.min.lua');
    assert.strictEqual(artifact.cart.filename, 'demo.min.p8'); assert.ok(Object.isFrozen(artifact.cart));
    const exported = C.prepareInput(cartSource(artifact.cart.text));
    assert.strictEqual(exported.original.cart.header, input.original.cart.header);
    assert.strictEqual(exported.original.cart.nonLua, input.original.cart.nonLua);
    assert.deepStrictEqual(Cart.parseP8(artifact.cart.text).rom, Cart.parseP8(text).rom);
    assert.deepStrictEqual(Cart.parseP8(artifact.cart.text).label, Cart.parseP8(text).label);
    assert.ok(artifact.warnings.some((s) => s.includes('source') || s.includes('Source')));
    assert.strictEqual(E.build(state, input).cart.text, artifact.cart.text); assert.strictEqual(JSON.stringify(input), before);
  }
});

t('MIN-08 empty sections and empty optimized code remain valid build copies', () => {
  const text = K.NEW_CART + '-- comment only\n__gfx__\n__map__\n__gff__\n__sfx__\n__music__\n';
  const { state, input } = complete(cartSource(text), { ...result(0, 0), lua: '', cartText: K.NEW_CART + '\n__meta:title__\ncomment only\n' });
  const artifact = E.build(state, input);
  assert.strictEqual(artifact.lua.text, ''); assert.ok(artifact.cart.text.endsWith(input.original.cart.nonLua));
  assert.throws(() => C.prepareInput(cartSource(artifact.cart.text)), (e) => e.code === 'E_EMPTY');
  assert.strictEqual(C.prepareInput(cartSource(artifact.cart.text), { allowEmpty: true }).lua, '');
  assert.throws(() => C.prepareInput(cartSource('bad'), { allowEmpty: true }), (e) => e.code === 'E_CART_HEADER');
});

t('MIN-08 changed assets, headers, code, missing data and mismatched snapshots block output', () => {
  const text = cartridge(), lua = 'cls()', raw = { ...result(), lua, cartText: K.joinCart(K.splitCart(text), lua) };
  const { state, input } = complete(cartSource(text), raw);
  const good = E.build(state, input).cart.text;
  for (const candidate of [good.replace('version 42', 'version 43'), good.replace('12345678', '82345678'), good.replace('__sfx__', '__missing__')]) assert.throws(() => E.verifyCart(text, candidate, lua), (e) => e.code === 'E_EXPORT_PRESERVATION');
  for (const cartText of [raw.cartText.replace('12345678', '82345678'), raw.cartText.replace('cls()', 'flip()')]) {
    const bad = complete(cartSource(text), { ...raw, cartText }); assert.strictEqual(E.inspect(bad.state, bad.input).ok, false);
  }
  assert.strictEqual(E.inspect(state, { ...input, sourceRevision: -1 }).code, 'E_EXPORT_SOURCE');
  assert.strictEqual(E.inspect(state, { ...input, original: { text: 'other' } }).code, 'E_EXPORT_SOURCE');
  const unresolved = complete(source(), { ...result(), lua: '#include missing.lua' }); assert.strictEqual(E.inspect(unresolved.state, unresolved.input).ok, false);
});

t('MIN-08 stale, cancelled, failed and unsupported jobs cannot export; zero savings and preserved hints can', () => {
  const { state, input } = complete(source('--[[keep:note]]\ncls()'), result(2, 2));
  assert.ok(E.build(state, input).warnings.length);
  for (const event of [{ type: 'source', source: source('flip()') }, { type: 'cancel' }, { type: 'failure', diagnostics: [{ code: 'E_INCLUDE_MISSING', message: 'missing' }] }, { type: 'options', options: { profile: 'aggressive' } }, { type: 'start' }]) {
    assert.strictEqual(E.inspect(C.transition(state, event), input).code, 'E_EXPORT_STALE');
  }
  const named = complete(source('cls()', 'demo.min.lua'), result(2, 2));
  assert.strictEqual(E.build(named.state, named.input).lua.filename, 'demo.min.min.lua');
});

t('MIN-08 preservation permits inspection copies while budgets distinguish exact boundaries and increases', () => {
  const text = K.NEW_CART + 'cls()\n';
  for (const [tokens, characters, over] of [[0, 0, false], [8192, 65535, false], [8193, 65535, true], [8192, 65536, true]]) {
    const raw = result(0, tokens); raw.cartText = text; raw.metrics.optimized.characters = characters;
    const { state, input } = complete(cartSource(text), raw), before = JSON.stringify({ state, input });
    const checked = E.inspect(state, input); assert.ok(checked.ok, 'budget excess must not be confused with preservation failure');
    const { budgets, cart, lua } = checked.artifacts;
    assert.strictEqual(budgets.textOver, over); assert.strictEqual(budgets.pngBlocked, over);
    assert.strictEqual(cart.text, text); assert.strictEqual(lua.text, 'cls()');
    if (tokens > 8192) assert.ok(budgets.warnings.some((s) => /Tokens: 8,193; limit 8,192; exceeds by 1/.test(s)));
    if (characters > 65535) assert.ok(budgets.warnings.some((s) => /Characters: 65,536; limit 65,535; exceeds by 1/.test(s)));
    assert.strictEqual(JSON.stringify({ state, input }), before);
  }
  for (const bytes of [null, 15359, 15360]) {
    const raw = result(); raw.metrics.optimized.compressedBytes = bytes;
    if (bytes === null) raw.metrics.optimized.compressedReason = 'Unavailable in fixture.';
    const { state, input } = complete(source(), raw), { budgets } = E.build(state, input);
    assert.strictEqual(budgets.textOver, false); assert.strictEqual(budgets.pngBlocked, bytes === 15360);
    if (bytes === 15360) assert.match(budgets.warnings.join(' '), /PNG compressed code: 15,360 bytes;.*maximum 15,359.*exceeds by 1.*not text/);
  }
});

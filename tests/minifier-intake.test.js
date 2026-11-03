const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { t } = require('./harness.js');
const C = require('../js/minifier-core.js');
const sample = fs.readFileSync(path.join(__dirname, 'fixtures/minifier/sample.p8'), 'utf8');

t('MIN-04 cartridge intake preserves exact original/header/non-Lua text and code-tab metadata', () => {
  const text = sample.replace('__gfx__', '-->8\n-- glyphs\nprint("♥")\n__gfx__').replace(/\n/g, '\r\n');
  const input = C.textInput('Heart.P8', text);
  assert.strictEqual(input.source.files[0].text, text); assert.strictEqual(input.original.text, text);
  assert.strictEqual(input.original.cart.version, 42);
  assert.strictEqual(input.original.cart.header, text.slice(0, text.indexOf('__lua__') + '__lua__\r\n'.length));
  assert.strictEqual(input.original.cart.nonLua, text.slice(text.indexOf('__gfx__')));
  assert.deepStrictEqual(input.original.cart.sections, ['gfx', 'map', 'gff']);
  assert.ok(input.lua.includes('♥')); assert.strictEqual(input.tabs.length, 2);
  assert.ok(Object.isFrozen(input.original.cart.sections));
});

t('MIN-04 rejects malformed headers, missing/misplaced/duplicate sections and empty Lua', () => {
  for (const text of [sample.replace('pico-8 cartridge', 'wrong header'), sample.replace('version 42', 'version nope'), sample.replace('__lua__', '__lua_'), sample.replace('__lua__', '__gfx__\n__lua__'), sample + '\n__lua__\ncls()', sample + '\n__gfx__\n0']) assert.throws(() => C.textInput('bad.p8', text), (e) => /^E_CART_/.test(e.code));
  for (const [name, text] of [['empty.lua', ' \r\n\t'], ['empty.p8', 'pico-8 cartridge // http://www.pico-8.com\nversion 42\n__lua__\n__gfx__\n0']]) assert.throws(() => C.textInput(name, text), (e) => e.code === 'E_EMPTY');
});

t('MIN-04 strict text decode never silently replaces corrupt bytes or accepts binary/PNG input', () => {
  assert.throws(() => C.decodeText(Uint8Array.from([0xff, 0xfe])), (e) => e.code === 'E_INPUT_ENCODING');
  assert.throws(() => C.textInput('binary.lua', 'cls()\0'), (e) => e.code === 'E_INPUT_ENCODING');
  assert.throws(() => C.inputKind('cart.p8.png'), (e) => e.code === 'E_FORMAT_UNSUPPORTED');
  assert.throws(() => C.textInput('cart.lua', sample), (e) => e.code === 'E_FORMAT_UNSUPPORTED');
  const text = '-- glyphs\r\nprint("♥ 🅾️")\r\n-->8\r\ncls()\r\n';
  const input = C.textInput('glyphs.lua', C.decodeText(new TextEncoder().encode(text)));
  assert.strictEqual(input.source.files[0].text, text); assert.strictEqual(input.original.cart, null);
  assert.strictEqual(input.tabs.length, 2); assert.strictEqual(input.lua, text);
});

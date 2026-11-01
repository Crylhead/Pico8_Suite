// #33: retirement reads load references through the shared Lua lexer, including string-call forms.
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/project-core.js');

const retire = (lua, cands = ['old.p8']) => P.retirement(cands, [{ name: 'main.p8', text: `pico-8 cartridge\n__lua__\n${lua}\n__gfx__\n00\n` }]);

t('#33 string-call and long-bracket load references keep their cart', () => {
  const forms = ['load"old.p8"', "load'old.p8'", 'load [[old.p8]]', 'load[==[old.p8]==]', 'load("old.p8")', 'load"old"', 'load([=[old.p8]=])', 'load\n"old.p8"', 's="a"..load"old.p8"'];
  for (const lua of forms) {
    const r = retire(`x=1\n${lua}`);
    assert.deepStrictEqual([r.retire, r.unresolved], [[], []], lua);
    assert.deepStrictEqual(r.kept.map((k) => k.cart), ['old.p8'], lua);
    assert.match(r.kept[0].by, /^main\.p8:4 load/, lua);
  }
});

t('#33 comments, strings, member calls, definitions and run() are not references; unreferenced carts retire', () => {
  const lua = ['-- load"old.p8"', '--[==[ load"old.p8" ]] ]==]', 's="load\\"old.p8\\""', 'u=[[load"old.p8"]]', 'obj.load"old.p8"', 'obj:load"old.p8"',
    'obj . load ("old.p8")', 'function load(x) end', 'local load=1', 'run("old.p8")', 'reload"old.p8"', 'load"other.p8"'].join('\n');
  assert.deepStrictEqual(retire(lua), { retire: ['old.p8'], kept: [], unresolved: [] });
});

t('#33 load forms that cannot be resolved keep every candidate and are reported', () => {
  for (const [lua, why] of [['load{"old.p8"}', /table/], ['local f=load\nf"old.p8"', /without a call/], ['pcall(load,"old.p8")', /without a call/], ['load"x\\".p8"', /cannot be resolved/]]) {
    const r = retire(`x=1\n${lua}`, ['old.p8', 'unrelated.p8']);
    assert.deepStrictEqual(r.retire, [], lua);
    assert.deepStrictEqual(r.unresolved.map((u) => u.line), [4], lua);
    assert.match(r.unresolved[0].why, why, lua);
  }
});

t('#33 string-call references are followed through carts that stay', () => {
  const files = [
    { name: 'main.p8', text: 'load"mid"' },
    { name: 'mid.p8', text: '__lua__\nload[[deep.p8]]\n' },
    { name: 'gone.p8', text: "load'alsogone.p8'" },
  ];
  const r = P.retirement(['mid.p8', 'deep.p8', 'gone.p8', 'alsogone.p8'], files);
  assert.deepStrictEqual(r.retire.sort(), ['alsogone.p8', 'gone.p8']);
  assert.deepStrictEqual(r.kept.map((k) => [k.cart, k.by]), [['mid.p8', 'main.p8:1 load"mid"'], ['deep.p8', 'mid.p8:2 load[[deep.p8]]']]);
  assert.deepStrictEqual(r.unresolved, []);
});

// #41/#42/#43: destructive decisions (retirement, adoption, anchor and cart-list rewrites) read
// executable Lua through the shared lexer and never treat an approximation as proof.
const assert = require('assert');
const { t } = require('./harness.js');
const P = require('../js/project-core.js');

const cart = (name, text = '') => ({ rom: new Uint8Array(0x4300).fill(1), lua: '', used: new Uint8Array(0x4300), reads: [], luaAt: 0, name, text });
const adoptOf = (fx, more = ['atlas.p8']) => P.adopt(new Map([['fx.p8', cart('fx.p8', fx)], ...more.map((n) => [n, cart(n)])]));
const retire = (lua, cands = ['old.p8', 'other.p8']) => P.retirement(cands, [{ name: 'main.lua', text: lua }, ...cands.map((n) => ({ name: n, text: '' }))]);
const where = () => ({ cart: 'd0.p8', off: 0x100, len: 100, lz: false });
const whereSet = (n) => (n === 'x' ? { off: 0, len: 10, carts: ['d1.p8', 'd2.p8'] } : null);

// ---------------------------------------------------------------- #41

t('#41 a string-valued name in a concatenation is resolved, not guessed as a number', () => {
  for (const call of ['load(name..".p8")', 'reload(0,0,10,name..".p8")', 'load(name)']) {
    const r = retire(`name="old"\n${call}`);
    assert.deepStrictEqual(r.kept.map((k) => [k.cart, k.by]), [['old.p8', `main.lua:2 ${call}`]], call);
    assert.deepStrictEqual([r.retire, r.unresolved], [['other.p8'], []], `${call}: an established absence still retires`);
  }
  // a decoy assignment in a comment or a string is not a second binding
  const r = retire('-- name="other"\ns="name=\\"other\\""\nlocal name=[[old]]\nload(name..".p8")');
  assert.deepStrictEqual([r.retire, r.kept.map((k) => k.cart)], [['other.p8'], ['old.p8']]);
});

t('#41 unresolved fragments, reassigned names and mutable tables keep every candidate', () => {
  const cases = [
    ['load("m"..i..".p8")', /\bi\b/],
    ['load(pick()..".p8")', /pick/],
    ['name=pick()\nload(name..".p8")', /name/],
    ['name="old"\nname="other"\nload(name)', /more than once/],
    ['name="old"\nname..="x"\nload(name)', /\.\.=/],
    ['local name="old"\nfunction f(name) load(name) end', /name/],
    ['local xs={"old.p8"}\nxs[1]="other.p8"\nload(xs[1])', /replaced/],
    ['local xs={"old.p8"}\nadd(xs,"other.p8")\nload(xs[2])', /whole/],
    ['local xs={"old.p8"}\nlocal ys=xs\nys[1]="other.p8"\nload(xs[1])', /whole/],
    ['xs={"old.p8"}\n_ENV.xs={"other.p8"}\nload(xs[1])', /_ENV/],
    ['local xs={"old.p8",nm}\nload(xs[1])', /nm/],
    ['local xs={"old.p8"}\n#include more.lua\nload(xs[1])', /include/],
  ];
  for (const [lua, why] of cases) {
    const r = retire(lua);
    assert.deepStrictEqual(r.retire, [], lua);
    assert.ok(r.unresolved.length, lua);
    assert.match(r.unresolved.map((u) => u.why).join(' / '), why, lua);
  }
});

t('#41 provable cart lists and transitive references keep exactly their carts', () => {
  const files = [
    { name: 'main.p8', text: '__lua__\nlocal xs={"mid.p8", -- the first\n "old.p8"}\nfor i=1,#xs do load(xs[i]) end\nfor c in all(xs) do end\n__gfx__\n' },
    { name: 'mid.p8', text: '__lua__\nlocal n="deep"\nload(n)\n' },
  ];
  const r = P.retirement(['mid.p8', 'old.p8', 'deep.p8', 'gone.p8'], files);
  assert.deepStrictEqual(r.retire, ['gone.p8']);
  assert.deepStrictEqual(r.kept.map((k) => [k.cart, k.by]), [['mid.p8', 'main.p8:4 load(xs[i])'], ['old.p8', 'main.p8:4 load(xs[i])'], ['deep.p8', 'mid.p8:3 load(n)']]);
  assert.deepStrictEqual(r.unresolved, []);
});

t('#41 adoption never treats a computed name as reading no cart', () => {
  // previously the unknown fragment was taken as digits: atlas.p8 was adopted although name.."" reads it
  const fx = 'name="atlas"\nreload(0x8000,0,0x100,"atlas.p8")\nreload(0x8000,0,0x100,name..".p8")\n';
  const r = adoptOf(fx, ['atlas.p8', 'other.p8']);
  assert.deepStrictEqual([r.edits.map((e) => e.line), r.adoptedCarts, r.keptCarts], [[2], [], ['atlas.p8']]);
  const unknown = adoptOf('reload(0x8000,0,0x100,"atlas.p8")\nreload(0x8000,0,0x100,pick()..".p8")\n');
  assert.deepStrictEqual([unknown.adoptedCarts, unknown.keptCarts], [[], ['atlas.p8']]);
  assert.strictEqual(unknown.skipped[0].carts, null, 'an unresolved name may read any cart');
});

// ---------------------------------------------------------------- #42

const setFx = (list, more = '') => `${list}\n${more}reload(0,0,10,cs[i]) --@data x[]`;

t('#42 mixed, concatenated and unsupported list entries are rejected before any edit', () => {
  for (const [list, why] of [['local cs={"old.p8",other}', /other/], ['local cs={"old.p8"..suffix}', /concatenated|suffix/], ['local cs={[1]="old.p8"}', /\[1\]/],
    ['local cs={"old.p8",{"b.p8"}}', /\{/], ['local cs={}', /empty/], ['local cs={"old.p8"}..x', /longer expression/], ['local cs=pick()', /table literal/]]) {
    const src = setFx(list);
    const r = P.rewriteAnchors(src, where, whereSet);
    assert.strictEqual(r.text, src, `${list}: nothing changes`);
    assert.deepStrictEqual(r.errors.map((e) => e.line), [2], list);
    assert.match(r.errors[0].msg, why, list);
    assert.match(P.checkAnchors([{ name: 'fx.p8', text: src }], [{ ref: 'x.c1', set: 'x', bytes: new Uint8Array(10) }]).errors.join('\n'), /^fx\.p8:2 /, list);
  }
});

t('#42 ambiguous, reassigned, mutated or partly indexed lists are rejected', () => {
  for (const [lua, why, call] of [
    ['local cs={"a.p8"}\ncs={"b.p8"}', /more than once/], ['cs={"a.p8"}\nif x then cs={"b.p8"} end', /more than once/],
    ['local cs={"a.p8"}\ncs[2]="b.p8"', /replaced/], ['local cs={"a.p8"}\ndel(cs,"a.p8")', /whole/], ['local cs={"a.p8"}\nfunction f(cs) end', /declared/],
    ['local cs={"a.p8"}', /complete index|list index/, 'reload(0,0,10,cs[i]..".p8") --@data x[]'], ['local cs={"a.p8"}', /complete index|list index/, 'reload(0,0,10,cs[i].n) --@data x[]'],
    ['local t={cs={"a.p8"}}', /never assigned/],
  ]) {
    const src = call ? `${lua}\n${call}` : setFx(lua);
    const r = P.rewriteAnchors(src, where, whereSet);
    assert.strictEqual(r.text, src, lua);
    assert.strictEqual(r.errors.length, 1, lua);
    assert.match(r.errors[0].msg, why, lua);
  }
});

t('#42 decoys in comments and strings are ignored; the live binding is rewritten in place', () => {
  const src = [
    '-- cs={"decoy.p8"}', '--[==[ cs={"decoy.p8"} ]==]', 's="cs={\\"decoy.p8\\"}"', 'u=[[cs={"decoy.p8"}]]',
    'local cs={ -- the skull carts', '  "old.p8", -- first', "  'two.p8';", '}', 'for c in all(cs) do end', 'reload(0,0,10,cs[i]) --@data x[] -- set',
  ].join('\n');
  const r = P.rewriteAnchors(src, where, whereSet);
  assert.deepStrictEqual(r.errors, []);
  const want = src.replace('"old.p8"', '"d1.p8"').replace("'two.p8'", '"d2.p8"').replace('reload(0,0,10,cs[i])', 'reload(0,0x0000,0x000a,cs[i])');
  assert.strictEqual(r.text, want, 'only the entries and the call change: comments, separators and decoys stay');
  assert.ok(r.text.startsWith('-- cs={"decoy.p8"}\n--[==[ cs={"decoy.p8"} ]==]\ns="cs={\\"decoy.p8\\"}"\nu=[[cs={"decoy.p8"}]]'));
  // a different number of carts rebuilds an uncommented list; a commented one is refused
  const grow = (n) => ({ off: 0, len: 10, carts: ['d1.p8', 'd2.p8', 'd3.p8'] });
  assert.strictEqual(P.rewriteAnchors(setFx('local cs={"a.p8","b.p8"}'), where, grow).text.split('\n')[0], 'local cs={"d1.p8", "d2.p8", "d3.p8"}');
  const refused = P.rewriteAnchors(src, where, grow);
  assert.strictEqual(refused.text, src);
  assert.match(refused.errors[0].msg, /comments/);
});

t('#42 adoption accepts only proven literal cart lists', () => {
  const sets = ['local cs={"atlas.p8", "b.p8"}', 'local cs={"atlas.p8",other}', '-- cs={"atlas.p8"}\nlocal cs={"atlas.p8"}\ncs[2]="b.p8"'];
  const ok = adoptOf(`${sets[0]}\nreload(0,0,0x100,cs[i])\n`, ['atlas.p8', 'b.p8']);
  assert.deepStrictEqual([ok.assets.map((a) => [a.type, a.meta.carts]), ok.adoptedCarts.sort()], [[['cartset', ['atlas.p8', 'b.p8']]], ['atlas.p8', 'b.p8']]);
  assert.match(ok.edits[0].after, /--@data fx_cs\[\]$/);
  for (const list of sets.slice(1)) {
    const r = adoptOf(`reload(0,0,0x100,"atlas.p8")\n${list}\nreload(0,0,0x100,cs[i])\n`, ['atlas.p8', 'b.p8']);
    assert.deepStrictEqual(r.assets.map((a) => a.type), ['table'], list);
    const skip = r.skipped.find((s) => /cs\[i\]/.test(s.why) || /cart list/.test(s.why));
    assert.ok(skip, list);
    assert.strictEqual(skip.carts, null, `${list}: an unproven list may read any cart`);
    assert.deepStrictEqual([r.adoptedCarts, r.keptCarts.sort()], [[], ['atlas.p8']], list);
  }
});

// ---------------------------------------------------------------- #43

t('#43 anchors are found only in real comments after executable reload() calls', () => {
  const src = [
    'local template=[=[', 'reload(0,0,10,"old.p8") --@data x.bin', ']=]',
    '--[==[', 'reload(0,0,10,"old.p8") --@data x.bin', ']==]',
    's="reload(0,0,10,\\"old.p8\\") --@data x.bin+frame"',
    'u="reload(9,9,9,9)" reload(0,0,10,"old.p8") --@data x.bin -- live',
  ].join('\n');
  assert.deepStrictEqual(P.findAnchors(src).map((a) => [a.line, a.ref, a.error]), [[7, 'x.bin', null]]);
  const r = P.rewriteAnchors(src, where);
  assert.deepStrictEqual(r.errors, []);
  const want = src.split('\n');
  want[7] = 'u="reload(9,9,9,9)" reload(0,0x0100,0x0064,"d0.p8") --@data x.bin -- live';
  assert.strictEqual(r.text, want.join('\n'), 'literal and comment contents stay; the live call keeps its trailing comment');
  const chk = P.checkAnchors([{ name: 'fx.p8', text: src }], [{ ref: 'x.bin', bytes: new Uint8Array(100), lz: false }]);
  assert.deepStrictEqual([chk.anchors.map((a) => a.line), chk.errors], [[8], []]);
  // the issue's sample: only the final call changes
  const sample = 'local template=[=[\nreload(0,0,10,"old.p8") --@data x.bin\n]=]\nreload(0,0,10,"old.p8") --@data x.bin';
  assert.strictEqual(P.rewriteAnchors(sample, where).text, sample.replace(/reload\(0,0,10,"old\.p8"\)( --@data x\.bin)$/, 'reload(0,0x0100,0x0064,"d0.p8")$1'));
});

t('#43 ambiguous or split anchored lines are rejected, never guessed', () => {
  for (const [line, why] of [
    ['reload(0,0,10,"a.p8") reload(0,0,10,"b.p8") --@data x.bin', /more than one reload/],
    ['reload(0,0,\n10,"a.p8") --@data x.bin', /several lines/],
    ['x=1 --@data x.bin', /no reload/],
  ]) {
    const r = P.rewriteAnchors(line, where);
    assert.strictEqual(r.text, line, line);
    assert.strictEqual(r.errors.length, 1, line);
    assert.match(r.errors[0].msg, why, line);
  }
});

t('#43 adoption anchors only executable, unambiguous one-line calls; renames touch real anchors only', () => {
  const fx = [
    'u=[[', 'reload(0x8000,0,0x100,"atlas.p8")', ']]',
    'reload(0x8000,0,0x100,"atlas.p8") reload(0x9000,0,0x100,"b.p8")',
    'reload(0x8000,0,\n0x100,"c.p8")',
    'reload(0x8000,0,0x100,"d.p8") s=[[', ']]',
    'reload(0x8000,0,0x100,"e.p8") -- the font',
  ].join('\n');
  const r = adoptOf(fx, ['atlas.p8', 'b.p8', 'c.p8', 'd.p8', 'e.p8']);
  assert.deepStrictEqual(r.edits.map((e) => [e.line, e.after]), [[9, 'reload(0x8000,0,0x100,"e.p8") -- the font --@data fx_e.bin']]);
  assert.deepStrictEqual(r.skipped.map((s) => [s.line, s.carts]), [[4, ['atlas.p8']], [4, ['b.p8']], [5, ['c.p8']], [7, ['d.p8']]]);
  assert.match(r.skipped.map((s) => s.why).join(' / '), /more than one reload.*several lines.*inside a string/);
  assert.deepStrictEqual([r.adoptedCarts, r.keptCarts.sort()], [['e.p8'], ['atlas.p8', 'b.p8', 'c.p8', 'd.p8']]);
  // the new anchor is found again by the shared discovery
  assert.deepStrictEqual(P.findAnchors(r.edits[0].after).map((a) => [a.ref, a.error]), [['fx_e.bin', null]]);
  const text = 's="--@data fx_e.bin"\nreload(0,0,10,"d0.p8") --@data fx_e.bin';
  assert.strictEqual(P.renameInText(text, 'fx_e', 'font'), 's="--@data fx_e.bin"\nreload(0,0,10,"d0.p8") --@data font.bin');
});

// integrated review: assignments hidden in nested functions, locals outside their block, _ENV calls
t('#41 nested multiple assignments, out-of-scope locals and _ENV/_G calls keep their carts', () => {
  const keep = (lua, why) => {
    const r = P.retirement(['a.p8', 'b.p8'], [{ name: 'fx.p8', text: `pico-8 cartridge\n__lua__\n${lua}\n__gfx__\n00\n` }]);
    assert.deepStrictEqual(r.retire, [], lua);
    if (why) assert.match(r.unresolved.map((u) => u.why).join(' / '), why, lua);
  };
  keep('c="a.p8"\nfoo(function() c,x="b.p8",0 end)\nreload(0,0,0x100,c)', /multiple assignment/);
  keep('c="a.p8"\nt={function() x,c=0,"b.p8" end}\nt[1]()\nreload(0,0,0x100,c)', /multiple assignment/);
  keep('c="a.p8"\nt={function() x=1;c="b.p8" end}\nreload(0,0,0x100,c)', /assigned/);
  keep('cs={"a.p8"}\nt={function() x=1;cs={"b.p8"} end}\nreload(0,0,0x100,cs[1])', /assigned/);
  keep('cs={"a.p8"}\ncs[1],x="b.p8",0\nreload(0,0,0x100,cs[1])', /multiple assignment/);
  keep('#include lib.lua\nfunction f() local c="a.p8" end\nreload(0,0,0x100,c)', /outside the block|include/);
  keep('function f() local c="a.p8" end\n_ENV.c="b.p8"\nreload(0,0,0x100,c)', /outside the block|_ENV/);
  keep('function f() local cs={"a.p8"} end\n_ENV.cs={"b.p8"}\nreload(0,0,0x100,cs[1])', /outside the block|_ENV/);
  keep('if x then local c="a.p8" end\nreload(0,0,0x100,c)', /outside the block/);
  keep('_ENV.reload(0,0,0x100,"b.p8")\nload"a.p8"');
  keep('_G.load("b.p8")\nload"a.p8"');
  keep('o=setmetatable({},{__index=_ENV})\no.load("b.p8")\nload"a.p8"', /globals table/);
  keep('_G["load"]("b.p8")\nload"a.p8"', /globals table/);

  // still proven: a local used inside its block (also with PICO-8 shorthand ifs), a single global
  const ok = (lua) => P.retirement(['a.p8', 'b.p8'], [{ name: 'fx.p8', text: `__lua__\n${lua}\n` }]);
  let r = ok('function f()\n local c="a.p8"\n if (x) y=1\n while (z) z-=1\n reload(0,0,0x100,c)\nend');
  assert.deepStrictEqual([r.retire, r.unresolved], [['b.p8'], []]);
  r = ok('t={f=function() reload(0,0,0x100,cs[i]) end, n=1}\ncs={"a.p8"}\nfor i=1,#cs do x,y=cs[i],1 end');
  assert.deepStrictEqual([r.retire, r.unresolved], [['b.p8'], []]);
  r = ok('local _ENV=self\n_G.x=1\nload"a.p8"');
  assert.deepStrictEqual([r.retire, r.unresolved], [['b.p8'], []]);
});

t('#41 a name or list entry read on the right of a multiple assignment stays proven; as a target it does not', () => {
  const run = (lua) => P.retirement(['a.p8', 'b.p8'], [{ name: 'fx.p8', text: `__lua__\n${lua}\n` }]);
  for (const lua of ['c="a.p8"\nx,y=c,1\nload(c)', 'cs={"a.p8"}\nx,y=cs[1],2\nload(cs[1])', 'c="a.p8"\nfunction f() return c, 1 end\nload(c)']) {
    assert.deepStrictEqual([run(lua).retire, run(lua).unresolved], [['b.p8'], []], lua);
  }
  for (const lua of ['c="a.p8"\nc, self.x = "b.p8", 1\nload(c)', 'cs={"a.p8"}\ncs[1], t[2] = "b.p8", 1\nload(cs[1])', 'c="a.p8"\ndo c,x="b.p8",1 end\nload(c)']) {
    assert.deepStrictEqual(run(lua).retire, [], lua);
    assert.match(run(lua).unresolved[0].why, /multiple assignment/, lua);
  }
});

// #61: the tour card is placed beside its target only when it fits whole; a null or shortened spot from
// P8Tips.place (#60) centers the card instead, so its buttons never end up off-screen. Runs the actual
// position() and visible() from js/tours.js with a minimal fake DOM.
const assert = require('assert');
const vm = require('vm');
const { t } = require('./harness.js');
const { read, fn, line } = require('./source-extract.js');

function setup(placeResult) {
  const src = read('js/tours.js');
  const ctx = vm.createContext({ placeResult });
  vm.runInContext(`
    const style = () => ({});
    const ring = { style: style() };
    const card = { style: style(), offsetWidth: 300, offsetHeight: 180 };
    const node = { getClientRects: () => [1], closest: () => null, getBoundingClientRect: () => ({ top: 100, bottom: 130, left: 40, right: 140, width: 100, height: 30 }) };
    const document = { documentElement: { clientWidth: 800, clientHeight: 240 } };
    const P8Tips = { place: () => placeResult };
    let active = { ring, card, run: { state: { ctx: { el: node } } } };
    ${line(src, 'const visible =')}
    ${fn(src, 'position')}
    position();
    this.env = { ring, card };
  `, ctx);
  return ctx.env;
}

t('#61 a card that fits beside its target is placed there, with the target ring shown', () => {
  const { ring, card } = setup({ top: 138, left: 20, side: 'below' });
  assert.deepStrictEqual([card.style.top, card.style.left, ring.style.display], ['138px', '20px', 'block']);
});

t('#61 a shortened or missing spot centers the card instead; the target ring stays', () => {
  for (const p of [{ top: 4, left: 20, side: 'above', maxHeight: 60 }, null]) {
    const { ring, card } = setup(p);
    assert.strictEqual(card.style.top, `${Math.max(8, (240 - 180) / 3)}px`, JSON.stringify(p));
    assert.strictEqual(card.style.left, `${(800 - 300) / 2}px`, JSON.stringify(p));
    assert.strictEqual(ring.style.display, 'block', 'the target stays highlighted');
  }
});

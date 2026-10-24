import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { besideElement } from './thread-place.ts';

const WINDOW = { left: 0, top: 0, width: 1_280, height: 800 };
const SIZE = { width: 344, height: 300 };
/** An element and its pin: the drop stands on its top edge, 16 px in from its start corner. */
const pinOn = (left: number, top: number, width: number, height: number) => ({
  element: { left: left - 5, top: top - 5, width: width + 10, height: height + 10 },
  drop: { left: left + 2, top: top - 34, width: 28, height: 34 },
  tip: { x: left + 16, y: top },
});
const place = (
  pin: ReturnType<typeof pinOn>,
  others: { left: number; top: number; width: number; height: number }[] = [],
  direction: 'ltr' | 'rtl' = 'ltr',
) => besideElement(pin.element, pin.drop, pin.tip, SIZE, WINDOW, others, direction);

describe('where the bubble opens around its element (FRU-421)', () => {
  it('goes under the element first', () => {
    assert.deepEqual(place(pinOn(200, 100, 300, 40)), { left: 196, top: 159, side: 'below', edge: 'top', arrow: 20 });
  });

  it('goes above when there is no room under, clear of the drop and not only of the element', () => {
    const above = place(pinOn(200, 460, 300, 40));
    assert.equal(above?.side, 'above');
    // The drop starts at 426: 426 − 14 − 300.
    assert.equal(above?.top, 112);
  });

  it('never covers its element, on any side it takes', () => {
    for (const pin of [
      pinOn(200, 100, 300, 40),
      pinOn(200, 460, 300, 40),
      pinOn(100, 40, 200, 700),
      pinOn(900, 40, 200, 700),
    ]) {
      const where = place(pin);
      assert.ok(where !== undefined);
      const box = { ...where, ...SIZE };
      const apart =
        box.left + box.width <= pin.element.left ||
        pin.element.left + pin.element.width <= box.left ||
        box.top + box.height <= pin.element.top ||
        pin.element.top + pin.element.height <= box.top;
      assert.ok(apart, `the bubble covers its element on the side ${where.side}`);
    }
  });

  it('leaves a side that would cover the drop of another pin', () => {
    const pin = pinOn(200, 100, 300, 40);
    // Another pin under the element, where the bubble would go.
    const under = { left: 300, top: 300, width: 28, height: 34 };
    assert.equal(place(pin, [under])?.side, 'end');
  });

  it('takes a side that covers a drop rather than no side, when every side in the window does', () => {
    const pin = pinOn(200, 100, 300, 40);
    const everywhere = { left: 0, top: 0, width: 1_280, height: 800 };
    assert.equal(place(pin, [everywhere])?.side, 'below');
  });

  it('starts on the left side in a right-to-left page, for a tall element', () => {
    assert.equal(place(pinOn(500, 40, 200, 700), [], 'rtl')?.edge, 'right');
    assert.equal(place(pinOn(500, 40, 200, 700), [], 'ltr')?.edge, 'left');
  });

  it('gives no side for an element that fills the window', () => {
    assert.equal(place(pinOn(0, 0, 1_280, 800)), undefined);
  });
});

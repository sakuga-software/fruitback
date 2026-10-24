import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PREVIEW_GAP, previewPlace } from './pin-preview.ts';

const WINDOW = { left: 0, top: 0, width: 1_280, height: 800 };
const SIZE = { width: 240, height: 90 };
const drop = (left: number, top: number) => ({ left, top, width: 28, height: 34 });

describe('where the preview of a pin goes (FRU-422)', () => {
  it('goes on the end side of the drop, at its top', () => {
    assert.deepEqual(previewPlace(drop(400, 300), SIZE, WINDOW, [], 'ltr'), { left: 428 + PREVIEW_GAP, top: 300 });
  });

  it('goes on the start side first in a right-to-left page', () => {
    assert.deepEqual(previewPlace(drop(400, 300), SIZE, WINDOW, [], 'rtl'), {
      left: 400 - PREVIEW_GAP - 240,
      top: 300,
    });
  });

  it('goes to the start side when the end of the window has no room', () => {
    assert.deepEqual(previewPlace(drop(1_200, 300), SIZE, WINDOW, [], 'ltr'), {
      left: 1_200 - PREVIEW_GAP - 240,
      top: 300,
    });
  });

  it('leaves the side that would cover a drop next to it', () => {
    // The fan of a spot: the next drop is 30 px to the right.
    const next = drop(430, 300);
    assert.deepEqual(previewPlace(drop(400, 300), SIZE, WINDOW, [next], 'ltr'), {
      left: 400 - PREVIEW_GAP - 240,
      top: 300,
    });
    // Drops on both sides: above.
    const before = drop(370, 300);
    assert.deepEqual(previewPlace(drop(400, 300), SIZE, WINDOW, [next, before], 'ltr'), {
      left: 414 - 120,
      top: 300 - PREVIEW_GAP - 90,
    });
  });

  it('counts the window from where it is scrolled to', () => {
    const scrolled = { ...WINDOW, top: 2_000 };
    // The end side is in the window: a drop at 2 300 in the document is 300 px down the window.
    assert.deepEqual(previewPlace(drop(400, 2_300), SIZE, scrolled, [], 'ltr'), { left: 436, top: 2_300 });
  });

  it('stays in a phone that has room on no side, pushed in from the end side', () => {
    const phone = { left: 0, top: 0, width: 390, height: 844 };
    const wide = { width: 374, height: 90 };
    // No side fits whole beside the drop; above and below the middle runs out of the window too.
    const where = previewPlace(drop(300, 20), wide, phone, [], 'ltr');
    assert.ok(where.left >= PREVIEW_GAP && where.left + wide.width <= 390 - PREVIEW_GAP + 0.001);
    assert.ok(where.top >= PREVIEW_GAP);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAG_MARGIN,
  KEY_STEP,
  KEY_STEP_LARGE,
  NO_OFFSET,
  clampOffset,
  keyMove,
  moved,
  tether,
} from './bubble-drag.ts';

const VIEW = { left: 0, top: 100, width: 1000, height: 800 };
const PLACE = { left: 500, top: 300, width: 344, height: 200 };

describe('the move of a bubble (FRU-420)', () => {
  it('keeps an offset inside the window, 8 px from each edge', () => {
    assert.deepEqual(clampOffset({ x: 40, y: -20 }, PLACE, VIEW), { x: 40, y: -20 });
    // Right and bottom: the bubble stops 8 px before the edge.
    assert.deepEqual(clampOffset({ x: 900, y: 900 }, PLACE, VIEW), {
      x: 1000 - DRAG_MARGIN - 344 - 500,
      y: 100 + 800 - DRAG_MARGIN - 200 - 300,
    });
    // Left and top, in document coordinates: the window starts at the scroll.
    assert.deepEqual(clampOffset({ x: -900, y: -900 }, PLACE, VIEW), {
      x: DRAG_MARGIN - 500,
      y: 100 + DRAG_MARGIN - 300,
    });
  });

  it('keeps the top and the start edge of a bubble larger than the window in sight', () => {
    const tall = { ...PLACE, height: 2000 };
    assert.equal(clampOffset({ x: 0, y: 500 }, tall, VIEW).y, 100 + DRAG_MARGIN - 300);
  });

  it('moves 16 px with an arrow, 48 px with Shift, and goes home with Home', () => {
    assert.deepEqual(keyMove('ArrowRight', false), { x: KEY_STEP, y: 0 });
    assert.deepEqual(keyMove('ArrowLeft', true), { x: -KEY_STEP_LARGE, y: 0 });
    assert.deepEqual(keyMove('ArrowUp', false), { x: 0, y: -16 });
    assert.deepEqual(keyMove('ArrowDown', true), { x: 0, y: 48 });
    assert.equal(keyMove('Home', false), 'home');
    assert.equal(keyMove('Enter', false), undefined);
    assert.equal(moved(NO_OFFSET), false);
    assert.equal(moved({ x: 0, y: 1 }), true);
  });

  it('draws the line from the point of the pin to the nearest point of the bubble, and none under it', () => {
    const line = tether({ left: 100, top: 100, width: 100, height: 100 }, { x: 40, y: 150 });
    assert.deepEqual(line, { x: 40, y: 150, length: 60, angle: 0 });
    const below = tether({ left: 100, top: 100, width: 100, height: 100 }, { x: 150, y: 260 });
    assert.equal(below?.length, 60);
    assert.equal(below?.angle, -Math.PI / 2);
    assert.equal(tether({ left: 100, top: 100, width: 100, height: 100 }, { x: 150, y: 150 }), undefined);
  });
});

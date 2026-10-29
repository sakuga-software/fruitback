import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Box, MOST_MS, STILL_MS, framesOf, settle } from './settle.ts';
import { handFrames, mountPage } from './dom.fixture.ts';

const PRESSED: Box = { left: 21.8, top: 10.45, right: 138.2, bottom: 39.55 };
const RELEASED: Box = { left: 20, top: 10, right: 140, bottom: 40 };

describe('settle (FRU-489)', () => {
  it('says each change of the box, and stops once it stayed the same for a while', () => {
    const frames = handFrames();
    let box = PRESSED;
    let changes = 0;
    settle(
      frames,
      () => box,
      () => (changes += 1),
    );

    // React Aria takes the press off 80 ms after the click: five frames with no change.
    for (let frame = 0; frame < 5; frame += 1) frames.next();
    assert.equal(changes, 0);
    assert.equal(frames.pending(), 1, 'the watch stopped before the press was taken off');
    box = RELEASED;
    frames.next();
    assert.equal(changes, 1);

    // Then still: it stops after STILL_MS, and reads nothing more.
    let ran = 0;
    while (frames.next()) ran += 1;
    assert.equal(changes, 1);
    assert.ok(ran * 16 >= STILL_MS && ran * 16 < STILL_MS + 32, `ran ${ran} frames`);
  });

  it('keeps on while a transition grows the box back, and never after MOST_MS', () => {
    const frames = handFrames();
    let width = 116;
    let changes = 0;
    settle(
      frames,
      () => ({ left: 0, top: 0, right: width, bottom: 30 }),
      () => (changes += 1),
    );
    let ran = 0;
    while (frames.next()) {
      ran += 1;
      width += 0.01;
    }
    assert.equal(ran, Math.ceil(MOST_MS / 16));
    // The first frame reads the box it started on.
    assert.equal(changes, ran - 1);
  });

  it('stops when asked, and does nothing without frames', () => {
    const frames = handFrames();
    let changes = 0;
    let box = PRESSED;
    const stop = settle(
      frames,
      () => box,
      () => (changes += 1),
    );
    stop();
    box = RELEASED;
    assert.equal(frames.next(), false);
    assert.equal(changes, 0);
    stop();

    assert.doesNotThrow(() =>
      settle(
        undefined,
        () => box,
        () => (changes += 1),
      )(),
    );
  });

  it('takes the frames of a window', () => {
    const page = mountPage('<main></main>');
    const frames = framesOf(page.view);
    assert.notEqual(frames, undefined);
    assert.equal(typeof frames?.now(), 'number');
    assert.equal(framesOf(null), undefined);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DESK, NARROW, scaleOf } from './preview-scale.ts';

describe('the scale of the site in the preview of the setup (FRU-354)', () => {
  it('lays a narrow frame out at its own width', () => {
    assert.equal(scaleOf(0), 1);
    assert.equal(scaleOf(358), 1);
    assert.equal(scaleOf(NARROW - 1), 1);
  });

  it('scales the desk width down to a wide frame', () => {
    assert.equal(scaleOf(640), 0.5);
    assert.equal(scaleOf(757.8), 757.8 / DESK);
  });

  it('never enlarges the site: a frame wider than the desk width stays at 1', () => {
    assert.equal(scaleOf(DESK), 1);
    assert.equal(scaleOf(1600), 1);
    assert.equal(scaleOf(2560), 1);
  });
});

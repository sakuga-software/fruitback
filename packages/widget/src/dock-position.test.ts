import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_DOCK_POSITION, DOCK_POSITIONS, parseDockPosition } from './dock-position.ts';

describe('parseDockPosition (FRU-443)', () => {
  it('takes the four corners, bottom right first, and nothing else', () => {
    assert.deepEqual(DOCK_POSITIONS, ['bottom-right', 'bottom-left', 'top-right', 'top-left']);
    assert.equal(DEFAULT_DOCK_POSITION, 'bottom-right');
    for (const corner of DOCK_POSITIONS) assert.equal(parseDockPosition(corner), corner);
    for (const other of ['', 'top', 'Bottom-Right', 'center', 42, null, undefined, {}]) {
      assert.equal(parseDockPosition(other), undefined, String(other));
    }
  });
});

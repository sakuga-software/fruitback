import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cornerBeside } from '../gallery/freeze.ts';

describe('the frozen copy of the widget in the gallery (FRU-579)', () => {
  it('puts the dock of the copy on the other side of the dock of the live widget', () => {
    assert.equal(cornerBeside(undefined), 'bottom-left');
    assert.equal(cornerBeside('bottom-right'), 'bottom-left');
    assert.equal(cornerBeside('bottom-left'), 'bottom-right');
    assert.equal(cornerBeside('top-left'), 'top-right');
    assert.equal(cornerBeside('top-right'), 'top-left');
  });
});

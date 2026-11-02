import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isNonEmptyString, isRecord } from './guards.ts';

/** One meaning for the guards of every parser (FRU-511). Four copies of `isRecord` accepted an array. */
describe('isRecord', () => {
  it('accepts a plain object', () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord(Object.create(null)), true);
  });

  it('refuses an array, null and every primitive', () => {
    for (const value of [[], [{ a: 1 }], null, undefined, 0, 'x', true, Symbol('s'), () => undefined]) {
      assert.equal(isRecord(value), false, String(value));
    }
  });
});

describe('isNonEmptyString', () => {
  it('accepts a string with one character or more, and nothing else', () => {
    assert.equal(isNonEmptyString('a'), true);
    assert.equal(isNonEmptyString(''), false);
    assert.equal(isNonEmptyString(1), false);
    assert.equal(isNonEmptyString(undefined), false);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSeed } from '@fruitback/shared';
import { PIN_SEED } from './plant-a-pin.ts';

describe('the pin the compose smoke test plants', () => {
  it('is a seed the worker accepts, with no field dropped', () => {
    // The script cannot import the fixture at run time, so its seed is written by hand and can drift.
    assert.deepEqual(parseSeed(PIN_SEED), { ok: true, seed: PIN_SEED });
  });
});

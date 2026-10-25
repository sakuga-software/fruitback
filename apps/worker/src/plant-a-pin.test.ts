import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { parseNote } from '@fruitback/shared';
import { PIN_NOTE } from './plant-a-pin.ts';

describe('the pin the compose smoke test plants', () => {
  it('is a note the worker accepts, with no field dropped', () => {
    // The script cannot import the fixture at run time, so its note is written by hand and can drift.
    assert.deepEqual(parseNote(PIN_NOTE), { ok: true, note: PIN_NOTE });
  });
});

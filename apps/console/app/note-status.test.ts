import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NOTE_STAGES as STAGES } from '@fruitback/shared';
import {
  STATUS_NOT_SAVED,
  STATUS_PROBLEMS,
  type StatusChoice,
  offeredFor,
  statusName,
  statusProblemOf,
} from './note-status.ts';
import { DID_NOT_ANSWER, WORKSPACE_SUSPENDED } from './problems.ts';

const [FIRST, SECOND] = STAGES;
const waiting: StatusChoice = { key: 'own:waiting', name: 'Waiting', stage: SECOND };
const parked: StatusChoice = { key: 'own:parked', name: 'Parked', stage: SECOND, hidden: true };
const builtIn: StatusChoice = { key: `own:${FIRST}`, name: '', stage: FIRST };

describe('the status of a note in the list (FRU-384)', () => {
  it('names a built-in status the team did not rename by its stage, and any other by its name', () => {
    assert.equal(
      statusName(builtIn, (stage) => `stage ${stage}`),
      `stage ${FIRST}`,
    );
    assert.equal(
      statusName(waiting, (stage) => `stage ${stage}`),
      'Waiting',
    );
  });

  it('offers no hidden status, except the one the note is in', () => {
    const all = [waiting, parked, builtIn];
    assert.deepEqual(offeredFor(all, waiting.key), [waiting, builtIn]);
    assert.deepEqual(offeredFor(all, parked.key), all);
  });

  it('says each refusal of the worker, and that the status was not saved otherwise', () => {
    for (const [error, sentence] of Object.entries(STATUS_PROBLEMS)) {
      assert.equal(statusProblemOf({ status: 409, error }), sentence);
    }
    assert.equal(statusProblemOf({ status: 0, error: 'network' }), DID_NOT_ANSWER);
    assert.equal(statusProblemOf({ status: 503, error: 'index-unavailable' }), DID_NOT_ANSWER);
    assert.equal(statusProblemOf({ status: 409, error: 'workspace-suspended' }), WORKSPACE_SUSPENDED);
    assert.equal(statusProblemOf({ status: 400, error: 'invalid-status' }), STATUS_NOT_SAVED);
    assert.equal(statusProblemOf({ status: 400, error: 'constructor' }), STATUS_NOT_SAVED);
  });
});

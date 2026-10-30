import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UNREACHABLE } from './api.ts';
import {
  NAME_PROBLEMS,
  SERVER_PROBLEM,
  SITE_NOT_ADDED,
  SITE_PROBLEMS,
  UNREACHABLE_PROBLEM,
  WORKSPACE_NOT_CREATED,
  WORKSPACE_SUSPENDED,
  copyText,
  problemOf,
  writeProblemOf,
} from './problems.ts';

describe('what a refused call says (FRU-164)', () => {
  it('does not blame the address when the worker failed or did not answer', () => {
    // The defect: a 500 on a correct address said « Paste the full address of the site ».
    const said = problemOf({ status: 500, error: 'unknown' }, SITE_PROBLEMS, SITE_NOT_ADDED);

    assert.equal(said, SERVER_PROBLEM);
    assert.notEqual(said, SITE_PROBLEMS['invalid-url']);
    assert.equal(problemOf(UNREACHABLE, SITE_PROBLEMS, SITE_NOT_ADDED), UNREACHABLE_PROBLEM);
    assert.equal(
      problemOf({ status: 503, error: 'store-unavailable' }, NAME_PROBLEMS, WORKSPACE_NOT_CREATED),
      SERVER_PROBLEM,
    );
  });

  // FRU-516: « Fruitback did not answer » was said for a 500 too, where Fruitback had answered.
  it('tells no answer from an answer that is an error, and asks for the connection only for the first', () => {
    assert.match(problemOf(UNREACHABLE, SITE_PROBLEMS, SITE_NOT_ADDED), /Check your connection/);
    assert.doesNotMatch(problemOf({ status: 500, error: 'unknown' }, SITE_PROBLEMS, SITE_NOT_ADDED), /connection/);
    assert.notEqual(UNREACHABLE_PROBLEM, SERVER_PROBLEM);
  });

  it('keeps the sentence of the address for an address the worker refuses: the control', () => {
    assert.equal(
      problemOf({ status: 400, error: 'invalid-url' }, SITE_PROBLEMS, SITE_NOT_ADDED),
      'Paste the full address of the site, starting with https://.',
    );
    assert.equal(
      problemOf({ status: 400, error: 'invalid-name' }, NAME_PROBLEMS, WORKSPACE_NOT_CREATED),
      'A workspace needs a name of one line, up to 80 characters.',
    );
  });

  it('says that the workspace is suspended, and who can change it, for a write it refuses (FRU-328)', () => {
    const refused = { status: 409, error: 'workspace-suspended' };

    assert.equal(problemOf(refused, SITE_PROBLEMS, SITE_NOT_ADDED), WORKSPACE_SUSPENDED);
    assert.equal(writeProblemOf(refused, SITE_NOT_ADDED), WORKSPACE_SUSPENDED);
    assert.match(WORKSPACE_SUSPENDED, /administrator of this instance/);
    // The control: another 409 keeps the sentence of the screen.
    const other = { status: 409, error: 'already-member' };
    assert.equal(writeProblemOf(other, SITE_NOT_ADDED), SITE_NOT_ADDED);
    assert.equal(problemOf(other, SITE_PROBLEMS, SITE_NOT_ADDED), SITE_NOT_ADDED);
  });

  it('says who can do it when the role is refused', () => {
    assert.match(problemOf({ status: 403, error: 'forbidden' }, SITE_PROBLEMS, SITE_NOT_ADDED), /owner or an admin/);
  });

  it('says the sentence of the screen for a refusal it does not know, and never a method of Object', () => {
    assert.equal(
      problemOf({ status: 400, error: 'invalid-visibility' }, SITE_PROBLEMS, SITE_NOT_ADDED),
      SITE_NOT_ADDED,
    );
    assert.equal(problemOf({ status: 400, error: 'constructor' }, SITE_PROBLEMS, SITE_NOT_ADDED), SITE_NOT_ADDED);
  });
});

describe('a copy the browser can refuse (FRU-164)', () => {
  it('says yes when the clipboard took the text', async () => {
    const taken: string[] = [];

    assert.equal(await copyText('<script>', { writeText: async (text) => void taken.push(text) }), true);
    assert.deepEqual(taken, ['<script>']);
  });

  it('says no when the clipboard refuses, and when there is none', async () => {
    const refusing = {
      writeText: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    };

    assert.equal(await copyText('<script>', refusing), false);
    assert.equal(await copyText('<script>', undefined), false);
  });
});

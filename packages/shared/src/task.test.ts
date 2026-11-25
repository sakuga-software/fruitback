import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseNote } from './note.ts';
import { NOTE_MAX_LENGTH } from './note.ts';
import { TASK_KIND, TASK_VERSION, createTask, isTaskIssue, parseTask, taskIssueSchema } from './task.ts';

/** A task written by hand (FRU-657): its own kind, which no reader of a note takes. */

const input = { id: 'task_1', createdAt: '2026-11-24T10:00:00.000Z', title: 'Write the release notes' };

describe('a task (FRU-657)', () => {
  it('round-trips with no field the caller did not give', () => {
    const task = createTask(input);
    assert.deepEqual(task, { ...input, kind: TASK_KIND, v: TASK_VERSION });
    assert.deepEqual(parseTask(JSON.parse(JSON.stringify(task))), { ok: true, task });
  });

  it('is no note: parseNote answers not-found, as a reader of before does', () => {
    assert.deepEqual(parseNote(createTask(input)), { ok: false, reason: 'not-found' });
  });

  it('refuses a note, a newer version, an empty or a multi-line title, and an empty text', () => {
    assert.deepEqual(parseTask({ kind: 'fruitback.note', v: 3 }), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseTask({ ...createTask(input), v: TASK_VERSION + 1 }), {
      ok: false,
      reason: 'unsupported-version',
      version: TASK_VERSION + 1,
    });
    for (const title of ['', ' padded ', 'two\nlines', 'x'.repeat(201)]) {
      assert.equal(parseTask({ ...createTask(input), title }).ok, false, JSON.stringify(title));
    }
    assert.equal(parseTask({ ...createTask(input), text: '' }).ok, false);
    for (const v of [0, 1.5, '1', undefined]) {
      assert.deepEqual(parseTask({ ...createTask(input), v }), {
        ok: false,
        reason: 'invalid',
        message: 'missing or malformed task version',
      });
    }
    assert.deepEqual(parseTask({ ...createTask(input), title: '', createdAt: 'never' }), {
      ok: false,
      reason: 'invalid',
      message: 'createdAt: expected an ISO 8601 timestamp; title: Too small: expected string to have >=1 characters',
    });
    assert.deepEqual(parseTask({ ...createTask(input), title: 'two\nlines' }), {
      ok: false,
      reason: 'invalid',
      message: 'title: expected one trimmed line',
    });
    for (const value of [null, undefined, 'fruitback.task', 3]) {
      assert.deepEqual(parseTask(value), { ok: false, reason: 'not-found' });
    }
    assert.throws(() => createTask({ ...input, title: '' }));
  });

  it('tells a read of a task from a read of a note', () => {
    const issue = { id: '1', identifier: 'FB-1', title: 't', stage: 'new', stateName: '', updatedAt: '' } as const;
    assert.equal(isTaskIssue({ ...issue, task: createTask(input) }), true);
    assert.equal(isTaskIssue({ ...issue, note: {} } as never), false);
  });
});

describe('the kind, the limits and the read of a task (FRU-657)', () => {
  it('is named fruitback.task at version 1, the words of the contract', () => {
    assert.equal(TASK_KIND, 'fruitback.task');
    assert.equal(TASK_VERSION, 1);
  });

  it('takes a text up to NOTE_MAX_LENGTH, and no longer', () => {
    assert.equal(parseTask({ ...createTask(input), text: 'x' }).ok, true);
    assert.equal(parseTask({ ...createTask(input), text: 'x'.repeat(NOTE_MAX_LENGTH) }).ok, true);
    assert.equal(parseTask({ ...createTask(input), text: 'x'.repeat(NOTE_MAX_LENGTH + 1) }).ok, false);
  });

  it('names the field of a nested refusal by its whole path', () => {
    assert.deepEqual(parseTask({ ...createTask(input), client: { id: '' } }), {
      ok: false,
      reason: 'invalid',
      message: 'client.id: Too small: expected string to have >=1 characters',
    });
  });

  it('reads a task as the envelope of a note with task in place of note, and keeps each field', () => {
    const issue = {
      id: '41',
      identifier: 'FB-41',
      title: 'Write the release notes',
      stage: 'todo',
      stateName: 'To do',
      status: 'own:todo',
      updatedAt: '2026-11-24T10:00:00.000Z',
      comments: [{ id: 'c1', body: 'Started.', createdAt: '2026-11-24T11:00:00.000Z' }],
      mine: true,
      task: createTask(input),
    };
    assert.deepEqual(taskIssueSchema.parse(issue), issue);
    // A field of a note that a task has not, and a note in place of the task, are not a task.
    assert.equal('note' in taskIssueSchema.parse({ ...issue, note: {} }), false);
    assert.equal(taskIssueSchema.safeParse({ ...issue, task: undefined }).success, false);
  });
});

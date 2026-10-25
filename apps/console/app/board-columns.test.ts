import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type BoardNote, boardColumns, takesNotes } from './board-columns.ts';
import type { StatusChoice } from './note-status.ts';

/** The statuses of a site: the team added « Waiting » and hid « Parked ». */
const STATUSES: StatusChoice[] = [
  { key: 'own:waiting', name: 'Waiting', stage: 'todo' },
  { key: 'own:parked', name: 'Parked', stage: 'todo', hidden: true },
  { key: 'own:new', name: '', stage: 'new' },
  { key: 'own:todo', name: '', stage: 'todo' },
  { key: 'own:progress', name: '', stage: 'progress' },
  { key: 'own:done', name: 'Shipped', stage: 'done' },
  { key: 'own:closed', name: '', stage: 'closed' },
];

const keys = (columns: { key: string; notes: BoardNote[] }[]) =>
  columns.map((column) => `${column.key}=${column.notes.map((note) => note.id).join(',')}`);

describe('the columns of the board of the notes (FRU-436)', () => {
  it('are the stages, in their order, without the statuses of one site', () => {
    const notes: BoardNote[] = [
      { id: 'a', stage: 'done' },
      { id: 'b', stage: 'new' },
      { id: 'c', stage: 'new' },
    ];
    assert.deepEqual(keys(boardColumns(notes, undefined)), [
      'stage:new=b,c',
      'stage:todo=',
      'stage:progress=',
      'stage:done=a',
      'stage:closed=',
    ]);
    assert.equal(boardColumns(notes, []).length, 5);
  });

  it('are the shown statuses of the site, in its order, each with its notes', () => {
    const notes: BoardNote[] = [
      { id: 'a', stage: 'todo', status: 'own:waiting' },
      { id: 'b', stage: 'new', status: 'own:new' },
    ];
    assert.deepEqual(keys(boardColumns(notes, STATUSES)), [
      'own:waiting=a',
      'own:new=b',
      'own:todo=',
      'own:progress=',
      'own:done=',
      'own:closed=',
    ]);
  });

  it('show a hidden status only when a note is in it, and it takes no note', () => {
    const columns = boardColumns([{ id: 'a', stage: 'todo', status: 'own:parked' }], STATUSES);
    assert.deepEqual(keys(columns).slice(0, 2), ['own:waiting=', 'own:parked=a']);
    assert.equal(takesNotes(columns[1]!), false);
    assert.equal(takesNotes(columns[0]!), true);
  });

  it('put a note of a tracker in the built-in status of its stage', () => {
    // « Waiting » comes first and is of the stage « todo » too: the built-in one is chosen.
    const columns = boardColumns([{ id: 't', stage: 'todo' }], STATUSES);
    assert.deepEqual(columns.find((column) => column.notes.length > 0)?.key, 'own:todo');
  });

  it('put a note of a tracker in the first shown status of its stage, when the built-in one is hidden', () => {
    const hidden = STATUSES.map((status) =>
      status.key === 'own:todo' ? { ...status, hidden: true as const } : status,
    );
    const columns = boardColumns([{ id: 't', stage: 'todo' }], hidden);
    assert.equal(columns.find((column) => column.notes.length > 0)?.key, 'own:waiting');
  });

  it('give a stage that no shown status takes a column of its own, after the statuses', () => {
    const only = STATUSES.filter((status) => status.stage !== 'closed');
    const columns = boardColumns([{ id: 'x', stage: 'closed' }], only);
    assert.equal(columns.at(-1)?.key, 'stage:closed');
    assert.deepEqual(
      columns.at(-1)?.notes.map((note) => note.id),
      ['x'],
    );
    assert.equal(takesNotes(columns.at(-1)!), false);
  });

  it('put a note whose status the site no longer has in the status of its stage', () => {
    const columns = boardColumns([{ id: 'g', stage: 'progress', status: 'own:gone' }], STATUSES);
    assert.equal(columns.find((column) => column.notes.length > 0)?.key, 'own:progress');
  });
});

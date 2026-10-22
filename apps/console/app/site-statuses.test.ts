import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OWN,
  type StatusRow,
  colourOf,
  isChanged,
  isDeletable,
  keyFor,
  moved,
  ratioOf,
  reads,
  resetOf,
  rowOf,
  statusesOf,
} from './site-statuses.ts';

const row = (fields: Partial<StatusRow> & Pick<StatusRow, 'source' | 'key' | 'stage'>): StatusRow => ({
  name: null,
  color: null,
  textColor: null,
  position: 0,
  origin: 'tracker',
  hidden: false,
  ...fields,
});

describe('the statuses of a site, as the screen holds them (FRU-371)', () => {
  it('draws the five built-in statuses of the worker store when the worker keeps no row', () => {
    const listed = statusesOf('own', OWN, []);

    assert.deepEqual(
      listed.map((each) => [each.key, each.stage, each.builtIn, each.kept]),
      [
        ['new', 'new', true, false],
        ['todo', 'todo', true, false],
        ['progress', 'progress', true, false],
        ['done', 'done', true, false],
        ['closed', 'closed', true, false],
      ],
    );
  });

  it('puts a row in place of its default, and a status the team added at the place it was written', () => {
    const listed = statusesOf('own', OWN, [
      row({ source: OWN, key: 'closed', stage: 'closed', name: 'Won’t fix', position: 4 }),
      row({ source: OWN, key: 'waiting', stage: 'todo', origin: 'team', position: 5 }),
      // Another source of the same site is not of this list.
      row({ source: 'c1', key: 'open', stage: 'new' }),
    ]);

    assert.deepEqual(
      listed.map((each) => each.key),
      ['new', 'todo', 'progress', 'done', 'closed', 'waiting'],
    );
    assert.equal(listed.find((each) => each.key === 'closed')?.name, 'Won’t fix');
    assert.equal(listed.find((each) => each.key === 'waiting')?.builtIn, false);
  });

  it('draws the four states of GitHub for a GitHub connector, and adds nothing to them', () => {
    const listed = statusesOf('github', 'c9', [
      row({ source: 'c9', key: 'closed:completed', stage: 'done', name: 'Fixed', position: 1 }),
      row({ source: 'c9', key: 'stray', stage: 'todo' }),
    ]);

    assert.deepEqual(
      listed.map((each) => [each.key, each.stage, each.name]),
      [
        ['open', 'new', null],
        ['closed:completed', 'done', 'Fixed'],
        ['closed:not_planned', 'closed', null],
        ['closed:duplicate', 'closed', null],
      ],
    );
  });

  it('draws the states of a Linear team, in its order, with its names and colours, and a row in place of its state (FRU-368)', () => {
    const states = [
      { id: 'b1', name: 'Backlog', type: 'backlog', stage: 'new' as const, color: '#bec2c8' },
      { id: 'd1', name: 'Done', type: 'completed', stage: 'done' as const },
    ];
    const listed = statusesOf('linear', 'l1', [row({ source: 'l1', key: 'd1', stage: 'closed', position: 1 })], states);

    assert.deepEqual(
      listed.map((each) => [each.key, each.stage, each.trackerName, each.trackerColor, each.kept]),
      [
        ['b1', 'new', 'Backlog', '#bec2c8', false],
        ['d1', 'closed', 'Done', undefined, true],
      ],
    );
    // Re-staged: « Reset » gives back the stage Linear's type gives it. A state of Linear is never deleted here.
    assert.equal(isChanged(listed[1]!), true);
    assert.equal(isDeletable(listed[1]!), false);
    assert.equal(isChanged(listed[0]!), false);
  });

  it('says « Reset » for a default that changed, « Delete » for a status the team added, and never both', () => {
    const listed = statusesOf('own', OWN, [
      row({ source: OWN, key: 'waiting', stage: 'todo', origin: 'team', position: 5, color: '#7dd3fc' }),
    ]);
    const fresh = listed.find((each) => each.key === 'new');
    const waiting = listed.find((each) => each.key === 'waiting');
    const restaged = { ...statusesOf('github', 'c9', [])[0]!, stage: 'todo' as const };

    assert.equal(isChanged(fresh!), false);
    assert.equal(isChanged({ ...fresh!, name: 'Inbox' }), true);
    assert.equal(isChanged(restaged), true);
    assert.equal(isChanged(waiting!), false);
    assert.equal(isDeletable(waiting!), true);
    assert.equal(isDeletable(fresh!), false);
    assert.equal(isDeletable(restaged), false);
  });

  it('resets a status to its default at the same place, and writes the row the worker takes', () => {
    const [, todo] = statusesOf('own', OWN, [
      row({
        source: OWN,
        key: 'todo',
        stage: 'todo',
        name: 'Next',
        color: '#7dd3fc',
        textColor: '#000000',
        position: 1,
      }),
    ]);
    const reset = resetOf(todo!);

    assert.deepEqual(rowOf(reset), row({ source: OWN, key: 'todo', stage: 'todo', position: 1 }));
  });

  it('moves a status one place and numbers the whole list again, and refuses past an end', () => {
    const listed = statusesOf('own', OWN, []);
    const down = moved(listed, 1, 1);

    assert.deepEqual(
      down?.map((each) => [each.key, each.position]),
      [
        ['new', 0],
        ['progress', 1],
        ['todo', 2],
        ['done', 3],
        ['closed', 4],
      ],
    );
    assert.equal(moved(listed, 0, -1), undefined);
    assert.equal(moved(listed, 4, 1), undefined);
  });

  it('makes a key of the name, unique, never a stage, and one of its own for a name of no latin letter', () => {
    assert.equal(keyFor('Waiting for client', []), 'waiting-for-client');
    assert.equal(keyFor('Waiting for client', ['waiting-for-client']), 'waiting-for-client-2');
    assert.equal(keyFor('Déjà vu !', []), 'deja-vu');
    assert.equal(keyFor('Done', []), 'done-2');
    assert.equal(
      keyFor('完了', [], () => 0.5),
      `status-${Math.floor(0.5 * 36 ** 6).toString(36)}`,
    );
    assert.match(keyFor('x'.repeat(300), []), /^x{48}$/);
  });

  it('reads a typed colour, and measures a text on it as the worker does', () => {
    assert.equal(colourOf(' 7DD3FC '), '#7dd3fc');
    assert.equal(colourOf('#7dd3fc'), '#7dd3fc');
    assert.equal(colourOf('#7dd3f'), undefined);
    assert.equal(colourOf('blue'), undefined);
    // White on #0ea5e9 is under 4.5:1 (frame C of the board); ink on it reads.
    assert.equal(reads(ratioOf('#0ea5e9', '#ffffff')), false);
    assert.equal(reads(ratioOf('#0ea5e9', '#18181b')), true);
    assert.equal(reads(ratioOf(undefined, '#18181b')), false);
  });
});

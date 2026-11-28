import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import type { World } from './console-world.fixture.ts';
import type { NoteIndex } from './notes-index.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { type NoteStore, StoreError } from './store.ts';
import { createMemoryStore } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { type Handle, KEY_A, KEY_B, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * A visitor known by the key of their browser deletes their open note (FRU-702), through the route of
 * a member's withdrawal (FRU-605): `POST /feedback/<id>/withdraw`. The note is closed as withdrawn in
 * its store, nothing is deleted there, and its pin leaves the page for every reader.
 */

/** A site, and a note that the browser of key A left on it. */
async function aVisitorNote(options: Parameters<typeof aVisitorSite>[0] = {}) {
  const site = await aVisitorSite(options);
  const issue = await site.send(site.noteOf('vd_1', 'The button is too small.', 'Camille'), { key: KEY_A });

  return { ...site, issue };
}

const indexRow = async (world: Awaited<ReturnType<typeof aVisitorSite>>['world']) =>
  (await rowsOf(world.database, `SELECT note_id, stage, removed_at FROM note_index WHERE note_id = 'vd_1'`))[0];

/** An index that keeps every write but the mark of a deletion, which it refuses. */
const refusingMarks = (index: NoteIndex): NoteIndex => ({
  ...index,
  remove: async () => {
    throw new Error('the index is down');
  },
});

/** The worker's own store, whose withdrawals fail as a store that does not answer. */
const failingWithdrawals = (world: World): NoteStore => {
  const store = createPostgresNoteStore(world.database);

  return {
    ...store,
    withdraw: async () => {
      throw new StoreError('the store is down');
    },
  };
};

describe('a visitor deletes their open note (FRU-702)', () => {
  it('closes it as withdrawn, says who in a reply, and its pin leaves the page for every reader', async () => {
    const { world, withdraw, read, bobToken, issue } = await aVisitorNote();
    assert.equal((await read({ key: KEY_A })).get('vd_1')?.withdrawable, true);

    const deleted = await withdraw(issue, { key: KEY_A });

    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.stage, 'closed');
    assert.match(deleted.body.comment.body, /^\*\*Camille\*\* via Fruitback · not verified\nWithdrew the note$/u);
    for (const who of [{ key: KEY_A }, { key: KEY_B }, {}, { token: bobToken }]) {
      assert.equal((await read(who)).has('vd_1'), false, JSON.stringify(who));
    }
    // Nothing is deleted: the team keeps the note, closed, and its row in the index.
    const kept = await rowsOf(world.database, 'SELECT stage FROM notes');
    assert.deepEqual(
      kept.map((row) => row.stage),
      ['closed'],
    );
    const row = await indexRow(world);
    assert.equal(row?.stage, 'closed');
    assert.equal(typeof row?.removed_at === 'number' || typeof row?.removed_at === 'string', true);
  });

  it('refuses another browser, no key, a key of another shape, a member and a token, and changes nothing', async () => {
    const { world, withdraw, read, bobToken, issue } = await aVisitorNote();

    assert.equal((await withdraw(issue, { key: KEY_B })).status, 403);
    assert.equal((await withdraw(issue, {})).status, 401);
    assert.equal((await withdraw(issue, { key: 'not-a-key' })).status, 401);
    assert.equal((await withdraw(issue, { token: bobToken })).status, 403);
    // FRU-706: a token that is no identity gives nothing more than the browser it came with.
    assert.equal((await withdraw(issue, { key: KEY_B, token: 'not.a.session' })).status, 403);
    assert.equal((await withdraw(issue, { token: 'not.a.session' })).status, 401);

    assert.equal((await read({ key: KEY_B })).get('vd_1')?.stage, 'new');
    assert.equal((await read({ key: KEY_B })).get('vd_1')?.withdrawable, undefined);
    assert.equal((await indexRow(world))?.removed_at, null);
  });

  it('refuses once the team took the note on, and keeps its pin', async () => {
    for (const stage of ['done', 'closed']) {
      const { withdraw, read, moveTo, issue } = await aVisitorNote();
      await moveTo(issue, stage);

      const refused = await withdraw(issue, { key: KEY_A });

      assert.equal(refused.status, 409, stage);
      assert.equal(refused.body.error, 'not-open');
      assert.equal((await read()).has('vd_1'), true, stage);
    }
  });

  it('refuses a visitor on a site that no longer takes the notes of anybody', async () => {
    const { world, site, withdraw, issue } = await aVisitorNote();
    await rowsOf(world.database, `UPDATE sites SET visibility = 'members', writers = 'members' WHERE id = '${site}'`);

    assert.equal((await withdraw(issue, { key: KEY_A })).status, 403);
    assert.equal((await indexRow(world))?.removed_at, null);
  });

  it('refuses a visitor where the tab « Access » says « Never », offers no deletion, and follows it back (FRU-703)', async () => {
    const { world, site, withdraw, read, issue } = await aVisitorNote();
    await rowsOf(world.database, `UPDATE sites SET visitor_delete = 'never' WHERE id = '${site}'`);

    const refused = await withdraw(issue, { key: KEY_A });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'not-allowed' });
    assert.equal((await read({ key: KEY_A })).get('vd_1')?.withdrawable, undefined);
    assert.equal((await indexRow(world))?.removed_at, null);

    // « While open » again: the same browser deletes it.
    await rowsOf(world.database, `UPDATE sites SET visitor_delete = 'while-open' WHERE id = '${site}'`);
    assert.equal((await withdraw(issue, { key: KEY_A })).status, 200);
  });

  it('keeps the pin of a note a member withdraws: the team sees it closed (FRU-605)', async () => {
    const { send, noteOf, withdraw, read, bobToken } = await aVisitorSite();
    const issue = await send(noteOf('vd_bob'), { token: bobToken });

    assert.equal((await withdraw(issue, { token: bobToken })).status, 200);
    assert.equal((await read()).get('vd_bob')?.stage, 'closed');
  });

  it('counts the deletions of a visitor with their replies: 5 a minute from one address', async () => {
    const { send, noteOf, withdraw } = await aVisitorSite();
    const answers = [];
    for (let each = 1; each <= 6; each += 1) {
      const issue = await send(noteOf(`vd_${each}`), { key: KEY_A });
      answers.push((await withdraw(issue, { key: KEY_A })).status);
    }

    assert.deepEqual(answers, [200, 200, 200, 200, 200, 429]);
  });

  it('withdraws nothing when the index does not answer, so a pin never stays after « Deleted »', async () => {
    const { world, withdraw, read, issue } = await aVisitorNote({ indexOf: refusingMarks });

    const refused = await withdraw(issue, { key: KEY_A });

    assert.equal(refused.status, 502, JSON.stringify(refused.body));
    assert.deepEqual(
      (await rowsOf(world.database, 'SELECT stage FROM notes')).map((row) => row.stage),
      ['new'],
    );
    assert.equal((await read()).get('vd_1')?.stage, 'new');
  });

  it('takes the mark back when the store withdraws nothing, so the pin stays with its note', async () => {
    const { world, withdraw, read, issue } = await aVisitorNote({ storeOf: failingWithdrawals });

    const failed = await withdraw(issue, { key: KEY_A });

    assert.equal(failed.status, 502, JSON.stringify(failed.body));
    assert.equal((await indexRow(world))?.removed_at, null);
    assert.equal((await read()).has('vd_1'), true);
  });

  it('cancels the issue of a tracker, and its pin leaves the page (Linear)', async () => {
    const { withdraw, read, issue } = await aVisitorNote({ storeOf: () => createMemoryStore() });

    const deleted = await withdraw(issue, { key: KEY_A });

    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(deleted.body.stage, 'closed');
    assert.equal((await read()).has('vd_1'), false);
  });
});

/**
 * Each guard of FRU-702, taken out of a copy of its module: the case that holds it sees the change.
 * The real module is the control of each one, in the same world. The open stage is held twice, by
 * the route and by the store under the lock of the row, as for an edit (`visitor-edit.test.ts`).
 */
describe('the guards of the deletion of a visitor, each planted out (FRU-702)', () => {
  type Check = (site: Awaited<ReturnType<typeof aVisitorNote>>) => Promise<boolean>;
  const WITHDRAW = 'export async function postWithdraw(';
  const PLANTS: readonly { guard: string; file: string; after?: string; from: string; to: string; holds: Check }[] = [
    {
      guard: 'another browser does not delete the note',
      file: 'edit-routes.ts',
      after: WITHDRAW,
      from: 'if (author === undefined || author !== caller.author) return json(403',
      to: 'if (author === undefined) return json(403',
      holds: async ({ withdraw, issue }) => (await withdraw(issue, { key: KEY_B })).status === 403,
    },
    {
      guard: 'a site that does not take the notes of anybody lets no visitor delete',
      file: 'visitor-key.ts',
      from: "return (action === 'edit' ? client?.visitorEdit : client?.visitorDelete) === 'while-open';",
      to: 'return true;',
      holds: async ({ world, site, withdraw, issue }) => {
        await rowsOf(
          world.database,
          `UPDATE sites SET visibility = 'members', writers = 'members' WHERE id = '${site}'`,
        );

        return (await withdraw(issue, { key: KEY_A })).status === 403;
      },
    },
    {
      guard: 'a site whose visitors may not delete lets no visitor delete (FRU-703)',
      file: 'visitor-key.ts',
      from: "=== 'while-open';",
      to: '!== undefined;',
      holds: async ({ world, site, withdraw, issue }) => {
        await rowsOf(world.database, `UPDATE sites SET visitor_delete = 'never' WHERE id = '${site}'`);

        return (await withdraw(issue, { key: KEY_A })).status === 403;
      },
    },
    {
      guard: 'the pin of a deleted note leaves the page',
      file: 'feedback-routes.ts',
      from: 'const all = await withoutRemoved(noteIndex, route.client?.workspace, clientId, read);',
      to: 'const all = read;',
      holds: async ({ withdraw, read, issue }) => {
        await withdraw(issue, { key: KEY_A });

        return !(await read()).has('vd_1');
      },
    },
    {
      guard: 'a member who withdraws keeps the pin',
      file: 'edit-routes.ts',
      from: "const marks = caller.kind === 'visitor' ? context.noteIndex : undefined;",
      to: 'const marks = context.noteIndex;',
      holds: async ({ send, noteOf, withdraw, read, bobToken }) => {
        const issue = await send(noteOf('vd_bob'), { token: bobToken });
        await withdraw(issue, { token: bobToken });

        return (await read()).has('vd_bob');
      },
    },
    {
      guard: 'an index that does not answer withdraws nothing',
      file: 'edit-routes.ts',
      from: 'if (marks !== undefined) await markRemoved(',
      to: 'if (false) await markRemoved(',
      holds: async ({ handle }) => {
        const site = await aVisitorNote({ indexOf: refusingMarks, ...(handle === undefined ? {} : { handle }) });

        return (await site.withdraw(site.issue, { key: KEY_A })).status === 502;
      },
    },
    {
      guard: 'the mark is taken back when the store withdraws nothing',
      file: 'edit-routes.ts',
      from: 'if (marks !== undefined) await unmark(marks);',
      to: '',
      holds: async ({ handle }) => {
        const site = await aVisitorNote({ storeOf: failingWithdrawals, ...(handle === undefined ? {} : { handle }) });
        await site.withdraw(site.issue, { key: KEY_A });

        return (await indexRow(site.world))?.removed_at === null;
      },
    },
    {
      guard: 'the deletions of a visitor are counted',
      file: 'edit-routes.ts',
      after: WITHDRAW,
      from: "if (caller.kind === 'visitor' && !(await checkReplyLimit(kv, context.context.clientIp))) {",
      to: 'if (false) {',
      holds: async ({ send, noteOf, withdraw }) => {
        let last = 0;
        for (let each = 1; each <= 6; each += 1) {
          last = (await withdraw(await send(noteOf(`vd_n${each}`), { key: KEY_A }), { key: KEY_A })).status;
        }

        return last === 429;
      },
    },
  ];

  for (const plant of PLANTS) {
    it(`sees « ${plant.guard} » go when it is taken out`, async () => {
      assert.equal(await plant.holds(await aVisitorNote()), true, 'the control: the real module holds the guard');

      const mutant = await mutatedModule(plant.file, {
        ...(plant.after === undefined ? {} : { after: plant.after }),
        from: plant.from,
        to: plant.to,
      });
      try {
        const handle = mutant.module.handleRequest as Handle;
        assert.equal(await plant.holds(await aVisitorNote({ handle })), false, plant.guard);
      } finally {
        mutant.remove();
      }
    });
  }
});

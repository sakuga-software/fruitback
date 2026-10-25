import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_NOTE_STAGE, NOTE_STAGES, type NoteStatus, offeredStatuses, statusOf } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';

/**
 * The statuses of a site through the console (FRU-366), and what `GET /feedback` says of them: the
 * list of the site, and the status of each note that the worker keeps.
 */

const world = worlds();
const PAGE = 'https://acme.test/pricing';
const [NEW, , , DONE, CLOSED] = NOTE_STAGES;

/** A workspace of Alice with one site that everybody reads, and her console session. */
async function acme(): Promise<{ team: World; token: string; workspace: string; site: string }> {
  const team = await world();
  const { token } = await signInTo(team, 'alice@acme.dev');
  const workspace = await workspaceIn(team, token);
  const site = (await team.accounts.addSite(workspace, { origin: 'https://acme.test', visibility: 'everyone' })).id;

  return { team, token, workspace, site };
}

/** A note the worker keeps on the page, in `stage` and in the status `key` (NULL: the built-in one). */
async function plant(team: World, site: string, stage: string, key: string | null, id: string): Promise<void> {
  const seed = noteFixture({ id, client: { id: site }, page: { url: PAGE, path: '/pricing' } });
  await rowsOf(
    team.database,
    `INSERT INTO notes (client_id, page_url, stage, status_key, payload, created_at, updated_at)
       VALUES ('${site}', '${PAGE}', '${stage}', ${key === null ? 'NULL' : `'${key}'`}, '${JSON.stringify(seed)}', 1, 1)`,
  );
}

async function read(
  team: World,
  site: string,
): Promise<{ statuses: NoteStatus[]; issues: { stage: string; status?: string }[] }> {
  // The notes the worker keeps, in the database of the world: its default store is the one in memory.
  const answer = await callOn(
    team,
    'GET',
    `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`,
    { origin: 'https://acme.test' },
    { store: createPostgresNoteStore(team.database) },
  );
  assert.equal(answer.status, 200, await answer.clone().text());

  return (await answer.json()) as { statuses: NoteStatus[]; issues: { stage: string; status?: string }[] };
}

const path = (workspace: string, site: string, more = '') =>
  `/console/workspaces/${workspace}/sites/${site}/statuses${more}`;

describe('the statuses of a site, through the console (FRU-366)', () => {
  it('adds, changes, lists and orders the statuses of a site, and keeps the origin the worker decides', async () => {
    const { team, token, workspace, site } = await acme();

    const waiting = { source: 'own', key: 'waiting', name: 'Waiting for the client', stage: NEW, color: '#7dd3fc' };
    const put = await callOn(team, 'POST', path(workspace, site), { token, body: { ...waiting, origin: 'tracker' } });
    assert.equal(put.status, 200, await put.clone().text());
    // A status the team adds to the worker's store is `team`, whatever the request said.
    assert.equal(((await put.json()) as { status: { origin: string } }).status.origin, 'team');

    const renamed = await callOn(team, 'POST', path(workspace, site), {
      token,
      body: { source: 'own', key: DONE, name: 'Shipped', stage: DONE, position: 1 },
    });
    assert.equal(renamed.status, 200);

    const ordered = await callOn(team, 'POST', path(workspace, site, '/order'), {
      token,
      body: {
        order: [
          { source: 'own', key: DONE },
          { source: 'own', key: 'waiting' },
        ],
      },
    });
    assert.equal(ordered.status, 200, await ordered.clone().text());

    const listed = await callOn(team, 'GET', path(workspace, site), { token });
    assert.equal(listed.status, 200);
    const { statuses } = (await listed.json()) as {
      statuses: { key: string; position: number; origin: string; name: string | null }[];
    };
    assert.deepEqual(
      statuses.map((status) => [status.key, status.position, status.origin, status.name]),
      [
        [DONE, 0, 'tracker', 'Shipped'],
        ['waiting', 1, 'team', 'Waiting for the client'],
      ],
    );
  });

  it('refuses what a status cannot be, and says why', async () => {
    const { team, token, workspace, site } = await acme();
    const refusal = async (body: unknown) => {
      const answer = await callOn(team, 'POST', path(workspace, site), { token, body });
      assert.equal(answer.status, 400, JSON.stringify(body));

      return ((await answer.json()) as { refusal: string }).refusal;
    };

    // Under 4.5:1: #ffaaaa on #a52a3a is 3.87:1.
    assert.equal(
      await refusal({ source: 'own', key: 'x', stage: CLOSED, color: '#a52a3a', textColor: '#ffaaaa' }),
      'text-under-contrast',
    );
    assert.equal(await refusal({ source: 'own', key: 'x', stage: CLOSED, color: 'red' }), 'invalid-color');
    // A built-in status is the status of its stage.
    assert.equal(await refusal({ source: 'own', key: DONE, stage: CLOSED }), 'built-in-stage');
    // A connector this site does not send to.
    assert.equal(await refusal({ source: 'con_elsewhere', key: 'st_1', stage: DONE }), 'unknown-source');
    assert.deepEqual(
      ((await (await callOn(team, 'GET', path(workspace, site), { token })).json()) as { statuses: unknown[] })
        .statuses,
      [],
    );
  });

  it('refuses an order that names a status twice, or one the site does not have, and changes nothing', async () => {
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), {
      token,
      body: { source: 'own', key: 'a', stage: NEW, position: 4 },
    });

    const twice = await callOn(team, 'POST', path(workspace, site, '/order'), {
      token,
      body: {
        order: [
          { source: 'own', key: 'a' },
          { source: 'own', key: 'a' },
        ],
      },
    });
    assert.equal(twice.status, 400);
    const unknown = await callOn(team, 'POST', path(workspace, site, '/order'), {
      token,
      body: {
        order: [
          { source: 'own', key: 'a' },
          { source: 'own', key: 'gone' },
        ],
      },
    });
    assert.deepEqual([unknown.status, await unknown.json()], [400, { error: 'unknown-status' }]);
    const rows = await rowsOf(team.database, `SELECT key, position FROM statuses WHERE site_id = '${site}'`);
    assert.deepEqual(rows, [{ key: 'a', position: 4 }], 'the first status kept its place: the order rolled back');
  });

  it('does not remove a status that holds notes until it is told where they go', async () => {
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'waiting', stage: NEW } });
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'parked', stage: CLOSED } });
    await plant(team, site, NEW as string, 'waiting', 'seed-1');
    await plant(team, site, NEW as string, 'waiting', 'seed-2');

    const refused = await callOn(team, 'DELETE', path(workspace, site, '/own/waiting'), { token });
    assert.deepEqual([refused.status, await refused.json()], [409, { error: 'status-in-use', notes: 2 }]);
    // An empty `moveTo` is none: the same answer, not `invalid-target`.
    const empty = await callOn(team, 'DELETE', path(workspace, site, '/own/waiting?moveTo='), { token });
    assert.deepEqual([empty.status, await empty.json()], [409, { error: 'status-in-use', notes: 2 }]);
    const nowhere = await callOn(team, 'DELETE', path(workspace, site, '/own/waiting?moveTo=gone'), { token });
    assert.deepEqual([nowhere.status, await nowhere.json()], [400, { error: 'invalid-target' }]);

    const moved = await callOn(team, 'DELETE', path(workspace, site, '/own/waiting?moveTo=parked'), { token });
    assert.deepEqual([moved.status, await moved.json()], [200, { moved: 2 }]);
    // The notes take the status and its stage.
    assert.deepEqual(
      await rowsOf(team.database, `SELECT DISTINCT stage, status_key FROM notes WHERE client_id = '${site}'`),
      [{ stage: CLOSED, status_key: 'parked' }],
    );

    // To a built-in status: the notes have no status of their own, and the stage of that one.
    const back = await callOn(team, 'DELETE', path(workspace, site, `/own/parked?moveTo=${DONE}`), { token });
    assert.deepEqual([back.status, await back.json()], [200, { moved: 2 }]);
    assert.deepEqual(
      await rowsOf(team.database, `SELECT DISTINCT stage, status_key FROM notes WHERE client_id = '${site}'`),
      [{ stage: DONE, status_key: null }],
    );
    assert.deepEqual(await rowsOf(team.database, `SELECT key FROM statuses WHERE site_id = '${site}'`), []);
  });

  it('counts the notes in each status of the store, 0 for one with none, and those of its site only (FRU-386)', async () => {
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'waiting', stage: NEW } });
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'parked', stage: CLOSED } });
    await plant(team, site, NEW as string, 'waiting', 'seed-1');
    await plant(team, site, NEW as string, 'waiting', 'seed-2');
    // No status of its own: the built-in status of its stage.
    await plant(team, site, DONE as string, null, 'seed-3');
    // The control: a note of another site of the same workspace, in a status of the same key.
    const elsewhere = (
      await team.accounts.addSite(workspace, { origin: 'https://globex.test', visibility: 'everyone' })
    ).id;
    await plant(team, elsewhere, NEW as string, 'waiting', 'seed-4');

    const listed = await callOn(team, 'GET', path(workspace, site), { token });
    assert.equal(listed.status, 200, await listed.clone().text());
    const { notes } = (await listed.json()) as { notes: Record<string, number> };
    assert.deepEqual(notes, {
      ...Object.fromEntries(NOTE_STAGES.map((stage) => [stage, 0])),
      [DONE as string]: 1,
      waiting: 2,
      parked: 0,
    });

    // The number the list gives is the one a delete with no `moveTo` refuses with.
    const refused = await callOn(team, 'DELETE', path(workspace, site, '/own/waiting'), { token });
    assert.deepEqual([refused.status, await refused.json()], [409, { error: 'status-in-use', notes: 2 }]);
  });

  it('writes the new stage of the notes it moves in the index of the notes, with no read of their page', async () => {
    // Found in the heavy review of #487: the index learns a stage from a read of the page only.
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'waiting', stage: NEW } });
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'parked', stage: CLOSED } });
    await plant(team, site, NEW as string, 'waiting', 'seed-1');
    await read(team, site);
    const indexed = () => rowsOf(team.database, `SELECT note_id, stage FROM note_index WHERE site_id = '${site}'`);
    assert.deepEqual(await indexed(), [{ note_id: 'seed-1', stage: NEW }], 'the read wrote the note in the index');

    await callOn(team, 'DELETE', path(workspace, site, '/own/waiting?moveTo=parked'), { token });
    assert.deepEqual(await indexed(), [{ note_id: 'seed-1', stage: CLOSED }]);

    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'parked', stage: DONE } });
    assert.deepEqual(await indexed(), [{ note_id: 'seed-1', stage: DONE }]);
  });

  it('reads the page of a note it moves again at once, not from the cache of the page', async () => {
    // Found in the balanced review of #487: a cached read kept the old stage up to CACHE_TTL_MS.
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'waiting', stage: NEW } });
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'parked', stage: CLOSED } });
    await plant(team, site, NEW as string, 'waiting', 'seed-1');
    const pins = async () => (await read(team, site)).issues.map((issue) => [issue.stage, issue.status]);
    assert.deepEqual(await pins(), [[NEW, 'own:waiting']]);

    await callOn(team, 'DELETE', path(workspace, site, '/own/waiting?moveTo=parked'), { token });
    assert.deepEqual(await pins(), [[CLOSED, 'own:parked']]);

    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'parked', stage: DONE } });
    assert.deepEqual(await pins(), [[DONE, 'own:parked']]);
  });

  it('gives the list of the statuses changed at the next read, while the notes of the page are still in the cache', async () => {
    // Asked in the balanced review of #487: `statuses` is never in the cached answer. A rename moves no
    // note, so nothing invalidates the page, and the list must change all the same.
    const { team, token, workspace, site } = await acme();
    await plant(team, site, DONE as string, null, 'seed-1');
    const first = await read(team, site);
    assert.equal(first.statuses.find((status) => status.key === `own:${DONE}`)?.name, '');

    await callOn(team, 'POST', path(workspace, site), {
      token,
      body: { source: 'own', key: DONE, name: 'Shipped', stage: DONE, color: '#5560c4' },
    });
    const second = await read(team, site);

    assert.deepEqual(second.statuses[0], {
      key: `own:${DONE}`,
      name: 'Shipped',
      stage: DONE,
      color: '#5560c4',
      textColor: '#ffffff',
    });
    assert.deepEqual(second.issues, first.issues, 'the notes came from the same cached answer');
  });

  it('takes the notes of a status the team added to the stage it moves to', async () => {
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'waiting', stage: NEW } });
    await plant(team, site, NEW as string, 'waiting', 'seed-1');
    await plant(team, site, NEW as string, null, 'seed-2');

    await callOn(team, 'POST', path(workspace, site), { token, body: { source: 'own', key: 'waiting', stage: DONE } });

    assert.deepEqual(
      await rowsOf(team.database, `SELECT status_key, stage FROM notes WHERE client_id = '${site}' ORDER BY id`),
      [
        { status_key: 'waiting', stage: DONE },
        // A note in a built-in status does not move.
        { status_key: null, stage: NEW },
      ],
    );
  });

  it('answers a site of another workspace as one that does not exist, and refuses a member who does not set sites', async () => {
    const { team, token, workspace, site } = await acme();
    const other = await workspaceIn(team, token, 'Globex');
    for (const [method, more, body] of [
      ['GET', '', undefined],
      ['POST', '', { source: 'own', key: 'x', stage: NEW }],
      ['POST', '/order', { order: [] }],
      ['DELETE', '/own/waiting', undefined],
    ] as const) {
      const answer = await callOn(team, method, path(other, site, more), { token, body });
      assert.equal(answer.status, 404, `${method} ${more}`);
    }

    // Found in review: Bob is a member of the workspace of this site, in this world, so a 403 is the
    // refusal of his role. The control: the owner of the same workspace reads the same path.
    const bob = await signInTo(team, 'bob@acme.dev');
    await memberOf(team, workspace, bob.id, 'member');
    for (const [method, more, body] of [
      ['GET', '', undefined],
      ['POST', '', { source: 'own', key: 'x', stage: NEW }],
      ['POST', '/order', { order: [] }],
      ['DELETE', '/own/x', undefined],
    ] as const) {
      const refused = await callOn(team, method, path(workspace, site, more), { token: bob.token, body });
      assert.deepEqual(
        [refused.status, await refused.json()],
        [403, { error: 'forbidden', role: 'member' }],
        `${method} ${more}`,
      );
    }
    assert.equal((await callOn(team, 'GET', path(workspace, site), { token })).status, 200);
    assert.deepEqual(await rowsOf(team.database, 'SELECT * FROM statuses'), [], 'a refused member wrote nothing');
  });
});

describe('the statuses in the read of a page (FRU-366)', () => {
  it('lists the built-in statuses on a site with no row, and draws each note by its stage', async () => {
    const { team, site } = await acme();
    await plant(team, site, DONE as string, null, 'seed-1');

    const { statuses, issues } = await read(team, site);

    assert.deepEqual(
      statuses,
      NOTE_STAGES.map((stage) => ({ key: `own:${stage}`, name: '', stage })),
    );
    assert.equal(issues[0]?.status, `own:${DONE}`);
    assert.deepEqual(statusOf(issues[0] as never, offeredStatuses(statuses)), {
      key: `own:${DONE}`,
      name: '',
      stage: DONE,
    });
  });

  it('gives the rows of the site, a text colour computed for a colour with none, and the status of each note', async () => {
    const { team, token, workspace, site } = await acme();
    await callOn(team, 'POST', path(workspace, site), {
      token,
      body: { source: 'own', key: 'waiting', name: 'Waiting', stage: NEW, color: '#5560c4', position: 0 },
    });
    await callOn(team, 'POST', path(workspace, site), {
      token,
      body: {
        source: 'own',
        key: DONE,
        name: 'Shipped',
        stage: DONE,
        color: '#f3bb3d',
        textColor: '#000000',
        position: 1,
      },
    });
    await plant(team, site, NEW as string, 'waiting', 'seed-1');
    await plant(team, site, DONE as string, null, 'seed-2');

    const { statuses, issues } = await read(team, site);

    assert.deepEqual(statuses.slice(0, 2), [
      // #5560c4 takes white, as the widget writes on « done » today (5.45:1).
      { key: 'own:waiting', name: 'Waiting', stage: NEW, color: '#5560c4', textColor: '#ffffff' },
      { key: `own:${DONE}`, name: 'Shipped', stage: DONE, color: '#f3bb3d', textColor: '#000000' },
    ]);
    // The four built-in statuses no row changed follow.
    assert.deepEqual(
      statuses.slice(2).map((status) => status.key),
      NOTE_STAGES.filter((stage) => stage !== DONE).map((stage) => `own:${stage}`),
    );
    assert.deepEqual(
      issues.map((issue) => issue.status),
      ['own:waiting', `own:${DONE}`],
    );
    // What the widget will draw: each note in its status.
    const offered = offeredStatuses(statuses);
    assert.deepEqual(
      issues.map((issue) => statusOf(issue as never, offered)?.name),
      ['Waiting', 'Shipped'],
    );
    assert.equal(DEFAULT_NOTE_STAGE, NEW, 'a new note is in the first stage, so its built-in status is the first one');
  });
});

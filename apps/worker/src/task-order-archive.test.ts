import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';
import { readTaskChange } from './task-fields.ts';

/**
 * The place of a task in its column, its archive and its deletion (FRU-665), from the console.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';

type Answer = { status: number; body: Record<string, any> };

const answerOf = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: response.status === 204 ? {} : ((await response.json()) as Record<string, any>),
});

async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/** Alice owns Acme. Bob is a member and left a note the worker keeps. Carol is a member too. */
async function acme(tasks?: string) {
  const world = await open(tasks === undefined ? {} : { env: { FRUITBACK_TASKS: tasks } });
  const store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' })).id;
  // An address keeps the note in the worker too, on a worker that keeps tasks or not.
  const rest = (await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' }))
    .id;
  await world.accounts.setDestination(workspace, site, { connector: rest });
  const bob = await signInTo(world, 'bob@acme.dev');
  const carol = await signInTo(world, 'carol@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  await memberOf(world, workspace, carol.id, 'member');
  const extension = await sessionOf(world, bob.id, workspace);
  const planted = await callOn(
    world,
    'POST',
    '/feedback',
    {
      origin: ORIGIN,
      body: noteFixture({
        id: 'sd_1',
        page: { url: `${ORIGIN}/pricing`, path: '/pricing' },
        client: { id: site, name: 'Acme' },
      }),
      headers: { Authorization: `Bearer ${extension}` },
    },
    { store },
  );
  assert.equal(planted.status, 201);
  const base = `/console/workspaces/${workspace}`;
  const note = noteIdOf(site, 'sd_1');
  const call = (method: string, path: string, token: string, body?: unknown) =>
    callOn(world, method, `${base}${path}`, { token, ...(body === undefined ? {} : { body }) }).then(answerOf);
  const taskOf = async (token = alice.token) =>
    (await call('GET', '/notes', token)).body.notes.find((one: { id: string }) => one.id === note)?.task;

  return { world, alice, bob, carol, workspace, note, call, taskOf };
}

describe('the place, the archive and the deletion of a task (FRU-665)', () => {
  it('keeps the place of a task in its column, and refuses a place that is not a number', async () => {
    const { alice, note, call, taskOf } = await acme();

    assert.equal((await call('POST', `/notes/${note}/task`, alice.token, { position: -1.5 })).status, 204);
    assert.equal((await taskOf()).position, -1.5);
    assert.deepEqual(await call('POST', `/notes/${note}/task`, alice.token, { position: '1' }), {
      status: 400,
      body: { error: 'invalid-task', field: 'position' },
    });
    assert.deepEqual(readTaskChange({ position: Number.POSITIVE_INFINITY }), { invalid: 'position' });
  });

  it('takes an archived task out of the list, shows it among the archived ones, and brings it back', async () => {
    const { alice, note, call } = await acme();
    const ids = async (query = '') =>
      (await call('GET', `/notes${query}`, alice.token)).body.notes.map((one: { id: string }) => one.id);

    assert.equal((await call('POST', `/notes/${note}/task`, alice.token, { archived: true })).status, 204);
    assert.deepEqual(await ids(), []);
    // The counts read the same filter: the archived task is in none of them.
    const counted = (await call('GET', '/notes', alice.token)).body.counts;
    assert.equal(counted.all, 0, JSON.stringify(counted));
    assert.deepEqual(await ids('?archived=1'), [note]);
    assert.equal((await call('GET', '/notes?archived=1', alice.token)).body.counts.all, 1);
    assert.equal((await call('GET', '/notes?archived=yes', alice.token)).status, 400);

    assert.equal((await call('POST', `/notes/${note}/task`, alice.token, { archived: false })).status, 204);
    assert.deepEqual(await ids(), [note]);
    assert.deepEqual(await ids('?archived=1'), []);
  });

  it('deletes a task for good, its replies included, with the rights of the status', async () => {
    const { world, alice, carol, note, call } = await acme();
    const replies = async () =>
      Number((await rowsOf(world.database, 'SELECT count(*) AS n FROM note_comments'))[0]?.n ?? 0);
    await rowsOf(
      world.database,
      `INSERT INTO note_comments (note_id, body, created_at) SELECT id, 'a reply', 1 FROM notes`,
    );
    assert.equal(await replies(), 1);

    assert.deepEqual(await call('DELETE', `/notes/${note}/task`, carol.token), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.equal((await call('DELETE', `/notes/${note}/task`, alice.token)).status, 204);
    assert.deepEqual((await call('GET', '/notes', alice.token)).body.notes, []);
    assert.equal(await replies(), 0);
    assert.equal(Number((await rowsOf(world.database, 'SELECT count(*) AS n FROM notes'))[0]?.n), 0);
    assert.equal((await call('DELETE', `/notes/${note}/task`, alice.token)).status, 404);
  });

  it('deletes and archives nothing on a worker that keeps no task', async () => {
    const { alice, note, call } = await acme('off');

    for (const [method, body] of [
      ['DELETE', undefined],
      ['POST', { archived: true }],
    ] as const) {
      assert.deepEqual(await call(method, `/notes/${note}/task`, alice.token, body), {
        status: 403,
        body: { error: 'tasks-off' },
      });
    }
  });
});

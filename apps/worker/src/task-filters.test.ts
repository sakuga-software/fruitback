import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * The filters of the list on the fields of a task (FRU-655): assignee, priority, label and day.
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

  return { world, store, alice, bob, carol, workspace, site, extension, note, call, taskOf };
}

/** A second note of Bob on the site, kept by the worker: the id of its row in the list. */
async function plantAnother(
  world: World,
  store: ReturnType<typeof createPostgresNoteStore>,
  site: string,
  extension: string,
): Promise<string> {
  const planted = await callOn(
    world,
    'POST',
    '/feedback',
    {
      origin: ORIGIN,
      body: noteFixture({
        id: 'sd_2',
        page: { url: `${ORIGIN}/about`, path: '/about' },
        client: { id: site, name: 'Acme' },
      }),
      headers: { Authorization: `Bearer ${extension}` },
    },
    { store },
  );
  assert.equal(planted.status, 201);

  return noteIdOf(site, 'sd_2');
}

describe('the filters on the fields of a task (FRU-655)', () => {
  it('finds the tasks by assignee, priority, label and day, and forgets a label that is removed', async () => {
    const { world, store, alice, bob, site, extension, note, call } = await acme();
    const second = await plantAnother(world, store, site, extension);
    const bug = (await call('POST', '/labels', alice.token, { name: 'Bug', color: '#dc2626' })).body.label;
    await call('POST', `/notes/${note}/task`, alice.token, {
      assignee: bob.id,
      priority: 'high',
      labels: [bug.id],
      dueOn: '2026-11-20',
    });
    await call('POST', `/notes/${second}/task`, alice.token, { assignee: alice.id, dueOn: '2026-11-25' });
    const ids = async (query: string) =>
      ((await call('GET', `/notes?${query}`, alice.token)).body.notes as { id: string }[]).map((one) => one.id).sort();
    const both = [note, second].sort();

    assert.deepEqual(await ids(''), both);
    assert.deepEqual(await ids(`assignee=${bob.id}`), [note]);
    assert.deepEqual(await ids('assignee=me'), [second]);
    assert.deepEqual(await ids('assignee=none'), []);
    assert.deepEqual(await ids('priority=high'), [note]);
    assert.deepEqual(await ids('priority=none'), [second]);
    assert.deepEqual(await ids(`label=${bug.id}`), [note]);
    assert.deepEqual(await ids('due=overdue&today=2026-11-23'), [note]);
    assert.deepEqual(await ids('due=week&today=2026-11-23'), [second]);
    assert.deepEqual(await ids('due=none'), []);
    // Filters combine: each must hold.
    assert.deepEqual(await ids(`priority=high&assignee=${alice.id}`), []);

    assert.equal((await call('DELETE', `/labels/${bug.id}`, alice.token)).status, 204);
    assert.deepEqual(await ids(`label=${bug.id}`), []);
  });

  it('refuses a filter that is not one, and a day filter with no day of the person', async () => {
    const { alice, call } = await acme();

    for (const [query, error] of [
      ['priority=p1', 'invalid-priority'],
      ['due=soon', 'invalid-due'],
      ['due=overdue', 'invalid-today'],
      ['due=week&today=2026-02-30', 'invalid-today'],
      ['assignee=a%20b', 'invalid-assignee'],
    ] as const) {
      assert.deepEqual((await call('GET', `/notes?${query}`, alice.token)).body, { error }, query);
    }
  });
});

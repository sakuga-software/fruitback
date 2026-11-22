import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import { isDay, readLabel, readTaskChange } from './task-fields.ts';

/**
 * The fields of a task the worker keeps (FRU-652): the assignee, the priority, the day and the
 * labels of the workspace, written from the console and read in its list of the notes.
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

describe('the fields of a task (FRU-652)', () => {
  it('reads a task with no field set, then the fields its author set', async () => {
    const { alice, bob, note, call, taskOf } = await acme();
    assert.deepEqual(await taskOf(), { labels: [] });

    const label = (await call('POST', '/labels', alice.token, { name: ' Bug ', color: '#DC2626' })).body.label;
    assert.deepEqual({ name: label.name, color: label.color }, { name: 'Bug', color: '#dc2626' });
    const set = await call('POST', `/notes/${note}/task`, bob.token, {
      assignee: alice.id,
      priority: 'high',
      dueOn: '2026-12-01',
      labels: [label.id],
    });
    assert.equal(set.status, 204, JSON.stringify(set.body));

    assert.deepEqual(await taskOf(), {
      assignee: { id: alice.id, name: (await taskOf()).assignee.name },
      priority: 'high',
      dueOn: '2026-12-01',
      labels: [{ id: label.id, name: 'Bug', color: '#dc2626' }],
    });
    // `null` clears a field, and a field left out does not change.
    assert.equal((await call('POST', `/notes/${note}/task`, bob.token, { priority: null, labels: [] })).status, 204);
    const after = await taskOf();
    assert.equal(after.priority, undefined);
    assert.deepEqual(after.labels, []);
    assert.equal(after.dueOn, '2026-12-01');
  });

  it('lets a role that manages the sites change the task of somebody else, and refuses another member', async () => {
    const { alice, carol, note, call } = await acme();

    assert.equal((await call('POST', `/notes/${note}/task`, alice.token, { priority: 'low' })).status, 204);
    assert.deepEqual(await call('POST', `/notes/${note}/task`, carol.token, { priority: 'urgent' }), {
      status: 403,
      body: { error: 'not-allowed' },
    });
  });

  it('answers 404 to a guest of another site, and writes nothing', async () => {
    const { world, workspace, note, call, taskOf } = await acme();
    const other = (await world.accounts.addSite(workspace, { origin: 'https://other.acme.dev', visibility: 'members' }))
      .id;
    const gina = await signInTo(world, 'gina@acme.dev');
    await memberOf(world, workspace, gina.id, 'guest');
    await shareWith(world, workspace, gina.id, [other]);

    assert.deepEqual(await call('POST', `/notes/${note}/task`, gina.token, { priority: 'urgent' }), {
      status: 404,
      body: { error: 'not-found' },
    });
    assert.equal((await taskOf()).priority, undefined);
  });

  it('refuses an assignee who is not a member, and a label of another workspace', async () => {
    const { world, alice, note, call } = await acme();
    const stranger = await signInTo(world, 'eve@else.dev');
    const elsewhere = await workspaceIn(world, stranger.token, 'Else');
    const foreign = (await world.accounts.addLabel(elsewhere, { name: 'Bug', color: '#000000' })) as {
      label: { id: string };
    };

    assert.deepEqual(await call('POST', `/notes/${note}/task`, alice.token, { assignee: stranger.id }), {
      status: 409,
      body: { error: 'not-member' },
    });
    assert.deepEqual(await call('POST', `/notes/${note}/task`, alice.token, { labels: [foreign.label.id] }), {
      status: 409,
      body: { error: 'unknown-label' },
    });
  });

  it('refuses a field that is not one, before it reads the note', async () => {
    const { alice, note, call } = await acme();

    for (const [body, field] of [
      [{ priority: 'p1' }, 'priority'],
      [{ dueOn: '2026-02-30' }, 'dueOn'],
      [{ labels: 'bug' }, 'labels'],
      [{ assignee: '' }, 'assignee'],
      [{}, 'body'],
    ] as const) {
      assert.deepEqual(await call('POST', `/notes/${note}/task`, alice.token, body), {
        status: 400,
        body: { error: 'invalid-task', field },
      });
    }
  });

  it('keeps label names unique in a workspace, and lets only a role that manages the sites write them', async () => {
    const { alice, bob, note, call, taskOf } = await acme();
    const bug = (await call('POST', '/labels', alice.token, { name: 'Bug', color: '#dc2626' })).body.label;

    assert.equal((await call('POST', '/labels', alice.token, { name: 'Bug', color: '#000000' })).status, 409);
    assert.equal((await call('POST', '/labels', bob.token, { name: 'Copy', color: '#000000' })).status, 403);
    assert.deepEqual((await call('GET', '/labels', bob.token)).body.labels, [bug]);
    const renamed = await call('POST', `/labels/${bug.id}`, alice.token, { name: 'Defect' });
    assert.deepEqual(renamed.body.label, { ...bug, name: 'Defect' });

    // A label removed leaves every task.
    await call('POST', `/notes/${note}/task`, alice.token, { labels: [bug.id] });
    assert.equal((await call('DELETE', `/labels/${bug.id}`, alice.token)).status, 204);
    assert.deepEqual((await taskOf()).labels, []);
    assert.equal((await call('DELETE', `/labels/${bug.id}`, alice.token)).status, 404);
  });

  it('changes nothing on a worker that keeps no task, and still reads the labels', async () => {
    const { alice, note, call } = await acme('off');

    assert.deepEqual(await call('POST', `/notes/${note}/task`, alice.token, { priority: 'high' }), {
      status: 403,
      body: { error: 'tasks-off' },
    });
    assert.deepEqual(await call('POST', '/labels', alice.token, { name: 'Bug', color: '#dc2626' }), {
      status: 403,
      body: { error: 'tasks-off' },
    });
    assert.equal((await call('GET', '/labels', alice.token)).status, 200);
  });
});

describe('reading a change of a task (FRU-652)', () => {
  it('takes a day of the calendar and nothing else', () => {
    assert.equal(isDay('2024-02-29'), true);
    assert.equal(isDay('2026-02-29'), false);
    assert.equal(isDay('2026-1-01'), false);
  });

  it('keeps each label once, and refuses a label name too long or a colour that is not #rrggbb', () => {
    assert.deepEqual(readTaskChange({ labels: ['a', 'a', 'b'] }), { labels: ['a', 'b'] });
    assert.deepEqual(readLabel({ name: 'x'.repeat(41), color: '#000000' }), { invalid: 'name' });
    assert.deepEqual(readLabel({ name: 'Bug', color: 'red' }), { invalid: 'color' });
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * One note, whole, for the page of a task in the console (FRU-653): `GET …/notes/<note>`.
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
    // The store of the note: a read of its page goes through it, as the routes of the page do.
    callOn(world, method, `${base}${path}`, { token, ...(body === undefined ? {} : { body }) }, { store }).then(
      answerOf,
    );
  const taskOf = async (token = alice.token) =>
    (await call('GET', '/notes', token)).body.notes.find((one: { id: string }) => one.id === note)?.task;

  return { world, store, alice, bob, carol, workspace, site, extension, note, call, taskOf };
}

describe('the page of a task (FRU-653)', () => {
  it('reads the whole note, its text and its element, for a member of the workspace', async () => {
    const { alice, carol, note, call } = await acme();

    for (const token of [alice.token, carol.token]) {
      const read = await call('GET', `/notes/${note}`, token);
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.note.note.id, 'sd_1');
      assert.equal(typeof read.body.note.note.text, 'string');
      assert.equal(read.body.note.note.page.url, `${ORIGIN}/pricing`);
    }
  });

  it('answers 404 to a guest of another site, to a note that is not one, and to any method but GET', async () => {
    const { world, workspace, site, alice, note, call } = await acme();
    const other = (await world.accounts.addSite(workspace, { origin: 'https://other.acme.dev', visibility: 'members' }))
      .id;
    const gina = await signInTo(world, 'gina@acme.dev');
    await memberOf(world, workspace, gina.id, 'guest');
    await shareWith(world, workspace, gina.id, [other]);

    assert.equal((await call('GET', `/notes/${note}`, gina.token)).status, 404);
    assert.equal((await call('GET', `/notes/${noteIdOf(site, 'sd_9')}`, alice.token)).status, 404);
    assert.equal((await call('POST', `/notes/${note}`, alice.token, {})).status, 405);
  });
});

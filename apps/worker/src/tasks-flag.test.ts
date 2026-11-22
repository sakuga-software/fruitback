import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import { createRoutedStore } from './connectors.ts';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import { NoDestination, type NoteStore, takesEdits, takesReplies, takesStatuses, takesWithdrawals } from './store.ts';

/**
 * `FRUITBACK_TASKS` (FRU-651): whether a worker keeps tasks. `on` by default. With `off`, a site needs
 * a destination, the notes the worker keeps are read-only, and `/health` and the console say so.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';

type Answer = { status: number; body: Record<string, any> };

const answerOf = async (response: Response): Promise<Answer> => ({
  status: response.status,
  body: (await response.json()) as Record<string, any>,
});

async function sessionOf(world: World, account: string, workspace: string): Promise<string> {
  const { code } = await createPairing(world.sessions, { subject: account, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);

  return redeemed.session.accessToken;
}

/** Alice owns Acme, with a site that has no destination and one that sends to an address. */
async function acme(tasks?: string) {
  const world = await open(tasks === undefined ? {} : { env: { FRUITBACK_TASKS: tasks } });
  const store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const plain = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' })).id;
  const hooked = (await world.accounts.addSite(workspace, { origin: 'https://hooks.acme.dev', visibility: 'members' }))
    .id;
  const rest = (await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' }))
    .id;
  await world.accounts.setDestination(workspace, hooked, { connector: rest });
  const extension = await sessionOf(world, alice.id, workspace);

  const send = (site: string, origin: string, id: string) =>
    callOn(
      world,
      'POST',
      '/feedback',
      {
        origin,
        body: noteFixture({
          id,
          page: { url: `${origin}/pricing`, path: '/pricing' },
          client: { id: site, name: 'Acme' },
        }),
        headers: { Authorization: `Bearer ${extension}` },
      },
      { store },
    ).then(answerOf);

  return { world, store, alice, workspace, plain, hooked, send };
}

describe('FRUITBACK_TASKS (FRU-651)', () => {
  it('is on by default: a site with no destination keeps its notes, and /health says nothing of it', async () => {
    const { world, plain, send } = await acme();

    assert.equal((await send(plain, ORIGIN, 'sd_1')).status, 201);
    const health = await answerOf(await callOn(world, 'GET', '/health'));
    assert.equal(health.status, 200);
    assert.equal('tasks' in health.body, false);
  });

  it('off: refuses the note of a site with no destination, and takes the note of a site with one', async () => {
    const { plain, hooked, send } = await acme('off');

    const refused = await send(plain, ORIGIN, 'sd_1');
    assert.equal(refused.status, 502, JSON.stringify(refused.body));
    assert.equal(refused.body.error, 'no-destination');
    // The control: an address is a destination, and the worker still keeps its note for it.
    assert.equal((await send(hooked, 'https://hooks.acme.dev', 'sd_2')).status, 201);
  });

  it('off: /health and /console/me say so', async () => {
    const { world, alice } = await acme('off');

    assert.deepEqual((await answerOf(await callOn(world, 'GET', '/health'))).body.tasks, 'off');
    const me = await answerOf(await callOn(world, 'GET', '/console/me', { token: alice.token }));
    assert.equal(me.body.tasks, false);
  });

  it('on: /console/me says the console may change the notes the worker keeps', async () => {
    const { world, alice } = await acme('on');

    const me = await answerOf(await callOn(world, 'GET', '/console/me', { token: alice.token }));
    assert.equal(me.body.tasks, true);
  });

  it('off: the console changes no status of a note the worker keeps; on, it does', async () => {
    for (const tasks of ['on', 'off']) {
      const { world, alice, workspace, hooked, send } = await acme(tasks);
      assert.equal((await send(hooked, 'https://hooks.acme.dev', 'sd_1')).status, 201);

      const answer = await answerOf(
        await callOn(world, 'POST', `/console/workspaces/${workspace}/notes/${noteIdOf(hooked, 'sd_1')}/status`, {
          token: alice.token,
          body: { status: 'own:done' },
        }),
      );
      if (tasks === 'on') assert.equal(answer.status, 200, JSON.stringify(answer.body));
      else assert.deepEqual(answer, { status: 403, body: { error: 'tasks-off' } });
      // The list offers the change only where the route takes it.
      const listed = await answerOf(
        await callOn(world, 'GET', `/console/workspaces/${workspace}/notes`, { token: alice.token }),
      );
      assert.equal(listed.body.notes[0]?.canSetStatus, tasks === 'on', JSON.stringify(listed.body));
    }
  });

  it('refuses a value that is not on or off at boot, by its name', async () => {
    const world = await open({ env: { FRUITBACK_TASKS: 'of' } });
    const health = await answerOf(await callOn(world, 'GET', '/health'));

    assert.equal(health.status, 503);
    assert.ok((health.body.missing as string[]).includes('FRUITBACK_TASKS (on or off)'), JSON.stringify(health.body));
  });
});

describe('the store of a site with no destination, on a worker that keeps no task (FRU-651)', () => {
  const policy = { showComments: true, identitySecret: undefined, read: 'public' } as ClientPolicy;
  const plain = {} as ClientConfig;
  const hooked = { connector: 'conn_rest', workspace: 'ws' } as ClientConfig;
  const own = {
    name: 'own',
    scope: () => 'own',
    create: async () => ({ id: 'n', identifier: 'FB-1' }),
    findForPage: async () => [{ id: 'kept' }],
    reply: async () => ({}),
    setStatus: async () => ({}),
    edit: async () => ({}),
    withdraw: async () => ({}),
  } as unknown as NoteStore;
  const received: NoteStore[] = [];
  const routed = createRoutedStore(
    own,
    async (_connector, _workspace, base) => {
      received.push(base);

      return base;
    },
    { tasks: 'off' },
  );

  it('reads the notes kept before, and takes no new note, status, edit, reply or withdrawal', async () => {
    assert.deepEqual(await routed.findForPage({ url: PAGE, clientId: 's' }, plain, policy), [{ id: 'kept' }]);
    await assert.rejects(routed.create(noteFixture(), plain, policy), NoDestination);
    assert.equal(await takesStatuses(routed, plain), false);
    assert.equal(await takesReplies(routed, plain), false);
    assert.equal(await takesEdits(routed, plain, policy), false);
    assert.equal(await takesWithdrawals(routed, plain), false);
  });

  it('hands a connector that only receives the own store whole, which keeps its notes', async () => {
    assert.deepEqual(await routed.create(noteFixture(), hooked, policy), { id: 'n', identifier: 'FB-1' });
    assert.equal(received.at(-1), own);
    assert.equal(await takesStatuses(routed, hooked), true);
  });
});

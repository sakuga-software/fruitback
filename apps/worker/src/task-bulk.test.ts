import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';
import { MAX_LABELS, MAX_TASKS, readTasksChange } from './task-fields.ts';

/**
 * Several tasks changed or deleted at once, from the console (FRU-656): one call, one transaction,
 * and the rights of a change of one task for each of them.
 */

const open = worlds();
const ACME = 'https://acme.dev';
const SHOP = 'https://shop.acme.dev';

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

/**
 * Alice owns Acme, Bob and Carol are members. Two sites keep their notes in the worker. Bob left
 * `b1` and `b2` on acme.dev and `b3` on shop.acme.dev; Alice left `a1` on acme.dev.
 */
async function acme(tasks?: string) {
  const world = await open(tasks === undefined ? {} : { env: { FRUITBACK_TASKS: tasks } });
  const store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const rest = (await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' }))
    .id;
  const sites: Record<string, string> = {};
  for (const origin of [ACME, SHOP]) {
    sites[origin] = (await world.accounts.addSite(workspace, { origin, visibility: 'members' })).id;
    await world.accounts.setDestination(workspace, sites[origin] as string, { connector: rest });
  }
  const bob = await signInTo(world, 'bob@acme.dev');
  const carol = await signInTo(world, 'carol@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  await memberOf(world, workspace, carol.id, 'member');
  const leave = async (account: string, origin: string, id: string) => {
    const site = sites[origin] as string;
    const planted = await callOn(
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
        headers: { Authorization: `Bearer ${await sessionOf(world, account, workspace)}` },
      },
      { store },
    );
    assert.equal(planted.status, 201, await planted.clone().text());

    return noteIdOf(site, id);
  };
  const b1 = await leave(bob.id, ACME, 'b1');
  const b2 = await leave(bob.id, ACME, 'b2');
  const b3 = await leave(bob.id, SHOP, 'b3');
  const a1 = await leave(alice.id, ACME, 'a1');
  const base = `/console/workspaces/${workspace}`;
  const call = (method: string, path: string, token: string, body?: unknown) =>
    callOn(world, method, `${base}${path}`, { token, ...(body === undefined ? {} : { body }) }).then(answerOf);
  const listed = async (query = '') =>
    new Map<string, { status?: string; task?: Record<string, any> }>(
      (await call('GET', `/notes${query}`, alice.token)).body.notes.map((one: { id: string }) => [one.id, one]),
    );
  const label = async (name: string) =>
    (await call('POST', '/labels', alice.token, { name, color: '#dc2626' })).body.label.id as string;

  return { world, workspace, sites, alice, bob, carol, b1, b2, b3, a1, call, listed, label };
}

describe('several tasks at once (FRU-656)', () => {
  it('changes the fields of several tasks in one call, on two sites', async () => {
    const { alice, carol, b1, b2, b3, a1, call, listed } = await acme();

    const changed = await call('POST', '/tasks', alice.token, {
      notes: [b1, b3, a1],
      change: { assignee: carol.id, priority: 'high', dueOn: '2026-12-01', status: 'own:progress' },
    });
    assert.deepEqual(changed, { status: 200, body: { changed: 3 } });
    const notes = await listed();
    for (const id of [b1, b3, a1]) {
      const note = notes.get(id);
      assert.equal(note?.status, 'own:progress', id);
      assert.equal(note?.task?.assignee?.id, carol.id, id);
      assert.equal(note?.task?.priority, 'high', id);
      assert.equal(note?.task?.dueOn, '2026-12-01', id);
    }
    // The task out of the call is as it was.
    assert.equal(notes.get(b2)?.task?.priority, undefined);
    assert.notEqual(notes.get(b2)?.status, 'own:progress');
    // The index reads the fields too: the filters find the three.
    assert.equal((await listed(`?assignee=${carol.id}`)).size, 3);
  });

  it('puts a label on and takes another off every task, and keeps their other labels', async () => {
    const { alice, b1, b2, call, listed, label } = await acme();
    const [bug, design, copy] = [await label('Bug'), await label('Design'), await label('Copy')];
    assert.equal((await call('POST', `/notes/${b1}/task`, alice.token, { labels: [bug, copy] })).status, 204);
    assert.equal((await call('POST', `/notes/${b2}/task`, alice.token, { labels: [bug] })).status, 204);

    const changed = await call('POST', '/tasks', alice.token, {
      notes: [b1, b2],
      change: { addLabels: [design], removeLabels: [bug] },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const names = (id: string, notes: Awaited<ReturnType<typeof listed>>) =>
      ((notes.get(id)?.task?.labels ?? []) as { name: string }[]).map((one) => one.name).sort();
    const notes = await listed();
    assert.deepEqual(names(b1, notes), ['Copy', 'Design']);
    assert.deepEqual(names(b2, notes), ['Design']);
    assert.equal((await listed(`?label=${design}`)).size, 2);
    assert.equal((await listed(`?label=${bug}`)).size, 0);
  });

  it('changes none of the tasks when one of them is refused, and names it', async () => {
    const { bob, b1, b2, a1, call, listed } = await acme();

    // Bob may change his notes, not Alice's: hers comes after his in the call.
    assert.deepEqual(
      await call('POST', '/tasks', bob.token, { notes: [b1, b2, a1], change: { priority: 'urgent', archived: true } }),
      { status: 403, body: { error: 'not-allowed', note: a1 } },
    );
    const notes = await listed();
    for (const id of [b1, b2, a1]) assert.equal(notes.get(id)?.task?.priority, undefined, id);
    // The control: his own two change.
    assert.equal(
      (await call('POST', '/tasks', bob.token, { notes: [b1, b2], change: { priority: 'urgent' } })).status,
      200,
    );
    assert.equal((await listed()).get(b2)?.task?.priority, 'urgent');
  });

  it('refuses a status that a site of the tasks does not have, and moves none', async () => {
    const { world, workspace, alice, sites, b1, b3, call, listed } = await acme();
    const saved = await world.accounts.putSiteStatus(workspace, sites[ACME] as string, {
      source: 'own',
      key: 'review',
      stage: 'progress',
      name: 'Review',
      color: '#2563eb',
      textColor: null,
      position: 0,
      origin: 'team',
      hidden: false,
    });
    assert.ok(saved.saved);

    assert.deepEqual(await call('POST', '/tasks', alice.token, { notes: [b1, b3], change: { status: 'own:review' } }), {
      status: 409,
      body: { error: 'status-changed', note: b3 },
    });
    assert.notEqual((await listed()).get(b1)?.status, 'own:review');
    assert.deepEqual(await call('POST', '/tasks', alice.token, { notes: [b1], change: { status: 'review' } }), {
      status: 400,
      body: { error: 'not-own' },
    });
    assert.equal(
      (await call('POST', '/tasks', alice.token, { notes: [b1], change: { status: 'own:review' } })).status,
      200,
    );
    assert.equal((await listed()).get(b1)?.status, 'own:review');
  });

  it('refuses a label that would put a task past its labels, an assignee who is no member, and a label of no one', async () => {
    const { world, alice, b1, b2, call, listed, label } = await acme();
    const many = [];
    for (let at = 0; at < MAX_LABELS; at += 1) many.push(await label(`L${at}`));
    const extra = await label('One more');
    assert.equal((await call('POST', `/notes/${b2}/task`, alice.token, { labels: many })).status, 204);

    assert.deepEqual(await call('POST', '/tasks', alice.token, { notes: [b1, b2], change: { addLabels: [extra] } }), {
      status: 409,
      body: { error: 'too-many-labels', note: b2 },
    });
    assert.equal((await listed()).get(b1)?.task?.labels.length, 0);
    const stranger = await signInTo(world, 'eve@else.dev');
    assert.deepEqual(await call('POST', '/tasks', alice.token, { notes: [b1], change: { assignee: stranger.id } }), {
      status: 409,
      body: { error: 'not-member' },
    });
    assert.deepEqual(await call('POST', '/tasks', alice.token, { notes: [b1], change: { addLabels: ['lbl_none'] } }), {
      status: 409,
      body: { error: 'unknown-label' },
    });
  });

  it('deletes several tasks in one call, and none when one is refused', async () => {
    const { world, alice, bob, b1, b2, a1, call, listed } = await acme();
    const kept = async () => Number((await rowsOf(world.database, 'SELECT count(*) AS n FROM notes'))[0]?.n);
    assert.equal(await kept(), 4);

    assert.deepEqual(await call('POST', '/tasks/delete', bob.token, { notes: [b1, a1] }), {
      status: 403,
      body: { error: 'not-allowed', note: a1 },
    });
    assert.equal(await kept(), 4);
    assert.deepEqual(await call('POST', '/tasks/delete', alice.token, { notes: [b1, b2, a1] }), {
      status: 200,
      body: { deleted: 3 },
    });
    assert.equal(await kept(), 1);
    assert.equal((await listed()).size, 1);
    assert.deepEqual(await call('POST', '/tasks/delete', alice.token, { notes: [b1] }), {
      status: 404,
      body: { error: 'not-found', note: b1 },
    });
  });

  it('answers 404 to a guest for a task of a site not shared with them, and writes nothing', async () => {
    const { world, workspace, sites, b1, b3, call, listed } = await acme();
    const gina = await signInTo(world, 'gina@acme.dev');
    await memberOf(world, workspace, gina.id, 'guest');
    await shareWith(world, workspace, gina.id, [sites[SHOP] as string]);

    assert.deepEqual(await call('POST', '/tasks', gina.token, { notes: [b3, b1], change: { priority: 'low' } }), {
      status: 404,
      body: { error: 'not-found', note: b1 },
    });
    assert.equal((await listed()).get(b3)?.task?.priority, undefined);
  });

  it('changes and deletes nothing on a worker that keeps no task', async () => {
    const { alice, b1, call } = await acme('off');

    for (const [path, body] of [
      ['/tasks', { notes: [b1], change: { priority: 'low' } }],
      ['/tasks/delete', { notes: [b1] }],
    ] as const) {
      assert.deepEqual(await call('POST', path, alice.token, body), { status: 403, body: { error: 'tasks-off' } });
    }
  });

  it('changes and deletes nothing in a suspended workspace', async () => {
    const { world, workspace, alice, b1, call, listed } = await acme();
    await rowsOf(world.database, `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${workspace}', 1)`);

    for (const [path, body] of [
      ['/tasks', { notes: [b1], change: { priority: 'low' } }],
      ['/tasks/delete', { notes: [b1] }],
    ] as const) {
      assert.equal((await call('POST', path, alice.token, body)).body.error, 'workspace-suspended', path);
    }
    assert.equal((await listed()).get(b1)?.task?.priority, undefined);
  });

  it('reads a body of several tasks, and refuses one that is not', () => {
    const notes = ['n1'];
    assert.deepEqual(readTasksChange({ notes: ['n1', 'n1'], change: { priority: null, addLabels: ['l1', 'l1'] } }), {
      notes,
      change: { priority: null, addLabels: ['l1'] },
    });
    for (const [body, field] of [
      [{ change: { priority: 'low' } }, 'notes'],
      [{ notes: [], change: { priority: 'low' } }, 'notes'],
      [{ notes: Array.from({ length: MAX_TASKS + 1 }, (_, at) => `n${at}`), change: { priority: 'low' } }, 'notes'],
      [{ notes, change: {} }, 'change'],
      [{ notes, change: [] }, 'change'],
      [{ notes, change: { labels: [] } }, 'labels'],
      [{ notes, change: { position: 1 } }, 'position'],
      [{ notes, change: { priority: 'soon' } }, 'priority'],
      [{ notes, change: { status: 3 } }, 'status'],
      [{ notes, change: { addLabels: 'l1' } }, 'addLabels'],
      [{ notes, change: { addLabels: ['l1'], removeLabels: ['l1'] } }, 'removeLabels'],
    ] as const) {
      assert.deepEqual(readTasksChange(body as Record<string, unknown>), { invalid: field }, JSON.stringify(body));
    }
  });
});

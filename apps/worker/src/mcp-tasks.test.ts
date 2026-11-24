import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { resetMemoryLinear } from './linear-memory.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * The tools of a task in `/mcp` (FRU-659): the fields in `list_notes` and `get_note`, the filters of
 * the console, `task_choices`, and `update_task` for a key that writes, on a worker that keeps tasks.
 */

const open = worlds();

afterEach(() => resetMemoryLinear());

type Rpc = { status: number; body: any };

/**
 * Alice owns Acme and its site `shop`, which holds one note of hers on `/pricing`, kept by the
 * worker, or in the Linear in memory with `tracked`. Bob is a member, Gus a guest.
 */
async function acme({ tracked = false, tasks }: { tracked?: boolean; tasks?: 'on' | 'off' } = {}) {
  const world = await open(tasks === undefined ? {} : { env: { FRUITBACK_TASKS: tasks } });
  if (!tracked) world.context.store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const shop = await world.accounts.addSite(workspace, {
    origin: 'https://shop.acme.dev',
    visibility: 'everyone',
    writers: 'anyone',
  });
  if (tasks === 'off') {
    // A worker that keeps no task takes a note with a destination only: an address keeps it in the worker too.
    const rest = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' });
    await world.accounts.setDestination(workspace, shop.id, { connector: rest.id });
  }
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const gus = await signInTo(world, 'gus@acme.dev');
  await memberOf(world, workspace, gus.id, 'guest');
  const { code } = await createPairing(world.sessions, { subject: alice.id, workspace });
  const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
  assert.ok(redeemed.ok);
  const sent = await callOn(world, 'POST', `/feedback?client=${shop.id}`, {
    origin: shop.origin,
    body: noteFixture({
      id: 'sd_one',
      text: 'Too small.',
      createdAt: new Date().toISOString(),
      page: { url: 'https://shop.acme.dev/pricing', path: '/pricing', title: 'Pricing' },
      client: { id: shop.id, name: shop.id },
    }),
    token: redeemed.session.accessToken,
  });
  assert.equal(sent.status, 201, await sent.clone().text());

  const base = `/console/workspaces/${workspace}`;
  const key = async (rights: 'read' | 'write'): Promise<{ id: string; secret: string }> => {
    const made = await callOn(world, 'POST', `${base}/agent-keys`, {
      token: alice.token,
      body: { name: 'Claude on CI', rights, sites: [shop.id] },
    });
    assert.equal(made.status, 201, await made.clone().text());

    return (await made.json()) as { id: string; secret: string };
  };
  const label = async (name: string): Promise<string> => {
    const added = await callOn(world, 'POST', `${base}/labels`, {
      token: alice.token,
      body: { name, color: '#3366ff' },
    });
    assert.equal(added.status, 201, await added.clone().text());

    return ((await added.json()) as { label: { id: string } }).label.id;
  };
  /** The note as the list of the console reads it: the screen an agent's change shows on. */
  const consoleRow = async (): Promise<any> => {
    const listed = await callOn(world, 'GET', `${base}/notes`, { token: alice.token });
    assert.equal(listed.status, 200, await listed.clone().text());

    return ((await listed.json()) as { notes: any[] }).notes[0];
  };
  const writesOf = async (id: string): Promise<any[]> => {
    const listed = await callOn(world, 'GET', `${base}/agent-keys/${id}/writes`, { token: alice.token });
    assert.equal(listed.status, 200, await listed.clone().text());

    return ((await listed.json()) as { writes: any[] }).writes;
  };

  return { world, alice, bob, gus, workspace, shop, key, label, consoleRow, writesOf };
}

let next = 1;

function rpc(world: World, key: string, method: string, params: Record<string, unknown> = {}): Promise<Rpc> {
  return callOn(world, 'POST', '/mcp', {
    origin: null,
    token: key,
    body: { jsonrpc: '2.0', id: next++, method, params },
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

const call = (world: World, key: string, name: string, args: Record<string, unknown>) =>
  rpc(world, key, 'tools/call', { name, arguments: args });

const toolsOf = async (world: World, key: string): Promise<string[]> =>
  (await rpc(world, key, 'tools/list')).body.result.tools.map((tool: { name: string }) => tool.name);

/** The notes `list_notes` answers for these arguments, or the text of its error. */
async function listed(world: World, key: string, args: Record<string, unknown>): Promise<any[] | string> {
  const answer = await call(world, key, 'list_notes', args);
  if (answer.body.result.isError === true) return answer.body.result.content[0].text;

  return answer.body.result.structuredContent.notes;
}

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('the tools of a task in /mcp (FRU-659)', () => {
  it('gives a key read the fields of a task and the filters of the console, and no write of a task', async () => {
    const { world, alice, bob, workspace, shop, key, label } = await acme();
    const urgent = await label('Urgent');
    const { secret } = await key('read');
    const [note] = (await listed(world, secret, { site: shop.id })) as any[];
    assert.deepEqual(note.task, { labels: [] }, 'a task with no field set');

    // A person of the team sets the fields in the console.
    const set = await callOn(world, 'POST', `/console/workspaces/${workspace}/notes/${note.id}/task`, {
      token: alice.token,
      body: { assignee: bob.id, priority: 'high', dueOn: day(-1), labels: [urgent] },
    });
    assert.equal(set.status, 204, await set.clone().text());

    const got = await call(world, secret, 'get_note', { id: note.id });
    const task = got.body.result.structuredContent.note.task;
    assert.equal(task.assignee.id, bob.id);
    assert.equal(task.priority, 'high');
    assert.equal(task.dueOn, day(-1));
    assert.deepEqual(
      task.labels.map((one: { id: string; name: string }) => [one.id, one.name]),
      [[urgent, 'Urgent']],
    );
    assert.equal('position' in task, false, 'the place in a column is the board’s');

    const ids = async (args: Record<string, unknown>) => {
      const notes = await listed(world, secret, { site: shop.id, ...args });
      assert.ok(Array.isArray(notes), String(notes));

      return notes.map((one: { id: string }) => one.id);
    };
    assert.deepEqual(await ids({ assignee: bob.id }), [note.id]);
    assert.deepEqual(await ids({ assignee: 'none' }), []);
    assert.deepEqual(await ids({ priority: 'high' }), [note.id]);
    assert.deepEqual(await ids({ priority: 'none' }), []);
    assert.deepEqual(await ids({ label: urgent }), [note.id]);
    assert.deepEqual(await ids({ due: 'overdue', today: day(0) }), [note.id]);
    assert.deepEqual(await ids({ due: 'overdue' }), [note.id], 'with no today: the day of UTC');
    assert.deepEqual(await ids({ due: 'week', today: day(0) }), []);
    assert.deepEqual(await ids({ due: 'none' }), []);
    assert.deepEqual(await ids({ archived: true }), []);
    assert.match(String(await listed(world, secret, { site: shop.id, assignee: 'me' })), /^Invalid assignee/);
    assert.match(String(await listed(world, secret, { site: shop.id, priority: 'soon' })), /^Invalid priority/);
    assert.match(String(await listed(world, secret, { site: shop.id, due: 'later' })), /^Invalid due/);

    assert.deepEqual(await toolsOf(world, secret), ['list_notes', 'get_note', 'notes_as_text', 'task_choices']);
    const refused = await call(world, secret, 'update_task', { id: note.id, priority: 'low' });
    assert.equal(refused.body.error?.code, -32602);
    assert.equal(
      (await call(world, secret, 'get_note', { id: note.id })).body.result.structuredContent.note.task.priority,
      'high',
    );
  });

  it('changes the status and every field of a task, which the console reads, and logs both writes', async () => {
    const { world, bob, shop, key, label, consoleRow, writesOf } = await acme();
    const [bug, copy] = [await label('Bug'), await label('Copy')];
    const { id: keyId, secret } = await key('write');
    const [note] = (await listed(world, secret, { site: shop.id })) as any[];
    assert.ok((await toolsOf(world, secret)).includes('update_task'));

    const updated = await call(world, secret, 'update_task', {
      id: note.id,
      status: 'own:progress',
      assignee: bob.id,
      priority: 'urgent',
      dueOn: day(3),
      labels: [copy, bug, copy],
    });
    assert.equal(updated.body.result.isError, undefined, JSON.stringify(updated.body));
    const answer = updated.body.result.structuredContent;
    assert.equal(answer.stage, 'progress');
    assert.equal(answer.task.assignee.id, bob.id);

    const row = await consoleRow();
    assert.equal(row.status, 'own:progress');
    assert.equal(row.task.assignee.id, bob.id);
    assert.equal(row.task.priority, 'urgent');
    assert.equal(row.task.dueOn, day(3));
    assert.deepEqual(
      row.task.labels.map((one: { name: string }) => one.name),
      ['Bug', 'Copy'],
    );
    const writes = await writesOf(keyId);
    assert.deepEqual(writes.map((write) => write.action).toSorted(), ['status', 'task']);

    // `null` clears a field; a field left out does not change.
    const cleared = await call(world, secret, 'update_task', { id: note.id, assignee: null, dueOn: null, labels: [] });
    assert.equal(cleared.body.result.isError, undefined, JSON.stringify(cleared.body));
    const after = await consoleRow();
    assert.deepEqual(after.task, { priority: 'urgent', labels: [] });
    assert.equal(after.status, 'own:progress');
  });

  it('refuses an update that is not one, and writes nothing of a refused one', async () => {
    const { world, alice, shop, key, consoleRow, writesOf } = await acme();
    const other = await workspaceIn(world, alice.token, 'Other');
    const foreign = await callOn(world, 'POST', `/console/workspaces/${other}/labels`, {
      token: alice.token,
      body: { name: 'Elsewhere', color: '#000000' },
    });
    const elsewhere = ((await foreign.json()) as { label: { id: string } }).label.id;
    const stranger = await signInTo(world, 'eve@else.dev');
    const { id: keyId, secret } = await key('write');
    const [note] = (await listed(world, secret, { site: shop.id })) as any[];

    for (const [args, error] of [
      [{ id: note.id }, /^Nothing to change/],
      [{ id: note.id, priority: 'soon' }, /^Invalid priority/],
      [{ id: note.id, dueOn: '2026-02-30' }, /^Invalid dueOn/],
      [{ id: note.id, labels: 'Bug' }, /^Invalid labels/],
      [{ id: note.id, status: 'done' }, /^Invalid status/],
      [{ id: note.id, status: 'own:nope', priority: 'low' }, /^No status of this site/],
      [{ id: note.id, assignee: stranger.id, priority: 'low' }, /^No member of this workspace/],
      [{ id: note.id, labels: [elsewhere], priority: 'low' }, /^No label of this workspace/],
      [{ id: 'nope', priority: 'low' }, /^No note of the sites of this key/],
    ] as const) {
      const refused = await call(world, secret, 'update_task', args);
      assert.equal(refused.body.result.isError, true, JSON.stringify(args));
      assert.match(refused.body.result.content[0].text, error, JSON.stringify(args));
    }
    const row = await consoleRow();
    assert.deepEqual(row.task, { labels: [] });
    assert.equal(row.status, 'own:new');
    assert.deepEqual(await writesOf(keyId), []);
  });

  it('refuses the fields and the status of a note in a tracker', async () => {
    const { world, shop, key, writesOf } = await acme({ tracked: true });
    const { id: keyId, secret } = await key('write');
    const [note] = (await listed(world, secret, { site: shop.id })) as any[];
    assert.equal('task' in note, false, 'a note in a tracker has no field of Fruitback');

    const fields = await call(world, secret, 'update_task', { id: note.id, priority: 'low' });
    assert.match(fields.body.result.content[0].text, /^fields-not-taken/);
    const status = await call(world, secret, 'update_task', { id: note.id, status: 'own:done' });
    assert.match(status.body.result.content[0].text, /^statuses-not-taken/);
    assert.deepEqual(await writesOf(keyId), []);
  });

  it('lists the labels and the members a task can be given to, never a guest', async () => {
    const { world, alice, bob, gus, workspace, shop, key, label } = await acme();
    const bug = await label('Bug');
    const { secret } = await key('read');

    const choices = (await call(world, secret, 'task_choices', {})).body.result.structuredContent;
    assert.deepEqual(choices.labels, [{ id: bug, name: 'Bug', color: '#3366ff' }]);
    const members = choices.members.map((member: { id: string }) => member.id);
    assert.deepEqual(members.toSorted(), [alice.id, bob.id].toSorted());
    assert.equal(members.includes(gus.id), false);
    assert.deepEqual(Object.keys(choices.members[0]).toSorted(), ['id', 'name'], 'no e-mail');

    // A key whose member no longer reads the members (a guest now) gets the labels only.
    await rowsOf(world.database, `UPDATE member SET role = 'admin' WHERE "userId" = '${bob.id}'`);
    const made = await key('read');
    await rowsOf(world.database, `UPDATE agent_keys SET created_by = '${bob.id}' WHERE id = '${made.id}'`);
    const control = (await call(world, made.secret, 'task_choices', {})).body.result.structuredContent;
    assert.equal(control.members.length, 2, 'the control: an admin reads the members');
    await rowsOf(world.database, `UPDATE member SET role = 'guest' WHERE "userId" = '${bob.id}'`);
    await shareWith(world, workspace, bob.id, [shop.id]);
    const guest = await call(world, made.secret, 'task_choices', {});
    assert.equal(guest.body.result.isError, undefined, JSON.stringify(guest.body));
    assert.deepEqual(guest.body.result.structuredContent.members, []);
    assert.deepEqual(guest.body.result.structuredContent.labels, choices.labels);
  });

  it('gives no tool of a task on a worker that keeps none, and refuses each when called', async () => {
    const { world, shop, key } = await acme({ tasks: 'off' });
    const { secret } = await key('write');
    const [note] = (await listed(world, secret, { site: shop.id })) as any[];

    assert.deepEqual(await toolsOf(world, secret), ['list_notes', 'get_note', 'notes_as_text', 'reply_to_note']);
    for (const [name, args] of [
      ['update_task', { id: note.id, priority: 'low' }],
      ['set_note_status', { id: note.id, status: 'own:done' }],
      ['task_choices', {}],
    ] as const) {
      const refused = await call(world, secret, name, args);
      assert.equal(refused.body.error?.code, -32602, name);
    }
  });
});

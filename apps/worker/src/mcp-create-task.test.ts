import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { AGENT_WRITE_LIMIT } from './agent-tools.ts';
import { noteKeyOf } from './console-notes.ts';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';
import { StoreError } from './store.ts';

/**
 * `create_task` of `/mcp` (FRU-659, 2/2): a task written by hand (FRU-657) by an agent key that
 * writes, through the route `/mcp`. Then `update_task` and `set_note_status` change it, as the
 * console does.
 */

const open = worlds();

type Rpc = { status: number; body: any };

const TEAM = { name: null, color: null, textColor: null, position: 0, origin: 'team' as const, hidden: false };

/**
 * Alice owns Acme and its sites `shop` and `blog`, which keep their notes in Fruitback; `shop` holds
 * one note on `/pricing`, and the statuses `waiting` (To do) and `parked` (hidden). Bob is a member.
 * The keys name `shop` only.
 */
async function acme({ tasks }: { tasks?: 'on' | 'off' } = {}) {
  const world = await open(tasks === undefined ? {} : { env: { FRUITBACK_TASKS: tasks } });
  world.context.store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const shop = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'members' });
  const blog = await world.accounts.addSite(workspace, { origin: 'https://blog.acme.dev', visibility: 'members' });
  const hook = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' });
  if (tasks === 'off') {
    // A worker that keeps no task keeps the notes of a site that sends them to an address only.
    await world.accounts.setDestination(workspace, shop.id, { connector: hook.id });
  }
  await world.accounts.putSiteStatus(workspace, shop.id, {
    source: 'own',
    key: 'waiting',
    stage: 'todo' as never,
    ...TEAM,
    name: 'Waiting',
  });
  await world.accounts.putSiteStatus(workspace, shop.id, {
    source: 'own',
    key: 'parked',
    stage: 'todo' as never,
    ...TEAM,
    name: 'Parked',
    position: 1,
    hidden: true,
  });
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
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
  const label = async (name: string, owner = workspace): Promise<string> => {
    const added = await callOn(world, 'POST', `/console/workspaces/${owner}/labels`, {
      token: alice.token,
      body: { name, color: '#3366ff' },
    });
    assert.equal(added.status, 201, await added.clone().text());

    return ((await added.json()) as { label: { id: string } }).label.id;
  };
  /** The tasks with no page, as the list of the console reads them: the screen an agent's task shows on. */
  const consoleTasks = async (): Promise<any[]> => {
    const listed = await callOn(world, 'GET', `${base}/notes`, { token: alice.token });
    assert.equal(listed.status, 200, await listed.clone().text());

    return ((await listed.json()) as { notes: any[] }).notes.filter((note) => note.page.url === '');
  };
  const writesOf = async (id: string): Promise<any[]> => {
    const listed = await callOn(world, 'GET', `${base}/agent-keys/${id}/writes`, { token: alice.token });
    assert.equal(listed.status, 200, await listed.clone().text());

    return ((await listed.json()) as { writes: any[] }).writes;
  };

  return { world, alice, bob, workspace, base, shop, blog, hook, key, label, consoleTasks, writesOf };
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

/** What a tool answered: its content, or the text of its error. */
async function answered(world: World, key: string, name: string, args: Record<string, unknown>): Promise<any> {
  const answer = await call(world, key, name, args);
  assert.equal(answer.status, 200);
  if (answer.body.result?.isError === true) return answer.body.result.content[0].text as string;
  assert.ok(answer.body.result, JSON.stringify(answer.body));

  return answer.body.result.structuredContent;
}

const toolsOf = async (world: World, key: string): Promise<string[]> =>
  (await rpc(world, key, 'tools/list')).body.result.tools.map((tool: { name: string }) => tool.name);

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe('create_task of /mcp (FRU-659)', () => {
  it('writes a task with every field, which the console lists and get_note reads, and logs it', async () => {
    const { world, alice, bob, base, shop, key, label, consoleTasks, writesOf } = await acme();
    const [bug, copy] = [await label('Bug'), await label('Copy')];
    const { id: keyId, secret } = await key('write');
    assert.ok((await toolsOf(world, secret)).includes('create_task'));

    const made = await answered(world, secret, 'create_task', {
      site: shop.id,
      title: '  Write   the release notes ',
      text: 'For the 2.0.',
      status: 'own:progress',
      assignee: bob.id,
      priority: 'high',
      dueOn: day(2),
      labels: [copy, bug, copy],
    });
    assert.equal(typeof made, 'object', String(made));
    // The answer is what was written: the ids as they were sent, each label once.
    const { notice: _notice, ...written } = made;
    assert.deepEqual(written, {
      id: made.id,
      site: shop.id,
      identifier: made.identifier,
      status: 'own:progress',
      stage: 'progress',
      title: 'Write the release notes',
      text: 'For the 2.0.',
      assignee: bob.id,
      priority: 'high',
      dueOn: day(2),
      labels: [copy, bug],
    });
    assert.match(made.identifier, /^FB-\d+$/);
    assert.equal(noteKeyOf(made.id)?.site, shop.id);

    const [row] = await consoleTasks();
    assert.equal(row?.id, made.id);
    assert.equal(row.excerpt, 'Write the release notes');
    assert.equal(row.status, 'own:progress');
    assert.equal(row.task.assignee.id, bob.id);
    assert.equal(row.task.priority, 'high');
    assert.equal(row.task.dueOn, day(2));
    assert.deepEqual(row.task.labels.map((one: { name: string }) => one.name).toSorted(), ['Bug', 'Copy']);

    // Its page in the console: written by the member of the key, whose own task it is.
    const page = await callOn(world, 'GET', `${base}/notes/${made.id}`, { token: alice.token });
    assert.equal(page.status, 200, await page.clone().text());
    const { task } = (await page.json()) as { task: any };
    assert.equal(task.task.reporter.id, alice.id);
    assert.equal(task.task.text, 'For the 2.0.');
    assert.equal(task.mine, true);

    const got = await answered(world, secret, 'get_note', { id: made.id });
    assert.equal(got.task.identifier, made.identifier);
    assert.equal(got.task.fields.priority, 'high');

    assert.deepEqual(
      (await writesOf(keyId)).map(({ action, status, note }) => ({ action, status, note })),
      [{ action: 'create', status: 'own:progress', note: noteKeyOf(made.id)?.note }],
    );
  });

  it('takes a title alone, in the status New, and a status the team added', async () => {
    const { world, shop, key, consoleTasks } = await acme();
    const { secret } = await key('write');

    const alone = await answered(world, secret, 'create_task', { site: shop.id, title: 'Call the client' });
    assert.equal(alone.status, 'own:new');
    assert.equal(alone.stage, 'new');
    assert.deepEqual(alone.labels, []);
    assert.equal('assignee' in alone, false);

    const waiting = await answered(world, secret, 'create_task', {
      site: shop.id,
      title: 'Wait for the copy',
      status: 'own:waiting',
    });
    assert.equal(waiting.status, 'own:waiting');
    assert.equal(waiting.stage, 'todo');
    assert.deepEqual((await consoleTasks()).map((one) => one.status).toSorted(), ['own:new', 'own:waiting'].toSorted());
  });

  it('refuses before it writes what it cannot take, and writes nothing then', async () => {
    const { world, alice, shop, blog, key, label, consoleTasks, writesOf } = await acme();
    const other = await workspaceIn(world, alice.token, 'Other');
    const elsewhere = await label('Elsewhere', other);
    const foreign = await world.accounts.addSite(other, { origin: 'https://other.dev', visibility: 'members' });
    // A member of another workspace only.
    const eve = await signInTo(world, 'eve@else.dev');
    await memberOf(world, other, eve.id, 'member');
    const { id: keyId, secret } = await key('write');
    const site = shop.id;

    for (const [args, error] of [
      [{ site, title: 'A', due: day(1) }, /^Unknown argument: due\. create_task takes site, title, /],
      [{ site, title: 'A', position: 1 }, /^Unknown argument: position\./],
      [{ site, title: '   ' }, /^Invalid title\.$/],
      [{ site, title: 'A'.repeat(201) }, /^Invalid title\.$/],
      [{ site, title: 'A', text: 7 }, /^Invalid text\.$/],
      [{ site, title: 'A', status: 'done' }, /^Invalid status: a status of the site, as `own:<key>`\.$/],
      [{ site, title: 'A', priority: 'soon' }, /^Invalid priority\.$/],
      [{ site, title: 'A', dueOn: '2026-02-30' }, /^Invalid dueOn\.$/],
      [{ site, title: 'A', labels: 'Bug' }, /^Invalid labels\.$/],
      [{ site: blog.id, title: 'A' }, /^No site of this key has this id\.$/],
      [{ site: foreign.id, title: 'A' }, /^No site of this key has this id\.$/],
      [{ title: 'A' }, /^No site of this key has this id\.$/],
      [{ site, title: 'A', status: 'own:nope' }, /^No status of this site has this key\.$/],
      [{ site, title: 'A', status: 'own:parked' }, /^This status is hidden on its site\.$/],
      [{ site, title: 'A', assignee: eve.id }, /^No member of this workspace has this assignee id/],
      [{ site, title: 'A', labels: [elsewhere] }, /^No label of this workspace has one of these ids/],
    ] as const) {
      assert.match(String(await answered(world, secret, 'create_task', args)), error, JSON.stringify(args));
    }
    assert.deepEqual(await consoleTasks(), []);
    const blogTasks = await rowsOf(world.database, `SELECT id FROM notes WHERE page_url = ''`);
    assert.deepEqual(blogTasks, [], 'no task in any site, of any workspace');
    assert.deepEqual(await writesOf(keyId), []);
  });

  it('is given to a key that writes only, and refused to a key read', async () => {
    const { world, shop, key, consoleTasks } = await acme();
    const { secret } = await key('read');

    assert.equal((await toolsOf(world, secret)).includes('create_task'), false);
    const refused = await call(world, secret, 'create_task', { site: shop.id, title: 'A' });
    assert.equal(refused.body.error?.code, -32602);
    assert.deepEqual(await consoleTasks(), []);
  });

  it('is not given on a worker that keeps no task, and refused when called', async () => {
    const { world, shop, key } = await acme({ tasks: 'off' });
    const { secret } = await key('write');

    assert.equal((await toolsOf(world, secret)).includes('create_task'), false);
    const refused = await call(world, secret, 'create_task', { site: shop.id, title: 'A' });
    assert.equal(refused.body.error?.code, -32602);
  });

  it('counts in the limit of the writes of its key, with update_task', async () => {
    assert.equal(AGENT_WRITE_LIMIT, 30, 'SECURITY.md names the limit');
    const { world, shop, key, consoleTasks, writesOf } = await acme();
    const { id: keyId, secret } = await key('write');
    const first = await answered(world, secret, 'create_task', { site: shop.id, title: 'Task 0' });
    for (let index = 1; index < AGENT_WRITE_LIMIT; index += 1) {
      const [name, args] =
        index % 2 === 0
          ? ['create_task', { site: shop.id, title: `Task ${index}` }]
          : ['update_task', { id: first.id, priority: index % 4 === 1 ? 'low' : 'high' }];
      const done = await answered(world, secret, name, args);
      assert.equal(typeof done, 'object', `${name} ${index}: ${String(done)}`);
    }

    const limited = await answered(world, secret, 'create_task', { site: shop.id, title: 'One more' });
    assert.match(String(limited), /wrote 30 times/);
    assert.equal((await consoleTasks()).length, 15);
    assert.equal((await writesOf(keyId)).length, AGENT_WRITE_LIMIT);
  });

  it('starts no agent: a task in To do calls no trigger of its site, where one of the console does', async () => {
    const { world, alice, base, shop, hook, key } = await acme();
    const trigger = await callOn(world, 'POST', `${base}/sites/${shop.id}/agent-trigger`, {
      token: alice.token,
      body: { connector: hook.id, moment: 'moved-to-todo', enabled: true },
    });
    assert.ok(trigger.ok, await trigger.clone().text());
    const calls = async () =>
      (await rowsOf(world.database, `SELECT body FROM deliveries WHERE event = 'agent.requested'`)).length;
    const { secret } = await key('write');

    const made = await answered(world, secret, 'create_task', { site: shop.id, title: 'A', status: 'own:todo' });
    assert.equal(made.stage, 'todo');
    assert.equal(await calls(), 0);

    // The control: the same task, written by a person in the console, calls once.
    const written = await callOn(world, 'POST', `${base}/notes`, {
      token: alice.token,
      body: { site: shop.id, title: 'B', status: 'own:todo' },
    });
    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(await calls(), 1);
  });

  it('says that the task may be written when the store does not answer its write', async () => {
    const { world, shop, key, writesOf } = await acme();
    const kept = world.context.accounts;
    assert.ok(kept !== undefined);
    world.context.accounts = {
      ...kept,
      createTask: async () => {
        throw new StoreError('the database went away');
      },
    };
    const { id: keyId, secret } = await key('write');

    const failed = await answered(world, secret, 'create_task', { site: shop.id, title: 'A' });
    assert.equal(
      failed,
      'The store of the notes did not answer: the task may have been written. Look for it with notes_as_text before you write it again.',
    );
    assert.deepEqual(await writesOf(keyId), []);
  });
});

describe('update_task and set_note_status on a task that create_task wrote (FRU-659)', () => {
  it('changes its fields and its status, as the console does, and logs each write', async () => {
    const { world, bob, shop, key, label, consoleTasks, writesOf } = await acme();
    const bug = await label('Bug');
    const { id: keyId, secret } = await key('write');
    const made = await answered(world, secret, 'create_task', {
      site: shop.id,
      title: 'Fix the footer',
      assignee: bob.id,
      dueOn: day(1),
    });

    const updated = await answered(world, secret, 'update_task', {
      id: made.id,
      status: 'own:progress',
      assignee: null,
      priority: 'urgent',
      labels: [bug],
    });
    assert.equal(typeof updated, 'object', String(updated));
    assert.equal(updated.id, made.id);
    assert.equal(updated.status, 'own:progress');
    assert.equal(updated.stage, 'progress');
    assert.equal(updated.task.priority, 'urgent');
    const [row] = await consoleTasks();
    assert.equal(row.status, 'own:progress');
    assert.equal('assignee' in row.task, false, 'null clears the assignee');
    assert.equal(row.task.dueOn, day(1), 'a field left out does not change');
    assert.deepEqual(
      row.task.labels.map((one: { name: string }) => one.name),
      ['Bug'],
    );

    const set = await answered(world, secret, 'set_note_status', { id: made.id, status: 'own:done' });
    assert.deepEqual(set, { notice: set.notice, status: 'own:done', stage: 'done' });
    assert.equal((await consoleTasks())[0].status, 'own:done');
    assert.deepEqual((await writesOf(keyId)).map((write) => write.action).toSorted(), [
      'create',
      'status',
      'status',
      'task',
    ]);
  });

  it('refuses a status or a field it cannot take, and writes nothing of a refused one', async () => {
    const { world, shop, key, consoleTasks } = await acme();
    const stranger = await signInTo(world, 'eve@else.dev');
    const { secret } = await key('write');
    const made = await answered(world, secret, 'create_task', { site: shop.id, title: 'Fix the footer' });

    for (const [name, args, error] of [
      ['update_task', { id: made.id, status: 'own:nope', priority: 'low' }, /^No status of this site has this key\.$/],
      ['update_task', { id: made.id, status: 'own:parked' }, /^This status is hidden on its site\.$/],
      ['update_task', { id: made.id, assignee: stranger.id }, /^No member of this workspace has this assignee id/],
      ['set_note_status', { id: made.id, status: 'own:nope' }, /^No status of this site has this key\.$/],
    ] as const) {
      assert.match(String(await answered(world, secret, name, args)), error, JSON.stringify(args));
    }
    const [row] = await consoleTasks();
    assert.equal(row.status, 'own:new');
    assert.deepEqual(row.task, { labels: [] });
  });

  it('says that the fields were saved when the status fails after them', async () => {
    const { world, bob, shop, key, consoleTasks } = await acme();
    const { secret } = await key('write');
    const made = await answered(world, secret, 'create_task', { site: shop.id, title: 'Fix the footer' });
    const kept = world.context.accounts;
    assert.ok(kept !== undefined);
    world.context.accounts = {
      ...kept,
      setNoteStatus: async () => {
        throw new StoreError('the database went away');
      },
    };

    const failed = await answered(world, secret, 'update_task', { id: made.id, status: 'own:done', assignee: bob.id });
    assert.match(String(failed), /^The fields were saved; the status was not\. /);
    const [row] = await consoleTasks();
    assert.equal(row.task.assignee.id, bob.id);
    assert.equal(row.status, 'own:new');
  });
});

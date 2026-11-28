import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf, noteKeyOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * A task written by hand with no site (FRU-672): it belongs to its workspace only. A member writes,
 * reads and changes it as a task of a site that every member reads, with the built-in statuses only; a
 * guest neither writes nor sees it; it stays when a site goes, and goes with its workspace.
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

/**
 * Alice owns Acme and its site, which keeps its notes in Fruitback and has a status of its own,
 * « Review ». Bob is a member, Gina a guest with the site shared with her. One note on `/pricing`.
 */
async function acme() {
  const world = await open();
  world.context.store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' })).id;
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const gina = await signInTo(world, 'gina@acme.dev');
  await memberOf(world, workspace, gina.id, 'guest');
  await shareWith(world, workspace, gina.id, [site]);
  const extension = await sessionOf(world, alice.id, workspace);
  const planted = await callOn(world, 'POST', '/feedback', {
    origin: ORIGIN,
    body: noteFixture({
      id: 'sd_1',
      page: { url: `${ORIGIN}/pricing`, path: '/pricing' },
      client: { id: site, name: 'Acme' },
    }),
    headers: { Authorization: `Bearer ${extension}` },
  });
  assert.equal(planted.status, 201, await planted.clone().text());
  const base = `/console/workspaces/${workspace}`;
  const call = (method: string, path: string, token: string, body?: unknown) =>
    callOn(world, method, `${base}${path}`, { token, ...(body === undefined ? {} : { body }) }).then(answerOf);
  const review = await call('POST', `/sites/${site}/statuses`, alice.token, {
    source: 'own',
    key: 'review',
    name: 'Review',
    stage: 'progress',
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  const ids = async (token: string, query = '') =>
    ((await call('GET', `/notes${query}`, token)).body.notes as { id: string }[]).map((note) => note.id);

  return { world, alice, bob, gina, workspace, site, base, call, ids, review: 'own:review' };
}

describe('a task written by hand with no site (FRU-672)', () => {
  it('is written by a member with no site, and the list shows it with the built-in statuses', async () => {
    const { bob, site, call, ids } = await acme();

    const made = await call('POST', '/notes', bob.token, { title: 'Renew the domain', priority: 'high' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(noteKeyOf(made.body.id), { site: '', note: noteKeyOf(made.body.id)?.note });
    assert.match(made.body.identifier, /^FB-\d+$/);
    // `null` says the same as no site.
    assert.equal((await call('POST', '/notes', bob.token, { site: null, title: 'Pay the invoice' })).status, 201);

    const list = await call('GET', '/notes', bob.token);
    const row = list.body.notes.find((note: { id: string }) => note.id === made.body.id);
    assert.equal(row.site.id, '');
    assert.equal(row.page.url, '');
    assert.equal(row.status, 'own:new');
    assert.deepEqual(row.task, { priority: 'high', labels: [] });
    assert.deepEqual(
      list.body.statuses[''].map((status: { key: string }) => status.key),
      ['own:new', 'own:todo', 'own:progress', 'own:done', 'own:closed'],
      'the built-in statuses, and no status of a site',
    );
    assert.equal(list.body.statuses[site].length, 6, 'the control: the site has « Review » too');
    assert.equal((await ids(bob.token)).length, 3);

    const read = await call('GET', `/notes/${made.body.id}`, bob.token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.task.task.title, 'Renew the domain');
    assert.equal(read.body.task.task.client, undefined, 'it names no site');
    assert.equal(read.body.task.mine, true);
  });

  it('takes the built-in statuses only, and its fields, as a task of a site', async () => {
    const { alice, bob, call, review } = await acme();
    const made = await call('POST', '/notes', bob.token, { title: 'Renew the domain', status: 'own:todo' });
    assert.equal(made.body.stage, 'todo');
    const id = made.body.id as string;

    assert.deepEqual(
      [(await call('POST', '/notes', bob.token, { title: 'A', status: review })).status],
      [409],
      'a status of a site is no status of the workspace',
    );
    const refused = await call('POST', `/notes/${id}/status`, bob.token, { status: review });
    assert.deepEqual([refused.status, refused.body.error], [409, 'status-changed']);
    const moved = await call('POST', `/notes/${id}/status`, bob.token, { status: 'own:done' });
    assert.deepEqual([moved.status, moved.body.stage], [200, 'done']);
    assert.equal(
      (await call('POST', `/notes/${id}/task`, bob.token, { priority: 'low', dueOn: '2026-12-01' })).status,
      204,
    );
    // A member who manages the sites changes the task of another, as for a task of a site.
    assert.equal((await call('POST', `/notes/${id}/task`, alice.token, { assignee: bob.id })).status, 204);
    const several = await call('POST', '/tasks', alice.token, { notes: [id], change: { priority: 'urgent' } });
    assert.equal(several.status, 200, JSON.stringify(several.body));

    const row = (await call('GET', '/notes', bob.token)).body.notes.find((note: { id: string }) => note.id === id);
    assert.equal(row.stage, 'done');
    assert.deepEqual(row.task, {
      assignee: { id: bob.id, name: row.task.assignee.name },
      priority: 'urgent',
      dueOn: '2026-12-01',
      labels: [],
    });
    assert.equal((await call('DELETE', `/notes/${id}/task`, bob.token)).status, 204);
    assert.equal((await call('GET', `/notes/${id}`, bob.token)).status, 404);
  });

  it('is neither written nor seen by a guest, nor counted for her', async () => {
    const { workspace, bob, gina, site, call, ids, world } = await acme();
    const made = await call('POST', '/notes', bob.token, { title: 'Renew the domain' });
    const id = made.body.id as string;

    assert.equal((await call('POST', '/notes', gina.token, { title: 'Mine' })).status, 404);
    assert.equal(
      (await call('POST', '/notes', gina.token, { site, title: 'In the shared site' })).status,
      201,
      'the control',
    );
    assert.equal((await ids(gina.token)).includes(id), false);
    assert.equal((await ids(bob.token)).includes(id), true);
    assert.equal((await call('GET', `/notes/${id}`, gina.token)).status, 404);
    assert.equal((await call('POST', `/notes/${id}/status`, gina.token, { status: 'own:done' })).status, 404);
    assert.equal((await call('POST', `/notes/${id}/task`, gina.token, { priority: 'low' })).status, 404);
    assert.equal((await call('DELETE', `/notes/${id}/task`, gina.token)).status, 404);
    const several = await call('POST', '/tasks', gina.token, { notes: [id], change: { priority: 'low' } });
    assert.equal(several.status, 404, JSON.stringify(several.body));

    const rail = async (token: string) =>
      (await answerOf(await callOn(world, 'GET', `/console/workspaces/${workspace}/rail`, { token }))).body.notes;
    // Gina: the note of the site and her task. Bob: the same, and the task of the workspace.
    assert.equal(await rail(gina.token), 2);
    assert.equal(await rail(bob.token), 3);
  });

  it('stays when a site goes, and goes with its workspace', async () => {
    const { world, alice, workspace, site, call, ids } = await acme();
    const made = await call('POST', '/notes', alice.token, { title: 'Renew the domain' });

    assert.equal(await world.accounts.removeSite(workspace, site), true);
    assert.deepEqual(await ids(alice.token), [made.body.id]);
    assert.equal((await call('GET', `/notes/${made.body.id}`, alice.token)).status, 200);

    const kept = async () =>
      (await rowsOf(world.database, `SELECT id FROM notes WHERE client_id = '' AND payload LIKE '%Renew the domain%'`))
        .length;
    assert.equal(await kept(), 1);
    // The administrator of the instance lists it, with no site and no address.
    const admin = await world.context.instanceAdmin?.notes({ limit: 50, workspace });
    assert.deepEqual(
      admin?.notes.map((note) => [note.site, note.excerpt]),
      [[{ id: '', origin: '' }, 'Renew the domain']],
    );
    await world.accounts.deleteWorkspace(workspace);
    assert.equal(await kept(), 0, 'no row of a task outlives its workspace');
    assert.equal((await rowsOf(world.database, `SELECT 1 FROM note_index WHERE site_id = ''`)).length, 0);
  });

  it('is never read by a key of /mcp, which reads the sites of its grant', async () => {
    const { world, alice, workspace, site, call } = await acme();
    const made = await call('POST', '/notes', alice.token, { title: 'Renew the domain' });
    const key = await call('POST', '/agent-keys', alice.token, { name: 'Claude', rights: 'write', sites: [site] });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    const tool = async (name: string, args: Record<string, unknown>) =>
      (
        await answerOf(
          await callOn(world, 'POST', '/mcp', {
            origin: null,
            token: key.body.secret,
            body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
          }),
        )
      ).body.result;

    assert.equal((await tool('get_note', { id: made.body.id })).isError, true);
    assert.equal((await tool('list_notes', { site: '' })).isError, true);
    assert.equal((await tool('update_task', { id: made.body.id, priority: 'low' })).isError, true);
    assert.deepEqual(
      (await tool('list_notes', { site })).structuredContent.notes.map((note: { id: string }) => note.id),
      [noteIdOf(site, 'sd_1')],
    );
    const refused = await callOn(world, 'POST', `/console/workspaces/${workspace}/agent-keys`, {
      token: alice.token,
      body: { name: 'Claude', rights: 'read', sites: [''] },
    });
    assert.equal(refused.status, 400, 'a grant names no workspace as a site');
  });
});

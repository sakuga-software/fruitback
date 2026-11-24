import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf, noteKeyOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';

/**
 * A task written by hand (FRU-657): `POST …/notes`, with no page and no pin. It is listed with the
 * notes of its site, its page reads it as `{ task }`, and no read of a page, of the extension or of a
 * tool of `/mcp` takes it for a note of a page.
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

/** Alice owns Acme, whose site keeps its notes in Fruitback. Bob is a member. One note on `/pricing`. */
async function acme(tasks?: string) {
  const world = await open(tasks === undefined ? {} : { env: { FRUITBACK_TASKS: tasks } });
  const store = createPostgresNoteStore(world.database);
  world.context.store = store;
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' })).id;
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const extension = await sessionOf(world, alice.id, workspace);
  // A worker that keeps no task keeps no note of a site with no destination either (FRU-651).
  const planted =
    tasks === 'off'
      ? undefined
      : await callOn(world, 'POST', '/feedback', {
          origin: ORIGIN,
          body: noteFixture({
            id: 'sd_1',
            page: { url: `${ORIGIN}/pricing`, path: '/pricing' },
            client: { id: site, name: 'Acme' },
          }),
          headers: { Authorization: `Bearer ${extension}` },
        });
  if (planted !== undefined) assert.equal(planted.status, 201, await planted.clone().text());
  const base = `/console/workspaces/${workspace}`;
  const call = (method: string, path: string, token: string, body?: unknown) =>
    callOn(world, method, `${base}${path}`, { token, ...(body === undefined ? {} : { body }) }).then(answerOf);
  const listed = async (token = alice.token) => (await call('GET', '/notes', token)).body.notes as any[];

  return { world, alice, bob, workspace, site, extension, base, call, listed };
}

describe('a task written by hand (FRU-657)', () => {
  it('takes a title alone, and the list shows it with the notes of its site, with no page', async () => {
    const { bob, site, call, listed } = await acme();

    const made = await call('POST', '/notes', bob.token, { site, title: '  Write the   release notes ' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.match(made.body.identifier, /^FB-\d+$/);
    assert.equal(made.body.stage, 'new');
    assert.equal(noteKeyOf(made.body.id)?.site, site);

    const row = (await listed(bob.token)).find((one) => one.id === made.body.id);
    assert.ok(row, 'the task is in the list');
    assert.equal(row.excerpt, 'Write the release notes');
    assert.equal(row.page.url, '');
    assert.equal(row.status, 'own:new');
    assert.equal(row.author.kind, 'you');
    // Its author changes it, as the author of a note.
    assert.equal(row.canSetStatus, true);
    assert.equal((await listed()).length, 2, 'the note of the page is still there');
  });

  it('reads as `{ task }` on its page: its title, its text, its number and no page', async () => {
    const { alice, site, call } = await acme();
    const made = await call('POST', '/notes', alice.token, { site, title: 'Check the invoices', text: 'All of May.' });

    const read = await call('GET', `/notes/${made.body.id}`, alice.token);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.note, undefined);
    assert.equal(read.body.task.identifier, made.body.identifier);
    assert.equal(read.body.task.title, 'Check the invoices');
    assert.equal(read.body.task.task.kind, 'fruitback.task');
    assert.equal(read.body.task.task.text, 'All of May.');
    assert.equal(read.body.task.task.page, undefined);
    assert.equal(read.body.task.mine, true);
    assert.deepEqual(read.body.task.comments, []);
    // A note of a page still reads as `{ note }`.
    const note = await call('GET', `/notes/${noteIdOf(site, 'sd_1')}`, alice.token);
    assert.equal(note.body.note.note.id, 'sd_1');
  });

  it('takes its status and its fields at once, and the list filters on them', async () => {
    const { world, alice, bob, workspace, site, call, listed } = await acme();
    const label = (await world.accounts.addLabel(workspace, { name: 'Billing', color: '#aa0000' })) as any;
    const made = await call('POST', '/notes', alice.token, {
      site,
      title: 'Send the quote',
      status: 'own:progress',
      assignee: bob.id,
      priority: 'high',
      dueOn: '2026-12-01',
      labels: [label.label.id],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.stage, 'progress');

    const row = (await listed()).find((one) => one.id === made.body.id);
    assert.equal(row.stage, 'progress');
    assert.equal(row.task.assignee.id, bob.id);
    assert.equal(row.task.priority, 'high');
    assert.equal(row.task.dueOn, '2026-12-01');
    assert.deepEqual(
      row.task.labels.map((one: { id: string }) => one.id),
      [label.label.id],
    );
    const filtered = (await call('GET', `/notes?assignee=${bob.id}&priority=high`, alice.token)).body.notes;
    assert.deepEqual(
      filtered.map((one: { id: string }) => one.id),
      [made.body.id],
    );
    // Its fields change after, as those of any task the worker keeps.
    assert.equal((await call('POST', `/notes/${made.body.id}/task`, alice.token, { priority: 'low' })).status, 204);
    assert.equal(
      (await call('POST', `/notes/${made.body.id}/status`, alice.token, { status: 'own:done' })).body.stage,
      'done',
    );
  });

  it('refuses a task with no title, an unknown site, status, assignee or label, and every write on a worker that keeps none', async () => {
    const { alice, site, call } = await acme();
    const refused = async (body: Record<string, unknown>) => {
      const answer = await call('POST', '/notes', alice.token, body);

      return [answer.status, answer.body.field ?? answer.body.error];
    };

    assert.deepEqual(await refused({ site, title: '   ' }), [400, 'title']);
    assert.deepEqual(await refused({ site }), [400, 'title']);
    assert.deepEqual(await refused({ site, title: 'x'.repeat(201) }), [400, 'title']);
    assert.deepEqual(await refused({ title: 'No site' }), [400, 'site']);
    assert.deepEqual(await refused({ site, title: 'A', status: 'done' }), [400, 'status']);
    assert.deepEqual(await refused({ site, title: 'A', priority: 'soon' }), [400, 'priority']);
    assert.deepEqual(await refused({ site: 'site_none', title: 'A' }), [404, 'not-found']);
    assert.deepEqual(await refused({ site, title: 'A', status: 'own:nowhere' }), [409, 'status-changed']);
    assert.deepEqual(await refused({ site, title: 'A', assignee: 'acc_nobody' }), [409, 'not-member']);
    assert.deepEqual(await refused({ site, title: 'A', labels: ['lbl_none'] }), [409, 'unknown-label']);
    assert.equal((await call('GET', '/notes', alice.token)).body.notes.length, 1, 'no refusal wrote a task');

    const off = await acme('off');
    const answer = await off.call('POST', '/notes', off.alice.token, { site: off.site, title: 'A' });
    assert.deepEqual([answer.status, answer.body.error], [403, 'tasks-off']);
  });

  it('lets a guest write in a site shared with them only', async () => {
    const { world, workspace, site, call } = await acme();
    const other = (await world.accounts.addSite(workspace, { origin: 'https://other.acme.dev', visibility: 'members' }))
      .id;
    const gina = await signInTo(world, 'gina@acme.dev');
    await memberOf(world, workspace, gina.id, 'guest');
    await shareWith(world, workspace, gina.id, [other]);

    assert.equal((await call('POST', '/notes', gina.token, { site, title: 'A' })).status, 404);
    assert.equal((await call('POST', '/notes', gina.token, { site: other, title: 'A' })).status, 201);
  });

  it('shows no pin: no read of a page and no list of the extension holds it', async () => {
    const { world, alice, site, extension, call } = await acme();
    const made = await call('POST', '/notes', alice.token, { site, title: 'No pin' });
    assert.equal(made.status, 201);

    const page = await answerOf(
      await callOn(world, 'GET', `/feedback?url=${encodeURIComponent(`${ORIGIN}/pricing`)}&client=${site}`, {
        origin: ORIGIN,
        headers: { Authorization: `Bearer ${extension}` },
      }),
    );
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.deepEqual(
      page.body.issues.map((issue: { note: { id: string } }) => issue.note.id),
      ['sd_1'],
    );
    const panel = await answerOf(
      await callOn(world, 'GET', `/session/notes?site=${site}`, {
        origin: null,
        headers: { Authorization: `Bearer ${extension}` },
      }),
    );
    assert.equal(panel.status, 200, JSON.stringify(panel.body));
    assert.deepEqual(
      panel.body.notes.map((note: { note: string }) => note.note),
      ['sd_1'],
    );
  });

  it('is read by get_note of /mcp as a task, and left out of the notes that list_notes reads', async () => {
    const { world, alice, workspace, site, call } = await acme();
    const made = await call('POST', '/notes', alice.token, { site, title: 'For the agent', text: 'Fix the footer.' });
    const key = await answerOf(
      await callOn(world, 'POST', `/console/workspaces/${workspace}/agent-keys`, {
        token: alice.token,
        body: { name: 'Claude', rights: 'write', sites: [site] },
      }),
    );
    assert.equal(key.status, 201, JSON.stringify(key.body));
    let id = 1;
    const tool = async (name: string, args: Record<string, unknown>) =>
      (
        await answerOf(
          await callOn(world, 'POST', '/mcp', {
            origin: null,
            token: key.body.secret,
            body: { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } },
          }),
        )
      ).body.result;

    const got = await tool('get_note', { id: made.body.id });
    assert.equal(got.structuredContent.task.id, made.body.id);
    assert.equal(got.structuredContent.task.task.text, 'Fix the footer.');
    const notes = await tool('list_notes', { site });
    assert.deepEqual(
      notes.structuredContent.notes.map((note: { note: { id: string } }) => note.note.id),
      ['sd_1'],
    );
    const text = await tool('notes_as_text', { site });
    assert.equal(text.isError ?? false, false);
    // FRU-658: the tasks written by hand come after the pages, under a heading of their own.
    assert.match(
      text.structuredContent.text,
      /# Tasks with no page\n\n## 1\. FB-\d+ — new\n\n- (By|Written): .*\n\n> For the agent\n>\n> Fix the footer\.\n/,
    );
    // A task is in no thread of a page: the tools of a note answer that it is none.
    const reply = await tool('reply_to_note', { id: made.body.id, body: 'On it.' });
    assert.equal(reply.isError, true);
  });
});

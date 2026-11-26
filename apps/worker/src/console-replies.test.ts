import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { resetMemoryLinear } from './linear-memory.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { REPLY_LENGTH } from './reply-text.ts';
import { createPairing, redeemPairing } from './session.ts';
import { type NoteStore, StoreError } from './store.ts';

/**
 * `POST /console/workspaces/<id>/notes/<note>/replies` (FRU-712): a reply under a note, from its panel
 * in the console. Whoever reads the note in the console replies, in the name of their account, and the
 * reply goes the way of a reply of the widget: to the tracker of the note.
 */

const open = worlds();
const ORIGIN = 'https://shop.acme.dev';
const PAGE = `${ORIGIN}/pricing`;

afterEach(() => resetMemoryLinear());

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

/**
 * Alice owns Acme and its site `shop`, which holds one note of hers on `/pricing`: in the Linear in
 * memory (the tracker of the world), or kept by the worker with `kept`. Bob is a member.
 */
async function acme({ kept = false, env = {} }: { kept?: boolean; env?: Record<string, string> } = {}) {
  const world = await open({ env });
  if (kept) world.context.store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  await rowsOf(world.database, `UPDATE "user" SET name = 'Alice Martin' WHERE id = '${alice.id}'`);
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const shop = await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' });
  if (kept) {
    // An address keeps the note in the worker too.
    const rest = (await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' }))
      .id;
    await world.accounts.setDestination(workspace, shop.id, { connector: rest });
  }
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const extension = await sessionOf(world, alice.id, workspace);
  const planted = await callOn(world, 'POST', `/feedback?client=${shop.id}`, {
    origin: ORIGIN,
    token: extension,
    body: noteFixture({
      id: 'sd_one',
      text: 'The price is cut off on a phone.',
      createdAt: new Date().toISOString(),
      page: { url: PAGE, path: '/pricing', title: 'Pricing' },
      client: { id: shop.id, name: shop.id },
    }),
  });
  assert.equal(planted.status, 201, await planted.clone().text());
  const base = `/console/workspaces/${workspace}`;
  const note = noteIdOf(shop.id, 'sd_one');
  const reply = (
    token: string | undefined,
    body: unknown,
    options: { id?: string; origin?: string | null; store?: NoteStore } = {},
  ) =>
    callOn(
      world,
      'POST',
      `${base}/notes/${options.id ?? note}/replies`,
      {
        ...(token === undefined ? {} : { token }),
        body,
        ...(options.origin === undefined ? {} : { origin: options.origin }),
      },
      options.store === undefined ? {} : { store: options.store },
    ).then(answerOf);
  /** The replies of the note, as the widget reads its page: in the tracker, or in the store of the worker. */
  const replies = async (): Promise<any[]> => {
    const read = await callOn(world, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${shop.id}`, {
      origin: ORIGIN,
      token: extension,
    });
    assert.equal(read.status, 200, await read.clone().text());

    return ((await read.json()) as { issues: any[] }).issues[0].comments ?? [];
  };

  return { world, alice, bob, workspace, shop, extension, base, note, reply, replies };
}

describe('a reply from the panel of a note in the console (FRU-712)', () => {
  it('writes the reply of a member in the tracker of the note, named by their account', async () => {
    const { world, alice, base, note, reply, replies } = await acme();

    // A name in the body is not read: the account names the person.
    const written = await reply(alice.token, { body: 'Fixed on staging.\nTry again?', name: 'Somebody else' });
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(
      written.body.comment.body,
      '**Alice Martin** via Fruitback · member of Acme\n\n> Fixed on staging.\n> Try again?',
    );

    // The widget reads it on the page, from the tracker.
    const [comment] = await replies();
    assert.equal(comment.body, written.body.comment.body);
    // And the panel of the console, which reads the note again.
    const panel = await callOn(world, 'GET', `${base}/notes/${note}`, { token: alice.token });
    assert.equal(panel.status, 200);
    const read = (await panel.json()) as { note: { comments: { body: string }[] } };
    assert.deepEqual(
      read.note.comments.map((each) => each.body),
      [written.body.comment.body],
    );
  });

  it('writes it in the store of the worker for a note the worker keeps', async () => {
    const { bob, reply, replies } = await acme({ kept: true });

    const written = await reply(bob.token, { body: 'Seen, on it.' });
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.deepEqual(
      (await replies()).map((each) => each.body),
      ['**bob@acme.dev** via Fruitback · member of Acme\n\n> Seen, on it.'],
    );
  });

  it('takes the reply of a guest on a site shared with them, and answers 404 on any other site', async () => {
    const { world, workspace, shop, reply, replies } = await acme();
    const gina = await signInTo(world, 'gina@acme.dev');
    await memberOf(world, workspace, gina.id, 'guest');
    const other = await world.accounts.addSite(workspace, { origin: 'https://other.acme.dev', visibility: 'members' });

    await shareWith(world, workspace, gina.id, [other.id]);
    assert.equal((await reply(gina.token, { body: 'Hello' })).status, 404);
    assert.equal((await replies()).length, 0);

    await shareWith(world, workspace, gina.id, [shop.id]);
    const written = await reply(gina.token, { body: 'Hello' });
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal((await replies()).length, 1);
  });

  it('refuses whoever is not a person of the console of this workspace, and writes nothing', async () => {
    const { world, alice, extension, reply, replies } = await acme();
    const stranger = await signInTo(world, 'eve@other.dev');
    await workspaceIn(world, stranger.token, 'Other');

    // A visitor: no cookie. A session of the extension is no cookie of the console either.
    assert.equal((await reply(undefined, { body: 'Hi' })).status, 401);
    assert.equal((await reply(extension, { body: 'Hi' })).status, 401);
    // A person of another workspace: as a workspace that does not exist.
    assert.equal((await reply(stranger.token, { body: 'Hi' })).status, 404);
    // The cookie sent by another page of the same site, or by a request with no `Origin`.
    assert.equal((await reply(alice.token, { body: 'Hi' }, { origin: ORIGIN })).status, 403);
    assert.equal((await reply(alice.token, { body: 'Hi' }, { origin: null })).status, 403);
    assert.equal((await replies()).length, 0);
  });

  it('refuses a member who left the workspace, with the cookie they held', async () => {
    const { world, workspace, bob, reply, replies } = await acme();
    await rowsOf(
      world.database,
      `DELETE FROM member WHERE "organizationId" = '${workspace}' AND "userId" = '${bob.id}'`,
    );

    assert.equal((await reply(bob.token, { body: 'Hi' })).status, 404);
    assert.equal((await replies()).length, 0);
  });

  it('takes 1 to 2000 characters, and refuses an empty reply or a longer one, never cut', async () => {
    const { alice, reply, replies } = await acme();

    for (const body of ['', '   ', 'x'.repeat(REPLY_LENGTH + 1), 42, undefined]) {
      const refused = await reply(alice.token, { body });
      assert.equal(refused.status, 400, String(body).slice(0, 10));
      assert.deepEqual(refused.body, { error: 'invalid-reply', maxLength: REPLY_LENGTH });
    }
    assert.equal((await replies()).length, 0);
    assert.equal((await reply(alice.token, { body: 'é'.repeat(REPLY_LENGTH) })).status, 201);
  });

  it('answers 404 for a note that is not one, and 405 to any method but POST', async () => {
    const { world, alice, base, note, shop, reply } = await acme();

    assert.equal((await reply(alice.token, { body: 'Hi' }, { id: noteIdOf(shop.id, 'sd_none') })).status, 404);
    assert.equal((await reply(alice.token, { body: 'Hi' }, { id: 'not-an-id' })).status, 404);
    assert.equal((await callOn(world, 'GET', `${base}/notes/${note}/replies`, { token: alice.token })).status, 405);
  });

  it('answers 403 replies-not-taken when the worker shows no reply, and on a task written by hand', async () => {
    const hidden = await acme({ env: { FRUITBACK_HIDE_COMMENTS: '1' } });
    const refused = await hidden.reply(hidden.alice.token, { body: 'Hi' });
    assert.deepEqual([refused.status, refused.body.error], [403, 'replies-not-taken']);

    const { world, alice, base, shop, reply } = await acme({ kept: true });
    const task = await callOn(world, 'POST', `${base}/notes`, {
      token: alice.token,
      body: { site: shop.id, title: 'Plan' },
    });
    assert.equal(task.status, 201, await task.clone().text());
    const { id } = (await task.json()) as { id: string };
    const onTask = await reply(alice.token, { body: 'Hi' }, { id });
    assert.deepEqual([onTask.status, onTask.body.error], [403, 'replies-not-taken']);
  });

  it('answers 502 when the store does not answer, so the console keeps the text', async () => {
    const { world, alice, reply } = await acme({ kept: true });
    const kept = createPostgresNoteStore(world.database);
    const down: NoteStore = {
      ...kept,
      reply: async () => {
        throw new StoreError('the tracker went away');
      },
    };

    const refused = await reply(alice.token, { body: 'Hi' }, { store: down });
    assert.deepEqual([refused.status, refused.body.error], [502, 'store-unavailable']);
  });
});

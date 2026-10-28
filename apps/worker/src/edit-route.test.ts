import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { NOTE_MAX_LENGTH, NOTE_STAGES } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createMemoryStore } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteStore } from './store.ts';

/**
 * `POST /feedback/<id>/text` (FRU-475): the person who left a note edits its text, while it is `new`
 * and the worker keeps it. Nobody else, and no note of a tracker. A reply says it was edited.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const [NEW, TODO] = NOTE_STAGES;

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

/** Alice owns Acme and its site. Bob and Carol are members. Bob left a note on `PAGE`, kept by the worker. */
async function aNote() {
  const world = await open();
  const store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' })).id;
  const bob = await signInTo(world, 'bob@acme.dev');
  const carol = await signInTo(world, 'carol@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  await memberOf(world, workspace, carol.id, 'member');
  const tokens = {
    alice: await sessionOf(world, alice.id, workspace),
    bob: await sessionOf(world, bob.id, workspace),
    carol: await sessionOf(world, carol.id, workspace),
  };
  const note = noteFixture({
    id: 'ed_1',
    text: 'The price is wrong',
    page: { url: PAGE, path: '/pricing' },
    client: { id: site, name: 'Acme' },
  });
  const planted = await answerOf(
    await callOn(
      world,
      'POST',
      '/feedback',
      { origin: ORIGIN, body: note, headers: { Authorization: `Bearer ${tokens.bob}` } },
      { store },
    ),
  );
  assert.equal(planted.status, 201, JSON.stringify(planted.body));

  return { world, store, workspace, site, tokens, note: planted.body.issue.id as string };
}

function edit(
  world: World,
  site: string,
  note: string,
  text: unknown,
  token: string | undefined,
  store: NoteStore,
): Promise<Answer> {
  return callOn(
    world,
    'POST',
    `/feedback/${note}/text?client=${site}`,
    {
      origin: ORIGIN,
      body: { url: PAGE, text },
      ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
    },
    { store },
  ).then(answerOf);
}

/** The first pin of `PAGE`, as this reader reads it. */
async function pin(world: World, site: string, token: string, store: NoteStore): Promise<Record<string, any>> {
  const answer = await answerOf(
    await callOn(
      world,
      'GET',
      `/feedback?url=${encodeURIComponent(PAGE)}&client=${site}`,
      { origin: ORIGIN, headers: { Authorization: `Bearer ${token}` } },
      { store },
    ),
  );
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  return (answer.body.issues as Record<string, any>[])[0] ?? {};
}

const textOfRow = async (world: World) =>
  (await rowsOf(world.database, 'SELECT payload FROM notes')).map((row) => JSON.parse(String(row.payload)).text);

describe('the text of a note, edited by the person who left it (FRU-475)', () => {
  it('replaces the text, says it was edited in a reply, and the read, the index and the excerpt follow', async () => {
    const { world, store, site, tokens, note } = await aNote();
    assert.equal((await pin(world, site, tokens.bob, store)).editable, true);

    const edited = await edit(world, site, note, '  The price of the Pro plan is wrong  ', tokens.bob, store);

    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    // Trimmed, as the composer sends a note.
    assert.equal(edited.body.note.text, 'The price of the Pro plan is wrong');
    assert.equal(edited.body.note.id, 'ed_1');
    assert.match(edited.body.comment.body, /^\*\*bob@acme\.dev\*\* via Fruitback · member of Acme\nEdited the note$/u);
    assert.deepEqual(await textOfRow(world), ['The price of the Pro plan is wrong']);
    // The read has the new text, and the reply. Nothing of the text of before.
    const read = await pin(world, site, tokens.bob, store);
    assert.equal(read.note.text, 'The price of the Pro plan is wrong');
    assert.equal(read.title.includes('Pro plan'), true, read.title);
    assert.equal(read.comments.length, 1);
    assert.ok(!JSON.stringify(read).includes('The price is wrong'));
    // The list of the console reads the excerpt in the index: it follows at once.
    assert.deepEqual(await rowsOf(world.database, `SELECT excerpt FROM note_index WHERE site_id = '${site}'`), [
      { excerpt: 'The price of the Pro plan is wrong' },
    ]);
  });

  it('is offered to its author only: no other member, and no role that manages the sites', async () => {
    const { world, store, site, tokens } = await aNote();

    assert.equal((await pin(world, site, tokens.carol, store)).editable, undefined);
    assert.equal((await pin(world, site, tokens.alice, store)).editable, undefined);
  });

  it('refuses a member who did not leave the note, the owner, and a request with no session, and changes nothing', async () => {
    const { world, store, site, tokens, note } = await aNote();

    assert.deepEqual(await edit(world, site, note, 'Mine now', tokens.carol, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await edit(world, site, note, 'Mine now', tokens.alice, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await edit(world, site, note, 'Mine now', undefined, store), {
      status: 401,
      body: { error: 'identity-required' },
    });
    assert.deepEqual(await textOfRow(world), ['The price is wrong']);
    assert.deepEqual(await rowsOf(world.database, 'SELECT id FROM note_comments'), []);
  });

  it('refuses an empty text, a text longer than a note, and a value that is no text', async () => {
    const { world, store, site, tokens, note } = await aNote();
    const refused = { status: 400, body: { error: 'invalid-text', maxLength: NOTE_MAX_LENGTH } };

    assert.deepEqual(await edit(world, site, note, '   ', tokens.bob, store), refused);
    assert.deepEqual(await edit(world, site, note, 'a'.repeat(NOTE_MAX_LENGTH + 1), tokens.bob, store), refused);
    assert.deepEqual(await edit(world, site, note, 3, tokens.bob, store), refused);
    assert.deepEqual(await textOfRow(world), ['The price is wrong']);
  });

  it('refuses a note the team moved: no longer offered, and `409 not-new`', async () => {
    const { world, store, site, tokens, note } = await aNote();
    const moved = await callOn(
      world,
      'POST',
      `/feedback/${note}/status?client=${site}`,
      {
        origin: ORIGIN,
        body: { url: PAGE, status: `own:${TODO}` },
        headers: { Authorization: `Bearer ${tokens.alice}` },
      },
      { store },
    );
    assert.equal(moved.status, 200);

    assert.equal((await pin(world, site, tokens.bob, store)).editable, undefined);
    assert.deepEqual(await edit(world, site, note, 'Too late', tokens.bob, store), {
      status: 409,
      body: { error: 'not-new', stage: TODO },
    });
    assert.deepEqual(await textOfRow(world), ['The price is wrong']);
  });

  it('refuses the note of a tracker: the issue is the team’s there, and is not offered', async () => {
    const { world, site, tokens } = await aNote();
    const tracker = createMemoryStore();
    const note = noteFixture({ id: 'ed_2', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
    const planted = await answerOf(
      await callOn(
        world,
        'POST',
        '/feedback',
        { origin: ORIGIN, body: note, headers: { Authorization: `Bearer ${tokens.bob}` } },
        { store: tracker },
      ),
    );
    assert.equal(planted.status, 201);

    assert.equal((await pin(world, site, tokens.bob, tracker)).editable, undefined);
    assert.deepEqual(await edit(world, site, planted.body.issue.id as string, 'Changed', tokens.bob, tracker), {
      status: 403,
      body: { error: 'edits-not-taken' },
    });
  });

  it('answers 404 for a note that is not on the page of the request', async () => {
    const { world, store, site, tokens } = await aNote();

    assert.deepEqual(await edit(world, site, '999', 'Changed', tokens.bob, store), {
      status: 404,
      body: { error: 'not-found' },
    });
  });
});

describe('the edit of a note, written under the lock of its row (FRU-475)', () => {
  it('writes nothing on a note that moved since the route read it, nor on a note of another site', async () => {
    const { world, store, site, note } = await aNote();
    const author = { kind: 'member' as const, name: 'Bob', workspace: 'Acme' };
    const policy = { showComments: true, read: 'authenticated', write: 'public' } as never;
    await rowsOf(world.database, `UPDATE notes SET stage = '${TODO}' RETURNING id`);

    assert.equal(
      await store.edit?.({ issue: note, clientId: site }, { text: 'Late', author }, undefined, policy),
      'not-new',
    );
    await rowsOf(world.database, `UPDATE notes SET stage = '${NEW}' RETURNING id`);
    assert.equal(
      await store.edit?.({ issue: note, clientId: 'another-site' }, { text: 'Elsewhere', author }, undefined, policy),
      undefined,
    );
    assert.deepEqual(await textOfRow(world), ['The price is wrong']);
    assert.deepEqual(await rowsOf(world.database, 'SELECT id FROM note_comments'), []);
  });
});

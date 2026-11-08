import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { NOTE_STAGES } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createMemoryStore } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import { type NoteStore, StoreError } from './store.ts';

/**
 * `POST /feedback/<id>/withdraw` (FRU-605): the person who left an open note withdraws it. It goes to
 * `closed`, with a reply that says so, and nothing is deleted. Nobody else, and no note done or closed.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const [, TODO, PROGRESS, DONE, CLOSED] = NOTE_STAGES;

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

/** Alice owns Acme and its site. Bob and Carol are members. Bob left a note on `PAGE`. */
async function aNote(store?: NoteStore) {
  const world = await open();
  const kept = store ?? createPostgresNoteStore(world.database);
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
    id: 'wd_1',
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
      { store: kept },
    ),
  );
  assert.equal(planted.status, 201, JSON.stringify(planted.body));

  return { world, store: kept, workspace, site, tokens, note: planted.body.issue.id as string };
}

function withdraw(world: World, site: string, note: string, token: string | undefined, store: NoteStore) {
  return callOn(
    world,
    'POST',
    `/feedback/${note}/withdraw?client=${site}`,
    {
      origin: ORIGIN,
      body: { url: PAGE },
      ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
    },
    { store },
  ).then(answerOf);
}

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

function moveTo(world: World, site: string, note: string, stage: string, token: string, store: NoteStore) {
  return callOn(
    world,
    'POST',
    `/feedback/${note}/status?client=${site}`,
    { origin: ORIGIN, body: { url: PAGE, status: `own:${stage}` }, headers: { Authorization: `Bearer ${token}` } },
    { store },
  );
}

const rowsOfNotes = (world: World) => rowsOf(world.database, 'SELECT stage, payload FROM notes');

describe('a note withdrawn by the person who left it (FRU-605)', () => {
  it('closes the note, says who withdrew it in a reply, deletes nothing, and the read and the index follow', async () => {
    const { world, store, site, tokens, note } = await aNote();
    assert.equal((await pin(world, site, tokens.bob, store)).withdrawable, true);

    const withdrawn = await withdraw(world, site, note, tokens.bob, store);

    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.stage, CLOSED);
    assert.match(
      withdrawn.body.comment.body,
      /^\*\*bob@acme\.dev\*\* via Fruitback · member of Acme\nWithdrew the note$/u,
    );
    const rows = await rowsOfNotes(world);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.stage, CLOSED);
    assert.equal(JSON.parse(String(rows[0]?.payload)).text, 'The price is wrong');
    const read = await pin(world, site, tokens.bob, store);
    assert.equal(read.stage, CLOSED);
    assert.equal(read.withdrawable, undefined);
    assert.equal(read.editable, undefined);
    assert.deepEqual(await rowsOf(world.database, `SELECT stage FROM note_index WHERE site_id = '${site}'`), [
      { stage: CLOSED },
    ]);
  });

  it('takes a note the team took, at todo and at progress', async () => {
    for (const stage of [TODO, PROGRESS]) {
      const { world, store, site, tokens, note } = await aNote();
      assert.equal((await moveTo(world, site, note, stage, tokens.alice, store)).status, 200);
      assert.equal((await withdraw(world, site, note, tokens.bob, store)).status, 200, stage);
    }
  });

  it('refuses a note done or closed: not offered, and `409 not-open`', async () => {
    const { world, store, site, tokens, note } = await aNote();
    for (const stage of [DONE, CLOSED]) {
      assert.equal((await moveTo(world, site, note, stage, tokens.alice, store)).status, 200);
      assert.equal((await pin(world, site, tokens.bob, store)).withdrawable, undefined, stage);
      assert.deepEqual(await withdraw(world, site, note, tokens.bob, store), {
        status: 409,
        body: { error: 'not-open', stage },
      });
    }
    assert.deepEqual(await rowsOf(world.database, 'SELECT id FROM note_comments'), []);
  });

  it('refuses a member who did not leave the note, the owner, and no session, and changes nothing', async () => {
    const { world, store, site, tokens, note } = await aNote();

    assert.equal((await pin(world, site, tokens.carol, store)).withdrawable, undefined);
    assert.deepEqual(await withdraw(world, site, note, tokens.carol, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await withdraw(world, site, note, tokens.alice, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await withdraw(world, site, note, undefined, store), {
      status: 401,
      body: { error: 'identity-required' },
    });
    assert.equal((await rowsOfNotes(world))[0]?.stage, 'new');
  });

  it('writes one withdrawal for a double click: the second waits for the first', async () => {
    const { world, store, site, tokens, note } = await aNote();
    let release: () => void = () => {};
    const slow: NoteStore = {
      ...store,
      withdraw: async (...args) => {
        await new Promise<void>((resolve) => (release = resolve));

        return (store.withdraw as NonNullable<NoteStore['withdraw']>)(...args);
      },
    };

    const first = withdraw(world, site, note, tokens.bob, slow);
    // The first holds the key; the second is refused while it is written.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await withdraw(world, site, note, tokens.bob, slow);
    release();

    assert.deepEqual(second, { status: 409, body: { error: 'withdraw-in-progress' } });
    assert.equal((await first).status, 200);
    assert.equal((await rowsOf(world.database, 'SELECT id FROM note_comments')).length, 1);
  });

  it('takes a new try at once after a withdrawal that failed: the key is let go (review of #870)', async () => {
    const { world, store, site, tokens, note } = await aNote();
    let calls = 0;
    const once: NoteStore = {
      ...store,
      withdraw: async (...args) => {
        calls += 1;
        if (calls === 1) throw new StoreError('the tracker did not answer');

        return (store.withdraw as NonNullable<NoteStore['withdraw']>)(...args);
      },
    };

    assert.deepEqual(await withdraw(world, site, note, tokens.bob, once), {
      status: 502,
      body: { error: 'store-unavailable' },
    });
    // No wait: `kv.set(lock, '0', 1)` puts the count back at 0, for 1 ms (`ttlMs`, kv.ts).
    assert.equal((await withdraw(world, site, note, tokens.bob, once)).status, 200);
    assert.equal(calls, 2);
  });

  it('cancels the issue of a tracker after the reply, and its description stays', async () => {
    const tracker = createMemoryStore();
    const { world, site, tokens, note } = await aNote(tracker);

    const withdrawn = await withdraw(world, site, note, tokens.bob, tracker);

    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.stage, CLOSED);
    const read = await pin(world, site, tokens.carol, tracker);
    assert.equal(read.stage, CLOSED);
    assert.equal(read.stateName, 'Canceled');
    assert.equal(read.note.text, 'The price is wrong');
  });

  it('writes nothing under the lock on a note marked done since the route read it', async () => {
    const { world, store, site, note } = await aNote();
    const author = { kind: 'member' as const, name: 'Bob', workspace: 'Acme' };
    await rowsOf(world.database, `UPDATE notes SET stage = '${DONE}' RETURNING id`);

    assert.equal(
      await store.withdraw?.(
        { issue: note, clientId: site },
        { author, note: noteFixture(), identifier: 'FB-1' },
        undefined,
        { showComments: true, read: 'authenticated', write: 'public' } as never,
      ),
      'not-open',
    );
    assert.equal((await rowsOfNotes(world))[0]?.stage, DONE);
  });
});

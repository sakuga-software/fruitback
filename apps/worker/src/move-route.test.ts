import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { NOTE_STAGES } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createMemoryStore } from './linear-memory.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteStore } from './store.ts';
import { MOVE_LOCK_MS } from './edit-routes.ts';
import { KvError } from './kv.ts';

/**
 * `POST /feedback/<id>/place` (FRU-605): the person who left an open note moves it to another element
 * of its page. Its anchor and viewport change, with a reply that says so. Nobody else, and no note
 * done or closed.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const [, , PROGRESS, DONE, CLOSED] = NOTE_STAGES;

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
async function aNote(store?: NoteStore, env: Record<string, string> = {}) {
  const world = await open({ env });
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
    id: 'mv_1',
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

const ANCHOR = {
  selector: '[data-testid="card-latte"] .add',
  tag: 'button',
  text: 'Ajouter',
  bounds: { xPct: 40, yPct: 20, wPct: 10, hPct: 4 },
};
const VIEWPORT = { width: 390, height: 844, dpr: 3 };

function move(
  world: World,
  site: string,
  note: string,
  token: string | undefined,
  store: NoteStore,
  place: Record<string, unknown> = { anchor: ANCHOR, viewport: VIEWPORT },
) {
  return callOn(
    world,
    'POST',
    `/feedback/${note}/place?client=${site}`,
    {
      origin: ORIGIN,
      body: { url: PAGE, ...place },
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

describe('a note moved by the person who left it (FRU-605)', () => {
  it('puts the note on its new element, says so in a reply, and the read follows', async () => {
    const { world, store, site, tokens, note } = await aNote();

    const moved = await move(world, site, note, tokens.bob, store);

    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(moved.body.note.anchor, ANCHOR);
    assert.deepEqual(moved.body.note.viewport, VIEWPORT);
    assert.equal(moved.body.note.text, 'The price is wrong');
    assert.equal(
      moved.body.comment.body,
      '**bob@acme.dev** via Fruitback · member of Acme\nMoved the note\n\n> [data-testid="card-latte"] .add',
    );
    const kept = JSON.parse(String((await rowsOfNotes(world))[0]?.payload));
    assert.deepEqual(kept.anchor, ANCHOR);
    const read = await pin(world, site, tokens.carol, store);
    assert.deepEqual(read.note.anchor, ANCHOR);
  });

  it('takes a note the team took, and refuses a note done or closed with `409 not-open`', async () => {
    const { world, store, site, tokens, note } = await aNote();
    assert.equal((await moveTo(world, site, note, PROGRESS, tokens.alice, store)).status, 200);
    assert.equal((await move(world, site, note, tokens.bob, store)).status, 200);
    for (const stage of [DONE, CLOSED]) {
      assert.equal((await moveTo(world, site, note, stage, tokens.alice, store)).status, 200);
      assert.deepEqual(await move(world, site, note, tokens.bob, store), {
        status: 409,
        body: { error: 'not-open', stage },
      });
    }
  });

  it('refuses another member, the owner, no session, and a place that is no place', async () => {
    const { world, store, site, tokens, note } = await aNote();

    assert.deepEqual(await move(world, site, note, tokens.carol, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await move(world, site, note, tokens.alice, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await move(world, site, note, undefined, store), {
      status: 401,
      body: { error: 'identity-required' },
    });
    for (const place of [{}, { anchor: { selector: '' }, viewport: VIEWPORT }, { anchor: ANCHOR, viewport: 'wide' }]) {
      assert.deepEqual(await move(world, site, note, tokens.bob, store, place), {
        status: 400,
        body: { error: 'invalid-place' },
      });
    }
    assert.deepEqual(await rowsOf(world.database, 'SELECT id FROM note_comments'), []);
  });

  it('writes one move for a double click: the second waits for the first, and a new try is taken after (review of #877)', async () => {
    const { world, store, site, tokens, note } = await aNote();
    let release: () => void = () => {};
    const slow: NoteStore = {
      ...store,
      move: async (...args) => {
        await new Promise<void>((resolve) => (release = resolve));

        return (store.move as NonNullable<NoteStore['move']>)(...args);
      },
    };

    const first = move(world, site, note, tokens.bob, slow);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await move(world, site, note, tokens.bob, slow), {
      status: 409,
      body: { error: 'move-in-progress' },
    });
    release();
    assert.equal((await first).status, 200);
    assert.equal((await rowsOf(world.database, 'SELECT id FROM note_comments')).length, 1);
    // The key is let go: the next move is taken at once.
    assert.equal((await move(world, site, note, tokens.bob, store)).status, 200);
  });

  it('lets go of its key when the store of keys fails once, and takes the next move (review of #877)', async () => {
    const { world, store, site, tokens, note } = await aNote();
    const kv = world.kv;
    const set = kv.set.bind(kv);
    let failures = 1;
    kv.set = async (...args) => {
      if (args[1] === '0' && failures > 0) {
        failures -= 1;
        throw new KvError('the store of keys blinked');
      }

      return set(...args);
    };
    try {
      assert.equal((await move(world, site, note, tokens.bob, store)).status, 200);
      assert.equal((await move(world, site, note, tokens.bob, store)).status, 200);
    } finally {
      kv.set = set;
    }
  });

  it('holds a move longer than a call to a tracker can last (review of #877)', () => {
    // undici, under `fetch` of Node, gives up after 300 s with no headers, and 300 s with no body.
    assert.ok(MOVE_LOCK_MS > 2 * 300_000, String(MOVE_LOCK_MS));
  });

  it('refuses a move of a note of a tracker where the replies are hidden: a read would show the place of before (review of #877)', async () => {
    const tracker = createMemoryStore();
    const { world, site, tokens, note } = await aNote(tracker, { FRUITBACK_HIDE_COMMENTS: '1' });

    assert.equal((await pin(world, site, tokens.bob, tracker)).editable, undefined);
    assert.deepEqual(await move(world, site, note, tokens.bob, tracker), {
      status: 403,
      body: { error: 'edits-not-taken' },
    });
  });

  it('writes the place in a reply of a tracker, keeps its description, and a read takes the place', async () => {
    const tracker = createMemoryStore();
    const { world, site, tokens, note } = await aNote(tracker);
    const before = (await pin(world, site, tokens.carol, tracker)).note.anchor;

    const moved = await move(world, site, note, tokens.bob, tracker);

    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const kept = await tracker.findForPage({ url: PAGE, clientId: site }, undefined, { showComments: false } as never);
    assert.deepEqual(kept[0]?.note.anchor, before);
    assert.deepEqual((await pin(world, site, tokens.carol, tracker)).note.anchor, ANCHOR);
  });
});

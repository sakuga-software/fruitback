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

/**
 * `POST /feedback/<id>/status` (FRU-367): the status of a note that the worker keeps. The person who
 * left the note, or a role that manages the sites, as for a verdict (FRU-294). The note takes the stage
 * of its status, in the store and in the index of the notes.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const [NEW, TODO, , DONE] = NOTE_STAGES;

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
 * Alice owns Acme and its site. Bob and Carol are members. Bob left a note on `PAGE`, kept by the
 * worker. The site has a status the team added, « Waiting », and a hidden one.
 */
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
  const team = { name: null, color: null, textColor: null, position: 0, origin: 'team' as const, hidden: false };
  await world.accounts.putSiteStatus(workspace, site, { source: 'own', key: 'waiting', stage: TODO as never, ...team });
  await world.accounts.putSiteStatus(workspace, site, {
    source: 'own',
    key: 'parked',
    stage: TODO as never,
    ...team,
    hidden: true,
  });
  const seed = noteFixture({ id: 'sd_1', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
  const planted = await answerOf(
    await callOn(
      world,
      'POST',
      '/feedback',
      { origin: ORIGIN, body: seed, headers: { Authorization: `Bearer ${tokens.bob}` } },
      { store },
    ),
  );
  assert.equal(planted.status, 201, JSON.stringify(planted.body));

  return { world, store, workspace, site, tokens, note: planted.body.issue.id as string };
}

function setStatus(
  world: World,
  site: string,
  note: string,
  status: unknown,
  token: string | undefined,
  store: NoteStore,
): Promise<Answer> {
  return callOn(
    world,
    'POST',
    `/feedback/${note}/status?client=${site}`,
    {
      origin: ORIGIN,
      body: { url: PAGE, status },
      ...(token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } }),
    },
    { store },
  ).then(answerOf);
}

async function pin(world: World, site: string, token: string, store: NoteStore) {
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
  const [issue] = answer.body.issues as Record<string, any>[];

  return [issue?.stage, issue?.status];
}

describe('the status of a note that the worker keeps (FRU-367)', () => {
  it('lets the person who left the note put it in a status the team added, and the note takes its stage', async () => {
    const { world, store, site, tokens, note } = await aNote();

    const set = await setStatus(world, site, note, 'own:waiting', tokens.bob, store);

    assert.deepEqual(set, { status: 200, body: { status: 'own:waiting', stage: TODO } });
    // The list and the counts of the console read the index: it has the stage at once,
    // before any read of the page could teach it.
    assert.deepEqual(await rowsOf(world.database, `SELECT stage FROM note_index WHERE site_id = '${site}'`), [
      { stage: TODO },
    ]);
    assert.deepEqual(await pin(world, site, tokens.bob, store), [TODO, 'own:waiting']);
    assert.deepEqual(await rowsOf(world.database, `SELECT stage, status_key FROM seeds`), [
      { stage: TODO, status_key: 'waiting' },
    ]);
  });

  it('lets a role that manages the sites put the note of somebody else in a built-in status', async () => {
    const { world, store, site, tokens, note } = await aNote();
    await setStatus(world, site, note, 'own:waiting', tokens.bob, store);

    const set = await setStatus(world, site, note, `own:${DONE}`, tokens.alice, store);

    assert.deepEqual(set, { status: 200, body: { status: `own:${DONE}`, stage: DONE } });
    // A built-in status is no key of its own: the note is in the status of its stage.
    assert.deepEqual(await rowsOf(world.database, `SELECT stage, status_key FROM seeds`), [
      { stage: DONE, status_key: null },
    ]);
    assert.deepEqual(await pin(world, site, tokens.alice, store), [DONE, `own:${DONE}`]);
  });

  it('refuses a member who did not leave the note, and a request with no session, and changes nothing', async () => {
    const { world, store, site, tokens, note } = await aNote();

    assert.deepEqual(await setStatus(world, site, note, 'own:waiting', tokens.carol, store), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await setStatus(world, site, note, 'own:waiting', undefined, store), {
      status: 401,
      body: { error: 'identity-required' },
    });
    assert.deepEqual(await rowsOf(world.database, `SELECT stage, status_key FROM seeds`), [
      { stage: NEW, status_key: null },
    ]);
  });

  it('refuses a status the site does not have, a hidden one, one of a tracker, and a value that is no status', async () => {
    const { world, store, site, tokens, note } = await aNote();
    const refused = (status: unknown) => setStatus(world, site, note, status, tokens.bob, store);

    assert.deepEqual(await refused('own:gone'), { status: 400, body: { error: 'unknown-status' } });
    assert.deepEqual(await refused('own:parked'), { status: 409, body: { error: 'status-hidden' } });
    assert.deepEqual(await refused('con_linear:st_1'), { status: 400, body: { error: 'not-own' } });
    assert.deepEqual(await refused('own:in review'), { status: 400, body: { error: 'invalid-status' } });
    assert.deepEqual(await refused(3), { status: 400, body: { error: 'invalid-status' } });
    assert.deepEqual(await rowsOf(world.database, `SELECT stage, status_key FROM seeds`), [
      { stage: NEW, status_key: null },
    ]);
  });

  it('refuses the note of a tracker: its status changes in the tracker', async () => {
    const { world, site, tokens } = await aNote();
    const tracker = createMemoryStore();
    const seed = noteFixture({ id: 'sd_2', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
    const planted = await answerOf(
      await callOn(
        world,
        'POST',
        '/feedback',
        { origin: ORIGIN, body: seed, headers: { Authorization: `Bearer ${tokens.bob}` } },
        { store: tracker },
      ),
    );

    assert.deepEqual(
      await setStatus(world, site, planted.body.issue.id as string, 'own:waiting', tokens.bob, tracker),
      {
        status: 403,
        body: { error: 'statuses-not-taken' },
      },
    );
  });

  it('keeps the effect of « Still wrong »: the note goes back to the first stage, in its built-in status', async () => {
    const { world, store, workspace, site, tokens, note } = await aNote();
    await world.accounts.putSiteStatus(workspace, site, {
      source: 'own',
      key: 'shipped',
      name: null,
      stage: DONE as never,
      color: null,
      textColor: null,
      position: 1,
      origin: 'team',
      hidden: false,
    });
    assert.equal((await setStatus(world, site, note, 'own:shipped', tokens.bob, store)).status, 200);

    const wrong = await answerOf(
      await callOn(
        world,
        'POST',
        `/feedback/${note}/check?client=${site}`,
        { origin: ORIGIN, body: { url: PAGE, verdict: 'wrong' }, headers: { Authorization: `Bearer ${tokens.bob}` } },
        { store },
      ),
    );

    assert.equal(wrong.status, 201, JSON.stringify(wrong.body));
    assert.deepEqual(await rowsOf(world.database, `SELECT stage, status_key FROM seeds`), [
      { stage: NEW, status_key: null },
    ]);
    assert.deepEqual(await pin(world, site, tokens.bob, store), [NEW, `own:${NEW}`]);
  });
});

describe('the status of a note, written under the lock of its site (FRU-367, heavy review of #492)', () => {
  it('writes nothing for a status removed or hidden since the route read it, and takes the stage of the row now', async () => {
    const { world, store, workspace, site, note } = await aNote();
    const target = { issue: note, clientId: site };
    const before = () => rowsOf(world.database, `SELECT stage, status_key FROM seeds`);

    // Removed by the console after the route read it: the route still holds what it read.
    assert.equal(await store.setStatus?.(target, { key: 'gone', stage: TODO as never }, undefined), 'status-changed');
    // Hidden after the route read it.
    assert.equal(await store.setStatus?.(target, { key: 'parked', stage: TODO as never }, undefined), 'status-changed');
    assert.deepEqual(await before(), [{ stage: NEW, status_key: null }]);

    // Moved to another stage after the route read it: the note takes the stage of the row, not the
    // one the route read, so its status and its stage agree.
    const team = { name: null, color: null, textColor: null, position: 0, origin: 'team' as const, hidden: false };
    await world.accounts.putSiteStatus(workspace, site, {
      source: 'own',
      key: 'waiting',
      stage: DONE as never,
      ...team,
    });
    const set = await store.setStatus?.(target, { key: 'waiting', stage: TODO as never }, undefined);
    assert.deepEqual(set, { stage: DONE, page: PAGE });
    assert.deepEqual(await before(), [{ stage: DONE, status_key: 'waiting' }]);
  });
});

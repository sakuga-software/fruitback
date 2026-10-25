import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { DEFAULT_NOTE_STAGE, NOTE_STAGES } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { noteIdOf } from './console-notes.ts';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { createPairing, redeemPairing } from './session.ts';
import type { NoteStore } from './store.ts';

/**
 * `POST /console/workspaces/<id>/notes/<note>/status` (FRU-384): the status of a note the worker keeps,
 * chosen in the list of the notes of the console. The route of the extension (FRU-367) asks for a
 * session of the extension; the console has a cookie. Same rights: the author of the note, or a role
 * that manages the sites. The list says, note by note, who may.
 */

const open = worlds();
const ORIGIN = 'https://acme.dev';
const PAGE = 'https://acme.dev/pricing';
const [, TODO, , DONE] = NOTE_STAGES;

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
 * Alice owns Acme and its site. Bob and Carol are members, Gina a guest of another site of Acme. Bob
 * left a note on `PAGE`, kept by the worker. The site has a status the team added, « Waiting », and a
 * hidden one, « Parked ».
 */
async function aNote(options: { rest?: boolean } = {}) {
  const world = await open();
  const store = createPostgresNoteStore(world.database);
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const site = (await world.accounts.addSite(workspace, { origin: ORIGIN, visibility: 'members' })).id;
  const other = (await world.accounts.addSite(workspace, { origin: 'https://other.acme.dev', visibility: 'members' }))
    .id;
  const bob = await signInTo(world, 'bob@acme.dev');
  const carol = await signInTo(world, 'carol@acme.dev');
  const gina = await signInTo(world, 'gina@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  await memberOf(world, workspace, carol.id, 'member');
  await memberOf(world, workspace, gina.id, 'guest');
  await shareWith(world, workspace, gina.id, [other]);
  const team = { name: null, color: null, textColor: null, position: 0, origin: 'team' as const, hidden: false };
  await world.accounts.putSiteStatus(workspace, site, {
    source: 'own',
    key: 'waiting',
    stage: TODO as never,
    ...team,
    name: 'Waiting',
    color: '#2563eb',
  });
  await world.accounts.putSiteStatus(workspace, site, {
    source: 'own',
    key: 'parked',
    stage: TODO as never,
    ...team,
    name: 'Parked',
    position: 1,
    hidden: true,
  });
  // A site that sends its notes on to an address: the worker keeps them too (FRU-367).
  const rest = options.rest
    ? (await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.dev', sealed: 'x' })).id
    : undefined;
  if (rest !== undefined) await world.accounts.setDestination(workspace, site, { connector: rest });
  const seed = noteFixture({ id: 'sd_1', page: { url: PAGE, path: '/pricing' }, client: { id: site, name: 'Acme' } });
  const extension = await sessionOf(world, bob.id, workspace);
  const planted = await answerOf(
    await callOn(
      world,
      'POST',
      '/feedback',
      { origin: ORIGIN, body: seed, headers: { Authorization: `Bearer ${extension}` } },
      { store },
    ),
  );
  assert.equal(planted.status, 201, JSON.stringify(planted.body));

  return {
    world,
    store,
    workspace,
    site,
    other,
    alice,
    bob,
    carol,
    gina,
    extension,
    rest,
    note: noteIdOf(site, 'sd_1'),
  };
}

function choose(world: World, workspace: string, note: string, status: unknown, token: string): Promise<Answer> {
  return callOn(world, 'POST', `/console/workspaces/${workspace}/notes/${note}/status`, {
    token,
    body: { status },
  }).then(answerOf);
}

async function listed(world: World, workspace: string, token: string) {
  const answer = await answerOf(await callOn(world, 'GET', `/console/workspaces/${workspace}/notes`, { token }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body));

  return answer.body as { notes: Record<string, any>[]; statuses?: Record<string, Record<string, any>[]> };
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

const stored = (world: World) => rowsOf(world.database, 'SELECT stage, status_key FROM notes');
const indexed = (world: World, site: string) =>
  rowsOf(world.database, `SELECT stage FROM note_index WHERE site_id = '${site}'`);

describe('the status of a note, chosen in the console (FRU-384)', () => {
  it('lists the status of a kept note, who may change it, and the statuses of its site', async () => {
    const { world, workspace, site, alice, bob, carol } = await aNote();

    const [mine] = (await listed(world, workspace, bob.token)).notes;
    assert.equal(mine?.status, `own:${DEFAULT_NOTE_STAGE}`);
    assert.equal(mine?.canSetStatus, true, 'the author may');
    assert.equal((await listed(world, workspace, carol.token)).notes[0]?.canSetStatus, false, 'another member may not');
    const managed = await listed(world, workspace, alice.token);
    assert.equal(managed.notes[0]?.canSetStatus, true, 'a role that manages the sites may');

    const statuses = managed.statuses?.[site] ?? [];
    assert.deepEqual(
      statuses.map((one) => one.key),
      ['own:waiting', 'own:parked', ...NOTE_STAGES.map((stage) => `own:${stage}`)],
    );
    assert.deepEqual(statuses[0], {
      key: 'own:waiting',
      name: 'Waiting',
      stage: TODO,
      color: '#2563eb',
      textColor: statuses[0]?.textColor,
    });
    // A hidden status names the notes in it, and is never offered: the list says which it is.
    assert.equal(statuses[1]?.hidden, true);
  });

  it('lets the author put the note in a status the team added: the store, the index and the pin follow', async () => {
    const { world, store, workspace, site, bob, extension, note } = await aNote();
    // A read of the page first: the cache now holds it, and must not answer it again.
    assert.deepEqual(await pin(world, site, extension, store), [DEFAULT_NOTE_STAGE, `own:${DEFAULT_NOTE_STAGE}`]);

    const set = await choose(world, workspace, note, 'own:waiting', bob.token);

    assert.deepEqual(set, { status: 200, body: { status: 'own:waiting', stage: TODO } });
    assert.deepEqual(await stored(world), [{ stage: TODO, status_key: 'waiting' }]);
    assert.deepEqual(await indexed(world, site), [{ stage: TODO }]);
    assert.deepEqual(await pin(world, site, extension, store), [TODO, 'own:waiting']);
    const [listedNote] = (await listed(world, workspace, bob.token)).notes;
    assert.equal(listedNote?.status, 'own:waiting');
    assert.equal(listedNote?.stage, TODO);
  });

  it('lets a role that manages the sites put the note of somebody else in a built-in status', async () => {
    const { world, workspace, site, alice, bob, note } = await aNote();
    await choose(world, workspace, note, 'own:waiting', bob.token);

    const set = await choose(world, workspace, note, `own:${DONE}`, alice.token);

    assert.deepEqual(set, { status: 200, body: { status: `own:${DONE}`, stage: DONE } });
    // A built-in status writes no key.
    assert.deepEqual(await stored(world), [{ stage: DONE, status_key: null }]);
    assert.deepEqual(await indexed(world, site), [{ stage: DONE }]);
  });

  it('refuses a member who did not write the note, and writes nothing', async () => {
    const { world, workspace, carol, note } = await aNote();

    assert.deepEqual(await choose(world, workspace, note, 'own:waiting', carol.token), {
      status: 403,
      body: { error: 'not-allowed' },
    });
    assert.deepEqual(await stored(world), [{ stage: DEFAULT_NOTE_STAGE, status_key: null }]);
  });

  it('refuses a hidden status, and one the site no longer has, with the conflict the console says', async () => {
    const { world, workspace, alice, note } = await aNote();

    assert.deepEqual(await choose(world, workspace, note, 'own:parked', alice.token), {
      status: 409,
      body: { error: 'status-hidden' },
    });
    assert.deepEqual(await choose(world, workspace, note, 'own:gone', alice.token), {
      status: 409,
      body: { error: 'status-changed' },
    });
    assert.deepEqual(await stored(world), [{ stage: DEFAULT_NOTE_STAGE, status_key: null }]);
  });

  it('refuses a status that is not of the worker, or not a status, and any method but POST', async () => {
    const { world, workspace, alice, note } = await aNote();

    assert.deepEqual(await choose(world, workspace, note, 'linear:abc', alice.token), {
      status: 400,
      body: { error: 'not-own' },
    });
    for (const status of [undefined, 3, 'own:', 'own:Not A Key']) {
      assert.deepEqual(await choose(world, workspace, note, status, alice.token), {
        status: 400,
        body: { error: 'invalid-status' },
      });
    }
    const path = `/console/workspaces/${workspace}/notes/${note}/status`;
    assert.equal((await callOn(world, 'GET', path, { token: alice.token })).status, 405);
    assert.deepEqual(await stored(world), [{ stage: DEFAULT_NOTE_STAGE, status_key: null }]);
  });

  it('takes the note of a site that sends to an address: the worker keeps it too (heavy review of #505)', async () => {
    const { world, workspace, bob, rest, note } = await aNote({ rest: true });
    // The index says where the note went: the connector of the address, as `FB-<id>`.
    assert.deepEqual(
      await rowsOf(world.database, `SELECT place, connector_id, reference LIKE 'FB-%' AS kept FROM note_index`),
      [{ place: 'connector', connector_id: rest, kept: true }],
    );

    const [listedNote] = (await listed(world, workspace, bob.token)).notes;
    assert.equal(listedNote?.status, `own:${DEFAULT_NOTE_STAGE}`);
    assert.equal(listedNote?.canSetStatus, true);
    assert.deepEqual(await choose(world, workspace, note, 'own:waiting', bob.token), {
      status: 200,
      body: { status: 'own:waiting', stage: TODO },
    });
    assert.deepEqual(await stored(world), [{ stage: TODO, status_key: 'waiting' }]);
  });

  it('leaves to its tracker a note it named FB-<n>, the number of another note of the site', async () => {
    // A tracker, and an address whose issue would name a row of the worker that is another note.
    for (const kind of ['linear', 'rest'] as const) {
      const { world, workspace, site, alice } = await aNote();
      const index = createPostgresNoteIndex(world.database);
      const [{ id }] = (await rowsOf(world.database, 'SELECT id FROM notes')) as [{ id: number }];
      const connector = await world.accounts.addConnector(workspace, { kind, label: 'Elsewhere', sealed: 'x' });
      await index.record(
        [
          {
            workspace,
            site,
            seed: noteFixture({ id: 'sd_2', page: { url: PAGE, path: '/pricing' } }),
            channel: 'extension',
            author: { kind: 'member', account: alice.id },
            place: { kind: 'connector', connector: connector.id },
            // The number of the note the worker keeps: a tracker can name an issue so.
            issue: { identifier: `FB-${id}` },
            stage: DEFAULT_NOTE_STAGE,
          },
        ],
        Date.now() + 1_000,
      );

      const other = noteIdOf(site, 'sd_2');
      const tracked = (await listed(world, workspace, alice.token)).notes.find((one) => one.id === other);
      assert.ok(tracked !== undefined);
      assert.equal(tracked.status, undefined);
      assert.equal(tracked.canSetStatus, undefined);
      assert.deepEqual(
        await choose(world, workspace, other, 'own:waiting', alice.token),
        {
          status: 403,
          body: { error: 'statuses-not-taken' },
        },
        kind,
      );
      assert.deepEqual(await stored(world), [{ stage: DEFAULT_NOTE_STAGE, status_key: null }]);
    }
  });

  it('answers 404 for a note of a site the caller does not read, or of another workspace', async () => {
    const { world, workspace, site, alice, gina, note } = await aNote();

    // Gina is a guest of the other site only.
    assert.deepEqual(await choose(world, workspace, note, 'own:waiting', gina.token), {
      status: 404,
      body: { error: 'not-found' },
    });
    const zed = await signInTo(world, 'zed@other.dev');
    const elsewhere = await workspaceIn(world, zed.token, 'Other');
    assert.deepEqual(await choose(world, elsewhere, note, 'own:waiting', zed.token), {
      status: 404,
      body: { error: 'not-found' },
    });
    assert.deepEqual(await choose(world, workspace, noteIdOf(site, 'sd_404'), 'own:waiting', alice.token), {
      status: 404,
      body: { error: 'not-found' },
    });
    assert.deepEqual(await stored(world), [{ stage: DEFAULT_NOTE_STAGE, status_key: null }]);
  });
});

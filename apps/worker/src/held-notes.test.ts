import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { type World, callOn, memberOf, signInTo } from './console-world.fixture.ts';
import { HELD_NOTE_KEEP_MS } from './held-notes.ts';
import { createPostgresHeldNotes } from './held-notes-postgres.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { type NoteStore, StoreError } from './store.ts';
import { type Handle, KEY_A, KEY_B, ORIGIN, aVisitorSite } from './visitor-site.fixture.ts';

/**
 * « Hold new visitor notes » of the card « Safeguards » (FRU-704). On a site that says it, `POST
 * /feedback` keeps a note of a visitor with no token in `held_notes` and answers `202`; the tracker
 * gets nothing. A member reads the queue « To approve » in the console, and approves a note (it goes
 * to its place, as it would have gone at once) or rejects it (it goes). Each case goes through
 * `handleRequest`, on PostgreSQL (PGlite).
 */

const notesInStore = async (world: World) =>
  Number((await rowsOf(world.database, 'SELECT count(*) AS count FROM notes'))[0]?.count);

/** A site that holds the notes of its visitors, and the console of its owner. */
async function aHoldingSite(options: Parameters<typeof aVisitorSite>[0] = {}) {
  const site = await aVisitorSite(options);
  await rowsOf(site.world.database, `UPDATE sites SET hold_visitor_notes = true WHERE id = '${site.site}'`);
  const alice = await signInTo(site.world, 'alice@acme.dev');
  const base = `/console/workspaces/${site.workspace}/held`;
  /** A call of the console, through the same store as the page: the note goes where the page sends it. */
  const consoleCall = async (method: string, path: string, token = alice.token, store: NoteStore = site.store) => {
    const response = await callOn(site.world, method, `${base}${path}`, { token }, { store });
    const text = await response.text();

    return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, any>) };
  };

  return { ...site, alice, consoleCall };
}

describe('the notes of visitors that wait for a member (FRU-704)', () => {
  it('keeps a note of a visitor out of the tracker, answers 202, and shows it in the queue « To approve »', async () => {
    const { world, call, noteOf, read, consoleCall } = await aHoldingSite();

    const sent = await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_1', 'The price is wrong.', 'Camille'));

    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.deepEqual(sent.body, { held: true, id: 'hn_1' });
    assert.equal(await notesInStore(world), 0);
    assert.equal((await read({ key: KEY_A })).has('hn_1'), false);
    const queue = await consoleCall('GET', '');
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.deepEqual(
      queue.body.notes.map((each: Record<string, unknown>) => [each.note, each.origin, each.text, each.name]),
      [['hn_1', ORIGIN, 'The price is wrong.', 'Camille']],
    );
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 1 });
    // The same note sent again is held once.
    assert.equal(
      (await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_1', 'The price is wrong.', 'Camille'))).status,
      202,
    );
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 1 });
  });

  it('sends a note of a member at once, and holds nothing of it', async () => {
    const { world, call, noteOf, bobToken, consoleCall } = await aHoldingSite();

    assert.equal((await call('POST', '/feedback', { token: bobToken }, noteOf('hn_bob'))).status, 201);
    assert.equal(await notesInStore(world), 1);
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 0 });
  });

  it('sends an approved note to its place, as the visitor’s own, once', async () => {
    const { world, site, call, noteOf, read, mine, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_2'));

    const approved = await consoleCall('POST', `/${site}/hn_2/approve`);

    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(typeof approved.body.issue.identifier, 'string');
    assert.equal(await notesInStore(world), 1);
    assert.equal((await read()).has('hn_2'), true);
    // The browser that sent it reads it as its own; another does not.
    assert.deepEqual(await mine({ key: KEY_A }), ['hn_2']);
    assert.deepEqual(await mine({ key: KEY_B }), []);
    assert.deepEqual((await consoleCall('GET', '')).body, { notes: [] });
    // A second approval, by anybody, sends nothing.
    assert.equal((await consoleCall('POST', `/${site}/hn_2/approve`)).status, 404);
    assert.equal(await notesInStore(world), 1);
  });

  it('removes a rejected note, and sends it nowhere', async () => {
    const { world, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_3'));

    assert.equal((await consoleCall('POST', `/${site}/hn_3/reject`)).status, 204);

    assert.equal(await notesInStore(world), 0);
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 0 });
    assert.equal((await rowsOf(world.database, 'SELECT count(*) AS count FROM held_notes'))[0]?.count, 0);
  });

  it('keeps the note in the queue when its tracker does not answer the approval', async () => {
    const { world, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_4'));
    const failing: NoteStore = {
      ...createPostgresNoteStore(world.database),
      create: async () => {
        throw new StoreError('the tracker is down');
      },
    };

    const refused = await consoleCall('POST', `/${site}/hn_4/approve`, undefined, failing);

    assert.equal(refused.status, 502, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'store-unavailable' });
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 1 });
    assert.equal((await consoleCall('POST', `/${site}/hn_4/approve`)).status, 200);
  });

  it('refuses a guest, and a person of another workspace reads nothing', async () => {
    const { world, workspace, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_5'));
    const guest = await signInTo(world, 'guest@acme.dev');
    await memberOf(world, workspace, guest.id, 'guest');
    const stranger = await signInTo(world, 'nobody@globex.dev');

    assert.equal((await consoleCall('GET', '', guest.token)).status, 403);
    assert.equal((await consoleCall('POST', `/${site}/hn_5/approve`, guest.token)).status, 403);
    assert.equal((await consoleCall('POST', `/${site}/hn_5/reject`, stranger.token)).status, 404);
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 1 });
  });

  it('holds a batch of a visitor whole, and a batch sent again holds nothing twice', async () => {
    const { world, call, noteOf, consoleCall } = await aHoldingSite();
    const batch = [noteOf('hn_b1'), noteOf('hn_b2')];

    const sent = await call('POST', '/feedback', { key: KEY_A }, batch);

    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    assert.deepEqual(sent.body, {
      results: [
        { id: 'hn_b1', held: true },
        { id: 'hn_b2', held: true },
      ],
    });
    assert.equal((await call('POST', '/feedback', { key: KEY_A }, batch)).status, 202);
    assert.equal(await notesInStore(world), 0);
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 2 });
  });

  it('sends a note at once again once the site stops holding them', async () => {
    const { world, site, call, noteOf } = await aHoldingSite();
    await rowsOf(world.database, `UPDATE sites SET hold_visitor_notes = false WHERE id = '${site}'`);

    assert.equal((await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_6'))).status, 201);
    assert.equal(await notesInStore(world), 1);
  });

  it('forgets a note that waited 30 days, in the queue at once and in the table at the sweep', async () => {
    const { world, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_old'));
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_new'));
    const old = Date.now() - HELD_NOTE_KEEP_MS - 1;
    await rowsOf(world.database, `UPDATE held_notes SET held_at = ${old} WHERE note_id = 'hn_old'`);

    assert.deepEqual(
      (await consoleCall('GET', '')).body.notes.map((each: Record<string, unknown>) => each.note),
      ['hn_new'],
    );
    assert.equal((await consoleCall('POST', `/${site}/hn_old/approve`)).status, 404);
    assert.equal(await notesInStore(world), 0);
    assert.equal(await createPostgresHeldNotes(world.database).sweep(Date.now()), 1);
    assert.deepEqual(
      (await rowsOf(world.database, 'SELECT note_id FROM held_notes')).map((row) => row.note_id),
      ['hn_new'],
    );
  });

  it('fails when the route does not hold (planted violation)', async () => {
    const mutant = await mutatedModule('feedback-routes.ts', {
      from: 'if (identity.visitor && route.client?.holdVisitorNotes === true && attachmentIds.length === 0) {',
      to: 'if (false) {',
    });
    const { world, call, noteOf } = await aHoldingSite({ handle: mutant.module.handleRequest as Handle });

    const sent = await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_p'));
    mutant.remove();

    assert.equal(sent.status, 201);
    assert.equal(await notesInStore(world), 1);
  });
});

describe('« Hold new visitor notes », set in the console (FRU-704)', () => {
  it('is off for a new site, changes for an owner, is kept when not named, and refuses another value', async () => {
    const { world, workspace, site, alice } = await aHoldingSite();
    const post = (body: Record<string, unknown>) =>
      callOn(world, 'POST', `/console/workspaces/${workspace}/sites`, {
        token: alice.token,
        body: { url: ORIGIN, visibility: 'everyone', writers: 'anyone', ...body },
      });
    const stored = async () =>
      (await rowsOf(world.database, `SELECT hold_visitor_notes FROM sites WHERE id = '${site}'`))[0]
        ?.hold_visitor_notes;
    const fresh = await post({ url: 'https://new.acme.dev' });
    assert.equal(((await fresh.json()) as Record<string, unknown>).holdVisitorNotes, false);

    const off = await post({ holdVisitorNotes: false });
    assert.equal(off.status, 201);
    assert.equal(await stored(), false);
    assert.equal((await post({ holdVisitorNotes: true })).status, 201);
    assert.equal(await stored(), true);
    assert.equal((await post({})).status, 201);
    assert.equal(await stored(), true);
    for (const value of ['yes', 1, null]) {
      const refused = await post({ holdVisitorNotes: value });
      assert.equal(refused.status, 400, String(value));
      assert.deepEqual(await refused.json(), { error: 'invalid-hold-visitor-notes' });
    }
    assert.equal(await stored(), true);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mutatedModule } from './conformance.fixture.ts';
import { type World, callOn, memberOf, signInTo } from './console-world.fixture.ts';
import { HELD_CLAIM_MS, HELD_NOTE_KEEP_MS, type HeldNotes } from './held-notes.ts';
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
  const consoleCall = async (
    method: string,
    path: string,
    token = alice.token,
    store: NoteStore = site.store,
    heldNotes: HeldNotes = createPostgresHeldNotes(site.world.database),
  ) => {
    const response = await callOn(site.world, method, `${base}${path}`, { token }, { store, heldNotes });
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

  it('keeps the note when its send throws, and gives it back when an approval stops half way (review of #987)', async () => {
    const { world, site, workspace, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_t'));
    const throwing: NoteStore = {
      ...createPostgresNoteStore(world.database),
      create: async () => {
        throw new Error('a bug nobody expected');
      },
    };

    // The handler lets an error nobody expected go up, as for any route: the note waits again first.
    await assert.rejects(consoleCall('POST', `/${site}/hn_t/approve`, undefined, throwing), /a bug nobody expected/);
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 1 });

    // An approval that claimed the note and stopped: hidden while its claim runs, back after it.
    const held = createPostgresHeldNotes(world.database);
    const now = Date.now();
    assert.equal((await held.take(workspace, site, 'hn_t', now))?.note.id, 'hn_t');
    assert.equal(await held.take(workspace, site, 'hn_t', now), undefined);
    assert.equal(await held.count(workspace, undefined, now), 0);
    assert.equal(await held.count(workspace, undefined, now + HELD_CLAIM_MS + 1), 1);
    assert.equal((await held.take(workspace, site, 'hn_t', now + HELD_CLAIM_MS + 1))?.note.id, 'hn_t');
  });

  it('lets a late approval neither release nor remove the claim of the next one (review of #987)', async () => {
    const { world, site, workspace, call, noteOf } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_c'));
    const held = createPostgresHeldNotes(world.database);
    const now = Date.now();
    const first = await held.take(workspace, site, 'hn_c', now);
    const later = now + HELD_CLAIM_MS + 1;
    const second = await held.take(workspace, site, 'hn_c', later);
    assert.ok(first !== undefined && second !== undefined);

    await held.release(site, 'hn_c', first.claim);
    await held.done(site, 'hn_c', first.claim);

    assert.equal(await held.count(workspace, undefined, later + 1), 0);
    await held.done(site, 'hn_c', second.claim);
    assert.equal(await held.count(workspace, undefined, later + HELD_CLAIM_MS + 1), 0);
    assert.equal((await rowsOf(world.database, 'SELECT count(*) AS n FROM held_notes'))[0]?.n, 0);
  });

  it('answers 200 for a note sent to its place even when its row is not removed at once (review of #987)', async () => {
    const { world, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_d'));
    const real = createPostgresHeldNotes(world.database);
    const failingDone: HeldNotes = {
      ...real,
      done: async () => {
        throw new Error('the database blinked');
      },
    };

    const approved = await consoleCall('POST', `/${site}/hn_d/approve`, undefined, undefined, failingDone);

    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(await notesInStore(world), 1);
    // The row stays claimed: no second approval sends it again while the claim runs.
    assert.equal((await consoleCall('POST', `/${site}/hn_d/approve`)).status, 404);
    assert.equal(await notesInStore(world), 1);
  });

  it('still says why an approval failed when the database does not take the release (review of #987)', async () => {
    const { world, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_r'));
    const failing: NoteStore = {
      ...createPostgresNoteStore(world.database),
      create: async () => {
        throw new StoreError('the tracker is down');
      },
    };
    const failingRelease: HeldNotes = {
      ...createPostgresHeldNotes(world.database),
      release: async () => {
        throw new Error('the database blinked');
      },
    };

    const refused = await consoleCall('POST', `/${site}/hn_r/approve`, undefined, failing, failingRelease);

    assert.equal(refused.status, 502, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: 'store-unavailable' });
    assert.equal(await notesInStore(world), 0);
  });

  it('shows a note again at once when its reject does not remove it (review of #987)', async () => {
    const { world, site, call, noteOf, consoleCall } = await aHoldingSite();
    await call('POST', '/feedback', { key: KEY_A }, noteOf('hn_j'));
    const failingDone: HeldNotes = {
      ...createPostgresHeldNotes(world.database),
      done: async () => {
        throw new Error('the database blinked');
      },
    };

    await assert.rejects(
      consoleCall('POST', `/${site}/hn_j/reject`, undefined, undefined, failingDone),
      /the database blinked/,
    );
    assert.deepEqual((await consoleCall('GET', '/count')).body, { count: 1 });
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

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { deliveryBody } from './rest-connector.ts';

const open = worlds();
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T12:00:00.000Z');

/**
 * A workspace of Alice with two sites and twelve notes, one a day for twelve days, the newest today.
 * The even ones went to an address of the workspace, the odd ones to its own store. Three of those of
 * the address did not arrive: notes 0 and 2 wait for an attempt, note 4 was given up. A delivery of
 * another site of another workspace, with the same reference, is no delivery of this one. Bob is a
 * member, Gina a guest of the first site.
 */
async function aWorkspace() {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  world.context = { ...world.context, noteIndex: index };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  const gina = await signInTo(world, 'gina@client.fr');
  await memberOf(world, workspace, gina.id, 'guest');
  const first = await world.accounts.addSite(workspace, { origin: 'https://acme.dev', visibility: 'everyone' });
  const second = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'everyone' });
  await shareWith(world, workspace, gina.id, [first.id]);
  const hook = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.test', sealed: 'x' });

  const ids: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const site = i % 4 < 2 ? first : second;
    const note = noteFixture({ id: `sd_view${String(i).padStart(2, '0')}` });
    ids.push(note.id);
    await index.record(
      [
        {
          workspace,
          site: site.id,
          note,
          channel: 'script',
          author: { kind: 'visitor' },
          place: i % 2 === 0 ? { kind: 'connector', connector: hook.id } : { kind: 'fruitback' },
          issue: { identifier: `REF-${i}` },
          stage: 'new',
        },
      ],
      NOW - i * DAY,
    );
    if (i === 0 || i === 2 || i === 4) {
      await world.accounts.enqueueDelivery(
        hook.id,
        deliveryBody({ workspace, site: { id: site.id }, identifier: `REF-${i}`, note }),
        NOW,
      );
    }
  }
  await rowsOf(world.database, `UPDATE deliveries SET next_at = NULL, attempts = 6 WHERE body LIKE '%REF-4"%'`);

  const zed = await signInTo(world, 'zed@other.dev');
  const other = await workspaceIn(world, zed.token, 'Other');
  const elsewhere = await world.accounts.addSite(other, { origin: 'https://other.dev', visibility: 'everyone' });
  const theirs = await world.accounts.addConnector(other, { kind: 'rest', label: 'hooks.other.test', sealed: 'x' });
  await world.accounts.enqueueDelivery(
    theirs.id,
    deliveryBody({ workspace: other, site: { id: elsewhere.id }, identifier: 'REF-6', note: noteFixture() }),
    NOW,
  );

  return { world, alice, bob, gina, workspace, first, second, ids };
}

type Listed = { notes: { id: string }[]; total: number; counts: { undelivered?: number } };

async function list(world: Awaited<ReturnType<typeof open>>, workspace: string, token: string, query: string) {
  const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/notes?${query}`, { token });

  return { status: answer.status, body: (await answer.json()) as Listed };
}

describe('the notes left since an instant, for « New this week » (FRU-722)', () => {
  it('lists the notes left at that instant or after it, and counts them', async () => {
    const { world, alice, workspace } = await aWorkspace();
    // Today and the six days before: notes 0 to 6. Note 6 was left at the instant itself.
    const since = NOW - 6 * DAY;

    const { status, body } = await list(world, workspace, alice.token, `since=${since}&limit=50`);
    assert.equal(status, 200);
    assert.equal(body.total, 7);
    assert.equal(body.notes.length, 7);
    // The control: with no filter, the twelve.
    assert.equal((await list(world, workspace, alice.token, 'limit=50')).body.total, 12);
  });

  it('refuses an instant that is not a count of milliseconds', async () => {
    const { world, alice, workspace } = await aWorkspace();
    for (const since of ['yesterday', '-1', '1.5', '2026-11-20', '', '99999999999999999']) {
      const { status, body } = await list(world, workspace, alice.token, `since=${encodeURIComponent(since)}`);
      assert.equal(status, 400, since);
      assert.deepEqual(body, { error: 'invalid-since' });
    }
  });

  it('narrows a guest to the sites shared with them', async () => {
    const { world, gina, workspace } = await aWorkspace();
    // The first site: notes 0, 1, 4, 5, 8, 9; of the last seven days, 0, 1, 4, 5.
    const { body } = await list(world, workspace, gina.token, `since=${NOW - 6 * DAY}&limit=50`);
    assert.equal(body.total, 4);
  });
});

describe('the notes whose delivery did not arrive, for « Not delivered » (FRU-722)', () => {
  it('lists them, waiting or given up, and none of another workspace', async () => {
    const { world, alice, bob, workspace } = await aWorkspace();
    for (const token of [alice.token, bob.token]) {
      const { status, body } = await list(world, workspace, token, 'undelivered=1&limit=50');
      assert.equal(status, 200);
      // Notes 0, 2 and 4; note 6 has a delivery of another workspace with its reference.
      assert.equal(body.total, 3);
      assert.equal(body.notes.length, 3);
      assert.equal(body.counts.undelivered, 3);
    }
    // The control: with no filter, every note, of which three did not arrive.
    const all = await list(world, workspace, alice.token, 'limit=50');
    assert.equal(all.body.total, 12);
    assert.equal(all.body.counts.undelivered, 3);
  });

  it('lists none when every delivery arrived', async () => {
    const { world, alice, workspace } = await aWorkspace();
    await rowsOf(world.database, 'DELETE FROM deliveries');
    const { status, body } = await list(world, workspace, alice.token, 'undelivered=1');
    assert.equal(status, 200);
    assert.equal(body.total, 0);
  });

  it('is refused to a guest, who does not see where a note went, and takes 1 only', async () => {
    const { world, alice, gina, workspace } = await aWorkspace();
    const guest = await list(world, workspace, gina.token, 'undelivered=1');
    assert.equal(guest.status, 403);
    for (const value of ['0', 'true', 'yes', '']) {
      const { status, body } = await list(world, workspace, alice.token, `undelivered=${value}`);
      assert.equal(status, 400, value);
      assert.deepEqual(body, { error: 'invalid-undelivered' });
    }
  });

  it('crosses with the other filters: the notes of one site that did not arrive', async () => {
    const { world, alice, workspace, second } = await aWorkspace();
    // The second site: notes 2, 3, 6, 7, 10, 11; of those that did not arrive, note 2.
    const { body } = await list(world, workspace, alice.token, `undelivered=1&site=${second.id}`);
    assert.equal(body.total, 1);
    const both = await list(world, workspace, alice.token, `undelivered=1&since=${NOW - DAY}`);
    // Today and yesterday: notes 0 and 1; did not arrive: note 0.
    assert.equal(both.body.total, 1);
  });
});

describe('the counts of the views in the read of the bar (FRU-722)', () => {
  it('says the total of the list for « New this week » and « Not delivered »', async () => {
    const { world, alice, gina, workspace } = await aWorkspace();
    const since = NOW - 6 * DAY;
    const rail = async (token: string, query = '') => {
      const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/rail${query}`, { token });
      assert.equal(answer.status, 200, await answer.clone().text());

      return ((await answer.json()) as { views: Record<string, number> }).views;
    };

    const owner = await rail(alice.token, `?since=${since}`);
    assert.equal(owner.new, (await list(world, workspace, alice.token, `since=${since}`)).body.total);
    assert.equal(owner.undelivered, (await list(world, workspace, alice.token, 'undelivered=1')).body.total);
    assert.deepEqual(owner, { assigned: 0, new: 7, undelivered: 3 });
    // No instant: no count of « New this week ».
    assert.deepEqual(await rail(alice.token), { assigned: 0, undelivered: 3 });

    // A guest: the notes of their site, and nothing about deliveries.
    const guest = await rail(gina.token, `?since=${since}`);
    assert.deepEqual(guest, { assigned: 0, new: 4 });
  });

  it('refuses an instant that is not a count of milliseconds', async () => {
    const { world, alice, workspace } = await aWorkspace();
    const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/rail?since=last-week`, {
      token: alice.token,
    });
    assert.equal(answer.status, 400);
  });
});

describe('the list of the extension reads neither filter (FRU-722)', () => {
  it('ignores `since` and `undelivered` outside the route of the console', async () => {
    const { queryOf } = await import('./console-notes.ts');
    const read = queryOf(new URLSearchParams({ since: '0', undelivered: '1' }), 'acc');
    assert.equal(read.ok, true);
    assert.equal('since' in (read.ok ? read.query : {}), false);
    assert.equal('undelivered' in (read.ok ? read.query : {}), false);
    // The control: the route of the console reads both.
    const console = queryOf(new URLSearchParams({ since: '0', undelivered: '1' }), 'acc', { console: true });
    assert.deepEqual(console.ok ? { since: console.query.since, undelivered: console.query.undelivered } : {}, {
      since: 0,
      undelivered: true,
    });
  });
});

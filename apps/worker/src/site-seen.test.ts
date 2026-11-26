import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { deliveryBody } from './rest-connector.ts';
import { createPairing, redeemPairing } from './session.ts';
import { SEEN_EVERY_MS, forgetSeen, seeSite } from './site-seen.ts';

const open = worlds();
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-26T12:00:00.000Z');

afterEach(() => forgetSeen());

type SitePage = {
  seen: { script?: string; extension?: string };
  oldestOpenAt?: string;
  recent?: { days: number; notes: number; undelivered?: number };
};

/** A workspace of Alice with one site that everyone reads, and Gina, a guest of it. */
async function aSite() {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  world.context = { ...world.context, noteIndex: index };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token);
  const gina = await signInTo(world, 'gina@client.fr');
  await memberOf(world, workspace, gina.id, 'guest');
  const site = await world.accounts.addSite(workspace, { origin: 'https://acme.dev', visibility: 'everyone' });
  await shareWith(world, workspace, gina.id, [site.id]);

  return { world, index, alice, gina, workspace, site };
}

/** What the page of the site says, for the person of `token`. */
async function pageOf(world: Awaited<ReturnType<typeof open>>, workspace: string, site: string, token: string) {
  const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/sites/${site}`, { token });
  assert.equal(answer.status, 200, await answer.clone().text());

  return (await answer.json()) as SitePage;
}

/** The read of the pins of a page that the widget sends when it mounts. */
function readPins(
  world: Awaited<ReturnType<typeof open>>,
  site: string,
  options: { origin?: string | null; token?: string },
) {
  return callOn(world, 'GET', `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${site}`, {
    origin: options.origin === undefined ? 'https://acme.dev' : options.origin,
    ...(options.token === undefined ? {} : { token: options.token }),
  });
}

async function seenAt(world: Awaited<ReturnType<typeof open>>, site: string) {
  const [row] = await rowsOf(
    world.database,
    `SELECT script_seen_at, extension_seen_at FROM sites WHERE id = '${site}'`,
  );

  return { script: row?.script_seen_at ?? null, extension: row?.extension_seen_at ?? null };
}

describe('when the widget was last seen on a site (FRU-721)', () => {
  it('writes the visit of the script from the read of the pins, and the page of the site says it', async () => {
    const { world, alice, gina, workspace, site } = await aSite();
    assert.deepEqual((await pageOf(world, workspace, site.id, alice.token)).seen, {});

    const before = Date.now();
    assert.equal((await readPins(world, site.id, {})).status, 200);
    const seen = (await pageOf(world, workspace, site.id, alice.token)).seen;
    assert.deepEqual(Object.keys(seen), ['script']);
    assert.ok(Date.parse(seen.script as string) >= before);
    // A guest of the site reads it too: it says nothing of a tracker.
    assert.deepEqual((await pageOf(world, workspace, site.id, gina.token)).seen, seen);
  });

  it('writes it also when the read is refused: the script is on the site of members only', async () => {
    const { world, alice, workspace } = await aSite();
    const closed = await world.accounts.addSite(workspace, { origin: 'https://team.acme.dev', visibility: 'members' });
    const answer = await callOn(
      world,
      'GET',
      `/feedback?url=${encodeURIComponent('https://team.acme.dev/')}&client=${closed.id}`,
      { origin: 'https://team.acme.dev' },
    );
    assert.equal(answer.status, 401);
    assert.notEqual((await seenAt(world, closed.id)).script, null);
    assert.ok((await pageOf(world, workspace, closed.id, alice.token)).seen.script);
  });

  it('writes nothing for a read with no Origin, or another one', async () => {
    const { world, site } = await aSite();
    await readPins(world, site.id, { origin: null });
    await readPins(world, site.id, { origin: 'https://evil.example' });
    assert.deepEqual(await seenAt(world, site.id), { script: null, extension: null });
    // The control: from the site, it is written.
    await readPins(world, site.id, {});
    assert.notEqual((await seenAt(world, site.id)).script, null);
  });

  it('writes the visit of the extension for a session of the workspace, apart from the script', async () => {
    const { world, alice, workspace, site } = await aSite();
    const { code } = await createPairing(world.sessions, { subject: alice.id, workspace });
    const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(redeemed.ok);

    await readPins(world, site.id, { token: redeemed.session.accessToken });
    const seen = await seenAt(world, site.id);
    assert.notEqual(seen.extension, null);
    assert.equal(seen.script, null);
    // A token that does not verify says nothing of the site.
    forgetSeen();
    await rowsOf(world.database, `UPDATE sites SET extension_seen_at = NULL WHERE id = '${site.id}'`);
    await readPins(world, site.id, { token: 'not-a-token' });
    assert.equal((await seenAt(world, site.id)).extension, null);
  });

  it('writes at most once an hour: this process remembers, and the store keeps a date of the hour', async () => {
    const { world, site } = await aSite();
    await readPins(world, site.id, {});
    const first = Number((await seenAt(world, site.id)).script);
    // An older date in the row: the process wrote in the hour, so it does not write again.
    await rowsOf(
      world.database,
      `UPDATE sites SET script_seen_at = ${first - 2 * SEEN_EVERY_MS} WHERE id = '${site.id}'`,
    );
    await readPins(world, site.id, {});
    assert.equal(Number((await seenAt(world, site.id)).script), first - 2 * SEEN_EVERY_MS);
    // Another process (this one, forgetting): the date is old, so it writes.
    forgetSeen();
    await readPins(world, site.id, {});
    assert.ok(Number((await seenAt(world, site.id)).script) >= first);

    // The store alone: a date of the hour is not written again; one an hour old is.
    await world.accounts.markSiteSeen(site.id, 'script', NOW);
    await world.accounts.markSiteSeen(site.id, 'script', NOW + SEEN_EVERY_MS - 1);
    assert.equal(Number((await seenAt(world, site.id)).script), NOW);
    await world.accounts.markSiteSeen(site.id, 'script', NOW + SEEN_EVERY_MS + 1);
    assert.equal(Number((await seenAt(world, site.id)).script), NOW + SEEN_EVERY_MS + 1);
  });

  it('checks the way a read claims only when a write is due, not at every read of the hour', async () => {
    const marked: string[] = [];
    const accounts = { markSiteSeen: async (site: string, way: string) => void marked.push(`${site}:${way}`) };
    let checks = 0;
    const confirm = async () => {
      checks += 1;

      return true;
    };
    await seeSite(accounts, 'site_a', 'extension', confirm, NOW);
    for (let minute = 1; minute < 60; minute += 1)
      await seeSite(accounts, 'site_a', 'extension', confirm, NOW + minute * 60_000);
    assert.equal(checks, 1);
    // The other way of the same site is its own: the script is checked and written once too.
    await seeSite(accounts, 'site_a', 'script', confirm, NOW + 1);
    await seeSite(accounts, 'site_a', 'script', confirm, NOW + 2);
    assert.equal(checks, 2);
    // An hour later, the way is checked and written again.
    await seeSite(accounts, 'site_a', 'extension', confirm, NOW + SEEN_EVERY_MS);
    assert.equal(checks, 3);
    assert.deepEqual(marked, ['site_a:extension', 'site_a:script', 'site_a:extension']);
    // A claim that does not check writes nothing.
    await seeSite(accounts, 'site_b', 'script', async () => false, NOW);
    assert.equal(marked.length, 3);
  });

  it('answers the read of the pins when the write fails', async () => {
    const { world, site } = await aSite();
    const failing = { ...world.accounts, markSiteSeen: () => Promise.reject(new Error('the database stopped')) };
    const answer = await callOn(
      world,
      'GET',
      `/feedback?url=${encodeURIComponent('https://acme.dev/pricing')}&client=${site.id}`,
      { origin: 'https://acme.dev' },
      { accounts: failing },
    );
    assert.equal(answer.status, 200);
  });
});

describe('the figures of the page of a site (FRU-721)', () => {
  it('says the oldest open note, the notes of 30 days, and those not delivered to whoever sees the tracker', async () => {
    const { world, index, alice, gina, workspace, site } = await aSite();
    const hook = await world.accounts.addConnector(workspace, { kind: 'rest', label: 'hooks.acme.test', sealed: 'x' });
    // Notes 0 to 5, left 0, 10, 20, 29, 40 and 50 days ago: 0 to 3 are in the last 30 days. Note 5 is
    // done, note 4 is the oldest open one. Notes 0 and 4 did not arrive; of the last 30 days, note 0.
    // The route reads the clock of the process: the dates are counted from it, and none is on an edge.
    const now = Date.now();
    const ages = [0, 10, 20, 29, 40, 50];
    const stages = ['new', 'todo', 'done', 'progress', 'new', 'done'] as const;
    for (let i = 0; i < 6; i += 1) {
      const note = noteFixture({ id: `sd_fig${i}` });
      await index.record(
        [
          {
            workspace,
            site: site.id,
            note,
            channel: 'script',
            author: { kind: 'visitor' },
            place: { kind: 'connector', connector: hook.id },
            issue: { identifier: `REF-${i}` },
            stage: stages[i] as (typeof stages)[number],
          },
        ],
        now - (ages[i] as number) * DAY,
      );
      if (i === 0 || i === 4) {
        await world.accounts.enqueueDelivery(
          hook.id,
          deliveryBody({ workspace, site: { id: site.id }, identifier: `REF-${i}`, note }),
          NOW,
        );
      }
    }

    const owner = await pageOf(world, workspace, site.id, alice.token);
    assert.equal(owner.oldestOpenAt, new Date(now - 40 * DAY).toISOString());
    assert.deepEqual(owner.recent, { days: 30, notes: 4, undelivered: 1 });
    // A guest: the same notes, nothing of the deliveries.
    const guest = await pageOf(world, workspace, site.id, gina.token);
    assert.equal(guest.oldestOpenAt, owner.oldestOpenAt);
    assert.deepEqual(guest.recent, { days: 30, notes: 4 });
  });

  it('says no oldest note for a site with none open, and zero notes', async () => {
    const { world, alice, workspace, site } = await aSite();
    const page = await pageOf(world, workspace, site.id, alice.token);
    assert.equal('oldestOpenAt' in page, false);
    assert.deepEqual(page.recent, { days: 30, notes: 0, undelivered: 0 });
  });
});

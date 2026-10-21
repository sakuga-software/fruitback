import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { SeedStage } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type World, callOn, memberOf, shareWith, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import type { NoteEntry } from './notes-index.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, digest, redeemPairing } from './session.ts';

/**
 * `GET /session/notes` (FRU-306): the notes of one whole site, for the side panel of the extension,
 * read in the index with the rules of the console's list (FRU-244) and the session read again in the
 * store. Each refusal has its control: the same call that a person who may read gets `200` for.
 */

const open = worlds();
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const BASE = Date.parse('2026-10-01T00:00:00.000Z');
const LONG = `The add button is almost invisible until you hover it, and ${'nobody can tell it is clickable. '.repeat(3)}`;

type Answer = {
  notes: {
    seed: string;
    excerpt: string;
    page: { url: string; path: string };
    stage: string;
    author: { kind: string; name?: string };
    reference?: string;
    referenceUrl?: string;
    createdAt: string;
  }[];
  total: number;
  searched: string[];
  next?: string;
};

type Session = { accessToken: string; refreshToken: string };

/** A session of the extension: the account's (FRU-238), or a pairing of `workspace`. */
async function sessionOf(world: World, who: { id: string; token: string }, workspace?: string): Promise<Session> {
  if (workspace !== undefined) {
    const { code } = await createPairing(world.sessions, { subject: who.id, workspace });
    const redeemed = await redeemPairing(world.sessions, code, world.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(redeemed.ok);

    return redeemed.session;
  }
  const asked = await callOn(world, 'POST', '/session/connect', { origin: EXTENSION, body: { browser: 'Chrome' } });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { request, claim } = (await asked.json()) as { request: string; claim: string };
  const shown = await callOn(world, 'GET', `/console/connect/${request}`, { token: who.token });
  const { word } = (await shown.json()) as { word: string };
  const approved = await callOn(world, 'POST', `/console/connect/${request}/approve`, {
    token: who.token,
    body: { word, account: who.id },
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  await world.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const claimed = await callOn(world, 'POST', '/session/connect/claim', { origin: EXTENSION, body: { claim } });
  assert.equal(claimed.status, 200, await claimed.clone().text());

  return (await claimed.json()) as Session;
}

function ask(world: World, token: string | undefined, query: string): Promise<Response> {
  return callOn(world, 'GET', `/session/notes${query}`, {
    origin: EXTENSION,
    ...(token === undefined ? {} : { token }),
  });
}

async function read(world: World, token: string, query: string): Promise<Answer> {
  const answer = await ask(world, token, query);
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal(answer.headers.get('Cache-Control'), 'no-store');

  return (await answer.json()) as Answer;
}

/**
 * Acme of Alice, with the site `shop` (three pages, six notes) and the site `admin` (two notes). Bob
 * is a member; Gina is a guest of `shop` only. Zed owns another workspace, with notes of its own.
 */
async function acme() {
  const world = await open();
  const index = createPostgresNoteIndex(world.database);
  world.context = { ...world.context, noteIndex: index, connectStore: world.connectStore };
  const alice = await signInTo(world, 'alice@acme.dev');
  const workspace = await workspaceIn(world, alice.token, 'Acme');
  const bob = await signInTo(world, 'bob@acme.dev');
  await memberOf(world, workspace, bob.id, 'member');
  await rowsOf(world.database, `UPDATE "user" SET name = 'Bob Martin' WHERE id = '${bob.id}'`);
  const gina = await signInTo(world, 'gina@client.fr');
  await memberOf(world, workspace, gina.id, 'guest');
  const shop = await world.accounts.addSite(workspace, { origin: 'https://shop.acme.dev', visibility: 'members' });
  const admin = await world.accounts.addSite(workspace, { origin: 'https://admin.acme.dev', visibility: 'members' });
  await shareWith(world, workspace, gina.id, [shop.id]);
  const linear = await world.accounts.addConnector(workspace, { kind: 'linear', label: 'Linear ACM', sealed: 'x' });

  const plant = async (
    on: { workspace: string; site: string; origin: string },
    i: number,
    path: string,
    stage: SeedStage,
    note: string,
    author?: string,
  ) => {
    const seed = seedFixture({ id: `sd_${on.site}_${i}`, note, page: { url: `${on.origin}${path}`, path } });
    const entry: NoteEntry = {
      workspace: on.workspace,
      site: on.site,
      seed,
      channel: 'extension',
      author: author === undefined ? { kind: 'visitor' } : { kind: 'member', account: author },
      place: { kind: 'connector', connector: linear.id },
      issue: { identifier: `ACM-${100 + i}`, url: `https://linear.test/ACM-${100 + i}` },
      stage,
    };
    await index.record([entry], BASE + i * 1_000);
  };
  const atShop = { workspace, site: shop.id, origin: shop.origin };
  await plant(atShop, 1, '/', 'seeded', LONG, bob.id);
  await plant(atShop, 2, '/', 'green', 'Could the title mention Bordeaux?');
  await plant(atShop, 3, '/cart', 'ripening', '29 € for the Mocha, the price list says 27 €.');
  await plant(atShop, 4, '/cart', 'ripe', 'The total does not add up.');
  await plant(atShop, 5, '/subscriptions', 'ripening', 'The email field is too short on mobile.');
  await plant(atShop, 6, '/subscriptions', 'composted', 'Wrong currency.');
  const atAdmin = { workspace, site: admin.id, origin: admin.origin };
  await plant(atAdmin, 7, '/users', 'seeded', 'The secret admin note.');
  await plant(atAdmin, 8, '/users', 'green', 'Another admin note.');

  const zed = await signInTo(world, 'zed@other.dev');
  const other = await workspaceIn(world, zed.token, 'Other');
  const otherSite = await world.accounts.addSite(other, { origin: 'https://other.dev', visibility: 'members' });
  await plant({ workspace: other, site: otherSite.id, origin: otherSite.origin }, 9, '/', 'seeded', 'Of Other.');

  return { world, workspace, shop, admin, otherSite, alice, bob, gina, zed };
}

describe('the notes of a whole site, in GET /session/notes (FRU-306)', () => {
  it('gives a member the notes of every page of the site, as excerpts, the newest first', async () => {
    const { world, shop, alice, bob } = await acme();
    const { accessToken } = await sessionOf(world, alice);

    const answer = await read(world, accessToken, `?site=${shop.id}`);

    assert.equal(answer.total, 6);
    assert.deepEqual(
      answer.notes.map((note) => note.page.path),
      ['/subscriptions', '/subscriptions', '/cart', '/cart', '/', '/'],
    );
    const long = answer.notes.find((note) => note.seed === `sd_${shop.id}_1`);
    assert.ok(long !== undefined);
    assert.ok(long.excerpt.length <= 64, 'an excerpt, never the text');
    assert.ok(!JSON.stringify(answer).includes('nobody can tell it is clickable'));
    assert.deepEqual(long.author, { kind: 'member', name: 'Bob Martin' });
    assert.equal(long.reference, 'ACM-101');
    assert.equal(long.referenceUrl, 'https://linear.test/ACM-101');
    assert.deepEqual(answer.searched, ['excerpt', 'page', 'site', 'stage', 'reference']);
    // No reply, no selector, nothing of the note beyond the index.
    for (const note of answer.notes) {
      assert.deepEqual(Object.keys(note).sort(), [
        'author',
        'createdAt',
        'excerpt',
        'page',
        'reference',
        'referenceUrl',
        'seed',
        'stage',
      ]);
    }
    // The member reads it too, with the same session kind.
    assert.equal((await read(world, (await sessionOf(world, bob)).accessToken, `?site=${shop.id}`)).total, 6);
  });

  it('filters by stage and by words, and refuses a query it cannot read', async () => {
    const { world, shop, alice } = await acme();
    const { accessToken } = await sessionOf(world, alice);

    const ripening = await read(world, accessToken, `?site=${shop.id}&stage=ripening`);
    assert.deepEqual(
      ripening.notes.map((note) => note.stage),
      ['ripening', 'ripening'],
    );
    assert.equal((await read(world, accessToken, `?site=${shop.id}&q=mocha`)).total, 1);
    assert.equal(
      (await read(world, accessToken, `?site=${shop.id}&q=ACM-104`)).total,
      1,
      'the owner finds a reference',
    );

    assert.equal((await ask(world, accessToken, `?site=${shop.id}&stage=ripe-ish`)).status, 400);
    assert.equal((await ask(world, accessToken, `?site=${shop.id}&limit=500`)).status, 400);
    assert.equal((await ask(world, accessToken, '')).status, 400, 'a site is required');
  });

  it('lets a pairing of the workspace read its sites, and the sites of no other workspace', async () => {
    const { world, workspace, shop, otherSite, alice } = await acme();
    const { accessToken } = await sessionOf(world, alice, workspace);

    assert.equal((await read(world, accessToken, `?site=${shop.id}`)).total, 6);
    assert.equal((await ask(world, accessToken, `?site=${otherSite.id}`)).status, 404);
  });
});

describe('who reads the notes of a site, in GET /session/notes (FRU-306)', () => {
  it('gives a guest the site shared with them, and answers 404 for the site that is not', async () => {
    const { world, shop, admin, gina } = await acme();
    const { accessToken } = await sessionOf(world, gina);

    // The control: the same session reads the site shared with it.
    assert.equal((await read(world, accessToken, `?site=${shop.id}`)).total, 6);
    const refused = await ask(world, accessToken, `?site=${admin.id}`);
    assert.equal(refused.status, 404);
    assert.ok(!(await refused.text()).includes('admin note'));
  });

  it('gives a guest nothing of where the notes went, and no search on the references', async () => {
    const { world, shop, alice, gina } = await acme();
    const guest = (await sessionOf(world, gina)).accessToken;
    const owner = (await sessionOf(world, alice)).accessToken;

    const answer = await read(world, guest, `?site=${shop.id}`);
    for (const note of answer.notes) {
      assert.equal(note.reference, undefined);
      assert.equal(note.referenceUrl, undefined);
    }
    assert.ok(!JSON.stringify(answer).includes('ACM-'));
    assert.deepEqual(answer.searched, ['excerpt', 'page', 'site', 'stage']);
    // The control: the owner finds the note by its reference, the guest does not.
    assert.equal((await read(world, owner, `?site=${shop.id}&q=ACM-104`)).total, 1);
    assert.equal((await read(world, guest, `?site=${shop.id}&q=ACM-104`)).total, 0);
  });

  it('answers 404 to a person of another workspace, and to a site of a suspended workspace', async () => {
    const { world, workspace, shop, otherSite, alice, zed } = await acme();
    const outsider = (await sessionOf(world, zed)).accessToken;
    const owner = (await sessionOf(world, alice)).accessToken;

    assert.equal((await read(world, outsider, `?site=${otherSite.id}`)).total, 1, 'the control: Zed reads his own');
    assert.equal((await ask(world, outsider, `?site=${shop.id}`)).status, 404);

    assert.equal((await read(world, owner, `?site=${shop.id}`)).total, 6);
    await rowsOf(
      world.database,
      `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${workspace}', ${Date.now()})`,
    );
    assert.equal((await ask(world, owner, `?site=${shop.id}`)).status, 404);
  });

  it('answers 401 to the cookie of the console, to no token, and to a session that ended', async () => {
    const { world, shop, alice } = await acme();
    const session = await sessionOf(world, alice);

    assert.equal((await ask(world, alice.token, `?site=${shop.id}`)).status, 401, 'the cookie of the console');
    assert.equal((await ask(world, undefined, `?site=${shop.id}`)).status, 401);
    assert.equal((await read(world, session.accessToken, `?site=${shop.id}`)).total, 6, 'the control');
    const revoked = await callOn(world, 'POST', '/session/revoke', {
      origin: EXTENSION,
      body: { refreshToken: session.refreshToken },
    });
    assert.equal(revoked.status, 204);
    // The access token is still signed and in date: the store says the session ended.
    assert.equal((await ask(world, session.accessToken, `?site=${shop.id}`)).status, 401);
  });

  it('answers 401 to a member who left, whose token is still in date', async () => {
    const { world, workspace, shop, bob } = await acme();
    const { accessToken } = await sessionOf(world, bob, workspace);
    assert.equal((await read(world, accessToken, `?site=${shop.id}`)).total, 6, 'the control');

    await rowsOf(world.database, `DELETE FROM member WHERE "userId" = '${bob.id}'`);

    assert.equal((await ask(world, accessToken, `?site=${shop.id}`)).status, 401);
  });
});

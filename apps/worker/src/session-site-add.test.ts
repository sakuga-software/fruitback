import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { CONSOLE, type World, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, digest, mintAccessToken, redeemPairing } from './session.ts';
import { ADDS_PER_ACCOUNT, addableOrigin } from './session-site-add.ts';

/**
 * `POST /session/sites` (FRU-255): the extension adds the site of its tab to a workspace, the first
 * route a token of an extension writes through. Through `handleRequest`, on PostgreSQL (PGlite), role
 * by role and session by session. Each guard of `session-site-add.ts` has a test here that fails
 * without it.
 */

const world = worlds();

/**
 * A request through the worker of the world, with its stores of connection: the cookie of the
 * console, or the access token of a session of the extension. The `Origin` of the console by default.
 */
function callOn(
  env: World,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string | null } = {},
): Promise<Response> {
  const token = options.token;
  const headers: Record<string, string> = {};
  // A cookie of the console holds a `=`; a token of the extension does not.
  if (token !== undefined && token.includes('=')) headers.Cookie = token;
  else if (token !== undefined) headers.Authorization = `Bearer ${token}`;

  return env.call(path, {
    method,
    headers,
    origin: options.origin === undefined ? CONSOLE : options.origin,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SITE = 'https://staging.client.fr';

type Site = { id: string; origin: string; visibility: string; workspace: string };

/**
 * A session of an account, the whole way (FRU-238): the extension asks, the person approves in the
 * console, the extension claims. A write reads that session again in the store.
 */
async function connect(
  env: World,
  who: { id: string; token: string },
): Promise<{ accessToken: string; refreshToken: string }> {
  const asked = await callOn(env, 'POST', '/session/connect', {
    origin: EXTENSION,
    body: { browser: 'Chrome on macOS' },
  });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { request, claim } = (await asked.json()) as { request: string; claim: string };
  const shown = await callOn(env, 'GET', `/console/connect/${request}`, { token: who.token });
  const { word } = (await shown.json()) as { word: string };
  const approved = await callOn(env, 'POST', `/console/connect/${request}/approve`, {
    token: who.token,
    body: { word, account: who.id },
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  // The pace of the claims: the interval went by.
  await env.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const claimed = await callOn(env, 'POST', '/session/connect/claim', { origin: EXTENSION, body: { claim } });
  assert.equal(claimed.status, 200, await claimed.clone().text());

  return (await claimed.json()) as { accessToken: string; refreshToken: string };
}

/** The access token of a new session of `who`. */
async function accountToken(env: World, who: { id: string; token: string }): Promise<string> {
  return (await connect(env, who)).accessToken;
}

function add(env: World, token: string | undefined, body: unknown, more: { origin?: string | null } = {}) {
  return callOn(env, 'POST', '/session/sites', {
    origin: more.origin === undefined ? EXTENSION : more.origin,
    ...(token === undefined ? {} : { token }),
    body,
  });
}

async function sitesOf(env: World, workspace: string): Promise<{ origin: string; visibility: string }[]> {
  return env.accounts.sites(workspace);
}

/** Alice owns Acme, with one person of each other role; Mallory owns Evil. */
async function acme(env: World) {
  const alice = await signInTo(env, 'alice@acme.dev');
  const id = await workspaceIn(env, alice.token, 'Acme');
  const people: Record<string, { id: string; token: string }> = { owner: alice };
  for (const role of ['admin', 'member', 'guest']) {
    const person = await signInTo(env, `${role}@acme.dev`);
    await memberOf(env, id, person.id, role);
    people[role] = person;
  }
  const mallory = await signInTo(env, 'mallory@evil.dev');
  const evil = await workspaceIn(env, mallory.token, 'Evil');

  return { id, evil, mallory, people: people as Record<'owner' | 'admin' | 'member' | 'guest', typeof alice> };
}

describe('a site added from the popup (FRU-255)', () => {
  it('is added by the owner and by an admin, as a site of members, and the console reads it', async () => {
    const env = await world();
    const { id, people } = await acme(env);

    for (const [role, origin] of [
      ['owner', SITE],
      ['admin', 'https://preview.client.fr'],
    ] as const) {
      const answer = await add(env, await accountToken(env, people[role]), { workspace: id, origin });
      assert.equal(answer.status, 201, role);
      const { site } = (await answer.json()) as { site: Site };
      assert.deepEqual({ ...site, id: undefined }, { id: undefined, origin, visibility: 'members', workspace: id });
      assert.equal(answer.headers.get('Cache-Control'), 'no-store');
    }

    const listed = await callOn(env, 'GET', `/console/workspaces/${id}/sites`, { token: people.owner.token });
    assert.deepEqual(
      ((await listed.json()) as { sites: { origin: string }[] }).sites.map((site) => site.origin).sort(),
      ['https://preview.client.fr', SITE],
    );
  });

  it('is refused to a member and a guest, and answered « not found » outside the workspace', async () => {
    const env = await world();
    const { id, evil, mallory, people } = await acme(env);

    for (const role of ['member', 'guest'] as const) {
      const answer = await add(env, await accountToken(env, people[role]), { workspace: id, origin: SITE });
      assert.equal(answer.status, 403, role);
      assert.deepEqual(await answer.json(), { error: 'forbidden', role });
    }
    // Mallory names Acme; Alice names Evil, which is Mallory's: no member, no answer about it.
    assert.equal((await add(env, await accountToken(env, mallory), { workspace: id, origin: SITE })).status, 404);
    assert.equal(
      (await add(env, await accountToken(env, people.owner), { workspace: evil, origin: SITE })).status,
      404,
    );
    assert.equal(
      (await add(env, await accountToken(env, people.owner), { workspace: 'org_none', origin: SITE })).status,
      404,
    );
    assert.deepEqual(await sitesOf(env, id), []);
    assert.deepEqual(await sitesOf(env, evil), []);
  });

  it('reads the role at each call: a person removed between two calls adds nothing more', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const token = await accountToken(env, people.admin);

    assert.equal((await add(env, token, { workspace: id, origin: SITE })).status, 201);
    await rowsOf(
      env.database,
      `DELETE FROM member WHERE "organizationId" = '${id}' AND "userId" = '${people.admin.id}'`,
    );

    assert.equal((await add(env, token, { workspace: id, origin: 'https://other.client.fr' })).status, 404);
    assert.deepEqual(
      (await sitesOf(env, id)).map((site) => site.origin),
      [SITE],
    );
  });

  it('takes a session of an account only: not a pairing, not an expired token, not nobody', async () => {
    const env = await world();
    const { id, people } = await acme(env);

    const { code } = await createPairing(env.sessions, { subject: people.owner.id, workspace: id });
    const paired = await redeemPairing(env.sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(paired.ok);
    const pairing = await add(env, paired.session.accessToken, { workspace: id, origin: SITE });
    assert.equal(pairing.status, 403);
    assert.deepEqual(await pairing.json(), { error: 'account-required' });

    // Signed by the worker, for an account, but of no session: no chain to read again.
    const minted = await mintAccessToken(
      { subject: people.owner.id, account: true },
      env.env.FRUITBACK_IDENTITY_SECRET as string,
      Date.now(),
    );
    assert.equal((await add(env, minted, { workspace: id, origin: SITE })).status, 401);
    const expired = await mintAccessToken(
      { subject: people.owner.id, account: true },
      env.env.FRUITBACK_IDENTITY_SECRET as string,
      Date.now() - 3 * 60 * 60 * 1000,
    );
    assert.equal((await add(env, expired, { workspace: id, origin: SITE })).status, 401);
    assert.equal((await add(env, undefined, { workspace: id, origin: SITE })).status, 401);
    assert.equal((await add(env, 'not.a.token', { workspace: id, origin: SITE })).status, 401);
    assert.deepEqual(await sitesOf(env, id), []);
  });

  it('makes a site of members whatever the body says, and keeps a site already there as it is', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const token = await accountToken(env, people.owner);

    const forged = await add(env, token, { workspace: id, origin: SITE, visibility: 'everyone', previews: true });
    assert.equal(forged.status, 201);
    assert.deepEqual(
      (await sitesOf(env, id)).map(({ origin, visibility }) => ({ origin, visibility })),
      [{ origin: SITE, visibility: 'members' }],
    );

    // A site of everyone, made in the console: added again from the popup, it stays one of everyone.
    await env.accounts.addSite(id, { origin: 'https://public.client.fr', visibility: 'everyone' });
    const again = await add(env, token, { workspace: id, origin: 'https://public.client.fr/some/page?x=1' });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { site: Site }).site.visibility, 'everyone');
    assert.equal(
      (await sitesOf(env, id)).find((site) => site.origin === 'https://public.client.fr')?.visibility,
      'everyone',
    );
  });

  it('adds one site when the same one is asked twice at the same instant', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const token = await accountToken(env, people.owner);

    const answers = await Promise.all([
      add(env, token, { workspace: id, origin: SITE }),
      add(env, token, { workspace: id, origin: SITE }),
    ]);
    // One made it, the other found it, or both reached the store at once: one row, either way.
    for (const answer of answers) assert.ok([200, 201].includes(answer.status), String(answer.status));
    assert.equal((await sitesOf(env, id)).length, 1);
    assert.equal((await sitesOf(env, id))[0]?.visibility, 'members');
  });

  it('adds the same address to its own workspace, and leaves the site of another workspace alone', async () => {
    const env = await world();
    const { id, evil, people } = await acme(env);
    await env.accounts.addSite(evil, { origin: SITE, visibility: 'everyone' });

    assert.equal((await add(env, await accountToken(env, people.owner), { workspace: id, origin: SITE })).status, 201);
    assert.deepEqual(
      (await sitesOf(env, evil)).map(({ origin, visibility }) => ({ origin, visibility })),
      [{ origin: SITE, visibility: 'everyone' }],
    );
  });

  it('refuses a page of a site, a plain http address that is not the loopback, and a body that is not one', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const token = await accountToken(env, people.owner);

    const page = await add(env, token, { workspace: id, origin: SITE }, { origin: 'https://evil.example' });
    assert.equal(page.status, 403);
    assert.deepEqual(await page.json(), { error: 'origin-not-allowed' });
    for (const origin of [
      'http://staging.client.fr',
      'javascript:alert(1)',
      'https://user:pass@client.fr',
      'ftp://client.fr',
      '',
    ]) {
      const answer = await add(env, token, { workspace: id, origin });
      assert.equal(answer.status, 400, origin);
    }
    assert.equal((await add(env, token, { workspace: id })).status, 400);
    assert.equal((await add(env, token, { origin: SITE })).status, 400);
    assert.equal((await add(env, token, [id, SITE])).status, 400);
    assert.equal((await add(env, token, { workspace: id, origin: SITE, pad: 'x'.repeat(3_000) })).status, 400);
    assert.deepEqual(await sitesOf(env, id), []);
    // The dev loop: the playground is a site like another.
    assert.equal((await add(env, token, { workspace: id, origin: 'http://localhost:5177' })).status, 201);
  });

  it('adds ten sites an hour per account, and counts the refused ones', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const token = await accountToken(env, people.owner);

    for (let index = 0; index < ADDS_PER_ACCOUNT; index += 1) {
      assert.equal((await add(env, token, { workspace: id, origin: `https://s${index}.client.fr` })).status, 201);
    }
    const over = await add(env, token, { workspace: id, origin: 'https://one-more.client.fr' });
    assert.equal(over.status, 429);
    assert.equal((await sitesOf(env, id)).length, ADDS_PER_ACCOUNT);
    // Another account has a count of its own.
    assert.equal(
      (await add(env, await accountToken(env, people.admin), { workspace: id, origin: 'https://admin.client.fr' }))
        .status,
      201,
    );
  });
});

describe('a session that ended, with the access token it still holds (FRU-255)', () => {
  it('adds no site after a log out: the write reads the session again', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const session = await connect(env, people.owner);
    assert.equal((await add(env, session.accessToken, { workspace: id, origin: SITE })).status, 201);

    const revoked = await callOn(env, 'POST', '/session/revoke', {
      origin: EXTENSION,
      body: { refreshToken: session.refreshToken },
    });
    assert.ok(revoked.status < 300, String(revoked.status));

    const refused = await add(env, session.accessToken, { workspace: id, origin: 'https://after.client.fr' });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: 'identity-required' });
    assert.deepEqual(
      (await sitesOf(env, id)).map((site) => site.origin),
      [SITE],
    );
  });

  it('adds no site once the browser is disconnected in the console', async () => {
    const env = await world();
    const { id, people } = await acme(env);
    const session = await connect(env, people.owner);
    const listed = await callOn(env, 'GET', '/console/me/browsers', { token: people.owner.token });
    const { browsers } = (await listed.json()) as { browsers: { id: string }[] };
    const cut = await callOn(env, 'DELETE', `/console/me/browsers/${browsers[0]?.id}`, { token: people.owner.token });
    assert.equal(cut.status, 204);

    assert.equal((await add(env, session.accessToken, { workspace: id, origin: SITE })).status, 401);
    assert.deepEqual(await sitesOf(env, id), []);
  });
});

describe('where the popup may add a site (FRU-255)', () => {
  it('says it for each workspace of the account, from the role read now', async () => {
    const env = await world();
    const { id, people } = await acme(env);

    for (const [role, expected] of [
      ['owner', true],
      ['admin', true],
      ['member', false],
      ['guest', false],
    ] as const) {
      const listed = await callOn(env, 'GET', '/session/sites', {
        origin: EXTENSION,
        token: await accountToken(env, people[role]),
      });
      const { workspaces } = (await listed.json()) as { workspaces: { id: string; canAddSite: boolean }[] };
      assert.equal(workspaces.find((each) => each.id === id)?.canAddSite, expected, role);
    }
  });
});

describe('the origin of a tab, as a site', () => {
  it('is https, or the loopback over http', () => {
    assert.equal(addableOrigin('https://client.fr/a/b?c#d'), 'https://client.fr');
    assert.equal(addableOrigin('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080');
    assert.equal(addableOrigin('http://client.fr'), undefined);
    assert.equal(addableOrigin(`https://${'a'.repeat(2_100)}.fr`), undefined);
  });
});

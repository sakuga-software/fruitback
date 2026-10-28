import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { CONSOLE, type World, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, digest, redeemPairing } from './session.ts';
import { placesOf } from './session-site-settings.ts';

/**
 * `POST /session/sites/settings` (FRU-453): the popup changes who sees the notes of a site and where
 * they go, on the screen that turns it on. Through `handleRequest`, on PostgreSQL (PGlite). Each
 * guard of `session-site-settings.ts` has a test here that fails without it.
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

function set(env: World, token: string | undefined, body: unknown, more: { origin?: string | null } = {}) {
  return callOn(env, 'POST', '/session/sites/settings', {
    origin: more.origin === undefined ? EXTENSION : more.origin,
    ...(token === undefined ? {} : { token }),
    body,
  });
}

/** Acme with two sites: the first sends to « REST API · Hook », the second to nowhere. */
async function withPlaces(env: World) {
  const world = await acme(env);
  const first = await env.accounts.addSite(world.id, { origin: SITE, visibility: 'members' });
  const second = await env.accounts.addSite(world.id, { origin: 'https://other.client.fr', visibility: 'members' });
  const hook = await env.accounts.addConnector(world.id, { kind: 'rest', label: 'Hook', sealed: 'sealed-1' });
  const place = { connector: hook.id, label: 'REST API · Hook' };
  assert.ok(await env.accounts.setDestinations(world.id, first.id, [place]));

  return { ...world, first, second, hook, place };
}

async function siteIn(env: World, workspace: string, id: string) {
  const found = (await env.accounts.sites(workspace)).find((each) => each.id === id);
  assert.ok(found);

  return found;
}

describe('who sees the notes and where they go, set from the popup (FRU-453)', () => {
  it('lists the places of the workspace to who manages its sites, and to nobody else', async () => {
    const env = await world();
    const { id, people, place } = await withPlaces(env);

    for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
      const answer = await callOn(env, 'GET', '/session/sites', {
        origin: EXTENSION,
        token: await accountToken(env, people[role]),
      });
      assert.equal(answer.status, 200, role);
      const { workspaces } = (await answer.json()) as { workspaces: { id: string; places?: unknown }[] };
      const acmeEntry = workspaces.find((each) => each.id === id);
      if (role === 'owner' || role === 'admin') assert.deepEqual(acmeEntry?.places, [place], role);
      else assert.equal(acmeEntry?.places, undefined, role);
    }
  });

  it('sets the visibility and the place of a site, for the owner and an admin', async () => {
    const env = await world();
    const { id, people, second, place } = await withPlaces(env);

    for (const role of ['owner', 'admin'] as const) {
      const token = await accountToken(env, people[role]);
      const answer = await set(env, token, { workspace: id, site: second.id, visibility: 'everyone', place });
      assert.equal(answer.status, 200, await answer.clone().text());
      assert.deepEqual(await answer.json(), {
        site: {
          id: second.id,
          origin: 'https://other.client.fr',
          visibility: 'everyone',
          workspace: id,
          destination: { label: 'REST API · Hook' },
        },
      });
      const stored = await siteIn(env, id, second.id);
      assert.equal(stored.visibility, 'everyone');
      assert.deepEqual(
        stored.destinations.map((each) => each.connector),
        [place.connector],
      );

      // Back to « Fruitback » and « Members only ».
      const back = await set(env, token, { workspace: id, site: second.id, visibility: 'members', place: null });
      assert.equal(back.status, 200);
      const again = await siteIn(env, id, second.id);
      assert.equal(again.visibility, 'members');
      assert.deepEqual(again.destinations, []);
    }
  });

  it('keeps the label the worker wrote, never the one of the body, and refuses a place no site sends to', async () => {
    const env = await world();
    const { id, people, second, hook } = await withPlaces(env);
    const token = await accountToken(env, people.owner);

    const answer = await set(env, token, {
      workspace: id,
      site: second.id,
      place: { connector: hook.id, label: 'Somewhere else' },
    });
    assert.equal(answer.status, 200);
    assert.equal((await siteIn(env, id, second.id)).destinations[0]?.label, 'REST API · Hook');

    const other = await env.accounts.addConnector(id, { kind: 'rest', label: 'Unused', sealed: 'sealed-2' });
    const unused = await set(env, token, { workspace: id, site: second.id, place: { connector: other.id } });
    assert.equal(unused.status, 400);
    assert.deepEqual(await unused.json(), { error: 'invalid-place' });
    // A bad place changes no visibility either.
    const both = await set(env, token, {
      workspace: id,
      site: second.id,
      visibility: 'everyone',
      place: { connector: other.id },
    });
    assert.equal(both.status, 400);
    assert.equal((await siteIn(env, id, second.id)).visibility, 'members');
  });

  it('puts the chosen place first and keeps the others, and does not empty a site of two places', async () => {
    const env = await world();
    const { id, people, first, place } = await withPlaces(env);
    const token = await accountToken(env, people.owner);
    const other = await env.accounts.addConnector(id, { kind: 'rest', label: 'Second', sealed: 'sealed-2' });
    const second = { connector: other.id, label: 'REST API · Second' };
    assert.ok(await env.accounts.setDestinations(id, first.id, [place, second]));

    assert.equal((await set(env, token, { workspace: id, site: first.id, place: second })).status, 200);
    assert.deepEqual(
      (await siteIn(env, id, first.id)).destinations.map((each) => each.connector),
      [other.id, place.connector],
    );

    const emptied = await set(env, token, { workspace: id, site: first.id, place: null });
    assert.equal(emptied.status, 409);
    assert.equal((await siteIn(env, id, first.id)).destinations.length, 2);
  });

  it('is refused to a member and a guest, and answered « not found » outside the workspace', async () => {
    const env = await world();
    const { id, evil, mallory, people, second } = await withPlaces(env);

    for (const role of ['member', 'guest'] as const) {
      const answer = await set(env, await accountToken(env, people[role]), {
        workspace: id,
        site: second.id,
        visibility: 'everyone',
      });
      assert.equal(answer.status, 403, role);
      assert.deepEqual(await answer.json(), { error: 'forbidden', role });
    }
    assert.equal(
      (await set(env, await accountToken(env, mallory), { workspace: id, site: second.id, visibility: 'everyone' }))
        .status,
      404,
    );
    // The site of Acme, named under Evil: Alice is no member there.
    assert.equal(
      (
        await set(env, await accountToken(env, people.owner), {
          workspace: evil,
          site: second.id,
          visibility: 'everyone',
        })
      ).status,
      404,
    );
    // Mallory names her own workspace and a site of Acme: not a site of hers.
    assert.equal(
      (await set(env, await accountToken(env, mallory), { workspace: evil, site: second.id, visibility: 'everyone' }))
        .status,
      404,
    );
    assert.equal((await siteIn(env, id, second.id)).visibility, 'members');
  });

  it('reads the role at each call: a person removed between two calls changes nothing more', async () => {
    const env = await world();
    const { id, people, second } = await withPlaces(env);
    const token = await accountToken(env, people.admin);

    assert.equal((await set(env, token, { workspace: id, site: second.id, visibility: 'everyone' })).status, 200);
    await rowsOf(
      env.database,
      `DELETE FROM member WHERE "organizationId" = '${id}' AND "userId" = '${people.admin.id}'`,
    );
    assert.equal((await set(env, token, { workspace: id, site: second.id, visibility: 'members' })).status, 404);
    assert.equal((await siteIn(env, id, second.id)).visibility, 'everyone');
  });

  it('changes nothing after a log out: the write reads the session again', async () => {
    const env = await world();
    const { id, people, second } = await withPlaces(env);
    const session = await connect(env, people.owner);
    assert.equal(
      (await set(env, session.accessToken, { workspace: id, site: second.id, visibility: 'everyone' })).status,
      200,
    );

    const revoked = await callOn(env, 'POST', '/session/revoke', {
      origin: EXTENSION,
      body: { refreshToken: session.refreshToken },
    });
    assert.ok(revoked.status < 300, String(revoked.status));

    const refused = await set(env, session.accessToken, { workspace: id, site: second.id, visibility: 'members' });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: 'identity-required' });
    assert.equal((await siteIn(env, id, second.id)).visibility, 'everyone');
  });

  it('takes a session of an account from an extension only, and a POST only', async () => {
    const env = await world();
    const { id, people, second } = await withPlaces(env);
    const body = { workspace: id, site: second.id, visibility: 'everyone' };

    const { code } = await createPairing(env.sessions, { subject: people.owner.id, workspace: id });
    const paired = await redeemPairing(env.sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(paired.ok);
    const pairing = await set(env, paired.session.accessToken, body);
    assert.equal(pairing.status, 403);
    assert.deepEqual(await pairing.json(), { error: 'account-required' });
    assert.equal((await set(env, undefined, body)).status, 401);

    const token = await accountToken(env, people.owner);
    const page = await set(env, token, body, { origin: 'https://evil.example' });
    assert.equal(page.status, 403);
    const read = await callOn(env, 'GET', '/session/sites/settings', { origin: EXTENSION, token });
    assert.equal(read.status, 405);
    for (const bad of [
      { workspace: id, site: second.id },
      { workspace: id, site: second.id, visibility: 'all' },
      'x',
    ]) {
      assert.equal((await set(env, token, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await siteIn(env, id, second.id)).visibility, 'members');
  });
});

describe('placesOf (FRU-453)', () => {
  it('lists each labelled place once, in the order of the sites', () => {
    const site = (destinations: { connector: string; teamId?: string; label?: string }[]) => ({
      id: 's',
      workspaceId: 'w',
      origin: 'https://a.test',
      visibility: 'members' as const,
      writers: 'members' as const,
      destinations,
    });
    assert.deepEqual(
      placesOf([
        site([{ connector: 'c1', teamId: 't', label: 'Linear · T' }, { connector: 'c2' }]),
        site([
          { connector: 'c1', teamId: 't', label: 'Linear · T' },
          { connector: 'c3', label: 'REST API · C' },
        ]),
      ] as never),
      [
        { connector: 'c1', teamId: 't', label: 'Linear · T' },
        { connector: 'c3', label: 'REST API · C' },
      ],
    );
  });
});

import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { CONSOLE, type World, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPairing, digest, redeemPairing } from './session.ts';

/**
 * `POST /session/sites/settings` and `GET /session/sites/places` (FRU-453): the popup changes who sees
 * the notes of a site and where they go, a provider, a team, a project, on the screen that turns it
 * on. Through `handleRequest`, on PostgreSQL (PGlite), with a Linear that answers here. Each guard of
 * `session-site-settings.ts` has a test here that fails without it.
 */

const LINEAR_KEY = 'lin_api_the_key_of_acme';
/** How the Linear of the suite answers now. */
const linearState = { down: false };

afterEach(() => {
  vi.restoreAllMocks();
  linearState.down = false;
});

/** Linear with two teams: Design, with its project Site, and Support with none. */
function linear(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (linearState.down) return Response.json({ errors: [{ message: 'later' }] }, { status: 500 });
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    if (!/FruitbackTeams/.test(query)) return Response.json({ data: {} });

    return Response.json({
      data: {
        viewer: { name: 'Camille' },
        organization: { name: 'Acme' },
        teams: {
          nodes: [
            {
              id: 'team_design',
              name: 'Design',
              key: 'DES',
              private: false,
              projects: {
                nodes: [{ id: 'proj_site', name: 'Site', status: { name: 'In Progress', type: 'started' } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
            {
              id: 'team_support',
              name: 'Support',
              key: 'SUP',
              projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  });
}

const opened = worlds();
const world = () => opened({ env: { FRUITBACK_SECRETS_KEY: 'another-secret-that-opens-the-connectors' } });

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

function places(env: World, token: string, workspace: string, connector: string, origin: string = EXTENSION) {
  return callOn(env, 'GET', `/session/sites/places?workspace=${workspace}&connector=${connector}`, { origin, token });
}

/** Acme with two sites, a Linear and an address. The first site sends to the address. */
async function withSources(env: World) {
  linear();
  const world = await acme(env);
  const first = await env.accounts.addSite(world.id, { origin: SITE, visibility: 'members' });
  const second = await env.accounts.addSite(world.id, { origin: 'https://other.client.fr', visibility: 'members' });
  const hook = await env.accounts.addConnector(world.id, { kind: 'rest', label: 'Hook', sealed: 'sealed-1' });
  const added = await callOn(env, 'POST', `/console/workspaces/${world.id}/connectors`, {
    token: world.people.owner.token,
    body: { kind: 'linear', apiKey: LINEAR_KEY },
  });
  assert.equal(added.status, 201, await added.clone().text());
  const lin = ((await added.json()) as { id: string }).id;
  assert.ok(await env.accounts.setDestinations(world.id, first.id, [{ connector: hook.id, label: 'REST API · Hook' }]));

  return { ...world, first, second, hook, lin };
}

async function siteIn(env: World, workspace: string, id: string) {
  const found = (await env.accounts.sites(workspace)).find((each) => each.id === id);
  assert.ok(found);

  return found;
}

describe('who sees the notes and where they go, set from the popup (FRU-453)', () => {
  it('lists the sources of the workspace and where each site sends, to who manages its sites only', async () => {
    const env = await world();
    const { id, people, hook, lin, first, second } = await withSources(env);

    for (const role of ['owner', 'admin', 'member', 'guest'] as const) {
      const answer = await callOn(env, 'GET', '/session/sites', {
        origin: EXTENSION,
        token: await accountToken(env, people[role]),
      });
      assert.equal(answer.status, 200, role);
      const listed = (await answer.json()) as {
        workspaces: { id: string; sources?: unknown }[];
        sites: { id: string; place?: unknown }[];
      };
      const acmeEntry = listed.workspaces.find((each) => each.id === id);
      if (role === 'owner' || role === 'admin') {
        assert.deepEqual(
          acmeEntry?.sources,
          [
            { id: hook.id, kind: 'rest', label: 'Hook' },
            { id: lin, kind: 'linear', label: 'Linear · Camille' },
          ],
          role,
        );
        assert.deepEqual(listed.sites.find((each) => each.id === first.id)?.place, { connector: hook.id });
        assert.equal(listed.sites.find((each) => each.id === second.id)?.place, null);
      } else {
        assert.equal(acmeEntry?.sources, undefined, role);
        assert.equal(listed.sites.find((each) => each.id === first.id)?.place, undefined, role);
      }
    }
  });

  it('answers the teams of a Linear with their projects, and nothing to choose for an address', async () => {
    const env = await world();
    const { id, people, hook, lin, evil, mallory } = await withSources(env);
    const token = await accountToken(env, people.admin);

    const teams = await places(env, token, id, lin);
    assert.equal(teams.status, 200, await teams.clone().text());
    const offer = (await teams.json()) as { kind: string; teams: { id: string; projects: { id: string }[] }[] };
    assert.equal(offer.kind, 'linear');
    assert.deepEqual(
      offer.teams.map((team) => [team.id, team.projects.map((project) => project.id)]),
      [
        ['team_design', ['proj_site']],
        ['team_support', []],
      ],
    );
    assert.deepEqual(await (await places(env, token, id, hook.id)).json(), { kind: 'rest' });
    // A connector named under another workspace, a member, a page, a Linear that does not answer.
    assert.equal((await places(env, await accountToken(env, mallory), evil, lin)).status, 404);
    assert.equal((await places(env, token, id, 'conn_none')).status, 404);
    assert.equal((await places(env, await accountToken(env, people.member), id, lin)).status, 403);
    assert.equal((await places(env, token, id, lin, 'https://evil.example')).status, 403);
    linearState.down = true;
    assert.equal((await places(env, token, id, lin)).status, 502);
  });

  it('sets a team and a project of Linear, with the words Linear answers, and the visibility', async () => {
    const env = await world();
    const { id, people, second, lin } = await withSources(env);
    const token = await accountToken(env, people.owner);

    const answer = await set(env, token, {
      workspace: id,
      site: second.id,
      visibility: 'everyone',
      place: { connector: lin, teamId: 'team_design', projectId: 'proj_site', label: 'Somewhere else' },
    });
    assert.equal(answer.status, 200, await answer.clone().text());
    assert.deepEqual(await answer.json(), {
      site: {
        id: second.id,
        origin: 'https://other.client.fr',
        visibility: 'everyone',
        workspace: id,
        destination: { label: 'Linear · Design · Site' },
      },
    });
    const stored = await siteIn(env, id, second.id);
    assert.equal(stored.visibility, 'everyone');
    assert.deepEqual(
      stored.destinations.map(({ connector, teamId, projectId, label }) => ({ connector, teamId, projectId, label })),
      [{ connector: lin, teamId: 'team_design', projectId: 'proj_site', label: 'Linear · Design · Site' }],
    );

    // The team alone, then back to « Fruitback » and « Members only ».
    assert.equal(
      (await set(env, token, { workspace: id, site: second.id, place: { connector: lin, teamId: 'team_support' } }))
        .status,
      200,
    );
    assert.equal((await siteIn(env, id, second.id)).destinations[0]?.label, 'Linear · Support');
    assert.equal(
      (await set(env, token, { workspace: id, site: second.id, visibility: 'members', place: null })).status,
      200,
    );
    const back = await siteIn(env, id, second.id);
    assert.equal(back.visibility, 'members');
    assert.deepEqual(back.destinations, []);
  });

  it('refuses a place the key does not reach, and changes nothing when Linear does not answer', async () => {
    const env = await world();
    const { id, people, second, lin, hook } = await withSources(env);
    const token = await accountToken(env, people.owner);

    for (const place of [
      { connector: lin, teamId: 'team_none' },
      { connector: lin, teamId: 'team_design', projectId: 'proj_none' },
      { connector: lin },
      { connector: hook.id, teamId: 'team_design' },
      { connector: 'conn_none' },
    ]) {
      const refused = await set(env, token, { workspace: id, site: second.id, visibility: 'everyone', place });
      assert.equal(refused.status, 400, JSON.stringify(place));
      assert.deepEqual(await refused.json(), { error: 'invalid-place' });
    }
    linearState.down = true;
    const down = await set(env, token, {
      workspace: id,
      site: second.id,
      visibility: 'everyone',
      place: { connector: lin, teamId: 'team_design' },
    });
    assert.equal(down.status, 502);
    const kept = await siteIn(env, id, second.id);
    assert.equal(kept.visibility, 'members');
    assert.deepEqual(kept.destinations, []);
  });

  it('refuses a connector of another workspace', async () => {
    const env = await world();
    const { id, people, second, evil } = await withSources(env);
    const theirs = await env.accounts.addConnector(evil, { kind: 'rest', label: 'Theirs', sealed: 'sealed-9' });

    const answer = await set(env, await accountToken(env, people.owner), {
      workspace: id,
      site: second.id,
      place: { connector: theirs.id },
    });
    assert.equal(answer.status, 400);
    assert.deepEqual((await siteIn(env, id, second.id)).destinations, []);
  });

  it('replaces the default place and keeps the others, and does not empty a site of two places', async () => {
    const env = await world();
    const { id, people, first, hook, lin } = await withSources(env);
    const token = await accountToken(env, people.owner);
    const other = await env.accounts.addConnector(id, { kind: 'rest', label: 'Second', sealed: 'sealed-2' });
    assert.ok(
      await env.accounts.setDestinations(id, first.id, [
        { connector: hook.id, label: 'REST API · Hook' },
        { connector: other.id, label: 'REST API · Second' },
      ]),
    );

    assert.equal(
      (await set(env, token, { workspace: id, site: first.id, place: { connector: lin, teamId: 'team_design' } }))
        .status,
      200,
    );
    assert.deepEqual(
      (await siteIn(env, id, first.id)).destinations.map((each) => each.connector),
      [lin, other.id],
    );
    // The second place chosen as the default: it is not there twice.
    assert.equal(
      (await set(env, token, { workspace: id, site: first.id, place: { connector: other.id } })).status,
      200,
    );
    assert.deepEqual(
      (await siteIn(env, id, first.id)).destinations.map((each) => each.connector),
      [other.id],
    );

    assert.ok(
      await env.accounts.setDestinations(id, first.id, [
        { connector: hook.id, label: 'REST API · Hook' },
        { connector: other.id, label: 'REST API · Second' },
      ]),
    );
    const emptied = await set(env, token, { workspace: id, site: first.id, place: null });
    assert.equal(emptied.status, 409);
    assert.equal((await siteIn(env, id, first.id)).destinations.length, 2);
  });

  it('is refused to a member and a guest, and answered « not found » outside the workspace', async () => {
    const env = await world();
    const { id, evil, mallory, people, second } = await withSources(env);

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
    assert.equal(
      (await set(env, await accountToken(env, mallory), { workspace: evil, site: second.id, visibility: 'everyone' }))
        .status,
      404,
    );
    assert.equal((await siteIn(env, id, second.id)).visibility, 'members');
  });

  it('reads the role at each call: a person removed between two calls changes nothing more', async () => {
    const env = await world();
    const { id, people, second } = await withSources(env);
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
    const { id, people, second } = await withSources(env);
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

  it('takes a session of an account from an extension only, and the method of each route only', async () => {
    const env = await world();
    const { id, people, second, lin } = await withSources(env);
    const body = { workspace: id, site: second.id, visibility: 'everyone' };

    const { code } = await createPairing(env.sessions, { subject: people.owner.id, workspace: id });
    const paired = await redeemPairing(env.sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(paired.ok);
    const pairing = await set(env, paired.session.accessToken, body);
    assert.equal(pairing.status, 403);
    assert.deepEqual(await pairing.json(), { error: 'account-required' });
    assert.equal((await places(env, paired.session.accessToken, id, lin)).status, 403);
    assert.equal((await set(env, undefined, body)).status, 401);

    const token = await accountToken(env, people.owner);
    assert.equal((await set(env, token, body, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await callOn(env, 'GET', '/session/sites/settings', { origin: EXTENSION, token })).status, 405);
    assert.equal(
      (
        await callOn(env, 'POST', `/session/sites/places?workspace=${id}&connector=${lin}`, {
          origin: EXTENSION,
          token,
        })
      ).status,
      405,
    );
    for (const bad of [
      { workspace: id, site: second.id },
      { workspace: id, site: second.id, visibility: 'all' },
      { workspace: id, site: second.id, place: 'x' },
      'x',
    ]) {
      assert.equal((await set(env, token, bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await siteIn(env, id, second.id)).visibility, 'members');
  });
});

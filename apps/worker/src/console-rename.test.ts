import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { Auth } from './auth.ts';
import { CONSOLE, type World, callOn, memberOf, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { redeemPairing, refreshSession } from './session.ts';

/**
 * The name of a workspace, changed by who manages it (FRU-236): `POST /console/workspaces/<id>`,
 * through `handleRequest`, on PostgreSQL (PGlite), with better-auth on. The route of the organization
 * plugin that does the same and more (`/organization/update`) stays closed.
 */

const world = worlds();

type Me = { workspaces: { id: string; name: string; role: string }[] };

async function namesOf(env: World, token: string): Promise<Record<string, string>> {
  const me = (await (await callOn(env, 'GET', '/console/me', { token })).json()) as Me;

  return Object.fromEntries(me.workspaces.map((each) => [each.id, each.name]));
}

/** Alice owns Acme, with one person of each other role in it; Mallory owns another workspace. */
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
  const other = await workspaceIn(env, mallory.token, 'Evil');
  const rename = (token: string | undefined, name: unknown, more: { origin?: string | null } = {}) =>
    callOn(env, 'POST', `/console/workspaces/${id}`, {
      ...(token === undefined ? {} : { token }),
      body: { name },
      ...more,
    });

  return {
    id,
    other,
    alice,
    mallory,
    people: people as Record<'owner' | 'admin' | 'member' | 'guest', typeof alice>,
    rename,
  };
}

describe('renaming a workspace (FRU-236)', () => {
  it('lets the owner and an admin rename it, and answers the workspace with their role', async () => {
    const env = await world();
    const { id, people, rename } = await acme(env);

    for (const [role, name] of [
      ['owner', 'Acme Outdoor'],
      ['admin', 'Acme Studio'],
    ] as const) {
      const answer = await rename(people[role].token, name);
      assert.equal(answer.status, 200, role);
      assert.deepEqual(await answer.json(), { id, name, role, logo: null }, role);
      // At once, for everybody of the workspace: nothing keeps the name of before.
      for (const reader of Object.values(people)) assert.equal((await namesOf(env, reader.token))[id], name, role);
    }
    assert.deepEqual(await rowsOf(env.database, `SELECT name FROM organization WHERE id = '${id}'`), [
      { name: 'Acme Studio' },
    ]);
  });

  it('refuses a member and a guest as the other routes of who manages a workspace do, and changes nothing', async () => {
    const env = await world();
    const { id, alice, people, rename } = await acme(env);

    for (const role of ['member', 'guest'] as const) {
      const answer = await rename(people[role].token, 'Taken over');
      assert.equal(answer.status, 403, role);
      assert.deepEqual(await answer.json(), { error: 'forbidden', role }, role);
      // The same refusal as a route that already asks for `manage-workspace`.
      const connectors = await callOn(env, 'POST', `/console/workspaces/${id}/connectors`, {
        token: people[role].token,
        body: {},
      });
      assert.equal(connectors.status, 403, role);
    }
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
  });

  it('answers a workspace somebody is not of as one that does not exist, and nobody without a session', async () => {
    const env = await world();
    const { id, other, alice, mallory, rename } = await acme(env);

    // Somebody of another workspace, by the id of this one.
    const stranger = await rename(mallory.token, 'Evil too');
    assert.equal(stranger.status, 404);
    assert.deepEqual(await stranger.json(), { error: 'not-found' });
    // An id nothing has answers the same.
    const missing = await callOn(env, 'POST', '/console/workspaces/ws_00000000000000000000', {
      token: mallory.token,
      body: { name: 'Nothing' },
    });
    assert.equal(missing.status, 404);
    // The owner of Acme does not rename the workspace of Mallory either.
    const reverse = await callOn(env, 'POST', `/console/workspaces/${other}`, {
      token: alice.token,
      body: { name: 'Good' },
    });
    assert.equal(reverse.status, 404);

    assert.equal((await rename(undefined, 'Nobody')).status, 401);
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
    assert.equal((await namesOf(env, mallory.token))[other], 'Evil');
  });

  it('refuses the token of an extension of the workspace, and a token in Authorization of any kind', async () => {
    const env = await world();
    const { id, alice, rename } = await acme(env);
    const connect = await callOn(env, 'POST', `/console/workspaces/${id}/connect`, { token: alice.token, body: {} });
    const { code } = (await connect.json()) as { code: string };
    const paired = await redeemPairing(env.sessions, code, env.env.FRUITBACK_IDENTITY_SECRET as string);
    assert.ok(paired.ok);

    // `callOn` sends a token that is not the cookie in `Authorization`: the extension of the owner.
    for (const token of [paired.session.accessToken, paired.session.refreshToken]) {
      assert.equal((await rename(token, 'By an extension')).status, 401);
    }
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
  });

  it('takes a change from the console only: no Origin, another origin, and the origin of the worker are refused', async () => {
    const env = await world();
    const { id, alice, rename } = await acme(env);

    for (const origin of [
      null,
      'https://evil.example',
      'https://demo.fruitback.test',
      'https://api.fruitback.test',
      'null',
    ]) {
      const answer = await rename(alice.token, 'From elsewhere', { origin });
      assert.equal(answer.status, 403, String(origin));
      assert.deepEqual(await answer.json(), { error: 'origin-not-allowed' }, String(origin));
      assert.equal(answer.headers.get('Access-Control-Allow-Origin'), null, String(origin));
    }
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
    // The control: the console.
    const taken = await rename(alice.token, 'From the console', { origin: CONSOLE });
    assert.equal(taken.status, 200);
    assert.equal(taken.headers.get('Access-Control-Allow-Origin'), CONSOLE);
  });

  it('keeps the rule of a name that the creation has: one line, 1 to 80 characters, with its code', async () => {
    const env = await world();
    const { id, alice, rename } = await acme(env);

    for (const name of ['', '   ', '\n\t', 'x'.repeat(81), 42, null, ['Acme'], { name: 'Acme' }, undefined]) {
      const answer = await rename(alice.token, name);
      assert.equal(answer.status, 400, JSON.stringify(name));
      assert.deepEqual(await answer.json(), { error: 'invalid-name' }, JSON.stringify(name));
      // The creation refuses the same value with the same code.
      const created = await callOn(env, 'POST', '/console/workspaces', { token: alice.token, body: { name } });
      assert.equal(created.status, 400, JSON.stringify(name));
      assert.deepEqual(await created.json(), { error: 'invalid-name' }, JSON.stringify(name));
    }
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');

    for (const [sent, kept] of [
      ['x'.repeat(80), 'x'.repeat(80)],
      // Two lines, and spaces around: one line, as the creation writes it.
      ['  Sakuga \n studio  ', 'Sakuga studio'],
      ['<b>Acme</b> & "co"', '<b>Acme</b> & "co"'],
      ['Ünïcödé 工作室 🍓', 'Ünïcödé 工作室 🍓'],
      ['A', 'A'],
    ] as const) {
      const answer = await rename(alice.token, sent);
      assert.equal(answer.status, 200, sent);
      assert.equal(((await answer.json()) as { name: string }).name, kept, sent);
      assert.equal((await namesOf(env, alice.token))[id], kept, sent);
    }
    // No name is unique: two workspaces of one person can have the same one, as at the creation.
    const twin = await workspaceIn(env, alice.token, 'Twin');
    assert.equal(
      (await callOn(env, 'POST', `/console/workspaces/${twin}`, { token: alice.token, body: { name: 'A' } })).status,
      200,
    );
  });

  it('moves nothing else: the id, the sites, the members, and the extensions that are paired', async () => {
    const env = await world();
    const { id, alice, people, rename } = await acme(env);
    const site = await callOn(env, 'POST', `/console/workspaces/${id}/sites`, {
      token: alice.token,
      body: { url: 'https://staging.acme.dev' },
    });
    assert.equal(site.status, 201);
    const connect = await callOn(env, 'POST', `/console/workspaces/${id}/connect`, { token: alice.token, body: {} });
    const { code } = (await connect.json()) as { code: string };
    const secret = env.env.FRUITBACK_IDENTITY_SECRET as string;
    const paired = await redeemPairing(env.sessions, code, secret);
    assert.ok(paired.ok);
    const read = async () => ({
      sites: await (await callOn(env, 'GET', `/console/workspaces/${id}/sites`, { token: alice.token })).json(),
      members: await rowsOf(
        env.database,
        `SELECT "userId", role FROM member WHERE "organizationId" = '${id}' ORDER BY "userId"`,
      ),
      row: await rowsOf(env.database, `SELECT id, slug, logo, metadata FROM organization WHERE id = '${id}'`),
      forSites: (await callOn(env, 'GET', '/session/sites', { token: paired.session.accessToken, origin: null }))
        .status,
    });
    const before = await read();

    assert.equal((await rename(people.admin.token, 'Acme, renamed')).status, 200);

    assert.deepEqual(await read(), before);
    assert.equal(before.forSites, 200);
    // The session of the extension goes on: its next refresh answers a token.
    const refreshed = await refreshSession(env.sessions, paired.session.refreshToken, secret);
    assert.ok(refreshed.ok);
  });

  it('takes POST on a workspace to rename it and DELETE to delete it, and no other method', async () => {
    const env = await world();
    const { id, alice } = await acme(env);

    for (const method of ['GET', 'PUT', 'PATCH']) {
      const answer = await callOn(env, method, `/console/workspaces/${id}`, { token: alice.token });
      assert.equal(answer.status, 405, method);
    }
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
  });

  it('answers 502 and keeps the name when better-auth does not write it, and hands it the name only', async () => {
    const env = await world();
    const { id, alice } = await acme(env);
    const asked: unknown[] = [];
    const real = env.auth;
    // better-auth as it is, but for the one call that renames.
    const refusing = {
      ...real,
      api: {
        ...real.api,
        updateOrganization: async (input: { body: unknown }) => {
          asked.push(input.body);
          throw new Error('a failure of better-auth');
        },
      },
    } as unknown as Auth;

    const answer = await callOn(
      env,
      'POST',
      `/console/workspaces/${id}`,
      {
        token: alice.token,
        body: { name: 'Acme Outdoor', slug: 'taken', logo: 'https://evil.example/x.png', metadata: {} },
      },
      { auth: refusing },
    );

    assert.equal(answer.status, 502);
    assert.deepEqual(await answer.json(), { error: 'auth-unavailable' });
    // What the body of the request held beside the name went nowhere.
    assert.deepEqual(asked, [{ organizationId: id, data: { name: 'Acme Outdoor' } }]);
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
  });

  it('leaves the route of the plugin closed: /organization/update answers 404 to the owner', async () => {
    const env = await world();
    const { id, alice } = await acme(env);

    const answer = await callOn(env, 'POST', '/console/auth/organization/update', {
      token: alice.token,
      body: { organizationId: id, data: { name: 'By the plugin', slug: 'a-slug' } },
    });

    assert.equal(answer.status, 404);
    assert.equal((await namesOf(env, alice.token))[id], 'Acme');
  });
});

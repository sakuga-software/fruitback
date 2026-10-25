import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { ACTIONS, ROLES, type Role, can } from './accounts.ts';
import {
  callOn as call,
  memberOf,
  signInTo as signIn,
  workspaceIn as workspaceOf,
  worlds,
  type World,
} from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';

/**
 * The routes of the console, called as the console calls them: with the cookie of a session of
 * better-auth, on a worker whose accounts are in PostgreSQL (PGlite). Until FRU-150 these cases ran on
 * an accounts file and the token of the sign-in of before.
 */

const SITE = 'https://staging.acme.test';
const envWith = worlds();

describe('the console API (FRU-99)', () => {
  it('answers the account and its workspaces, and nobody without a session', async () => {
    const env = await envWith();
    const alice = await signIn(env, 'alice@acme.dev');

    assert.equal((await call(env, 'GET', '/console/me')).status, 401);
    const before = (await (await call(env, 'GET', '/console/me', { token: alice.token })).json()) as {
      account: { email: string };
      workspaces: unknown[];
    };
    assert.equal(before.account.email, 'alice@acme.dev');
    assert.deepEqual(before.workspaces, []);

    const id = await workspaceOf(env, alice.token, '  Sakuga  studio ');
    const after = (await (await call(env, 'GET', '/console/me', { token: alice.token })).json()) as {
      workspaces: unknown[];
    };
    assert.deepEqual(after.workspaces, [{ id, name: 'Sakuga studio', role: 'owner', logo: null, suspended: false }]);
  });

  it('refuses a workspace with no name, or a name nobody can read on one line', async () => {
    const env = await envWith();
    const { token } = await signIn(env, 'alice@acme.dev');

    assert.equal((await call(env, 'POST', '/console/workspaces', { token, body: { name: '   ' } })).status, 400);
    assert.equal(
      (await call(env, 'POST', '/console/workspaces', { token, body: { name: 'x'.repeat(81) } })).status,
      400,
    );
  });

  it('adds the site a person pasted, by its origin, read by members unless they say everyone', async () => {
    const env = await envWith();
    const { token } = await signIn(env, 'alice@acme.dev');
    const id = await workspaceOf(env, token);

    const added = await call(env, 'POST', `/console/workspaces/${id}/sites`, {
      token,
      body: { url: `${SITE}/pricing?tab=2` },
    });
    assert.equal(added.status, 201);
    const site = (await added.json()) as { id: string; origin: string; visibility: string };
    assert.deepEqual({ origin: site.origin, visibility: site.visibility }, { origin: SITE, visibility: 'members' });

    const listed = (await (await call(env, 'GET', `/console/workspaces/${id}/sites`, { token })).json()) as {
      sites: unknown[];
    };
    assert.deepEqual(listed.sites, [site]);

    assert.equal(
      (await call(env, 'POST', `/console/workspaces/${id}/sites`, { token, body: { url: 'not a url' } })).status,
      400,
    );
    assert.equal(
      (await call(env, 'POST', `/console/workspaces/${id}/sites`, { token, body: { url: SITE, visibility: 'all' } }))
        .status,
      400,
    );
    assert.equal((await call(env, 'DELETE', `/console/workspaces/${id}/sites/${site.id}`, { token })).status, 204);
    assert.equal((await call(env, 'DELETE', `/console/workspaces/${id}/sites/${site.id}`, { token })).status, 404);
  });

  it('answers a workspace somebody is not a member of as one that does not exist', async () => {
    const env = await envWith();
    const alice = await signIn(env, 'alice@acme.dev');
    const mallory = await signIn(env, 'mallory@evil.dev');
    const id = await workspaceOf(env, alice.token);

    for (const [method, path] of [
      ['GET', `/console/workspaces/${id}/sites`],
      ['POST', `/console/workspaces/${id}/connect`],
      ['DELETE', `/console/workspaces/${id}`],
    ] as const) {
      const response = await call(env, method, path, {
        token: mallory.token,
        body: method === 'POST' ? {} : undefined,
      });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  });

  for (const role of ROLES) {
    it(`lets a ${role} do what the table says, and nothing more`, async () => {
      const env = await envWith();
      const owner = await signIn(env, 'owner@acme.dev');
      const person = await signIn(env, `${role}@acme.dev`);
      const id = await workspaceOf(env, owner.token);
      if (role !== 'owner') {
        // The row an accepted invitation leaves, for each role, a guest included.
        await memberOf(env, id, person.id, role);
      }
      const token = role === 'owner' ? owner.token : person.token;
      const status = async (method: string, path: string, body?: unknown): Promise<number> =>
        (await call(env, method, `/console/workspaces/${id}${path}`, { token, body })).status;

      const expect = (action: (typeof ACTIONS)[number], yes: number) => (can(role as Role, action) ? yes : 403);
      assert.equal(await status('GET', '/sites'), expect('read-feedback', 200));
      assert.equal(await status('POST', '/sites', { url: SITE }), expect('manage-sites', 201));
      assert.equal(await status('POST', '/connect', {}), expect('read-feedback', 201));
      assert.equal(await status('DELETE', ''), expect('delete-workspace', 204));
    });
  }
});

describe('the pairing code of « Connect this browser », on Fruitback Cloud (FRU-325)', () => {
  // The control is a worker of another host: the same call mints a code there.
  for (const [publicUrl, status] of [
    ['https://api.fruitback.com', 404],
    ['https://api.fruitback.test', 201],
  ] as const) {
    it(`answers ${status} on a worker at ${publicUrl}`, async () => {
      const env = await envWith({ env: { FRUITBACK_PUBLIC_URL: publicUrl } });
      const alice = await signIn(env, 'alice@acme.dev');
      const id = await workspaceOf(env, alice.token);

      const minted = await call(env, 'POST', `/console/workspaces/${id}/connect`, { token: alice.token, body: {} });

      assert.equal(minted.status, status, await minted.clone().text());
    });
  }
});

describe('from a link in a mailbox to a note on the page (FRU-99, FRU-100)', () => {
  it('signs in, creates a workspace, adds a site, connects a browser, and that browser writes and reads there', async () => {
    const env = await envWith();
    const alice = await signIn(env, 'alice@acme.dev');
    const id = await workspaceOf(env, alice.token);
    const site = (await (
      await call(env, 'POST', `/console/workspaces/${id}/sites`, { token: alice.token, body: { url: SITE } })
    ).json()) as { id: string };

    const connect = (await (
      await call(env, 'POST', `/console/workspaces/${id}/connect`, { token: alice.token, body: {} })
    ).json()) as { code: string };
    // The extension spends the code on the pairing route, as it does for a code an operator minted.
    const paired = await call(env, 'POST', '/session/pair', {
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      body: { code: connect.code },
    });
    assert.equal(paired.status, 200);
    const session = (await paired.json()) as { accessToken: string };

    const note = noteFixture();
    const written = await call(env, 'POST', '/feedback', {
      origin: SITE,
      token: session.accessToken,
      body: { ...note, page: { ...note.page, url: `${SITE}/pricing` }, client: { id: site.id } },
    });
    assert.equal(written.status, 201, await written.clone().text());

    const read = await call(env, 'GET', `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${site.id}`, {
      origin: SITE,
      token: session.accessToken,
    });
    assert.equal(read.status, 200);
    const issues = ((await read.json()) as { issues: { note: { reporter?: { id?: string; verified?: boolean } } }[] })
      .issues;
    assert.equal(issues.length, 1);
    assert.deepEqual(
      { id: issues[0]?.note.reporter?.id, verified: issues[0]?.note.reporter?.verified },
      { id: alice.id, verified: true },
    );

    // The control: the console session itself names no workspace, so it reads no site.
    const fromConsole = await call(
      env,
      'GET',
      `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${site.id}`,
      {
        origin: SITE,
        token: alice.token,
      },
    );
    assert.equal(fromConsole.status, 401);
  });

  it('keeps the browser of another workspace off the site', async () => {
    const env = await envWith();
    const alice = await signIn(env, 'alice@acme.dev');
    const mallory = await signIn(env, 'mallory@evil.dev');
    const acme = await workspaceOf(env, alice.token, 'Acme');
    const evil = await workspaceOf(env, mallory.token, 'Evil');
    const site = (await (
      await call(env, 'POST', `/console/workspaces/${acme}/sites`, { token: alice.token, body: { url: SITE } })
    ).json()) as { id: string };
    const connect = (await (
      await call(env, 'POST', `/console/workspaces/${evil}/connect`, { token: mallory.token, body: {} })
    ).json()) as { code: string };
    const paired = (await (
      await call(env, 'POST', '/session/pair', {
        origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
        body: { code: connect.code },
      })
    ).json()) as { accessToken: string };

    const read = await call(env, 'GET', `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${site.id}`, {
      origin: SITE,
      token: paired.accessToken,
    });
    assert.equal(read.status, 401);
  });
});

/**
 * The access token of an extension, against each route of the console it opened before FRU-202.
 * Since FRU-150 the console API reads no token at all, only the cookie of a session: these cases
 * hold that a token signed with the key of the worker still opens nothing here.
 *
 * Alice owns A and B, and pairs an extension for A. Each case also shows that the console session
 * of Alice is still served, so a refusal is about the token and not about the route.
 */
describe('the token of an extension on the console API (FRU-202)', () => {
  async function extensionOf(): Promise<{
    env: World;
    alice: { id: string; token: string };
    a: string;
    b: string;
    token: string;
  }> {
    const env = await envWith();
    const alice = await signIn(env, 'alice@acme.dev');
    const a = await workspaceOf(env, alice.token, 'A');
    const b = await workspaceOf(env, alice.token, 'B');
    const connect = (await (
      await call(env, 'POST', `/console/workspaces/${a}/connect`, { token: alice.token, body: {} })
    ).json()) as { code: string };
    const paired = await call(env, 'POST', '/session/pair', {
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
      body: { code: connect.code },
    });
    assert.equal(paired.status, 200);
    const token = ((await paired.json()) as { accessToken: string }).accessToken;
    // The control: this token is good where it belongs, the notes of a site of A.
    const site = (await (
      await call(env, 'POST', `/console/workspaces/${a}/sites`, { token: alice.token, body: { url: SITE } })
    ).json()) as { id: string };
    const read = await call(env, 'GET', `/feedback?url=${encodeURIComponent(`${SITE}/`)}&client=${site.id}`, {
      origin: SITE,
      token,
    });
    assert.equal(read.status, 200);

    return { env, alice, a, b, token };
  }

  async function sitesOf(env: World, token: string, workspace: string): Promise<unknown[]> {
    const answer = await call(env, 'GET', `/console/workspaces/${workspace}/sites`, { token });
    assert.equal(answer.status, 200);

    return ((await answer.json()) as { sites: unknown[] }).sites;
  }

  it('refuses GET /console/me to the token of an extension', async () => {
    const { env, alice, token } = await extensionOf();

    const refused = await call(env, 'GET', '/console/me', { token });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: 'identity-required' });
    assert.equal((await call(env, 'GET', '/console/me', { token: alice.token })).status, 200);
  });

  it('refuses POST /console/workspaces to the token of an extension, and creates nothing', async () => {
    const { env, alice, token } = await extensionOf();

    assert.equal((await call(env, 'POST', '/console/workspaces', { token, body: { name: 'C' } })).status, 401);
    const me = (await (await call(env, 'GET', '/console/me', { token: alice.token })).json()) as {
      workspaces: unknown[];
    };
    assert.equal(me.workspaces.length, 2);
  });

  it('refuses DELETE of its own workspace to the token of an extension, and the workspace stays', async () => {
    const { env, alice, a, b, token } = await extensionOf();

    assert.equal((await call(env, 'DELETE', `/console/workspaces/${a}`, { token })).status, 401);
    assert.equal((await call(env, 'DELETE', `/console/workspaces/${b}`, { token })).status, 401);
    assert.equal((await sitesOf(env, alice.token, a)).length, 1);
    assert.equal((await sitesOf(env, alice.token, b)).length, 0);
  });

  it('refuses the sites of another workspace, and of its own, to the token of an extension', async () => {
    const { env, alice, a, b, token } = await extensionOf();

    for (const workspace of [a, b]) {
      assert.equal((await call(env, 'GET', `/console/workspaces/${workspace}/sites`, { token })).status, 401);
      const added = await call(env, 'POST', `/console/workspaces/${workspace}/sites`, {
        token,
        body: { url: 'https://other.acme.test' },
      });
      assert.equal(added.status, 401);
    }
    assert.equal((await sitesOf(env, alice.token, a)).length, 1);
    assert.equal((await sitesOf(env, alice.token, b)).length, 0);
  });

  it('refuses POST connect to the token of an extension, in another workspace and in its own', async () => {
    const { env, alice, a, b, token } = await extensionOf();

    // A code would turn a token of 10 minutes into a session of 30 days, in any workspace.
    assert.equal((await call(env, 'POST', `/console/workspaces/${b}/connect`, { token, body: {} })).status, 401);
    assert.equal((await call(env, 'POST', `/console/workspaces/${a}/connect`, { token, body: {} })).status, 401);
    assert.equal(
      (await call(env, 'POST', `/console/workspaces/${b}/connect`, { token: alice.token, body: {} })).status,
      201,
    );
  });
});

describe('the store behind the API', () => {
  it('is the same database the routing reads', async () => {
    const env = await envWith();
    const { token } = await signIn(env, 'alice@acme.dev');
    const id = await workspaceOf(env, token);
    await call(env, 'POST', `/console/workspaces/${id}/sites`, { token, body: { url: SITE } });

    assert.equal(Object.values(await env.accounts.clientMap())[0]?.origins?.[0], SITE);
  });
});

/**
 * The worker key on a worker with accounts (FRU-203). Until FRU-150 the console API took a token
 * signed with `FRUITBACK_IDENTITY_SECRET` for the console session of its `sub`, so whoever held the
 * key was anybody. That exposure is closed: this is its test, turned over.
 */
describe('the worker key on a worker with accounts (FRU-203)', () => {
  it('takes no token that the holder of the worker key signed: a console session is the cookie (FRU-150)', async () => {
    const env = await envWith();
    const alice = await signIn(env, 'alice@acme.dev');
    const key = env.env.FRUITBACK_IDENTITY_SECRET as string;
    const forged = await signIdentityToken({ sub: alice.id, exp: Math.floor(Date.now() / 1000) + 300 }, key);

    assert.equal((await call(env, 'GET', '/console/me', { token: forged })).status, 401);
    assert.equal(
      (await call(env, 'POST', '/console/workspaces', { token: forged, body: { name: 'Forged' } })).status,
      401,
    );
    // The control: the cookie of the same person is served, and no workspace was made.
    const me = await call(env, 'GET', '/console/me', { token: alice.token });
    assert.equal(me.status, 200);
    assert.deepEqual(((await me.json()) as { workspaces: unknown[] }).workspaces, []);
  });
});

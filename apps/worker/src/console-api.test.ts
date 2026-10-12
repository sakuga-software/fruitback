import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { ACTIONS, ROLES, type Role, can } from './accounts.ts';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import type { WorkerEnv } from './env.ts';
import { closeSessionConnections } from './session-sqlite.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { signIdentityToken } from './identity.ts';
import type { MailMessage, Mailer } from './mail.ts';
import { createMemoryKv } from './kv.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const CONSOLE = 'https://app.fruitback.test';
const SITE = 'https://staging.acme.test';
const directories: string[] = [];

afterEach(() => {
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-console-api-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_CONSOLE_URL: CONSOLE,
  };
}

let ip = 0;
function call(
  env: WorkerEnv,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string } = {},
  context: Partial<RequestContext> = {},
): Promise<Response> {
  const headers: Record<string, string> = { Origin: options.origin ?? CONSOLE };
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  ip += 1;

  return handleRequest(
    new Request(`https://api.fruitback.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    env,
    { clientIp: `198.18.0.${ip % 250}`, kv: createMemoryKv(), ...context },
  );
}

/** Signs an address in through the real link, and answers its account id and access token. */
async function signIn(env: WorkerEnv, email: string): Promise<{ id: string; token: string }> {
  const sent: MailMessage[] = [];
  const mailer: Mailer = { send: async (message) => void sent.push(message) };
  await call(env, 'POST', '/auth/email', { body: { email } }, { mailer });
  const code = /#([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? '')?.[1];
  const opened = await call(env, 'POST', '/auth/email/redeem', { body: { code } });
  const body = (await opened.json()) as { accessToken: string; account: { id: string } };

  return { id: body.account.id, token: body.accessToken };
}

async function workspaceOf(env: WorkerEnv, token: string, name = 'Acme'): Promise<string> {
  const created = await call(env, 'POST', '/console/workspaces', { token, body: { name } });
  assert.equal(created.status, 201);

  return ((await created.json()) as { id: string }).id;
}

describe('the console API (FRU-99)', () => {
  it('answers the account and its workspaces, and nobody without a token', async () => {
    const env = envWith();
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
    assert.deepEqual(after.workspaces, [{ id, name: 'Sakuga studio', role: 'owner' }]);
  });

  it('refuses a workspace with no name, or a name nobody can read on one line', async () => {
    const env = envWith();
    const { token } = await signIn(env, 'alice@acme.dev');

    assert.equal((await call(env, 'POST', '/console/workspaces', { token, body: { name: '   ' } })).status, 400);
    assert.equal(
      (await call(env, 'POST', '/console/workspaces', { token, body: { name: 'x'.repeat(81) } })).status,
      400,
    );
  });

  it('adds the site a person pasted, by its origin, read by members unless they say everyone', async () => {
    const env = envWith();
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
    const env = envWith();
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
      const env = envWith();
      const owner = await signIn(env, 'owner@acme.dev');
      const person = await signIn(env, `${role}@acme.dev`);
      const id = await workspaceOf(env, owner.token);
      if (role !== 'owner') {
        // No invitation route yet (FRU-104): the role is written where the invitation will write it.
        const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
        database
          .prepare('INSERT INTO members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)')
          .run(id, person.id, role, Date.now());
        database.close();
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

describe('from a link in a mailbox to a note on the page (FRU-99, FRU-100)', () => {
  it('signs in, creates a workspace, adds a site, connects a browser, and that browser writes and reads there', async () => {
    const env = envWith();
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

    const seed = seedFixture();
    const written = await call(env, 'POST', '/feedback', {
      origin: SITE,
      token: session.accessToken,
      body: { ...seed, page: { ...seed.page, url: `${SITE}/pricing` }, client: { id: site.id } },
    });
    assert.equal(written.status, 201, await written.clone().text());

    const read = await call(env, 'GET', `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${site.id}`, {
      origin: SITE,
      token: session.accessToken,
    });
    assert.equal(read.status, 200);
    const issues = ((await read.json()) as { issues: { seed: { reporter?: { id?: string; verified?: boolean } } }[] })
      .issues;
    assert.equal(issues.length, 1);
    assert.deepEqual(
      { id: issues[0]?.seed.reporter?.id, verified: issues[0]?.seed.reporter?.verified },
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
    const env = envWith();
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
 *
 * Alice owns A and B, and pairs an extension for A. Each case also shows that the console session
 * of Alice is still served, so a refusal is about the token and not about the route.
 */
describe('the token of an extension on the console API (FRU-202)', () => {
  async function extensionOf(): Promise<{
    env: WorkerEnv;
    alice: { id: string; token: string };
    a: string;
    b: string;
    token: string;
  }> {
    const env = envWith();
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

  async function sitesOf(env: WorkerEnv, token: string, workspace: string): Promise<unknown[]> {
    const answer = await call(env, 'GET', `/console/workspaces/${workspace}/sites`, { token });
    assert.equal(answer.status, 200);

    return ((await answer.json()) as { sites: unknown[] }).sites;
  }

  it('refuses GET /console/me to the token of an extension', async () => {
    const { env, alice, token } = await extensionOf();

    const refused = await call(env, 'GET', '/console/me', { token });
    assert.equal(refused.status, 401);
    assert.deepEqual(await refused.json(), { error: 'identity-required', reason: 'not-a-console-session' });
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
  it('is the same file the routing reads', async () => {
    const env = envWith();
    const { token } = await signIn(env, 'alice@acme.dev');
    const id = await workspaceOf(env, token);
    await call(env, 'POST', `/console/workspaces/${id}/sites`, { token, body: { url: SITE } });

    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    assert.equal(Object.values(await accounts.clientMap())[0]?.origins?.[0], SITE);
  });
});

/**
 * What `SECURITY.md` says of the worker key on a worker with accounts (FRU-203). The first case is
 * an exposure and not a protection: it is held here so that the sentence stays true, and so that a
 * change that closes it has a test to turn over.
 */
describe('the worker key on a worker with accounts (FRU-203)', () => {
  const OTHER_KEY = 'another-worker-secret-of-enough-chars';
  const inFiveMinutes = (): number => Math.floor(Date.now() / 1000) + 300;

  it('takes a token that the holder of the worker key signed for the console session of its sub', async () => {
    const env = envWith();
    const alice = await signIn(env, 'alice@acme.dev');
    // What a site that was given the key can do: no code of the worker mints this token.
    const forged = await signIdentityToken({ sub: alice.id, exp: inFiveMinutes() }, SECRET);

    const me = await call(env, 'GET', '/console/me', { token: forged });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { account: { email: string } }).account.email, 'alice@acme.dev');
    const made = await call(env, 'POST', '/console/workspaces', { token: forged, body: { name: 'Forged' } });
    assert.equal(made.status, 201);
    const { id } = (await made.json()) as { id: string };
    assert.equal(
      (await call(env, 'POST', `/console/workspaces/${id}/connect`, { token: forged, body: {} })).status,
      201,
    );
    assert.equal((await call(env, 'DELETE', `/console/workspaces/${id}`, { token: forged })).status, 204);

    // The control: the same claims under a key that is not the key of the worker.
    const stranger = await signIdentityToken({ sub: alice.id, exp: inFiveMinutes() }, OTHER_KEY);
    assert.equal((await call(env, 'GET', '/console/me', { token: stranger })).status, 401);
  });

  it('refuses every token of the old key once the key changed, and a session that was open goes on at its next refresh', async () => {
    const env = envWith();
    const sent: MailMessage[] = [];
    const mailer: Mailer = { send: async (message) => void sent.push(message) };
    await call(env, 'POST', '/auth/email', { body: { email: 'alice@acme.dev' } }, { mailer });
    const code = /#([A-Za-z0-9_-]+)/.exec(sent[0]?.text ?? '')?.[1];
    const opened = await call(env, 'POST', '/auth/email/redeem', { body: { code } });
    const cookie = (opened.headers.getSetCookie()[0] ?? '').split(';')[0] as string;
    const session = (await opened.json()) as { accessToken: string; account: { id: string } };
    const forged = await signIdentityToken({ sub: session.account.id, exp: inFiveMinutes() }, SECRET);
    assert.equal((await call(env, 'GET', '/console/me', { token: forged })).status, 200);

    const changed: WorkerEnv = { ...env, FRUITBACK_IDENTITY_SECRET: OTHER_KEY };
    assert.equal((await call(changed, 'GET', '/console/me', { token: forged })).status, 401);
    assert.equal((await call(changed, 'GET', '/console/me', { token: session.accessToken })).status, 401);

    // The refresh token is a digest in the store, not a signature: the session is not ended.
    const refreshed = await handleRequest(
      new Request('https://api.fruitback.test/console/session/refresh', {
        method: 'POST',
        headers: { Origin: CONSOLE, Cookie: cookie },
      }),
      changed,
      { clientIp: '198.18.1.1', kv: createMemoryKv() },
    );
    assert.equal(refreshed.status, 200);
    const again = ((await refreshed.json()) as { accessToken: string }).accessToken;
    assert.equal((await call(changed, 'GET', '/console/me', { token: again })).status, 200);
  });
});

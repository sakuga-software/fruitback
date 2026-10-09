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

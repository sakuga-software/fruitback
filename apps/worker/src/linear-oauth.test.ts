import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { handleRequest } from './app.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import { REFRESH_MARGIN_MS, readCredential } from './linear-oauth.ts';
import { open } from './secrets.ts';
import { closeSessionConnections } from './session-sqlite.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const CONSOLE = 'https://app.fruitback.test';
const API = 'https://api.fruitback.test';
const SITE = 'https://staging.acme.dev';
const directories: string[] = [];

afterEach(() => {
  mock.restoreAll();
  mock.timers.reset();
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-linear-oauth-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'sqlite',
    FRUITBACK_SQLITE_PATH: join(directory, 'fb.db'),
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SECRETS_KEY: SECRETS_KEY,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_CONSOLE_URL: CONSOLE,
    FRUITBACK_PUBLIC_URL: API,
    FRUITBACK_LINEAR_OAUTH: 'linear-client:the-linear-client-secret',
    ...overrides,
    // The path of the SQLite store is that store's own variable, so `WorkerEnv` does not name it.
  } as WorkerEnv;
}

/**
 * Linear, as far as the flow uses it: the token route with its codes and its refresh tokens, the
 * GraphQL route that takes the access token of the moment only, and the revoke route.
 */
function fakeLinear() {
  const state = {
    /** The codes Linear gave, with the challenge each one was asked with. */
    codes: new Map<string, string>(),
    access: '' as string,
    refresh: '' as string,
    generation: 0,
    tokenCalls: [] as Record<string, string>[],
    graphql: [] as string[],
    revoked: [] as string[],
    issues: [] as { teamId: string; description: string }[],
    /** What the token route answers to a refresh: a status, or `down` for no answer at all. */
    refreshAnswer: 200 as number | 'down',
    slowRefresh: undefined as Promise<void> | undefined,
  };
  const mint = () => {
    state.generation += 1;
    state.access = `access-${state.generation}`;
    state.refresh = `refresh-${state.generation}`;

    return { access_token: state.access, refresh_token: state.refresh, expires_in: 86_400, token_type: 'Bearer' };
  };

  mock.method(globalThis, 'fetch', async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
    const address = String(url);
    if (address === 'https://api.linear.app/oauth/token') {
      const form = Object.fromEntries(new URLSearchParams(init.body));
      state.tokenCalls.push(form);
      if (form.client_id !== 'linear-client' || form.client_secret !== 'the-linear-client-secret') {
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      }
      if (form.grant_type === 'authorization_code') {
        const challenge = state.codes.get(form.code ?? '');
        const proves =
          createHash('sha256')
            .update(form.code_verifier ?? '')
            .digest('base64url') === challenge;
        if (!proves || form.redirect_uri !== `${API}/auth/linear/callback`) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        state.codes.delete(form.code ?? '');

        return Response.json(mint());
      }
      if (form.grant_type === 'refresh_token') {
        await state.slowRefresh;
        if (state.refreshAnswer === 'down') throw new TypeError('fetch failed');
        if (state.refreshAnswer !== 200) return Response.json({ error: 'x' }, { status: state.refreshAnswer });
        if (form.refresh_token !== state.refresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });

        return Response.json(mint());
      }

      return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    if (address === 'https://api.linear.app/oauth/revoke') {
      state.revoked.push(new URLSearchParams(init.body).get('token') ?? '');

      return new Response(null, { status: 200 });
    }

    state.graphql.push(init.headers.Authorization ?? '');
    if (init.headers.Authorization !== `Bearer ${state.access}`) {
      return Response.json({ errors: [{ message: 'no' }] }, { status: 401 });
    }
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];
    if (operation === 'FruitbackTeams') {
      return Response.json({
        data: {
          viewer: { name: 'Fruitback' },
          organization: { name: 'Acme Inc' },
          teams: { nodes: [{ id: 'team_design', name: 'Design', key: 'DES', projects: { nodes: [] } }] },
        },
      });
    }
    if (operation === 'FruitbackLabels') return Response.json({ data: { team: { labels: { nodes: [] } } } });
    if (operation === 'FruitbackCreateLabel') {
      const { name } = variables.input as { name: string };

      return Response.json({ data: { issueLabelCreate: { issueLabel: { id: `label_${name}`, name } } } });
    }
    if (operation === 'FruitbackCreateIssue') {
      const input = variables.input as { teamId: string; description: string };
      state.issues.push(input);
      const n = state.issues.length;

      return Response.json({
        data: {
          issueCreate: { success: true, issue: { id: `issue_${n}`, identifier: `DES-${n}`, url: `https://l/${n}` } },
        },
      });
    }

    return Response.json({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return state;
}

let ip = 0;
function call(
  env: WorkerEnv,
  method: string,
  path: string,
  options: {
    token?: string;
    body?: unknown;
    origin?: string;
    cookie?: string;
    kv?: ReturnType<typeof createMemoryKv>;
  } = {},
): Promise<Response> {
  ip += 1;

  return handleRequest(
    new Request(`${API}${path}`, {
      method,
      headers: {
        ...(options.origin === null ? {} : { Origin: options.origin ?? CONSOLE }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    env,
    { clientIp: `203.0.113.${ip % 250}`, kv: options.kv ?? KV },
  );
}

/** One Kv for a test: the ticket and the state live there between two requests. */
let KV = createMemoryKv();

async function acme(env: WorkerEnv, name = 'Acme') {
  KV = createMemoryKv();
  const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const person = async (email: string) => {
    const account = await accounts.signIn({ provider: 'email', subject: email, email });

    return { account, token: await signIdentityToken({ sub: account.id, exp }, SECRET) };
  };
  const owner = await person(`owner@${name.toLowerCase()}.dev`);
  const workspace = await accounts.createWorkspace(name, owner.account.id);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;

  return { accounts, owner, workspace, site, base, person };
}

type World = Awaited<ReturnType<typeof acme>>;

/** The console asks where to go, and the browser goes there: the address at Linear, and the cookie it left with. */
async function leave(env: WorkerEnv, world: World, token = world.owner.token) {
  const asked = await call(env, 'POST', `${world.base}/connectors/linear/oauth`, { token });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { url } = (await asked.json()) as { url: string };
  const started = await call(env, 'GET', new URL(url).pathname + new URL(url).search);
  assert.equal(started.status, 302);
  const at = new URL(started.headers.get('Location') as string);
  const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;

  return { ticket: url, at, cookie, state: at.searchParams.get('state') as string };
}

/** The person says yes at Linear, and Linear sends the browser back with a code. */
async function comeBack(
  env: WorkerEnv,
  linear: ReturnType<typeof fakeLinear>,
  left: Awaited<ReturnType<typeof leave>>,
) {
  linear.codes.set('code-1', left.at.searchParams.get('code_challenge') as string);

  return call(env, 'GET', `/auth/linear/callback?code=code-1&state=${left.state}`, { cookie: left.cookie });
}

async function connected(env: WorkerEnv, linear: ReturnType<typeof fakeLinear>, world: World): Promise<string> {
  const back = await comeBack(env, linear, await leave(env, world));
  assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${world.workspace.id}/connectors?linear=connected`);
  const [connector] = await world.accounts.connectors(world.workspace.id);
  assert.ok(connector !== undefined);
  const set = await call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
    token: world.owner.token,
    body: { connector: connector.id, teamId: 'team_design' },
  });
  assert.equal(set.status, 200, await set.clone().text());

  return connector.id;
}

function note(site: string) {
  const seed = seedFixture();

  return { ...seed, page: { ...seed.page, url: `${SITE}/pricing` }, client: { id: site } };
}

describe('a workspace connects Linear with OAuth (FRU-134)', () => {
  it('sends the browser to Linear with the application as the actor, a state and a challenge', async () => {
    const env = envWith();
    fakeLinear();
    const left = await leave(env, await acme(env));

    assert.equal(`${left.at.origin}${left.at.pathname}`, 'https://linear.app/oauth/authorize');
    assert.deepEqual(Object.fromEntries(left.at.searchParams), {
      client_id: 'linear-client',
      redirect_uri: `${API}/auth/linear/callback`,
      response_type: 'code',
      scope: 'read,write',
      actor: 'app',
      prompt: 'consent',
      state: left.state,
      code_challenge: left.at.searchParams.get('code_challenge'),
      code_challenge_method: 'S256',
    });
    assert.match(left.cookie, /^fruitback_linear_state=[\w-]{20,}$/);
    assert.equal(left.cookie.split('=')[1], left.state);
  });

  it('keeps the token sealed, names the connector after the workspace of Linear, and goes back to the console', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const back = await comeBack(env, linear, await leave(env, world));

    assert.equal(back.status, 302);
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${world.workspace.id}/connectors?linear=connected`);
    const [connector] = await world.accounts.connectors(world.workspace.id);
    assert.equal(connector?.kind, 'linear');
    assert.equal(connector?.label, 'Linear OAuth · Acme Inc');
    // The code was proven with the verifier of this flow, and with the secret of the application.
    assert.equal(linear.tokenCalls[0]?.grant_type, 'authorization_code');

    const kept = await world.accounts.sealedKey(connector?.id as string);
    const credential = readCredential(open(kept?.sealed as string, SECRETS_KEY) as string);
    assert.deepEqual(
      { ...credential, expiresAt: 0 },
      {
        via: 'oauth',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: 0,
      },
    );

    closeAccountConnections();
    const directory = dirname(env.FRUITBACK_ACCOUNTS_PATH as string);
    const bytes = Buffer.concat(
      readdirSync(directory)
        .filter((name) => name.startsWith('accounts.db'))
        .map((name) => readFileSync(join(directory, name))),
    ).toString('latin1');
    assert.equal(bytes.includes('access-1') || bytes.includes('refresh-1'), false);
    const listed = await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token });
    assert.equal((await listed.text()).includes('access-1'), false);
  });

  it('writes the notes of a site with the token, as a bearer', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    await connected(env, linear, world);

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });

    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(linear.issues[0]?.teamId, 'team_design');
    assert.equal(linear.graphql.at(-1), 'Bearer access-1');
  });

  it('says whether the worker has the application, and offers nothing without it', async () => {
    const env = envWith();
    fakeLinear();
    const world = await acme(env);
    const listed = await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token });
    assert.equal(((await listed.json()) as { linearOAuth: boolean }).linearOAuth, true);

    const without = envWith({ FRUITBACK_LINEAR_OAUTH: undefined });
    const bare = await acme(without);
    const none = await call(without, 'GET', `${bare.base}/connectors`, { token: bare.owner.token });
    assert.equal(((await none.json()) as { linearOAuth: boolean }).linearOAuth, false);
    assert.equal(
      (await call(without, 'POST', `${bare.base}/connectors/linear/oauth`, { token: bare.owner.token })).status,
      404,
    );
    assert.equal((await call(without, 'GET', '/auth/linear/start?ticket=aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  });
});

describe('the Linear of one person, and the workspace of another (FRU-134)', () => {
  it('refuses a callback from a browser that did not start the flow', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const left = await leave(env, world);
    linear.codes.set('code-1', left.at.searchParams.get('code_challenge') as string);
    const path = `/auth/linear/callback?code=code-1&state=${left.state}`;

    // The victim opens the address the attacker sent: their browser holds no cookie of this flow.
    const stranger = await call(env, 'GET', path);
    const forged = await call(env, 'GET', path, { cookie: 'fruitback_linear_state=another-state-of-the-attacker' });

    for (const answer of [stranger, forged]) {
      assert.equal(answer.status, 302);
      assert.equal(answer.headers.get('Location'), `${CONSOLE}/`);
    }
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), []);
    assert.equal(linear.tokenCalls.length, 0, 'the code was not spent for them');
  });

  it('spends a ticket and a state once', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const left = await leave(env, world);
    const again = await call(env, 'GET', new URL(left.ticket).pathname + new URL(left.ticket).search);
    assert.equal(again.headers.get('Location'), `${CONSOLE}/`, 'a ticket starts one flow');

    assert.match((await comeBack(env, linear, left)).headers.get('Location') ?? '', /linear=connected$/);
    linear.codes.set('code-2', left.at.searchParams.get('code_challenge') as string);
    const replay = await call(env, 'GET', `/auth/linear/callback?code=code-2&state=${left.state}`, {
      cookie: left.cookie,
    });
    assert.equal(replay.headers.get('Location'), `${CONSOLE}/`);
    assert.equal((await world.accounts.connectors(world.workspace.id)).length, 1);
  });

  it('gives a ticket to an owner or an admin only, and asks the role again on the way back', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const member = await world.person('member@acme.dev');
    const { DatabaseSync } = await import('node:sqlite');
    const role = (value: string, account: string): void => {
      closeAccountConnections();
      const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
      database
        .prepare('DELETE FROM members WHERE workspace_id = ? AND account_id = ?')
        .run(world.workspace.id, account);
      database
        .prepare('INSERT INTO members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, 1)')
        .run(world.workspace.id, account, value);
      database.close();
    };
    role('member', member.account.id);
    assert.equal(
      (await call(env, 'POST', `${world.base}/connectors/linear/oauth`, { token: member.token })).status,
      403,
    );

    // An admin starts, and is a member again before Linear sends them back.
    role('admin', member.account.id);
    const left = await leave(env, world, member.token);
    role('member', member.account.id);
    const back = await comeBack(env, linear, left);

    assert.match(back.headers.get('Location') ?? '', /linear=forbidden$/);
    assert.deepEqual(
      await createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string).connectors(world.workspace.id),
      [],
    );
  });

  it('goes back with a word, and keeps nothing, when the person says no or the code is wrong', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);

    const refused = await leave(env, world);
    const no = await call(env, 'GET', `/auth/linear/callback?error=access_denied&state=${refused.state}`, {
      cookie: refused.cookie,
    });
    assert.match(no.headers.get('Location') ?? '', /linear=declined$/);

    const wrong = await leave(env, world);
    const bad = await call(env, 'GET', `/auth/linear/callback?code=never-given&state=${wrong.state}`, {
      cookie: wrong.cookie,
    });
    assert.match(bad.headers.get('Location') ?? '', /linear=failed$/);
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), []);
    assert.equal(linear.graphql.length, 0);
  });
});

describe('a token of Linear that ends (FRU-134)', () => {
  /** A connected workspace, with the clock moved to where the token is near its end. */
  async function nearTheEnd() {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);
    mock.timers.enable({ apis: ['Date'], now: Date.now() + 86_400_000 - REFRESH_MARGIN_MS + 1_000 });

    return { env, linear, world, connector };
  }

  it('is refreshed before it is used, and the new pair is kept sealed', async () => {
    const { env, linear, world, connector } = await nearTheEnd();

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });

    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(linear.graphql.at(-1), 'Bearer access-2');
    assert.deepEqual(
      linear.tokenCalls.filter((form) => form.grant_type === 'refresh_token').map((form) => form.refresh_token),
      ['refresh-1'],
    );
    const kept = await world.accounts.sealedKey(connector);
    const credential = readCredential(open(kept?.sealed as string, SECRETS_KEY) as string);
    assert.equal(credential.via === 'oauth' && credential.refreshToken, 'refresh-2');

    // The next call uses what was kept, and asks Linear for no token.
    await call(env, 'POST', '/feedback', { origin: SITE, body: { ...note(world.site.id), id: 'sd_second000001' } });
    assert.equal(linear.tokenCalls.filter((form) => form.grant_type === 'refresh_token').length, 1);
  });

  it('is refreshed once for two notes written together', async () => {
    const { env, linear, world } = await nearTheEnd();
    let release: () => void = () => {};
    linear.slowRefresh = new Promise((resolve) => (release = resolve));

    const both = Promise.all([
      call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) }),
      call(env, 'POST', '/feedback', { origin: SITE, body: { ...note(world.site.id), id: 'sd_second000001' } }),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const answers = await both;

    assert.deepEqual(
      answers.map((answer) => answer.status),
      [201, 201],
    );
    assert.equal(linear.tokenCalls.filter((form) => form.grant_type === 'refresh_token').length, 1);
  });

  it('answers 502, and writes nowhere else, when Linear ended the connection or cannot be reached', async () => {
    for (const answer of [400, 401, 500, 'down'] as const) {
      const { env, linear, world, connector } = await nearTheEnd();
      linear.refreshAnswer = answer;

      const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });

      assert.equal(written.status, 502, String(answer));
      assert.equal(linear.issues.length, 0);
      // The pair it holds is kept: a refresh that fails must not lose the refresh token.
      const kept = await world.accounts.sealedKey(connector);
      const credential = readCredential(open(kept?.sealed as string, SECRETS_KEY) as string);
      assert.equal(credential.via === 'oauth' && credential.refreshToken, 'refresh-1');
      mock.timers.reset();
      mock.restoreAll();
      closeAccountConnections();
    }
  });

  it('is refreshed for the list of teams too', async () => {
    const { env, linear, world, connector } = await nearTheEnd();

    // The clock moved a day: the access token of the console ended, and the person holds a new one.
    const token = await signIdentityToken(
      { sub: world.owner.account.id, exp: Math.floor(Date.now() / 1000) + 600 },
      SECRET,
    );
    const teams = await call(env, 'GET', `${world.base}/connectors/${connector}/teams`, { token });

    assert.equal(teams.status, 200, await teams.clone().text());
    assert.equal(linear.graphql.at(-1), 'Bearer access-2');
  });
});

describe('disconnecting Linear (FRU-134)', () => {
  it('revokes the token at Linear, and removes the connector whatever Linear answers', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);

    const removed = await call(env, 'DELETE', `${world.base}/connectors/${connector}`, { token: world.owner.token });

    assert.equal(removed.status, 204);
    assert.deepEqual(linear.revoked, ['refresh-1']);
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), []);
  });

  it('asks Linear nothing for a connector made with a key', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const { seal } = await import('./secrets.ts');
    const keyed = await world.accounts.addConnector(world.workspace.id, {
      kind: 'linear',
      label: 'Linear · Camille',
      sealed: seal('lin_api_a_personal_key', SECRETS_KEY),
    });

    await call(env, 'DELETE', `${world.base}/connectors/${keyed.id}`, { token: world.owner.token });

    assert.deepEqual(linear.revoked, []);
  });
});

describe('what a Linear connector keeps (FRU-134)', () => {
  it('reads a connector made before as a key, and a pair of tokens as OAuth', () => {
    assert.deepEqual(readCredential('lin_api_a_personal_key'), { via: 'key', apiKey: 'lin_api_a_personal_key' });
    assert.deepEqual(readCredential('{"accessToken":"a","refreshToken":"r","expiresAt":7}'), {
      via: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: 7,
    });
    assert.equal(readCredential('{"accessToken":"a"}').via, 'key', 'half a pair is not a pair');
    assert.equal(readCredential('{not json').via, 'key');
  });

  it('needs the public address, the accounts and the key that seals, and a client id with its secret', () => {
    assert.equal(readConfig(envWith()).ok, true);
    assert.equal(readConfig(envWith({ FRUITBACK_LINEAR_OAUTH: 'nocolon' })).ok, false);
    assert.equal(readConfig(envWith({ FRUITBACK_PUBLIC_URL: undefined })).ok, false);
    assert.equal(readConfig(envWith({ FRUITBACK_SECRETS_KEY: undefined })).ok, false);
  });
});

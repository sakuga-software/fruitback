import { afterEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { noteFixture } from '@fruitback/shared/note.fixture';
import {
  WORKER as API,
  CONSOLE,
  type World as Env,
  callOn,
  memberOf,
  signInTo,
  worlds,
} from './console-world.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { type Kv, KvError, createMemoryKv } from './kv.ts';
import { REFRESH_MARGIN_MS, readCredential } from './linear-oauth.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresNoteStore } from './notes-postgres.ts';
import { open, seal } from './secrets.ts';

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const worldWith = worlds();

/**
 * A worker with accounts and the application of Linear. Its notes are in the database of the case
 * (FRU-225: they were in a SQLite file of the case).
 */
async function envWith(overrides: Partial<WorkerEnv> = {}): Promise<Env> {
  const world = await worldWith({
    env: {
      FRUITBACK_STORE: 'postgres',
      FRUITBACK_SECRETS_KEY: SECRETS_KEY,
      FRUITBACK_LINEAR_OAUTH: 'linear-client:the-linear-client-secret',
      ...overrides,
    },
  });

  return { ...world, context: { ...world.context, store: createPostgresNoteStore(world.database) } };
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
    /** The workspace of Linear the next consent is for (FRU-633). */
    organization: { id: 'org_acme', name: 'Acme Inc' },
  };
  const mint = () => {
    state.generation += 1;
    state.access = `access-${state.generation}`;
    state.refresh = `refresh-${state.generation}`;

    return { access_token: state.access, refresh_token: state.refresh, expires_in: 86_400, token_type: 'Bearer' };
  };

  mockMethod(globalThis, 'fetch', async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
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
    // The list of the teams, who the key is, and the places of a site by their ids (FRU-501): one answer.
    if (operation === 'FruitbackTeams' || operation === 'FruitbackViewer' || operation === 'FruitbackPlaces') {
      return Response.json({
        data: {
          viewer: { name: 'Fruitback' },
          organization: state.organization,
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

/** `cookie` is the cookie of the flow at Linear. The cookie of a person of the console is `token`. */
function call(
  env: Env,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string; cookie?: string } = {},
): Promise<Response> {
  const { cookie, ...rest } = options;

  return callOn(env, method, path, { ...rest, ...(cookie === undefined ? {} : { headers: { Cookie: cookie } }) });
}

async function acme(env: Env, name = 'Acme') {
  const { accounts } = env;
  const person = async (email: string) => {
    const { id, token } = await signInTo(env, email);

    return { account: { id }, token };
  };
  const owner = await person(`owner@${name.toLowerCase()}.dev`);
  const workspace = await accounts.createWorkspace(name, owner.account.id);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;

  return { accounts, owner, workspace, site, base, person };
}

type World = Awaited<ReturnType<typeof acme>>;

/** The console asks where to go, and the browser goes there: the address at Linear, and the cookie it left with. */
async function leave(env: Env, world: World, token = world.owner.token, path = '/connectors/linear/oauth') {
  const asked = await call(env, 'POST', `${world.base}${path}`, { token });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { url } = (await asked.json()) as { url: string };
  const started = await call(env, 'GET', new URL(url).pathname + new URL(url).search);
  assert.equal(started.status, 302);
  const at = new URL(started.headers.get('Location') as string);
  const cookie = (started.headers.get('Set-Cookie') ?? '').split(';')[0] as string;

  return { ticket: url, at, cookie, state: at.searchParams.get('state') as string };
}

/** The person says yes at Linear, and Linear sends the browser back with a code. */
async function comeBack(env: Env, linear: ReturnType<typeof fakeLinear>, left: Awaited<ReturnType<typeof leave>>) {
  linear.codes.set('code-1', left.at.searchParams.get('code_challenge') as string);

  return call(env, 'GET', `/auth/linear/callback?code=code-1&state=${left.state}`, { cookie: left.cookie });
}

async function connected(env: Env, linear: ReturnType<typeof fakeLinear>, world: World): Promise<string> {
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
  const base = noteFixture();

  return { ...base, page: { ...base.page, url: `${SITE}/pricing` }, client: { id: site } };
}

describe('a workspace connects Linear with OAuth (FRU-134)', () => {
  it('sends the browser to Linear with the application as the actor, a state and a challenge', async () => {
    const env = await envWith();
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
    const env = await envWith();
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
        // FRU-633: the workspace of Linear, whose connectors share the pair.
        organization: 'org_acme',
      },
    );

    // Every row of every table of the database, as text.
    const tables = await rowsOf(env.database, `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    let bytes = '';
    for (const { tablename } of tables) {
      const rows = await rowsOf(env.database, `SELECT t::text AS row FROM "${String(tablename)}" AS t`);
      bytes += rows.map((each) => String(each.row)).join('\n');
    }
    assert.ok(bytes.includes(connector?.id as string), 'the control: the row of the connector was read');
    assert.equal(bytes.includes('access-1') || bytes.includes('refresh-1'), false);
    const listed = await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token });
    assert.equal((await listed.text()).includes('access-1'), false);
  });

  it('writes the notes of a site with the token, as a bearer', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    await connected(env, linear, world);

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });

    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(linear.issues[0]?.teamId, 'team_design');
    assert.equal(linear.graphql.at(-1), 'Bearer access-1');
  });

  it('says whether the worker has the application, and offers nothing without it', async () => {
    const env = await envWith();
    fakeLinear();
    const world = await acme(env);
    const listed = await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token });
    assert.equal(((await listed.json()) as { linearOAuth: boolean }).linearOAuth, true);

    // The second worker of the case takes the place of the first: PGlite holds one database.
    const without = await envWith({ FRUITBACK_LINEAR_OAUTH: undefined });
    const bare = await acme(without);
    const none = await call(without, 'GET', `${bare.base}/connectors`, { token: bare.owner.token });
    assert.equal(((await none.json()) as { linearOAuth: boolean }).linearOAuth, false);
    assert.equal(
      (await call(without, 'POST', `${bare.base}/connectors/linear/oauth`, { token: bare.owner.token })).status,
      404,
    );
    assert.equal((await call(without, 'GET', '/auth/linear/start?ticket=aaaaaaaaaaaaaaaaaaaaaaaa')).status, 404);
  });

  // FRU-67. On memory a `Kv` never throws. A database can answer the rate limit and then stop, and
  // the ticket is kept below the limit, where nothing caught that: the request ended as a `500`.
  it('answers 503, with the headers of the console, when the Kv stops after the rate limit', async () => {
    const env = await envWith();
    fakeLinear();
    const world = await acme(env);
    const memory = createMemoryKv();
    const down = async (): Promise<never> => {
      throw new KvError('the Kv of the database did not answer: PostgreSQL did not answer: read ECONNRESET');
    };
    const ticketsDown: Kv = {
      ...memory,
      get: (key) => (key.startsWith('fruitback:linear-ticket:') ? down() : memory.get(key)),
      set: (key, value, ttl) => (key.startsWith('fruitback:linear-ticket:') ? down() : memory.set(key, value, ttl)),
    };
    mockMethod(console, 'error', () => {});

    const asked = await callOn(
      env,
      'POST',
      `${world.base}/connectors/linear/oauth`,
      { token: world.owner.token },
      { kv: ticketsDown },
    );
    assert.equal(asked.status, 503);
    assert.deepEqual(await asked.json(), { error: 'limiter-unavailable' });
    assert.equal(asked.headers.get('Access-Control-Allow-Origin'), CONSOLE);

    const started = await callOn(
      env,
      'GET',
      '/auth/linear/start?ticket=aaaaaaaaaaaaaaaaaaaaaaaa',
      {},
      { kv: ticketsDown },
    );
    assert.equal(started.status, 503);
  });
});

describe('the Linear of one person, and the workspace of another (FRU-134)', () => {
  it('refuses a callback from a browser that did not start the flow', async () => {
    const env = await envWith();
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
    const env = await envWith();
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
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const member = await world.person('member@acme.dev');
    const role = async (value: string, account: string): Promise<void> => {
      await rowsOf(
        env.database,
        `DELETE FROM member WHERE "organizationId" = '${world.workspace.id}' AND "userId" = '${account}'`,
      );
      await memberOf(env, world.workspace.id, account, value);
    };
    await role('member', member.account.id);
    assert.equal(
      (await call(env, 'POST', `${world.base}/connectors/linear/oauth`, { token: member.token })).status,
      403,
    );

    // An admin starts, and is a member again before Linear sends them back.
    await role('admin', member.account.id);
    const left = await leave(env, world, member.token);
    await role('member', member.account.id);
    const back = await comeBack(env, linear, left);

    assert.match(back.headers.get('Location') ?? '', /linear=forbidden$/);
    assert.deepEqual(await env.accounts.connectors(world.workspace.id), []);
  });

  it('keeps no connector for a workspace that was suspended while the person was at Linear (FRU-282)', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const left = await leave(env, world);
    await rowsOf(
      env.database,
      `INSERT INTO workspace_suspensions (workspace_id, since) VALUES ('${world.workspace.id}', ${Date.now()})`,
    );

    const back = await comeBack(env, linear, left);

    assert.match(back.headers.get('Location') ?? '', /linear=suspended$/);
    assert.deepEqual(await env.accounts.connectors(world.workspace.id), []);
    // The control: the same way back, after the restoration, keeps the connector.
    await rowsOf(env.database, `DELETE FROM workspace_suspensions`);
    assert.match(
      (await comeBack(env, linear, await leave(env, world))).headers.get('Location') ?? '',
      /linear=connected$/,
    );
    assert.equal((await env.accounts.connectors(world.workspace.id)).length, 1);
  });

  it('goes back with a word, and keeps nothing, when the person says no or the code is wrong', async () => {
    const env = await envWith();
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
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 - REFRESH_MARGIN_MS + 1_000 });

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

  it('does not spend a refresh token twice for a caller that read the connector before the refresh', async () => {
    const { linear, world, connector } = await nearTheEnd();
    const { linearAuthorization } = await import('./linear-oauth.ts');
    const access = {
      accounts: world.accounts,
      secretsKey: SECRETS_KEY,
      oauth: { clientId: 'linear-client', clientSecret: 'the-linear-client-secret' },
    };
    // Both callers read the same sealed pair. The first one refreshes and finishes.
    const stale = (await world.accounts.sealedKey(connector))?.sealed as string;
    assert.equal(await linearAuthorization(connector, stale, access), 'Bearer access-2');

    // The second one comes with what it read before: it gets the pair of the store, and asks Linear nothing.
    assert.equal(await linearAuthorization(connector, stale, access), 'Bearer access-2');
    assert.deepEqual(
      linear.tokenCalls.filter((form) => form.grant_type === 'refresh_token').map((form) => form.refresh_token),
      ['refresh-1'],
    );
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
      // FRU-102: a connection Linear ended is for somebody to fix, and a Linear that is down is not.
      const [listed] = await world.accounts.connectors(world.workspace.id);
      assert.equal(
        listed?.attention?.reason,
        answer === 400 || answer === 401 ? 'connection-ended' : undefined,
        String(answer),
      );
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('is refreshed for the list of teams too', async () => {
    const { env, linear, world, connector } = await nearTheEnd();

    // The clock moved a day: the session of the console lasts longer, and its cookie is still good.
    const { token } = world.owner;
    const teams = await call(env, 'GET', `${world.base}/connectors/${connector}/teams`, { token });

    assert.equal(teams.status, 200, await teams.clone().text());
    assert.equal(linear.graphql.at(-1), 'Bearer access-2');
  });
});

describe('disconnecting Linear (FRU-134)', () => {
  it('revokes the token at Linear, and removes the connector whatever Linear answers', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);

    const removed = await call(env, 'DELETE', `${world.base}/connectors/${connector}`, { token: world.owner.token });

    assert.equal(removed.status, 204);
    assert.deepEqual(linear.revoked, ['refresh-1']);
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), []);
  });

  it('asks Linear nothing for a connector made with a key', async () => {
    const env = await envWith();
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

  it('needs the public address, the accounts and the key that seals, and a client id with its secret', async () => {
    const { env } = await envWith();
    assert.equal(readConfig(env).ok, true);
    assert.equal(readConfig({ ...env, FRUITBACK_LINEAR_OAUTH: 'nocolon' }).ok, false);
    assert.equal(readConfig({ ...env, FRUITBACK_PUBLIC_URL: undefined }).ok, false);
    assert.equal(readConfig({ ...env, FRUITBACK_SECRETS_KEY: undefined }).ok, false);
  });
});

/** A second workspace of Fruitback, with its own site, for the same workspace of Linear (FRU-633). */
async function globex(env: Env) {
  const { id, token } = await signInTo(env, 'owner@globex.dev');
  const workspace = await env.accounts.createWorkspace('Globex', id);
  const site = await env.accounts.addSite(workspace.id, { origin: OTHER_SITE, visibility: 'everyone' });

  return {
    accounts: env.accounts,
    owner: { account: { id }, token },
    workspace,
    site,
    base: `/console/workspaces/${workspace.id}`,
  };
}

const OTHER_SITE = 'https://staging.globex.dev';

function otherNote(site: string, id: string) {
  const base = noteFixture();

  return { ...base, id, page: { ...base.page, url: `${OTHER_SITE}/pricing` }, client: { id: site } };
}

/** The pair a connector keeps now. */
async function pairOf(world: { accounts: World['accounts'] }, connector: string) {
  const kept = await world.accounts.sealedKey(connector);

  return readCredential(open(kept?.sealed as string, SECRETS_KEY) as string);
}

/** Sends the site of `world` to `connector`, as the console does. */
async function sendTo(
  env: Env,
  world: { base: string; site: { id: string }; owner: { token: string } },
  connector: string,
) {
  const set = await call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
    token: world.owner.token,
    body: { connector, teamId: 'team_design' },
  });
  assert.equal(set.status, 200, await set.clone().text());
}

/** A connector as the worker kept it before FRU-633: its pair says no workspace of Linear. */
async function asBefore(env: Env, connector: string): Promise<void> {
  const pair = await pairOf(env, connector);
  assert.ok(pair.via === 'oauth');
  const { accessToken, refreshToken, expiresAt } = pair;
  const sealed = seal(JSON.stringify({ accessToken, refreshToken, expiresAt }), SECRETS_KEY);
  await rowsOf(
    env.database,
    `UPDATE connectors SET sealed = '${sealed}', linear_organization = NULL WHERE id = '${connector}'`,
  );
}

describe('one pair of tokens for each workspace of Linear (FRU-633)', () => {
  it('keeps the connector of another workspace of Fruitback working after a consent for the same workspace of Linear', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const first = await acme(env);
    const before = await connected(env, linear, first);
    const second = await globex(env);

    const back = await comeBack(env, linear, await leave(env, second as unknown as World, second.owner.token));
    assert.equal(back.headers.get('Location'), `${CONSOLE}/w/${second.workspace.id}/connectors?linear=connected`);

    // Linear ended `refresh-1` and `access-1` with the second consent. The first connector holds the new pair.
    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(first.site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(linear.graphql.at(-1), 'Bearer access-2');
    const [made] = await second.accounts.connectors(second.workspace.id);
    assert.ok(made !== undefined && made.id !== before);
    assert.deepEqual(await pairOf(first, before), await pairOf(second, made.id));
  });

  it('gives the pair that one connector refreshed to every connector of its workspace of Linear, with one refresh', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const first = await acme(env);
    await connected(env, linear, first);
    const second = await globex(env);
    await comeBack(env, linear, await leave(env, second as unknown as World, second.owner.token));
    const [made] = await second.accounts.connectors(second.workspace.id);
    await sendTo(env, second, made?.id as string);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 - REFRESH_MARGIN_MS + 1_000 });

    const one = await call(env, 'POST', '/feedback', { origin: SITE, body: note(first.site.id) });
    const other = await call(env, 'POST', '/feedback', {
      origin: OTHER_SITE,
      body: otherNote(second.site.id, 'sd_globex000001'),
    });

    assert.equal(one.status, 201, await one.clone().text());
    assert.equal(other.status, 201, await other.clone().text());
    assert.deepEqual(
      linear.tokenCalls.filter((form) => form.grant_type === 'refresh_token').map((form) => form.refresh_token),
      ['refresh-2'],
    );
    assert.equal(linear.graphql.at(-1), 'Bearer access-3');
  });

  it('gives a connector that Linear ended a new pair in its own panel: it keeps its id, its site and its settings', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);
    const settings = (await world.accounts.connectors(world.workspace.id))[0]?.settings;
    assert.ok(settings !== undefined);
    await world.accounts.setConnectorSettings(world.workspace.id, connector, { ...settings, showComments: false });
    // Linear ends the pair, as a consent elsewhere does: the next note finds it refused.
    linear.refresh = 'ended';
    linear.access = 'ended';
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 86_400_000 });
    assert.equal((await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) })).status, 502);
    assert.equal((await world.accounts.connectors(world.workspace.id))[0]?.attention?.reason, 'connection-ended');
    vi.useRealTimers();

    const left = await leave(env, world, world.owner.token, `/connectors/${connector}/reconnect`);
    const back = await comeBack(env, linear, left);

    assert.equal(
      back.headers.get('Location'),
      `${CONSOLE}/w/${world.workspace.id}/connectors?linear=reconnected&connector=${connector}`,
    );
    const listed = await world.accounts.connectors(world.workspace.id);
    assert.deepEqual(
      listed.map((each) => [each.id, each.attention, each.settings.showComments]),
      [[connector, undefined, false]],
    );
    const written = await call(env, 'POST', '/feedback', {
      origin: SITE,
      body: { ...note(world.site.id), id: 'sd_again0000001' },
    });
    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(linear.issues.at(-1)?.teamId, 'team_design');
    assert.equal(linear.graphql.at(-1), `Bearer ${linear.access}`);
  });

  it('keeps the pair of the connector when the consent is for another workspace of Linear, and gives it to that one', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);
    const kept = await pairOf(world, connector);
    const elsewhere = await globex(env);
    linear.organization = { id: 'org_globex', name: 'Globex' };
    await comeBack(env, linear, await leave(env, elsewhere as unknown as World, elsewhere.owner.token));
    const [globexLinear] = await elsewhere.accounts.connectors(elsewhere.workspace.id);

    linear.organization = { id: 'org_globex', name: 'Globex' };
    const back = await comeBack(
      env,
      linear,
      await leave(env, world, world.owner.token, `/connectors/${connector}/reconnect`),
    );

    assert.equal(
      back.headers.get('Location'),
      `${CONSOLE}/w/${world.workspace.id}/connectors?linear=other-organization&connector=${connector}`,
    );
    assert.deepEqual(await pairOf(world, connector), kept);
    // The exchange ended the pair of before in the workspace of Linear Globex: its connector has the new one.
    const globexPair = await pairOf(elsewhere, globexLinear?.id as string);
    assert.equal(globexPair.via === 'oauth' && globexPair.accessToken, linear.access);
  });

  it('brings the connector of before back on a plain « Connect », with no second connector', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);
    await asBefore(env, connector);
    linear.refresh = 'ended';
    linear.access = 'ended';

    const back = await comeBack(env, linear, await leave(env, world));

    assert.equal(
      back.headers.get('Location'),
      `${CONSOLE}/w/${world.workspace.id}/connectors?linear=reconnected&connector=${connector}`,
    );
    assert.deepEqual(
      (await world.accounts.connectors(world.workspace.id)).map((each) => each.id),
      [connector],
    );
    const pair = await pairOf(world, connector);
    assert.equal(pair.via === 'oauth' && pair.organization, 'org_acme');
  });

  it('asks a working connector of before for its workspace of Linear before a consent ends its pair', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const first = await acme(env);
    const before = await connected(env, linear, first);
    await asBefore(env, before);
    const second = await globex(env);

    await comeBack(env, linear, await leave(env, second as unknown as World, second.owner.token));

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(first.site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    assert.equal(linear.graphql.at(-1), `Bearer ${linear.access}`);
  });

  it('revokes the pair only when the last connector of its workspace of Linear goes', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const first = await acme(env);
    const before = await connected(env, linear, first);
    const second = await globex(env);
    await comeBack(env, linear, await leave(env, second as unknown as World, second.owner.token));
    const [made] = await second.accounts.connectors(second.workspace.id);

    await call(env, 'DELETE', `${first.base}/connectors/${before}`, { token: first.owner.token });
    assert.deepEqual(linear.revoked, []);
    await call(env, 'DELETE', `${second.base}/connectors/${made?.id}`, { token: second.owner.token });
    assert.deepEqual(linear.revoked, ['refresh-2']);
  });

  it('starts a new consent for a connector made with OAuth of the workspace only, and for its owner or admin', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, linear, world);
    const other = await globex(env);
    const reader = await world.person('reader@acme.dev');
    await memberOf(env, world.workspace.id, reader.account.id, 'member');

    const ask = (base: string, id: string, token: string) =>
      call(env, 'POST', `${base}/connectors/${id}/reconnect`, { token });
    assert.equal((await ask(world.base, connector, world.owner.token)).status, 201);
    assert.equal((await ask(other.base, connector, other.owner.token)).status, 404);
    assert.equal((await ask(world.base, connector, reader.token)).status, 403);
    const key = await world.accounts.addConnector(world.workspace.id, { kind: 'linear', label: 'Linear', sealed: 'x' });
    assert.equal((await ask(world.base, key.id, world.owner.token)).status, 404);
  });
});

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import type { AccountStore, ConnectorAttention } from './accounts.ts';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { handleRequest } from './app.ts';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import { noteConnectorCall, troubleOf, watchedStore } from './connector-health.ts';
import type { WorkerEnv } from './env.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import { LinearKeyForbidden, LinearKeyRefused } from './linear.ts';
import { LinearConnectionEnded } from './linear-oauth.ts';
import { closeSessionConnections } from './session-sqlite.ts';
import { type SeedStore, StoreError } from './store.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const CONSOLE = 'https://app.fruitback.test';
const SITE = 'https://staging.acme.dev';
const PAGE = `${SITE}/pricing`;
const LINEAR_KEY = 'lin_api_the_real_key_of_acme';
const directories: string[] = [];

afterEach(() => {
  mock.restoreAll();
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-connector-health-'));
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
    // The path of the SQLite store is that store's own variable, so `WorkerEnv` does not name it.
  } as WorkerEnv;
}

/**
 * Linear with one key, and a switch for what it does with it.
 *
 * `working` answers. `revoked` is a key somebody removed at Linear: `401`. `forbidden` is a key that
 * may not do this: `403`. `down` is Linear with a failure of its own: `500`.
 */
function linearWith() {
  const world = { mode: 'working' as 'working' | 'revoked' | 'forbidden' | 'down', issues: [] as string[] };
  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
    if (world.mode === 'down') return Response.json({ errors: [{ message: 'later' }] }, { status: 500 });
    if (world.mode === 'forbidden') return Response.json({ errors: [{ message: 'not you' }] }, { status: 403 });
    if (world.mode === 'revoked' || init.headers.Authorization !== LINEAR_KEY) {
      return Response.json({ errors: [{ message: 'no' }] }, { status: 401 });
    }
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];

    if (operation === 'FruitbackTeams') {
      return Response.json({
        data: {
          viewer: { name: 'Camille' },
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
      world.issues.push((variables.input as { description: string }).description);
      const identifier = `DES-${world.issues.length}`;

      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: { id: identifier, identifier, url: `https://linear.app/acme/issue/${identifier}` },
          },
        },
      });
    }
    if (operation === 'FruitbackIssues') {
      return Response.json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    }

    return Response.json({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return world;
}

let ip = 0;
function call(
  env: WorkerEnv,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  ip += 1;

  return handleRequest(
    new Request(`https://api.fruitback.test${path}`, {
      method,
      headers: {
        Origin: options.origin ?? CONSOLE,
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    env,
    // A new `Kv` for each call: a read that the cache answers asks the tracker nothing.
    { clientIp: `203.0.113.${ip % 250}`, kv: createMemoryKv() },
  );
}

/** A workspace whose one site sends its notes to Linear, connected with a key through the console. */
async function acme(env: WorkerEnv) {
  const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
  const account = await accounts.signIn({ provider: 'email', subject: 'owner@acme.dev', email: 'owner@acme.dev' });
  const token = await signIdentityToken({ sub: account.id, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
  const workspace = await accounts.createWorkspace('Acme', account.id);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;
  const added = await call(env, 'POST', `${base}/connectors`, { token, body: { kind: 'linear', apiKey: LINEAR_KEY } });
  assert.equal(added.status, 201, await added.clone().text());
  const connector = ((await added.json()) as { id: string }).id;
  await accounts.setDestination(workspace.id, site.id, { connector, teamId: 'team_design' });

  const write = () => {
    const seed = seedFixture();

    return call(env, 'POST', '/feedback', {
      origin: SITE,
      body: { ...seed, page: { ...seed.page, url: PAGE }, client: { id: site.id } },
    });
  };
  const read = () => call(env, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site.id}`, { origin: SITE });
  /** The connector as the console reads it: the route, never the row. */
  const attention = async (): Promise<ConnectorAttention | undefined> => {
    const listed = await call(env, 'GET', `${base}/connectors`, { token });
    assert.equal(listed.status, 200);
    const { connectors } = (await listed.json()) as { connectors: { id: string; attention?: ConnectorAttention }[] };

    return connectors.find((each) => each.id === connector)?.attention;
  };

  return { accounts, token, workspace, site, base, connector, write, read, attention };
}

describe('a connector that its tracker refuses (FRU-102)', () => {
  it('answers 502 for a key revoked at Linear, writes nowhere else, and needs attention', async () => {
    const env = envWith();
    const linear = linearWith();
    const world = await acme(env);
    assert.equal((await world.write()).status, 201);
    assert.equal(await world.attention(), undefined, 'a connector that works needs nothing');

    linear.mode = 'revoked';
    const written = await world.write();

    // The widget keeps the note and tries again: the same promise as a store that is down.
    assert.equal(written.status, 502);
    assert.deepEqual(await written.json(), { error: 'store-unavailable', message: 'no' });
    assert.equal(linear.issues.length, 1, 'the note went nowhere');
    assert.equal((await world.attention())?.reason, 'key-refused');

    // And nothing fell into the worker's own store: with a key that works again, the page is empty.
    linear.mode = 'working';
    assert.deepEqual(((await (await world.read()).json()) as { issues: unknown[] }).issues, []);
  });

  it('needs attention after a read too: a page that only shows its pins asks the tracker as well', async () => {
    const env = envWith();
    const linear = linearWith();
    const world = await acme(env);

    linear.mode = 'revoked';
    assert.equal((await world.read()).status, 502);

    assert.equal((await world.attention())?.reason, 'key-refused');
  });

  it('works again at the first call Linear answers', async () => {
    const env = envWith();
    const linear = linearWith();
    const world = await acme(env);
    linear.mode = 'revoked';
    await world.write();
    assert.notEqual(await world.attention(), undefined);

    linear.mode = 'working';
    assert.equal((await world.write()).status, 201);

    assert.equal(await world.attention(), undefined);
  });

  it('says a key that may not write apart from a key that is refused', async () => {
    const env = envWith();
    const linear = linearWith();
    const world = await acme(env);

    linear.mode = 'forbidden';
    assert.equal((await world.write()).status, 502);

    assert.equal((await world.attention())?.reason, 'key-lacks-access');
  });

  it('needs no attention for a Linear that is down: nobody of the workspace can fix that', async () => {
    const env = envWith();
    const linear = linearWith();
    const world = await acme(env);

    linear.mode = 'down';
    assert.equal((await world.write()).status, 502);
    assert.equal(await world.attention(), undefined);

    // And an outage after a refusal does not clear it: Linear said nothing of the key.
    linear.mode = 'revoked';
    await world.write();
    linear.mode = 'down';
    await world.write();
    assert.equal((await world.attention())?.reason, 'key-refused');
  });

  it('keeps the moment of the first refusal, so the console says since when the notes do not leave', async () => {
    const accounts = createSqliteAccountStore(envWith().FRUITBACK_ACCOUNTS_PATH as string);
    const account = await accounts.signIn({ provider: 'email', subject: 'a@acme.dev', email: 'a@acme.dev' });
    const workspace = await accounts.createWorkspace('Acme', account.id);
    const { id } = await accounts.addConnector(workspace.id, { kind: 'linear', label: 'Linear · A', sealed: 'x' });
    const since = async () => (await accounts.connectors(workspace.id))[0]?.attention;

    await accounts.noteConnector(id, 'key-refused', Date.parse('2026-10-10T08:00:00.000Z'));
    await accounts.noteConnector(id, 'key-refused', Date.parse('2026-10-10T09:00:00.000Z'));
    assert.deepEqual(await since(), { reason: 'key-refused', since: '2026-10-10T08:00:00.000Z' });

    // Another kind of refusal is another thing to do, with its own moment.
    await accounts.noteConnector(id, 'key-lacks-access', Date.parse('2026-10-10T10:00:00.000Z'));
    assert.deepEqual(await since(), { reason: 'key-lacks-access', since: '2026-10-10T10:00:00.000Z' });

    await accounts.noteConnector(id, undefined, Date.parse('2026-10-10T11:00:00.000Z'));
    assert.equal(await since(), undefined);
  });

  it('sees the refusal when somebody opens the panel of the connector, with no note written', async () => {
    const env = envWith();
    const linear = linearWith();
    const world = await acme(env);

    linear.mode = 'revoked';
    const teams = await call(env, 'GET', `${world.base}/connectors/${world.connector}/teams`, { token: world.token });

    assert.equal(teams.status, 502);
    assert.equal((await world.attention())?.reason, 'key-refused');
  });
});

describe('what counts as a refusal', () => {
  it('names the three refusals, and nothing for another failure', () => {
    assert.equal(troubleOf(new LinearKeyRefused('no')), 'key-refused');
    assert.equal(troubleOf(new LinearKeyForbidden('no')), 'key-lacks-access');
    assert.equal(troubleOf(new LinearConnectionEnded('no')), 'connection-ended');
    assert.equal(troubleOf(new StoreError('Linear could not be reached')), undefined);
    assert.equal(troubleOf(new TypeError('a defect')), undefined);
  });
});

describe('the store that notes its connector', () => {
  const policy = { showComments: false, identitySecret: undefined, read: 'public' } as ClientPolicy;
  const routed = { connector: 'con_a', workspace: 'ws_a' } as ClientConfig;
  const created = { id: '1', identifier: 'DES-1' };

  function accountsThat(note: AccountStore['noteConnector']) {
    return { noteConnector: note } as unknown as AccountStore;
  }

  it('answers what the store answered when the state cannot be kept: the note exists', async () => {
    mock.method(console, 'error', () => {});
    const store = { name: 'fake', scope: () => '', create: async () => created } as unknown as SeedStore;
    const accounts = accountsThat(async () => {
      throw new Error('the accounts file is locked');
    });

    assert.deepEqual(await watchedStore(store, accounts).create(seedFixture(), routed, policy), created);
  });

  it('throws the error of the store, and not the one of the accounts, when both fail', async () => {
    mock.method(console, 'error', () => {});
    const refusal = new LinearKeyRefused('no');
    const store = {
      name: 'fake',
      scope: () => '',
      create: async () => {
        throw refusal;
      },
    } as unknown as SeedStore;
    const accounts = accountsThat(async () => {
      throw new Error('the accounts file is locked');
    });

    await assert.rejects(
      watchedStore(store, accounts).create(seedFixture(), routed, policy),
      (error) => error === refusal,
    );
  });

  it('notes nothing for a client with no connector, and is the store itself with no accounts', async () => {
    const noted: unknown[] = [];
    const store = { name: 'fake', scope: () => '', create: async () => created } as unknown as SeedStore;
    const accounts = accountsThat(async (...call) => void noted.push(call));

    await watchedStore(store, accounts).create(seedFixture(), {} as ClientConfig, policy);
    await watchedStore(store, accounts).create(seedFixture(), undefined, policy);

    assert.deepEqual(noted, []);
    assert.equal(watchedStore(store, undefined), store);
  });

  it('keeps the name, the stages and the scope of the store it watches', () => {
    const store = { name: 'fake', stages: ['seeded'], scope: () => 'a-scope' } as unknown as SeedStore;
    const watched = watchedStore(
      store,
      accountsThat(async () => {}),
    );

    assert.equal(watched.name, 'fake');
    assert.deepEqual(watched.stages, ['seeded']);
    assert.equal(watched.scope(undefined), 'a-scope');
  });

  it('writes the moment of its clock', async () => {
    const noted: unknown[] = [];
    const accounts = accountsThat(async (...call) => void noted.push(call));

    await noteConnectorCall(accounts, 'con_a', new LinearKeyRefused('no'), () => 42);

    assert.deepEqual(noted, [['con_a', 'key-refused', 42]]);
  });
});

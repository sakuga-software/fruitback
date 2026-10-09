import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { closeSessionConnections } from './session-sqlite.ts';
import { handleRequest } from './app.ts';
import { signIdentityToken } from './identity.ts';
import { createMemoryKv } from './kv.ts';
import { open, seal } from './secrets.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const CONSOLE = 'https://app.fruitback.test';
const SITE = 'https://staging.acme.dev';
const LINEAR_KEY = 'lin_api_the_real_key_of_acme';
const directories: string[] = [];

afterEach(() => {
  mock.restoreAll();
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-connectors-'));
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
    ...overrides,
    // The path of the SQLite store is that store's own variable, so `WorkerEnv` does not name it.
  } as WorkerEnv;
}

/**
 * Linear, as far as a connector uses it: it answers the key it knows and refuses every other one, and
 * keeps the issues it receives, by team.
 */
function fakeLinear(keys: string[] = [LINEAR_KEY]) {
  const issues: { teamId: string; projectId?: string; description: string; id: string }[] = [];
  const asked: string[] = [];
  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
    asked.push(init.headers.Authorization ?? '');
    if (!keys.includes(init.headers.Authorization ?? ''))
      return Response.json({ errors: [{ message: 'no' }] }, { status: 401 });
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];

    if (operation === 'FruitbackTeams') {
      return Response.json({
        data: {
          viewer: { name: 'Camille' },
          teams: {
            nodes: [
              {
                id: 'team_design',
                name: 'Design',
                key: 'DES',
                projects: { nodes: [{ id: 'proj_site', name: 'Site' }] },
              },
            ],
          },
        },
      });
    }
    if (operation === 'FruitbackLabels') return Response.json({ data: { team: { labels: { nodes: [] } } } });
    if (operation === 'FruitbackCreateLabel') {
      const { name } = variables.input as { name: string };

      return Response.json({ data: { issueLabelCreate: { issueLabel: { id: `label_${name}`, name } } } });
    }
    if (operation === 'FruitbackCreateIssue') {
      const input = variables.input as { teamId: string; projectId?: string; description: string };
      const id = `issue_${issues.length + 1}`;
      issues.push({
        teamId: input.teamId,
        description: input.description,
        id,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });

      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id,
              identifier: `DES-${issues.length}`,
              url: `https://linear.app/acme/issue/DES-${issues.length}`,
            },
          },
        },
      });
    }
    if (operation === 'FruitbackIssues') {
      const filter = variables.filter as { team: { id: { eq: string } }; description: { contains: string } };
      const nodes = issues
        .filter(
          (issue) => issue.teamId === filter.team.id.eq && issue.description.includes(filter.description.contains),
        )
        .map((issue, index) => ({
          id: issue.id,
          identifier: `DES-${index + 1}`,
          url: `https://linear.app/acme/issue/DES-${index + 1}`,
          title: 'A note',
          updatedAt: '2026-10-09T10:00:00.000Z',
          description: issue.description,
          state: { name: 'In Progress', type: 'started' },
          comments: { nodes: [] },
        }));

      return Response.json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }

    return Response.json({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return { issues, asked };
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
    { clientIp: `203.0.113.${ip % 250}`, kv: createMemoryKv() },
  );
}

/** A workspace with its owner, a member, a guest and one site read by everyone. */
async function acme(env: WorkerEnv) {
  const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const person = async (email: string) => {
    const account = await accounts.signIn({ provider: 'email', subject: email, email });

    return { account, token: await signIdentityToken({ sub: account.id, exp }, SECRET) };
  };
  const owner = await person('owner@acme.dev');
  const workspace = await accounts.createWorkspace('Acme', owner.account.id);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;

  return { accounts, owner, workspace, site, base, person };
}

async function connected(env: WorkerEnv, world: Awaited<ReturnType<typeof acme>>): Promise<string> {
  const added = await call(env, 'POST', `${world.base}/connectors`, {
    token: world.owner.token,
    body: { kind: 'linear', apiKey: LINEAR_KEY },
  });
  assert.equal(added.status, 201, await added.clone().text());

  return ((await added.json()) as { id: string }).id;
}

function note(site: string, path = '/pricing') {
  const seed = seedFixture();

  return { ...seed, page: { ...seed.page, url: `${SITE}${path}` }, client: { id: site } };
}

describe('a workspace connects Linear (FRU-121)', () => {
  it('keeps the key encrypted, and never answers it', async () => {
    const env = envWith();
    fakeLinear();
    const world = await acme(env);

    const added = await call(env, 'POST', `${world.base}/connectors`, {
      token: world.owner.token,
      body: { kind: 'linear', apiKey: LINEAR_KEY },
    });
    const body = await added.text();
    const listed = await (await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token })).text();

    assert.equal(added.status, 201);
    assert.match(body, /"label":"Linear · Camille"/);
    assert.equal(body.includes(LINEAR_KEY) || listed.includes(LINEAR_KEY), false, 'no route answers the key');
    closeAccountConnections();
    const directory = dirname(env.FRUITBACK_ACCOUNTS_PATH as string);
    const onDisk = readdirSync(directory)
      .filter((file) => file.startsWith('accounts.db'))
      .map((file) => readFileSync(join(directory, file)).toString('latin1'))
      .join('');
    assert.equal(onDisk.includes(LINEAR_KEY), false, 'the file holds no key in the clear');
    assert.ok(onDisk.includes('Camille'), 'the control: the row is in the bytes that were read');
  });

  it('stores nothing for a key Linear refuses', async () => {
    const env = envWith();
    fakeLinear();
    const world = await acme(env);

    const refused = await call(env, 'POST', `${world.base}/connectors`, {
      token: world.owner.token,
      body: { kind: 'linear', apiKey: 'lin_api_wrong' },
    });

    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'key-refused' });
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), []);
  });

  it('says Linear is down, not that the key is refused, when Linear does not answer', async () => {
    const env = envWith();
    const world = await acme(env);
    const body = { kind: 'linear', apiKey: LINEAR_KEY };

    mock.method(globalThis, 'fetch', async () => new Response('bad gateway', { status: 502 }));
    const down = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const unreachable = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () =>
      Response.json(
        { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] },
        { status: 400 },
      ),
    );
    const refused = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });

    assert.deepEqual([down.status, unreachable.status], [502, 502]);
    assert.deepEqual(await down.json(), { error: 'store-unavailable' });
    assert.deepEqual(
      await refused.json(),
      { error: 'key-refused' },
      'a refusal Linear words as an error, under any status',
    );
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), [], 'no key is kept in any of the three');
  });

  it('sends the notes of a site to the team it chose, and reads them back from there', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);

    const teams = await call(env, 'GET', `${world.base}/connectors/${connector}/teams`, { token: world.owner.token });
    assert.deepEqual(
      ((await teams.json()) as { teams: { id: string }[] }).teams.map((team) => team.id),
      ['team_design'],
    );

    const set = await call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
      token: world.owner.token,
      body: { connector, teamId: 'team_design', projectId: 'proj_site' },
    });
    assert.equal(set.status, 200);

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 201, await written.clone().text());
    assert.deepEqual(
      linear.issues.map(({ teamId, projectId }) => ({ teamId, projectId })),
      [{ teamId: 'team_design', projectId: 'proj_site' }],
    );

    const read = await call(
      env,
      'GET',
      `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${world.site.id}`,
      {
        origin: SITE,
      },
    );
    const issues = ((await read.json()) as { issues: { identifier: string; stateName: string }[] }).issues;
    assert.deepEqual(
      issues.map((issue) => [issue.identifier, issue.stateName]),
      [['DES-1', 'In Progress']],
    );
  });

  it('keeps the notes of a site with no destination in the worker, and asks Linear nothing', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    await connected(env, world);
    linear.asked.length = 0;

    const written = await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });

    assert.equal(written.status, 201);
    assert.deepEqual(linear.asked, []);
    assert.deepEqual(linear.issues, []);
  });

  it('answers 502, and writes nowhere else, when the connector cannot be used', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await world.accounts.setDestination(world.workspace.id, world.site.id, { connector, teamId: 'team_design' });

    // The key the worker holds no longer opens what the file keeps.
    const moved = { ...env, FRUITBACK_SECRETS_KEY: 'a-different-key-of-at-least-32-chars' };
    const written = await call(moved, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) });
    assert.equal(written.status, 502);
    assert.equal(((await written.json()) as { error: string }).error, 'store-unavailable');

    // And with the right key again, the page holds no note: nothing fell into the worker's own store.
    const read = await call(
      env,
      'GET',
      `/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${world.site.id}`,
      {
        origin: SITE,
      },
    );
    assert.deepEqual(((await read.json()) as { issues: unknown[] }).issues, []);
    assert.deepEqual(linear.issues, []);
  });

  it('gives the notes back to the worker when the connector is removed', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await world.accounts.setDestination(world.workspace.id, world.site.id, { connector, teamId: 'team_design' });

    const removed = await call(env, 'DELETE', `${world.base}/connectors/${connector}`, { token: world.owner.token });
    assert.equal(removed.status, 204);
    linear.asked.length = 0;

    assert.equal((await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) })).status, 201);
    assert.deepEqual(linear.asked, []);
    assert.equal((await world.accounts.sites(world.workspace.id))[0]?.destination, undefined);
  });
});

describe('who may touch a connector (FRU-121)', () => {
  it('lets an owner add and remove one, a member see it, and a guest see nothing of the tracker', async () => {
    const env = envWith();
    fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await world.accounts.setDestination(world.workspace.id, world.site.id, { connector, teamId: 'team_design' });
    closeAccountConnections();
    const { DatabaseSync } = await import('node:sqlite');
    const member = await world.person('member@acme.dev');
    const guest = await world.person('guest@acme.dev');
    closeAccountConnections();
    const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    for (const [person, role] of [
      [member, 'member'],
      [guest, 'guest'],
    ] as const) {
      database
        .prepare('INSERT INTO members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, 1)')
        .run(world.workspace.id, person.account.id, role);
    }
    database.close();
    const body = { kind: 'linear', apiKey: LINEAR_KEY };

    assert.equal((await call(env, 'GET', `${world.base}/connectors`, { token: member.token })).status, 200);
    assert.equal((await call(env, 'POST', `${world.base}/connectors`, { token: member.token, body })).status, 403);
    assert.equal(
      (await call(env, 'DELETE', `${world.base}/connectors/${connector}`, { token: member.token })).status,
      403,
    );
    assert.equal(
      (await call(env, 'GET', `${world.base}/connectors/${connector}/teams`, { token: member.token })).status,
      403,
    );

    assert.equal((await call(env, 'GET', `${world.base}/connectors`, { token: guest.token })).status, 403);
    const sitesOf = async (token: string) =>
      (
        (await (await call(env, 'GET', `${world.base}/sites`, { token })).json()) as {
          sites: { destination?: unknown }[];
        }
      ).sites;
    assert.equal((await sitesOf(guest.token))[0]?.destination, undefined, 'a guest does not learn where the notes go');
    assert.deepEqual((await sitesOf(member.token))[0]?.destination, { connector, teamId: 'team_design' });
  });

  it('refuses a destination through the connector of another workspace', async () => {
    const env = envWith();
    fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    const other = await world.person('other@else.dev');
    const elsewhere = await world.accounts.createWorkspace('Elsewhere', other.account.id);
    const theirs = await world.accounts.addSite(elsewhere.id, { origin: 'https://else.dev', visibility: 'everyone' });

    const set = await call(env, 'POST', `/console/workspaces/${elsewhere.id}/sites/${theirs.id}/destination`, {
      token: other.token,
      body: { connector, teamId: 'team_design' },
    });
    const teams = await call(env, 'GET', `/console/workspaces/${elsewhere.id}/connectors/${connector}/teams`, {
      token: other.token,
    });

    assert.equal(set.status, 404);
    assert.equal(teams.status, 404);
    assert.equal((await world.accounts.sites(elsewhere.id))[0]?.destination, undefined);
  });

  it('does not write through the key of another workspace, whatever the row of the site says', async () => {
    const env = envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    const other = await world.person('other@else.dev');
    const elsewhere = await world.accounts.createWorkspace('Elsewhere', other.account.id);
    const theirs = await world.accounts.addSite(elsewhere.id, { origin: 'https://else.dev', visibility: 'everyone' });
    // A row no route can write: the store refuses it. Written by hand, as a damaged file would hold it.
    closeAccountConnections();
    const { DatabaseSync } = await import('node:sqlite');
    const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    database
      .prepare("UPDATE sites SET connector_id = ?, team_id = 'team_design' WHERE id = ?")
      .run(connector, theirs.id);
    database.close();
    linear.asked.length = 0;
    const seed = seedFixture();

    const written = await call(env, 'POST', '/feedback', {
      origin: 'https://else.dev',
      body: { ...seed, page: { ...seed.page, url: 'https://else.dev/' }, client: { id: theirs.id } },
    });

    assert.equal(written.status, 502);
    assert.deepEqual(linear.issues, []);
    assert.deepEqual(linear.asked, [], 'the key of Acme was never sent');
  });

  it('offers no connector on a worker with no key to encrypt one', async () => {
    const env = envWith({ FRUITBACK_SECRETS_KEY: undefined });
    fakeLinear();
    const world = await acme(env);

    const listed = (await (
      await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token })
    ).json()) as { available: boolean };
    const added = await call(env, 'POST', `${world.base}/connectors`, {
      token: world.owner.token,
      body: { kind: 'linear', apiKey: LINEAR_KEY },
    });

    assert.equal(listed.available, false);
    assert.equal(added.status, 404);
  });
});

describe('the key that encrypts the connectors', () => {
  it('opens what it sealed, and nothing another key or another hand wrote', () => {
    const sealed = seal('lin_api_x', SECRETS_KEY);

    assert.equal(open(sealed, SECRETS_KEY), 'lin_api_x');
    assert.equal(sealed.includes('lin_api_x'), false);
    assert.notEqual(seal('lin_api_x', SECRETS_KEY), sealed, 'two seals of one key differ');
    assert.equal(open(sealed, 'a-different-key-of-at-least-32-chars'), undefined);
    assert.equal(open(`${sealed.slice(0, -2)}AA`, SECRETS_KEY), undefined, 'a changed value does not open');
    assert.equal(open('not sealed', SECRETS_KEY), undefined);
  });

  it('must differ from the identity secret, and needs the accounts', () => {
    assert.equal(readConfig(envWith({ FRUITBACK_SECRETS_KEY: SECRET })).ok, false);
    assert.equal(readConfig(envWith({ FRUITBACK_SECRETS_KEY: 'short' })).ok, false);
    const alone = envWith();
    delete alone.FRUITBACK_ACCOUNTS_PATH;
    delete alone.FRUITBACK_CONSOLE_URL;
    assert.equal(readConfig(alone).ok, false);
    assert.equal(readConfig(envWith()).ok, true);
  });
});

import { afterEach, describe, it, vi } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { IDENTITY_SECRET, envWith as workerEnv } from './auth-worker.fixture.ts';
import { type CallOptions, type World, callOn, memberOf, signInTo, worlds } from './console-world.fixture.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { createMemoryKv } from './kv.ts';
import { rowsOf } from './postgres.fixture.ts';
import { open, seal } from './secrets.ts';

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';
const LINEAR_KEY = 'lin_api_the_real_key_of_acme';
const opened = worlds();

afterEach(() => {
  vi.restoreAllMocks();
});

function envWith(overrides: Partial<WorkerEnv> = {}): Promise<World> {
  return opened({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY, ...overrides } });
}

/**
 * Linear, as far as a connector uses it: it answers the key it knows and refuses every other one, and
 * keeps the issues it receives, by team.
 */
function fakeLinear(keys: string[] = [LINEAR_KEY]) {
  const issues: { teamId: string; projectId?: string; description: string; id: string }[] = [];
  const asked: string[] = [];
  mockMethod(globalThis, 'fetch', async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
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
      const filter = variables.filter as { team: { id: { eq: string } }; and: { description: { contains: string } }[] };
      const nodes = issues
        .filter(
          (issue) =>
            issue.teamId === filter.team.id.eq &&
            filter.and.every((clause) => issue.description.includes(clause.description.contains)),
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

/** A request with a cache of its own: no read is answered by the cache of the request before. */
function call(env: World, method: string, path: string, options: CallOptions = {}): Promise<Response> {
  return callOn(env, method, path, options, { kv: createMemoryKv() });
}

/** A workspace with its owner and one site read by everyone. `person` signs somebody else in. */
async function acme(env: World) {
  const accounts = env.accounts;
  const person = async (email: string) => {
    const { id, token } = await signInTo(env, email);

    return { account: { id }, token };
  };
  const owner = await person('owner@acme.dev');
  const workspace = await accounts.createWorkspace('Acme', owner.account.id);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;

  return { accounts, owner, workspace, site, base, person };
}

async function connected(env: World, world: Awaited<ReturnType<typeof acme>>): Promise<string> {
  const added = await call(env, 'POST', `${world.base}/connectors`, {
    token: world.owner.token,
    body: { kind: 'linear', apiKey: LINEAR_KEY },
  });
  assert.equal(added.status, 201, await added.clone().text());

  return ((await added.json()) as { id: string }).id;
}

function note(site: string, path = '/pricing') {
  const base = noteFixture();

  return { ...base, page: { ...base.page, url: `${SITE}${path}` }, client: { id: site } };
}

describe('a workspace connects Linear (FRU-121)', () => {
  it('keeps the key encrypted, and never answers it', async () => {
    const env = await envWith();
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
    const tables = await rowsOf(env.database, "SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    let inDatabase = '';
    for (const { tablename } of tables) {
      inDatabase += JSON.stringify(await rowsOf(env.database, `SELECT * FROM "${String(tablename)}"`));
    }
    assert.equal(inDatabase.includes(LINEAR_KEY), false, 'the database holds no key in the clear');
    assert.ok(inDatabase.includes('Camille'), 'the control: the row is in the rows that were read');
  });

  it('stores nothing for a key Linear refuses', async () => {
    const env = await envWith();
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
    const env = await envWith();
    const world = await acme(env);
    const body = { kind: 'linear', apiKey: LINEAR_KEY };

    mockMethod(globalThis, 'fetch', async () => new Response('bad gateway', { status: 502 }));
    const down = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });
    vi.restoreAllMocks();
    mockMethod(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const unreachable = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });
    vi.restoreAllMocks();
    mockMethod(globalThis, 'fetch', async () =>
      Response.json(
        { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] },
        { status: 400 },
      ),
    );
    const refused = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });

    vi.restoreAllMocks();
    mockMethod(globalThis, 'fetch', async () => Response.json({ errors: [{ message: 'Forbidden' }] }, { status: 403 }));
    const forbidden = await call(env, 'POST', `${world.base}/connectors`, { token: world.owner.token, body });
    assert.deepEqual(
      await forbidden.json(),
      { error: 'key-lacks-access' },
      'a key Linear knows is not one to type again',
    );

    assert.deepEqual([down.status, unreachable.status], [502, 502]);
    assert.deepEqual(await down.json(), { error: 'store-unavailable' });
    assert.deepEqual(
      await refused.json(),
      { error: 'key-refused' },
      'a refusal Linear words as an error, under any status',
    );
    assert.deepEqual(await world.accounts.connectors(world.workspace.id), [], 'no key is kept in any of the four');
  });

  it('sends the notes of a site to the team it chose, and reads them back from there', async () => {
    const env = await envWith();
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
    const env = await envWith();
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
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await world.accounts.setDestination(world.workspace.id, world.site.id, { connector, teamId: 'team_design' });

    // The key the worker holds no longer opens what the database keeps.
    const moved = { ...env, env: { ...env.env, FRUITBACK_SECRETS_KEY: 'a-different-key-of-at-least-32-chars' } };
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
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await world.accounts.setDestination(world.workspace.id, world.site.id, { connector, teamId: 'team_design' });

    const removed = await call(env, 'DELETE', `${world.base}/connectors/${connector}`, { token: world.owner.token });
    assert.equal(removed.status, 204);
    linear.asked.length = 0;

    assert.equal((await call(env, 'POST', '/feedback', { origin: SITE, body: note(world.site.id) })).status, 201);
    assert.deepEqual(linear.asked, []);
    assert.deepEqual((await world.accounts.sites(world.workspace.id))[0]?.destinations, []);
  });
});

describe('who may touch a connector (FRU-121)', () => {
  it('lets an owner add and remove one, a member see it, and a guest see nothing of the tracker', async () => {
    const env = await envWith();
    fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await world.accounts.setDestination(world.workspace.id, world.site.id, { connector, teamId: 'team_design' });
    const member = await world.person('member@acme.dev');
    const guest = await world.person('guest@acme.dev');
    for (const [person, role] of [
      [member, 'member'],
      [guest, 'guest'],
    ] as const) {
      await memberOf(env, world.workspace.id, person.account.id, role);
    }
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
    const env = await envWith();
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
    assert.deepEqual((await world.accounts.sites(elsewhere.id))[0]?.destinations, []);
  });

  it('does not write through the key of another workspace, whatever the row of the site says', async () => {
    const env = await envWith();
    const linear = fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    const other = await world.person('other@else.dev');
    const elsewhere = await world.accounts.createWorkspace('Elsewhere', other.account.id);
    const theirs = await world.accounts.addSite(elsewhere.id, { origin: 'https://else.dev', visibility: 'everyone' });
    // A row no route can write: the store refuses it. Written by hand, as a damaged database would hold it.
    await rowsOf(
      env.database,
      `INSERT INTO site_destinations (site_id, position, connector_id, team_id)
         VALUES ('${theirs.id}', 0, '${connector}', 'team_design')`,
    );
    linear.asked.length = 0;
    const base = noteFixture();

    const written = await call(env, 'POST', '/feedback', {
      origin: 'https://else.dev',
      body: { ...base, page: { ...base.page, url: 'https://else.dev/' }, client: { id: theirs.id } },
    });

    assert.equal(written.status, 502);
    assert.deepEqual(linear.issues, []);
    assert.deepEqual(linear.asked, [], 'the key of Acme was never sent');
  });

  it('offers no connector on a worker with no key to encrypt one', async () => {
    const env = await envWith({ FRUITBACK_SECRETS_KEY: undefined });
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

describe('a workspace names its connector (FRU-404)', () => {
  type Listed = { connectors: { id: string; label: string; name?: string }[] };
  const listed = async (env: World, world: Awaited<ReturnType<typeof acme>>) =>
    ((await (await call(env, 'GET', `${world.base}/connectors`, { token: world.owner.token })).json()) as Listed)
      .connectors;

  it('keeps the name an owner gives, beside the label of the worker, and takes it away again', async () => {
    const env = await envWith();
    fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    const other = await connected(env, world);
    assert.equal((await listed(env, world))[0]?.name, undefined, 'no name until one is given');

    const named = await call(env, 'POST', `${world.base}/connectors/${connector}`, {
      token: world.owner.token,
      body: { name: '  Linear   of the  clients ' },
    });
    assert.equal(named.status, 200);
    const view = (await named.json()) as { id: string; label: string; name?: string };
    assert.equal(view.id, connector);
    assert.equal(view.name, 'Linear of the clients', 'one line, its spaces made one');
    const [first, second] = await listed(env, world);
    assert.equal(first?.name, 'Linear of the clients');
    assert.equal(first?.label, view.label, 'the label of the worker does not move');
    assert.equal(second?.id, other);
    assert.equal(second?.name, undefined, 'one connector, not its neighbour');

    for (const name of [null, '', '   ']) {
      await call(env, 'POST', `${world.base}/connectors/${connector}`, {
        token: world.owner.token,
        body: { name: 'Again' },
      });
      const cleared = await call(env, 'POST', `${world.base}/connectors/${connector}`, {
        token: world.owner.token,
        body: { name },
      });
      assert.equal(cleared.status, 200, JSON.stringify(name));
      assert.equal(((await cleared.json()) as { name?: string }).name, undefined, JSON.stringify(name));
    }
  });

  it('refuses a name that is not one, and keeps the one before', async () => {
    const env = await envWith();
    fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    await call(env, 'POST', `${world.base}/connectors/${connector}`, {
      token: world.owner.token,
      body: { name: 'Clients' },
    });

    for (const body of [{}, { name: 42 }, { name: 'x'.repeat(81) }]) {
      const refused = await call(env, 'POST', `${world.base}/connectors/${connector}`, {
        token: world.owner.token,
        body,
      });
      assert.equal(refused.status, 400, JSON.stringify(body));
      assert.deepEqual(await refused.json(), { error: 'invalid-name' });
    }
    assert.equal((await listed(env, world))[0]?.name, 'Clients');
  });

  it('lets only who manages the workspace name a connector, and only one of their own', async () => {
    const env = await envWith();
    fakeLinear();
    const world = await acme(env);
    const connector = await connected(env, world);
    const member = await world.person('member@acme.dev');
    await memberOf(env, world.workspace.id, member.account.id, 'member');
    const other = await world.person('other@else.dev');
    const elsewhere = await world.accounts.createWorkspace('Elsewhere', other.account.id);

    const byMember = await call(env, 'POST', `${world.base}/connectors/${connector}`, {
      token: member.token,
      body: { name: 'Mine' },
    });
    const fromElsewhere = await call(env, 'POST', `/console/workspaces/${elsewhere.id}/connectors/${connector}`, {
      token: other.token,
      body: { name: 'Mine' },
    });

    assert.equal(byMember.status, 403);
    assert.equal(fromElsewhere.status, 404);
    assert.equal((await listed(env, world))[0]?.name, undefined);
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
    assert.equal(readConfig(workerEnv({ FRUITBACK_SECRETS_KEY: IDENTITY_SECRET })).ok, false);
    assert.equal(readConfig(workerEnv({ FRUITBACK_SECRETS_KEY: 'short' })).ok, false);
    const alone = workerEnv({ FRUITBACK_SECRETS_KEY: SECRETS_KEY });
    delete alone.FRUITBACK_DATABASE_URL;
    delete alone.FRUITBACK_CONSOLE_URL;
    assert.equal(readConfig(alone).ok, false);
    assert.equal(readConfig(workerEnv({ FRUITBACK_SECRETS_KEY: SECRETS_KEY })).ok, true);
  });
});

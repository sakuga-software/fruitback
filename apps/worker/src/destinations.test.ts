import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type Role, destinationId } from './accounts.ts';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { handleRequest } from './app.ts';
import type { WorkerEnv } from './env.ts';
import { signIdentityToken } from './identity.ts';
import { type Kv, createMemoryKv } from './kv.ts';
import { closeSessionConnections } from './session-sqlite.ts';

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
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-destinations-'));
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

/** Every text a filter of Linear looks for in a description, wherever the clause is. */
function wanted(filter: unknown): string[] {
  if (typeof filter !== 'object' || filter === null) return [];

  return Object.entries(filter).flatMap(([key, value]) =>
    key === 'contains' && typeof value === 'string' ? [value] : wanted(value),
  );
}

/** Linear with two teams. It keeps each issue with its team, and a read answers one team only. */
function twoTeams() {
  const issues: { teamId: string; projectId?: string; description: string }[] = [];
  const reads: string[] = [];
  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
    if (init.headers.Authorization !== LINEAR_KEY)
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
              { id: 'team_support', name: 'Support', key: 'SUP', projects: { nodes: [] } },
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
      issues.push({
        teamId: input.teamId,
        description: input.description,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      });
      const identifier = `LIN-${issues.length}`;

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
      const filter = variables.filter as { team: { id: { eq: string } } };
      reads.push(filter.team.id.eq);
      const nodes = issues
        .map((issue, index) => ({ issue, identifier: `LIN-${index + 1}` }))
        .filter(({ issue }) => issue.teamId === filter.team.id.eq)
        .filter(({ issue }) => wanted(variables.filter).every((text) => issue.description.includes(text)))
        .map(({ issue, identifier }) => ({
          id: identifier,
          identifier,
          url: `https://linear.app/acme/issue/${identifier}`,
          title: 'A note',
          updatedAt: '2026-10-09T10:00:00.000Z',
          description: issue.description,
          state: { name: 'Todo', type: 'unstarted' },
          comments: { nodes: [] },
        }));

      return Response.json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }

    return Response.json({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return { issues, reads };
}

let ip = 0;
function call(
  env: WorkerEnv,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string; kv?: Kv } = {},
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
    { clientIp: `203.0.113.${ip % 250}`, kv: options.kv ?? createMemoryKv() },
  );
}

type Offered = { id: string; label?: string }[];

/** A workspace with a Linear connector and one site. Each person has a console token and a session. */
async function acme(env: WorkerEnv) {
  const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const owner = await accounts.signIn({ provider: 'email', subject: 'owner@acme.dev', email: 'owner@acme.dev' });
  const workspace = await accounts.createWorkspace('Acme', owner.id);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;
  const consoleToken = await signIdentityToken({ sub: owner.id, exp }, SECRET);
  /** The token of an extension session: the worker key, and the workspace of the session. */
  const sessionOf = (account: string, ws = workspace.id) => signIdentityToken({ sub: account, ws, exp }, SECRET);
  /** Somebody of the workspace with this role. The file is written by hand: no route invites yet (FRU-104). */
  const person = async (role: Role) => {
    const email = `${role}@acme.dev`;
    const account = await accounts.signIn({ provider: 'email', subject: email, email });
    closeAccountConnections();
    const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    database
      .prepare('INSERT INTO members (workspace_id, account_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(workspace.id, account.id, role, Date.now());
    database.close();

    return { account, session: await sessionOf(account.id) };
  };

  const added = await call(env, 'POST', `${base}/connectors`, {
    token: consoleToken,
    body: { kind: 'linear', apiKey: LINEAR_KEY },
  });
  assert.equal(added.status, 201, await added.clone().text());
  const connector = ((await added.json()) as { id: string }).id;
  const place = (destinations: unknown, token = consoleToken) =>
    call(env, 'POST', `${base}/sites/${site.id}/destinations`, { token, body: { destinations } });

  const read = async (options: { token?: string; kv?: Kv } = {}) => {
    const answer = await call(env, 'GET', `/feedback?url=${encodeURIComponent(PAGE)}&client=${site.id}`, {
      origin: SITE,
      ...options,
    });
    const body = (await answer.json()) as { issues?: { seed: { note: string } }[]; destinations?: Offered };

    return { status: answer.status, notes: (body.issues ?? []).map((issue) => issue.seed.note), body };
  };
  let written = 0;
  const write = (text: string, options: { token?: string; destination?: string } = {}) => {
    const seed = seedFixture();
    written += 1;

    return call(
      env,
      'POST',
      options.destination === undefined ? '/feedback' : `/feedback?destination=${options.destination}`,
      {
        origin: SITE,
        ...(options.token === undefined ? {} : { token: options.token }),
        body: {
          ...seed,
          id: `seed-${written}`,
          note: text,
          page: { ...seed.page, url: PAGE },
          client: { id: site.id },
        },
      },
    );
  };

  return {
    accounts,
    workspace,
    site,
    base,
    connector,
    consoleToken,
    ownerSession: await sessionOf(owner.id),
    sessionOf,
    person,
    place,
    read,
    write,
  };
}

const DESIGN = 'team_design';
const SUPPORT = 'team_support';

describe('a site that can send to several places (FRU-123)', () => {
  it('keeps the places in order, each with the label the tracker gives, and the first is the one of the client', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);

    const set = await world.place([
      { connector: world.connector, teamId: SUPPORT },
      { connector: world.connector, teamId: DESIGN, projectId: 'proj_site' },
    ]);

    assert.equal(set.status, 200, await set.clone().text());
    assert.deepEqual((await world.accounts.sites(world.workspace.id))[0]?.destinations, [
      { connector: world.connector, teamId: SUPPORT, label: 'Linear · Support' },
      { connector: world.connector, teamId: DESIGN, projectId: 'proj_site', label: 'Linear · Design · Site' },
    ]);
    const client = (await world.accounts.clientMap())[world.site.id];
    assert.equal(client?.teamId, SUPPORT);
    assert.equal(client?.projectId, undefined);
    assert.equal(client?.destinations?.length, 2);
  });

  it('refuses a sixth place, the same place twice, and a team the key does not reach, and keeps nothing', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);
    const one = { connector: world.connector, teamId: DESIGN };

    const six = await world.place(Array.from({ length: 6 }, () => one));
    const twice = await world.place([one, one]);
    const unknown = await world.place([one, { connector: world.connector, teamId: 'team_of_nobody' }]);
    const elsewhere = await world.place([{ connector: 'con_of_another_workspace', teamId: DESIGN }]);

    assert.deepEqual([six.status, twice.status, unknown.status, elsewhere.status], [400, 400, 400, 404]);
    assert.deepEqual((await world.accounts.sites(world.workspace.id))[0]?.destinations, []);
  });

  it('lets an owner set the places, and not a member', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);
    const member = await world.person('member');
    const memberConsole = await signIdentityToken(
      { sub: member.account.id, exp: Math.floor(Date.now() / 1000) + 600 },
      SECRET,
    );

    assert.equal((await world.place([{ connector: world.connector, teamId: DESIGN }], memberConsole)).status, 403);
  });

  it('gives the next place to a site whose first connector goes', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);
    const second = await call(env, 'POST', `${world.base}/connectors`, {
      token: world.consoleToken,
      body: { kind: 'linear', apiKey: LINEAR_KEY },
    });
    const other = ((await second.json()) as { id: string }).id;
    await world.place([
      { connector: world.connector, teamId: DESIGN },
      { connector: other, teamId: SUPPORT },
    ]);

    await world.accounts.removeConnector(world.workspace.id, world.connector);

    assert.deepEqual(
      (await world.accounts.sites(world.workspace.id))[0]?.destinations.map((each) => [each.connector, each.teamId]),
      [[other, SUPPORT]],
    );
  });

  it('keeps the one destination a site had before the list existed', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);
    // The file as the version before held it: the three columns of the site, and no table.
    closeAccountConnections();
    const database = new DatabaseSync(env.FRUITBACK_ACCOUNTS_PATH as string);
    const { user_version: version } = database.prepare('PRAGMA user_version').get() as { user_version: number };
    database.exec('DROP TABLE site_destinations');
    database
      .prepare("UPDATE sites SET connector_id = ?, team_id = 'team_design', project_id = 'proj_site' WHERE id = ?")
      .run(world.connector, world.site.id);
    database.exec(`PRAGMA user_version = ${version - 1}`);
    database.close();

    const after = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);

    assert.deepEqual((await after.sites(world.workspace.id))[0]?.destinations, [
      { connector: world.connector, teamId: DESIGN, projectId: 'proj_site' },
    ]);
  });
});

describe('who reads the places of a site (FRU-123)', () => {
  async function placed(env: WorkerEnv) {
    const world = await acme(env);
    await world.place([
      { connector: world.connector, teamId: DESIGN },
      { connector: world.connector, teamId: SUPPORT },
    ]);

    return world;
  }

  it('offers them to a member, by a name that says nothing of the connector or of the team', async () => {
    const env = envWith();
    twoTeams();
    const world = await placed(env);
    const member = await world.person('member');

    const { body } = await world.read({ token: member.session });

    assert.deepEqual(
      body.destinations?.map((each) => each.label),
      ['Linear · Design', 'Linear · Support'],
    );
    assert.deepEqual(
      body.destinations?.map((each) => each.id),
      [
        destinationId(world.site.id, { connector: world.connector, teamId: DESIGN }),
        destinationId(world.site.id, { connector: world.connector, teamId: SUPPORT }),
      ],
    );
    const text = JSON.stringify(body.destinations);
    for (const secret of [world.connector, DESIGN, SUPPORT]) assert.equal(text.includes(secret), false, secret);
  });

  it('offers them to nobody else: a visitor, a guest, a session of another workspace, a token of the site', async () => {
    const env = envWith();
    twoTeams();
    const world = await placed(env);
    const guest = await world.person('guest');
    const member = await world.person('member');
    const stranger = await world.accounts.signIn({ provider: 'email', subject: 's@else.dev', email: 's@else.dev' });
    const elsewhere = await world.accounts.createWorkspace('Elsewhere', stranger.id);

    assert.equal((await world.read()).body.destinations, undefined, 'a visitor');
    assert.equal((await world.read({ token: guest.session })).body.destinations, undefined, 'a guest');
    // The session of a member, with the workspace of somebody else in it: refused as a token.
    const foreign = await world.sessionOf(member.account.id, elsewhere.id);
    assert.equal((await world.read({ token: foreign })).body.destinations, undefined, 'another workspace');
    // A person who left the workspace keeps a token for some minutes: the role is read at the request.
    const gone = await world.sessionOf('acc_of_somebody_who_left');
    assert.equal((await world.read({ token: gone })).body.destinations, undefined, 'no member any more');
  });

  it('never keeps them in the cached answer: a visitor who reads after a member gets none', async () => {
    const env = envWith();
    const linear = twoTeams();
    const world = await placed(env);
    const member = await world.person('member');
    const kv = createMemoryKv();

    const first = await world.read({ token: member.session, kv });
    const second = await world.read({ kv });

    assert.equal(first.body.destinations?.length, 2);
    assert.equal(second.status, 200);
    assert.equal(second.body.destinations, undefined);
    // The control: the second read came from the cache, so this is the answer a cache could leak.
    assert.deepEqual(linear.reads, [DESIGN, SUPPORT]);
  });

  it('offers nothing for a site that keeps its notes in the worker', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);

    assert.equal((await world.read({ token: world.ownerSession })).body.destinations, undefined);
  });
});

describe('a note that goes where a member chose (FRU-123)', () => {
  async function placed(env: WorkerEnv) {
    const world = await acme(env);
    await world.place([
      { connector: world.connector, teamId: DESIGN },
      { connector: world.connector, teamId: SUPPORT },
    ]);
    const support = destinationId(world.site.id, { connector: world.connector, teamId: SUPPORT });

    return { world, support };
  }

  it('writes in the place chosen, in the first one when nobody chose, and reads the page from both', async () => {
    const env = envWith();
    const linear = twoTeams();
    const { world, support } = await placed(env);
    const member = await world.person('member');

    assert.equal((await world.write('For the first place.')).status, 201);
    assert.equal((await world.write('For support.', { token: member.session, destination: support })).status, 201);

    assert.deepEqual(
      linear.issues.map((issue) => issue.teamId),
      [DESIGN, SUPPORT],
    );
    assert.deepEqual((await world.read()).notes, ['For the first place.', 'For support.']);
  });

  it('refuses a choice from somebody who may not see the tracker, and a place the site does not have', async () => {
    const env = envWith();
    const linear = twoTeams();
    const { world, support } = await placed(env);
    const guest = await world.person('guest');
    const member = await world.person('member');

    const answers = [
      await world.write('A visitor chooses.', { destination: support }),
      await world.write('A guest chooses.', { token: guest.session, destination: support }),
      await world.write('A place of nobody.', { token: member.session, destination: 'dst_0000000000000000dead' }),
    ];

    for (const answer of answers) {
      assert.equal(answer.status, 403);
      assert.deepEqual(await answer.json(), { error: 'destination-not-allowed' });
    }
    assert.deepEqual(linear.issues, [], 'nothing was written, in the first place either');
  });

  it('shows each note once when two places are in one team', async () => {
    const env = envWith();
    twoTeams();
    const world = await acme(env);
    await world.place([
      { connector: world.connector, teamId: DESIGN },
      { connector: world.connector, teamId: DESIGN, projectId: 'proj_site' },
    ]);

    await world.write('One note.');

    assert.deepEqual((await world.read()).notes, ['One note.']);
  });

  it('asks the tracker once for a site with one place, as before', async () => {
    const env = envWith();
    const linear = twoTeams();
    const world = await acme(env);
    await world.place([{ connector: world.connector, teamId: DESIGN }]);

    await world.read();

    assert.deepEqual(linear.reads, [DESIGN]);
  });
});

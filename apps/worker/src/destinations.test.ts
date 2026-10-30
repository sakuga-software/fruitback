import { afterEach, describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { noteFixture } from '@fruitback/shared/note.fixture';
import { type Role, destinationId } from './accounts.ts';
import { IDENTITY_SECRET } from './auth-worker.fixture.ts';
import {
  type CallOptions,
  type World,
  callOn,
  memberOf,
  shareWith,
  signInTo,
  worlds,
} from './console-world.fixture.ts';
import { signIdentityToken } from './identity.ts';
import { mockMethod } from './mock.fixture.ts';
import { type Kv, createMemoryKv } from './kv.ts';

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const SITE = 'https://staging.acme.dev';
const PAGE = `${SITE}/pricing`;
const LINEAR_KEY = 'lin_api_the_real_key_of_acme';
const opened = worlds();

afterEach(() => {
  vi.restoreAllMocks();
});

function envWith(): Promise<World> {
  return opened({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
}

/** Every text a filter of Linear looks for in a description, wherever the clause is. */
function wanted(filter: unknown): string[] {
  if (typeof filter !== 'object' || filter === null) return [];

  return Object.entries(filter).flatMap(([key, value]) =>
    key === 'contains' && typeof value === 'string' ? [value] : wanted(value),
  );
}

/**
 * Linear with two teams. It keeps each issue with its team, and a read answers one team only.
 *
 * `answers.as` is how it answers now: `revoked` is a key somebody removed at Linear (`401`), and
 * `down` is a Linear that fails (`500`).
 */
function twoTeams() {
  const issues: { teamId: string; projectId?: string; description: string }[] = [];
  const reads: string[] = [];
  /** Each call, by its operation and its variables. */
  const asked: { operation: string | undefined; variables: Record<string, unknown> }[] = [];
  const answers = { as: 'working' as 'working' | 'revoked' | 'down' };
  mockMethod(globalThis, 'fetch', async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
    if (answers.as === 'down') return Response.json({ errors: [{ message: 'later' }] }, { status: 500 });
    if (answers.as === 'revoked' || init.headers.Authorization !== LINEAR_KEY)
      return Response.json({ errors: [{ message: 'no' }] }, { status: 401 });
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];
    asked.push({ operation, variables });

    // The list of the teams, who the key is, and the places of a site by their ids (FRU-501): one answer.
    if (operation === 'FruitbackTeams' || operation === 'FruitbackViewer' || operation === 'FruitbackPlaces') {
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

  return { issues, reads, answers, asked };
}

/** A request with a cache of its own, unless it gives one: `kv` is the cache two requests share. */
function call(
  env: World,
  method: string,
  path: string,
  { kv, ...options }: CallOptions & { kv?: Kv } = {},
): Promise<Response> {
  return callOn(env, method, path, options, { kv: kv ?? createMemoryKv() });
}

type Offered = { id: string; label?: string }[];

/** A workspace with a Linear connector and one site. Each person has a console cookie and a session. */
async function acme(env: World) {
  const accounts = env.accounts;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const { id: owner, token: consoleToken } = await signInTo(env, 'owner@acme.dev');
  const workspace = await accounts.createWorkspace('Acme', owner);
  const site = await accounts.addSite(workspace.id, { origin: SITE, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;
  /** The token of an extension session: the worker key, and the workspace of the session. */
  const sessionOf = (account: string, ws = workspace.id) =>
    signIdentityToken({ sub: account, ws, exp }, IDENTITY_SECRET);
  /** Somebody of the workspace with this role: the row an accepted invitation leaves. */
  const person = async (role: Role) => {
    const { id, token } = await signInTo(env, `${role}@acme.dev`);
    await memberOf(env, workspace.id, id, role);
    // A guest of the site (FRU-250): the share their invitation left.
    if (role === 'guest') await shareWith(env, workspace.id, id, [site.id]);

    return { account: { id }, console: token, session: await sessionOf(id) };
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
    const body = (await answer.json()) as { issues?: { note: { text: string } }[]; destinations?: Offered };

    return { status: answer.status, notes: (body.issues ?? []).map((issue) => issue.note.text), body };
  };
  let written = 0;
  const write = (text: string, options: { token?: string; destination?: string } = {}) => {
    const note = noteFixture();
    written += 1;

    return call(
      env,
      'POST',
      options.destination === undefined ? '/feedback' : `/feedback?destination=${options.destination}`,
      {
        origin: SITE,
        ...(options.token === undefined ? {} : { token: options.token }),
        body: {
          ...note,
          id: `sd_${written}`,
          text,
          page: { ...note.page, url: PAGE },
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
    ownerSession: await sessionOf(owner),
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
    const env = await envWith();
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

  it('asks Linear for the places it labels, in one call, and never for the list of its teams (FRU-501)', async () => {
    const env = await envWith();
    const linear = twoTeams();
    const world = await acme(env);
    linear.asked.length = 0;

    const set = await world.place([
      { connector: world.connector, teamId: SUPPORT },
      { connector: world.connector, teamId: DESIGN, projectId: 'proj_site' },
    ]);

    assert.equal(set.status, 200, await set.clone().text());
    assert.deepEqual(linear.asked, [
      { operation: 'FruitbackPlaces', variables: { teams: [SUPPORT, DESIGN], projects: ['proj_site'] } },
    ]);
  });

  it('gives a page of the teams to the picker, and the teams whose name holds a search (FRU-501)', async () => {
    const env = await envWith();
    const linear = twoTeams();
    const world = await acme(env);
    linear.asked.length = 0;
    const teams = (query: string) =>
      call(env, 'GET', `/console/workspaces/${world.workspace.id}/connectors/${world.connector}/teams${query}`, {
        token: world.consoleToken,
      });

    const first = await teams('');
    const found = await teams('?q=%20sup%20&after=c-1');
    const tooLong = await teams(`?q=${'x'.repeat(101)}`);

    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(found.status, 200);
    assert.equal(tooLong.status, 400);
    assert.deepEqual(
      linear.asked.map((one) => [one.operation, one.variables]),
      [
        ['FruitbackTeams', {}],
        ['FruitbackTeams', { after: 'c-1', filter: { name: { containsIgnoreCase: 'sup' } } }],
      ],
    );
  });

  it('refuses a sixth place, the same place twice, and a team the key does not reach, and keeps nothing', async () => {
    const env = await envWith();
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

  it('keeps the one destination with no label, and keeps no list, when the tracker refuses the key or is down', async () => {
    for (const as of ['revoked', 'down'] as const) {
      const env = await envWith();
      const linear = twoTeams();
      const world = await acme(env);
      const one = { connector: world.connector, teamId: DESIGN };
      linear.answers.as = as;

      // The list needs the label a member chooses by, so nothing is kept without the tracker. It is
      // the answer of a tracker that cannot be used, never a `500`. The key is not one the caller
      // gave: `key-refused` is for a key that is typed, when a connector is made.
      const list = await world.place([one, { connector: world.connector, teamId: SUPPORT }]);
      assert.equal(list.status, 502, as);
      assert.deepEqual(await list.json(), { error: 'store-unavailable' }, as);
      assert.deepEqual((await world.accounts.sites(world.workspace.id))[0]?.destinations, [], as);

      // The route of one destination does not stop for it: the place is kept, with no label.
      const single = await call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
        token: world.consoleToken,
        body: one,
      });
      assert.equal(single.status, 200, as);
      assert.deepEqual((await world.accounts.sites(world.workspace.id))[0]?.destinations, [one], as);

      vi.restoreAllMocks();
    }
  });

  it('notes a refused key on the connector from both routes, as the read of its teams does, and an answer ends it', async () => {
    /** What the console reads of the connector: the reason it needs somebody, or nothing. */
    const reasonOf = async (world: Awaited<ReturnType<typeof acme>>, env: World) => {
      const listed = await call(env, 'GET', `${world.base}/connectors`, { token: world.consoleToken });
      const body = (await listed.json()) as { connectors: { attention?: { reason: string } }[] };

      return body.connectors[0]?.attention?.reason;
    };
    for (const route of ['list', 'one'] as const) {
      for (const as of ['revoked', 'down'] as const) {
        const env = await envWith();
        const linear = twoTeams();
        const world = await acme(env);
        const one = { connector: world.connector, teamId: DESIGN };
        linear.answers.as = as;

        const asked =
          route === 'list'
            ? await world.place([one])
            : await call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, {
                token: world.consoleToken,
                body: one,
              });

        assert.equal(asked.status, route === 'list' ? 502 : 200, `${route} ${as}`);
        // A refusal is the workspace's to fix. A tracker that is down is nobody's, and is not noted.
        assert.equal(await reasonOf(world, env), as === 'revoked' ? 'key-refused' : undefined, `${route} ${as}`);

        linear.answers.as = 'working';
        assert.equal((await world.place([one])).status, 200, `${route} ${as}`);
        assert.equal(await reasonOf(world, env), undefined, `${route} ${as}`);

        vi.restoreAllMocks();
      }
    }
  });

  it('refuses one destination for a site that has two places or more, and keeps its list', async () => {
    const env = await envWith();
    twoTeams();
    const world = await acme(env);
    const both = [
      { connector: world.connector, teamId: DESIGN },
      { connector: world.connector, teamId: SUPPORT },
    ];
    const single = (body: unknown) =>
      call(env, 'POST', `${world.base}/sites/${world.site.id}/destination`, { token: world.consoleToken, body });
    assert.equal((await world.place(both)).status, 200);

    // A console of before the list knows one place: what it sends must not take the others away.
    for (const body of [{ connector: world.connector, teamId: SUPPORT }, { connector: null }]) {
      const refused = await single(body);
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), { error: 'site-has-destinations', count: 2 });
    }
    assert.deepEqual(
      (await world.accounts.sites(world.workspace.id))[0]?.destinations.map((each) => each.teamId),
      [DESIGN, SUPPORT],
    );

    // A site with one place keeps the route: one place takes the place of the other.
    assert.equal((await world.place([both[0]])).status, 200);
    assert.equal((await single(both[1])).status, 200);
    assert.deepEqual(
      (await world.accounts.sites(world.workspace.id))[0]?.destinations.map((each) => each.teamId),
      [SUPPORT],
    );
  });

  it('lets an owner set the places, and not a member', async () => {
    const env = await envWith();
    twoTeams();
    const world = await acme(env);
    const member = await world.person('member');

    assert.equal((await world.place([{ connector: world.connector, teamId: DESIGN }], member.console)).status, 403);
  });

  it('gives the next place to a site whose first connector goes', async () => {
    const env = await envWith();
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
});

describe('who reads the places of a site (FRU-123)', () => {
  async function placed(env: World) {
    const world = await acme(env);
    await world.place([
      { connector: world.connector, teamId: DESIGN },
      { connector: world.connector, teamId: SUPPORT },
    ]);

    return world;
  }

  it('offers them to a member, by a name that says nothing of the connector or of the team', async () => {
    const env = await envWith();
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
    const env = await envWith();
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
    const env = await envWith();
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
    const env = await envWith();
    twoTeams();
    const world = await acme(env);

    assert.equal((await world.read({ token: world.ownerSession })).body.destinations, undefined);
  });
});

describe('a note that goes where a member chose (FRU-123)', () => {
  async function placed(env: World) {
    const world = await acme(env);
    await world.place([
      { connector: world.connector, teamId: DESIGN },
      { connector: world.connector, teamId: SUPPORT },
    ]);
    const support = destinationId(world.site.id, { connector: world.connector, teamId: SUPPORT });

    return { world, support };
  }

  it('writes in the place chosen, in the first one when nobody chose, and reads the page from both', async () => {
    const env = await envWith();
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
    const env = await envWith();
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
    const env = await envWith();
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
    const env = await envWith();
    const linear = twoTeams();
    const world = await acme(env);
    await world.place([{ connector: world.connector, teamId: DESIGN }]);

    await world.read();

    assert.deepEqual(linear.reads, [DESIGN]);
  });
});

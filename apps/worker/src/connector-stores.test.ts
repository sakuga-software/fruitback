import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { type AccountStore, DEFAULT_CONNECTOR_SETTINGS } from './accounts.ts';
import type { ClientConfig, ClientPolicy } from './clients.ts';
import { createConnectorStores, createRoutedStore } from './connectors.ts';
import { type CallOptions, type World, callOn, memberOf, signInTo, worlds } from './console-world.fixture.ts';
import { createMemoryKv } from './kv.ts';
import { seal } from './secrets.ts';
import { createMemoryStore } from './linear-memory.ts';
import { type SeedStore, StoreError, takesReplies } from './store.ts';

const SECRETS_KEY = 'another-secret-that-opens-the-connectors';
const opened = worlds();

afterEach(() => {
  mock.restoreAll();
});

function envWith(): Promise<World> {
  return opened({ env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
}

/** Every `contains` of a filter, whatever its shape: a read names the page, and can name more. */
function wanted(filter: unknown): string[] {
  if (typeof filter !== 'object' || filter === null) return [];

  return Object.entries(filter).flatMap(([key, value]) =>
    key === 'contains' && typeof value === 'string' ? [value] : wanted(value),
  );
}

/**
 * Linear with several organisations: a key reaches the issues of its own organisation and no other.
 *
 * Every organisation has a team with the **same** id. A worker that sent a note with the key of
 * another workspace would then find a team to write to, and the test would see the note there.
 */
function linearOf(organisations: Record<string, string>) {
  const issues = new Map<string, { teamId: string; description: string }[]>(
    Object.values(organisations).map((name) => [name, []]),
  );
  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string; headers: Record<string, string> }) => {
    const organisation = organisations[init.headers.Authorization ?? ''];
    if (organisation === undefined) return Response.json({ errors: [{ message: 'no' }] }, { status: 401 });
    const kept = issues.get(organisation) as { teamId: string; description: string }[];
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];

    if (operation === 'FruitbackTeams') {
      return Response.json({
        data: {
          viewer: { name: organisation },
          teams: { nodes: [{ id: 'team_design', name: 'Design', key: 'DES', projects: { nodes: [] } }] },
        },
      });
    }
    if (operation === 'FruitbackStates') {
      const teams = variables.teams as string[];
      // Linear answers the states of every team the filter names, and of no other.
      const nodes = [
        { id: 'state_todo', name: 'Todo', type: 'unstarted', position: 1, team: { id: 'team_design', name: 'Design' } },
        {
          id: 'state_triage',
          name: 'Triage',
          type: 'triage',
          position: 0,
          team: { id: 'team_design', name: 'Design' },
        },
        { id: 'state_other', name: 'Todo', type: 'unstarted', position: 0, team: { id: 'team_other', name: 'Other' } },
      ].filter((state) => teams.includes(state.team.id));

      return Response.json({ data: { workflowStates: { nodes } } });
    }
    if (operation === 'FruitbackLabels') return Response.json({ data: { team: { labels: { nodes: [] } } } });
    if (operation === 'FruitbackCreateLabel') {
      const { name } = variables.input as { name: string };

      return Response.json({ data: { issueLabelCreate: { issueLabel: { id: `label_${name}`, name } } } });
    }
    if (operation === 'FruitbackCreateIssue') {
      const input = variables.input as { teamId: string; description: string };
      kept.push({ teamId: input.teamId, description: input.description });
      const identifier = `${organisation.toUpperCase()}-${kept.length}`;

      return Response.json({
        data: {
          issueCreate: {
            success: true,
            issue: { id: identifier, identifier, url: `https://linear.app/${organisation}/issue/${identifier}` },
          },
        },
      });
    }
    if (operation === 'FruitbackIssues') {
      const filter = variables.filter as { team: { id: { eq: string } } };
      const nodes = kept
        .map((issue, index) => ({ issue, identifier: `${organisation.toUpperCase()}-${index + 1}` }))
        .filter(({ issue }) => issue.teamId === filter.team.id.eq)
        .filter(({ issue }) => wanted(variables.filter).every((text) => issue.description.includes(text)))
        .map(({ issue, identifier }) => ({
          id: identifier,
          identifier,
          url: `https://linear.app/${organisation}/issue/${identifier}`,
          title: 'A note',
          updatedAt: '2026-10-09T10:00:00.000Z',
          description: issue.description,
          state: { id: 'state_todo', name: 'Todo', type: 'unstarted' },
          comments: {
            nodes: [{ id: `${identifier}-reply`, body: 'Seen.', createdAt: '2026-10-09T11:00:00.000Z', user: null }],
          },
        }));

      return Response.json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }

    return Response.json({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return issues;
}

/** A request with a cache of its own: no read is answered by the cache of the request before. */
function call(env: World, method: string, path: string, options: CallOptions = {}): Promise<Response> {
  return callOn(env, method, path, options, { kv: createMemoryKv() });
}

/** A workspace with its owner and one site, connected to Linear with its own key, through the console. */
async function tenant(env: World, name: string, origin: string, apiKey: string) {
  const accounts = env.accounts;
  const { id, token } = await signInTo(env, `owner@${name.toLowerCase()}.dev`);
  const account = { id };
  const workspace = await accounts.createWorkspace(name, account.id);
  const site = await accounts.addSite(workspace.id, { origin, visibility: 'everyone' });
  const base = `/console/workspaces/${workspace.id}`;

  const added = await call(env, 'POST', `${base}/connectors`, { token, body: { kind: 'linear', apiKey } });
  assert.equal(added.status, 201, await added.clone().text());
  const connector = ((await added.json()) as { id: string }).id;
  const set = await call(env, 'POST', `${base}/sites/${site.id}/destination`, {
    token,
    body: { connector, teamId: 'team_design' },
  });
  assert.equal(set.status, 200, await set.clone().text());

  const page = `${origin}/pricing`;
  const write = (text: string) => {
    const seed = seedFixture();

    return call(env, 'POST', '/feedback', {
      origin,
      body: { ...seed, note: text, page: { ...seed.page, url: page }, client: { id: site.id } },
    });
  };
  const read = async () => {
    const answer = await call(env, 'GET', `/feedback?url=${encodeURIComponent(page)}&client=${site.id}`, { origin });

    return ((await answer.json()) as { issues: { identifier: string; seed: { note: string } }[] }).issues.map(
      (issue) => [issue.identifier, issue.seed.note],
    );
  };
  /** What the widget draws of each pin: its stage, and the replies it shows. */
  const pins = async () => {
    const answer = await call(env, 'GET', `/feedback?url=${encodeURIComponent(page)}&client=${site.id}`, { origin });

    return ((await answer.json()) as { issues: { stage: string; comments?: unknown[] }[] }).issues.map((issue) => ({
      stage: issue.stage,
      comments: issue.comments?.length,
    }));
  };

  return { accounts, workspace, account, site, connector, base, token, write, read, pins };
}

describe('two workspaces on one worker, each with its own tracker (FRU-102)', () => {
  it('writes the notes of each one in its own tracker, and reads them back from there only', async () => {
    const env = await envWith();
    const linear = linearOf({ lin_api_the_key_of_acme: 'acme', lin_api_the_key_of_globex: 'globex' });
    const acme = await tenant(env, 'Acme', 'https://staging.acme.dev', 'lin_api_the_key_of_acme');
    const globex = await tenant(env, 'Globex', 'https://staging.globex.dev', 'lin_api_the_key_of_globex');

    // One after the other, then the first again: the store of a connector is kept between requests,
    // and a request of the other workspace in between must not change which key the first one uses.
    assert.equal((await acme.write('Acme: the price is wrong.')).status, 201);
    assert.equal((await globex.write('Globex: the logo is cut.')).status, 201);
    assert.equal((await acme.write('Acme: and the button too.')).status, 201);

    const notesOf = (organisation: string) =>
      (linear.get(organisation) ?? []).map((issue) => /"note": "([^"]*)"/.exec(issue.description)?.[1]);
    assert.deepEqual(notesOf('acme'), ['Acme: the price is wrong.', 'Acme: and the button too.']);
    assert.deepEqual(notesOf('globex'), ['Globex: the logo is cut.']);

    assert.deepEqual(await acme.read(), [
      ['ACME-1', 'Acme: the price is wrong.'],
      ['ACME-2', 'Acme: and the button too.'],
    ]);
    assert.deepEqual(await globex.read(), [['GLOBEX-1', 'Globex: the logo is cut.']]);
  });

  it('keeps the notes of one workspace when the other one loses its connector', async () => {
    const env = await envWith();
    const linear = linearOf({ lin_api_the_key_of_acme: 'acme', lin_api_the_key_of_globex: 'globex' });
    const acme = await tenant(env, 'Acme', 'https://staging.acme.dev', 'lin_api_the_key_of_acme');
    const globex = await tenant(env, 'Globex', 'https://staging.globex.dev', 'lin_api_the_key_of_globex');
    assert.equal((await acme.write('Acme: before.')).status, 201);
    assert.equal((await globex.write('Globex: before.')).status, 201);

    const removed = await call(env, 'DELETE', `${acme.base}/connectors/${acme.connector}`, { token: acme.token });
    assert.equal(removed.status, 204);

    // Acme has no destination now: its next note stays in the worker. Globex is not touched.
    assert.equal((await acme.write('Acme: after.')).status, 201);
    assert.equal((await globex.write('Globex: after.')).status, 201);
    assert.equal(linear.get('acme')?.length, 1);
    assert.equal(linear.get('globex')?.length, 2);
    assert.deepEqual(
      (await globex.read()).map(([, text]) => text),
      ['Globex: before.', 'Globex: after.'],
    );
  });
});

describe('the stages a read reports, for a site that sends to the tracker of its workspace (FRU-188)', () => {
  it('are the stages of that tracker, not the ones of the store of the worker', async () => {
    const env = await envWith();
    linearOf({ lin_api_the_key_of_acme: 'acme' });
    const acme = await tenant(env, 'Acme', 'https://staging.acme.dev', 'lin_api_the_key_of_acme');
    const plain = await acme.accounts.addSite(acme.workspace.id, {
      origin: 'https://plain.acme.dev',
      visibility: 'everyone',
    });
    // The store of the worker reports three stages, as GitHub does (`GITHUB_STAGES`).
    const own: SeedStore = {
      name: 'three-stages',
      stages: ['green', 'ripe', 'composted'],
      scope: () => '',
      create: async () => ({ id: 'x', identifier: 'X-1' }),
      findForPage: async () => [],
    };
    const stagesOf = async (origin: string, site: string) => {
      const answer = await callOn(
        env,
        'GET',
        `/feedback?url=${encodeURIComponent(`${origin}/`)}&client=${site}`,
        { origin },
        { kv: createMemoryKv(), store: own },
      );
      assert.equal(answer.status, 200, await answer.clone().text());

      return ((await answer.json()) as { stages: string[] }).stages;
    };

    // Linear answers for this site: its five stages.
    assert.deepEqual(await stagesOf('https://staging.acme.dev', acme.site.id), [
      'seeded',
      'green',
      'ripening',
      'ripe',
      'composted',
    ]);
    // A site with no destination is read in the store of the worker: its three.
    assert.deepEqual(await stagesOf('https://plain.acme.dev', plain.id), ['green', 'ripe', 'composted']);
  });
});

describe('the store of a connector, built for the request that asks for it (FRU-102)', () => {
  const own = { name: 'own' } as unknown as SeedStore;
  const client = { teamId: 'team_design' } as ClientConfig;
  const policy = { showComments: false, identitySecret: undefined, read: 'public' } as ClientPolicy;

  /** The one method the stores read, over a row a test changes. */
  function row(initial: { key: string; workspaceId: string } | undefined) {
    const held = { now: initial };
    const accounts = {
      sealedKey: async () =>
        held.now === undefined
          ? undefined
          : {
              kind: 'linear' as const,
              sealed: seal(held.now.key, SECRETS_KEY),
              workspaceId: held.now.workspaceId,
              settings: DEFAULT_CONNECTOR_SETTINGS,
            },
    } as unknown as AccountStore;

    return { held, accounts };
  }

  /** The keys Linear was asked with, in order. */
  function askedKeys() {
    const asked: string[] = [];
    mock.method(globalThis, 'fetch', async (_url: unknown, init: { headers: Record<string, string> }) => {
      asked.push(init.headers.Authorization ?? '');

      return Response.json({ data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    });

    return asked;
  }

  it('reads the row at each request: a key that changed is used at once, and the old one never again', async () => {
    const asked = askedKeys();
    const { held, accounts } = row({ key: 'lin_api_the_first_key', workspaceId: 'ws_a' });
    const stores = createConnectorStores(accounts, SECRETS_KEY);

    await (
      await stores('con_a', 'ws_a', own)
    ).findForPage({ url: 'https://acme.dev/', clientId: undefined }, client, policy);
    held.now = { key: 'lin_api_the_second_key', workspaceId: 'ws_a' };
    await (
      await stores('con_a', 'ws_a', own)
    ).findForPage({ url: 'https://acme.dev/', clientId: undefined }, client, policy);

    assert.deepEqual(asked, ['lin_api_the_first_key', 'lin_api_the_second_key']);
  });

  it('gives no store for a connector that is gone, or that another workspace holds now', async () => {
    const asked = askedKeys();
    const { held, accounts } = row({ key: 'lin_api_the_first_key', workspaceId: 'ws_a' });
    const stores = createConnectorStores(accounts, SECRETS_KEY);
    await stores('con_a', 'ws_a', own);

    held.now = { key: 'lin_api_the_first_key', workspaceId: 'ws_other' };
    await assert.rejects(stores('con_a', 'ws_a', own), StoreError);
    held.now = undefined;
    await assert.rejects(stores('con_a', 'ws_a', own), StoreError);
    assert.deepEqual(asked, [], 'no key left the worker');
  });
});

describe('what a workspace sets on its connector (FRU-102)', () => {
  it('takes the replies away and gives a state another stage, for the connector it is set on only', async () => {
    const env = await envWith();
    linearOf({ lin_api_the_key_of_acme: 'acme', lin_api_the_key_of_globex: 'globex' });
    const acme = await tenant(env, 'Acme', 'https://staging.acme.dev', 'lin_api_the_key_of_acme');
    const globex = await tenant(env, 'Globex', 'https://staging.globex.dev', 'lin_api_the_key_of_globex');
    assert.equal((await acme.write('Acme: one.')).status, 201);
    assert.equal((await globex.write('Globex: one.')).status, 201);
    // The stage of the type of « Todo », and its reply.
    assert.deepEqual(await acme.pins(), [{ stage: 'green', comments: 1 }]);

    const set = await call(env, 'POST', `${acme.base}/connectors/${acme.connector}/settings`, {
      token: acme.token,
      body: { showComments: false, stages: { state_todo: 'ripening' } },
    });
    assert.equal(set.status, 200, await set.clone().text());
    // A new note empties the cache of the page, as a change of the settings does not.
    assert.equal((await acme.write('Acme: two.')).status, 201);

    assert.deepEqual(await acme.pins(), [
      { stage: 'ripening', comments: undefined },
      { stage: 'ripening', comments: undefined },
    ]);
    assert.deepEqual(await globex.pins(), [{ stage: 'green', comments: 1 }], 'the other workspace is not touched');

    // The defaults again: the exception is gone, and the replies come back.
    const back = await call(env, 'POST', `${acme.base}/connectors/${acme.connector}/settings`, {
      token: acme.token,
      body: { showComments: true, stages: {} },
    });
    assert.equal(back.status, 200);
    assert.equal((await acme.write('Acme: three.')).status, 201);
    assert.deepEqual((await acme.pins())[0], { stage: 'green', comments: 1 });
  });

  it('lists the states of the teams its sites send to, each with the stage of its type, and its settings', async () => {
    const env = await envWith();
    linearOf({ lin_api_the_key_of_acme: 'acme' });
    const acme = await tenant(env, 'Acme', 'https://staging.acme.dev', 'lin_api_the_key_of_acme');

    const listed = await call(env, 'GET', `${acme.base}/connectors/${acme.connector}/states`, { token: acme.token });
    assert.equal(listed.status, 200, await listed.clone().text());
    assert.deepEqual(await listed.json(), {
      // In the order of the board, and no state of a team no site sends to.
      states: [
        { id: 'state_triage', name: 'Triage', type: 'triage', teamId: 'team_design', team: 'Design', stage: 'seeded' },
        { id: 'state_todo', name: 'Todo', type: 'unstarted', teamId: 'team_design', team: 'Design', stage: 'green' },
      ],
      settings: DEFAULT_CONNECTOR_SETTINGS,
    });
  });

  it('refuses settings that are not settings, a role that does not manage the workspace, and another workspace', async () => {
    const env = await envWith();
    linearOf({ lin_api_the_key_of_acme: 'acme', lin_api_the_key_of_globex: 'globex' });
    const acme = await tenant(env, 'Acme', 'https://staging.acme.dev', 'lin_api_the_key_of_acme');
    const globex = await tenant(env, 'Globex', 'https://staging.globex.dev', 'lin_api_the_key_of_globex');
    const settings = (body: unknown, as = acme, connector = acme.connector) =>
      call(env, 'POST', `${as.base}/connectors/${connector}/settings`, { token: as.token, body });

    for (const body of [
      { showComments: 'no' },
      { stages: { state_todo: 'purple' } },
      { stages: { 'a state': 'green' } },
      { stages: ['green'] },
      { stages: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`state_${index}`, 'green'])) },
    ]) {
      const refused = await settings(body);
      assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80));
    }

    // The connector of Acme, asked from Globex, does not exist.
    assert.equal((await settings({ showComments: false }, globex, acme.connector)).status, 404);
    const read = await call(env, 'GET', `${globex.base}/connectors/${acme.connector}/states`, { token: globex.token });
    assert.equal(read.status, 404);

    // A member sees the tracker and does not change what the workspace set; an admin does.
    for (const [role, status] of [
      ['member', 403],
      ['admin', 200],
    ] as const) {
      const { id: person, token } = await signInTo(env, `${role}@acme.dev`);
      await memberOf(env, acme.workspace.id, person, role);

      const asked = await call(env, 'POST', `${acme.base}/connectors/${acme.connector}/settings`, {
        token,
        body: { showComments: false },
      });
      assert.equal(asked.status, status, role);
      const states = await call(env, 'GET', `${acme.base}/connectors/${acme.connector}/states`, { token });
      assert.equal(states.status, status, role);
    }
    // The admin's change only.
    assert.deepEqual((await acme.accounts.connectors(acme.workspace.id))[0]?.settings, {
      showComments: false,
      stages: {},
    });
  });
});

describe('the sites that take a reply, by where their notes go (FRU-257)', () => {
  const policy = { showComments: true, identitySecret: undefined, read: 'public', locale: 'en' } as ClientPolicy;

  /** One connector of each shape, as `sealedKey` answers them. */
  const accounts = {
    sealedKey: async (connector: string) => {
      const shapes: Record<string, { kind: 'linear' | 'rest'; showComments: boolean }> = {
        con_linear: { kind: 'linear', showComments: true },
        con_quiet: { kind: 'linear', showComments: false },
        con_rest: { kind: 'rest', showComments: true },
      };
      const shape = shapes[connector];

      return shape === undefined
        ? undefined
        : {
            kind: shape.kind,
            sealed: seal('lin_api_a_key_of_the_test', SECRETS_KEY),
            workspaceId: 'ws_a',
            settings: { ...DEFAULT_CONNECTOR_SETTINGS, showComments: shape.showComments },
          };
    },
    enqueueDelivery: async () => 'dlv_1',
  } as unknown as AccountStore;
  const routed = createRoutedStore(createMemoryStore(), createConnectorStores(accounts, SECRETS_KEY));
  const site = (connector?: string) =>
    ({ workspace: 'ws_a', ...(connector === undefined ? {} : { connector }) }) as ClientConfig;

  it('a site with no destination, and a tracker that shows its replies', async () => {
    assert.equal(await takesReplies(routed, site()), true);
    assert.equal(await takesReplies(routed, site('con_linear')), true);
  });

  it('never a tracker whose replies are hidden, nor an address that only receives, though it keeps the notes', async () => {
    assert.equal(await takesReplies(routed, site('con_quiet')), false);
    assert.equal(await takesReplies(routed, site('con_rest')), false);

    const reply = { body: 'Seen.', author: { kind: 'visitor' as const } };
    for (const connector of ['con_quiet', 'con_rest']) {
      await assert.rejects(
        routed.reply?.({ issue: 'dev_issue_1', clientId: 'site_a' }, reply, site(connector), policy) ??
          Promise.reject(),
        StoreError,
        connector,
      );
    }
  });
});

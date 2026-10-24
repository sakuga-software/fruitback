import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { NOTE_STAGES, buildIssueDescription, offeredStatuses, statusOf } from '@fruitback/shared';
import { noteFixture } from '@fruitback/shared/note.fixture';
import type { ClientPolicy } from './clients.ts';
import { GITHUB_STATES, createIssueStore, githubStateKey, stageForGithubIssue } from './github.ts';
import { mockMethod } from './mock.fixture.ts';
import { envelopeStatuses } from './site-statuses.ts';
import { trackerSourcesOf } from './tracker-states.ts';
import { createRoutedStore } from './connectors.ts';
import type { NoteStore } from './store.ts';
import { callOn, signInTo, workspaceIn, worlds } from './console-world.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The four statuses of a GitHub issue (FRU-369): what `state` and `state_reason` say, named by the
 * connector they are read through, and re-staged by a site. Decision 4: no label is a status.
 */

const [NEW, TODO, , DONE, CLOSED] = NOTE_STAGES;
const PAGE = noteFixture().page.url;
const POLICY: ClientPolicy = {
  showComments: false,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};

afterEach(() => vi.restoreAllMocks());

function row(id: number, state: string, stateReason: string | null) {
  const seed = noteFixture({ id: `sd_${id}` });

  return {
    id,
    number: id,
    html_url: `https://github.com/acme/site/issues/${id}`,
    title: 'A note',
    body: buildIssueDescription(seed),
    state,
    state_reason: stateReason,
    updated_at: '2026-10-22T10:00:00Z',
    comments: 0,
    labels: [{ name: 'fruitback' }, { name: 'fruitback:acme' }],
  };
}

/** A store of `acme/site` on a GitHub that lists `rows`, with a token that needs no call. */
function storeOf(
  rows: unknown[],
  options: { statusSource?: string; stages?: Record<string, never> | Record<string, string> } = {},
): NoteStore {
  mockMethod(globalThis, 'fetch', async (input: string) =>
    new URL(input).pathname === '/repos/acme/site/issues'
      ? new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response('{}', { status: 404 }),
  );

  return createIssueStore({
    repositoryOf: () => 'acme/site',
    tokens: { get: async () => 'ghs_test', drop: () => undefined },
    ...(options.statusSource === undefined ? {} : { statusSource: options.statusSource }),
    ...(options.stages === undefined ? {} : { stages: options.stages as never }),
  });
}

describe('the four statuses of a GitHub issue (FRU-369)', () => {
  it('names each state and reason by its key, and none for a state GitHub does not have', () => {
    assert.equal(githubStateKey('open', null), 'open');
    // Reopened is open again.
    assert.equal(githubStateKey('open', 'reopened'), 'open');
    assert.equal(githubStateKey('closed', 'completed'), 'closed:completed');
    // Closed before GitHub had a reason: done, as its stage says.
    assert.equal(githubStateKey('closed', null), 'closed:completed');
    assert.equal(githubStateKey('closed', 'not_planned'), 'closed:not_planned');
    assert.equal(githubStateKey('closed', 'duplicate'), 'closed:duplicate');
    assert.equal(githubStateKey('archived', null), undefined);
  });

  it('lists four states, each with the name of the read and the stage of its state', () => {
    assert.deepEqual(GITHUB_STATES, [
      { id: 'open', name: 'Open', stage: NEW },
      { id: 'closed:completed', name: 'Closed', stage: DONE },
      { id: 'closed:not_planned', name: 'Not planned', stage: CLOSED },
      { id: 'closed:duplicate', name: 'Duplicate', stage: CLOSED },
    ]);
    for (const state of GITHUB_STATES) {
      const [kind, reason] = state.id.split(':');
      assert.equal(state.stage, stageForGithubIssue(kind as string, reason ?? null), state.id);
    }
  });

  it('says the status of each issue under its connector, and the four states', async () => {
    const store = storeOf(
      [row(1, 'open', null), row(2, 'closed', 'not_planned'), row(3, 'closed', null), row(4, 'closed', 'duplicate')],
      { statusSource: 'con_github' },
    );

    const issues = await store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    assert.deepEqual(
      issues.map((issue) => [issue.identifier, issue.stage, issue.status]),
      [
        ['#1', NEW, 'con_github:open'],
        ['#2', CLOSED, 'con_github:closed:not_planned'],
        ['#3', DONE, 'con_github:closed:completed'],
        ['#4', CLOSED, 'con_github:closed:duplicate'],
      ],
    );
    assert.deepEqual(await store.trackerStates?.(undefined), [...GITHUB_STATES]);
  });

  it('says no status, and no state, for the store of the worker, which no connector names', async () => {
    const store = storeOf([row(1, 'open', null)]);

    const [issue] = await store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);

    assert.equal(issue?.stage, NEW);
    assert.equal('status' in (issue ?? {}), false);
    assert.equal(store.trackerStates, undefined);
  });

  it('draws an issue with the stage its site gives the status, so a status and its stage agree', async () => {
    const store = storeOf([row(2, 'closed', 'not_planned'), row(1, 'open', null)], {
      statusSource: 'con_github',
      stages: { 'closed:not_planned': TODO as string },
    });

    const issues = await store.findForPage({ url: PAGE, clientId: 'acme' }, undefined, POLICY);
    const offered = offeredStatuses(
      envelopeStatuses(
        [
          {
            source: 'con_github',
            key: 'closed:not_planned',
            name: 'Later',
            stage: TODO as never,
            color: null,
            textColor: null,
            position: 0,
            origin: 'tracker',
            hidden: false,
          },
        ],
        [{ source: 'con_github', states: GITHUB_STATES }],
      ),
    );

    assert.deepEqual(
      issues.map((issue) => [issue.stage, statusOf(issue, offered)?.name]),
      [
        [TODO, 'Later'],
        [NEW, 'Open'],
      ],
    );
  });
});

describe('one list of states for each connector (FRU-369, heavy review of pull request 495)', () => {
  it('gives one source for two repositories of one GitHub connector, and keeps two teams of Linear apart by their ids', async () => {
    const store = {
      trackerStatesFor: async (client: { teamId?: string } | undefined) =>
        client?.teamId?.includes('/')
          ? [...GITHUB_STATES]
          : [{ id: `st_${client?.teamId}`, name: client?.teamId ?? '', stage: NEW }],
    } as unknown as NoteStore;
    const client = {
      id: 'site_1',
      name: 'Acme',
      origins: ['https://acme.dev'],
      destinations: [
        { id: 'd1', connector: 'con_github', teamId: 'acme/site' },
        { id: 'd2', connector: 'con_github', teamId: 'acme/docs' },
        { id: 'd3', connector: 'con_linear', teamId: 'web' },
        { id: 'd4', connector: 'con_linear', teamId: 'design' },
      ],
    } as never;

    const sources = await trackerSourcesOf(undefined, store, client);

    assert.deepEqual(
      sources.map(({ source, states }) => [source, states.map((state) => state.id)]),
      [
        ['con_github', GITHUB_STATES.map((state) => state.id)],
        ['con_linear', ['st_web', 'st_design']],
      ],
    );
    // So the read lists each status once.
    const keys = envelopeStatuses([], sources).map((status) => status.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('the four states reach the read through the routed store (FRU-369, lite review of 3349bccd)', () => {
  it('gives trackerSourcesOf the four states of a GitHub connector, through createRoutedStore as GET /feedback has it', async () => {
    // The store of a GitHub connector says `trackerStates`; the routed store asks it as `trackerStatesFor`.
    const github = storeOf([], { statusSource: 'con_github' });
    const routed = createRoutedStore({ name: 'own', scope: () => 'own' } as unknown as NoteStore, async () => github);
    const client = {
      id: 'site_1',
      name: 'Acme',
      origins: ['https://acme.dev'],
      destinations: [
        { id: 'd1', connector: 'con_github', teamId: 'acme/site' },
        { id: 'd2', connector: 'con_github', teamId: 'acme/docs' },
      ],
    } as never;

    const sources = await trackerSourcesOf(undefined, routed, client);

    assert.deepEqual(sources, [{ source: 'con_github', states: [...GITHUB_STATES] }]);
  });
});

describe('the states of GitHub on the statuses page of a site (FRU-369)', () => {
  const open = worlds();

  it('lists one GitHub connector once, with its four states, for a site that sends to two of its repositories', async () => {
    const world = await open();
    const { token } = await signInTo(world, 'alice@acme.dev');
    const workspace = await workspaceIn(world, token);
    const site = (await world.accounts.addSite(workspace, { origin: 'https://acme.dev', visibility: 'members' })).id;
    for (const statement of [
      `INSERT INTO connectors (id, workspace_id, kind, label, sealed, created_at, settings)
         VALUES ('con_github', '${workspace}', 'github', 'acme', 'not-opened', 1, '{"stages":{"closed:duplicate":"${DONE}"}}')`,
      `INSERT INTO site_destinations (site_id, position, connector_id, team_id, label) VALUES
         ('${site}', 0, 'con_github', 'acme/site', 'GitHub · acme/site'),
         ('${site}', 1, 'con_github', 'acme/docs', 'GitHub · acme/docs')`,
    ]) {
      await rowsOf(world.database, statement);
    }

    const answer = await callOn(world, 'GET', `/console/workspaces/${workspace}/sites/${site}/statuses/tracker`, {
      token,
    });

    assert.equal(answer.status, 200, await answer.clone().text());
    const { trackers } = (await answer.json()) as {
      trackers: { connector: string; label: string; states: { id: string; stage: string }[] }[];
    };
    assert.deepEqual(
      trackers.map((tracker) => [
        tracker.connector,
        tracker.label,
        tracker.states.map((state) => [state.id, state.stage]),
      ]),
      [
        [
          'con_github',
          'GitHub · acme',
          [
            ['open', NEW],
            ['closed:completed', DONE],
            ['closed:not_planned', CLOSED],
            // The settings of the connector (FRU-102) name states of Linear: they change no state here.
            ['closed:duplicate', CLOSED],
          ],
        ],
      ],
    );
  });
});

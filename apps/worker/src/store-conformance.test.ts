import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { DEFAULT_SEED_STAGE, SEED_STAGES } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import type { ClientPolicy } from './clients.ts';
import { COMMENTS_PER_ISSUE as GITHUB_REPLY_CAP, createGithubStore } from './github.ts';
import { createMemoryStore, resetMemoryLinear, setMemoryIssueState } from './linear-memory.ts';
import { COMMENTS_PER_ISSUE as LINEAR_REPLY_CAP, type IssueNode, createLinearStore } from './linear.ts';
import { type Database, type PgDatabase, createPgDatabase } from './postgres.ts';
import { NO_REAL_POSTGRES, createMigratedPgliteDatabase, createRealDatabase, rowsOf } from './postgres.fixture.ts';
import { COMMENTS_PER_ISSUE as POSTGRES_REPLY_CAP } from './seed-rows.ts';
import { createPostgresSeedStore } from './seeds-postgres.ts';
import type { CreatedIssue, SeedStore } from './store.ts';
import { type ConformanceSubject, describeStoreConformance, repliesNewestFirst } from './store-conformance.fixture.ts';
import { REFUSED_SINCE_POSTGRES } from './env.ts';
import { isDevOnlyProvider, storeProviders } from './stores.ts';

/**
 * Each store against the conformance suite (FRU-34). A new store adds a subject here, and a row to the
 * store matrix in `docs/self-hosting.md`.
 */

const POLICY: ClientPolicy = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The board of the team of the fake Linear, with no triage. */
const TEAM_STATES = [
  { id: 'st_backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 'st_todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 'st_doing', name: 'In Progress', type: 'started', position: 2 },
  { id: 'st_done', name: 'Done', type: 'completed', position: 3 },
];

/**
 * Linear, as far as the Linear store uses it. It keeps the labels and the issues it receives, and
 * applies the filter of `FruitbackIssues`: the team and a substring of the description.
 * A label belongs to one team, as on Linear, and an issue refuses a label of another team.
 *
 * `refuseLabels`: a team that lets this key create no label, as Linear answers an application that
 * is a member of no team (FRU-138, measured).
 */
function fakeLinear({ refuseLabels = false } = {}): { node(id: string): IssueNode } {
  const labels = new Map<string, Map<string, string>>();
  let labelCount = 0;
  const labelsOf = (teamId: string) => {
    const known = labels.get(teamId) ?? new Map<string, string>();
    labels.set(teamId, known);

    return known;
  };
  const issues: { teamId: string; labelIds: string[]; node: IssueNode }[] = [];

  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];

    if (operation === 'FruitbackLabels') {
      const known = labelsOf(String(variables.teamId));
      const nodes = (variables.names as string[]).flatMap((name) => {
        const id = known.get(name);

        return id === undefined ? [] : [{ id, name }];
      });

      return json(200, { data: { team: { labels: { nodes } } } });
    }

    if (operation === 'FruitbackCreateLabel') {
      const { name, teamId } = variables.input as { name: string; teamId: string };
      if (refuseLabels) {
        return json(200, { errors: [{ message: 'not allowed to take action', extensions: { code: 'FORBIDDEN' } }] });
      }
      labelCount += 1;
      const id = `label_${labelCount}`;
      labelsOf(teamId).set(name, id);

      return json(200, { data: { issueLabelCreate: { issueLabel: { id, name } } } });
    }

    if (operation === 'FruitbackCreateIssue') {
      const input = variables.input as { teamId: string; title: string; description: string; labelIds: string[] };
      const teamLabelIds = [...labelsOf(input.teamId).values()];
      if (!input.labelIds.every((id) => teamLabelIds.includes(id))) {
        return json(200, { errors: [{ message: 'a label of another team' }] });
      }
      const number = issues.length + 1;
      const issue = {
        id: `issue_${number}`,
        identifier: `SKG-${number}`,
        url: `https://linear.app/acme/issue/SKG-${number}`,
      };
      issues.push({
        teamId: input.teamId,
        labelIds: input.labelIds,
        node: {
          ...issue,
          title: input.title,
          updatedAt: '2026-09-15T10:00:00.000Z',
          description: input.description,
          state: { name: 'Backlog', type: 'backlog' },
          comments: { nodes: [] },
        },
      });

      return json(200, { data: { issueCreate: { success: true, issue } } });
    }

    if (operation === 'FruitbackCreateComment') {
      const input = variables.input as { issueId: string; body: string };
      const issue = issues.find((each) => each.node.id === input.issueId);
      if (issue === undefined) return json(200, { errors: [{ message: 'Entity not found' }] });
      const comment = {
        id: `comment_${input.issueId}_${issue.node.comments?.nodes.length ?? 0}`,
        body: input.body,
        createdAt: '2026-09-15T11:00:00.000Z',
        user: { name: 'Fruitback' },
      };
      issue.node.comments = { nodes: [comment, ...(issue.node.comments?.nodes ?? [])] };

      return json(200, { data: { commentCreate: { success: true, comment } } });
    }

    if (operation === 'FruitbackIssueStates') {
      // A team with no triage, as most are: « Still wrong » goes to its backlog (FRU-294).
      const found = issues.find((each) => each.node.id === variables.id);
      if (found === undefined) return json(200, { errors: [{ message: 'Entity not found: Issue' }] });

      return json(200, {
        data: { issue: { id: found.node.id, team: { id: found.teamId, states: { nodes: TEAM_STATES } } } },
      });
    }

    if (operation === 'FruitbackReopenIssue') {
      const found = issues.find((each) => each.node.id === variables.id);
      const state = TEAM_STATES.find((each) => each.id === (variables.input as { stateId: string }).stateId);
      if (found === undefined || state === undefined) return json(200, { errors: [{ message: 'Entity not found' }] });
      found.node.state = { id: state.id, name: state.name, type: state.type };

      return json(200, {
        data: { issueUpdate: { success: true, issue: { id: found.node.id, state: found.node.state } } },
      });
    }

    if (operation === 'FruitbackIssues') {
      const filter = variables.filter as {
        team: { id: { eq: string } };
        and: { description?: { contains: string }; labels?: unknown }[];
      };
      // A clause on the labels would hide every note of a team that refuses them.
      assert.equal(
        filter.and.some((clause) => clause.labels !== undefined),
        false,
        'the read must not select by label',
      );
      const wanted = filter.and.flatMap((clause) =>
        clause.description === undefined ? [] : [clause.description.contains],
      );
      const nodes = issues
        .filter((issue) => issue.teamId === filter.team.id.eq)
        .filter((issue) => wanted.every((text) => (issue.node.description ?? '').includes(text)))
        .map((issue) => ({
          ...issue.node,
          comments: { nodes: (issue.node.comments?.nodes ?? []).slice(0, variables.comments as number) },
        }));

      return json(200, { data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } });
    }

    return json(200, { errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return {
    node(id) {
      const found = issues.find((issue) => issue.node.id === id);
      assert.ok(found, `no Linear issue ${id}`);

      return found.node;
    },
  };
}

type GithubIssue = {
  repository: string;
  id: number;
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: string;
  state_reason: string | null;
  updated_at: string;
  labels: { name: string }[];
  replies: { id: number; body: string; created_at: string; user: { login: string } }[];
};

/**
 * GitHub, as far as the GitHub store uses it, for any repository. It keeps the labels and the issues
 * it receives, per repository. A list filter needs every label, without case. Comments come back
 * oldest first, as GitHub sorts them, because the store picks its pages from that order.
 */
function fakeGithub(): { issue(id: string): GithubIssue } {
  const labels = new Map<string, Set<string>>();
  const issues: GithubIssue[] = [];

  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const onPage = <T>(rows: T[]) => rows.slice((page - 1) * perPage, page * perPage);

    if (method === 'POST' && url.pathname === '/app/installations/77/access_tokens') {
      return json(201, { token: 'ghs_conformance', expires_at: '2999-01-01T00:00:00Z' });
    }

    const scoped = /^\/repos\/([^/]+\/[^/]+)(\/.*)$/.exec(url.pathname);
    if (scoped === null) return json(404, { message: 'Not Found' });
    const [, repository = '', path = ''] = scoped;
    const route = `${method} ${path}`;
    const inRepository = issues.filter((issue) => issue.repository === repository);

    if (route === 'GET /installation') return json(200, { id: 77 });

    if (route === 'POST /labels') {
      const known = labels.get(repository) ?? new Set<string>();
      labels.set(repository, known);
      const name = String(body.name).toLowerCase();
      if (known.has(name)) return json(422, { errors: [{ code: 'already_exists' }] });
      known.add(name);

      return json(201, { name: body.name });
    }

    if (route === 'POST /issues') {
      const number = inRepository.length + 1;
      const issue: GithubIssue = {
        repository,
        id: 9000 + issues.length + 1,
        number,
        html_url: `https://github.com/${repository}/issues/${number}`,
        title: String(body.title),
        body: String(body.body),
        state: 'open',
        state_reason: null,
        updated_at: '2026-09-15T10:00:00Z',
        labels: (body.labels as string[]).map((name) => ({ name })),
        replies: [],
      };
      issues.push(issue);

      return json(201, { id: issue.id, number: issue.number, html_url: issue.html_url });
    }

    if (route === 'GET /issues') {
      const required = (url.searchParams.get('labels') ?? '').split(',').map((name) => name.toLowerCase());
      const rows = inRepository
        .filter((issue) => required.every((name) => issue.labels.some((label) => label.name.toLowerCase() === name)))
        .sort((left, right) => right.number - left.number)
        .map(({ repository: _repository, replies, ...row }) => ({ ...row, comments: replies.length }));

      return json(200, onPage(rows));
    }

    const comments = /^GET \/issues\/(\d+)\/comments$/.exec(route);
    if (comments) {
      const issue = inRepository.find((candidate) => candidate.number === Number(comments[1]));

      return issue === undefined
        ? json(404, { message: 'Not Found' })
        : json(200, onPage([...issue.replies].sort((left, right) => left.created_at.localeCompare(right.created_at))));
    }

    return json(404, { message: 'Not Found' });
  });

  return {
    issue(id) {
      const found = issues.find((issue) => String(issue.id) === id);
      assert.ok(found, `no GitHub issue ${id}`);

      return found;
    },
  };
}

const GITHUB_KEY = createPrivateKey(
  generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey,
);

/** Every call to the provider answers `500`. */
function providerErrors(): void {
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => json(500, { message: 'down for maintenance' }));
}

/** Every call to the provider rejects, as `fetch` does when the network is down. */
function networkDown(): void {
  mock.restoreAll();
  mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed');
  });
}

/** Every call to the provider answers `200` with a page that is not JSON, as a proxy in front of it can. */
function unreadableAnswers(): void {
  mock.restoreAll();
  mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>maintenance</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  );
}

/** Write a seed, then store replies on it. */
async function writeWithReplies(
  store: SeedStore,
  seed: Parameters<SeedStore['create']>[0],
  reply: (created: CreatedIssue) => void,
): Promise<void> {
  reply(await store.create(seed, undefined, POLICY));
}

let linear: ReturnType<typeof fakeLinear> | undefined;
let github: ReturnType<typeof fakeGithub> | undefined;
/** The databases a case opened, the one of `open` first. Closed after the case. */
let databases: Database[] = [];

/**
 * The store of the database, on PGlite and on a real server (FRU-218). One provider, two subjects:
 * PGlite has one connection, and the job « postgres » of CI has a server with several.
 */
function postgresSubject(on: string, create: () => Promise<PgDatabase>, skip: string | false): ConformanceSubject {
  const opened = (): Database => {
    const [database] = databases;
    if (database === undefined) throw new Error('the case opened no database');

    return database;
  };

  return {
    provider: 'postgres',
    on,
    skip,
    writtenStage: DEFAULT_SEED_STAGE,
    replyCap: POSTGRES_REPLY_CAP,
    otherTenant: 'one database holds the seeds of every site, so there is no other tenant',
    readWithNoClient:
      'one database holds the seeds of every workspace: a read that names no site gets the seeds that name none',
    async open() {
      const database = await create();
      databases.push(database);

      return createPostgresSeedStore(database);
    },
    async close() {
      for (const database of databases.splice(0)) await database.close();
    },
    unknownState: async (created) => {
      await rowsOf(opened(), `UPDATE seeds SET stage = 'marmalade' WHERE id = ${Number(created.id)}`);
    },
    markDone: async (created) => {
      await rowsOf(opened(), `UPDATE seeds SET stage = 'ripe' WHERE id = ${Number(created.id)}`);
    },
    plantReplies: async (store, seed, count) => {
      const created = await store.create(seed, undefined, POLICY);
      for (const reply of repliesNewestFirst(count)) {
        await rowsOf(
          opened(),
          `INSERT INTO seed_comments (seed_id, author, body, created_at) VALUES (${Number(created.id)}, 'Alice', '${reply.body}', ${Date.parse(reply.createdAt)})`,
        );
      }
    },
    // A database that refuses every statement, as one whose tables are gone would.
    broken() {
      const refuses = async (): Promise<never> => {
        throw Object.assign(new Error('relation "seeds" does not exist'), { code: '42P01' });
      };

      return createPostgresSeedStore({
        schema: 'public',
        run: refuses,
        transaction: refuses,
        alone: refuses,
        close: async () => {},
      });
    },
    // Nothing listens on port 1: the driver is refused the connection.
    unreachable() {
      const database = createPgDatabase('postgres://fruitback:not-a-password@127.0.0.1:1/fruitback', 'public');
      databases.push(database);

      return createPostgresSeedStore(database);
    },
    garbled:
      'a row the store cannot read costs that one note, and the read answers the others: seeds-postgres.test.ts holds it',
  };
}

const LINEAR_CONFIG = { apiKey: 'lin_api_test', teamId: 'team_1' };
const GITHUB_CONFIG = { appId: '12345', privateKey: GITHUB_KEY, repository: 'acme/site' };

const SUBJECTS: ConformanceSubject[] = [
  {
    provider: 'linear',
    writtenStage: DEFAULT_SEED_STAGE,
    replyCap: LINEAR_REPLY_CAP,
    otherTenant: { teamId: 'team_2' },
    open() {
      linear = fakeLinear();

      return createLinearStore(LINEAR_CONFIG);
    },
    close: () => mock.restoreAll(),
    unknownState(created) {
      linear!.node(created.id).state = { name: 'Marmalade', type: 'marmalade' };
    },
    markDone(created) {
      linear!.node(created.id).state = { id: 'st_done', name: 'Done', type: 'completed' };
    },
    plantReplies: (store, seed, count) =>
      writeWithReplies(store, seed, (created) => {
        linear!.node(created.id).comments = {
          nodes: repliesNewestFirst(count).map((reply, index) => ({
            id: `comment_${index}`,
            body: reply.body,
            createdAt: reply.createdAt,
            user: { name: 'Alice' },
          })),
        };
      }),
    broken() {
      providerErrors();

      return createLinearStore(LINEAR_CONFIG);
    },
    unreachable() {
      networkDown();

      return createLinearStore(LINEAR_CONFIG);
    },
    garbled() {
      unreadableAnswers();

      return createLinearStore(LINEAR_CONFIG);
    },
  },
  {
    provider: 'github',
    noReply:
      'GitHub is a store of the environment and no connector of a workspace yet (FRU-188): no route writes to it',
    noCheck: 'a verdict is a reply (FRU-294), and GitHub takes no reply: see noReply',
    markDone: 'GitHub takes no verdict',
    writtenStage: DEFAULT_SEED_STAGE,
    replyCap: GITHUB_REPLY_CAP,
    otherTenant: { repository: 'acme/other' },
    open() {
      github = fakeGithub();

      return createGithubStore(GITHUB_CONFIG);
    },
    close: () => mock.restoreAll(),
    unknownState(created) {
      github!.issue(created.id).state = 'marmalade';
    },
    plantReplies: (store, seed, count) =>
      writeWithReplies(store, seed, (created) => {
        github!.issue(created.id).replies = repliesNewestFirst(count).map((reply, index) => ({
          id: 100 + index,
          body: reply.body,
          created_at: reply.createdAt,
          user: { login: 'alice' },
        }));
      }),
    broken() {
      providerErrors();

      return createGithubStore(GITHUB_CONFIG);
    },
    unreachable() {
      networkDown();

      return createGithubStore(GITHUB_CONFIG);
    },
    garbled() {
      unreadableAnswers();

      return createGithubStore(GITHUB_CONFIG);
    },
  },
  postgresSubject('PGlite', createMigratedPgliteDatabase, false),
  postgresSubject('a real server', createRealDatabase, NO_REAL_POSTGRES),
  {
    provider: 'memory',
    replyCap: 'the dev store writes two canned replies and no more',
    otherTenant: 'one list in the process holds the seeds of every client, so there is no other tenant',
    open() {
      resetMemoryLinear();

      return createMemoryStore();
    },
    close: () => resetMemoryLinear(),
    unknownState: 'the dev store gives each note a state from its own list',
    markDone: (created) => setMemoryIssueState(created.id, { name: 'Done', type: 'completed' }),
    async plantReplies(store, seed) {
      // The dev store writes two replies, newest first, on the third note of each page (FRU-268).
      // The two notes before it are on the same page, for another client, so a read for this one
      // finds only the seed.
      for (const filler of [1, 2]) {
        const client = { id: `filler_${filler}`, name: `Filler ${filler}` };
        await store.create({ ...seed, id: `${seed.id}_${filler}`, client }, undefined, POLICY);
      }
      await store.create(seed, undefined, POLICY);
    },
    broken: 'the dev store keeps the notes in the process, so no provider can fail',
    unreachable: 'the dev store keeps the notes in the process, so there is no network to lose',
    garbled: 'the dev store keeps the notes in the process, so there is no answer to read',
  },
];

for (const subject of SUBJECTS) describeStoreConformance(subject);

describe('the conformance suite', () => {
  it('runs for every store the worker can select', () => {
    assert.deepEqual([...new Set(SUBJECTS.map((subject) => subject.provider))].sort(), storeProviders().sort());
  });
});

/**
 * The matrix is compared with the code where the code holds the answer: the stages, the reply cap and
 * whether the store runs in production. The column that says what changes a stage is prose about each
 * provider, and no test reads it.
 *
 * The matrix lists the stores that an operator can choose. A store that `readConfig` refuses by its
 * name since FRU-225 is not one of them, and the page names it in « Upgrading » only.
 */
describe('the store matrix in docs/self-hosting.md', () => {
  const offered = (provider: string) => !Object.hasOwn(REFUSED_SINCE_POSTGRES, provider);
  const guide = readFileSync(new URL('../../../docs/self-hosting.md', import.meta.url), 'utf8');
  const header = ['', 'Store', 'Stages', 'What changes the stage', 'Replies', 'Runs in production', ''];
  const lines = guide.split('\n').map((line) => line.split('|').map((cell) => cell.trim()));
  // oxfmt pads the cells to align the columns, so a row is compared cell by cell.
  const start = lines.findIndex((cells) => cells.join('|') === header.join('|'));
  const end = lines.findIndex((cells, index) => index > start && cells.length === 1);
  const rows = lines
    .slice(start + 2, end < 0 ? undefined : end)
    .map((cells) => ({ provider: /^`([^`]+)`$/.exec(cells[1] ?? '')?.[1] ?? '', cells }));

  it('has one row for each store, and no other', () => {
    assert.ok(start >= 0, 'the store matrix was not found');
    assert.deepEqual(rows.map((row) => row.provider).sort(), storeProviders().filter(offered).sort());
  });

  // One row for a provider, whatever the number of places its suite runs on.
  const first = SUBJECTS.filter(
    (subject, index) =>
      offered(subject.provider) && SUBJECTS.findIndex((each) => each.provider === subject.provider) === index,
  );

  for (const subject of first) {
    it(`gives the stages, the reply cap and the production answer of ${subject.provider}`, async () => {
      const store = await subject.open();
      const stages = [...(store.stages ?? SEED_STAGES)];
      await subject.close();
      const cells = rows.find((row) => row.provider === subject.provider)?.cells ?? [];

      assert.deepEqual(
        [...(cells[2] ?? '').matchAll(/`(\w+)`/g)].map((match) => match[1]),
        stages,
      );
      if (typeof subject.replyCap === 'number') {
        assert.match(cells[4] ?? '', new RegExp(`\\bnewest ${subject.replyCap}\\b`));
      } else {
        assert.doesNotMatch(cells[4] ?? '', /\bnewest\b/);
      }
      assert.equal(cells[5], isDevOnlyProvider(subject.provider) ? 'no' : 'yes');
    });
  }
});

describe('Linear, in a team that refuses the labels (FRU-138)', () => {
  const seedOf = (id: string, client: string | undefined) => {
    const seed = seedFixture({ id });

    return client === undefined ? { ...seed, client: undefined } : { ...seed, client: { id: client } };
  };

  it('reads a note back, and keeps the notes of two clients of one team apart', async () => {
    fakeLinear({ refuseLabels: true });
    const store = createLinearStore(LINEAR_CONFIG);
    try {
      const mine = seedOf('sd_mine00000001', 'acme');
      const theirs = seedOf('sd_theirs000001', 'globex');
      await store.create(mine, undefined, POLICY);
      await store.create(theirs, undefined, POLICY);
      const read = async (clientId: string | undefined) =>
        (await store.findForPage({ url: mine.page.url, clientId }, undefined, POLICY)).map((issue) => issue.seed.id);

      assert.deepEqual(await read('acme'), ['sd_mine00000001']);
      assert.deepEqual(await read('globex'), ['sd_theirs000001']);
      assert.deepEqual((await read(undefined)).sort(), ['sd_mine00000001', 'sd_theirs000001']);
    } finally {
      mock.restoreAll();
    }
  });
});

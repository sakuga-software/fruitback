import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, mock } from 'node:test';
import { DEFAULT_SEED_STAGE, SEED_STAGES } from '@fruitback/shared';
import type { ClientPolicy } from './clients.ts';
import { COMMENTS_PER_ISSUE as GITHUB_REPLY_CAP, createGithubStore } from './github.ts';
import { createMemoryStore, resetMemoryLinear } from './linear-memory.ts';
import { COMMENTS_PER_ISSUE as LINEAR_REPLY_CAP, type IssueNode, createLinearStore } from './linear.ts';
import { COMMENTS_PER_ISSUE as SQLITE_REPLY_CAP, closeSqliteConnections, createSqliteStore } from './sqlite.ts';
import type { CreatedIssue, SeedStore } from './store.ts';
import { type ConformanceSubject, describeStoreConformance, repliesNewestFirst } from './store-conformance.fixture.ts';
import { isDevOnlyProvider, storeProviders } from './stores.ts';

/**
 * Each store against the conformance suite (SKG-527). A new store adds a subject here, and a row to the
 * store matrix in `docs/self-hosting.md`.
 */

const POLICY: ClientPolicy = { showComments: true, identitySecret: undefined, read: 'public' };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Linear, as far as the Linear store uses it. It keeps the labels and the issues it receives, and
 * applies the filter of `FruitbackIssues`: the team, every label, and a substring of the description.
 * A label belongs to one team, as on Linear, and an issue refuses a label of another team.
 */
function fakeLinear(): { node(id: string): IssueNode } {
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

    if (operation === 'FruitbackIssues') {
      const filter = variables.filter as {
        team: { id: { eq: string } };
        and: { labels: { some: { name: { eq: string } } } }[];
        description: { contains: string };
      };
      const required = filter.and.map((clause) => labelsOf(filter.team.id.eq).get(clause.labels.some.name.eq));
      const nodes = issues
        .filter((issue) => issue.teamId === filter.team.id.eq)
        .filter((issue) => required.every((id) => id !== undefined && issue.labelIds.includes(id)))
        .filter((issue) => (issue.node.description ?? '').includes(filter.description.contains))
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
let directories: string[] = [];
let sqlitePath = '';

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-conformance-'));
  directories.push(directory);

  return directory;
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
  {
    provider: 'sqlite',
    writtenStage: DEFAULT_SEED_STAGE,
    replyCap: SQLITE_REPLY_CAP,
    otherTenant: 'one file holds the seeds of every client, so there is no other tenant',
    open() {
      sqlitePath = join(freshDirectory(), 'fruitback.db');

      return createSqliteStore({ path: sqlitePath });
    },
    close() {
      closeSqliteConnections();
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
      directories = [];
    },
    unknownState(created) {
      // The store keeps its connection open. Close it before another connection writes the file.
      closeSqliteConnections();
      const database = new DatabaseSync(sqlitePath);
      database.prepare('UPDATE seeds SET stage = ? WHERE id = ?').run('marmalade', Number(created.id));
      database.close();
    },
    plantReplies: (store, seed, count) =>
      writeWithReplies(store, seed, (created) => {
        closeSqliteConnections();
        const database = new DatabaseSync(sqlitePath);
        const insert = database.prepare('INSERT INTO comments (seed_id, author, body, created_at) VALUES (?, ?, ?, ?)');
        for (const reply of repliesNewestFirst(count))
          insert.run(Number(created.id), 'Alice', reply.body, reply.createdAt);
        database.close();
      }),
    broken: () => createSqliteStore({ path: join(freshDirectory(), 'missing', 'fruitback.db') }),
    unreachable: 'the file is on a local disk, so there is no network to lose',
    garbled() {
      const path = join(freshDirectory(), 'fruitback.db');
      writeFileSync(path, 'not a database');

      return createSqliteStore({ path });
    },
  },
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
    async plantReplies(store, seed) {
      // The dev store writes two replies, newest first, on every third note.
      for (const filler of [1, 2]) {
        const page = { ...seed.page, url: `${seed.page.url}?filler=${filler}` };
        await store.create({ ...seed, id: `${seed.id}_${filler}`, page }, undefined, POLICY);
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
    assert.deepEqual(SUBJECTS.map((subject) => subject.provider).sort(), storeProviders().sort());
  });
});

/**
 * The matrix is compared with the code where the code holds the answer: the stages, the reply cap and
 * whether the store runs in production. The column that says what changes a stage is prose about each
 * provider, and no test reads it.
 */
describe('the store matrix in docs/self-hosting.md', () => {
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
    assert.deepEqual(rows.map((row) => row.provider).sort(), storeProviders().sort());
  });

  for (const subject of SUBJECTS) {
    it(`gives the stages, the reply cap and the production answer of ${subject.provider}`, () => {
      const store = subject.open();
      const stages = [...(store.stages ?? SEED_STAGES)];
      subject.close();
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

import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, mock } from 'node:test';
import { DEFAULT_SEED_STAGE, SEED_STAGES } from '@fruitback/shared';
import { createGithubStore } from './github.ts';
import { createMemoryStore, resetMemoryLinear } from './linear-memory.ts';
import { type IssueNode, createLinearStore } from './linear.ts';
import { closeSqliteConnections, createSqliteStore } from './sqlite.ts';
import { type ConformanceSubject, describeStoreConformance } from './store-conformance.fixture.ts';
import { isDevOnlyProvider, storeProviders } from './stores.ts';

/**
 * Each store against the conformance suite (SKG-527). A new store adds a subject here, and a row to the
 * store matrix in `docs/self-hosting.md`.
 */

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Linear, as far as the Linear store uses it. It keeps the labels and the issues it receives, and
 * applies the filter of `FruitbackIssues`: the team, every label, and a substring of the description.
 */
function fakeLinear(): { node(id: string): IssueNode } {
  const labels = new Map<string, string>();
  const issues: { teamId: string; labelIds: string[]; node: IssueNode }[] = [];

  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0];

    if (operation === 'FruitbackLabels') {
      const nodes = (variables.names as string[]).flatMap((name) => {
        const id = labels.get(name);

        return id === undefined ? [] : [{ id, name }];
      });

      return json(200, { data: { team: { labels: { nodes } } } });
    }

    if (operation === 'FruitbackCreateLabel') {
      const { name } = variables.input as { name: string };
      const id = `label_${labels.size + 1}`;
      labels.set(name, id);

      return json(200, { data: { issueLabelCreate: { issueLabel: { id, name } } } });
    }

    if (operation === 'FruitbackCreateIssue') {
      const input = variables.input as { teamId: string; title: string; description: string; labelIds: string[] };
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
      const required = filter.and.map((clause) => labels.get(clause.labels.some.name.eq));
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
 * GitHub, as far as the GitHub store uses it, for the repository `acme/site`. It keeps the labels and
 * the issues it receives. A list filter needs every label, without case. Comments come back in the
 * order they were stored, so the order the store returns is its own.
 */
function fakeGithub(): { issue(id: string): GithubIssue } {
  const labels = new Set<string>();
  const issues: GithubIssue[] = [];

  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const route = `${init.method ?? 'GET'} ${url.pathname}`;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const page = Number(url.searchParams.get('page') ?? '1');
    const perPage = Number(url.searchParams.get('per_page') ?? '30');
    const onPage = <T>(rows: T[]) => rows.slice((page - 1) * perPage, page * perPage);

    if (route === 'GET /repos/acme/site/installation') return json(200, { id: 77 });
    if (route === 'POST /app/installations/77/access_tokens') {
      return json(201, { token: 'ghs_conformance', expires_at: '2999-01-01T00:00:00Z' });
    }

    if (route === 'POST /repos/acme/site/labels') {
      const name = String(body.name).toLowerCase();
      if (labels.has(name)) return json(422, { errors: [{ code: 'already_exists' }] });
      labels.add(name);

      return json(201, { name: body.name });
    }

    if (route === 'POST /repos/acme/site/issues') {
      const number = issues.length + 1;
      const issue: GithubIssue = {
        id: 9000 + number,
        number,
        html_url: `https://github.com/acme/site/issues/${number}`,
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

    if (route === 'GET /repos/acme/site/issues') {
      const required = (url.searchParams.get('labels') ?? '').split(',').map((name) => name.toLowerCase());
      const rows = issues
        .filter((issue) => required.every((name) => issue.labels.some((label) => label.name.toLowerCase() === name)))
        .sort((left, right) => right.number - left.number)
        .map(({ replies, ...row }) => ({ ...row, comments: replies.length }));

      return json(200, onPage(rows));
    }

    const comments = /^GET \/repos\/acme\/site\/issues\/(\d+)\/comments$/.exec(route);
    if (comments) {
      const issue = issues.find((candidate) => candidate.number === Number(comments[1]));

      return issue === undefined ? json(404, { message: 'Not Found' }) : json(200, onPage(issue.replies));
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

/** Every provider answers `500` to every call. */
function outage(): void {
  mock.method(globalThis, 'fetch', async () => json(500, { message: 'down for maintenance' }));
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

const SUBJECTS: ConformanceSubject[] = [
  {
    provider: 'linear',
    writtenStage: DEFAULT_SEED_STAGE,
    open() {
      linear = fakeLinear();

      return createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1' });
    },
    close: () => mock.restoreAll(),
    unknownState(created) {
      linear!.node(created.id).state = { name: 'Marmalade', type: 'marmalade' };
    },
    reply(created, replies) {
      linear!.node(created.id).comments = {
        nodes: replies.map((reply, index) => ({
          id: `comment_${index}`,
          body: reply.body,
          createdAt: reply.createdAt,
          user: { name: 'Alice' },
        })),
      };
    },
    broken() {
      mock.restoreAll();
      outage();

      return createLinearStore({ apiKey: 'lin_api_test', teamId: 'team_1' });
    },
  },
  {
    provider: 'github',
    writtenStage: DEFAULT_SEED_STAGE,
    open() {
      github = fakeGithub();

      return createGithubStore({ appId: '12345', privateKey: GITHUB_KEY, repository: 'acme/site' });
    },
    close: () => mock.restoreAll(),
    unknownState(created) {
      github!.issue(created.id).state = 'marmalade';
    },
    reply(created, replies) {
      github!.issue(created.id).replies = replies.map((reply, index) => ({
        id: 100 + index,
        body: reply.body,
        created_at: reply.createdAt,
        user: { login: 'alice' },
      }));
    },
    broken() {
      mock.restoreAll();
      outage();

      return createGithubStore({ appId: '12345', privateKey: GITHUB_KEY, repository: 'acme/site' });
    },
  },
  {
    provider: 'sqlite',
    writtenStage: DEFAULT_SEED_STAGE,
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
    reply(created, replies) {
      closeSqliteConnections();
      const database = new DatabaseSync(sqlitePath);
      const insert = database.prepare('INSERT INTO comments (seed_id, author, body, created_at) VALUES (?, ?, ?, ?)');
      for (const reply of replies) insert.run(Number(created.id), 'Alice', reply.body, reply.createdAt);
      database.close();
    },
    broken: () => createSqliteStore({ path: join(freshDirectory(), 'missing', 'fruitback.db') }),
  },
  {
    provider: 'memory',
    open() {
      resetMemoryLinear();

      return createMemoryStore();
    },
    close: () => resetMemoryLinear(),
    unknownState: 'the dev store gives each note a state from its own list',
    reply: 'the dev store writes its own replies, on every third note',
    broken: 'the dev store keeps the notes in the process, so no provider can fail',
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
  const header = '| Store | Stages | What changes the stage | Replies | Runs in production |';
  const start = guide.indexOf(`\n${header}\n`);
  const rows = new Map(
    guide
      .slice(start + 1)
      .split('\n\n')[0]!
      .split('\n')
      .slice(2)
      .map((line) => line.split('|').map((cell) => cell.trim()))
      .map((cells) => [/^`(\w+)`$/.exec(cells[1] ?? '')?.[1] ?? '', cells] as const),
  );

  it('has one row for each store, and no other', () => {
    assert.ok(start >= 0, 'the store matrix was not found');
    assert.deepEqual([...rows.keys()].sort(), storeProviders().sort());
  });

  for (const subject of SUBJECTS) {
    it(`gives the stages and the production answer of ${subject.provider}`, () => {
      const store = subject.open();
      const stages = [...(store.stages ?? SEED_STAGES)];
      subject.close();
      const cells = rows.get(subject.provider) ?? [];

      assert.deepEqual(
        [...(cells[2] ?? '').matchAll(/`(\w+)`/g)].map((match) => match[1]),
        stages,
      );
      assert.equal(cells[5], isDevOnlyProvider(subject.provider) ? 'no' : 'yes');
    });
  }

  for (const provider of ['linear', 'github', 'sqlite']) {
    it(`gives the reply cap of ${provider}`, () => {
      const source = readFileSync(new URL(`./${provider}.ts`, import.meta.url), 'utf8');
      const cap = /^const COMMENTS_PER_ISSUE = (\d+);$/m.exec(source)?.[1];

      assert.ok(cap !== undefined, `no COMMENTS_PER_ISSUE in ${provider}.ts`);
      assert.match(rows.get(provider)?.[4] ?? '', new RegExp(`\\bnewest ${cap}\\b`));
    });
  }
});

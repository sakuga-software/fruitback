import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Seed } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { handleRequest } from './app.ts';
import { resetCacheState } from './cache.ts';
import type { WorkerEnv } from './env.ts';
import { type Kv, createMemoryKv, resetSharedKv } from './kv.ts';

/**
 * The parent of a batch when Linear takes it and then refuses its sub-issues (FRU-195).
 *
 * The parent is kept, and the next attempt for the same notes writes its sub-issues under it: a team
 * gets one parent for a batch, not one for each attempt. Nothing in the workspace of the team is
 * archived or changed. The Linear here is a double: nothing of this was measured on a real one.
 */

const ORIGIN = 'https://preview.acme.test';
const PAGE = `${ORIGIN}/pricing`;
const LINEAR: WorkerEnv = {
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  ALLOWED_ORIGINS: ORIGIN,
} as WorkerEnv;

beforeEach(async () => {
  await resetSharedKv();
  resetCacheState();
});
afterEach(() => mock.restoreAll());

function seeds(count: number, from = 0): Seed[] {
  return Array.from({ length: count }, (_, index) =>
    seedFixture({
      id: `sd_parent_${from + index}`,
      note: `Note ${from + index + 1}`,
      page: { url: PAGE, path: '/pricing', title: 'Pricing' },
    }),
  );
}

function send(body: unknown, kv: Kv, query = ''): Promise<Response> {
  return handleRequest(
    new Request(`https://worker.fruitback.dev/feedback${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    LINEAR,
    { clientIp: '203.0.113.7', kv },
  );
}

type Input = { title: string; parentId?: string };
type Linear = {
  /** Every issue Linear keeps: a parent has no `parentId`. */
  kept: (Input & { id: string })[];
  /** Every `issueCreate` it was asked, kept or not. */
  asked: Input[];
  /** Every operation that is not a read of labels or an `issueCreate`. */
  others: string[];
  /** Whether it refuses a sub-issue: `nth` counts the sub-issues it was asked, from one. */
  refuses: (nth: number) => boolean;
  /** The parents it refuses a sub-issue of, as a parent that the team deleted. */
  gone: Set<string>;
};

/** A Linear that keeps what it is asked, and refuses the sub-issues when it is told to. */
function installLinear(): Linear {
  const linear: Linear = { kept: [], asked: [], others: [], refuses: () => false, gone: new Set() };
  let subIssues = 0;
  const answer = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0] ?? 'unknown';
    if (operation === 'FruitbackLabels') return answer({ data: { team: { labels: { nodes: [] } } } });
    if (operation === 'FruitbackCreateLabel') {
      const { name } = variables.input as { name: string };

      return answer({ data: { issueLabelCreate: { issueLabel: { id: `label_${name}`, name } } } });
    }
    if (operation !== 'FruitbackCreateIssue') {
      linear.others.push(operation);

      return answer({ errors: [{ message: `the double does not know ${operation}` }] });
    }

    const input = variables.input as Input;
    linear.asked.push({ title: input.title, ...(input.parentId === undefined ? {} : { parentId: input.parentId }) });
    if (input.parentId !== undefined && (linear.refuses(++subIssues) || linear.gone.has(input.parentId))) {
      return answer({ errors: [{ message: 'Linear refuses this sub-issue' }] });
    }
    const id = `issue_${linear.kept.length + 1}`;
    linear.kept.push({ id, title: input.title, ...(input.parentId === undefined ? {} : { parentId: input.parentId }) });

    return answer({
      data: {
        issueCreate: { success: true, issue: { id, identifier: `DES-${linear.kept.length}`, url: `https://l/${id}` } },
      },
    });
  });

  return linear;
}

const parents = (linear: Linear) => linear.kept.filter((issue) => issue.parentId === undefined);
const children = (linear: Linear) => linear.kept.filter((issue) => issue.parentId !== undefined);

describe('a batch whose parent Linear took and whose sub-issues it refused (FRU-195)', () => {
  it('answers 502, and leaves one parent with no sub-issue', async () => {
    const linear = installLinear();
    linear.refuses = () => true;

    const sent = await send(seeds(2), createMemoryKv());

    assert.equal(sent.status, 502);
    assert.equal(parents(linear).length, 1);
    assert.equal(children(linear).length, 0);
  });

  it('writes no second parent at the next attempt: the notes go under the first one', async () => {
    const linear = installLinear();
    const kv = createMemoryKv();
    linear.refuses = () => true;
    assert.equal((await send(seeds(2), kv)).status, 502);

    linear.refuses = () => false;
    const again = await send(seeds(2), kv);

    assert.equal(again.status, 201, await again.clone().text());
    assert.equal(parents(linear).length, 1, 'the second attempt wrote a second parent');
    assert.deepEqual(
      children(linear).map((issue) => issue.parentId),
      ['issue_1', 'issue_1'],
    );
  });

  it('archives nothing and changes nothing in Linear: it only creates issues', async () => {
    const linear = installLinear();
    const kv = createMemoryKv();
    linear.refuses = () => true;
    await send(seeds(2), kv);
    linear.refuses = () => false;
    await send(seeds(2), kv);

    assert.deepEqual(linear.others, []);
  });

  it('puts the notes that a partial attempt did not keep under the same parent', async () => {
    const linear = installLinear();
    const kv = createMemoryKv();
    // The first note is kept, then Linear refuses the second.
    linear.refuses = (nth) => nth === 2;
    assert.equal((await send(seeds(2), kv)).status, 207);

    // The widget sends again the note that was not kept, alone.
    const again = await send(seeds(1, 1), kv);

    assert.equal(again.status, 201, await again.clone().text());
    assert.equal(parents(linear).length, 1, 'the note sent again got a parent of its own');
    assert.equal(children(linear).length, 2);
  });

  it('does not hold on to a parent that keeps no note: the attempt after a second failure writes a new one', async () => {
    const linear = installLinear();
    const kv = createMemoryKv();
    linear.refuses = () => true;
    assert.equal((await send(seeds(2), kv)).status, 502);
    // The team deleted the empty parent: Linear refuses every sub-issue of it, and takes the others.
    linear.refuses = () => false;
    linear.gone.add('issue_1');
    assert.equal((await send(seeds(2), kv)).status, 502);

    const third = await send(seeds(2), kv);

    assert.equal(third.status, 201, await third.clone().text());
    assert.deepEqual(
      children(linear).map((issue) => issue.parentId),
      ['issue_2', 'issue_2'],
    );
  });

  it('does not put other notes under the parent of a batch they are no part of', async () => {
    const linear = installLinear();
    const kv = createMemoryKv();
    linear.refuses = () => true;
    await send(seeds(2), kv);
    linear.refuses = () => false;

    // Other notes, in the same minutes: they are no part of the first batch.
    const other = await send(seeds(2, 10), kv);

    assert.equal(other.status, 201);
    assert.equal(parents(linear).length, 2);
    assert.deepEqual(
      children(linear).map((issue) => issue.parentId),
      ['issue_2', 'issue_2'],
    );
  });

  it('still plants the notes when the Kv does not remember the parent', async () => {
    const linear = installLinear();
    const memory = createMemoryKv();
    const kv: Kv = {
      ...memory,
      get: (key) => (key.includes('batch-parent') ? Promise.reject(new Error('no answer')) : memory.get(key)),
      set: (key, value, ttl) =>
        key.includes('batch-parent') ? Promise.reject(new Error('no answer')) : memory.set(key, value, ttl),
    };

    const sent = await send(seeds(2), kv);

    assert.equal(sent.status, 201, await sent.clone().text());
    assert.equal(children(linear).length, 2);
  });
});

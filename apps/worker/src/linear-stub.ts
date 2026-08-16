import { mock } from 'node:test';
import { type Seed, buildIssueDescription, buildIssueTitle } from '@sakuga/fruitback-shared';

/**
 * A fake Linear GraphQL endpoint, dispatching on the operation name. It records every call so a test
 * can assert what was actually sent — the description in particular, which has to round-trip.
 *
 * `fetch` is replaced through `node:test`'s mock registry, so `mock.restoreAll()` in an `afterEach`
 * puts the real one back.
 */

export type GraphqlCall = { operation: string; variables: Record<string, unknown> };

export type IssueInput = {
  teamId: string;
  projectId?: string;
  title: string;
  description: string;
  labelIds: string[];
};

/** One issue as `FruitbackIssues` returns it. */
export type StoredIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  updatedAt: string;
  description: string | null;
  state: { name: string; type: string } | null;
};

export type LinearStub = {
  calls: GraphqlCall[];
  /** Input of the last `issueCreate`, i.e. what Linear would have stored. */
  issueInput(): IssueInput;
  createdLabels(): string[];
  /** Filter of the last `issues` query, i.e. what Linear was asked to narrow on. */
  issueFilter(): Record<string, unknown>;
};

export type LinearStubOptions = {
  /** Labels that already exist in the team, as name → id. */
  existingLabels?: Record<string, string>;
  /** Fail every label creation, to exercise the drop-the-label path. */
  failLabelCreation?: boolean;
  /** Make `issueCreate` fail the way an outage would. */
  failIssueCreation?: boolean;
  /**
   * Issues the read path will find. Returned whatever the filter says: Linear's
   * `description contains` is a substring match, and leaving the narrowing to the worker is what
   * lets a test prove it drops the issues of a neighbouring page.
   */
  storedIssues?: StoredIssue[];
  /** Serve `storedIssues` this many at a time, to exercise the pagination loop. */
  issuesPageSize?: number;
  /** Make the `issues` query fail the way an outage would. */
  failIssueQuery?: boolean;
};

/** A stored issue built from a seed, the way `POST /feedback` would have written it. */
export function storedIssueFromSeed(seed: Seed, overrides: Partial<StoredIssue> = {}): StoredIssue {
  return {
    id: `issue_${seed.id}`,
    identifier: 'SKG-901',
    url: 'https://linear.app/sakuga-software/issue/SKG-901',
    title: buildIssueTitle(seed),
    updatedAt: '2026-08-05T10:00:00.000Z',
    description: buildIssueDescription(seed),
    state: { name: 'In Progress', type: 'started' },
    ...overrides,
  };
}

export function installLinearStub(options: LinearStubOptions = {}): LinearStub {
  const existing: Record<string, string> = { ...(options.existingLabels ?? {}) };
  const calls: GraphqlCall[] = [];
  const createdLabels: string[] = [];

  mock.method(globalThis, 'fetch', async (_url: unknown, init: { body: string }) => {
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
    const operation = /Fruitback\w+/.exec(query)?.[0] ?? 'unknown';
    calls.push({ operation, variables });

    if (operation === 'FruitbackLabels') {
      const names = variables.names as string[];
      const nodes = names.filter((name) => name in existing).map((name) => ({ id: existing[name], name }));

      return jsonResponse({ data: { team: { labels: { nodes } } } });
    }

    if (operation === 'FruitbackCreateLabel') {
      const { name } = variables.input as { name: string };
      if (options.failLabelCreation) return jsonResponse({ errors: [{ message: 'name must be unique' }] });

      const id = `label_${createdLabels.length + 1}`;
      existing[name] = id;
      createdLabels.push(name);

      return jsonResponse({ data: { issueLabelCreate: { issueLabel: { id, name } } } });
    }

    if (operation === 'FruitbackCreateIssue') {
      if (options.failIssueCreation) return jsonResponse({ errors: [{ message: 'Linear is down' }] });

      return jsonResponse({
        data: {
          issueCreate: {
            success: true,
            issue: { id: 'issue_1', identifier: 'SKG-999', url: 'https://linear.app/sakuga-software/issue/SKG-999' },
          },
        },
      });
    }

    if (operation === 'FruitbackIssues') {
      if (options.failIssueQuery) return jsonResponse({ errors: [{ message: 'Linear is down' }] });

      const stored = options.storedIssues ?? [];
      const pageSize = options.issuesPageSize ?? stored.length;
      const offset = Number(variables.after ?? 0);
      const nodes = pageSize > 0 ? stored.slice(offset, offset + pageSize) : stored;
      const next = offset + nodes.length;

      return jsonResponse({
        data: {
          issues: {
            pageInfo: { hasNextPage: next < stored.length, endCursor: String(next) },
            nodes,
          },
        },
      });
    }

    return jsonResponse({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  return {
    calls,
    issueInput() {
      const call = [...calls].reverse().find((entry) => entry.operation === 'FruitbackCreateIssue');
      if (!call) throw new Error('no issue was created');

      return call.variables.input as IssueInput;
    },
    createdLabels: () => createdLabels,
    issueFilter() {
      const call = [...calls].reverse().find((entry) => entry.operation === 'FruitbackIssues');
      if (!call) throw new Error('no issue was queried');

      return call.variables.filter as Record<string, unknown>;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

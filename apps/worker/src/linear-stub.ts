import { type Mock, vi } from 'vitest';

/**
 * A fake Linear GraphQL endpoint, dispatching on the operation name. It records every call so a test
 * can assert what was actually sent — the description in particular, which has to round-trip.
 */

export type GraphqlCall = { operation: string; variables: Record<string, unknown> };

export type IssueInput = {
  teamId: string;
  projectId?: string;
  title: string;
  description: string;
  labelIds: string[];
};

export type LinearStub = {
  fetch: Mock;
  calls: GraphqlCall[];
  /** Input of the last `issueCreate`, i.e. what Linear would have stored. */
  issueInput(): IssueInput;
  createdLabels(): string[];
};

export type LinearStubOptions = {
  /** Labels that already exist in the team, as name → id. */
  existingLabels?: Record<string, string>;
  /** Fail every label creation, to exercise the drop-the-label path. */
  failLabelCreation?: boolean;
  /** Make `issueCreate` fail the way an outage would. */
  failIssueCreation?: boolean;
};

export function installLinearStub(options: LinearStubOptions = {}): LinearStub {
  const existing: Record<string, string> = { ...(options.existingLabels ?? {}) };
  const calls: GraphqlCall[] = [];
  const createdLabels: string[] = [];

  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
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

    return jsonResponse({ errors: [{ message: `unexpected operation: ${operation}` }] });
  });

  vi.stubGlobal('fetch', fetchMock);

  return {
    fetch: fetchMock,
    calls,
    issueInput() {
      const call = [...calls].reverse().find((entry) => entry.operation === 'FruitbackCreateIssue');
      if (!call) throw new Error('no issue was created');

      return call.variables.input as IssueInput;
    },
    createdLabels: () => createdLabels,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

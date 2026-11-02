import { mockMethod } from './mock.fixture.ts';
import { type Note, buildIssueDescription, buildIssueTitle } from '@fruitback/shared';

/**
 * A fake Linear GraphQL endpoint, dispatching on the operation name. It records every call so a test
 * can assert what was actually sent — the description in particular, which has to round-trip.
 *
 * `fetch` is replaced through vitest's mock registry, so `vi.restoreAllMocks()` in an `afterEach`
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
  /** What Linear returns for the nested `comments` connection (FRU-13). */
  comments?: { nodes: { id: string; body: string; createdAt: string; user: { name: string } | null }[] } | null;
  /**
   * Every attachment of the issue, in the order of Linear (FRU-348). The stub sends back only what
   * the `attachments(first:, filter:)` of the query asks for, as Linear does.
   */
  attachments?: { nodes: StoredAttachment[] } | null;
};

export type StoredAttachment = { title: string; url: string; subtitle: string | null };

export type LinearStub = {
  calls: GraphqlCall[];
  /** The PUTs of files to the storage, in order (FRU-331). */
  puts: PutCall[];
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
  /** The workflow states of the team of every issue, for « Still wrong » (FRU-294). */
  teamStates?: { id: string; name: string; type: string; position: number }[];
  /** FRU-331: `fileUpload` refuses, the storage answers this status to the PUT, `attachmentCreate` refuses. */
  failFileUpload?: boolean;
  putStatus?: number;
  failAttachment?: boolean;
  /** The address `fileUpload` answers to put the bytes at. */
  uploadUrl?: string;
};

/** A PUT of the bytes of a file to the storage of Linear (FRU-331). */
export type PutCall = { url: string; headers: Record<string, string>; body: Uint8Array };

/** A stored issue built from a note, the way `POST /feedback` would have written it. */
export function storedIssueFromNote(note: Note, overrides: Partial<StoredIssue> = {}): StoredIssue {
  return {
    id: `issue_${note.id}`,
    identifier: 'SKG-901',
    url: 'https://linear.app/sakuga-software/issue/SKG-901',
    title: buildIssueTitle(note),
    updatedAt: '2026-08-05T10:00:00.000Z',
    description: buildIssueDescription(note),
    state: { name: 'In Progress', type: 'started' },
    ...overrides,
  };
}

export function installLinearStub(options: LinearStubOptions = {}): LinearStub {
  const existing: Record<string, string> = { ...(options.existingLabels ?? {}) };
  const calls: GraphqlCall[] = [];
  const createdLabels: string[] = [];
  const puts: PutCall[] = [];

  mockMethod(
    globalThis,
    'fetch',
    async (url: unknown, init: { method?: string; body: string; headers?: Record<string, string> }) => {
      if (init.method === 'PUT') {
        puts.push({
          url: String(url),
          headers: { ...init.headers },
          body: new Uint8Array(init.body as unknown as Uint8Array),
        });
        calls.push({ operation: 'PUT', variables: { url: String(url) } });

        return new Response(null, { status: options.putStatus ?? 200 });
      }
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
        const page = pageSize > 0 ? stored.slice(offset, offset + pageSize) : stored;
        const nodes = page.map((issue) => withAskedAttachments(issue, query, variables));
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

      if (operation === 'FruitbackFileUpload') {
        if (options.failFileUpload) return jsonResponse({ errors: [{ message: 'upload refused' }] });
        const n = calls.filter((call) => call.operation === 'FruitbackFileUpload').length;

        return jsonResponse({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: options.uploadUrl ?? `https://storage.linear.test/put/${n}?signed=1`,
                assetUrl: `https://uploads.linear.app/asset/${n}/${String(variables.filename)}`,
                headers: [
                  { key: 'x-goog-content-length-range', value: `${String(variables.size)},${String(variables.size)}` },
                ],
              },
            },
          },
        });
      }

      if (operation === 'FruitbackCreateAttachment') {
        if (options.failAttachment) return jsonResponse({ errors: [{ message: 'attachment refused' }] });

        return jsonResponse({
          data: { attachmentCreate: { success: true, attachment: { id: `att_${calls.length}`, url: '', title: '' } } },
        });
      }

      if (operation === 'FruitbackIssueStates') {
        return jsonResponse({
          data: { issue: { id: variables.id, team: { id: 'team_1', states: { nodes: options.teamStates ?? [] } } } },
        });
      }

      if (operation === 'FruitbackReopenIssue') {
        const { stateId } = variables.input as { stateId: string };
        const state = (options.teamStates ?? []).find((each) => each.id === stateId);
        if (state === undefined) return jsonResponse({ errors: [{ message: 'Entity not found: WorkflowState' }] });

        return jsonResponse({
          data: {
            issueUpdate: {
              success: true,
              issue: { id: variables.id, state: { id: state.id, name: state.name, type: state.type } },
            },
          },
        });
      }

      if (operation === 'FruitbackCreateComment') {
        const { body } = variables.input as { body: string };

        return jsonResponse({
          data: {
            commentCreate: {
              success: true,
              comment: {
                id: `comment_${calls.length}`,
                body,
                createdAt: '2026-10-20T10:00:00.000Z',
                user: { name: 'Fruitback' },
              },
            },
          },
        });
      }

      return jsonResponse({ errors: [{ message: `unexpected operation: ${operation}` }] });
    },
  );

  return {
    calls,
    puts,
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

/**
 * The attachments of an issue as Linear answers `attachments(first: …, filter: …)` (FRU-348): the
 * filter on the subtitle first, then the first ones. Each argument is read from the query, as a
 * literal or as a variable, so a query that asks for too few is answered with too few.
 */
function withAskedAttachments(issue: StoredIssue, query: string, variables: Record<string, unknown>): StoredIssue {
  if (issue.attachments == null) return issue;
  const args = /attachments\(([^)]*)\)/.exec(query)?.[1] ?? '';
  const valueOf = (name: string): unknown => {
    const raw = new RegExp(`${name}:\\s*(\\$\\w+|\\d+)`).exec(args)?.[1];
    if (raw === undefined) return undefined;

    return raw.startsWith('$') ? variables[raw.slice(1)] : Number(raw);
  };
  // Linear sends 50 when the query names no `first`.
  const first = (valueOf('first') as number | undefined) ?? 50;
  const filter = valueOf('filter') as { subtitle?: { eq?: string } } | undefined;
  const subtitle = filter?.subtitle?.eq;
  const kept = issue.attachments.nodes.filter((each) => subtitle === undefined || each.subtitle === subtitle);

  return { ...issue, attachments: { nodes: kept.slice(0, first) } };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A fake Linear that keeps what it receives, for the bench of the extension (FRU-426).
 *
 * `linear.ts` runs as in production: its GraphQL calls and the PUT of each file reach `answer`
 * in place of the network. It keeps the issues, the bytes of each file and each attachment, and
 * gives them back to the read of the page, so a pin comes back after a reload.
 *
 * It differs from `linear-stub.ts`: the stub answers each test with canned data, and this fake
 * holds state for one process. `installLinearFake` puts it in front of `fetch`.
 */

export const LINEAR_FAKE_GRAPHQL = 'https://api.linear.app/graphql';
/** The address `fileUpload` gives for the bytes. It is https, because `linear.ts` refuses another scheme. */
export const LINEAR_FAKE_STORAGE = 'https://storage.linear.fake';
export const LINEAR_FAKE_TEAM = 'team_bench';

export type FakeFile = { uploadUrl: string; assetUrl: string; name: string; type: string; size: number };
export type FakePut = { url: string; type: string; bytes: number; sha256: string };
export type FakeAttachment = { issueId: string; title: string; url: string; subtitle: string | null };
export type FakeIssue = {
  id: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  teamId: string;
  createdAt: string;
};

/** What the fake received, in order: what `GET /__dev/tracker` answers. */
export type TrackerReceived = {
  issues: FakeIssue[];
  uploads: FakeFile[];
  puts: FakePut[];
  attachments: FakeAttachment[];
};

const STATES = [
  { id: 'state_backlog', name: 'Backlog', type: 'backlog', color: '#bec2c8', position: 0 },
  { id: 'state_todo', name: 'Todo', type: 'unstarted', color: '#e2e2e2', position: 1 },
  { id: 'state_progress', name: 'In Progress', type: 'started', color: '#f2c94c', position: 2 },
  { id: 'state_done', name: 'Done', type: 'completed', color: '#5e6ad2', position: 3 },
];

export type LinearFake = {
  /** The answer of the fake, or `undefined` for a request that is not for Linear. */
  answer(url: string, init: RequestInit | undefined): Promise<Response> | undefined;
  received(): TrackerReceived;
};

export function createLinearFake(): LinearFake {
  const issues: FakeIssue[] = [];
  const uploads: FakeFile[] = [];
  const puts: FakePut[] = [];
  const attachments: FakeAttachment[] = [];
  const labels = new Map<string, string>();

  const graphql = (query: string, variables: Record<string, unknown>): unknown => {
    const operation = /Fruitback\w+/.exec(query)?.[0] ?? 'unknown';
    switch (operation) {
      case 'FruitbackLabels': {
        const names = (variables.names as string[] | undefined) ?? [];
        return {
          team: {
            labels: { nodes: names.filter((name) => labels.has(name)).map((name) => ({ id: labels.get(name), name })) },
          },
        };
      }
      case 'FruitbackCreateLabel': {
        const { name } = variables.input as { name: string };
        const id = `label_${labels.size + 1}`;
        labels.set(name, id);
        return { issueLabelCreate: { issueLabel: { id, name } } };
      }
      case 'FruitbackCreateIssue': {
        const input = variables.input as { teamId: string; title: string; description?: string };
        const number = issues.length + 1;
        const issue: FakeIssue = {
          id: `issue_${number}`,
          identifier: `BENCH-${number}`,
          url: `https://linear.app/bench/issue/BENCH-${number}`,
          title: input.title,
          description: input.description ?? '',
          teamId: input.teamId,
          createdAt: new Date().toISOString(),
        };
        issues.push(issue);
        return {
          issueCreate: { success: true, issue: { id: issue.id, identifier: issue.identifier, url: issue.url } },
        };
      }
      case 'FruitbackIssues':
        return {
          issues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: issues.map((issue) => ({
              id: issue.id,
              identifier: issue.identifier,
              url: issue.url,
              title: issue.title,
              updatedAt: issue.createdAt,
              description: issue.description,
              state: STATES[1],
              comments: { nodes: [] },
              attachments: {
                nodes: attachments
                  .filter((each) => each.issueId === issue.id)
                  .map(({ title, url, subtitle }) => ({ title, url, subtitle })),
              },
            })),
          },
        };
      case 'FruitbackFileUpload': {
        const number = uploads.length + 1;
        const name = String(variables.filename);
        const file: FakeFile = {
          uploadUrl: `${LINEAR_FAKE_STORAGE}/put/${number}`,
          assetUrl: `${LINEAR_FAKE_STORAGE}/asset/${number}/${encodeURIComponent(name)}`,
          name,
          type: String(variables.contentType),
          size: Number(variables.size),
        };
        uploads.push(file);
        return {
          fileUpload: {
            success: true,
            uploadFile: { uploadUrl: file.uploadUrl, assetUrl: file.assetUrl, headers: [] },
          },
        };
      }
      case 'FruitbackCreateAttachment': {
        const input = variables.input as FakeAttachment;
        attachments.push({
          issueId: input.issueId,
          title: input.title,
          url: input.url,
          subtitle: input.subtitle ?? null,
        });
        return { attachmentCreate: { success: true } };
      }
      case 'FruitbackViewer':
        return { viewer: { name: 'Bench' }, organization: { name: 'Bench' } };
      case 'FruitbackTeams':
      case 'FruitbackPlaces': {
        // A search, or the ids of the places of a site (FRU-501), as Linear filters them.
        const search = (variables.filter as { name?: { containsIgnoreCase?: string } } | undefined)?.name
          ?.containsIgnoreCase;
        const ids = variables.teams as string[] | undefined;
        const team = { id: LINEAR_FAKE_TEAM, name: 'Bench', key: 'BENCH', projects: { nodes: [] } };
        const kept =
          (search === undefined || team.name.toLowerCase().includes(search.toLowerCase())) &&
          (ids === undefined || ids.includes(team.id));
        return { teams: { nodes: kept ? [team] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      case 'FruitbackStates':
        return {
          workflowStates: {
            nodes: STATES.map((state) => ({ ...state, team: { id: LINEAR_FAKE_TEAM, name: 'Bench' } })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      default:
        return undefined;
    }
  };

  return {
    answer(url, init) {
      if (url === LINEAR_FAKE_GRAPHQL) {
        const { query, variables } = JSON.parse(String(init?.body)) as {
          query: string;
          variables?: Record<string, unknown>;
        };
        const data = graphql(query, variables ?? {});
        const body =
          data === undefined ? { errors: [{ message: 'The fake Linear has no answer for this operation' }] } : { data };

        return Promise.resolve(Response.json(body));
      }
      if (url.startsWith(`${LINEAR_FAKE_STORAGE}/put/`) && init?.method === 'PUT') {
        return (async () => {
          const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
          const digest = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
          const type = new Headers(init.headers).get('Content-Type') ?? '';
          puts.push({ url, type, bytes: bytes.byteLength, sha256: digest });

          return new Response(null, { status: 200 });
        })();
      }

      return undefined;
    },
    received: () => ({ issues: [...issues], uploads: [...uploads], puts: [...puts], attachments: [...attachments] }),
  };
}

/**
 * Puts `fake` in front of the `fetch` of this process. A request for Linear goes to the fake; any
 * other request goes to the network as before.
 */
export function installLinearFake(fake: LinearFake): void {
  const network = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);

    return fake.answer(url, init) ?? network(input, init);
  };
}

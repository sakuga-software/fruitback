import type { Http } from './plugin.ts';

/**
 * Jira Cloud and the authorization server of Atlassian, as far as the connector uses them (FRU-622),
 * on no port: an `Http` that a test hands the worker (`trackerHttp`) or the store.
 *
 * Each answer has the shape that the official documentation gives, read on 2026-11-08:
 * - the OAuth 2.0 (3LO) page of Jira Cloud: `POST https://auth.atlassian.com/oauth/token` with a
 *   JSON body, `403 { error: 'invalid_grant' }` for a refresh token it does not know, and
 *   `GET https://api.atlassian.com/oauth/token/accessible-resources`;
 * - the OpenAPI of the REST API v3 (`swagger-v3.v3.json`, version 1001.0.0): `CreatedIssue`,
 *   `PageOfCreateMetaIssueTypes`, `PageBeanProject`, `SearchAndReconcileResults`,
 *   `IssueTypeWithStatus`, and `Attachment` for `POST /issue/{key}/attachments`, which wants
 *   `X-Atlassian-Token: no-check` and a multipart field named `file`.
 *
 * It refuses what Jira refuses: a call with no bearer, an upload without its header, a JQL that is
 * not bounded by a project.
 */

export const SITE_ID = '11223344-a1b2-3b33-c444-def123456789';
export const OTHER_SITE_ID = '99887766-a1b2-3b33-c444-def123456789';
export const JIRA_CLIENT = { clientId: 'jira-client', clientSecret: 'the-jira-client-secret' };

type Issue = {
  id: string;
  key: string;
  project: string;
  fields: Record<string, unknown>;
  labels: string[];
  status: { id: string; name: string; statusCategory: { key: string } };
  resolution: { name: string } | null;
  comments: { id: string; body: unknown; created: string; author: { displayName: string } }[];
  attachments: { filename: string; mimeType: string; size: number }[];
};

export function fakeJira() {
  const state = {
    valid: new Set<string>(),
    refreshable: new Set<string>(),
    codes: new Set<string>(),
    lasts: 3_600,
    generation: 0,
    /** The sites of the consent, as `accessible-resources` lists them: a Confluence one too. */
    resources: [
      {
        id: SITE_ID,
        name: 'acme',
        url: 'https://acme.atlassian.net',
        scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user'],
        avatarUrl: 'https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png',
      },
      {
        id: SITE_ID,
        name: 'acme',
        url: 'https://acme.atlassian.net',
        scopes: ['read:confluence-content.all'],
        avatarUrl: 'https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png',
      },
    ] as { id: string; name: string; url: string; scopes: string[]; avatarUrl: string }[],
    projects: [
      { id: '10000', key: 'DES', name: 'Design' },
      { id: '10001', key: 'PLA', name: 'Platform' },
    ],
    /** The projects that the person of the token may not see: Jira answers 404 for them. */
    hidden: new Set<string>(),
    issueTypes: [
      { id: '10003', name: 'Sub-task', subtask: true },
      { id: '10001', name: 'Task', subtask: false },
      { id: '10004', name: 'Bug', subtask: false },
    ],
    statuses: [
      { id: '10000', name: 'To Do', statusCategory: { key: 'new', colorName: 'blue-gray' } },
      { id: '3', name: 'In Progress', statusCategory: { key: 'indeterminate', colorName: 'yellow' } },
      { id: '10001', name: 'Done', statusCategory: { key: 'done', colorName: 'green' } },
    ],
    issues: [] as Issue[],
    /** Every JQL that a search was asked with. */
    searches: [] as string[],
    /** What the next call to the REST API answers in place of its own answer, once. */
    next: undefined as { status: number; body?: unknown } | undefined,
  };

  const mint = () => {
    state.generation += 1;
    const access = `jira-access-${state.generation}`;
    const refresh = `jira-refresh-${state.generation}`;
    state.valid.add(access);
    state.refreshable.add(refresh);

    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: state.lasts,
      scope: 'read:jira-work write:jira-work read:jira-user offline_access',
      token_type: 'Bearer',
    };
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const errorOf = (status: number, message: string) => json({ errorMessages: [message], errors: {} }, status);

  async function rest(url: URL, init: RequestInit | undefined, method: string): Promise<Response> {
    const site = /^\/ex\/jira\/([0-9a-f-]{36})(\/rest\/api\/3\/.*)$/.exec(url.pathname);
    if (site === null || site[1] !== SITE_ID) return errorOf(404, 'Site not found');
    const path = site[2] as string;
    const project = (id: string) => state.projects.find((each) => each.id === id && !state.hidden.has(id));

    if (method === 'GET' && path === '/rest/api/3/project/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase();
      const startAt = Number(url.searchParams.get('startAt') ?? '0');
      const maxResults = Number(url.searchParams.get('maxResults') ?? '50');
      const all = state.projects.filter(
        (each) =>
          !state.hidden.has(each.id) &&
          (each.name.toLowerCase().includes(query) || each.key.toLowerCase().includes(query)),
      );
      const values = all.slice(startAt, startAt + maxResults);

      return json({
        isLast: startAt + values.length >= all.length,
        maxResults,
        startAt,
        total: all.length,
        self: `https://your-domain.atlassian.net/rest/api/3/project/search?startAt=${startAt}`,
        values: values.map((each) => ({ ...each, projectTypeKey: 'software', simplified: false, style: 'classic' })),
      });
    }
    const one = /^\/rest\/api\/3\/project\/([0-9]+)$/.exec(path);
    if (method === 'GET' && one !== null) {
      const found = project(one[1] as string);

      return found === undefined
        ? errorOf(404, 'No project could be found')
        : json({ ...found, projectTypeKey: 'software' });
    }
    const statuses = /^\/rest\/api\/3\/project\/([0-9]+)\/statuses$/.exec(path);
    if (method === 'GET' && statuses !== null) {
      if (project(statuses[1] as string) === undefined) return errorOf(404, 'No project could be found');

      return json([
        { id: '10001', name: 'Task', subtask: false, statuses: state.statuses },
        { id: '10004', name: 'Bug', subtask: false, statuses: state.statuses.slice(0, 2) },
      ]);
    }
    const types = /^\/rest\/api\/3\/issue\/createmeta\/([0-9]+)\/issuetypes$/.exec(path);
    if (method === 'GET' && types !== null) {
      if (project(types[1] as string) === undefined) return errorOf(404, 'No project could be found');

      return json({ issueTypes: state.issueTypes, maxResults: 50, startAt: 0, total: state.issueTypes.length });
    }
    if (method === 'POST' && path === '/rest/api/3/issue') {
      const body = JSON.parse(String(init?.body)) as { fields: Record<string, unknown> };
      const fields = body.fields;
      const id = (fields.project as { id?: string } | undefined)?.id ?? '';
      const found = project(id);
      if (found === undefined)
        return json({ errorMessages: [], errors: { project: 'valid project is required' } }, 400);
      if (typeof fields.summary !== 'string' || fields.summary.length > 255) {
        return json({ errorMessages: [], errors: { summary: 'Summary must be less than 255 characters.' } }, 400);
      }
      const labels = (fields.labels ?? []) as string[];
      if (labels.some((label) => /\s/.test(label))) {
        return json({ errorMessages: [], errors: { labels: 'The label cannot contain spaces.' } }, 400);
      }
      const description = fields.description as { type?: string; version?: number } | undefined;
      if (description !== undefined && (description.type !== 'doc' || description.version !== 1)) {
        return json(
          { errorMessages: [], errors: { description: 'Operation value must be an Atlassian Document' } },
          400,
        );
      }
      const n = state.issues.length + 1;
      const key = `${found.key}-${n}`;
      state.issues.push({
        id: String(10_000 + n),
        key,
        project: found.id,
        fields,
        labels,
        status: state.statuses[0] as Issue['status'],
        resolution: null,
        comments: [],
        attachments: [],
      });

      return json(
        { id: String(10_000 + n), key, self: `https://your-domain.atlassian.net/rest/api/3/issue/${10_000 + n}` },
        201,
      );
    }
    const attach = /^\/rest\/api\/3\/issue\/([A-Z]+-[0-9]+)\/attachments$/.exec(path);
    if (method === 'POST' && attach !== null) {
      const issue = state.issues.find((each) => each.key === attach[1]);
      if (issue === undefined) return errorOf(404, 'Issue does not exist');
      if (new Headers(init?.headers).get('X-Atlassian-Token') !== 'no-check') return errorOf(403, 'XSRF check failed');
      if (!(init?.body instanceof FormData)) return errorOf(415, 'Unsupported media type');
      const files = init.body.getAll('file').filter((each): each is File => each instanceof File);
      if (files.length === 0) return errorOf(400, 'No file');
      const added = files.map((file) => ({ filename: file.name, mimeType: file.type, size: file.size }));
      issue.attachments.push(...added);

      return json(
        added.map((each, index) => ({ ...each, id: String(20_000 + index), created: '2026-11-08T10:00:00.000+0000' })),
      );
    }
    if (method === 'GET' && path === '/rest/api/3/search/jql') {
      const jql = url.searchParams.get('jql') ?? '';
      state.searches.push(jql);
      // A search must be bounded (« this parameter requires a bounded query »).
      const bounded = /^project = ([0-9]+)((?: AND labels = "[^"]+")*) ORDER BY created DESC$/.exec(jql);
      if (bounded === null) return errorOf(400, 'Unbounded JQL queries are not allowed here.');
      const wanted = [...(bounded[2] ?? '').matchAll(/labels = "([^"]+)"/g)].map((match) => match[1] as string);
      const fields = (url.searchParams.get('fields') ?? '').split(',');
      const issues = state.issues
        .filter((issue) => issue.project === bounded[1] && wanted.every((label) => issue.labels.includes(label)))
        .reverse()
        .map((issue) => ({
          expand: '',
          id: issue.id,
          key: issue.key,
          self: `https://your-domain.atlassian.net/rest/api/3/issue/${issue.id}`,
          fields: {
            summary: issue.fields.summary,
            description: issue.fields.description,
            labels: issue.labels,
            updated: '2026-11-08T10:00:00.000+0000',
            status: { ...issue.status, self: 'https://your-domain.atlassian.net/rest/api/3/status/1' },
            resolution: issue.resolution,
            ...(fields.includes('comment')
              ? {
                  comment: {
                    comments: issue.comments,
                    maxResults: issue.comments.length,
                    startAt: 0,
                    total: issue.comments.length,
                  },
                }
              : {}),
          },
        }));

      return json({ isLast: true, issues });
    }

    return errorOf(404, `No route for ${method} ${path}`);
  }

  const http: Http = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    if (url.origin === 'https://auth.atlassian.com' && url.pathname === '/oauth/token' && method === 'POST') {
      if (new Headers(init?.headers).get('Content-Type') !== 'application/json')
        return json({ error: 'invalid_request' }, 400);
      const form = JSON.parse(String(init?.body)) as Record<string, string>;
      if (form.client_id !== JIRA_CLIENT.clientId || form.client_secret !== JIRA_CLIENT.clientSecret) {
        return json({ error: 'access_denied', error_description: 'Unauthorized' }, 401);
      }
      if (form.grant_type === 'authorization_code' && state.codes.delete(form.code ?? '')) return json(mint());
      if (form.grant_type === 'refresh_token' && state.refreshable.delete(form.refresh_token ?? ''))
        return json(mint());

      return json({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }, 403);
    }
    if (url.origin !== 'https://api.atlassian.com') throw new TypeError(`fetch failed: ${url.origin} is not Atlassian`);
    const token = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
    if (!state.valid.has(token)) return json({ code: 401, message: 'Unauthorized' }, 401);
    if (url.pathname === '/oauth/token/accessible-resources') return json(state.resources);
    if (state.next !== undefined) {
      const { status, body } = state.next;
      state.next = undefined;

      return json(body ?? { errorMessages: ['planted'] }, status);
    }

    return rest(url, init, method);
  };

  return { state, http };
}

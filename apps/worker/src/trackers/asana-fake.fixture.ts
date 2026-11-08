import type { Http } from './plugin.ts';

/**
 * Asana, as far as the connector uses it (FRU-626), on no port: an `Http` that a test hands the worker
 * (`trackerHttp`) or the store.
 *
 * Each answer has the shape of Asana's OpenAPI (`asana_oas.yaml`, read on 2026-11-08) and of its page on
 * OAuth: every answer wrapped in `data`, a page of a list with `next_page.offset`; `POST /-/oauth_token`
 * form-encoded, with PKCE, answered `{ access_token, refresh_token, expires_in: 3600 }`, and a refresh
 * that gives no new refresh token; `POST /-/oauth_revoke` with the refresh token; a task with
 * `completed`, `memberships.section` and `permalink_url`; the stories of a task oldest first, comments
 * and changes; the typeahead of a workspace; and `POST /attachments` with the fields `parent` and `file`.
 *
 * It refuses what Asana refuses: a token it does not know (`401`), a project the token cannot see
 * (`404`), a tag of another workspace on a task.
 */

export const ASANA_CLIENT = { clientId: 'asana-client', clientSecret: 'the-asana-client-secret' };
export const PERSONAL = '2/1200000000000001/1210000000000002:0123456789abcdef0123456789abcdef';
export const WORKSPACE = '1100000000000001';

type Task = {
  gid: string;
  name: string;
  notes: string;
  project: string;
  tags: string[];
  completed: boolean;
  section: { gid: string; name: string };
  stories: { gid: string; type: string; text: string; created_at: string; created_by: { name: string } }[];
  attachments: { name: string; type: string; size: number }[];
  modified: string;
};

export function fakeAsana() {
  const state = {
    valid: new Set<string>([PERSONAL]),
    /** The codes of a consent, each with the PKCE challenge it was asked with. */
    codes: new Map<string, string>(),
    refreshable: new Set<string>(),
    revoked: [] as string[],
    generation: 0,
    workspaces: [{ gid: WORKSPACE, name: 'Acme' }],
    projects: [
      { gid: '1200000000000010', name: 'Website', workspace: WORKSPACE },
      { gid: '1200000000000011', name: 'Mobile app', workspace: WORKSPACE },
    ],
    hidden: new Set<string>(),
    sections: [
      { gid: '1300000000000001', name: 'To do' },
      { gid: '1300000000000002', name: 'Doing' },
    ],
    tags: [] as { gid: string; name: string; workspace: string }[],
    tasks: [] as Task[],
    attachmentsOff: false,
    next: undefined as { status: number; body?: unknown } | undefined,
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const error = (status: number, message: string) => json({ errors: [{ message }] }, status);
  const projectOf = (gid: string) => state.projects.find((each) => each.gid === gid && !state.hidden.has(gid));
  const view = (task: Task) => ({
    gid: task.gid,
    resource_type: 'task',
    name: task.name,
    notes: task.notes,
    completed: task.completed,
    modified_at: task.modified,
    permalink_url: `https://app.asana.com/0/${task.project}/${task.gid}`,
    memberships: [{ project: { gid: task.project, resource_type: 'project' }, section: task.section }],
  });
  const page = <T>(items: readonly T[], url: URL) => {
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const from = Number(url.searchParams.get('offset') ?? '0');
    const slice = items.slice(from, from + limit);
    const more = from + limit < items.length;

    return {
      data: slice,
      next_page: more ? { offset: String(from + limit), path: url.pathname, uri: url.href } : null,
    };
  };

  const http: Http = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    if (url.origin !== 'https://app.asana.com') throw new TypeError(`fetch failed: ${url.origin} is not Asana`);
    if (url.pathname === '/-/oauth_token' && method === 'POST') {
      if (new Headers(init?.headers).get('Content-Type') !== 'application/x-www-form-urlencoded') {
        return json({ error: 'invalid_request' }, 400);
      }
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      if (form.client_id !== ASANA_CLIENT.clientId || form.client_secret !== ASANA_CLIENT.clientSecret) {
        return json({ error: 'invalid_client' }, 401);
      }
      state.generation += 1;
      const access = `asana-access-${state.generation}`;
      if (form.grant_type === 'authorization_code') {
        const challenge = state.codes.get(form.code ?? '');
        const { createHash } = await import('node:crypto');
        const proves =
          challenge !== undefined &&
          createHash('sha256')
            .update(form.code_verifier ?? '')
            .digest('base64url') === challenge;
        if (!proves) return json({ error: 'invalid_grant' }, 400);
        state.codes.delete(form.code ?? '');
        const refresh = `asana-refresh-${state.generation}`;
        state.refreshable.add(refresh);
        state.valid.add(access);

        return json({
          access_token: access,
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: refresh,
          data: { name: 'Mia' },
        });
      }
      if (form.grant_type === 'refresh_token' && state.refreshable.has(form.refresh_token ?? '')) {
        state.valid.add(access);

        // A refresh gives an access token, and no new refresh token.
        return json({ access_token: access, token_type: 'bearer', expires_in: 3600 });
      }

      return json({ error: 'invalid_grant' }, 400);
    }
    if (url.pathname === '/-/oauth_revoke' && method === 'POST') {
      const token = new URLSearchParams(String(init?.body)).get('token') ?? '';
      state.revoked.push(token);
      state.refreshable.delete(token);

      return new Response(null, { status: 200 });
    }
    const path = url.pathname.replace(/^\/api\/1\.0/, '');
    const token = (new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
    if (!state.valid.has(token)) return error(401, 'Not Authorized');
    if (state.next !== undefined) {
      const { status, body } = state.next;
      state.next = undefined;

      return json(body ?? { errors: [{ message: 'planted' }] }, status);
    }

    if (method === 'GET' && path === '/users/me') {
      return json({ data: { gid: '1', name: 'Mia Krystof', workspaces: state.workspaces } });
    }
    if (method === 'GET' && path === '/projects') {
      const workspace = url.searchParams.get('workspace');
      if (workspace === null) return error(400, 'workspace: Missing input');

      return json(
        page(
          state.projects
            .filter((each) => each.workspace === workspace && !state.hidden.has(each.gid))
            .map(({ gid, name }) => ({ gid, name, resource_type: 'project' })),
          url,
        ),
      );
    }
    const project = /^\/projects\/([0-9]+)$/.exec(path);
    if (method === 'GET' && project !== null) {
      const found = projectOf(project[1] as string);
      if (found === undefined) return error(404, 'project: Unknown object');
      const workspace = state.workspaces.find((each) => each.gid === found.workspace);

      return json({
        data: { gid: found.gid, name: found.name, workspace: { gid: found.workspace, name: workspace?.name } },
      });
    }
    const sections = /^\/projects\/([0-9]+)\/sections$/.exec(path);
    if (method === 'GET' && sections !== null) {
      if (projectOf(sections[1] as string) === undefined) return error(404, 'project: Unknown object');

      return json({ data: state.sections });
    }
    const typeahead = /^\/workspaces\/([0-9]+)\/typeahead$/.exec(path);
    if (method === 'GET' && typeahead !== null) {
      if (url.searchParams.get('resource_type') !== 'tag') return error(400, 'resource_type: Missing input');
      const query = (url.searchParams.get('query') ?? '').toLowerCase();

      // A typeahead is fuzzy: a tag whose name only begins like the query comes back too.
      return json({
        data: state.tags
          .filter((each) => each.workspace === typeahead[1] && each.name.toLowerCase().startsWith(query.slice(0, 15)))
          .map(({ gid, name }) => ({ gid, name, resource_type: 'tag' })),
      });
    }
    if (method === 'POST' && path === '/tags') {
      const { data } = JSON.parse(String(init?.body)) as { data: { name: string; workspace: string } };
      const tag = { gid: String(1400000000000000 + state.tags.length + 1), name: data.name, workspace: data.workspace };
      state.tags.push(tag);

      return json({ data: { gid: tag.gid, name: tag.name, resource_type: 'tag' } }, 201);
    }
    if (method === 'POST' && path === '/tasks') {
      const { data } = JSON.parse(String(init?.body)) as {
        data: { name: string; notes: string; projects: string[]; tags: string[] };
      };
      const found = projectOf(data.projects[0] ?? '');
      if (found === undefined) return error(404, 'projects: Unknown object');
      if (data.tags.some((gid) => state.tags.find((each) => each.gid === gid)?.workspace !== found.workspace)) {
        return error(400, 'tags: Tag is not in the same workspace');
      }
      const task: Task = {
        gid: String(1500000000000000 + state.tasks.length + 1),
        name: data.name,
        notes: data.notes,
        project: found.gid,
        tags: data.tags,
        completed: false,
        section: state.sections[0] as Task['section'],
        stories: [],
        attachments: [],
        modified: '2026-11-08T10:00:00.000Z',
      };
      state.tasks.push(task);

      return json(
        { data: { gid: task.gid, permalink_url: `https://app.asana.com/0/${task.project}/${task.gid}` } },
        201,
      );
    }
    const tagged = /^\/tags\/([0-9]+)\/tasks$/.exec(path);
    if (method === 'GET' && tagged !== null) {
      return json(page(state.tasks.filter((each) => each.tags.includes(tagged[1] as string)).map(view), url));
    }
    const stories = /^\/tasks\/([0-9]+)\/stories$/.exec(path);
    if (method === 'GET' && stories !== null) {
      const task = state.tasks.find((each) => each.gid === stories[1]);

      return json(page(task?.stories ?? [], url));
    }
    if (method === 'POST' && path === '/attachments') {
      if (state.attachmentsOff) return error(403, 'Forbidden');
      const form = init?.body;
      if (!(form instanceof FormData)) return error(400, 'file: Missing input');
      const task = state.tasks.find((each) => each.gid === form.get('parent'));
      const file = form.get('file');
      if (task === undefined || !(file instanceof File)) return error(400, 'parent: Missing input');
      task.attachments.push({ name: file.name, type: file.type, size: file.size });

      return json({ data: { gid: `16${task.attachments.length}`, name: file.name, resource_type: 'attachment' } }, 200);
    }

    return error(404, `No route for ${method} ${path}`);
  };

  return { state, http };
}

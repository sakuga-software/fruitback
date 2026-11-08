import type { Http } from './plugin.ts';

/**
 * ClickUp, as far as the connector uses it (FRU-625), on no port: an `Http` that a test hands the
 * worker (`trackerHttp`) or the store.
 *
 * Each answer has the shape of ClickUp's OpenAPI v2 reference (`clickup-api-v2-reference.json`, read
 * on 2026-11-08) and of its page on authentication: `POST /api/v2/oauth/token` with `client_id`,
 * `client_secret` and `code`, answered `{ access_token }`; a personal token sent as it is, and a
 * token of OAuth with `Bearer`; `GetTasksresponse` (`tasks`, `last_page`), the `status` of a task with
 * its `type`, `GetListresponse` with its `statuses`, `GetFoldersresponse` with the lists of each
 * folder, the comments newest first with a `date` in milliseconds, and `POST /task/{id}/attachment`
 * with a multipart field `attachment`.
 *
 * It refuses what ClickUp refuses: a call with no token it knows (`401`, `OAUTH_017`), a list of a
 * space it does not reach (`404`), a tag filter on a tag that the space does not have.
 */

export const CLICKUP_CLIENT = { clientId: 'clickup-client', clientSecret: 'the-clickup-client-secret' };
export const PERSONAL = 'pk_123456_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

type Task = {
  id: string;
  list: string;
  name: string;
  markdown: string;
  tags: string[];
  status: { status: string; type: string };
  comments: { id: string; comment_text: string; date: string; user: { username: string } }[];
  attachments: { title: string; mimetype: string; size: number }[];
  updated: string;
};

export function fakeClickup() {
  const state = {
    /** The tokens ClickUp takes: a personal one as it is, and tokens of OAuth with `Bearer`. */
    valid: new Set<string>([PERSONAL]),
    codes: new Set<string>(),
    generation: 0,
    teams: [{ id: '9001', name: 'Acme', color: '#000000', avatar: null, members: [] }],
    spaces: [
      { id: '790', name: 'Product', team: '9001' },
      { id: '791', name: 'Marketing', team: '9001' },
    ],
    folders: [{ id: '457', name: 'Web', space: '790', hidden: false }],
    lists: [
      { id: '124', name: 'Bugs', space: '790', folder: '457' },
      { id: '125', name: 'Inbox', space: '790', folder: undefined as string | undefined },
      { id: '126', name: 'Site', space: '791', folder: undefined as string | undefined },
    ],
    /** The lists the token does not reach: ClickUp answers 404 for them. */
    hidden: new Set<string>(),
    statuses: [
      { status: 'to do', orderindex: 0, color: '#d3d3d3', type: 'open' },
      { status: 'in progress', orderindex: 1, color: '#4194f6', type: 'custom' },
      { status: 'complete', orderindex: 2, color: '#6bc950', type: 'closed' },
    ],
    /** The tags of each space, by name, in lower case as ClickUp keeps them. */
    tags: new Map<string, Set<string>>(),
    tasks: [] as Task[],
    /** Each filter of a read of tasks: its tags. */
    reads: [] as string[][],
    attachmentsOff: false,
    /** The tags that ClickUp refuses to make, with a 400 that is not « it exists ». */
    refusedTags: new Set<string>(),
    /** The lists whose answer says no space. */
    spaceless: new Set<string>(),
    next: undefined as { status: number; body?: unknown } | undefined,
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const refused = () => json({ err: 'Token invalid', ECODE: 'OAUTH_017' }, 401);
  const listOf = (id: string) => state.lists.find((each) => each.id === id && !state.hidden.has(id));
  const spaceName = (id: string) => state.spaces.find((each) => each.id === id)?.name ?? '';
  const view = (task: Task) => ({
    id: task.id,
    custom_id: null,
    name: task.name,
    text_content: task.markdown,
    description: task.markdown,
    markdown_description: task.markdown,
    status: { id: `p_${task.status.status}`, ...task.status, color: '#d3d3d3', orderindex: 0 },
    date_created: '1762596000000',
    date_updated: task.updated,
    tags: task.tags.map((name) => ({ name, tag_fg: '#000000', tag_bg: '#000000', creator: 183 })),
    url: `https://app.clickup.com/t/${task.id}`,
    list: { id: task.list },
  });

  const http: Http = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    if (url.origin !== 'https://api.clickup.com') throw new TypeError(`fetch failed: ${url.origin} is not ClickUp`);
    const path = url.pathname.replace(/^\/api/, '');
    if (path === '/v2/oauth/token' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (body.client_id !== CLICKUP_CLIENT.clientId || body.client_secret !== CLICKUP_CLIENT.clientSecret) {
        return json({ err: 'Client not found', ECODE: 'OAUTH_010' }, 400);
      }
      if (!state.codes.delete(body.code ?? '')) return json({ err: 'Code not found', ECODE: 'OAUTH_014' }, 400);
      state.generation += 1;
      const token = `${state.generation}_clickup_oauth_token`;
      state.valid.add(`Bearer ${token}`);

      return json({ access_token: token });
    }
    const authorization = new Headers(init?.headers).get('Authorization') ?? '';
    // A personal token goes as it is; a token of OAuth goes with `Bearer`.
    if (!state.valid.has(authorization)) return refused();
    if (state.next !== undefined) {
      const { status, body } = state.next;
      state.next = undefined;

      return json(body ?? { err: 'planted' }, status);
    }

    if (method === 'GET' && path === '/v2/user') {
      return json({ user: { id: 183, username: 'Mia Krystof', email: 'mia@acme.test', color: '#827718' } });
    }
    if (method === 'GET' && path === '/v2/team') return json({ teams: state.teams });
    const spaces = /^\/v2\/team\/([0-9]+)\/space$/.exec(path);
    if (method === 'GET' && spaces !== null) {
      return json({
        spaces: state.spaces
          .filter((each) => each.team === spaces[1])
          .map(({ id, name }) => ({ id, name, private: false, archived: false })),
      });
    }
    const folders = /^\/v2\/space\/([0-9]+)\/folder$/.exec(path);
    if (method === 'GET' && folders !== null) {
      return json({
        folders: state.folders
          .filter((each) => each.space === folders[1])
          .map((folder) => ({
            id: folder.id,
            name: folder.name,
            hidden: folder.hidden,
            space: { id: folder.space, name: spaceName(folder.space), access: true },
            lists: state.lists
              .filter((list) => list.folder === folder.id && !state.hidden.has(list.id))
              .map(({ id, name }) => ({ id, name })),
          })),
      });
    }
    const loose = /^\/v2\/space\/([0-9]+)\/list$/.exec(path);
    if (method === 'GET' && loose !== null) {
      return json({
        lists: state.lists
          .filter((list) => list.space === loose[1] && list.folder === undefined && !state.hidden.has(list.id))
          .map(({ id, name }) => ({ id, name })),
      });
    }
    const tag = /^\/v2\/space\/([0-9]+)\/tag$/.exec(path);
    if (method === 'POST' && tag !== null) {
      const name = (JSON.parse(String(init?.body)) as { tag: { name: string } }).tag.name.toLowerCase();
      if (state.refusedTags.has(name)) return json({ err: 'Tag name invalid', ECODE: 'TAGS_002' }, 400);
      const kept = state.tags.get(tag[1] as string) ?? new Set<string>();
      if (kept.has(name)) return json({ err: 'Tag already exists', ECODE: 'TAGS_001' }, 400);
      kept.add(name);
      state.tags.set(tag[1] as string, kept);

      return json({});
    }
    if (method === 'GET' && tag !== null) {
      return json({
        tags: [...(state.tags.get(tag[1] as string) ?? [])].map((name) => ({
          name,
          tag_fg: '#000000',
          tag_bg: '#000000',
        })),
      });
    }
    const list = /^\/v2\/list\/([0-9]+)$/.exec(path);
    if (method === 'GET' && list !== null) {
      const found = listOf(list[1] as string);
      if (found === undefined) return json({ err: 'List not found', ECODE: 'SUBCAT_016' }, 404);
      const folder = state.folders.find((each) => each.id === found.folder);

      return json({
        id: found.id,
        name: found.name,
        folder:
          folder === undefined
            ? { id: '0', name: 'hidden', hidden: true, access: true }
            : { id: folder.id, name: folder.name, hidden: false, access: true },
        ...(state.spaceless.has(found.id)
          ? {}
          : { space: { id: found.space, name: spaceName(found.space), access: true } }),
        statuses: state.statuses,
        permission_level: 'create',
      });
    }
    const tasks = /^\/v2\/list\/([0-9]+)\/task$/.exec(path);
    if (tasks !== null) {
      const found = listOf(tasks[1] as string);
      if (found === undefined) return json({ err: 'List not found', ECODE: 'SUBCAT_016' }, 404);
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string; markdown_content: string; tags: string[] };
        const n = state.tasks.length + 1;
        // ClickUp keeps the tags of a task that its space has, in lower case.
        const known = state.tags.get(found.space) ?? new Set<string>();
        const task: Task = {
          id: `86abc${n}`,
          list: found.id,
          name: body.name,
          markdown: body.markdown_content,
          tags: body.tags.map((each) => each.toLowerCase()).filter((each) => known.has(each)),
          status: { status: 'to do', type: 'open' },
          comments: [],
          attachments: [],
          updated: '1762596000000',
        };
        state.tasks.push(task);

        return json(view(task));
      }
      const wanted = url.searchParams.getAll('tags[]');
      state.reads.push(wanted);
      const page = Number(url.searchParams.get('page') ?? '0');
      const all = state.tasks
        .filter((each) => each.list === found.id && wanted.every((name) => each.tags.includes(name)))
        .filter((each) => url.searchParams.get('include_closed') === 'true' || each.status.type !== 'closed')
        .reverse();
      const slice = all.slice(page * 100, page * 100 + 100);

      return json({ tasks: slice.map(view), last_page: page * 100 + 100 >= all.length });
    }
    const attach = /^\/v2\/task\/([0-9a-z]+)\/attachment$/.exec(path);
    if (method === 'POST' && attach !== null) {
      const task = state.tasks.find((each) => each.id === attach[1]);
      if (task === undefined) return json({ err: 'Task not found', ECODE: 'ITEM_013' }, 404);
      if (state.attachmentsOff) return json({ err: 'No permission', ECODE: 'ACCESS_083' }, 403);
      if (!(init?.body instanceof FormData)) return json({ err: 'No attachment supplied', ECODE: 'UPLOAD_002' }, 400);
      const file = init.body.get('attachment');
      if (!(file instanceof File)) return json({ err: 'No attachment supplied', ECODE: 'UPLOAD_002' }, 400);
      task.attachments.push({ title: file.name, mimetype: file.type, size: file.size });

      return json({
        id: `att_${task.attachments.length}`,
        title: file.name,
        url: `https://t.clickup.com/${file.name}`,
      });
    }
    const comments = /^\/v2\/task\/([0-9a-z]+)\/comment$/.exec(path);
    if (method === 'GET' && comments !== null) {
      const task = state.tasks.find((each) => each.id === comments[1]);

      return json({ comments: [...(task?.comments ?? [])].reverse() });
    }

    return json({ err: `No route for ${method} ${path}`, ECODE: 'APP_001' }, 404);
  };

  return { state, http };
}

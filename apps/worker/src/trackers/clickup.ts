import { createHash } from 'node:crypto';
import {
  FRUITBACK_LABEL,
  type Note,
  type NoteComment,
  type NoteIssue,
  type NoteStage,
  buildIssueDescription,
  buildIssueTitle,
  noteIssueSchema,
  parseNoteFromDescription,
} from '@fruitback/shared';
import { z } from 'zod';
import type { ClientConfig } from '../clients.ts';
import type { StageExceptions } from '../linear.ts';
import { type FilesAnswer, type NoteStore, StoreError, type TrackerState } from '../store.ts';
import {
  type Http,
  type TrackerAccess,
  TrackerInputRefused,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  type TrackerPlugin,
} from './plugin.ts';

/**
 * ClickUp, a connector of a plugin (FRU-625).
 *
 * **It connects by OAuth where the operator made a ClickUp app, else by a personal token.** ClickUp's
 * page on authentication says: « For apps or integrations that other people use, use the OAuth flow »,
 * and « Use a personal API token for individual or testing purposes ». So the card offers the consent
 * where `FRUITBACK_CLICKUP_OAUTH` is set, and a personal token for a team that runs its own server
 * with no app. Neither expires: ClickUp says that its access token « currently does not expire », and
 * that a personal token never does. Both are sealed like every key.
 *
 * A place is a list of ClickUp. A note is a task of the list, with the tags `fruitback` and the tag
 * of its page, which a read filters on; the note is in a code block of its Markdown description.
 */

const API = 'https://api.clickup.com/api';
const CONSENT = 'https://app.clickup.com/api';
const CALL_TIMEOUT_MS = 10_000;

/** A token of OAuth of ClickUp does not expire: the worker never refreshes it. */
const NEVER = Number.MAX_SAFE_INTEGER;

/** A list id of ClickUp: a number, written as a string. */
const LIST = /^[0-9]{1,20}$/;

/** The tasks of one answer of `GET /list/{id}/task`, and the pages a read asks for at most. */
const TASKS_PER_PAGE = 100;
const TASK_PAGES = 10;
/** The replies of a note that a read shows, the newest. */
const COMMENTS_PER_TASK = 50;
/** The tasks whose replies are read at once. */
const COMMENT_READS_AT_ONCE = 4;
/** The spaces a page of places walks, each with its folders and its lists. */
const SPACES_PER_PAGE = 5;

/** The tag of a page: ClickUp keeps a tag in lower case, and a read filters on it. */
export function pageTag(url: string): string {
  return `${FRUITBACK_LABEL}-page-${createHash('sha256').update(url).digest('hex').slice(0, 20)}`;
}

/** What the type of a status of ClickUp says, as the stage of a pin. */
export function clickupStage(type: string | undefined): NoteStage {
  if (type === 'custom') return 'progress';
  if (type === 'done' || type === 'closed') return 'done';

  return 'new';
}

export const CLICKUP_STAGES: readonly NoteStage[] = ['new', 'progress', 'done'];

/** The key of a status: its name, which ClickUp compares without case, in lower case. */
const statusKey = (name: string): string => name.trim().toLowerCase();

function authorizationOf(credential: Awaited<ReturnType<TrackerAccess['credential']>>): string {
  // A personal token goes as it is; a token of OAuth with `Bearer`, as ClickUp's page shows each.
  return credential.via === 'token' ? credential.token : `Bearer ${credential.accessToken}`;
}

/**
 * A call to ClickUp. `401` is a token that ClickUp refuses. `403` is a refusal of rights, and so is a
 * `404` on a list (`list: true`), which ClickUp answers for a list the token cannot reach. Anything
 * else is a ClickUp that is down.
 */
async function call(
  http: Http,
  authorization: string,
  path: string,
  init: RequestInit = {},
  { list = false }: { list?: boolean } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await http(`${API}${path}`, {
      ...init,
      headers: { Accept: 'application/json', Authorization: authorization, ...init.headers },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new StoreError('ClickUp could not be reached');
  }
  if (response.status === 401) throw new TrackerKeyRefused('ClickUp refuses the token of this connector');
  if (response.status === 403 || (list && response.status === 404)) {
    throw new TrackerKeyForbidden(`ClickUp responded ${response.status} for this list`);
  }
  if (!response.ok) throw new StoreError(`ClickUp responded ${response.status}`);

  return response.json().catch(() => {
    throw new StoreError('ClickUp answered no JSON');
  });
}

async function clickup(access: TrackerAccess, path: string, init: RequestInit = {}, options = {}): Promise<unknown> {
  return call(access.http, authorizationOf(await access.credential()), path, init, options);
}

const teamsSchema = z.object({ teams: z.array(z.object({ id: z.string(), name: z.string() })) });
const userSchema = z.object({ user: z.object({ username: z.string().nullable().optional() }) });
const listSchema = z.object({
  id: z.string(),
  name: z.string(),
  folder: z.object({ id: z.string(), name: z.string(), hidden: z.boolean().optional() }).optional(),
  space: z.object({ id: z.string(), name: z.string() }).optional(),
  statuses: z
    .array(z.object({ status: z.string(), type: z.string().optional(), color: z.string().optional() }))
    .optional(),
});

const taskSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  url: z.string().optional(),
  markdown_description: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  date_updated: z.string().nullable().optional(),
  status: z.object({ status: z.string(), type: z.string().optional() }).optional(),
  tags: z.array(z.object({ name: z.string() })).optional(),
});

/** The teams of ClickUp (« Workspaces ») that the token reaches, for its label. */
async function teamsOf(http: Http, authorization: string): Promise<{ id: string; name: string }[]> {
  const parsed = teamsSchema.safeParse(await call(http, authorization, '/v2/team'));
  if (!parsed.success) throw new StoreError('ClickUp returned no Workspaces');

  return parsed.data.teams;
}

function labelOf(teams: readonly { name: string }[]): string {
  const [first] = teams;
  if (first === undefined) return 'ClickUp';

  return teams.length === 1 ? `ClickUp · ${first.name}` : `ClickUp · ${first.name} +${teams.length - 1}`;
}

/**
 * The tags of a note, made in the space of its list first: a read filters on them, so a task without
 * them would be lost to its page. A tag that exists already is no failure.
 */
async function ensureTags(access: TrackerAccess, space: string, tags: readonly string[]): Promise<void> {
  for (const name of tags) {
    try {
      await clickup(access, `/v2/space/${space}/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: { name } }),
      });
    } catch (error) {
      // ClickUp answers `400` for a tag of the space that exists. Any refusal of rights stops the note.
      if (error instanceof TrackerKeyRefused || error instanceof TrackerKeyForbidden) throw error;
      if (!(error instanceof StoreError) || !/responded 400/.test(error.message)) throw error;
    }
  }
}

async function listOf(access: TrackerAccess, list: string | undefined): Promise<z.infer<typeof listSchema>> {
  if (list === undefined || !LIST.test(list)) throw new StoreError('This destination names no ClickUp list');
  const parsed = listSchema.safeParse(await clickup(access, `/v2/list/${list}`, {}, { list: true }));
  if (!parsed.success) throw new StoreError('ClickUp returned no list');

  return parsed.data;
}

async function sendFiles(
  access: TrackerAccess,
  task: string,
  files: readonly { id: string; name: string; type: string; content: Uint8Array }[],
): Promise<FilesAnswer> {
  const sent: string[] = [];
  const lost: string[] = [];
  for (const file of files) {
    const form = new FormData();
    form.append('attachment', new Blob([new Uint8Array(file.content)], { type: file.type }), file.name);
    try {
      await clickup(access, `/v2/task/${task}/attachment`, { method: 'POST', body: form });
      sent.push(file.id);
    } catch (error) {
      console.error(
        `[fruitback] a file of a note did not reach ClickUp: ${error instanceof Error ? error.message : String(error)}`,
      );
      lost.push(file.id);
    }
  }

  return { sent, lost, waiting: [] };
}

const commentsSchema = z.object({
  comments: z.array(
    z.object({
      id: z.string(),
      comment_text: z.string().optional(),
      date: z.string().optional(),
      user: z.object({ username: z.string().nullable().optional() }).optional(),
    }),
  ),
});

async function commentsOf(access: TrackerAccess, task: string): Promise<NoteComment[]> {
  const parsed = commentsSchema.safeParse(await clickup(access, `/v2/task/${task}/comment`));
  if (!parsed.success) return [];

  // ClickUp lists the newest first; a thread reads oldest first.
  return parsed.data.comments
    .slice(0, COMMENTS_PER_TASK)
    .reverse()
    .map((comment) => ({
      id: comment.id,
      body: comment.comment_text ?? '',
      createdAt: comment.date === undefined ? '' : new Date(Number(comment.date)).toISOString(),
      ...(comment.user?.username ? { author: comment.user.username } : {}),
    }));
}

function createClickupStore(
  access: TrackerAccess,
  { connector, stages = {} }: { connector: string; stages?: StageExceptions },
): NoteStore {
  return {
    name: 'clickup',
    stages: CLICKUP_STAGES,
    attachments: true,
    scope: (client) => `${connector}:${client?.teamId ?? ''}`,

    async create(note: Note, client: ClientConfig | undefined, policy, files = []) {
      const list = await listOf(access, client?.teamId);
      const tags = [FRUITBACK_LABEL, pageTag(note.page.url)];
      if (list.space !== undefined) await ensureTags(access, list.space.id, tags);
      const created = z.object({ id: z.string(), url: z.string().optional() }).safeParse(
        await clickup(
          access,
          `/v2/list/${list.id}/task`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: buildIssueTitle(note, { maxLength: 250 }),
              markdown_content: buildIssueDescription(note, {
                ...(policy.locale === undefined ? {} : { locale: policy.locale }),
              }),
              tags,
            }),
          },
          { list: true },
        ),
      );
      if (!created.success) throw new StoreError('ClickUp returned no task');
      const issue = {
        id: created.data.id,
        identifier: `#${created.data.id}`,
        url: created.data.url ?? `https://app.clickup.com/t/${created.data.id}`,
      };
      if (files.length === 0) return issue;

      return { ...issue, files: await sendFiles(access, created.data.id, files) };
    },

    async findForPage(query, client, policy) {
      const list = client?.teamId;
      if (list === undefined || !LIST.test(list)) throw new StoreError('This destination names no ClickUp list');
      const tag = pageTag(query.url);
      const rows: unknown[] = [];
      for (let page = 0; page < TASK_PAGES; page += 1) {
        const params = new URLSearchParams({
          include_markdown_description: 'true',
          include_closed: 'true',
          subtasks: 'true',
          order_by: 'created',
          page: String(page),
        });
        params.append('tags[]', tag);
        const answer = z
          .object({ tasks: z.array(z.unknown()), last_page: z.boolean().optional() })
          .safeParse(await clickup(access, `/v2/list/${list}/task?${params}`, {}, { list: true }));
        if (!answer.success) throw new StoreError('ClickUp returned no tasks');
        rows.push(...answer.data.tasks);
        if (answer.data.last_page !== false || answer.data.tasks.length < TASKS_PER_PAGE) break;
      }

      const matched = rows.flatMap((each) => {
        const task = taskSchema.safeParse(each);
        if (!task.success) return [];
        // The tag selects the tasks, and the note confirms the page and the client.
        if (!(task.data.tags ?? []).some((each) => each.name.toLowerCase() === tag)) return [];
        const parsed = parseNoteFromDescription(task.data.markdown_description ?? task.data.description ?? '');
        if (!parsed.ok || parsed.note.page.url !== query.url) return [];
        if (query.clientId && parsed.note.client?.id !== query.clientId) return [];

        return [{ task: task.data, note: parsed.note }];
      });

      const read: NoteIssue[] = [];
      for (let at = 0; at < matched.length; at += COMMENT_READS_AT_ONCE) {
        const batch = await Promise.all(
          matched.slice(at, at + COMMENT_READS_AT_ONCE).map(async ({ task, note }) => {
            const status = task.status;
            const key = status === undefined ? undefined : statusKey(status.status);
            const stage =
              key !== undefined && Object.hasOwn(stages, key) ? (stages[key] as NoteStage) : clickupStage(status?.type);
            const comments = policy.showComments ? await commentsOf(access, task.id) : undefined;

            return noteIssueSchema.safeParse({
              id: task.id,
              identifier: `#${task.id}`,
              url: task.url ?? `https://app.clickup.com/t/${task.id}`,
              title: task.name ?? '',
              stage,
              stateName: status?.status ?? '',
              ...(key === undefined ? {} : { status: `${connector}:${key}` }),
              updatedAt:
                task.date_updated === undefined || task.date_updated === null
                  ? ''
                  : new Date(Number(task.date_updated)).toISOString(),
              ...(comments === undefined ? {} : { comments }),
              note,
            });
          }),
        );
        for (const each of batch) if (each.success) read.push(each.data);
      }

      return read;
    },

    // FRU-368: the statuses of the list, each with the stage of its type.
    async trackerStates(client): Promise<TrackerState[]> {
      const list = await listOf(access, client?.teamId);

      return (list.statuses ?? []).map((status) => ({
        id: statusKey(status.status),
        name: status.status,
        stage: clickupStage(status.type),
        ...(status.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(status.color) ? { color: status.color } : {}),
      }));
    },
  };
}

const spacesSchema = z.object({ spaces: z.array(z.object({ id: z.string(), name: z.string() })) });
const foldersSchema = z.object({
  folders: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      lists: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
    }),
  ),
});
const listsSchema = z.object({ lists: z.array(z.object({ id: z.string(), name: z.string() })) });

/** The spaces of every Workspace the token reaches, in order: the walk of the places goes through them. */
async function spacesOf(access: TrackerAccess): Promise<{ id: string; name: string }[]> {
  const authorization = authorizationOf(await access.credential());
  const spaces: { id: string; name: string }[] = [];
  for (const team of await teamsOf(access.http, authorization)) {
    const parsed = spacesSchema.safeParse(
      await call(access.http, authorization, `/v2/team/${team.id}/space?archived=false`),
    );
    if (!parsed.success) throw new StoreError('ClickUp returned no spaces');
    spaces.push(...parsed.data.spaces);
  }

  return spaces;
}

export const plugin: TrackerPlugin = {
  kind: 'clickup',
  name: 'ClickUp',
  envNames: { oauth: 'FRUITBACK_CLICKUP_OAUTH' },
  async connect(body, { http }) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    // A personal token of ClickUp starts with `pk_`.
    if (!/^pk_[A-Za-z0-9_]{8,200}$/.test(token)) throw new TrackerInputRefused('invalid-token');
    const user = userSchema.safeParse(await call(http, token, '/v2/user'));
    if (!user.success) throw new StoreError('ClickUp returned no user');

    return { label: labelOf(await teamsOf(http, token)), token };
  },
  oauth: {
    authorize: ({ clientId, redirectUri, state }) =>
      `${CONSENT}?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state })}`,
    async exchange({ code, client }, http) {
      let response: Response;
      try {
        response = await http(`${API}/v2/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, code }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
      } catch {
        return undefined;
      }
      if (!response.ok) return undefined;
      const parsed = z
        .object({ access_token: z.string().min(1) })
        .safeParse(await response.json().catch(() => undefined));

      // No refresh token, and no end: ClickUp says its token does not expire.
      return parsed.success ? { accessToken: parsed.data.access_token, refreshToken: '', expiresAt: NEVER } : undefined;
    },
    // A token that never ends is never refreshed. A worker that asks anyway has a token ClickUp ended.
    refresh: async () => 'ended',
    async identify(tokens, http) {
      const teams = await teamsOf(http, `Bearer ${tokens.accessToken}`).catch(() => undefined);
      if (teams === undefined || teams.length === 0) return undefined;

      return { label: labelOf(teams) };
    },
  },
  async places(access, { search, after }) {
    const spaces = await spacesOf(access);
    const from = after !== undefined && /^[0-9]{1,4}$/.test(after) ? Number(after) : 0;
    const wanted = search?.toLowerCase();
    const places: { id: string; name: string }[] = [];
    for (const space of spaces.slice(from, from + SPACES_PER_PAGE)) {
      const folders = foldersSchema.safeParse(await clickup(access, `/v2/space/${space.id}/folder?archived=false`));
      const loose = listsSchema.safeParse(await clickup(access, `/v2/space/${space.id}/list?archived=false`));
      if (!folders.success || !loose.success) throw new StoreError('ClickUp returned no lists');
      for (const list of loose.data.lists) places.push({ id: list.id, name: `${space.name} › ${list.name}` });
      for (const folder of folders.data.folders) {
        for (const list of folder.lists ?? []) {
          places.push({ id: list.id, name: `${space.name} › ${folder.name} › ${list.name}` });
        }
      }
    }
    const next = from + SPACES_PER_PAGE < spaces.length ? String(from + SPACES_PER_PAGE) : undefined;

    return {
      places: wanted === undefined ? places : places.filter((each) => each.name.toLowerCase().includes(wanted)),
      ...(next === undefined ? {} : { next }),
    };
  },
  readPlace: (value) => (typeof value === 'string' && LIST.test(value) ? value : undefined),
  async placeName(access, place) {
    try {
      const list = await listOf(access, place);
      const path = [list.space?.name, list.folder?.hidden === false ? list.folder.name : undefined, list.name];

      return { name: path.filter((each): each is string => each !== undefined).join(' › ') };
    } catch (error) {
      // A list that the token does not reach is no place of this connector.
      if (error instanceof TrackerKeyForbidden) return undefined;
      throw error;
    }
  },
  store: (access, options) => createClickupStore(access, options),
};

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
  type OAuthTokens,
  type TrackerAccess,
  TrackerInputRefused,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  type TrackerPlugin,
} from './plugin.ts';

/**
 * Asana, a connector of a plugin (FRU-626).
 *
 * **It connects by OAuth where the operator made an Asana app, else by a personal access token.**
 * Asana's page on OAuth calls it « the preferred method of authentication for developers, users, and
 * Asana as a platform », and the personal access token is for one's own scripts: so the card offers
 * the consent where `FRUITBACK_ASANA_OAUTH` is set, and a token for a team that runs its own server
 * with no app. A token of OAuth lasts an hour (`expires_in`) and is refreshed with its refresh token;
 * both are sealed like every key.
 *
 * A place is a project. A note is a task of the project, with a tag of its site and its page that a
 * read lists the tasks of; the note is in a code block of its notes, as on every tracker.
 */

const APP = 'https://app.asana.com';
const API = `${APP}/api/1.0`;
const CALL_TIMEOUT_MS = 10_000;

/** A gid of Asana: a number, written as a string. */
const GID = /^[0-9]{1,20}$/;

/** The tasks of one answer, and the pages a read asks for at most. */
const TASKS_PER_PAGE = 100;
const TASK_PAGES = 10;
const COMMENTS_PER_TASK = 50;
const COMMENT_READS_AT_ONCE = 4;
const PROJECTS_PER_PAGE = 100;

/** The key of the state of a task that is done, beside the sections of its project. */
export const COMPLETED = 'completed';

/**
 * The tag of the notes of one client on one page. Asana lists the tasks of a tag (`/tags/{gid}/tasks`)
 * on every plan, where its search is a paid one, so a read goes through this tag.
 */
export function pageTag(url: string, client: string | undefined): string {
  const named = JSON.stringify([client ?? '', url]);

  return `${FRUITBACK_LABEL}-page-${createHash('sha256').update(named).digest('hex').slice(0, 20)}`;
}

/** A date of Asana as ISO; an empty string for one that is not a date. */
function dateOf(value: string | null | undefined): string {
  const moment = value === undefined || value === null ? Number.NaN : Date.parse(value);

  return Number.isFinite(moment) ? new Date(moment).toISOString() : '';
}

function bearerOf(credential: Awaited<ReturnType<TrackerAccess['credential']>>): string {
  // A personal access token and a token of OAuth both go with `Bearer`.
  return `Bearer ${credential.via === 'token' ? credential.token : credential.accessToken}`;
}

/**
 * A call to Asana. `401` is a token that Asana refuses. `403` is a refusal of rights, and so is a
 * `404` on a project (`project: true`): Asana answers it for a project the token cannot see. `402`
 * is a feature of a paid plan, a refusal too. Anything else is an Asana that is down.
 */
async function call(
  http: Http,
  authorization: string,
  path: string,
  init: RequestInit = {},
  { project = false }: { project?: boolean } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await http(`${API}${path}`, {
      ...init,
      headers: { Accept: 'application/json', Authorization: authorization, ...init.headers },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new StoreError('Asana could not be reached');
  }
  if (response.status === 401) throw new TrackerKeyRefused('Asana refuses the token of this connector');
  if (response.status === 402 || response.status === 403 || (project && response.status === 404)) {
    throw new TrackerKeyForbidden(`Asana responded ${response.status} for this project`);
  }
  if (!response.ok) throw new StoreError(`Asana responded ${response.status}`);
  const body = (await response.json().catch(() => undefined)) as { data?: unknown } | undefined;
  if (body === undefined || !('data' in body)) throw new StoreError('Asana answered no data');

  return body;
}

async function asana(access: TrackerAccess, path: string, init: RequestInit = {}, options = {}): Promise<unknown> {
  return call(access.http, bearerOf(await access.credential()), path, init, options);
}

const meSchema = z.object({
  data: z.object({
    name: z.string().nullable().optional(),
    workspaces: z.array(z.object({ gid: z.string(), name: z.string() })),
  }),
});

function labelOf(workspaces: readonly { name: string }[]): string {
  const [first] = workspaces;
  if (first === undefined) return 'Asana';

  return workspaces.length === 1 ? `Asana · ${first.name}` : `Asana · ${first.name} +${workspaces.length - 1}`;
}

async function workspacesOf(http: Http, authorization: string): Promise<{ gid: string; name: string }[]> {
  const parsed = meSchema.safeParse(await call(http, authorization, '/users/me?opt_fields=name,workspaces.name'));
  if (!parsed.success) throw new StoreError('Asana returned no user');

  return parsed.data.data.workspaces;
}

const projectSchema = z.object({
  data: z.object({
    gid: z.string(),
    name: z.string(),
    workspace: z.object({ gid: z.string(), name: z.string().optional() }),
  }),
});

async function projectOf(
  access: TrackerAccess,
  project: string | undefined,
): Promise<z.infer<typeof projectSchema>['data']> {
  if (project === undefined || !GID.test(project)) throw new StoreError('This destination names no Asana project');
  const parsed = projectSchema.safeParse(
    await asana(access, `/projects/${project}?opt_fields=name,workspace.name`, {}, { project: true }),
  );
  if (!parsed.success) throw new StoreError('Asana returned no project');

  return parsed.data.data;
}

const listSchema = z.object({
  data: z.array(z.object({ gid: z.string(), name: z.string() })),
  next_page: z.object({ offset: z.string() }).nullable().optional(),
});

/** The tag of a name in a workspace, found by the typeahead of Asana, or `undefined`. */
async function findTag(access: TrackerAccess, workspace: string, name: string): Promise<string | undefined> {
  const params = new URLSearchParams({ resource_type: 'tag', query: name, count: '100' });
  const found = listSchema.safeParse(await asana(access, `/workspaces/${workspace}/typeahead?${params}`));
  if (!found.success) throw new StoreError('Asana returned no tags');

  return found.data.data.find((each) => each.name === name)?.gid;
}

/** The tag of a note: found, or made in the workspace of its project. */
async function tagOf(access: TrackerAccess, workspace: string, name: string): Promise<string> {
  const found = await findTag(access, workspace, name);
  if (found !== undefined) return found;
  const made = z.object({ data: z.object({ gid: z.string() }) }).safeParse(
    await asana(access, '/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { name, workspace } }),
    }),
  );
  if (!made.success) throw new StoreError('Asana made no tag');

  return made.data.data.gid;
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
    form.append('parent', task);
    form.append('resource_subtype', 'asana');
    form.append('file', new Blob([new Uint8Array(file.content)], { type: file.type }), file.name);
    try {
      await asana(access, '/attachments', { method: 'POST', body: form });
      sent.push(file.id);
    } catch (error) {
      console.error(
        `[fruitback] a file of a note did not reach Asana: ${error instanceof Error ? error.message : String(error)}`,
      );
      lost.push(file.id);
    }
  }

  return { sent, lost, waiting: [] };
}

const taskSchema = z.object({
  gid: z.string(),
  name: z.string().optional(),
  notes: z.string().nullable().optional(),
  completed: z.boolean().optional(),
  modified_at: z.string().nullable().optional(),
  permalink_url: z.string().optional(),
  memberships: z
    .array(
      z.object({
        project: z.object({ gid: z.string() }).optional(),
        section: z.object({ gid: z.string(), name: z.string() }).nullable().optional(),
      }),
    )
    .optional(),
});

const storiesSchema = z.object({
  data: z.array(
    z.object({
      gid: z.string(),
      type: z.string().optional(),
      text: z.string().optional(),
      created_at: z.string().optional(),
      created_by: z.object({ name: z.string().nullable().optional() }).nullable().optional(),
    }),
  ),
});

async function commentsOf(access: TrackerAccess, task: string): Promise<NoteComment[]> {
  const params = new URLSearchParams({ opt_fields: 'type,text,created_at,created_by.name', limit: '100' });
  const parsed = storiesSchema.safeParse(await asana(access, `/tasks/${task}/stories?${params}`));
  if (!parsed.success) return [];

  // The stories of a task are its comments and its changes, oldest first: the comments only.
  return parsed.data.data
    .filter((story) => story.type === 'comment')
    .slice(-COMMENTS_PER_TASK)
    .map((story) => ({
      id: story.gid,
      body: story.text ?? '',
      createdAt: dateOf(story.created_at),
      ...(story.created_by?.name ? { author: story.created_by.name } : {}),
    }));
}

/** The key of the state of a task in a project: done, or its section. */
function stateOf(task: z.infer<typeof taskSchema>, project: string): { key: string; name: string } | undefined {
  if (task.completed === true) return { key: COMPLETED, name: 'Completed' };
  const section = task.memberships?.find((each) => each.project?.gid === project)?.section;

  return section === undefined || section === null ? undefined : { key: section.gid, name: section.name };
}

function createAsanaStore(
  access: TrackerAccess,
  { connector, stages = {} }: { connector: string; stages?: StageExceptions },
): NoteStore {
  return {
    name: 'asana',
    stages: ['new', 'todo', 'progress', 'done', 'closed'],
    attachments: true,
    scope: (client) => `${connector}:${client?.teamId ?? ''}`,

    async create(note: Note, client: ClientConfig | undefined, policy, files = []) {
      const project = await projectOf(access, client?.teamId);
      const tag = await tagOf(access, project.workspace.gid, pageTag(note.page.url, note.client?.id));
      const created = z.object({ data: z.object({ gid: z.string(), permalink_url: z.string().optional() }) }).safeParse(
        await asana(
          access,
          '/tasks?opt_fields=permalink_url',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              data: {
                name: buildIssueTitle(note, { maxLength: 250 }),
                notes: buildIssueDescription(note, {
                  ...(policy.locale === undefined ? {} : { locale: policy.locale }),
                }),
                projects: [project.gid],
                tags: [tag],
              },
            }),
          },
          { project: true },
        ),
      );
      if (!created.success) throw new StoreError('Asana returned no task');
      const gid = created.data.data.gid;
      const issue = {
        id: gid,
        identifier: `#${gid}`,
        url: created.data.data.permalink_url ?? `${APP}/0/${project.gid}/${gid}`,
      };
      if (files.length === 0) return issue;

      return { ...issue, files: await sendFiles(access, gid, files) };
    },

    async findForPage(query, client, policy) {
      const project = await projectOf(access, client?.teamId);
      const tag = await findTag(access, project.workspace.gid, pageTag(query.url, query.clientId));
      // No tag yet: no note was ever written for this page.
      if (tag === undefined) return [];
      const rows: unknown[] = [];
      let offset: string | undefined;
      for (let page = 0; page < TASK_PAGES; page += 1) {
        const params = new URLSearchParams({
          limit: String(TASKS_PER_PAGE),
          opt_fields: 'name,notes,completed,modified_at,permalink_url,memberships.project,memberships.section.name',
          ...(offset === undefined ? {} : { offset }),
        });
        const answer = listSchema
          .extend({ data: z.array(z.unknown()) })
          .safeParse(await asana(access, `/tags/${tag}/tasks?${params}`));
        if (!answer.success) throw new StoreError('Asana returned no tasks');
        rows.push(...answer.data.data);
        offset = answer.data.next_page?.offset;
        if (offset === undefined || answer.data.data.length === 0) break;
      }

      const matched = rows.flatMap((each) => {
        const task = taskSchema.safeParse(each);
        if (!task.success) return [];
        // A tag of the workspace: the task must be one of the project of this place too.
        if (!(task.data.memberships ?? []).some((membership) => membership.project?.gid === project.gid)) return [];
        const parsed = parseNoteFromDescription(task.data.notes ?? '');
        if (!parsed.ok || parsed.note.page.url !== query.url) return [];
        if (query.clientId && parsed.note.client?.id !== query.clientId) return [];

        return [{ task: task.data, note: parsed.note }];
      });

      const read: NoteIssue[] = [];
      for (let at = 0; at < matched.length; at += COMMENT_READS_AT_ONCE) {
        const batch = await Promise.all(
          matched.slice(at, at + COMMENT_READS_AT_ONCE).map(async ({ task, note }) => {
            const state = stateOf(task, project.gid);
            const fallback: NoteStage = task.completed === true ? 'done' : 'new';
            const stage =
              state !== undefined && Object.hasOwn(stages, state.key) ? (stages[state.key] as NoteStage) : fallback;
            const comments = policy.showComments ? await commentsOf(access, task.gid) : undefined;

            return noteIssueSchema.safeParse({
              id: task.gid,
              identifier: `#${task.gid}`,
              url: task.permalink_url ?? `${APP}/0/${project.gid}/${task.gid}`,
              title: task.name ?? '',
              stage,
              stateName: state?.name ?? '',
              ...(state === undefined ? {} : { status: `${connector}:${state.key}` }),
              updatedAt: dateOf(task.modified_at),
              ...(comments === undefined ? {} : { comments }),
              note,
            });
          }),
        );
        for (const each of batch) if (each.success) read.push(each.data);
      }

      return read;
    },

    // FRU-368: the sections of the project, then « Completed ». A section is New until a site gives it
    // a stage: Asana says nothing of what a section means.
    async trackerStates(client): Promise<TrackerState[]> {
      const project = await projectOf(access, client?.teamId);
      const sections = listSchema.safeParse(
        await asana(access, `/projects/${project.gid}/sections?opt_fields=name`, {}, { project: true }),
      );
      if (!sections.success) throw new StoreError('Asana returned no sections');

      return [
        ...sections.data.data.map((section) => ({ id: section.gid, name: section.name, stage: 'new' as const })),
        { id: COMPLETED, name: 'Completed', stage: 'done' },
      ];
    },
  };
}

async function askTokens(http: Http, form: Record<string, string>, now: number): Promise<OAuthTokens | 'refused'> {
  let response: Response;
  try {
    response = await http(`${APP}/-/oauth_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new StoreError('Asana could not be reached');
  }
  if (response.status === 400 || response.status === 401) return 'refused';
  if (!response.ok) throw new StoreError(`Asana responded ${response.status} to a token`);
  const parsed = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1).optional(),
      expires_in: z.number().positive(),
    })
    .safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new StoreError('Asana gave no tokens');

  return {
    accessToken: parsed.data.access_token,
    // A refresh answers no new refresh token: the one of the consent stays.
    refreshToken: parsed.data.refresh_token ?? form.refresh_token ?? '',
    expiresAt: now + parsed.data.expires_in * 1_000,
  };
}

/** Tells Asana that the tokens of a consent are over. Best effort: the connector goes whatever Asana answers. */
async function revoke(
  credential: { refreshToken: string },
  client: { clientId: string; clientSecret: string },
  http: Http,
): Promise<void> {
  await http(`${APP}/-/oauth_revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    // Asana revokes by the refresh token, and its access tokens go with it.
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      token: credential.refreshToken,
    }).toString(),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  }).catch(() => undefined);
}

export const plugin: TrackerPlugin = {
  kind: 'asana',
  name: 'Asana',
  envNames: { oauth: 'FRUITBACK_ASANA_OAUTH' },
  async connect(body, { http }) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    // A personal access token of Asana: a version digit, a slash, then the token.
    if (!/^[0-9]\/[A-Za-z0-9:/_-]{16,300}$/.test(token)) throw new TrackerInputRefused('invalid-token');

    return { label: labelOf(await workspacesOf(http, `Bearer ${token}`)), token };
  },
  oauth: {
    authorize: ({ clientId, redirectUri, state, challenge }) =>
      `${APP}/-/oauth_authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })}`,
    async exchange({ code, verifier, redirectUri, client }, http, now) {
      const tokens = await askTokens(
        http,
        {
          grant_type: 'authorization_code',
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri,
          code,
          code_verifier: verifier,
        },
        now,
      );

      return tokens === 'refused' ? undefined : tokens;
    },
    async refresh(refreshToken, client, http, now) {
      const tokens = await askTokens(
        http,
        {
          grant_type: 'refresh_token',
          client_id: client.clientId,
          client_secret: client.clientSecret,
          refresh_token: refreshToken,
        },
        now,
      );

      return tokens === 'refused' ? 'ended' : tokens;
    },
    async identify(tokens, http) {
      const workspaces = await workspacesOf(http, `Bearer ${tokens.accessToken}`).catch(() => undefined);
      if (workspaces === undefined || workspaces.length === 0) return undefined;

      return { label: labelOf(workspaces) };
    },
    revoke: (credential, client, http) => revoke(credential, client, http),
  },
  async places(access, { search, after }) {
    const authorization = bearerOf(await access.credential());
    const workspaces = await workspacesOf(access.http, authorization);
    // `<index of the workspace>.<offset of Asana>`: the next page of one workspace, then the next one.
    const matched = after === undefined ? null : /^([0-9]{1,3})\.([A-Za-z0-9_-]{0,300})$/.exec(after);
    const index = matched === null ? 0 : Number(matched[1]);
    const workspace = workspaces[index];
    if (workspace === undefined) return { places: [] };
    const params = new URLSearchParams({
      workspace: workspace.gid,
      archived: 'false',
      limit: String(PROJECTS_PER_PAGE),
      opt_fields: 'name',
      ...(matched === null || matched[2] === '' ? {} : { offset: matched[2] as string }),
    });
    const answer = listSchema.safeParse(await call(access.http, authorization, `/projects?${params}`));
    if (!answer.success) throw new StoreError('Asana returned no projects');
    const wanted = search?.toLowerCase();
    const places = answer.data.data
      .map((project) => ({
        id: project.gid,
        name: workspaces.length === 1 ? project.name : `${workspace.name} › ${project.name}`,
      }))
      .filter((each) => wanted === undefined || each.name.toLowerCase().includes(wanted));
    const offset = answer.data.next_page?.offset;
    let next: string | undefined;
    if (offset !== undefined) next = `${index}.${offset}`;
    else if (index + 1 < workspaces.length) next = `${index + 1}.`;

    return { places, ...(next === undefined ? {} : { next }) };
  },
  readPlace: (value) => (typeof value === 'string' && GID.test(value) ? value : undefined),
  async placeName(access, place) {
    try {
      return { name: (await projectOf(access, place)).name };
    } catch (error) {
      // A project that the token cannot see is no place of this connector.
      if (error instanceof TrackerKeyForbidden) return undefined;
      throw error;
    }
  },
  store: (access, options) => createAsanaStore(access, options),
  async disconnect(access, client) {
    const credential = await access.credential();
    if (credential.via !== 'oauth' || client === undefined) return;
    await revoke(credential, client, access.http);
  },
};

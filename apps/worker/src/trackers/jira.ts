import { createHash } from 'node:crypto';
import {
  FRUITBACK_LABEL,
  type Note,
  type NoteComment,
  type NoteIssue,
  type NoteStage,
  buildIssueTitle,
  clientLabelName,
  noteIssueSchema,
} from '@fruitback/shared';
import { z } from 'zod';
import type { ClientConfig } from '../clients.ts';
import type { StageExceptions } from '../linear.ts';
import type { FilesAnswer } from '../store.ts';
import { type NoteStore, StoreError, type TrackerState } from '../store.ts';
import { adfText, buildAdfDescription, noteOfDescription } from './jira-adf.ts';
import {
  type Http,
  type OAuthTokens,
  type TrackerAccess,
  TrackerKeyForbidden,
  TrackerKeyRefused,
  type TrackerPlugin,
} from './plugin.ts';

/**
 * Jira Cloud, a connector of a plugin (FRU-622).
 *
 * **It connects by OAuth 2.0 (3LO), never by an API token.** Atlassian's page on basic auth says that
 * an app that collects API tokens does not comply with its security requirements. The operator of the
 * server makes one OAuth app in the developer console of Atlassian (`FRUITBACK_JIRA_OAUTH`), and each
 * workspace consents to it. The token reaches the sites the person chose at the consent, with the
 * rights of that person in Jira, and the worker calls `api.atlassian.com` only: no address that a
 * person types is ever called.
 *
 * A place is a project of a site: `<cloud id>/<project id>`. A note is an issue of the project, with
 * the labels `fruitback`, the label of its client, and a label of its page that a search finds
 * exactly. The note is in a code block of the description, as on every tracker.
 */

const AUTH = 'https://auth.atlassian.com';
const API = 'https://api.atlassian.com';
const CALL_TIMEOUT_MS = 10_000;

/** What the worker reads and writes: projects, issues and their comments, the user, and a refresh token. */
export const JIRA_SCOPES = ['read:jira-work', 'write:jira-work', 'read:jira-user', 'offline_access'] as const;

/** The sites a token reaches, as `accessible-resources` lists them, kept beside the tokens. */
type Site = { id: string; name: string; url: string };

const siteSchema = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/),
  name: z.string(),
  url: z.string().url(),
  scopes: z.array(z.string()).optional(),
});

const tokensSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/** `<cloud id>/<project id>`: a project of one site. */
const PLACE = /^([0-9a-f-]{36})\/([0-9]{1,18})$/;

/** The issues of one page are read in one search: a page has never had more notes than this. */
const ISSUES_PAGE_SIZE = 100;
/** The projects of a page of places, for each site. */
const PROJECTS_PAGE_SIZE = 50;
/** The replies of a note that a read shows, the newest. */
const COMMENTS_PER_ISSUE = 50;

/** A Jira label has no space, and Fruitback keeps it short and plain. Another one goes by its hash. */
function jiraLabel(name: string): string {
  return /^[A-Za-z0-9._:-]{1,100}$/.test(name)
    ? name
    : `${FRUITBACK_LABEL}:${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
}

/** The label of a page: a search by it finds the issues of that page and of no other. */
export function pageLabel(url: string): string {
  return `${FRUITBACK_LABEL}-page-${createHash('sha256').update(url).digest('hex').slice(0, 20)}`;
}

/** What the status category of Jira says, as the stage of a pin. A done issue with a resolution of refusal is closed. */
const REFUSED = /^(won'?t (do|fix)|declined|duplicate|cannot reproduce|rejected|abandoned)$/i;

export function jiraStage(category: string | undefined, resolution?: string | null): NoteStage {
  if (category === 'indeterminate') return 'progress';
  if (category === 'done')
    return resolution !== undefined && resolution !== null && REFUSED.test(resolution) ? 'closed' : 'done';

  return 'new';
}

export const JIRA_STAGES: readonly NoteStage[] = ['new', 'progress', 'done', 'closed'];

function sitesOf(extra: Readonly<Record<string, string>>): Site[] {
  try {
    const parsed = z.array(siteSchema).safeParse(JSON.parse(extra.sites ?? '[]'));

    return parsed.success ? parsed.data.map(({ id, name, url }) => ({ id, name, url })) : [];
  } catch {
    return [];
  }
}

/** A call to Jira with the token of the connector. A refusal is said as one, anything else is a Jira that is down. */
async function jira(access: TrackerAccess, path: string, init: RequestInit = {}): Promise<unknown> {
  const credential = await access.credential();
  if (credential.via !== 'oauth') throw new StoreError('This Jira connector holds no token of OAuth');
  let response: Response;
  try {
    response = await access.http(`${API}${path}`, {
      ...init,
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}`, ...init.headers },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new StoreError('Jira could not be reached');
  }
  if (response.status === 401) throw new TrackerKeyRefused('Jira refuses the token of this connector');
  if (response.status === 403 || response.status === 404) {
    throw new TrackerKeyForbidden(`Jira responded ${response.status} for this place`);
  }
  if (!response.ok) throw new StoreError(`Jira responded ${response.status}`);
  if (response.status === 204) return undefined;

  return response.json().catch(() => {
    throw new StoreError('Jira answered no JSON');
  });
}

/** The site and the project of a place, for a site the connector still reaches. */
async function placeOf(access: TrackerAccess, place: string | undefined): Promise<{ site: Site; project: string }> {
  const matched = place === undefined ? null : PLACE.exec(place);
  if (matched === null) throw new StoreError('This destination names no Jira project');
  const credential = await access.credential();
  const site = sitesOf(credential.extra).find((each) => each.id === matched[1]);
  if (site === undefined) throw new TrackerKeyForbidden('This connector does not reach the site of this project');

  return { site, project: matched[2] as string };
}

async function askTokens(http: Http, body: Record<string, string>, now: number): Promise<OAuthTokens | 'refused'> {
  let response: Response;
  try {
    response = await http(`${AUTH}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch {
    throw new StoreError('Atlassian could not be reached');
  }
  // Atlassian answers a refresh token it does not know with `403 invalid_grant`.
  if (response.status === 400 || response.status === 401 || response.status === 403) return 'refused';
  if (!response.ok) throw new StoreError(`Atlassian responded ${response.status} to a token`);
  const parsed = tokensSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new StoreError('Atlassian gave no tokens');

  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresAt: now + parsed.data.expires_in * 1_000,
  };
}

const issueRowSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.object({
    summary: z.string().optional(),
    updated: z.string().optional(),
    labels: z.array(z.string()).optional(),
    description: z.unknown().optional(),
    status: z
      .object({
        id: z.string(),
        name: z.string(),
        statusCategory: z.object({ key: z.string() }).optional(),
      })
      .optional(),
    resolution: z.object({ name: z.string() }).nullable().optional(),
    comment: z
      .object({
        comments: z.array(
          z.object({
            id: z.string(),
            body: z.unknown().optional(),
            created: z.string(),
            author: z.object({ displayName: z.string().optional() }).optional(),
          }),
        ),
      })
      .optional(),
  }),
});

const statusesSchema = z.array(
  z.object({
    statuses: z.array(
      z.object({ id: z.string(), name: z.string(), statusCategory: z.object({ key: z.string() }).optional() }),
    ),
  }),
);

/** The issue type a note takes in a project: a bug, else a task, else the first that is no sub-task. */
async function issueTypeOf(access: TrackerAccess, site: Site, project: string): Promise<string> {
  const answer = z
    .object({ issueTypes: z.array(z.object({ id: z.string(), name: z.string(), subtask: z.boolean().optional() })) })
    .safeParse(await jira(access, `/ex/jira/${site.id}/rest/api/3/issue/createmeta/${project}/issuetypes`));
  const types = answer.success ? answer.data.issueTypes.filter((each) => each.subtask !== true) : [];
  const chosen =
    types.find((each) => /^bug$/i.test(each.name)) ?? types.find((each) => /^task$/i.test(each.name)) ?? types[0];
  if (chosen === undefined) throw new TrackerKeyForbidden('This Jira project offers no issue type to create');

  return chosen.id;
}

/** Each file of the note, sent to the issue. A file that Jira refuses is lost, never a failure of the note. */
async function sendFiles(
  access: TrackerAccess,
  site: Site,
  key: string,
  files: readonly { id: string; name: string; type: string; content: Uint8Array }[],
): Promise<FilesAnswer> {
  const sent: string[] = [];
  const lost: string[] = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.content)], { type: file.type }), file.name);
    try {
      await jira(access, `/ex/jira/${site.id}/rest/api/3/issue/${key}/attachments`, {
        method: 'POST',
        // Atlassian refuses an upload without it (its protection against a forged form).
        headers: { 'X-Atlassian-Token': 'no-check' },
        body: form,
      });
      sent.push(file.id);
    } catch (error) {
      console.error(
        `[fruitback] a file of a note did not reach Jira: ${error instanceof Error ? error.message : String(error)}`,
      );
      lost.push(file.id);
    }
  }

  return { sent, lost, waiting: [] };
}

function commentsOf(row: z.infer<typeof issueRowSchema>): NoteComment[] {
  return (row.fields.comment?.comments ?? []).slice(-COMMENTS_PER_ISSUE).map((comment) => ({
    id: comment.id,
    body: adfText(comment.body),
    createdAt: comment.created,
    ...(comment.author?.displayName ? { author: comment.author.displayName } : {}),
  }));
}

function createJiraStore(
  access: TrackerAccess,
  { connector, stages = {} }: { connector: string; stages?: StageExceptions },
): NoteStore {
  return {
    name: 'jira',
    stages: JIRA_STAGES,
    attachments: true,
    scope: (client) => `${connector}:${client?.teamId ?? ''}`,

    async create(note: Note, client: ClientConfig | undefined, policy, files = []) {
      const { site, project } = await placeOf(access, client?.teamId);
      const issueType = await issueTypeOf(access, site, project);
      const labels = [
        FRUITBACK_LABEL,
        ...(note.client === undefined ? [] : [jiraLabel(clientLabelName(note.client.id))]),
        pageLabel(note.page.url),
      ];
      const created = z.object({ id: z.string(), key: z.string() }).safeParse(
        await jira(access, `/ex/jira/${site.id}/rest/api/3/issue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fields: {
              project: { id: project },
              issuetype: { id: issueType },
              summary: buildIssueTitle(note, { maxLength: 250 }),
              description: buildAdfDescription(note, policy.locale),
              labels,
            },
          }),
        }),
      );
      if (!created.success) throw new StoreError('Jira returned no issue');
      const issue = {
        id: created.data.id,
        identifier: created.data.key,
        url: `${site.url}/browse/${created.data.key}`,
      };
      if (files.length === 0) return issue;

      return { ...issue, files: await sendFiles(access, site, created.data.key, files) };
    },

    async findForPage(query, client, policy) {
      const { site, project } = await placeOf(access, client?.teamId);
      const labels = [
        FRUITBACK_LABEL,
        pageLabel(query.url),
        ...(query.clientId ? [jiraLabel(clientLabelName(query.clientId))] : []),
      ];
      const jql = [`project = ${project}`, ...labels.map((label) => `labels = "${label}"`)].join(' AND ');
      const params = new URLSearchParams({
        jql: `${jql} ORDER BY created DESC`,
        maxResults: String(ISSUES_PAGE_SIZE),
        fields: [
          'summary',
          'status',
          'resolution',
          'description',
          'updated',
          'labels',
          ...(policy.showComments ? ['comment'] : []),
        ].join(','),
      });
      const answer = z
        .object({ issues: z.array(z.unknown()) })
        .safeParse(await jira(access, `/ex/jira/${site.id}/rest/api/3/search/jql?${params}`));
      if (!answer.success) throw new StoreError('Jira returned no search');

      return answer.data.issues.flatMap((each): NoteIssue[] => {
        const row = issueRowSchema.safeParse(each);
        if (!row.success) return [];
        // The labels select the issues, and the note confirms the page and the client.
        if (!labels.every((label) => row.data.fields.labels?.includes(label))) return [];
        const parsed = noteOfDescription(row.data.fields.description);
        if (!parsed.ok || parsed.note.page.url !== query.url) return [];
        if (query.clientId && parsed.note.client?.id !== query.clientId) return [];
        const status = row.data.fields.status;
        const stage =
          status !== undefined && Object.hasOwn(stages, status.id)
            ? (stages[status.id] as NoteStage)
            : jiraStage(status?.statusCategory?.key, row.data.fields.resolution?.name);
        const read = noteIssueSchema.safeParse({
          id: row.data.id,
          identifier: row.data.key,
          url: `${site.url}/browse/${row.data.key}`,
          title: row.data.fields.summary ?? '',
          stage,
          stateName: status?.name ?? '',
          ...(status === undefined ? {} : { status: `${connector}:${status.id}` }),
          updatedAt: row.data.fields.updated ?? '',
          ...(policy.showComments ? { comments: commentsOf(row.data) } : {}),
          note: parsed.note,
        });

        return read.success ? [read.data] : [];
      });
    },

    // FRU-368: the statuses of the project, each with the stage of its category, for the statuses of a site.
    async trackerStates(client): Promise<TrackerState[]> {
      const { site, project } = await placeOf(access, client?.teamId);
      const answer = statusesSchema.safeParse(
        await jira(access, `/ex/jira/${site.id}/rest/api/3/project/${project}/statuses`),
      );
      if (!answer.success) throw new StoreError('Jira returned no statuses');
      const seen = new Map<string, TrackerState>();
      for (const type of answer.data) {
        for (const status of type.statuses) {
          if (!seen.has(status.id)) {
            seen.set(status.id, { id: status.id, name: status.name, stage: jiraStage(status.statusCategory?.key) });
          }
        }
      }

      return [...seen.values()];
    },
  };
}

const projectsSchema = z.object({
  values: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
  isLast: z.boolean().optional(),
});

/** Where the next page of places starts: the site, and the first project of it to ask for. */
function cursorOf(after: string | undefined): { site: number; at: number } {
  if (after === undefined) return { site: 0, at: 0 };
  const matched = /^([0-9]{1,3})\.([0-9]{1,7})$/.exec(after);

  return matched === null ? { site: 0, at: 0 } : { site: Number(matched[1]), at: Number(matched[2]) };
}

export const plugin: TrackerPlugin = {
  kind: 'jira',
  name: 'Jira',
  envNames: { oauth: 'FRUITBACK_JIRA_OAUTH' },
  oauth: {
    authorize: ({ clientId, redirectUri, state }) =>
      `${AUTH}/authorize?${new URLSearchParams({
        audience: 'api.atlassian.com',
        client_id: clientId,
        scope: JIRA_SCOPES.join(' '),
        redirect_uri: redirectUri,
        state,
        response_type: 'code',
        prompt: 'consent',
      })}`,
    async exchange({ code, redirectUri, client }, http, now) {
      const tokens = await askTokens(
        http,
        {
          grant_type: 'authorization_code',
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code,
          redirect_uri: redirectUri,
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
      const response = await http(`${API}/oauth/token/accessible-resources`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!response.ok) return undefined;
      const parsed = z.array(z.unknown()).safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) return undefined;
      // The id of a resource is not unique across products: a Jira site is one whose scopes write Jira.
      const sites = parsed.data.flatMap((each) => {
        const site = siteSchema.safeParse(each);

        return site.success && (site.data.scopes ?? []).includes('write:jira-work')
          ? [{ id: site.data.id, name: site.data.name, url: site.data.url.replace(/\/+$/, '') }]
          : [];
      });
      const [first] = sites;
      if (first === undefined) return undefined;

      return {
        label: sites.length === 1 ? `Jira · ${first.name}` : `Jira · ${first.name} +${sites.length - 1}`,
        extra: { sites: JSON.stringify(sites) },
      };
    },
  },
  async places(access, { search, after }) {
    const sites = sitesOf((await access.credential()).extra);
    const cursor = cursorOf(after);
    const site = sites[cursor.site];
    if (site === undefined) return { places: [] };
    const params = new URLSearchParams({
      startAt: String(cursor.at),
      maxResults: String(PROJECTS_PAGE_SIZE),
      orderBy: 'name',
      ...(search === undefined ? {} : { query: search }),
    });
    const answer = projectsSchema.safeParse(
      await jira(access, `/ex/jira/${site.id}/rest/api/3/project/search?${params}`),
    );
    if (!answer.success) throw new StoreError('Jira returned no projects');
    const places = answer.data.values.map((project) => ({
      id: `${site.id}/${project.id}`,
      name: sites.length === 1 ? `${project.name} (${project.key})` : `${site.name} · ${project.name} (${project.key})`,
    }));
    const more = answer.data.isLast === false && answer.data.values.length > 0;
    // The next projects of this site, else the first ones of the next site.
    let next: string | undefined;
    if (more) next = `${cursor.site}.${cursor.at + answer.data.values.length}`;
    else if (cursor.site + 1 < sites.length) next = `${cursor.site + 1}.0`;

    return { places, ...(next === undefined ? {} : { next }) };
  },
  readPlace: (value) => (typeof value === 'string' && PLACE.test(value) ? value : undefined),
  async placeName(access, place) {
    let answer: unknown;
    try {
      const { site, project } = await placeOf(access, place);
      answer = await jira(access, `/ex/jira/${site.id}/rest/api/3/project/${project}`);
    } catch (error) {
      // A project that the person cannot see is no place of this connector.
      if (error instanceof TrackerKeyForbidden) return undefined;
      throw error;
    }
    const read = z.object({ name: z.string(), key: z.string() }).safeParse(answer);

    return read.success ? { name: `${read.data.name} (${read.data.key})` } : undefined;
  },
  store: (access, options) => createJiraStore(access, options),
};

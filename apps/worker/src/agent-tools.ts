import { type FeedbackWords, type NoteIssue, feedbackText } from '@fruitback/shared';
import { type AccountStore, type AgentWrite, can } from './accounts.ts';
import type { AgentGrant } from './agent-keys.ts';
import type { ClientConfig, ClientPolicy, ClientResolution } from './clients.ts';
import { cursorOf, noteIdOf, noteKeyOf, queryOf } from './console-notes.ts';
import { readPage } from './feedback-routes.ts';
import type { Kv } from './kv.ts';
import type { McpTool, ToolAnswer } from './mcp.ts';
import {
  canonicalizeRequestedPage,
  indexed,
  invalidatePages,
  placeOf,
  placedAt,
  withoutTracker,
} from './note-helpers.ts';
import { chargeRateLimit } from './rate-limit.ts';
import { markedAgent } from './reply-text.ts';
import { OWN_SOURCE, isBuiltIn } from './site-statuses.ts';
import type { NoteStage } from '@fruitback/shared';
import type { ListedNote, NoteIndex } from './notes-index.ts';
import { withoutTrackerStatus } from './site-statuses.ts';
import { type NoteStore, StoreError, findNote, takesChecks, takesReplies, takesStatuses } from './store.ts';
import { TASK_PRIORITIES, type TaskChange, type TaskFields, readTaskChange } from './task-fields.ts';

/**
 * The read tools of `/mcp` (FRU-463): the notes of the sites of an agent key, with their whole
 * content. `docs/decisions/agents.md` says why each one exists.
 *
 * - **A key reads the sites of its grant, and no other.** A site out of the grant answers as a site
 *   that does not exist, and so does a note of such a site.
 * - **The notes come from the index of the notes, and their content from the read of their page**
 *   (`readPage`, the read of `GET /feedback` and its cache). A note that the index lists and that
 *   its store no longer holds is left out.
 * - **On a site that everyone reads, a key with `verifiedOnly` reads only the notes of a known
 *   person**: `reporter.verified` is `true`. This filter and the one of `status` run after the read
 *   of a page of the index, so a page of answers can hold fewer notes than its `limit`, and `next`
 *   still says if more wait.
 * - **A key whose member does not see the tracker reads no reference of it**, as a guest in the
 *   console (FRU-250).
 * - **The tools of a task follow the module** (FRU-659): on a worker that keeps no task (FRU-651),
 *   `task_choices`, `set_note_status` and `update_task` are not given. The reads still give the
 *   fields of a task kept before, as the list of the console does.
 */

export type AgentToolsContext = {
  grant: AgentGrant;
  /** What the write tools read and write beside the store (FRU-464), and the fields of a task (FRU-659). */
  accounts: Pick<AccountStore, 'siteStatuses' | 'recordAgentWrite' | 'setTaskFields' | 'labels' | 'membersOf'>;
  /** Whether this worker keeps tasks (FRU-651). `off`: no tool of a task is given. */
  tasks: 'on' | 'off';
  /** The longest reply, as `POST /feedback/<id>/replies` takes it. */
  replyLength: number;
  store: NoteStore;
  kv: Kv;
  noteIndex: NoteIndex | undefined;
  /** The client of a site and what was decided for it, as `GET /feedback` resolves it. */
  route(site: string): Promise<ClientResolution>;
};

/** The most notes `notes_as_text` writes for a whole site. */
export const MAX_TEXT_NOTES = 200;

/**
 * The pages that `list_notes` and `notes_as_text` read at the same time (FRU-539). A read of a
 * tracker calls it: GitHub counts the requests that run at the same time, and a page of GitHub
 * already fetches four threads at once.
 */
export const PAGE_READS_AT_ONCE = 4;

const NO_SITE = 'No site of this key has this id.';
const NO_NOTE = 'No note of the sites of this key has this id.';
const UNAVAILABLE = 'The store of the notes did not answer. Try again later.';

/** The words of `notes_as_text`: the English of the widget (FRU-109). */
const WORDS: FeedbackWords = {
  title: (url) => `Notes on ${url}`,
  empty: 'No note on this page.',
  element: (element) => `Element: ${element}`,
  component: (component) => `Component: ${component}`,
  by: (name) => `By: ${name}`,
  written: (date) => `Written: ${date}`,
  approximate: 'Position: approximate — found by its place on the page, not by its identity',
  detached: 'Position: element not found on this page',
  picture: (url) => `Picture: ${url}`,
  noNote: 'No note.',
  team: 'Team',
  reply: (author) => `Reply from ${author}`,
  status: (issue, status) => status?.name || issue.stateName || issue.stage,
};

const STAGE_NAMES = ['new', 'todo', 'progress', 'done', 'closed'];

/** The most members `task_choices` gives, as the menu of the console reads them. */
export const MAX_TASK_MEMBERS = 200;

export function agentTools(context: AgentToolsContext): McpTool[] {
  const { grant } = context;
  const seesTracker = can(grant.role, 'see-tracker');

  return [
    {
      name: 'list_notes',
      description:
        'The notes of one site, newest first, each with its whole content: text, page, element, component, file and line, picture, replies, stage, status and reporter.',
      inputSchema: {
        type: 'object',
        properties: {
          site: { type: 'string', description: `One of: ${grant.sites.join(', ')}` },
          stage: { type: 'string', enum: STAGE_NAMES },
          status: {
            type: 'string',
            description:
              'The key of a status of the site, as each note gives it in `status`: `own:<key>` for a status Fruitback keeps.',
          },
          since: { type: 'string', description: 'An ISO 8601 date: only the notes left at it or after it.' },
          q: { type: 'string', description: 'Words to look for in the excerpt, the page and the stage.' },
          assignee: {
            type: 'string',
            description: 'The tasks of a member, by the id that task_choices gives; `none`: the tasks of nobody.',
          },
          priority: { type: 'string', enum: [...TASK_PRIORITIES, 'none'] },
          label: { type: 'string', description: 'The tasks with a label, by the id that task_choices gives.' },
          due: {
            type: 'string',
            enum: ['overdue', 'week', 'none'],
            description:
              '`overdue`: a due day before `today`. `week`: `today` and the six days after it. `none`: no due day.',
          },
          today: {
            type: 'string',
            description: 'The day of `due`, YYYY-MM-DD, in the zone of the team. Absent: the day of UTC.',
          },
          archived: { type: 'boolean', description: '`true`: the archived tasks, in place of the others.' },
          cursor: { type: 'string', description: 'The `next` of the answer before.' },
          limit: { type: 'integer', minimum: 8, maximum: 50 },
        },
        required: ['site'],
        additionalProperties: false,
      },
      call: (args) => listNotes(context, seesTracker, args),
    },
    {
      name: 'get_note',
      description: 'One note, with its whole content, by the `id` that list_notes gives.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: (args) => getNote(context, seesTracker, args),
    },
    {
      name: 'notes_as_text',
      description: `The notes of one page, or of a whole site (${MAX_TEXT_NOTES} at most), as Markdown: each line a reviewer wrote is quoted.`,
      inputSchema: {
        type: 'object',
        properties: {
          site: { type: 'string', description: `One of: ${grant.sites.join(', ')}` },
          page: { type: 'string', description: 'The address of one page of the site.' },
        },
        required: ['site'],
        additionalProperties: false,
      },
      call: (args) => notesAsText(context, seesTracker, args),
    },
    ...(context.tasks === 'on'
      ? [
          {
            name: 'task_choices',
            description:
              'The labels of the workspace, and the members a task can be given to: the ids that update_task and the filters of list_notes take.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            call: () => taskChoices(context),
          },
        ]
      : []),
    ...(grant.write ? writeTools(context) : []),
  ];
}

/** The most writes of one key in a minute (FRU-464), whatever the address it calls from. */
export const AGENT_WRITE_LIMIT = 30;

/**
 * The write tools (FRU-464), for a key with the right `write` only: a key `read` is not given them,
 * and `tools/call` refuses a tool it was not given. Each write counts in the limit of its key, and
 * goes in the log of its key once the store took it.
 */
function writeTools(context: AgentToolsContext): McpTool[] {
  return [
    {
      name: 'reply_to_note',
      description:
        'Adds a reply under a note, in its thread on the page. The reviewer reads it as a reply of an agent, under the name of this key.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The `id` that list_notes gives.' },
          body: { type: 'string', maxLength: context.replyLength },
        },
        required: ['id', 'body'],
        additionalProperties: false,
      },
      call: (args) => replyToNote(context, args),
    },
    ...(context.tasks === 'on' ? taskWriteTools(context) : []),
  ];
}

/** The write tools of a task (FRU-464, FRU-659), on a worker that keeps tasks only. */
function taskWriteTools(context: AgentToolsContext): McpTool[] {
  return [
    {
      name: 'set_note_status',
      description: `Sets the status of a note that Fruitback keeps: a key of the statuses of its site, as \`${OWN_SOURCE}:<key>\`. A note in a tracker takes its status from the tracker.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The `id` that list_notes gives.' },
          status: { type: 'string', description: `For example \`${OWN_SOURCE}:done\`.` },
        },
        required: ['id', 'status'],
        additionalProperties: false,
      },
      call: (args) => setNoteStatus(context, args),
    },
    {
      name: 'update_task',
      description:
        'Changes a task that Fruitback keeps: its status, its assignee, its priority, its due day and its labels. A field left out does not change, and `null` clears it. A note in a tracker is changed in its tracker.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The `id` that list_notes gives.' },
          status: { type: 'string', description: `A status of its site, as \`${OWN_SOURCE}:<key>\`.` },
          assignee: {
            type: ['string', 'null'],
            description: 'The id of a member, as task_choices gives it. `null`: nobody.',
          },
          priority: { type: ['string', 'null'], enum: [...TASK_PRIORITIES, null] },
          dueOn: { type: ['string', 'null'], description: 'A day, YYYY-MM-DD. `null`: no due day.' },
          labels: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 20,
            description: 'The ids of its labels, as task_choices gives them: they replace the labels it has.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      call: (args) => updateTask(context, args),
    },
  ];
}

type Site = {
  id: string;
  workspace: string;
  read: (url: string) => Promise<NoteIssue[]>;
  publicRead: boolean;
  client: ClientConfig | undefined;
  policy: ClientPolicy;
};

/** The site of the grant that `id` names, or `undefined`. */
async function siteOf(context: AgentToolsContext, id: unknown): Promise<Site | undefined> {
  if (typeof id !== 'string' || !context.grant.sites.includes(id)) return undefined;
  const route = await context.route(id);
  if (!route.ok) return undefined;

  return {
    id,
    workspace: context.grant.workspace,
    publicRead: route.policy.read === 'public',
    client: route.client,
    policy: route.policy,
    read: (url) =>
      readPage({
        store: context.store,
        kv: context.kv,
        noteIndex: context.noteIndex,
        client: route.client,
        clientId: id,
        url,
        policy: route.policy,
      }),
  };
}

/** Whether the key reads this note: on a site that everyone reads, `verifiedOnly` keeps a known person's. */
function readable(context: AgentToolsContext, site: Site, issue: NoteIssue): boolean {
  return !(context.grant.verifiedOnly && site.publicRead && issue.note.reporter?.verified !== true);
}

/**
 * A note as an agent reads it: the issue as `GET /feedback` gives it, with `id` for `get_note`
 * and its site. The id of the issue in its tracker is `issueId`, for a key that sees the tracker.
 */
function noteView(
  site: Site,
  issue: NoteIssue,
  seesTracker: boolean,
  task: TaskFields | undefined,
): Record<string, unknown> {
  const { id: issueId, ...fields } = seesTracker ? issue : withoutTrackerStatus(withoutTracker(issue, issue.note.id));

  return {
    id: noteIdOf(site.id, issue.note.id),
    site: site.id,
    ...(seesTracker ? { issueId } : {}),
    ...fields,
    ...(task === undefined ? {} : { task: taskView(task) }),
  };
}

/**
 * The fields of a task as an agent reads them (FRU-659): those of the console, with no place in its
 * column, which only the board reads.
 */
function taskView(task: TaskFields): Omit<TaskFields, 'position'> {
  const { position: _position, ...shown } = task;

  return shown;
}

/**
 * The issues of these notes of the index, in their order. Each page is read once, and
 * `PAGE_READS_AT_ONCE` pages at the same time (FRU-539): one page after the other made 50 reads in a
 * row for `list_notes`, and 200 for `notes_as_text`. A note that two pages hold is the one of
 * the last page, as when the pages were read one after the other.
 */
async function contentOf(site: Site, listed: readonly ListedNote[]): Promise<NoteIssue[]> {
  const pages = [...new Set(listed.map((note) => note.pageUrl))];
  const byPage: NoteIssue[][] = [];
  let next = 0;
  let failed = false;
  const reader = async (): Promise<void> => {
    // After a failure, no reader starts a page: the call answers the error of the first one.
    while (!failed && next < pages.length) {
      const position = next++;
      try {
        byPage[position] = await site.read(pages[position] as string);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_READS_AT_ONCE, pages.length) }, reader));
  const read = new Map<string, NoteIssue>();
  for (const issues of byPage) {
    for (const issue of issues) read.set(issue.note.id, issue);
  }

  return listed.flatMap((note) => {
    const issue = read.get(note.note);

    return issue === undefined ? [] : [issue];
  });
}

async function guarded(work: () => Promise<ToolAnswer>): Promise<ToolAnswer> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof StoreError) return { ok: false, error: UNAVAILABLE };
    throw error;
  }
}

function listNotes(
  context: AgentToolsContext,
  seesTracker: boolean,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  return guarded(async () => {
    const site = await siteOf(context, args.site);
    const index = context.noteIndex;
    if (site === undefined || index === undefined) return { ok: false, error: NO_SITE };
    const params = new URLSearchParams();
    for (const field of ['stage', 'q', 'cursor', 'limit', 'assignee', 'priority', 'label', 'due', 'today'] as const) {
      const value = args[field];
      if (typeof value === 'string' || typeof value === 'number') params.set(field, String(value));
      else if (value !== undefined) return { ok: false, error: `Invalid ${field}.` };
    }
    // FRU-659: the filters of a task, as the console reads them (FRU-655). A key is no account: no `me`.
    if (params.get('assignee') === 'me')
      return { ok: false, error: 'Invalid assignee: the id of a member, or `none`.' };
    if (args.archived === true) params.set('archived', '1');
    else if (args.archived !== undefined && args.archived !== false) return { ok: false, error: 'Invalid archived.' };
    // The console sends the day of the browser; an agent that says none reads the day of UTC.
    if (params.has('due') && !params.has('today')) params.set('today', new Date().toISOString().slice(0, 10));
    const query = queryOf(params, '');
    if (!query.ok) return { ok: false, error: `Invalid ${query.error.replace(/^invalid-/, '')}.` };
    const since = args.since === undefined ? undefined : Date.parse(String(args.since));
    if (since !== undefined && Number.isNaN(since)) return { ok: false, error: 'Invalid since: an ISO 8601 date.' };

    const listed = await index.list(site.workspace, {
      ...query.query,
      site: site.id,
      sites: [site.id],
      searchesReference: seesTracker,
      ...(since === undefined ? {} : { since }),
    });
    if (args.status !== undefined && typeof args.status !== 'string') return { ok: false, error: 'Invalid status.' };
    const status = args.status;
    const issues = (await contentOf(site, listed.notes)).filter(
      (issue) => readable(context, site, issue) && (status === undefined || issue.status === status),
    );
    const tasks = new Map(listed.notes.map((note) => [note.note, note.kept?.task]));

    return {
      ok: true,
      content: {
        site: site.id,
        notes: issues.map((issue) => noteView(site, issue, seesTracker, tasks.get(issue.note.id))),
        ...(listed.next === undefined ? {} : { next: cursorOf(listed.next) }),
      },
    };
  });
}

function getNote(context: AgentToolsContext, seesTracker: boolean, args: Record<string, unknown>): Promise<ToolAnswer> {
  return guarded(async () => {
    const key = typeof args.id === 'string' ? noteKeyOf(args.id) : undefined;
    const site = key === undefined ? undefined : await siteOf(context, key.site);
    if (key === undefined || site === undefined || context.noteIndex === undefined)
      return { ok: false, error: NO_NOTE };
    const page = await context.noteIndex.pageOfNote(site.workspace, site.id, key.note);
    const issue = page === undefined ? undefined : (await site.read(page)).find((each) => each.note.id === key.note);
    if (issue === undefined || !readable(context, site, issue)) return { ok: false, error: NO_NOTE };
    const task = await context.noteIndex.taskOf(site.workspace, site.id, key.note);

    return { ok: true, content: { note: noteView(site, issue, seesTracker, task) } };
  });
}

function notesAsText(
  context: AgentToolsContext,
  seesTracker: boolean,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  return guarded(async () => {
    const site = await siteOf(context, args.site);
    const index = context.noteIndex;
    if (site === undefined || index === undefined) return { ok: false, error: NO_SITE };
    const shown = (issue: NoteIssue): NoteIssue =>
      seesTracker ? issue : withoutTrackerStatus(withoutTracker(issue, issue.note.id));

    if (args.page !== undefined) {
      const page = typeof args.page === 'string' ? canonicalizeRequestedPage(args.page) : null;
      if (page === null) return { ok: false, error: 'Invalid page: the address of a page.' };
      const issues = (await site.read(page)).filter((issue) => readable(context, site, issue));
      const text = feedbackText(
        issues.map((issue) => ({ issue: shown(issue) })),
        { pageUrl: page, words: WORDS },
      );

      return { ok: true, content: { site: site.id, page, text } };
    }

    const listed = await index.list(site.workspace, {
      site: site.id,
      sites: [site.id],
      searchesReference: seesTracker,
      limit: MAX_TEXT_NOTES,
    });
    const issues = (await contentOf(site, listed.notes)).filter((issue) => readable(context, site, issue));
    const byPage = new Map<string, NoteIssue[]>();
    for (const [position, issue] of issues.entries()) {
      const page = listed.notes.find((note) => note.note === issue.note.id)?.pageUrl ?? `#${position}`;
      byPage.set(page, [...(byPage.get(page) ?? []), shown(issue)]);
    }
    const text = [...byPage]
      .map(([page, notes]) =>
        feedbackText(
          notes.map((issue) => ({ issue })),
          { pageUrl: page, words: WORDS },
        ),
      )
      .join('\n');

    return {
      ok: true,
      content: { site: site.id, text, ...(listed.next === undefined ? {} : { truncated: true }) },
    };
  });
}

/** The note of the grant that `id` names, with the places of its site to look for it in. */
async function writableNote(
  context: AgentToolsContext,
  id: unknown,
): Promise<{ site: Site; note: string; page: string; targets: (ClientConfig | undefined)[] } | undefined> {
  const key = typeof id === 'string' ? noteKeyOf(id) : undefined;
  const site = key === undefined ? undefined : await siteOf(context, key.site);
  if (key === undefined || site === undefined || context.noteIndex === undefined) return undefined;
  const page = await context.noteIndex.pageOfNote(site.workspace, site.id, key.note);
  if (page === undefined) return undefined;
  const places = site.client?.destinations ?? [];
  const targets =
    site.client === undefined || places.length < 2
      ? [site.client]
      : places.map((place) => placedAt(site.client as ClientConfig, place));

  return { site, note: key.note, page, targets };
}

/**
 * Writes a write in the log of its key. The write is in the store by then: a failure of the log is
 * said in the log of the worker and never answered to the agent, which would write a second time.
 */
async function logged(context: AgentToolsContext, workspace: string, write: AgentWrite): Promise<void> {
  try {
    await context.accounts.recordAgentWrite(workspace, write);
  } catch (error) {
    console.error(
      `[fruitback] the write of an agent key was not logged: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Counts one write of the key. `false`: the key wrote `AGENT_WRITE_LIMIT` times in this minute. */
function chargeKey(context: AgentToolsContext): Promise<boolean> {
  return chargeRateLimit(context.kv, context.grant.key, 1, {
    limit: AGENT_WRITE_LIMIT,
    counter: (key, window) => `fruitback:rate:agent:${JSON.stringify([key, window])}`,
  });
}

const LIMITED = `This key wrote ${AGENT_WRITE_LIMIT} times in the last minute. Try again later.`;

function replyToNote(context: AgentToolsContext, args: Record<string, unknown>): Promise<ToolAnswer> {
  return guarded(async () => {
    const body = args.body;
    if (typeof body !== 'string' || body.trim() === '' || [...body].length > context.replyLength) {
      return { ok: false, error: `Invalid body: 1 to ${context.replyLength} characters.` };
    }
    const found = await writableNote(context, args.id);
    if (found === undefined) return { ok: false, error: NO_NOTE };
    const { site, note, page } = found;
    if (!site.policy.showComments) return { ok: false, error: 'This site takes no reply.' };

    for (const target of found.targets) {
      const issue = await findNote(
        context.store,
        { url: page, clientId: site.id, id: note, by: 'note' },
        target,
        site.policy,
      );
      if (issue === undefined) continue;
      if (!readable(context, site, issue)) return { ok: false, error: NO_NOTE };
      if (!(await takesReplies(context.store, target))) return { ok: false, error: 'This note takes no reply.' };
      if (!(await chargeKey(context))) return { ok: false, error: LIMITED };
      const comment = await context.store.reply?.(
        { issue: issue.id, clientId: site.id },
        { body, author: { kind: 'agent', name: context.grant.name } },
        target,
        site.policy,
      );
      if (comment === undefined) break;
      await invalidatePages(context.kv, [page]);
      await logged(context, site.workspace, {
        key: context.grant.key,
        keyName: context.grant.name,
        site: site.id,
        note,
        action: 'reply',
        at: Date.now(),
      });

      return { ok: true, content: { comment: markedAgent(comment) } };
    }

    return { ok: false, error: NO_NOTE };
  });
}

type ChosenStatus = { key: string | null; stage: NoteStage };

/** The status of its site that `asked` names, as `postStatus` reads it, or the error of the tool. */
async function statusOf(
  context: AgentToolsContext,
  site: Site,
  asked: unknown,
): Promise<{ chosen: ChosenStatus } | { error: string }> {
  const prefix = `${OWN_SOURCE}:`;
  if (typeof asked !== 'string' || !asked.startsWith(prefix)) {
    return { error: `Invalid status: a status of the site, as \`${prefix}<key>\`.` };
  }
  const key = asked.slice(prefix.length);
  const rows = (await context.accounts.siteStatuses(site.workspace, site.id)) ?? [];
  const row = rows.find((one) => one.source === OWN_SOURCE && one.key === key);
  if (row?.hidden === true) return { error: 'This status is hidden on its site.' };
  if (isBuiltIn(OWN_SOURCE, key)) return { chosen: { key: null, stage: key as NoteStage } };
  if (row !== undefined) return { chosen: { key, stage: row.stage } };

  return { error: 'No status of this site has this key.' };
}

const IN_TRACKER = 'statuses-not-taken: this note is in a tracker, which sets its status.';

function setNoteStatus(context: AgentToolsContext, args: Record<string, unknown>): Promise<ToolAnswer> {
  return guarded(async () => {
    const prefix = `${OWN_SOURCE}:`;
    const asked = args.status;
    if (typeof asked !== 'string' || !asked.startsWith(prefix)) {
      return { ok: false, error: `Invalid status: a status of the site, as \`${prefix}<key>\`.` };
    }
    const found = await writableNote(context, args.id);
    if (found === undefined) return { ok: false, error: NO_NOTE };
    const { site, note, page } = found;
    const status = await statusOf(context, site, asked);
    if ('error' in status) return { ok: false, error: status.error };
    const { chosen } = status;

    for (const target of found.targets) {
      const issue = await findNote(
        context.store,
        { url: page, clientId: site.id, id: note, by: 'note' },
        target,
        site.policy,
      );
      if (issue === undefined) continue;
      if (!readable(context, site, issue)) return { ok: false, error: NO_NOTE };
      if (!(await takesStatuses(context.store, target))) return { ok: false, error: IN_TRACKER };
      if (!(await chargeKey(context))) return { ok: false, error: LIMITED };
      const answer = await writeStatus(context, site, target, issue, chosen);
      if (answer === undefined) break;
      if (answer === 'status-changed') return { ok: false, error: 'The status changed in the console. Try again.' };
      await invalidatePages(context.kv, [page]);
      await logged(context, site.workspace, {
        key: context.grant.key,
        keyName: context.grant.name,
        site: site.id,
        note,
        action: 'status',
        status: asked,
        at: Date.now(),
      });

      return { ok: true, content: { status: asked, stage: answer.stage } };
    }

    return { ok: false, error: NO_NOTE };
  });
}

/** Writes a status through the store, then the index, as `set_note_status` does. */
async function writeStatus(
  context: AgentToolsContext,
  site: Site,
  target: ClientConfig | undefined,
  issue: NoteIssue,
  chosen: ChosenStatus,
): Promise<{ stage: NoteStage } | 'status-changed' | undefined> {
  const answer = await context.store.setStatus?.({ issue: issue.id, clientId: site.id }, chosen, target);
  if (answer === undefined || answer === 'status-changed') return answer;
  const verdicts = site.policy.showComments && (await takesChecks(context.store, target));
  await indexed(context.noteIndex, (index) =>
    index.refresh(site.workspace, site.id, placeOf(target), [{ ...issue, stage: answer.stage }], Date.now(), {
      verdicts,
    }),
  );

  return answer;
}

/** The fields of `update_task` (FRU-659): the fields of the console, with no place and no archive. */
const TASK_FIELDS = ['assignee', 'priority', 'dueOn', 'labels'] as const;

/** Why `setTaskFields` refused, as the agent reads it. */
const TASK_REFUSED = {
  'not-found': NO_NOTE,
  'not-allowed': NO_NOTE,
  'not-kept': 'fields-not-taken: this note is in a tracker, which keeps its fields.',
  'not-member': 'No member of this workspace has this assignee id: task_choices lists them.',
  'unknown-label': 'No label of this workspace has one of these ids: task_choices lists them.',
} as const;

/**
 * `update_task` (FRU-659): the fields of a task as `POST …/notes/<note>/task` writes them, and its
 * status as `set_note_status` writes it. Everything is checked before the first write. The fields
 * are written first, in one transaction that a refusal leaves untouched; then the status. A status
 * that fails after the fields were written answers « The fields were saved; the status was not. »
 */
function updateTask(context: AgentToolsContext, args: Record<string, unknown>): Promise<ToolAnswer> {
  return guarded(async () => {
    const asked = Object.fromEntries(TASK_FIELDS.flatMap((field) => (field in args ? [[field, args[field]]] : [])));
    let change: TaskChange | undefined;
    if (Object.keys(asked).length > 0) {
      const read = readTaskChange(asked);
      if ('invalid' in read) return { ok: false, error: `Invalid ${read.invalid}.` };
      change = read;
    }
    if (change === undefined && args.status === undefined) {
      return { ok: false, error: 'Nothing to change: give a status, an assignee, a priority, a due day or labels.' };
    }
    const found = await writableNote(context, args.id);
    if (found === undefined) return { ok: false, error: NO_NOTE };
    const { site, note, page } = found;
    let chosen: ChosenStatus | undefined;
    if (args.status !== undefined) {
      const status = await statusOf(context, site, args.status);
      if ('error' in status) return { ok: false, error: status.error };
      chosen = status.chosen;
    }

    for (const target of found.targets) {
      const issue = await findNote(
        context.store,
        { url: page, clientId: site.id, id: note, by: 'note' },
        target,
        site.policy,
      );
      if (issue === undefined) continue;
      if (!readable(context, site, issue)) return { ok: false, error: NO_NOTE };
      if (chosen !== undefined && !(await takesStatuses(context.store, target))) {
        return { ok: false, error: IN_TRACKER };
      }
      if (!(await chargeKey(context))) return { ok: false, error: LIMITED };
      const write = { key: context.grant.key, keyName: context.grant.name, site: site.id, note };

      if (change !== undefined) {
        // The member of a key that writes manages the sites (FRU-461): the right of the console.
        const set = await context.accounts.setTaskFields(site.workspace, site.id, note, change, {
          account: '',
          manages: true,
        });
        if (!set.set) return { ok: false, error: TASK_REFUSED[set.reason] };
        await invalidatePages(context.kv, [page]);
        await logged(context, site.workspace, { ...write, action: 'task', at: Date.now() });
      }
      let stage: NoteStage | undefined;
      if (chosen !== undefined) {
        // Once the fields are written, every failure of the status says so: the agent then sends the
        // status again, not the fields.
        const saved = change === undefined ? '' : 'The fields were saved; the status was not. ';
        let answer: Awaited<ReturnType<typeof writeStatus>>;
        try {
          answer = await writeStatus(context, site, target, issue, chosen);
        } catch (error) {
          if (saved !== '' && error instanceof StoreError) return { ok: false, error: `${saved}${UNAVAILABLE}` };
          throw error;
        }
        if (answer === undefined) return { ok: false, error: `${saved}${IN_TRACKER}` };
        if (answer === 'status-changed') {
          return { ok: false, error: `${saved}The status changed in the console. Try again.` };
        }
        stage = answer.stage;
        await invalidatePages(context.kv, [page]);
        await logged(context, site.workspace, {
          ...write,
          action: 'status',
          status: args.status as string,
          at: Date.now(),
        });
      }
      const task = await context.noteIndex?.taskOf(site.workspace, site.id, note);

      return {
        ok: true,
        content: {
          id: noteIdOf(site.id, note),
          ...(chosen === undefined ? {} : { status: args.status, stage }),
          ...(task === undefined ? {} : { task: taskView(task) }),
        },
      };
    }

    return { ok: false, error: NO_NOTE };
  });
}

/**
 * `task_choices` (FRU-659): the labels of the workspace, and its members who are not guests, as the
 * menu of the console offers them: an id and a name, the address for a member with no name. A key whose member does not read the members gets no member.
 */
function taskChoices(context: AgentToolsContext): Promise<ToolAnswer> {
  return guarded(async () => {
    const { workspace, role } = context.grant;
    const labels = await context.accounts.labels(workspace);
    const members = can(role, 'read-members')
      ? (await context.accounts.membersOf(workspace, { limit: MAX_TASK_MEMBERS, offset: 0 })).members
          .filter((member) => member.role !== 'guest')
          // As the menu of the console names them: a member who gave no name is named by their address.
          .map((member) => ({ id: member.user.id, name: member.user.name || member.user.email }))
      : [];

    return { ok: true, content: { labels, members } };
  });
}

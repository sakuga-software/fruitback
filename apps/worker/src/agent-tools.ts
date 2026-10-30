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
 */

export type AgentToolsContext = {
  grant: AgentGrant;
  /** What the write tools read and write beside the store (FRU-464). */
  accounts: Pick<AccountStore, 'siteStatuses' | 'recordAgentWrite'>;
  /** The longest reply, as `POST /feedback/<id>/replies` takes it. */
  replyLength: number;
  store: NoteStore;
  kv: Kv;
  noteIndex: NoteIndex | undefined;
  /** The client of a site and what was decided for it, as `GET /feedback` resolves it. */
  route(site: string): Promise<ClientResolution>;
};

/** The most notes `feedback_as_text` writes for a whole site. */
export const MAX_TEXT_NOTES = 200;

const NO_SITE = 'No site of this key has this id.';
const NO_NOTE = 'No note of the sites of this key has this id.';
const UNAVAILABLE = 'The store of the notes did not answer. Try again later.';

/** The words of `feedback_as_text`: the English of the widget (FRU-109). */
const WORDS: FeedbackWords = {
  title: (url) => `Feedback on ${url}`,
  empty: 'No feedback on this page.',
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

export function agentTools(context: AgentToolsContext): McpTool[] {
  const { grant } = context;
  const seesTracker = can(grant.role, 'see-tracker');

  return [
    {
      name: 'list_feedback',
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
          cursor: { type: 'string', description: 'The `next` of the answer before.' },
          limit: { type: 'integer', minimum: 8, maximum: 50 },
        },
        required: ['site'],
        additionalProperties: false,
      },
      call: (args) => listFeedback(context, seesTracker, args),
    },
    {
      name: 'get_feedback',
      description: 'One note, with its whole content, by the `id` that list_feedback gives.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      call: (args) => getFeedback(context, seesTracker, args),
    },
    {
      name: 'feedback_as_text',
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
      call: (args) => feedbackAsText(context, seesTracker, args),
    },
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
      name: 'reply_to_feedback',
      description:
        'Adds a reply under a note, in its thread on the page. The reviewer reads it as a reply of an agent, under the name of this key.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The `id` that list_feedback gives.' },
          body: { type: 'string', maxLength: context.replyLength },
        },
        required: ['id', 'body'],
        additionalProperties: false,
      },
      call: (args) => replyToFeedback(context, args),
    },
    {
      name: 'set_feedback_status',
      description: `Sets the status of a note that Fruitback keeps: a key of the statuses of its site, as \`${OWN_SOURCE}:<key>\`. A note in a tracker takes its status from the tracker.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The `id` that list_feedback gives.' },
          status: { type: 'string', description: `For example \`${OWN_SOURCE}:done\`.` },
        },
        required: ['id', 'status'],
        additionalProperties: false,
      },
      call: (args) => setFeedbackStatus(context, args),
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
 * A note as an agent reads it: the issue as `GET /feedback` gives it, with `id` for `get_feedback`
 * and its site. The id of the issue in its tracker is `issueId`, for a key that sees the tracker.
 */
function noteView(site: Site, issue: NoteIssue, seesTracker: boolean): Record<string, unknown> {
  const { id: issueId, ...fields } = seesTracker ? issue : withoutTrackerStatus(withoutTracker(issue, issue.note.id));

  return { id: noteIdOf(site.id, issue.note.id), site: site.id, ...(seesTracker ? { issueId } : {}), ...fields };
}

/** The issues of these notes of the index, in their order, read page by page. */
async function contentOf(site: Site, listed: readonly ListedNote[]): Promise<NoteIssue[]> {
  const pages = [...new Set(listed.map((note) => note.pageUrl))];
  const read = new Map<string, NoteIssue>();
  for (const page of pages) {
    for (const issue of await site.read(page)) read.set(issue.note.id, issue);
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

function listFeedback(
  context: AgentToolsContext,
  seesTracker: boolean,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  return guarded(async () => {
    const site = await siteOf(context, args.site);
    const index = context.noteIndex;
    if (site === undefined || index === undefined) return { ok: false, error: NO_SITE };
    const params = new URLSearchParams();
    for (const field of ['stage', 'q', 'cursor', 'limit'] as const) {
      const value = args[field];
      if (typeof value === 'string' || typeof value === 'number') params.set(field, String(value));
      else if (value !== undefined) return { ok: false, error: `Invalid ${field}.` };
    }
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

    return {
      ok: true,
      content: {
        site: site.id,
        notes: issues.map((issue) => noteView(site, issue, seesTracker)),
        ...(listed.next === undefined ? {} : { next: cursorOf(listed.next) }),
      },
    };
  });
}

function getFeedback(
  context: AgentToolsContext,
  seesTracker: boolean,
  args: Record<string, unknown>,
): Promise<ToolAnswer> {
  return guarded(async () => {
    const key = typeof args.id === 'string' ? noteKeyOf(args.id) : undefined;
    const site = key === undefined ? undefined : await siteOf(context, key.site);
    if (key === undefined || site === undefined || context.noteIndex === undefined)
      return { ok: false, error: NO_NOTE };
    const page = await context.noteIndex.pageOfNote(site.workspace, site.id, key.note);
    const issue = page === undefined ? undefined : (await site.read(page)).find((each) => each.note.id === key.note);
    if (issue === undefined || !readable(context, site, issue)) return { ok: false, error: NO_NOTE };

    return { ok: true, content: { note: noteView(site, issue, seesTracker) } };
  });
}

function feedbackAsText(
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

function replyToFeedback(context: AgentToolsContext, args: Record<string, unknown>): Promise<ToolAnswer> {
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

function setFeedbackStatus(context: AgentToolsContext, args: Record<string, unknown>): Promise<ToolAnswer> {
  return guarded(async () => {
    const prefix = `${OWN_SOURCE}:`;
    const asked = args.status;
    if (typeof asked !== 'string' || !asked.startsWith(prefix)) {
      return { ok: false, error: `Invalid status: a status of the site, as \`${prefix}<key>\`.` };
    }
    const key = asked.slice(prefix.length);
    const found = await writableNote(context, args.id);
    if (found === undefined) return { ok: false, error: NO_NOTE };
    const { site, note, page } = found;

    const rows = (await context.accounts.siteStatuses(site.workspace, site.id)) ?? [];
    const row = rows.find((one) => one.source === OWN_SOURCE && one.key === key);
    if (row?.hidden === true) return { ok: false, error: 'This status is hidden on its site.' };
    let chosen: { key: string | null; stage: NoteStage };
    if (isBuiltIn(OWN_SOURCE, key)) chosen = { key: null, stage: key as NoteStage };
    else if (row !== undefined) chosen = { key, stage: row.stage };
    else return { ok: false, error: 'No status of this site has this key.' };

    for (const target of found.targets) {
      const issue = await findNote(
        context.store,
        { url: page, clientId: site.id, id: note, by: 'note' },
        target,
        site.policy,
      );
      if (issue === undefined) continue;
      if (!readable(context, site, issue)) return { ok: false, error: NO_NOTE };
      if (!(await takesStatuses(context.store, target))) {
        return { ok: false, error: 'statuses-not-taken: this note is in a tracker, which sets its status.' };
      }
      if (!(await chargeKey(context))) return { ok: false, error: LIMITED };
      const answer = await context.store.setStatus?.({ issue: issue.id, clientId: site.id }, chosen, target);
      if (answer === undefined) break;
      if (answer === 'status-changed') return { ok: false, error: 'The status changed in the console. Try again.' };
      await invalidatePages(context.kv, [page]);
      const verdicts = site.policy.showComments && (await takesChecks(context.store, target));
      await indexed(context.noteIndex, (index) =>
        index.refresh(site.workspace, site.id, placeOf(target), [{ ...issue, stage: answer.stage }], Date.now(), {
          verdicts,
        }),
      );
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

import { type FeedbackWords, type NoteIssue, feedbackText } from '@fruitback/shared';
import { can } from './accounts.ts';
import type { AgentGrant } from './agent-keys.ts';
import type { ClientResolution } from './clients.ts';
import { cursorOf, noteIdOf, noteKeyOf, queryOf } from './console-notes.ts';
import { readPage } from './feedback-routes.ts';
import type { Kv } from './kv.ts';
import type { McpTool, ToolAnswer } from './mcp.ts';
import { canonicalizeRequestedPage, withoutTracker } from './note-helpers.ts';
import type { ListedNote, NoteIndex } from './notes-index.ts';
import { withoutTrackerStatus } from './site-statuses.ts';
import { type NoteStore, StoreError } from './store.ts';

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
 *   person**: `reporter.verified` is `true`. The filter runs after the read of a page of the index,
 *   so a page of answers can hold fewer notes than its `limit`, and `next` still says if more wait.
 * - **A key whose member does not see the tracker reads no reference of it**, as a guest in the
 *   console (FRU-250).
 */

export type AgentToolsContext = {
  grant: AgentGrant;
  store: NoteStore;
  kv: Kv;
  noteIndex: NoteIndex | undefined;
  /** The client of a site and what was decided for it, as `GET /feedback` resolves it. */
  route(site: string): ClientResolution;
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
  ];
}

type Site = { id: string; workspace: string; read: (url: string) => Promise<NoteIssue[]>; publicRead: boolean };

/** The site of the grant that `id` names, or `undefined`. */
function siteOf(context: AgentToolsContext, id: unknown): Site | undefined {
  if (typeof id !== 'string' || !context.grant.sites.includes(id)) return undefined;
  const route = context.route(id);
  if (!route.ok) return undefined;

  return {
    id,
    workspace: context.grant.workspace,
    publicRead: route.policy.read === 'public',
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
    const site = siteOf(context, args.site);
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
    const issues = (await contentOf(site, listed.notes)).filter((issue) => readable(context, site, issue));

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
    const site = key === undefined ? undefined : siteOf(context, key.site);
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
    const site = siteOf(context, args.site);
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

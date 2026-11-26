import type { NoteIssue } from '@fruitback/shared';
import type { DoneNoticeSeams } from './done-notices.ts';
import { json } from './http.ts';
import { afterStatusMoved, ownKeyOf } from './console-status.ts';
import { readJsonObject } from './bounded-body.ts';
import { handleTasks } from './console-tasks.ts';
import { CONSOLE_REPLY_PATH, type Replier, type ReplyToNote, postConsoleReply } from './console-replies.ts';
import { isDay, isPriority } from './task-fields.ts';
import { NOTE_STAGES, type NoteStage, type NoteStatus } from '@fruitback/shared';
import type { Action, AccountStore, Reach } from './accounts.ts';
import type { Kv } from './kv.ts';
import { invalidatePages } from './note-helpers.ts';
import { OWN_SOURCE, envelopeStatuses } from './site-statuses.ts';
import {
  type ListedNote,
  type NoteCursor,
  type NoteIndex,
  type NoteList,
  type NotePage,
  type NoteQuery,
  PAGE_SIZES,
  QUERY_LENGTH,
  SEARCHED,
  SEARCHED_WITHOUT_TRACKER,
  STAGE_ORDER,
} from './notes-index.ts';

/**
 * The notes of a workspace, for the page « Notes » of the console (FRU-244).
 *
 * `GET /console/workspaces/<id>/notes?site=&stage=&place=&mine=1&since=&undelivered=1&q=&cursor=&limit=` reads one page of
 * the index of the notes (FRU-237), the newest first. `counts=none` leaves out `total` and `counts`,
 * which read the whole filter: the console asks for them on the first page only (FRU-502). `POST …/notes/<note>/retry` sends again a note
 * whose delivery to a receiving connector did not arrive. `POST …/notes/<note>/status` puts a note the
 * worker keeps in a status of its site (FRU-384). `POST …/notes/<note>/replies` writes a reply under a
 * note, in the name of the caller (FRU-712, `console-replies.ts`).
 *
 * **It answers what the index keeps, and nothing else**: an excerpt of 64 characters at most, never
 * the text of a note, and a search on the fields the index holds (`searched` says which).
 *
 * Who reads what:
 * - `read-feedback` (every role) reads the list: its excerpts, pages, elements, stages, dates, authors;
 * - `see-tracker` (not a guest) reads where each note went: the place, the reference and its link in
 *   the tracker, the delivery that did not arrive, and the counts by place. A guest gets none of it,
 *   and a `place` filter is refused to it, as the list of the sites hides it the destinations;
 * - `manage-sites` sends a note again;
 * - the author of a note the worker keeps, or `manage-sites`, chooses its status (FRU-384): the list
 *   says which notes the caller may change (`canSetStatus`), with the statuses of their sites. The
 *   status of a note in a tracker is the tracker's, and is not changed here.
 *
 * A guest reads the notes of the sites shared with them and no other (FRU-250): the list, its
 * counts and its search are of those sites, whatever `site` the query names.
 *
 * The name of an author is the name its account has now, read at each request, for a member of the
 * workspace only. A name a visitor typed is not in the index (FRU-237), so it is nowhere here.
 */

export type NotesContext = {
  workspace: string;
  account: string;
  allowed: (action: Action) => boolean;
  /** The role and the sites of the caller, read when a route of the notes is asked (FRU-250). */
  reach: () => Promise<Reach | undefined>;
  noteIndex: NoteIndex | undefined;
  /** Whether this worker keeps tasks (FRU-651). `off`: no status of a note changes here. */
  tasks: 'on' | 'off';
  /** FRU-653: one note as its page reads it. Absent: `GET …/notes/<note>` answers 404. */
  readNote?: (workspace: string, site: string, note: string) => Promise<NoteIssue | undefined>;
  /** FRU-712: writes a reply under a note of a page. Absent: `POST …/notes/<note>/replies` answers 404. */
  replyToNote?: ReplyToNote;
  /** FRU-712: the caller as a reply names them, read at the call; `undefined` once they left the workspace. */
  replier?: () => Promise<Replier | undefined>;
  /** Who to tell when a note is done (FRU-604). */
  done?: DoneNoticeSeams;
  accounts: Pick<
    AccountStore,
    | 'retryDelivery'
    | 'setNoteStatus'
    | 'siteStatuses'
    | 'agentTrigger'
    | 'enqueueDelivery'
    | 'setTaskFields'
    | 'deleteTask'
    | 'createTask'
    | 'readTask'
    | 'changeTasks'
    | 'deleteTasks'
    | 'labels'
    | 'addLabel'
    | 'changeLabel'
    | 'removeLabel'
  >;
  /** The cache of the reads of the pages: a status changed makes the read of its page wrong. */
  kv: Kv | undefined;
  now: number;
  headers: Record<string, string>;
};

const ID = /^[A-Za-z0-9_-]+$/;

/** The route, or `undefined` for a path that is not one of the notes. */
export async function handleNotes(
  rest: string,
  request: Request,
  context: NotesContext,
): Promise<Response | undefined> {
  // FRU-652: the fields of a task, and the labels of the workspace.
  const tasks = await handleTasks(rest, request, context, noteKeyOf);
  if (tasks !== undefined) return tasks;
  // FRU-712: a reply from the panel of a note.
  const reply = CONSOLE_REPLY_PATH.exec(rest);
  if (reply !== null) return postConsoleReply(reply[1] as string, request, context, noteKeyOf);
  const retry = /^\/notes\/([A-Za-z0-9_-]+)\/retry$/.exec(rest);
  const status = /^\/notes\/([A-Za-z0-9_-]+)\/status$/.exec(rest);
  if (rest !== '/notes' && retry === null && status === null) return undefined;

  const { headers } = context;
  const index = context.noteIndex;

  if (status !== null) return setStatus(status[1] as string, request, context);

  if (retry !== null) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!context.allowed('manage-sites')) return forbidden(context);
    const note = noteKeyOf(retry[1] as string);
    if (note === undefined || index === undefined) return json(404, { error: 'not-found' }, headers);
    // The delivery of this note, if it is one of this workspace and did not arrive. Then the route
    // of FRU-122, which checks the workspace again.
    const delivery = await answered(() => index.deliveryOf(context.workspace, note.site, note.note));
    if (delivery === failed) return json(503, { error: 'index-unavailable' }, headers);
    if (delivery === undefined) return json(404, { error: 'not-found' }, headers);
    const due = await context.accounts.retryDelivery(context.workspace, delivery.connector, delivery.id, context.now);

    return due ? new Response(null, { status: 204, headers }) : json(404, { error: 'not-found' }, headers);
  }

  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
  if (!context.allowed('read-feedback')) return forbidden(context);
  // A worker with no database has no index, and so no list.
  if (index === undefined) return json(404, { error: 'not-found' }, headers);

  const seesTracker = context.allowed('see-tracker');
  // The table of the console reads its notes by status (FRU-551), and the views of its bar by the
  // day a note was left and by its delivery (FRU-722): those are for this route only.
  const query = queryOf(new URL(request.url).searchParams, context.account, { console: true });
  if (!query.ok) return json(400, { error: query.error }, headers);
  // Where a note went is about the tracker: its place, and whether its delivery arrived.
  if ((query.query.place !== undefined || query.query.undelivered === true) && !seesTracker) return forbidden(context);
  // FRU-502: `counts=none` reads the page alone. The counts read the whole filter, and the console
  // holds them from the first page of the same filter.
  const counts = new URL(request.url).searchParams.get('counts') ?? undefined;
  if (counts !== undefined && counts !== 'none') return json(400, { error: 'invalid-counts' }, headers);

  // The sites the caller reads: a guest, the ones shared with them (FRU-250).
  const reach = await context.reach();
  if (reach === undefined) return json(404, { error: 'not-found' }, headers);
  const sites = reach.sites === 'every' ? {} : { sites: reach.sites };
  // A guest does not see the references: its search does not read them either, or it would find one
  // by trying words (review of #306).
  const asked = { ...query.query, ...sites, searchesReference: seesTracker };
  const list = await answered(async (): Promise<NotePage & { counted?: NoteList }> => {
    if (counts === 'none') return index.page(context.workspace, asked);
    const whole = await index.list(context.workspace, asked);

    return { ...whole, counted: whole };
  });
  if (list === failed) return json(503, { error: 'index-unavailable' }, headers);
  const manages = context.allowed('manage-sites');
  const statuses = await statusesOf(context, list.notes);

  return json(
    200,
    {
      notes: list.notes.map((note) => noteView(note, context.account, seesTracker, manages, context.tasks === 'on')),
      ...(list.counted === undefined ? {} : countsView(list.counted, seesTracker)),
      searched: seesTracker ? SEARCHED : SEARCHED_WITHOUT_TRACKER,
      ...(statuses === undefined ? {} : { statuses }),
      ...(list.next === undefined ? {} : { next: cursorOf(list.next) }),
    },
    headers,
  );
}

/** The total and the counts of the filter: absent from a page read with `counts=none` (FRU-502). */
function countsView(list: NoteList, seesTracker: boolean) {
  return {
    total: list.total,
    counts: {
      all: [...list.byPlace.values()].reduce((sum, notes) => sum + notes, 0),
      // FRU-551: the notes of the list by stage, for the heads of the groups of the table.
      byStage: Object.fromEntries(list.byStage),
      ...(seesTracker ? { byPlace: Object.fromEntries(list.byPlace), undelivered: list.undelivered } : {}),
    },
  };
}

type Parsed = { ok: true; query: NoteQuery } | { ok: false; error: string };

/**
 * The query of the list, from the address. Any field that is not what it should be is refused.
 * `console`: the route of the console, which alone reads `order=status` (FRU-551), `since` and
 * `undelivered` (FRU-722). Elsewhere the list is the newest first, a cursor of a list by status is
 * refused, and those two fields are not read.
 */
export function queryOf(params: URLSearchParams, account: string, options: { console?: boolean } = {}): Parsed {
  const site = params.get('site') ?? undefined;
  if (site !== undefined && !ID.test(site)) return { ok: false, error: 'invalid-site' };
  const stage = params.get('stage') ?? undefined;
  if (stage !== undefined && !(NOTE_STAGES as readonly string[]).includes(stage)) {
    return { ok: false, error: 'invalid-stage' };
  }
  const place = params.get('place') ?? undefined;
  if (place !== undefined && !ID.test(place)) return { ok: false, error: 'invalid-place' };
  const mine = params.get('mine') ?? undefined;
  if (mine !== undefined && mine !== '1' && mine !== 'true') return { ok: false, error: 'invalid-mine' };
  // FRU-665: the archived tasks, in place of the others.
  const archived = params.get('archived') ?? undefined;
  if (archived !== undefined && archived !== '1') return { ok: false, error: 'invalid-archived' };
  // FRU-667: the notes that are not done nor closed. A stage that is asked says the stage already.
  const unresolved = params.get('unresolved') ?? undefined;
  if (unresolved !== undefined && (unresolved !== '1' || stage !== undefined)) {
    return { ok: false, error: 'invalid-unresolved' };
  }
  const q = params.get('q')?.trim() || undefined;
  if (q !== undefined && q.length > QUERY_LENGTH) return { ok: false, error: 'invalid-q' };
  // FRU-655: the fields of a task. `me` and `none` for the assignee, `none` for the priority.
  const assignee = params.get('assignee') ?? undefined;
  if (assignee !== undefined && !ID.test(assignee)) return { ok: false, error: 'invalid-assignee' };
  const priority = params.get('priority') ?? undefined;
  if (priority !== undefined && priority !== 'none' && !isPriority(priority))
    return { ok: false, error: 'invalid-priority' };
  const label = params.get('label') ?? undefined;
  if (label !== undefined && !ID.test(label)) return { ok: false, error: 'invalid-label' };
  const dueBy = params.get('due') ?? undefined;
  const today = params.get('today') ?? undefined;
  if (dueBy !== undefined && !['overdue', 'week', 'none'].includes(dueBy)) return { ok: false, error: 'invalid-due' };
  if ((dueBy === 'overdue' || dueBy === 'week') && !isDay(today)) return { ok: false, error: 'invalid-today' };
  const order = options.console === true ? (params.get('order') ?? undefined) : undefined;
  if (order !== undefined && order !== 'status') return { ok: false, error: 'invalid-order' };
  // FRU-722: the notes left at this instant or after it, in milliseconds. The console counts the day
  // of the person, which the worker cannot know, as for `due`.
  const sinceText = options.console === true ? (params.get('since') ?? undefined) : undefined;
  const since = sinceText === undefined ? undefined : Number(sinceText);
  if (since !== undefined && (!/^\d{1,16}$/.test(sinceText as string) || !Number.isSafeInteger(since))) {
    return { ok: false, error: 'invalid-since' };
  }
  // FRU-722: the notes whose delivery did not arrive.
  const undelivered = options.console === true ? (params.get('undelivered') ?? undefined) : undefined;
  if (undelivered !== undefined && undelivered !== '1') return { ok: false, error: 'invalid-undelivered' };
  const cursor = params.get('cursor') ?? undefined;
  const after = cursor === undefined ? undefined : readCursor(cursor);
  if (cursor !== undefined && after === undefined) return { ok: false, error: 'invalid-cursor' };
  // A cursor belongs to one order: one with a rank is of a list by status, one without of the other.
  if (after !== undefined && (after.rank !== undefined) !== (order === 'status')) {
    return { ok: false, error: 'invalid-cursor' };
  }
  const asked = params.get('limit') ?? undefined;
  const limit = asked === undefined ? PAGE_SIZES.default : Number(asked);
  if (!Number.isInteger(limit) || limit < PAGE_SIZES.min || limit > PAGE_SIZES.max) {
    return { ok: false, error: 'invalid-limit' };
  }

  return {
    ok: true,
    query: {
      limit,
      ...(site === undefined ? {} : { site }),
      ...(stage === undefined ? {} : { stage: stage as NoteStage }),
      ...(place === undefined ? {} : { place }),
      ...(mine === undefined ? {} : { author: account }),
      ...(archived === undefined ? {} : { archived: true }),
      ...(unresolved === undefined ? {} : { unresolved: true }),
      ...(assignee === undefined ? {} : { assignee: assigneeOf(assignee, account) }),
      ...(priority === undefined ? {} : { priority: priority === 'none' ? null : priority }),
      ...(label === undefined ? {} : { label }),
      ...(dueBy === undefined ? {} : { due: dueOf(dueBy, today as string) }),
      ...(since === undefined ? {} : { since }),
      ...(undelivered === undefined ? {} : { undelivered: true as const }),
      ...(q === undefined ? {} : { q }),
      ...(after === undefined ? {} : { after }),
      ...(order === undefined ? {} : { order }),
    },
  };
}

/** Who left a note, as the console names it. */
export type AuthorView =
  | { kind: 'you' | 'owner' | 'admin' | 'member' | 'guest'; name: string }
  | { kind: 'former-member' | 'verified' | 'anonymous' };

export function authorView(author: ListedNote['author'], account: string): AuthorView {
  if (author.kind === 'member') {
    if (author.member === undefined) return { kind: 'former-member' };
    if (author.account === account) return { kind: 'you', name: author.member.name };
    const role = author.member.role;

    return {
      kind: role === 'owner' || role === 'admin' || role === 'guest' ? role : 'member',
      name: author.member.name,
    };
  }

  // A token the site signed, or a note from before the index whose reporter was verified.
  return author.kind === 'visitor' ? { kind: 'anonymous' } : { kind: 'verified' };
}

function noteView(note: ListedNote, account: string, seesTracker: boolean, manages: boolean, keepsTasks: boolean) {
  const page = pageOf(note.pageUrl);
  const kept = note.kept;

  return {
    id: noteIdOf(note.site, note.note),
    excerpt: note.excerpt,
    page,
    // FRU-613: the element of the note, which the end of the setup shows under its text.
    ...(note.selector === undefined ? {} : { selector: note.selector }),
    ...(note.component === undefined ? {} : { component: note.component }),
    site: { id: note.site },
    stage: note.stage,
    channel: note.channel,
    author: authorView(note.author, account),
    // FRU-384: the status of a note the worker keeps, and whether this caller may change it.
    ...(kept === undefined
      ? {}
      : {
          status: `${OWN_SOURCE}:${kept.statusKey ?? kept.stage}`,
          // FRU-651: a worker that keeps no task changes no status.
          canSetStatus:
            keepsTasks && (manages || (note.author.account !== undefined && note.author.account === account)),
          // FRU-652: the fields of the task, which the same right changes.
          task: kept.task,
        }),
    ...(seesTracker
      ? {
          place: placeView(note.place),
          ...(note.reference === undefined ? {} : { ref: note.reference }),
          ...(note.referenceUrl === undefined ? {} : { url: note.referenceUrl }),
          ...(note.delivery === undefined
            ? {}
            : {
                delivery: {
                  id: note.delivery.id,
                  // A delivery with no next attempt was given up (FRU-122).
                  state: note.delivery.nextAt === undefined ? 'gave-up' : 'waiting',
                  attempts: note.delivery.attempts,
                  ...(note.delivery.lastStatus === undefined ? {} : { lastStatus: note.delivery.lastStatus }),
                },
              }),
        }
      : {}),
    createdAt: new Date(note.createdAt).toISOString(),
    checkedAt: new Date(note.checkedAt).toISOString(),
  };
}

/** Where a note went: the worker's store, a connector, or a connector that was removed since. */
function placeView(place: ListedNote['place']) {
  if (place.kind === 'fruitback') return { kind: 'fruitback' };
  if (place.connector === undefined) return { kind: 'removed' };

  return { kind: place.connector.kind, connector: place.connector.id, label: place.connector.label };
}

export function pageOf(url: string): { url: string; host: string; path: string } {
  try {
    const parsed = new URL(url);

    return { url, host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { url, host: '', path: url };
  }
}

/** The id of a note in the console: its site and the id the widget gave it, opaque. */
export function noteIdOf(site: string, note: string): string {
  return Buffer.from(JSON.stringify([site, note])).toString('base64url');
}

export function noteKeyOf(id: string): { site: string; note: string } | undefined {
  const read = readJson(id);

  return Array.isArray(read) && read.length === 2 && typeof read[0] === 'string' && typeof read[1] === 'string'
    ? { site: read[0], note: read[1] }
    : undefined;
}

/** Where the next page starts, opaque: the screen gives it back as it got it. */
export function cursorOf(cursor: NoteCursor): string {
  const read = [cursor.at, cursor.site, cursor.note, ...(cursor.rank === undefined ? [] : [cursor.rank])];

  return Buffer.from(JSON.stringify(read)).toString('base64url');
}

function readCursor(text: string): NoteCursor | undefined {
  if (!ID.test(text)) return undefined;
  const read = readJson(text);

  if (
    !Array.isArray(read) ||
    (read.length !== 3 && read.length !== 4) ||
    !Number.isSafeInteger(read[0]) ||
    typeof read[1] !== 'string' ||
    typeof read[2] !== 'string'
  ) {
    return undefined;
  }
  if (read.length === 3) return { at: read[0] as number, site: read[1], note: read[2] };
  const rank = read[3] as unknown;
  // The rank of a stage of `STAGE_ORDER` (FRU-551).
  if (!Number.isInteger(rank) || (rank as number) < 0 || (rank as number) >= STAGE_ORDER.length) return undefined;

  return { at: read[0] as number, site: read[1], note: read[2], rank: rank as number };
}

function readJson(base64url: string): unknown {
  try {
    return JSON.parse(Buffer.from(base64url, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** A status of a site as the list of the notes gives it: hidden ones are named, never offered. */
export type StatusChoice = NoteStatus & { hidden?: true };

/**
 * The statuses of the worker's store of each site with a note the worker keeps on this page
 * (FRU-384): to name the status of each note, and to offer the others to whoever may change it. Read
 * in the store at each request, as the extension reads them (FRU-366). `undefined`: the store did
 * not answer, and the list goes without them, each status then named by its stage.
 */
async function statusesOf(
  context: NotesContext,
  notes: readonly ListedNote[],
): Promise<Record<string, StatusChoice[]> | undefined> {
  const sites = [...new Set(notes.filter((note) => note.kept !== undefined).map((note) => note.site))];
  if (sites.length === 0) return undefined;
  const read = await answered(() =>
    Promise.all(
      sites.map(async (site) => [site, await context.accounts.siteStatuses(context.workspace, site)] as const),
    ),
  );
  if (read === failed) return undefined;

  return Object.fromEntries(
    read.map(([site, rows]) => {
      const hidden = new Set(
        (rows ?? []).filter((row) => row.source === OWN_SOURCE && row.hidden).map((row) => `${OWN_SOURCE}:${row.key}`),
      );
      const own = envelopeStatuses((rows ?? []).filter((row) => row.source === OWN_SOURCE));

      return [site, own.map((one) => (hidden.has(one.key) ? { ...one, hidden: true as const } : one))];
    }),
  );
}

/**
 * `POST …/notes/<note>/status`, `{ status: 'own:<key>' }` (FRU-384): the route of the extension
 * (FRU-367) for the console, whose session is a cookie. Every check is the store's, in one
 * transaction: the note, its author, the status of its site, then the note and the index.
 */
async function setStatus(id: string, request: Request, context: NotesContext): Promise<Response> {
  const { headers } = context;
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  if (!context.allowed('read-feedback')) return forbidden(context);
  if (context.tasks === 'off') return json(403, { error: 'tasks-off' }, headers);
  const note = noteKeyOf(id);
  if (note === undefined) return json(404, { error: 'not-found' }, headers);
  // A guest changes only the notes of the sites shared with them (FRU-250).
  const reach = await context.reach();
  if (reach === undefined || (reach.sites !== 'every' && !reach.sites.includes(note.site))) {
    return json(404, { error: 'not-found' }, headers);
  }

  const asked = (await readJsonObject(request))?.status;
  const own = ownKeyOf(asked);
  if ('error' in own) return json(400, { error: own.error }, headers);
  const { key } = own;

  const answer = await context.accounts.setNoteStatus(context.workspace, note.site, note.note, key, {
    account: context.account,
    manages: context.allowed('manage-sites'),
  });
  if (!answer.set) {
    switch (answer.reason) {
      case 'not-found':
        return json(404, { error: 'not-found' }, headers);
      case 'not-allowed':
        return json(403, { error: 'not-allowed' }, headers);
      // In a tracker: its status changes there.
      case 'not-kept':
        return json(403, { error: 'statuses-not-taken' }, headers);
      case 'status-hidden':
        return json(409, { error: 'status-hidden' }, headers);
      // No such status of the site now: removed since the list was read, as far as a caller knows.
      case 'unknown-status':
        return json(409, { error: 'status-changed' }, headers);
    }
  }
  if (context.kv !== undefined) await invalidatePages(context.kv, [answer.page]);
  await afterStatusMoved(context, { ...note, ...answer });

  return json(200, { status: asked, stage: answer.stage }, headers);
}

const failed = Symbol('failed');

/** What the index answers, or `failed` when it does not: said in the log, answered `503`. */
async function answered<T>(read: () => Promise<T>): Promise<T | typeof failed> {
  try {
    return await read();
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return failed;
  }
}

function forbidden(context: NotesContext): Response {
  return json(403, { error: 'forbidden' }, context.headers);
}

/** The assignee of a filter (FRU-655): `me` is the caller, `none` nobody. */
function assigneeOf(asked: string, account: string): string | null {
  if (asked === 'me') return account;

  return asked === 'none' ? null : asked;
}

/** The day of a filter (FRU-655): `week` is `today` and the six days after it. */
function dueOf(by: string, today: string): NonNullable<NoteQuery['due']> {
  if (by === 'none') return { by: 'none' };
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);

  return { by: by as 'overdue' | 'week', today, weekEnd: end.toISOString().slice(0, 10) };
}

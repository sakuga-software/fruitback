import { SEED_STAGES, type SeedStage } from '@fruitback/shared';
import type { Action, AccountStore, Reach } from './accounts.ts';
import {
  type ListedNote,
  type NoteCursor,
  type NoteIndex,
  type NoteQuery,
  PAGE_SIZES,
  QUERY_LENGTH,
  SEARCHED,
  SEARCHED_WITHOUT_TRACKER,
} from './notes-index.ts';

/**
 * The notes of a workspace, for the page « Notes » of the console (FRU-244).
 *
 * `GET /console/workspaces/<id>/notes?site=&stage=&place=&mine=1&q=&cursor=&limit=` reads one page of
 * the index of the notes (FRU-237), the newest first. `POST …/notes/<note>/retry` sends again a note
 * whose delivery to a receiving connector did not arrive.
 *
 * **It answers what the index keeps, and nothing else**: an excerpt of 64 characters at most, never
 * the text of a note, and a search on the fields the index holds (`searched` says which).
 *
 * Who reads what:
 * - `read-feedback` (every role) reads the list: its excerpts, pages, stages, dates, authors;
 * - `see-tracker` (not a guest) reads where each note went: the place, the reference and its link in
 *   the tracker, the delivery that did not arrive, and the counts by place. A guest gets none of it,
 *   and a `place` filter is refused to it, as the list of the sites hides it the destinations;
 * - `manage-sites` sends a note again.
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
  accounts: Pick<AccountStore, 'retryDelivery'>;
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
  const retry = /^\/notes\/([A-Za-z0-9_-]+)\/retry$/.exec(rest);
  if (rest !== '/notes' && retry === null) return undefined;

  const { headers } = context;
  const index = context.noteIndex;

  if (retry !== null) {
    if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
    if (!context.allowed('manage-sites')) return forbidden(context);
    const note = noteKeyOf(retry[1] as string);
    if (note === undefined || index === undefined) return json(404, { error: 'not-found' }, headers);
    // The delivery of this note, if it is one of this workspace and did not arrive. Then the route
    // of FRU-122, which checks the workspace again.
    const delivery = await answered(() => index.deliveryOf(context.workspace, note.site, note.seed));
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
  const query = queryOf(new URL(request.url).searchParams, context.account);
  if (!query.ok) return json(400, { error: query.error }, headers);
  if (query.query.place !== undefined && !seesTracker) return forbidden(context);

  // The sites the caller reads: a guest, the ones shared with them (FRU-250).
  const reach = await context.reach();
  if (reach === undefined) return json(404, { error: 'not-found' }, headers);
  const sites = reach.sites === 'every' ? {} : { sites: reach.sites };
  // A guest does not see the references: its search does not read them either, or it would find one
  // by trying words (review of #306).
  const list = await answered(() =>
    index.list(context.workspace, { ...query.query, ...sites, searchesReference: seesTracker }),
  );
  if (list === failed) return json(503, { error: 'index-unavailable' }, headers);

  return json(
    200,
    {
      notes: list.notes.map((note) => noteView(note, context.account, seesTracker)),
      total: list.total,
      counts: {
        all: [...list.byPlace.values()].reduce((sum, notes) => sum + notes, 0),
        ...(seesTracker ? { byPlace: Object.fromEntries(list.byPlace), undelivered: list.undelivered } : {}),
      },
      searched: seesTracker ? SEARCHED : SEARCHED_WITHOUT_TRACKER,
      ...(list.next === undefined ? {} : { next: cursorOf(list.next) }),
    },
    headers,
  );
}

type Parsed = { ok: true; query: NoteQuery } | { ok: false; error: string };

/** The query of the list, from the address. Any field that is not what it should be is refused. */
export function queryOf(params: URLSearchParams, account: string): Parsed {
  const site = params.get('site') ?? undefined;
  if (site !== undefined && !ID.test(site)) return { ok: false, error: 'invalid-site' };
  const stage = params.get('stage') ?? undefined;
  if (stage !== undefined && !(SEED_STAGES as readonly string[]).includes(stage)) {
    return { ok: false, error: 'invalid-stage' };
  }
  const place = params.get('place') ?? undefined;
  if (place !== undefined && !ID.test(place)) return { ok: false, error: 'invalid-place' };
  const mine = params.get('mine') ?? undefined;
  if (mine !== undefined && mine !== '1' && mine !== 'true') return { ok: false, error: 'invalid-mine' };
  const q = params.get('q')?.trim() || undefined;
  if (q !== undefined && q.length > QUERY_LENGTH) return { ok: false, error: 'invalid-q' };
  const cursor = params.get('cursor') ?? undefined;
  const after = cursor === undefined ? undefined : readCursor(cursor);
  if (cursor !== undefined && after === undefined) return { ok: false, error: 'invalid-cursor' };
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
      ...(stage === undefined ? {} : { stage: stage as SeedStage }),
      ...(place === undefined ? {} : { place }),
      ...(mine === undefined ? {} : { author: account }),
      ...(q === undefined ? {} : { q }),
      ...(after === undefined ? {} : { after }),
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

function noteView(note: ListedNote, account: string, seesTracker: boolean) {
  const page = pageOf(note.pageUrl);

  return {
    id: noteIdOf(note.site, note.seed),
    excerpt: note.excerpt,
    page,
    site: { id: note.site },
    stage: note.stage,
    channel: note.channel,
    author: authorView(note.author, account),
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
export function noteIdOf(site: string, seed: string): string {
  return Buffer.from(JSON.stringify([site, seed])).toString('base64url');
}

function noteKeyOf(id: string): { site: string; seed: string } | undefined {
  const read = readJson(id);

  return Array.isArray(read) && read.length === 2 && typeof read[0] === 'string' && typeof read[1] === 'string'
    ? { site: read[0], seed: read[1] }
    : undefined;
}

/** Where the next page starts, opaque: the screen gives it back as it got it. */
export function cursorOf(cursor: NoteCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.site, cursor.seed])).toString('base64url');
}

function readCursor(text: string): NoteCursor | undefined {
  if (!ID.test(text)) return undefined;
  const read = readJson(text);

  return Array.isArray(read) &&
    read.length === 3 &&
    Number.isSafeInteger(read[0]) &&
    typeof read[1] === 'string' &&
    typeof read[2] === 'string'
    ? { at: read[0] as number, site: read[1], seed: read[2] }
    : undefined;
}

function readJson(base64url: string): unknown {
  try {
    return JSON.parse(Buffer.from(base64url, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
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

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

function forbidden(context: NotesContext): Response {
  return json(403, { error: 'forbidden' }, context.headers);
}

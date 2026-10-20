import { type AccountStore, type Reach, can, readsSite } from './accounts.ts';
import { authorView, cursorOf, pageOf, queryOf } from './console-notes.ts';
import { readBearerToken } from './identity.ts';
import { type ListedNote, type NoteIndex, SEARCHED, SEARCHED_WITHOUT_TRACKER } from './notes-index.ts';
import type { SessionIdentity } from './session.ts';

/**
 * The notes of one whole site, for the side panel of the extension (FRU-306): the scope « Whole site »
 * of « Search and options » (FRU-307).
 *
 * `GET /session/notes?site=<id>&stage=&q=&cursor=&limit=` reads one page of the index of the notes
 * (FRU-237), the newest first, with the query of the console's list (FRU-244) and its rules:
 *
 * - **The index only**: an excerpt of 64 characters at most, the page, the stage, the author, the
 *   date. Never the text of a note, never its replies. The panel opens the page of a note to read them.
 * - **The session is read again in the store** (`sessionWrites` of `app.ts`): a session that ended,
 *   a browser disconnected in « My account », a suspended account or a person who left reads nothing.
 * - **The site is one the person reads now**: a member reads every site of a workspace, a guest the
 *   sites shared with them (FRU-250). Any other site, and a site of a suspended workspace (FRU-282),
 *   answers `404`, as a site that does not exist.
 * - **Where a note went is read with `see-tracker` only**: the reference and its link. For a guest
 *   the search does not read the references either, or it would find one by trying words.
 *
 * No cache of its own: `no-store`, as every route of the session.
 */
export const SESSION_NOTES_PATH = '/session/notes';

/** The fields of the query this route reads. Any other one is ignored, never read. */
const FIELDS = ['site', 'stage', 'q', 'cursor', 'limit'] as const;

const ID = /^[A-Za-z0-9_-]+$/;

export type SessionNotesContext = {
  accounts: Pick<AccountStore, 'memberships' | 'reach' | 'sites' | 'suspension'>;
  noteIndex: NoteIndex | undefined;
  /** `sessionWrites` of `app.ts`, bound to this request: the person of the session, now, or `undefined`. */
  session: () => Promise<SessionIdentity | undefined>;
  headers: Record<string, string>;
};

export async function handleSessionNotes(request: Request, context: SessionNotesContext): Promise<Response> {
  const { headers } = context;
  if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
  if (readBearerToken(request.headers.get('Authorization')) === undefined) {
    return json(401, { error: 'identity-required' }, headers);
  }
  const session = await context.session();
  if (session === undefined) return json(401, { error: 'identity-required' }, headers);

  const params = new URL(request.url).searchParams;
  const site = params.get('site');
  if (site === null || !ID.test(site)) return json(400, { error: 'invalid-site' }, headers);

  const found = await siteOf(context.accounts, session, site);
  if (found === undefined) return json(404, { error: 'not-found' }, headers);
  // A worker with no database has no index, and so no list.
  const index = context.noteIndex;
  if (index === undefined) return json(404, { error: 'not-found' }, headers);

  const read = new URLSearchParams();
  for (const field of FIELDS) {
    const value = params.get(field);
    if (value !== null) read.set(field, value);
  }
  const query = queryOf(read, session.subject);
  if (!query.ok) return json(400, { error: query.error }, headers);

  const seesTracker = can(found.reach.role, 'see-tracker');
  let list;
  try {
    list = await index.list(found.workspace, {
      ...query.query,
      site,
      sites: [site],
      searchesReference: seesTracker,
    });
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return json(503, { error: 'index-unavailable' }, headers);
  }

  return json(
    200,
    {
      notes: list.notes.map((note) => noteView(note, session.subject, seesTracker)),
      total: list.total,
      searched: seesTracker ? SEARCHED : SEARCHED_WITHOUT_TRACKER,
      ...(list.next === undefined ? {} : { next: cursorOf(list.next) }),
    },
    headers,
  );
}

/**
 * The workspace of `site` and the reach of the person there, when they read that site now, or
 * `undefined`. A session of an account looks in every workspace it is a member of; a pairing of a
 * workspace (FRU-95) in that one. A suspended workspace (FRU-282) is in neither.
 */
async function siteOf(
  accounts: SessionNotesContext['accounts'],
  session: SessionIdentity,
  site: string,
): Promise<{ workspace: string; reach: Reach } | undefined> {
  for (const workspace of await workspacesOf(accounts, session)) {
    const reach = await accounts.reach(workspace, session.subject);
    if (reach === undefined || !readsSite(reach, site)) continue;
    if ((await accounts.sites(workspace)).some((each) => each.id === site)) return { workspace, reach };
  }

  return undefined;
}

/** The workspaces of a session that are not suspended: an account's memberships, or a pairing's one. */
async function workspacesOf(accounts: SessionNotesContext['accounts'], session: SessionIdentity): Promise<string[]> {
  if (session.account === true) {
    return (await accounts.memberships(session.subject))
      .filter((each) => each.suspension === undefined)
      .map((each) => each.workspace.id);
  }
  if (session.workspace === undefined) return [];

  return (await accounts.suspension(session.workspace)) === undefined ? [session.workspace] : [];
}

function noteView(note: ListedNote, account: string, seesTracker: boolean) {
  const { url, path } = pageOf(note.pageUrl);

  return {
    seed: note.seed,
    excerpt: note.excerpt,
    page: { url, path },
    stage: note.stage,
    author: authorView(note.author, account),
    ...(seesTracker && note.reference !== undefined ? { reference: note.reference } : {}),
    ...(seesTracker && note.referenceUrl !== undefined ? { referenceUrl: note.referenceUrl } : {}),
    createdAt: new Date(note.createdAt).toISOString(),
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

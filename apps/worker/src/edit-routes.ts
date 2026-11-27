import { json } from './http.ts';
import { readBearerToken } from './identity.ts';
import { NOTE_MAX_LENGTH, noteAnchorSchema, noteViewportSchema } from '@fruitback/shared';
import type { AccountStore } from './accounts.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { normalizeClientId } from './clients.ts';
import { type Kv, KvError } from './kv.ts';
import { canonicalizeRequestedPage, indexed, invalidatePages, placeOf, routingFailure } from './note-helpers.ts';
import type { NoteIndex } from './notes-index.ts';
import type { NewNoteVersion, NoteVersions } from './note-versions.ts';
import { checkReplyLimit } from './rate-limit.ts';
import { indexedAuthorOf } from './reply-routes.ts';
import type { ClientResolution } from './clients.ts';
import type { CallerChecks, RequestContext, Served } from './request-context.ts';
import {
  EDITABLE_STAGES,
  type NewEdit,
  type NoteStore,
  StoreError,
  findNote,
  takesEdits,
  takesWithdrawals,
} from './store.ts';
import { type VisitorAction, visitorAuthor } from './visitor-key.ts';

/** `POST /feedback/<id>/text`: the text of a note, edited by the person who left it (FRU-475, FRU-605). */
export const EDIT_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/text$/;

/**
 * Who writes on a note of their own, by this request (FRU-605, FRU-701), as `NoteIndex.authors`
 * names an author:
 *
 * - **A member**: a session of the extension, read again in the store as for every write, of a
 *   person who writes in the workspace now (`writerIn`). Their account.
 * - **A visitor known by their browser** (FRU-701): no token, and the key of the browser in
 *   `X-Fruitback-Visitor`, on a site whose visitors may do `action` (`visitorMay`). `visitor:<digest>`.
 *   A request with a token is never read as a visitor: a token that no longer writes is a session
 *   that ended, and is told so.
 *
 * Anybody else: `401 identity-required`, or `403 not-allowed` for a person or a visitor this site does
 * not let write.
 */
type Caller =
  | { ok: true; kind: 'member'; author: string }
  | { ok: true; kind: 'visitor'; author: string }
  | { ok: false; status: 401 | 403; error: 'identity-required' | 'not-allowed' };

async function callerOf(
  request: Request,
  config: Served,
  route: Extract<ClientResolution, { ok: true }>,
  where: { workspace: string; site: string; accounts: AccountStore; context: RequestContext },
  checks: CallerChecks,
  action: VisitorAction,
): Promise<Caller> {
  const { workspace, site, accounts, context } = where;
  const session = await checks.sessionWrites(request, config, context);
  if (session === undefined) {
    const token = readBearerToken(request.headers.get('Authorization'));
    const digest = token === undefined ? checks.visitorOf(request, site) : undefined;
    if (digest === undefined) return { ok: false, status: 401, error: 'identity-required' };
    if (!checks.visitorMay(route.client, action)) return { ok: false, status: 403, error: 'not-allowed' };

    return { ok: true, kind: 'visitor', author: visitorAuthor(digest) };
  }
  const account = await checks.writerIn(request, config, context, workspace, site);
  if (account === undefined) {
    const reach = await accounts.reach(workspace, session.subject);
    const suspended = config.suspendedIn !== undefined && (await config.suspendedIn(workspace));

    return reach === undefined || suspended
      ? { ok: false, status: 401, error: 'identity-required' }
      : { ok: false, status: 403, error: 'not-allowed' };
  }

  return { ok: true, kind: 'member', author: account };
}

/**
 * The name that the reply of an edit or of a withdrawal gives its author (FRU-257): a member by their account and their
 * workspace, read now; a visitor by the name the note was sent with, their word, « not verified ».
 * `undefined`: the account or its membership is gone since the session was read.
 */
async function replyAuthorOf(
  caller: Extract<Caller, { ok: true }>,
  accounts: AccountStore,
  workspace: string,
  note: { reporter?: { name?: string } },
): Promise<NewEdit['author'] | undefined> {
  if (caller.kind === 'visitor') {
    const name = note.reporter?.name;

    return name === undefined ? { kind: 'visitor' } : { kind: 'visitor', name };
  }
  const [person, memberships] = await Promise.all([
    accounts.account(caller.author),
    accounts.memberships(caller.author),
  ]);
  const membership = memberships.find((each) => each.workspace.id === workspace);
  if (person === undefined || membership === undefined) return undefined;

  return { kind: 'member', name: person.name ?? person.email, workspace: membership.workspace.name };
}

/**
 * « Keep every version » (FRU-704): on a site that keeps them, the version of before is written, then
 * `change` runs. A change that does not happen (`happened` says no, or it throws) takes its version
 * back, so the history holds only what was changed. A store of versions that does not answer is a
 * store that does not answer: `StoreError`, `502`, and nothing changes.
 */
async function withVersion<T>(
  versions: NoteVersions | undefined,
  version: NewNoteVersion | undefined,
  change: () => Promise<T>,
  happened: (answer: T) => boolean,
): Promise<T> {
  if (versions === undefined || version === undefined) return change();
  let id: string | undefined;
  try {
    id = await versions.keep(version);
  } catch (error) {
    throw new StoreError(
      `the versions of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const takeBack = async () => {
    if (id !== undefined) await versions.forget(version.site, version.note, id).catch(() => undefined);
  };
  let answer: T;
  try {
    answer = await change();
  } catch (error) {
    await takeBack();
    throw error;
  }
  if (!happened(answer)) await takeBack();

  return answer;
}

/** The author of a version, as `note-versions.ts` keeps it: an account, or a visitor and nothing more. */
function versionAuthorOf(caller: Extract<Caller, { ok: true }>): NewNoteVersion['author'] {
  return caller.kind === 'member' ? { kind: 'member', account: caller.author } : { kind: 'visitor' };
}

/**
 * `POST /feedback/<id>/text?client=<site>` with `{ url, text }` (FRU-475).
 *
 * Replaces the text of a note, and writes a reply under it that says it was edited. The decisions of
 * the ticket, the simplest and the safest:
 *
 * - **Who.** The person who left the note, and nobody else (`callerOf`): a session of the extension,
 *   read again in the store as for every write, whose account the index keeps as the author, or a
 *   visitor known by the key of their browser, whose digest the index keeps (FRU-701), on a site
 *   that lets its visitors edit. A role that manages the sites does not rewrite the words of somebody
 *   else. A token of a site, and a visitor with no key, are nobody the worker can name: `401`.
 * - **Until when.** While the note is open: `new`, `todo` or `progress` (FRU-605). A note done waits
 *   for the verdict of its author, and a closed note says nothing more. Read in the store, and again
 *   under the lock of the row in the worker's own store (`409 not-open`).
 * - **Where.** On a site with one place: the worker's own store replaces the text. An address keeps
 *   it the same way, and is told by `note.edited`, ids only. Linear gets a comment with the new text,
 *   and its description stays the team's; where the replies are hidden, no edit (`403
 *   edits-not-taken`): a read would show the text of before. GitHub takes no reply, and no edit.
 * - **History.** The reply says who edited it, and when. The text of before is kept only on a site
 *   that keeps every version (FRU-704, `note-versions.ts`), for its members, and the widget tells the
 *   author so before they save (`versionsKept`). Elsewhere it is not kept: a person may edit a note to
 *   take out what they should not have written.
 */
export async function postEdit(
  request: Request,
  issue: string,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  context: {
    accounts: AccountStore | undefined;
    noteIndex: NoteIndex | undefined;
    /** FRU-704: where the versions of the notes are kept. Absent: none is. */
    versions?: NoteVersions | undefined;
    context: RequestContext;
  },
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, hidesTracker } = checks;
  const body = await readBoundedText(request);
  if (body === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const { url: requested, text: typed } = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const url = typeof requested === 'string' ? canonicalizeRequestedPage(requested) : null;
  if (url === null) return json(400, { error: 'invalid-url' }, corsHeaders);
  const text = typeof typed === 'string' ? typed.trim() : '';
  // The length of the note itself: `noteSchema` refuses a longer text, and a read would drop the pin.
  if (text === '' || text.length > NOTE_MAX_LENGTH) {
    return json(400, { error: 'invalid-text', maxLength: NOTE_MAX_LENGTH }, corsHeaders);
  }

  const clientId = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  try {
    const workspace = route.client?.workspace;
    const { accounts } = context;
    if (workspace === undefined || clientId === undefined || accounts === undefined) {
      return json(401, { error: 'identity-required' }, corsHeaders);
    }
    const caller = await callerOf(
      request,
      config,
      route,
      { workspace, site: clientId, accounts, context: context.context },
      checks,
      'edit',
    );
    if (!caller.ok) return json(caller.status, { error: caller.error }, corsHeaders);
    // One place only: a site that sends to several reads each note in each of them, and only the
    // worker's own store edits one.
    const target = route.client;
    if ((target?.destinations?.length ?? 0) > 1) return json(403, { error: 'edits-not-taken' }, corsHeaders);

    // A guest reads a note by the id the widget gave it, never by the id of the tracker (FRU-250).
    const hidden = await hidesTracker(request, config, route.policy);
    // Read now in the store, never in the cache: the stage that decides is the store's.
    const found = await findNote(
      store,
      { url, clientId, id: issue, by: hidden ? 'note' : 'issue' },
      target,
      route.policy,
    );
    if (found === undefined) return json(404, { error: 'not-found' }, corsHeaders);

    const author = await indexedAuthorOf(context.noteIndex, workspace, clientId, found.note.id);
    if (author === undefined || author !== caller.author) return json(403, { error: 'not-allowed' }, corsHeaders);
    if (!(await takesEdits(store, target, route.policy))) return json(403, { error: 'edits-not-taken' }, corsHeaders);
    if (!EDITABLE_STAGES.has(found.stage)) return json(409, { error: 'not-open', stage: found.stage }, corsHeaders);

    const named = await replyAuthorOf(caller, accounts, workspace, found.note);
    if (named === undefined) return json(401, { error: 'identity-required' }, corsHeaders);
    // FRU-701: an edit writes a reply, and a visitor's counts with their replies of the minute.
    if (caller.kind === 'visitor' && !(await checkReplyLimit(kv, context.context.clientIp))) {
      return json(429, { error: 'rate-limited' }, corsHeaders);
    }

    // FRU-704: the text of before, on a site that keeps every version. The same text again is no version.
    const version: NewNoteVersion | undefined =
      target?.keepNoteVersions === true && text !== found.note.text
        ? {
            workspace,
            site: clientId,
            note: found.note.id,
            kind: 'edit',
            text: found.note.text,
            author: versionAuthorOf(caller),
            at: Date.now(),
          }
        : undefined;
    const answer = await withVersion(
      context.versions,
      version,
      async () =>
        store.edit?.(
          { issue: found.id, clientId },
          {
            text,
            author: named,
            note: found.note,
            identifier: found.identifier,
          },
          target,
          route.policy,
        ),
      (edited) => edited !== undefined && edited !== 'not-open',
    );
    if (answer === undefined) return json(404, { error: 'not-found' }, corsHeaders);
    // Marked done or closed by the team between the read above and the write.
    if (answer === 'not-open') return json(409, { error: 'not-open' }, corsHeaders);
    await invalidatePages(kv, [url]);
    // The excerpt of the console and of the extension follows the text (FRU-244).
    await indexed(context.noteIndex, (index) => index.reword(workspace, clientId, found.note.id, answer.note.text));

    return json(
      200,
      { note: answer.note, ...(route.policy.showComments ? { comment: answer.comment } : {}) },
      corsHeaders,
    );
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

/**
 * Marks a note as deleted by its visitor in the index (FRU-702), before the store withdraws it. An index
 * that does not answer is a store that does not answer: `502`, and the visitor tries again.
 */
async function markRemoved(index: NoteIndex, workspace: string, site: string, note: string, at: number): Promise<void> {
  try {
    await index.remove(workspace, site, note, at);
  } catch (error) {
    throw new StoreError(
      `the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** `POST /feedback/<id>/withdraw`: the person who left an open note withdraws it (FRU-605). */
export const WITHDRAW_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/withdraw$/;

/** How long one withdrawal of a note holds the others back: a double click, or two tabs. */
const WITHDRAW_LOCK_MS = 15_000;

/**
 * `POST /feedback/<id>/withdraw?client=<site>` with `{ url }` (FRU-605).
 *
 * The author takes back a note they left, while it is open. The guards are the ones of an edit:
 *
 * - **Who.** The author the index keeps, by a session of the extension, and nobody else: a role that
 *   manages the sites closes a note in the console, as the team does.
 * - **Until when.** `new`, `todo` or `progress`: `409 not-open` after, with its stage.
 * - **Where.** On a site with one place whose store takes it (`takesWithdrawals`): the worker's own
 *   store, an address (which gets `note.withdrawn`), Linear (a reply, then the first `canceled`
 *   state). GitHub takes none (`403 withdrawals-not-taken`).
 * - **What.** The note goes to `closed`, with a reply that says who withdrew it. **Nothing is
 *   deleted**: the text, the replies and the issue stay, for the team. A site that keeps every version
 *   keeps the deletion in the history of the note too (FRU-704), with who did it and when.
 */
export async function postWithdraw(
  request: Request,
  issue: string,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  context: {
    accounts: AccountStore | undefined;
    noteIndex: NoteIndex | undefined;
    /** FRU-704: where the versions of the notes are kept. Absent: none is. */
    versions?: NoteVersions | undefined;
    context: RequestContext;
  },
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, hidesTracker } = checks;
  const body = await readBoundedText(request);
  if (body === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const { url: requested } = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const url = typeof requested === 'string' ? canonicalizeRequestedPage(requested) : null;
  if (url === null) return json(400, { error: 'invalid-url' }, corsHeaders);

  const clientId = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  try {
    const workspace = route.client?.workspace;
    const { accounts } = context;
    if (workspace === undefined || clientId === undefined || accounts === undefined) {
      return json(401, { error: 'identity-required' }, corsHeaders);
    }
    const caller = await callerOf(
      request,
      config,
      route,
      { workspace, site: clientId, accounts, context: context.context },
      checks,
      'withdraw',
    );
    if (!caller.ok) return json(caller.status, { error: caller.error }, corsHeaders);
    const target = route.client;
    if ((target?.destinations?.length ?? 0) > 1) return json(403, { error: 'withdrawals-not-taken' }, corsHeaders);

    const hidden = await hidesTracker(request, config, route.policy);
    const found = await findNote(
      store,
      { url, clientId, id: issue, by: hidden ? 'note' : 'issue' },
      target,
      route.policy,
    );
    if (found === undefined) return json(404, { error: 'not-found' }, corsHeaders);

    const author = await indexedAuthorOf(context.noteIndex, workspace, clientId, found.note.id);
    if (author === undefined || author !== caller.author) return json(403, { error: 'not-allowed' }, corsHeaders);
    if (!(await takesWithdrawals(store, target))) return json(403, { error: 'withdrawals-not-taken' }, corsHeaders);
    if (!EDITABLE_STAGES.has(found.stage)) return json(409, { error: 'not-open', stage: found.stage }, corsHeaders);

    const named = await replyAuthorOf(caller, accounts, workspace, found.note);
    if (named === undefined) return json(401, { error: 'identity-required' }, corsHeaders);
    // FRU-702: a withdrawal writes a reply, and a visitor's counts with their replies of the minute.
    if (caller.kind === 'visitor' && !(await checkReplyLimit(kv, context.context.clientIp))) {
      return json(429, { error: 'rate-limited' }, corsHeaders);
    }

    // One withdrawal at a time on a note: a tracker has no lock, and a double click would write the
    // reply twice. The second is refused while the first is written.
    const lock = `fruitback:withdraw:${clientId}:${found.note.id}`;
    if ((await kv.incr(lock, WITHDRAW_LOCK_MS)) > 1) return json(409, { error: 'withdraw-in-progress' }, corsHeaders);
    // FRU-702: a visitor deletes their note, and its pin leaves the page for everybody. The row of the
    // index is marked first: an index that does not answer is `502`, and nothing is withdrawn. The row
    // is there, or `NoteIndex.authors` would not have named this visitor. The mark is taken back
    // when the store withdraws nothing. A member withdraws, and the team sees the pin closed (FRU-605).
    const marks = caller.kind === 'visitor' ? context.noteIndex : undefined;
    if (marks !== undefined) await markRemoved(marks, workspace, clientId, found.note.id, Date.now());
    const unmark = (index: NoteIndex) =>
      indexed(index, (each) => each.remove(workspace, clientId, found.note.id, null));
    try {
      let answer: Awaited<ReturnType<NonNullable<NoteStore['withdraw']>>> | undefined;
      // FRU-704: the note as it was, on a site that keeps every version.
      const version: NewNoteVersion | undefined =
        target?.keepNoteVersions === true
          ? {
              workspace,
              site: clientId,
              note: found.note.id,
              kind: 'delete',
              text: found.note.text,
              author: versionAuthorOf(caller),
              at: Date.now(),
            }
          : undefined;
      try {
        answer = await withVersion(
          context.versions,
          version,
          async () =>
            store.withdraw?.(
              { issue: found.id, clientId },
              { author: named, note: found.note, identifier: found.identifier },
              target,
              route.policy,
            ),
          (withdrawn) => withdrawn !== undefined && withdrawn !== 'not-open',
        );
      } catch (error) {
        if (marks !== undefined) await unmark(marks);
        throw error;
      }
      if ((answer === undefined || answer === 'not-open') && marks !== undefined) await unmark(marks);
      if (answer === undefined) return json(404, { error: 'not-found' }, corsHeaders);
      // Done or closed by the team between the read above and the write.
      if (answer === 'not-open') return json(409, { error: 'not-open' }, corsHeaders);
      await invalidatePages(kv, [url]);
      // The stage of now, for the counts and the list of the console and of the extension.
      await indexed(context.noteIndex, (index) =>
        index.refresh(
          workspace,
          clientId,
          placeOf(target),
          [{ ...found, stage: answer.stage, comments: [...(found.comments ?? []), answer.comment] }],
          Date.now(),
        ),
      );

      return json(
        200,
        { stage: answer.stage, ...(route.policy.showComments ? { comment: answer.comment } : {}) },
        corsHeaders,
      );
    } finally {
      await kv.set(lock, '0', 1).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

/**
 * How long one move of a note holds the others back (review of #877). Longer than any call to a
 * tracker can last, so that the key never expires under a move still running and lets a second one
 * in: a write to Linear has no timeout of its own, and `fetch` of Node gives up on a server that does
 * not answer after 300 s (the `headersTimeout` and `bodyTimeout` of undici). The key is let go as soon
 * as the store answers: this only counts for a worker that stopped in the middle.
 */
export const MOVE_LOCK_MS = 15 * 60_000;

/**
 * Lets go of the key of a move (review of #877): three tries, then a line in the log. The key is held
 * `MOVE_LOCK_MS`, so a key that stays would refuse every move of the note until it expires; a store of
 * keys that fails three times in a row is said, and fails the next moves too (`503`), whatever the key.
 */
async function letGo(kv: Kv, lock: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await kv.set(lock, '0', 1);

      return;
    } catch {
      // Tried again: a store of keys that blinks for one call must not hold a move for 15 minutes.
    }
  }
  console.error('[fruitback] the key of a move was not let go, and expires by itself', lock);
}

/** `POST /feedback/<id>/place`: the author moves an open note to another element of its page (FRU-605). */
export const PLACE_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/place$/;

/**
 * `POST /feedback/<id>/place?client=<site>` with `{ url, anchor, viewport }` (FRU-605).
 *
 * The guards of an edit, and where an edit is taken (`takesEdits`): a tracker keeps the new place in
 * a reply too. **The same page only**: `url` is the page of the note, read in the store by it, and an
 * anchor is checked by `noteAnchorSchema` as the anchor of a new note is.
 */
export async function postMove(
  request: Request,
  issue: string,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  context: {
    accounts: AccountStore | undefined;
    noteIndex: NoteIndex | undefined;
    context: RequestContext;
  },
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, sessionWrites, writerIn, hidesTracker } = checks;
  const body = await readBoundedText(request);
  if (body === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const fields = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const url = typeof fields.url === 'string' ? canonicalizeRequestedPage(fields.url) : null;
  if (url === null) return json(400, { error: 'invalid-url' }, corsHeaders);
  const anchor = noteAnchorSchema.safeParse(fields.anchor);
  const viewport = noteViewportSchema.safeParse(fields.viewport);
  if (!anchor.success || !viewport.success) return json(400, { error: 'invalid-place' }, corsHeaders);

  const clientId = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  try {
    const workspace = route.client?.workspace;
    const { accounts } = context;
    const session = await sessionWrites(request, config, context.context);
    if (workspace === undefined || clientId === undefined || accounts === undefined || session === undefined) {
      return json(401, { error: 'identity-required' }, corsHeaders);
    }
    const account = await writerIn(request, config, context.context, workspace, clientId);
    if (account === undefined) {
      const reach = await accounts.reach(workspace, session.subject);
      const suspended = config.suspendedIn !== undefined && (await config.suspendedIn(workspace));

      return reach === undefined || suspended
        ? json(401, { error: 'identity-required' }, corsHeaders)
        : json(403, { error: 'not-allowed' }, corsHeaders);
    }
    const target = route.client;
    if ((target?.destinations?.length ?? 0) > 1) return json(403, { error: 'edits-not-taken' }, corsHeaders);

    const hidden = await hidesTracker(request, config, route.policy);
    const found = await findNote(
      store,
      { url, clientId, id: issue, by: hidden ? 'note' : 'issue' },
      target,
      route.policy,
    );
    if (found === undefined) return json(404, { error: 'not-found' }, corsHeaders);

    const author = await indexedAuthorOf(context.noteIndex, workspace, clientId, found.note.id);
    if (author === undefined || author !== account) return json(403, { error: 'not-allowed' }, corsHeaders);
    if (store.move === undefined || !(await takesEdits(store, target, route.policy))) {
      return json(403, { error: 'edits-not-taken' }, corsHeaders);
    }
    if (!EDITABLE_STAGES.has(found.stage)) return json(409, { error: 'not-open', stage: found.stage }, corsHeaders);

    const [person, memberships] = await Promise.all([accounts.account(account), accounts.memberships(account)]);
    const membership = memberships.find((each) => each.workspace.id === workspace);
    if (person === undefined || membership === undefined) return json(401, { error: 'identity-required' }, corsHeaders);

    // One move at a time on a note, as a withdrawal (review of #877): a tracker has no lock, and a
    // double click would write two comments.
    const lock = `fruitback:move:${clientId}:${found.note.id}`;
    if ((await kv.incr(lock, MOVE_LOCK_MS)) > 1) return json(409, { error: 'move-in-progress' }, corsHeaders);
    try {
      const answer = await store.move(
        { issue: found.id, clientId },
        {
          author: { kind: 'member', name: person.name ?? person.email, workspace: membership.workspace.name },
          anchor: anchor.data,
          viewport: viewport.data,
          note: found.note,
          identifier: found.identifier,
        },
        target,
        route.policy,
      );
      if (answer === undefined) return json(404, { error: 'not-found' }, corsHeaders);
      if (answer === 'not-open') return json(409, { error: 'not-open' }, corsHeaders);
      await invalidatePages(kv, [url]);

      return json(
        200,
        { note: answer.note, ...(route.policy.showComments ? { comment: answer.comment } : {}) },
        corsHeaders,
      );
    } finally {
      await letGo(kv, lock);
    }
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

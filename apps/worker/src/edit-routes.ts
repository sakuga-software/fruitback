import { json } from './http.ts';
import { NOTE_MAX_LENGTH, noteAnchorSchema, noteViewportSchema } from '@fruitback/shared';
import type { AccountStore } from './accounts.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { normalizeClientId } from './clients.ts';
import { type Kv, KvError } from './kv.ts';
import { canonicalizeRequestedPage, indexed, invalidatePages, placeOf, routingFailure } from './note-helpers.ts';
import type { NoteIndex } from './notes-index.ts';
import { indexedAuthorOf } from './reply-routes.ts';
import type { CallerChecks, RequestContext, Served } from './request-context.ts';
import { EDITABLE_STAGES, type NoteStore, StoreError, findNote, takesEdits, takesWithdrawals } from './store.ts';

/** `POST /feedback/<id>/text`: the text of a note, edited by the person who left it (FRU-475, FRU-605). */
export const EDIT_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/text$/;

/**
 * `POST /feedback/<id>/text?client=<site>` with `{ url, text }` (FRU-475).
 *
 * Replaces the text of a note, and writes a reply under it that says it was edited. The decisions of
 * the ticket, the simplest and the safest:
 *
 * - **Who.** The person who left the note, and nobody else: a session of the extension, read again
 *   in the store as for every write, whose account the index keeps as the author. A role that
 *   manages the sites does not rewrite the words of somebody else. A visitor and a token of a site
 *   are nobody the worker can name: `401`.
 * - **Until when.** While the note is open: `new`, `todo` or `progress` (FRU-605). A note done waits
 *   for the verdict of its author, and a closed note says nothing more. Read in the store, and again
 *   under the lock of the row in the worker's own store (`409 not-open`).
 * - **Where.** On a site with one place: the worker's own store replaces the text. An address keeps
 *   it the same way, and is told by `note.edited`, ids only. Linear gets a comment with the new text,
 *   and its description stays the team's; where the replies are hidden, no edit (`403
 *   edits-not-taken`): a read would show the text of before. GitHub takes no reply, and no edit.
 * - **History.** The text of before is not kept: a person may edit a note to take out what they
 *   should not have written. The reply says who edited it, and when.
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
    if (author === undefined || author !== account) return json(403, { error: 'not-allowed' }, corsHeaders);
    if (!(await takesEdits(store, target, route.policy))) return json(403, { error: 'edits-not-taken' }, corsHeaders);
    if (!EDITABLE_STAGES.has(found.stage)) return json(409, { error: 'not-open', stage: found.stage }, corsHeaders);

    const [person, memberships] = await Promise.all([accounts.account(account), accounts.memberships(account)]);
    const membership = memberships.find((each) => each.workspace.id === workspace);
    if (person === undefined || membership === undefined) return json(401, { error: 'identity-required' }, corsHeaders);

    const answer = await store.edit?.(
      { issue: found.id, clientId },
      {
        text,
        author: { kind: 'member', name: person.name ?? person.email, workspace: membership.workspace.name },
        note: found.note,
        identifier: found.identifier,
      },
      target,
      route.policy,
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
 *   deleted**: the text, the replies and the issue stay, for the team.
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
    if (author === undefined || author !== account) return json(403, { error: 'not-allowed' }, corsHeaders);
    if (!(await takesWithdrawals(store, target))) return json(403, { error: 'withdrawals-not-taken' }, corsHeaders);
    if (!EDITABLE_STAGES.has(found.stage)) return json(409, { error: 'not-open', stage: found.stage }, corsHeaders);

    const [person, memberships] = await Promise.all([accounts.account(account), accounts.memberships(account)]);
    const membership = memberships.find((each) => each.workspace.id === workspace);
    if (person === undefined || membership === undefined) return json(401, { error: 'identity-required' }, corsHeaders);

    // One withdrawal at a time on a note: a tracker has no lock, and a double click would write the
    // reply twice. The second is refused while the first is written.
    const lock = `fruitback:withdraw:${clientId}:${found.note.id}`;
    if ((await kv.incr(lock, WITHDRAW_LOCK_MS)) > 1) return json(409, { error: 'withdraw-in-progress' }, corsHeaders);
    try {
      const answer = await store.withdraw?.(
        { issue: found.id, clientId },
        {
          author: { kind: 'member', name: person.name ?? person.email, workspace: membership.workspace.name },
          note: found.note,
          identifier: found.identifier,
        },
        target,
        route.policy,
      );
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
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

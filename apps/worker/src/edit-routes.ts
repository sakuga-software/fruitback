import { NOTE_MAX_LENGTH } from '@fruitback/shared';
import type { AccountStore } from './accounts.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { normalizeClientId } from './clients.ts';
import { type Kv, KvError } from './kv.ts';
import { canonicalizeRequestedPage, indexed, invalidatePages, routingFailure } from './note-helpers.ts';
import type { NoteIndex } from './notes-index.ts';
import { indexedAuthorOf } from './reply-routes.ts';
import type { CallerChecks, RequestContext, Served } from './request-context.ts';
import { type NoteStore, StoreError, takesEdits } from './store.ts';

/** `POST /feedback/<id>/text`: the text of a note, edited by the person who left it (FRU-475). */
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
 * - **Until when.** While the note is `new`: nobody of the team moved it yet. Read in the store, and
 *   again under the lock of the row when it is written (`409 not-new`).
 * - **Where.** A note that the worker keeps (« Kept in Fruitback »), on a site with one place. A note
 *   of a tracker is the team's issue there, and an address already has the note it was sent: an
 *   edit would make the two say different things (`403 edits-not-taken`). Nothing is sent again.
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
    const found = (await store.findForPage({ url, clientId }, target, route.policy)).find((each) =>
      hidden ? each.note.id === issue : each.id === issue,
    );
    if (found === undefined) return json(404, { error: 'not-found' }, corsHeaders);

    const author = await indexedAuthorOf(context.noteIndex, workspace, clientId, found.note.id);
    if (author === undefined || author !== account) return json(403, { error: 'not-allowed' }, corsHeaders);
    if (!(await takesEdits(store, target))) return json(403, { error: 'edits-not-taken' }, corsHeaders);
    if (found.stage !== 'new') return json(409, { error: 'not-new', stage: found.stage }, corsHeaders);

    const [person, memberships] = await Promise.all([accounts.account(account), accounts.memberships(account)]);
    const membership = memberships.find((each) => each.workspace.id === workspace);
    if (person === undefined || membership === undefined) return json(401, { error: 'identity-required' }, corsHeaders);

    const answer = await store.edit?.(
      { issue: found.id, clientId },
      { text, author: { kind: 'member', name: person.name ?? person.email, workspace: membership.workspace.name } },
      target,
      route.policy,
    );
    if (answer === undefined) return json(404, { error: 'not-found' }, corsHeaders);
    // Moved by the team between the read above and the write.
    if (answer === 'not-new') return json(409, { error: 'not-new' }, corsHeaders);
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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

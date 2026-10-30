import { json } from './http.ts';
import { type AccountStore, can } from './accounts.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { type ClientConfig, normalizeClientId } from './clients.ts';
import { type Kv, KvError } from './kv.ts';
import {
  canonicalizeRequestedPage,
  indexed,
  invalidatePages,
  placeOf,
  placedAt,
  routingFailure,
} from './note-helpers.ts';
import type { NoteIndex } from './notes-index.ts';
import { checkReplyLimit } from './rate-limit.ts';
import { checkedOf } from './reply-text.ts';
import type { CallerChecks, RequestContext, Served } from './request-context.ts';
import {
  type CheckVerdict,
  type NoteStore,
  StoreError,
  findNote,
  takesChecks,
  takesReplies,
  takesStatuses,
} from './store.ts';
import { OWN_SOURCE, isBuiltIn, readSiteStatus } from './site-statuses.ts';
import { DEFAULT_NOTE_STAGE, type NoteStage } from '@fruitback/shared';

/**
 * The routes that write under a note (FRU-363), out of `app.ts` so that a review reads them in one
 * file: a reply (`POST /feedback/<id>/replies`, FRU-257) and a verdict on a note done
 * (`POST /feedback/<id>/check`, FRU-294). Every check of the caller stays in `app.ts`, which hands
 * it over in `CallerChecks`, under the names the routes call it by.
 */

/** `POST /feedback/<id>/replies`: the id of the issue of a note, as a read answers it (FRU-257). */
export const REPLY_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/replies$/;

/**
 * `POST /feedback/<id>/replies?client=<site>` with `{ url, body, name? }` (FRU-257).
 *
 * The note must be one that a read of that page answers for that site: the id alone names an issue
 * of a tracker, which can be of another site. The reply goes to the place where the note was found,
 * and the page is read again by everybody after it.
 */
export async function postReply(
  request: Request,
  issue: string,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  context: { clientIp: string; accounts: AccountStore | undefined; stillWrites: () => Promise<boolean> },
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, replyAuthorFor, endedSession, REPLY_LENGTH } = checks;
  const text = await readBoundedText(request);
  if (text === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const {
    url: requested,
    body,
    name,
  } = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const url = typeof requested === 'string' ? canonicalizeRequestedPage(requested) : null;
  if (url === null) return json(400, { error: 'invalid-url' }, corsHeaders);
  if (typeof body !== 'string' || body.trim() === '' || [...body].length > REPLY_LENGTH) {
    return json(400, { error: 'invalid-reply', maxLength: REPLY_LENGTH }, corsHeaders);
  }
  if (name !== undefined && typeof name !== 'string') return json(400, { error: 'invalid-name' }, corsHeaders);

  const clientId = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  if (!route.policy.showComments) return json(403, { error: 'replies-not-taken' }, corsHeaders);

  try {
    // The accounts are read here: a store that does not answer is `502`, as for the reply itself.
    const who = await replyAuthorFor(request, route.policy, route.client?.workspace, name, context.accounts);
    if (!who.ok) return json(who.status, { error: 'identity-required', reason: who.reason }, corsHeaders);
    if (who.account) {
      const ended = await endedSession(context.stillWrites, corsHeaders);
      if (ended !== undefined) return ended;
    }

    const places = route.client?.destinations ?? [];
    const targets =
      route.client === undefined || places.length < 2
        ? [route.client]
        : places.map((place) => placedAt(route.client as ClientConfig, place));
    for (const target of targets) {
      const found = await findNote(store, { url, clientId, id: issue, by: 'issue' }, target, route.policy);
      if (found === undefined) continue;
      if (!(await takesReplies(store, target))) return json(403, { error: 'replies-not-taken' }, corsHeaders);
      // Counted once the reply is one the worker would take: a refusal costs no reply of the minute.
      if (who.author.kind === 'visitor' && !(await checkReplyLimit(kv, context.clientIp))) {
        return json(429, { error: 'rate-limited' }, corsHeaders);
      }
      const comment = await store.reply?.({ issue, clientId }, { body, author: who.author }, target, route.policy);
      if (comment === undefined) break;
      await invalidatePages(kv, [url]);

      return json(201, { comment }, corsHeaders);
    }

    return json(404, { error: 'not-found' }, corsHeaders);
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

/** `POST /feedback/<id>/check`: a verdict on a note that the team marked done (FRU-294). */
export const CHECK_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/check$/;

const VERDICTS: readonly CheckVerdict[] = ['fixed', 'wrong'];

/** How long one verdict holds its note against a second one, at most: a worker that dies while it writes (FRU-294). */
export const CHECK_LOCK_MS = 15_000;

/**
 * The account that left a note, as the index keeps it (FRU-294). An index that does not answer is a
 * store that does not answer: `502`, and the person tries again. Never « nobody », which would refuse
 * the author as if they were somebody else.
 */
export async function indexedAuthorOf(
  index: NoteIndex | undefined,
  workspace: string,
  site: string,
  note: string,
): Promise<string | undefined> {
  if (index === undefined) return undefined;
  try {
    return (await index.authors(workspace, site, [note])).get(note);
  } catch (error) {
    throw new StoreError(
      `the index of the notes did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * `POST /feedback/<id>/check?client=<site>` with `{ url, verdict: 'fixed' | 'wrong', body? }` (FRU-294).
 *
 * « Looks fixed » writes a marked reply under the note, and the note stays done. « Still wrong »
 * writes the marked reply, then reopens the note in its store. **The store stays the one source of the
 * stage and of the verdict**: nothing is kept here.
 *
 * - **Who.** A session of the extension, read again in the store as for every write (2026-10-14),
 *   of a person who reads the site now. And of them, the person who left the note (the index keeps
 *   their account) or a role that manages the sites. Anybody else of the workspace: `403`.
 * - **When.** Only on a note that its store says is `done` now (`409 not-done`), and not confirmed
 *   already (`409 already-checked`).
 */
export async function postCheck(
  request: Request,
  issue: string,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  context: {
    clientIp: string;
    accounts: AccountStore | undefined;
    noteIndex: NoteIndex | undefined;
    context: RequestContext;
  },
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, sessionWrites, writerIn, hidesTracker, REPLY_LENGTH } = checks;
  const text = await readBoundedText(request);
  if (text === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const {
    url: requested,
    verdict,
    body,
  } = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const url = typeof requested === 'string' ? canonicalizeRequestedPage(requested) : null;
  if (url === null) return json(400, { error: 'invalid-url' }, corsHeaders);
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict as CheckVerdict)) {
    return json(400, { error: 'invalid-verdict', verdicts: VERDICTS }, corsHeaders);
  }
  if (body !== undefined && (typeof body !== 'string' || [...body].length > REPLY_LENGTH)) {
    return json(400, { error: 'invalid-reply', maxLength: REPLY_LENGTH }, corsHeaders);
  }

  const clientId = normalizeClientId(new URL(request.url).searchParams.get('client'));
  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  try {
    const workspace = route.client?.workspace;
    const { accounts } = context;
    // A session of the extension, still valid in the store: no token, a token of a site, a cookie of
    // the console, a session that ended, all stop here.
    const session = await sessionWrites(request, config, context.context);
    if (workspace === undefined || clientId === undefined || accounts === undefined || session === undefined) {
      return json(401, { error: 'identity-required' }, corsHeaders);
    }
    const account = await writerIn(request, config, context.context, workspace, clientId);
    const reach = await accounts.reach(workspace, session.subject);
    // A person of the workspace who does not read this site (a guest of another site): `403`. Anybody
    // else, a workspace that is suspended included (FRU-282): `401`, as for no session.
    if (account === undefined) {
      const suspended = config.suspendedIn !== undefined && (await config.suspendedIn(workspace));

      return reach === undefined || suspended
        ? json(401, { error: 'identity-required' }, corsHeaders)
        : json(403, { error: 'not-allowed' }, corsHeaders);
    }
    if (!route.policy.showComments) return json(403, { error: 'checks-not-taken' }, corsHeaders);

    // A guest reads a note by the id the widget gave it, never by the id of the tracker (FRU-250).
    const hidden = await hidesTracker(request, config, route.policy);
    const places = route.client?.destinations ?? [];
    const targets =
      route.client === undefined || places.length < 2
        ? [route.client]
        : places.map((place) => placedAt(route.client as ClientConfig, place));
    for (const target of targets) {
      // Read now in the store, never in the cache: the stage that decides is the store's.
      const found = await findNote(
        store,
        { url, clientId, id: issue, by: hidden ? 'note' : 'issue' },
        target,
        route.policy,
      );
      if (found === undefined) continue;

      const author = await indexedAuthorOf(context.noteIndex, workspace, clientId, found.note.id);
      const manages = reach !== undefined && can(reach.role, 'manage-sites');
      if (author !== account && !manages) return json(403, { error: 'not-allowed' }, corsHeaders);
      if (!(await takesChecks(store, target))) return json(403, { error: 'checks-not-taken' }, corsHeaders);
      if (found.stage !== 'done') return json(409, { error: 'not-done', stage: found.stage }, corsHeaders);
      if (checkedOf(found.comments) !== undefined) return json(409, { error: 'already-checked' }, corsHeaders);
      // No count of its own, as for the reply of a member (FRU-257): only a member gives a verdict,
      // and the limit of all requests applies above.
      // One verdict at a time on a note: a double click, or two tabs, pass the guards above together
      // and would write two verdicts. The second is refused while the first is written; after it, the
      // read under the key sees the verdict of the first.
      const lock = `fruitback:check:${clientId}:${found.note.id}`;
      if ((await kv.incr(lock, CHECK_LOCK_MS)) > 1) return json(409, { error: 'check-in-progress' }, corsHeaders);
      try {
        // Read again under the key: a request that read the note before another wrote its verdict
        // takes the key after it, and must see that verdict.
        const now = await findNote(store, { url, clientId, id: found.id, by: 'issue' }, target, route.policy);
        if (now === undefined) break;
        if (now.stage !== 'done') return json(409, { error: 'not-done', stage: now.stage }, corsHeaders);
        if (checkedOf(now.comments) !== undefined) return json(409, { error: 'already-checked' }, corsHeaders);
        const [person, memberships] = await Promise.all([accounts.account(account), accounts.memberships(account)]);
        const membership = memberships.find((each) => each.workspace.id === workspace);
        if (person === undefined || membership === undefined) {
          return json(401, { error: 'identity-required' }, corsHeaders);
        }
        const typed = typeof body === 'string' && body.trim() !== '' ? { body } : {};
        const answer = await store.check?.(
          { issue: found.id, clientId },
          {
            verdict: verdict as CheckVerdict,
            author: { kind: 'member', name: person.name ?? person.email, workspace: membership.workspace.name },
            ...typed,
          },
          target,
          route.policy,
        );
        if (answer === undefined) break;
        await invalidatePages(kv, [url]);
        // The stage the store answers now, for the counts of the console and of the extension.
        await indexed(context.noteIndex, (index) =>
          index.refresh(
            workspace,
            clientId,
            placeOf(target),
            [{ ...now, stage: answer.stage, comments: [...(now.comments ?? []), answer.comment] }],
            Date.now(),
            { verdicts: true },
          ),
        );

        return json(201, { comment: answer.comment, stage: answer.stage }, corsHeaders);
      } finally {
        // Freed once the store answered, whatever it said: the store holds the verdict from then on,
        // and the guards above read it there. A verdict that failed is not refused on its retry.
        await kv.set(lock, '0', 1).catch(() => undefined);
      }
    }

    return json(404, { error: 'not-found' }, corsHeaders);
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

/** `POST /feedback/<id>/status`: the status of a note that the worker keeps (FRU-367). */
export const STATUS_PATH = /^\/feedback\/([A-Za-z0-9_-]{1,100})\/status$/;

/**
 * `POST /feedback/<id>/status?client=<site>` with `{ url, status: 'own:<key>' }` (FRU-367).
 *
 * Puts a note that the worker keeps in a status of its site, and the note takes the stage of that
 * status: `statusOf` draws a note by its status only when the two agree.
 *
 * - **Who.** As for a verdict (FRU-294): a session of the extension, read again in the store, of a
 *   person who reads the site now; and of them, the person who left the note or a role that manages
 *   the sites. Anybody else of the workspace: `403`.
 * - **Which status.** A key of the `statuses` of the read: `own:<stage>` for a built-in status, or
 *   `own:<key>` for a status the team added to this site. A hidden one is not offered, and refused
 *   (`409 status-hidden`). A status of a tracker changes in the tracker (`400 not-own`), and so does
 *   a note of a tracker (`403 statuses-not-taken`).
 */
export async function postStatus(
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
  const text = await readBoundedText(request);
  if (text === null) return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }
  const { url: requested, status: asked } = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
    string,
    unknown
  >;
  const url = typeof requested === 'string' ? canonicalizeRequestedPage(requested) : null;
  if (url === null) return json(400, { error: 'invalid-url' }, corsHeaders);
  const prefix = `${OWN_SOURCE}:`;
  if (typeof asked !== 'string') return json(400, { error: 'invalid-status' }, corsHeaders);
  if (!asked.startsWith(prefix)) return json(400, { error: 'not-own' }, corsHeaders);
  const key = asked.slice(prefix.length);
  if (!readSiteStatus({ source: OWN_SOURCE, key, stage: DEFAULT_NOTE_STAGE }).ok) {
    return json(400, { error: 'invalid-status' }, corsHeaders);
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
    const reach = await accounts.reach(workspace, session.subject);
    if (account === undefined) {
      const suspended = config.suspendedIn !== undefined && (await config.suspendedIn(workspace));

      return reach === undefined || suspended
        ? json(401, { error: 'identity-required' }, corsHeaders)
        : json(403, { error: 'not-allowed' }, corsHeaders);
    }

    // The status, among those of this site: a built-in one, or one the team added. Read now, in the store.
    const rows = (await accounts.siteStatuses(workspace, clientId)) ?? [];
    const row = rows.find((one) => one.source === OWN_SOURCE && one.key === key);
    if (row?.hidden === true) return json(409, { error: 'status-hidden' }, corsHeaders);
    // A built-in status writes no key: a note with none is in the built-in status of its stage.
    let chosen: { key: string | null; stage: NoteStage };
    if (isBuiltIn(OWN_SOURCE, key)) chosen = { key: null, stage: key as NoteStage };
    else if (row !== undefined) chosen = { key, stage: row.stage };
    else return json(400, { error: 'unknown-status' }, corsHeaders);

    const hidden = await hidesTracker(request, config, route.policy);
    const places = route.client?.destinations ?? [];
    const targets =
      route.client === undefined || places.length < 2
        ? [route.client]
        : places.map((place) => placedAt(route.client as ClientConfig, place));
    for (const target of targets) {
      // Read now in the store, never in the cache: the author and the place are the store's.
      const found = await findNote(
        store,
        { url, clientId, id: issue, by: hidden ? 'note' : 'issue' },
        target,
        route.policy,
      );
      if (found === undefined) continue;

      const author = await indexedAuthorOf(context.noteIndex, workspace, clientId, found.note.id);
      const manages = reach !== undefined && can(reach.role, 'manage-sites');
      if (author !== account && !manages) return json(403, { error: 'not-allowed' }, corsHeaders);
      if (!(await takesStatuses(store, target))) return json(403, { error: 'statuses-not-taken' }, corsHeaders);

      const answer = await store.setStatus?.({ issue: found.id, clientId }, chosen, target);
      if (answer === undefined) break;
      // Removed, hidden or moved by the console between the read above and the write (heavy review of #492).
      if (answer === 'status-changed') return json(409, { error: 'status-changed' }, corsHeaders);
      await invalidatePages(kv, [url]);
      // The stage the store answers now, for the list and the counts of the console (FRU-237).
      const verdicts = route.policy.showComments && (await takesChecks(store, target));
      await indexed(context.noteIndex, (index) =>
        index.refresh(workspace, clientId, placeOf(target), [{ ...found, stage: answer.stage }], Date.now(), {
          verdicts,
        }),
      );

      // FRU-468: a person moved the note to To do, from another stage: the trigger of its site may call.
      // `was` is read under the lock of the write: two moves at once call once.
      if (answer.stage === 'todo' && answer.was !== 'todo') {
        await config.requestAgent?.({
          workspace,
          site: clientId,
          ...(route.client?.origins?.[0] === undefined ? {} : { origin: route.client.origins[0] }),
          identifier: found.identifier,
          note: found.note.id,
          reason: 'moved-to-todo',
        });
      }

      return json(200, { status: asked, stage: answer.stage }, corsHeaders);
    }

    return json(404, { error: 'not-found' }, corsHeaders);
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, corsHeaders);
    if (error instanceof KvError) return json(503, { error: 'limiter-unavailable' }, corsHeaders);
    throw error;
  }
}

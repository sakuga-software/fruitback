import { MAX_ATTACHMENTS_PER_NOTE, NOTE_STAGES, type Note, type NoteIssue, parseNote } from '@fruitback/shared';
import { legacyAttachment, settleFiles, takeFiles } from './attachment-routes.ts';
import { attachmentIdsOf } from './attachments.ts';
import { SENT_TTL_MS, batchMemory, createAll, hold, release, sentKey } from './batch.ts';
import { MAX_BODY_BYTES, readBoundedText } from './bounded-body.ts';
import { cached } from './cache.ts';
import { type ClientConfig, type ClientPolicy, normalizeClientId } from './clients.ts';
import { type Kv, KvError } from './kv.ts';
import {
  batchOffer,
  canonicalNote,
  canonicalizeRequestedPage,
  indexed,
  invalidatePages,
  noteEntry,
  optionalReporter,
  placeOf,
  placedAt,
  routingFailure,
  withoutTracker,
} from './note-helpers.ts';
import { type Channel, type NoteIndex, authorOf } from './notes-index.ts';
import { chargeRateLimit, maxBatch } from './rate-limit.ts';
import { checkedOf, markedAgent } from './reply-text.ts';
import type { CallerChecks, RequestContext, Served } from './request-context.ts';
import {
  type BatchAnswer,
  type CreatedIssue,
  type NoteStore,
  StoreError,
  takesAttachments,
  takesChecks,
  takesEdits,
  takesReplies,
} from './store.ts';
import { attachmentStoreFor } from './worker-stores.ts';
import { OWN_SOURCE, type SiteStatus, envelopeStatuses, withoutTrackerStatus } from './site-statuses.ts';
import { trackerSourcesOf } from './tracker-states.ts';
import type { StageExceptions } from './linear.ts';
import type { AccountStore } from './accounts.ts';

/**
 * The routes of the notes of a page (FRU-374), out of `app.ts` so that a review reads them in one
 * file: `GET /feedback`, the read of the pins of a page, and `POST /feedback`, one note or a batch.
 * Every check of the caller stays in `app.ts`, which hands it over in `CallerChecks`, under the
 * names the routes call it by.
 */

/**
 * The read path: every note planted on one page, with the Linear state that gives the pin its
 * colour. This is what lets a client come back to the page and see their own notes again.
 */
export async function getFeedback(
  request: Request,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  noteIndex: NoteIndex | undefined,
  context: RequestContext | undefined,
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, authorizeRead, writesHere, hidesTracker, notesOfReader, memberOf, seesTracker, signsNotes } =
    checks;
  const params = new URL(request.url).searchParams;
  const requested = params.get('url');
  if (requested === null || requested.trim() === '') {
    return json(400, { error: 'missing-url' }, corsHeaders);
  }

  const url = canonicalizeRequestedPage(requested);
  if (url === null) {
    return json(400, { error: 'invalid-url' }, corsHeaders);
  }

  // Normalised once, here, because this value does three jobs: it picks the route, it builds the
  // Linear label the filter matches on, and it keys the cache. Normalising for only one of them is
  // how a note becomes unreadable by the client that wrote it.
  const clientId = normalizeClientId(params.get('client'));
  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // **Before the cache, and that ordering is the guarantee.** The cached entry is per
  // (team, client, page) and holds the same answer for every entitled reader, so it is safe to
  // share — but only because an unauthorised caller is turned away here and never reaches the
  // lookup. Moving this below `cached` would serve a warm authenticated answer to an anonymous
  // request, which is the exact leak this ticket exists to close.
  const allowed = await authorizeRead(request, route.policy);
  if (!allowed.ok) {
    // FRU-330: the refusal of a read says whether a note would be refused too, so the widget of a
    // visitor offers none. Absent: the worker takes a note here.
    const closed = (await writesHere(request, route.policy)) ? {} : { canWrite: false };

    return json(401, { error: 'identity-required', reason: allowed.reason, ...closed }, corsHeaders);
  }

  try {
    // The store says what separates one tenant from another — a team for Linear, nothing extra for
    // the in-memory one. The client id is in the key regardless, so two clients reading the same URL
    // never share an entry even when they share a team.
    //
    // FRU-123: a site that can send to several places is read in each one, because a tracker finds
    // a note by where it is. Each place has its own entry: the scope of the store names it.
    const places = route.client?.destinations ?? [];
    const targets =
      route.client === undefined || places.length < 2
        ? [route.client]
        : places.map((place) => placedAt(route.client as ClientConfig, place));
    const all = await readPage({ store, kv, noteIndex, client: route.client, clientId, url, policy: route.policy });
    // Asked at each request, after the cache, whose answer every reader of the page shares.
    const hidden = await hidesTracker(request, config, route.policy);
    // FRU-294: the notes of this reader, and the confirmation of each note done. Never in the cached
    // answer: `mine` is the reader's.
    const own = await notesOfReader(request, config, route.policy, route.client?.workspace, clientId, all, noteIndex);
    // FRU-475: the reader may edit a note of theirs that is still `new`, where the worker keeps it,
    // on a site with one place. The route decides again; this only says where to offer it.
    const editsHere = own.size > 0 && places.length < 2 && (await takesEdits(store, route.client));
    const issues: NoteIssue[] = all.map((issue) => {
      const checked = issue.stage === 'done' ? checkedOf(issue.comments) : undefined;
      const mine = own.has(issue.note.id);
      const marked = {
        ...issue,
        ...(checked === undefined ? {} : { checked }),
        ...(mine ? { mine: true as const } : {}),
        ...(mine && editsHere && issue.stage === 'new' ? { editable: true as const } : {}),
      };

      return hidden ? withoutTrackerStatus(withoutTracker(marked, issue.note.id)) : marked;
    });

    // The stages of the trackers that answered, in the order of `NOTE_STAGES` (FRU-188). A site read in
    // several places can show a pin of each of them.
    const reported = await Promise.all(
      targets.map(async (target) => (await store.stagesFor?.(target)) ?? store.stages ?? NOTE_STAGES),
    );
    const stages = NOTE_STAGES.filter((stage) => reported.some((each) => each.includes(stage)));

    // FRU-366: the statuses of the site, which `status` on each note names. Asked at each request, and
    // never in the cached answer: a change in the console shows at the next read. A read that cannot
    // reach them keeps its pins, with the built-in statuses only, which draw each pin by its stage.
    // FRU-368: the states of the trackers of the site are statuses too, in the trackers' colours when
    // the site turned its switch on.
    // A reader the tracker is hidden from gets no id of the tracker (FRU-250): the statuses of the
    // worker's store only, and none of a tracker (heavy review of pull request 494).
    const [rows, trackers, trackerColours] = await Promise.all([
      statusesOfSite(context?.accounts, route.client?.workspace, clientId),
      hidden
        ? []
        : trackerSourcesOf(kv, store, route.client, (connector) => exceptionsOf(context?.accounts, connector)),
      trackerColoursOf(context?.accounts, route.client?.workspace, clientId),
    ]);
    const statuses = hidden
      ? envelopeStatuses(rows.filter((row) => row.source === OWN_SOURCE))
      : envelopeStatuses(rows, trackers, trackerColours);

    // WARNING: asked at each request, and never in the cached answer. The entry of the cache is
    // shared by everybody who may read the page, and the places are for a member only.
    // FRU-331: whether a note of this reader may carry files, for a reader who may send one (a
    // session of the workspace that reads this site). Asked at each request, like the places.
    const attaches =
      route.client?.workspace !== undefined &&
      clientId !== undefined &&
      (context?.attachments ?? attachmentStoreFor(config)) !== undefined &&
      (await memberOf(request, config, route.client.workspace, clientId)) !== undefined;
    const offered =
      places.length > 0 && (await seesTracker(request, config, route.policy))
        ? {
            destinations: await Promise.all(
              places.map(async (place) => ({
                id: place.id,
                ...(place.label === undefined ? {} : { label: place.label }),
                ...(attaches
                  ? { canAttach: await takesAttachments(store, placedAt(route.client as ClientConfig, place)) }
                  : {}),
              })),
            ),
          }
        : {};

    return json(
      200,
      // `stages` does not depend on the page, so it is not in the cached answer.
      {
        url,
        issues,
        stages,
        statuses,
        ...offered,
        // Asked at each request like the places, and absent for a reader the worker cannot name.
        ...((await signsNotes(request, route.policy)) ? { identified: true } : {}),
        // FRU-257: whether this reader may write a reply here. A reader of a site that not everybody
        // reads is one the worker let in above. Never in the cached answer: it is the reader's.
        ...(route.policy.showComments && (await takesReplies(store, route.client)) ? { canReply: true } : {}),
        // FRU-330: absent where this reader may leave a note, as on every worker of before.
        ...((await writesHere(request, route.policy)) ? {} : { canWrite: false }),
        // FRU-331: `false` says that the notes of this site stay in Fruitback, or go to a tracker that
        // takes no file: the widget offers no file and says why. Absent: this reader sends none.
        ...(attaches ? { canAttach: await takesAttachments(store, route.client) } : {}),
        ...batchOffer(config),
      },
      // No browser cache, deliberately. The read cache above is what protects the Linear
      // quota; letting the browser hold a copy too only buys one saved request per page load, and
      // costs the widget the pin it planted a second ago — it re-reads and gets served its own
      // stale copy. The E2E suite found exactly that.
      { ...corsHeaders, 'Cache-Control': 'no-store' },
    );
  } catch (error) {
    if (error instanceof StoreError) {
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
}

/**
 * The notes of one page as the store answers them, through the read cache (FRU-237): what `GET
 * /feedback` reads before it decides what this reader sees, and what `/mcp` reads (FRU-463). A read
 * that asked the store writes what it found in the index of the notes.
 *
 * A site that can send to several places is read in each one (FRU-123), and a note that comes back
 * twice is kept once.
 */
export async function readPage({
  store,
  kv,
  noteIndex,
  client,
  clientId,
  url,
  policy,
}: {
  store: NoteStore;
  kv: Kv;
  noteIndex: NoteIndex | undefined;
  client: ClientConfig | undefined;
  clientId: string | undefined;
  url: string;
  policy: ClientPolicy;
}): Promise<NoteIssue[]> {
  // The store says what separates one tenant from another — a team for Linear, nothing extra for
  // the in-memory one. The client id is in the key regardless, so two clients reading the same URL
  // never share an entry even when they share a team.
  //
  // FRU-123: a site that can send to several places is read in each one, because a tracker finds
  // a note by where it is. Each place has its own entry: the scope of the store names it.
  const places = client?.destinations ?? [];
  const targets = client === undefined || places.length < 2 ? [client] : places.map((place) => placedAt(client, place));
  const found = await Promise.all(
    targets.map((target) => {
      const key = JSON.stringify([store.name, store.scope(target), clientId ?? null, url]);

      return cached(kv, url, key, async () => {
        const issues = await store.findForPage({ url, clientId }, target, policy);
        // FRU-237: what the store says now is the stage the index keeps. Only a read that asked the
        // store writes, so a page that many read costs one write for each answer of the cache.
        const workspace = client?.workspace;
        if (workspace !== undefined && clientId !== undefined) {
          // FRU-295: the verdicts are kept only where a person can give one, so that a fix to check
          // is always one that the person can confirm.
          const verdicts = policy.showComments && (await takesChecks(store, target));
          await indexed(noteIndex, (index) =>
            index.refresh(workspace, clientId, placeOf(target), issues, Date.now(), { verdicts }),
          );
        }

        return issues;
      });
    }),
  );
  // Two places of one team are one read of the tracker, so a note can come back twice. A site
  // that is read in one place gets what its store answers, as it is: nothing there comes back
  // twice, and two notes can hold one note id.
  const seen = new Set<string>();
  const issues =
    found.length < 2
      ? found.flat()
      : found.flat().filter((issue) => !seen.has(issue.note.id) && seen.add(issue.note.id));

  // FRU-464: a reply of an agent says so, after the cache, from the line that the worker wrote.
  return issues.map((issue) =>
    issue.comments === undefined ? issue : { ...issue, comments: issue.comments.map(markedAgent) },
  );
}

/**
 * A note of a known person arrived (FRU-468): the trigger of its site calls its agent, when it is on
 * and waits for this moment. A note of a visitor calls nothing. `authorOf` is the reading of the index:
 * a member, or a reviewer the identity of the site verified.
 */
async function verifiedNoteArrived(
  config: Served,
  workspace: string,
  origin: string | undefined,
  site: string,
  note: Note,
  channel: Channel,
  issue: CreatedIssue,
): Promise<void> {
  if (config.requestAgent === undefined || authorOf(note, channel === 'extension').kind === 'visitor') return;
  await config.requestAgent({
    workspace,
    site,
    ...(origin === undefined ? {} : { origin }),
    identifier: issue.identifier,
    note: note.id,
    reason: 'verified-note',
  });
}

export async function postFeedback(
  request: Request,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  clientIp: string,
  noteIndex: NoteIndex | undefined,
  /** Whether the session of the token still writes, read in the store (FRU-238). */
  stillWrites: () => Promise<boolean>,
  context: RequestContext | undefined,
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, attributionFor, endedSession, chosenPlace, writerIn, hidesTracker } = checks;
  // FRU-331: the files of the note, by their ids in transit. Read before the body: a bad list is
  // refused whatever the note says.
  const attachmentIds = attachmentIdsOf(new URL(request.url).searchParams.get('attachments'), MAX_ATTACHMENTS_PER_NOTE);
  if (attachmentIds === null) {
    return json(400, { error: 'invalid-attachments', max: MAX_ATTACHMENTS_PER_NOTE }, corsHeaders);
  }

  const body = await readBoundedText(request);
  if (body === null) {
    return json(413, { error: 'payload-too-large', maxBytes: MAX_BODY_BYTES }, corsHeaders);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(400, { error: 'invalid-json' }, corsHeaders);
  }

  // FRU-124: an array is a batch, an object is one note, as before.
  if (Array.isArray(payload)) {
    // A note with files goes alone: the files of a batch would have to say which note is theirs.
    if (attachmentIds.length > 0) return json(400, { error: 'attachments-in-batch' }, corsHeaders);
    return postBatch(request, config, store, kv, corsHeaders, clientIp, payload, noteIndex, stillWrites, checks);
  }

  const parsed = parseNote(payload);
  if (!parsed.ok) {
    return json(400, { error: 'invalid-note', reason: parsed.reason }, corsHeaders);
  }

  const note = canonicalNote(parsed.note);
  const clientId = note.client?.id;

  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // Whose word the attribution is (FRU-9). The claimed reporter loses `verified` whatever it said,
  // and only a token this worker checked can put it back.
  const identity = await attributionFor(request, route.policy, note.reporter);
  if (!identity.ok) {
    return json(401, { error: identity.error, reason: identity.reason }, corsHeaders);
  }
  // A note signed by a session of an account is a write: the session is read again (FRU-238).
  const ended = identity.account ? await endedSession(stillWrites, corsHeaders) : undefined;
  if (ended !== undefined) return ended;

  const attributed = { ...note, ...optionalReporter(identity.reporter) };

  const target = await chosenPlace(request, config, route);
  if (target === null) return json(403, { error: 'destination-not-allowed' }, corsHeaders);

  try {
    // A note of before FRU-331, sent again, names its picture in its note: it goes with it while the
    // migration keeps it, and the note is never refused for it.
    const noteFiles = {
      files: context?.attachments ?? attachmentStoreFor(config),
      store,
      writer:
        context === undefined
          ? undefined
          : (workspace: string, site: string | undefined) => writerIn(request, config, context, workspace, site),
    };
    const workspaceOfNote = route.client?.workspace;
    const legacy = await legacyAttachment(noteFiles, target, workspaceOfNote, attributed, attachmentIds);
    const named = legacy?.id === undefined ? attachmentIds : [...attachmentIds, legacy.id];
    const taken =
      named.length === 0
        ? undefined
        : await takeFiles(noteFiles, target, workspaceOfNote, attributed.id, clientId, named);
    if (taken !== undefined && !taken.ok) return json(taken.status, taken.body, corsHeaders);
    const { files: answered, ...issue } = await store.create(
      attributed,
      target,
      route.policy,
      taken?.ok === true ? taken.files : undefined,
    );
    // The tracker has the files, or refused them once the note was written: none stays in transit.
    // A file that a delivery carries later stays until that delivery arrives, or its transit ends.
    const filesOutcome = taken?.ok === true ? await settleFiles(taken.store, taken.files, answered) : undefined;
    await invalidatePages(kv, [attributed.page.url]);
    const workspace = route.client?.workspace;
    if (workspace !== undefined && clientId !== undefined) {
      const entry = noteEntry(workspace, clientId, attributed, identity.channel, target, issue);
      await indexed(noteIndex, (index) => index.record([entry], Date.now()));
      await verifiedNoteArrived(
        config,
        workspace,
        route.client?.origins?.[0],
        clientId,
        attributed,
        identity.channel,
        issue,
      );
    }

    const hidden = await hidesTracker(request, config, route.policy);

    return json(
      201,
      {
        issue: hidden ? withoutTracker(issue, attributed.id) : issue,
        ...(filesOutcome === undefined ? {} : { attachments: filesOutcome }),
        // The note named a picture that its place takes no file for: it goes without it, and says why.
        ...(legacy?.notTaken === undefined
          ? {}
          : { attachments: { sent: 0, lost: 0, waiting: 0, notTaken: legacy.notTaken } }),
      },
      corsHeaders,
    );
  } catch (error) {
    if (error instanceof StoreError) {
      // Upstream failed, not the caller: 502 tells the widget to keep the note and retry.
      return json(502, { error: 'store-unavailable', message: error.message }, corsHeaders);
    }
    throw error;
  }
}

/**
 * Several notes in one request (FRU-124): `POST /feedback` with an array of notes.
 *
 * - Every note is read before anything is written: one that is not a note refuses the batch.
 * - The request passed the limiter for one. The N − 1 others are counted here, before any write:
 *   over the limit, `429`, and nothing is written.
 * - One client for the whole batch, one identity, one place (`?destination=`).
 * - A note kept in the last minutes answers its issue again and is not planted twice: its id is the
 *   key (`note.id` « dedupes retries »). That is what a widget sends again after a partial failure.
 *   A note that another request is planting now is answered as not kept, and is not planted here.
 * - One answer for each note, in order: `201` when every one was kept, `207` when some were, `502`
 *   when none was. The widget keeps the ones that were not as drafts.
 */
async function postBatch(
  request: Request,
  config: Served,
  store: NoteStore,
  kv: Kv,
  corsHeaders: Record<string, string>,
  clientIp: string,
  payload: unknown[],
  noteIndex: NoteIndex | undefined,
  stillWrites: () => Promise<boolean>,
  checks: CallerChecks,
): Promise<Response> {
  const { routeFor, attributionFor, endedSession, chosenPlace, hidesTracker } = checks;
  const max = maxBatch(config.rateLimitPerMinute);
  if (payload.length === 0 || payload.length > max) {
    return json(400, { error: 'invalid-batch', max }, corsHeaders);
  }

  const notes: Note[] = [];
  for (const [index, each] of payload.entries()) {
    const parsed = parseNote(each);
    if (!parsed.ok) return json(400, { error: 'invalid-note', index, reason: parsed.reason }, corsHeaders);
    notes.push(canonicalNote(parsed.note));
  }
  if (new Set(notes.map((note) => note.id)).size !== notes.length) {
    return json(400, { error: 'invalid-batch', reason: 'the same note twice', max }, corsHeaders);
  }
  const clientId = notes[0]?.client?.id;
  if (!notes.every((note) => note.client?.id === clientId)) {
    return json(400, { error: 'invalid-batch', reason: 'one client for the whole batch', max }, corsHeaders);
  }

  let allowed: boolean;
  try {
    allowed = await chargeRateLimit(kv, clientIp, notes.length - 1, { limit: config.rateLimitPerMinute });
  } catch (error) {
    if (!(error instanceof KvError)) throw error;
    console.error(`[fruitback] rate limit unavailable: ${error.message}`);

    return json(503, { error: 'limiter-unavailable' }, corsHeaders);
  }
  if (!allowed) return json(429, { error: 'rate-limited' }, corsHeaders);

  const route = await routeFor(request, config, clientId);
  if (!route.ok) return routingFailure(route, corsHeaders);

  // One request is one caller: the identity is checked once, and written on every note it signs.
  const attributed: Note[] = [];
  let channel: Channel = 'script';
  let account = false;
  for (const note of notes) {
    const identity = await attributionFor(request, route.policy, note.reporter);
    if (!identity.ok) return json(401, { error: identity.error, reason: identity.reason }, corsHeaders);
    attributed.push({ ...note, ...optionalReporter(identity.reporter) });
    channel = identity.channel;
    account = identity.account;
  }
  // Once for the request, as the token is one (FRU-238).
  const ended = account ? await endedSession(stillWrites, corsHeaders) : undefined;
  if (ended !== undefined) return ended;

  const target = await chosenPlace(request, config, route);
  if (target === null) return json(403, { error: 'destination-not-allowed' }, corsHeaders);

  // The notes kept by an earlier attempt are answered from the `Kv`, and only the others are sent.
  const known = await Promise.all(
    attributed.map(async (note) => {
      try {
        const kept = await kv.get(sentKey(clientId, note.id));

        return kept === undefined ? undefined : (JSON.parse(kept) as CreatedIssue);
      } catch {
        // A `Kv` that does not answer only loses the protection against a second copy.
        return undefined;
      }
    }),
  );
  // A note that is not kept yet is taken for this request. One that another request holds is not
  // sent from here: it is answered as not kept, and the next attempt reads what became of it.
  const held = await Promise.all(
    attributed.map((note, index) => (known[index] === undefined ? hold(kv, clientId, note.id) : false)),
  );
  const fresh = attributed.filter((_, index) => held[index]);

  let planted: BatchAnswer[] = [];
  try {
    if (fresh.length > 0) {
      planted = await createAll(store, fresh, target, route.policy, batchMemory(kv, store, clientId, target, fresh));
    }
  } catch (error) {
    if (!(error instanceof StoreError)) {
      // An error nobody expected answers `500`. The notes are given back first: the next attempt
      // must not wait for the hold to end.
      await Promise.all(fresh.map((note) => release(kv, clientId, note.id)));
      throw error;
    }
    // Nothing of this attempt was kept. A note of an earlier one still answers its issue.
    planted = fresh.map(() => ({ error: 'store-unavailable' }) as const);
  }

  let next = 0;
  const results = attributed.map((note, index) => {
    const issue = known[index];
    if (issue !== undefined) return { id: note.id, issue };
    const answer: BatchAnswer = held[index] ? (planted[next++] as BatchAnswer) : { error: 'store-unavailable' };

    return { id: note.id, ...answer };
  });
  await Promise.all(
    results.flatMap((result, index) => (held[index] && 'error' in result ? [release(kv, clientId, result.id)] : [])),
  );

  // WARNING: a `Kv` that does not take this write loses the ten minutes, not the note. The note is
  // kept and answered; only its trace is missing. Its hold is not given back, so a second attempt in
  // the next minute is answered « not kept » and plants nothing. After that minute, a widget that
  // sends the whole batch again would plant it twice: a widget sends again only the notes that were
  // answered as not kept. The memory `Kv` of this process does not refuse a write.
  await Promise.all(
    results.flatMap((result) =>
      'issue' in result
        ? [kv.set(sentKey(clientId, result.id), JSON.stringify(result.issue), SENT_TTL_MS).catch(() => undefined)]
        : [],
    ),
  );
  const kept = results.filter((result) => 'issue' in result);
  // FRU-237: the notes this request planted. One kept by an earlier attempt is in the index already.
  const workspace = route.client?.workspace;
  if (workspace !== undefined && clientId !== undefined) {
    const entries = attributed.flatMap((note, index) => {
      const result = results[index];
      const issue = result !== undefined && 'issue' in result ? result.issue : undefined;

      return held[index] && issue !== undefined ? [noteEntry(workspace, clientId, note, channel, target, issue)] : [];
    });
    await indexed(noteIndex, (index) => index.record(entries, Date.now()));
    for (const [index, note] of attributed.entries()) {
      const result = results[index];
      if (held[index] && result !== undefined && 'issue' in result && result.issue !== undefined) {
        await verifiedNoteArrived(config, workspace, route.client?.origins?.[0], clientId, note, channel, result.issue);
      }
    }
  }
  await invalidatePages(
    kv,
    attributed.filter((_, index) => 'issue' in (results[index] as object)).map((note) => note.page.url),
  );

  // A guest gets no reference of the tracker (FRU-250).
  const answered = (await hidesTracker(request, config, route.policy))
    ? results.map((result) =>
        'issue' in result && result.issue !== undefined
          ? { ...result, issue: withoutTracker(result.issue, result.id) }
          : result,
      )
    : results;
  if (kept.length === 0) return json(502, { error: 'store-unavailable', results: answered }, corsHeaders);

  return json(kept.length === results.length ? 201 : 207, { results: answered }, corsHeaders);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** The stages a connector gives some states (FRU-102), read at this request. None when it cannot say. */
async function exceptionsOf(accounts: AccountStore | undefined, connector: string): Promise<StageExceptions> {
  if (accounts === undefined) return {};
  try {
    return (await accounts.sealedKey(connector))?.settings.stages ?? {};
  } catch (error) {
    console.error(
      `[fruitback] the settings of a connector did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return {};
  }
}

/** Whether a site draws its tracker's states in the tracker's colours (FRU-368). Off when it cannot say. */
async function trackerColoursOf(
  accounts: AccountStore | undefined,
  workspace: string | undefined,
  site: string | undefined,
): Promise<boolean> {
  if (accounts === undefined || workspace === undefined || site === undefined) return false;
  try {
    return (await accounts.siteTrackerColours(workspace, site)) === true;
  } catch (error) {
    console.error(
      `[fruitback] the colours of a site did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return false;
  }
}

/** The rows of the statuses of a site of a workspace, or none: a site of the environment has no row. */
async function statusesOfSite(
  accounts: AccountStore | undefined,
  workspace: string | undefined,
  site: string | undefined,
): Promise<SiteStatus[]> {
  if (accounts === undefined || workspace === undefined || site === undefined) return [];
  try {
    return (await accounts.siteStatuses(workspace, site)) ?? [];
  } catch (error) {
    console.error(
      `[fruitback] the statuses of a site did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return [];
  }
}

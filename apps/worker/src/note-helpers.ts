import { type Note, type NoteIssue, type NoteReporter, canonicalizePageUrl } from '@fruitback/shared';
import { MAX_BODY_BYTES } from './bounded-body.ts';
import { type ClientConfig, type ClientDestination, type ClientResolution, normalizeClientId } from './clients.ts';
import type { WorkerConfig } from './env.ts';
import { type Kv, KvError } from './kv.ts';
import { invalidate } from './cache.ts';
import { type Channel, type NoteEntry, type NoteIndex, authorOf } from './notes-index.ts';
import { maxBatch } from './rate-limit.ts';
import type { CreatedIssue } from './store.ts';

/**
 * What the routes of the notes share and that decides nothing of who calls (FRU-363): the place of a
 * note, what a guest reads of it, its row in the index, its page as the worker writes it, and the
 * answer to a route that names no client it may. Out of `app.ts`, which keeps every check of the
 * caller.
 */

/** The client as it routes when its notes go to this place, and not to its first one. */
export function placedAt(client: ClientConfig, place: ClientDestination): ClientConfig {
  const { teamId: _team, projectId: _project, ...rest } = client;

  return {
    ...rest,
    connector: place.connector,
    ...(place.teamId === undefined ? {} : { teamId: place.teamId }),
    ...(place.projectId === undefined ? {} : { projectId: place.projectId }),
  };
}

/**
 * A note as a guest reads it (FRU-250): no reference in the tracker, no address of the issue, and no
 * id of the tracker. Its handle is the id the widget gave the note, which is Fruitback's own.
 */
export function withoutTracker<
  T extends { id: string; identifier: string; url?: string; attachments?: NoteIssue['attachments'] },
>(issue: T, note: string): T {
  const { url: _url, attachments, ...rest } = issue;

  // The address of a file is the tracker's (FRU-331): a guest reads its name only.
  return {
    ...rest,
    ...(attachments === undefined ? {} : { attachments: attachments.map(({ name }) => ({ name })) }),
    id: note,
    identifier: note,
  } as T;
}

/**
 * Writes to the index of the notes, and never fails the request for it (FRU-237). The note is in its
 * store by then: a `502` would have the widget send it a second time. A row that is missing is
 * written again by the next read of its page.
 */
export async function indexed(index: NoteIndex | undefined, work: (index: NoteIndex) => Promise<void>): Promise<void> {
  if (index === undefined) return;
  try {
    await work(index);
  } catch (error) {
    console.error(
      `[fruitback] the index of the notes was not written: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The row of the index of one note this worker just planted. */
export function noteEntry(
  workspace: string,
  site: string,
  note: Note,
  channel: Channel,
  target: ClientConfig | undefined,
  issue: CreatedIssue,
): NoteEntry {
  return {
    workspace,
    site,
    note,
    channel,
    author: authorOf(note, channel === 'extension'),
    place: placeOf(target),
    issue: { identifier: issue.identifier, ...(issue.url === undefined ? {} : { url: issue.url }) },
    stage: 'new',
  };
}

/** Where a note of this target goes, as the index says it. */
export function placeOf(target: ClientConfig | undefined): NoteEntry['place'] {
  return target?.connector === undefined ? { kind: 'fruitback' } : { kind: 'connector', connector: target.connector };
}

/** Spread, so an absent reporter stays absent — the round-trip forbids a key nobody provided. */
export function optionalReporter(reporter: NoteReporter | undefined): { reporter?: NoteReporter } {
  return reporter === undefined ? {} : { reporter };
}

/** 400 when the caller has to say who they are, 403 when they said something they may not claim. */
export function routingFailure(
  resolution: Extract<ClientResolution, { ok: false }>,
  headers: Record<string, string>,
): Response {
  const status = resolution.reason === 'origin-not-allowed-for-client' ? 403 : 400;

  return json(status, { error: resolution.reason }, headers);
}

/**
 * Canonicalized server-side for the same reason the write path does it: the filter matches this
 * exact string inside the description, so a caller that skipped normalization would find nothing.
 */
export function canonicalizeRequestedPage(requested: string): string | null {
  try {
    const url = new URL(requested);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    return canonicalizePageUrl(url);
  } catch {
    return null;
  }
}

/**
 * Re-canonicalized server-side. The read path finds notes by matching this URL inside the
 * description, so a client that skipped normalization would plant a pin nobody can find again.
 *
 * The client id gets the same treatment and for the same reason: it becomes the `fruitback:<id>`
 * label the read filters on, so a padded id here means an issue nobody can query back.
 */
export function canonicalNote(note: Note): Note {
  const clientId = normalizeClientId(note.client?.id);

  return {
    ...note,
    page: { ...note.page, url: canonicalizePageUrl(note.page.url) },
    ...(note.client !== undefined && clientId !== undefined ? { client: { ...note.client, id: clientId } } : {}),
  };
}

/** The page just changed, so every cached answer for it is wrong, for every client. */
export async function invalidatePages(kv: Kv, urls: readonly string[]): Promise<void> {
  for (const url of new Set(urls)) {
    try {
      await invalidate(kv, url);
    } catch (error) {
      if (!(error instanceof KvError)) throw error;
      // The issue exists now. A 502 here tells the widget to retry, and the retry plants the note a
      // second time. The cost of answering 201 is a pin that shows up one TTL late.
      console.error(`[fruitback] cache not invalidated after a write: ${error.message}`);
    }
  }
}

/**
 * What a worker takes in one request (FRU-124), in the envelope of `GET /feedback` as `stages` is:
 * the most notes, and the most bytes of the body. Absent where the limit of a minute is too low for
 * a batch: the widget then sends its notes one by one, and never sends an array.
 */
export function batchOffer(config: WorkerConfig): { batch?: { max: number; maxBytes: number } } {
  const max = maxBatch(config.rateLimitPerMinute);

  return max === 0 ? {} : { batch: { max, maxBytes: MAX_BODY_BYTES } };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

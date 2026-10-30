import { MAX_ATTACHMENTS_PER_NOTE, MAX_ATTACHMENT_BYTES_PER_NOTE, type Note } from '@fruitback/shared';
import {
  ATTACHMENTS_PATH,
  type AttachmentStore,
  MAX_FILES_PER_MINUTE,
  MAX_HELD_BYTES,
  MAX_HELD_FILES,
  type OutgoingFile,
  TRANSIT_MS,
  admitFile,
  admitNote,
  attachmentIdOf,
  attachmentName,
  checkAttachment,
  isLegacyFileId,
  legacyFileOf,
  maxBytesFor,
  newAttachmentId,
  verifiesSignedRead,
} from './attachments.ts';
import { readBoundedBytes } from './bounded-body.ts';
import { type ClientConfig, normalizeClientId } from './clients.ts';
import type { Kv } from './kv.ts';
import { type FilesAnswer, type NoteStore, takesAttachments } from './store.ts';

/**
 * The routes of the files of the notes in transit (FRU-331), out of `app.ts` so that a review reads
 * every check of them in one file: who sends a file, who reads one, and what a note may take.
 * `app.ts` hands them what only it knows, for one request: see `AttachmentSeams`.
 */

/**
 * The account that writes in `workspace` for `site` with the token of this request, or `undefined`:
 * `writerIn` of `app.ts`, a member now with a session still valid in the store (FRU-238), and a
 * guest only on a site shared with them (FRU-250).
 */
export type Writer = (workspace: string, site: string | undefined) => Promise<string | undefined>;

/** What `app.ts` knows of one request to `/attachments`, and the routes of this file do not. */
export type AttachmentSeams = {
  /** Where the files wait: `undefined` on a worker with no database, which answers `404`. */
  files: AttachmentStore | undefined;
  /** The store of the notes of the request, which says whether a place takes files. */
  store: NoteStore;
  headers: Record<string, string>;
  /** What signs the read of a file. `undefined`: no read is signed, and every read answers `404`. */
  secretsKey: string | undefined;
  kv: () => Kv;
  /**
   * The route of `site`, as `routeFor` resolves it: its refusal as an answer, or the workspace of its
   * sessions and the place that the request chose (`chosenPlace`, `null` for a place refused).
   */
  route: (
    site: string | undefined,
  ) =>
    | { ok: false; response: Response }
    | { ok: true; workspace: string | undefined; place: () => Promise<ClientConfig | undefined | null> };
  writer: Writer;
};

/**
 * The files of the notes in transit (FRU-331): see `attachments.ts`.
 *
 * `POST /attachments?client=<site>&name=<name>[&destination=<place>]`, the bytes as the body and
 * their type in `Content-Type`: a session of the workspace of the site, whatever its role, keeps one
 * file for a note of that site, as `writerIn` says for a write. A guest sends one on a site shared
 * with them. Nobody else: `401`.
 *
 * - `409 attachments-not-taken` when the store of the place takes no file: the note stays in
 *   Fruitback (« Kept in Fruitback »), or goes to GitHub, whose API takes none.
 * - `413` over the limit of the kind of the file (`MAX_ATTACHMENT_BYTES`), `400 type-mismatch` for
 *   bytes that are not what the type says, `400 empty-file`.
 * - `429 transit-full` when the account already holds `MAX_HELD_FILES` or `MAX_HELD_BYTES`.
 *
 * `GET /attachments/<id>?expires=…&signature=…` is the read of the receiver of a delivery of a REST
 * connector, and the one read of a file there is: a signature of this worker that has not ended, or
 * `404`, as for a file that does not exist. No CORS header, a download, and nothing a browser runs.
 * There is no read for a member, a guest or a page: **Fruitback serves no file to a person**.
 */
export async function handleAttachment(request: Request, pathname: string, seams: AttachmentSeams): Promise<Response> {
  const { files, store, headers } = seams;
  if (files === undefined) return json(404, { error: 'not-found' }, headers);
  const now = Date.now();

  if (pathname !== ATTACHMENTS_PATH) {
    const id = attachmentIdOf(pathname);
    if (id === undefined) return json(404, { error: 'not-found' }, headers);
    if (request.method !== 'GET') return json(405, { error: 'method-not-allowed' }, headers);
    // No CORS header on any answer of this read: no page of any origin reads the bytes.
    const query = new URL(request.url).searchParams;
    if (seams.secretsKey === undefined || !verifiesSignedRead(seams.secretsKey, id, query, now))
      return json(404, { error: 'not-found' });
    const found = await files.get(id, now);
    // A file that no note took is no file of a delivery. A picture of before FRU-331 (`shot_`) is
    // named by the note of its delivery, not taken: the signature of that delivery is its proof.
    if (found === undefined || (found.note === undefined && !isLegacyFileId(found.id)))
      return json(404, { error: 'not-found' });

    return new Response(found.content, {
      status: 200,
      headers: {
        'Content-Type': found.type,
        'Content-Length': String(found.content.byteLength),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  }

  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  const params = new URL(request.url).searchParams;
  const site = normalizeClientId(params.get('client'));
  const route = seams.route(site);
  if (!route.ok) return route.response;
  const { workspace } = route;
  // A write: a member of the workspace, with a session read again in the store (FRU-238).
  const account = workspace === undefined ? undefined : await seams.writer(workspace, site);
  if (workspace === undefined || account === undefined || site === undefined)
    return json(401, { error: 'identity-required' }, headers);

  const target = await route.place();
  if (target === null) return json(403, { error: 'destination-not-allowed' }, headers);
  if (!(await takesAttachments(store, target))) return json(409, { error: 'attachments-not-taken' }, headers);

  const declared = request.headers.get('Content-Type');
  const maxBytes = maxBytesFor(declared);
  const body = await readBoundedBytes(request, maxBytes);
  if (body === null) return json(413, { error: 'payload-too-large', maxBytes }, headers);
  const checked = checkAttachment(declared, body);
  if (!checked.ok) return json(400, { error: checked.error }, headers);

  // The limits of the person (FRU-331): files a minute for the session, files and bytes in transit.
  const refused = await admitFile(files, seams.kv(), account, body.byteLength, now);
  if (refused === 'files-per-minute')
    return json(429, { error: 'rate-limited', maxFilesPerMinute: MAX_FILES_PER_MINUTE }, headers);
  if (refused === 'transit-full')
    return json(429, { error: 'transit-full', maxFiles: MAX_HELD_FILES, maxBytes: MAX_HELD_BYTES }, headers);

  const id = newAttachmentId();
  const name = attachmentName(params.get('name'));
  const expiresAt = now + TRANSIT_MS;
  await files.put({
    id,
    workspace,
    account,
    site,
    name,
    type: checked.type,
    content: body,
    createdAt: now,
    expiresAt,
  });
  // The files whose transit ended go with the next one that comes: a worker that receives files sweeps.
  await files
    .sweep(now)
    .catch((error: unknown) => console.error('[fruitback] the files in transit were not swept', error));

  return json(
    201,
    { id, name, type: checked.type, size: body.byteLength, expiresAt: new Date(expiresAt).toISOString() },
    headers,
  );
}

/** What a note of `POST /feedback` needs to take its files: the store of the files, and who writes. */
export type NoteFileSeams = {
  files: AttachmentStore | undefined;
  /** The store of the notes of the request, which says whether a place takes files. */
  store: NoteStore;
  /** `undefined` when the request has no context to read a session in: nobody writes then. */
  writer: Writer | undefined;
};

/**
 * The files that a note names, given to it (FRU-331), or the answer that refuses the note.
 *
 * - `409 attachments-not-taken`: the store of the place takes no file.
 * - `401`: only the session that sent the files names them, as a write (`writerIn`).
 * - `410 attachment-gone`: a file is not one this person sent for this site, or its transit ended,
 *   or another note took it. `ids` says which: the widget keeps the note and its text, and the
 *   person sends it again without them.
 * - `413`: the files of one note are over `MAX_ATTACHMENT_BYTES_PER_NOTE` together.
 *
 * Nothing is written before every file is checked: a refusal leaves the files where they were.
 * `workspace` is the one of the client that the route of the note resolved.
 */
export async function takeFiles(
  seams: NoteFileSeams,
  target: ClientConfig | undefined,
  workspace: string | undefined,
  note: string,
  site: string | undefined,
  ids: readonly string[],
): Promise<
  | { ok: true; store: AttachmentStore; files: OutgoingFile[] }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const { files, store, writer } = seams;
  if (files === undefined || !(await takesAttachments(store, target))) {
    return { ok: false, status: 409, body: { error: 'attachments-not-taken' } };
  }
  const account = workspace === undefined || writer === undefined ? undefined : await writer(workspace, site);
  if (account === undefined || site === undefined) {
    return { ok: false, status: 401, body: { error: 'identity-required' } };
  }

  const now = Date.now();
  const found = await Promise.all(ids.map((id) => files.get(id, now)));
  const gone = ids.filter((id, index) => {
    const file = found[index];

    return (
      file === undefined ||
      file.account !== account ||
      file.workspace !== workspace ||
      // A picture of before FRU-250 names no site: its workspace and its sender decide.
      (file.site !== '' && file.site !== site) ||
      (file.note !== undefined && file.note !== note)
    );
  });
  if (gone.length > 0) return { ok: false, status: 410, body: { error: 'attachment-gone', ids: gone } };
  const admitted = admitNote(found.map((file) => file?.content.byteLength ?? 0));
  if (admitted === 'too-many-files') {
    return { ok: false, status: 400, body: { error: 'invalid-attachments', max: MAX_ATTACHMENTS_PER_NOTE } };
  }
  if (admitted === 'too-large') {
    return { ok: false, status: 413, body: { error: 'payload-too-large', maxBytes: MAX_ATTACHMENT_BYTES_PER_NOTE } };
  }

  const claimed = await files.claim(ids, note, now);
  // Another note took one between the read and the claim: none is sent, and the note is refused.
  if (claimed.length !== ids.length) {
    const kept = new Set(claimed.map((file) => file.id));

    return { ok: false, status: 410, body: { error: 'attachment-gone', ids: ids.filter((id) => !kept.has(id)) } };
  }

  return {
    ok: true,
    store: files,
    files: claimed.map((file) => ({ id: file.id, name: file.name, type: file.type, content: file.content })),
  };
}

/**
 * The picture of before FRU-331 that a note names, when it is still in transit and this note may take
 * it (its sender, its workspace, a store that takes files), or `undefined`. Never a refusal: a note
 * whose picture is gone goes without it, as it would have before. `notTaken: 'no-tracker'`: the
 * note names a picture and the place of the note takes no file (a note kept in Fruitback, GitHub):
 * the answer says why the picture is not joined, as `canAttach: false` says it on a read.
 */
export async function legacyAttachment(
  seams: NoteFileSeams,
  target: ClientConfig | undefined,
  workspace: string | undefined,
  note: Note,
  named: readonly string[],
): Promise<{ id?: string; notTaken?: 'no-tracker' } | undefined> {
  const { files, store, writer } = seams;
  const id = legacyFileOf(note);
  if (id === undefined || named.includes(id) || named.length >= MAX_ATTACHMENTS_PER_NOTE) return undefined;
  if (!(await takesAttachments(store, target))) return { notTaken: 'no-tracker' };
  if (files === undefined || writer === undefined || workspace === undefined) return undefined;
  const found = await files.get(id, Date.now());
  if (found === undefined || found.workspace !== workspace) return undefined;
  if (found.note !== undefined && found.note !== note.id) return undefined;
  const account = await writer(workspace, note.client?.id);

  return account === found.account ? { id } : undefined;
}

/**
 * Removes from the transit the files that the tracker has, or refused, and answers how many of each
 * (FRU-331). A store that said nothing of them sent none: they are lost, and removed too.
 */
export async function settleFiles(
  files: AttachmentStore,
  sent: readonly OutgoingFile[],
  answer: FilesAnswer | undefined,
): Promise<{ sent: number; lost: number; waiting: number }> {
  const outcome = answer ?? { sent: [], lost: sent.map((file) => file.id), waiting: [] };
  try {
    await files.remove([...outcome.sent, ...outcome.lost]);
  } catch (error) {
    // The note is written. A file that stays goes at the end of its transit.
    console.error('[fruitback] files of a written note were not removed from the transit', error);
  }

  return { sent: outcome.sent.length, lost: outcome.lost.length, waiting: outcome.waiting.length };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

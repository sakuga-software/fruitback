import { readJsonObject } from './bounded-body.ts';
import { json } from './http.ts';
import type { NotesContext } from './console-notes.ts';
import { type ReplyOutcome, refusedReply } from './reply-routes.ts';
import { REPLY_LENGTH } from './reply-text.ts';
import type { NewReply, ReplyAuthor } from './store.ts';

/** Writes a reply under a note of a page, by the way of a reply of the widget (`writeReply`). */
export type ReplyToNote = (workspace: string, site: string, note: string, reply: NewReply) => Promise<ReplyOutcome>;

/** A person of the console, as a reply names them: their account, in this workspace. */
export type Replier = Extract<ReplyAuthor, { kind: 'member' }>;

/** `POST …/notes/<note>/replies` (FRU-712). */
export const CONSOLE_REPLY_PATH = /^\/notes\/([A-Za-z0-9_-]+)\/replies$/;

/**
 * `POST /console/workspaces/<id>/notes/<note>/replies` with `{ body }` (FRU-712): a reply under a note,
 * from its panel in the console, in the name of the person signed in.
 *
 * - **Who.** Whoever reads the note in the console (`read-feedback`, every role): a member of the
 *   workspace on any site, a guest only on a site shared with them (FRU-250). Anybody else, and any
 *   note of another site, is `404`, as the read of the note. The cookie, the `Origin`, the account and
 *   a suspended workspace are checked before this, as for every write of the console.
 * - **In whose name.** Their account, as the widget names a session of the workspace (FRU-257): the
 *   name of the account, or its address. A name in the body is not read. A visitor never comes here:
 *   a visitor has no account.
 * - **Where.** The way of a reply of the widget: the store of the note, and so its tracker (Linear,
 *   GitHub…) or the store of the worker. There is no second way to send a reply.
 * - **Which notes.** A note of a page whose site shows its replies, in a store that takes them. A task
 *   written by hand is in no thread: `403 replies-not-taken`, as `reply_to_note` of `/mcp`.
 *
 * `201 { comment }`, the reply as the page reads it. A refusal writes nothing, and the console keeps
 * the text.
 */
export async function postConsoleReply(
  id: string,
  request: Request,
  context: NotesContext,
  noteKeyOf: (id: string) => { site: string; note: string } | undefined,
): Promise<Response> {
  const { headers } = context;
  if (request.method !== 'POST') return json(405, { error: 'method-not-allowed' }, headers);
  if (!context.allowed('read-feedback')) return json(403, { error: 'forbidden' }, headers);
  const note = noteKeyOf(id);
  if (note === undefined || context.replyToNote === undefined) return json(404, { error: 'not-found' }, headers);
  // A guest replies only in the sites shared with them (FRU-250); a note of any other site is none.
  const reach = await context.reach();
  if (reach === undefined || (reach.sites !== 'every' && !reach.sites.includes(note.site))) {
    return json(404, { error: 'not-found' }, headers);
  }
  const body = (await readJsonObject(request))?.body;
  if (typeof body !== 'string' || body.trim() === '' || [...body].length > REPLY_LENGTH) {
    return json(400, { error: 'invalid-reply', maxLength: REPLY_LENGTH }, headers);
  }
  // Read now: a person who left the workspace a second ago is refused, as by the widget.
  const author = await context.replier?.();
  if (author === undefined) return json(404, { error: 'not-found' }, headers);

  const written = await context.replyToNote(context.workspace, note.site, note.note, { body, author });

  return written.ok ? json(201, { comment: written.comment }, headers) : refusedReply(written.error, headers);
}

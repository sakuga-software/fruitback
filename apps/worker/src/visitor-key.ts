import { createHash } from 'node:crypto';
import type { ClientConfig } from './clients.ts';

/**
 * The key of a browser (FRU-700): how the worker knows a visitor with no account as the author of
 * their notes, on the same browser.
 *
 * - **The widget makes the key**, 32 random bytes, at the first note a visitor sends on a site. It
 *   keeps it in the `localStorage` of the page, under the id of the site, and sends it in
 *   `VISITOR_HEADER` with each call to the worker.
 * - **The worker keeps a digest of it, never the key**: `visitorDigestOf`, in `note_index.author_visitor`,
 *   for a note of a visitor only. The digest names the site too, so one key gives another digest on
 *   each site, and a key of one site opens nothing on another.
 * - **A key is not a proof of who somebody is.** Whoever holds the storage of the page holds the key.
 *   It opens only the notes that this browser left on this site. A key that is absent, or not of the
 *   shape the widget makes, is no key: no digest, and nothing is opened.
 */

/** The header of the key. Not CORS-safelisted: `cors.ts` lists it, or a browser would refuse the call. */
export const VISITOR_HEADER = 'X-Fruitback-Visitor';

/** A key as the widget makes it: 32 bytes in base64url, with no padding. Anything else is no key. */
const KEY = /^[A-Za-z0-9_-]{43}$/u;

/** What `NoteIndex.authors` answers for a note of a visitor: this prefix, then its digest. */
export const VISITOR_AUTHOR_PREFIX = 'visitor:';

/**
 * The digest of the key of this request, for `site`, or `undefined` with no site or no key of the
 * right shape. SHA-256 with no salt of its own: a key is 256 random bits, so no list of guesses
 * finds it, and the same key must give the same digest at each request.
 */
export function visitorDigestOf(request: Request, site: string | undefined): string | undefined {
  if (site === undefined || site === '') return undefined;
  const key = request.headers.get(VISITOR_HEADER);
  if (key === null || !KEY.test(key)) return undefined;

  return createHash('sha256').update(`fruitback-visitor\n${site}\n${key}`).digest('base64url');
}

/** The author of a note of a visitor, as `NoteIndex.authors` names it and a route compares it. */
export function visitorAuthor(digest: string): string {
  return `${VISITOR_AUTHOR_PREFIX}${digest}`;
}

/** What a visitor known by their browser does on a note of theirs (FRU-701, FRU-702). */
export type VisitorAction = 'edit' | 'withdraw';

/**
 * Whether a visitor known by their browser may `action` a note of theirs on this site (FRU-701,
 * FRU-702): the setting of the site in the tab « Access » of the console (FRU-703), `visitorEdit`
 * for an edit and `visitorDelete` for a withdrawal. `while-open` lets them, while the note is open
 * (the routes read the stage, `EDITABLE_STAGES`); `never`, or nothing, does not. `clientOf` gives the
 * two only to a site that takes the notes of anybody, so a site of members, a client of
 * `FRUITBACK_CLIENTS` and a site that closed its notes let no visitor do anything.
 *
 * Only `app.ts` imports it, as `visitorDigestOf`: the routes call it as `visitorMay` of `CallerChecks`.
 */
export function visitorMay(
  client: Pick<ClientConfig, 'visitorEdit' | 'visitorDelete'> | undefined,
  action: VisitorAction,
): boolean {
  return (action === 'edit' ? client?.visitorEdit : client?.visitorDelete) === 'while-open';
}

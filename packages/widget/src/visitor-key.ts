/**
 * The key of this browser for one site (FRU-700): how the worker knows a visitor with no account as
 * the author of their notes, on the same browser.
 *
 * - **Made at the first note a visitor sends**, 32 random bytes, and kept in the `localStorage` of the
 *   page under the id of the site. A reader who never sent a note has none, and sends none.
 * - **Sent with each call once it exists**, in `VISITOR_HEADER`: the worker keeps a digest of it
 *   with each note, and says `mine` to a read that sends the same key.
 * - **Not a proof of who somebody is.** Any script of the page reads it. It only tells this
 *   browser's notes from the others. The worker decides what it opens, never the widget.
 * - A storage that the browser refuses keeps the key in memory: the notes of this page are known
 *   until it is closed.
 * - `embed.ts` makes none for a mount whose host names the reporter (`identityToken`) or carries the
 *   calls (`transport`, the extension): the worker knows those readers another way.
 */

/** The header the worker reads (`apps/worker/src/visitor-key.ts`). */
export const VISITOR_HEADER = 'X-Fruitback-Visitor';

/** The key in `localStorage`, beside the preferences of the widget, then the id of the site. */
export const VISITOR_KEY_PREFIX = 'fruitback:visitor:';

/** A key as this file makes it, and as the worker takes it: 32 bytes in base64url, no padding. */
const KEY = /^[A-Za-z0-9_-]{43}$/u;

export type VisitorKey = {
  /** The key of this browser for the site, or `undefined` before its first note. */
  current(): string | undefined;
  /** The key, made and kept first when there is none: before a note is sent. */
  ensure(): string;
};

/** 32 random bytes, in base64url with no padding: 43 characters. */
function newKey(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>): string {
  const bytes = random(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * The key of `site`, in `area` (the `localStorage` of the page), or in memory when the browser
 * refuses it. A stored value of another shape is no key: a new one takes its place at the next note.
 */
export function createVisitorKey(
  area: Storage | null,
  site: string,
  random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer> = (bytes) => crypto.getRandomValues(bytes),
): VisitorKey {
  const name = `${VISITOR_KEY_PREFIX}${site}`;
  let memory: string | undefined;
  const read = (): string | undefined => {
    let stored: string | null | undefined;
    try {
      stored = area?.getItem(name);
    } catch {
      stored = undefined;
    }
    if (typeof stored === 'string' && KEY.test(stored)) return stored;

    return memory;
  };

  return {
    current: read,
    ensure() {
      const known = read();
      if (known !== undefined) return known;
      const made = newKey(random);
      memory = made;
      try {
        area?.setItem(name, made);
      } catch {
        // A full or refused storage keeps the key for this page only.
      }

      return made;
    },
  };
}

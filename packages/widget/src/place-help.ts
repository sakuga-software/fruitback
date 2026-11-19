/**
 * What to do about a place of the site that its tracker no longer has (FRU-640), as the worker says
 * it in a `502` whose `error` is `destination-unavailable`.
 *
 * - `member`: the writer is a member of the workspace, and `url` is the page of the site in the
 *   console, where a member chooses another place.
 * - `visitor`: any other writer, and `url` is a page of help for the person who writes.
 */
export type PlaceHelp = { url: string; for: 'member' | 'visitor' };

/** The `error` of the `502` that says the place of the note is gone. */
export const PLACE_GONE_ERROR = 'destination-unavailable';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The help of an answer, or `undefined`. The widget opens the address in a new tab, so only an
 * `https:` address is taken, and `http:` on a local host for development.
 */
export function placeHelpOf(body: string): PlaceHelp | undefined {
  let answer: unknown;
  try {
    answer = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { error, help, for: reader } = answer as { error?: unknown; help?: unknown; for?: unknown };
  if (error !== PLACE_GONE_ERROR || typeof help !== 'string') return undefined;
  if (!isOpenable(help)) return undefined;

  return { url: new URL(help).href, for: reader === 'member' ? 'member' : 'visitor' };
}

function isOpenable(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.username !== '' || url.password !== '') return false;

    return url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

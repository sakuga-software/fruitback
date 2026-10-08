import { normalizeWorkerEndpoint } from './endpoint.ts';

/**
 * A pairing link, read from the address of the tab the popup was opened on (FRU-92).
 *
 * The link is `<worker>/pair#<code>`. The popup reads it, a trusted context: no content script runs
 * on the worker's page, and the code does not go through the page's own JavaScript.
 *
 * **Any page can have an address of this shape.** So the worker a link names is the page it is on,
 * and never a value the address carries: a page can make the popup offer a pairing with itself, and
 * with no other worker. The popup names that worker, and pairs only on a click.
 */

export type PairLink = { endpoint: string; code: string };

/** The path the worker serves its pairing page on. `pair-link.test.ts` holds it to the worker's. */
export const PAIR_PATH = '/pair';

/** Groups of four, as the worker writes a code. The worker decides whether the code is good. */
const CODE_SHAPE = /^[0-9A-Z]{4}(?:-[0-9A-Z]{4})+$/;

export function parsePairLink(url: string | undefined): PairLink | undefined {
  if (url === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  // A credential in the address is not a deployment anybody runs, and it would go into the endpoint.
  if (parsed.username !== '' || parsed.password !== '') return undefined;
  if (!parsed.pathname.endsWith(PAIR_PATH)) return undefined;

  const code = parsed.hash.slice(1);
  if (!CODE_SHAPE.test(code)) return undefined;

  // The path before `/pair` is kept: a worker behind `https://example.com/fruitback` is an ordinary
  // deployment, and the session is stored under the endpoint the rules name.
  const base = `${parsed.origin}${parsed.pathname.slice(0, -PAIR_PATH.length)}`;

  return { endpoint: normalizeWorkerEndpoint(base), code };
}

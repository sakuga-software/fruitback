/**
 * Where a sign-in with a provider comes back to, when it started on « Connect this browser »
 * (FRU-240). The worker brings the console back to its root after the provider, with no path of
 * return (it has no open redirect to defend), so the page keeps the id of the request in this tab,
 * and the front door takes it once.
 *
 * The id is public: it is in the address of the page the extension opened. No token is kept here.
 * It is kept for the fifteen minutes a request lives, and the tab forgets it when it closes.
 */
const KEY = 'fruitback:connect';
const LIVES_MS = 15 * 60 * 1000;
/** The ids of the worker are base64url: anything else is not a request, and is not followed. */
const REQUEST = /^[\w-]{1,64}$/;

type Kept = { request: string; until: number };

function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    // A browser that refuses storage: the sign-in comes back to the root, as before.
    return undefined;
  }
}

/** Keeps the request before the page leaves for a provider. */
export function keepConnect(request: string, now = Date.now()): void {
  if (!REQUEST.test(request)) return;
  try {
    storage()?.setItem(KEY, JSON.stringify({ request, until: now + LIVES_MS } satisfies Kept));
  } catch {
    // Full or refused: the sign-in comes back to the root.
  }
}

/** The request to go back to, once: it is forgotten as it is read. */
export function takeConnect(now = Date.now()): string | undefined {
  const kept = storage();
  const value = kept?.getItem(KEY) ?? null;
  if (value === null) return undefined;
  kept?.removeItem(KEY);
  try {
    const read = JSON.parse(value) as Partial<Kept>;
    if (typeof read.request !== 'string' || !REQUEST.test(read.request)) return undefined;
    if (typeof read.until !== 'number' || read.until < now) return undefined;

    return read.request;
  } catch {
    return undefined;
  }
}

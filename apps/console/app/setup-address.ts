import { siteAddress } from './site-address.ts';

/**
 * The address of a site that comes with a visit of the setup (FRU-635, board S1): the landing sends
 * `/setup?site=staging.acme.dev`, and the setup adds that site once the person is signed in.
 *
 * A sign-in with a provider brings the browser back to the root of the console, with no path of
 * return (FRU-240), and the front door sends a person with no site to `/setup` with no query. So the
 * address is kept in this tab for an hour, as `connect-return.ts` keeps a request, and forgotten
 * when the site is added. The address is public: it is in the link the person opened.
 */
const KEY = 'fruitback:setup-site';
const LIVES_MS = 60 * 60 * 1000;

type Kept = { address: string; until: number };

function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    // A browser that refuses storage: the address lives only in the address bar.
    return undefined;
  }
}

/**
 * The address of the site of this visit: the one of `?site=`, read as the form reads a typed
 * address and kept, or the one kept before the sign-in. `undefined` for none, or for an address that
 * cannot be one: the setup then asks for it, as before.
 */
export function setupAddress(search: URLSearchParams, now = Date.now()): string | undefined {
  const given = search.get('site');
  const address = given === null ? undefined : siteAddress(given);
  if (address !== undefined) {
    try {
      storage()?.setItem(KEY, JSON.stringify({ address, until: now + LIVES_MS } satisfies Kept));
    } catch {
      // Full or refused: the address lives only in the address bar.
    }

    return address;
  }

  return kept(now);
}

/** Forgets the kept address: its site was added, or the setup is past it. */
export function forgetSetupAddress(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    // Nothing kept, or nothing to forget.
  }
}

function kept(now: number): string | undefined {
  try {
    const value = storage()?.getItem(KEY) ?? null;
    if (value === null) return undefined;
    const read = JSON.parse(value) as Partial<Kept>;
    if (typeof read.until !== 'number' || read.until < now || typeof read.address !== 'string') return undefined;

    // Read again as an address: what a storage holds is not trusted more than the address bar.
    return siteAddress(read.address);
  } catch {
    return undefined;
  }
}

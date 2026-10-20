/**
 * What differs from one instance of the console to another (FRU-222): the address of its worker.
 *
 * The image of the console is one image for every instance, so the address cannot be in the bundle.
 * The container writes `/config.js` when it starts, the page loads it before the bundle, and it
 * sets `globalThis.__FRUITBACK__`. A console that is built for one worker (the Cloud, built by
 * Dokploy with `VITE_FRUITBACK_API`) keeps the address of its build when the file sets nothing.
 *
 * WARNING: nothing secret goes in that file. Every visitor of the sign-in screen reads it.
 */

/** Where a worker answers in development, when nothing says otherwise. */
export const DEVELOPMENT_API = 'http://localhost:8788';

/**
 * The address of the worker: what the container wrote, or what the build holds, or the worker of
 * `pnpm dev`. With no slash at its end, so that a path can follow it.
 */
export function apiFrom(written: unknown, built: string | undefined): string {
  const atStart = (written as { api?: unknown } | null | undefined)?.api;
  const chosen =
    typeof atStart === 'string' && atStart.trim() !== '' ? atStart.trim() : built?.trim() || DEVELOPMENT_API;

  return chosen.replace(/\/+$/, '');
}

/**
 * Whether « Connect this browser » leads to the sign-in of the popup (FRU-313), rather than to a
 * pairing code. The extension of the store signs in to Fruitback Cloud alone (`WXT_FRUITBACK_CLOUD`):
 * on a console of the Cloud the popup gives the session of the account, as « Sign in to Fruitback »
 * does anywhere. A self-hosted console keeps the pairing link of its worker, which that extension
 * cannot sign in to.
 */
export function connectsBySignIn(api: string): boolean {
  return instanceOf(api).cloud;
}

/** The host of the worker of Fruitback Cloud. */
export const CLOUD_API_HOST = 'api.fruitback.com';

/**
 * The host of the worker at `api`, and whether it is Fruitback Cloud (FRU-262). The build holds no
 * flag for the Cloud, and the console knows its worker before any read: so the host decides.
 */
export function instanceOf(api: string): { host: string; cloud: boolean } {
  let host: string;
  try {
    host = new URL(api).host;
  } catch {
    host = api;
  }

  return { host, cloud: host === CLOUD_API_HOST };
}

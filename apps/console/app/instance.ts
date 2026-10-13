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

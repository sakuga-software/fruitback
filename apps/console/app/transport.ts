/**
 * The way to the worker (FRU-99): its address, a bound on each call, and whether it answers.
 *
 * Every request of the console goes through `reach`, with the cookie of the worker
 * (`credentials: 'include'`): the cookie of a session of better-auth (FRU-148).
 */

import { apiFrom } from './instance.ts';

/** Where the worker answers: see `instance.ts`. Read once, when the bundle starts. */
export const API = apiFrom(
  (globalThis as { __FRUITBACK__?: unknown }).__FRUITBACK__,
  import.meta.env?.VITE_FRUITBACK_API as string | undefined,
);

/**
 * A worker that never answers must not hold a screen: every call stops after this long.
 */
const CALL_TIMEOUT_MS = 15_000;

/** What a call answers when the worker did not: no network, no name, no answer in time. */
export const UNREACHABLE = { ok: false, status: 0, error: 'unreachable' } as const;

type ReachListener = (reachable: boolean) => void;
const reachListeners = new Set<ReachListener>();
let reachable = true;

/** Tells the listener each time the worker stops or starts to answer. Returns how to stop. */
export function onReachability(listener: ReachListener): () => void {
  reachListeners.add(listener);
  listener(reachable);

  return () => void reachListeners.delete(listener);
}

function reached(now: boolean): void {
  if (now === reachable) return;
  reachable = now;
  for (const listener of reachListeners) listener(now);
}

/**
 * A request that answered, or `undefined`. WARNING: this must not reject. A caller that awaits a
 * rejected call sets no state, and its screen says "Loading…" until the tab closes.
 */
export async function reach(path: string, init: RequestInit): Promise<Response | undefined> {
  try {
    const response = await fetch(`${API}${path}`, {
      ...init,
      credentials: 'include',
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    reached(true);

    return response;
  } catch {
    reached(false);

    return undefined;
  }
}

import { endpointsOfNewEpochs } from './session-storage.ts';

/**
 * What the background does to the previews a worker listed when the session of that worker starts
 * or ends (FRU-103).
 *
 * A list is the answer of a worker to one session. A pairing and a logout each mint an epoch, and
 * nothing else does: on either, the list of that worker is forgotten at once, and every paired
 * worker is asked again. Without this, an account of another workspace that pairs with the same
 * worker would get the wildcard of the first, with its own session, for two hours at most.
 *
 * Here and not in `background.ts`, so that a test drives it with the sessions and the storage the
 * background uses: see `session-previews.test.ts`.
 */
export type SessionPreviewsSeams = {
  /** Forgets what one worker listed. */
  forget: (endpoint: string) => Promise<void>;
  /** Asks the paired workers again, and registers what that leaves. */
  ask: () => Promise<void>;
  report?: (error: unknown) => void;
};

/** The handler of a change of `storage.local`, given the keys that changed. */
export function createSessionPreviews({ forget, ask, report }: SessionPreviewsSeams) {
  return async (changedKeys: readonly string[]): Promise<void> => {
    const ended = endpointsOfNewEpochs(changedKeys);
    if (ended.length === 0) return;

    try {
      await Promise.all(ended.map((endpoint) => forget(endpoint)));
    } catch (error) {
      // Asked again all the same: an answer of the session there is now replaces the list.
      report?.(error);
    }
    await ask();
  };
}

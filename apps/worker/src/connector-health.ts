import type { AccountStore, ConnectorTrouble } from './accounts.ts';
import { LinearKeyForbidden, LinearKeyRefused } from './linear.ts';
import { LinearConnectionEnded } from './linear-oauth.ts';
import type { SeedStore } from './store.ts';

/**
 * Whether a connector works, as its tracker last said (FRU-102).
 *
 * A key that the tracker refuses was a `502` for the widget and nothing for anybody else: the error
 * was thrown, then lost, and the console said « Working » from a constant. Here the refusal is kept
 * on the connector, and the console says « Needs attention » with what to do.
 *
 * **Only a refusal is trouble.** A tracker that is down or slow answers `502` too, and it is not
 * kept: nobody of the workspace can do anything about it, and it ends alone.
 */
export function troubleOf(error: unknown): ConnectorTrouble | undefined {
  if (error instanceof LinearKeyRefused) return 'key-refused';
  if (error instanceof LinearKeyForbidden) return 'key-lacks-access';
  if (error instanceof LinearConnectionEnded) return 'connection-ended';

  return undefined;
}

/**
 * Keeps what a call to the tracker of a connector said. `error` absent: the tracker answered.
 *
 * WARNING: this never rejects. The call to the tracker is over when this runs, and its answer is the
 * one the caller gets. A note that was created and then answered with an error is sent again by the
 * widget, and kept twice.
 */
export async function noteConnectorCall(
  accounts: AccountStore,
  connector: string,
  error: unknown,
  now: () => number = Date.now,
): Promise<void> {
  const trouble = error === undefined ? undefined : troubleOf(error);
  // An error that is no refusal says nothing of the key: the state of the connector stays as it is.
  if (error !== undefined && trouble === undefined) return;

  try {
    await accounts.noteConnector(connector, trouble, now());
  } catch (failure) {
    console.error('[fruitback] the state of a connector was not kept', connector, failure);
  }
}

/**
 * The store of a request, with each call through a connector noted on that connector.
 *
 * A client with no connector uses the worker's own store, and nothing is noted for it. With no
 * accounts there is no connector at all, and the store is answered as it is.
 */
export function watchedStore(
  store: SeedStore,
  accounts: AccountStore | undefined,
  now: () => number = Date.now,
): SeedStore {
  if (accounts === undefined) return store;

  async function watched<T>(connector: string | undefined, call: () => Promise<T>): Promise<T> {
    if (connector === undefined) return call();

    let answer: T;
    try {
      answer = await call();
    } catch (error) {
      await noteConnectorCall(accounts as AccountStore, connector, error, now);
      throw error;
    }
    await noteConnectorCall(accounts as AccountStore, connector, undefined, now);

    return answer;
  }

  return {
    ...store,
    create: (seed, client, policy) => watched(client?.connector, () => store.create(seed, client, policy)),
    findForPage: (query, client, policy) => watched(client?.connector, () => store.findForPage(query, client, policy)),
  };
}

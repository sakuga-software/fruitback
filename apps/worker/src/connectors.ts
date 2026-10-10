import type { AccountStore, ConnectorKind } from './accounts.ts';
import type { ClientConfig } from './clients.ts';
import { createLinearStore } from './linear.ts';
import { deliveryBody } from './rest-connector.ts';
import { type LinearOAuth, linearAuthorization } from './linear-oauth.ts';
import { type SeedStore, StoreError } from './store.ts';

/**
 * The store of a request on a worker whose workspaces connect their own trackers (FRU-121).
 *
 * A site with no destination keeps its notes in the worker's own store, as before. A site with one
 * sends them through the connector of its workspace: the client entry `clientOf` made carries the
 * connector and the team, and the Linear store already routes by the team of the client.
 *
 * **A connector that cannot be used is a store that is down**, never a fall back to the worker's own
 * store: a note written there would be invisible to the team that reads its tracker. The widget keeps
 * the note and tries again (`502 store-unavailable`).
 */
const TRACKERS: Record<Exclude<ConnectorKind, 'rest'>, (apiKey: string) => SeedStore> = {
  // The team is the client's. This default is never read for a client that has a destination.
  linear: (apiKey) => createLinearStore({ apiKey, teamId: 'no-team', projectId: undefined }),
};

/** `own` is the worker's own store: a connector that only receives keeps its notes there. */
export type ConnectorStores = (connector: string, workspace: string | undefined, own: SeedStore) => Promise<SeedStore>;

/**
 * The store of a site whose connector is an address that receives (FRU-122).
 *
 * It is the worker's own store, and each note that is kept is also put in the queue of deliveries.
 *
 * WARNING: the note is kept first, and a queue that refuses the row does not fail the request. The
 * note exists, and a failure here would make the widget send it again and keep it twice. The cost
 * is a note that is kept and never sent, which is logged.
 */
function receivingStore(own: SeedStore, accounts: AccountStore, connector: string, now: () => number): SeedStore {
  return {
    ...own,
    async create(seed, client, policy) {
      const created = await own.create(seed, client, policy);
      try {
        await accounts.enqueueDelivery(
          connector,
          deliveryBody({
            workspace: client?.workspace ?? '',
            site: {
              id: seed.client?.id ?? '',
              ...(client?.origins?.[0] === undefined ? {} : { origin: client.origins[0] }),
            },
            identifier: created.identifier,
            seed,
          }),
          now(),
        );
      } catch (error) {
        console.error('[fruitback] a note was kept and its delivery was not queued', created.identifier, error);
      }

      return created;
    },
  };
}

/**
 * The store of a connector, built for the request that asks for it, from the row as it is now.
 *
 * **Nothing is kept between two requests** (FRU-102). A map of the stores was here, and a map of
 * these maps in `app.ts`, by the object of the accounts. A request makes a new object of the
 * accounts, so the second map never found anything: each request built its store, and the comment
 * said the opposite. A cache that worked would hold the key of each tracker in the clear for the
 * life of the process, a connector that was removed included. The key is opened at each request, the
 * store of Linear holds no state, and a key that changes or a connector that goes is read at once.
 * A connector whose store costs something to build must bring its own cache, with a way out.
 *
 * WARNING: the workspace of the client is compared with the workspace of the connector. A site must
 * not write through the key of another team, whatever its row says.
 */
export function createConnectorStores(
  accounts: AccountStore,
  secretsKey: string | undefined,
  now: () => number = Date.now,
  oauth?: LinearOAuth,
): ConnectorStores {
  return async (connector, workspace, own) => {
    const kept = await accounts.sealedKey(connector);
    if (kept === undefined || kept.workspaceId !== workspace)
      throw new StoreError('The connector of this site is gone');
    // Nothing is opened to keep a note and queue it: the key is for the loop that sends.
    if (kept.kind === 'rest') return receivingStore(own, accounts, connector, now);

    // A token of OAuth near its end is refreshed here.
    return TRACKERS[kept.kind](await linearAuthorization(connector, kept.sealed, { accounts, secretsKey, oauth, now }));
  };
}

/** The worker's own store for a client with no destination, the connector's store for the others. */
export function createRoutedStore(base: SeedStore, connectors: ConnectorStores): SeedStore {
  const pick = (client: ClientConfig | undefined): Promise<SeedStore> =>
    client?.connector === undefined ? Promise.resolve(base) : connectors(client.connector, client.workspace, base);

  return {
    name: base.name,
    ...(base.stages === undefined ? {} : { stages: base.stages }),
    // The connector is in the key: two sites of one team in two workspaces must not share an entry.
    scope: (client) =>
      client?.connector === undefined ? base.scope(client) : `${client.connector}:${client.teamId ?? ''}`,
    create: async (seed, client, policy) => (await pick(client)).create(seed, client, policy),
    findForPage: async (query, client, policy) => (await pick(client)).findForPage(query, client, policy),
    ...(base.forget === undefined ? {} : { forget: base.forget }),
  };
}

import type { AccountStore, ConnectorKind } from './accounts.ts';
import type { ClientConfig } from './clients.ts';
import { createLinearStore } from './linear.ts';
import { open } from './secrets.ts';
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
const STORES: Record<ConnectorKind, (apiKey: string) => SeedStore> = {
  // The team is the client's. This default is never read for a client that has a destination.
  linear: (apiKey) => createLinearStore({ apiKey, teamId: 'no-team', projectId: undefined }),
};

export type ConnectorStores = (connector: string, workspace: string | undefined) => Promise<SeedStore>;

/**
 * One store per connector, kept for the life of the process and replaced when its key changes.
 *
 * WARNING: the workspace of the client is compared with the workspace of the connector. A site must
 * not write through the key of another team, whatever its row says.
 */
export function createConnectorStores(accounts: AccountStore, secretsKey: string | undefined): ConnectorStores {
  const built = new Map<string, { sealed: string; store: SeedStore }>();

  return async (connector, workspace) => {
    if (secretsKey === undefined) throw new StoreError('This worker has no key to open a connector with');
    const kept = await accounts.sealedKey(connector);
    if (kept === undefined || kept.workspaceId !== workspace)
      throw new StoreError('The connector of this site is gone');

    const known = built.get(connector);
    if (known?.sealed === kept.sealed) return known.store;

    const apiKey = open(kept.sealed, secretsKey);
    if (apiKey === undefined) throw new StoreError('The key of this connector could not be opened');
    const store = STORES[kept.kind](apiKey);
    built.set(connector, { sealed: kept.sealed, store });

    return store;
  };
}

/** The worker's own store for a client with no destination, the connector's store for the others. */
export function createRoutedStore(base: SeedStore, connectors: ConnectorStores): SeedStore {
  const pick = (client: ClientConfig | undefined): Promise<SeedStore> =>
    client?.connector === undefined ? Promise.resolve(base) : connectors(client.connector, client.workspace);

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

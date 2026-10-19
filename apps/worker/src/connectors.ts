import { SEED_STAGES } from '@fruitback/shared';
import type { AccountStore, ConnectorKind, ConnectorSettings } from './accounts.ts';
import { createAll } from './batch.ts';
import type { ClientConfig } from './clients.ts';
import { createLinearStore } from './linear.ts';
import { deliveryBody } from './rest-connector.ts';
import { type LinearOAuth, linearAuthorization } from './linear-oauth.ts';
import { type SeedStore, StoreError, takesChecks, takesReplies } from './store.ts';

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
const TRACKERS: Record<Exclude<ConnectorKind, 'rest'>, (apiKey: string, settings: ConnectorSettings) => SeedStore> = {
  // The team is the client's. This default is never read for a client that has a destination.
  linear: (apiKey, settings) => createLinearStore({ apiKey, teamId: 'no-team', projectId: undefined }, settings.stages),
};

/**
 * The store of a connector whose workspace does not show the replies of its tracker (FRU-102).
 *
 * The switch can only take the replies away: a worker that hides them everywhere still hides them.
 * It is applied to the policy each store reads, so a store keeps the promise of `showComments`: the
 * replies are not asked for, and not returned.
 */
function withSettings(store: SeedStore, settings: ConnectorSettings): SeedStore {
  if (settings.showComments) return store;
  const quiet = <P extends { showComments: boolean }>(policy: P): P => ({ ...policy, showComments: false });
  // A reply that nobody reads back on the page is a reply lost for its author (FRU-257), and so is a
  // verdict, which is a reply (FRU-294).
  const { reply: _reply, check: _check, ...noReply } = store;

  return {
    ...noReply,
    create: (seed, client, policy) => store.create(seed, client, quiet(policy)),
    ...(store.createBatch === undefined
      ? {}
      : {
          createBatch: (seeds, client, policy) =>
            (store.createBatch as NonNullable<SeedStore['createBatch']>)(seeds, client, quiet(policy)),
        }),
    findForPage: (query, client, policy) => store.findForPage(query, client, quiet(policy)),
  };
}

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
  // An address only receives: it sends no reply back, so a site of it takes none (FRU-257), and no
  // verdict (FRU-294).
  const { reply: _reply, check: _check, ...noReply } = own;

  return {
    ...noReply,
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
    const authorization = await linearAuthorization(connector, kept.sealed, { accounts, secretsKey, oauth, now });

    return withSettings(TRACKERS[kept.kind](authorization, kept.settings), kept.settings);
  };
}

/** The worker's own store for a client with no destination, the connector's store for the others. */
export function createRoutedStore(base: SeedStore, connectors: ConnectorStores): SeedStore {
  const pick = (client: ClientConfig | undefined): Promise<SeedStore> =>
    client?.connector === undefined ? Promise.resolve(base) : connectors(client.connector, client.workspace, base);

  return {
    name: base.name,
    ...(base.stages === undefined ? {} : { stages: base.stages }),
    // The stages of the tracker that answers for the client: GitHub says three, Linear says five, and
    // the store of the worker can be either (FRU-188). `stages` above stays for a caller with no client.
    // A store with no `stages` reports every stage, so the answer is never left to the worker's own.
    stagesFor: async (client) => (await pick(client)).stages ?? SEED_STAGES,
    // The connector is in the key: two sites of one team in two workspaces must not share an entry.
    scope: (client) =>
      client?.connector === undefined ? base.scope(client) : `${client.connector}:${client.teamId ?? ''}`,
    create: async (seed, client, policy) => (await pick(client)).create(seed, client, policy),
    // The store of the client decides how a batch is written: under a parent, or one note at a time.
    createBatch: async (seeds, client, policy, memory) => createAll(await pick(client), seeds, client, policy, memory),
    findForPage: async (query, client, policy) => (await pick(client)).findForPage(query, client, policy),
    ...(base.forget === undefined ? {} : { forget: base.forget }),
    repliesFor: async (client) => takesReplies(await pick(client), client),
    checksFor: async (client) => takesChecks(await pick(client), client),
    async reply(target, reply, client, policy) {
      const store = await pick(client);
      if (store.reply === undefined) throw new StoreError('The store of this site takes no reply');

      return store.reply(target, reply, client, policy);
    },
    async check(target, check, client, policy) {
      const store = await pick(client);
      if (store.check === undefined) throw new StoreError('The store of this site takes no verdict');

      return store.check(target, check, client, policy);
    },
  };
}

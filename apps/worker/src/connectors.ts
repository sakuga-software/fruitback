import { SEED_STAGES } from '@fruitback/shared';
import type { AccountStore, ConnectorKind, ConnectorSettings } from './accounts.ts';
import { createAll } from './batch.ts';
import type { ClientConfig } from './clients.ts';
import { type GithubApp, createGithubConnectorStore, openInstallation } from './github-connector.ts';
import { type StageExceptions, createLinearStore } from './linear.ts';
import { deliveryBody } from './rest-connector.ts';
import { type LinearOAuth, linearAuthorization } from './linear-oauth.ts';
import { type SeedStore, StoreError, takesAttachments, takesChecks, takesStatuses, takesReplies } from './store.ts';

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
type Kept = { connector: string; workspace: string; sealed: string; settings: ConnectorSettings };
type TrackerAccess = {
  accounts: AccountStore;
  secretsKey: string | undefined;
  now: () => number;
  oauth: LinearOAuth | undefined;
  githubApp: GithubApp | undefined;
};

const TRACKERS: Record<Exclude<ConnectorKind, 'rest'>, (kept: Kept, access: TrackerAccess) => Promise<SeedStore>> = {
  async linear({ connector, workspace, sealed, settings }, { accounts, secretsKey, oauth, now }) {
    // A token of OAuth near its end is refreshed here.
    const apiKey = await linearAuthorization(connector, sealed, { accounts, secretsKey, oauth, now });
    // The team is the client's. This default is never read for a client that has a destination.
    const config = { apiKey, teamId: 'no-team', projectId: undefined };
    // The issues say their status as `<connector>:<state id>` (FRU-368). The states keep the
    // exceptions of the connector (FRU-102): they are what a site with no row of its own shows.
    const base = createLinearStore(config, settings.stages, connector);
    // FRU-368: the stage a site gives a state wins over the exception of the connector, for that site.
    const forSite = async (site: string | undefined): Promise<SeedStore> => {
      const own = await siteStages(accounts, workspace, site, connector);

      return own === undefined ? base : createLinearStore(config, { ...settings.stages, ...own }, connector);
    };

    return {
      ...base,
      findForPage: async (query, client, policy) => (await forSite(query.clientId)).findForPage(query, client, policy),
      check: async (target, check, client, policy) =>
        (await forSite(target.clientId)).check?.(target, check, client, policy),
    };
  },
  // FRU-359: the repository is the client's, and the token of the App reaches that repository only.
  async github({ connector, workspace, sealed }, { accounts, secretsKey, githubApp }) {
    if (githubApp === undefined) throw new StoreError('This worker has no GitHub App to reach a repository with');
    const installation = openInstallation(sealed, secretsKey);
    // FRU-369: the issues say their status as `<connector>:<key>`, one of the four of GITHUB_STATES.
    // FRU-382: what GitHub says of a repository when a note goes there, for the console's warning.
    const privacy = (repository: string, isPrivate: boolean) =>
      accounts.noteRepositoryPrivacy(connector, repository, isPrivate);
    const base = createGithubConnectorStore(githubApp, installation, { statusSource: connector, privacy });
    // The stage a site gives a status wins over the one GitHub's state gives, for that site.
    const forSite = async (site: string | undefined): Promise<SeedStore> => {
      const own = await siteStages(accounts, workspace, site, connector);

      return own === undefined
        ? base
        : createGithubConnectorStore(githubApp, installation, { statusSource: connector, stages: own, privacy });
    };

    return {
      ...base,
      findForPage: async (query, client, policy) => (await forSite(query.clientId)).findForPage(query, client, policy),
    };
  },
};

/**
 * The stages a site gives the states of a connector (FRU-368): the rows of its statuses whose source is
 * that connector. `undefined` for a site with none, or whose rows did not answer: the store then reads
 * with the exceptions of the connector, as before, and the read does not fail for a setting.
 */
async function siteStages(
  accounts: AccountStore,
  workspace: string,
  site: string | undefined,
  connector: string,
): Promise<StageExceptions | undefined> {
  if (site === undefined) return undefined;
  try {
    const rows = ((await accounts.siteStatuses(workspace, site)) ?? []).filter((row) => row.source === connector);

    return rows.length === 0 ? undefined : Object.fromEntries(rows.map((row) => [row.key, row.stage]));
  } catch (error) {
    console.error(
      `[fruitback] the statuses of a site did not answer: ${error instanceof Error ? error.message : String(error)}`,
    );

    return undefined;
  }
}

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
    create: (seed, client, policy, files) => store.create(seed, client, quiet(policy), files),
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
    // FRU-331: the files of a note travel with its delivery, by the addresses of short life that each
    // attempt signs (`deliverDue`). The worker's own store takes none: the files never stay with it.
    attachments: true,
    async create(seed, client, policy, files = []) {
      const created = await own.create(seed, client, policy);
      const ids = files.map((file) => file.id);
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
            ...(files.length === 0
              ? {}
              : {
                  attachments: files.map((file) => ({
                    id: file.id,
                    name: file.name,
                    type: file.type,
                    size: file.content.byteLength,
                  })),
                }),
          }),
          now(),
        );
      } catch (error) {
        console.error('[fruitback] a note was kept and its delivery was not queued', created.identifier, error);

        // No delivery carries the files: they are lost, and the worker removes them now.
        return { ...created, files: { sent: [], lost: ids, waiting: [] } };
      }

      return { ...created, files: { sent: [], lost: [], waiting: ids } };
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
  /**
   * Whether a delivery can carry the address of a file on this worker (FRU-331): it has a public
   * address and a key to sign with. Without them an address that receives takes no file.
   */
  {
    filesReachable = false,
    githubApp,
  }: {
    filesReachable?: boolean;
    /** The GitHub App of the worker (FRU-359), for a `github` connector. It holds the tokens of the process. */
    githubApp?: GithubApp;
  } = {},
): ConnectorStores {
  return async (connector, workspace, own) => {
    const kept = await accounts.sealedKey(connector);
    if (kept === undefined || kept.workspaceId !== workspace)
      throw new StoreError('The connector of this site is gone');
    // Nothing is opened to keep a note and queue it: the key is for the loop that sends.
    if (kept.kind === 'rest') {
      const receiving = receivingStore(own, accounts, connector, now);
      if (filesReachable) return receiving;
      // Takes no file, and never queues one: the route refuses files before it (`409`), and a call
      // that would still bring some sends the note alone, with no file said to wait (raised in review).
      const { attachments: _files, ...noFiles } = receiving;

      return { ...noFiles, create: (seed, client, policy) => receiving.create(seed, client, policy) };
    }

    const store = await TRACKERS[kept.kind](
      { connector, workspace, sealed: kept.sealed, settings: kept.settings },
      { accounts, secretsKey, now, oauth, githubApp },
    );

    return withSettings(store, kept.settings);
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
    create: async (seed, client, policy, files) => (await pick(client)).create(seed, client, policy, files),
    // FRU-331: the store of the site says whether it takes files. The worker's own store takes none.
    attachmentsFor: async (client) => takesAttachments(await pick(client), client),
    // The store of the client decides how a batch is written: under a parent, or one note at a time.
    createBatch: async (seeds, client, policy, memory) => createAll(await pick(client), seeds, client, policy, memory),
    findForPage: async (query, client, policy) => (await pick(client)).findForPage(query, client, policy),
    ...(base.forget === undefined ? {} : { forget: base.forget }),
    repliesFor: async (client) => takesReplies(await pick(client), client),
    checksFor: async (client) => takesChecks(await pick(client), client),
    // FRU-367: only the worker's own store sets the status of a note; a tracker keeps its own.
    statusesFor: async (client) => takesStatuses(await pick(client), client),
    // FRU-368: the states of the tracker of the client, for the statuses of its site.
    trackerStatesFor: async (client) => {
      const store = await pick(client);

      return store.trackerStates === undefined ? undefined : store.trackerStates(client);
    },
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
    async setStatus(target, status, client) {
      const store = await pick(client);
      if (store.setStatus === undefined) throw new StoreError('The store of this site takes no status');

      return store.setStatus(target, status, client);
    },
  };
}

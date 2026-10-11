import type { AccountStore } from './accounts.ts';
import { type Database, databaseFor } from './postgres.ts';
import type { SessionStore } from './session.ts';

/**
 * The stores of a worker on a database, loaded at their first call (FRU-180).
 *
 * `accounts-postgres.ts` and `session-postgres.ts` import Drizzle, and `app.ts` is loaded by every
 * worker. So `app.ts` imports this file, which imports them only when a store is called: **a worker
 * without `FRUITBACK_DATABASE_URL` loads nothing of Drizzle and nothing of the driver.**
 * test:`loads no file of Drizzle and no file of the driver for a worker without the variable` holds
 * it, in a process of its own.
 *
 * Do not import one of the two files from a file that every worker loads.
 */

/**
 * The database with its schema, once for each `Database`: `migrated` of `postgres-migrate.ts`, loaded
 * at the first call. `auth.ts` applies the migrations before it builds better-auth, and is loaded by
 * every worker.
 */
export async function migrated(database: Database): Promise<void> {
  return (await import('./postgres-migrate.ts')).migrated(database);
}

/**
 * A store whose every method loads the real one, then calls it.
 *
 * `methods` names every method of the interface: a store that gains one does not compile until it
 * is named here.
 */
function later<Store extends object>(load: () => Promise<Store>, methods: Record<keyof Store, true>): Store {
  let loading: Promise<Store> | undefined;
  const loaded = (): Promise<Store> => {
    loading ??= load();
    // A failure is not kept: the next call tries again.
    loading.catch(() => (loading = undefined));

    return loading;
  };

  const store: Record<string, unknown> = {};
  for (const method of Object.keys(methods)) {
    store[method] = async (...values: unknown[]): Promise<unknown> => {
      const real = (await loaded()) as Record<string, (...values: unknown[]) => unknown>;

      return real[method]?.(...values);
    };
  }

  return store as Store;
}

export function postgresAccountStore(url: string): AccountStore {
  return later(async () => (await import('./accounts-postgres.ts')).createPostgresAccountStore(databaseFor(url)), {
    signIn: true,
    account: true,
    setLocale: true,
    localeOf: true,
    createWorkspace: true,
    memberships: true,
    role: true,
    addSite: true,
    sites: true,
    removeSite: true,
    addConnector: true,
    connectors: true,
    removeConnector: true,
    resealConnector: true,
    noteConnector: true,
    sealedKey: true,
    setDestination: true,
    setDestinations: true,
    enqueueDelivery: true,
    dueDeliveries: true,
    settleDelivery: true,
    deliveries: true,
    retryDelivery: true,
    dropAbandonedDeliveries: true,
    deleteWorkspace: true,
    clientMap: true,
    createEmailLink: true,
    spendEmailLink: true,
  });
}

export function postgresSessionStore(url: string): SessionStore {
  return later(async () => (await import('./session-postgres.ts')).createPostgresSessionStore(databaseFor(url)), {
    createPairing: true,
    redeemPairing: true,
    rotateSession: true,
    revokeSession: true,
    purge: true,
  });
}

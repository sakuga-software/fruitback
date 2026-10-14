import type { AccountStore } from './accounts.ts';
import type { Kv } from './kv.ts';
import type { NoteIndex } from './notes-index.ts';
import { z } from 'zod';
import { type Database, databaseFor, databaseUrlOf, readDatabaseSchema } from './postgres.ts';
import type { ScreenshotStore } from './screenshots.ts';
import type { SessionStore } from './session.ts';
import type { SeedStore } from './store.ts';
import { type StoreSpec, defineStore } from './store-config.ts';

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

export function postgresAccountStore(url: string, schema: string): AccountStore {
  const database = databaseFor(url, schema);

  return later(async () => (await import('./accounts-postgres.ts')).createPostgresAccountStore(database), {
    signIn: true,
    account: true,
    setLocale: true,
    setName: true,
    localeOf: true,
    createWorkspace: true,
    memberships: true,
    owners: true,
    role: true,
    markSeen: true,
    lastSeen: true,
    addSite: true,
    sites: true,
    removeSite: true,
    addConnector: true,
    connectors: true,
    removeConnector: true,
    resealConnector: true,
    noteConnector: true,
    setConnectorSettings: true,
    sealedKey: true,
    setDestination: true,
    setDestinations: true,
    enqueueDelivery: true,
    dueDeliveries: true,
    settleDelivery: true,
    deliveries: true,
    retryDelivery: true,
    dropAbandonedDeliveries: true,
    addDomain: true,
    domains: true,
    removeDomain: true,
    noteDomainCheck: true,
    domainsToCheck: true,
    setPreviews: true,
    deleteWorkspace: true,
    clientMap: true,
  });
}

export function postgresSessionStore(url: string, schema: string): SessionStore {
  return sessionStoreOn(databaseFor(url, schema));
}

/** The sessions of this database. `auth.ts` ends the sessions of a member who is removed (FRU-149). */
export function sessionStoreOn(database: Database): SessionStore {
  return later(async () => (await import('./session-postgres.ts')).createPostgresSessionStore(database), {
    createPairing: true,
    redeemPairing: true,
    rotateSession: true,
    revokeSession: true,
    endSessionsOf: true,
    renameSessionsOf: true,
    purge: true,
    holdsSession: true,
  });
}

/** The pictures of the notes of this database (FRU-44). */
export function postgresScreenshotStore(url: string, schema: string): ScreenshotStore {
  const database = databaseFor(url, schema);

  return later(async () => (await import('./screenshots-postgres.ts')).createPostgresScreenshotStore(database), {
    put: true,
    get: true,
  });
}

const kvs = new Map<string, Kv>();

/**
 * The `Kv` of this database (FRU-67), one for each address for the whole process: it paces its own
 * sweep, and a new one for each request would sweep at each request.
 */
export function postgresKv(url: string, schema: string): Kv {
  // Keyed as `databaseFor` keys its databases (FRU-219): two schemas of one database are two Kvs.
  const key = `${schema} ${url}`;
  let kv = kvs.get(key);
  if (kv === undefined) {
    const database = databaseFor(url, schema);
    kv = later(async () => (await import('./kv-postgres.ts')).createPostgresKv(database), {
      get: true,
      set: true,
      incr: true,
      close: true,
    });
    kvs.set(key, kv);
  }

  return kv;
}

/** The index of the notes of this database (FRU-237): `notes-index-postgres.ts`, loaded at the first call. */
export function postgresNoteIndex(url: string, schema: string): NoteIndex {
  const database = databaseFor(url, schema);

  return later(async () => (await import('./notes-index-postgres.ts')).createPostgresNoteIndex(database), {
    record: true,
    refresh: true,
    summary: true,
    undelivered: true,
    forget: true,
    list: true,
    deliveryOf: true,
  });
}

/**
 * The notes of this database (FRU-218): `createPostgresSeedStore` of `seeds-postgres.ts`, loaded at
 * the first call. `name` and `scope` are read with no call, by `/health` and by the key of the read
 * cache, so they are written here and held equal to the real ones by a test.
 */
export function postgresSeedStore(url: string, schema: string): SeedStore {
  const database = databaseFor(url, schema);
  type Calls = Required<Pick<SeedStore, 'create' | 'createBatch' | 'findForPage' | 'forget'>>;
  const store = later<Calls>(
    async () => (await import('./seeds-postgres.ts')).createPostgresSeedStore(database) as Calls,
    {
      create: true,
      createBatch: true,
      findForPage: true,
      forget: true,
    },
  );

  return { name: 'postgres', scope: () => 'postgres', ...store };
}

/**
 * The database as a selectable store (FRU-218): `FRUITBACK_STORE=postgres`.
 *
 * It reads the variable of the accounts, `FRUITBACK_DATABASE_URL`, and no other: the notes are in the
 * database of the worker, with its sites. A worker with no database is told the name of that
 * variable. It is not the default: `DEFAULT_STORE_PROVIDER` does not change here.
 */
export function createPostgresStoreSpec(): StoreSpec {
  return defineStore({
    provider: 'postgres',
    envNames: { url: 'FRUITBACK_DATABASE_URL', schema: 'FRUITBACK_DATABASE_SCHEMA' },
    read: (env) => ({
      url: databaseUrlOf(env),
      schema: readDatabaseSchema(env.FRUITBACK_DATABASE_SCHEMA),
    }),
    schema: z.object({ url: z.string().min(1), schema: z.string().min(1) }),
    create: ({ url, schema }) => postgresSeedStore(url, schema),
  });
}

/** The copy of the notes of a SQLite file (FRU-220): `copySeedsFile` of `postgres-copy.ts`, loaded at the call. */
export async function copySeedsFile(copy: {
  seedsPath: string;
  clients: ReadonlyMap<string | null, string>;
  database: Database;
  dryRun: boolean;
}): Promise<{ ok: boolean; lines: string[] }> {
  return (await import('./postgres-copy.ts')).copySeedsFile(copy);
}

/** What `migrate-to-postgres` copies, and where (FRU-145). */
export type SqliteCopy = { accountsPath: string; sessionsPath: string; database: Database; dryRun: boolean };

/**
 * The copy of the two SQLite files into the database: `copySqliteFiles` of `postgres-copy.ts`, loaded
 * at the call. The command is in `cli.ts`, which every worker loads.
 */
export async function copySqliteFiles(copy: SqliteCopy): Promise<{ ok: boolean; lines: string[] }> {
  return (await import('./postgres-copy.ts')).copySqliteFiles(copy);
}

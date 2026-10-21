import { type AccountStore } from './accounts.ts';
import { type AttachmentStore } from './attachments.ts';
import { authFor } from './auth.ts';
import type { ConnectStore } from './connect.ts';
import { type TxtResolver, recheckDomains } from './domain-proof.ts';
import { type WorkerConfig, type WorkerEnv, readConfig } from './env.ts';
import { type AdminLinks, firstAdminLines } from './first-admin.ts';
import type { InstanceAdminReads } from './instance-admin.ts';
import { type Kv, processKv } from './kv.ts';
import { type Mailer, createTemMailer } from './mail.ts';
import type { NoteIndex } from './notes-index.ts';
import {
  postgresAccountStore,
  postgresConnectStore,
  postgresInstanceAdmin,
  postgresKv,
  postgresNoteIndex,
  postgresAttachmentStore,
  postgresSessionStore,
} from './postgres-stores.ts';
import { type Send, deliverDue } from './rest-connector.ts';
import type { SessionStore } from './session.ts';
import type { SeedStore } from './store.ts';

/**
 * What this worker opens from its configuration (FRU-363): its stores, its `Kv`, what sends its mail,
 * and the two passes that `server.ts` runs on a timer. Out of `app.ts`, which exports them again:
 * `server.ts`, `cli.ts` and the tests read them there.
 */

/**
 * Which store this process writes to (FRU-29, FRU-33).
 *
 * It was a `Pick<typeof realLinear, 'createSeedIssue' | 'fetchSeedIssues'>` — an interface
 * discovered by accident — then a branch on a `fakeLinear` boolean with Linear's three credentials
 * read straight off the config. Both are gone: the provider was selected and validated at boot
 * (`stores.ts`), and this is only where it is built. SQLite (FRU-31) and GitHub (FRU-32) each
 * added an entry to the registry and nothing here.
 *
 * A dev-only store cannot win in production: `readStoreConfig` refuses it at boot rather than
 * letting the process start.
 */
export function storeFor(config: WorkerConfig): SeedStore {
  return config.store.create();
}

/**
 * The extension's session store, or `undefined` when this worker runs without one (FRU-42).
 *
 * Deliberately not built from `config.store`: sessions are credentials and seeds are not, so they
 * never share a backend. They are in the database of the accounts (FRU-142), and in no file since
 * FRU-226.
 */
export function sessionStoreFor(config: WorkerConfig): SessionStore | undefined {
  return config.databaseUrl === undefined ? undefined : postgresSessionStore(config.databaseUrl, config.databaseSchema);
}

/**
 * Where the requests of the extension wait for a person to approve them (FRU-238): the database of
 * the accounts, or nowhere. A worker with no accounts has nobody to approve.
 */
export function connectStoreFor(config: WorkerConfig): ConnectStore | undefined {
  return config.databaseUrl === undefined ? undefined : postgresConnectStore(config.databaseUrl, config.databaseSchema);
}

/** What the links of an administrator need of this worker, or `undefined` when it signs nobody in (FRU-221). */
export function adminLinksFor(config: WorkerConfig): AdminLinks | undefined {
  const auth = authFor(config);
  const accounts = accountStoreFor(config);
  if (auth === undefined || accounts === undefined || config.consoleUrl === undefined) return undefined;

  return { auth, kv: kvFor(config), owners: () => accounts.owners(), consoleUrl: config.consoleUrl };
}

/**
 * Writes the sign-in link of the first administrator in the log, on a worker that names one and whose
 * instance has no owner yet (FRU-221). `server.ts` calls it when the server listens. It never
 * rejects: the next start tries again. Its error names no token.
 */
export async function announceFirstAdmin(
  config: WorkerConfig,
  log: (line: string) => void = (line) => console.log(`[fruitback] ${line}`),
): Promise<void> {
  const links = config.firstAdmin === undefined ? undefined : adminLinksFor(config);
  if (config.firstAdmin === undefined || links === undefined) return;
  try {
    for (const line of await firstAdminLines(links, config.firstAdmin)) log(line);
  } catch (error) {
    console.error(
      `[fruitback] the sign-in link of FRUITBACK_FIRST_ADMIN was not made: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** What sends the e-mail of this worker, or `undefined` when it sends none (FRU-98). */
export function mailerFor(config: WorkerConfig): Mailer | undefined {
  return config.mail === undefined ? undefined : createTemMailer(config.mail);
}

/** The accounts of this worker, or `undefined` when its clients come from the env (FRU-96). */
export function accountStoreFor(config: WorkerConfig): AccountStore | undefined {
  return config.databaseUrl === undefined ? undefined : postgresAccountStore(config.databaseUrl, config.databaseSchema);
}

/**
 * Where this worker keeps the state of its rate limiter and of its read cache (FRU-67).
 *
 * **A worker with a database keeps it there**, so its replicas share one limit; a worker without one
 * keeps it in the memory of the process, as before. No variable chooses: the database is the one
 * store that replicas share. One instance for the process either way.
 */
export function kvFor(config: Pick<WorkerConfig, 'databaseUrl' | 'databaseSchema'>): Kv {
  return config.databaseUrl === undefined ? processKv() : postgresKv(config.databaseUrl, config.databaseSchema);
}

/** What the administrator of the instance reads (FRU-261): the database of the accounts. */
export function instanceAdminFor(config: WorkerConfig): InstanceAdminReads | undefined {
  return config.databaseUrl === undefined
    ? undefined
    : postgresInstanceAdmin(config.databaseUrl, config.databaseSchema);
}

/** Where this worker keeps the pictures of the notes: its database, or nowhere (FRU-44). */
/** The index of the notes of a worker with a database (FRU-237), or none: `notes-index.ts`. */
export function noteIndexFor(config: WorkerConfig): NoteIndex | undefined {
  return config.databaseUrl === undefined ? undefined : postgresNoteIndex(config.databaseUrl, config.databaseSchema);
}

export function attachmentStoreFor(config: WorkerConfig): AttachmentStore | undefined {
  return config.databaseUrl === undefined
    ? undefined
    : postgresAttachmentStore(config.databaseUrl, config.databaseSchema);
}

/**
 * One pass over the notes that wait to be sent to the address a workspace connected (FRU-122).
 *
 * The server calls it on a timer. It is here and not in `server.ts` so a test reaches it with no
 * socket: it reads the same configuration as a request does.
 */
/**
 * Asks the DNS again for the proofs of the domains that were not asked for `RECHECK_MS` (FRU-103).
 * `server.ts` calls it on a timer, like `deliverPending`.
 */
export async function recheckPending(env: WorkerEnv, resolve: TxtResolver, now?: () => number): Promise<void> {
  const config = readConfig(env);
  const accounts = config.ok ? accountStoreFor(config.config) : undefined;
  if (!config.ok || accounts === undefined) return;

  await recheckDomains(accounts, resolve, (now ?? Date.now)());
}

export async function deliverPending(
  env: WorkerEnv,
  send: Send,
  now?: () => number,
  /** The accounts a test opened, as `RequestContext.accounts`. Absent, the ones of the environment. */
  held?: AccountStore,
): Promise<void> {
  const config = readConfig(env);
  if (!config.ok) return;
  const accounts = held ?? accountStoreFor(config.config);
  if (accounts === undefined) return;

  const attachments = attachmentStoreFor(config.config);
  await deliverDue({
    accounts,
    secretsKey: config.config.secretsKey,
    send,
    ...(attachments === undefined ? {} : { attachments }),
    ...(config.config.publicUrl === undefined ? {} : { publicUrl: config.config.publicUrl }),
    ...(now === undefined ? {} : { now }),
  });
}

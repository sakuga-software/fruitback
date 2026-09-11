import { DatabaseSync } from 'node:sqlite';
import type { SessionIdentity, SessionRecord, SessionStore } from './session.ts';
import { StoreError } from './store.ts';

/**
 * Where the extension's sessions live (SKG-535).
 *
 * **Its own file, and its own module, deliberately.** `sqlite.ts` looks like it could be reused —
 * same driver, same shape of helper — and it cannot: its `connect` runs the *seeds* migrations and
 * drives `PRAGMA user_version` with them. Pointing a session database at it would create `seeds` and
 * `comments` in it and leave both schemas fighting over one version counter, which is unrecoverable
 * rather than merely wrong. Verified by reading `sqlite.ts` before this file was written.
 *
 * A separate file also states the thing that matters: sessions are not seeds, and a worker storing
 * its seeds in Linear still keeps its credentials on a disk it owns.
 */

/**
 * The schema, one statement per version, applied in order.
 *
 * Append; never edit an entry that has shipped. Same rule and same mechanism as the seed store, and
 * the two counters are independent because the two files are.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE pairings (
    code_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    name TEXT,
    email TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    redeemed_at INTEGER
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    name TEXT,
    email TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  -- Purging walks both tables by expiry, and nothing else ever does. Pairings need this as much as
  -- sessions do: the purge runs before every redemption, so without it a guessed code costs a full
  -- table scan and traffic meant to be cheap to refuse becomes the expensive path. Raised in review.
  CREATE INDEX pairings_by_expiry ON pairings (expires_at);
  CREATE INDEX sessions_by_expiry ON sessions (expires_at);
  `,
];

/**
 * One connection per file, for the lifetime of the process.
 *
 * Same reason as the seed store's: a handle is not cheap, and the session store is built per request
 * wherever the transport did not hand one over.
 */
const connections = new Map<string, DatabaseSync>();

let opened = 0;

function connect(path: string): DatabaseSync {
  const open = connections.get(path);
  if (open !== undefined) return open;

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path);
  } catch (error) {
    throw new StoreError(`Session store could not open ${path}: ${String(error)}`);
  }

  opened += 1;

  // Closed on failure. The constructor succeeds on a file that is not a database at all, and the
  // first PRAGMA is what throws — leaving a descriptor open per request. Same trap as `sqlite.ts`.
  try {
    database.exec('PRAGMA journal_mode = WAL');
    migrate(database);
  } catch (error) {
    database.close();
    throw new StoreError(`Session store could not initialise ${path}: ${String(error)}`);
  }

  connections.set(path, database);

  return database;
}

function migrate(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;

  for (let index = version; index < MIGRATIONS.length; index += 1) {
    // One transaction, so a crash between the tables and the version they record cannot leave a
    // database that re-runs `CREATE TABLE` for ever. `PRAGMA user_version` is transactional.
    database.exec('BEGIN');
    try {
      database.exec(MIGRATIONS[index] as string);
      database.exec(`PRAGMA user_version = ${index + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

/** How many handles this process opened. A counter, not `connections.size` — see `sqlite.ts`. */
export function sessionConnectionsOpened(): number {
  return opened;
}

export function closeSessionConnections(): void {
  for (const database of connections.values()) database.close();
  connections.clear();
  opened = 0;
}

type IdentityRow = { subject: unknown; name: unknown; email: unknown };

/**
 * A row is parsed, never trusted — the same rule the seed store follows, and for the same reason.
 *
 * This file sits on a volume an operator can edit and a restore can be older than the code. A cast
 * describes the row to TypeScript and checks nothing. `TEXT` affinity narrows what can actually
 * arrive — an integer written here comes back as a string — but a **BLOB** keeps its type, and a
 * `NOT NULL` column holds an empty string quite happily. Either would otherwise reach
 * `signIdentityToken` and mint a token behind a `200` that this worker's own verifier then rejects.
 * An unreadable row answers like a missing one, so it costs that session and never the endpoint.
 * Raised in review.
 */
function identityOf(row: IdentityRow): SessionIdentity | undefined {
  if (typeof row.subject !== 'string' || row.subject === '') return undefined;

  return {
    subject: row.subject,
    ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
    ...(typeof row.email === 'string' && row.email !== '' ? { email: row.email } : {}),
  };
}

export function createSqliteSessionStore(path: string): SessionStore {
  return {
    // `async` throughout so a volume nobody mounted rejects rather than throwing synchronously past
    // a caller's `.catch()`. `connect` throws before any await, which is the path that matters.
    async createPairing({ codeHash, identity, expiresAt }) {
      connect(path)
        .prepare(
          'INSERT INTO pairings (code_hash, subject, name, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(codeHash, identity.subject, identity.name ?? null, identity.email ?? null, Date.now(), expiresAt);
    },

    /**
     * Spends the code and opens the session it buys, in one transaction.
     *
     * **No test in this process can tell the spend apart from a read followed by a write.**
     * `DatabaseSync` is synchronous and nothing here awaits, so two redemptions never interleave in
     * one process however they are scheduled — measured, against exactly that mutation, which stayed
     * green. What the single statement buys is the case a unit test cannot reach: two workers on one
     * volume, or an asynchronous driver later.
     *
     * The **transaction** is a different guard, and that one is observable: marking the code spent
     * and then failing to insert the session burns the only code the reviewer has, and the retry
     * answers `code-spent-or-expired`, which is true and useless. Raised in review, and mutation-tested
     * by making the insert collide on its primary key.
     */
    async redeemPairing({ codeHash, tokenHash, expiresAt, now }) {
      const database = connect(path);

      database.exec('BEGIN IMMEDIATE');
      try {
        // `changes === 1` is what proves this call is the one that spent it: the `WHERE` matches only
        // an unredeemed, unexpired row.
        const spent = database
          .prepare('UPDATE pairings SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?')
          .run(now, codeHash, now);

        if (spent.changes !== 1) {
          database.exec('ROLLBACK');

          return undefined;
        }

        const row = database.prepare('SELECT subject, name, email FROM pairings WHERE code_hash = ?').get(codeHash) as
          | IdentityRow
          | undefined;
        const identity = row === undefined ? undefined : identityOf(row);

        if (identity === undefined) {
          database.exec('ROLLBACK');

          return undefined;
        }

        database
          .prepare(
            'INSERT INTO sessions (token_hash, subject, name, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(tokenHash, identity.subject, identity.name ?? null, identity.email ?? null, now, expiresAt);

        database.exec('COMMIT');

        return identity;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },

    async findSession(tokenHash, now) {
      const row = connect(path)
        .prepare(
          'SELECT subject, name, email, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
        )
        .get(tokenHash, now) as (IdentityRow & { expires_at: unknown }) | undefined;

      if (row === undefined) return undefined;

      const identity = identityOf(row);

      return identity === undefined || typeof row.expires_at !== 'number'
        ? undefined
        : { ...identity, expiresAt: row.expires_at };
    },

    async revokeSession(tokenHash, now) {
      const revoked = connect(path)
        .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .run(now, tokenHash);

      return revoked.changes === 1;
    },

    /**
     * Expired rows go; revoked ones stay until they expire.
     *
     * Deleting a revoked session the moment it is revoked would make a replayed token read as
     * "unknown" rather than as "revoked", which is the same answer to the caller and a worse one in
     * a log an operator is reading after an incident.
     */
    async purge(now) {
      const database = connect(path);
      database.prepare('DELETE FROM pairings WHERE expires_at <= ?').run(now);
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    },
  };
}

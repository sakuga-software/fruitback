import { DatabaseSync } from 'node:sqlite';
import type { SessionIdentity, SessionRecord, SessionStore } from './session.ts';

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

  -- Purging walks by expiry, and nothing else ever does.
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
    throw new Error(`Session store could not open ${path}: ${String(error)}`);
  }

  opened += 1;

  // Closed on failure. The constructor succeeds on a file that is not a database at all, and the
  // first PRAGMA is what throws — leaving a descriptor open per request. Same trap as `sqlite.ts`.
  try {
    database.exec('PRAGMA journal_mode = WAL');
    migrate(database);
  } catch (error) {
    database.close();
    throw new Error(`Session store could not initialise ${path}: ${String(error)}`);
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

type IdentityRow = { subject: string; name: string | null; email: string | null };

function identityOf(row: IdentityRow): SessionIdentity {
  return {
    subject: row.subject,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.email === null ? {} : { email: row.email }),
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
     * Marks the code spent, then reads it. In that order, and `changes === 1` is the guard: the
     * `WHERE` matches only an unredeemed, unexpired row, and SQLite applies one statement atomically.
     *
     * **No test in this process can tell this apart from a read followed by a write.** `DatabaseSync`
     * is synchronous and nothing here awaits between the two, so two redemptions never interleave in
     * one process however they are scheduled — measured, against exactly that mutation, which stayed
     * green. What this form buys is the case a unit test cannot reach: two workers on one volume, or
     * an asynchronous driver later. It is written the correct way rather than the way this process
     * happens to make safe.
     */
    async redeemPairing(codeHash, now) {
      const database = connect(path);
      const spent = database
        .prepare('UPDATE pairings SET redeemed_at = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?')
        .run(now, codeHash, now);

      if (spent.changes !== 1) return undefined;

      const row = database.prepare('SELECT subject, name, email FROM pairings WHERE code_hash = ?').get(codeHash) as
        | IdentityRow
        | undefined;

      return row === undefined ? undefined : identityOf(row);
    },

    async createSession({ tokenHash, identity, expiresAt }) {
      connect(path)
        .prepare(
          'INSERT INTO sessions (token_hash, subject, name, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(tokenHash, identity.subject, identity.name ?? null, identity.email ?? null, Date.now(), expiresAt);
    },

    async findSession(tokenHash, now) {
      const row = connect(path)
        .prepare(
          'SELECT subject, name, email, expires_at FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?',
        )
        .get(tokenHash, now) as (IdentityRow & { expires_at: number }) | undefined;

      return row === undefined ? undefined : { ...identityOf(row), expiresAt: row.expires_at };
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

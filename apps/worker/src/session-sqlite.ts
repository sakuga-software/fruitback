import { DatabaseSync } from 'node:sqlite';
import type { RotationOutcome, SessionIdentity, SessionStore } from './session.ts';
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
  // Rotation (SKG-600). `rotated_at` marks a token that has issued its successor; `predecessor_hash`
  // is the link back to the one it replaced, and reading it the other way — every row that names a
  // token as its predecessor — is how a leaked chain is walked forward. One column rather than two,
  // and the index is what makes the backward reading cheap.
  `
  ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;
  ALTER TABLE sessions ADD COLUMN predecessor_hash TEXT;

  CREATE INDEX sessions_by_predecessor ON sessions (predecessor_hash);
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

type SessionRow = IdentityRow & {
  expires_at: unknown;
  revoked_at: unknown;
  rotated_at: unknown;
  predecessor_hash: unknown;
};

/** Marked, never deleted: a revoked row is what turns a later replay into `reused` rather than into an unknown token. */
function revoke(database: DatabaseSync, tokenHash: string, now: number): void {
  database
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now, tokenHash);
}

/**
 * Every token that descends from this one, revoked.
 *
 * Walked forward through `predecessor_hash`, which is the column read the other way round. A
 * predecessor can have several rows naming it — each retry inside the grace mints one — so this
 * takes a queue rather than a single successor.
 *
 * `seen` is not defensive tidiness: this file sits on a volume an operator can edit, and a row whose
 * `predecessor_hash` points back into its own chain would otherwise spin here for ever, inside a
 * transaction, holding the database.
 *
 * The walk is not short-circuited on an already revoked row, and must not be: a rotation revokes
 * each predecessor, so every link but the tip is revoked in the ordinary case and a filtered walk
 * would stop at the first hop without ever reaching the live token.
 *
 * The cost, stated rather than guessed. Chain length is bounded by the rotations that fit inside
 * one `expires_at` — about 5400 for a session refreshed every 8 minutes for 30 days. Measured at
 * 45 ms on such a chain, through `sessions_by_predecessor`, and a replay pays it again each time.
 * `checkRateLimit` caps that at 20 requests a minute per IP. The two calls inside the grace walk
 * one row, not the chain.
 */
function revokeDescendants(database: DatabaseSync, tokenHash: string, now: number): void {
  const seen = new Set([tokenHash]);
  const queue = [tokenHash];

  while (queue.length > 0) {
    const parent = queue.shift() as string;
    const rows = database.prepare('SELECT token_hash FROM sessions WHERE predecessor_hash = ?').all(parent) as {
      token_hash: unknown;
    }[];

    for (const { token_hash: child } of rows) {
      if (typeof child !== 'string' || seen.has(child)) continue;

      seen.add(child);
      revoke(database, child, now);
      queue.push(child);
    }
  }
}

/**
 * What this refresh token buys, decided on the row it names.
 *
 * Separated from the transaction around it so the branches read as the four cases they are, and so
 * `commit` is stated per branch rather than inferred — a rollback on a branch that revoked a chain
 * would throw the revocation away, which is the one mistake here that fails silently and safely
 * enough to ship.
 */
function decide(
  database: DatabaseSync,
  input: { row: SessionRow | undefined; tokenHash: string; successorHash: string; now: number; graceMs: number },
): { answer: RotationOutcome; commit: boolean } {
  const { row, tokenHash, successorHash, now, graceMs } = input;

  if (row === undefined || typeof row.expires_at !== 'number' || row.expires_at <= now) {
    return { answer: { outcome: 'gone' }, commit: false };
  }

  const rotatedAt = typeof row.rotated_at === 'number' ? row.rotated_at : undefined;

  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    // Revoked *and* rotated is the combination a logout cannot produce: this token issued a
    // successor, the successor was used, and that is what retired this one. Somebody kept a copy.
    if (rotatedAt === undefined) return { answer: { outcome: 'gone' }, commit: false };

    revokeDescendants(database, tokenHash, now);

    return { answer: { outcome: 'reused' }, commit: true };
  }

  if (rotatedAt !== undefined) {
    // Live, but its successor was never used: the answer carrying it did not arrive. Past the
    // ceiling the client has given up on, so does this — the chain goes rather than staying live
    // with nobody watching it.
    if (now > rotatedAt + graceMs) {
      revoke(database, tokenHash, now);
      revokeDescendants(database, tokenHash, now);

      return { answer: { outcome: 'gone' }, commit: true };
    }

    // Inside it: mint a fresh successor and drop the one nobody received, so this token never has
    // two live successors.
    revokeDescendants(database, tokenHash, now);
  }

  const identity = identityOf(row);
  if (identity === undefined) return { answer: { outcome: 'gone' }, commit: false };

  database
    .prepare(
      'INSERT INTO sessions (token_hash, subject, name, email, created_at, expires_at, predecessor_hash) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      successorHash,
      identity.subject,
      identity.name ?? null,
      identity.email ?? null,
      now,
      row.expires_at,
      tokenHash,
    );

  database.prepare('UPDATE sessions SET rotated_at = ? WHERE token_hash = ?').run(now, tokenHash);

  // Using a token is the proof its client received it, and that is what retires the one it replaced.
  // A clock is the fallback, never the mechanism.
  if (typeof row.predecessor_hash === 'string') revoke(database, row.predecessor_hash, now);

  return { answer: { outcome: 'rotated', identity }, commit: true };
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

    /**
     * Spends a refresh token and issues its successor, in one transaction (SKG-600).
     *
     * The three outcomes, and what decides each:
     *
     * - **`rotated`** — the token was live. Its successor is written, it is marked rotated, and the
     *   token it replaced (if any) is revoked *now*: a successor being used is the proof the client
     *   received it, and that is what normally retires a predecessor. No clock is involved.
     * - **`gone`** — unknown, expired, or revoked by a logout. Also a rotated token presented after
     *   the grace ran out: the client that lost the answer waited too long, and the whole chain goes
     *   with it rather than leaving a token nobody is watching.
     * - **`reused`** — revoked *and* rotated, which is the one combination a logout cannot produce:
     *   it means the successor was already used, so whoever still holds this one copied it. Every
     *   live descendant is revoked before answering.
     *
     * Inside the grace a rotated token rotates **again** rather than answering with the successor it
     * already minted. The successor cannot be answered twice: only its digest is stored, which is
     * the property that makes a copy of this file useless. The orphan is revoked in the same
     * transaction, so a predecessor never has two live successors.
     *
     * The successor **inherits the predecessor's expiry**. Rotation is about shortening what a
     * leaked token is worth, not about extending a session: thirty days from pairing stays thirty
     * days, and `SECURITY.md` stays true.
     */
    async rotateSession({ tokenHash, successorHash, now, graceMs }) {
      const database = connect(path);

      database.exec('BEGIN IMMEDIATE');
      try {
        const row = database
          .prepare(
            'SELECT subject, name, email, expires_at, revoked_at, rotated_at, predecessor_hash FROM sessions WHERE token_hash = ?',
          )
          .get(tokenHash) as SessionRow | undefined;

        const outcome = decide(database, { row, tokenHash, successorHash, now, graceMs });
        database.exec(outcome.commit ? 'COMMIT' : 'ROLLBACK');

        return outcome.answer;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
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
     *
     * A successor inherits its predecessor's `expires_at`, so a whole chain expires together and no
     * predecessor is purged while its successor is live. Give a rotation a sliding expiry and that
     * stops being true: the root is purged first, a replay of it reads as unknown, and the leak
     * signal is lost with nothing failing.
     */
    async purge(now) {
      const database = connect(path);
      database.prepare('DELETE FROM pairings WHERE expires_at <= ?').run(now);
      database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    },
  };
}

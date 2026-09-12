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
  // Rotation (SKG-600). `rotated_at` marks a token that has issued its successor and
  // `predecessor_hash` is the link back to the one it replaced — kept because retiring a predecessor
  // when its successor is used needs exactly that one hop.
  //
  // `root_hash` names the chain. Revoking a session used to walk `predecessor_hash` in both
  // directions, and a walk is linear in the chain: measured at 10 microseconds a link, with nothing
  // enforcing the eight-minute cadence the first estimate assumed. A holder refreshing at the rate
  // limit builds hundreds of thousands of rows inside one `expires_at`, and a single logout or
  // replay then held the database for seconds inside `BEGIN IMMEDIATE`. With the chain named it is
  // one indexed statement, whatever the length. Raised in review.
  //
  // It is NULL on every row written before this migration. Read it as `root_hash ?? token_hash`:
  // a row that names no chain is the head of its own.
  `
  ALTER TABLE sessions ADD COLUMN rotated_at INTEGER;
  ALTER TABLE sessions ADD COLUMN predecessor_hash TEXT;
  ALTER TABLE sessions ADD COLUMN root_hash TEXT;

  CREATE INDEX sessions_by_root ON sessions (root_hash);
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
  root_hash: unknown;
};

/** Marked, never deleted: a revoked row is what turns a later replay into `reused` rather than into an unknown token. */
function revoke(database: DatabaseSync, tokenHash: string, now: number): void {
  database
    .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(now, tokenHash);
}

/** The chain a row belongs to. A row with no `root_hash` predates the column and heads its own. */
function chainOf(row: { root_hash: unknown }, tokenHash: string): string {
  return typeof row.root_hash === 'string' ? row.root_hash : tokenHash;
}

/**
 * Every live token of one chain, revoked — except `keep`, when the caller still needs it.
 *
 * One statement rather than a walk, and `revoked_at IS NULL` is what makes a repeat call free: the
 * rows are already marked, so nothing is written.
 *
 * The cost, measured rather than reasoned about. The walk this replaced ran at 10 microseconds a
 * link and the chain has no bound but `expires_at`: 605 ms over 60,000 rows, and a holder refreshing
 * at the rate limit reaches an order of magnitude more inside thirty days. The same chains revoke in
 * 0.6 ms and 6.4 ms now. What a walk made linear, an index makes flat. Raised in review, which also
 * pointed out that the first estimate assumed a cadence nothing enforces.
 *
 * `keep` is the grace branch's, and it is the only place root-based revocation differs from walking
 * descendants rather than merely costing less: that branch drops the successors nobody received
 * while the token presenting itself stays live to mint another.
 */
/**
 * Is any token of this chain still live?
 *
 * A head carries NULL in `root_hash` — every root does, and so does every row written before the
 * column existed — so it cannot be found by chain and is asked for by name.
 *
 * That second clause is **defensive, and mutation testing says so**: removing it fails nothing,
 * because no reachable state has the head as the only live row. A rotation leaves the head live
 * beside exactly one live successor, and every branch that revokes the head revokes the chain with
 * it. It is kept because the alternative is a predicate that is true only by an argument about
 * reachability, three branches away from the code that would break it. `revokeChain` names the head
 * for the same reason, and there the clause **is** load-bearing — dropping it fails
 * `ends a chain from any link, including the token nobody is holding`.
 */
function chainHasLive(database: DatabaseSync, root: string): boolean {
  const live = database
    .prepare('SELECT 1 FROM sessions WHERE revoked_at IS NULL AND (root_hash = ? OR token_hash = ?) LIMIT 1')
    .get(root, root);

  return live !== undefined;
}

function revokeChain(database: DatabaseSync, root: string, now: number, keep?: string): void {
  database
    .prepare('UPDATE sessions SET revoked_at = ? WHERE root_hash = ? AND token_hash IS NOT ? AND revoked_at IS NULL')
    .run(now, root, keep ?? null);

  // A chain rooted before `root_hash` existed has NULL on its head, so the statement above cannot
  // reach it by chain. It is named directly instead.
  if (root !== keep) revoke(database, root, now);
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
    // A revoked token presented while its chain still holds a live one means **two parties hold
    // tokens from one chain**, and that is the leak signal. The chain goes.
    //
    // The test used to be revoked *and* rotated, which missed the case a reviewer reproduced: a
    // thief presents the predecessor inside the grace, the client's own successor is revoked under
    // it, and the client then presents a token that is revoked and never rotated. That answered
    // `gone` and left the thief refreshing for the remaining thirty days with nothing recorded.
    //
    // Asking the chain instead is both stricter and simpler. A chain with nothing live left is an
    // ended session — a logout, or a revocation that already happened — and answers `gone`, so this
    // no longer reports a replay for a session that merely finished.
    //
    // The cost is stated rather than hidden: whoever intercepts one answer in flight can now end the
    // session at will. Reading a response body already implies a position from which the session can
    // be taken outright, which is why this trade was made deliberately.
    if (!chainHasLive(database, chainOf(row, tokenHash))) {
      return { answer: { outcome: 'gone' }, commit: false };
    }

    revokeChain(database, chainOf(row, tokenHash), now);

    return { answer: { outcome: 'reused' }, commit: true };
  }

  if (rotatedAt !== undefined) {
    // Live, but its successor was never used: the answer carrying it did not arrive. Past the
    // ceiling the client has given up on, so does this — the chain goes rather than staying live
    // with nobody watching it.
    if (now > rotatedAt + graceMs) {
      revokeChain(database, chainOf(row, tokenHash), now);

      return { answer: { outcome: 'gone' }, commit: true };
    }

    // Inside it: mint a fresh successor and drop the one nobody received, so this token never has
    // two live successors. This token itself must survive — it is about to mint that successor.
    revokeChain(database, chainOf(row, tokenHash), now, tokenHash);
  }

  const identity = identityOf(row);
  if (identity === undefined) return { answer: { outcome: 'gone' }, commit: false };

  database
    .prepare(
      'INSERT INTO sessions (token_hash, subject, name, email, created_at, expires_at, predecessor_hash, root_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      successorHash,
      identity.subject,
      identity.name ?? null,
      identity.email ?? null,
      now,
      row.expires_at,
      tokenHash,
      chainOf(row, tokenHash),
    );

  // `rotated_at IS NULL` keeps the **first** rotation, which is what the grace is a ceiling on.
  // Writing `now` on every retry slides that ceiling: whoever holds this token re-presents it just
  // inside each window and it never retires, minting a successor each time. Raised in review.
  database
    .prepare('UPDATE sessions SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL')
    .run(now, tokenHash);

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
     * - **`reused`** — revoked, while something in the same chain is still live. Two parties hold
     *   tokens from one chain, so one of them copied theirs. The whole chain is revoked before this
     *   answers. A chain with nothing live left is an ended session and answers `gone` instead.
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
            'SELECT subject, name, email, expires_at, revoked_at, rotated_at, predecessor_hash, root_hash FROM sessions WHERE token_hash = ?',
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

    /**
     * Ends the session, and a session is the whole chain — in both directions (SKG-600).
     *
     * Revoking the presented row alone was enough before rotation. It is not now, and the first fix
     * for it only covered half the chain. Both halves were raised in review, one round apart:
     *
     * - **Forward.** A refresh whose answer was lost leaves storage holding a token that has already
     *   issued a successor. A logout with it revoked that token and left the successor live for the
     *   rest of the thirty days, held by nobody and revocable by nobody.
     * - **Backward.** A rotation does not revoke the token it rotated — only that token's successor
     *   *being used* retires it. So after `A -> B` the client holds B and A is live and rotated, and
     *   a logout with B left A usable inside its grace: whoever copied A presented it and got a
     *   fresh successor. The log out ended nothing. Measured before it was fixed.
     *
     * So it revokes by **chain**, not from the token presented. Any link ends the session.
     *
     * The answer stays derived from the presented row's own update. A logout on an already revoked
     * token must keep reading as "there was nothing live here" even when another row did change.
     */
    async revokeSession(tokenHash, now) {
      const database = connect(path);

      database.exec('BEGIN IMMEDIATE');
      try {
        const revoked = database
          .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
          .run(now, tokenHash);

        const row = database.prepare('SELECT root_hash FROM sessions WHERE token_hash = ?').get(tokenHash) as
          | { root_hash: unknown }
          | undefined;

        if (row !== undefined) revokeChain(database, chainOf(row, tokenHash), now);
        database.exec('COMMIT');

        return revoked.changes === 1;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
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

import type { Database, Queryable, Row } from './postgres.ts';
import { migrated } from './postgres-migrations.ts';
import { chainOf, identityOf } from './session-rows.ts';
import type { RotationOutcome, SessionStore } from './session.ts';

/**
 * The sessions in PostgreSQL (FRU-142): the same interface as `session-sqlite.ts`, the same names of
 * tables and columns, the same digests. `session-conformance.test.ts` holds both to the same cases.
 *
 * This store stays after better-auth: it holds the session of the extension.
 *
 * **What `BEGIN IMMEDIATE` did without saying it.** The SQLite store has one writer at a time for
 * the whole file, so nothing could write between a read and the write that followed it. Here two
 * refreshes are two connections, and each rule says in its SQL how it holds:
 *
 * - **A code is spent by one statement that reads what it changes.** Of two redemptions, the second
 *   `UPDATE` waits for the row, reads `redeemed_at` again, and changes nothing. The identity is read
 *   before, with no lock: nothing writes those columns after the pairing is made. The session is
 *   written in the same transaction, so a session that cannot be written leaves the code spendable.
 * - **A rotation and a log out hold the head of their chain** (`FOR UPDATE`) before they read the
 *   token. The four cases of a rotation are several statements, and no one of them decides alone:
 *   without the lock, two refreshes of one token both read « never rotated » and leave two live
 *   successors. The chain of a token never changes, so it is read first with no lock. The token is
 *   read after, when the chain is held: another call may have rotated or revoked it meanwhile.
 * - **An instant is a `BIGINT` of milliseconds that the worker gives.** The database never reads its
 *   clock: `now` and `expiresAt` come from the caller, as in the file.
 */

const SESSION_COLUMNS =
  'subject, name, email, workspace, expires_at, revoked_at, rotated_at, predecessor_hash, root_hash';

/**
 * Holds the chain of this token until the transaction ends, and answers the name of the chain.
 * `undefined`: no such token.
 *
 * The head is the one row that every token of a chain names, so two calls on one chain meet there.
 * The token is held too: a head that is gone leaves its tokens with nothing else to meet on. A purge
 * removes a whole chain in one statement, so that is a row somebody edited.
 */
async function holdChain(transaction: Queryable, tokenHash: string): Promise<string | undefined> {
  const named = (await transaction.query('SELECT root_hash FROM sessions WHERE token_hash = $1', [tokenHash])).rows[0];
  if (named === undefined) return undefined;

  const root = chainOf(named, tokenHash);
  // In one order for every call, so two calls that hold two rows never wait for each other.
  await transaction.query(
    'SELECT 1 FROM sessions WHERE token_hash = $1 OR token_hash = $2 ORDER BY token_hash FOR UPDATE',
    [root, tokenHash],
  );

  return root;
}

/** Marked, never deleted: a revoked row is what turns a later replay into `reused` rather than into an unknown token. */
async function revoke(transaction: Queryable, tokenHash: string, now: number): Promise<boolean> {
  const revoked = await transaction.query(
    'UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL',
    [now, tokenHash],
  );

  return revoked.rowCount === 1;
}

/**
 * Is any token of this chain still live?
 *
 * A head carries NULL in `root_hash`, so it cannot be found by chain and is asked for by name. See
 * `chainHasLive` of `session-sqlite.ts` for what that clause holds.
 */
async function chainHasLive(transaction: Queryable, root: string): Promise<boolean> {
  const live = await transaction.query(
    'SELECT 1 FROM sessions WHERE revoked_at IS NULL AND (root_hash = $1 OR token_hash = $1) LIMIT 1',
    [root],
  );

  return live.rows.length === 1;
}

/**
 * Every live token of one chain, revoked — except `keep`, when the caller still needs it.
 *
 * `IS DISTINCT FROM` and not `<>`: with no token to keep the value is NULL, and `<>` with a NULL is
 * never true, so nothing would be revoked.
 */
async function revokeChain(transaction: Queryable, root: string, now: number, keep?: string): Promise<void> {
  await transaction.query(
    'UPDATE sessions SET revoked_at = $1 WHERE root_hash = $2 AND token_hash IS DISTINCT FROM $3 AND revoked_at IS NULL',
    [now, root, keep ?? null],
  );

  // The head has NULL in `root_hash`, so the statement above cannot reach it by chain.
  if (root !== keep) await revoke(transaction, root, now);
}

/**
 * What this refresh token buys, decided on the row it names. The caller holds the chain.
 *
 * The four cases and the reason for each are in `decide` of `session-sqlite.ts`, and they are the
 * same here. One thing differs in form: the SQLite store rolls back when a row cannot be read as an
 * identity, to undo what the grace branch revoked. Here the identity is read before that branch
 * writes, so every path that answers has written exactly what stays.
 */
async function decide(
  transaction: Queryable,
  input: { row: Row | undefined; root: string; tokenHash: string; successorHash: string; now: number; graceMs: number },
): Promise<RotationOutcome> {
  const { row, root, tokenHash, successorHash, now, graceMs } = input;

  if (row === undefined || typeof row.expires_at !== 'number' || row.expires_at <= now) return { outcome: 'gone' };

  if (row.revoked_at !== null && row.revoked_at !== undefined) {
    // A revoked token presented while its chain still holds a live one: two parties hold tokens of
    // one chain, and the chain goes. A chain with nothing live left is a session that ended.
    if (!(await chainHasLive(transaction, root))) return { outcome: 'gone' };

    await revokeChain(transaction, root, now);

    return { outcome: 'reused' };
  }

  const rotatedAt = typeof row.rotated_at === 'number' ? row.rotated_at : undefined;

  // Live, its successor never used, and past the ceiling: the client gave up, and so does this.
  if (rotatedAt !== undefined && now > rotatedAt + graceMs) {
    await revokeChain(transaction, root, now);

    return { outcome: 'gone' };
  }

  const identity = identityOf(row);
  if (identity === undefined) return { outcome: 'gone' };

  // Inside the ceiling: drop the successor nobody received, so this token never has two live ones.
  // This token itself must survive: it is about to mint that successor.
  if (rotatedAt !== undefined) await revokeChain(transaction, root, now, tokenHash);

  // The successor takes the expiry of its predecessor: a rotation does not extend a session.
  await transaction.query(
    `INSERT INTO sessions
       (token_hash, subject, name, email, workspace, created_at, expires_at, predecessor_hash, root_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      successorHash,
      identity.subject,
      identity.name ?? null,
      identity.email ?? null,
      identity.workspace ?? null,
      now,
      row.expires_at,
      tokenHash,
      root,
    ],
  );

  // `rotated_at IS NULL` keeps the first rotation, which is what the grace is a ceiling on.
  await transaction.query('UPDATE sessions SET rotated_at = $1 WHERE token_hash = $2 AND rotated_at IS NULL', [
    now,
    tokenHash,
  ]);

  // Using a token is the proof its client received it, and that is what retires the one it replaced.
  if (typeof row.predecessor_hash === 'string') await revoke(transaction, row.predecessor_hash, now);

  return { outcome: 'rotated', identity };
}

export function createPostgresSessionStore(database: Database): SessionStore {
  /** The database, with its schema. The first call of a process applies the migrations. */
  const ready = async (): Promise<Database> => {
    await migrated(database);

    return database;
  };

  return {
    async createPairing({ codeHash, identity, expiresAt }) {
      await (
        await ready()
      ).query(
        `INSERT INTO pairings (code_hash, subject, name, email, workspace, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          codeHash,
          identity.subject,
          identity.name ?? null,
          identity.email ?? null,
          identity.workspace ?? null,
          Date.now(),
          expiresAt,
        ],
      );
    },

    async redeemPairing({ codeHash, tokenHash, expiresAt, now }) {
      return (await ready()).transaction(async (transaction) => {
        // Read before the code is spent: a pairing that cannot be read as a person must not cost
        // its code, and nothing writes these columns after the pairing is made.
        const row = (
          await transaction.query('SELECT subject, name, email, workspace FROM pairings WHERE code_hash = $1', [
            codeHash,
          ])
        ).rows[0];
        const identity = row === undefined ? undefined : identityOf(row);
        if (identity === undefined) return undefined;

        // One statement decides who spent it. The second of two calls waits for the row, reads
        // `redeemed_at` again, and changes nothing.
        const spent = await transaction.query(
          'UPDATE pairings SET redeemed_at = $1 WHERE code_hash = $2 AND redeemed_at IS NULL AND expires_at > $1',
          [now, codeHash],
        );
        if (spent.rowCount !== 1) return undefined;

        // In the same transaction: a session that cannot be written takes the spend back with it.
        await transaction.query(
          `INSERT INTO sessions (token_hash, subject, name, email, workspace, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            tokenHash,
            identity.subject,
            identity.name ?? null,
            identity.email ?? null,
            identity.workspace ?? null,
            now,
            expiresAt,
          ],
        );

        return identity;
      });
    },

    async rotateSession({ tokenHash, successorHash, now, graceMs }) {
      return (await ready()).transaction(async (transaction) => {
        const root = await holdChain(transaction, tokenHash);
        if (root === undefined) return { outcome: 'gone' };

        // Read now that the chain is held: this is the token as the call before left it.
        const row = (
          await transaction.query(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = $1`, [tokenHash])
        ).rows[0];

        return decide(transaction, { row, root, tokenHash, successorHash, now, graceMs });
      });
    },

    async revokeSession(tokenHash, now) {
      return (await ready()).transaction(async (transaction) => {
        const root = await holdChain(transaction, tokenHash);
        if (root === undefined) return false;

        // The answer is the presented row's own: a log out on a token already revoked says that
        // nothing live was there, even when another row of the chain changes.
        const revoked = await revoke(transaction, tokenHash, now);
        // A session is the whole chain, in both directions: any link ends it.
        await revokeChain(transaction, root, now);

        return revoked;
      });
    },

    async purge(now) {
      const db = await ready();
      // Expired rows go; revoked ones stay until they expire, so a replay of one still ends its chain.
      await db.query('DELETE FROM pairings WHERE expires_at <= $1', [now]);
      await db.query('DELETE FROM sessions WHERE expires_at <= $1', [now]);
    },
  };
}

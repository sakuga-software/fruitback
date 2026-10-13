import { and, count, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { ClaimOutcome, ConnectRow, ConnectStore } from './connect.ts';
import type { Database, Db } from './postgres.ts';
import { migrated } from './postgres-migrate.ts';
import { connect_requests, pairings, sessions } from './postgres-schema.ts';
import { chainOf, identityOf } from './session-rows.ts';
import { type RotationOutcome, type SessionStore, namedSessionsOf } from './session.ts';

/**
 * The sessions in PostgreSQL (FRU-142): the same interface as `session-sqlite.ts`, the same names of
 * tables and columns, the same digests. `session-conformance.test.ts` holds both to the same cases.
 *
 * The statements are written with Drizzle (FRU-180), on the tables of `postgres-schema.ts`.
 *
 * This store stays after better-auth: it holds the session of the extension.
 *
 * **What `BEGIN IMMEDIATE` did without saying it.** The SQLite store has one writer at a time for
 * the whole file, so nothing could write between a read and the write that followed it. Here two
 * refreshes are two connections, and each rule says in its statement how it holds:
 *
 * - **A code is spent by one statement that reads what it changes.** Of two redemptions, the second
 *   update waits for the row, reads `redeemed_at` again, and changes nothing. The identity is read
 *   before, with no lock: nothing writes those columns after the pairing is made. The session is
 *   written in the same transaction, so a session that cannot be written leaves the code spendable.
 * - **A rotation and a log out hold the head of their chain** (`for('update')`) before they read the
 *   token. The four cases of a rotation are several statements, and no one of them decides alone:
 *   without the lock, two refreshes of one token both read « never rotated » and leave two live
 *   successors. The chain of a token never changes, so it is read first with no lock. The token is
 *   read after, when the chain is held: another call may have rotated or revoked it meanwhile.
 * - **An instant is a `BIGINT` of milliseconds that the worker gives.** The database never reads its
 *   clock: `now` and `expiresAt` come from the caller, as in the file.
 *
 * **A write that must say whether it changed a row returns that row.** The two drivers of Drizzle do
 * not count the rows of a statement in the same way, and `returning` is the same on both.
 */

/** What a rotation reads of the token it is given. */
const SESSION = {
  subject: sessions.subject,
  name: sessions.name,
  email: sessions.email,
  workspace: sessions.workspace,
  expires_at: sessions.expires_at,
  revoked_at: sessions.revoked_at,
  rotated_at: sessions.rotated_at,
  predecessor_hash: sessions.predecessor_hash,
  root_hash: sessions.root_hash,
  account_id: sessions.account_id,
  browser: sessions.browser,
  connection_id: sessions.connection_id,
};

type SessionRow = {
  subject: string;
  name: string | null;
  email: string | null;
  workspace: string | null;
  expires_at: number;
  revoked_at: number | null;
  rotated_at: number | null;
  predecessor_hash: string | null;
  root_hash: string | null;
  account_id: string | null;
  browser: string | null;
  connection_id: string | null;
};

/**
 * Holds the chain of this token until the transaction ends, and answers the name of the chain.
 * `undefined`: no such token.
 *
 * The head is the one row that every token of a chain names, so two calls on one chain meet there.
 * The token is held too: a head that is gone leaves its tokens with nothing else to meet on. A purge
 * removes a whole chain in one statement, so that is a row somebody edited.
 */
async function holdChain(tx: Db, tokenHash: string): Promise<string | undefined> {
  const named = (
    await tx.select({ root_hash: sessions.root_hash }).from(sessions).where(eq(sessions.token_hash, tokenHash))
  )[0];
  if (named === undefined) return undefined;

  const root = chainOf(named, tokenHash);
  // In one order for every call, so two calls that hold two rows never wait for each other.
  await tx
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(or(eq(sessions.token_hash, root), eq(sessions.token_hash, tokenHash)))
    .orderBy(sessions.token_hash)
    .for('update');

  return root;
}

/** Marked, never deleted: a revoked row is what turns a later replay into `reused` rather than into an unknown token. */
async function revoke(tx: Db, tokenHash: string, now: number): Promise<boolean> {
  const revoked = await tx
    .update(sessions)
    .set({ revoked_at: now })
    .where(and(eq(sessions.token_hash, tokenHash), isNull(sessions.revoked_at)))
    .returning({ token_hash: sessions.token_hash });

  return revoked.length === 1;
}

/**
 * Is any token of this chain still live?
 *
 * A head carries NULL in `root_hash`, so it cannot be found by chain and is asked for by name. See
 * `chainHasLive` of `session-sqlite.ts` for what that clause holds.
 */
async function chainHasLive(tx: Db, root: string): Promise<boolean> {
  const live = await tx
    .select({ token_hash: sessions.token_hash })
    .from(sessions)
    .where(and(isNull(sessions.revoked_at), or(eq(sessions.root_hash, root), eq(sessions.token_hash, root))))
    .limit(1);

  return live.length === 1;
}

/**
 * Every live token of one chain, revoked — except `keep`, when the caller still needs it.
 *
 * `IS DISTINCT FROM` and not `<>`: with no token to keep the value is NULL, and `<>` with a NULL is
 * never true, so nothing would be revoked.
 */
async function revokeChain(tx: Db, root: string, now: number, keep?: string): Promise<void> {
  await tx
    .update(sessions)
    .set({ revoked_at: now })
    .where(
      and(
        eq(sessions.root_hash, root),
        sql`${sessions.token_hash} IS DISTINCT FROM ${keep ?? null}`,
        isNull(sessions.revoked_at),
      ),
    );

  // The head has NULL in `root_hash`, so the statement above cannot reach it by chain.
  if (root !== keep) await revoke(tx, root, now);
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
  tx: Db,
  input: {
    row: SessionRow | undefined;
    root: string;
    tokenHash: string;
    successorHash: string;
    now: number;
    graceMs: number;
  },
): Promise<RotationOutcome> {
  const { row, root, tokenHash, successorHash, now, graceMs } = input;

  if (row === undefined || row.expires_at <= now) return { outcome: 'gone' };

  if (row.revoked_at !== null) {
    // A revoked token presented while its chain still holds a live one: two parties hold tokens of
    // one chain, and the chain goes. A chain with nothing live left is a session that ended.
    if (!(await chainHasLive(tx, root))) return { outcome: 'gone' };

    await revokeChain(tx, root, now);

    return { outcome: 'reused' };
  }

  const rotatedAt = row.rotated_at ?? undefined;

  // Live, its successor never used, and past the ceiling: the client gave up, and so does this.
  if (rotatedAt !== undefined && now > rotatedAt + graceMs) {
    await revokeChain(tx, root, now);

    return { outcome: 'gone' };
  }

  const identity = identityOf(row);
  if (identity === undefined) return { outcome: 'gone' };

  // Inside the ceiling: drop the successor nobody received, so this token never has two live ones.
  // This token itself must survive: it is about to mint that successor.
  if (rotatedAt !== undefined) await revokeChain(tx, root, now, tokenHash);

  // The successor takes the expiry of its predecessor: a rotation does not extend a session.
  await tx.insert(sessions).values({
    token_hash: successorHash,
    subject: identity.subject,
    name: identity.name ?? null,
    email: identity.email ?? null,
    workspace: identity.workspace ?? null,
    created_at: now,
    expires_at: row.expires_at,
    predecessor_hash: tokenHash,
    root_hash: root,
    // A session of an account stays one (FRU-238), under its name in « My account ».
    account_id: row.account_id,
    browser: row.browser,
    connection_id: row.connection_id,
  });

  // `rotated_at IS NULL` keeps the first rotation, which is what the grace is a ceiling on.
  await tx
    .update(sessions)
    .set({ rotated_at: now })
    .where(and(eq(sessions.token_hash, tokenHash), isNull(sessions.rotated_at)));

  // Using a token is the proof its client received it, and that is what retires the one it replaced.
  if (row.predecessor_hash !== null) await revoke(tx, row.predecessor_hash, now);

  return { outcome: 'rotated', identity };
}

export function createPostgresSessionStore(database: Database): SessionStore {
  /** `work` on the database, with its schema. The first call of a process applies the migrations. */
  const run = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };

  /** `work` in one transaction, on the database with its schema. */
  const transaction = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.transaction(work);
  };

  return {
    async createPairing({ codeHash, identity, expiresAt }) {
      await run((db) =>
        db.insert(pairings).values({
          code_hash: codeHash,
          subject: identity.subject,
          name: identity.name ?? null,
          email: identity.email ?? null,
          workspace: identity.workspace ?? null,
          created_at: Date.now(),
          expires_at: expiresAt,
        }),
      );
    },

    async redeemPairing({ codeHash, tokenHash, expiresAt, now }) {
      return transaction(async (tx) => {
        // Read before the code is spent: a pairing that cannot be read as a person must not cost
        // its code, and nothing writes these columns after the pairing is made.
        const row = (
          await tx
            .select({
              subject: pairings.subject,
              name: pairings.name,
              email: pairings.email,
              workspace: pairings.workspace,
            })
            .from(pairings)
            .where(eq(pairings.code_hash, codeHash))
        )[0];
        const identity = row === undefined ? undefined : identityOf(row);
        if (identity === undefined) return undefined;

        // One statement decides who spent it. The second of two calls waits for the row, reads
        // `redeemed_at` again, and changes nothing.
        const spent = await tx
          .update(pairings)
          .set({ redeemed_at: now })
          .where(and(eq(pairings.code_hash, codeHash), isNull(pairings.redeemed_at), gt(pairings.expires_at, now)))
          .returning({ code_hash: pairings.code_hash });
        if (spent.length !== 1) return undefined;

        // In the same transaction: a session that cannot be written takes the spend back with it.
        await tx.insert(sessions).values({
          token_hash: tokenHash,
          subject: identity.subject,
          name: identity.name ?? null,
          email: identity.email ?? null,
          workspace: identity.workspace ?? null,
          created_at: now,
          expires_at: expiresAt,
        });

        return identity;
      });
    },

    async rotateSession({ tokenHash, successorHash, now, graceMs }) {
      return transaction(async (tx) => {
        const root = await holdChain(tx, tokenHash);
        if (root === undefined) return { outcome: 'gone' };

        // Read now that the chain is held: this is the token as the call before left it.
        const row = (await tx.select(SESSION).from(sessions).where(eq(sessions.token_hash, tokenHash)))[0];

        return decide(tx, { row, root, tokenHash, successorHash, now, graceMs });
      });
    },

    async revokeSession(tokenHash, now) {
      return transaction(async (tx) => {
        const root = await holdChain(tx, tokenHash);
        if (root === undefined) return false;

        // The answer is the presented row's own: a log out on a token already revoked says that
        // nothing live was there, even when another row of the chain changes.
        const revoked = await revoke(tx, tokenHash, now);
        // A session is the whole chain, in both directions: any link ends it.
        await revokeChain(tx, root, now);

        return revoked;
      });
    },

    async endSessionsOf(of, now) {
      const { subject, workspace } = namedSessionsOf(of);
      const theirs = (table: typeof sessions | typeof pairings) =>
        and(
          subject === undefined ? undefined : eq(table.subject, subject),
          workspace === undefined ? undefined : eq(table.workspace, workspace),
        );

      await transaction(async (tx) => {
        // Every row of these chains is held first, their heads among them: a head carries the person
        // and the workspace of its chain. A rotation holds its head before it writes, so one that
        // runs now ends before this line answers, and none starts after it. The statement below then
        // reads the successor that such a rotation wrote: without this hold, it would not see a row
        // that was written after it started, and that successor would stay live.
        await tx
          .select({ token_hash: sessions.token_hash })
          .from(sessions)
          .where(theirs(sessions))
          .orderBy(sessions.token_hash)
          .for('update');
        await tx
          .update(sessions)
          .set({ revoked_at: now })
          .where(and(isNull(sessions.revoked_at), theirs(sessions)));
        // A code that nobody redeemed yet would open a session for a membership that is gone.
        await tx
          .update(pairings)
          .set({ redeemed_at: now })
          .where(and(isNull(pairings.redeemed_at), theirs(pairings)));
      });
    },

    async purge(now) {
      // Expired rows go; revoked ones stay until they expire, so a replay of one still ends its chain.
      await run((db) => db.delete(pairings).where(lte(pairings.expires_at, now)));
      await run((db) => db.delete(sessions).where(lte(sessions.expires_at, now)));
    },

    async holdsSession() {
      const rows = await run((db) => db.select({ token_hash: sessions.token_hash }).from(sessions).limit(1));

      return rows.length > 0;
    },
  };
}

/** A row of `connect_requests`, as `connect.ts` reads it. */
function connectRowOf(row: typeof connect_requests.$inferSelect): ConnectRow {
  return {
    word: row.word,
    browser: row.browser,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.outcome === 'approved' || row.outcome === 'refused' ? { outcome: row.outcome } : {}),
    ...(row.account_id === null ? {} : { account: row.account_id }),
    ...(row.answered_at === null ? {} : { answeredAt: row.answered_at }),
    ...(row.claimed_at === null ? {} : { claimedAt: row.claimed_at }),
    misses: row.misses,
  };
}

/**
 * The requests of the extension, approved in the console (FRU-238), beside the sessions they open.
 *
 * Each rule holds in one statement that reads what it changes, as the spend of a pairing code does:
 *
 * - **An answer is one `UPDATE … WHERE outcome IS NULL`.** Of two answers at the same instant, the
 *   second waits for the row, reads `outcome` again, and changes nothing: `already`.
 * - **A claim is spent by one `UPDATE … WHERE claimed_at IS NULL`, and the session is written in the
 *   same transaction.** Of two claims, one gets a session. A session that cannot be written leaves
 *   the request to claim.
 * - **Expiry is compared in the statement**, with the instant of the worker: an answer or a claim at
 *   the instant of expiry changes nothing.
 */
export function createPostgresConnectStore(database: Database): ConnectStore {
  const run = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.run(work);
  };
  const transaction = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    await migrated(database);

    return database.transaction(work);
  };
  const live = (now: number) =>
    and(isNull(connect_requests.outcome), isNull(connect_requests.claimed_at), gt(connect_requests.expires_at, now));

  return {
    async createRequest({ requestHash, claimHash, word, browser, now, expiresAt, maxLive }) {
      return run(async (db) => {
        // Counted, then written: two requests at the same instant may both pass the last place. The
        // bound is of a flood, and one more row is no flood.
        const [waiting] = await db.select({ count: count() }).from(connect_requests).where(live(now));
        if ((waiting?.count ?? 0) >= maxLive) return 'busy';
        await db.insert(connect_requests).values({
          request_hash: requestHash,
          claim_hash: claimHash,
          word,
          browser,
          created_at: now,
          expires_at: expiresAt,
        });

        return 'created';
      });
    },

    async readRequest(requestHash) {
      const rows = await run((db) =>
        db.select().from(connect_requests).where(eq(connect_requests.request_hash, requestHash)),
      );

      return rows[0] === undefined ? undefined : connectRowOf(rows[0]);
    },

    async answer({ requestHash, account, outcome, now }) {
      return run(async (db) => {
        const answered = await db
          .update(connect_requests)
          .set({ outcome, account_id: account, answered_at: now })
          .where(and(eq(connect_requests.request_hash, requestHash), live(now)))
          .returning({ request_hash: connect_requests.request_hash });
        if (answered.length === 1) return { ok: true };

        const row = (await db.select().from(connect_requests).where(eq(connect_requests.request_hash, requestHash)))[0];
        if (row === undefined) return { ok: false, reason: 'unknown' };
        if (row.outcome !== null || row.claimed_at !== null) return { ok: false, reason: 'already' };

        return { ok: false, reason: 'expired' };
      });
    },

    async miss(requestHash, now, max) {
      const missed = await run((db) =>
        db
          .update(connect_requests)
          .set({
            misses: sql`${connect_requests.misses} + 1`,
            // The last word allowed refuses the request, in the same statement that counts it.
            outcome: sql`CASE WHEN ${connect_requests.misses} + 1 >= ${max} THEN 'refused' ELSE NULL END`,
            answered_at: sql`CASE WHEN ${connect_requests.misses} + 1 >= ${max} THEN ${now}::bigint ELSE NULL END`,
          })
          .where(and(eq(connect_requests.request_hash, requestHash), live(now)))
          .returning({ misses: connect_requests.misses }),
      );

      return missed[0] === undefined ? undefined : Math.max(0, max - missed[0].misses);
    },

    async claim({ claimHash, now, tokenHash, connectionId, expiresAt, open }): Promise<ClaimOutcome> {
      return transaction(async (tx) => {
        // The outcome and the expiry are read with no lock: neither ever goes back. An answer is given
        // once, and `now` is the instant of this call.
        const row = (await tx.select().from(connect_requests).where(eq(connect_requests.claim_hash, claimHash)))[0];
        if (row === undefined || row.expires_at <= now) return { state: 'gone' };
        if (row.outcome === 'refused') return { state: 'refused' };
        if (row.outcome !== 'approved' || row.account_id === null) return { state: 'pending' };

        // Who claims it is the one thing two claims can both read as open: one statement decides. The
        // second of two claims waits for the row, reads `claimed_at` again, and changes nothing.
        const spent = await tx
          .update(connect_requests)
          .set({ claimed_at: now })
          .where(and(eq(connect_requests.claim_hash, claimHash), isNull(connect_requests.claimed_at)))
          .returning({ account_id: connect_requests.account_id, browser: connect_requests.browser });
        const claimed = spent[0];
        if (claimed === undefined || claimed.account_id === null) return { state: 'gone' };

        // The account as it is now: one deleted since the approval opens nothing.
        const person = await open(claimed.account_id);
        if (person === undefined) return { state: 'gone' };

        // In the same transaction: a session that cannot be written takes the claim back with it.
        await tx.insert(sessions).values({
          token_hash: tokenHash,
          subject: claimed.account_id,
          name: person.name ?? null,
          email: person.email ?? null,
          workspace: null,
          created_at: now,
          expires_at: expiresAt,
          account_id: claimed.account_id,
          browser: claimed.browser,
          connection_id: connectionId,
        });

        return { state: 'claimed', account: claimed.account_id, browser: claimed.browser };
      });
    },

    async browsersOf(account, now) {
      const rows = await run((db) =>
        db
          .select({
            id: sessions.connection_id,
            browser: sql<string>`max(${sessions.browser})`,
            // Through the column, so the driver's string is read as the number the column is.
            connectedAt: sql<number>`min(${sessions.created_at})`.mapWith(sessions.created_at),
            usedAt: sql<number>`max(${sessions.created_at})`.mapWith(sessions.created_at),
          })
          .from(sessions)
          .where(eq(sessions.account_id, account))
          .groupBy(sessions.connection_id)
          // A connection is listed while one token of its chain is live.
          .having(sql`bool_or(${sessions.revoked_at} IS NULL AND ${sessions.expires_at} > ${now})`)
          .orderBy(sql`max(${sessions.created_at}) DESC`),
      );

      return rows.flatMap((row) =>
        row.id === null
          ? []
          : [{ id: row.id, browser: row.browser ?? '', connectedAt: row.connectedAt, usedAt: row.usedAt }],
      );
    },

    async endBrowser(account, connectionId, now) {
      return transaction(async (tx) => {
        const theirs = and(eq(sessions.account_id, account), eq(sessions.connection_id, connectionId));
        // Held first, as `endSessionsOf` holds them: a rotation that runs now ends before the update
        // below starts, and the update then reads the successor it wrote.
        await tx
          .select({ token_hash: sessions.token_hash })
          .from(sessions)
          .where(theirs)
          .orderBy(sessions.token_hash)
          .for('update');
        const ended = await tx
          .update(sessions)
          .set({ revoked_at: now })
          .where(and(theirs, isNull(sessions.revoked_at), gt(sessions.expires_at, now)))
          .returning({ token_hash: sessions.token_hash });

        return ended.length > 0;
      });
    },

    async purge(now) {
      await run((db) => db.delete(connect_requests).where(lte(connect_requests.expires_at, now)));
    },
  };
}

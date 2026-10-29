import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  type Subject,
  type Violation,
  describeConformance,
  describeControls,
  factoriesOf,
  mutatedModule,
  turn,
} from './conformance.fixture.ts';
import type { Database } from './postgres.ts';
import {
  NO_REAL_POSTGRES,
  createMigratedPgliteDatabase,
  createMigratedRealDatabase,
  onDatabase,
} from './postgres.fixture.ts';
import type { RotationOutcome, SessionIdentity, SessionStore } from './session.ts';
import { sessionCases } from './session-conformance.fixture.ts';
import { createPostgresSessionStore } from './session-postgres.ts';

/**
 * Each `SessionStore` against the conformance suite (FRU-140). A new implementation adds a subject
 * here: the last test of this file fails until it does.
 */

const PGLITE = onDatabase(
  'the PostgreSQL session store, on PGlite',
  'createPostgresSessionStore',
  createMigratedPgliteDatabase,
  createPostgresSessionStore,
);

const SUBJECTS: Subject<SessionStore>[] = [
  PGLITE,
  // The same store on a server, where two refreshes are two connections.
  onDatabase(
    'the PostgreSQL session store, on a real server',
    'createPostgresSessionStore',
    createMigratedRealDatabase,
    createPostgresSessionStore,
    NO_REAL_POSTGRES,
  ),
];

for (const subject of SUBJECTS) describeConformance('SessionStore', sessionCases, subject);

/**
 * A store in memory that reads a token, waits a turn of the event loop, then writes what it decided
 * on what it read. One call after the other, it answers as the real store does. Two calls on one
 * chain at the same moment both decide before either writes: that is a store on a network that
 * nothing makes wait for the chain.
 */
function decidesThenWaits(real: SessionStore): SessionStore {
  type Held = {
    identity: SessionIdentity;
    expiresAt: number;
    root: string;
    predecessor?: string;
    revokedAt?: number;
    rotatedAt?: number;
  };
  const pairings = new Map<string, SessionIdentity>();
  const sessions = new Map<string, Held>();
  const chain = (root: string) => [...sessions].filter(([hash, session]) => session.root === root || hash === root);
  const revokeChain = (root: string, now: number, keep?: string) => {
    for (const [hash, session] of chain(root)) if (hash !== keep) session.revokedAt ??= now;
  };

  return {
    ...real,
    async createPairing(pairing) {
      pairings.set(pairing.codeHash, pairing.identity);
    },
    async redeemPairing({ codeHash, tokenHash, expiresAt }) {
      const identity = pairings.get(codeHash);
      if (identity === undefined) return undefined;
      pairings.delete(codeHash);
      sessions.set(tokenHash, { identity, expiresAt, root: tokenHash });

      return identity;
    },
    async purge() {},
    // It reads the live tokens of the person, waits, then ends the ones it read.
    async endSessionsOf(of, now) {
      const read = [...sessions].filter(
        ([, session]) =>
          session.revokedAt === undefined &&
          (of.subject === undefined || session.identity.subject === of.subject) &&
          (of.workspace === undefined || session.identity.workspace === of.workspace),
      );
      await turn();
      for (const [, session] of read) session.revokedAt ??= now;
    },
    async rotateSession({ tokenHash, successorHash, now, graceMs }): Promise<RotationOutcome> {
      const row = sessions.get(tokenHash);
      if (row === undefined || row.expiresAt <= now) return { outcome: 'gone' };
      // The token as it was read. Everything below is decided on this copy.
      const read = { ...row };
      await turn();

      if (read.revokedAt !== undefined) {
        if (!chain(read.root).some(([, session]) => session.revokedAt === undefined)) return { outcome: 'gone' };
        revokeChain(read.root, now);

        return { outcome: 'reused' };
      }
      if (read.rotatedAt !== undefined) {
        if (now > read.rotatedAt + graceMs) {
          revokeChain(read.root, now);

          return { outcome: 'gone' };
        }
        revokeChain(read.root, now, tokenHash);
      }

      sessions.set(successorHash, {
        identity: read.identity,
        expiresAt: read.expiresAt,
        root: read.root,
        predecessor: tokenHash,
      });
      row.rotatedAt ??= now;
      const before = read.predecessor === undefined ? undefined : sessions.get(read.predecessor);
      if (before !== undefined) before.revokedAt ??= now;

      return { outcome: 'rotated', identity: read.identity };
    },
  };
}

const REPLAY_ANSWER = "await revokeChain(tx, root, now);\n\n    return { outcome: 'reused' };";
const SPEND_THE_CODE = 'eq(pairings.code_hash, codeHash), isNull(pairings.redeemed_at), gt(pairings.expires_at, now)';
const EXPIRED_OR_UNKNOWN = "if (row === undefined || row.expires_at <= now) return { outcome: 'gone' };";
const PAST_THE_GRACE = 'if (rotatedAt !== undefined && now > rotatedAt + graceMs) {';
const DROP_ORPHANS = 'if (rotatedAt !== undefined) await revokeChain(tx, root, now, tokenHash);';
const RETIRE_PREDECESSOR = 'if (row.predecessor_hash !== null) await revoke(tx, row.predecessor_hash, now);';
const NAME_THE_HEAD = 'if (root !== keep) await revoke(tx, root, now);';
const CHAIN_IS_DEAD = "if (!(await chainHasLive(tx, root))) return { outcome: 'gone' };";
const PURGE_SESSIONS = 'db.delete(sessions).where(lte(sessions.expires_at, now))';
const END_SESSIONS = '.where(and(isNull(sessions.revoked_at), theirs(sessions)));';
const SPEND_CODES = '.where(and(isNull(pairings.redeemed_at), theirs(pairings)));';
const OF_THE_PERSON = 'subject === undefined ? undefined : eq(sessions.subject, subject)';
const OF_THE_WORKSPACE = 'workspace === undefined ? undefined : eq(sessions.workspace, workspace)';

/** One change to `session-postgres.ts`, or one store around it, for each case: the case must fail. */
const VIOLATIONS: Violation<SessionStore>[] = [
  {
    breaks: 'writes the name a person chose on their live sessions and codes, and on nobody else (FRU-249)',
    by: 'renames every session of the worker',
    replace: {
      from: '.where(and(eq(sessions.subject, subject), isNull(sessions.revoked_at), gt(sessions.expires_at, now)));',
      to: '.where(and(isNull(sessions.revoked_at), gt(sessions.expires_at, now)));',
    },
  },
  {
    breaks: 'writes the name a person chose on their live sessions and codes, and on nobody else (FRU-249)',
    by: 'leaves the codes that wait with the name of before',
    replace: {
      from: 'eq(pairings.subject, subject), isNull(pairings.redeemed_at), gt(pairings.expires_at, now)',
      to: 'sql`false`',
    },
  },
  {
    breaks: 'writes the primary address a person chose on their live sessions and codes, and on nobody else (FRU-450)',
    by: 'writes the address as the name',
    replace: {
      from: 'await rewriteSessionsOf(subject, { email }, now);',
      to: 'await rewriteSessionsOf(subject, { name: email }, now);',
    },
  },
  {
    breaks: 'opens a session for the person the operator named, not for whoever redeemed',
    by: 'does not keep the name of a pairing',
    replace: { after: 'async createPairing(', from: 'name: identity.name ?? null,', to: 'name: null,' },
  },
  {
    breaks: 'spends the code, so a second reviewer with the same code gets nothing',
    by: 'redeems a code each time it is asked',
    replace: { from: SPEND_THE_CODE, to: 'eq(pairings.code_hash, codeHash), gt(pairings.expires_at, now)' },
  },
  {
    breaks: 'gives one session to two reviewers who redeem one code at the same moment',
    by: 'reads the code, waits, then marks it spent',
    wrap: (real) => {
      const pairings = new Map<string, SessionIdentity>();
      const spent = new Set<string>();

      return {
        ...real,
        async createPairing(pairing) {
          pairings.set(pairing.codeHash, pairing.identity);
        },
        async redeemPairing({ codeHash }) {
          const identity = pairings.get(codeHash);
          if (identity === undefined || spent.has(codeHash)) return undefined;
          await turn();
          spent.add(codeHash);

          return identity;
        },
      };
    },
  },
  {
    breaks: 'refuses a code at its expiry, and after, with no purge before',
    by: 'never reads the expiry of a code',
    replace: { from: SPEND_THE_CODE, to: 'eq(pairings.code_hash, codeHash), isNull(pairings.redeemed_at)' },
  },
  {
    breaks: 'refuses a code at its expiry, and after, with no purge before',
    by: 'still takes a code at the instant of its expiry',
    replace: {
      from: SPEND_THE_CODE,
      to: 'eq(pairings.code_hash, codeHash), isNull(pairings.redeemed_at), sql`${pairings.expires_at} >= ${now}`',
    },
  },
  {
    breaks: 'leaves the code spendable when the session cannot be written',
    by: 'keeps the code spent when the session failed',
    replace: {
      after: 'async redeemPairing(',
      from: 'return transaction(async (tx) => {',
      to: 'return run(async (tx) => {',
    },
  },
  {
    breaks: 'refuses a pairing whose subject is an empty string',
    by: 'takes an empty subject',
    // The parser of a row is in `session-rows.ts`. The change is where this store reads its answer:
    // a row that is no person is taken as one.
    replace: {
      from: 'const identity = row === undefined ? undefined : identityOf(row);',
      to: "const identity = row === undefined ? undefined : (identityOf(row) ?? { subject: '' });",
    },
  },
  {
    breaks: 'keeps the workspace of a pairing through every rotation',
    by: 'does not copy the workspace to a successor',
    replace: {
      after: 'async function decide(',
      from: 'workspace: identity.workspace ?? null,',
      to: 'workspace: null,',
    },
  },
  {
    breaks: 'refuses a refresh token that was never issued',
    by: 'rotates a token it does not know',
    wrap: (real) => ({
      ...real,
      async rotateSession(rotation) {
        const answer = await real.rotateSession(rotation);

        return answer.outcome === 'gone' ? { outcome: 'rotated', identity: { subject: 'anybody' } } : answer;
      },
    }),
  },
  {
    breaks: 'refuses a session past its expiry',
    by: 'never reads the expiry of a session',
    replace: { from: EXPIRED_OR_UNKNOWN, to: "if (row === undefined) return { outcome: 'gone' };" },
  },
  {
    breaks: 'refuses a session past its expiry',
    by: 'still takes a token at the instant of its expiry',
    replace: { after: 'async function decide(', from: 'row.expires_at <= now', to: 'row.expires_at < now' },
  },
  {
    breaks: 'answers rotated, gone and reused for the three things a token can be',
    by: 'calls a replay an ended session',
    replace: { from: REPLAY_ANSWER, to: "await revokeChain(tx, root, now);\n\n    return { outcome: 'gone' };" },
  },
  {
    breaks: 'revokes on the worker, so the refresh token stops working everywhere',
    by: 'rotates a token that is revoked',
    replace: { from: 'if (row.revoked_at !== null) {', to: 'if (false) {' },
  },
  {
    breaks: 'treats a second logout as a no-op rather than an error',
    by: 'answers that every log out revoked something',
    replace: { from: 'return revoked.length === 1;', to: 'return true;' },
  },
  {
    breaks: 'leaves every other session alone',
    by: 'revokes every chain with one',
    replace: { after: 'async function revokeChain(', from: 'eq(sessions.root_hash, root),', to: 'sql`true`,' },
  },
  {
    breaks: 'hands back a new refresh token, and the new one works',
    by: 'does not copy the name to a successor',
    replace: { after: 'async function decide(', from: 'name: identity.name ?? null,', to: 'name: null,' },
  },
  {
    breaks: 'keeps the old token usable until the new one is used',
    by: 'gives a rotated token no grace',
    replace: { from: PAST_THE_GRACE, to: 'if (rotatedAt !== undefined && now >= rotatedAt) {' },
  },
  {
    breaks: 'takes a third presentation inside the ceiling, not just a second',
    by: 'revokes the token that presents itself with the successors nobody received',
    replace: { from: DROP_ORPHANS, to: 'if (rotatedAt !== undefined) await revokeChain(tx, root, now);' },
  },
  {
    breaks: 'drops the successor that was never received',
    by: 'keeps every successor of a token live',
    replace: { from: DROP_ORPHANS, to: '' },
  },
  {
    breaks: 'ends the chain when an orphan is presented and something in it is still live',
    by: 'rolls the revocation of the chain back',
    replace: { from: REPLAY_ANSWER, to: "return { outcome: 'reused' };" },
  },
  {
    breaks: 'answers a token from a chain that is entirely revoked without calling it a replay',
    by: 'calls every revoked token a replay',
    replace: { from: CHAIN_IS_DEAD, to: '' },
  },
  {
    breaks: 'retires the old token the moment the new one is used',
    by: 'never retires a predecessor',
    replace: { from: RETIRE_PREDECESSOR, to: '' },
  },
  {
    breaks: 'revokes the whole chain when a retired token is replayed',
    by: 'refuses the replay and leaves the chain live',
    replace: { from: REPLAY_ANSWER, to: "return { outcome: 'reused' };" },
  },
  {
    breaks: 'gives up on a rotated token once the grace has run out, and takes the chain with it',
    by: 'has a grace with no end',
    replace: { from: PAST_THE_GRACE, to: 'if (false) {' },
  },
  {
    breaks: 'gives up on a rotated token once the grace has run out, and takes the chain with it',
    by: 'refuses the late token and leaves its successor live',
    replace: { after: PAST_THE_GRACE, from: 'await revokeChain(tx, root, now);', to: '' },
  },
  {
    breaks: 'still accepts the retry the grace exists for, at the last moment it covers',
    by: 'ends the grace one instant early',
    replace: { from: PAST_THE_GRACE, to: 'if (rotatedAt !== undefined && now >= rotatedAt + graceMs) {' },
  },
  {
    breaks: 'does not extend the session it rotates',
    by: 'gives a successor an expiry of its own',
    replace: {
      after: 'async function decide(',
      from: 'expires_at: row.expires_at,',
      to: 'expires_at: Number(row.expires_at) * 2,',
    },
  },
  {
    breaks: 'tells a logged-out token apart from a replayed one',
    by: 'calls every revoked token a replay',
    replace: { from: CHAIN_IS_DEAD, to: '' },
  },
  {
    breaks: 'does not extend the grace by retrying inside it',
    by: 'writes the instant of every rotation',
    replace: {
      from: '.where(and(eq(sessions.token_hash, tokenHash), isNull(sessions.rotated_at)));',
      to: '.where(eq(sessions.token_hash, tokenHash));',
    },
  },
  {
    breaks: 'ends the whole chain on log out, not only the token it was handed',
    by: 'revokes the row it was handed alone',
    replace: { after: 'async revokeSession(', from: 'await revokeChain(tx, root, now);', to: '' },
  },
  {
    breaks: 'ends a chain from any link, including the token nobody is holding',
    by: 'does not revoke the head of a chain by its name',
    replace: { from: NAME_THE_HEAD, to: '' },
  },
  {
    breaks: 'reaches the live head of a forked chain when the log out comes from a leaf',
    by: 'does not revoke the head of a chain by its name',
    replace: { from: NAME_THE_HEAD, to: '' },
  },
  {
    breaks: 'answers false on a token already revoked, whatever the chain did',
    by: 'answers for the chain, and not for the row it was handed',
    replace: { after: 'async revokeSession(', from: 'return revoked;', to: 'return true;' },
  },
  {
    breaks: 'leaves the token a client just received alone when its predecessor is retired',
    by: 'retires the whole chain with the predecessor',
    replace: {
      from: RETIRE_PREDECESSOR,
      to: 'if (row.predecessor_hash !== null) await revokeChain(tx, root, now);',
    },
  },
  {
    breaks: 'revokes a forked chain to its tip when the root is replayed',
    by: 'revokes the direct successors of the root alone',
    replace: {
      after: 'async function revokeChain(',
      from: 'eq(sessions.root_hash, root),',
      to: 'eq(sessions.predecessor_hash, root),',
    },
  },
  {
    breaks: 'serves whoever presents last inside the grace, until the earlier holder comes back',
    by: 'keeps every successor of a token live',
    replace: { from: DROP_ORPHANS, to: '' },
  },
  {
    breaks: 'names the chain of a token, the head for the first and every successor alike',
    by: 'names each token as a chain of its own',
    replace: { after: 'async chainOf(tokenHash)', from: 'chainOf(rows[0], tokenHash)', to: 'tokenHash' },
  },
  {
    breaks: 'answers the person of a chain while one of its tokens lives, and nobody once it ended or expired',
    by: 'answers the person of a chain that ended',
    replace: { after: 'async liveIdentity(', from: 'isNull(sessions.revoked_at),', to: '' },
  },
  {
    breaks: 'answers the person of a chain while one of its tokens lives, and nobody once it ended or expired',
    by: 'answers the person of a chain that expired',
    replace: { after: 'async liveIdentity(', from: 'gt(sessions.expires_at, now),', to: '' },
  },
  {
    breaks: 'holds no session until a code is spent, and holds one after, ended or not',
    by: 'counts a code that nobody spent as a session',
    replace: {
      from: 'db.select({ token_hash: sessions.token_hash }).from(sessions).limit(1)',
      to: 'db.select({ code_hash: pairings.code_hash }).from(pairings).limit(1)',
    },
  },
  {
    breaks: 'drops the codes and the sessions that are expired, and nothing that is not',
    by: 'keeps the codes that are expired',
    replace: {
      from: 'db.delete(pairings).where(lte(pairings.expires_at, now))',
      to: 'db.delete(pairings).where(sql`false`)',
    },
  },
  {
    breaks: 'drops the codes and the sessions that are expired, and nothing that is not',
    by: 'keeps the sessions that are expired',
    replace: { from: PURGE_SESSIONS, to: 'db.delete(sessions).where(sql`false`)' },
  },
  {
    breaks: 'ends every session of a person in a workspace, from any link of each chain',
    by: 'ends nothing when a member is removed',
    replace: { from: END_SESSIONS, to: '.where(sql`false`);' },
  },
  {
    breaks: 'ends every session of a person in a workspace, from any link of each chain',
    by: 'ends the tokens that never issued a successor, and leaves the others',
    replace: {
      from: END_SESSIONS,
      to: '.where(and(isNull(sessions.rotated_at), isNull(sessions.revoked_at), theirs(sessions)));',
    },
  },
  {
    breaks: 'leaves the same person in another workspace, and another person in the same one',
    by: 'ends every session of the person, whatever the workspace',
    replace: { from: END_SESSIONS, to: `.where(and(isNull(sessions.revoked_at), ${OF_THE_PERSON}));` },
  },
  {
    breaks: 'leaves the same person in another workspace, and another person in the same one',
    by: 'ends every session of the workspace, whoever the person',
    replace: { from: END_SESSIONS, to: `.where(and(isNull(sessions.revoked_at), ${OF_THE_WORKSPACE}));` },
  },
  {
    breaks: 'ends every session of a workspace when no person is named, and of a person when no workspace is',
    by: 'ends nothing when no person is named',
    replace: {
      from: END_SESSIONS,
      to: `.where(and(isNull(sessions.revoked_at), subject === undefined ? sql\`false\` : eq(sessions.subject, subject), ${OF_THE_WORKSPACE}));`,
    },
  },
  {
    breaks: 'ends every session of a workspace when no person is named, and of a person when no workspace is',
    by: 'keeps the sessions that name no workspace when the person is the only name',
    replace: {
      from: END_SESSIONS,
      to: `.where(and(isNull(sessions.revoked_at), ${OF_THE_PERSON}, workspace === undefined ? sql\`\${sessions.workspace} IS NOT NULL\` : eq(sessions.workspace, workspace)));`,
    },
  },
  {
    breaks: 'spends the codes minted for the person in the workspace, and no other code',
    by: 'leaves the code of a removed member spendable',
    replace: { from: SPEND_CODES, to: '.where(sql`false`);' },
  },
  {
    breaks: 'spends the codes minted for the person in the workspace, and no other code',
    by: 'spends every code of the workspace',
    replace: {
      from: SPEND_CODES,
      to: '.where(and(isNull(pairings.redeemed_at), workspace === undefined ? undefined : eq(pairings.workspace, workspace)));',
    },
  },
  {
    breaks: 'ends nothing, and throws, when neither a person nor a workspace is named',
    by: 'ends every session when nobody is named',
    wrap: (real) => ({
      ...real,
      async endSessionsOf(of, now) {
        const all = of.subject || of.workspace ? of : { subject: 'alice' };
        await real.endSessionsOf(all, now);
        if (all !== of) throw new Error('names neither a person nor a workspace');
      },
    }),
  },
  {
    breaks: 'leaves no live successor when a refresh and the end of the sessions run at the same moment',
    by: 'reads the live tokens, waits, then ends the ones it read',
    wrap: decidesThenWaits,
  },
  {
    breaks: 'never leaves two live successors when one token is refreshed twice at the same moment',
    by: 'reads a token, waits, then writes what it decided',
    wrap: decidesThenWaits,
  },
  {
    breaks: 'ends the session when a token and its successor are refreshed at the same moment',
    by: 'reads a token, waits, then writes what it decided',
    wrap: decidesThenWaits,
  },
  {
    breaks: 'drops the codes and the sessions that are expired, and nothing that is not',
    by: 'drops every session',
    replace: { from: PURGE_SESSIONS, to: 'db.delete(sessions)' },
  },
  {
    breaks: 'keeps a revoked session until it expires, so a replay of it still ends the chain',
    by: 'drops a session when it is revoked',
    replace: {
      from: PURGE_SESSIONS,
      to: 'db.delete(sessions).where(or(lte(sessions.expires_at, now), sql`${sessions.revoked_at} IS NOT NULL`))',
    },
  },
];

describeControls('SessionStore', sessionCases, VIOLATIONS, PGLITE, async (change) => {
  const mutant = await mutatedModule('session-postgres.ts', change);
  let database: Database | undefined;

  return {
    factory: 'createPostgresSessionStore',
    label: 'a changed PostgreSQL session store',
    async open() {
      database = await createMigratedPgliteDatabase();
      const create = mutant.module.createPostgresSessionStore as (database: Database) => SessionStore;

      return create(database);
    },
    async close() {
      await database?.close();
      database = undefined;
      mutant.remove();
    },
  };
});

describe('the SessionStore conformance suite', () => {
  it('runs for every implementation the worker exports', () => {
    assert.deepEqual([...new Set(SUBJECTS.map((subject) => subject.factory))].sort(), factoriesOf('SessionStore'));
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type FileStoreModule,
  type Subject,
  type Violation,
  describeConformance,
  describeControls,
  factoriesOf,
  mutatedModule,
  onFile,
  turn,
} from './conformance.fixture.ts';
import type { SessionIdentity, SessionStore } from './session.ts';
import { sessionCases } from './session-conformance.fixture.ts';
import { closeSessionConnections, createSqliteSessionStore } from './session-sqlite.ts';

/**
 * Each `SessionStore` against the conformance suite (FRU-140). A new implementation adds a subject
 * here: the last test of this file fails until it does.
 */

const SQLITE = onFile<SessionStore>('the SQLite session store', 'createSqliteSessionStore', () => ({
  create: createSqliteSessionStore,
  close: closeSessionConnections,
}));

const SUBJECTS: Subject<SessionStore>[] = [SQLITE];

for (const subject of SUBJECTS) describeConformance('SessionStore', sessionCases, subject);

const REPLAY_ANSWER = "return { answer: { outcome: 'reused' }, commit: true };";
const EXPIRED_OR_UNKNOWN = "if (row === undefined || typeof row.expires_at !== 'number' || row.expires_at <= now) {";
const PAST_THE_GRACE = 'if (now > rotatedAt + graceMs) {';
const DROP_ORPHANS = 'revokeChain(database, chainOf(row, tokenHash), now, tokenHash);';
const RETIRE_PREDECESSOR = "if (typeof row.predecessor_hash === 'string') revoke(database, row.predecessor_hash, now);";
const NAME_THE_HEAD = 'if (root !== keep) revoke(database, root, now);';
const SPEND_THE_CODE = 'AND redeemed_at IS NULL AND expires_at > ?';
const PURGE_SESSIONS = "'DELETE FROM sessions WHERE expires_at <= ?'";

/** One change to `session-sqlite.ts`, or one store around it, for each case: the case must fail. */
const VIOLATIONS: Violation<SessionStore>[] = [
  {
    breaks: 'opens a session for the person the operator named, not for whoever redeemed',
    by: 'does not keep the name of a pairing',
    replace: { after: 'async createPairing(', from: 'identity.name ?? null,', to: 'null,' },
  },
  {
    breaks: 'spends the code, so a second reviewer with the same code gets nothing',
    by: 'redeems a code each time it is asked',
    replace: { from: SPEND_THE_CODE, to: 'AND expires_at > ?' },
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
    replace: { from: SPEND_THE_CODE, to: 'AND redeemed_at IS NULL AND ? IS NOT NULL' },
  },
  {
    breaks: 'refuses a code at its expiry, and after, with no purge before',
    by: 'still takes a code at the instant of its expiry',
    replace: { from: SPEND_THE_CODE, to: 'AND redeemed_at IS NULL AND expires_at >= ?' },
  },
  {
    breaks: 'leaves the code spendable when the session cannot be written',
    by: 'keeps the code spent when the session failed',
    replace: {
      after: 'async redeemPairing(',
      from: "} catch (error) {\n        database.exec('ROLLBACK');",
      to: "} catch (error) {\n        database.exec('COMMIT');",
    },
  },
  {
    breaks: 'refuses a pairing whose subject is an empty string',
    by: 'takes an empty subject',
    replace: {
      from: "if (typeof row.subject !== 'string' || row.subject === '') return undefined;",
      to: "if (typeof row.subject !== 'string') return undefined;",
    },
  },
  {
    breaks: 'keeps the workspace of a pairing through every rotation',
    by: 'does not copy the workspace to a successor',
    replace: { after: 'function decide(', from: 'identity.workspace ?? null,', to: 'null,' },
  },
  {
    breaks: 'refuses a refresh token that was never issued',
    by: 'reads a row that is not there',
    replace: { from: EXPIRED_OR_UNKNOWN, to: "if (typeof row?.expires_at === 'number' && row.expires_at <= now) {" },
  },
  {
    breaks: 'refuses a session past its expiry',
    by: 'never reads the expiry of a session',
    replace: { from: EXPIRED_OR_UNKNOWN, to: "if (row === undefined || typeof row.expires_at !== 'number') {" },
  },
  {
    breaks: 'refuses a session past its expiry',
    by: 'still takes a token at the instant of its expiry',
    replace: { from: 'row.expires_at <= now', to: 'row.expires_at < now' },
  },
  {
    breaks: 'answers rotated, gone and reused for the three things a token can be',
    by: 'calls a replay an ended session',
    replace: { from: REPLAY_ANSWER, to: "return { answer: { outcome: 'gone' }, commit: true };" },
  },
  {
    breaks: 'revokes on the worker, so the refresh token stops working everywhere',
    by: 'rotates a token that is revoked',
    replace: { from: 'if (row.revoked_at !== null && row.revoked_at !== undefined) {', to: 'if (false) {' },
  },
  {
    breaks: 'treats a second logout as a no-op rather than an error',
    by: 'answers that every log out revoked something',
    replace: { from: 'return revoked.changes === 1;', to: 'return true;' },
  },
  {
    breaks: 'leaves every other session alone',
    by: 'revokes every chain with one',
    replace: {
      from: 'WHERE root_hash = ? AND token_hash IS NOT ?',
      to: 'WHERE (root_hash = ? OR 1) AND token_hash IS NOT ?',
    },
  },
  {
    breaks: 'hands back a new refresh token, and the new one works',
    by: 'does not copy the name to a successor',
    replace: { after: 'function decide(', from: 'identity.name ?? null,', to: 'null,' },
  },
  {
    breaks: 'keeps the old token usable until the new one is used',
    by: 'gives a rotated token no grace',
    replace: { from: PAST_THE_GRACE, to: 'if (now >= rotatedAt) {' },
  },
  {
    breaks: 'takes a third presentation inside the ceiling, not just a second',
    by: 'revokes the token that presents itself with the successors nobody received',
    replace: { from: DROP_ORPHANS, to: 'revokeChain(database, chainOf(row, tokenHash), now);' },
  },
  {
    breaks: 'drops the successor that was never received',
    by: 'keeps every successor of a token live',
    replace: { from: DROP_ORPHANS, to: '' },
  },
  {
    breaks: 'ends the chain when an orphan is presented and something in it is still live',
    by: 'rolls the revocation of the chain back',
    replace: { from: REPLAY_ANSWER, to: "return { answer: { outcome: 'reused' }, commit: false };" },
  },
  {
    breaks: 'answers a token from a chain that is entirely revoked without calling it a replay',
    by: 'calls every revoked token a replay',
    replace: { from: 'if (!chainHasLive(database, chainOf(row, tokenHash))) {', to: 'if (false) {' },
  },
  {
    breaks: 'retires the old token the moment the new one is used',
    by: 'never retires a predecessor',
    replace: { from: RETIRE_PREDECESSOR, to: '' },
  },
  {
    breaks: 'revokes the whole chain when a retired token is replayed',
    by: 'refuses the replay and leaves the chain live',
    replace: {
      from: `revokeChain(database, chainOf(row, tokenHash), now);\n\n    ${REPLAY_ANSWER}`,
      to: REPLAY_ANSWER,
    },
  },
  {
    breaks: 'gives up on a rotated token once the grace has run out, and takes the chain with it',
    by: 'has a grace with no end',
    replace: { from: PAST_THE_GRACE, to: 'if (false) {' },
  },
  {
    breaks: 'gives up on a rotated token once the grace has run out, and takes the chain with it',
    by: 'refuses the late token and leaves its successor live',
    replace: { after: PAST_THE_GRACE, from: 'commit: true', to: 'commit: false' },
  },
  {
    breaks: 'still accepts the retry the grace exists for, at the last moment it covers',
    by: 'ends the grace one instant early',
    replace: { from: PAST_THE_GRACE, to: 'if (now >= rotatedAt + graceMs) {' },
  },
  {
    breaks: 'does not extend the session it rotates',
    by: 'gives a successor an expiry of its own',
    replace: {
      after: 'function decide(',
      from: 'row.expires_at,\n      tokenHash,',
      to: 'Number(row.expires_at) * 2,\n      tokenHash,',
    },
  },
  {
    breaks: 'tells a logged-out token apart from a replayed one',
    by: 'calls every revoked token a replay',
    replace: { from: 'if (!chainHasLive(database, chainOf(row, tokenHash))) {', to: 'if (false) {' },
  },
  {
    breaks: 'does not extend the grace by retrying inside it',
    by: 'writes the instant of every rotation',
    replace: { from: 'WHERE token_hash = ? AND rotated_at IS NULL', to: 'WHERE token_hash = ?' },
  },
  {
    breaks: 'ends the whole chain on log out, not only the token it was handed',
    by: 'revokes the row it was handed alone',
    replace: { from: 'if (row !== undefined) revokeChain(database, chainOf(row, tokenHash), now);', to: '' },
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
    replace: { from: 'return revoked.changes === 1;', to: 'return row !== undefined;' },
  },
  {
    breaks: 'leaves the token a client just received alone when its predecessor is retired',
    by: 'retires the whole chain with the predecessor',
    replace: {
      from: RETIRE_PREDECESSOR,
      to: "if (typeof row.predecessor_hash === 'string') revokeChain(database, chainOf(row, tokenHash), now);",
    },
  },
  {
    breaks: 'revokes a forked chain to its tip when the root is replayed',
    by: 'revokes the direct successors of the root alone',
    replace: {
      from: 'WHERE root_hash = ? AND token_hash IS NOT ?',
      to: 'WHERE predecessor_hash = ? AND token_hash IS NOT ?',
    },
  },
  {
    breaks: 'serves whoever presents last inside the grace, until the earlier holder comes back',
    by: 'keeps every successor of a token live',
    replace: { from: DROP_ORPHANS, to: '' },
  },
  {
    breaks: 'drops the codes and the sessions that are expired, and nothing that is not',
    by: 'keeps the codes that are expired',
    replace: {
      from: "'DELETE FROM pairings WHERE expires_at <= ?'",
      to: "'DELETE FROM pairings WHERE expires_at <= ? AND 0'",
    },
  },
  {
    breaks: 'drops the codes and the sessions that are expired, and nothing that is not',
    by: 'keeps the sessions that are expired',
    replace: { from: PURGE_SESSIONS, to: "'DELETE FROM sessions WHERE expires_at <= ? AND 0'" },
  },
  {
    breaks: 'drops the codes and the sessions that are expired, and nothing that is not',
    by: 'drops every session',
    replace: { from: PURGE_SESSIONS, to: "'DELETE FROM sessions WHERE ? IS NOT NULL'" },
  },
  {
    breaks: 'keeps a revoked session until it expires, so a replay of it still ends the chain',
    by: 'drops a session when it is revoked',
    replace: { from: PURGE_SESSIONS, to: "'DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL'" },
  },
];

describeControls('SessionStore', sessionCases, VIOLATIONS, SQLITE, async (change) => {
  const mutant = await mutatedModule('session-sqlite.ts', change);
  const subject = onFile<SessionStore>('a changed SQLite session store', 'createSqliteSessionStore', () => ({
    create: mutant.module.createSqliteSessionStore as FileStoreModule<SessionStore>['create'],
    close: mutant.module.closeSessionConnections as FileStoreModule<SessionStore>['close'],
  }));

  return {
    ...subject,
    close() {
      subject.close();
      mutant.remove();
    },
  };
});

describe('the SessionStore conformance suite', () => {
  it('runs for every implementation the worker exports', () => {
    assert.deepEqual(SUBJECTS.map((subject) => subject.factory).sort(), factoriesOf('SessionStore'));
  });
});

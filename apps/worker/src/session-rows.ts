import type { SessionIdentity } from './session.ts';

/**
 * A row of the sessions as the worker reads it, whatever database answered it (FRU-142).
 *
 * The columns have the names of the SQLite file of before, and `postgres-copy.ts` copies them as they are.
 */

/**
 * A row is parsed, never trusted — the same rule the note store follows, and for the same reason.
 *
 * An operator can edit a row, and a restore can be older than the code. A cast describes the row to
 * TypeScript and checks nothing. In a SQLite file, `TEXT` affinity narrows what can actually arrive —
 * an integer written here comes back as a string — but a **BLOB** keeps its type, and a `NOT NULL`
 * column holds an empty string quite happily in both databases. Either would otherwise reach
 * `signIdentityToken` and mint a token behind a `200` that this worker's own verifier then rejects.
 * An unreadable row answers like a missing one, so it costs that session and never the endpoint.
 * Raised in review.
 */
export function identityOf(row: Record<string, unknown>): SessionIdentity | undefined {
  if (typeof row.subject !== 'string' || row.subject === '') return undefined;
  // A session of an account (FRU-238) names its account twice, and no workspace. A row that names
  // another account than its person, or a workspace beside it, is one somebody edited: unreadable.
  const account = row.account_id ?? null;
  if (account !== null && (account !== row.subject || (row.workspace ?? null) !== null)) return undefined;

  return {
    subject: row.subject,
    ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
    ...(typeof row.email === 'string' && row.email !== '' ? { email: row.email } : {}),
    ...(typeof row.workspace === 'string' && row.workspace !== '' ? { workspace: row.workspace } : {}),
    ...(account === null ? {} : { account: true as const }),
  };
}

/** The chain a row belongs to. A row with no `root_hash` is the head of its own. */
export function chainOf(row: Record<string, unknown>, tokenHash: string): string {
  return typeof row.root_hash === 'string' ? row.root_hash : tokenHash;
}

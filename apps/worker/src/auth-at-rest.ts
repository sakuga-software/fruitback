import { digest } from './session.ts';

/**
 * What better-auth may keep in the database, and what the worker keeps in its place (FRU-181).
 *
 * **A copy of the database is not a set of credentials, even with `FRUITBACK_AUTH_SECRET` beside it.**
 * better-auth 1.7.7 finds a session by its token, and keeps that token in the clear: a copy of the
 * `session` table and the secret that signs the cookie were a working cookie for every open session.
 * It has no option that keeps a digest of that token.
 *
 * So the worker puts this layer between better-auth and its database adapter, at the one interface
 * that every adapter of better-auth implements (Kysely, Drizzle or another). It names no library, and
 * `auth.ts` installs it with a plugin of its own, `fruitback-at-rest`.
 *
 * - `session.token` and `verification.identifier` are kept as their SHA-256. Each value that reaches
 *   the database is digested, in a row that is written and in a lookup. A digest read in a copy is
 *   digested again when it is presented, so it finds nothing. The digest has no key: a value of 190
 *   bits or more cannot be found again from its digest, and a key would add nothing that a leak of
 *   the environment does not take.
 * - The token columns of `account`, and its password, are never kept: their value is dropped before
 *   the row is written. The worker reads who a person is at sign-in, and calls no provider after it.
 *
 * WARNING: a row read back has the token that the caller gave, never the digest. A row whose token
 * the caller did not give, as in a list of the sessions of a person, has no token at all: a session
 * is then named by its id. A lookup by a token that is absent throws. better-auth swallows that error
 * where it reads a row before it deletes it, and then deletes nothing: so the routes that list the
 * sessions and act on their tokens are closed in `auth.ts` (`DISABLED_PATHS`), to a request and to
 * a call in the process.
 */

/** A condition of a lookup, as better-auth gives one to its adapter. */
type Where = { field: string; value: unknown; operator?: string; connector?: string; mode?: string };

type Row = Record<string, unknown>;

/** What the worker reads of a database adapter of better-auth: its methods, by name. */
export type AdapterOfAuth = Record<string, unknown> & {
  transaction?: (callback: (trx: AdapterOfAuth) => Promise<unknown>) => Promise<unknown>;
};

/** The column of each table that holds a value the database keeps as its digest. */
export const DIGESTED: Readonly<Record<string, string>> = { session: 'token', verification: 'identifier' };

/** The columns of each table that the database never keeps: they are written empty. */
export const DROPPED: Readonly<Record<string, readonly string[]>> = {
  account: ['accessToken', 'refreshToken', 'idToken', 'password'],
};

/**
 * The members of an adapter of better-auth 1.7.7, and nothing else.
 *
 * An adapter with another member is refused: a later version that adds a way to read or write a row
 * would go around this layer. Read it, and add it here, before you trust it.
 */
export const ADAPTER_MEMBERS: readonly string[] = [
  'id',
  'options',
  'createSchema',
  'transaction',
  'create',
  'findOne',
  'findMany',
  'count',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'consumeOne',
  'incrementOne',
];

/** The operators a lookup may use on a digested column. An order, or a part of a value, has no digest. */
const COMPARED = new Set(['eq', 'ne', 'in', 'not_in']);

const KEPT = Symbol('fruitback-at-rest');

/** The digests of the values given in one call, so that a row read back has the value again. */
type Seen = Map<string, string>;

async function digested(value: unknown, model: string, field: string, seen: Seen): Promise<string> {
  // The value is never quoted: it is a token.
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `better-auth asked the database for a ${model} by a ${field} that the worker does not have. ` +
        `The database keeps no ${field}: name a ${model} by its id (see auth-at-rest.ts)`,
    );
  }
  const kept = await digest(value);
  seen.set(kept, value);

  return kept;
}

async function whereOf(model: string, where: unknown, seen: Seen): Promise<unknown> {
  const field = DIGESTED[model];
  if (field === undefined || !Array.isArray(where)) return where;

  return Promise.all(
    (where as Where[]).map(async (condition) => {
      if (condition.field !== field) return condition;
      const operator = condition.operator ?? 'eq';
      if (!COMPARED.has(operator) || condition.mode === 'insensitive') {
        throw new Error(
          `better-auth compared ${model}.${field} with « ${operator} », and the database keeps its digest`,
        );
      }
      const value = Array.isArray(condition.value)
        ? await Promise.all(condition.value.map(async (each: unknown) => digested(each, model, field, seen)))
        : await digested(condition.value, model, field, seen);

      return { ...condition, value };
    }),
  );
}

async function rowOf(model: string, data: unknown, seen: Seen): Promise<unknown> {
  if (data === null || typeof data !== 'object') return data;
  const row: Row = { ...(data as Row) };
  const field = DIGESTED[model];
  if (field !== undefined && row[field] !== undefined) row[field] = await digested(row[field], model, field, seen);
  for (const dropped of DROPPED[model] ?? []) if (row[dropped] !== undefined) row[dropped] = null;

  return row;
}

/** A row read back, with the value its caller gave in place of the digest, or with none. */
function readBack(model: string, found: unknown, seen: Seen): unknown {
  if (Array.isArray(found)) return found.map((each) => readBack(model, each, seen));
  if (found === null || typeof found !== 'object') return found;
  const row: Row = { ...(found as Row) };
  const field = DIGESTED[model];
  if (field !== undefined && field in row) {
    const given = typeof row[field] === 'string' ? seen.get(row[field]) : undefined;
    if (given === undefined) delete row[field];
    else row[field] = given;
  }
  // A row of another table, joined to this one: `{ ...session, user: {...} }`.
  for (const [joined, value] of Object.entries(row)) {
    if (joined !== model && Object.hasOwn(DIGESTED, joined) && value !== null && typeof value === 'object') {
      row[joined] = readBack(joined, value, seen);
    }
  }

  return row;
}

type Call = { model: string; where?: unknown; data?: unknown; update?: unknown; set?: unknown } & Row;

function method(inner: AdapterOfAuth, name: string): (call: Call) => Promise<unknown> {
  const original = inner[name];
  if (typeof original !== 'function') throw new Error(`the adapter of better-auth has no ${name}`);

  return async (call: Call) => {
    const seen: Seen = new Map();
    const model = call.model;
    const given: Call = { ...call };
    if ('where' in call) given.where = await whereOf(model, call.where, seen);
    if ('data' in call) given.data = await rowOf(model, call.data, seen);
    if ('update' in call) given.update = await rowOf(model, call.update, seen);
    if ('set' in call) given.set = await rowOf(model, call.set, seen);

    return readBack(model, await (original as (call: Call) => Promise<unknown>).call(inner, given), seen);
  };
}

/** The members of `adapter` that this layer does not know. Empty for an adapter it can wrap. */
export function unknownMembers(adapter: AdapterOfAuth): string[] {
  return Object.keys(adapter).filter((name) => !ADAPTER_MEMBERS.includes(name));
}

/**
 * Puts the layer in front of `adapter`, **in place**, and answers it.
 *
 * In place, because better-auth keeps the check of the schema of an adapter beside that very object
 * (a `WeakMap` of `@better-auth/core`): an adapter that is another object would lose it. A
 * transaction gives each call an adapter of its own, and that one is wrapped too. An adapter that
 * is wrapped already is answered as it is, so a value is never digested twice.
 */
export function keepAtRest<T extends AdapterOfAuth>(adapter: T): T {
  if ((adapter as Record<symbol, unknown>)[KEPT] === true) return adapter;
  const unknown = unknownMembers(adapter);
  if (unknown.length > 0) {
    throw new Error(
      `the adapter of better-auth has a member that auth-at-rest.ts does not know (${unknown.join(', ')}). ` +
        'It may read or write a row around the digests: read it before you add it to ADAPTER_MEMBERS',
    );
  }

  const inner: AdapterOfAuth = { ...adapter };
  const wrapped: Record<string, unknown> = {};
  for (const name of ADAPTER_MEMBERS) {
    if (name === 'id' || name === 'options' || name === 'createSchema' || name === 'transaction') continue;
    wrapped[name] = method(inner, name);
  }
  const transaction = inner.transaction;
  if (typeof transaction === 'function') {
    wrapped.transaction = async (callback: (trx: AdapterOfAuth) => Promise<unknown>) =>
      transaction.call(inner, async (trx: AdapterOfAuth) => callback(keepAtRest(trx)));
  }

  Object.assign(adapter, wrapped);
  Object.defineProperty(adapter, KEPT, { value: true, enumerable: false });

  return adapter;
}

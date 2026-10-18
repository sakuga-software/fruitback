import assert from 'node:assert/strict';
import { newId } from './account-rows.ts';
import type { Role } from './accounts.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { CONSOLE_URL, PUBLIC_URL, databasesOfACase } from './auth.fixture.ts';
import { SESSION_COOKIE, workerOf } from './auth-worker.fixture.ts';
import type { WorkerEnv } from './env.ts';
import { createPostgresNoteIndex } from './notes-index-postgres.ts';
import { createPgliteDatabase, rowsOf } from './postgres.fixture.ts';

/**
 * A worker with accounts, for a test of the routes of the console (FRU-150): the accounts are in
 * PostgreSQL (PGlite), and a person signs in with better-auth, by a link, as the console does. The
 * tests of the console used an accounts file and the token of the sign-in of before: both are gone.
 *
 * A « world » is one worker and its database. `callOn` is a request to it, as a browser or an
 * extension sends one: `token` is the cookie of a person of the console, or the access token of a
 * session of an extension, and `callOn` puts each where it goes.
 */

export const CONSOLE = CONSOLE_URL;
export const WORKER = PUBLIC_URL;

export type World = Awaited<ReturnType<typeof workerOf>> & {
  /** What `handleRequest` is handed, beside the request and the environment. */
  context: Partial<RequestContext>;
};

export type CallOptions = {
  /** The cookie of a console session (`signInTo`), or the access token of a session of the extension. */
  token?: string;
  body?: unknown;
  /** The `Origin` of the request. The console's when absent; `null` for none. */
  origin?: string | null;
  headers?: Record<string, string>;
};

/**
 * The worlds of a test file: call it once, at the top. Each world it opens is closed after its case.
 * `env` adds to the environment of the worker, e.g. `FRUITBACK_SECRETS_KEY`.
 */
export function worlds(): (more?: { env?: Partial<WorkerEnv> }) => Promise<World> {
  const { opening } = databasesOfACase();

  return async (more = {}) => {
    const worker = await workerOf(await opening(createPgliteDatabase), more);

    return {
      ...worker,
      context: {
        accounts: worker.accounts,
        sessionStore: worker.sessions,
        mailer: worker.mail,
        kv: worker.kv,
        auth: worker.auth,
        instanceAdmin: worker.instanceAdmin,
        // FRU-237: the index of the notes, on the database of the world.
        noteIndex: createPostgresNoteIndex(worker.database),
      },
    };
  };
}

let ip = 0;

/** A request to the worker of this world. `context` replaces a part of what the worker is handed. */
export function callOn(
  world: World,
  method: string,
  path: string,
  options: CallOptions = {},
  context: Partial<RequestContext> = {},
): Promise<Response> {
  const origin = options.origin === undefined ? CONSOLE : options.origin;
  const headers: Record<string, string> = { ...(origin === null ? {} : { Origin: origin }) };
  if (options.token !== undefined) {
    if (options.token.includes(`${SESSION_COOKIE}=`)) headers.Cookie = options.token;
    else headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  ip += 1;

  return handleRequest(
    new Request(`${WORKER}${path}`, {
      method,
      headers: { ...headers, ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    world.env,
    { clientIp: `198.18.0.${ip % 250}`, ...world.context, ...context },
  );
}

/** Signs an address in by a link, and answers its account id and its cookie, as `token`. */
export async function signInTo(world: World, email: string): Promise<{ id: string; token: string }> {
  const token = await world.signIn(email);
  const me = await callOn(world, 'GET', '/console/me', { token });
  assert.equal(me.status, 200, await me.clone().text());

  return { id: ((await me.json()) as { account: { id: string } }).account.id, token };
}

/** A workspace that the person of `token` makes, through the console: its id. */
export async function workspaceIn(world: World, token: string, name = 'Acme'): Promise<string> {
  const created = await callOn(world, 'POST', '/console/workspaces', { token, body: { name } });
  assert.equal(created.status, 201, await created.clone().text());

  return ((await created.json()) as { id: string }).id;
}

/** Writes a member of a workspace with a role, as the row an accepted invitation leaves. */
export async function memberOf(world: World, workspace: string, account: string, role: Role | string): Promise<void> {
  await rowsOf(
    world.database,
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ('${newId('mem')}', '${workspace}', '${account}', '${role}', now())`,
  );
}

/** Shares sites of a workspace with a guest, as the acceptance of their invitation does (FRU-250). */
export async function shareWith(
  world: World,
  workspace: string,
  account: string,
  sites: readonly string[],
): Promise<void> {
  for (const site of sites) {
    await rowsOf(
      world.database,
      `INSERT INTO site_shares (workspace_id, account_id, site_id, created_at)
         VALUES ('${workspace}', '${account}', '${site}', ${Date.now()})`,
    );
  }
}

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { canonicalizePageUrl } from '@fruitback/shared';
import type { BetterAuthOptions } from 'better-auth';
import { ACCOUNT_SUSPENDED, SERVED_PATHS } from './auth.ts';
import { CONSOLE_URL, DATABASES, databasesOfACase } from './auth.fixture.ts';
import { type Call, cookieOf, envWith, workerOf } from './auth-worker.fixture.ts';
import { runPair } from './cli.ts';
import { handleConsoleApi } from './console-api.ts';
import { adminLinkFor } from './first-admin.ts';
import { ADMIN_PATH } from './instance-admin.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { digest } from './session.ts';

/**
 * An administrator of the instance suspends and restores an account (FRU-281). Every case goes
 * through `handleRequest`, as the console, a provider and an extension call it, on PGlite and on a
 * real server when the run has one.
 */

const { opening } = databasesOfACase();
const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123456789';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SITE = 'https://staging.beta.dev';

type Worker = Awaited<ReturnType<typeof workerOf>>;
type Person = { id: string; cookie: string };

/** The answer of a provider for a person: GitHub and Google prove the address, and better-auth reads it. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: 'https://accounts.google.com', aud: 'the-client-of-google', ...claims })}.c2lnbmF0dXJl`;
}

/** One subject of a provider per address: a subject that two addresses share is one person to better-auth. */
const subjects = new Map<string, number>();
function subjectOf(email: string): number {
  if (!subjects.has(email)) subjects.set(email, 4000 + subjects.size);

  return subjects.get(email) as number;
}

const PROVIDER_ANSWERS: Record<string, (email: string) => Record<string, unknown>> = {
  github: (email) => ({
    'https://github.com/login/oauth/access_token': {
      access_token: 'gho_a-token',
      token_type: 'bearer',
      scope: 'user:email',
    },
    'https://api.github.com/user': { id: subjectOf(email), login: 'someone', name: 'Someone', email },
    'https://api.github.com/user/emails': [{ email, primary: true, verified: true }],
  }),
  google: (email) => ({
    'https://oauth2.googleapis.com/token': {
      access_token: 'ya29.a-token',
      token_type: 'Bearer',
      id_token: idToken({ sub: String(subjectOf(email)), email, email_verified: true, name: 'Someone' }),
    },
  }),
};

/** What a way to sign in gave: a cookie of a session, or the code of the console's error. */
type Outcome = { cookie: string; error: string | null };

async function byEmail(worker: Worker, email: string): Promise<Outcome> {
  assert.equal((await worker.call('/console/auth/email', { body: { email } })).status, 202);
  const answer = await worker.call('/console/auth/email/redeem', { body: { token: worker.lastToken() } });
  if (answer.status === 200) return { cookie: cookieOf(answer), error: null };

  return { cookie: '', error: ((await answer.json()) as { error: string }).error };
}

async function byProvider(worker: Worker, provider: string, email: string): Promise<Outcome> {
  const answers = PROVIDER_ANSWERS[provider];
  assert.ok(answers, `no answers of ${provider} in this file`);
  const start = await worker.call(`/console/auth/start/${provider}`, { origin: null });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state');
  const stateCookie = start.headers
    .getSetCookie()
    .map((each) => each.split(';')[0])
    .join('; ');
  const fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = answers(email)[`${url.origin}${url.pathname}`];
    if (body === undefined) throw new Error(`a test called ${url.origin}${url.pathname}`);

    return Response.json(body);
  });
  try {
    const back = await worker.call(`/console/auth/callback/${provider}?code=a-code&state=${state}`, {
      origin: null,
      headers: { Cookie: stateCookie },
    });
    const location = new URL(back.headers.get('Location') ?? '', CONSOLE_URL);

    return { cookie: cookieOf(back), error: location.searchParams.get('error') };
  } finally {
    fetched.mock.restore();
  }
}

/** Every way to sign in that the worker serves. A way that this table does not name fails a case. */
const WAYS: Record<string, (worker: Worker, email: string) => Promise<Outcome>> = {
  email: byEmail,
  github: (worker, email) => byProvider(worker, 'github', email),
  google: (worker, email) => byProvider(worker, 'google', email),
};

/** The code that each way to sign in gives a suspended account: the console reads it. */
const REFUSED: Record<string, string> = {
  email: 'account-suspended',
  github: ACCOUNT_SUSPENDED,
  google: ACCOUNT_SUSPENDED,
};

function as(worker: Worker, cookie: string, path: string, init: Call = {}): Promise<Response> {
  return worker.call(path, { ...init, headers: { ...init.headers, Cookie: cookie } });
}

function bearer(worker: Worker, token: string, path: string, init: Call = {}): Promise<Response> {
  return worker.call(path, {
    origin: EXTENSION,
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
}

async function person(worker: Worker, email: string): Promise<Person> {
  const cookie = await worker.signIn(email);
  const me = await as(worker, cookie, '/console/me');
  assert.equal(me.status, 200, await me.clone().text());

  return { id: ((await me.json()) as { account: { id: string } }).account.id, cookie };
}

async function workspaceOf(worker: Worker, owner: Person, name: string): Promise<string> {
  const made = await as(worker, owner.cookie, '/console/workspaces', { body: { name } });
  assert.equal(made.status, 201, await made.clone().text());

  return ((await made.json()) as { id: string }).id;
}

async function memberOf(worker: Worker, workspace: string, account: string, role: string): Promise<void> {
  await rowsOf(
    worker.database,
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt")
       VALUES ('mem_${account}_${workspace}', '${workspace}', '${account}', '${role}', now())`,
  );
}

/** The tokens of one session of the extension. */
type Tokens = { accessToken: string; refreshToken: string };

/** A code of a session of a workspace, minted in the console. */
async function codeFor(worker: Worker, who: Person, workspace: string): Promise<string> {
  const minted = await as(worker, who.cookie, `/console/workspaces/${workspace}/connect`, { body: {} });
  assert.equal(minted.status, 201, await minted.clone().text());

  return ((await minted.json()) as { code: string }).code;
}

/** A session of the extension paired for one workspace. */
async function workspaceSession(worker: Worker, who: Person, workspace: string): Promise<Tokens> {
  const paired = await worker.call('/session/pair', {
    body: { code: await codeFor(worker, who, workspace) },
    origin: null,
  });
  assert.equal(paired.status, 200, await paired.clone().text());

  return (await paired.json()) as Tokens;
}

/** An approval of the console for a session of an account (FRU-238): the claim that the extension spends. */
async function approvedClaim(worker: Worker, who: Person): Promise<string> {
  const asked = await worker.call('/session/connect', { origin: EXTENSION, body: { browser: 'Chrome on macOS' } });
  assert.equal(asked.status, 201, await asked.clone().text());
  const { request, claim } = (await asked.json()) as { request: string; claim: string };
  const { word } = (await (await as(worker, who.cookie, `/console/connect/${request}`)).json()) as { word: string };
  const approved = await as(worker, who.cookie, `/console/connect/${request}/approve`, {
    body: { word, account: who.id },
  });
  assert.equal(approved.status, 200, await approved.clone().text());

  return claim;
}

async function claimed(worker: Worker, claim: string): Promise<Response> {
  await worker.kv.set(`fruitback:connect-poll:${await digest(claim)}`, '0', 1);
  await new Promise((resolve) => setTimeout(resolve, 3));

  return worker.call('/session/connect/claim', { origin: EXTENSION, body: { claim } });
}

/** A session of an account: the extension asks, the person approves, the extension claims. */
async function accountSession(worker: Worker, who: Person): Promise<Tokens> {
  const answer = await claimed(worker, await approvedClaim(worker, who));
  assert.equal(answer.status, 200, await answer.clone().text());

  return (await answer.json()) as Tokens;
}

/**
 * Ana signs in first and is the administrator, with Alpha. Bob owns Beta, which has a site. Carl is a
 * member of Beta and owns Gamma: he has a cookie, a session of the extension for Beta, and one of his
 * account.
 */
async function anInstance(open: () => Promise<PgDatabase>, more: Parameters<typeof workerOf>[1] = {}) {
  const worker = await workerOf(await opening(open), { ...more, env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
  const ana = await person(worker, 'ana@acme.dev');
  const bob = await person(worker, 'bob@beta.dev');
  const carl = await person(worker, 'carl@beta.dev');
  const alpha = await workspaceOf(worker, ana, 'Alpha');
  const beta = await workspaceOf(worker, bob, 'Beta');
  const gamma = await workspaceOf(worker, carl, 'Gamma');
  await memberOf(worker, beta, carl.id, 'member');
  const made = await as(worker, bob.cookie, `/console/workspaces/${beta}/sites`, {
    body: { url: SITE, visibility: 'members' },
  });
  assert.equal(made.status, 201, await made.clone().text());
  const site = ((await made.json()) as { id: string }).id;
  const ofBeta = await workspaceSession(worker, carl, beta);
  const ofAccount = await accountSession(worker, carl);

  return { worker, ana, bob, carl, alpha, beta, gamma, site, ofBeta, ofAccount };
}

type Instance = Awaited<ReturnType<typeof anInstance>>;

async function suspend(worker: Worker, by: Person, account: string, body: unknown) {
  const answer = await as(worker, by.cookie, `${ADMIN_PATH}/users/${account}/suspension`, { body });

  return { status: answer.status, body: (await answer.json()) as unknown };
}

/** What each token of Carl reads now: the status of each call, by the name of the token. */
async function whatCarlReads(on: Instance): Promise<Record<string, number>> {
  const { worker, carl, site, ofBeta, ofAccount } = on;
  const page = encodeURIComponent(canonicalizePageUrl(`${SITE}/pricing`));
  const feedback = `/feedback?url=${page}&client=${site}`;

  return {
    cookie: (await as(worker, carl.cookie, '/console/me')).status,
    'cookie, sessions': (await as(worker, carl.cookie, '/console/sessions')).status,
    'workspace, sites': (await bearer(worker, ofBeta.accessToken, '/session/sites')).status,
    'workspace, feedback': (await bearer(worker, ofBeta.accessToken, feedback, { origin: SITE })).status,
    'account, sites': (await bearer(worker, ofAccount.accessToken, '/session/sites')).status,
    'account, feedback': (await bearer(worker, ofAccount.accessToken, feedback, { origin: SITE })).status,
  };
}

const READS_BEFORE = {
  cookie: 200,
  'cookie, sessions': 200,
  'workspace, sites': 200,
  'workspace, feedback': 200,
  'account, sites': 200,
  'account, feedback': 200,
};
const READS_REFUSED = {
  cookie: 401,
  'cookie, sessions': 401,
  'workspace, sites': 401,
  'workspace, feedback': 401,
  'account, sites': 401,
  'account, feedback': 401,
};

async function refreshed(worker: Worker, tokens: Tokens): Promise<number> {
  return (await worker.call('/session/refresh', { body: { refreshToken: tokens.refreshToken }, origin: EXTENSION }))
    .status;
}

async function actionRows(worker: Worker) {
  return rowsOf(
    worker.database,
    'SELECT action, actor_email, target_account_id, target_email, workspace_id FROM admin_actions ORDER BY at, workspace_id',
  );
}

const banned = async (worker: Worker, account: string): Promise<unknown> =>
  (await rowsOf(worker.database, `SELECT banned FROM "user" WHERE id = '${account}'`))[0]?.banned;

/** Writes the ban in the database, and ends no session: what a check of each entry point sees alone. */
const banInTheDatabase = (worker: Worker, account: string) =>
  rowsOf(worker.database, `UPDATE "user" SET banned = true WHERE id = '${account}'`);

for (const { label, open, skip } of DATABASES) {
  describe(
    `what a ban does in better-auth 1.7.7, which the worker does not mount the admin plugin of, on ${label} (FRU-281)`,
    { skip },
    () => {
      it('has a case for every way to sign in that the worker serves', async () => {
        const worker = await workerOf(await opening(open));
        const providers = Object.keys((worker.auth.options.socialProviders ?? {}) as Record<string, unknown>);
        const callbacks = Object.keys(SERVED_PATHS)
          .filter((path) => path.startsWith('/callback/'))
          .map((path) => path.slice('/callback/'.length));
        assert.deepEqual([...providers].sort(), [...callbacks].sort());
        assert.deepEqual(Object.keys(WAYS).sort(), ['email', ...providers].sort());
        assert.deepEqual(Object.keys(REFUSED).sort(), Object.keys(WAYS).sort());
      });

      it('signs a banned account in by every way, and keeps its session, without the checks of the worker', async () => {
        // The control of every case below: better-auth reads `banned` and refuses nothing with it.
        const withoutTheHook = (options: BetterAuthOptions): BetterAuthOptions => ({
          ...options,
          databaseHooks: { ...options.databaseHooks, session: {} },
        });
        const worker = await workerOf(await opening(open), { changed: withoutTheHook });
        const carl = await person(worker, 'carl@beta.dev');
        await banInTheDatabase(worker, carl.id);

        const read = await worker.auth.api.getSession({ headers: new Headers({ Cookie: carl.cookie }) });
        assert.equal((read?.user as { banned?: unknown } | undefined)?.banned, true);
        assert.equal(read?.user.id, carl.id, 'better-auth answers the session of a banned account');
        for (const [way, signIn] of Object.entries(WAYS)) {
          const outcome = await signIn(worker, 'carl@beta.dev');
          assert.deepEqual([outcome.error, outcome.cookie !== ''], [null, true], way);
        }
      });

      it('signs a suspended account in by no way, and opens no session for it', async () => {
        const worker = await workerOf(await opening(open));
        const carl = await person(worker, 'carl@beta.dev');
        await banInTheDatabase(worker, carl.id);
        const before = await rowsOf(worker.database, `SELECT id FROM session WHERE "userId" = '${carl.id}'`);

        for (const [way, signIn] of Object.entries(WAYS)) {
          const outcome = await signIn(worker, 'carl@beta.dev');
          assert.deepEqual([outcome.error, outcome.cookie], [REFUSED[way], ''], way);
        }
        const after = await rowsOf(worker.database, `SELECT id FROM session WHERE "userId" = '${carl.id}'`);
        assert.deepEqual(after, before);
        // The control: the same ways sign somebody else in.
        for (const [way, signIn] of Object.entries(WAYS)) {
          assert.equal((await signIn(worker, 'dana@beta.dev')).error, null, way);
        }
      });

      it('refuses the link that the operator makes for a suspended owner', async () => {
        const worker = await workerOf(await opening(open));
        const bob = await person(worker, 'bob@beta.dev');
        await workspaceOf(worker, bob, 'Beta');
        const links = {
          auth: worker.auth,
          kv: worker.kv,
          owners: () => worker.accounts.owners(),
          consoleUrl: CONSOLE_URL,
        };
        const spend = async (): Promise<Response> => {
          const made = await adminLinkFor(links, 'bob@beta.dev');
          assert.ok(made.ok, made.lines.join('\n'));
          const link = made.lines.find((line) => line.includes('/sign-in#'))?.trim() ?? '';

          return worker.call('/console/auth/email/redeem', { body: { token: link.slice(link.indexOf('#') + 1) } });
        };
        await banInTheDatabase(worker, bob.id);

        const refused = await spend();
        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), { error: 'account-suspended' });
        // The control: the account restored, a new link signs the owner in.
        await rowsOf(worker.database, `UPDATE "user" SET banned = false WHERE id = '${bob.id}'`);
        assert.equal((await spend()).status, 200);
      });
    },
  );

  describe(`an administrator suspends and restores an account, on ${label} (FRU-281)`, { skip }, () => {
    it('suspends an account: its cookie and its extensions are refused at their next call, and it signs in by no way', async () => {
      const on = await anInstance(open);
      const { worker, ana, carl, ofBeta, ofAccount } = on;
      assert.deepEqual(await whatCarlReads(on), READS_BEFORE);

      const answer = await suspend(worker, ana, carl.id, { suspended: true });

      assert.deepEqual(answer, { status: 200, body: { user: { id: carl.id, suspended: true }, changed: true } });
      assert.equal(await banned(worker, carl.id), true);
      assert.deepEqual(await whatCarlReads(on), READS_REFUSED);
      assert.deepEqual(await rowsOf(worker.database, `SELECT id FROM session WHERE "userId" = '${carl.id}'`), []);
      assert.deepEqual(
        await rowsOf(
          worker.database,
          `SELECT token_hash FROM sessions WHERE subject = '${carl.id}' AND revoked_at IS NULL`,
        ),
        [],
      );
      assert.equal(await refreshed(worker, ofBeta), 401);
      assert.equal(await refreshed(worker, ofAccount), 401);
      for (const [way, signIn] of Object.entries(WAYS)) {
        assert.equal((await signIn(worker, 'carl@beta.dev')).error, REFUSED[way], way);
      }
      // The users of the administrator say it; Bob, who is no administrator, keeps his session.
      const users = (await (await as(worker, ana.cookie, `${ADMIN_PATH}/users`)).json()) as {
        users: { id: string; suspended: boolean }[];
      };
      assert.deepEqual(
        users.users.map((user) => [user.id, user.suspended]).sort(),
        [
          [ana.id, false],
          [on.bob.id, false],
          [carl.id, true],
        ].sort(),
      );
      assert.equal((await as(worker, on.bob.cookie, '/console/me')).status, 200);
    });

    it('restores an account: it signs in again, and its old sessions stay ended', async () => {
      const on = await anInstance(open);
      const { worker, ana, carl, beta, ofBeta, ofAccount } = on;
      assert.equal((await suspend(worker, ana, carl.id, { suspended: true })).status, 200);

      const answer = await suspend(worker, ana, carl.id, { suspended: false });

      assert.deepEqual(answer, { status: 200, body: { user: { id: carl.id, suspended: false }, changed: true } });
      assert.equal(await banned(worker, carl.id), false);
      assert.equal((await as(worker, carl.cookie, '/console/me')).status, 401);
      assert.equal(await refreshed(worker, ofBeta), 401);
      assert.equal(await refreshed(worker, ofAccount), 401);
      // A token minted before the suspension still reads for the rest of its ten minutes, as the token
      // of a member who was removed (SECURITY.md). It refreshes nothing and writes nothing.
      assert.equal((await bearer(worker, ofBeta.accessToken, '/session/sites')).status, 200);
      // A write checks the session in the store (FRU-238): the session of the account stays ended.
      const added = await bearer(worker, ofAccount.accessToken, '/session/sites', {
        body: { url: 'https://new.beta.dev' },
      });
      assert.equal(added.status, 401, await added.clone().text());
      for (const [way, signIn] of Object.entries(WAYS)) {
        const outcome = await signIn(worker, 'carl@beta.dev');
        assert.deepEqual([way, outcome.error, outcome.cookie !== ''], [way, null, true]);
      }
      // A new session of the extension works again.
      const again = await workspaceSession(
        worker,
        { id: carl.id, cookie: (await byEmail(worker, 'carl@beta.dev')).cookie },
        beta,
      );
      assert.equal((await bearer(worker, again.accessToken, '/session/sites')).status, 200);
    });

    it('ends a session of the extension that a failed suspension left live, before it restores the account', async () => {
      const on = await anInstance(open);
      const { worker, ana, carl, ofBeta } = on;
      // The suspension committed, and the end of the sessions of the extension failed after it.
      await banInTheDatabase(worker, carl.id);
      assert.equal(await refreshed(worker, ofBeta), 401, 'the ban refuses the session while it is live');

      assert.equal((await suspend(worker, ana, carl.id, { suspended: false })).status, 200);

      assert.deepEqual(
        await rowsOf(
          worker.database,
          `SELECT token_hash FROM sessions WHERE subject = '${carl.id}' AND revoked_at IS NULL`,
        ),
        [],
      );
    });

    it('refuses an administrator who suspends themselves, also when another administrator stays', async () => {
      const { worker, ana, bob } = await anInstance(open);
      assert.equal(
        (await as(worker, ana.cookie, `${ADMIN_PATH}/users/${bob.id}/instance-admin`, { body: { admin: true } }))
          .status,
        200,
      );
      const before = (await actionRows(worker)).length;

      const refused = await suspend(worker, ana, ana.id, { suspended: true });

      assert.deepEqual(refused, { status: 409, body: { error: 'self-suspension' } });
      assert.equal(await banned(worker, ana.id), false);
      assert.equal((await actionRows(worker)).length, before);
      assert.equal((await as(worker, ana.cookie, '/console/me')).status, 200);
      // The control: the other administrator suspends her.
      assert.equal((await suspend(worker, bob, ana.id, { suspended: true })).status, 200);
      assert.equal(await banned(worker, ana.id), true);
    });

    it('refuses to suspend the last administrator, whoever asks', async () => {
      const { worker, ana, bob } = await anInstance(open);

      // Bob is no administrator: the route refuses him first. The store says why it refuses the change.
      const change = await worker.instanceAdmin.setSuspended(
        { id: bob.id, email: 'bob@beta.dev' },
        ana.id,
        true,
        Date.now(),
      );

      assert.deepEqual(change, { ok: false, refused: 'last-admin' });
      assert.equal(await banned(worker, ana.id), false);
      assert.deepEqual(await actionRows(worker), []);
      // The control: with a second administrator, the same change suspends her.
      await rowsOf(worker.database, `UPDATE "user" SET role = 'admin' WHERE id = '${bob.id}'`);
      const done = await worker.instanceAdmin.setSuspended(
        { id: bob.id, email: 'bob@beta.dev' },
        ana.id,
        true,
        Date.now(),
      );
      assert.deepEqual(done, { ok: true, changed: true, suspended: true });
    });

    it('answers 200 with no change and writes no action when the account is already in the state asked', async () => {
      const { worker, ana, bob, carl } = await anInstance(open);
      assert.deepEqual(await suspend(worker, ana, bob.id, { suspended: false }), {
        status: 200,
        body: { user: { id: bob.id, suspended: false }, changed: false },
      });
      assert.equal((await suspend(worker, ana, carl.id, { suspended: true })).status, 200);
      const rows = (await actionRows(worker)).length;

      assert.deepEqual(await suspend(worker, ana, carl.id, { suspended: true }), {
        status: 200,
        body: { user: { id: carl.id, suspended: true }, changed: false },
      });
      assert.equal((await actionRows(worker)).length, rows);
      assert.equal(
        (await as(worker, bob.cookie, '/console/me')).status,
        200,
        'a restoration of nothing ended a session',
      );
    });

    it('answers 404 for an account that does not exist, and 400 for a body that is not { suspended: true | false }', async () => {
      const { worker, ana, bob } = await anInstance(open);

      assert.deepEqual(await suspend(worker, ana, 'acc_nobody', { suspended: true }), {
        status: 404,
        body: { error: 'not-found' },
      });
      for (const body of [
        {},
        { suspended: 'true' },
        { suspended: 1 },
        { suspended: null },
        [true],
        'suspended',
        null,
      ]) {
        assert.deepEqual(
          await suspend(worker, ana, bob.id, body),
          { status: 400, body: { error: 'invalid-suspended' } },
          JSON.stringify(body),
        );
      }
      // Bob, who is no administrator, finds no route.
      assert.deepEqual(await suspend(worker, bob, ana.id, { suspended: true }), {
        status: 404,
        body: { error: 'not-found' },
      });
      assert.equal(await banned(worker, bob.id), false);
      assert.deepEqual(await actionRows(worker), []);
    });

    it('changes nothing when its action cannot be written', async () => {
      const on = await anInstance(open);
      const { worker, ana, carl } = on;
      await rowsOf(worker.database, 'ALTER TABLE admin_actions ADD CONSTRAINT refuses_every_row CHECK (false)');

      // A refusal of the database is no `StoreError`: `handleRequest` throws it, and the server answers 500.
      await assert.rejects(suspend(worker, ana, carl.id, { suspended: true }), /refuses_every_row/);

      assert.equal(await banned(worker, carl.id), false);
      assert.deepEqual(await whatCarlReads(on), READS_BEFORE);
      // The control: with the table open again, the same call suspends Carl.
      await rowsOf(worker.database, 'ALTER TABLE admin_actions DROP CONSTRAINT refuses_every_row');
      assert.equal((await suspend(worker, ana, carl.id, { suspended: true })).status, 200);
    });
  });

  describe(
    `the trace of a suspension, which the owners of each workspace of the account read, on ${label} (FRU-281)`,
    { skip },
    () => {
      it('writes one row for each workspace of the account, and the owners of each read it beside the reads', async () => {
        const { worker, ana, bob, carl, alpha, beta, gamma } = await anInstance(open);
        await suspend(worker, ana, carl.id, { suspended: true });
        await suspend(worker, ana, carl.id, { suspended: false });

        const of = { actor_email: 'ana@acme.dev', target_account_id: carl.id, target_email: 'carl@beta.dev' };
        const sorted = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
        assert.deepEqual(
          sorted(await actionRows(worker)),
          sorted([
            { action: 'account-suspended', ...of, workspace_id: beta },
            { action: 'account-suspended', ...of, workspace_id: gamma },
            { action: 'account-restored', ...of, workspace_id: beta },
            { action: 'account-restored', ...of, workspace_id: gamma },
          ]),
        );

        const read = await as(worker, bob.cookie, `/console/workspaces/${beta}/admin-reads`);
        assert.equal(read.status, 200, await read.clone().text());
        const { reads, actions } = (await read.json()) as { reads: unknown[]; actions: Record<string, unknown>[] };
        assert.ok(Array.isArray(reads));
        assert.deepEqual(
          sorted(actions.map(({ at: _, ...action }) => action)),
          sorted([
            { action: 'account-restored', admin: { email: 'ana@acme.dev' }, target: { email: 'carl@beta.dev' } },
            { action: 'account-suspended', admin: { email: 'ana@acme.dev' }, target: { email: 'carl@beta.dev' } },
          ]),
        );
        // The owner of a workspace that Carl is not a member of reads none of it.
        const ofAlpha = (await (await as(worker, ana.cookie, `/console/workspaces/${alpha}/admin-reads`)).json()) as {
          actions: unknown[];
        };
        assert.deepEqual(ofAlpha.actions, []);
        // The administrators read every row.
        const all = (await (await as(worker, ana.cookie, `${ADMIN_PATH}/actions`)).json()) as {
          actions: { action: string; workspace?: { id: string } }[];
        };
        assert.deepEqual(all.actions.map((action) => action.workspace?.id).sort(), [beta, beta, gamma, gamma].sort());
      });

      it('writes one row with no workspace for an account that is a member of none', async () => {
        const { worker, ana } = await anInstance(open);
        const dana = await person(worker, 'dana@nowhere.dev');

        assert.equal((await suspend(worker, ana, dana.id, { suspended: true })).status, 200);

        assert.deepEqual(await actionRows(worker), [
          {
            action: 'account-suspended',
            actor_email: 'ana@acme.dev',
            target_account_id: dana.id,
            target_email: 'dana@nowhere.dev',
            workspace_id: null,
          },
        ]);
      });

      it('keeps the action for the owners after the account leaves the workspace, and after the account goes', async () => {
        const { worker, ana, bob, carl, beta } = await anInstance(open);
        await suspend(worker, ana, carl.id, { suspended: true });
        const ofBeta = async () =>
          (
            (await (await as(worker, bob.cookie, `/console/workspaces/${beta}/admin-reads`)).json()) as {
              actions: { action: string; at: string; admin: unknown; target: unknown }[];
            }
          ).actions.map(({ at: _, ...action }) => action);
        const suspended = {
          action: 'account-suspended',
          admin: { email: 'ana@acme.dev' },
          target: { email: 'carl@beta.dev' },
        };

        await rowsOf(
          worker.database,
          `DELETE FROM member WHERE "userId" = '${carl.id}' AND "organizationId" = '${beta}'`,
        );
        assert.deepEqual(await ofBeta(), [suspended]);
        await rowsOf(worker.database, `DELETE FROM "user" WHERE id = '${carl.id}'`);
        assert.deepEqual(await ofBeta(), [suspended]);
        // The account went: the rows keep its address, and no longer its id.
        assert.deepEqual(await rowsOf(worker.database, 'SELECT DISTINCT target_account_id FROM admin_actions'), [
          { target_account_id: null },
        ]);
      });
    },
  );

  describe(
    `each entry point refuses a suspended account, with the ban alone in the database, on ${label} (FRU-281)`,
    { skip },
    () => {
      it('refuses the cookie on every route that reads it, and every token of the extension', async () => {
        const on = await anInstance(open);
        const { worker, carl, beta, ofBeta, ofAccount } = on;
        assert.deepEqual(await whatCarlReads(on), READS_BEFORE);

        await banInTheDatabase(worker, carl.id);

        assert.deepEqual(await whatCarlReads(on), READS_REFUSED);
        for (const path of [
          '/console/me/sign-in',
          '/console/me/browsers',
          `/console/workspaces/${beta}/sites`,
          `/console/auth/organization/list-members?organizationId=${beta}`,
        ]) {
          assert.equal((await as(worker, carl.cookie, path)).status, 401, path);
        }
        assert.equal(await refreshed(worker, ofBeta), 401);
        assert.equal(await refreshed(worker, ofAccount), 401);
      });

      it('refuses a suspended account in callerOf, whatever reads the cookie', async () => {
        const on = await anInstance(open);
        const { worker, carl } = on;
        const me = () =>
          handleConsoleApi(
            new Request('https://api.fruitback.test/console/me', { headers: { Origin: CONSOLE_URL } }),
            '/console/me',
            {
              accounts: worker.accounts,
              sessions: worker.sessions,
              cookieSession: async () => carl.id,
              consoleUrl: CONSOLE_URL,
            },
            {},
          );
        assert.equal((await me())?.status, 200);

        await banInTheDatabase(worker, carl.id);

        const refused = await me();
        assert.equal(refused?.status, 401);
        assert.deepEqual(await refused?.json(), { error: 'identity-required', reason: 'no-account' });
      });

      it('opens no session for a code or an approval made before the suspension', async () => {
        const on = await anInstance(open);
        const { worker, carl, beta } = on;
        const code = await codeFor(worker, carl, beta);
        const claim = await approvedClaim(worker, carl);
        const live = () =>
          rowsOf(
            worker.database,
            `SELECT token_hash FROM sessions WHERE subject = '${carl.id}' AND revoked_at IS NULL`,
          );
        const before = await live();

        await banInTheDatabase(worker, carl.id);

        const paired = await worker.call('/session/pair', { body: { code }, origin: null });
        assert.equal(paired.status, 401, await paired.clone().text());
        const refused = await claimed(worker, claim);
        assert.deepEqual([refused.status, await refused.json()], [410, { error: 'connect-expired' }]);
        assert.deepEqual(await live(), before);
      });

      it('mints no pairing code for a suspended account with the pair command', async () => {
        const { worker, carl, beta } = await anInstance(open);
        const pair = () =>
          runPair(['--subject', carl.id, '--workspace', beta], envWith(), worker.sessions, worker.accounts);
        assert.equal((await pair()).ok, true);

        await banInTheDatabase(worker, carl.id);

        const refused = await pair();
        assert.equal(refused.ok, false);
        assert.match(refused.lines.join('\n'), /is suspended/);
      });
    },
  );
}

describe('the places that turn a token into an account (FRU-281)', () => {
  const sources = readdirSync(new URL('.', import.meta.url)).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.fixture.ts'),
  );
  const text = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');
  const filesWith = (pattern: RegExp, planted: Record<string, string> = {}): string[] =>
    sources.filter((file) => pattern.test(planted[file] ?? text(file))).sort();

  /**
   * Each place, with the check of the suspension that it relies on. A new place fails here, and its
   * author reads what this ticket asks of it.
   */
  const PLACES: Record<string, { pattern: RegExp; files: string[] }> = {
    'the cookie of the console, read by better-auth: `sessionOfCookie` refuses a banned user': {
      pattern: /\.getSession\(/,
      files: ['auth-routes.ts'],
    },
    'a token of the worker key: `role`, `reach` and `accountActive` refuse a suspended account': {
      pattern: /verifyIdentityToken\(/,
      files: ['app.ts', 'identity.ts', 'session-check.ts', 'session-sites.ts'],
    },
    'a new session of better-auth: its hook refuses a suspended account': {
      pattern: /session:\s*\{\s*create:/,
      files: ['auth.ts'],
    },
  };

  for (const [place, { pattern, files }] of Object.entries(PLACES)) {
    it(`finds ${place} in the files it names, and in no other`, () => {
      assert.deepEqual(filesWith(pattern), files);
      // The planted violation: a read of the same kind in `console-api.ts` is found.
      const planted = {
        'console-api.ts': `${text('console-api.ts')}\nconst x = auth.api.getSession({}); verifyIdentityToken(t, s); const o = { session: { create: {} } };`,
      };
      assert.deepEqual(filesWith(pattern, planted), [...files, 'console-api.ts'].sort());
    });
  }
});

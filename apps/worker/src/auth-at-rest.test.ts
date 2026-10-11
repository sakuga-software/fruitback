import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it, mock } from 'node:test';
import type { Auth, BetterAuthOptions } from 'better-auth';
import { ADAPTER_MEMBERS, type AdapterOfAuth, DIGESTED, DROPPED, keepAtRest, unknownMembers } from './auth-at-rest.ts';
import { AT_REST_PLUGIN, DISABLED_PATHS, closedPath, startAuth } from './auth.ts';
import {
  AUTH_SECRET,
  CONSOLE_URL,
  DATABASES,
  PUBLIC_URL,
  ask,
  databasesOfACase,
  optionsOn,
  signUp,
  withTestSignUp,
} from './auth.fixture.ts';
import type { Database } from './postgres.ts';
import { digest } from './session.ts';

/**
 * What the database of better-auth keeps, and what a copy of it opens (FRU-181).
 *
 * The threat is a copy of the database: a `pg_dump`, the nightly backup, a disk. The cases ask what
 * that copy opens **with `FRUITBACK_AUTH_SECRET` beside it**, because the secret and the database
 * live on one host. Each « opens nothing » has its control: the same thing, without the layer of
 * `auth-at-rest.ts`, opens the session.
 */

const SESSION_COOKIE = '__Secure-fruitback.session_token';

/** A cookie of a session signed as better-call signs one: the value, a dot, its HMAC-SHA256. */
function signed(value: string, secret: string): string {
  const signature = createHmac('sha256', secret).update(value).digest('base64');

  return `${SESSION_COOKIE}=${encodeURIComponent(`${value}.${signature}`)}`;
}

async function sessionOf(auth: Auth, headers: Record<string, string>): Promise<{ id?: string } | undefined> {
  const answer = await ask(auth, '/get-session', { headers });

  return ((await answer.json()) as { session?: { id?: string } } | null)?.session;
}

/** The value of the cookie of a session, as the browser holds it, without its signature. */
function tokenIn(cookie: string): string {
  const value = decodeURIComponent(cookie.split(`${SESSION_COOKIE}=`)[1]?.split(';')[0] ?? '');

  return value.slice(0, value.lastIndexOf('.'));
}

/** The options of the worker without the layer: what FRU-144 shipped, and the control of each case. */
function withoutTheLayer(options: BetterAuthOptions): BetterAuthOptions {
  return { ...options, plugins: (options.plugins ?? []).filter((plugin) => plugin.id !== AT_REST_PLUGIN) };
}

async function builtPast(options: BetterAuthOptions): Promise<Auth> {
  const { betterAuth } = await import('better-auth');

  return betterAuth(options) as unknown as Auth;
}

/** Every value of every column of the seven tables, as text. */
async function everyValue(database: Database): Promise<string[]> {
  const values: string[] = [];
  for (const table of ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation']) {
    for (const row of (await database.query(`SELECT * FROM "${table}"`)).rows) {
      for (const value of Object.values(row)) if (value !== null) values.push(String(value));
    }
  }

  return values;
}

/** The secrets of `given` that a value of the database holds, as they are or as better-auth would take them. */
async function heldIn(database: Database, given: readonly string[]): Promise<string[]> {
  const values = await everyValue(database);

  return given.filter((secret) => values.some((value) => value.includes(secret)));
}

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`a copy of the database of better-auth, and the secret beside it, on ${label} (FRU-181)`, { skip }, () => {
    // The reason for the layer, kept measured: what FRU-144 shipped.
    it('opened a session with the token of the table and the secret, before the layer', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await builtPast(withTestSignUp(withoutTheLayer(options)));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const row = String((await database.query('SELECT "token" FROM "session"')).rows[0]?.token);

      assert.equal(
        row,
        tokenIn(cookie),
        'the table no longer holds the token of the cookie: read auth-at-rest.ts again',
      );
      assert.equal(await sessionOf(auth, { Authorization: `Bearer ${row}` }), undefined);
      assert.equal(await sessionOf(auth, { Cookie: `${SESSION_COOKIE}=${row}` }), undefined, 'no signature');
      assert.equal(await sessionOf(auth, { Cookie: signed(row, `${AUTH_SECRET}-another`) }), undefined);
      assert.ok(await sessionOf(auth, { Cookie: signed(row, AUTH_SECRET) }), 'the row and the secret open it');
      assert.ok(await sessionOf(auth, { Cookie: cookie }), 'the control: the cookie the worker set');
    });

    it('keeps the digest of the token of a session, which opens nothing, even signed with the secret', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const token = tokenIn(cookie);
      const row = String((await database.query('SELECT "token" FROM "session"')).rows[0]?.token);

      assert.ok(token.length >= 32, 'no token in the cookie, so nothing below is tested');
      assert.equal(row, await digest(token));
      assert.deepEqual(await heldIn(database, [token]), []);
      for (const [what, headers] of [
        ['the row, signed with the secret', { Cookie: signed(row, AUTH_SECRET) }],
        ['the row, with no signature', { Cookie: `${SESSION_COOKIE}=${row}` }],
        ['the row, in an Authorization header', { Authorization: `Bearer ${row}` }],
      ] as const) {
        assert.equal(await sessionOf(auth, headers), undefined, what);
      }
      // The control: the cookie the worker set opens the session, and it names the row.
      const id = String((await database.query('SELECT "id" FROM "session"')).rows[0]?.id);
      assert.equal((await sessionOf(auth, { Cookie: cookie }))?.id, id);

      // Even with the bearer plugin, which the worker refuses, the row opens nothing.
      const { bearer } = await import('better-auth/plugins/bearer');
      const withBearer = await builtPast(
        withTestSignUp({ ...options, plugins: [...(options.plugins ?? []), bearer()] }),
      );
      assert.equal(await sessionOf(withBearer, { Authorization: `Bearer ${row}` }), undefined);
      assert.ok(await sessionOf(withBearer, { Authorization: `Bearer ${token}` }), 'the control: the token itself');
    });

    it('ends a session at once on sign-out, and every session of a person with « sign out everywhere »', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie: first } = await signUp(auth, 'alice@acme.dev');
      // A second session of the same person, as a second browser would hold it.
      const context = await auth.$context;
      const alice = String((await database.query('SELECT "id" FROM "user"')).rows[0]?.id);
      const second = signed(String((await context.internalAdapter.createSession(alice)).token), AUTH_SECRET);
      const { cookie: other } = await signUp(auth, 'bob@acme.dev');
      const count = async (): Promise<number> =>
        Number((await database.query('SELECT count(*) AS n FROM "session"')).rows[0]?.n);

      assert.equal(await count(), 3);
      assert.ok(await sessionOf(auth, { Cookie: second }), 'a second session of the same person');

      const everywhere = await ask(auth, '/revoke-sessions', {
        method: 'POST',
        body: '{}',
        headers: { Cookie: first },
      });
      assert.equal(everywhere.status, 200);
      assert.equal(await sessionOf(auth, { Cookie: first }), undefined);
      assert.equal(await sessionOf(auth, { Cookie: second }), undefined);
      assert.equal(await count(), 1, 'the session of another person stays');

      const out = await ask(auth, '/sign-out', { method: 'POST', body: '{}', headers: { Cookie: other } });
      assert.equal(out.status, 200);
      assert.equal(await sessionOf(auth, { Cookie: other }), undefined);
      assert.equal(await count(), 0);
    });

    it('keeps the token of the cookie when a session is renewed, and the digest in the row', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      // A session last renewed two days ago: better-auth renews it at the next read (updateAge, a day).
      await database.query(
        `UPDATE "session" SET "expiresAt" = now() + interval '5 days', "updatedAt" = now() - interval '2 days'`,
      );
      const before = (await database.query('SELECT "expiresAt" FROM "session"')).rows[0]?.expiresAt;
      const answer = await ask(auth, '/get-session', { headers: { Cookie: cookie } });
      const renewed = answer.headers.getSetCookie().find((each) => each.startsWith(`${SESSION_COOKIE}=`));

      assert.ok(renewed, 'better-auth did not renew the session, so nothing below is tested');
      assert.equal(tokenIn(renewed), tokenIn(cookie));
      const row = (await database.query('SELECT "token", "expiresAt" FROM "session"')).rows[0];
      assert.equal(row?.token, await digest(tokenIn(cookie)));
      assert.ok(new Date(String(row?.expiresAt)) > new Date(String(before)));
      assert.ok(await sessionOf(auth, { Cookie: renewed.split(';')[0] ?? '' }));
    });

    it('answers 404 on each route that names a session by its token, or reads a token of a provider', async () => {
      const { options } = await optionsOn(await opening(open));
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');

      // Some are a GET and some a POST: neither is answered.
      const both = async (instance: Auth, path: string, cookie_: string): Promise<number[]> => [
        (await ask(instance, path, { headers: { Cookie: cookie_ } })).status,
        (await ask(instance, path, { method: 'POST', body: '{}', headers: { Cookie: cookie_ } })).status,
      ];
      for (const path of Object.keys(DISABLED_PATHS))
        assert.deepEqual(await both(auth, path, cookie), [404, 404], path);
      // The control: the same instance answers a route that is not in the list.
      assert.equal(
        (await ask(auth, '/update-user', { method: 'POST', body: '{"name":"Al"}', headers: { Cookie: cookie } }))
          .status,
        200,
      );
      // And each of them is a route of better-auth: without the list and the plugin, it is answered.
      const answering = await builtPast(withTestSignUp(withoutTheLayer({ ...options, disabledPaths: [] })));
      const { cookie: again } = await signUp(answering, 'bob@acme.dev');
      for (const path of Object.keys(DISABLED_PATHS)) {
        assert.notDeepEqual(
          await both(answering, path, again),
          [404, 404],
          `better-auth has no ${path}: take it out of DISABLED_PATHS`,
        );
      }
    });

    it('throws on a call in the process to a route that names a session by its token, and ends nothing', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const api = auth.api as unknown as Record<string, (input: object) => Promise<unknown>>;
      const headers = new Headers({ Cookie: cookie, Origin: CONSOLE_URL });
      const planted: [string, string, object][] = [
        ['revokeSession', '/revoke-session', { headers, body: { token: tokenIn(cookie) } }],
        ['revokeOtherSessions', '/revoke-other-sessions', { headers }],
        ['getAccessToken', '/get-access-token', { headers, body: { providerId: 'github' } }],
        ['refreshToken', '/refresh-token', { headers, body: { providerId: 'github' } }],
        ['accountInfo', '/account-info', { headers, query: {} }],
      ];

      assert.deepEqual(planted.map(([, path]) => path).toSorted(), Object.keys(DISABLED_PATHS).toSorted());
      for (const [name, path, input] of planted) {
        await assert.rejects(
          api[name]?.(input) ?? Promise.reject(new Error(`no auth.api.${name}`)),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(error.message, closedPath(path));

            return true;
          },
        );
      }
      assert.ok(await sessionOf(auth, { Cookie: cookie }), 'a refused call ended the session');
      // The control: the same instance, called the same way, ends every session of the person.
      await api.revokeSessions?.({ headers });
      assert.equal(await sessionOf(auth, { Cookie: cookie }), undefined);
    });

    it('lets the organization plugin write the active workspace of a session, by its token', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const api = auth.api as unknown as Record<string, (input: object) => Promise<{ id?: string } | null>>;
      const headers = new Headers({ Cookie: cookie, Origin: CONSOLE_URL });
      const workspace = await api.createOrganization?.({ headers, body: { name: 'Acme', slug: 'acme' } });
      await api.setActiveOrganization?.({ headers, body: { organizationId: null } });
      await api.setActiveOrganization?.({ headers, body: { organizationId: workspace?.id } });
      const row = (await database.query('SELECT "token", "activeOrganizationId" FROM "session"')).rows[0];

      assert.match(String(workspace?.id), /^ws_/);
      assert.deepEqual(row, { token: await digest(tokenIn(cookie)), activeOrganizationId: workspace?.id });
    });

    it('keeps a link or a code as a digest that finds nothing when it is presented', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const context = await (await startAuth(options)).$context;
      const identifier = 'magic-link:a-token-of-a-link-that-nobody-guesses';
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await context.internalAdapter.createVerificationValue({ identifier, value: '{}', expiresAt });
      const kept = String((await database.query('SELECT "identifier" FROM "verification"')).rows[0]?.identifier);

      assert.deepEqual(await heldIn(database, ['a-token-of-a-link']), []);
      assert.notEqual(kept, await digest(identifier), 'digested once more than better-auth does');
      // What a copy gives, presented as it is and without its prefix: nothing.
      assert.equal(await context.internalAdapter.consumeVerificationValue(kept), null);
      assert.equal(await context.internalAdapter.consumeVerificationValue(`magic-link:${kept}`), null);
      // The control: the link itself is found, once.
      assert.equal((await context.internalAdapter.consumeVerificationValue(identifier))?.value, '{}');
      assert.equal(await context.internalAdapter.consumeVerificationValue(identifier), null);
    });

    it('keeps no state of a sign-in with a provider, and no token of the provider, in any row', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const providers = { github: { clientId: 'a-client-of-a-test', clientSecret: 'a-secret-of-a-test-0123456789' } };
      const auth = await startAuth({ ...options, socialProviders: providers });
      const github: Record<string, unknown> = {
        'https://github.com/login/oauth/access_token': {
          access_token: 'gho_an-access-token-of-github',
          refresh_token: 'ghr_a-refresh-token-of-github',
          token_type: 'bearer',
          scope: 'read:user,user:email',
        },
        'https://api.github.com/user': { id: 4242, login: 'alice', name: 'Alice', email: 'alice@acme.dev' },
        'https://api.github.com/user/emails': [{ email: 'alice@acme.dev', primary: true, verified: true }],
      };
      const fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = github[`${url.origin}${url.pathname}`];
        if (body === undefined) throw new Error(`a test called ${url.origin}${url.pathname}`);

        return Response.json(body);
      });
      try {
        const start = await ask(auth, '/sign-in/social', {
          method: 'POST',
          body: JSON.stringify({ provider: 'github', callbackURL: CONSOLE_URL }),
        });
        assert.equal(start.status, 200, await start.clone().text());
        const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state') ?? '';
        const stateCookie = start.headers
          .getSetCookie()
          .map((each) => each.split(';')[0])
          .join('; ');

        assert.ok(state.length >= 32, 'no state in the address of GitHub');
        assert.deepEqual((await database.query('SELECT "id" FROM "verification"')).rows, [], 'a row for the state');
        assert.match(stateCookie, /oauth_state=/);

        const back = await auth.handler(
          new Request(`${PUBLIC_URL}/console/auth/callback/github?code=a-code-of-github&state=${state}`, {
            headers: { Cookie: stateCookie },
          }),
        );
        assert.equal(back.status, 302, back.headers.get('Location') ?? '');
        assert.doesNotMatch(back.headers.get('Location') ?? '', /error/);
        const cookie = back.headers
          .getSetCookie()
          .filter((each) => each.startsWith(`${SESSION_COOKIE}=`))
          .map((each) => each.split(';')[0])
          .join('; ');

        assert.ok(await sessionOf(auth, { Cookie: cookie }), 'the sign-in with GitHub opened no session');
        assert.deepEqual((await database.query('SELECT "providerId", "accountId", "scope" FROM "account"')).rows, [
          { providerId: 'github', accountId: '4242', scope: 'read:user,user:email' },
        ]);
        assert.deepEqual(
          await heldIn(database, ['an-access-token-of-github', 'a-refresh-token-of-github', state, tokenIn(cookie)]),
          [],
        );
      } finally {
        fetched.mock.restore();
      }
    });

    it('writes no token and no digest in the log, when a lookup fails or a route refuses', async () => {
      const database = await opening(open);
      const { options, said } = await optionsOn(database);
      const written: string[] = [];
      const mocks = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        mock.method(console, level, (...args: unknown[]) => void written.push(args.map(String).join(' '))),
      );
      let secrets: string[] = [];
      try {
        const auth = await startAuth(withTestSignUp(options));
        const { cookie } = await signUp(auth, 'alice@acme.dev');
        const row = String((await database.query('SELECT "token" FROM "session"')).rows[0]?.token);
        secrets = [tokenIn(cookie), row];
        await sessionOf(auth, { Cookie: signed(row, AUTH_SECRET) });
        await ask(auth, '/sign-out', {
          method: 'POST',
          body: '{}',
          headers: { Cookie: cookie, Origin: 'https://evil.test' },
        });
        // A closed path, called in the process: refused, and the error names no token.
        await (auth.api as unknown as { revokeOtherSessions(input: object): Promise<unknown> })
          .revokeOtherSessions({ headers: new Headers({ Cookie: cookie, Origin: CONSOLE_URL }) })
          .then(
            () => assert.fail('revoke-other-sessions answered: read DISABLED_PATHS'),
            (error: unknown) => void written.push(String(error)),
          );
        await ask(auth, '/sign-out', { method: 'POST', body: '{}', headers: { Cookie: cookie } });
      } finally {
        for (const each of mocks) each.mock.restore();
      }
      const log = [...said.map(({ message }) => message), ...written].join('\n');

      assert.equal(secrets.length, 2, 'no session was opened, so nothing below is tested');
      assert.ok(log.length > 0, 'nothing was written, so the log was not read');
      for (const secret of secrets) assert.equal(log.includes(secret), false);
    });

    it('finds a session by an index of its digest', async () => {
      const database = await opening(open);
      await optionsOn(database);
      await database.query('SET enable_seqscan = off');
      const plan = (
        await database.query(`EXPLAIN SELECT * FROM "session" WHERE "token" = $1`, [await digest('x')])
      ).rows
        .map((row) => String(Object.values(row)[0]))
        .join('\n');

      assert.match(plan, /Index (Only )?Scan using session_token_key on session/);
    });

    // The guard of every case above, and the control that it sees what it looks for.
    it('finds the token of a session in a row of an instance that has no layer', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const { cookie } = await signUp(await builtPast(withTestSignUp(withoutTheLayer(options))), 'alice@acme.dev');

      assert.deepEqual(await heldIn(database, [tokenIn(cookie)]), [tokenIn(cookie)]);
    });
  });
}

describe('the layer between better-auth and its adapter (FRU-181)', () => {
  /** An adapter that keeps its rows in memory and records what it was asked. */
  function recording(): { adapter: AdapterOfAuth; asked: { name: string; call: Record<string, unknown> }[] } {
    const asked: { name: string; call: Record<string, unknown> }[] = [];
    const adapter: AdapterOfAuth = { id: 'recording' };
    for (const name of ADAPTER_MEMBERS) {
      if (name === 'id' || name === 'options' || name === 'createSchema') continue;
      adapter[name] =
        name === 'transaction'
          ? async (callback: (trx: AdapterOfAuth) => Promise<unknown>) =>
              callback({ ...adapter, transaction: undefined })
          : async (call: Record<string, unknown>) => {
              asked.push({ name, call });

              return name === 'findMany' ? [{ id: 'ses_1', token: 'not-a-digest-it-was-given' }] : (call.data ?? null);
            };
    }

    return { adapter, asked };
  }

  it('knows every member of the adapter that better-auth builds, and no other', async () => {
    const { options } = await optionsOn(await opening(DATABASES[0]?.open ?? (async () => assert.fail())));
    const { betterAuth } = await import('better-auth');
    const context = await betterAuth(withoutTheLayer(options)).$context;
    const members = Object.keys(context.adapter);

    assert.deepEqual(unknownMembers(context.adapter as unknown as AdapterOfAuth), []);
    // A member that went away is a reading of the adapter that is out of date, too.
    assert.deepEqual(
      ADAPTER_MEMBERS.filter((name) => !members.includes(name)),
      [],
    );
  });

  it('refuses an adapter that has a member it does not know, and names it', () => {
    const { adapter } = recording();

    assert.throws(() => keepAtRest({ ...adapter, upsert: async () => null }), /« ?upsert|\(upsert\)/);
  });

  it('digests a token once, in a row and in a lookup, and never quotes it', async () => {
    const { adapter, asked } = recording();
    const kept = keepAtRest(keepAtRest(adapter));
    const created = (await (kept.create as (call: object) => Promise<Record<string, unknown>>)({
      model: 'session',
      data: { token: 'a-token', userId: 'acc_1' },
    })) as Record<string, unknown>;
    await (kept.findOne as (call: object) => Promise<unknown>)({
      model: 'session',
      where: [{ field: 'token', value: 'a-token' }],
    });
    await (kept.deleteMany as (call: object) => Promise<unknown>)({
      model: 'session',
      where: [{ field: 'token', value: ['a-token', 'b-token'], operator: 'in' }],
    });

    const [written, found, deleted] = asked.map(({ call }) => call);
    assert.equal(created.token, 'a-token', 'the row read back has the token its caller gave');
    assert.equal((written?.data as Record<string, unknown> | undefined)?.token, await digest('a-token'));
    assert.deepEqual((found?.where as { value: unknown }[] | undefined)?.[0]?.value, await digest('a-token'));
    assert.deepEqual((deleted?.where as { value: unknown }[] | undefined)?.[0]?.value, [
      await digest('a-token'),
      await digest('b-token'),
    ]);
  });

  it('answers no token for a session whose token it was not given, and refuses a lookup by none', async () => {
    const { adapter } = recording();
    const kept = keepAtRest(adapter);
    const listed = (await (kept.findMany as (call: object) => Promise<Record<string, unknown>[]>)({
      model: 'session',
      where: [{ field: 'userId', value: 'acc_1' }],
    })) as Record<string, unknown>[];

    const token = listed[0]?.token;
    assert.deepEqual(listed, [{ id: 'ses_1' }]);
    await assert.rejects(
      (kept.delete as (call: object) => Promise<unknown>)({
        model: 'session',
        where: [{ field: 'token', value: token }],
      }),
      (error: unknown) => error instanceof Error && /name a session by its id/.test(error.message),
    );
    for (const operator of ['contains', 'starts_with', 'gt']) {
      await assert.rejects(
        (kept.findOne as (call: object) => Promise<unknown>)({
          model: 'verification',
          where: [{ field: 'identifier', value: 'magic-link:', operator }],
        }),
        (error: unknown) => error instanceof Error && !error.message.includes('magic-link:'),
      );
    }
  });

  it('writes the token columns and the password of an account empty, in a transaction too', async () => {
    const { adapter, asked } = recording();
    const kept = keepAtRest(adapter);
    const account = {
      providerId: 'github',
      accountId: '4242',
      accessToken: 'gho_a',
      refreshToken: 'ghr_b',
      idToken: 'eyJ.c',
      password: 'scrypt:d',
    };
    await (kept.transaction as (callback: (trx: AdapterOfAuth) => Promise<unknown>) => Promise<unknown>)(async (trx) =>
      (trx.create as (call: object) => Promise<unknown>)({ model: 'account', data: account }),
    );
    await (kept.update as (call: object) => Promise<unknown>)({
      model: 'account',
      where: [{ field: 'id', value: 'lgn_1' }],
      update: { accessToken: 'gho_e' },
    });

    assert.deepEqual(asked[0]?.call.data, {
      providerId: 'github',
      accountId: '4242',
      accessToken: null,
      refreshToken: null,
      idToken: null,
      password: null,
    });
    assert.deepEqual(asked[1]?.call.update, { accessToken: null });
    assert.deepEqual(Object.keys(DIGESTED).toSorted(), ['session', 'verification']);
    assert.deepEqual(DROPPED.account, ['accessToken', 'refreshToken', 'idToken', 'password']);
  });
});

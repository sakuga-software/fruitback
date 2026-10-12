import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sql } from 'drizzle-orm';
import { AT_REST_PLUGIN, AUTH_BASE_PATH, startAuth } from './auth.ts';
import {
  CONSOLE_URL,
  DATABASES,
  PUBLIC_URL,
  ask,
  databasesOfACase,
  optionsOn,
  signUp,
  withTestSignUp,
} from './auth.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * What an instance of better-auth does with the options of the worker, measured (FRU-144): the
 * cookie, the token of the `session` table, the origin of a request, the address of the caller.
 *
 * No route serves this instance. The cases ask it directly, as the console would the day it is
 * mounted, and each « never » has its control: the same thing with the option that would allow it.
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of DATABASES) {
  describe(`the options of better-auth, measured on an instance, on ${label} (FRU-144)`, { skip }, () => {
    it('opens no session with the row of the session table, and the bearer plugin opens one with the token alone', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const row = String((await rowsOf(database, 'SELECT "token" FROM "session"'))[0]?.token);
      const name = cookie.split('=')[0];
      const token = decodeURIComponent(cookie.split('=')[1] ?? '').split('.')[0] ?? '';
      const sessionOf = async (instance: typeof auth, headers: Record<string, string>): Promise<unknown> =>
        ((await (await ask(instance, '/get-session', { headers })).json()) as { session?: unknown } | null)?.session;

      assert.ok(row.length >= 32, 'no token was read in the table, so nothing below is tested');
      assert.equal(await sessionOf(auth, { Authorization: `Bearer ${row}` }), undefined);
      assert.equal(await sessionOf(auth, { Cookie: `${name}=${row}` }), undefined, 'a cookie that is not signed');
      // The control: the cookie the worker signed opens the session.
      assert.ok(await sessionOf(auth, { Cookie: cookie }));

      // Why `bearer` is refused, kept measured. Built past `startAuth`, which refuses it.
      const { betterAuth } = await import('better-auth');
      const { bearer } = await import('better-auth/plugins/bearer');
      const plugins = [...(options.plugins ?? []), bearer()];
      const withBearer = betterAuth({ ...withTestSignUp(options), plugins }) as unknown as typeof auth;
      assert.ok(
        await sessionOf(withBearer, { Authorization: `Bearer ${token}` }),
        'the bearer plugin no longer opens a session with the token in a header: read REFUSED_PLUGINS again',
      );
      assert.equal(await sessionOf(withBearer, { Authorization: `Bearer ${row}` }), undefined);
      // And without the layer of auth-at-rest.ts, the row of a copy is that token (FRU-144).
      const withoutLayer = betterAuth({
        ...withTestSignUp(options),
        plugins: plugins.filter((plugin) => plugin.id !== AT_REST_PLUGIN),
      }) as unknown as typeof auth;
      const { cookie: other } = await signUp(withoutLayer, 'bob@acme.dev');
      const clear = String(
        (
          await rowsOf(
            database,
            sql`SELECT s."token" FROM "session" s JOIN "user" u ON u."id" = s."userId" WHERE u."email" = ${'bob@acme.dev'}`,
          )
        )[0]?.token,
      );
      assert.ok(other.includes(encodeURIComponent(clear)), 'without the layer, the table holds the token itself');
      assert.ok(await sessionOf(withoutLayer, { Authorization: `Bearer ${clear}` }));
    });

    it('sets the cookie of a session for the routes of the console only, where no script reads it', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const { setCookie } = await signUp(await startAuth(withTestSignUp(options)), 'alice@acme.dev');

      assert.equal(setCookie.length, 1, setCookie.join('\n'));
      const [pair, ...attributes] = (setCookie[0] ?? '').split('; ');
      assert.match(pair ?? '', /^__Secure-fruitback\.session_token=/);
      assert.deepEqual(attributes.filter((attribute) => !attribute.startsWith('Max-Age=')).toSorted(), [
        'HttpOnly',
        'Path=/console',
        'SameSite=Strict',
        'Secure',
      ]);
      // The ids of the worker, on the rows that better-auth wrote.
      assert.match(String((await rowsOf(database, 'SELECT "id" FROM "user"'))[0]?.id), /^acc_[0-9a-f]{20}$/);
      assert.match(String((await rowsOf(database, 'SELECT "id" FROM "session"'))[0]?.id), /^ses_[0-9a-f]{20}$/);
    });

    it('refuses a request that has the cookie and comes from another origin, or from none', async () => {
      const { options } = await optionsOn(await opening(open));
      const auth = await startAuth(withTestSignUp(options));
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const signOut = (headers: Record<string, string>): Promise<Response> =>
        auth.handler(
          new Request(`${PUBLIC_URL}${AUTH_BASE_PATH}/sign-out`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers },
            body: '{}',
          }),
        );

      // `demo.fruitback.com` is the same site as the worker: the cookie is sent from there.
      assert.equal((await signOut({ Origin: 'https://demo.fruitback.test' })).status, 403);
      assert.equal((await signOut({})).status, 403);
      // The control: the console itself is answered.
      assert.equal((await signOut({ Origin: CONSOLE_URL })).status, 200);
    });

    it('keeps no address of the caller, whatever X-Forwarded-For says', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      await signUp(await startAuth(withTestSignUp(options)), 'alice@acme.dev', { 'X-Forwarded-For': '203.0.113.7' });

      // FRU-147: no address and no user agent at all, and not the empty text of 1.7.7 alone.
      assert.deepEqual(await rowsOf(database, 'SELECT "ipAddress", "userAgent" FROM "session"'), [
        { ipAddress: null, userAgent: null },
      ]);
    });

    // Why the worker does not let better-auth read the address: measured, with the tracking on.
    it('takes a lone X-Forwarded-For as the caller wrote it, and refuses a chain, when it tracks addresses', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      // better-auth alone: no header named by the worker, and not the hook that empties the row.
      const tracking = await startAuth(
        withTestSignUp({
          ...options,
          databaseHooks: { ...options.databaseHooks, session: {} },
          advanced: { ...options.advanced, ipAddress: { disableIpTracking: false } },
        }),
      );
      await signUp(tracking, 'lone@acme.dev', { 'X-Forwarded-For': '203.0.113.7' });
      await signUp(tracking, 'chain@acme.dev', { 'X-Forwarded-For': '203.0.113.7, 198.51.100.9' });

      assert.deepEqual(
        await rowsOf(
          database,
          'SELECT u."email", s."ipAddress" FROM "session" s JOIN "user" u ON u."id" = s."userId" ORDER BY u."email"',
        ),
        [
          { email: 'chain@acme.dev', ipAddress: '' },
          { email: 'lone@acme.dev', ipAddress: '203.0.113.7' },
        ],
      );
    });

    // Why `readConfig` refuses every BETTER_AUTH_ variable: measured. The options of the worker are
    // the same in each half, and only the environment of the process changes.
    it('takes an origin and a secret from the environment over its options, when the worker lets one in', async () => {
      const { options } = await optionsOn(await opening(open));
      const withSignUp = withTestSignUp(options);
      const auth = await startAuth(withSignUp);
      const { cookie } = await signUp(auth, 'alice@acme.dev');
      const sessionOf = async (instance: typeof auth, origin: string): Promise<number> =>
        (
          await ask(instance, '/update-user', {
            method: 'POST',
            body: '{"name":"Alice"}',
            headers: { Cookie: cookie, Origin: origin },
          })
        ).status;

      assert.equal(await sessionOf(auth, 'https://evil.test'), 403, 'before: an origin that is not the console');
      try {
        process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'https://evil.test';
        assert.equal(await sessionOf(auth, 'https://evil.test'), 200, 'the variable no longer adds an origin');

        process.env.BETTER_AUTH_SECRETS = '2:another-secret-that-nobody-gave-the-worker-0123456789';
        const other = await startAuth(withSignUp);
        assert.equal(await sessionOf(other, CONSOLE_URL), 401, 'the variable no longer takes the place of the secret');
      } finally {
        delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
        delete process.env.BETTER_AUTH_SECRETS;
      }
      // The control: with no variable, the cookie the worker signed is the cookie that is read.
      assert.equal(await sessionOf(await startAuth(withSignUp), CONSOLE_URL), 200);
    });

    it('gives no way to sign in with a password', async () => {
      const database = await opening(open);
      const { options } = await optionsOn(database);
      const auth = await startAuth(options);
      const answer = await ask(auth, '/sign-up/email', {
        method: 'POST',
        body: JSON.stringify({ email: 'alice@acme.dev', password: 'correct horse battery staple', name: 'Alice' }),
      });

      assert.ok(answer.status >= 400, `a sign-up with a password answered ${answer.status}`);
      assert.equal(answer.headers.get('Set-Cookie'), null);
      assert.deepEqual(await rowsOf(database, 'SELECT "id" FROM "user"'), []);
    });
  });
}

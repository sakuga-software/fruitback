import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it, mock } from 'node:test';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { AUTH_BASE_PATH, type Auth, CLIENT_IP_HEADER, SERVED_PATHS, authOptions, startAuth } from './auth.ts';
import {
  AUTH_CONFIG,
  AUTH_SECRET,
  NO_SESSIONS,
  CONSOLE_URL,
  DATABASES,
  PUBLIC_URL,
  databasesOfACase,
  make,
} from './auth.fixture.ts';
import { createMemoryKv } from './kv.ts';
import { MailError } from './mail.ts';
import { GITHUB, GOOGLE, SESSION_COOKIE, cookieOf, envWith, workerOf } from './auth-worker.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { createPostgresSessionStore } from './session-postgres.ts';
import { digest } from './session.ts';

/**
 * The console signs in with better-auth, beside the path of before (FRU-147). Every case goes through
 * `handleRequest`, as a browser would, on PGlite and on a real server when the run has one.
 *
 * The threat model is in `SECURITY.md`: a copy of the database, a page of the same site as the
 * worker that sends the cookie, a provider that did not verify an address, and the token of a link
 * in an address that a proxy logs.
 */

const { opening } = databasesOfACase();

/** A worker with better-auth on, on the database of a case. */
async function workerOn(open: () => Promise<PgDatabase>, more: { trackIp?: boolean } = {}) {
  return workerOf(await opening(open), more);
}

/** The value of the cookie of a session, as the browser holds it, without its signature. */
function tokenIn(cookie: string): string {
  const value = decodeURIComponent(cookie.split(`${SESSION_COOKIE}=`)[1]?.split(';')[0] ?? '');

  return value.slice(0, value.lastIndexOf('.'));
}

/** A cookie of a session signed as better-call signs one: the value, a dot, its HMAC-SHA256. */
function signed(value: string): string {
  const signature = createHmac('sha256', AUTH_SECRET).update(value).digest('base64');

  return `${SESSION_COOKIE}=${encodeURIComponent(`${value}.${signature}`)}`;
}

/** Every value of every column of the seven tables of better-auth, as text. */
async function everyValue(database: PgDatabase): Promise<string[]> {
  const values: string[] = [];
  for (const table of ['user', 'session', 'account', 'verification', 'organization', 'member', 'invitation']) {
    for (const row of await rowsOf(database, `SELECT * FROM "${table}"`)) {
      for (const value of Object.values(row)) if (value !== null) values.push(String(value));
    }
  }

  return values;
}

/** An id token of Google, as its token endpoint answers one. better-auth decodes it, and checks no signature. */
function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: 'https://accounts.google.com', aud: GOOGLE.clientId, ...claims })}.c2lnbmF0dXJl`;
}

/**
 * A provider that answers as GitHub or Google would, for the length of `work`. better-auth calls them
 * with the `fetch` of the process.
 */
async function withProvider<T>(answers: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  const fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = answers[`${url.origin}${url.pathname}`];
    if (body === undefined) throw new Error(`a test called ${url.origin}${url.pathname}`);

    return Response.json(body);
  });
  try {
    return await work();
  } finally {
    fetched.mock.restore();
  }
}

const GITHUB_TOKEN = {
  'https://github.com/login/oauth/access_token': {
    access_token: 'gho_an-access-token',
    token_type: 'bearer',
    scope: 'read:user,user:email',
  },
};

/** A sign-in with a provider, through the routes of the worker: the start, then the way back. */
async function throughProvider(worker: Awaited<ReturnType<typeof workerOn>>, provider: 'github' | 'google') {
  const start = await worker.call('/console/auth/sign-in/social', { body: { provider, callbackURL: CONSOLE_URL } });
  assert.equal(start.status, 200, await start.clone().text());
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state') ?? '';
  const stateCookie = start.headers
    .getSetCookie()
    .map((each) => each.split(';')[0])
    .join('; ');
  assert.ok(state.length > 0, 'no state');
  assert.match(
    start.headers.getSetCookie().join('\n'),
    /oauth_state=[^;]+;.*Path=\/console\/auth;.*HttpOnly.*SameSite=Lax/i,
  );
  // The provider sends the person back with a navigation from its own site: no `Origin` of the console.
  const back = await worker.call(`/console/auth/callback/${provider}?code=a-code&state=${state}`, {
    origin: null,
    headers: { Cookie: stateCookie },
  });

  return { start, back, location: back.headers.get('Location') ?? '', cookie: cookieOf(back) };
}

for (const { label, open, skip } of DATABASES) {
  describe(`the link of the e-mail, through better-auth, on ${label} (FRU-147)`, { skip }, () => {
    it('opens a session with a link asked for, then spent, and the token reaches the worker in no address', async () => {
      const worker = await workerOn(open);

      const asked = await worker.call('/console/auth/email', { body: { email: ' Alice@Acme.dev ', locale: 'fr' } });
      assert.equal(asked.status, 202);
      assert.deepEqual(await asked.json(), { sent: true });
      const [message] = worker.mail.sent;
      assert.equal(message?.to, 'alice@acme.dev');
      assert.match(message?.subject ?? '', /Votre lien/);
      assert.doesNotMatch(`${message?.text}${message?.html}`, /[?&]token=|magic-link\/verify/);
      const token = worker.lastToken();

      const spent = await worker.call('/console/auth/email/redeem', { body: { token, locale: 'fr' } });
      assert.equal(spent.status, 200);
      const cookie = cookieOf(spent);
      const set = spent.headers.getSetCookie().join('\n');
      assert.match(set, /HttpOnly/);
      assert.match(set, /Secure/);
      assert.match(set, /SameSite=Strict/);
      assert.match(set, /Path=\/console;/);
      // The answer of better-auth holds the token of the session: the worker hands over its cookie only.
      const body = await spent.text();
      assert.doesNotMatch(body, new RegExp(tokenIn(cookie)));
      const { account } = JSON.parse(body) as { account: { id: string; email: string; locale?: string } };
      assert.match(account.id, /^acc_[0-9a-f]{20}$/);
      assert.deepEqual({ ...account, id: '' }, { id: '', email: 'alice@acme.dev', locale: 'fr' });

      const me = await worker.call('/console/me', { headers: { Cookie: cookie } });
      assert.equal(me.status, 200);
      assert.equal(((await me.json()) as { account: { id: string } }).account.id, account.id);
      for (const url of worker.received) assert.equal(url.includes(token), false, url);
    });

    it('opens one session for a link spent twice, or by two calls at the same moment', async () => {
      const worker = await workerOn(open);
      await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      const token = worker.lastToken();

      const first = await worker.call('/console/auth/email/redeem', { body: { token } });
      const again = await worker.call('/console/auth/email/redeem', { body: { token } });
      assert.equal(first.status, 200);
      assert.equal(again.status, 401);
      assert.deepEqual(await again.json(), { error: 'link-spent-or-expired' });
      assert.equal(again.headers.get('Set-Cookie'), null);

      await worker.call('/console/auth/email', { body: { email: 'bob@acme.dev' } });
      const twice = worker.lastToken();
      const both = await Promise.all([
        worker.call('/console/auth/email/redeem', { body: { token: twice } }),
        worker.call('/console/auth/email/redeem', { body: { token: twice } }),
      ]);
      assert.deepEqual(both.map((answer) => answer.status).toSorted(), [200, 401]);
      assert.equal(Number((await rowsOf(worker.database, 'SELECT count(*)::int AS n FROM "session"'))[0]?.n), 2);
    });

    it('keeps the link as a digest of a digest, which opens nothing when a copy presents it', async () => {
      const worker = await workerOn(open);
      await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      const token = worker.lastToken();
      const [row] = await rowsOf(worker.database, 'SELECT identifier, value FROM "verification"');
      const kept = String(row?.identifier);
      const once = createHash('sha256').update(token).digest('base64url');

      // Neither the token nor a digest that a lookup of better-auth takes is in a row.
      const values = await everyValue(worker.database);
      for (const secret of [
        token,
        once,
        `magic-link:${once}`,
        await digest(token),
        await digest(`magic-link:${once}`),
      ]) {
        assert.equal(
          values.some((value) => value.includes(secret)),
          false,
          `a row holds ${secret}`,
        );
      }
      assert.deepEqual(JSON.parse(String(row?.value)), { type: 'magic-link', email: 'alice@acme.dev' });
      // What a copy gives, presented as the token: as it is, and without the prefix of better-auth.
      for (const presented of [kept, kept.replace(/^magic-link:/, ''), once]) {
        const refused = await worker.call('/console/auth/email/redeem', { body: { token: presented } });
        assert.ok([400, 401].includes(refused.status), `${presented}: ${refused.status}`);
      }
      // The control: the link itself opens the session.
      assert.equal((await worker.call('/console/auth/email/redeem', { body: { token } })).status, 200);
    });

    it('answers the same with or without an account, and sends three links to an address in the window', async () => {
      const worker = await workerOn(open);
      await worker.accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });

      const known = await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      const unknown = await worker.call('/console/auth/email', { body: { email: 'nobody@acme.dev' } });
      assert.deepEqual([known.status, await known.text()], [unknown.status, await unknown.text()]);

      // One of the window is spent above.
      assert.equal((await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } })).status, 202);
      assert.equal((await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } })).status, 202);
      const fourth = await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      assert.equal(fourth.status, 429);
      assert.equal(worker.mail.sent.filter((each) => each.to === 'alice@acme.dev').length, 3);
    });

    it('signs in the account of before by its address, under its id', async () => {
      const worker = await workerOn(open);
      const before = await worker.accounts.signIn({
        provider: 'github',
        subject: '4242',
        email: 'alice@acme.dev',
        name: 'Alice',
        locale: 'de',
      });

      await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      const spent = await worker.call('/console/auth/email/redeem', {
        body: { token: worker.lastToken(), locale: 'fr' },
      });

      assert.deepEqual(((await spent.json()) as { account: unknown }).account, before);
      assert.match(
        worker.mail.sent.at(-1)?.subject ?? '',
        /sign-in link/,
        'the language of the account is not the one of the browser',
      );
    });

    // better-auth awaits `sendMagicLink` (read in plugins/magic-link of 1.7.7): the route answers once
    // the mail is sent, and says so when it is not.
    it('answers 202 once the link is sent, and 502 when the mail provider refuses it', async () => {
      const worker = await workerOn(open);
      const said = mock.method(console, 'error', () => {});
      const refused = mock.method(worker.mail, 'send', async () => {
        throw new MailError('The mail provider refused the message: 503');
      });
      try {
        const answer = await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });

        assert.equal(answer.status, 502);
        assert.deepEqual(await answer.json(), { error: 'mail-unavailable' });
      } finally {
        refused.mock.restore();
        said.mock.restore();
      }
      // The control: the same call, with a provider that accepts, answers after the mail is in the box.
      const sent = await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      assert.equal(sent.status, 202);
      assert.equal(worker.mail.sent.length, 1);
    });

    it('spends a link for the console only, and not for a request with no Origin', async () => {
      const worker = await workerOn(open);
      await worker.call('/console/auth/email', { body: { email: 'mallory@acme.dev' } });
      const token = worker.lastToken();

      for (const origin of [null, 'https://demo.fruitback.test']) {
        const answer = await worker.call('/console/auth/email/redeem', { body: { token }, origin });
        assert.equal(answer.status, 403, String(origin));
        assert.equal(answer.headers.get('Set-Cookie'), null);
      }
      // The control: the link was not spent by the two refusals, and the console spends it.
      assert.equal((await worker.call('/console/auth/email/redeem', { body: { token } })).status, 200);
    });

    it('closes the routes of better-auth that put a token in an address', async () => {
      const worker = await workerOn(open);

      for (const [method, path] of [
        ['POST', '/console/auth/sign-in/magic-link'],
        ['GET', '/console/auth/magic-link/verify?token=x'],
      ] as const) {
        const answer = await worker.call(path, {
          method,
          ...(method === 'POST' ? { body: { email: 'a@acme.dev' } } : {}),
        });
        assert.equal(answer.status, 404, path);
      }
      assert.deepEqual(worker.mail.sent, []);
    });
  });

  describe(`a copy of the database, and a page of the same site, on ${label} (FRU-147)`, { skip }, () => {
    it('opens nothing with the token of the session table, as a cookie, signed, or in Authorization', async () => {
      const worker = await workerOn(open);
      const cookie = await worker.signIn('alice@acme.dev');
      const row = String((await rowsOf(worker.database, 'SELECT token FROM "session"'))[0]?.token);
      assert.notEqual(row, tokenIn(cookie));

      const copies: Record<string, string>[] = [
        { Cookie: `${SESSION_COOKIE}=${row}` },
        { Cookie: signed(row) },
        { Authorization: `Bearer ${row}` },
      ];
      for (const headers of copies) {
        assert.equal((await worker.call('/console/me', { headers })).status, 401, JSON.stringify(headers));
      }
      // The control: the cookie that the worker set, and the token in it signed again.
      assert.equal((await worker.call('/console/me', { headers: { Cookie: cookie } })).status, 200);
      assert.equal((await worker.call('/console/me', { headers: { Cookie: signed(tokenIn(cookie)) } })).status, 200);
    });

    it('refuses a change with the cookie from another origin, or from none, and takes it from the console', async () => {
      const worker = await workerOn(open);
      const cookie = await worker.signIn('alice@acme.dev');
      const create = (origin: string | null) =>
        worker.call('/console/workspaces', { body: { name: 'Acme' }, origin, headers: { Cookie: cookie } });

      assert.equal((await create('https://demo.fruitback.test')).status, 403);
      const none = await create(null);
      assert.equal(none.status, 403);
      assert.deepEqual(await none.json(), { error: 'origin-not-allowed' });
      assert.equal(Number((await rowsOf(worker.database, 'SELECT count(*)::int AS n FROM "organization"'))[0]?.n), 0);
      assert.equal((await create(CONSOLE_URL)).status, 201);
      // A read with no `Origin` changes nothing, and answers.
      assert.equal((await worker.call('/console/me', { origin: null, headers: { Cookie: cookie } })).status, 200);
    });

    it('refuses a member who was removed at the next call, and a session that was ended', async () => {
      const worker = await workerOn(open);
      const cookie = await worker.signIn('alice@acme.dev');
      const created = await worker.call('/console/workspaces', { body: { name: 'Acme' }, headers: { Cookie: cookie } });
      const { id } = (await created.json()) as { id: string };
      const sites = () => worker.call(`/console/workspaces/${id}/sites`, { headers: { Cookie: cookie } });
      assert.equal((await sites()).status, 200);

      // The pairing of an extension, for the person of the cookie.
      const connected = await worker.call(`/console/workspaces/${id}/connect`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });
      assert.equal(connected.status, 201);

      await rowsOf(worker.database, `DELETE FROM "member" WHERE "organizationId" = '${id}'`);
      assert.equal((await sites()).status, 404);

      const listed = await worker.call('/console/sessions', { headers: { Cookie: cookie } });
      const { sessions } = (await listed.json()) as { sessions: { id: string; current: boolean }[] };
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.current, true);
      assert.doesNotMatch(JSON.stringify(sessions), new RegExp(tokenIn(cookie)));
      const ended = await worker.call(`/console/sessions/${sessions[0]?.id}`, {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });
      assert.equal(ended.status, 204);
      assert.equal((await worker.call('/console/me', { headers: { Cookie: cookie } })).status, 401);
    });

    // FRU-204: the console says « signed out » only when this route answers `ok`. A route that
    // refused somebody with no session would hold them on « You are still signed in » for ever.
    it('answers a sign-out with a session that already ended, or with none, as it answers the first one', async () => {
      const worker = await workerOn(open);
      const cookie = await worker.signIn('alice@acme.dev');
      const signOut = (headers: Record<string, string>): Promise<Response> =>
        worker.call('/console/auth/sign-out', { body: {}, headers });

      const first = await signOut({ Cookie: cookie });
      assert.equal(first.status, 200);
      assert.equal((await worker.call('/console/me', { headers: { Cookie: cookie } })).status, 401);

      // Another tab that still shows « My account », a session that expired, a cookie that is not one.
      const without: Record<string, string>[] = [
        { Cookie: cookie },
        {},
        { Cookie: `${SESSION_COOKIE}=not-a-session.not-a-signature` },
      ];
      for (const headers of without) {
        const again = await signOut(headers);
        assert.equal(again.status, 200, JSON.stringify(headers));
        assert.deepEqual(await again.json(), { success: true });
      }
    });

    it('ends a session by its id for its person only, and from the console only', async () => {
      const worker = await workerOn(open);
      const alice = await worker.signIn('alice@acme.dev');
      const bob = await worker.signIn('bob@acme.dev');
      const idOf = async (cookie: string) =>
        (
          (await (await worker.call('/console/sessions', { headers: { Cookie: cookie } })).json()) as {
            sessions: { id: string }[];
          }
        ).sessions[0]?.id;
      const bobs = await idOf(bob);

      const across = await worker.call(`/console/sessions/${bobs}`, { method: 'DELETE', headers: { Cookie: alice } });
      assert.equal(across.status, 404);
      const noOrigin = await worker.call(`/console/sessions/${bobs}`, {
        method: 'DELETE',
        origin: null,
        headers: { Cookie: bob },
      });
      assert.equal(noOrigin.status, 403);
      assert.equal((await worker.call('/console/me', { headers: { Cookie: bob } })).status, 200);
    });

    it('answers no route that hands the token of the session to a script of the console', async () => {
      const worker = await workerOn(open);
      const cookie = await worker.signIn('alice@acme.dev');
      const token = tokenIn(cookie);
      const headers = { Cookie: cookie };

      // FRU-206: `/get-session` of better-auth answers the session with its token, and it was served.
      for (const method of ['GET', 'POST']) {
        const answer = await worker.call(`${AUTH_BASE_PATH}/get-session`, { method, headers });
        assert.equal(answer.status, 404, method);
        assert.deepEqual(await answer.json(), { error: 'not-found' });
      }
      // The control: better-auth has that route, and it answers the token to whoever has the cookie.
      const inside = await worker.auth.handler(
        new Request(`https://api.fruitback.test${AUTH_BASE_PATH}/get-session`, { headers }),
      );
      assert.equal(inside.status, 200);
      assert.ok((await inside.text()).includes(token), 'better-auth no longer answers the token: read this test again');

      // No route a script of the console can read answers it: the served ones, and the worker's own.
      const read = [
        ...Object.keys(SERVED_PATHS).map((path) => `${AUTH_BASE_PATH}${path}`),
        '/console/me',
        '/console/sessions',
      ];
      for (const path of read) {
        const answer = await worker.call(path, { headers });
        assert.equal((await answer.text()).includes(token), false, path);
        assert.equal(answer.headers.get('Location')?.includes(token) ?? false, false, path);
      }
      // The session is still read in the process: the cookie opens the console as before.
      assert.equal((await worker.call('/console/me', { headers })).status, 200);
    });
  });

  describe(`the cookie of a session that is renewed, on ${label} (FRU-208)`, { skip }, () => {
    /** A session last renewed two days ago: better-auth renews it at the next read (a day). */
    const aged = (worker: Awaited<ReturnType<typeof workerOn>>) =>
      rowsOf(
        worker.database,
        `UPDATE "session" SET "expiresAt" = now() + interval '5 days', "updatedAt" = now() - interval '2 days'`,
      );
    const endOf = async (worker: Awaited<ReturnType<typeof workerOn>>): Promise<number> =>
      new Date(String((await rowsOf(worker.database, 'SELECT "expiresAt" FROM "session"'))[0]?.expiresAt)).getTime();
    const sessionCookies = (answer: Response): string[] =>
      answer.headers.getSetCookie().filter((each) => each.includes('fruitback.session_token='));

    it('renews the cookie with the session, on each route that reads the cookie, and on no other call', async () => {
      const worker = await workerOn(open);
      const opened = await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      assert.equal(opened.status, 202);
      const redeemed = await worker.call('/console/auth/email/redeem', { body: { token: worker.lastToken() } });
      const atSignIn = sessionCookies(redeemed)[0] ?? '';
      const cookie = cookieOf(redeemed);
      const headers = { Cookie: cookie };
      const created = await worker.call('/console/workspaces', { body: { name: 'Acme' }, headers });
      const { id } = (await created.json()) as { id: string };
      // A session of today is not renewed: no call above set the cookie again.
      assert.deepEqual(sessionCookies(created), []);

      for (const path of [
        '/console/me',
        '/console/sessions',
        `/console/auth/organization/list-members?organizationId=${id}`,
      ]) {
        await aged(worker);
        const before = await endOf(worker);

        const answer = await worker.call(path, { headers });
        assert.equal(answer.status, 200, path);
        // The row moved: better-auth renewed the session. Without this the lines below test nothing.
        assert.ok((await endOf(worker)) > before + 24 * 60 * 60 * 1000, `${path}: the session was not renewed`);
        // The cookie of the sign-in again, to the letter: the same token, and seven days from now.
        assert.deepEqual(sessionCookies(answer), [atSignIn], path);
        assert.match(atSignIn, /; Max-Age=604800; Path=\/console; HttpOnly; Secure; SameSite=Strict$/);
        assert.equal(answer.headers.get('Access-Control-Allow-Origin'), CONSOLE_URL, path);

        // The control: the next call finds a session renewed a moment ago, and sets nothing.
        const next = await worker.call(path, { headers });
        assert.equal(next.status, 200, path);
        assert.deepEqual(sessionCookies(next), [], path);
      }
    });

    it('sets no cookie for a cookie that opens nothing, and none for the session that a call ends', async () => {
      const worker = await workerOn(open);
      const cookie = await worker.signIn('alice@acme.dev');
      const headers = { Cookie: cookie };

      const nothing: Record<string, string>[] = [{}, { Cookie: `${SESSION_COOKIE}=not-a-session.not-a-signature` }];
      for (const refused of nothing) {
        const answer = await worker.call('/console/me', { headers: refused });
        assert.equal(answer.status, 401);
        assert.deepEqual(answer.headers.getSetCookie(), []);
      }
      // A session that expired: better-auth sets cookies on that reading too (it clears them), and
      // none of them leaves by this way. Somebody of another session signs in for this half.
      const late = await worker.signIn('bob@acme.dev');
      await rowsOf(
        worker.database,
        `UPDATE "session" SET "expiresAt" = now() - interval '1 minute' WHERE "token" <> '${await digest(tokenIn(cookie))}'`,
      );
      const expired = await worker.call('/console/me', { headers: { Cookie: late } });
      assert.equal(expired.status, 401);
      assert.deepEqual(expired.headers.getSetCookie(), []);

      // The person ends this very session, and the reading of that call renewed it a moment before.
      const listed = await worker.call('/console/sessions', { headers });
      const { sessions } = (await listed.json()) as { sessions: { id: string; current: boolean }[] };
      await aged(worker);
      const ended = await worker.call(`/console/sessions/${sessions[0]?.id}`, { method: 'DELETE', headers });
      assert.equal(ended.status, 204);
      assert.deepEqual(ended.headers.getSetCookie(), []);
      assert.equal((await worker.call('/console/me', { headers })).status, 401);

      // The two routes of better-auth that end the session of the cookie do not go through the
      // reading of the worker. « Sign out » clears the cookie. « Sign out everywhere » is better-auth
      // alone, before and after FRU-208: it can set the cookie again on its own answer, and whatever
      // it sets opens nothing, because every session of the person is gone.
      for (const route of ['sign-out', 'revoke-sessions']) {
        const again = { Cookie: await worker.signIn('alice@acme.dev') };
        await aged(worker);
        const out = await worker.call(`/console/auth/${route}`, { body: {}, headers: again });
        assert.equal(out.status, 200, route);
        if (route === 'sign-out') {
          for (const each of sessionCookies(out)) assert.match(each, /fruitback\.session_token=;.*Max-Age=0/);
        }
        for (const held of [again.Cookie, cookieOf(out)].filter((each) => each !== '')) {
          assert.equal((await worker.call('/console/me', { headers: { Cookie: held } })).status, 401, route);
        }
      }
    });
  });

  describe(`what a reading of better-auth may set, on ${label} (FRU-208)`, { skip }, () => {
    it('hands the browser the cookie of the session and no other header of a reading', async () => {
      const database = await opening(open);
      await make(database);
      const renewed = '__Secure-fruitback.session_token=a-token.a-signature; Max-Age=604800; Path=/console';
      // A reading that sets more than the cookie of the session, as a later better-auth could.
      const setting = {
        api: {
          getSession: async () => ({
            headers: new Headers([
              ['Set-Cookie', renewed],
              ['Set-Cookie', '__Secure-fruitback.session_data=a-cache; Max-Age=300; Path=/'],
              ['Set-Cookie', 'another=1; Path=/'],
              ['X-Of-Better-Auth', 'a-header'],
            ]),
            response: { user: { id: 'acc_nobody' }, session: { id: 'a-session' } },
          }),
        },
      } as unknown as Auth;

      const answer = await handleRequest(
        new Request('https://worker.test/console/me', {
          headers: { Origin: CONSOLE_URL, Cookie: '__Secure-fruitback.session_token=a-token.a-signature' },
        }),
        envWith(),
        {
          clientIp: '192.0.2.201',
          accounts: createPostgresAccountStore(database),
          auth: setting,
          kv: createMemoryKv(),
        },
      );

      assert.deepEqual(answer.headers.getSetCookie(), [renewed]);
      assert.equal(answer.headers.get('X-Of-Better-Auth'), null);
      // An answer that sets a cookie is kept by no cache: every answer of the console says so already.
      assert.equal(answer.headers.get('Cache-Control'), 'no-store');
    });
  });

  describe(`a change on a route of better-auth comes from the console, on ${label} (FRU-212)`, { skip }, () => {
    /** Every route of better-auth that the worker serves and that a request can change something by. */
    const WRITES: Record<string, unknown> = {
      '/sign-out': {},
      '/revoke-sessions': {},
      '/sign-in/social': { provider: 'github', callbackURL: CONSOLE_URL },
      // better-auth takes a POST on its callbacks, for a provider that comes back by a form. GitHub
      // and Google come back by a GET, so nothing legitimate posts here.
      '/callback/github': { code: 'a-code', state: 'a-state' },
      '/callback/google': { code: 'a-code', state: 'a-state' },
    };

    it('lists every served route that is not only read', () => {
      const read = ['/ok', '/error'];

      assert.deepEqual(Object.keys(SERVED_PATHS).sort(), [...Object.keys(WRITES), ...read].sort());
    });

    for (const [path, body] of Object.entries(WRITES)) {
      it(`refuses a change on ${path} with no Origin, whatever its Referer`, async () => {
        const worker = await workerOn(open);
        const cookie = await worker.signIn('alice@acme.dev');
        const from = (more: { origin: string | null; referer?: string }) =>
          worker.call(`${AUTH_BASE_PATH}${path}`, {
            body,
            origin: more.origin,
            headers: { Cookie: cookie, ...(more.referer === undefined ? {} : { Referer: more.referer }) },
          });

        for (const [name, referer] of [
          ['no Origin', undefined],
          ['the Referer of the console only', `${CONSOLE_URL}/w/ws_1/account`],
          ['the Referer of the worker only', `${PUBLIC_URL}/pair`],
        ] as const) {
          const refused = await from({ origin: null, ...(referer === undefined ? {} : { referer }) });
          assert.equal(refused.status, 403, name);
          assert.deepEqual(await refused.json(), { error: 'origin-not-allowed' }, name);
          assert.deepEqual(refused.headers.getSetCookie(), [], name);
        }
        // Nothing changed: the session of the cookie is still there.
        assert.equal((await worker.call('/console/me', { headers: { Cookie: cookie } })).status, 200);
        // With no cookie either: better-auth alone checks no origin at all for such a request.
        const bare = await worker.call(`${AUTH_BASE_PATH}${path}`, { body, origin: null });
        assert.equal(bare.status, 403, 'no cookie and no Origin');
        assert.deepEqual(await bare.json(), { error: 'origin-not-allowed' });

        // The control: the same call from the console reaches better-auth, which answers it.
        const taken = await from({ origin: CONSOLE_URL });
        assert.notEqual(taken.status, 403, await taken.clone().text());
      });
    }

    it('still answers a read of better-auth with no Origin: the way back from a provider is one', async () => {
      const worker = await workerOn(open);

      assert.equal((await worker.call(`${AUTH_BASE_PATH}/ok`, { origin: null })).status, 200);
      // No state: better-auth answers its own refusal, a redirect to the console, and not the worker's 403.
      const back = await worker.call(`${AUTH_BASE_PATH}/callback/github?code=a-code&state=a-state`, { origin: null });
      assert.equal(back.status, 302);
    });
  });

  describe(`GitHub and Google, through better-auth, on ${label} (FRU-147)`, { skip }, () => {
    it('creates no account and joins none for an address that GitHub did not verify', async () => {
      const worker = await workerOn(open);
      const alice = await worker.accounts.signIn({
        provider: 'email',
        subject: 'alice@acme.dev',
        email: 'alice@acme.dev',
      });

      for (const email of ['eve@acme.dev', 'alice@acme.dev']) {
        const { location, cookie } = await withProvider(
          {
            ...GITHUB_TOKEN,
            'https://api.github.com/user': { id: 66, login: 'eve', name: 'Eve', email },
            'https://api.github.com/user/emails': [{ email, primary: true, verified: false }],
          },
          () => throughProvider(worker, 'github'),
        );

        assert.equal(cookie, '', `${email}: a session was opened`);
        assert.ok(location.startsWith(`${CONSOLE_URL}/setup?error=`), location);
      }
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id FROM "user"'), [{ id: alice.id }]);
      assert.deepEqual(
        await rowsOf(worker.database, `SELECT "providerId" FROM "account" WHERE "providerId" = 'github'`),
        [],
      );
    });

    // The control of the case above: without the hook of the worker, better-auth makes that account
    // and opens its session (measured on 1.7.7).
    it('makes an account for an address that GitHub did not verify, without the hook of the worker', async () => {
      const database = await opening(open);
      await make(database);
      const options = await authOptions(
        { ...AUTH_CONFIG, github: GITHUB, trackIp: false },
        await database.pool(),
        NO_SESSIONS,
      );
      const auth = await startAuth({ ...options, databaseHooks: { ...options.databaseHooks, user: {} } });
      const start = await auth.handler(
        new Request(`${PUBLIC_URL}/console/auth/sign-in/social`, {
          method: 'POST',
          headers: { Origin: CONSOLE_URL, 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'github', callbackURL: CONSOLE_URL }),
        }),
      );
      const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state') ?? '';
      const stateCookie = start.headers
        .getSetCookie()
        .map((each) => each.split(';')[0])
        .join('; ');

      const back = await withProvider(
        {
          ...GITHUB_TOKEN,
          'https://api.github.com/user': { id: 66, login: 'eve', name: 'Eve', email: 'eve@acme.dev' },
          'https://api.github.com/user/emails': [{ email: 'eve@acme.dev', primary: true, verified: false }],
        },
        () =>
          auth.handler(
            new Request(`${PUBLIC_URL}/console/auth/callback/github?code=a-code&state=${state}`, {
              headers: { Cookie: stateCookie },
            }),
          ),
      );

      assert.notEqual(cookieOf(back), '', 'better-auth opened no session: the hook proves nothing');
      assert.deepEqual(await rowsOf(database, 'SELECT email, "emailVerified" FROM "user"'), [
        { email: 'eve@acme.dev', emailVerified: false },
      ]);
    });

    it('creates no account for an address that Google did not verify', async () => {
      const worker = await workerOn(open);

      const { location, cookie } = await withProvider(
        {
          'https://oauth2.googleapis.com/token': {
            access_token: 'ya29.an-access-token',
            token_type: 'Bearer',
            id_token: idToken({ sub: '1081', email: 'eve@acme.dev', email_verified: false, name: 'Eve' }),
          },
        },
        () => throughProvider(worker, 'google'),
      );

      assert.equal(cookie, '');
      assert.ok(location.startsWith(`${CONSOLE_URL}/setup?error=`), location);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT id FROM "user"'), []);
    });

    it('signs the account of before in with GitHub, under its id, and keeps no token and no picture', async () => {
      const worker = await workerOn(open);
      const before = await worker.accounts.signIn({
        provider: 'github',
        subject: '4242',
        email: 'alice@acme.dev',
        name: 'Alice',
      });

      const { location, cookie } = await withProvider(
        {
          ...GITHUB_TOKEN,
          'https://api.github.com/user': {
            id: 4242,
            login: 'alice',
            name: 'Alice',
            email: 'alice@acme.dev',
            avatar_url: 'https://avatars.example/alice.png',
          },
          'https://api.github.com/user/emails': [{ email: 'alice@acme.dev', primary: true, verified: true }],
        },
        () => throughProvider(worker, 'github'),
      );

      assert.equal(location, CONSOLE_URL);
      const me = await worker.call('/console/me', { headers: { Cookie: cookie } });
      assert.equal(((await me.json()) as { account: { id: string } }).account.id, before.id);
      const values = await everyValue(worker.database);
      for (const secret of ['gho_an-access-token', 'avatars.example']) {
        assert.equal(
          values.some((value) => value.includes(secret)),
          false,
          secret,
        );
      }
    });

    it('starts a sign-in with GitHub by a navigation, and sets the cookie of the state on it (FRU-148)', async () => {
      const worker = await workerOn(open);
      await worker.accounts.signIn({ provider: 'github', subject: '4242', email: 'alice@acme.dev' });

      // A navigation of the browser: no `Origin`, and the answer is a redirect, not a body to read.
      const start = await worker.call('/console/auth/start/github', { origin: null });
      assert.equal(start.status, 302);
      const to = new URL(start.headers.get('Location') ?? '');
      assert.equal(`${to.origin}${to.pathname}`, 'https://github.com/login/oauth/authorize');
      assert.equal(to.searchParams.get('redirect_uri'), `${PUBLIC_URL}/console/auth/callback/github`);
      assert.equal(start.headers.get('Access-Control-Allow-Origin'), null);
      const set = start.headers.getSetCookie().join('\n');
      assert.match(set, /oauth_state=[^;]+;.*Path=\/console\/auth;.*HttpOnly.*SameSite=Lax/i);
      const stateCookie = start.headers
        .getSetCookie()
        .map((each) => each.split(';')[0])
        .join('; ');

      const back = await withProvider(
        {
          ...GITHUB_TOKEN,
          'https://api.github.com/user': { id: 4242, login: 'alice', name: 'Alice', email: 'alice@acme.dev' },
          'https://api.github.com/user/emails': [{ email: 'alice@acme.dev', primary: true, verified: true }],
        },
        () =>
          worker.call(`/console/auth/callback/github?code=a-code&state=${to.searchParams.get('state')}`, {
            origin: null,
            headers: { Cookie: stateCookie },
          }),
      );
      assert.equal(back.headers.get('Location'), `${CONSOLE_URL}/`);
      assert.equal((await worker.call('/console/me', { headers: { Cookie: cookieOf(back) } })).status, 200);
    });

    it('starts a sign-in with a provider on a GET only, and sets no cookie of a state on another method (FRU-207)', async () => {
      const worker = await workerOn(open);

      // A form of another site posts where a link only navigates, and a `fetch` chooses its method.
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        for (const origin of [null, CONSOLE_URL]) {
          const refused = await worker.call('/console/auth/start/github', { method, origin });
          assert.equal(refused.status, 405, `${method} from ${origin}`);
          assert.deepEqual(refused.headers.getSetCookie(), [], `${method} from ${origin}`);
          assert.equal(refused.headers.get('Location'), null, `${method} from ${origin}`);
        }
      }
      // The control: the same address, by a GET, starts the sign-in.
      const started = await worker.call('/console/auth/start/github', { origin: null });
      assert.equal(started.status, 302);
      assert.equal(started.headers.getSetCookie().length > 0, true);
    });

    it('sends the address of the start to no provider: the redirect says no-referrer, and is not kept (FRU-207)', async () => {
      const worker = await workerOn(open);

      for (const provider of ['github', 'google']) {
        const started = await worker.call(`/console/auth/start/${provider}`, { origin: null });
        assert.equal(started.status, 302, provider);
        assert.equal(started.headers.get('Referrer-Policy'), 'no-referrer', provider);
        assert.equal(started.headers.get('Cache-Control'), 'no-store', provider);
      }
    });

    it('sends the person back to the console, whatever the address of the start asks for (FRU-207)', async () => {
      const worker = await workerOn(open);
      await worker.accounts.signIn({ provider: 'github', subject: '4242', email: 'alice@acme.dev' });
      // Every name a return address goes by, each with another site: an open redirect reads one.
      const elsewhere = 'https://evil.example/landing';
      const asked = new URLSearchParams();
      for (const name of [
        'to',
        'callbackURL',
        'callbackUrl',
        'callback',
        'errorCallbackURL',
        'newUserCallbackURL',
        'redirect',
        'redirectTo',
        'redirect_uri',
        'returnTo',
        'return_to',
        'next',
        'url',
        'continue',
      ]) {
        asked.set(name, elsewhere);
      }

      const start = await worker.call(`/console/auth/start/github?${asked}`, { origin: null });
      assert.equal(start.status, 302);
      const to = new URL(start.headers.get('Location') ?? '');
      assert.equal(`${to.origin}${to.pathname}`, 'https://github.com/login/oauth/authorize');
      // The provider is sent back to the worker, and is told of no other site.
      assert.equal(to.searchParams.get('redirect_uri'), `${PUBLIC_URL}/console/auth/callback/github`);
      assert.equal(to.href.includes('evil.example'), false, to.href);
      const stateCookie = start.headers
        .getSetCookie()
        .map((each) => each.split(';')[0])
        .join('; ');
      const state = to.searchParams.get('state');

      // The way back that works lands on the console.
      const back = await withProvider(
        {
          ...GITHUB_TOKEN,
          'https://api.github.com/user': { id: 4242, login: 'alice', name: 'Alice', email: 'alice@acme.dev' },
          'https://api.github.com/user/emails': [{ email: 'alice@acme.dev', primary: true, verified: true }],
        },
        () =>
          worker.call(`/console/auth/callback/github?code=a-code&state=${state}`, {
            origin: null,
            headers: { Cookie: stateCookie },
          }),
      );
      assert.equal(back.headers.get('Location'), `${CONSOLE_URL}/`);

      // And the way back that fails lands on the console too: the provider refused, with the same state.
      const again = await worker.call(`/console/auth/start/github?${asked}`, { origin: null });
      const refused = await worker.call(
        `/console/auth/callback/github?error=access_denied&state=${new URL(again.headers.get('Location') ?? '').searchParams.get('state')}`,
        {
          origin: null,
          headers: {
            Cookie: again.headers
              .getSetCookie()
              .map((each) => each.split(';')[0])
              .join('; '),
          },
        },
      );
      assert.equal(refused.status, 302);
      const failedAt = new URL(refused.headers.get('Location') ?? '');
      assert.equal(`${failedAt.origin}${failedAt.pathname}`, `${CONSOLE_URL}/setup`);
      assert.equal(failedAt.searchParams.get('error'), 'access_denied');
    });

    it('starts no sign-in for a navigation that a page of another site made (FRU-211)', async () => {
      const worker = await workerOn(open);
      const from = (site: string | undefined) =>
        worker.call('/console/auth/start/github', {
          origin: null,
          headers: site === undefined ? {} : { 'Sec-Fetch-Site': site },
        });

      // A link or a redirect of another site: the browser says so, and no state is made.
      const refused = await from('cross-site');
      assert.equal(refused.status, 302);
      const to = new URL(refused.headers.get('Location') ?? '');
      assert.equal(`${to.origin}${to.pathname}`, `${CONSOLE_URL}/setup`);
      assert.equal(to.searchParams.get('error'), 'started_from_another_site');
      assert.deepEqual(refused.headers.getSetCookie(), []);
      assert.equal(refused.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await rowsOf(worker.database, 'SELECT 1 FROM "verification"'), []);

      // The control: the button of the console (the same site), the address typed by hand, and a
      // browser that sends no such header all start the sign-in, as before.
      for (const site of ['same-site', 'same-origin', 'none', undefined]) {
        const started = await from(site);
        assert.equal(started.status, 302, String(site));
        assert.equal(new URL(started.headers.get('Location') ?? '').origin, 'https://github.com', String(site));
        assert.equal(started.headers.getSetCookie().length > 0, true, String(site));
      }
    });

    it('sends the console a code of better-auth when a sign-in with a provider fails (FRU-148)', async () => {
      const worker = await workerOn(open);
      // The person came back with no cookie of the state: another browser, or a link that is old.
      const back = await worker.call('/console/auth/callback/github?code=a-code&state=a-state', { origin: null });

      assert.equal(back.status, 302);
      const to = new URL(back.headers.get('Location') ?? '');
      assert.equal(`${to.origin}${to.pathname}`, `${CONSOLE_URL}/setup`);
      assert.match(to.searchParams.get('error') ?? '', /^state_/);
      assert.equal((await worker.call('/console/auth/start/linear', { origin: null })).status, 404);
    });

    it('says that a provider is not set up only when it is not, and answers 502 when better-auth rejects (FRU-148)', async () => {
      const database = await opening(open);
      await make(database);
      // GitHub only: this worker has no client of Google.
      const options = await authOptions(
        { ...AUTH_CONFIG, github: GITHUB, trackIp: false },
        await database.pool(),
        NO_SESSIONS,
      );
      const auth = await startAuth(options);
      const through = (path: string, instance: Auth) =>
        handleRequest(new Request(`${PUBLIC_URL}${path}`), envWith(), {
          clientIp: '198.51.100.201',
          accounts: createPostgresAccountStore(database),
          sessionStore: createPostgresSessionStore(database),
          kv: createMemoryKv(),
          auth: instance,
        });

      const absent = await through('/console/auth/start/google', auth);
      assert.equal(absent.headers.get('Location'), `${CONSOLE_URL}/setup?error=oauth_provider_not_found`);
      assert.equal(
        (await through('/console/auth/start/github', auth)).headers.get('Location')?.startsWith('https://github.com/'),
        true,
      );

      // A provider that is set up, and a better-auth that rejects: not « not set up », and in the log.
      const rejecting = {
        options: auth.options,
        api: { signInSocial: async () => Promise.reject(new Error('SCHEMA_MISMATCH of a test')) },
      } as unknown as Auth;
      const errors: string[] = [];
      const logged = mock.method(console, 'error', (line: string) => void errors.push(line));
      try {
        const down = await through('/console/auth/start/github', rejecting);

        assert.equal(down.status, 502);
        assert.equal(down.headers.get('Location'), null);
      } finally {
        logged.mock.restore();
      }
      assert.deepEqual(errors, ['[fruitback] better-auth did not answer: SCHEMA_MISMATCH of a test']);
    });

    it('says which ways the routes of better-auth offer, and no boolean of the path of before', async () => {
      const worker = await workerOn(open);
      const answer = await worker.call('/auth/providers');

      assert.deepEqual(await answer.json(), { betterAuth: { email: true, github: false, google: false } });
      // The routes of the path of before are gone (FRU-150).
      for (const [method, path] of [
        ['POST', '/auth/email'],
        ['POST', '/auth/email/redeem'],
        ['POST', '/console/session/refresh'],
        ['POST', '/console/session/logout'],
        ['GET', '/auth/github'],
        ['GET', '/auth/google'],
        ['GET', '/auth/github/callback'],
      ] as const) {
        const gone = await worker.call(path, method === 'POST' ? { body: {} } : {});
        assert.equal(gone.status, 404, `${method} ${path}`);
      }
    });
  });

  describe(`the address and the user agent of a session, on ${label} (FRU-147)`, { skip }, () => {
    const SPOOF = {
      'X-Forwarded-For': '203.0.113.66',
      [CLIENT_IP_HEADER]: '203.0.113.77',
      'User-Agent': 'Browser/1.0',
    };

    it('keeps neither when the switch is off, whatever the caller writes', async () => {
      const worker = await workerOn(open);
      await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      await worker.call('/console/auth/email/redeem', {
        body: { token: worker.lastToken() },
        headers: SPOOF,
        ip: '192.0.2.10',
      });

      assert.deepEqual(await rowsOf(worker.database, 'SELECT "ipAddress", "userAgent" FROM "session"'), [
        { ipAddress: null, userAgent: null },
      ]);
    });

    it('keeps the address that the worker read, and not one that the caller wrote, when it is on', async () => {
      const worker = await workerOn(open, { trackIp: true });
      await worker.call('/console/auth/email', { body: { email: 'alice@acme.dev' } });
      await worker.call('/console/auth/email/redeem', {
        body: { token: worker.lastToken() },
        headers: SPOOF,
        ip: '192.0.2.10',
      });

      assert.deepEqual(await rowsOf(worker.database, 'SELECT "ipAddress", "userAgent" FROM "session"'), [
        { ipAddress: '192.0.2.10', userAgent: 'Browser/1.0' },
      ]);
    });
  });
}

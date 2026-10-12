import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it, mock } from 'node:test';
import { createPostgresAccountStore } from './accounts-postgres.ts';
import { handleRequest } from './app.ts';
import { type Auth, CLIENT_IP_HEADER, authOptions, startAuth } from './auth.ts';
import {
  AUTH_CONFIG,
  AUTH_SECRET,
  CONSOLE_URL,
  DATABASES,
  PUBLIC_URL,
  databasesOfACase,
  make,
} from './auth.fixture.ts';
import type { WorkerEnv } from './env.ts';
import { type Kv, createMemoryKv } from './kv.ts';
import type { MailMessage, Mailer } from './mail.ts';
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

const IDENTITY_SECRET = 'an-identity-secret-of-exactly-enough-x';
const SESSION_COOKIE = '__Secure-fruitback.session_token';
const GITHUB = { clientId: 'the-second-app-of-github', clientSecret: 'a-secret-of-github-0123456789' };
const GOOGLE = { clientId: 'the-client-of-google', clientSecret: 'a-secret-of-google-0123456789' };

const { opening } = databasesOfACase();

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE_URL,
    FRUITBACK_IDENTITY_SECRET: IDENTITY_SECRET,
    // Port 1 of this machine: nothing listens there. Each case hands over its stores and its instance.
    FRUITBACK_DATABASE_URL: 'postgres://fruitback:not-a-password@127.0.0.1:1/fruitback',
    FRUITBACK_CONSOLE_URL: CONSOLE_URL,
    FRUITBACK_PUBLIC_URL: PUBLIC_URL,
    FRUITBACK_AUTH_SECRET: AUTH_SECRET,
    ...overrides,
  };
}

/** A mailer that keeps what it was asked to send. */
function inbox(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];

  return {
    sent,
    async send(message) {
      sent.push(message);
    },
  };
}

type Call = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** `null`: no `Origin` header. */
  origin?: string | null;
  ip?: string;
};

/** A worker with better-auth on, on the database of a case, and every request it was given. */
async function workerOn(open: () => Promise<PgDatabase>, more: { trackIp?: boolean } = {}) {
  const database = await opening(open);
  await make(database);
  const options = await authOptions(
    { ...AUTH_CONFIG, github: GITHUB, google: GOOGLE, trackIp: more.trackIp === true },
    await database.pool(),
  );
  const auth: Auth = await startAuth(options);
  const accounts = createPostgresAccountStore(database);
  const sessions = createPostgresSessionStore(database);
  const mail = inbox();
  const kv: Kv = createMemoryKv();
  const env = envWith(more.trackIp === true ? { FRUITBACK_AUTH_TRACK_IP: '1' } : {});
  const received: string[] = [];
  let ip = 0;

  const call = (path: string, init: Call = {}): Promise<Response> => {
    ip += 1;
    const url = path.startsWith('http') ? path : `${PUBLIC_URL}${path}`;
    received.push(url);
    const origin = init.origin === undefined ? CONSOLE_URL : init.origin;
    const headers: Record<string, string> = {
      ...(origin === null ? {} : { Origin: origin }),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    };

    return handleRequest(
      new Request(url, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      env,
      { clientIp: init.ip ?? `198.51.100.${ip % 250}`, accounts, sessionStore: sessions, mailer: mail, kv, auth },
    );
  };

  /** The token of the last link that was sent, read after the `#` of the link, as the console reads it. */
  const lastToken = (): string => {
    const text = mail.sent.at(-1)?.text ?? '';
    const link = /https:\/\/\S+/.exec(text)?.[0] ?? '';
    assert.ok(link.startsWith(`${CONSOLE_URL}/sign-in#`), `the link is not after a # of the console: ${link}`);

    return link.slice(link.indexOf('#') + 1);
  };

  /** A link asked for and spent: the cookie of the session, as the browser sends it back. */
  const signIn = async (email: string): Promise<string> => {
    assert.equal((await call('/console/auth/email', { body: { email } })).status, 202);
    const answer = await call('/console/auth/email/redeem', { body: { token: lastToken() } });
    assert.equal(answer.status, 200, await answer.clone().text());

    return cookieOf(answer);
  };

  return { database, auth, accounts, sessions, mail, kv, env, received, call, lastToken, signIn };
}

function cookieOf(answer: Response): string {
  return answer.headers
    .getSetCookie()
    .filter((each) => each.startsWith(`${SESSION_COOKIE}=`))
    .map((each) => each.split(';')[0])
    .join('; ');
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

      // One of the window is spent above. The path of before counts in the same window.
      await worker.call('/auth/email', { body: { email: 'alice@acme.dev' } });
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
      const options = await authOptions({ ...AUTH_CONFIG, github: GITHUB, trackIp: false }, await database.pool());
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

    it('says which ways the routes of better-auth offer, beside the two booleans of before', async () => {
      const worker = await workerOn(open);
      const answer = await worker.call('/auth/providers');

      assert.deepEqual(await answer.json(), {
        github: false,
        google: false,
        betterAuth: { email: true, github: false, google: false },
      });
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

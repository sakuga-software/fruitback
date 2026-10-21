import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { SERVED_PATHS, authConfigOf } from './auth.ts';
import { refusedSignUp } from './auth-routes.ts';
import { CONSOLE_URL, MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { type Call, cookieOf, envWith, workerOf } from './auth-worker.fixture.ts';
import { REQUIRED_WITH_DATABASE, readConfig } from './env.ts';
import { adminLinkFor } from './first-admin.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';
import { INVITATION_REQUIRED, type SignUp, maySignUp, readSignUp } from './sign-up.ts';

/**
 * Who may create an account (FRU-278). Each way to sign in is driven through `handleRequest`, as a
 * browser would, on PGlite and on a real server when the run has one.
 */

const { opening } = databasesOfACase();
const SECRETS_KEY = 'a-key-that-seals-the-connectors-0123456789';

type Worker = Awaited<ReturnType<typeof workerOf>>;

async function workerOn(open: () => Promise<PgDatabase>, signUp: SignUp) {
  return workerOf(await opening(open), { signUp, env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
}

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

/** A provider that answers for the length of `work`. better-auth calls it with the `fetch` of the process. */
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
  const back = await withProvider(answers(email), () =>
    worker.call(`/console/auth/callback/${provider}?code=a-code&state=${state}`, {
      origin: null,
      headers: { Cookie: stateCookie },
    }),
  );
  const location = new URL(back.headers.get('Location') ?? '', CONSOLE_URL);

  return { cookie: cookieOf(back), error: location.searchParams.get('error') };
}

/**
 * Every way to sign in, and the code of a refusal on it. A way that this table does not name fails
 * `has a case for every way to sign in that the worker serves`.
 */
const WAYS: Record<string, { signIn: (worker: Worker, email: string) => Promise<Outcome>; refused: string }> = {
  email: { signIn: byEmail, refused: 'invitation-required' },
  github: { signIn: (worker, email) => byProvider(worker, 'github', email), refused: INVITATION_REQUIRED },
  google: { signIn: (worker, email) => byProvider(worker, 'google', email), refused: INVITATION_REQUIRED },
};

async function accountsOf(worker: Worker): Promise<string[]> {
  return (await rowsOf(worker.database, 'SELECT email FROM "user" ORDER BY email')).map((row) => String(row.email));
}

/** An account that exists before the case: the instance is no longer empty. */
async function someoneAlready(worker: Worker, email = 'first@acme.dev'): Promise<void> {
  await worker.accounts.signIn({ provider: 'email', subject: email, email });
}

function as(worker: Worker, cookie: string, path: string, init: Call = {}): Promise<Response> {
  return worker.call(path, { ...init, headers: { ...init.headers, Cookie: cookie } });
}

/** The first account makes a workspace through the console, and invites `emails` there. */
async function invitedBy(worker: Worker, emails: string[]): Promise<void> {
  const owner = await byEmail(worker, 'owner@acme.dev');
  assert.equal(owner.error, null);
  const made = await as(worker, owner.cookie, '/console/workspaces', { body: { name: 'acme' } });
  assert.equal(made.status, 201, await made.clone().text());
  const workspace = ((await made.json()) as { id: string }).id;
  for (const email of emails) {
    const sent = await as(worker, owner.cookie, '/console/auth/organization/invite-member', {
      body: { email, role: 'member', organizationId: workspace },
    });
    assert.equal(sent.status, 200, await sent.clone().text());
  }
}

describe('the rule of who may create an account (FRU-278)', () => {
  it('reads invited when the variable is absent or empty, and passes any other value to the schema', () => {
    assert.equal(readSignUp(undefined), 'invited');
    assert.equal(readSignUp('  '), 'invited');
    assert.equal(readSignUp(' anyone '), 'anyone');
    assert.equal(readSignUp('Anyone'), 'Anyone');
  });

  it('refuses at boot a value that is not one of the two, with its sentence, and a value with no sign-in', () => {
    for (const value of ['Anyone', 'everyone', 'domain:acme.dev', 'true']) {
      const config = readConfig(envWith({ FRUITBACK_SIGN_UP: value }));
      assert.equal(config.ok, false, value);
      assert.deepEqual(config.ok ? [] : config.missing, ['FRUITBACK_SIGN_UP (invited, the default, or anyone)'], value);
    }
    // With no secret of the sign-in, the worker refuses for that secret, which every database needs (FRU-225).
    const alone = readConfig(envWith({ FRUITBACK_SIGN_UP: 'anyone', FRUITBACK_AUTH_SECRET: undefined }));
    assert.deepEqual(alone.ok ? [] : alone.missing, [REQUIRED_WITH_DATABASE.FRUITBACK_AUTH_SECRET]);
    // The controls: each of the two values starts, and so does no value at all.
    for (const value of ['invited', 'anyone', undefined, '']) {
      const config = readConfig(envWith({ FRUITBACK_SIGN_UP: value }));
      assert.ok(config.ok, `${value}: ${config.ok ? '' : config.missing.join(', ')}`);
      assert.equal(config.config.signUp, value || 'invited');
    }
  });

  it('accepts a new address only for anyone, the first account, an invitation, or the link of the operator', () => {
    const none = { firstAccount: false, invited: false, byOperator: false };
    assert.equal(maySignUp('invited', none), false);
    assert.equal(maySignUp('anyone', none), true);
    for (const fact of ['firstAccount', 'invited', 'byOperator'] as const) {
      assert.equal(maySignUp('invited', { ...none, [fact]: true }), true, fact);
    }
  });
});

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`who may create an account, on ${label} (FRU-278)`, { skip }, () => {
    it('has a case for every way to sign in that the worker serves', async () => {
      const worker = await workerOn(open, 'invited');
      const providers = Object.keys((worker.auth.options.socialProviders ?? {}) as Record<string, unknown>);
      const callbacks = Object.keys(SERVED_PATHS)
        .filter((path) => path.startsWith('/callback/'))
        .map((path) => path.slice('/callback/'.length));
      // A provider that a later change adds to the options or to the routes has no case here: it fails.
      assert.deepEqual([...providers].sort(), [...callbacks].sort());
      assert.deepEqual(Object.keys(WAYS).sort(), ['email', ...providers].sort());
    });

    it('refuses to create the account of a person nobody invited, on an instance with no variable', async () => {
      // The value of a worker whose environment does not name it.
      const config = readConfig(envWith());
      assert.ok(config.ok);
      const signUp = authConfigOf(config.config)?.signUp;
      assert.equal(signUp, 'invited');

      for (const [way, { signIn, refused }] of Object.entries(WAYS)) {
        const worker = await workerOn(open, signUp ?? 'anyone');
        await someoneAlready(worker);

        const stranger = await signIn(worker, `stranger-${way}@elsewhere.dev`);
        assert.equal(stranger.error, refused, way);
        assert.equal(stranger.cookie, '', way);
        assert.deepEqual(await accountsOf(worker), ['first@acme.dev'], way);
      }
    });

    it('signs in a person who has an account, as before, by every way', async () => {
      for (const [way, { signIn }] of Object.entries(WAYS)) {
        const worker = await workerOn(open, 'invited');
        await someoneAlready(worker);
        await someoneAlready(worker, 'alice@acme.dev');

        const alice = await signIn(worker, 'alice@acme.dev');
        assert.equal(alice.error, null, way);
        assert.equal((await as(worker, alice.cookie, '/console/me')).status, 200, way);
        assert.deepEqual(await accountsOf(worker), ['alice@acme.dev', 'first@acme.dev'], way);
      }
    });

    it('creates the first account of an instance that has none, by every way', async () => {
      for (const [way, { signIn }] of Object.entries(WAYS)) {
        const worker = await workerOn(open, 'invited');

        const first = await signIn(worker, 'first@acme.dev');
        assert.equal(first.error, null, way);
        assert.equal((await as(worker, first.cookie, '/console/me')).status, 200, way);
        // The control: the second one is refused.
        assert.equal((await signIn(worker, 'second@acme.dev')).error, WAYS[way]?.refused, way);
        assert.deepEqual(await accountsOf(worker), ['first@acme.dev'], way);
      }
    });

    it('creates the account of an address that a workspace invited, by every way', async () => {
      const worker = await workerOn(open, 'invited');
      const ways = Object.entries(WAYS);
      await invitedBy(
        worker,
        ways.map(([way]) => `Invited-${way}@Client.dev`),
      );

      for (const [way, { signIn }] of ways) {
        const guest = await signIn(worker, `invited-${way}@client.dev`);
        assert.equal(guest.error, null, way);
        assert.equal((await as(worker, guest.cookie, '/console/me')).status, 200, way);
      }
      assert.deepEqual(await accountsOf(worker), [
        ...ways.map(([way]) => `invited-${way}@client.dev`).sort(),
        'owner@acme.dev',
      ]);
    });

    it('creates the account of an invited address that a provider gives with capitals', async () => {
      const worker = await workerOn(open, 'invited');
      await invitedBy(worker, ['guest-github@client.dev', 'guest-google@client.dev']);

      for (const provider of ['github', 'google']) {
        const guest = await byProvider(worker, provider, `Guest-${provider.toUpperCase()}@Client.dev`);
        assert.equal(guest.error, null, provider);
      }
    });

    it('refuses an address whose invitation ended, or was cancelled', async () => {
      const worker = await workerOn(open, 'invited');
      await invitedBy(worker, ['late@client.dev', 'cancelled@client.dev', 'waiting@client.dev']);
      await rowsOf(
        worker.database,
        `UPDATE invitation SET "expiresAt" = now() - interval '1 minute' WHERE email = 'late@client.dev'`,
      );
      await rowsOf(worker.database, `UPDATE invitation SET status = 'canceled' WHERE email = 'cancelled@client.dev'`);

      assert.equal((await byEmail(worker, 'late@client.dev')).error, 'invitation-required');
      assert.equal((await byEmail(worker, 'cancelled@client.dev')).error, 'invitation-required');
      // The control: the invitation that waits still opens.
      assert.equal((await byEmail(worker, 'waiting@client.dev')).error, null);
      assert.deepEqual(await accountsOf(worker), ['owner@acme.dev', 'waiting@client.dev']);
    });

    it('creates the account of the first administrator by the link of the operator, though other accounts exist', async () => {
      const worker = await workerOn(open, 'invited');
      // An account with no workspace: the instance has no owner, and it is not empty.
      await someoneAlready(worker, 'stray@acme.dev');
      // The control: the same address, by a link of the e-mail, is refused.
      assert.equal((await byEmail(worker, 'admin@acme.dev')).error, 'invitation-required');

      const made = await adminLinkFor(
        { auth: worker.auth, kv: worker.kv, owners: () => worker.accounts.owners(), consoleUrl: CONSOLE_URL },
        'admin@acme.dev',
      );
      assert.ok(made.ok, made.lines.join('\n'));
      const link = made.lines.find((line) => line.includes('/sign-in#'))?.trim() ?? '';
      const answer = await worker.call('/console/auth/email/redeem', {
        body: { token: link.slice(link.indexOf('#') + 1) },
      });

      assert.equal(answer.status, 200, await answer.clone().text());
      assert.deepEqual(await accountsOf(worker), ['admin@acme.dev', 'stray@acme.dev']);
    });

    it('gives back the behaviour of before with anyone: every way creates the account', async () => {
      for (const [way, { signIn }] of Object.entries(WAYS)) {
        const worker = await workerOn(open, 'anyone');
        await someoneAlready(worker);

        const stranger = await signIn(worker, `stranger-${way}@elsewhere.dev`);
        assert.equal(stranger.error, null, way);
        assert.equal((await as(worker, stranger.cookie, '/console/me')).status, 200, way);
      }
    });
  });
}

/** The places of a source file that write a row of `user`, or ask better-auth to. */
function writesOfUser(source: string): string[] {
  const patterns = [
    /\.insert\(\s*user\s*\)/g,
    /INSERT\s+INTO\s+"?user"?\b/gi,
    /\bcreate(?:OAuth)?User\s*\(/g,
    /\.signIn\(/g,
  ];

  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[0]));
}

describe('the refusal of a sign-in by a link (FRU-278)', () => {
  it('reads the code in the redirect of better-auth, and in an answer in JSON', async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: `/setup?error=${INVITATION_REQUIRED}` } });
    assert.equal(await refusedSignUp(redirect), true);
    assert.equal(await refusedSignUp(Response.json({ code: INVITATION_REQUIRED }, { status: 403 })), true);
    // The controls: a link that is spent is not a refusal of the rule.
    const spent = new Response(null, { status: 302, headers: { Location: '/setup?error=INVALID_TOKEN' } });
    assert.equal(await refusedSignUp(spent), false);
    assert.equal(await refusedSignUp(Response.json({ code: 'INVALID_TOKEN' }, { status: 401 })), false);
    assert.equal(await refusedSignUp(new Response('not json', { status: 500 })), false);
  });
});

describe('the places that create an account (FRU-278)', () => {
  /** Each file of the worker that may write a row of `user` outside better-auth, with its reason. */
  const ALLOWED: Record<string, string> = {
    'accounts-postgres.ts':
      '`signIn` of the store: no route calls it, only the seed of the worker of development, and the tests',
  };

  it('writes a row of user only through better-auth, whose hook decides', () => {
    const directory = new URL('./', import.meta.url);
    const sources = readdirSync(directory).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.fixture.ts'),
    );
    assert.ok(sources.length > 50, 'the guard reads no file');
    const found = sources
      .filter((name) => !Object.hasOwn(ALLOWED, name))
      .flatMap((name) =>
        writesOfUser(readFileSync(new URL(name, directory), 'utf8')).map((what) => `${name}: ${what}`),
      );

    assert.deepEqual(found, []);
    // The allowed file still writes one: otherwise its entry is stale, and says nothing.
    assert.ok(writesOfUser(readFileSync(new URL('accounts-postgres.ts', directory), 'utf8')).length > 0);
  });

  it('finds each way of writing a row of user in a planted source', () => {
    for (const planted of [
      'await tx.insert(user).values({ id })',
      'await client.query(`INSERT INTO "user" (id) VALUES ($1)`)',
      'await ctx.context.internalAdapter.createUser({ email })',
      'await internalAdapter.createOAuthUser(user, account)',
      'await accounts.signIn({ provider, subject, email })',
    ]) {
      assert.equal(writesOfUser(planted).length, 1, planted);
    }
    assert.deepEqual(writesOfUser('await auth.api.signInSocial({ body })'), []);
  });
});

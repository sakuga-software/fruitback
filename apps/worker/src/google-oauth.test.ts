import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { type Kv, createMemoryKv } from './kv.ts';
import { closeSessionConnections } from './session-sqlite.ts';

const SECRET = 'a-worker-secret-of-exactly-enough';
const CONSOLE = 'https://app.fruitback.test';
const API = 'https://api.fruitback.test';
const directories: string[] = [];

afterEach(() => {
  closeAccountConnections();
  closeSessionConnections();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function envWith(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-google-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_CONSOLE_URL: CONSOLE,
    FRUITBACK_PUBLIC_URL: API,
    FRUITBACK_GOOGLE_OAUTH: 'client-1.apps.googleusercontent.com:GOCSPX-the-client-secret',
    ...overrides,
  };
}

type Profile = { sub?: string; email?: string; email_verified?: unknown; name?: string };

/** A double of Google that checks what a real one checks: the secret, the verifier, the redirect. */
function google(options: { profile?: Profile; down?: boolean } = {}) {
  const challenges = new Map<string, string>();
  const calls: string[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    calls.push(String(input));
    if (options.down === true) throw new TypeError('fetch failed');
    if (input === 'https://oauth2.googleapis.com/token') {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      const challenge = createHash('sha256')
        .update(body.code_verifier ?? '')
        .digest('base64url');
      const valid =
        (init?.headers as Record<string, string>)['Content-Type'] === 'application/x-www-form-urlencoded' &&
        body.grant_type === 'authorization_code' &&
        body.client_id === 'client-1.apps.googleusercontent.com' &&
        body.client_secret === 'GOCSPX-the-client-secret' &&
        body.redirect_uri === `${API}/auth/google/callback` &&
        challenges.get(body.code ?? '') === challenge;

      return valid
        ? Response.json({ access_token: 'ya29.token', id_token: 'not-read', expires_in: 3599 })
        : Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    if (input === 'https://openidconnect.googleapis.com/v1/userinfo') {
      if ((init?.headers as Record<string, string>).Authorization !== 'Bearer ya29.token') {
        return new Response('{}', { status: 401 });
      }

      return Response.json(
        options.profile ?? { sub: '1098765', email: 'Alice@Acme.dev', email_verified: true, name: 'Alice' },
      );
    }

    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  return { fetcher, calls, challenges };
}

let ip = 0;
function get(env: WorkerEnv, path: string, context: Partial<RequestContext>, cookie?: string): Promise<Response> {
  ip += 1;

  return handleRequest(
    new Request(`${API}${path}`, { headers: { Origin: CONSOLE, ...(cookie === undefined ? {} : { Cookie: cookie }) } }),
    env,
    { clientIp: `192.0.2.${ip % 250}`, ...context },
  );
}

/** Leaves for Google, and comes back with a code Google would hand out for that challenge. */
async function roundTrip(env: WorkerEnv, double: ReturnType<typeof google>, kv: Kv) {
  const left = await get(env, '/auth/google', { kv, fetcher: double.fetcher });
  const location = new URL(left.headers.get('Location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  double.challenges.set('the-code', location.searchParams.get('code_challenge') ?? '');
  const stateCookie = left.headers.getSetCookie()[0]?.split(';')[0] ?? '';

  return { left, location, state, stateCookie };
}

const accountsOf = (env: WorkerEnv) => createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);

describe('signing in with Google (FRU-135)', () => {
  it('sends the person to Google with a state, a PKCE challenge and the identity scopes only', async () => {
    const { left, location, state } = await roundTrip(envWith(), google(), createMemoryKv());

    assert.equal(left.status, 302);
    assert.equal(location.origin + location.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.deepEqual(Object.fromEntries(location.searchParams), {
      client_id: 'client-1.apps.googleusercontent.com',
      redirect_uri: `${API}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
      code_challenge: location.searchParams.get('code_challenge'),
      code_challenge_method: 'S256',
    });
    assert.match(
      left.headers.getSetCookie()[0] ?? '',
      /Path=\/auth\/google\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  it('signs in the address Google verified, and hands the console its session cookie', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = google();
    const { state, stateCookie } = await roundTrip(env, double, kv);

    const back = await get(
      env,
      `/auth/google/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      stateCookie,
    );

    assert.equal(back.status, 302);
    assert.equal(back.headers.get('Location'), `${CONSOLE}/`);
    assert.ok(back.headers.getSetCookie().some((cookie) => cookie.startsWith('fruitback_console=')));
    const account = await accountsOf(env).signIn({ provider: 'google', subject: '1098765', email: 'alice@acme.dev' });
    assert.equal(account.email, 'alice@acme.dev');
    assert.equal(account.name, 'Alice');
  });

  it('is the same account as the one a link or GitHub proved for that address', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = google();
    const known = await accountsOf(env).signIn({
      provider: 'email',
      subject: 'alice@acme.dev',
      email: 'alice@acme.dev',
    });
    const { state, stateCookie } = await roundTrip(env, double, kv);
    await get(env, `/auth/google/callback?code=the-code&state=${state}`, { kv, fetcher: double.fetcher }, stateCookie);

    const again = await accountsOf(env).signIn({ provider: 'google', subject: '1098765', email: 'alice@acme.dev' });
    assert.equal(again.id, known.id);
  });

  it('makes no account for an address Google did not verify', async () => {
    for (const profile of [
      { sub: '1', email: 'mallory@acme.dev', email_verified: false },
      { sub: '1', email: 'mallory@acme.dev', email_verified: 'true' },
      { sub: '1', email: 'mallory@acme.dev' },
      { sub: '1', email_verified: true },
    ] as Profile[]) {
      const env = envWith();
      const kv = createMemoryKv();
      const double = google({ profile });
      const { state, stateCookie } = await roundTrip(env, double, kv);

      const back = await get(
        env,
        `/auth/google/callback?code=the-code&state=${state}`,
        { kv, fetcher: double.fetcher },
        stateCookie,
      );

      assert.equal(back.headers.get('Location'), `${CONSOLE}/setup?error=google-unverified`, JSON.stringify(profile));
      assert.equal(
        back.headers.getSetCookie().some((cookie) => cookie.startsWith('fruitback_console=')),
        false,
      );
      assert.equal(await accountsOf(env).localeOf('mallory@acme.dev'), undefined);
      closeAccountConnections();
    }
  });

  it('refuses a callback from a browser that did not start, a state used twice and a code Google did not give', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = google();
    const { state, stateCookie } = await roundTrip(env, double, kv);
    const path = `/auth/google/callback?code=the-code&state=${state}`;
    const failed = `${CONSOLE}/setup?error=google-failed`;

    assert.equal((await get(env, path, { kv, fetcher: double.fetcher })).headers.get('Location'), failed, 'no cookie');
    assert.equal(double.calls.length, 0, 'the code was not spent for them');
    assert.match(
      (await get(env, path, { kv, fetcher: double.fetcher }, stateCookie)).headers.get('Location') ?? '',
      /\/$/,
    );
    assert.equal(
      (await get(env, path, { kv, fetcher: double.fetcher }, stateCookie)).headers.get('Location'),
      failed,
      'twice',
    );

    const other = await roundTrip(env, double, kv);
    const wrong = await get(
      env,
      `/auth/google/callback?code=never-given&state=${other.state}`,
      { kv, fetcher: double.fetcher },
      other.stateCookie,
    );
    assert.equal(wrong.headers.get('Location'), failed);
  });

  it("does not finish with a state that GitHub's flow issued", async () => {
    const env = envWith({ FRUITBACK_GITHUB_OAUTH: 'gh-client:gh-secret' });
    const kv = createMemoryKv();
    const double = google();
    const viaGitHub = await get(env, '/auth/github', { kv, fetcher: double.fetcher });
    const state = new URL(viaGitHub.headers.get('Location') ?? '').searchParams.get('state') ?? '';
    double.challenges.set(
      'the-code',
      new URL(viaGitHub.headers.get('Location') ?? '').searchParams.get('code_challenge') ?? '',
    );

    const back = await get(
      env,
      `/auth/google/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      `fruitback_oauth_state=${state}`,
    );

    assert.equal(back.headers.get('Location'), `${CONSOLE}/setup?error=google-failed`);
  });

  it('says so when the person refuses at Google, and when Google does not answer', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const refused = await roundTrip(env, google(), kv);
    const no = await get(
      env,
      `/auth/google/callback?error=access_denied&state=${refused.state}`,
      { kv },
      refused.stateCookie,
    );
    assert.equal(no.headers.get('Location'), `${CONSOLE}/setup?error=google-declined`);

    const down = google({ down: true });
    const left = await roundTrip(env, google(), kv);
    const back = await get(
      env,
      `/auth/google/callback?code=the-code&state=${left.state}`,
      { kv, fetcher: down.fetcher },
      left.stateCookie,
    );
    assert.equal(back.headers.get('Location'), `${CONSOLE}/setup?error=google-failed`);
  });
});

describe('which providers a worker signs people in with (FRU-135)', () => {
  it('answers a boolean for each, to the console, and no client id', async () => {
    const both = await get(envWith({ FRUITBACK_GITHUB_OAUTH: 'gh-client:gh-secret' }), '/auth/providers', {});
    assert.deepEqual([both.status, await both.json()], [200, { github: true, google: true }]);
    assert.equal(both.headers.get('Access-Control-Allow-Origin'), CONSOLE);

    const one = await get(envWith(), '/auth/providers', {});
    assert.deepEqual(await one.json(), { github: false, google: true });
    const none = await get(
      envWith({ FRUITBACK_GOOGLE_OAUTH: undefined, FRUITBACK_PUBLIC_URL: undefined }),
      '/auth/providers',
      {},
    );
    assert.deepEqual(await none.json(), { github: false, google: false });
    assert.equal((await get(envWith({ FRUITBACK_GOOGLE_OAUTH: undefined }), '/auth/google', {})).status, 404);
  });

  it('needs a client id with its secret, the public address and the accounts', () => {
    assert.equal(readConfig(envWith()).ok, true);
    assert.equal(readConfig(envWith({ FRUITBACK_GOOGLE_OAUTH: 'nocolon' })).ok, false);
    assert.equal(readConfig(envWith({ FRUITBACK_PUBLIC_URL: undefined })).ok, false);
    assert.equal(
      readConfig(envWith({ FRUITBACK_ACCOUNTS_PATH: undefined, FRUITBACK_SESSION_PATH: undefined })).ok,
      false,
    );
  });
});

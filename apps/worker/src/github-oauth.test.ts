import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAccountConnections, createSqliteAccountStore } from './accounts-sqlite.ts';
import { type WorkerEnv, readConfig } from './env.ts';
import { closeSessionConnections } from './session-sqlite.ts';
import { type RequestContext, handleRequest } from './app.ts';
import { type Kv, createMemoryKv } from './kv.ts';
import { parseGitHubOAuth } from './github-oauth.ts';

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
  const directory = mkdtempSync(join(tmpdir(), 'fruitback-github-'));
  directories.push(directory);

  return {
    FRUITBACK_STORE: 'memory',
    ALLOWED_ORIGINS: CONSOLE,
    FRUITBACK_IDENTITY_SECRET: SECRET,
    FRUITBACK_SESSION_PATH: join(directory, 'sessions.db'),
    FRUITBACK_ACCOUNTS_PATH: join(directory, 'accounts.db'),
    FRUITBACK_CONSOLE_URL: CONSOLE,
    FRUITBACK_PUBLIC_URL: API,
    FRUITBACK_GITHUB_OAUTH: 'client-1:the-client-secret',
    ...overrides,
  };
}

type Emails = { email: string; primary: boolean; verified: boolean }[];

/** A double of GitHub that checks what a real one checks: the secret, the verifier, the redirect. */
function github(options: { emails?: Emails; id?: number; name?: string; down?: boolean } = {}) {
  const challenges = new Map<string, string>();
  const calls: string[] = [];
  const fetcher = (async (input: string, init?: RequestInit) => {
    calls.push(String(input));
    if (options.down === true) throw new TypeError('fetch failed');
    if (input === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      const challenge = createHash('sha256')
        .update(body.code_verifier ?? '')
        .digest('base64url');
      const valid =
        body.client_id === 'client-1' &&
        body.client_secret === 'the-client-secret' &&
        body.redirect_uri === `${API}/auth/github/callback` &&
        challenges.get(body.code ?? '') === challenge;

      return Response.json(valid ? { access_token: 'gho_token' } : { error: 'bad_verification_code' });
    }
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (auth !== 'Bearer gho_token') return new Response('{}', { status: 401 });
    if (input === 'https://api.github.com/user')
      return Response.json({ id: options.id ?? 4242, login: 'alice', name: options.name ?? 'Alice' });
    if (input === 'https://api.github.com/user/emails') {
      return Response.json(options.emails ?? [{ email: 'Alice@Acme.dev', primary: true, verified: true }]);
    }

    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  return { fetcher, calls, challenges };
}

let ip = 0;
function get(env: WorkerEnv, path: string, context: Partial<RequestContext>, cookie?: string): Promise<Response> {
  ip += 1;

  return handleRequest(new Request(`${API}${path}`, { headers: cookie === undefined ? {} : { Cookie: cookie } }), env, {
    clientIp: `192.0.2.${ip % 250}`,
    ...context,
  });
}

function cookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

/** Leaves for GitHub, and comes back with a code GitHub would hand out for that challenge. */
async function roundTrip(env: WorkerEnv, double: ReturnType<typeof github>, kv: Kv) {
  const left = await get(env, '/auth/github', { kv, fetcher: double.fetcher });
  const location = new URL(left.headers.get('Location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  double.challenges.set('the-code', location.searchParams.get('code_challenge') ?? '');
  const stateCookie = cookies(left)[0]?.split(';')[0] ?? '';

  return { left, location, state, stateCookie };
}

describe('signing in with GitHub (FRU-97)', () => {
  it('sends the person to GitHub with a state, a PKCE challenge and the identity scopes only', async () => {
    const kv = createMemoryKv();
    const { left, location } = await roundTrip(envWith(), github(), kv);

    assert.equal(left.status, 302);
    assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(location.searchParams.get('client_id'), 'client-1');
    assert.equal(location.searchParams.get('redirect_uri'), `${API}/auth/github/callback`);
    assert.equal(location.searchParams.get('scope'), 'read:user user:email');
    assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(location.searchParams.get('client_secret'), null, 'the secret never leaves the worker');
    const cookie = cookies(left)[0] ?? '';
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/auth/github/callback']) {
      assert.ok(cookie.includes(attribute), `${attribute} in ${cookie}`);
    }
  });

  it('comes back signed in, to the account of the verified primary address', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = github();
    const { state, stateCookie } = await roundTrip(env, double, kv);

    const back = await get(
      env,
      `/auth/github/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      stateCookie,
    );

    assert.equal(back.status, 302);
    assert.equal(back.headers.get('Location'), `${CONSOLE}/`);
    const session = cookies(back).find((each) => each.startsWith('fruitback_console='));
    assert.ok(session !== undefined && session.includes('HttpOnly'));
    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    const again = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    assert.equal(again.name, 'Alice', 'the e-mail link joins the account GitHub made, by its address');

    const refreshed = await handleRequest(
      new Request(`${API}/console/session/refresh`, {
        method: 'POST',
        headers: { Cookie: session.split(';')[0] as string },
      }),
      env,
      { clientIp: '192.0.2.251', kv: createMemoryKv() },
    );
    assert.equal(refreshed.status, 200, 'the cookie opens the console session');
  });

  it('refuses a state the browser did not leave with, and asks GitHub nothing', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = github();
    const { state } = await roundTrip(env, double, kv);
    double.calls.length = 0;

    const forged = await get(
      env,
      `/auth/github/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      'fruitback_oauth_state=other',
    );

    assert.equal(forged.headers.get('Location'), `${CONSOLE}/setup?error=github-failed`);
    assert.equal(
      cookies(forged).some((each) => each.startsWith('fruitback_console=') && !each.includes('Max-Age=0')),
      false,
    );
    assert.deepEqual(double.calls, []);
  });

  it('refuses a state this worker never issued, and one already spent', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = github();

    const never = await get(
      env,
      '/auth/github/callback?code=the-code&state=made-up',
      { kv, fetcher: double.fetcher },
      'fruitback_oauth_state=made-up',
    );
    assert.equal(never.headers.get('Location'), `${CONSOLE}/setup?error=github-failed`);

    const { state, stateCookie } = await roundTrip(env, double, kv);
    const first = await get(
      env,
      `/auth/github/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      stateCookie,
    );
    assert.equal(first.headers.get('Location'), `${CONSOLE}/`);
    const replay = await get(
      env,
      `/auth/github/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      stateCookie,
    );
    assert.equal(replay.headers.get('Location'), `${CONSOLE}/setup?error=github-failed`);
  });

  it('creates no account for an address GitHub has not verified', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const double = github({ emails: [{ email: 'alice@acme.dev', primary: true, verified: false }] });
    const { state, stateCookie } = await roundTrip(env, double, kv);

    const back = await get(
      env,
      `/auth/github/callback?code=the-code&state=${state}`,
      { kv, fetcher: double.fetcher },
      stateCookie,
    );

    assert.equal(back.headers.get('Location'), `${CONSOLE}/setup?error=github-unverified`);
    const accounts = createSqliteAccountStore(env.FRUITBACK_ACCOUNTS_PATH as string);
    const later = await accounts.signIn({ provider: 'email', subject: 'alice@acme.dev', email: 'alice@acme.dev' });
    assert.equal(later.name, undefined, 'the control: nothing of GitHub joined that address');
  });

  it('says so when the person declined at GitHub', async () => {
    const back = await get(envWith(), '/auth/github/callback?error=access_denied&state=x', { kv: createMemoryKv() });

    assert.equal(back.headers.get('Location'), `${CONSOLE}/setup?error=github-declined`);
  });

  it('fails cleanly when GitHub does not answer', async () => {
    const env = envWith();
    const kv = createMemoryKv();
    const up = github();
    const { state, stateCookie } = await roundTrip(env, up, kv);

    const back = await get(
      env,
      `/auth/github/callback?code=the-code&state=${state}`,
      { kv, fetcher: github({ down: true }).fetcher },
      stateCookie,
    );

    assert.equal(back.headers.get('Location'), `${CONSOLE}/setup?error=github-failed`);
  });

  it('does not exist without an OAuth App', async () => {
    const env = envWith({ FRUITBACK_GITHUB_OAUTH: undefined });

    assert.equal((await get(env, '/auth/github', { kv: createMemoryKv() })).status, 404);
  });
});

describe('the configuration of GitHub sign-in', () => {
  it('reads the client id and the secret, and refuses a value with no colon', () => {
    assert.deepEqual(parseGitHubOAuth('id:secret'), { clientId: 'id', clientSecret: 'secret' });
    assert.equal(parseGitHubOAuth('nocolon'), undefined);
    assert.equal(readConfig(envWith({ FRUITBACK_GITHUB_OAUTH: 'nocolon' })).ok, false);
  });

  it('needs the public address GitHub sends the person back to', () => {
    const result = readConfig(envWith({ FRUITBACK_PUBLIC_URL: undefined }));

    assert.ok(result.ok === false && result.missing.some((name) => name.includes('FRUITBACK_PUBLIC_URL')));
  });
});

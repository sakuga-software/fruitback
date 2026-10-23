import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import { handleRequest } from './app.ts';
import { CONSOLE_URL, MIGRATED_DATABASES, PUBLIC_URL, databasesOfACase } from './auth.fixture.ts';
import { GOOGLE, cookieOf, workerOf } from './auth-worker.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The ways a person signs in, from « My account » (FRU-249): which providers are linked, linking one
 * by a navigation, and unlinking one while another way stays.
 */

const { opening } = databasesOfACase();

type Worker = Awaited<ReturnType<typeof workerOf>>;
type Call = Parameters<Worker['call']>[1];

/**
 * A provider that answers as GitHub or Google would, for the length of `work`. better-auth calls them
 * with the `fetch` of the process.
 */
async function withProvider<T>(answers: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  const fetched = mockMethod(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = answers[`${url.origin}${url.pathname}`];
    if (body === undefined) throw new Error(`a test called ${url.origin}${url.pathname}`);

    return Response.json(body);
  });
  try {
    return await work();
  } finally {
    fetched.mockRestore();
  }
}

/** GitHub, for a person with this address, verified or not, under this id. */
function github(email: string, { id = 4242, verified = true } = {}): Record<string, unknown> {
  return {
    'https://github.com/login/oauth/access_token': {
      access_token: 'gho_an-access-token',
      token_type: 'bearer',
      scope: 'read:user,user:email',
    },
    'https://api.github.com/user': { id, login: 'alice-gh', name: 'Alice of GitHub', email },
    'https://api.github.com/user/emails': [{ email, primary: true, verified }],
  };
}

/** The worker of `worker`, on the same database and better-auth, with no mailer: it sends no link. */
function withoutMail(worker: Worker): (path: string, init?: Call) => Promise<Response> {
  return (path, init = {}) => {
    const origin = init.origin === undefined ? CONSOLE_URL : init.origin;

    return handleRequest(
      new Request(`${PUBLIC_URL}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          ...(origin === null ? {} : { Origin: origin }),
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
      worker.env,
      {
        clientIp: '198.51.100.77',
        accounts: worker.accounts,
        sessionStore: worker.sessions,
        mailer: undefined,
        kv: worker.kv,
        auth: worker.auth,
      },
    );
  };
}

/**
 * A link of a provider, from « My account »: the navigation to the worker, then the way back from the
 * provider. The location the person lands on, and the answer of each half.
 */
async function linkThrough(
  worker: Worker,
  cookie: string,
  provider: 'github' | 'google',
  answers: Record<string, unknown>,
  workspace = 'ws_0123456789abcdef0123',
) {
  const start = await worker.call(`/console/auth/link/${provider}?workspace=${workspace}`, {
    origin: null,
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
  });
  assert.equal(start.status, 302, await start.clone().text());
  const to = new URL(start.headers.get('Location') ?? '');
  const state = to.searchParams.get('state') ?? '';
  assert.ok(state.length > 0, `no state in ${to.href}`);
  const stateCookie = start.headers
    .getSetCookie()
    .map((each) => each.split(';')[0])
    .join('; ');
  const back = await withProvider(answers, () =>
    worker.call(`/console/auth/callback/${provider}?code=a-code&state=${state}`, {
      origin: null,
      headers: { Cookie: `${cookie}; ${stateCookie}` },
    }),
  );

  return { start, to, back, location: back.headers.get('Location') ?? '' };
}

async function providersOf(database: PgDatabase, user: string): Promise<string[]> {
  return (
    await rowsOf(database, `SELECT "providerId" FROM "account" WHERE "userId" = '${user}' ORDER BY "providerId"`)
  ).map((row) => String(row.providerId));
}

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the ways a person signs in, on ${label} (FRU-249)`, { skip: skip !== false }, () => {
    async function signedIn(email = 'alice@acme.dev') {
      const worker = await workerOf(await opening(open));
      const cookie = await worker.signIn(email);
      const me = (await (await worker.call('/console/me', { headers: { Cookie: cookie } })).json()) as {
        account: { id: string };
      };

      return { worker, cookie, id: me.account.id };
    }

    it('says that the link of the e-mail signs in, and which provider is linked', async () => {
      const { worker, cookie } = await signedIn();

      const listed = await worker.call('/console/me/sign-in', { headers: { Cookie: cookie } });
      assert.equal(listed.status, 200);
      assert.deepEqual(await listed.json(), { email: true, github: { linked: false }, google: { linked: false } });

      await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));
      const after = await worker.call('/console/me/sign-in', { headers: { Cookie: cookie } });
      assert.deepEqual(await after.json(), { email: true, github: { linked: true }, google: { linked: false } });

      // A worker that sends no link says so.
      const quiet = await withoutMail(worker)('/console/me/sign-in', { headers: { Cookie: cookie } });
      assert.deepEqual(await quiet.json(), { email: false, github: { linked: true }, google: { linked: false } });
    });

    it('answers the list to the person of the cookie only', async () => {
      const { worker, cookie } = await signedIn();

      assert.equal((await worker.call('/console/me/sign-in')).status, 401);
      assert.equal((await worker.call('/console/me/sign-in', { body: {}, headers: { Cookie: cookie } })).status, 405);
      assert.equal(
        (await worker.call('/console/me/sign-in', { headers: { Authorization: 'Bearer a.b.c' } })).status,
        401,
      );
    });

    it('links GitHub for the same verified address, keeps no token, and goes back to « My account »', async () => {
      const { worker, cookie, id } = await signedIn();

      const { to, location } = await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));

      assert.equal(to.origin, 'https://github.com');
      assert.equal(location, `${CONSOLE_URL}/w/ws_0123456789abcdef0123/account?linked=github`);
      assert.deepEqual(await providersOf(worker.database, id), ['github']);
      const [row] = await rowsOf(
        worker.database,
        `SELECT "accessToken", "refreshToken", "idToken", password FROM "account" WHERE "userId" = '${id}'`,
      );
      assert.deepEqual(row, { accessToken: null, refreshToken: null, idToken: null, password: null });
      // One account still: the link joined nothing.
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM "user"')).length, 1);
    });

    it('refuses a provider whose address is another one, or is not verified, and joins no account', async () => {
      const { worker, cookie, id } = await signedIn();
      const bob = await worker.signIn('bob@acme.dev');

      // The console names the provider and says what to do from these two words (FRU-416). better-auth
      // 1.7.7 answers an address the provider did not verify with `unable_to_link_account`.
      for (const [answers, code, why] of [
        [github('alice@other.dev'), 'email_does_not_match', 'another address'],
        [github('alice@acme.dev', { verified: false }), 'unable_to_link_account', 'an address GitHub did not verify'],
      ] as const) {
        const { location } = await linkThrough(worker, cookie, 'github', answers);
        const back = new URL(location);
        assert.equal(`${back.origin}${back.pathname}`, `${CONSOLE_URL}/w/ws_0123456789abcdef0123/account`, why);
        assert.equal(back.searchParams.get('error'), code, `${why}: ${location}`);
        assert.equal(back.searchParams.get('provider'), 'github', `${why}: ${location}`);
        assert.deepEqual(await providersOf(worker.database, id), [], why);
      }
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM "user"')).length, 2);

      // A GitHub account that is Bob's already is not Alice's too.
      const bobs = (await (await worker.call('/console/me', { headers: { Cookie: bob } })).json()) as {
        account: { id: string };
      };
      await linkThrough(worker, bob, 'github', github('bob@acme.dev', { id: 7 }));
      const { location } = await linkThrough(worker, cookie, 'github', github('alice@acme.dev', { id: 7 }));
      assert.equal(new URL(location).searchParams.get('error'), 'account_already_linked_to_different_user', location);
      assert.equal(new URL(location).searchParams.get('provider'), 'github', location);
      assert.deepEqual(await providersOf(worker.database, id), []);
      assert.deepEqual(await providersOf(worker.database, bobs.account.id), ['github']);
    });

    it('starts no link for a page of another site, with no session, or for a provider it does not have', async () => {
      const { worker, cookie } = await signedIn();
      const page = `${CONSOLE_URL}/w/ws_0123456789abcdef0123/account`;
      const start = (path: string, headers: Record<string, string>) => worker.call(path, { origin: null, headers });

      const crossSite = await start('/console/auth/link/github?workspace=ws_0123456789abcdef0123', {
        Cookie: cookie,
        'Sec-Fetch-Site': 'cross-site',
      });
      assert.equal(crossSite.headers.get('Location'), `${page}?provider=github&error=started_from_another_site`);
      assert.deepEqual(crossSite.headers.getSetCookie(), []);

      const nobody = await start('/console/auth/link/github?workspace=ws_0123456789abcdef0123', {
        'Sec-Fetch-Site': 'same-site',
      });
      assert.equal(nobody.headers.get('Location'), `${page}?provider=github&error=identity_required`);

      // An address that is not a workspace id goes to the root of the console, and nowhere else.
      const elsewhere = await start('/console/auth/link/github?workspace=..%2F..%2Fevil.example', {
        Cookie: cookie,
        'Sec-Fetch-Site': 'cross-site',
      });
      assert.equal(
        elsewhere.headers.get('Location'),
        `${CONSOLE_URL}/?provider=github&error=started_from_another_site`,
      );

      assert.equal((await start('/console/auth/link/gitlab', { Cookie: cookie })).status, 404);
      assert.equal(
        (await worker.call('/console/auth/link/github', { body: {}, headers: { Cookie: cookie } })).status,
        405,
      );
      // better-auth's own routes stay closed.
      for (const path of ['/console/auth/link-social', '/console/auth/unlink-account', '/console/auth/list-accounts']) {
        assert.equal((await worker.call(path, { body: {}, headers: { Cookie: cookie } })).status, 404, path);
      }
    });

    it('unlinks a provider while the link of the e-mail signs in, and only a linked one of this person', async () => {
      const { worker, cookie, id } = await signedIn();
      await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));
      const bob = await worker.signIn('bob@acme.dev');
      const bobs = (await (await worker.call('/console/me', { headers: { Cookie: bob } })).json()) as {
        account: { id: string };
      };
      await linkThrough(worker, bob, 'github', github('bob@acme.dev', { id: 7 }));

      assert.equal(
        (await worker.call('/console/me/sign-in/google', { method: 'DELETE', headers: { Cookie: cookie } })).status,
        404,
      );
      const gone = await worker.call('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: cookie } });
      assert.equal(gone.status, 204);
      assert.deepEqual(await providersOf(worker.database, id), []);
      assert.deepEqual(await providersOf(worker.database, bobs.account.id), ['github']);
      // Twice: nothing left to take.
      const again = await worker.call('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: cookie } });
      assert.equal(again.status, 404);
      assert.deepEqual(await again.json(), { error: 'not-linked' });
    });

    it('keeps the last way to sign in on a worker that sends no link', async () => {
      const { worker, cookie, id } = await signedIn();
      const quiet = withoutMail(worker);
      await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));

      const refused = await quiet('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: cookie } });
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), { error: 'last-sign-in' });
      assert.deepEqual(await providersOf(worker.database, id), ['github']);

      // With Google linked too, one of the two may go, and then not the other.
      await withProvider(
        {
          'https://oauth2.googleapis.com/token': {
            access_token: 'ya29.an-access-token',
            token_type: 'Bearer',
            id_token: googleIdToken({ sub: '1081', email: 'alice@acme.dev', email_verified: true, name: 'Alice' }),
          },
        },
        async () => {
          const start = await worker.call('/console/auth/link/google', {
            origin: null,
            headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
          });
          const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state') ?? '';
          const stateCookie = start.headers
            .getSetCookie()
            .map((each) => each.split(';')[0])
            .join('; ');
          await worker.call(`/console/auth/callback/google?code=a-code&state=${state}`, {
            origin: null,
            headers: { Cookie: `${cookie}; ${stateCookie}` },
          });
        },
      );
      assert.deepEqual(await providersOf(worker.database, id), ['github', 'google']);
      assert.equal(
        (await quiet('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: cookie } })).status,
        204,
      );
      assert.equal(
        (await quiet('/console/me/sign-in/google', { method: 'DELETE', headers: { Cookie: cookie } })).status,
        409,
      );
      assert.deepEqual(await providersOf(worker.database, id), ['google']);
    });

    it('takes one of two providers, and not both, when two unlinks come at the same moment', async () => {
      const { worker, cookie, id } = await signedIn();
      const quiet = withoutMail(worker);
      await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));
      // Google, written as better-auth writes a link: the race is in the unlinks, not here.
      await rowsOf(
        worker.database,
        `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
           VALUES ('lgn_google_alice', '1081', 'google', '${id}', now(), now())`,
      );

      const answers = await Promise.all(
        ['github', 'google'].map((provider) =>
          quiet(`/console/me/sign-in/${provider}`, { method: 'DELETE', headers: { Cookie: cookie } }),
        ),
      );

      assert.deepEqual(answers.map((answer) => answer.status).sort(), [204, 409]);
      assert.equal((await providersOf(worker.database, id)).length, 1);
    });

    it('asks a session older than a day to sign in again before a provider goes', async () => {
      const { worker, cookie, id } = await signedIn();
      await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));
      await rowsOf(
        worker.database,
        `UPDATE "session" SET "createdAt" = now() - interval '25 hours' WHERE "userId" = '${id}'`,
      );

      const stale = await worker.call('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: cookie } });
      assert.equal(stale.status, 403);
      assert.deepEqual(await stale.json(), { error: 'sign-in-again' });
      assert.deepEqual(await providersOf(worker.database, id), ['github']);

      // The control: a session of the last day takes it.
      const fresh = await worker.signIn('alice@acme.dev');
      assert.equal(
        (await worker.call('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: fresh } })).status,
        204,
      );
    });

    it('unlinks for a DELETE of the console only, with the cookie, and never with the token of an extension', async () => {
      const { worker, cookie, id } = await signedIn();
      await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));
      const path = '/console/me/sign-in/github';

      assert.equal((await worker.call(path, { method: 'DELETE' })).status, 401);
      assert.equal(
        (await worker.call(path, { method: 'DELETE', headers: { Cookie: cookie }, origin: null })).status,
        403,
      );
      assert.equal(
        (
          await worker.call(path, {
            method: 'DELETE',
            headers: { Cookie: cookie },
            origin: 'https://demo.fruitback.test',
          })
        ).status,
        403,
      );
      assert.equal((await worker.call(path, { method: 'POST', body: {}, headers: { Cookie: cookie } })).status, 405);
      assert.equal(
        (await worker.call(path, { method: 'DELETE', headers: { Authorization: 'Bearer a.b.c' } })).status,
        401,
      );
      assert.deepEqual(await providersOf(worker.database, id), ['github']);
      assert.equal(cookieOf(await worker.call(path, { method: 'DELETE' })), '');
    });
  });
}

/** An id token of Google, as its token endpoint answers one. better-auth decodes it, and checks no signature. */
function googleIdToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: 'https://accounts.google.com', aud: GOOGLE.clientId, ...claims })}.c2lnbmF0dXJl`;
}

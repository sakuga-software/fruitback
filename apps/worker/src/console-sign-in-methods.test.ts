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
 * by a navigation, and unlinking one while another way stays. Since FRU-415 a link starts by a `POST`
 * of the console, and is written only once the person confirmed it, even for another address.
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

/** GitHub, for a person with this address (`null`: GitHub gives none), verified or not, under this id. */
function github(email: string | null, { id = 4242, verified = true } = {}): Record<string, unknown> {
  return {
    'https://github.com/login/oauth/access_token': {
      access_token: 'gho_an-access-token',
      token_type: 'bearer',
      scope: 'read:user,user:email',
    },
    'https://api.github.com/user': { id, login: 'alice-gh', name: 'Alice of GitHub', email },
    'https://api.github.com/user/emails': email === null ? [] : [{ email, primary: true, verified }],
  };
}

/** Google, for a person with this address, verified or not, under this `sub`. */
function google(email: string, { sub = '1081', verified = true } = {}): Record<string, unknown> {
  return {
    'https://oauth2.googleapis.com/token': {
      access_token: 'ya29.an-access-token',
      token_type: 'Bearer',
      id_token: googleIdToken({ sub, email, email_verified: verified, name: 'Alice' }),
    },
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

const PAGE = `${CONSOLE_URL}/w/ws_0123456789abcdef0123/account`;

/**
 * A link of a provider, from « My account »: the form of the console that the worker answers, then the
 * way back from the provider. The location the person lands on, and the answer of each half.
 */
async function linkThrough(
  worker: Worker,
  cookie: string,
  provider: 'github' | 'google',
  answers: Record<string, unknown>,
  workspace = 'ws_0123456789abcdef0123',
) {
  const start = await worker.call(`/console/auth/link/${provider}?workspace=${workspace}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
  });
  assert.equal(start.status, 303, await start.clone().text());
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

/** The link that waits, as « My account » reads it, confirms it, or cancels it. */
function pending(worker: Worker, cookie: string, method: 'GET' | 'POST' | 'DELETE' = 'GET', origin?: string | null) {
  return worker.call('/console/me/sign-in/pending', {
    method,
    headers: { Cookie: cookie },
    ...(origin === undefined ? {} : { origin }),
  });
}

/** A link through the provider, then its confirmation: the provider is linked. */
async function linked(worker: Worker, cookie: string, provider: 'github' | 'google', answers: Record<string, unknown>) {
  const { location } = await linkThrough(worker, cookie, provider, answers);
  assert.equal(location, `${PAGE}?confirm=${provider}`);
  const confirmed = await pending(worker, cookie, 'POST');
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
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

      await linked(worker, cookie, 'github', github('alice@acme.dev'));
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

    it('links GitHub for the same verified address after the confirmation, keeps no token, and goes back to « My account »', async () => {
      const { worker, cookie, id } = await signedIn();

      const { to, location } = await linkThrough(worker, cookie, 'github', github('alice@acme.dev'));

      assert.equal(to.origin, 'https://github.com');
      assert.equal(location, `${PAGE}?confirm=github`);
      assert.deepEqual(await providersOf(worker.database, id), []);
      assert.equal((await pending(worker, cookie, 'POST')).status, 200);
      assert.deepEqual(await providersOf(worker.database, id), ['github']);
      const [row] = await rowsOf(
        worker.database,
        `SELECT "accessToken", "refreshToken", "idToken", password FROM "account" WHERE "userId" = '${id}'`,
      );
      assert.deepEqual(row, { accessToken: null, refreshToken: null, idToken: null, password: null });
      // One account still: the link joined nothing.
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM "user"')).length, 1);
    });

    it('links a provider of another verified address after the confirmation, by its id, and alerts the address of the account (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();

      const { location } = await linkThrough(worker, cookie, 'google', google('alice@other.dev', { sub: '1081' }));

      // Nothing is written before the person says yes.
      assert.equal(location, `${PAGE}?confirm=google`);
      assert.deepEqual(await providersOf(worker.database, id), []);
      const waiting = await pending(worker, cookie);
      assert.equal(waiting.status, 200);
      assert.deepEqual(await waiting.json(), { provider: 'google', email: 'alice@other.dev' });

      const sentBefore = worker.mail.sent.length;
      const confirmed = await pending(worker, cookie, 'POST');
      assert.equal(confirmed.status, 200);
      assert.deepEqual(await confirmed.json(), { provider: 'google' });
      // The identity is the id of the provider account, never the address; no token is kept.
      const rows = await rowsOf(
        worker.database,
        `SELECT "providerId", "accountId", "accessToken", "idToken" FROM "account" WHERE "userId" = '${id}'`,
      );
      assert.deepEqual(rows, [{ providerId: 'google', accountId: '1081', accessToken: null, idToken: null }]);
      // The address of the account is unchanged, and there is one account still.
      assert.deepEqual(await rowsOf(worker.database, 'SELECT email FROM "user"'), [{ email: 'alice@acme.dev' }]);

      // The alert, to the address of the account, with the way to undo it.
      assert.equal(worker.mail.sent.length, sentBefore + 1);
      const alert = worker.mail.sent.at(-1);
      assert.equal(alert?.to, 'alice@acme.dev');
      assert.ok(
        alert?.text.includes('The Google account alice@​other.​dev was linked to your Fruitback account'),
        alert?.text,
      );
      assert.ok(alert?.text.includes(PAGE), alert?.text);
      assert.ok(alert?.text.includes('unlink it'), alert?.text);

      // Spent: a second confirmation finds nothing.
      assert.equal((await pending(worker, cookie, 'POST')).status, 404);
      assert.equal((await pending(worker, cookie)).status, 404);
    });

    it('refuses an address that the provider did not verify, or no address, and writes nothing (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();

      for (const [provider, answers, code, why] of [
        [
          'github',
          github('alice@other.dev', { verified: false }),
          'email_not_verified',
          'another address, not verified',
        ],
        [
          'github',
          github('alice@acme.dev', { verified: false }),
          'email_not_verified',
          'the same address, not verified',
        ],
        ['google', google('alice@other.dev', { verified: false }), 'email_not_verified', 'Google, not verified'],
        ['github', github(null), 'email_not_found', 'GitHub gave no address'],
      ] as const) {
        const { location } = await linkThrough(worker, cookie, provider, answers);
        const back = new URL(location);
        assert.equal(`${back.origin}${back.pathname}`, PAGE, why);
        assert.equal(back.searchParams.get('error'), code, `${why}: ${location}`);
        assert.equal(back.searchParams.get('provider'), provider, `${why}: ${location}`);
        assert.equal((await pending(worker, cookie)).status, 404, why);
        assert.deepEqual(await providersOf(worker.database, id), [], why);
      }
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM "user"')).length, 1);
    });

    it('refuses a provider account or an address that belongs to another account, and joins no account (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();
      const bob = await worker.signIn('bob@acme.dev');
      const bobs = (await (await worker.call('/console/me', { headers: { Cookie: bob } })).json()) as {
        account: { id: string };
      };
      await linked(worker, bob, 'github', github('bob@acme.dev', { id: 7 }));

      for (const [provider, answers, code, why] of [
        ['github', github('alice@acme.dev', { id: 7 }), 'account_already_linked_to_different_user', 'Bob’s GitHub'],
        ['github', github('alice@other.dev', { id: 7 }), 'account_already_linked_to_different_user', 'Bob’s, other'],
        ['github', github('bob@acme.dev', { id: 99 }), 'email_already_used', 'Bob’s address, another GitHub'],
        ['google', google('BOB@acme.dev', { sub: '55' }), 'email_already_used', 'Bob’s address at Google, in capitals'],
      ] as const) {
        const { location } = await linkThrough(worker, cookie, provider, answers);
        assert.equal(new URL(location).searchParams.get('error'), code, `${why}: ${location}`);
        assert.equal(new URL(location).searchParams.get('provider'), provider, `${why}: ${location}`);
        assert.equal((await pending(worker, cookie)).status, 404, why);
      }
      assert.deepEqual(await providersOf(worker.database, id), []);
      assert.deepEqual(await providersOf(worker.database, bobs.account.id), ['github']);
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM "user"')).length, 2);

      // A link that waits, and whose provider account became Bob's before the confirmation: refused then.
      await linkThrough(worker, cookie, 'google', google('alice@other.dev', { sub: '1081' }));
      await rowsOf(
        worker.database,
        `INSERT INTO "account" (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
           VALUES ('lgn_google_bob', '1081', 'google', '${bobs.account.id}', now(), now())`,
      );
      const late = await pending(worker, cookie, 'POST');
      assert.equal(late.status, 409);
      assert.deepEqual(await late.json(), { error: 'account_already_linked_to_different_user' });
      assert.deepEqual(await providersOf(worker.database, id), []);
    });

    it('answers 502 and keeps the link waiting when the write fails for another reason than a conflict (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();
      await linkThrough(worker, cookie, 'google', google('alice@other.dev'));
      const adapter = (await worker.auth.$context).internalAdapter as unknown as {
        createAccount: () => Promise<never>;
      };
      const failing = mockMethod(adapter, 'createAccount', async () => {
        throw new Error('the database did not answer');
      });
      let failed: Response;
      try {
        failed = await pending(worker, cookie, 'POST');
      } finally {
        failing.mockRestore();
      }

      assert.equal(failed.status, 502);
      assert.deepEqual(await providersOf(worker.database, id), []);
      // Not a conflict, and not spent: the person confirms again, and it is linked.
      assert.equal((await pending(worker, cookie)).status, 200);
      assert.equal((await pending(worker, cookie, 'POST')).status, 200);
      assert.deepEqual(await providersOf(worker.database, id), ['google']);
    });

    it('links nothing on a GET, nor on a POST of another page (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();
      const path = '/console/auth/link/github?workspace=ws_0123456789abcdef0123';

      // A GET of a page of the same site sends the cookie: it starts nothing, and sets no state.
      const read = await worker.call(path, {
        origin: null,
        headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
      });
      assert.equal(read.status, 405);
      assert.equal(read.headers.get('Location'), null);
      assert.deepEqual(read.headers.getSetCookie(), []);

      // A form of another page of the same site carries its own `Origin`: the worker refuses it before
      // any route. A request with no `Origin` goes back to « My account » with the reason.
      const elsewhere = await worker.call(path, {
        method: 'POST',
        origin: 'https://demo.fruitback.test',
        headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
      });
      assert.equal(elsewhere.status, 403);
      assert.equal(elsewhere.headers.get('Location'), null);
      assert.deepEqual(elsewhere.headers.getSetCookie(), []);
      const nowhere = await worker.call(path, {
        method: 'POST',
        origin: null,
        headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
      });
      assert.equal(nowhere.status, 303);
      assert.equal(nowhere.headers.get('Location'), `${PAGE}?provider=github&error=started_from_another_site`);
      assert.deepEqual(nowhere.headers.getSetCookie(), []);
      assert.deepEqual(await providersOf(worker.database, id), []);
    });

    it('lets only the session that started a link confirm it, from the console, and cancels it (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();
      const other = await worker.signIn('alice@acme.dev');
      const bob = await worker.signIn('bob@acme.dev');
      await linkThrough(worker, cookie, 'google', google('alice@other.dev'));

      assert.equal((await worker.call('/console/me/sign-in/pending', { method: 'POST' })).status, 401);
      assert.equal((await pending(worker, cookie, 'POST', 'https://demo.fruitback.test')).status, 403);
      assert.equal((await pending(worker, cookie, 'POST', null)).status, 403);
      // Another session of Alice, and Bob, see no link and confirm none.
      for (const someone of [other, bob]) {
        assert.equal((await pending(worker, someone)).status, 404);
        assert.equal((await pending(worker, someone, 'POST')).status, 404);
      }
      assert.deepEqual(await providersOf(worker.database, id), []);
      assert.equal(
        (await worker.call('/console/me/sign-in/pending', { method: 'PUT', headers: { Cookie: cookie } })).status,
        405,
      );

      // « Cancel »: the link goes, and nothing is written.
      assert.equal((await pending(worker, cookie, 'DELETE')).status, 204);
      assert.equal((await pending(worker, cookie)).status, 404);
      assert.equal((await pending(worker, cookie, 'POST')).status, 404);
      assert.deepEqual(await providersOf(worker.database, id), []);
    });

    it('signs in by the id of the linked provider account, whatever address it gives later (FRU-415)', async () => {
      const { worker, cookie, id } = await signedIn();
      await linked(worker, cookie, 'github', github('alice@other.dev', { id: 4242 }));

      // GitHub now answers another address for the same account: it still opens Alice's account.
      const start = await worker.call('/console/auth/start/github', {
        origin: null,
        headers: { 'Sec-Fetch-Site': 'same-site' },
      });
      const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state') ?? '';
      const stateCookie = start.headers
        .getSetCookie()
        .map((each) => each.split(';')[0])
        .join('; ');
      const back = await withProvider(github('alice@third.dev', { id: 4242 }), () =>
        worker.call(`/console/auth/callback/github?code=a-code&state=${state}`, {
          origin: null,
          headers: { Cookie: stateCookie },
        }),
      );
      const session = cookieOf(back);
      assert.ok(session.length > 0, back.headers.get('Location') ?? '');
      const me = (await (await worker.call('/console/me', { headers: { Cookie: session } })).json()) as {
        account: { id: string; email: string };
      };
      assert.equal(me.account.id, id);
      assert.equal(me.account.email, 'alice@acme.dev');
      assert.equal((await rowsOf(worker.database, 'SELECT id FROM "user"')).length, 1);
    });

    it('starts no link for a page of another site, with no session, or for a provider it does not have', async () => {
      const { worker, cookie } = await signedIn();
      const page = PAGE;
      const start = (path: string, headers: Record<string, string>) => worker.call(path, { method: 'POST', headers });

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
        (await worker.call('/console/auth/link/github', { method: 'PUT', headers: { Cookie: cookie } })).status,
        405,
      );
      // better-auth's own routes stay closed.
      for (const path of ['/console/auth/link-social', '/console/auth/unlink-account', '/console/auth/list-accounts']) {
        assert.equal((await worker.call(path, { body: {}, headers: { Cookie: cookie } })).status, 404, path);
      }
    });

    it('unlinks a provider while the link of the e-mail signs in, and only a linked one of this person', async () => {
      const { worker, cookie, id } = await signedIn();
      await linked(worker, cookie, 'github', github('alice@acme.dev'));
      const bob = await worker.signIn('bob@acme.dev');
      const bobs = (await (await worker.call('/console/me', { headers: { Cookie: bob } })).json()) as {
        account: { id: string };
      };
      await linked(worker, bob, 'github', github('bob@acme.dev', { id: 7 }));

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
      await linked(worker, cookie, 'github', github('alice@acme.dev'));

      const refused = await quiet('/console/me/sign-in/github', { method: 'DELETE', headers: { Cookie: cookie } });
      assert.equal(refused.status, 409);
      assert.deepEqual(await refused.json(), { error: 'last-sign-in' });
      assert.deepEqual(await providersOf(worker.database, id), ['github']);

      // With Google linked too, one of the two may go, and then not the other.
      await linked(worker, cookie, 'google', google('alice@acme.dev'));
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
      await linked(worker, cookie, 'github', github('alice@acme.dev'));
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
      await linked(worker, cookie, 'github', github('alice@acme.dev'));
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
      await linked(worker, cookie, 'github', github('alice@acme.dev'));
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

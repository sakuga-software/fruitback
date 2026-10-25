import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { mockMethod } from './mock.fixture.ts';
import { ADDRESSES_PER_HOUR, VERIFY_ADDRESS_HOURS } from './account-emails.ts';
import { CONSOLE_URL, MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { GOOGLE, cookieOf, workerOf } from './auth-worker.fixture.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The addresses of an account beside its primary one (FRU-450): added by hand with a link of
 * verification, or brought by a linked provider; a sign-in link and an invitation sent to one; the
 * choice of the primary address; and what an unlink takes away. Every case goes through
 * `handleRequest`, as the console calls it.
 */

const { opening } = databasesOfACase();

type Worker = Awaited<ReturnType<typeof workerOf>>;
type Listed = {
  canAdd: boolean;
  emails: { email: string; primary: boolean; providers: string[]; verified: boolean }[];
};

const ORG = '/console/auth/organization';

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

/** Google, for a person with this address, under this `sub`. */
function google(email: string, { sub = '1081', verified = true } = {}): Record<string, unknown> {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims = { iss: 'https://accounts.google.com', aud: GOOGLE.clientId, sub, email, email_verified: verified };

  return {
    'https://oauth2.googleapis.com/token': {
      access_token: 'ya29.an-access-token',
      token_type: 'Bearer',
      id_token: `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.c2lnbmF0dXJl`,
    },
  };
}

/** Somebody who signed in by a link: their cookie and their account. */
async function person(worker: Worker, email: string) {
  const cookie = await worker.signIn(email);

  return { cookie, id: await idOf(worker, cookie), email };
}

async function idOf(worker: Worker, cookie: string): Promise<string> {
  const me = (await (await worker.call('/console/me', { headers: { Cookie: cookie } })).json()) as {
    account: { id: string };
  };

  return me.account.id;
}

async function listed(worker: Worker, cookie: string): Promise<Listed> {
  const answer = await worker.call('/console/me/emails', { headers: { Cookie: cookie } });
  assert.equal(answer.status, 200, await answer.clone().text());

  return (await answer.json()) as Listed;
}

/** The token of the last link of verification, read after the `#` of the link, as the console reads it. */
function verifyToken(worker: Worker, to: string): string {
  const message = worker.mail.sent.findLast((each) => each.to === to);
  const link = /https:\/\/\S+/.exec(message?.text ?? '')?.[0] ?? '';
  assert.ok(link.startsWith(`${CONSOLE_URL}/verify-email#`), `the link is not after a # of the console: ${link}`);

  return link.slice(link.indexOf('#') + 1);
}

/** An address added by hand and verified from the session that asked. */
async function added(worker: Worker, cookie: string, email: string): Promise<void> {
  const asked = await worker.call('/console/me/emails', { body: { email }, headers: { Cookie: cookie } });
  assert.equal(asked.status, 202, await asked.clone().text());
  const verified = await worker.call('/console/me/emails/verify', {
    body: { token: verifyToken(worker, email) },
    headers: { Cookie: cookie },
  });
  assert.equal(verified.status, 200, await verified.clone().text());
}

/** A link of a provider from « My account », and its confirmation. */
async function linked(worker: Worker, cookie: string, provider: 'github' | 'google', answers: Record<string, unknown>) {
  const start = await worker.call(`/console/auth/link/${provider}?workspace=ws_0123456789abcdef0123`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-site' },
  });
  assert.equal(start.status, 303, await start.clone().text());
  const state = new URL(start.headers.get('Location') ?? '').searchParams.get('state') ?? '';
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
  assert.match(back.headers.get('Location') ?? '', /\?confirm=/);
  const confirmed = await worker.call('/console/me/sign-in/pending', { method: 'POST', headers: { Cookie: cookie } });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
}

/** A sign-in with a provider: the start, then the way back. */
async function signInWith(worker: Worker, provider: 'github' | 'google', answers: Record<string, unknown>) {
  const start = await worker.call('/console/auth/sign-in/social', { body: { provider, callbackURL: CONSOLE_URL } });
  assert.equal(start.status, 200, await start.clone().text());
  const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state') ?? '';
  const stateCookie = start.headers
    .getSetCookie()
    .map((each) => each.split(';')[0])
    .join('; ');
  const back = await withProvider(answers, () =>
    worker.call(`/console/auth/callback/${provider}?code=a-code&state=${state}`, {
      origin: null,
      headers: { Cookie: stateCookie },
    }),
  );

  return { location: back.headers.get('Location') ?? '', cookie: cookieOf(back) };
}

async function users(database: PgDatabase): Promise<string[]> {
  return (await rowsOf(database, 'SELECT email FROM "user" ORDER BY email')).map((row) => String(row.email));
}

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the other addresses of an account, on ${label} (FRU-450)`, { skip: skip !== false }, () => {
    it('adds an address once its link is opened in the session that asked, and lists it', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');

      const asked = await worker.call('/console/me/emails', {
        body: { email: ' Alice@Home.Example ' },
        headers: { Cookie: alice.cookie },
      });

      assert.equal(asked.status, 202, await asked.clone().text());
      assert.deepEqual(await asked.json(), { sent: true, email: 'alice@home.example' });
      const message = worker.mail.sent.at(-1);
      assert.equal(message?.to, 'alice@home.example');
      assert.match((message?.text ?? '').replaceAll('​', ''), /signed in as alice@acme\.dev/);
      assert.match(message?.text ?? '', new RegExp(`for ${VERIFY_ADDRESS_HOURS} hours`));
      // Waiting, it is nobody's: not listed, and no sign-in link opens the account with it.
      assert.deepEqual((await listed(worker, alice.cookie)).emails, [
        { email: 'alice@acme.dev', primary: true, providers: [], verified: true },
      ]);

      // Another account that opens the link adds nothing, and leaves the link to Alice.
      const mallory = await person(worker, 'mallory@evil.example');
      const token = verifyToken(worker, 'alice@home.example');
      const stolen = await worker.call('/console/me/emails/verify', {
        body: { token },
        headers: { Cookie: mallory.cookie },
      });
      assert.equal(stolen.status, 404);
      assert.deepEqual((await listed(worker, mallory.cookie)).emails.length, 1);
      // From another page, nothing either.
      const elsewhere = await worker.call('/console/me/emails/verify', {
        body: { token },
        headers: { Cookie: alice.cookie },
        origin: 'https://demo.fruitback.com',
      });
      assert.equal(elsewhere.status, 403);

      const verified = await worker.call('/console/me/emails/verify', {
        body: { token },
        headers: { Cookie: alice.cookie },
      });

      assert.equal(verified.status, 200, await verified.clone().text());
      assert.deepEqual((await listed(worker, alice.cookie)).emails, [
        { email: 'alice@acme.dev', primary: true, providers: [], verified: true },
        { email: 'alice@home.example', primary: false, providers: [], verified: true },
      ]);
      // Spent once.
      assert.equal(
        (await worker.call('/console/me/emails/verify', { body: { token }, headers: { Cookie: alice.cookie } })).status,
        404,
      );
      // The table keeps a digest of the token, never the token.
      const kept = await rowsOf(worker.database, 'SELECT identifier, value FROM verification');
      assert.equal(JSON.stringify(kept).includes(token), false);
    });

    it('refuses a link of verification past its 24 hours', async () => {
      assert.equal(VERIFY_ADDRESS_HOURS, 24);
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await worker.call('/console/me/emails', {
        body: { email: 'alice@home.example' },
        headers: { Cookie: alice.cookie },
      });
      const token = verifyToken(worker, 'alice@home.example');
      await rowsOf(worker.database, `UPDATE verification SET "expiresAt" = now() - interval '1 second'`);

      const late = await worker.call('/console/me/emails/verify', {
        body: { token },
        headers: { Cookie: alice.cookie },
      });

      assert.equal(late.status, 404);
      assert.equal((await listed(worker, alice.cookie)).emails.length, 1);
    });

    it('refuses an address of another account, and does not say whose it is', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      const bob = await person(worker, 'bob@acme.dev');
      await added(worker, bob.cookie, 'bob@home.example');
      const sent = worker.mail.sent.length;

      for (const email of ['bob@acme.dev', 'BOB@home.example']) {
        const refused = await worker.call('/console/me/emails', { body: { email }, headers: { Cookie: alice.cookie } });
        assert.equal(refused.status, 409);
        const said = await refused.text();
        assert.deepEqual(JSON.parse(said), { error: 'email-taken' });
        assert.equal(said.includes(bob.id), false);
      }
      const mine = await worker.call('/console/me/emails', {
        body: { email: 'alice@acme.dev' },
        headers: { Cookie: alice.cookie },
      });
      assert.deepEqual([mine.status, await mine.json()], [409, { error: 'already-yours' }]);
      assert.equal(worker.mail.sent.length, sent, 'a message left for an address that was refused');

      // An address that another account verified while Alice's link waited.
      await worker.call('/console/me/emails', {
        body: { email: 'shared@acme.dev' },
        headers: { Cookie: alice.cookie },
      });
      const aliceToken = verifyToken(worker, 'shared@acme.dev');
      await added(worker, bob.cookie, 'shared@acme.dev');
      const late = await worker.call('/console/me/emails/verify', {
        body: { token: aliceToken },
        headers: { Cookie: alice.cookie },
      });
      assert.deepEqual([late.status, await late.json()], [409, { error: 'email-taken' }]);
    });

    it('sends 5 links of verification an hour for an account, and no more', async () => {
      assert.equal(ADDRESSES_PER_HOUR, 5);
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      const ask = (n: number) =>
        worker.call('/console/me/emails', {
          body: { email: `alice${n}@home.example` },
          headers: { Cookie: alice.cookie },
        });

      for (let n = 0; n < ADDRESSES_PER_HOUR; n += 1) assert.equal((await ask(n)).status, 202);
      const sent = worker.mail.sent.length;

      assert.equal((await ask(ADDRESSES_PER_HOUR)).status, 429);
      assert.equal(worker.mail.sent.length, sent);
    });

    it('opens the account with a sign-in link sent to another address it proved, and with none that waits', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await added(worker, alice.cookie, 'alice@home.example');
      await worker.call('/console/me/emails', {
        body: { email: 'alice@waits.example' },
        headers: { Cookie: alice.cookie },
      });

      const asked = await worker.call('/console/auth/email', { body: { email: 'alice@home.example' } });

      assert.equal(asked.status, 202);
      assert.equal(worker.mail.sent.at(-1)?.to, 'alice@home.example');
      const opened = await worker.call('/console/auth/email/redeem', { body: { token: worker.lastToken() } });
      assert.equal(opened.status, 200, await opened.clone().text());
      assert.equal(((await opened.json()) as { account: { id: string } }).account.id, alice.id);
      assert.deepEqual(await users(worker.database), ['alice@acme.dev']);

      // An address that waits for its verification is nobody's: its link opens no account of Alice.
      const other = await person(worker, 'alice@waits.example');
      assert.notEqual(other.id, alice.id);
    });

    it('makes another address the primary one, with a session of the last day, and alerts both', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await added(worker, alice.cookie, 'alice@home.example');
      const before = worker.mail.sent.length;

      const unknown = await worker.call('/console/me/emails/primary', {
        body: { email: 'nobody@acme.dev' },
        headers: { Cookie: alice.cookie },
      });
      assert.equal(unknown.status, 404);
      const chosen = await worker.call('/console/me/emails/primary', {
        body: { email: 'alice@home.example', workspace: 'ws_0123456789abcdef0123' },
        headers: { Cookie: alice.cookie },
      });

      assert.equal(chosen.status, 200, await chosen.clone().text());
      const me = (await (await worker.call('/console/me', { headers: { Cookie: alice.cookie } })).json()) as {
        account: { email: string };
      };
      assert.equal(me.account.email, 'alice@home.example');
      assert.deepEqual((await listed(worker, alice.cookie)).emails, [
        { email: 'alice@home.example', primary: true, providers: [], verified: true },
        { email: 'alice@acme.dev', primary: false, providers: [], verified: true },
      ]);
      const alerts = worker.mail.sent.slice(before);
      assert.deepEqual(alerts.map((each) => each.to).toSorted(), ['alice@acme.dev', 'alice@home.example']);
      assert.ok(alerts.every((each) => each.subject === 'The primary address of your Fruitback account changed'));
      assert.match(alerts[0]?.text ?? '', /\/w\/ws_0123456789abcdef0123\/account/);
      // The address of before still signs in.
      const again = await person(worker, 'alice@acme.dev');
      assert.equal(again.id, alice.id);

      // A session older than a day signs in again first.
      await rowsOf(worker.database, `UPDATE session SET "createdAt" = now() - interval '25 hours'`);
      const stale = await worker.call('/console/me/emails/primary', {
        body: { email: 'alice@acme.dev' },
        headers: { Cookie: alice.cookie },
      });
      assert.deepEqual([stale.status, await stale.json()], [403, { error: 'sign-in-again' }]);
    });

    it('takes an address away by hand, but never the primary one nor one that a linked provider gives', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await added(worker, alice.cookie, 'alice@home.example');
      await linked(worker, alice.cookie, 'github', github('alice@gh.example'));
      const remove = (email: string) =>
        worker.call(`/console/me/emails/${encodeURIComponent(email)}`, {
          method: 'DELETE',
          headers: { Cookie: alice.cookie },
        });

      assert.deepEqual([(await remove('alice@acme.dev')).status], [409]);
      const provided = await remove('alice@gh.example');
      assert.deepEqual([provided.status, await provided.json()], [409, { error: 'provider-address' }]);
      assert.equal((await remove('nobody@acme.dev')).status, 404);
      assert.equal((await remove('alice@home.example')).status, 204);

      assert.deepEqual(
        (await listed(worker, alice.cookie)).emails.map((each) => [each.email, each.providers]),
        [
          ['alice@acme.dev', []],
          ['alice@gh.example', ['github']],
        ],
      );
      // A sign-in link to the address that went opens no more the account.
      assert.notEqual((await person(worker, 'alice@home.example')).id, alice.id);
    });

    it('keeps the address of a linked provider, follows it at each sign-in, and takes it away at the unlink', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await linked(worker, alice.cookie, 'github', github('alice@gh.example'));
      const addresses = async () =>
        (await listed(worker, alice.cookie)).emails.map((each) => [each.email, each.providers]);
      assert.deepEqual(await addresses(), [
        ['alice@acme.dev', []],
        ['alice@gh.example', ['github']],
      ]);

      // GitHub gives another verified address: it takes the place of the one of before.
      const moved = await signInWith(worker, 'github', github('alice@new.example'));
      assert.doesNotMatch(moved.location, /error=/);
      assert.deepEqual(await addresses(), [
        ['alice@acme.dev', []],
        ['alice@new.example', ['github']],
      ]);
      // One it did not verify takes it away, and the sign-in still opens the account.
      const unverified = await signInWith(worker, 'github', github('alice@other.example', { verified: false }));
      assert.equal(await idOf(worker, unverified.cookie), alice.id);
      assert.deepEqual(await addresses(), [['alice@acme.dev', []]]);

      await signInWith(worker, 'github', github('alice@new.example'));
      const unlinked = await worker.call('/console/me/sign-in/github', {
        method: 'DELETE',
        headers: { Cookie: alice.cookie },
      });
      assert.equal(unlinked.status, 204, await unlinked.clone().text());
      assert.deepEqual(await addresses(), [['alice@acme.dev', []]]);
    });

    it('keeps the address of an unlinked provider that Fruitback proved too, and refuses the unlink of the one that alone proves the primary address', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      // Fruitback proves an address, then Google gives it too.
      await added(worker, alice.cookie, 'alice@g.example');
      await linked(worker, alice.cookie, 'google', google('alice@g.example'));
      await linked(worker, alice.cookie, 'github', github('alice@gh.example'));
      assert.equal(
        (
          await worker.call('/console/me/emails/primary', {
            body: { email: 'alice@gh.example' },
            headers: { Cookie: alice.cookie },
          })
        ).status,
        200,
      );

      const refused = await worker.call('/console/me/sign-in/github', {
        method: 'DELETE',
        headers: { Cookie: alice.cookie },
      });
      assert.deepEqual([refused.status, await refused.json()], [409, { error: 'primary-address' }]);
      assert.equal((await rowsOf(worker.database, `SELECT 1 FROM account WHERE "providerId" = 'github'`)).length, 1);

      const unlinkedGoogle = await worker.call('/console/me/sign-in/google', {
        method: 'DELETE',
        headers: { Cookie: alice.cookie },
      });
      assert.equal(unlinkedGoogle.status, 204);
      assert.deepEqual(
        (await listed(worker, alice.cookie)).emails.map((each) => [
          each.email,
          each.primary,
          each.providers,
          each.verified,
        ]),
        [
          ['alice@gh.example', true, ['github'], true],
          ['alice@g.example', false, [], true],
          ['alice@acme.dev', false, [], true],
        ],
      );
    });

    it('takes away, at the next read, the address of a provider whose unlink did not write it', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await linked(worker, alice.cookie, 'github', github('alice@gh.example'));
      // The unlink of before, whose last write failed: the row of the provider is gone, its address stays.
      await rowsOf(worker.database, `DELETE FROM account WHERE "providerId" = 'github'`);

      assert.deepEqual(
        (await listed(worker, alice.cookie)).emails.map((each) => each.email),
        ['alice@acme.dev'],
      );
      assert.deepEqual(await rowsOf(worker.database, 'SELECT email FROM account_emails'), []);
    });

    it('makes no account for a provider that gives another address of an account, and joins none', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      await added(worker, alice.cookie, 'alice@home.example');

      const refused = await signInWith(worker, 'google', google('alice@home.example', { sub: '9999' }));

      assert.match(refused.location, /error=email_already_used/);
      assert.equal(refused.cookie, '');
      assert.deepEqual(await users(worker.database), ['alice@acme.dev']);
      assert.deepEqual(await rowsOf(worker.database, 'SELECT "providerId" FROM account'), []);
    });

    it('holds one address to one account in the database too', async () => {
      const worker = await workerOf(await opening(open));
      const alice = await person(worker, 'alice@acme.dev');
      const bob = await person(worker, 'bob@acme.dev');

      await assert.rejects(
        rowsOf(
          worker.database,
          `INSERT INTO account_emails (email, account_id, verified_at, created_at) VALUES ('bob@acme.dev', '${alice.id}', 1, 1)`,
        ),
        /another account|duplicate|unique/i,
      );
      await rowsOf(
        worker.database,
        `INSERT INTO account_emails (email, account_id, verified_at, created_at) VALUES ('alice@home.example', '${alice.id}', 1, 1)`,
      );
      await assert.rejects(
        rowsOf(worker.database, `UPDATE "user" SET email = 'alice@home.example' WHERE id = '${bob.id}'`),
        /another account|duplicate|unique/i,
      );
    });

    it('lets the account accept an invitation sent to another address it proved, and keeps the address of the invitation', async () => {
      const worker = await workerOf(await opening(open));
      const owner = await person(worker, 'owner@acme.dev');
      const made = await worker.call('/console/workspaces', {
        body: { name: 'acme' },
        headers: { Cookie: owner.cookie },
      });
      const workspace = ((await made.json()) as { id: string }).id;
      const invite = async (email: string) => {
        const sent = await worker.call(`${ORG}/invite-member`, {
          body: { organizationId: workspace, role: 'member', email },
          headers: { Cookie: owner.cookie },
        });
        assert.equal(sent.status, 200, await sent.clone().text());

        return ((await sent.json()) as { id: string }).id;
      };
      const alice = await person(worker, 'alice@acme.dev');
      await added(worker, alice.cookie, 'alice@home.example');
      await worker.call('/console/me/emails', {
        body: { email: 'alice@waits.example' },
        headers: { Cookie: alice.cookie },
      });
      const toHome = await invite('alice@home.example');
      const toWaiting = await invite('alice@waits.example');
      const theirs = async () =>
        (
          (await (await worker.call(`${ORG}/list-user-invitations`, { headers: { Cookie: alice.cookie } })).json()) as {
            id: string;
          }[]
        ).map((each) => each.id);

      assert.deepEqual(await theirs(), [toHome]);
      const refused = await worker.call(`${ORG}/accept-invitation`, {
        body: { invitationId: toWaiting },
        headers: { Cookie: alice.cookie },
      });
      assert.equal(refused.status, 403);
      const joined = await worker.call(`${ORG}/accept-invitation`, {
        body: { invitationId: toHome },
        headers: { Cookie: alice.cookie },
      });

      assert.equal(joined.status, 200, await joined.clone().text());
      assert.deepEqual(await rowsOf(worker.database, `SELECT role FROM member WHERE "userId" = '${alice.id}'`), [
        { role: 'member' },
      ]);
      assert.deepEqual(await rowsOf(worker.database, `SELECT email, status FROM invitation WHERE id = '${toHome}'`), [
        { email: 'alice@home.example', status: 'accepted' },
      ]);
      assert.deepEqual(await theirs(), []);
    });
  });
}

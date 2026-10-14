import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_PERSON_NAME } from './accounts.ts';
import { DATABASES, databasesOfACase } from './auth.fixture.ts';
import { workerOf } from './auth-worker.fixture.ts';

/**
 * The name a person signs their notes with (FRU-249), set by `POST /console/me/name`.
 *
 * Their own account only, by a POST of the console. The notes already in a tracker keep the name
 * they were sent with; an extension signs the new name from its next access token: the rename writes it on their sessions.
 */

const { opening } = databasesOfACase();
const SECRETS_KEY = 'k'.repeat(44);

type Worker = Awaited<ReturnType<typeof workerOf>>;

/**
 * A character by its code point. Written so, and not as an escape in a string: the formatter writes
 * an escape as the character itself, and an invisible one in a source file is a hazard of its own.
 */
const at = (code: number): string => String.fromCodePoint(code);

/** The claims of an access token, read without checking it: the test reads what the worker signed. */
function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
}

for (const { label, open, skip } of DATABASES) {
  describe(`the name of a person, on ${label} (FRU-249)`, { skip }, () => {
    async function signedIn() {
      const worker = await workerOf(await opening(open), { env: { FRUITBACK_SECRETS_KEY: SECRETS_KEY } });
      const headers = { Cookie: await worker.signIn('alice@acme.dev') };
      const nameOf = async (who = headers): Promise<string | undefined> =>
        ((await (await worker.call('/console/me', { headers: who })).json()) as { account: { name?: string } }).account
          .name;

      return { worker, headers, nameOf };
    }

    /** An extension that the person of `headers` paired for a new workspace: its tokens. */
    async function extensionOf(worker: Worker, headers: Record<string, string>) {
      const made = await worker.call('/console/workspaces', { body: { name: 'Acme' }, headers });
      assert.equal(made.status, 201, await made.clone().text());
      const { id } = (await made.json()) as { id: string };
      const minted = await worker.call(`/console/workspaces/${id}/connect`, { body: {}, headers });
      assert.equal(minted.status, 201, await minted.clone().text());
      const { code } = (await minted.json()) as { code: string };
      const paired = await worker.call('/session/pair', { body: { code }, origin: null });
      assert.equal(paired.status, 200, await paired.clone().text());

      return (await paired.json()) as { refreshToken: string; accessToken: string };
    }

    it('keeps the name a person chose, on one line, and answers the account with it', async () => {
      const { worker, headers, nameOf } = await signedIn();

      for (const [sent, kept] of [
        ['Alice Martin', 'Alice Martin'],
        ['  Alice \t Martin \n', 'Alice Martin'],
        // One form for one name: the decomposed « é » is kept composed.
        [`Ame${at(0x301)}lie`, 'Amélie'],
        ['山田 花子', '山田 花子'],
        // A separator of lines is white space: one line, with a space.
        [`Alice${at(0x2028)}Bob`, 'Alice Bob'],
        ['A', 'A'],
        ['a'.repeat(MAX_PERSON_NAME), 'a'.repeat(MAX_PERSON_NAME)],
      ] as const) {
        const answer = await worker.call('/console/me/name', { body: { name: sent }, headers });
        assert.equal(answer.status, 200, JSON.stringify(sent));
        assert.equal(
          ((await answer.json()) as { account: { name?: string } }).account.name,
          kept,
          JSON.stringify(sent),
        );
        assert.equal(await nameOf(), kept, JSON.stringify(sent));
      }
    });

    it('refuses what is not a name of one line, and keeps the name the account had', async () => {
      const { worker, headers, nameOf } = await signedIn();
      assert.equal((await worker.call('/console/me/name', { body: { name: 'Alice' }, headers })).status, 200);

      for (const body of [
        { name: '' },
        { name: '   ' },
        { name: 'a'.repeat(MAX_PERSON_NAME + 1) },
        // A control character, a direction mark that draws the name backwards, a character of no
        // width, a character of private use, a code point no script has.
        { name: `Ali${at(0x0)}ce` },
        { name: `Ali${at(0x7)}ce` },
        { name: `Alice${at(0x202e)}niam` },
        { name: `${at(0x2066)}Alice${at(0x2069)}` },
        { name: `Al${at(0x200b)}ice` },
        { name: `Alice${at(0xe000)}` },
        { name: `Alice${at(0x378)}` },
        { name: 42 },
        { name: ['Alice'] },
        { name: { first: 'Alice' } },
        { name: null },
        {},
        { displayName: 'Alice' },
      ]) {
        const answer = await worker.call('/console/me/name', { body, headers });
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.deepEqual(await answer.json(), { error: 'invalid-name' }, JSON.stringify(body));
        assert.equal(await nameOf(), 'Alice', JSON.stringify(body));
      }
      // A body that is not JSON: the same answer.
      const garbled = await worker.call('/console/me/name', {
        headers: { ...headers, 'Content-Type': 'application/json' },
        method: 'POST',
      });
      assert.equal(garbled.status, 400);
    });

    it('sets the name of the person of the cookie only, by a POST of the console', async () => {
      const { worker, headers, nameOf } = await signedIn();
      const bob = { Cookie: await worker.signIn('bob@acme.dev') };
      const body = { name: 'Mallory' };

      assert.equal((await worker.call('/console/me/name', { body })).status, 401);
      assert.equal((await worker.call('/console/me/name', { method: 'GET', headers })).status, 405);
      assert.equal((await worker.call('/console/me/name', { method: 'PUT', body, headers })).status, 405);
      assert.equal((await worker.call('/console/me/name', { body, headers, origin: null })).status, 403);
      assert.equal(
        (await worker.call('/console/me/name', { body, headers, origin: 'https://demo.fruitback.com' })).status,
        403,
      );
      assert.equal(await nameOf(), undefined);

      // An extension: its access token names Alice, and opens no route of the console.
      const { accessToken } = await extensionOf(worker, headers);
      const bearer = await worker.call('/console/me/name', {
        body,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      assert.equal(bearer.status, 401);
      assert.equal(await nameOf(), undefined);

      // Bob names Bob, and Alice keeps hers.
      assert.equal((await worker.call('/console/me/name', { body: { name: 'Bob' }, headers: bob })).status, 200);
      assert.equal(await nameOf(bob), 'Bob');
      assert.equal(await nameOf(), undefined);
    });

    it('signs the next access token of an extension with the new name, and leaves the token in hand as it was', async () => {
      const { worker, headers } = await signedIn();
      assert.equal((await worker.call('/console/me/name', { body: { name: 'Alice' }, headers })).status, 200);
      const paired = await extensionOf(worker, headers);
      assert.equal(claimsOf(paired.accessToken).name, 'Alice');

      assert.equal((await worker.call('/console/me/name', { body: { name: 'Alice Martin' }, headers })).status, 200);
      // The token in hand was signed before: it says what it said until it ends, ten minutes at most.
      assert.equal(claimsOf(paired.accessToken).name, 'Alice');

      const refreshed = await worker.call('/session/refresh', {
        body: { refreshToken: paired.refreshToken },
        origin: null,
      });
      assert.equal(refreshed.status, 200, await refreshed.clone().text());
      const next = (await refreshed.json()) as {
        accessToken: string;
        refreshToken: string;
        identity: { name?: string };
      };
      assert.equal(claimsOf(next.accessToken).name, 'Alice Martin');
      assert.equal(next.identity.name, 'Alice Martin');

      // The control: a name changed again is read again, at each refresh.
      assert.equal((await worker.call('/console/me/name', { body: { name: 'A. Martin' }, headers })).status, 200);
      const again = await worker.call('/session/refresh', { body: { refreshToken: next.refreshToken }, origin: null });
      assert.equal(claimsOf(((await again.json()) as { accessToken: string }).accessToken).name, 'A. Martin');
    });
  });
}

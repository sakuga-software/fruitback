import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { workerOf } from './auth-worker.fixture.ts';

/**
 * The language of an account (FRU-119), set by `POST /console/me/locale`. Its two cases went with
 * `console-routes.test.ts` (FRU-150), and nothing named `invalid-locale` any more (FRU-216).
 */

const { opening } = databasesOfACase();

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the language of an account, on ${label} (FRU-119, FRU-216)`, { skip }, () => {
    async function signedIn() {
      const worker = await workerOf(await opening(open));
      const headers = { Cookie: await worker.signIn('alice@acme.dev') };
      const localeOf = async (): Promise<string | undefined> =>
        ((await (await worker.call('/console/me', { headers })).json()) as { account: { locale?: string } }).account
          .locale;

      return { worker, headers, localeOf };
    }

    it('keeps the language a person chose, in its canonical form, and forgets it on null', async () => {
      const { worker, headers, localeOf } = await signedIn();

      for (const [sent, kept] of [
        ['fr', 'fr'],
        ['FR-fr', 'fr-FR'],
        [' en-GB ', 'en-GB'],
      ] as const) {
        const answer = await worker.call('/console/me/locale', { body: { locale: sent }, headers });
        assert.equal(answer.status, 200, sent);
        assert.equal(((await answer.json()) as { account: { locale?: string } }).account.locale, kept, sent);
        assert.equal(await localeOf(), kept, sent);
      }

      const cleared = await worker.call('/console/me/locale', { body: { locale: null }, headers });
      assert.equal(cleared.status, 200);
      assert.equal(await localeOf(), undefined);
    });

    it('refuses what is not a language tag, and keeps the language the account had', async () => {
      const { worker, headers, localeOf } = await signedIn();
      assert.equal((await worker.call('/console/me/locale', { body: { locale: 'fr' }, headers })).status, 200);

      for (const body of [
        { locale: 'not a language' },
        { locale: '<script>' },
        { locale: '' },
        { locale: '   ' },
        { locale: 'x'.repeat(36) },
        // A tag that `Intl.Locale` takes, and that is longer than a column of an account holds.
        { locale: 'en-US-u-ca-gregory-co-phonebk-hc-h23-nu-latn' },
        { locale: 42 },
        { locale: ['fr'] },
        { locale: { tag: 'fr' } },
        // No `locale` at all is not « forget it »: only `null` says that.
        {},
        { language: 'en' },
      ]) {
        const answer = await worker.call('/console/me/locale', { body, headers });
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.deepEqual(await answer.json(), { error: 'invalid-locale' }, JSON.stringify(body));
        assert.equal(await localeOf(), 'fr', JSON.stringify(body));
      }
    });

    it('sets the language of the person of the cookie only, by a POST of the console', async () => {
      const { worker, headers, localeOf } = await signedIn();
      const bob = { Cookie: await worker.signIn('bob@acme.dev') };
      const body = { locale: 'fr' };

      assert.equal((await worker.call('/console/me/locale', { body })).status, 401);
      assert.equal((await worker.call('/console/me/locale', { method: 'GET', headers })).status, 405);
      assert.equal((await worker.call('/console/me/locale', { body, headers, origin: null })).status, 403);
      assert.equal(await localeOf(), undefined);

      assert.equal((await worker.call('/console/me/locale', { body, headers: bob })).status, 200);
      assert.equal(await localeOf(), undefined, 'the language of Bob is not the language of Alice');
    });
  });
}

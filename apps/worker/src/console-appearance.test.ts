import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { MIGRATED_DATABASES, databasesOfACase } from './auth.fixture.ts';
import { workerOf } from './auth-worker.fixture.ts';
import { rowsOf } from './postgres.fixture.ts';
import { APPEARANCE_CHOICES, readAppearanceChoice } from './appearance.ts';

/**
 * The look of the console that an account keeps (FRU-716), set by `POST /console/me/appearance` as
 * the language is by `/console/me/locale`, and answered by `GET /console/me` to the person alone.
 */

const { opening } = databasesOfACase();

/** A whole appearance, as the console sends it. */
const MIDNIGHT = {
  mode: 'dark',
  light: 'snow',
  dark: 'midnight',
  sidebar: 'deep',
  accent: 'teal',
  density: 'compact',
  radius: 4,
  fontSize: 14,
} as const;

describe('a whole appearance, and nothing else (FRU-716)', () => {
  it('takes every value of every field', () => {
    for (const [field, values] of Object.entries(APPEARANCE_CHOICES)) {
      for (const value of values) {
        assert.deepEqual(readAppearanceChoice({ ...MIDNIGHT, [field]: value }), { ...MIDNIGHT, [field]: value });
      }
    }
  });

  it('refuses a value it does not know, a field missing or a field more', () => {
    const { fontSize: _, ...missing } = MIDNIGHT;
    for (const value of [
      { ...MIDNIGHT, mode: 'sepia' },
      // A light theme as the dark one, and the reverse.
      { ...MIDNIGHT, dark: 'slate' },
      { ...MIDNIGHT, light: 'graphite' },
      { ...MIDNIGHT, radius: '4' },
      { ...MIDNIGHT, radius: 5 },
      { ...MIDNIGHT, fontSize: 13.5 },
      { ...MIDNIGHT, accent: { toString: () => 'red' } },
      // The name of a field of `Object.prototype` is no field of an appearance.
      { ...MIDNIGHT, toString: 'red' },
      { ...MIDNIGHT, css: '--color-ink: red' },
      missing,
      {},
      [],
      'dark',
      42,
      null,
      undefined,
    ]) {
      assert.equal(readAppearanceChoice(value), undefined, JSON.stringify(value));
    }
  });
});

for (const { label, open, skip } of MIGRATED_DATABASES) {
  describe(`the appearance of an account, on ${label} (FRU-716)`, { skip: skip !== false }, () => {
    async function signedIn() {
      const database = await opening(open);
      const worker = await workerOf(database);
      const headers = { Cookie: await worker.signIn('alice@acme.dev') };
      const appearanceOf = async (as = headers): Promise<unknown> =>
        ((await (await worker.call('/console/me', { headers: as })).json()) as { account: { appearance?: unknown } })
          .account.appearance;

      return { database, worker, headers, appearanceOf };
    }

    it('keeps the appearance a person chose, answers it with /console/me, and forgets it on null', async () => {
      const { worker, headers, appearanceOf } = await signedIn();
      assert.equal(await appearanceOf(), undefined, 'an account of before has the default look');

      const answer = await worker.call('/console/me/appearance', { body: { appearance: MIDNIGHT }, headers });
      assert.equal(answer.status, 200);
      assert.deepEqual(await answer.json(), { appearance: MIDNIGHT });
      // Another browser of the same person reads it back with its own session.
      const elsewhere = { Cookie: await worker.signIn('alice@acme.dev') };
      assert.notEqual(elsewhere.Cookie, headers.Cookie);
      assert.deepEqual(await appearanceOf(elsewhere), MIDNIGHT);

      const cleared = await worker.call('/console/me/appearance', { body: { appearance: null }, headers });
      assert.equal(cleared.status, 200);
      assert.deepEqual(await cleared.json(), { appearance: null });
      assert.equal(await appearanceOf(), undefined);
    });

    it('refuses what is not a whole appearance, and keeps the one the account had', async () => {
      const { worker, headers, appearanceOf } = await signedIn();
      assert.equal(
        (await worker.call('/console/me/appearance', { body: { appearance: MIDNIGHT }, headers })).status,
        200,
      );

      for (const body of [
        { appearance: { ...MIDNIGHT, accent: 'magenta' } },
        { appearance: { ...MIDNIGHT, extra: true } },
        { appearance: 'dark' },
        { appearance: [] },
        // No `appearance` at all is not « forget it »: only `null` says that.
        {},
        { theme: 'midnight' },
      ]) {
        const answer = await worker.call('/console/me/appearance', { body, headers });
        assert.equal(answer.status, 400, JSON.stringify(body));
        assert.deepEqual(await answer.json(), { error: 'invalid-appearance' }, JSON.stringify(body));
        assert.deepEqual(await appearanceOf(), MIDNIGHT, JSON.stringify(body));
      }
    });

    it('sets the appearance of the person of the cookie only, by a POST of the console', async () => {
      const { worker, headers, appearanceOf } = await signedIn();
      const bob = { Cookie: await worker.signIn('bob@acme.dev') };
      const body = { appearance: MIDNIGHT };

      assert.equal((await worker.call('/console/me/appearance', { body })).status, 401);
      assert.equal((await worker.call('/console/me/appearance', { method: 'GET', headers })).status, 405);
      assert.equal((await worker.call('/console/me/appearance', { body, headers, origin: null })).status, 403);
      assert.equal(await appearanceOf(), undefined);

      assert.equal((await worker.call('/console/me/appearance', { body, headers: bob })).status, 200);
      assert.equal(await appearanceOf(), undefined, 'the appearance of Bob is not the appearance of Alice');
      assert.deepEqual(await appearanceOf(bob), MIDNIGHT);
    });

    it('answers a kept value the console no longer knows as it was, for the console to read field by field', async () => {
      const { database, worker, headers, appearanceOf } = await signedIn();
      assert.equal(
        (await worker.call('/console/me/appearance', { body: { appearance: MIDNIGHT }, headers })).status,
        200,
      );
      // A theme a later console took away, written in the row as an operator or a restore could.
      await rowsOf(database, `UPDATE "user" SET appearance = jsonb_set(appearance, '{dark}', '"dusk"')`);
      assert.deepEqual(await appearanceOf(), { ...MIDNIGHT, dark: 'dusk' });
      // A value that is no object is no choice.
      await rowsOf(database, `UPDATE "user" SET appearance = '"dark"'::jsonb`);
      assert.equal(await appearanceOf(), undefined);
    });
  });
}

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Auth, CLIENT_IP_HEADER, authOptions, startAuth } from './auth.ts';
import {
  AUTH_CONFIG,
  CONSOLE_URL,
  DATABASES,
  NO_SESSIONS,
  PUBLIC_URL,
  databasesOfACase,
  make,
} from './auth.fixture.ts';
import { GITHUB, workerOf } from './auth-worker.fixture.ts';
import { KvError } from './kv.ts';
import { KV_TABLE, createPostgresKv } from './kv-postgres.ts';
import type { PgDatabase } from './postgres.ts';
import { rowsOf } from './postgres.fixture.ts';

/**
 * The limiter of better-auth counts in the `Kv` of the database (FRU-229), so every replica of the
 * worker counts against one ceiling. It is on with `FRUITBACK_AUTH_TRACK_IP=1` only.
 *
 * `/sign-in/social` is a route of better-auth with a rule of its own in 1.7.7: three requests in ten
 * seconds for one address. The cases send four.
 */

const { opening } = databasesOfACase();

/** A replica: an instance of better-auth with the options of the worker, on this database. */
async function replicaOn(database: PgDatabase): Promise<Auth> {
  const options = await authOptions(
    { ...AUTH_CONFIG, github: GITHUB, trackIp: true },
    await database.pool(),
    NO_SESSIONS,
    createPostgresKv(database),
  );

  return startAuth(options);
}

function signInFrom(auth: Auth, ip: string): Promise<Response> {
  return auth.handler(
    new Request(`${PUBLIC_URL}/console/auth/sign-in/social`, {
      method: 'POST',
      headers: { Origin: CONSOLE_URL, 'Content-Type': 'application/json', [CLIENT_IP_HEADER]: ip },
      body: JSON.stringify({ provider: 'github', callbackURL: CONSOLE_URL }),
    }),
  );
}

async function countsOf(database: PgDatabase): Promise<string[]> {
  const rows = await rowsOf(database, `SELECT value FROM ${KV_TABLE} WHERE key LIKE '%|/sign-in/social' ORDER BY key`);

  return rows.map((row) => String(row.value));
}

for (const { label, open, skip } of DATABASES) {
  describe(`the limiter of better-auth, on ${label} (FRU-229)`, { skip }, () => {
    it('makes two instances on one database share the ceiling of a route', async () => {
      const database = await opening(open);
      await make(database);
      const [first, second] = [await replicaOn(database), await replicaOn(database)];

      for (let request = 1; request <= 3; request += 1) {
        assert.equal((await signInFrom(first, '198.51.100.7')).status, 200, `request ${request} of 3`);
      }
      const refused = await signInFrom(second, '198.51.100.7');

      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get('X-Retry-After'), '10');
      // In one process the two instances also share the memory of better-auth, so the refusal alone
      // passes with that memory. The count in the table is what a replica in another process reads.
      assert.deepEqual(await countsOf(database), ['4']);
      // The control: the second instance answers another address.
      assert.equal((await signInFrom(second, '198.51.100.8')).status, 200);
    });

    it('refuses with 503 limiter-unavailable when the Kv does not answer, and lets nothing through', async () => {
      const database = await opening(open);
      const kv = createPostgresKv(database);
      let down = false;
      const worker = await workerOf(database, {
        trackIp: true,
        limits: {
          incr: (key, ttlMs, by) => (down ? Promise.reject(new KvError('the Kv is down')) : kv.incr(key, ttlMs, by)),
        },
      });
      const signIn = () =>
        worker.call('/console/auth/sign-in/social', {
          body: { provider: 'github', callbackURL: CONSOLE_URL },
          ip: '198.51.100.9',
        });

      // The control: the same request, with the Kv up, reaches better-auth.
      const answered = await signIn();
      assert.equal(answered.status, 200, await answered.clone().text());
      down = true;
      const refused = await signIn();

      assert.equal(refused.status, 503);
      assert.deepEqual(await refused.json(), { error: 'limiter-unavailable' });
    });
  });
}

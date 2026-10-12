import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { call, redeemLink, signInProviders } from './api.ts';

afterEach(() => mock.restoreAll());

/**
 * A worker that refuses to say what it offers (FRU-205).
 *
 * While the console had two paths, a refusal of `GET /auth/providers` was read as a worker of
 * before: the console spent the refresh cookie of before and held a token. There is one path since
 * FRU-150, so a refusal there stops no call, and no call can take a token.
 */

type Sent = { path: string; init: RequestInit };

function worker(providers: () => Response): Sent[] {
  const sent: Sent[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push({ path, init });
    if (path === '/auth/providers') return providers();

    return Response.json({ account: { id: 'acc_1', email: 'ana@acme.dev' }, workspaces: [] });
  });

  return sent;
}

describe('a worker that refuses to say what it offers (FRU-205)', () => {
  for (const [name, providers] of [
    ['limited', () => Response.json({ error: 'rate-limited' }, { status: 429 })],
    ['failed', () => Response.json({ error: 'auth-unavailable' }, { status: 502 })],
    ['failed with no body', () => new Response('Bad Gateway', { status: 502 })],
  ] as const) {
    it(`stops no call and takes no token when the question is ${name}: the console has one path (FRU-150)`, async () => {
      const sent = worker(providers);

      // Nobody said which providers there are: that is not « none ».
      assert.equal(await signInProviders(), undefined);
      assert.equal((await call('GET', '/console/me', undefined, { quiet: true })).ok, true);
      assert.equal((await redeemLink('the-code-of-a-link')).ok, true);

      assert.deepEqual(
        sent.map((each) => each.path),
        ['/auth/providers', '/console/me', '/console/auth/email/redeem'],
      );
      for (const each of sent) {
        assert.equal(new Headers(each.init.headers).has('Authorization'), false, each.path);
      }
    });
  }
});

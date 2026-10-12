import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { UNREACHABLE, call, redeemLink, requestLink, signInProviders, signOut } from './api.ts';

afterEach(() => mock.restoreAll());

/**
 * A worker that did not say which path it serves (FRU-205).
 *
 * In a file of its own: `api.ts` keeps the path once the worker said it, and a test of `api.test.ts`
 * that runs before would have said it. Here nothing says it until the last case.
 */

type Sent = { path: string; init: RequestInit };

/** A worker whose `/auth/providers` answers as `providers` says, and which keeps what it was sent. */
function worker(providers: () => Response): Sent[] {
  const sent: Sent[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    sent.push({ path, init });
    if (path === '/auth/providers') return providers();
    // Every route of before answers as a worker that still serves it would: a session, a link sent.
    if (path === '/console/session/refresh') return Response.json({ accessToken: 'the-token-of-the-person-before' });
    if (path === '/console/session/logout') return new Response(null, { status: 204 });

    return Response.json({ account: { id: 'acc_1', email: 'before@acme.dev' }, workspaces: [], sent: true });
  });

  return sent;
}

const REFUSALS: [string, () => Response, { ok: false; status: number; error: string }][] = [
  [
    'limited',
    () => Response.json({ error: 'rate-limited' }, { status: 429 }),
    { ok: false, status: 429, error: 'rate-limited' },
  ],
  [
    'failed',
    () => Response.json({ error: 'auth-unavailable' }, { status: 502 }),
    { ok: false, status: 502, error: 'auth-unavailable' },
  ],
  [
    'failed with no body',
    () => new Response('Bad Gateway', { status: 502 }),
    { ok: false, status: 502, error: 'unknown' },
  ],
];

describe('a worker that did not say which path it serves (FRU-205)', () => {
  for (const [name, providers, refusal] of REFUSALS) {
    it(`takes no path, and answers the refusal, when the question is ${name}`, async () => {
      const sent = worker(providers);

      assert.deepEqual(await call('GET', '/console/me'), refusal);
      assert.deepEqual(await call('POST', '/console/workspaces', { name: 'Acme' }), refusal);
      assert.deepEqual(await requestLink('a@b.dev', 'fr'), refusal);
      assert.deepEqual(await redeemLink('the-code-of-a-link'), refusal);
      assert.equal(await signOut(), false);
      assert.equal(await signInProviders(), undefined);

      // Nothing but the question left: no refresh cookie was spent, no link was asked or spent on a
      // route of before, and no call carried a token.
      assert.deepEqual([...new Set(sent.map((each) => each.path))], ['/auth/providers']);
      for (const each of sent) assert.equal(new Headers(each.init.headers).get('Authorization'), null);
    });
  }

  it('takes no path when the worker does not answer', async () => {
    const fetched = mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });

    assert.deepEqual(await call('GET', '/console/me'), UNREACHABLE);
    assert.deepEqual(await requestLink('a@b.dev', 'fr'), UNREACHABLE);
    assert.equal(await signOut(), false);
    for (const each of fetched.mock.calls) assert.match(String(each.arguments[0]), /\/auth\/providers$/);
  });

  it('asks the question once for the calls of one moment', async () => {
    const sent = worker(() => Response.json({ error: 'rate-limited' }, { status: 429 }));

    await Promise.all([call('GET', '/console/me'), call('GET', '/console/workspaces'), signInProviders()]);

    assert.equal(sent.length, 1);
  });

  it('asks again at the next call, and takes the path the worker then says', async () => {
    worker(() => Response.json({ error: 'rate-limited' }, { status: 429 }));
    assert.equal((await call('GET', '/console/me')).ok, false);
    mock.restoreAll();

    // The control: the same worker of before, once it says that it is one, is served as before.
    const sent = worker(() => Response.json({ github: true, google: false }));
    assert.equal((await call('GET', '/console/me')).ok, true);

    assert.deepEqual(
      sent.map((each) => each.path),
      ['/auth/providers', '/console/session/refresh', '/console/me'],
    );
    assert.equal(new Headers(sent.at(-1)?.init.headers).get('Authorization'), 'Bearer the-token-of-the-person-before');
  });
});

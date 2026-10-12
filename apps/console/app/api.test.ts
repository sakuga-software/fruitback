import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_DESTINATIONS,
  type Site,
  UNREACHABLE,
  call,
  callUntilAnswered,
  hasRoomFor,
  onReachability,
  onSignedOut,
  providerStart,
  redeemLink,
  requestLink,
  signInProviders,
  signOut,
} from './api.ts';

afterEach(() => mock.restoreAll());

/** A worker nobody reaches: no name, no network. `fetch` rejects, as a browser's does. */
function down() {
  return mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch');
  });
}

describe('a worker that does not answer', () => {
  it('answers every call instead of rejecting, so no screen waits for ever', async () => {
    down();

    assert.deepEqual(await call('GET', '/console/me'), UNREACHABLE);
    assert.deepEqual(await requestLink('a@b.dev', 'en'), UNREACHABLE);
    assert.deepEqual(await redeemLink('code'), UNREACHABLE);
    assert.equal(await signOut(), false, 'nobody said that the session ended');
  });

  it('says so to whoever listens, and says when the worker is back', async () => {
    const seen: boolean[] = [];
    const stop = onReachability((reachable) => seen.push(reachable));
    mock.method(globalThis, 'fetch', async () =>
      Response.json({ account: { id: 'a', email: 'a@b.dev' }, workspaces: [] }),
    );
    await call('GET', '/console/me');
    mock.restoreAll();
    down();
    await call('GET', '/console/me');
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => Response.json({ error: 'identity-required' }, { status: 401 }));
    await call('GET', '/console/me');
    stop();

    assert.deepEqual(seen.slice(-2), [false, true], 'a refusal is still an answer');
    assert.equal(seen.includes(false), true);
  });

  it('asks again until the worker answers, and stops when told to', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const fetched = down();
    const answers: unknown[] = [];
    const stop = callUntilAnswered('GET', '/console/me', (answer) => answers.push(answer));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answers.length, 0, 'no answer is not handed over');

    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => Response.json({ workspaces: [] }));
    mock.timers.tick(5_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answers.length, 1);

    const quiet = down();
    const stopped = callUntilAnswered('GET', '/console/me', () => void answers.push('late'));
    await new Promise((resolve) => setImmediate(resolve));
    stopped();
    const before = quiet.mock.calls.length;
    mock.timers.tick(20_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quiet.mock.calls.length, before, 'a stopped call asks nothing more');
    assert.ok(fetched.mock.calls.length > 0);
    stop();
    mock.timers.reset();
  });

  it('bounds each request, so a worker that accepts and never answers is not waited for', async () => {
    const fetched = mock.method(globalThis, 'fetch', async () => Response.json({}));
    await call('GET', '/console/me');

    for (const each of fetched.mock.calls) {
      assert.ok((each.arguments[1] as RequestInit).signal instanceof AbortSignal);
    }
    assert.ok(fetched.mock.calls.length > 0);
  });
});

/** A worker that answers each path as `routes` says, and keeps every request it was sent. */
function worker(routes: Record<string, () => Response>) {
  const sent: { url: string; init: RequestInit }[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    const path = new URL(url).pathname;
    const route = routes[`${init.method ?? 'GET'} ${path}`];

    return route === undefined ? Response.json({ error: 'not-found' }, { status: 404 }) : route();
  });

  return sent;
}

const BETTER_AUTH = () =>
  Response.json({ github: true, google: false, betterAuth: { email: true, github: false, google: true } });

describe('a worker that serves better-auth (FRU-148)', () => {
  it('holds no token: each call sends the cookie of the worker, and no Authorization', async () => {
    const sent = worker({
      'GET /auth/providers': BETTER_AUTH,
      'POST /console/auth/email/redeem': () => Response.json({ account: { id: 'acc_1', email: 'a@b.dev' } }),
      'GET /console/me': () => Response.json({ account: { id: 'acc_1', email: 'a@b.dev' }, workspaces: [] }),
    });
    await signInProviders();

    const redeemed = await redeemLink('a-token-of-a-link');
    const me = await call('GET', '/console/me');

    assert.equal(redeemed.ok, true);
    assert.equal(me.ok, true);
    const redeem = sent.find((each) => each.url.endsWith('/console/auth/email/redeem'));
    assert.equal(JSON.parse(String(redeem?.init.body)).token, 'a-token-of-a-link');
    for (const each of sent) {
      assert.equal(each.init.credentials, 'include', each.url);
      assert.equal(new Headers(each.init.headers).get('Authorization'), null, each.url);
    }
    // There is nothing to refresh.
    assert.equal(sent.filter((each) => each.url.includes('/refresh')).length, 0);
  });

  it('takes the providers of better-auth, and starts a sign-in by a navigation to its route', async () => {
    worker({ 'GET /auth/providers': BETTER_AUTH });

    assert.deepEqual(await signInProviders(), { github: false, google: true });
    assert.match(providerStart('google'), /\/console\/auth\/start\/google$/);
  });

  it('sends a link and signs out on the routes of better-auth', async () => {
    const sent = worker({
      'GET /auth/providers': BETTER_AUTH,
      'POST /console/auth/email': () => Response.json({ sent: true }, { status: 202 }),
      'POST /console/auth/sign-out': () => Response.json({ success: true }),
    });
    await signInProviders();

    assert.equal((await requestLink('a@b.dev', 'fr')).ok, true);
    assert.equal(await signOut(), true);

    // No call to the path of before: the worker reads its refresh cookie no more (FRU-150).
    assert.deepEqual(sent.map((each) => `${each.init.method} ${new URL(each.url).pathname}`).slice(1), [
      'POST /console/auth/email',
      'POST /console/auth/sign-out',
    ]);
  });

  it('says that the sign-out failed when the worker did not end the session (FRU-204)', async () => {
    const cases: [string, () => Response, boolean][] = [
      ['ended', () => Response.json({ success: true }), true],
      ['refused', () => Response.json({ error: 'auth-unavailable' }, { status: 502 }), false],
      ['limited', () => Response.json({ error: 'rate-limited' }, { status: 429 }), false],
    ];

    for (const [name, answered, expected] of cases) {
      const sent = worker({ 'GET /auth/providers': BETTER_AUTH, 'POST /console/auth/sign-out': answered });
      await signInProviders();

      assert.equal(await signOut(), expected, name);
      assert.deepEqual(sent.map((each) => new URL(each.url).pathname).slice(1), ['/console/auth/sign-out'], name);
      mock.restoreAll();
    }
  });

  it('says that the sign-out failed when the worker stops answering (FRU-204)', async () => {
    worker({ 'GET /auth/providers': BETTER_AUTH });
    await signInProviders();
    mock.restoreAll();
    down();

    assert.equal(await signOut(), false);
  });

  it('tells whoever listens when a call is refused because the session ended, and not for a quiet call', async () => {
    worker({
      'GET /auth/providers': BETTER_AUTH,
      'POST /console/workspaces': () => Response.json({ error: 'identity-required' }, { status: 401 }),
      'GET /console/me': () => Response.json({ error: 'identity-required' }, { status: 401 }),
    });
    await signInProviders();
    let told = 0;
    const stop = onSignedOut(() => void (told += 1));

    const refused = await call('POST', '/console/workspaces', { name: 'Acme' });
    await call('GET', '/console/me', undefined, { quiet: true });
    stop();

    assert.deepEqual(refused, { ok: false, status: 401, error: 'identity-required' });
    assert.equal(told, 1);
  });
});

describe('a worker that does not say betterAuth (FRU-150)', () => {
  it('signs nobody in: no provider, no token, and no route of the sign-in of before', async () => {
    const sent = worker({
      'GET /auth/providers': () => Response.json({ github: true, google: true }),
      'GET /console/me': () => Response.json({ error: 'identity-required' }, { status: 401 }),
    });

    // The two booleans of a worker of before are read by nobody.
    assert.deepEqual(await signInProviders(), { github: false, google: false });
    assert.match(providerStart('github'), /\/console\/auth\/start\/github$/);
    await redeemLink('a-code');
    await call('GET', '/console/me', undefined, { quiet: true });

    assert.equal(sent.find((each) => each.url.endsWith('/redeem'))?.url.endsWith('/console/auth/email/redeem'), true);
    for (const each of sent) {
      assert.equal(new Headers(each.init.headers).has('Authorization'), false, each.url);
      assert.doesNotMatch(each.url, /\/console\/session\//);
    }
  });
});

describe('the providers the worker signs people in with (FRU-135)', () => {
  it('says which are on when the worker answers, and takes nothing but true for on', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({ betterAuth: { github: true, google: 'true' } }));

    assert.deepEqual(await signInProviders(), { github: true, google: false });
  });

  it('reads an answer with no body as no provider, and does not throw', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));

    assert.deepEqual(await signInProviders(), { github: false, google: false });
  });

  it('says nothing when the worker did not say, so no screen calls a provider not set up', async () => {
    down();
    assert.equal(await signInProviders(), undefined);

    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => Response.json({ error: 'not-found' }, { status: 404 }));
    assert.equal(await signInProviders(), undefined);
  });
});

describe('a site that sends to several places (FRU-123)', () => {
  const site = (places: number, connector = 'con_linear'): Site => ({
    id: 'site_1',
    origin: 'https://acme.dev',
    visibility: 'members',
    destinations: Array.from({ length: places }, (_, index) => ({ connector, teamId: `team_${index}` })),
  });

  it('has room for one more place under the bound of the worker, and none at the bound', () => {
    assert.equal(MAX_DESTINATIONS, 5);
    assert.equal(hasRoomFor(site(4), 'con_rest'), true);
    assert.equal(hasRoomFor(site(5), 'con_rest'), false);
    assert.equal(hasRoomFor(site(0), 'con_rest'), true);
  });

  it('keeps the choice of a source the site already sends to, even when the site is full', () => {
    assert.equal(hasRoomFor(site(5, 'con_rest'), 'con_rest'), true);
    // A worker of before sends one destination, and no list.
    assert.equal(
      hasRoomFor({ ...site(0), destinations: undefined as never, destination: { connector: 'c' } }, 'x'),
      true,
    );
  });
});

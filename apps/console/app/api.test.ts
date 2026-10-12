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
const BEFORE = () => Response.json({ github: true, google: false });

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
      'POST /console/session/logout': () => new Response(null, { status: 204 }),
    });
    await signInProviders();

    assert.equal((await requestLink('a@b.dev', 'fr')).ok, true);
    assert.equal(await signOut(), true);

    // The session of before is ended too (FRU-204): its refresh cookie is good for 30 days.
    assert.deepEqual(sent.map((each) => `${each.init.method} ${new URL(each.url).pathname}`).slice(1), [
      'POST /console/auth/email',
      'POST /console/auth/sign-out',
      'POST /console/session/logout',
    ]);
  });

  it('says that the sign-out failed when the worker did not end one of the two sessions (FRU-204)', async () => {
    const ended = () => Response.json({ success: true });
    const endedBefore = () => new Response(null, { status: 204 });
    const refused = () => Response.json({ error: 'auth-unavailable' }, { status: 502 });
    const limited = () => Response.json({ error: 'rate-limited' }, { status: 429 });
    const cases: [string, Record<string, () => Response>, boolean][] = [
      ['both ended', { 'POST /console/auth/sign-out': ended, 'POST /console/session/logout': endedBefore }, true],
      [
        'better-auth refused',
        { 'POST /console/auth/sign-out': refused, 'POST /console/session/logout': endedBefore },
        false,
      ],
      [
        'better-auth limited',
        { 'POST /console/auth/sign-out': limited, 'POST /console/session/logout': endedBefore },
        false,
      ],
      [
        'the path of before refused',
        { 'POST /console/auth/sign-out': ended, 'POST /console/session/logout': refused },
        false,
      ],
      // A worker that no longer serves the path of before (FRU-150) reads no refresh cookie.
      ['no path of before', { 'POST /console/auth/sign-out': ended }, true],
    ];

    for (const [name, routes, expected] of cases) {
      const sent = worker({ 'GET /auth/providers': BETTER_AUTH, ...routes });
      await signInProviders();

      assert.equal(await signOut(), expected, name);
      // Both are asked, whatever the first one answers.
      assert.deepEqual(
        sent.map((each) => new URL(each.url).pathname).slice(1),
        ['/console/auth/sign-out', '/console/session/logout'],
        name,
      );
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

describe('a worker of before, which does not say betterAuth (FRU-148)', () => {
  it('signs in as before: the link of before, and a navigation to the route of before', async () => {
    const sent = worker({
      'GET /auth/providers': BEFORE,
      'POST /auth/email/redeem': () =>
        Response.json({ accessToken: 'an-access-token', account: { id: 'a', email: 'a@b.dev' } }),
      'GET /console/me': () => Response.json({ account: { id: 'a', email: 'a@b.dev' }, workspaces: [] }),
    });

    assert.deepEqual(await signInProviders(), { github: true, google: false });
    assert.match(providerStart('github'), /\/auth\/github$/);
    assert.equal((await redeemLink('a-code')).ok, true);
    await call('GET', '/console/me');

    const me = sent.find((each) => each.url.endsWith('/console/me'));
    assert.equal(new Headers(me?.init.headers).get('Authorization'), 'Bearer an-access-token');
    assert.deepEqual(JSON.parse(String(sent.find((each) => each.url.endsWith('/redeem'))?.init.body)).code, 'a-code');
  });
});

describe('the sign-out of a worker of before (FRU-204)', () => {
  it('says whether the worker ended the session, on the route of before and no other', async () => {
    const sent = worker({
      'GET /auth/providers': BEFORE,
      'POST /console/session/logout': () => new Response(null, { status: 204 }),
    });
    await signInProviders();
    assert.equal(await signOut(), true);
    assert.deepEqual(sent.map((each) => new URL(each.url).pathname).slice(1), ['/console/session/logout']);

    mock.restoreAll();
    worker({
      'GET /auth/providers': BEFORE,
      'POST /console/session/logout': () => Response.json({ error: 'rate-limited' }, { status: 429 }),
    });
    await signInProviders();
    assert.equal(await signOut(), false);
  });
});

describe('a refusal of better-auth (FRU-209)', () => {
  it('is named by its code, so a screen finds its sentence, and by error when the worker refuses', async () => {
    worker({
      'GET /auth/providers': BETTER_AUTH,
      'POST /console/auth/organization/invite-member': () =>
        Response.json({ code: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION', message: 'x' }, { status: 400 }),
      'POST /console/auth/organization/leave': () => Response.json({ error: 'not-found' }, { status: 404 }),
      'POST /console/auth/organization/remove-member': () => new Response('Bad Gateway', { status: 502 }),
    });

    assert.deepEqual(await call('POST', '/console/auth/organization/invite-member', {}), {
      ok: false,
      status: 400,
      error: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
    });
    assert.deepEqual(await call('POST', '/console/auth/organization/leave', {}), {
      ok: false,
      status: 404,
      error: 'not-found',
    });
    assert.deepEqual(await call('POST', '/console/auth/organization/remove-member', {}), {
      ok: false,
      status: 502,
      error: 'unknown',
    });
  });
});

describe('the providers the worker signs people in with (FRU-135)', () => {
  it('says which are on when the worker answers, and takes nothing but true for on', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({ github: true, google: 'true' }));

    assert.deepEqual(await signInProviders(), { github: true, google: false });
  });

  it('reads an answer with no body as a worker of before, and does not throw', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));

    assert.deepEqual(await signInProviders(), { github: false, google: false });
    assert.match(providerStart('github'), /\/auth\/github$/);
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

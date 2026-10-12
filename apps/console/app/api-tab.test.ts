import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

afterEach(() => mock.restoreAll());

/**
 * A tab is of one account (FRU-210). `api.ts` keeps that account for the life of the page, so each
 * case loads the module again: a tab that was just opened.
 */
let loads = 0;
async function tab(): Promise<typeof import('./api.ts')> {
  loads += 1;

  return (await import(`./api.ts?tab=${loads}`)) as typeof import('./api.ts');
}

type Sent = { method: string; path: string };
const LEFT = { ok: false, status: 409, error: 'tab-left' };
const ANA = { account: { id: 'acc_ana', email: 'ana@acme.dev' }, workspaces: [] };
const BOB = { account: { id: 'acc_bob', email: 'bob@acme.dev' }, workspaces: [] };

/** A worker of better-auth. `me` answers `/console/me`; the other routes answer `ok`, or as `routes` says. */
function worker(script: { me: () => Response; routes?: Record<string, () => Response> }): Sent[] {
  const sent: Sent[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method ?? 'GET';
    if (path !== '/auth/providers') sent.push({ method, path });
    if (path === '/auth/providers') return Response.json({ betterAuth: { email: true } });
    if (path === '/console/me' && method === 'GET') return script.me();

    return script.routes?.[`${method} ${path}`]?.() ?? Response.json({ id: 'made' }, { status: 201 });
  });

  return sent;
}

const signedOut = () => Response.json({ error: 'identity-required' }, { status: 401 });

describe('a tab of the console is of one account (FRU-210)', () => {
  it('stops when « Continue » finds another account, and sends nothing of what was typed', async () => {
    const api = await tab();
    let me = () => Response.json(ANA);
    const sent = worker({ me: () => me(), routes: { 'POST /console/workspaces/ws_1/sites': signedOut } });
    const told: string[] = [];
    api.onLeft((why) => told.push(why));
    assert.equal((await api.call('GET', '/console/me')).ok, true);

    // The session of Ana ended: her call is refused, and the banner shows over her screen.
    const refused = await api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://staging.acme.dev' });
    assert.equal(refused.ok, false);
    assert.deepEqual(told, []);
    // Bob signs in in another tab, and somebody presses « Continue » here.
    me = () => Response.json(BOB);
    assert.deepEqual(await api.call('GET', '/console/me', undefined, { quiet: true }), LEFT);
    assert.deepEqual(told, ['changed']);

    // The screen of Ana sends again what she typed: nothing leaves, with the cookie of Bob or any other.
    const before = sent.length;
    assert.deepEqual(
      await api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://staging.acme.dev' }),
      LEFT,
    );
    assert.deepEqual(await api.call('GET', '/console/workspaces/ws_1/sites'), LEFT);
    assert.deepEqual(await api.call('DELETE', '/console/workspaces/ws_1'), LEFT);
    assert.equal(sent.length, before);
    assert.deepEqual(told, ['changed'], 'told once');
    // Nor does it end the session of Bob, ask for a link, or spend one: those do not go through `call`.
    assert.equal(await api.signOut(), false);
    assert.deepEqual(await api.requestLink('ana@acme.dev', 'en'), LEFT);
    assert.deepEqual(await api.redeemLink('a-token'), LEFT);
    assert.equal(sent.length, before);
  });

  it('goes on when « Continue » finds the same account', async () => {
    const api = await tab();
    const sent = worker({ me: () => Response.json(ANA) });
    const told: string[] = [];
    api.onLeft((why) => told.push(why));
    await api.call('GET', '/console/me');

    assert.equal((await api.call('GET', '/console/me', undefined, { quiet: true })).ok, true);
    assert.equal((await api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://a.dev' })).ok, true);

    assert.deepEqual(told, []);
    assert.deepEqual(sent.at(-1), { method: 'POST', path: '/console/workspaces/ws_1/sites' });
  });

  it('stops a tab that comes back when another account signed in, and holds a change made in that moment', async () => {
    const api = await tab();
    let me = () => Response.json(ANA);
    const sent = worker({ me: () => me() });
    const told: string[] = [];
    api.onLeft((why) => told.push(why));
    await api.call('GET', '/console/me');
    me = () => Response.json(BOB);

    // The tab comes back, and a click lands before the worker said who is signed in.
    const asked = api.checkTab();
    const clicked = api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://a.dev' });
    await asked;

    assert.deepEqual(await clicked, LEFT);
    assert.deepEqual(told, ['changed']);
    assert.equal(sent.filter((each) => each.method !== 'GET').length, 0);
  });

  it('stops a tab that comes back when its session ended somewhere else', async () => {
    const api = await tab();
    let me = () => Response.json(ANA);
    const sent = worker({ me: () => me() });
    const told: string[] = [];
    api.onLeft((why) => told.push(why));
    await api.call('GET', '/console/me');
    me = signedOut;

    await api.checkTab();

    assert.deepEqual(told, ['ended']);
    const before = sent.length;
    assert.deepEqual(await api.call('GET', '/console/workspaces/ws_1/sites'), LEFT);
    assert.equal(sent.length, before);
  });

  it('keeps the screen of somebody whose own call was refused, when the tab comes back still signed out', async () => {
    const api = await tab();
    let me = () => Response.json(ANA);
    worker({ me: () => me(), routes: { 'POST /console/workspaces/ws_1/sites': signedOut } });
    const told: string[] = [];
    let banner = 0;
    api.onLeft((why) => told.push(why));
    api.onSignedOut(() => void (banner += 1));
    await api.call('GET', '/console/me');
    me = signedOut;

    // Ana was working: the banner is over her screen, which keeps what she typed (FRU-148).
    await api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://a.dev' });
    await api.checkTab();

    assert.equal(banner, 1);
    assert.deepEqual(told, []);
    // She signs in again in another tab, and goes on.
    me = () => Response.json(ANA);
    assert.equal((await api.call('GET', '/console/me', undefined, { quiet: true })).ok, true);
    assert.deepEqual(told, []);
  });

  it('says nothing of who is signed in when the worker does not answer, or fails', async () => {
    const api = await tab();
    let me = () => Response.json(ANA);
    worker({ me: () => me() });
    const told: string[] = [];
    api.onLeft((why) => told.push(why));
    await api.call('GET', '/console/me');

    me = () => Response.json({ error: 'store-unavailable' }, { status: 502 });
    await api.checkTab();
    me = () => {
      throw new TypeError('Failed to fetch');
    };
    await api.checkTab();

    assert.deepEqual(told, []);
  });

  it('asks nothing for a tab that was never of an account', async () => {
    const api = await tab();
    const sent = worker({ me: signedOut });

    await api.checkTab();

    assert.deepEqual(sent, []);
  });

  it('takes the account of a sign-in made in the tab itself, after a sign-out there', async () => {
    const api = await tab();
    let me = () => Response.json(ANA);
    worker({
      me: () => me(),
      routes: {
        'POST /console/auth/sign-out': () => Response.json({ success: true }),
        'POST /console/session/logout': () => new Response(null, { status: 204 }),
        'POST /console/auth/email/redeem': () => Response.json({ account: BOB.account }),
      },
    });
    const told: string[] = [];
    api.onLeft((why) => told.push(why));
    await api.call('GET', '/console/me');

    // Ana signs out here, and Bob opens his link in the same tab: the tab is his, and nothing of hers is on it.
    assert.equal(await api.signOut(), true);
    me = () => Response.json(BOB);
    assert.equal((await api.redeemLink('a-token')).ok, true);
    assert.equal((await api.call('GET', '/console/me')).ok, true);

    assert.deepEqual(told, []);
  });
});

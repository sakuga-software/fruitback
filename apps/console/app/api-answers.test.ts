import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

afterEach(() => {
  mock.restoreAll();
  for (const name of ['localStorage', 'sessionStorage']) Reflect.deleteProperty(globalThis, name);
});

/**
 * Three things `api.ts` does with an answer of the worker, which no test held (FRU-216): what it
 * reads as a session that ended, what it says of the mail when the worker did not say, and what it
 * keeps of a sign-in. `api.ts` remembers what the worker said, so each case loads it again.
 */
let loads = 0;
async function loaded(): Promise<typeof import('./api.ts')> {
  loads += 1;

  return (await import(`./api.ts?answers=${loads}`)) as typeof import('./api.ts');
}

/** A worker that answers each path as `routes` says, and keeps the path of every request. */
function worker(routes: Record<string, () => Response>): string[] {
  const sent: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const asked = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
    sent.push(asked);

    return routes[asked]?.() ?? Response.json({ error: 'not-found' }, { status: 404 });
  });

  return sent;
}

describe('what the console reads as a session that ended (FRU-148, FRU-216)', () => {
  it('reads a 401 as one, and no other refusal: not a 403, a 404, a 429 or a failure of the worker', async () => {
    const api = await loaded();
    let status = 401;
    worker({
      'POST /console/workspaces/ws_1/sites': () => Response.json({ error: 'a-refusal' }, { status }),
      'GET /console/workspaces/ws_1/sites': () => Response.json({ error: 'a-refusal' }, { status }),
    });
    let told = 0;
    api.onSignedOut(() => void (told += 1));

    // Somebody who may not do this, a thing that is gone, a limit, a worker that fails: the session
    // is still good, and a banner that said « your session ended » would send them to sign in for nothing.
    for (status of [400, 403, 404, 409, 429, 500, 502, 503]) {
      const written = await api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://a.dev' });
      const read = await api.call('GET', '/console/workspaces/ws_1/sites');
      assert.deepEqual(written, { ok: false, status, error: 'a-refusal' });
      assert.deepEqual(read, { ok: false, status, error: 'a-refusal' });
      assert.equal(told, 0, String(status));
    }
    // The control: a 401 is told, once for each call.
    status = 401;
    await api.call('POST', '/console/workspaces/ws_1/sites', { url: 'https://a.dev' });
    assert.equal(told, 1);
  });
});

describe('whether the worker sends mail, as the console reads it (FRU-104, FRU-216)', () => {
  const said = (email: unknown) => () => Response.json({ betterAuth: { email, github: false, google: false } });

  it('says so only when the worker said so, and takes nothing but true for it', async () => {
    for (const [email, sends] of [
      [true, true],
      [false, false],
      ['true', false],
      [1, false],
      [undefined, false],
    ] as const) {
      const api = await loaded();
      worker({ 'GET /auth/providers': said(email) });

      assert.equal(await api.sendsMail(), sends, String(email));
      mock.restoreAll();
    }
  });

  it('answers « no » while the worker refuses to say, and asks again at the next call', async () => {
    const api = await loaded();
    const sent = worker({ 'GET /auth/providers': () => Response.json({ error: 'rate-limited' }, { status: 429 }) });

    // The worker did not say. « No » is what the screen of the members reads then: it shows the
    // link to hand over, which is true whether or not a message went.
    assert.equal(await api.sendsMail(), false);
    assert.equal(await api.sendsMail(), false);
    // It did not keep that « no »: each call asked again.
    assert.deepEqual(sent, ['GET /auth/providers', 'GET /auth/providers']);

    mock.restoreAll();
    const again = worker({ 'GET /auth/providers': said(true) });
    assert.equal(await api.sendsMail(), true);
    // What the worker said is kept: nothing more is asked.
    assert.equal(await api.sendsMail(), true);
    assert.deepEqual(again, ['GET /auth/providers']);
  });

  it('answers « no » when the worker does not answer at all', async () => {
    const api = await loaded();
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });

    assert.equal(await api.sendsMail(), false);
  });
});

describe('what the console keeps of a sign-in (FRU-148, FRU-216)', () => {
  /** A storage of a browser that keeps every write it was asked. */
  function storage(written: string[], name: string): Storage {
    const kept = new Map<string, string>();

    return {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => {
        written.push(`${name}.setItem(${key}, ${value})`);
        kept.set(key, value);
      },
      removeItem: (key: string) => void kept.delete(key),
      clear: () => kept.clear(),
      key: () => null,
      get length() {
        return kept.size;
      },
    } as Storage;
  }

  it('writes nothing in the storage of the browser: the answer goes to the screen, and the session is a cookie', async () => {
    const written: string[] = [];
    Object.defineProperty(globalThis, 'localStorage', { value: storage(written, 'localStorage'), configurable: true });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: storage(written, 'sessionStorage'),
      configurable: true,
    });
    const api = await loaded();
    const account = { id: 'acc_1', email: 'alice@acme.dev' };
    const sent = worker({
      'POST /console/auth/email/redeem': () => Response.json({ account, token: 'a-token-the-worker-must-not-answer' }),
      'GET /console/me': () => Response.json({ account, workspaces: [] }),
      'POST /console/auth/sign-out': () => Response.json({ success: true }),
    });

    const redeemed = await api.redeemLink('the-token-of-a-link');
    await api.call('GET', '/console/me');
    await api.signOut();

    assert.equal(redeemed.ok, true);
    assert.deepEqual(written, []);
    assert.deepEqual(sent, ['POST /console/auth/email/redeem', 'GET /console/me', 'POST /console/auth/sign-out']);
    // The control: the storage is there, and a write in it is seen. `api.ts` keeps nothing in it
    // since the name of a workspace comes from the address of its person (FRU-239).
    globalThis.localStorage.setItem('a-key', 'a-value');
    assert.deepEqual(written, ['localStorage.setItem(a-key, a-value)']);
  });
});

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

afterEach(() => mock.restoreAll());

/**
 * Whether the worker signs anybody in, as the sign-in screen reads it (FRU-217). `api.ts` keeps what
 * the worker said, so each case loads it again.
 */
let loads = 0;
async function loaded(): Promise<typeof import('./api.ts')> {
  loads += 1;

  return (await import(`./api.ts?sign-in=${loads}`)) as typeof import('./api.ts');
}

function providers(answer: () => Response): { asked: number } {
  const count = { asked: 0 };
  mock.method(globalThis, 'fetch', async () => {
    count.asked += 1;

    return answer();
  });

  return count;
}

describe('whether the worker signs anybody in (FRU-217)', () => {
  it('says no for a worker that answers and offers nothing: accounts, and no secret for the cookie', async () => {
    for (const body of [{}, { github: true, google: true }, { betterAuth: null }, { betterAuth: 'yes' }]) {
      const api = await loaded();
      providers(() => Response.json(body));

      assert.equal(await api.offersSignIn(), false, JSON.stringify(body));
      mock.restoreAll();
    }
  });

  it('says nothing for an answer with no body: it is not a worker that said what it offers', async () => {
    const api = await loaded();
    providers(() => new Response(null, { status: 204 }));

    assert.equal(await api.offersSignIn(), undefined);
  });

  it('says yes for a worker that says betterAuth, whatever it offers there', async () => {
    for (const betterAuth of [{ email: true, github: false, google: false }, { email: false }, {}]) {
      const api = await loaded();
      providers(() => Response.json({ betterAuth }));

      assert.equal(await api.offersSignIn(), true, JSON.stringify(betterAuth));
      mock.restoreAll();
    }
  });

  it('says nothing while the worker refuses or does not answer, and asks again: the form stays', async () => {
    const api = await loaded();
    const refused = providers(() => Response.json({ error: 'rate-limited' }, { status: 429 }));
    assert.equal(await api.offersSignIn(), undefined);
    assert.equal(await api.offersSignIn(), undefined);
    assert.equal(refused.asked, 2);

    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    assert.equal(await api.offersSignIn(), undefined);

    mock.restoreAll();
    const said = providers(() => Response.json({ betterAuth: { email: true } }));
    assert.equal(await api.offersSignIn(), true);
    assert.equal(await api.offersSignIn(), true);
    assert.equal(said.asked, 1, 'what the worker said is kept');
  });
});

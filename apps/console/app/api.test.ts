import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNREACHABLE,
  call,
  callUntilAnswered,
  onReachability,
  redeemLink,
  refresh,
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
    assert.equal(await refresh(), false);
    await signOut();
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

describe('the providers the worker signs people in with (FRU-135)', () => {
  it('says which are on when the worker answers, and takes nothing but true for on', async () => {
    mock.method(globalThis, 'fetch', async () => Response.json({ github: true, google: 'true' }));

    assert.deepEqual(await signInProviders(), { github: true, google: false });
  });

  it('says nothing when the worker did not say, so no screen calls a provider not set up', async () => {
    down();
    assert.equal(await signInProviders(), undefined);

    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => Response.json({ error: 'not-found' }, { status: 404 }));
    assert.equal(await signInProviders(), undefined);
  });
});

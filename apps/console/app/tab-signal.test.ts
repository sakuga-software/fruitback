import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Channel, announceSignIn, awaitSignIn } from './tab-signal.ts';

/**
 * Tabs of one browser, as channels that hear each other and never themselves: what a
 * `BroadcastChannel` does. `said` keeps every message, in order.
 */
function browser() {
  const tabs = new Set<Channel>();
  const said: unknown[] = [];
  const make = (): Channel => {
    const channel: Channel = {
      onmessage: null,
      postMessage(message) {
        said.push(message);
        for (const other of tabs) if (other !== channel) queueMicrotask(() => other.onmessage?.({ data: message }));
      },
      close() {
        tabs.delete(channel);
      },
    };
    tabs.add(channel);

    return channel;
  };

  return { make, said, tabs };
}

const SHORT = { heard: 30, carried: 120 };

describe('the tabs of one browser, when a sign-in link is opened (FRU-235)', () => {
  it('lets the tab that waited carry on, and tells the tab of the link', async () => {
    const { make, said } = browser();
    let carried = 0;
    const stop = awaitSignIn(
      async () => true,
      () => (carried += 1),
      make,
    );

    assert.equal(await announceSignIn(make, SHORT), true);
    assert.equal(carried, 1);
    assert.deepEqual(said, ['signed-in', 'heard', 'carried-on']);
    stop();
  });

  it('answers that no tab carried on when the link is opened alone', async () => {
    const { make, tabs } = browser();

    assert.equal(await announceSignIn(make, SHORT), false);
    // The channel is closed: a tab that is the console listens to nothing.
    assert.equal(tabs.size, 0);
  });

  it('does not carry on when the worker says that nobody is signed in', async () => {
    const { make, said } = browser();
    let carried = 0;
    const stop = awaitSignIn(
      async () => false,
      () => (carried += 1),
      make,
    );

    assert.equal(await announceSignIn(make, SHORT), false);
    assert.equal(carried, 0);
    // It heard, and never said that it carried on.
    assert.deepEqual(said, ['signed-in', 'heard']);
    stop();
  });

  it('waits the time of a call for a tab that heard, and no longer', async () => {
    const { make } = browser();
    const later = (ms: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms));
    // Slower than « heard », faster than « carried »: the tab of the link still learns it.
    const stopOne = awaitSignIn(
      () => later(60),
      () => {},
      make,
    );
    assert.equal(await announceSignIn(make, SHORT), true);
    stopOne();

    // Slower than both: the tab of the link becomes the console.
    const stopTwo = awaitSignIn(
      () => later(400),
      () => {},
      make,
    );
    assert.equal(await announceSignIn(make, SHORT), false);
    stopTwo();
  });

  it('carries on at no message but « signed-in », and a stopped tab carries on at none', async () => {
    const { make } = browser();
    let asked = 0;
    const stop = awaitSignIn(
      async () => ((asked += 1), true),
      () => {},
      make,
    );
    const stranger = make();
    for (const message of ['carried-on', 'heard', { kind: 'signed-in' }, 'signed-in ', 42, null]) {
      stranger.postMessage(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked, 0);

    // The control: the same stranger is heard when it says the word.
    stranger.postMessage('signed-in');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked, 1);

    stop();
    stranger.postMessage('signed-in');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked, 1);
  });

  it('is the console at once in a browser with no channel', async () => {
    assert.equal(await announceSignIn(() => undefined, SHORT), false);
    assert.doesNotThrow(() =>
      awaitSignIn(
        async () => true,
        () => {},
        () => undefined,
      )(),
    );
  });
});

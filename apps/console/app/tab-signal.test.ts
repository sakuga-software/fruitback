import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type Channel, type Locks, announceSignIn, awaitSignIn } from './tab-signal.ts';

/**
 * Tabs of one browser, as channels that hear each other and never themselves: what a
 * `BroadcastChannel` does. `said` keeps every message, in order. `late` is how long the browser takes
 * to deliver one (FRU-732). `locks` is the lock of the tabs that wait, as `navigator.locks` holds it.
 */
function browser(late = 0) {
  const tabs = new Set<Channel>();
  const said: unknown[] = [];
  let holders = 0;
  const locks: Locks = {
    hold() {
      holders += 1;
      let held = true;

      return () => {
        if (held) holders -= 1;
        held = false;
      };
    },
    held: async () => holders > 0,
  };
  const deliver = (task: () => void) => (late === 0 ? queueMicrotask(task) : setTimeout(task, late));
  const make = (): Channel => {
    const channel: Channel = {
      onmessage: null,
      postMessage(message) {
        said.push(message);
        for (const other of tabs) if (other !== channel) deliver(() => other.onmessage?.({ data: message }));
      },
      close() {
        tabs.delete(channel);
      },
    };
    tabs.add(channel);

    return channel;
  };

  return { make, said, tabs, locks, holders: () => holders };
}

const SHORT = { heard: 30, carried: 120 };

describe('the tabs of one browser, when a sign-in link is opened (FRU-235)', () => {
  it('lets the tab that waited carry on, and tells the tab of the link', async () => {
    const { make, said, locks } = browser();
    let carried = 0;
    const stop = awaitSignIn(
      async () => true,
      () => (carried += 1),
      make,
      locks,
    );

    assert.equal(await announceSignIn(make, SHORT, locks), true);
    assert.equal(carried, 1);
    assert.deepEqual(said, ['signed-in', 'heard', 'carried-on']);
    stop();
  });

  it('answers that no tab carried on when the link is opened alone', async () => {
    const { make, tabs, locks } = browser();

    assert.equal(await announceSignIn(make, SHORT, locks), false);
    // The channel is closed: a tab that is the console listens to nothing.
    assert.equal(tabs.size, 0);
  });

  it('does not carry on when the worker says that nobody is signed in', async () => {
    const { make, said, locks } = browser();
    let carried = 0;
    const stop = awaitSignIn(
      async () => false,
      () => (carried += 1),
      make,
      locks,
    );

    assert.equal(await announceSignIn(make, SHORT, locks), false);
    assert.equal(carried, 0);
    // It heard, and never said that it carried on.
    assert.deepEqual(said, ['signed-in', 'heard']);
    stop();
  });

  it('waits the time of a call for a tab that heard, and no longer', async () => {
    const { make, locks } = browser();
    const later = (ms: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), ms));
    // Slower than « heard », faster than « carried »: the tab of the link still learns it.
    const stopOne = awaitSignIn(
      () => later(60),
      () => {},
      make,
      locks,
    );
    assert.equal(await announceSignIn(make, SHORT, locks), true);
    stopOne();

    // Slower than both: the tab of the link becomes the console.
    const stopTwo = awaitSignIn(
      () => later(400),
      () => {},
      make,
      locks,
    );
    assert.equal(await announceSignIn(make, SHORT, locks), false);
    stopTwo();
  });

  it('carries on at no message but « signed-in », and a stopped tab carries on at none', async () => {
    const { make, locks } = browser();
    let asked = 0;
    const stop = awaitSignIn(
      async () => ((asked += 1), true),
      () => {},
      make,
      locks,
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

  it('gives « heard » the time of a call when a tab holds the lock of the tabs that wait (FRU-732)', async () => {
    // The browser delivers each message after 40 ms, so « heard » comes back at 80 ms: later than
    // « heard » (30 ms), sooner than « carried » (120 ms).
    const { make, locks, holders } = browser(40);
    let carried = 0;
    const stop = awaitSignIn(
      async () => true,
      () => (carried += 1),
      make,
      locks,
    );
    assert.equal(holders(), 1);

    assert.equal(await announceSignIn(make, SHORT, locks), true);
    assert.equal(carried, 1);
    stop();
    // A tab that stopped holds the lock no more: a link opened now waits only for « heard ».
    assert.equal(holders(), 0);
  });

  it('is the console after « heard » when no tab says that it waits, on the same slow browser', async () => {
    // The control of the case above: the same tab and the same delay, with locks that nobody holds,
    // as in a browser with no `navigator.locks`.
    const { make } = browser(40);
    const nobody: Locks = { hold: () => () => {}, held: async () => false };
    const stop = awaitSignIn(
      async () => true,
      () => {},
      make,
      nobody,
    );

    assert.equal(await announceSignIn(make, SHORT, nobody), false);
    stop();
  });

  it('is the console at once in a browser with no channel', async () => {
    const { locks } = browser();
    assert.equal(await announceSignIn(() => undefined, SHORT, locks), false);
    assert.doesNotThrow(() =>
      awaitSignIn(
        async () => true,
        () => {},
        () => undefined,
      )(),
    );
  });
});

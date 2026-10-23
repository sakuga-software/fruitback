import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Answer, ExtensionBrowser } from './api.ts';
import { CLOCK_MARGIN_MS, CONNECTED_EVERY_MS, newlyConnected, watchConnection } from './connect-watch.ts';

const OPENED = Date.parse('2026-10-23T12:00:00Z');

function browser(id: string, connectedAt: string): ExtensionBrowser {
  return { id, browser: 'Chrome on macOS', connectedAt, usedAt: connectedAt };
}

const OLD = browser('ext_old', '2026-10-01T09:00:00Z');
const NEW = browser('ext_new', '2026-10-23T12:01:00Z');

describe('the browser that connected since /connect opened (FRU-410)', () => {
  it('is a browser that was not in the first list', () => {
    assert.equal(newlyConnected([OLD], new Set(['ext_old']), OPENED), undefined);
    assert.equal(newlyConnected([OLD, NEW], new Set(['ext_old']), OPENED), NEW);
  });

  it('with no first list, is a browser connected after the page opened, less the margin of the clocks', () => {
    assert.equal(newlyConnected([OLD], undefined, OPENED), undefined);
    assert.equal(newlyConnected([OLD, NEW], undefined, OPENED), NEW);
    const justBefore = browser('ext_skew', new Date(OPENED - CLOCK_MARGIN_MS + 1_000).toISOString());
    assert.equal(newlyConnected([justBefore], undefined, OPENED), justBefore);
    const tooEarly = browser('ext_early', new Date(OPENED - CLOCK_MARGIN_MS - 1_000).toISOString());
    assert.equal(newlyConnected([tooEarly], undefined, OPENED), undefined);
  });
});

/** A document whose tab is shown or hidden on demand. */
function fakePage() {
  const listeners = new Set<() => void>();
  const page = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: 'visibilitychange', listener: () => void) => void listeners.add(listener),
    removeEventListener: (_: 'visibilitychange', listener: () => void) => void listeners.delete(listener),
    show(state: DocumentVisibilityState) {
      page.visibilityState = state;
      for (const listener of listeners) listener();
    },
    listeners,
  };

  return page;
}

/** Lets the promises of the reads settle. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('watching for a browser that connects (FRU-410)', () => {
  let answers: Answer<ExtensionBrowser[]>[];
  let reads: number;
  const read = (): Promise<Answer<ExtensionBrowser[]>> => {
    reads += 1;
    // The last answer stays: every read after it gets it again.
    const next = answers.length > 1 ? answers.shift() : answers[0];

    return next === undefined ? Promise.reject(new Error('no answer')) : Promise.resolve(next);
  };

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout'] });
    reads = 0;
  });
  afterEach(() => mock.timers.reset());

  it('reads at once, then every ten seconds, and stops at the first browser that connects', async () => {
    answers = [
      { ok: true, data: [OLD] },
      { ok: true, data: [OLD] },
      { ok: true, data: [OLD, NEW] },
    ];
    const connected: ExtensionBrowser[] = [];
    const page = fakePage();
    watchConnection({ read, page, now: () => OPENED, onConnected: (found) => connected.push(found) });
    await settle();
    assert.equal(reads, 1);
    mock.timers.tick(CONNECTED_EVERY_MS - 1);
    await settle();
    assert.equal(reads, 1);
    mock.timers.tick(1);
    await settle();
    assert.equal(reads, 2);
    assert.deepEqual(connected, []);
    mock.timers.tick(CONNECTED_EVERY_MS);
    await settle();
    assert.equal(reads, 3);
    assert.deepEqual(connected, [NEW]);
    // Found: nothing is read any more.
    mock.timers.tick(CONNECTED_EVERY_MS * 4);
    page.show('visible');
    await settle();
    assert.equal(reads, 3);
  });

  it('does not take a browser of the first list for one that just connected', async () => {
    answers = [{ ok: true, data: [OLD, NEW] }];
    const connected: ExtensionBrowser[] = [];
    watchConnection({ read, page: fakePage(), now: () => OPENED, onConnected: (found) => connected.push(found) });
    await settle();
    for (let round = 0; round < 3; round += 1) {
      mock.timers.tick(CONNECTED_EVERY_MS);
      await settle();
    }
    assert.equal(reads, 4);
    assert.deepEqual(connected, []);
  });

  it('asks nothing while the tab is hidden, and asks at once when it is shown again', async () => {
    answers = [
      { ok: true, data: [] },
      { ok: true, data: [] },
      { ok: true, data: [NEW] },
    ];
    const connected: ExtensionBrowser[] = [];
    const page = fakePage();
    watchConnection({ read, page, now: () => OPENED, onConnected: (found) => connected.push(found) });
    await settle();
    assert.equal(reads, 1);
    page.show('hidden');
    mock.timers.tick(CONNECTED_EVERY_MS * 10);
    await settle();
    assert.equal(reads, 1);
    page.show('visible');
    await settle();
    assert.equal(reads, 2);
    mock.timers.tick(CONNECTED_EVERY_MS);
    await settle();
    assert.equal(reads, 3);
    assert.deepEqual(connected, [NEW]);
  });

  it('keeps reading through a refusal: the person may sign in from the other tab', async () => {
    answers = [
      { ok: false, status: 401, error: 'unauthorized' },
      { ok: true, data: [OLD] },
      { ok: true, data: [OLD, NEW] },
    ];
    const connected: ExtensionBrowser[] = [];
    watchConnection({ read, page: fakePage(), now: () => OPENED, onConnected: (found) => connected.push(found) });
    await settle();
    mock.timers.tick(CONNECTED_EVERY_MS);
    await settle();
    // Signed in since: the browser connected long ago is not taken for this one.
    assert.deepEqual(connected, []);
    mock.timers.tick(CONNECTED_EVERY_MS);
    await settle();
    assert.equal(reads, 3);
    assert.deepEqual(connected, [NEW]);
  });

  it('keeps reading after a read that throws', async () => {
    const connected: ExtensionBrowser[] = [];
    let calls = 0;
    const throwing = (): Promise<Answer<ExtensionBrowser[]>> => {
      calls += 1;
      if (calls === 2) return Promise.reject(new TypeError('Failed to fetch'));

      return Promise.resolve({ ok: true, data: calls < 3 ? [OLD] : [OLD, NEW] });
    };
    watchConnection({
      read: throwing,
      page: fakePage(),
      now: () => OPENED,
      onConnected: (found) => connected.push(found),
    });
    await settle();
    for (let round = 0; round < 2; round += 1) {
      mock.timers.tick(CONNECTED_EVERY_MS);
      await settle();
    }
    assert.equal(calls, 3);
    assert.deepEqual(connected, [NEW]);
  });

  it('stops when the page goes away', async () => {
    answers = [{ ok: true, data: [] }];
    const page = fakePage();
    const stop = watchConnection({ read, page, now: () => OPENED, onConnected: () => assert.fail('connected') });
    await settle();
    stop();
    assert.equal(page.listeners.size, 0);
    mock.timers.tick(CONNECTED_EVERY_MS * 3);
    await settle();
    assert.equal(reads, 1);
  });
});

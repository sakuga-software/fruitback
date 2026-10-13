import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SessionResponse } from './session.ts';
import { type StorageArea, createStoredSessions } from './session-storage.ts';
import { storage } from './session-storage.fixture.ts';
import { previewsKey } from './proven-previews.ts';
import { createSessionPreviews } from './session-previews.ts';

/**
 * The previews a worker listed end with the session that asked (FRU-103).
 *
 * `session-storage.test.ts` tests which keys name a session that started or ended. This file tests
 * what the background does with them, over the sessions and the storage it uses: a pairing and a
 * logout are made by the real `Sessions`, each write of the area reaches the handler as a change of
 * `chrome.storage` does, and the list is forgotten by the real `rememberPreviews`.
 *
 * `wxt/browser` reads `globalThis.chrome` when it is imported, so the global is set before the import.
 */

const WORKER = 'https://worker.test';
const OTHER = 'https://other.test';
const CODE = 'ABCD-EFGH-JKMN';
const NOW = 1_700_000_000_000;
const PREVIEWS = 'https://*.preview.acme.dev';
const RULE = { mode: 'team', endpoint: WORKER, enabled: true, mount: { clientId: 'site_1' } } as const;

const fake = storage();
/** What listens to the changes of the area, as `storage.onChanged` of the background. */
let listener: (keys: string[]) => Promise<void> = async () => {};
let handled: Promise<void>[] = [];
/** The area, where each write is also a change that the listener hears, with the keys of that write. */
const local: StorageArea = {
  get: (keys) => fake.area.get(keys),
  async set(items) {
    await fake.area.set(items);
    handled.push(listener(Object.keys(items)));
  },
  async remove(key) {
    await fake.area.remove(key);
    handled.push(listener([key]));
  },
};
(globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'fruitback' }, storage: { local } };
const { readFreshPreviews, rememberPreviews } = await import('./sites.ts');

const post = async (url: string): Promise<SessionResponse> => {
  const identity = { subject: 'u_1', name: 'Alex' };
  if (url.endsWith('/session/pair')) {
    return { status: 200, body: { accessToken: 'access.1', refreshToken: 'refresh.1', expiresIn: 600, identity } };
  }
  if (url.endsWith('/session/refresh')) {
    return { status: 200, body: { accessToken: 'access.2', refreshToken: 'refresh.2', expiresIn: 600, identity } };
  }
  if (url.endsWith('/session/revoke')) return { status: 200, body: {} };

  throw new Error(`the worker was asked ${url}`);
};

/** A browser with one rule for the previews, the sessions of a context, and the handler listening. */
async function browserWith(more: { forget?: (endpoint: string) => Promise<void> } = {}) {
  for (const key of Object.keys(fake.read())) await fake.area.remove(key);
  await fake.area.set({ sites: { [PREVIEWS]: RULE } });
  const session = storage();
  const sessionsAt = (now: number) =>
    createStoredSessions(
      () => local,
      () => session.area,
      post,
      { now: () => now },
    );
  const steps: string[] = [];
  const reported: unknown[] = [];
  handled = [];
  listener = createSessionPreviews({
    forget: async (endpoint) => {
      await (more.forget ?? ((each) => rememberPreviews(each, undefined)))(endpoint);
      steps.push(`forget ${endpoint}`);
    },
    ask: async () => void steps.push('ask'),
    report: (error) => void reported.push(error),
  });
  /** Every change heard so far, handled to its end. */
  const settled = async () => {
    while (handled.length > 0) await handled.shift();
  };
  /** What the worker listed for a session, as `cloud.ts` keeps it. */
  const list = async (endpoint = WORKER) => {
    await rememberPreviews(endpoint, { at: Date.now(), previews: { [PREVIEWS]: 'site_1' } });
    await settled();
    steps.length = 0;
  };
  const grants = async () => Object.keys((await readFreshPreviews())[WORKER] ?? {});

  return { sessionsAt, steps, reported, settled, list, grants };
}

describe('the previews of a worker, when its session starts or ends (FRU-103)', () => {
  it('forgets the list at a logout, then asks the workers again', async () => {
    const browser = await browserWith();
    const popup = browser.sessionsAt(NOW);
    await popup.pair(WORKER, CODE);
    await browser.list();
    assert.deepEqual(await browser.grants(), [PREVIEWS], 'the control: the list grants before the logout');

    await popup.logout(WORKER);
    await browser.settled();

    assert.deepEqual(await browser.grants(), []);
    assert.equal(Object.hasOwn(fake.read(), previewsKey(WORKER)), false);
    assert.deepEqual(browser.steps, [`forget ${WORKER}`, 'ask'], 'forgotten first, then asked, once');
  });

  it('forgets the list at a pairing: the account that pairs may be of another workspace', async () => {
    const browser = await browserWith();
    // What a session of before left, with no logout between: the list is still there.
    await browser.list();

    assert.partialDeepStrictEqual(await browser.sessionsAt(NOW).pair(WORKER, CODE), { ok: true });
    await browser.settled();

    assert.deepEqual(await browser.grants(), []);
    assert.deepEqual(browser.steps, [`forget ${WORKER}`, 'ask']);
  });

  it('keeps the list through a refresh, which stores a new token and ends nothing', async () => {
    const browser = await browserWith();
    await browser.sessionsAt(NOW).pair(WORKER, CODE);
    await browser.list();

    // Ten minutes on, the grant is stale: asking for access rotates the refresh token.
    const background = browser.sessionsAt(NOW + 10 * 60_000);
    assert.partialDeepStrictEqual(await background.ensureAccess(WORKER), {
      ok: true,
      grant: { accessToken: 'access.2' },
    });
    await browser.settled();

    assert.deepEqual(await browser.grants(), [PREVIEWS]);
    assert.deepEqual(browser.steps, [], 'a refresh forgets nothing and asks nothing');
  });

  it('forgets the list of the worker whose session ended, and of no other', async () => {
    const browser = await browserWith();
    const popup = browser.sessionsAt(NOW);
    await popup.pair(WORKER, CODE);
    await popup.pair(OTHER, CODE);
    await browser.list(WORKER);
    await browser.list(OTHER);

    await popup.logout(OTHER);
    await browser.settled();

    assert.deepEqual(await browser.grants(), [PREVIEWS]);
    assert.equal(Object.hasOwn(fake.read(), previewsKey(OTHER)), false);
    assert.deepEqual(browser.steps, [`forget ${OTHER}`, 'ask']);
  });

  it('asks the workers again when the list could not be forgotten, and says so', async () => {
    const browser = await browserWith({
      forget: async () => {
        throw new Error('the storage refused');
      },
    });
    const popup = browser.sessionsAt(NOW);
    await popup.pair(WORKER, CODE);
    await browser.settled();

    assert.deepEqual(browser.steps, ['ask']);
    assert.equal(browser.reported.length, 1);
  });

  it('is what the background calls for each change of the local area', () => {
    const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');
    const heard = /browser\.storage\.onChanged\.addListener\(\(changes, area\) => \{([\s\S]*?)\n  \}\);/.exec(
      background,
    )?.[1];

    assert.ok(heard, 'the background listens to the changes of storage');
    assert.match(heard, /if \(area !== 'local'\) return;/);
    assert.match(heard, /void sessionPreviews\(Object\.keys\(changes\)\);/);
    assert.match(
      background,
      /createSessionPreviews\(\{\s*forget: \(endpoint\) => rememberPreviews\(endpoint, undefined\),\s*ask: refreshProven,/,
    );
  });
});

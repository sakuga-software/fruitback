import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import {
  CHECK_EVERY_MS,
  RETRY_AFTER_MS,
  type ReleaseCheckDeps,
  WORKER_VERSION,
  isNewer,
  parseRelease,
  releaseCheck,
} from './release.ts';

/** The last release, for the screen « Instance » of the administrator (FRU-520). */

const PAGE = 'https://github.com/sakuga-software/fruitback/releases/tag/v0.7.0';
const RELEASE = { tag_name: 'v0.7.0', html_url: PAGE };

function check(overrides: Partial<ReleaseCheckDeps> & { answer?: () => Promise<unknown> } = {}) {
  const clock = { now: Date.UTC(2026, 10, 2, 12) };
  const calls = { fetches: 0 };
  const { answer = async () => RELEASE, ...rest } = overrides;
  const latest = releaseCheck({
    running: '0.6.0',
    now: () => clock.now,
    fetchLatest: async () => {
      calls.fetches += 1;

      return answer();
    },
    ...rest,
  });

  return { latest, clock, calls };
}

/** Lets a question that runs behind a visit end. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the version of the worker', () => {
  it('is the one of its package, which the release sets', () => {
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

    assert.equal(WORKER_VERSION, own.version);
    assert.match(WORKER_VERSION, /^\d+\.\d+\.\d+$/);
  });
});

describe('isNewer and parseRelease', () => {
  it('compares the numbers, and never a version that is not « 1.2.3 »', () => {
    assert.equal(isNewer('0.7.0', '0.6.0'), true);
    assert.equal(isNewer('0.10.0', '0.9.1'), true);
    assert.equal(isNewer('0.6.0', '0.6.0'), false);
    assert.equal(isNewer('0.5.9', '0.6.0'), false);
    assert.equal(isNewer('0.7.0-rc.1', '0.6.0'), false);
    assert.equal(isNewer('0.7.0', 'edge'), false);
  });

  it('takes the tag and the page of a release of the repository, and nothing else', () => {
    assert.deepEqual(parseRelease(RELEASE), { version: '0.7.0', url: PAGE });
    assert.equal(
      parseRelease({ ...RELEASE, html_url: 'https://example.com/sakuga-software/fruitback/releases/' }),
      undefined,
    );
    assert.equal(parseRelease({ ...RELEASE, tag_name: 'nightly' }), undefined);
    assert.equal(parseRelease({ tag_name: 'v0.7.0' }), undefined);
    assert.equal(parseRelease('v0.7.0'), undefined);
    assert.equal(parseRelease(null), undefined);
  });
});

describe('releaseCheck', () => {
  it('gives a newer release, and asks GitHub once a day', async () => {
    const { latest, clock, calls } = check();

    assert.deepEqual(await latest(), { version: '0.7.0', url: PAGE });
    clock.now += CHECK_EVERY_MS - 1;
    assert.deepEqual(await latest(), { version: '0.7.0', url: PAGE });
    assert.equal(calls.fetches, 1);
    clock.now += 1;
    await latest();
    assert.equal(calls.fetches, 2);
  });

  it('gives nothing when the worker runs the last release, or a newer one', async () => {
    assert.equal(await check({ running: '0.7.0' }).latest(), undefined);
    assert.equal(await check({ running: '0.8.0' }).latest(), undefined);
  });

  it('shares one request between two visits at the same time', async () => {
    let release: (value: unknown) => void = () => {};
    const { latest, calls } = check({ answer: () => new Promise((resolve) => (release = resolve)) });
    const both = Promise.all([latest(), latest()]);
    release(RELEASE);

    assert.deepEqual(await both, [
      { version: '0.7.0', url: PAGE },
      { version: '0.7.0', url: PAGE },
    ]);
    assert.equal(calls.fetches, 1);
  });

  it('after a failure, keeps what it knew and asks again an hour later', async () => {
    let fail = false;
    const { latest, clock, calls } = check({
      answer: async () => {
        if (fail) throw new Error('offline');

        return RELEASE;
      },
    });
    await latest();
    fail = true;
    clock.now += CHECK_EVERY_MS;

    assert.deepEqual(await latest(), { version: '0.7.0', url: PAGE });
    await settled();
    assert.deepEqual(await latest(), { version: '0.7.0', url: PAGE }, 'the failure forgot the release');
    clock.now += RETRY_AFTER_MS - 1;
    await latest();
    assert.equal(calls.fetches, 2, 'it asked again before the hour');
    clock.now += 1;
    await latest();
    assert.equal(calls.fetches, 3);
  });

  it('counts an answer it cannot read as a failure', async () => {
    const { latest, clock, calls } = check({ answer: async () => ({ message: 'Not Found' }) });

    assert.equal(await latest(), undefined);
    clock.now += RETRY_AFTER_MS;
    await latest();
    assert.equal(calls.fetches, 2);
  });

  it('holds only the first visit of the process: a later question runs behind the visit', async () => {
    let answer: () => Promise<unknown> = async () => ({ ...RELEASE, tag_name: 'v0.6.1', html_url: `${PAGE}1` });
    const { latest, clock, calls } = check({ answer: () => answer() });
    assert.equal((await latest())?.version, '0.6.1', 'the first visit did not wait for its answer');

    let release: (value: unknown) => void = () => {};
    answer = () => new Promise((resolve) => (release = resolve));
    clock.now += CHECK_EVERY_MS;
    assert.equal((await latest())?.version, '0.6.1', 'a later visit waited for GitHub, or lost what was known');
    assert.equal(calls.fetches, 2);

    release(RELEASE);
    await settled();
    assert.equal((await latest())?.version, '0.7.0');
    assert.equal(calls.fetches, 2);
  });

  it('stops waiting for a GitHub that does not answer, even when the request ignores its signal', async () => {
    const { latest } = check({ answer: () => new Promise(() => {}), timeoutMs: 20 });
    const started = Date.now();

    assert.equal(await latest(), undefined);
    assert.ok(Date.now() - started < 1000);
  });
});

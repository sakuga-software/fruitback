import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeRead } from './read-probe.ts';

const SITE = { endpoint: 'https://worker.test/fruitback', clientId: 'acme co' };
const PAGE = 'https://staging.acme.dev/pricing?tab=annual';

function answering(status: number) {
  const asked: string[] = [];

  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);

      return { status, ok: status >= 200 && status < 300 };
    },
  };
}

describe('probeRead (FRU-66)', () => {
  it('asks the read the widget asks, for this page and this client', async () => {
    const seams = answering(200);

    assert.equal(await probeRead(SITE, PAGE, seams), 'answers');
    assert.deepEqual(seams.asked, [
      'https://worker.test/fruitback/feedback?url=https%3A%2F%2Fstaging.acme.dev%2Fpricing%3Ftab%3Dannual&client=acme%20co',
    ]);
  });

  it('says the worker wants a session on a 401, and on nothing else', async () => {
    assert.equal(await probeRead(SITE, PAGE, answering(401)), 'wants-a-session');

    for (const status of [403, 429, 500, 502, 503]) {
      assert.equal(await probeRead(SITE, PAGE, answering(status)), 'unknown', `status ${status}`);
    }
  });

  it('says nothing about a worker that cannot be reached', async () => {
    const unreachable = {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    };

    assert.equal(await probeRead(SITE, PAGE, unreachable), 'unknown');
  });
});

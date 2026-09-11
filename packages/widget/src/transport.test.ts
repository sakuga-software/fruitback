import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { type TransportRequest, fetchTransport } from './transport.ts';

afterEach(() => mock.restoreAll());

/** Records what `fetch` was handed, and answers with what the test asked for. */
function stubFetch(response: () => Response) {
  const seen: [string, RequestInit | undefined][] = [];
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    seen.push([url, init]);

    return response();
  });

  return seen;
}

const READ: TransportRequest = { url: 'https://worker.test/feedback?url=x', method: 'GET', headers: {} };

describe('fetchTransport', () => {
  it('answers with the status, whether or not the call succeeded', async () => {
    stubFetch(() => new Response('{"issues":[]}', { status: 200 }));
    assert.deepEqual(await fetchTransport(READ), { ok: true, status: 200, body: '{"issues":[]}' });

    mock.restoreAll();
    stubFetch(() => new Response('{"error":"identity-required"}', { status: 401 }));
    assert.deepEqual(await fetchTransport(READ), {
      ok: false,
      status: 401,
      body: '{"error":"identity-required"}',
    });
  });

  it('sends no body on a read, because a GET with one is refused by some proxies', async () => {
    const seen = stubFetch(() => new Response('{}', { status: 200 }));
    await fetchTransport(READ);

    assert.equal(Object.hasOwn(seen[0]?.[1] ?? {}, 'body'), false);
  });

  it('passes the body through on a write', async () => {
    const seen = stubFetch(() => new Response('{}', { status: 201 }));
    await fetchTransport({
      url: 'https://worker.test/feedback',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"note":"hello"}',
    });

    assert.equal(seen[0]?.[1]?.body, '{"note":"hello"}');
    assert.deepEqual(seen[0]?.[1]?.headers, { 'Content-Type': 'application/json' });
  });

  /**
   * A worker nobody can reach rejects rather than answering `ok: false`. `embed.ts` catches both the
   * same way, and a transport that swallowed this would hide an outage behind an empty page.
   */
  it('lets a network failure reject', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });

    await assert.rejects(() => fetchTransport(READ));
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANNEL, parseBridgeMessage, parseRelayRequest, parseRelayResponse } from './protocol.ts';

describe('parseBridgeMessage', () => {
  it('accepts a mount the isolated world sent', () => {
    const parsed = parseBridgeMessage({
      channel: CHANNEL,
      kind: 'mount',
      endpoint: 'https://feedback.acme.dev',
      clientId: 'acme',
      label: 'Feedback',
    });

    assert.deepEqual(parsed, {
      channel: CHANNEL,
      kind: 'mount',
      endpoint: 'https://feedback.acme.dev',
      clientId: 'acme',
      label: 'Feedback',
    });
  });

  it('leaves an absent label absent rather than making it empty', () => {
    const parsed = parseBridgeMessage({
      channel: CHANNEL,
      kind: 'mount',
      endpoint: 'https://feedback.acme.dev',
      clientId: 'acme',
    });

    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ['channel', 'clientId', 'endpoint', 'kind']);
  });

  it('accepts a ready, which travels the other way', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'ready' }), { channel: CHANNEL, kind: 'ready' });
  });

  it('accepts an unmount', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'unmount' }), { channel: CHANNEL, kind: 'unmount' });
  });

  // The page shares this channel. Everything below is something a hostile site can post, and each
  // one that got through would let it mount our widget against a worker of its choosing.
  it('refuses anything that is not ours', () => {
    for (const hostile of [
      undefined,
      null,
      'fruitback-extension',
      42,
      {},
      { channel: 'something-else', kind: 'mount', endpoint: 'https://a.dev', clientId: 'acme' },
      { channel: CHANNEL },
      { channel: CHANNEL, kind: 'mount' },
      { channel: CHANNEL, kind: 'evaluate', code: 'alert(1)' },
      { channel: CHANNEL, kind: 'mount', endpoint: 'https://a.dev' },
      { channel: CHANNEL, kind: 'mount', clientId: 'acme' },
      { channel: CHANNEL, kind: 'mount', endpoint: '', clientId: 'acme' },
      { channel: CHANNEL, kind: 'mount', endpoint: 'https://a.dev', clientId: '' },
      { channel: CHANNEL, kind: 'mount', endpoint: 7, clientId: 'acme' },
    ]) {
      assert.equal(parseBridgeMessage(hostile), undefined, `accepted ${JSON.stringify(hostile)}`);
    }
  });

  it('refuses an endpoint on a scheme no worker answers on', () => {
    for (const endpoint of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'not a url',
    ]) {
      assert.equal(
        parseBridgeMessage({ channel: CHANNEL, kind: 'mount', endpoint, clientId: 'acme' }),
        undefined,
        `accepted ${endpoint}`,
      );
    }
  });

  it('drops a label that is not a string instead of refusing the mount', () => {
    const parsed = parseBridgeMessage({
      channel: CHANNEL,
      kind: 'mount',
      endpoint: 'https://feedback.acme.dev',
      clientId: 'acme',
      label: { toString: 'not a string' },
    });

    assert.partialDeepStrictEqual(parsed, { kind: 'mount', clientId: 'acme' });
    assert.equal(Object.hasOwn(parsed ?? {}, 'label'), false);
  });
  /**
   * The channel carries a fixed set of fields and builds its answer from scratch, so a token cannot
   * travel on it even if something upstream put one in the object (SKG-599).
   *
   * Pinned here because SKG-596 adds a relay message to this file, and the tempting shape for a
   * relay is to spread the request it was given. The parser is the last place that would be noticed,
   * and the page is listening on the other side. See `worlds.test.ts` for the other half.
   */
  it('carries no credential, whatever the caller put in the object', () => {
    const parsed = parseBridgeMessage({
      channel: CHANNEL,
      kind: 'mount',
      endpoint: 'https://feedback.acme.dev',
      clientId: 'acme',
      accessToken: 'access.1',
      refreshToken: 'refresh.1',
      authorization: 'Bearer access.1',
    });

    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ['channel', 'clientId', 'endpoint', 'kind']);
  });
});

/**
 * The relay's half of the channel (SKG-596).
 *
 * Everything below arrives from the page's world, and on a team-mode page the page and our own
 * main-world script are indistinguishable senders. So the parser is where a relay message stops
 * being whatever somebody wrote and becomes the fixed set of fields the background reads.
 */
describe('the relay messages', () => {
  const REQUEST = {
    url: 'https://worker.test/feedback?url=x',
    method: 'GET',
    headers: {},
  };

  it('accepts an announce, which mounts nothing', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'announce' }), {
      channel: CHANNEL,
      kind: 'announce',
    });
  });

  it('accepts a relay request and its answer', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'relay-request', id: 'a', request: REQUEST }), {
      channel: CHANNEL,
      kind: 'relay-request',
      id: 'a',
      request: REQUEST,
    });

    const response = { ok: true, status: 200, body: '{}' };
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'relay-response', id: 'a', response }), {
      channel: CHANNEL,
      kind: 'relay-response',
      id: 'a',
      response,
    });
  });

  /**
   * `Authorization` is the header this allowlist exists for. The background writes it from a session
   * the page cannot read, and a page that could name it would choose which credential its own call
   * carries — or learn one exists by watching which requests succeed.
   */
  it('keeps Content-Type and drops every other header', () => {
    const request = parseRelayRequest({
      ...REQUEST,
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer stolen',
        authorization: 'Bearer stolen',
        Cookie: 'session=1',
        'X-Forwarded-For': '1.2.3.4',
      },
    });

    assert.deepEqual(request?.headers, { 'Content-Type': 'application/json' });
  });

  it('refuses a relay request that could not be sent, or could be sent anywhere', () => {
    for (const request of [
      undefined,
      { ...REQUEST, url: 'javascript:alert(1)' },
      { ...REQUEST, url: 'file:///etc/passwd' },
      { ...REQUEST, url: 'not a url' },
      { ...REQUEST, method: 'DELETE' },
      { ...REQUEST, method: 'get' },
      { ...REQUEST, body: 7 },
      { ...REQUEST, body: { note: 'hello' } },
    ]) {
      assert.equal(parseRelayRequest(request), undefined, JSON.stringify(request));
    }
  });

  /** The worker refuses a body this size anyway; refusing it here keeps it off the channel. */
  it('refuses a body larger than the worker would accept', () => {
    assert.ok(parseRelayRequest({ ...REQUEST, method: 'POST', body: 'x'.repeat(64 * 1_024) }) !== undefined);
    assert.equal(parseRelayRequest({ ...REQUEST, method: 'POST', body: 'x'.repeat(64 * 1_024 + 1) }), undefined);
  });

  it('refuses an id it could not pair an answer with', () => {
    for (const id of [undefined, '', 7, {}, 'x'.repeat(101)]) {
      assert.equal(
        parseBridgeMessage({ channel: CHANNEL, kind: 'relay-request', id, request: REQUEST }),
        undefined,
        JSON.stringify(id),
      );
    }
  });

  it('refuses an answer that is not the shape it claims', () => {
    for (const response of [
      undefined,
      {},
      { ok: true, status: 200 },
      { ok: 'yes', status: 200, body: '' },
      { ok: true, status: '200', body: '' },
      { ok: true, status: Number.NaN, body: '' },
      { ok: true, status: 200, body: 7 },
    ]) {
      assert.equal(parseRelayResponse(response), undefined, JSON.stringify(response));
    }
  });

  /**
   * The same rule the mount already keeps, on the message that was the tempting place to break it:
   * a relay is a request the caller hands over, and spreading it is how a field nobody named would
   * travel. Rebuilt field by field instead, so what arrives is what the background reads.
   */
  it('carries no credential on a relay, whatever the caller put in the object', () => {
    const parsed = parseBridgeMessage({
      channel: CHANNEL,
      kind: 'relay-request',
      id: 'a',
      accessToken: 'access.1',
      request: { ...REQUEST, accessToken: 'access.1', refreshToken: 'refresh.1', credentials: 'include' },
    });

    assert.deepEqual(Object.keys(parsed ?? {}).sort(), ['channel', 'id', 'kind', 'request']);
    assert.deepEqual(Object.keys((parsed as { request: Record<string, unknown> }).request).sort(), [
      'headers',
      'method',
      'url',
    ]);
  });
});

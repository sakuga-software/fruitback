import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CHANNEL,
  MAX_FILE_BASE64,
  NAME_MAX,
  parseBridgeMessage,
  parseRelayRequest,
  parseRelayResponse,
} from './protocol.ts';

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

  it('carries the name of « Name on my notes » to the page, and nothing else for it (FRU-302)', () => {
    const mount = (name: unknown) =>
      parseBridgeMessage({
        channel: CHANNEL,
        kind: 'mount',
        endpoint: 'https://feedback.acme.dev',
        clientId: 'acme',
        name,
      });

    // The contract of the seam: the page script gives it to the widget as `reporterName`.
    assert.equal((mount('Camille Durand') as { name?: string }).name, 'Camille Durand');
    assert.equal((mount('x'.repeat(NAME_MAX)) as { name?: string }).name?.length, NAME_MAX);
    // Too long, empty, or not a string: the mount goes on, with no name.
    for (const name of ['x'.repeat(NAME_MAX + 1), '', 42, { first: 'Camille' }, undefined]) {
      const parsed = mount(name);
      assert.equal(parsed?.kind, 'mount', JSON.stringify(name));
      assert.equal('name' in (parsed ?? {}), false, JSON.stringify(name));
    }
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
   * travel on it even if something upstream put one in the object (FRU-60).
   *
   * Pinned here because FRU-57 adds a relay message to this file, and the tempting shape for a
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

  /** A fifth field of a mount, on purpose (FRU-131). A locale tag is no credential. */
  it('carries the language of the reviewer, and drops a value that is no tag', () => {
    const mount = { channel: CHANNEL, kind: 'mount', endpoint: 'https://feedback.acme.dev', clientId: 'acme' };

    assert.deepEqual(parseBridgeMessage({ ...mount, locale: 'fr' }), { ...mount, locale: 'fr' });
    for (const locale of ['', 7, { tag: 'fr' }, 'x'.repeat(36)]) {
      assert.deepEqual(parseBridgeMessage({ ...mount, locale }), mount);
    }
  });
});

/**
 * The relay's half of the channel (FRU-57).
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

/**
 * The answer of the background to a capture, as the bridge reads it (FRU-332): a PNG in base64, which
 * the widget joins to the note. Anything else is no capture, and the answer stays.
 */
describe('the answer to a capture (FRU-332)', () => {
  const answer = (picture: unknown) =>
    parseBridgeMessage({ channel: CHANNEL, kind: 'capture-response', id: 'req1', picture });
  const PNG = { name: 'page.png', type: 'image/png', size: 3, base64: 'iVBO' };

  it('keeps a capture of the page, field by field', () => {
    assert.deepEqual(answer({ ...PNG, extra: 'dropped' }), {
      channel: CHANNEL,
      kind: 'capture-response',
      id: 'req1',
      picture: PNG,
    });
  });

  it('drops a capture that is not a PNG in base64, and keeps the answer with no picture', () => {
    for (const picture of [
      { ...PNG, type: 'text/html' },
      { ...PNG, base64: '<script>' },
      { ...PNG, base64: '' },
      { ...PNG, size: 0 },
      { ...PNG, name: '' },
      { ...PNG, base64: 'A'.repeat(MAX_FILE_BASE64 + 4) },
      { url: 'https://worker.test/screenshot/shot_0123456789abcdef0123456789abcdef', width: 1, height: 1 },
    ]) {
      assert.deepEqual(answer(picture), { channel: CHANNEL, kind: 'capture-response', id: 'req1' });
    }
  });

  it('reads a request of a capture with no area as the whole page, and with one as that area', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'capture-request', id: 'req1' }), {
      channel: CHANNEL,
      kind: 'capture-request',
      id: 'req1',
    });
    const area = { left: 1, top: 2, width: 3, height: 4, scale: 2 };
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'capture-request', id: 'req1', area }), {
      channel: CHANNEL,
      kind: 'capture-request',
      id: 'req1',
      area,
    });
    assert.equal(parseBridgeMessage({ channel: CHANNEL, kind: 'capture-request', id: 'req1', area: 'all' }), undefined);
  });
});

describe('a file of a note in a relayed request (FRU-332)', () => {
  const request = (more: Record<string, unknown>) => ({
    url: 'https://worker.test/attachments?client=acme&name=a.png',
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    ...more,
  });

  it('carries a body in base64 up to the largest file the worker takes', () => {
    assert.deepEqual(parseRelayRequest(request({ body: 'iVBORw0K', encoding: 'base64' })), {
      ...request({}),
      body: 'iVBORw0K',
      encoding: 'base64',
    });
    assert.notEqual(parseRelayRequest(request({ body: 'A'.repeat(MAX_FILE_BASE64), encoding: 'base64' })), undefined);
  });

  it('refuses a file over that size, a body that is not base64, another encoding, or a read', () => {
    for (const more of [
      { body: 'A'.repeat(MAX_FILE_BASE64 + 4), encoding: 'base64' },
      { body: 'not base64!', encoding: 'base64' },
      { body: 'A', encoding: 'base64' },
      { body: 'AAAAA', encoding: 'base64' },
      { body: 'A===', encoding: 'base64' },
      { body: 'iVBO', encoding: 'binary' },
      { body: '', encoding: 'base64' },
      { method: 'GET', body: 'iVBO', encoding: 'base64' },
    ]) {
      assert.equal(parseRelayRequest(request(more)), undefined, JSON.stringify(more).slice(0, 80));
    }
    // The control: a body of text keeps its cap of 64 KiB.
    assert.equal(parseRelayRequest(request({ body: 'x'.repeat(64 * 1_024 + 1) })), undefined);
  });
});

describe('the messages of the sign-in (FRU-315)', () => {
  it('reads a session as a boolean and nothing else, and a sign-in with nothing in it', () => {
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'session', signedOut: true }), {
      channel: CHANNEL,
      kind: 'session',
      signedOut: true,
    });
    assert.equal(parseBridgeMessage({ channel: CHANNEL, kind: 'session', signedOut: 'yes' }), undefined);
    assert.equal(parseBridgeMessage({ channel: CHANNEL, kind: 'session' }), undefined);
    assert.deepEqual(parseBridgeMessage({ channel: CHANNEL, kind: 'sign-in', url: 'https://evil.test' }), {
      channel: CHANNEL,
      kind: 'sign-in',
    });
  });
});

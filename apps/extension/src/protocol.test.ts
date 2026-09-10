import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHANNEL, parseBridgeMessage } from './protocol.ts';

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
});

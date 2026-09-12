import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSecureWorkerEndpoint, isWorkerEndpoint, normalizeWorkerEndpoint } from './endpoint.ts';

describe('isWorkerEndpoint', () => {
  it('accepts what a worker can answer on', () => {
    assert.equal(isWorkerEndpoint('https://feedback.acme.dev'), true);
    assert.equal(isWorkerEndpoint('http://localhost:8788'), true);
  });

  it('refuses everything else, including the schemes that would run as the page', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'worker.test', '', 42]) {
      assert.equal(isWorkerEndpoint(value), false, `accepted ${String(value)}`);
    }
  });
});

describe('normalizeWorkerEndpoint', () => {
  /**
   * `embed.ts` interpolates — `${endpoint}/feedback?url=…` — so a query on the endpoint swallows the
   * path and the request asks for `/` instead. The reporter is told the site is on and sees no pins.
   */
  it('drops a query and a fragment, which would otherwise eat the path', () => {
    assert.equal(normalizeWorkerEndpoint('https://worker.test?tenant=a'), 'https://worker.test');
    assert.equal(normalizeWorkerEndpoint('https://worker.test#top'), 'https://worker.test');
  });

  it('drops a trailing slash, so the built URL has one separator and not two', () => {
    assert.equal(normalizeWorkerEndpoint('https://worker.test/'), 'https://worker.test');
    assert.equal(normalizeWorkerEndpoint('https://worker.test///'), 'https://worker.test');
  });

  /** A worker behind a path prefix is an ordinary Traefik deployment. An origin-only rule breaks it. */
  it('keeps a path', () => {
    assert.equal(normalizeWorkerEndpoint('https://example.com/fruitback'), 'https://example.com/fruitback');
    assert.equal(normalizeWorkerEndpoint('https://example.com/fruitback/?x=1'), 'https://example.com/fruitback');
  });

  it('keeps the port, which is most of what a self-hosted worker is reached by', () => {
    assert.equal(normalizeWorkerEndpoint('http://localhost:8788/'), 'http://localhost:8788');
  });

  it('is idempotent, because the popup normalizes what it may have normalized before', () => {
    const once = normalizeWorkerEndpoint('https://example.com/fruitback/?x=1#y');

    assert.equal(normalizeWorkerEndpoint(once), once);
  });
});

describe('isSecureWorkerEndpoint', () => {
  it('allows https, and loopback however it is spelled', () => {
    for (const endpoint of [
      'https://worker.test',
      'https://example.com/fruitback',
      'http://localhost:8788',
      'http://127.0.0.1:8788',
      'http://[::1]:8788',
    ]) {
      assert.equal(isSecureWorkerEndpoint(endpoint), true, endpoint);
    }
  });

  /** A bearer credential travels over these, and anyone on the path reads it. */
  it('refuses plain http anywhere else, and anything that is not a URL', () => {
    for (const endpoint of [
      'http://worker.test',
      'http://192.168.1.10:8788',
      'http://localhost.evil.dev',
      'http://notlocalhost',
      'ws://worker.test',
      'not a url',
    ]) {
      assert.equal(isSecureWorkerEndpoint(endpoint), false, endpoint);
    }
  });
});

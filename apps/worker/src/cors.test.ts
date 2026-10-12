import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCorsHeaders, isExtensionOrigin, openCors, resolveCors } from './cors.ts';

/**
 * The exact value of each CORS header (FRU-179).
 *
 * A browser enforces these values, not the worker: a preflight with an empty
 * `Access-Control-Allow-Headers` refuses `Authorization` before any request arrives, and no
 * server-side test of a route sees it. So each header is compared whole.
 */

const SITE = 'https://acme.test';

function from(origin?: string): Request {
  return new Request('https://worker.test/feedback', origin === undefined ? {} : { headers: { Origin: origin } });
}

/** What a browser needs on a preflight, and on the response itself, to let the widget read it. */
function headersFor(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

describe('resolveCors', () => {
  it('answers an allowed origin with every header a browser needs', () => {
    assert.deepEqual(resolveCors(from(SITE), [SITE]), { allowed: true, headers: headersFor(SITE) });
  });

  it('allows a request with no Origin, and sends it no CORS header', () => {
    assert.deepEqual(resolveCors(from(), [SITE]), { allowed: true, headers: {} });
    assert.deepEqual(resolveCors(from(), []), { allowed: true, headers: {} });
  });

  it('refuses an origin that is not on the list, and sends it no CORS header', () => {
    assert.deepEqual(resolveCors(from('https://evil.test'), [SITE]), { allowed: false, headers: {} });
    assert.deepEqual(resolveCors(from(SITE), []), { allowed: false, headers: {} });
  });

  it('compares the origin whole: a prefix, a suffix or another scheme is another origin', () => {
    for (const origin of [
      'https://acme.test.evil.test',
      'https://evil-acme.test',
      'http://acme.test',
      `${SITE}:8443`,
    ]) {
      assert.equal(resolveCors(from(origin), [SITE]).allowed, false, origin);
    }
  });

  it('finds the origin anywhere in the list', () => {
    const list = ['https://one.test', SITE, 'https://three.test'];

    assert.deepEqual(resolveCors(from(SITE), list), { allowed: true, headers: headersFor(SITE) });
  });

  it('echoes the origin under `*`, never the star, because the answer varies by origin', () => {
    assert.deepEqual(resolveCors(from('https://anyone.test'), ['*']), {
      allowed: true,
      headers: headersFor('https://anyone.test'),
    });
  });

  it('allows the origin of an extension, which no list can name', () => {
    for (const origin of ['chrome-extension://abcdefgh', 'moz-extension://1b2c-3d4e', 'safari-web-extension://A1B2']) {
      assert.deepEqual(resolveCors(from(origin), [SITE]), { allowed: true, headers: headersFor(origin) }, origin);
    }
  });
});

describe('isExtensionOrigin', () => {
  it('is true for the three schemes of an extension, and for nothing else', () => {
    for (const origin of ['chrome-extension://abcdefgh', 'moz-extension://1b2c-3d4e', 'safari-web-extension://A1B2']) {
      assert.equal(isExtensionOrigin(origin), true, origin);
    }
    for (const origin of [
      'null',
      'file://',
      'https://acme.test',
      'https://chrome-extension://abcdefgh',
      'chrome-extension:abcdefgh',
      'extension://abcdefgh',
      '',
    ]) {
      assert.equal(isExtensionOrigin(origin), false, origin);
    }
  });
});

describe('openCors', () => {
  it('echoes any origin with every header a browser needs', () => {
    for (const origin of [SITE, 'https://evil.test', 'chrome-extension://abcdefgh']) {
      assert.deepEqual(openCors(from(origin)), { allowed: true, headers: headersFor(origin) }, origin);
    }
  });

  it('sends no CORS header to a request with no Origin', () => {
    assert.deepEqual(openCors(from()), { allowed: true, headers: {} });
  });
});

describe('diagnosticCorsHeaders', () => {
  it('echoes the origin and varies on it, and nothing more', () => {
    assert.deepEqual(diagnosticCorsHeaders(from(SITE)), { 'Access-Control-Allow-Origin': SITE, Vary: 'Origin' });
  });

  it('sends nothing to a request with no Origin', () => {
    assert.deepEqual(diagnosticCorsHeaders(from()), {});
  });
});

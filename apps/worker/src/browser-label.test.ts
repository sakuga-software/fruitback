import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UNKNOWN_BROWSER, browserLabel, everyBrowserLabel } from './browser-label.ts';

/** User agents as the browsers send them (2026). Each one names its family and its system once. */
const SEEN: readonly (readonly [string, string])[] = [
  [
    'Chrome on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  ],
  [
    'Chrome on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  ],
  [
    'Chrome on Android',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  ],
  [
    'Chrome on ChromeOS',
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  ],
  ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'],
  ['Firefox on macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0'],
  [
    'Safari on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  ],
  [
    'Safari on iOS',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  ],
  [
    'Chrome on iOS',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  ],
  [
    'Firefox on iOS',
    'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15',
  ],
  [
    'Edge on Windows',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  ],
  [
    'Opera on macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/122.0.0.0',
  ],
  [
    'Samsung Internet on Android',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  ],
];

describe('the short label of a browser (FRU-249)', () => {
  it('names the family and the system of the browsers people use', () => {
    for (const [label, userAgent] of SEEN) assert.equal(browserLabel(userAgent), label, userAgent);
  });

  it('keeps nothing of the user agent but two words of its lists', () => {
    const labels = new Set(everyBrowserLabel());
    for (const [, userAgent] of SEEN) assert.ok(labels.has(browserLabel(userAgent)), userAgent);
    // A user agent that carries a name, a version or a device: none of it is in the label.
    const loud = 'Mozilla/5.0 (Linux; Android 14; Pixel 9 of Alice) AppleWebKit/537.36 Chrome/141.0.0.0 alice@acme.dev';
    assert.equal(browserLabel(loud), 'Chrome on Android');
    for (const [, userAgent] of [...SEEN, ['', loud]]) {
      for (const word of browserLabel(userAgent).split(' ')) {
        assert.ok(!/\d/.test(word), `a version in « ${browserLabel(userAgent)} »`);
      }
    }
  });

  it('says « A browser » for what it does not know, and never reads a value that is not a user agent', () => {
    assert.equal(browserLabel('curl/8.7.1'), UNKNOWN_BROWSER);
    assert.equal(browserLabel('Lynx/2.9.0 libwww-FM/2.14 (X11; Linux)'), `${UNKNOWN_BROWSER} on Linux`);
    for (const value of [undefined, null, '', 42, ['Chrome/1'], 'Chrome/1 on macOS'.padEnd(513, ' ')]) {
      assert.equal(browserLabel(value), UNKNOWN_BROWSER, JSON.stringify(value));
    }
  });
});

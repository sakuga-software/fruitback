import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHROME_WEB_STORE, EXTENSION_GUIDE, extensionInstallFor } from './extension-store.ts';

// User agents as each browser sends them (macOS, Windows, Android, iOS).
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0';
const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0';
const SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const OPERA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 OPR/120.0.0.0';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36';
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/145.0.0.0 Mobile/15E148 Safari/604.1';

describe('where a browser installs the extension', () => {
  it('sends Chrome and Edge on a computer to the Chrome Web Store', () => {
    assert.equal(extensionInstallFor(CHROME), CHROME_WEB_STORE);
    assert.equal(extensionInstallFor(EDGE), CHROME_WEB_STORE);
  });

  it('sends every other browser to the guide', () => {
    for (const agent of [FIREFOX, SAFARI, OPERA, ANDROID, IOS_CHROME, '']) {
      assert.equal(extensionInstallFor(agent), EXTENSION_GUIDE, agent);
    }
  });

  it('names the listing of the extension, and the install section of the guide', () => {
    assert.match(CHROME_WEB_STORE, /^https:\/\/chromewebstore\.google\.com\/detail\/fruitback\/[a-p]{32}$/);
    assert.equal(EXTENSION_GUIDE, 'https://fruitback.com/reviewing.html#1-install-it');
  });
});

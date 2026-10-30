import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CHROME_WEB_STORE, EXTENSION_GUIDE, FIREFOX_ADDONS, extensionInstallFor } from './extension-store.ts';

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
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0';
const IOS_FIREFOX =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/145.0 Mobile/15E148 Safari/605.1.15';
const IOS_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/145.0.0.0 Mobile/15E148 Safari/604.1';

describe('where a browser installs the extension', () => {
  it('sends Chrome and Edge on a computer to the Chrome Web Store', () => {
    assert.equal(extensionInstallFor(CHROME), CHROME_WEB_STORE);
    assert.equal(extensionInstallFor(EDGE), CHROME_WEB_STORE);
  });

  it('sends Firefox on a computer to addons.mozilla.org (FRU-536)', () => {
    assert.equal(extensionInstallFor(FIREFOX), FIREFOX_ADDONS);
  });

  it('sends every other browser, and Firefox on a phone, to the guide', () => {
    for (const agent of [SAFARI, OPERA, ANDROID, IOS_CHROME, FIREFOX_ANDROID, IOS_FIREFOX, '']) {
      assert.equal(extensionInstallFor(agent), EXTENSION_GUIDE, agent);
    }
  });

  it('names the listing of the extension, and the install section of the guide', () => {
    assert.match(CHROME_WEB_STORE, /^https:\/\/chromewebstore\.google\.com\/detail\/fruitback\/[a-p]{32}$/);
    assert.equal(EXTENSION_GUIDE, 'https://fruitback.com/reviewing.html#1-install-it');
    // The address of the guide and of the landing (FRU-521), held by `docs-site.test.ts` of the worker.
    assert.equal(FIREFOX_ADDONS, 'https://addons.mozilla.org/en-US/firefox/addon/fruitback/');
  });
});

/** The console has no DOM under `node --test`: the guard reads the source of the screens (FRU-409). */
const SCREENS = ['routes/connect-start.tsx', 'routes/setup-install.tsx', 'routes/invitations.tsx'].map((path) => ({
  path,
  source: readFileSync(new URL(path, import.meta.url), 'utf8'),
}));

/** A control that leads somebody to install the extension, with its href and its words. */
const INSTALL =
  /href=\{([^}]+)\} newTab>\s*\{t\('(Install the extension \(beta\)|Install it in Firefox \(beta\))'\)\}/g;

function installLinks(source: string): { href: string; words: string }[] {
  return [...source.matchAll(INSTALL)].map(([, href = '', words = '']) => ({ href, words }));
}

describe('the screens that offer the extension (FRU-409)', () => {
  it('lead this browser where it installs it: the store for Chrome and Edge, the guide otherwise', () => {
    for (const { path, source } of SCREENS) {
      const links = installLinks(source).filter(({ words }) => words === 'Install the extension (beta)');
      assert.deepEqual(
        links.map(({ href }) => href),
        ['extensionInstallFor(navigator.userAgent)'],
        path,
      );
    }
    // The control: a screen that still leads to the guide alone is found.
    const before = "<Button href={EXTENSION_GUIDE} newTab>\n  {t('Install the extension (beta)')}";
    assert.deepEqual(installLinks(before), [{ href: 'EXTENSION_GUIDE', words: 'Install the extension (beta)' }]);
  });

  it('lead « Install it in Firefox (beta) » to addons.mozilla.org (FRU-536)', () => {
    const firefox = SCREENS.flatMap(({ source }) => installLinks(source)).filter(
      ({ words }) => words === 'Install it in Firefox (beta)',
    );
    assert.deepEqual(firefox, [{ href: 'FIREFOX_ADDONS', words: 'Install it in Firefox (beta)' }]);
  });
});

import { expect, test } from '@playwright/test';
import { stubWorker } from './console-workspace.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * Where the console sends somebody to install the extension: the foot of the rail, and `/connect`
 * (FRU-409). Where the foot of the rail sends somebody to install the extension. Since 0.3.0 the extension is on
 * the Chrome Web Store, which Chrome and Edge install from; Firefox installs it from addons.mozilla.org
 * (FRU-536). The browser is told apart by its user agent
 * (`extension-store.ts`), so each case runs in Chromium with the user agent of that browser.
 */

const CONSOLE = 'http://localhost:5178';
const STORE = 'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa';
const AMO = 'https://addons.mozilla.org/en-US/firefox/addon/fruitback/';
const NAMES: Record<string, string> = { [STORE]: 'the Chrome Web Store', [AMO]: 'addons.mozilla.org' };

const BROWSERS = [
  {
    name: 'Edge',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 Edg/145.0.0.0',
    href: STORE,
  },
  {
    name: 'Firefox',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0',
    href: AMO,
  },
];

for (const browser of BROWSERS) {
  test.describe(`in ${browser.name}`, () => {
    test.use({ userAgent: browser.userAgent });

    test(`the rail leads to ${NAMES[browser.href]}`, async ({ page }) => {
      await stubWorker(page);
      await page.goto(`${CONSOLE}/w/w1/sites`);
      await expect(page.locator('main h1')).toBeVisible();
      const extension = page.locator('aside.kit-rail').getByRole('link', { name: 'Install the extension (beta)' });
      await expect(extension).toHaveAttribute('href', browser.href);
      await expect(extension).toHaveAttribute('target', '_blank');
    });

    test(`/connect leads to ${NAMES[browser.href]} (FRU-409)`, async ({ page }) => {
      // The page asks the worker nothing: whatever it would ask is refused.
      await page.route(`${WORKER_ORIGIN}/**`, (route) =>
        route.fulfill({ status: 401, json: { error: 'unauthorized' } }),
      );
      await page.goto(`${CONSOLE}/connect`);
      await expect(page.locator('main h1')).toHaveText('Connect this browser');
      const install = page.locator('main').getByRole('link', { name: 'Install the extension (beta)' });
      await expect(install).toHaveAttribute('href', browser.href);
      await expect(install).toHaveAttribute('target', '_blank');
    });
  });
}

import { type Page, expect } from '@playwright/test';
import { type LoadedExtension, mintPairing, openPopup, test, SITE_ON } from './extension.ts';
import { caseOf, hydrated } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * Opera keeps extensions off the pages of search results (FRU-648). Measured on 2026-11-20: a site
 * of a workspace on google.com, turned on in Opera, sent no request to the worker, not even the read
 * of the pins. Its setting « Allow access to search page results » fixed it.
 *
 * No Opera runs here. The spec gives the popup the user agent of Opera, and takes the scripts of the
 * extension off the tab as Opera does: it unregisters them, then reloads the page.
 */

declare const chrome: { scripting: { unregisterContentScripts(): Promise<void> } };

const OPERA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/116.0.0.0';
const LINE = /Opera keeps extensions off search results/;

async function paired(extension: LoadedExtension): Promise<void> {
  const { link } = await mintPairing('Camille Durand');
  const worker = await extension.context.newPage();
  await worker.goto(link);
  const popup = await openPopup(extension, worker, AUTHENTICATED_WORKER_ORIGIN);
  await popup.getByRole('button', { name: 'Connect to this server' }).click();
  await expect(popup.getByText('Camille Durand', { exact: false })).toBeVisible();
  await popup.close();
  await worker.close();
}

/** A page of a site of the workspace, turned on in the popup, with its widget. */
async function turnedOn(extension: LoadedExtension, testCase: string): Promise<Page> {
  await paired(extension);
  const page = await extension.context.newPage();
  await page.goto(`/?case=${caseOf(testCase)}&widget=off`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await hydrated(page);
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: 'Turn on' }).click();
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  await popup.close();
  await expect(page.getByRole('button', { name: 'Leave a note' })).toHaveCount(1);

  return page;
}

/** The tab as Opera leaves a page of search results: the site is on, and no script of the extension runs. */
async function keptOff(extension: LoadedExtension, page: Page): Promise<void> {
  await extension.worker.evaluate(() => chrome.scripting.unregisterContentScripts());
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave a note' })).toHaveCount(0);
}

/** The popup after its second ask of the tab has had its time. */
async function settledPopup(extension: LoadedExtension, page: Page): Promise<Page> {
  const popup = await openPopup(extension, page);
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  await popup.waitForTimeout(2_500);

  return popup;
}

test.describe('on Opera', () => {
  // `--user-agent` does not reach the pages of an extension: the popup reads it from `navigator`.
  test.beforeEach(async ({ extension }) => {
    await extension.context.addInitScript((userAgent) => {
      Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => userAgent });
    }, OPERA);
  });

  test('the popup names the setting of Opera when nothing of the extension runs in the tab', async ({ extension }) => {
    const page = await turnedOn(extension, 'opera-kept-off');
    // The control: the widget runs, and the popup says nothing of Opera.
    const before = await settledPopup(extension, page);
    await expect(before.getByText(LINE)).toHaveCount(0);
    await before.close();

    await keptOff(extension, page);
    const popup = await settledPopup(extension, page);
    await expect(popup.getByText(LINE)).toBeVisible();
    await expect(popup.getByText(LINE)).toContainText('Allow access to search page results');
    const shot = test.info().outputPath('popup-opera.png');
    await popup.screenshot({ path: shot });
    await test.info().attach('popup, Opera, page kept off', { path: shot, contentType: 'image/png' });
  });
});

test('on another browser, the same tab gets no line about Opera', async ({ extension }) => {
  const page = await turnedOn(extension, 'opera-chrome');
  await keptOff(extension, page);
  const popup = await settledPopup(extension, page);
  await expect(popup.getByText(LINE)).toHaveCount(0);
});

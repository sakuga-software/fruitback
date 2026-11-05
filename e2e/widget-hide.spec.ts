import { type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, addRule, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Hide Fruitback on this page » in the settings of the widget (FRU-590): the reviewer hides the
 * widget from the page itself. The extension keeps it hidden on that origin, after a reload too, as
 * the popup does (FRU-444). A request that the page sends with no click of the person hides nothing.
 */

const LEAVE = /Leave a note/;

/** Enough time for a registered script to run and a widget to mount. An absence has no signal. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

const hiddenOrigins = (extension: { worker: { evaluate<T>(fn: () => Promise<T>): Promise<T> } }) =>
  extension.worker.evaluate(
    async () => ((await chrome.storage.local.get('hiddenOrigins')) as { hiddenOrigins?: string[] }).hiddenOrigins,
  );

declare const chrome: {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
};

test('the settings of the widget hide it on this page, and a request of the page alone hides nothing', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const site = await extension.context.newPage();
  // A script of the page reads the tag of the copy in the messages of the extension, as any can.
  await site.addInitScript(() => {
    window.addEventListener('message', (event) => {
      const copy = (event.data as { copy?: unknown } | null)?.copy;
      if (typeof copy === 'string') (window as { seenCopy?: string }).seenCopy = copy;
    });
  });
  await openBareSite(site, 'ext-widget-hide');
  await expect(site.getByRole('button', { name: LEAVE })).toBeVisible();

  // The page posts the request with that tag, and no gesture of the person: the bridge writes nothing.
  expect(await site.evaluate(() => typeof (window as { seenCopy?: string }).seenCopy)).toBe('string');
  // WARNING: `evaluate` of Playwright runs as a gesture of the person. The request goes from a timer,
  // after the activation of that gesture expired (5 s in Chromium), and the page reads that it did.
  const activeWhenSent = await site.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => {
          const active = navigator.userActivation.isActive;
          window.postMessage(
            {
              channel: 'fruitback-extension/2',
              kind: 'hide-request',
              copy: (window as { seenCopy?: string }).seenCopy,
            },
            window.location.origin,
          );
          resolve(active);
        }, 6_000);
      }),
  );
  expect(activeWhenSent).toBe(false);
  await settle(site);
  await expect(site.getByRole('button', { name: LEAVE })).toBeVisible();
  expect(await hiddenOrigins(extension)).toBeUndefined();

  // The click of the person in the settings of the widget.
  await site.getByRole('button', { name: 'Open Fruitback settings' }).click();
  await site.getByRole('button', { name: 'Hide Fruitback on this page' }).click();
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);
  await expect.poll(() => hiddenOrigins(extension)).toEqual([PLAYGROUND_ORIGIN]);

  await site.reload();
  await settle(site);
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);

  // The rule stays on: only this origin lost the widget. `popup-hide-widget.spec.ts` shows it again.
  const popup = await openPopup(extension, site);
  await expect(popup.getByText(/^On · /)).toBeVisible();
});

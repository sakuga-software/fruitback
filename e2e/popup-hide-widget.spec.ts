import AxeBuilder from '@axe-core/playwright';
import { type Page, expect } from '@playwright/test';
import { PLAYGROUND_ORIGIN, addRule, openBareSite, openPopup, test } from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Show Fruitback on this page » (FRU-444): the reviewer hides the widget on one site from the popup,
 * and the rule of the site stays on. Hidden, the page gets no script and no widget, after a reload
 * too; shown again, the widget comes back in the open tab, with no reload and no prompt.
 */

declare const chrome: {
  scripting: { getRegisteredContentScripts(): Promise<{ id: string; excludeMatches?: string[] }[]> };
};

const LEAVE = /Leave feedback/;

/** Enough time for a registered script to run and a widget to mount. An absence has no signal. */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

test('the popup hides the widget on this page, keeps it hidden after a reload, and shows it again', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const site = await extension.context.newPage();
  await openBareSite(site, 'ext-hide-widget');
  await expect(site.getByRole('button', { name: LEAVE })).toBeVisible();

  const popup = await openPopup(extension, site);
  const shown = popup.getByRole('switch', { name: 'Show Fruitback on this page' });
  await expect(shown).toHaveAttribute('aria-checked', 'true');
  // Reached by the keyboard, and turned by it.
  await shown.focus();
  await popup.keyboard.press('Space');

  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);
  await expect(popup.getByRole('switch', { name: 'Show Fruitback on this page' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // The rule stays on: only this page lost the widget.
  await expect(popup.getByText(/^On · /)).toBeVisible();

  // The scripts of the rule leave the origin out, so a reload runs nothing on the page.
  await expect
    .poll(() =>
      extension.worker.evaluate(async () =>
        (await chrome.scripting.getRegisteredContentScripts()).flatMap((script) => script.excludeMatches ?? []),
      ),
    )
    .toEqual([`${PLAYGROUND_ORIGIN}/*`, `${PLAYGROUND_ORIGIN}/*`]);
  await site.reload();
  await settle(site);
  await expect(site.locator('[data-fruitback-host]')).toHaveCount(0);
  expect(await site.evaluate(() => '__fruitbackPageScript' in window || 'fruitbackExtension' in window)).toBe(false);

  // Shown again: the tab that loaded while it was hidden gets the widget, with no reload.
  const again = await openPopup(extension, site);
  await again.getByRole('switch', { name: 'Show Fruitback on this page' }).click();
  await expect(site.getByRole('button', { name: LEAVE })).toBeVisible();
  await expect
    .poll(() =>
      extension.worker.evaluate(async () =>
        (await chrome.scripting.getRegisteredContentScripts()).flatMap((script) => script.excludeMatches ?? []),
      ),
    )
    .toEqual([]);
});

test('axe finds nothing on the popup with the switch, in both schemes', async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const site = await extension.context.newPage();
  await openBareSite(site, 'ext-hide-widget-axe');
  const popup = await openPopup(extension, site);
  await expect(popup.getByRole('switch', { name: 'Show Fruitback on this page' })).toBeVisible();

  for (const colorScheme of ['light', 'dark'] as const) {
    await popup.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page: popup }).analyze();
    expect(
      violations.map((violation) => violation.id),
      colorScheme,
    ).toEqual([]);
  }
});

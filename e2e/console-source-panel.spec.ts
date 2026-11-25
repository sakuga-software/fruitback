import { type Page, expect, test } from '@playwright/test';
import { fulfillSites } from './console-workspace.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { unfolded } from './settled.ts';

/**
 * Where the settings of a connector open (FRU-690): in a dialog over the screen, at every width, where
 * they were an accordion under the row (FRU-161, FRU-403). The dialog takes focus, keeps it, and
 * gives it back to the button of the row when it closes (FRU-197 asked the same of the accordion).
 *
 * The worker is answered by stubs: this measures layout and focus.
 */
const CONSOLE = 'http://localhost:5178';
/** Enough connectors for the last row to be at the bottom of a phone when it is touched. */
const COUNT = 6;

async function stubWorker(page: Page, locale: 'en' | 'fr'): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  const connectors = Array.from({ length: COUNT }, (_, index) => ({
    id: `c${index}`,
    kind: 'linear',
    label: `Linear · Person ${index}`,
    createdAt: '2026-10-01T10:00:00.000Z',
    // A connector that needs somebody: what to do is in its settings.
    attention: { reason: 'key-refused', since: '2026-10-10T10:00:00.000Z' },
  }));
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname === '/console/me') return json(me);
    const read = fulfillSites(route, [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }]);
    if (read !== false) return read;
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors, available: true });
    if (/^\/console\/workspaces\/w1\/connectors\/c\d\/teams$/.test(pathname)) {
      return json({ teams: [{ id: 't1', name: 'Web', key: 'WEB', projects: [] }] });
    }

    return route.fulfill({ status: 204 });
  });
}

/** The buttons « … » at the end of the rows, which open the settings of their connector. */
const openers = (page: Page) =>
  page.locator('tbody tr[data-connector]').getByRole('button', { name: /^(Settings of|Réglages de) / });
const panel = (page: Page) => page.locator('#source-panel');

for (const { width, height, locale, name } of [
  { width: 390, height: 844, locale: 'fr', name: 'Linear · Clé de Person 1' },
  { width: 768, height: 1024, locale: 'en', name: 'Linear · Key of Person 1' },
  { width: 1440, height: 900, locale: 'en', name: 'Linear · Key of Person 1' },
] as const) {
  test(`at ${width} px, the settings open in a dialog on the screen, with focus, and Escape gives it back`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await stubWorker(page, locale);
    await page.goto(`${CONSOLE}/w/w1/connectors`);
    await expect(openers(page)).toHaveCount(COUNT);

    for (const index of [1, COUNT - 1]) {
      const opener = openers(page).nth(index);
      // From the keyboard, as a screen reader presses it.
      await opener.focus();
      await page.keyboard.press('Enter');
      await unfolded(page);
      const dialog = page.getByRole('dialog');
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      if (index === 1) await expect(panel(page)).toHaveAttribute('aria-label', name);

      // The dialog is on the screen, whatever row was pressed, and so is what the connector needs.
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      await expect(panel(page).getByRole('alert').first()).toBeInViewport();

      // Tab stays in the dialog.
      for (let press = 0; press < 8; press += 1) {
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate((element) => element.contains(document.activeElement)), `Tab ${press}`).toBe(true);
      }

      // Escape in something of the dialog that is open closes that thing, and the dialog stays.
      const disconnect = panel(page).getByRole('button', { name: /^(Disconnect|Déconnecter) Linear$/ });
      await disconnect.click();
      await page.keyboard.press('Escape');
      await expect(disconnect).toBeFocused();
      await expect(dialog).toBeVisible();

      // Escape in the dialog itself closes it, and the keyboard is back on the button of the row.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });
}

test('a change of width keeps the dialog open, and takes the focus from nobody', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubWorker(page, 'en');
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await openers(page).first().click();
  await unfolded(page);
  const disconnect = panel(page).getByRole('button', { name: 'Disconnect Linear' });
  await disconnect.focus();
  // The window gets narrow: nothing is mounted again, and focus stays where the person put it.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(panel(page)).toBeVisible();
  await expect(disconnect).toBeFocused();
});

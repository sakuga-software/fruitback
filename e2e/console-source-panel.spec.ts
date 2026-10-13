import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * Where the panel of a source opens (FRU-161). From 1280 px it has its column beside the list, as on
 * `design/boards/4-connectors.png`. Under 1280 px there is no such column: the panel opens under the
 * row that was touched, and its top is on the screen.
 *
 * The worker is answered by stubs: this measures layout.
 */
const CONSOLE = 'http://localhost:5178';
/** Enough sources for the last row to be at the bottom of a phone when it is touched. */
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
    // A source that needs somebody: what to do is in its panel.
    attention: { reason: 'key-refused', since: '2026-10-10T10:00:00.000Z' },
  }));
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/sites') {
      return json({ sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }] });
    }
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors, available: true });
    if (/^\/console\/workspaces\/w1\/connectors\/c\d\/teams$/.test(pathname)) {
      // One team, so the panel holds a list to open: Escape in it must close the list, not the panel.
      return json({ teams: [{ id: 't1', name: 'Web', key: 'WEB', projects: [] }] });
    }

    return route.fulfill({ status: 204 });
  });
}

const rows = (page: Page) => page.locator('button[aria-pressed]');
const panel = (page: Page) => page.locator('#source-panel');

for (const { width, height, locale } of [
  { width: 390, height: 844, locale: 'fr' },
  { width: 768, height: 1024, locale: 'en' },
] as const) {
  test(`at ${width} px, the panel of a source opens under its row, on the screen`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await stubWorker(page, locale);
    await page.goto(`${CONSOLE}/w/w1/connectors`);
    await expect(rows(page)).toHaveCount(COUNT);

    for (const index of [0, COUNT - 1]) {
      const row = rows(page).nth(index);
      await row.click();
      await expect(row).toHaveAttribute('aria-pressed', 'true');

      // The top of the panel, its title and the reason the source needs somebody, are on the screen.
      const title = page.getByRole('heading', { level: 2, name: 'Linear', exact: true });
      await expect(title).toBeInViewport();
      await expect
        .poll(async () => {
          const box = await panel(page).boundingBox();

          return box !== null && box.y >= 0 && box.y + 80 <= height;
        })
        .toBe(true);
      await expect(panel(page).getByRole('alert').first()).toBeInViewport();

      // The panel is the next thing after its row, for a reader as for the eye, and the row names it.
      expect(await row.evaluate((button) => button.nextElementSibling?.id)).toBe('source-panel');
      await expect(row).toHaveAttribute('aria-controls', 'source-panel');

      // A second touch closes it.
      await row.click();
      await expect(panel(page)).toHaveCount(0);
    }
  });
}

test('at 1440 px, the panel of a source keeps its column beside the list', async ({ page }) => {
  await stubWorker(page, 'en');
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const row = rows(page).first();
  await row.click();
  await expect(panel(page)).toBeVisible();

  const list = await row.boundingBox();
  const heading = await page.getByRole('heading', { name: 'Connected', exact: true }).boundingBox();
  const beside = await panel(page).boundingBox();
  expect(beside!.x).toBeGreaterThan(list!.x + list!.width);
  // Its top is level with the heading of the list, as on the board.
  expect(Math.abs(beside!.y - heading!.y)).toBeLessThan(20);
});

/**
 * FRU-197. A press of a row said nothing to a screen reader but the state of the button, and from
 * 1280 px the panel is not the next thing after its row. So the panel that a person opens is a named
 * region that takes focus, and Escape gives focus back to the row.
 */
for (const { width, height, locale, name } of [
  { width: 390, height: 844, locale: 'fr', name: 'Linear · Clé de Person 1' },
  { width: 768, height: 1024, locale: 'en', name: 'Linear · Key of Person 1' },
  { width: 1440, height: 900, locale: 'en', name: 'Linear · Key of Person 1' },
] as const) {
  test(`at ${width} px, the panel a person opens takes focus under its name, and Escape gives it back`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await stubWorker(page, locale);
    await page.goto(`${CONSOLE}/w/w1/connectors`);
    const row = rows(page).nth(1);
    const region = page.getByRole('region', { name, exact: true });

    // From the keyboard, as a screen reader presses it.
    await row.focus();
    await page.keyboard.press('Enter');
    await expect(region).toBeFocused();
    await expect(region).toHaveAttribute('id', 'source-panel');
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    // The scroll that shows the panel is not undone by the focus: its title is on the screen.
    await expect(page.getByRole('heading', { level: 2, name: 'Linear', exact: true })).toBeInViewport();

    // Tab goes on inside the panel, wherever the panel is drawn.
    await page.keyboard.press('Tab');
    expect(
      await region.evaluate((panel) => panel.contains(document.activeElement) && panel !== document.activeElement),
    ).toBe(true);

    // Escape in something of the panel that is open closes that thing, and the panel stays.
    const list = region.getByRole('button', { name: /staging\.acme\.dev/ });
    await list.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(region).toBeVisible();
    const disconnect = region.getByRole('button', { name: /^(Disconnect|Déconnecter)$/ });
    await disconnect.click();
    await page.keyboard.press('Escape');
    await expect(disconnect).toBeFocused();
    await expect(region).toBeVisible();

    // Escape in the panel itself closes it, and the keyboard is back on the row.
    await page.keyboard.press('Escape');
    await expect(region).toHaveCount(0);
    await expect(row).toBeFocused();
    await expect(row).toHaveAttribute('aria-pressed', 'false');
  });
}

test('a panel that appears by itself takes no focus: the one a change of width mounts again', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubWorker(page, 'en');
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const row = rows(page).first();
  await row.click();
  await expect(panel(page)).toBeFocused();
  // The person goes back to the row, then the window gets narrow: the panel moves under the row.
  await row.focus();
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect.poll(() => row.evaluate((button) => button.nextElementSibling?.id)).toBe('source-panel');

  await expect(row).toBeFocused();
});

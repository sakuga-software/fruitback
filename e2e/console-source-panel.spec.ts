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
    if (/^\/console\/workspaces\/w1\/connectors\/c\d\/teams$/.test(pathname)) return json({ teams: [] });

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

import { type Locator, expect, test } from '@playwright/test';
import { box, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * Where a menu of the kit opens (FRU-407). The menu of a row ends at the right edge of its button,
 * and so stays over the table: it started at the left edge of the button, and went out of the table
 * on the right. The sites are cards since FRU-408: the menu of a card stays over the grid. The menu of the name of a workspace, at the left of the rail, still starts at the
 * left edge of its button. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

/** The box of the menu that `button` opens, once it no longer moves. */
async function opened(button: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  await button.click();
  const menu = button.page().getByRole('menu');
  await expect(menu).toBeVisible();
  let last = '';
  await expect
    .poll(async () => {
      const now = JSON.stringify(await box(menu));
      const still = now === last;
      last = now;

      return still;
    })
    .toBe(true);

  return box(menu);
}

for (const [width, height] of [
  [1492, 847],
  [1440, 900],
] as const) {
  test(`the menu of a card of sites ends at the right edge of its button, at ${width} px`, async ({ page }) => {
    await stubWorker(page, {
      sites: [
        { id: 's1', origin: 'https://app.acme.dev', visibility: 'members' },
        { id: 's2', origin: 'https://staging.acme.dev', visibility: 'members' },
      ],
    });
    await page.setViewportSize({ width, height });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const button = page.getByRole('button', { name: 'More for app.acme.dev' });
    const trigger = await box(button);
    const menu = await opened(button);
    const grid = await box(page.getByRole('list', { name: 'Sites' }));

    // Under the button, and toward its left: its right edge is the right edge of the button.
    expect.soft(menu.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
    expect.soft(Math.abs(menu.x + menu.width - (trigger.x + trigger.width))).toBeLessThanOrEqual(2);
    expect.soft(menu.x).toBeLessThan(trigger.x);
    // So it stays over the grid.
    expect.soft(menu.x + menu.width).toBeLessThanOrEqual(grid.x + grid.width);
    expect.soft(await sideScroll(page)).toBe(0);
  });
}

test('the menu of the name of a workspace still starts at the left edge of its button', async ({ page }) => {
  await stubWorker(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const button = page.locator('aside.kit-rail').getByRole('button', { name: /Acme/ });
  const trigger = await box(button);
  const menu = await opened(button);

  expect.soft(menu.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
  expect.soft(Math.abs(menu.x - trigger.x)).toBeLessThanOrEqual(2);
});

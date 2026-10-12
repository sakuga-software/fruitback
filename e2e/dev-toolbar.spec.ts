import { type Page, expect, test } from '@playwright/test';
import { openPlayground } from './pin.ts';

/**
 * The toolbar of the playground on a phone (FRU-171). It is scaffolding, but on the public
 * demonstration it is what a visitor sees first.
 */

type Box = { left: number; right: number; top: number; bottom: number };

async function measure(page: Page): Promise<{ bar: Box; buttons: Box[]; dock: Box }> {
  // To the end of the page: that is where the bar and the dock of the widget come closest.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  return page.evaluate(() => {
    const box = (element: Element): Box => {
      const { left, right, top, bottom } = element.getBoundingClientRect();

      return { left, right, top, bottom };
    };
    const bar = document.querySelector('[data-fruitback-dev="toolbar"]');
    const launch = document
      .querySelector('[data-fruitback-host]')
      ?.shadowRoot?.querySelector('[data-fruitback-host-launch]');
    if (!bar || !launch) throw new Error('the toolbar or the dock is missing');

    return {
      bar: box(bar),
      buttons: [...bar.querySelectorAll('button')].map(box),
      dock: box(launch),
    };
  });
}

for (const width of [390, 320]) {
  test(`at ${width} px, the toolbar keeps its buttons, fits the screen and leaves the dock alone`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openPlayground(page, `dev-toolbar-${width}`);
    const { bar, buttons, dock } = await measure(page);

    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.left).toBeGreaterThanOrEqual(bar.left);
      expect(button.right).toBeLessThanOrEqual(bar.right);
    }
    expect(bar.left).toBeGreaterThanOrEqual(0);
    // The bar is inside the screen. The page of the playground itself is 42 px too wide at 320 px,
    // with or without the bar: its navigation. That is the fixture's, and is not measured here.
    expect(bar.right).toBeLessThanOrEqual(width);
    // The two rectangles do not meet: the bar ends above the dock.
    expect(bar.bottom).toBeLessThanOrEqual(dock.top);
  });
}

test('at 1440 px, the toolbar still floats in the corner, beside the dock', async ({ page }) => {
  await openPlayground(page, 'dev-toolbar-wide');
  const bar = page.locator('[data-fruitback-dev="toolbar"]');
  expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe('fixed');
  const { bar: box, dock } = await measure(page);
  expect(box.right).toBeLessThanOrEqual(dock.left);
});

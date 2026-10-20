import { expect, test } from '@playwright/test';
import { badgeFor, openPlayground, pinFor, plantPin } from './pin.ts';

/**
 * A pin must not hide what it annotates (FRU-158). Since FRU-304 the drop of the mock-up of
 * 2026-10-20 points down at its element, 16 px in from its start corner, and stands above its top
 * edge: it covers nothing of its own element. Text written right above an element can be under it,
 * as in the mock-up: that is the price of a drop that points, and the frame of the note says which
 * element it is about. The frame shows only while its note is pointed at or open.
 */

test('a drop covers nothing of its own element, and stays on the page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'pin-placement');

  for (const plan of ['espresso', 'latte', 'mocha']) {
    await plantPin(page, page.locator(`[data-testid="card-${plan}"] .add`), `Bouton ${plan}`);
  }
  await plantPin(page, page.locator('[data-testid="card-latte"] .text-3xl'), 'Prix latte');
  await plantPin(page, page.locator('main header button'), 'En haut');
  await page.mouse.move(0, 0);

  const own = await page.locator('[data-fruitback-pin]').evaluateAll((pins) =>
    pins.flatMap((pin) => {
      const badge = (pin.querySelector('.fruitback-pin-badge') as HTMLElement).getBoundingClientRect();
      const frame = pin.getBoundingClientRect();
      // The element is 5 px inside the frame. The drop ends on its top edge, or inside it at the top of the page.
      const element = { top: frame.top + 5 };
      const onTop = badge.bottom <= element.top + 1;
      // The box of a turned drop holds its corners: the drawn drop is a round of 14 px around the middle.
      const middle = { x: badge.left + badge.width / 2, y: badge.top + badge.height / 2 };
      const onPage = middle.y - 14 + window.scrollY >= -1 && middle.x - 14 >= -1;

      const problems: string[] = [];
      if (!onTop && element.top + window.scrollY >= 34) problems.push(`on its element: ${pin.textContent}`);
      if (!onPage) problems.push(`off the page: ${pin.textContent}`);

      return problems;
    }),
  );
  expect(own).toEqual([]);

  // The badge is still the one control, and it still opens its note.
  await badgeFor(page, 'Prix latte').click();
  await expect(page.locator('[data-fruitback-thread]')).toContainText('Prix latte');
});

test('the frame shows only while its note is pointed at or open', async ({ page }) => {
  await openPlayground(page, 'pin-tint');
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Teinte du cadre');
  await page.mouse.move(0, 0);

  const pin = pinFor(page, 'Teinte du cadre');
  const frame = () => pin.evaluate((element) => getComputedStyle(element).borderTopColor);

  await expect.poll(frame).toBe('rgba(0, 0, 0, 0)');
  await badgeFor(page, 'Teinte du cadre').hover();
  await expect.poll(frame).not.toBe('rgba(0, 0, 0, 0)');
  await page.mouse.move(0, 0);
  await expect.poll(frame).toBe('rgba(0, 0, 0, 0)');
  await badgeFor(page, 'Teinte du cadre').click();
  await page.mouse.move(0, 0);
  await expect.poll(frame).not.toBe('rgba(0, 0, 0, 0)');
  // Never a fill over the element.
  expect(await pin.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
});

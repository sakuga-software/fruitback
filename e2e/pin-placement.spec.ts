import { expect, type Page, test } from '@playwright/test';
import { badgeFor, openPlayground, pinFor, plantPin } from './pin.ts';

/**
 * A pin must not hide what it annotates (FRU-158). The badge hung above the top-left corner of its
 * element, on whatever was written there: « 19 € » read « 9 € ». It hangs outside the corner now,
 * to the left, and the frame is tinted only while its note is pointed at or open.
 */

test('with a note on each « Ajouter » and one on a price, every title and price stays readable', async ({ page }) => {
  await openPlayground(page, 'pin-placement');

  for (const plan of ['espresso', 'latte', 'mocha']) {
    await plantPin(page, page.locator(`[data-testid="card-${plan}"] .add`), `Bouton ${plan}`);
  }
  await plantPin(page, page.locator('[data-testid="card-latte"] .text-3xl'), 'Prix latte');
  await page.mouse.move(0, 0);

  const covered = await coveredText(page);
  expect(covered, `text under a badge: ${covered.join(' ; ')}`).toEqual([]);

  // The badge is still the one control, and it still opens its note.
  await badgeFor(page, 'Prix latte').click();
  await expect(page.locator('[data-fruitback-thread]')).toContainText('Prix latte');
});

test('the frame is tinted only while its note is pointed at or open', async ({ page }) => {
  await openPlayground(page, 'pin-tint');
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), 'Teinte du cadre');
  await page.mouse.move(0, 0);

  const pin = pinFor(page, 'Teinte du cadre');
  const tint = () => pin.evaluate((element) => getComputedStyle(element).backgroundColor);

  await expect.poll(tint).toBe('rgba(0, 0, 0, 0)');
  await badgeFor(page, 'Teinte du cadre').hover();
  await expect.poll(tint).not.toBe('rgba(0, 0, 0, 0)');
  await badgeFor(page, 'Teinte du cadre').click();
  await page.mouse.move(0, 0);
  await expect.poll(tint).not.toBe('rgba(0, 0, 0, 0)');
});

/** The text of every card title and price that a badge overlaps, measured on the glyphs, not the box. */
async function coveredText(page: Page): Promise<string[]> {
  const badges = await page.locator('.fruitback-pin-badge').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();

      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    }),
  );

  return page.locator('[data-testid^="card-"] h3, [data-testid^="card-"] .text-3xl').evaluateAll(
    (elements, boxes) =>
      elements.flatMap((element) => {
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);

        return [...range.getClientRects()].some((line) =>
          boxes.some(
            (box) => box.left < line.right && box.right > line.left && box.top < line.bottom && box.bottom > line.top,
          ),
        )
          ? [element.textContent ?? '']
          : [];
      }),
    badges,
  );
}

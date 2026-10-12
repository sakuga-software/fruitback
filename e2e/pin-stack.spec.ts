import { expect, type Locator, test } from '@playwright/test';
import { badgeFor, openPlayground, plantPin } from './pin.ts';

/**
 * Several notes on one element (FRU-155). Each note keeps its own pin, and the badges fan out along
 * the top edge of the element, so a pointer reaches every one of them. Before, the three badges sat
 * at the same point and only the last one took the click.
 */

const NOTES = ['Première note du bouton', 'Deuxième note du bouton', 'Troisième note du bouton'];

test('three notes on one element give three badges, and the pointer reaches each one', async ({ page }) => {
  await openPlayground(page, 'pin-stack');
  const button = page.locator('[data-testid="card-latte"] .add');

  for (const note of NOTES) await plantPin(page, button, note);

  const centres: string[] = [];
  for (const note of NOTES) {
    const badge = badgeFor(page, note);
    expect(await hitsItself(badge), `the badge of « ${note} » is under another one`).toBe(true);
    const box = await badge.boundingBox();
    centres.push(
      `${Math.round((box?.x ?? 0) + (box?.width ?? 0) / 2)},${Math.round((box?.y ?? 0) + (box?.height ?? 0) / 2)}`,
    );
  }
  expect(new Set(centres).size, `badge centres: ${centres.join(' ; ')}`).toBe(NOTES.length);

  // A real click on each, which also proves nothing covers it: Playwright refuses a covered target.
  for (const note of NOTES) {
    await badgeFor(page, note).click({ timeout: 5_000 });
    await expect(page.locator('[data-fruitback-thread]')).toContainText(note);
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-fruitback-thread]')).toHaveCount(0);
  }
});

/** What the pointer hits at the centre of the badge, asked of the badge's own Shadow root. */
async function hitsItself(badge: Locator): Promise<boolean> {
  return badge.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const root = element.getRootNode() as Document | ShadowRoot;
    const hit = root.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

    return hit !== null && hit.closest('.fruitback-pin-badge') === element;
  });
}

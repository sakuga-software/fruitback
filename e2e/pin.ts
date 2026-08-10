import { expect, type Locator, type Page } from '@playwright/test';

/**
 * The three moves every spec makes: open a page of one's own, plant a pin, and check a pin sits on
 * an element.
 *
 * The harness these drive is the playground's, not the product's — the real capture UI is SKG-492/493
 * and the real re-anchoring is SKG-500. What the specs actually assert through it is the pipeline
 * underneath: `captureSeed`, `POST /feedback`, `GET /feedback`.
 */

/**
 * Each spec captures on its own URL. The seed's page identity is the canonical URL, so a query
 * parameter is all it takes to keep one spec's pins out of another's — the worker's in-memory store
 * lives for the whole run.
 */
export async function openPlayground(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?case=${testCase}`);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await expect(status(page)).toHaveText(/pin|^0/, { timeout: 15_000 });
}

/** Capture mode, a click on `target`, a note, send — and wait for the pin to come back. */
export async function plantPin(page: Page, target: Locator, note: string): Promise<void> {
  const before = await page.locator('[data-fb-pin]').count();

  await page.getByRole('button', { name: 'Laisser un feedback' }).click();
  await target.click();
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill(note);
  await page.getByRole('button', { name: 'Envoyer' }).click();

  // The harness only writes this once the re-read has finished drawing, so it is the happens-before
  // the geometry assertions need. Counting pins alone races: the old ones are still on the page
  // while the new set is being fetched.
  await expect(status(page)).toHaveText(/^planté ·/);
  await expect(page.locator('[data-fb-pin]')).toHaveCount(before + 1);
}

/**
 * Wait until the pins on the page have been drawn again — after a redeploy, a deletion, a reload.
 * Same reason as above: without it, an assertion measures the pins from before the DOM moved.
 */
export async function waitForPins(page: Page, count: number): Promise<void> {
  await expect(status(page)).toHaveText(new RegExp(`^${count} pins?$`));
  await expect(page.locator('[data-fb-pin]')).toHaveCount(count);
}

export function pinFor(page: Page, note: string): Locator {
  return page.locator(`[data-fb-pin][data-fb-label*=${JSON.stringify(note.slice(0, 20))}]`);
}

export function status(page: Page): Locator {
  return page.locator('[data-fb-dev="status"]');
}

/**
 * The assertion that matters: the pin is drawn over the element, not merely present. Tolerance is a
 * pixel — sub-pixel rounding is expected, being on the neighbouring card is not.
 */
export async function expectPinOn(pin: Locator, element: Locator): Promise<void> {
  const [pinBox, elementBox] = await Promise.all([pin.boundingBox(), element.boundingBox()]);

  expect(pinBox, 'the pin was not drawn').not.toBeNull();
  expect(elementBox, 'the element it should sit on is gone').not.toBeNull();
  expect(Math.abs((pinBox?.x ?? 0) - (elementBox?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((pinBox?.y ?? 0) - (elementBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((pinBox?.width ?? 0) - (elementBox?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((pinBox?.height ?? 0) - (elementBox?.height ?? 0))).toBeLessThanOrEqual(1);
}

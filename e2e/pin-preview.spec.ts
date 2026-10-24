import { type Locator, type Page, expect, test } from '@playwright/test';
import { badgeFor, openPlayground, plantPin } from './pin.ts';

/**
 * The preview of a note over its pin (FRU-422), in place of the `title` of the browser: on the hover
 * of a mouse and on the focus of the keyboard, gone on Escape, and never under a finger.
 */

const NOTE = 'Le bouton de paiement est trop petit sur mobile, et le texte passe sur deux lignes.';

const preview = (page: Page) => page.locator('.fruitback-preview');

/** The contrast of two colours of `getComputedStyle`, by the formula of WCAG 2. */
function contrast(foreground: string, background: string): number {
  const luminance = (colour: string) => {
    const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const value = Number(part) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);

  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

async function colours(part: Locator): Promise<[string, string]> {
  return part.evaluate((element) => {
    const box = element.closest('.fruitback-preview') ?? element;
    return [getComputedStyle(element).color, getComputedStyle(box).backgroundColor] as [string, string];
  });
}

function apart(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

test('a mouse over a pin shows the preview of its note, beside the drop, and it goes with the mouse', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPlayground(page, 'preview-hover');
  await plantPin(page, page.locator('#checkout-cta'), NOTE);
  const badge = badgeFor(page, 'Le bouton de paiement');
  // The browser draws no tooltip of its own over it.
  await expect(badge).not.toHaveAttribute('title');
  const name = await badge.getAttribute('aria-label');

  await badge.hover();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(preview(page).locator('.fruitback-preview-note')).toHaveText(NOTE);
  await expect(preview(page).locator('.fruitback-preview-hint')).toHaveText('Click to open');
  // Its identifier in the tracker, which the thread links to.
  await expect(preview(page).locator('.fruitback-preview-identifier')).toHaveText(/^DEV-\d+$/);
  // Two lines of the note at most.
  const lines = await preview(page)
    .locator('.fruitback-preview-note')
    .evaluate(
      (element) => element.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(element).lineHeight),
    );
  expect(lines).toBeLessThanOrEqual(2.05);
  // Beside the drop, never on it.
  expect(apart((await preview(page).boundingBox())!, (await badge.boundingBox())!)).toBe(true);
  expect(await badge.getAttribute('aria-label')).toBe(name);
  for (const part of ['state', 'note', 'hint', 'identifier']) {
    const [ink, ground] = await colours(preview(page).locator(`.fruitback-preview-${part}`));
    expect(contrast(ink, ground), part).toBeGreaterThanOrEqual(4.5);
  }

  await page.mouse.move(5, 5);
  await expect(preview(page)).toHaveCount(0);

  // A click opens the thread, and the preview does not stay over it.
  await badge.click();
  await expect(page.locator('[data-fruitback-thread]')).toBeVisible();
  await expect(preview(page)).toHaveCount(0);
});

test('the focus of the keyboard shows the preview, and Escape takes it away', async ({ page }) => {
  await openPlayground(page, 'preview-keyboard');
  await plantPin(page, page.locator('#checkout-cta'), NOTE);
  const badge = badgeFor(page, 'Le bouton de paiement');

  await badge.focus();
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator('.fruitback-preview-hint')).toHaveText('Press Enter to open');
  await page.keyboard.press('Escape');
  await expect(preview(page)).toHaveCount(0);
  await expect(badge).toBeFocused();

  // Enter opens the thread, as before.
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-fruitback-thread]')).toBeVisible();
});

test.describe('on a touch screen at 390 px', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a tap opens the thread, and no preview shows', async ({ page }) => {
    await openPlayground(page, 'preview-touch');
    await plantPin(page, page.locator('#checkout-cta'), NOTE);
    const badge = badgeFor(page, 'Le bouton de paiement');

    await badge.tap();
    await expect(page.locator('[data-fruitback-thread]')).toBeVisible();
    await expect(preview(page)).toHaveCount(0);
  });
});

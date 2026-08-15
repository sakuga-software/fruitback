import { expect, test } from '@playwright/test';
import { openPlayground } from './pin.ts';

/**
 * The popover (SKG-493) in a browser: the two things that only exist there — a media query deciding
 * whether it is a popover or a sheet, and an animation that has to stop when the reader asked for
 * less motion.
 */

async function selectTheCta(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await page.locator('#checkout-cta').click();
  await expect(page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?")).toBeVisible();
}

test('a note goes from planting to harvested, and the pin lands', async ({ page }) => {
  await openPlayground(page, 'composer-happy');
  await selectTheCta(page);

  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Le CTA devrait être plus large');
  await page.getByRole('button', { name: 'Planter' }).click();

  // The product's own word for it, in the status the composer announces.
  await expect(page.locator('[data-fb-composer]')).toContainText(/récolté/);
  await expect(page.locator('[data-fb-pin]')).toHaveCount(1);
  // And it closes itself once the confirmation has been read.
  await expect(page.locator('[data-fb-composer]')).toBeHidden({ timeout: 5_000 });
});

test('a failed send keeps the note and stays open', async ({ page }) => {
  // The one failure this widget cannot afford. The worker is made to refuse for this test only.
  await openPlayground(page, 'composer-failure');
  await page.route('**/feedback', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"linear-unavailable"}' })
      : route.fallback(),
  );
  await selectTheCta(page);

  const note = 'Une remarque qui a pris du temps à écrire';
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill(note);
  await page.getByRole('button', { name: 'Planter' }).click();

  await expect(page.locator('[data-fb-composer]')).toContainText(/pas passé/);
  await expect(page.locator('[data-fb-composer]')).toBeVisible();
  await expect(page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?")).toHaveValue(note);
  // Retrying is one click, not one more typing session.
  await expect(page.getByRole('button', { name: 'Planter' })).toBeEnabled();
});

test('on a phone it is a sheet at the bottom, not a popover beside the element', async ({ page }) => {
  // A 320px popover anchored to an element is unusable at that width.
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlayground(page, 'composer-mobile');
  await selectTheCta(page);

  const viewport = page.viewportSize();
  const measure = () =>
    page.locator('[data-fb-composer]').evaluate((node) => {
      // Viewport coordinates, not `boundingBox()`: the sheet is `position: fixed` and the page has
      // been scrolled to reach the element, so a document-relative measurement would carry the
      // scroll offset with it.
      const rect = node.getBoundingClientRect();

      return { left: Math.round(rect.left), right: Math.round(rect.right), bottom: Math.round(rect.bottom) };
    });

  // Polled, because `toBeVisible()` resolves the moment the sheet appears — which is while it is
  // still sliding up from below the fold, translated by its own height.
  await expect.poll(async () => (await measure()).bottom).toBe(viewport?.height);

  const box = await measure();
  expect(box.left).toBeLessThanOrEqual(1);
  expect(box.right).toBe(viewport?.width);
});

test('it stays inside the viewport when the element is against the right edge', async ({ page }) => {
  // The popover is clamped against its declared width, so the rendered box has to match it — with
  // content-box the padding sat outside and the popover overhung the edge by that much.
  await openPlayground(page, 'composer-edge');
  await page.getByRole('button', { name: /Laisser un feedback/ }).click();
  await page.locator('main header button').click();
  await expect(page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?")).toBeVisible();

  const viewport = page.viewportSize();
  await expect
    .poll(async () =>
      page.locator('[data-fb-composer]').evaluate((node) => Math.round(node.getBoundingClientRect().right)),
    )
    .toBeLessThanOrEqual(viewport?.width ?? 0);
});

test('it honours a reader who asked for less motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPlayground(page, 'composer-reduced-motion');
  await selectTheCta(page);

  const animation = await page
    .locator('[data-fb-composer]')
    .evaluate((node) => getComputedStyle(node).animationName);

  expect(animation).toBe('none');
});

test('the pin is a drop, and it says what it is to a screen reader', async ({ page }) => {
  await openPlayground(page, 'composer-pin-shape');
  await selectTheCta(page);
  await page.getByPlaceholder("Qu'est-ce qui ne va pas ici ?").fill('Un pin en goutte');
  await page.getByRole('button', { name: 'Planter' }).click();
  await expect(page.locator('[data-fb-pin]')).toHaveCount(1);

  const badge = page.locator('.fb-pin-badge');
  const shape = await badge.evaluate((node) => {
    const style = getComputedStyle(node);

    return { radius: style.borderRadius, transform: style.transform };
  });

  // Three round corners and one sharp, turned to point at the element.
  expect(shape.radius).toMatch(/50%/);
  expect(shape.transform).not.toBe('none');
  // The note lives in the accessible name now that the badge carries an emoji.
  await expect(badge).toHaveAttribute('aria-label', /Un pin en goutte/);
});

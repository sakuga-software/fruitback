import { expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The widget in a right-to-left language (SKG-531).
 *
 * What flips is layout: the dock moves to the reader's corner and the popover opens on the element's
 * right edge. What must not flip is geometry: a pin sits on the element it belongs to, whatever the
 * direction. No unit test sees either, because happy-dom neither resolves a logical property nor
 * lays anything out.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

/** Only the words this spec clicks. Every other key falls back to English, and still reads right to left. */
const ARABIC = {
  'launch.label': 'اترك ملاحظة',
  'composer.placeholder': 'ما المشكلة هنا؟',
  'composer.send': 'ازرع',
};

test('in Arabic the dock and the popover move, and the pin stays on its element', async ({ page }) => {
  // The popover scales in from 96%, which moves its right edge by up to six pixels mid-animation.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const attempt = test.info().retry;
  await page.goto(`/?widget=off&case=${attempt === 0 ? 'rtl' : `rtl-retry${attempt}`}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, messages }) =>
      (globalThis as { Fruitback: { init(options: Record<string, unknown>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'ar',
        messages: { ar: messages },
      }),
    { endpoint: WORKER_ORIGIN, messages: ARABIC },
  );

  await expect(page.locator('[data-fruitback-host]')).toHaveAttribute('dir', 'rtl');

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const launch = page.getByRole('button', { name: ARABIC['launch.label'] });
  const dock = await launch.boundingBox();
  expect(dock, 'the launch button is not laid out').not.toBeNull();
  // The inline end of a right-to-left page is its left side.
  expect(dock!.x + dock!.width).toBeLessThan(viewport!.width / 2);

  const target = page.locator('[data-testid="card-latte"] .add');
  await launch.click();
  await target.click();

  await expect(page.getByPlaceholder(ARABIC['composer.placeholder']), 'the popover did not open').toBeVisible();

  // Polled: the popover is placed after it opens. The popover's right edge meets the element's, unless
  // the viewport clamps it. Two pixels absorb rounding; a left-to-right placement would miss by the
  // popover's width less the element's.
  await expect
    .poll(
      async () => {
        const [element, composer] = await Promise.all([
          target.boundingBox(),
          page.locator('[data-fruitback-composer]').boundingBox(),
        ]);
        if (element === null || composer === null) return Number.POSITIVE_INFINITY;
        const expectedRight = Math.max(10 + composer.width, Math.min(element.x + element.width, viewport!.width - 10));

        return Math.abs(composer.x + composer.width - expectedRight);
      },
      { message: 'the popover never met the element on its right edge' },
    )
    .toBeLessThanOrEqual(2);

  await page.getByPlaceholder(ARABIC['composer.placeholder']).fill('يمين إلى يسار');
  await page.getByRole('button', { name: ARABIC['composer.send'], exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // Polled, and the value that satisfied the poll is kept: the pin is drawn after the read comes back.
  let pin: { x: number; y: number; width: number; height: number } | null = null;
  await expect
    .poll(async () => {
      pin = await page.locator('[data-fruitback-pin]').boundingBox();
      const now = await target.boundingBox();
      if (pin === null || now === null) return Number.POSITIVE_INFINITY;

      return Math.max(
        Math.abs(pin.x - now.x),
        Math.abs(pin.y - now.y),
        Math.abs(pin.width - now.width),
        Math.abs(pin.height - now.height),
      );
    })
    .toBeLessThanOrEqual(1);
  expect(pin).not.toBeNull();
});

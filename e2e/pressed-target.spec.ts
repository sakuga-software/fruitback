import { expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';

/**
 * A button that is smaller while it is pressed (FRU-489). HeroUI draws a pressed button at
 * `scale(0.97)` under `[data-pressed]`, and React Aria takes the press off up to 80 ms after the
 * click, as the widget stops that click. The element is chosen at the click, so the frame and the
 * composer were placed on the pressed box, and stayed there: scroll and resize do not fire, and a
 * ResizeObserver does not see a transform. Off by 1.5 % of the width of the button, 1.2 px here.
 *
 * Real layout and a real press: happy-dom has neither.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';

const ARABIC = {
  'launch.label': 'اترك ملاحظة',
  'composer.placeholder': 'ما المشكلة هنا؟',
};

const CASES = [
  // Under reduced motion the button has no transition: it is pressed, then it is not.
  { name: 'right to left, reduced motion', locale: 'ar', motion: 'reduce' },
  // With motion it grows back over the frames of a transition, and the composer grows in too.
  { name: 'left to right, with motion', locale: 'en', motion: 'no-preference' },
] as const;

for (const each of CASES) {
  test(`the frame and the composer meet a button that shrank while it was pressed, ${each.name}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: each.motion });
    await page.goto(`/?widget=off&case=${caseOf(`pressed-${each.locale}`)}`);
    await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
    await page.addScriptTag({ path: IIFE });
    await page.evaluate(
      ({ endpoint, locale, messages }) =>
        (globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } }).Fruitback.init({
          endpoint,
          clientId: 'playground',
          locale,
          messages: { ar: messages },
        }),
      { endpoint: WORKER_ORIGIN, locale: each.locale, messages: ARABIC },
    );
    const rtl = each.locale === 'ar';
    await expect(page.locator('[data-fruitback-host]')).toHaveAttribute('dir', rtl ? 'rtl' : 'ltr');

    const target = page.locator('[data-testid="card-latte"] .add');
    const released = await target.boundingBox();
    expect(released, 'the button is not laid out').not.toBeNull();
    await page.getByRole('button', { name: rtl ? ARABIC['launch.label'] : 'Leave feedback' }).click();
    // The control: the width of the button when the widget reads it, at the click on it,
    // read before the widget reads it.
    await target.evaluate((element) => {
      window.addEventListener(
        'click',
        () => {
          (element as HTMLElement).dataset.widthAtClick = String(element.getBoundingClientRect().width);
        },
        { capture: true, once: true },
      );
    });

    // Held until the press has drawn the button at its smallest, as a person's press does: a click of
    // Playwright lets go before a transition of the press has moved anything.
    const center = { x: released!.x + released!.width / 2, y: released!.y + released!.height / 2 };
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await expect
      .poll(() => target.evaluate((element) => getComputedStyle(element).transform))
      .toMatch(/^matrix\(0\.97, 0, 0, 0\.97/);
    await page.mouse.up();
    await expect(page.getByPlaceholder(rtl ? ARABIC['composer.placeholder'] : 'What should change?')).toBeVisible();
    const atClick = Number(await target.getAttribute('data-width-at-click'));
    expect(atClick, 'the button was not smaller at the click: this spec proves nothing').toBeLessThan(
      released!.width - 1,
    );

    // The press is over, and the button has its own box again.
    await expect
      .poll(() =>
        target.evaluate((element) => ({
          pressed: element.hasAttribute('data-pressed'),
          transform: getComputedStyle(element).transform,
        })),
      )
      .toEqual({ pressed: false, transform: 'matrix(1, 0, 0, 1, 0, 0)' });

    // The frame stands 5 px off the element on every side (FRU-303). The composer meets the frame on
    // its start edge: the left in English, the right in Arabic. Half a pixel absorbs the rounding of
    // layout to 1/64 px. Before FRU-489 both stayed on the pressed box, 1.2 px off.
    await expect
      .poll(
        async () => {
          const [element, frame, composer] = await Promise.all([
            target.boundingBox(),
            page.locator('[data-fruitback-host-highlight]').boundingBox(),
            page.locator('[data-fruitback-composer]').boundingBox(),
          ]);
          if (element === null || frame === null || composer === null) return Number.POSITIVE_INFINITY;
          // Unless the window holds it 10 px inside its edge, as `place` does.
          const width = page.viewportSize()!.width;
          const start = rtl
            ? composer.x +
              composer.width -
              Math.max(10 + composer.width, Math.min(element.x + element.width + 5, width - 10))
            : composer.x - Math.min(Math.max(element.x - 5, 10), width - composer.width - 10);

          return Math.max(
            Math.abs(frame.x - (element.x - 5)),
            Math.abs(frame.y - (element.y - 5)),
            Math.abs(frame.width - (element.width + 10)),
            Math.abs(frame.height - (element.height + 10)),
            Math.abs(start),
          );
        },
        { message: 'the frame or the composer stayed on the pressed box', timeout: 3_000 },
      )
      .toBeLessThanOrEqual(0.5);
  });
}

import { type Page, expect } from '@playwright/test';

/**
 * Waits until the animations and transitions of the page that will end have ended. axe measures the
 * contrast of what is drawn now: a line that fades in from `opacity: 0` and is not at its end fails
 * `color-contrast` (`.popup-screen-2 .kit-dl-entry`, FRU-298).
 *
 * An animation that never ends is left alone: one with infinite iterations (a spinner), and one that
 * is paused (the time bar of a notice under the pointer). An animation that is cancelled while this
 * waits rejects `finished`; it is drawn no more, so it counts as ended.
 */
export async function settled(surface: Page): Promise<void> {
  await surface.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/**
 * Waits until the settings of a connector are open in their dialog (FRU-690), and the dialog has
 * ended its zoom (HeroUI's Modal). Playwright finds a control stable while the dialog still grows, and
 * boxes measured before the end are not the last ones. Call it after the press that opens the
 * settings, before a click in them or a measure of them.
 */
export async function unfolded(page: Page): Promise<void> {
  await expect(page.locator('#source-panel')).toBeVisible();
  await settled(page);
}

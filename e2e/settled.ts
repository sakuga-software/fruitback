import type { Page } from '@playwright/test';

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

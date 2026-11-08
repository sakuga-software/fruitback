import { expect, test } from '@playwright/test';
import { settled } from './settled.ts';

/**
 * `settled` waits for what ends, and only for that (finding #a5b8fc of #869). A spinner, a paused
 * bar and an animation cancelled mid-way are on the page beside a fade: the wait ends, and the fade
 * is at its end.
 */
test('settled waits for a fade, and not for a spinner, a paused bar or a cancelled animation', async ({ page }) => {
  test.setTimeout(10_000);
  await page.setContent(`
    <style>
      @keyframes turn { to { rotate: 1turn; } }
      #spinner { animation: turn 1s linear infinite; }
      #paused { animation: turn 1s linear forwards paused; }
      #fade { transition: opacity 0.4s; }
    </style>
    <div id="spinner">spinner</div>
    <div id="paused">paused</div>
    <div id="cancelled">cancelled</div>
    <div id="fade" style="opacity: 0">fade</div>
  `);
  await page.evaluate(() => {
    const cancelled = document.querySelector('#cancelled') as HTMLElement;
    const animation = cancelled.animate([{ opacity: 0 }, { opacity: 1 }], 2000);
    setTimeout(() => animation.cancel(), 100);
    const fade = document.querySelector('#fade') as HTMLElement;
    fade.getBoundingClientRect();
    fade.style.opacity = '1';
  });
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(4);

  await settled(page);

  expect(await page.locator('#fade').evaluate((node) => getComputedStyle(node).opacity)).toBe('1');
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .map((each) => each.playState)
        .toSorted(),
    ),
  ).toEqual(['paused', 'running']);
});

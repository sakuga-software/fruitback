import { type Page, expect, test } from '@playwright/test';
import { box, stubWorker } from './console-workspace.ts';

/**
 * The drop of the entry of the rail on screen slides to the next entry in a move (FRU-413). It is a
 * picture of its own in the view transition of FRU-356 (`rail-drop`), so its group animates from the
 * box of the entry of before to the box of the new one. With reduced motion it does not move.
 * The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

type Seen = { duration: number; easing: string; transforms: string[] };

/** Reads, at each frame, the animation of the group of the drop, until a move ends. */
async function watchDrop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const found: Seen[] = [];
    (window as unknown as { drop: Seen[] }).drop = found;
    const tick = () => {
      for (const animation of document.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        if (effect?.pseudoElement !== '::view-transition-group(rail-drop)') continue;
        const timing = effect.getComputedTiming();
        found.push({
          duration: Number(timing.duration),
          // A CSS animation keeps its timing function on its keyframes.
          easing: String(effect.getKeyframes()[0]?.easing ?? ''),
          transforms: effect.getKeyframes().map((frame) => String(frame.transform ?? '')),
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const seenDrop = (page: Page) => page.evaluate(() => (window as unknown as { drop: Seen[] }).drop);

/** The vertical offset of a `matrix(…)` or `translate(…)` transform. */
function offsetY(transform: string): number {
  const matrix = /matrix\(([^)]+)\)/.exec(transform);
  if (matrix !== null) return Number(matrix[1]?.split(',')[5]);
  const translate = /translate\([^,]+,\s*([-\d.]+)px\)/.exec(transform);

  return translate === null ? Number.NaN : Number(translate[1]);
}

async function moveFromSitesToConnectors(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.getByRole('link', { name: 'Sites' })).toHaveAttribute('aria-current', 'page');
  await watchDrop(page);
  await nav.getByRole('link', { name: 'Connectors' }).click();
  await expect(nav.getByRole('link', { name: 'Connectors' })).toHaveAttribute('aria-current', 'page');
  await page.waitForTimeout(400);
}

test('the drop of the rail slides from the entry of before to the new one (FRU-413)', async ({ page }) => {
  await stubWorker(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  // The two entries, to know how far the drop goes: the drop is inside the entry on screen.
  const sites = await box(nav.getByRole('link', { name: 'Sites' }));
  const connectors = await box(nav.getByRole('link', { name: 'Connectors' }));

  await moveFromSitesToConnectors(page);
  const seen = await seenDrop(page);
  // The control: the move had a picture of the drop, which animated.
  expect(seen.length).toBeGreaterThan(0);
  const [first] = seen;
  expect(first?.duration).toBe(220);
  expect(first?.easing).toBe('cubic-bezier(0.16, 1, 0.3, 1)');
  // From the place of the drop in « Sites » to its place in « Connectors », down the rail.
  const from = offsetY(first?.transforms.at(0) ?? '');
  const to = offsetY(first?.transforms.at(-1) ?? '');
  expect(to - from).toBeCloseTo(connectors.y - sites.y, 0);

  // At the end, the drop is in the new entry, and only there.
  await expect(nav.locator('.kit-rail-drop')).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'Connectors' }).locator('.kit-rail-drop')).toHaveCount(1);
});

test('with reduced motion, the drop is at its new place at once', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await stubWorker(page);
  await moveFromSitesToConnectors(page);
  // The rule of FRU-356 takes every animation of a move away: the drop has none.
  expect((await seenDrop(page)).filter((each) => each.duration > 0)).toEqual([]);
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Connectors' })
      .locator('.kit-rail-drop'),
  ).toHaveCount(1);
  await context.close();
});

import { expect, type Page, test } from '@playwright/test';
import { openPlayground } from './pin.ts';

/**
 * A fixed element at a scroll (FRU-457). The frame and the composer are drawn in document coordinates,
 * and a fixed sidebar moves against the document as the page scrolls. Before the fix, both scrolled
 * away from a link that stayed where it was in the window. Real layout and real scroll: happy-dom has
 * neither.
 */

/** A link fixed to the left of the window, and a page tall enough to scroll. */
async function addFixedLink(page: Page): Promise<void> {
  await page.evaluate(() => {
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Instance');
    nav.style.cssText = 'position: fixed; left: 16px; top: 200px; z-index: 10; background: #fff; padding: 8px;';
    const link = document.createElement('a');
    link.id = 'fixed-link';
    link.href = '#administration';
    link.textContent = 'Administration';
    nav.append(link);
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    document.body.append(nav, spacer);
  });
}

/** The composer grows in from its corner: a box measured during that animation is off by a few pixels. */
async function settled(page: Page): Promise<void> {
  await expect(page.getByPlaceholder('What should change?')).toBeVisible();
  await page
    .locator('[data-fruitback-composer]')
    .evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
}

/** The top of each box in the window, rounded: the link, the frame and the composer. */
function tops(page: Page) {
  return page.evaluate(() => {
    const top = (element: Element | null | undefined) =>
      element === null || element === undefined ? null : Math.round(element.getBoundingClientRect().top);
    const shadow = document.querySelector('[data-fruitback-host]')?.shadowRoot;

    return {
      link: top(document.querySelector('#fixed-link')),
      frame: top(shadow?.querySelector('[data-fruitback-host-highlight]')),
      composer: top(shadow?.querySelector('[data-fruitback-composer]')),
    };
  });
}

test('the frame and the composer stay on a fixed link when the page scrolls', async ({ page }) => {
  await openPlayground(page, 'scroll-fixed');
  await addFixedLink(page);

  // In a capture: the frame is on the link under the pointer.
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('#fixed-link').hover();
  const hovered = await tops(page);
  expect(hovered.frame).not.toBeNull();
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await tops(page)).frame).toBe(hovered.frame);

  // Chosen: the frame is held and the composer opens beside the link.
  await page.locator('#fixed-link').click();
  await settled(page);
  const opened = await tops(page);
  await page.mouse.wheel(0, 500);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(600);
  await expect.poll(async () => (await tops(page)).frame).toBe(opened.frame);
  await expect.poll(async () => (await tops(page)).composer).toBe(opened.composer);
  expect((await tops(page)).link).toBe(opened.link);
});

test('the composer of an element that scrolls with the page stays with that element', async ({ page }) => {
  // The other half: an element of the document keeps its composer at its place in the document, so
  // the composer leaves the window with it rather than slide along the window.
  await openPlayground(page, 'scroll-static');
  await addFixedLink(page);
  await page.getByRole('button', { name: /Leave feedback/ }).click();
  await page.locator('#checkout-cta').click();
  await settled(page);
  const cta = () => page.locator('#checkout-cta').evaluate((node) => Math.round(node.getBoundingClientRect().top));
  const before = await tops(page);
  const ctaBefore = await cta();

  await page.mouse.wheel(0, 300);
  await expect.poll(cta).toBeLessThan(ctaBefore);
  const moved = ctaBefore - (await cta());
  const after = await tops(page);
  // Within a pixel: the element sits on a fraction of a pixel, and each top is rounded on its own.
  expect(Math.abs((after.composer ?? 0) - ((before.composer ?? 0) - moved))).toBeLessThanOrEqual(1);
  expect(Math.abs((after.frame ?? 0) - ((before.frame ?? 0) - moved))).toBeLessThanOrEqual(1);
});

import { type Locator, type Page, expect, test } from '@playwright/test';
import { badgeFor, openPlayground, plantPin } from './pin.ts';

/**
 * The bubble of a note opens under its element, above it or beside it, where the window has the room,
 * and never covers it (FRU-421). An element that leaves the room on no side gets the bubble beside its
 * pin, as before (FRU-304), with no arrow.
 *
 * Each case puts one element on the page, where only one side has the room, plants a note on it and
 * opens the thread.
 */

type Rect = { x: number; y: number; width: number; height: number };

async function element(page: Page, box: { left: number; top: number; width: number; height: number }) {
  await page.evaluate((at) => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    const node = document.createElement('div');
    node.id = 'side-probe';
    node.textContent = 'Probe';
    Object.assign(node.style, {
      position: 'absolute',
      left: `${at.left}px`,
      top: `${at.top}px`,
      width: `${at.width}px`,
      height: `${at.height}px`,
      zIndex: '1000',
      background: '#e7e5e4',
    });
    document.body.append(node);
  }, box);

  return page.locator('#side-probe');
}

/**
 * The box of `locator` once it is the same in two reads 100 ms apart. The pins, and an open thread, are
 * drawn again when the read that follows a send answers: a box read during that draw is `null`.
 */
async function steadyBox(locator: Locator): Promise<Rect> {
  let last = '';
  await expect
    .poll(
      async () => {
        const now = JSON.stringify(await locator.boundingBox());
        const steady = now !== 'null' && now === last;
        last = now;
        return steady;
      },
      { intervals: [100] },
    )
    .toBe(true);

  return JSON.parse(last) as Rect;
}

function apart(a: Rect, b: Rect): boolean {
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

const CASES: {
  name: string;
  window: [number, number];
  box: { left: number; top: number; width: number; height: number };
  arrow: string | undefined;
}[] = [
  { name: 'under', window: [1280, 800], box: { left: 200, top: 100, width: 300, height: 40 }, arrow: 'top' },
  { name: 'above', window: [1280, 800], box: { left: 200, top: 680, width: 300, height: 50 }, arrow: 'bottom' },
  { name: 'end side', window: [1280, 800], box: { left: 100, top: 60, width: 300, height: 640 }, arrow: 'left' },
  { name: 'start side', window: [1280, 800], box: { left: 840, top: 60, width: 300, height: 640 }, arrow: 'right' },
  { name: 'fallback', window: [1280, 800], box: { left: 0, top: 0, width: 1280, height: 800 }, arrow: undefined },
  // A phone leaves no room for 344 px beside an element: under, above, or beside the pin.
  { name: 'under', window: [390, 844], box: { left: 40, top: 100, width: 300, height: 40 }, arrow: 'top' },
  { name: 'above', window: [390, 844], box: { left: 40, top: 520, width: 300, height: 200 }, arrow: 'bottom' },
  { name: 'fallback', window: [390, 844], box: { left: 0, top: 0, width: 390, height: 844 }, arrow: undefined },
];

for (const each of CASES) {
  test(`at ${each.window[0]} px, the thread opens ${each.name === 'fallback' ? 'beside its pin, when its element fills the window' : `${each.name.includes('side') ? 'on the ' : ''}${each.name} its element`}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: each.window[0], height: each.window[1] });
    await openPlayground(page, `thread-side-${each.name.replace(' ', '-')}-${each.window[0]}`);
    const probe = await element(page, each.box);
    const note = `La bulle de ce côté-ci, ${each.name}, à ${each.window[0]} px.`;
    await plantPin(page, probe, note);
    // At the top of the page, at once: the page of the playground scrolls smoothly, and a pin sent
    // scrolls it on its way back to the note.
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    // A click where the drop is, with no scroll: the click of a locator scrolls the page to its own
    // liking, and the side that has the room depends on the scroll.
    const drop = await steadyBox(badgeFor(page, 'La bulle de ce côté-ci'));
    await page.mouse.click(drop.x + drop.width / 2, drop.y + drop.height / 2);
    const thread = page.locator('[data-fruitback-thread]');
    await expect(thread).toBeVisible();

    if (each.arrow === undefined) await expect(thread).not.toHaveAttribute('data-fruitback-arrow');
    else await expect(thread).toHaveAttribute('data-fruitback-arrow', each.arrow);

    // Nothing scrolled the page under the case it sets up.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const bubble = await steadyBox(thread);
    // Inside the window.
    expect(bubble.x).toBeGreaterThanOrEqual(0);
    expect(bubble.y).toBeGreaterThanOrEqual(0);
    expect(bubble.x + bubble.width).toBeLessThanOrEqual(each.window[0]);
    expect(bubble.y + bubble.height).toBeLessThanOrEqual(each.window[1]);
    // The element stays in sight, but in the fallback.
    if (each.arrow !== undefined) expect(apart(bubble, await steadyBox(probe))).toBe(true);
  });
}

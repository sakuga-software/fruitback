import { type Locator, type Page, expect, test } from '@playwright/test';
import { badgeFor, openPlayground, plantPin } from './pin.ts';

/**
 * A pin stays visible over the dock and over the settings of the widget (FRU-666). On a site, the
 * reporter comes back to see their notes: a pin hidden under the dock of the widget is a note lost.
 * The composer, the area capture and an open thread stay above the pins.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const NOTE = 'The heading of the offers is too small';

/**
 * Plants a note on a paragraph at the end side of the page, under the column of the dock. The badge
 * stands on the start corner of its element, and no element of the playground reaches that column.
 */
async function plantUnderTheDock(page: Page, testCase: string): Promise<Locator> {
  await openPlayground(page, testCase);
  const dock = await page.locator('[data-fruitback-dock]').boundingBox();
  if (dock === null) throw new Error('the dock is not on the screen');
  await page.evaluate((left) => {
    const offer = document.createElement('p');
    offer.id = 'offer-at-the-end';
    offer.textContent = 'Free delivery from two bags';
    offer.style.cssText = `position: absolute; left: ${left}px; top: 1400px; margin: 0; width: 120px;`;
    document.body.append(offer);
    // Room under the paragraph, so that a scroll can bring its badge to any height of the window.
    document.body.style.paddingBottom = '1000px';
  }, dock.x + 60);
  await plantPin(page, page.locator('#offer-at-the-end'), NOTE);

  return badgeFor(page, NOTE);
}

/** Scrolls the page so that the centre of the badge is on the centre of `target`, on the vertical axis. */
async function scrollBadgeOnto(page: Page, badge: Locator, target: Locator): Promise<void> {
  const [from, to] = [await badge.boundingBox(), await target.boundingBox()];
  if (from === null || to === null) throw new Error('the badge or its target is not on the screen');
  await page.evaluate((by) => window.scrollBy(0, by), from.y + from.height / 2 - (to.y + to.height / 2));
}

/** What is painted at the centre of the badge, asked of the badge's own Shadow root. */
async function onTop(badge: Locator): Promise<string> {
  return badge.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const root = element.getRootNode() as Document | ShadowRoot;
    const hit = root.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

    return hit?.closest('.fruitback-pin-badge') === element ? 'the badge' : String(hit?.className);
  });
}

test('a pin under the dock is drawn over it, and the dock still answers beside it', async ({ page }) => {
  const badge = await plantUnderTheDock(page, 'pin-over-dock');
  const dock = page.locator('[data-fruitback-dock]');
  await scrollBadgeOnto(page, badge, dock);
  await page.screenshot({ path: test.info().outputPath('pin-over-dock.png') });

  expect(await onTop(badge)).toBe('the badge');
  // The other direction: the buttons of the dock that the badge does not cover still take a click.
  await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
  await expect(page.locator('.fruitback-panel-config')).toBeVisible();
});

test('a pin under the settings is drawn over them', async ({ page }) => {
  const badge = await plantUnderTheDock(page, 'pin-over-settings');
  await page.getByRole('button', { name: 'Open Fruitback settings' }).click();
  const settings = page.locator('.fruitback-panel-config');
  await expect(settings).toBeVisible();
  await scrollBadgeOnto(page, badge, settings);
  await page.screenshot({ path: test.info().outputPath('pin-over-settings.png') });

  const [onBadge, onPanel] = [await badge.boundingBox(), await settings.boundingBox()];
  expect(onBadge!.y, 'the badge is not over the settings').toBeGreaterThan(onPanel!.y);
  expect(await onTop(badge)).toBe('the badge');
});

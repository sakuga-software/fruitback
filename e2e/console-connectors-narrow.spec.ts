import { type Locator, type Page, expect, test } from '@playwright/test';
import { box, sideScroll, styles } from './console-workspace.ts';
import {
  ADDRESS,
  LINEAR,
  catalogue,
  expectNoViolation,
  open,
  rows,
  search,
  settingsOf,
  tile,
  tiles,
  workerWith,
} from './console-connectors-stub.ts';

/**
 * The Connectors screen on a tablet and on a phone (FRU-727), against the mockups of the ticket at
 * 834 and 390 px. At 834 px the table drops « Used by » and the catalogue has two tiles in a row; at
 * 390 px each connector is a card, the search takes the whole width in 16 px, and the groups stay on
 * one line. A finger reaches every control of a row and of a tile in 44 px. The worker is answered
 * by stubs, and the sample data is of nobody.
 */

const HEALTH = { failing: 0, notes: 31, lastDeliveredAt: '2026-10-12T09:00:00.000Z' };

/** A Linear that the worker says is healthy, and an address whose two sends wait. */
async function twoConnectors(page: Page): Promise<void> {
  const worker = await workerWith(page);
  worker.connectors = [
    { ...LINEAR, health: HEALTH },
    { ...ADDRESS, health: { failing: 2, notes: 4, lastDeliveredAt: '2026-10-12T08:00:00.000Z' } },
  ];
  await open(page);
}

const centre = (found: { y: number; height: number }) => found.y + found.height / 2;

/** The element that a press at this point of the page reaches. */
const reached = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.closest('button')?.getAttribute('aria-label') ?? '', [
    x,
    y,
  ] as const);

test('at 834 px the table drops « Used by », keeps « Retry » in its frame, and the catalogue has two tiles in a row', async ({
  page,
}) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  await twoConnectors(page);
  await expect(rows(page)).toHaveCount(2);
  const frame = page.locator('.kit-table');
  await expect(frame).toHaveAttribute('data-stacked', 'false');

  // « Used by » is 0 px wide, and its head is said to a screen reader only.
  const head = page.locator('.kit-table thead th').nth(2);
  await expect(head).toHaveText('Used by');
  expect((await box(head)).width).toBeLessThan(1);
  await expect(rows(page).first().locator('[data-used-by] > *')).toBeHidden();

  // Nothing of a row goes past its frame, which does not scroll.
  expect(await frame.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
  const edge = (await box(frame)).x + (await box(frame)).width;
  const address = rows(page).nth(1);
  for (const control of [address.getByRole('button', { name: 'Retry REST API' }), settingsOf(page, 'REST API')]) {
    await expect(control).toBeVisible();
    expect((await box(control)).x + (await box(control)).width).toBeLessThanOrEqual(edge);
  }

  // The head of the catalogue holds on one line: its title, the search, and the groups.
  const title = catalogue(page).getByRole('heading', { name: 'Add a connector' });
  const groups = catalogue(page).getByRole('group', { name: 'Kind of connector' });
  expect(Math.abs(centre(await box(search(page))) - centre(await box(title)))).toBeLessThan(4);
  expect(Math.abs(centre(await box(groups)) - centre(await box(title)))).toBeLessThan(4);
  expect((await box(search(page))).width).toBeLessThanOrEqual(220);

  // Two tiles in a row, none narrower than 260 px, all of the same height.
  const [first, second, third] = await Promise.all([0, 1, 2].map(async (index) => box(tiles(page).nth(index))));
  expect(second!.y).toBe(first!.y);
  expect(third!.y).toBeGreaterThan(first!.y);
  for (const each of await tiles(page).all()) {
    expect((await box(each)).width).toBeGreaterThanOrEqual(260);
    expect((await box(each)).height).toBe(64);
  }
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, '834 px');

  // FRU-738: the table is 20 px from the edges of the screen, so it is wider. Up to 900 px « Used by »
  // stays 0 px wide: « Account » takes the room left (12 px went to « Used by » at 860 px before).
  for (const width of [860, 899]) {
    await page.setViewportSize({ width, height: 1112 });
    await expect.poll(async () => (await box(frame)).width, `the table at ${width} px`).toBe(width - 40);
    expect((await box(head)).width, `« Used by » at ${width} px`).toBeLessThan(1);
  }
});

test('at 390 px a connector is a card: its logo, its name and « … », its account, its health and sites, then « Retry »', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await twoConnectors(page);
  await expect(page.locator('.kit-table')).toHaveAttribute('data-stacked', 'true');

  for (const [index, name] of [
    [0, 'Linear'],
    [1, 'REST API'],
  ] as const) {
    const card = rows(page).nth(index);
    const cardBox = await box(card);
    const named = await box(card.locator('td').first().getByText(name, { exact: true }));
    const logo = await box(card.locator('[aria-hidden="true"]:has(img[data-logo])'));
    const more = await box(settingsOf(page, name));
    const account = await box(card.locator('[data-source-line]'));
    const health = await box(card.locator('[data-pill]'));
    const used = await box(card.locator('[data-used-by] > span'));

    // The logo of 32 px at the left of the card, the name beside it, « … » at its right on its line.
    expect.soft({ width: logo.width, height: logo.height }, name).toEqual({ width: 32, height: 32 });
    expect.soft(logo.x + logo.width, name).toBeLessThan(named.x);
    expect.soft(Math.abs(centre(more) - centre(named)), name).toBeLessThan(6);
    expect.soft(more.x + more.width, name).toBeLessThanOrEqual(cardBox.x + cardBox.width - 8);
    // The account under the name, where the name starts.
    expect.soft(account.y, name).toBeGreaterThanOrEqual(named.y + named.height - 1);
    expect.soft(Math.abs(account.x - named.x), name).toBeLessThan(1);
    // The health under the account, and the sites on the same line, after it.
    expect.soft(health.y, name).toBeGreaterThanOrEqual(account.y + account.height - 1);
    expect.soft(Math.abs(health.x - named.x), name).toBeLessThan(1);
    expect.soft(Math.abs(centre(used) - centre(health)), name).toBeLessThan(4);
    expect.soft(used.x, name).toBeGreaterThan(health.x + health.width);
  }

  // « 2 sites · 31 notes · <when> »: a dot ends the sites, so a line that goes on starts with the time.
  const linear = rows(page).first();
  const dot = await linear
    .locator('[data-used-by]')
    .evaluate((element) => getComputedStyle(element, '::after').content);
  expect(dot).toBe('"·"');
  const when = await box(linear.locator('[data-last-delivery]'));
  expect(Math.abs(centre(when) - centre(await box(linear.locator('[data-used-by] > span'))))).toBeLessThan(4);

  // « Retry » on a line of its own, at the right of the card, under its health.
  const address = rows(page).nth(1);
  const retry = await box(address.getByRole('button', { name: 'Retry REST API' }));
  const card = await box(address);
  expect(retry.y).toBeGreaterThan((await box(address.locator('[data-last-delivery]'))).y);
  expect(Math.abs(retry.x + retry.width - (card.x + card.width - 20))).toBeLessThan(2);
  // A card with no « Retry » ends under its health.
  const linearCard = await box(linear);
  expect(linearCard.y + linearCard.height - (await box(linear.locator('[data-pill]'))).y).toBeLessThan(40);
  expect(await sideScroll(page)).toBe(0);
});

test('at 390 px the search takes the whole width in 16 px, and the groups stay on one line', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await twoConnectors(page);
  const section = await box(catalogue(page));
  const field = await box(search(page));
  expect(Math.abs(field.width - section.width)).toBeLessThan(1);
  expect.soft(await styles(search(page), ['font-size', 'height'])).toEqual({ 'font-size': '16px', height: '44px' });

  // The groups, under the search, on one line that scrolls sideways if it must, 44 px high.
  const groups = catalogue(page).getByRole('group', { name: 'Kind of connector' });
  expect((await box(groups)).y).toBeGreaterThanOrEqual(field.y + field.height);
  const pressed = await groups.getByRole('button').all();
  const tops = await Promise.all(pressed.map(async (each) => (await box(each)).y));
  expect(new Set(tops).size).toBe(1);
  for (const each of pressed) expect((await box(each)).height).toBe(44);

  // One tile in a row, each as high as the others.
  const heights = new Set<number>();
  for (const each of await tiles(page).all()) {
    const found = await box(each);
    expect(Math.abs(found.width - section.width)).toBeLessThan(1);
    heights.add(found.height);
  }
  expect([...heights]).toEqual([64]);
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, '390 px, the catalogue');
});

/** Where a press 21 px above the centre of a control lands: inside 44 px for a finger. */
async function above(page: Page, control: Locator): Promise<string> {
  const found = await box(control);

  return reached(page, found.x + found.width / 2, centre(found) - 21);
}

test.describe('with a finger', () => {
  test.use({ hasTouch: true });

  for (const width of [834, 390]) {
    test(`at ${width} px « … », « Retry » and a button of a tile take a press in 44 px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await twoConnectors(page);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
      for (const label of ['Settings of REST API', 'Retry REST API', 'Add another Linear (1 connected)'])
        expect(await above(page, page.getByRole('button', { name: label, exact: true })), label).toBe(label);
      // A button of the tile stays inside its tile.
      const plus = await box(tile(page, 'Linear').getByRole('button', { name: 'Add another Linear (1 connected)' }));
      const tileBox = await box(tile(page, 'Linear'));
      expect(centre(plus) - 22).toBeGreaterThanOrEqual(tileBox.y);
      expect(centre(plus) + 22).toBeLessThanOrEqual(tileBox.y + tileBox.height);
    });
  }
});

test('with a mouse, a press beside a control is not its own', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await twoConnectors(page);
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
  for (const label of ['Settings of REST API', 'Add another Linear (1 connected)'])
    expect(await above(page, page.getByRole('button', { name: label, exact: true })), label).not.toBe(label);
});

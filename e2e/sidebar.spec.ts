import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf } from './pin.ts';

/**
 * The list of every note of the page (FRU-129), on the widget as `init` assembles it.
 *
 * The playground builds the widget part by part and does not have the list, so this spec loads the
 * built script, like `package.spec.ts`.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string): Promise<void> {
  // A page of its own for each retry and each repetition: the worker keeps the notes of the run, and
  // a second run on the same page found the notes of the first instead of « No note on this page yet. ».
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
}

async function plant(page: Page, card: string, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator(`[data-testid="${card}"] .add`).click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(note) }).first()).toBeVisible();
  // The popover stays open in its sent state for a moment.
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
}

test('the list shows every note, and a note chosen there opens its thread', async ({ page }) => {
  await mount(page, 'sidebar');
  const open = page.getByRole('button', { name: 'Show every note in a sidebar' });
  const list = page.getByRole('dialog', { name: 'Notes on this page' });

  // Empty first: the control for the two entries below.
  await open.click();
  await expect(list.getByText('No note on this page yet.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(open).toBeFocused();

  await plant(page, 'card-espresso', 'First note of the list');
  await plant(page, 'card-mocha', 'Second note of the list');

  await open.click();
  const entries = list.locator('[data-fruitback-note]');
  // « All », the chip that is pressed when the list opens: every note, whatever its state.
  await expect(list.getByRole('button', { name: 'All 2', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(entries).toHaveCount(2);

  // Choosing a note opens its thread in the column of the list, in place of the rows (FRU-312): the
  // head of the list stays, and nothing covers it.
  await entries.filter({ hasText: 'Second note of the list' }).click();
  const thread = page.getByRole('dialog', { name: /^Note \d+$/ });
  await expect(thread).toContainText('Second note of the list');
  await expect(list).toBeVisible();
  await expect(list.locator('[data-fruitback-thread]')).toHaveCount(1);
  await expect(entries.first()).toBeHidden();
  await expect(list.getByRole('button', { name: 'All notes' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Close the sidebar' })).toBeVisible();

  // Escape closes the thread and gives focus back to the entry. A second Escape closes the list.
  await page.keyboard.press('Escape');
  await expect(thread).toHaveCount(0);
  await expect(entries.filter({ hasText: 'Second note of the list' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
});

test('a note far down the page is brought into view when it is chosen', async ({ page }) => {
  await mount(page, 'sidebar-scroll');
  const target = page.locator('#checkout-cta');
  await target.scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await target.click();
  await page.getByPlaceholder('What should change?').fill('A note far down');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(target).not.toBeInViewport();

  await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
  await page.getByRole('dialog', { name: 'Notes on this page' }).locator('[data-fruitback-note]').click();

  await expect(target).toBeInViewport();
  await expect(page.getByRole('dialog', { name: /^Note \d+$/ })).toContainText('A note far down');
});

/** Plant a note on any element, with the composer as it is: by its parts, not by its words. */
async function plantOn(page: Page, selector: string, note: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(selector).click();
  await page.locator('[data-fruitback-note]:visible').fill(note);
  await page.locator('[data-fruitback-send]').click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
}

/**
 * The states of eight notes, as the mock-up counts them: six open and two done. The store in memory
 * gives a new issue the next of its five states, from wherever the specs before left it, so a read
 * is rewritten here: the note « Note N of eight » gets the Nth state below.
 */
const EIGHT = [
  ['seeded', 'New'],
  ['green', 'To do'],
  ['ripening', 'In progress'],
  ['ripe', 'Done'],
  ['composted', 'Closed'],
  ['seeded', 'New'],
  ['green', 'To do'],
  ['ripening', 'In progress'],
] as const;

async function statesOfTheMockUp(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { issues: { stage: string; stateName: string; seed: { note: string } }[] };
    for (const issue of body.issues) {
      const state = EIGHT[Number(/^Note (\d) of eight$/.exec(issue.seed.note)?.[1] ?? 1) - 1] ?? EIGHT[0];
      [issue.stage, issue.stateName] = state;
    }
    // In the order they were written, whatever the order of the store.
    body.issues.sort((one, other) => one.seed.note.localeCompare(other.seed.note));
    await route.fulfill({ response, json: body });
  });
}

/** Eight notes. The last two are on the button at the foot of the page. */
async function eightNotes(page: Page): Promise<void> {
  const places = [
    '[data-testid="card-espresso"] .add',
    '[data-testid="card-latte"] .add',
    '[data-testid="card-mocha"] .add',
    '[data-testid="card-espresso"] .add',
    '[data-testid="card-latte"] .add',
    '[data-testid="card-mocha"] .add',
    '#checkout-cta',
    '#checkout-cta',
  ];
  for (const [index, place] of places.entries()) {
    if (place === '#checkout-cta') await page.locator(place).scrollIntoViewIfNeeded();
    await plantOn(page, place, `Note ${index + 1} of eight`);
  }
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(8);
  await page.evaluate(() => window.scrollTo(0, 0));
}

test('the list is the board « Sidebar mode »: its measures, its chips, its search, the ring and the switch of the pins (FRU-308)', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await statesOfTheMockUp(page);
  await mount(page, `sidebar-measures-${test.info().retry}`);
  await eightNotes(page);
  const dock = page.locator('.fruitback-dock');
  await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await expect(list).toBeVisible();
  const read = (selector: string, properties: string[]) =>
    page
      .locator(selector)
      .first()
      .evaluate((element, names) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();

        return {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
        } as Record<string, string | number>;
      }, properties);

  // The panel of the board: 392 px on the end edge of the window, its whole height, over the page.
  expect(
    await read('[data-fruitback-sidebar]', [
      'border-left-width',
      'border-left-color',
      'background-color',
      'font-size',
      'line-height',
      'box-shadow',
    ]),
  ).toMatchObject({
    x: 1048,
    y: 0,
    width: 392,
    height: 900,
    'border-left-width': '1px',
    'border-left-color': 'rgb(231, 229, 228)',
    'background-color': 'rgb(255, 255, 255)',
    'font-size': '14px',
    'line-height': '20.3px',
    'box-shadow': 'rgba(0, 0, 0, 0.06) -10px 0px 30px 0px',
  });
  // The dock stands aside: the list covers its corner, and holds its own button to leave a note.
  await expect(dock).toBeHidden();

  // The head: the drop, « Notes », the host, « Back to floating pins » and the cross.
  expect(await read('.fruitback-sidebar-head', ['padding', 'gap', 'border-bottom-width'])).toMatchObject({
    padding: '16px 12px 12px 18px',
    gap: '8px',
    'border-bottom-width': '0px',
  });
  expect(await read('.fruitback-sidebar-heading svg', ['color'])).toMatchObject({
    x: 1067,
    width: 16,
    height: 16,
    color: 'rgb(221, 44, 39)',
  });
  await expect(page.locator('.fruitback-sidebar-title')).toHaveText('Notes');
  expect(await read('.fruitback-sidebar-title', ['font-size', 'font-weight'])).toMatchObject({
    x: 1091,
    'font-size': '15px',
    'font-weight': '650',
  });
  await expect(page.locator('.fruitback-sidebar-address')).toHaveText(/^· localhost:\d+$/);
  expect(await read('.fruitback-sidebar-address', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(117, 110, 105)',
  });
  expect(await read('[data-fruitback-floating]', ['border-radius', 'color'])).toMatchObject({
    x: 1356,
    y: 16,
    width: 32,
    height: 32,
    'border-radius': '10px',
    color: 'rgb(117, 110, 105)',
  });
  await expect(list.getByRole('button', { name: 'Back to floating pins' })).toBeVisible();
  expect(await read('.fruitback-sidebar-close', ['border-radius'])).toMatchObject({
    x: 1396,
    y: 16,
    width: 32,
    height: 32,
    'border-radius': '10px',
  });

  // « This page », the search and the chips, over a rule.
  expect(await read('.fruitback-sidebar-actions', ['padding', 'gap', 'border-bottom-width'])).toMatchObject({
    y: 60,
    padding: '0px 18px 12px',
    gap: '10px',
    'border-bottom-width': '1px',
  });
  await expect(list.locator('.fruitback-sidebar-scope')).toHaveText('This page · 8');
  expect(await read('.fruitback-sidebar-scope', ['padding', 'border-radius', 'background-color'])).toMatchObject({
    x: 1067,
    y: 60,
    width: 355,
    height: 36,
    padding: '3px',
    'border-radius': '10px',
    'background-color': 'rgb(245, 245, 244)',
  });
  expect(
    await read('.fruitback-sidebar-scope > span', [
      'border-radius',
      'background-color',
      'font-size',
      'font-weight',
      'box-shadow',
    ]),
  ).toMatchObject({
    height: 30,
    'border-radius': '8px',
    'background-color': 'rgb(255, 255, 255)',
    'font-size': '12px',
    'font-weight': '600',
    'box-shadow': 'rgba(28, 25, 23, 0.15) 0px 1px 3px 0px',
  });
  const search = list.getByRole('searchbox', { name: 'Search notes' });
  await expect(search).toHaveAttribute('placeholder', 'Search notes');
  expect(
    await read('.fruitback-sidebar-search-field', [
      'border-top-width',
      'border-top-color',
      'border-radius',
      'font-size',
      'padding-left',
    ]),
  ).toMatchObject({
    x: 1067,
    y: 106,
    width: 355,
    height: 34,
    'border-top-width': '1px',
    'border-top-color': 'rgb(143, 136, 131)',
    'border-radius': '6px',
    'font-size': '13px',
    'padding-left': '32px',
  });
  expect(await read('.fruitback-sidebar-search svg', [])).toMatchObject({ x: 1077, y: 115, width: 15, height: 15 });
  const chips = list.getByRole('group', { name: 'Status' }).getByRole('button');
  // « Closed » is not on the board: it shows because the fifth note is closed.
  await expect(chips).toHaveText(['All8', 'New2', 'To do2', 'In progress2', 'Done1', 'Closed1']);
  await expect(list.getByRole('button', { name: 'All 8', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(
    await read('[data-fruitback-chip="all"]', [
      'border-top-color',
      'background-color',
      'border-radius',
      'font-size',
      'font-weight',
      'padding-left',
    ]),
  ).toMatchObject({
    x: 1067,
    y: 150,
    height: 28,
    'border-top-color': 'rgb(28, 25, 23)',
    'background-color': 'rgb(245, 245, 244)',
    'border-radius': '999px',
    'font-size': '12px',
    'font-weight': '600',
    'padding-left': '10px',
  });
  expect(await read('[data-fruitback-chip="seeded"]', ['border-top-color', 'background-color'])).toMatchObject({
    'border-top-color': 'rgb(231, 229, 228)',
    'background-color': 'rgb(255, 255, 255)',
  });
  // Its own box, not the one it is turned in: a drop of 9 px, at 45°.
  expect(await read('[data-fruitback-chip="ripening"] .fruitback-sidebar-dot', ['background-color'])).toMatchObject({
    width: 12.7,
    height: 12.7,
    'background-color': 'rgb(172, 95, 0)',
  });
  expect(
    await page
      .locator('[data-fruitback-chip="ripening"] .fruitback-sidebar-dot')
      .evaluate((node) => [getComputedStyle(node).width, getComputedStyle(node).height]),
  ).toEqual(['9px', '9px']);
  expect(await read('[data-fruitback-chip="all"] .fruitback-sidebar-count', ['color', 'font-weight'])).toMatchObject({
    color: 'rgb(117, 110, 105)',
    'font-weight': '500',
  });
  expect(await read('.fruitback-sidebar-panel', ['padding', 'overflow-y'])).toMatchObject({
    padding: '8px 10px 12px',
    'overflow-y': 'auto',
  });

  // A row of the board: the drop with the number of its pin, « New · ID … when », the note, who and the replies.
  const rows = list.locator('.fruitback-sidebar-list [data-fruitback-note]');
  await expect(rows).toHaveCount(8);
  expect(await read('.fruitback-sidebar-item', ['display', 'gap', 'padding', 'border-radius'])).toMatchObject({
    x: 1059,
    width: 371,
    display: 'flex',
    gap: '12px',
    padding: '12px',
    'border-radius': '10px',
  });
  expect(
    await read('.fruitback-sidebar-pin', ['background-color', 'border-radius', 'border-top-width', 'border-top-color']),
  ).toMatchObject({
    // A drop of 24 px, turned 45° so that its point is down: its box on the screen is the diagonal.
    width: 33.9,
    height: 33.9,
    // The olive of « new » (FRU-292).
    'background-color': 'rgb(106, 121, 80)',
    'border-radius': '50% 50% 50% 0px',
    'border-top-width': '2px',
    'border-top-color': 'rgb(255, 255, 255)',
  });
  expect(await read('.fruitback-sidebar-pin > span', ['font-size', 'font-weight', 'color'])).toMatchObject({
    'font-size': '11px',
    'font-weight': '700',
    color: 'rgb(255, 255, 255)',
  });
  expect(await read('.fruitback-sidebar-top', ['font-size'])).toMatchObject({ 'font-size': '12px' });
  expect(await read('.fruitback-sidebar-status', ['font-weight'])).toMatchObject({ 'font-weight': '600' });
  expect(await read('.fruitback-sidebar-age', ['color'])).toMatchObject({ color: 'rgb(117, 110, 105)' });
  expect(await read('.fruitback-sidebar-note', ['font-size', 'line-height', '-webkit-line-clamp'])).toMatchObject({
    'font-size': '14px',
    'line-height': '20.3px',
    '-webkit-line-clamp': '2',
  });
  expect(await read('.fruitback-sidebar-meta', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(117, 110, 105)',
  });
  await expect(rows.locator('.fruitback-sidebar-pin')).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8']);
  await expect(rows.nth(0).locator('.fruitback-sidebar-status')).toHaveText('New');
  await expect(rows.nth(0).locator('.fruitback-sidebar-meta')).toHaveText(/^Anonymous · no reply/);

  // « further down » for the two notes at the foot of the page, and for no other.
  const below = rows.locator('[data-fruitback-below]');
  await expect(below.nth(6)).toBeVisible();
  await expect(below.nth(7)).toHaveText(' · further down');
  await expect(below.nth(0)).toBeHidden();
  await page.locator('#checkout-cta').scrollIntoViewIfNeeded();
  await expect(below.nth(6)).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(below.nth(6)).toBeVisible();

  // A chip shows its status, and « All » everything again.
  await list.getByRole('button', { name: 'In progress 2', exact: true }).click();
  await expect(rows.locator('.fruitback-sidebar-pin')).toHaveText(['3', '8']);
  await expect(list.getByRole('button', { name: 'In progress 2', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await list.getByRole('button', { name: 'Done 1', exact: true }).click();
  await expect(rows.locator('.fruitback-sidebar-pin')).toHaveText(['4']);
  await list.getByRole('button', { name: 'All 8', exact: true }).click();
  await expect(rows).toHaveCount(8);

  // The search reads the whole text of the notes; the chips count what it found.
  await search.fill('note 5');
  await expect(rows.locator('.fruitback-sidebar-pin')).toHaveText(['5']);
  await expect(chips).toHaveText(['All1', 'New0', 'To do0', 'In progress0', 'Done0', 'Closed1']);
  await search.fill('nothing like this');
  await expect(list.getByText('No note matches.')).toBeVisible();
  await search.fill('');
  await expect(rows).toHaveCount(8);

  // A row opens its thread in place of the rows (FRU-312): its element has the ring of the board, and
  // the other pins step back. Escape brings the rows back, and the ring goes.
  const id = await rows.nth(1).getAttribute('data-fruitback-note');
  const other = await rows.nth(0).getAttribute('data-fruitback-note');
  await rows.nth(1).click();
  await expect(list.locator('[data-fruitback-thread]')).toBeVisible();
  await expect(rows.nth(1)).toBeHidden();
  const ring = page.locator(`[data-fruitback-pin="${id}"]`);
  await expect
    .poll(() =>
      ring.evaluate((node) => {
        const style = getComputedStyle(node);

        return [style.borderTopWidth, style.borderTopColor, style.borderTopLeftRadius, style.boxShadow];
      }),
    )
    // The green of « to do », 12 px round, and the halo of the board.
    .toEqual(['2px', 'rgb(86, 128, 46)', '12px', 'rgba(255, 255, 255, 0.6) 0px 0px 0px 6px']);
  expect(await page.locator(`[data-fruitback-pin="${other}"]`).evaluate((node) => getComputedStyle(node).opacity)).toBe(
    '0.55',
  );
  await page.keyboard.press('Escape');
  await expect(rows.nth(1)).toBeVisible();
  await expect(rows.nth(1)).toBeFocused();
  expect(await page.locator(`[data-fruitback-pin="${other}"]`).evaluate((node) => getComputedStyle(node).opacity)).toBe(
    '1',
  );
  expect(await ring.evaluate((node) => getComputedStyle(node).boxShadow)).toBe('none');

  // The row of a note whose thread is open on the page is the card of the board. Under the pointer,
  // a row takes the raised surface.
  await page.locator(`[data-fruitback-pin="${id}"] .fruitback-pin-badge`).click();
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.mouse.move(0, 0);
  expect(
    await rows.nth(1).evaluate((node) => [getComputedStyle(node).backgroundColor, getComputedStyle(node).boxShadow]),
  ).toEqual(['rgb(255, 253, 249)', 'rgb(231, 229, 228) 0px 0px 0px 1px inset']);
  await rows.nth(0).hover();
  expect(await rows.nth(0).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(250, 250, 249)');
  await page.keyboard.press('Escape');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'true');

  // The foot: « Leave feedback » and « Show pins on the page ».
  expect(await read('.fruitback-sidebar-foot', ['padding', 'gap', 'border-top-width'])).toMatchObject({
    padding: '12px 18px 18px',
    gap: '10px',
    'border-top-width': '1px',
  });
  expect(
    await read('[data-fruitback-leave]', ['border-radius', 'background-color', 'color', 'font-size', 'font-weight']),
  ).toMatchObject({
    x: 1067,
    width: 355,
    height: 44,
    'border-radius': '999px',
    'background-color': 'rgb(221, 44, 39)',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'font-weight': '600',
  });
  const pins = list.getByRole('switch', { name: 'Show pins on the page' });
  await expect(pins).toBeChecked();
  expect(await read('[data-fruitback-show-pins]', ['background-color'])).toMatchObject({
    width: 32,
    height: 18,
    'background-color': 'rgb(28, 25, 23)',
  });
  const badges = page.locator('[data-fruitback-pin] .fruitback-pin-badge');
  await expect(badges.first()).toBeVisible();
  await pins.click();
  await expect(pins).not.toBeChecked();
  await expect(badges.first()).toBeHidden();
  await expect(badges.last()).toBeHidden();
  // « Back to floating pins »: the list goes, the pins come back, and the switch is on again.
  await list.getByRole('button', { name: 'Back to floating pins' }).click();
  await expect(list).toBeHidden();
  await expect(badges.first()).toBeVisible();
  await expect(dock).toBeVisible();
  await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
  await expect(pins).toBeChecked();

  // « Leave feedback » closes the list and starts a capture.
  await list.locator('[data-fruitback-leave]').click();
  await expect(list).toBeHidden();
  await expect(dock).toBeVisible();
  await expect(page.locator('[data-fruitback-host][data-fruitback-capturing]')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('the list lies over the page: the page keeps its width when the list opens (FRU-259)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mount(page, 'sidebar-over');
  // What a list that pushed the page would change: the box of the body, and the margins and paddings around it.
  const pageBox = () =>
    page.evaluate(() => {
      const sides = (element: Element) => {
        const style = getComputedStyle(element);

        return [style.marginLeft, style.marginRight, style.paddingLeft, style.paddingRight, style.width].join(' ');
      };
      const main = document.querySelector('main')!.getBoundingClientRect();

      return [
        sides(document.documentElement),
        sides(document.body),
        `${main.left} ${main.width}`,
        document.documentElement.scrollWidth,
      ].join(' | ');
    });
  const before = await pageBox();

  await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
  await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeVisible();
  expect(await pageBox()).toBe(before);

  // The control: the margin the mock-up gives its example site is seen by this measure.
  await page.evaluate(() => (document.body.style.marginRight = '428px'));
  expect(await pageBox()).not.toBe(before);
});

test('a note whose element is gone is a detached note at the bottom, and not among the notes (FRU-259, FRU-308)', async ({
  page,
}) => {
  await mount(page, 'sidebar-unplaced');
  await plantOn(page, '[data-testid="card-espresso"] .add', 'On a button that stays');
  await page.locator('#email-field').scrollIntoViewIfNeeded();
  await plantOn(page, '#email-field', 'On a field that goes');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
  const open = page.getByRole('button', { name: 'Show every note in a sidebar' });
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  const unplaced = list.getByRole('group', { name: '1 detached note' });

  // The control: with its element on the page, it is a note like the other.
  await open.click();
  await expect(list.locator('.fruitback-sidebar-list [data-fruitback-note]')).toHaveCount(2);
  await expect(list.locator('[data-fruitback-unplaced]')).toBeHidden();

  // The page changes under the open list.
  await page.evaluate(() => document.querySelector('#email-field')?.remove());
  await expect(unplaced).toBeVisible();
  await expect(list.locator('.fruitback-sidebar-list [data-fruitback-note]')).toHaveCount(1);
  await expect(list.locator('.fruitback-sidebar-list')).not.toContainText('On a field that goes');
  // The chips count the notes a pin shows on its element.
  await expect(list.getByRole('button', { name: 'All 1', exact: true })).toBeVisible();
  // The board: the note, then its status, its identifier and what became of it.
  await expect(unplaced.locator('[data-fruitback-note]')).toHaveText(
    /^On a field that goes.+ · the element it pointed at is gone$/,
  );
  expect(
    await list.locator('.fruitback-sidebar-unplaced').evaluate((node) => {
      const style = getComputedStyle(node);
      const title = getComputedStyle(node.querySelector('.fruitback-sidebar-unplaced-title')!);
      const icon = node.querySelector('svg')!;
      const card = getComputedStyle(node.querySelector('.fruitback-sidebar-lost')!);

      return {
        margin: style.marginTop,
        padding: style.padding,
        rule: style.borderTopWidth,
        title: [title.fontSize, title.fontWeight, title.textTransform, title.letterSpacing],
        icon: [icon.getBoundingClientRect().width, icon.getBoundingClientRect().height],
        dashes: getComputedStyle(icon.querySelector('path')!).strokeDasharray,
        brown: getComputedStyle(icon).color,
        card: [
          card.borderTopStyle,
          card.borderTopWidth,
          card.borderTopColor,
          card.borderTopLeftRadius,
          card.backgroundColor,
        ],
      };
    }),
  ).toEqual({
    margin: '10px',
    padding: '10px 8px 4px',
    rule: '1px',
    title: ['11px', '600', 'uppercase', '0.44px'],
    icon: [12, 15],
    dashes: '18px, 12px',
    brown: 'rgb(141, 110, 99)',
    card: ['dashed', '1px', 'rgb(141, 110, 99)', '10px', 'rgb(255, 253, 249)'],
  });

  // It still opens its thread.
  await unplaced.locator('[data-fruitback-note]').click();
  await expect(page.locator('[data-fruitback-thread]')).toContainText('On a field that goes');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core finds nothing in the list, in the ${scheme} scheme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mount(page, `sidebar-axe-${scheme}`);
    await plant(page, 'card-latte', `Seen by axe, ${scheme}`);
    await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
    await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeVisible();

    const scan = async (): Promise<string[]> => {
      const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();

      return results.violations.flatMap((violation) =>
        violation.nodes.map((node) => `${violation.id} on ${node.target.join(' ')}`),
      );
    };

    expect(await scan()).toEqual([]);

    // The control for the empty list: a byline as pale as the surface must be a finding.
    await page.locator('[data-fruitback-host]').evaluate((host) => {
      (host as HTMLElement).style.setProperty('--fruitback-color-text-muted', '#bbb');
      (host as HTMLElement).style.setProperty('--fruitback-color-surface', '#ccc');
    });
    expect((await scan()).filter((line) => line.startsWith('color-contrast'))).not.toEqual([]);
  });
}

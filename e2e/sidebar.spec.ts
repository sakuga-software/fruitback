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
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 5_000 });
}

test('the list shows every note, and a note chosen there opens its thread', async ({ page }) => {
  await mount(page, 'sidebar');
  const open = page.getByRole('button', { name: 'Show every note of this page' });
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
  // « All »: the store in memory gives each new issue its next state, so which of the two is open is not this test's.
  await list.getByRole('tab', { name: 'All 2' }).click();
  await expect(entries).toHaveCount(2);

  // Choosing a note opens its thread, and the list stays for the next one.
  await entries.filter({ hasText: 'Second note of the list' }).click();
  const thread = page.getByRole('dialog', { name: /^Note \d+$/ });
  await expect(thread).toContainText('Second note of the list');
  await expect(list).toBeVisible();

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
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 5_000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(target).not.toBeInViewport();

  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  await page.getByRole('dialog', { name: 'Notes on this page' }).getByRole('tab', { name: 'All 1' }).click();
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
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 5_000 });
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

test('the list has the measures of the mock-up, and its three tabs count and filter eight notes (FRU-259)', async ({
  page,
}) => {
  test.slow();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await statesOfTheMockUp(page);
  await mount(page, `sidebar-measures-${test.info().retry}`);
  await eightNotes(page);
  const dock = page.locator('.fruitback-dock');
  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await expect(list).toBeVisible();
  const read = (selector: string, properties: string[]) =>
    page
      .locator(selector)
      .first()
      .evaluate((element, names) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();

        // To the pixel, as the measures of the mock-up are: the head is 39.15 px of text, so what is
        // under it sits 0.15 px lower than a whole number.
        return {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: box.width,
          height: box.height,
          ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
        } as Record<string, string | number>;
      }, properties);

  // The panel: 380 px on the end edge of the window, its whole height.
  expect(
    await read('[data-fruitback-sidebar]', ['border-left-width', 'border-left-color', 'background-color', 'font-size']),
  ).toMatchObject({
    x: 1060,
    y: 0,
    width: 380,
    height: 900,
    'border-left-width': '1px',
    'border-left-color': 'rgb(231, 229, 228)',
    'background-color': 'rgb(255, 255, 255)',
    'font-size': '14px',
  });
  expect(await page.locator('[data-fruitback-sidebar]').evaluate((node) => getComputedStyle(node).boxShadow)).toBe(
    'rgba(0, 0, 0, 0.18) 0px 10px 30px 0px',
  );
  // The dock stands aside: the list covers its corner, and holds its own button to leave a note.
  await expect(dock).toBeHidden();

  expect(await read('.fruitback-sidebar-head', ['padding', 'gap', 'border-bottom-width'])).toMatchObject({
    padding: '12px 10px 12px 18px',
    gap: '8px',
    'border-bottom-width': '1px',
  });
  await expect(page.locator('.fruitback-sidebar-title')).toHaveText('Notes on this page');
  expect(await read('.fruitback-sidebar-title', ['font-size', 'font-weight'])).toMatchObject({
    x: 1079,
    y: 12,
    'font-size': '15px',
    'font-weight': '600',
  });
  await expect(page.locator('.fruitback-sidebar-address')).toHaveText(/^localhost:\d+\/$/);
  expect(await read('.fruitback-sidebar-address', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(117, 110, 105)',
  });
  expect(await read('.fruitback-sidebar-close', ['border-radius'])).toMatchObject({
    x: 1394,
    y: 14,
    width: 36,
    height: 36,
    'border-radius': '8px',
  });
  expect(await read('.fruitback-sidebar-actions', ['padding', 'gap'])).toMatchObject({
    padding: '14px 18px 0px',
    gap: '14px',
  });
  expect(
    await read('[data-fruitback-leave]', ['border-radius', 'background-color', 'color', 'font-size', 'font-weight']),
  ).toMatchObject({
    x: 1079,
    y: 78,
    width: 343,
    height: 40,
    'border-radius': '999px',
    'background-color': 'rgb(221, 44, 39)',
    color: 'rgb(255, 255, 255)',
    'font-size': '13px',
    'font-weight': '600',
  });
  expect(await read('[data-fruitback-leave] svg', [])).toMatchObject({ width: 12, height: 15 });
  expect(await read('[role="tablist"]', ['padding', 'gap', 'border-radius', 'background-color'])).toMatchObject({
    x: 1079,
    y: 132,
    width: 343,
    height: 38,
    padding: '3px',
    gap: '4px',
    'border-radius': '10px',
    'background-color': 'rgb(245, 245, 244)',
  });
  const tabs = list.getByRole('tab');
  await expect(tabs).toHaveText(['Open 6', 'Done 2', 'All 8']);
  const chosen = await read('[role="tab"][aria-selected="true"]', [
    'border-radius',
    'background-color',
    'color',
    'font-size',
    'font-weight',
    'box-shadow',
  ]);
  expect(chosen).toMatchObject({
    x: 1082,
    y: 135,
    height: 32,
    'border-radius': '8px',
    'background-color': 'rgb(255, 255, 255)',
    color: 'rgb(28, 25, 23)',
    'font-size': '13px',
    'font-weight': '600',
    'box-shadow': 'rgba(28, 25, 23, 0.15) 0px 1px 3px 0px',
  });
  expect(Number(chosen.width)).toBeCloseTo(109.7, 0);
  expect(await read('[role="tab"][aria-selected="false"]', ['background-color', 'color'])).toMatchObject({
    'background-color': 'rgba(0, 0, 0, 0)',
    color: 'rgb(87, 83, 78)',
  });
  expect(await read('[role="tabpanel"]', ['padding', 'overflow-y'])).toMatchObject({
    y: 170,
    padding: '10px 8px 16px',
    'overflow-y': 'auto',
  });

  // A row: the drop with the number of its pin, the note, and a line of what is known of it.
  const rows = list.locator('.fruitback-sidebar-list [data-fruitback-note]');
  await expect(rows).toHaveCount(6);
  expect(
    await read('.fruitback-sidebar-item', ['display', 'grid-template-columns', 'gap', 'padding', 'border-radius']),
  ).toMatchObject({
    x: 1069,
    y: 180,
    width: 363,
    display: 'grid',
    'grid-template-columns': '30px 303px',
    gap: '2px 10px',
    padding: '12px 10px',
    'border-radius': '10px',
  });
  expect(await read('.fruitback-sidebar-pin', ['background-color', 'border-radius'])).toMatchObject({
    width: 24,
    height: 24,
    // The olive of « new » (FRU-292).
    'background-color': 'rgb(106, 121, 80)',
    'border-radius': '50% 50% 50% 0px',
  });
  expect(await read('.fruitback-sidebar-pin > span', ['font-size', 'font-weight', 'color'])).toMatchObject({
    'font-size': '12px',
    'font-weight': '600',
    color: 'rgb(255, 255, 255)',
  });
  expect(await read('.fruitback-sidebar-note', ['font-size', 'line-height', '-webkit-line-clamp'])).toMatchObject({
    'font-size': '14px',
    'line-height': '20.3px',
    '-webkit-line-clamp': '2',
  });
  expect(await read('.fruitback-sidebar-meta', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(117, 110, 105)',
  });
  // The number of each pin, and white on the amber of « in progress » too (FRU-292).
  await expect(rows.locator('.fruitback-sidebar-pin')).toHaveText(['1', '2', '3', '6', '7', '8']);
  expect(
    await rows
      .nth(2)
      .locator('.fruitback-sidebar-pin > span')
      .evaluate((node) => getComputedStyle(node).color),
  ).toBe('rgb(255, 255, 255)');
  await expect(rows.nth(0).locator('.fruitback-sidebar-meta')).toHaveText(/^New · Anonymous · .+$/);

  // « further down » for the two notes at the foot of the page, and for no other.
  const below = rows.locator('[data-fruitback-below]');
  await expect(below.nth(4)).toBeVisible();
  await expect(below.nth(5)).toBeVisible();
  await expect(below.nth(5)).toHaveText(' · further down');
  await expect(below.nth(0)).toBeHidden();
  // The page scrolls under the list: they are in sight, and the words go.
  await page.locator('#checkout-cta').scrollIntoViewIfNeeded();
  await expect(below.nth(4)).toBeHidden();
  await expect(below.nth(5)).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(below.nth(5)).toBeVisible();

  // The tabs filter, by the pointer and by the arrows; one stop for the three.
  await tabs.nth(1).click();
  await expect(rows.locator('.fruitback-sidebar-pin')).toHaveText(['4', '5']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '-1');
  await tabs.nth(1).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(rows).toHaveCount(8);
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(rows).toHaveCount(6);
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();

  // The row of the note whose thread is open says so, on the sunken surface. Under the pointer, the raised one.
  await rows.nth(1).click();
  await expect(page.locator('[data-fruitback-thread]')).toBeVisible();
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.mouse.move(0, 0);
  expect(await rows.nth(1).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(245, 245, 244)');
  await rows.nth(0).hover();
  expect(await rows.nth(0).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(250, 250, 249)');
  await page.keyboard.press('Escape');
  await expect(rows.nth(1)).not.toHaveAttribute('aria-current', 'true');

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

  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  await expect(page.getByRole('dialog', { name: 'Notes on this page' })).toBeVisible();
  expect(await pageBox()).toBe(before);

  // The control: the margin the mock-up gives its example site is seen by this measure.
  await page.evaluate(() => (document.body.style.marginRight = '428px'));
  expect(await pageBox()).not.toBe(before);
});

test('a note whose element is gone is in « Could not be placed », and not among the notes (FRU-259)', async ({
  page,
}) => {
  await mount(page, 'sidebar-unplaced');
  await plantOn(page, '[data-testid="card-espresso"] .add', 'On a button that stays');
  await page.locator('#email-field').scrollIntoViewIfNeeded();
  await plantOn(page, '#email-field', 'On a field that goes');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
  const open = page.getByRole('button', { name: 'Show every note of this page' });
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  const unplaced = list.getByRole('group', { name: 'Could not be placed · 1' });

  // The control: with its element on the page, it is a note like the other.
  await open.click();
  await list.getByRole('tab', { name: 'All 2' }).click();
  await expect(list.locator('.fruitback-sidebar-list [data-fruitback-note]')).toHaveCount(2);
  await expect(list.locator('[data-fruitback-unplaced]')).toBeHidden();

  // The page changes under the open list.
  await page.evaluate(() => document.querySelector('#email-field')?.remove());
  await expect(unplaced).toBeVisible();
  await expect(list.locator('.fruitback-sidebar-list [data-fruitback-note]')).toHaveCount(1);
  await expect(list.locator('.fruitback-sidebar-list')).not.toContainText('On a field that goes');
  // The tabs count the notes a pin shows on its element.
  await expect(list.getByRole('tab', { name: 'All 1' })).toBeVisible();
  await expect(unplaced.locator('[data-fruitback-note]')).toHaveText(
    'On a field that goes' + 'Its element is no longer on this page. The note stays here.',
  );
  expect(
    await list.locator('.fruitback-sidebar-unplaced').evaluate((node) => {
      const style = getComputedStyle(node);
      const icon = node.querySelector('svg')!;

      return {
        margin: style.margin,
        paddingTop: style.paddingTop,
        rule: style.borderTopWidth,
        icon: [icon.getBoundingClientRect().width, icon.getBoundingClientRect().height],
        dashes: getComputedStyle(icon.querySelector('path')!).strokeDasharray,
        brown: getComputedStyle(icon).color,
      };
    }),
  ).toEqual({
    margin: '18px 10px 0px',
    paddingTop: '14px',
    rule: '1px',
    icon: [12, 15],
    dashes: '18px, 12px',
    brown: 'rgb(141, 110, 99)',
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
    await page.getByRole('button', { name: 'Show every note of this page' }).click();
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

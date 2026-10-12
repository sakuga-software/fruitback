import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The thread of a note with a long conversation and a long word (FRU-154), on the widget as `init`
 * assembles it.
 *
 * Both defects were rules of the stylesheet that did not apply, which only a real browser shows: the
 * reset of the host left a list `inline`, so its height limit did nothing, and an address has no
 * space to wrap at.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';
const ADDRESS =
  'https://staging.acme.dev/fr/produits/categorie/cafe-en-grains/espresso-italien-torrefaction-artisanale-250g?utm_source=newsletter&utm_campaign=rentree-2026';

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}-${test.info().retry}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
}

async function plant(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What is wrong here?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Leave a note' })).toBeHidden({ timeout: 5_000 });
}

/** Every note the worker reads back gets fourteen replies. The store in memory gives two at most. */
async function fourteenReplies(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { issues: { comments?: unknown[] }[] };
    for (const issue of body.issues) {
      issue.comments = Array.from({ length: 14 }, (_, index) => ({
        id: `reply-${index}`,
        body: `Reply ${index + 1}: we are looking at it, and here is where it stands. ${ADDRESS}`,
        createdAt: '2026-10-11T10:00:00.000Z',
        author: 'Alice',
      }));
    }
    await route.fulfill({ response, json: body });
  });
}

const display = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => getComputedStyle(element).display);

const overflowsSideways = (page: Page, selector: string) =>
  page.locator(selector).evaluate((element) => element.scrollWidth - element.clientWidth);

for (const scheme of ['light', 'dark'] as const) {
  test(`fourteen replies stay in a list of 180 px that scrolls, and axe finds nothing, in the ${scheme} scheme`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await fourteenReplies(page);
    await mount(page, `thread-replies-${scheme}`);
    await plant(page, 'A note with a long conversation');

    await page
      .getByRole('button', { name: /A note with a long conversation/ })
      .first()
      .click();
    const thread = page.getByRole('dialog', { name: /^Feedback / });
    await expect(thread.locator('.fruitback-thread-reply')).toHaveCount(14);

    expect(await display(page, 'ul.fruitback-thread-replies')).toBe('block');
    const list = await thread.locator('.fruitback-thread-replies').evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrolls: element.scrollHeight > element.clientHeight,
      indent: element.querySelector('li')!.getBoundingClientRect().left - element.getBoundingClientRect().left,
    }));
    expect(list.height).toBeLessThanOrEqual(180);
    expect(list.scrolls).toBe(true);
    // The replies sit behind their rule: 2 px of border and 10 px of padding.
    expect(list.indent).toBe(12);
    // A reply holds the same address, and wraps too.
    expect(await overflowsSideways(page, '.fruitback-thread-replies')).toBe(0);

    const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show every note of this page' }).click();
    await expect(page.getByRole('dialog', { name: 'Every note of this page' })).toBeVisible();
    expect(await display(page, 'ul.fruitback-sidebar-list')).toBe('block');
  });
}

test('at 390 px, a note with a long address wraps in the thread and in the list', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mount(page, 'thread-address');
  await plant(page, `The link is broken: ${ADDRESS}`);

  await page
    .getByRole('button', { name: /The link is broken/ })
    .first()
    .click();
  await expect(page.locator('.fruitback-thread-note')).toBeVisible();
  expect(await overflowsSideways(page, '.fruitback-thread-note')).toBe(0);
  expect(await overflowsSideways(page, '.fruitback-thread')).toBe(0);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  await expect(page.locator('.fruitback-sidebar-note')).toBeVisible();
  expect(await overflowsSideways(page, '.fruitback-sidebar-note')).toBe(0);
  expect(await overflowsSideways(page, '.fruitback-sidebar-list')).toBe(0);
});

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
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
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
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 5_000 });
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
    const thread = page.getByRole('dialog', { name: /^Note \d+$/ });
    await expect(thread.locator('.fruitback-thread-reply')).toHaveCount(14);

    // A column since FRU-256. What matters is that it is not the `inline` the reset of the host leaves.
    expect(await display(page, 'ul.fruitback-thread-replies')).toBe('flex');
    const list = await thread.locator('.fruitback-thread-replies').evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scrolls: element.scrollHeight > element.clientHeight,
      indent: element.querySelector('li')!.getBoundingClientRect().left - element.getBoundingClientRect().left,
    }));
    expect(list.height).toBeLessThanOrEqual(180);
    expect(list.scrolls).toBe(true);
    // The replies start where the note does: 16 px from the edge of the bubble (FRU-256).
    expect(list.indent).toBe(16);
    // A reply holds the same address, and wraps too.
    expect(await overflowsSideways(page, '.fruitback-thread-replies')).toBe(0);

    const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
    // « All »: whether the store in memory made the note an open one or a done one is not this test's.
    await page.getByRole('dialog', { name: 'Notes on this page' }).getByRole('tab', { name: 'All 1' }).click();
    expect(await display(page, 'ul.fruitback-sidebar-list')).toBe('block');
  });
}

/** The note of the mock-up: what the store in memory cannot give, a component and one reply. */
async function theNoteOfTheMockUp(page: Page): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      issues: { stateName: string; stage: string; comments?: unknown[]; seed: Record<string, unknown> }[];
    };
    for (const issue of body.issues) {
      issue.stateName = 'In progress';
      issue.stage = 'ripening';
      issue.seed.source = { component: 'HeroBanner', file: 'src/components/Hero.tsx', line: 42 };
      issue.seed.reporter = { name: 'Camille Durand' };
      issue.comments = [
        {
          id: 'reply-1',
          body: 'Trying the cream variant in the next build. I will mark it done when it is live.',
          createdAt: new Date(Date.now() - 86_400_000).toISOString(),
          author: 'Léa',
        },
      ];
    }
    await route.fulfill({ response, json: body });
  });
}

test('the bubble of a note has the measures of the mock-up, and opens beside its frame (FRU-256)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await theNoteOfTheMockUp(page);
  await mount(page, 'thread-measures');
  await plant(page, 'The button is hard to read on the green. Could it take the cream of the logo, with dark text?');

  const badge = page.getByRole('button', { name: /^Note 1, in progress: The button is hard/ });
  await badge.click();
  await expect(badge).toHaveAttribute('aria-expanded', 'true');
  const thread = page.getByRole('dialog', { name: 'Note 1', exact: true });
  await expect(thread).toBeVisible();

  const read = (selector: string, properties: string[]) =>
    page.locator(selector).evaluate((element, names) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();

      return {
        width: box.width,
        height: box.height,
        ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
      } as Record<string, string | number>;
    }, properties);

  expect(await read('.fruitback-thread', ['border-radius', 'font-size', 'line-height'])).toMatchObject({
    width: 360,
    'border-radius': '14px',
    'font-size': '14px',
    'line-height': '21px',
  });
  expect(await page.locator('.fruitback-thread').evaluate((element) => getComputedStyle(element).boxShadow)).toMatch(
    /0px 10px 30px 0px$|^rgba?\(0, 0, 0, 0\.18\) 0px 10px 30px 0px/,
  );
  // The head: 8 px around a cross of 32 px, and the rule under it.
  expect(await read('.fruitback-thread-head', ['padding', 'border-bottom-width', 'gap'])).toMatchObject({
    height: 49,
    padding: '8px 8px 8px 16px',
    'border-bottom-width': '1px',
    gap: '10px',
  });
  expect(await read('.fruitback-thread-stage', ['font-size', 'font-weight', 'gap'])).toMatchObject({
    'font-size': '13px',
    'font-weight': '600',
    gap: '7px',
  });
  expect(await read('.fruitback-thread-drop', ['background-color'])).toMatchObject({
    width: 10,
    height: 10,
    // The amber of « in progress », the colour its pin has.
    'background-color': 'rgb(172, 95, 0)',
  });
  expect(await read('.fruitback-thread-link', ['font-size', 'text-decoration-line', 'color'])).toMatchObject({
    'font-size': '12px',
    'text-decoration-line': 'underline',
    color: 'rgb(117, 110, 105)',
  });
  await expect(thread.getByRole('link')).toHaveText(/^DEV-\d+$/);
  expect(await read('.fruitback-thread-close', ['border-radius'])).toMatchObject({
    width: 32,
    height: 32,
    'border-radius': '8px',
  });
  expect(await read('.fruitback-thread-body', ['padding', 'gap', 'display'])).toMatchObject({
    padding: '14px 16px',
    gap: '8px',
    display: 'flex',
  });
  expect(await read('.fruitback-thread-meta', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(117, 110, 105)',
  });
  await expect(page.locator('.fruitback-thread-source')).toHaveText('HeroBanner · src/components/Hero.tsx:42');
  const source = await read('.fruitback-thread-source', [
    'font-size',
    'font-family',
    'padding',
    'border-radius',
    'margin-top',
    'background-color',
    'color',
  ]);
  expect(source).toMatchObject({
    'font-size': '11.5px',
    padding: '6px 8px',
    'border-radius': '6px',
    'margin-top': '4px',
    'background-color': 'rgb(250, 250, 249)',
    color: 'rgb(87, 83, 78)',
  });
  expect(String(source['font-family'])).toMatch(/^ui-monospace/);
  expect(await read('.fruitback-thread-answers', ['border-top-width'])).toMatchObject({ 'border-top-width': '1px' });
  expect(await read('.fruitback-thread-replies', ['padding'])).toMatchObject({ padding: '12px 16px' });
  expect(await read('.fruitback-thread-reply', ['gap', 'display'])).toMatchObject({ gap: '2px', display: 'flex' });
  expect(await read('.fruitback-thread-reply-who', ['font-size'])).toMatchObject({ 'font-size': '11px' });
  expect(await read('.fruitback-thread-reply-name', ['font-weight', 'color'])).toMatchObject({
    'font-weight': '600',
    color: 'rgb(28, 25, 23)',
  });
  expect(await read('.fruitback-thread-reply-body', ['font-size', 'line-height'])).toMatchObject({
    'font-size': '12px',
    'line-height': '18px',
  });
  // The foot of the mock-up: a field to reply, since FRU-257 decided who may (this worker lets everybody).
  await expect(thread.getByRole('textbox', { name: 'Reply' })).toHaveCount(1);
  await expect(thread.getByRole('button', { name: 'Send reply' })).toHaveCount(1);

  // Beside the frame, as the mock-up places it: 26 px past its edge and 32 px above its top, which
  // is 30 and 36 px from the element.
  const place = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const pin = root.querySelector('[data-fruitback-pin][data-fruitback-open]')!.getBoundingClientRect();
    const bubble = root.querySelector('.fruitback-thread')!.getBoundingClientRect();

    return { beside: bubble.left - pin.right, above: pin.top - bubble.top };
  });
  expect(place.beside).toBeCloseTo(26, 0);
  expect(place.above).toBeCloseTo(32, 0);

  // The cross answers a pointer with the sunken surface, and a keyboard with the ring of the widget.
  await page.locator('.fruitback-thread-close').hover();
  expect(await read('.fruitback-thread-close', ['background-color'])).toMatchObject({
    'background-color': 'rgb(245, 245, 244)',
  });
});

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

  await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
  await page.getByRole('tab', { name: 'All 1' }).click();
  await expect(page.locator('.fruitback-sidebar-note')).toBeVisible();
  expect(await overflowsSideways(page, '.fruitback-sidebar-note')).toBe(0);
  expect(await overflowsSideways(page, '.fruitback-sidebar-list')).toBe(0);
});

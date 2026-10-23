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

async function mount(page: Page, testCase: string, extra: { showSelectors?: boolean } = {}): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}-${test.info().retry}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, extra }) => {
      const scope = globalThis as unknown as {
        Fruitback: { init(options: Record<string, unknown>): unknown };
        fruitbackWidget: unknown;
      };
      scope.fruitbackWidget = scope.Fruitback.init({ endpoint, clientId: 'playground', locale: 'en-US', ...extra });
    },
    { endpoint: WORKER_ORIGIN, extra },
  );
}

async function plant(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
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
      indent:
        element.querySelector('li')!.getBoundingClientRect().left -
        element.closest('.fruitback-thread')!.getBoundingClientRect().left,
    }));
    expect(list.height).toBeLessThanOrEqual(180);
    expect(list.scrolls).toBe(true);
    // The replies start where the note does: 16 px inside the edge of 1 px of the bubble (FRU-256, FRU-304).
    expect(list.indent).toBe(17);
    // A reply holds the same address, and wraps too.
    expect(await overflowsSideways(page, '.fruitback-thread-replies')).toBe(0);

    const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
    // « All »: whether the store in memory made the note an open one or a done one is not this test's.
    await page
      .getByRole('dialog', { name: 'Notes on this page' })
      .getByRole('button', { name: 'All 1', exact: true })
      .click();
    // A column since FRU-308: not the `inline` the reset of the host leaves.
    expect(await display(page, 'ul.fruitback-sidebar-list')).toBe('flex');
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
      issue.stage = 'progress';
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

test('the bubble hides the CSS selector by default, and shows it when the host asks (FRU-349)', async ({ page }) => {
  await theNoteOfTheMockUp(page);
  await mount(page, 'thread-selectors');
  await plant(page, 'The selector is for a developer.');

  const badge = page.getByRole('button', { name: /^Note 1, in progress: The selector is for/ });
  await badge.click();
  const thread = page.getByRole('dialog', { name: 'Note 1', exact: true });
  await expect(thread).toBeVisible();
  // Neither the selector nor the component and the file (FRU-419).
  await expect(page.locator('.fruitback-thread-component')).toHaveCount(0);
  await expect(page.locator('.fruitback-thread-selector')).toHaveCount(0);

  // `showSelectors`, as the extension says « Show CSS selectors »: the open thread is drawn again.
  await page.evaluate(() =>
    (globalThis as unknown as { fruitbackWidget: { showSelectors(on: boolean): void } }).fruitbackWidget.showSelectors(
      true,
    ),
  );
  await expect(page.locator('.fruitback-thread-selector')).toHaveText(/card-espresso/);
  await expect(page.locator('.fruitback-thread-component')).toHaveText('<HeroBanner> · src/components/Hero.tsx:42');
  await page.evaluate(() =>
    (globalThis as unknown as { fruitbackWidget: { showSelectors(on: boolean): void } }).fruitbackWidget.showSelectors(
      false,
    ),
  );
  await expect(page.locator('.fruitback-thread-selector')).toHaveCount(0);
});

test('the bubble of a note has the measures of the mock-up, and opens beside its drop (FRU-256, FRU-304)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await theNoteOfTheMockUp(page);
  // The selector is shown on request only (FRU-349): this test measures its line too.
  await mount(page, 'thread-measures', { showSelectors: true });
  await plant(page, 'The button is hard to read on the green. Could it take the cream of the logo, with dark text?');

  const badge = page.getByRole('button', { name: /^Note 1, in progress: The button is hard/ });
  await badge.click();
  await expect(badge).toHaveAttribute('aria-expanded', 'true');
  const thread = page.getByRole('dialog', { name: 'Note 1', exact: true });
  await expect(thread).toBeVisible();

  const read = (selector: string, properties: string[]) =>
    page
      .locator(selector)
      .first()
      .evaluate((element, names) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();

        return {
          width: box.width,
          height: box.height,
          ...Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name)])),
        } as Record<string, string | number>;
      }, properties);

  expect(
    await read('.fruitback-thread', [
      'border-radius',
      'border-top-width',
      'border-top-color',
      'font-size',
      'line-height',
    ]),
  ).toMatchObject({
    width: 344,
    'border-radius': '14px',
    'border-top-width': '1px',
    'border-top-color': 'rgb(228, 228, 231)',
    'font-size': '14px',
    'line-height': '21px',
  });
  expect(await page.locator('.fruitback-thread').evaluate((element) => getComputedStyle(element).boxShadow)).toMatch(
    /0px 10px 30px 0px$|^rgba?\(0, 0, 0, 0\.18\) 0px 10px 30px 0px/,
  );
  // The head: the state behind its drop and the identifier in a chip, then the cross in a column of
  // its own (FRU-419). The first column wraps a long state onto a line of its own, 6 px above the rest
  // (FRU-350).
  expect(
    await read('.fruitback-thread-head', ['padding', 'border-bottom-width', 'column-gap', 'display']),
  ).toMatchObject({
    padding: '14px 14px 12px 16px',
    'border-bottom-width': '1px',
    'column-gap': '10px',
    display: 'grid',
  });
  expect(await read('.fruitback-thread-heading', ['column-gap', 'row-gap'])).toMatchObject({
    'column-gap': '10px',
    'row-gap': '6px',
  });
  expect(await read('.fruitback-thread-stage', ['font-size', 'font-weight', 'gap'])).toMatchObject({
    'font-size': '13px',
    'font-weight': '600',
    gap: '7px',
  });
  expect(await read('.fruitback-thread-drop', ['background-color'])).toMatchObject({
    // The mango of « in progress », the colour its pin has.
    'background-color': 'rgb(243, 187, 61)',
  });
  // The age of the status is in the title of its word, not in the head (FRU-419).
  await expect(page.locator('.fruitback-thread-age')).toHaveCount(0);
  await expect(page.locator('.fruitback-thread-state')).toHaveAttribute('title', /^In progress since /);
  expect(
    await read('.fruitback-thread-link', [
      'font-size',
      'font-weight',
      'text-decoration-line',
      'background-color',
      'border-top-left-radius',
      'padding',
    ]),
  ).toMatchObject({
    // 44 px to press: a chip of 26 px inside a transparent border of 9 px.
    height: 44,
    'font-size': '12px',
    'font-weight': '600',
    'text-decoration-line': 'none',
    'background-color': 'rgb(244, 244, 245)',
    'border-top-left-radius': '6px',
    padding: '4px 8px',
  });
  await expect(thread.getByRole('link')).toHaveText(/^DEV-\d+ →$/);
  // The cross: 28 px drawn, 44 px to press.
  expect(await read('.fruitback-thread-close', ['border-top-width'])).toMatchObject({
    width: 44,
    height: 44,
    'border-top-width': '8px',
  });
  expect(await read('.fruitback-thread-body', ['padding', 'gap', 'display'])).toMatchObject({
    padding: '14px 16px 4px',
    gap: '10px',
    display: 'flex',
  });
  expect(await read('.fruitback-thread-meta', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  // The lines of mono: the selector the note carries, then the component and the file. No box (FRU-419).
  const source = await read('.fruitback-thread-source', [
    'font-family',
    'padding',
    'border-top-width',
    'background-color',
  ]);
  expect(source).toMatchObject({
    padding: '0px',
    'border-top-width': '0px',
    'background-color': 'rgba(0, 0, 0, 0)',
  });
  expect(String(source['font-family'])).toMatch(/^ui-monospace/);
  await expect(page.locator('.fruitback-thread-selector')).not.toHaveText('');
  expect(await read('.fruitback-thread-selector', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  await expect(page.locator('.fruitback-thread-component')).toHaveText('<HeroBanner> · src/components/Hero.tsx:42');
  expect(await read('.fruitback-thread-component', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  // « Replies », the round of an initial, and the text of the reply.
  expect(await read('.fruitback-thread-answers', ['padding'])).toMatchObject({ padding: '10px 16px 16px' });
  expect(
    await read('.fruitback-thread-answers-title', ['font-size', 'font-weight', 'text-transform', 'color']),
  ).toMatchObject({
    'font-size': '11px',
    'font-weight': '600',
    'text-transform': 'uppercase',
    color: 'rgb(107, 107, 116)',
  });
  expect(
    await read('.fruitback-thread-reply-avatar', ['border-top-left-radius', 'background-color', 'font-size']),
  ).toMatchObject({
    width: 24,
    height: 24,
    'border-top-left-radius': '999px',
    'background-color': 'rgb(244, 244, 245)',
    'font-size': '11px',
  });
  await expect(page.locator('.fruitback-thread-reply-avatar')).toHaveText('L');
  expect(await read('.fruitback-thread-reply-who', ['font-size'])).toMatchObject({ 'font-size': '11px' });
  expect(await read('.fruitback-thread-reply-name', ['font-weight', 'color'])).toMatchObject({
    'font-weight': '600',
    color: 'rgb(24, 24, 27)',
  });
  expect(await read('.fruitback-thread-reply-body', ['font-size', 'line-height'])).toMatchObject({
    'font-size': '13px',
    'line-height': '18.85px',
  });
  // The foot: a field to reply, since FRU-257 decided who may (this worker lets everybody).
  await expect(thread.getByRole('textbox', { name: 'Reply' })).toHaveCount(1);
  await expect(thread.getByRole('button', { name: 'Send reply' })).toHaveCount(1);

  // Beside the drop: 26 px past its point, 8 px above the top of the drop, and 24 px or more from
  // the top of the window.
  const place = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const pin = root.querySelector('[data-fruitback-pin][data-fruitback-open]') as HTMLElement;
    const frame = pin.getBoundingClientRect();
    const bubble = root.querySelector('.fruitback-thread')!.getBoundingClientRect();
    const tipX = frame.left + Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x'));
    const tipY = frame.top + Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-y'));

    return { beside: bubble.left - tipX, above: tipY - bubble.top, top: bubble.top };
  });
  expect(place.beside).toBeCloseTo(26, 0);
  if (place.top > 24.5) expect(place.above).toBeCloseTo(42, 0);
  else expect(place.top).toBeCloseTo(24, 0);

  // The cross answers a pointer with the sunken surface.
  await page.locator('.fruitback-thread-close').hover();
  expect(await read('.fruitback-thread-close', ['background-color'])).toMatchObject({
    'background-color': 'rgb(244, 244, 245)',
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
  await page.getByRole('button', { name: 'All 1', exact: true }).click();
  await expect(page.locator('.fruitback-sidebar-note')).toBeVisible();
  expect(await overflowsSideways(page, '.fruitback-sidebar-note')).toBe(0);
  expect(await overflowsSideways(page, '.fruitback-sidebar-list')).toBe(0);
});

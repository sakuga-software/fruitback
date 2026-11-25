import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';

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
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
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
  await page.getByRole('button', { name: 'Leave a note' }).click();
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
    // The replies start where the note does: 12 px inside the edge of 1 px of the bubble (FRU-696).
    expect(list.indent).toBe(13);
    // A reply holds the same address, and wraps too.
    expect(await overflowsSideways(page, '.fruitback-thread-replies')).toBe(0);

    const results = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
      [],
    );

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show every note in a sidebar' }).click();
    // « All »: whether the store in memory made the note an open one or a done one is not this test's.
    // A chip of « Search and options » since FRU-606.
    const sidebar = page.getByRole('dialog', { name: 'Notes on this page' });
    await sidebar.getByRole('button', { name: 'Search and options' }).click();
    await sidebar.getByRole('button', { name: 'All 1', exact: true }).click();
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
      issues: { stateName: string; stage: string; comments?: unknown[]; note: Record<string, unknown> }[];
    };
    for (const issue of body.issues) {
      issue.stateName = 'In progress';
      issue.stage = 'progress';
      issue.note.source = { component: 'HeroBanner', file: 'src/components/Hero.tsx', line: 42 };
      issue.note.reporter = { name: 'Camille Durand' };
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

test('the bubble folds the CSS selector by default, and opens it when the host asks (FRU-349, FRU-696)', async ({
  page,
}) => {
  await theNoteOfTheMockUp(page);
  await mount(page, 'thread-selectors');
  await plant(page, 'The selector is for a developer.');

  const badge = page.getByRole('button', { name: /^Note 1, in progress: The selector is for/ });
  await badge.click();
  const thread = page.getByRole('dialog', { name: 'Note 1', exact: true });
  await expect(thread).toBeVisible();
  // The selector, the component and the file, folded under « Technical details » (FRU-419, FRU-696).
  await expect(page.locator('.fruitback-thread-component')).toBeHidden();
  await expect(page.locator('.fruitback-thread-selector')).toBeHidden();
  await expect(page.locator('.fruitback-thread-tech-summary')).toHaveText('Technical details');

  // `showSelectors`, as the extension says « Show CSS selectors »: the fold of the open thread opens.
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
  await expect(page.locator('.fruitback-thread-selector')).toBeHidden();
});

test('the bubble of a note has the measures of the mock-up of 2026-11-25, and opens under its element (FRU-421, FRU-696)', async ({
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

  // 360 px, the corner of 10 of a modal of the console, 13 px of text (FRU-696).
  expect(
    await read('.fruitback-thread', [
      'border-radius',
      'border-top-width',
      'border-top-color',
      'font-size',
      'line-height',
    ]),
  ).toMatchObject({
    width: 360,
    'border-radius': '10px',
    'border-top-width': '1px',
    'border-top-color': 'rgb(228, 228, 231)',
    'font-size': '13px',
    'line-height': '18.2px',
  });
  expect(await page.locator('.fruitback-thread').evaluate((element) => getComputedStyle(element).boxShadow)).toMatch(
    /0px 10px 30px 0px$|^rgba?\(0, 0, 0, 0\.18\) 0px 10px 30px 0px/,
  );
  // The head of 40 px: the status in a chip and the ticket, then the cross in a column of its own
  // (FRU-419). The first column wraps a long state onto a line of its own, 6 px above the rest.
  // 40 px on one line; here the chip of a visitor known by their browser (FRU-700) takes a second line.
  expect(
    await read('.fruitback-thread-head', ['padding', 'border-bottom-width', 'column-gap', 'display', 'min-height']),
  ).toMatchObject({
    'min-height': '40px',
    padding: '7px 9px 7px 12px',
    'border-bottom-width': '1px',
    'column-gap': '6px',
    display: 'grid',
  });
  expect(await read('.fruitback-thread-heading', ['column-gap', 'row-gap'])).toMatchObject({
    'column-gap': '6px',
    'row-gap': '6px',
  });
  // The status: a chip of 24 px with the edge and the corner of a control, the round of its stage.
  expect(
    await read('.fruitback-thread-stage', ['font-size', 'font-weight', 'gap', 'border-top-width', 'border-radius']),
  ).toMatchObject({
    height: 24,
    'font-size': '13px',
    'font-weight': '500',
    gap: '6px',
    'border-top-width': '1px',
    'border-radius': '6px',
  });
  expect(await read('.fruitback-thread-ring', ['color'])).toMatchObject({
    width: 14,
    height: 14,
    // The mango of « in progress », the colour its pin has.
    color: 'rgb(243, 187, 61)',
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
    // 44 px to press: 24 px drawn inside a transparent border of 10 px. The vertical radius counts
    // that border, so the hover keeps a corner of 6 px (FRU-632).
    height: 44,
    'font-size': '13px',
    'font-weight': '500',
    'text-decoration-line': 'none',
    'background-color': 'rgba(0, 0, 0, 0)',
    'border-top-left-radius': '6px 16px',
    padding: '3px 6px',
  });
  // The identifier, the sign of a new tab after it, and its name says the tab (FRU-696).
  await expect(thread.getByRole('link')).toHaveText(/^DEV-\d+$/);
  await expect(thread.getByRole('link')).toHaveAccessibleName(/^DEV-\d+, in a new tab$/);
  await expect(thread.locator('.fruitback-thread-link-out')).toHaveCount(1);
  // The cross: 26 px drawn, 44 px to press.
  expect(await read('.fruitback-thread-close', ['border-top-width'])).toMatchObject({
    width: 44,
    height: 44,
    'border-top-width': '9px',
  });
  // The conversation: the note is the first message, 12 px around.
  expect(await read('.fruitback-thread-body', ['padding', 'gap', 'display'])).toMatchObject({
    padding: '12px 12px 0px',
    gap: '12px',
    display: 'flex',
  });
  expect(await read('.fruitback-thread-message', ['gap', 'display'])).toMatchObject({ gap: '10px', display: 'flex' });
  expect(await read('.fruitback-thread-meta', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  await expect(page.locator('.fruitback-thread-body .fruitback-thread-reply-name')).toHaveText('Camille Durand');
  expect(await read('.fruitback-thread-note', ['font-size', 'line-height'])).toMatchObject({
    'font-size': '13px',
    'line-height': '19.5px',
  });
  // The text is aligned under the name, not under the round.
  const aligned = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const left = (selector: string) => root.querySelector(selector)!.getBoundingClientRect().left;

    return (
      left('.fruitback-thread-body .fruitback-thread-note') -
      left('.fruitback-thread-body .fruitback-thread-reply-name')
    );
  });
  expect(aligned).toBe(0);
  // The round of an initial, 22 px, white on the chip.
  expect(
    await read('.fruitback-thread-reply-avatar', ['border-top-left-radius', 'background-color', 'color', 'font-size']),
  ).toMatchObject({
    width: 22,
    height: 22,
    'border-top-left-radius': '999px',
    'background-color': 'rgb(63, 63, 70)',
    color: 'rgb(255, 255, 255)',
    'font-size': '10px',
  });
  await expect(page.locator('.fruitback-thread-reply-avatar').first()).toHaveText('C');
  await expect(page.locator('.fruitback-thread-answers .fruitback-thread-reply-avatar')).toHaveText('L');
  // No « Replies » title: the replies are messages of the same conversation.
  await expect(page.locator('.fruitback-thread-answers-title')).toHaveCount(0);
  expect(await read('.fruitback-thread-answers', ['padding'])).toMatchObject({ padding: '12px 12px 0px' });
  expect(await read('.fruitback-thread-reply-who', ['font-size'])).toMatchObject({ 'font-size': '12px' });
  expect(await read('.fruitback-thread-reply-name', ['font-weight', 'font-size', 'color'])).toMatchObject({
    'font-weight': '600',
    'font-size': '13px',
    color: 'rgb(24, 24, 27)',
  });
  expect(await read('.fruitback-thread-reply-body', ['font-size', 'line-height'])).toMatchObject({
    'font-size': '13px',
    'line-height': '19.5px',
  });
  // « Technical details », open here (the host shows the selectors): the lines of mono, no box.
  await expect(page.locator('details.fruitback-thread-tech')).toHaveAttribute('open');
  expect(await read('.fruitback-thread-tech-summary', ['font-size', 'color'])).toMatchObject({
    height: 24,
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  const source = await read('.fruitback-thread-source', ['font-family', 'border-top-width', 'background-color']);
  expect(source).toMatchObject({ 'border-top-width': '0px', 'background-color': 'rgba(0, 0, 0, 0)' });
  expect(String(source['font-family'])).toMatch(/^ui-monospace/);
  await expect(page.locator('.fruitback-thread-selector')).not.toHaveText('');
  expect(await read('.fruitback-thread-selector', ['font-size', 'color'])).toMatchObject({
    'font-size': '12px',
    color: 'rgb(107, 107, 116)',
  });
  await expect(page.locator('.fruitback-thread-component')).toHaveText('<HeroBanner> · src/components/Hero.tsx:42');
  // The reply on one line: a row of 34 px with « Send » of 26 px inside it.
  expect(await read('.fruitback-thread-reply-row', ['border-top-width', 'border-radius'])).toMatchObject({
    height: 34,
    'border-top-width': '1px',
    'border-radius': '6px',
  });
  expect(await read('.fruitback-thread-reply-send', ['border-radius'])).toMatchObject({
    height: 26,
    'border-radius': '6px',
  });
  // The foot: a field to reply, since FRU-257 decided who may (this worker lets everybody).
  await expect(thread.getByRole('textbox', { name: 'Reply' })).toHaveCount(1);
  await expect(thread.getByRole('button', { name: 'Send reply' })).toHaveCount(1);

  // Around its element, never on it (FRU-421): here under it, the arrow on its top edge under the
  // point of the drop.
  const place = await page.evaluate(() => {
    const root = document.querySelector('[data-fruitback-host]')!.shadowRoot!;
    const pin = root.querySelector('[data-fruitback-pin][data-fruitback-open]') as HTMLElement;
    const frame = pin.getBoundingClientRect();
    const node = root.querySelector('.fruitback-thread') as HTMLElement;
    const bubble = node.getBoundingClientRect();
    const tipX = frame.left + Number.parseFloat(pin.style.getPropertyValue('--fruitback-pin-tip-x'));

    return {
      arrow: node.dataset.fruitbackArrow,
      under: bubble.top - frame.bottom,
      arrowX: bubble.left + Number.parseFloat(node.style.getPropertyValue('--fruitback-arrow-at')),
      tipX,
    };
  });
  expect(place.arrow).toBe('top');
  expect(place.under).toBeCloseTo(14, 0);
  expect(place.arrowX).toBeCloseTo(place.tipX, 0);

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
  await page.getByRole('button', { name: 'Search and options' }).click();
  await page.getByRole('button', { name: 'All 1', exact: true }).click();
  await expect(page.locator('.fruitback-sidebar-note')).toBeVisible();
  expect(await overflowsSideways(page, '.fruitback-sidebar-note')).toBe(0);
  expect(await overflowsSideways(page, '.fruitback-sidebar-list')).toBe(0);
});

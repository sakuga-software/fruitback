import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, storedSeeds } from './pin.ts';

/**
 * Several notes sent together (FRU-124), on the widget as `init` assembles it, against the worker of
 * the suite, whose limit offers a batch of ten.
 *
 * Kept for later: nothing goes to the worker, the pin is neutral and says it is not sent, and the
 * drafts outlive a reload of the tab. Sent from the list: one request, an array, and the pins come
 * back with the state the tracker gave them.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string, locale = 'en-US'): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}-${test.info().retry}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ([endpoint, tag]) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint: endpoint as string,
        clientId: 'playground',
        locale: tag as string,
      }),
    [WORKER_ORIGIN, locale],
  );
  // The offer of a batch comes with the first read.
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

/** Every write the page makes, with its body. */
function writes(page: Page): string[] {
  const bodies: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/feedback') {
      bodies.push(request.postData() ?? '');
    }
  });

  return bodies;
}

async function keep(page: Page, card: string, note: string): Promise<void> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator(`[data-testid="${card}"] .add`).click();
  await page.locator('[data-fruitback-note]').fill(note);
  await page.getByRole('button', { name: 'Keep for later' }).click();
  await expect(page.locator('[data-fruitback-status]')).toHaveText('Kept for later');
  await expect(page.locator('[data-fruitback-state]')).toBeHidden({ timeout: 5_000 });
}

test('notes kept for later outlive a reload, and go in one request from the list', async ({ page }) => {
  const posted = writes(page);
  await mount(page, 'drafts');

  await keep(page, 'card-espresso', 'Gardée : le prix est faux');
  await keep(page, 'card-latte', 'Gardée : le bouton est trop petit');

  // Kept, not sent: no request, and two neutral pins that say so.
  expect(posted).toEqual([]);
  const drafts = page.locator('[data-fruitback-pin][data-fruitback-draft]');
  await expect(drafts).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Not sent yet · Gardée : le prix/ })).toBeVisible();

  // The tab keeps them through a reload.
  await page.reload();
  await mount(page, 'drafts');
  await expect(drafts).toHaveCount(2);

  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await expect(list.getByText('Kept for later, not sent yet')).toBeVisible();
  await list.getByRole('button', { name: 'Send the 2 notes' }).click();
  await expect(list.getByText('2 notes sent')).toBeVisible();

  // One request, an array of the two seeds.
  expect(posted).toHaveLength(1);
  const body = JSON.parse(posted[0] ?? '') as { note: string }[];
  expect(body.map((seed) => seed.note)).toEqual(['Gardée : le prix est faux', 'Gardée : le bouton est trop petit']);

  // The pins are the worker's now, with a state, and the drafts are gone, reload or not.
  await expect(drafts).toHaveCount(0);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
  expect((await storedSeeds(page)).map((seed) => seed.note).sort()).toEqual(
    ['Gardée : le bouton est trop petit', 'Gardée : le prix est faux'].sort(),
  );
  await page.reload();
  await mount(page, 'drafts');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(2);
  await expect(drafts).toHaveCount(0);
});

test('a failed send of the drafts says why, and keeps them', async ({ page }) => {
  await mount(page, 'drafts-failed');
  await keep(page, 'card-mocha', 'Gardée malgré un 429');
  await page.route(
    (url) => url.origin === WORKER_ORIGIN && url.pathname === '/feedback',
    (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status: 429,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: '{"error":"rate-limited"}',
          })
        : route.fallback(),
  );

  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await list.getByRole('button', { name: 'Send 1 note' }).click();
  await expect(list.locator('[data-fruitback-drafts-sent]')).toHaveText(/^Too many notes just now/);
  await expect(list.getByRole('button', { name: 'Send 1 note' })).toBeFocused();
  await expect(page.locator('[data-fruitback-pin][data-fruitback-draft]')).toHaveCount(1);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe-core finds nothing in the composer and the list with drafts, in the ${scheme} scheme`, async ({ page }) => {
    // Axe reads the colours as painted, and an opening animation paints them at part opacity.
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await mount(page, `drafts-axe-${scheme}`);
    await keep(page, 'card-espresso', 'Une note gardée');
    await page.locator('[data-fruitback-host-launch]').click();
    await page.locator('[data-testid="card-latte"] .add').click();
    await expect(page.getByRole('button', { name: 'Keep for later' })).toBeVisible();
    const composer = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(composer.violations).toEqual([]);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Show every note of this page' }).click();
    await expect(page.getByText('Kept for later, not sent yet')).toBeVisible();
    const list = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
    expect(list.violations).toEqual([]);
  });
}

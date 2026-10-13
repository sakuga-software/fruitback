import { type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The list of the notes when the worker does not answer the read (FRU-153).
 *
 * A reviewer who comes back to the page during an outage read « No note on this page yet. » and
 * believed the notes were gone. While no read answered for the page, the list says the notes could
 * not be read, and offers to read again. A failed read after a good one leaves the pins alone.
 *
 * The widget is the one `init` assembles, from the built script, like `sidebar.spec.ts`.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}-${test.info().retry}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const global = globalThis as unknown as {
      Fruitback: { init(options: Record<string, string>): unknown };
      widget: unknown;
    };
    global.widget = global.Fruitback.init({ endpoint, clientId: 'playground', locale: 'en-US' });
  }, WORKER_ORIGIN);
}

/** Only the read: the write, and anything else, goes through. */
function isRead(route: Route): boolean {
  const request = route.request();

  return request.method() === 'GET' && new URL(request.url()).pathname === '/feedback';
}

const failures = {
  '503': (route: Route) => route.fulfill({ status: 503, body: '{"error":"store-unavailable"}' }),
  '401': (route: Route) => route.fulfill({ status: 401, body: '{"error":"unauthenticated"}' }),
  'no network': (route: Route) => route.abort('internetdisconnected'),
} as const;

for (const [name, fail] of Object.entries(failures)) {
  test(`a first read that fails (${name}) is not an empty list, and « Try again » reads again`, async ({ page }) => {
    let failing = true;
    await page.route(`${WORKER_ORIGIN}/feedback**`, (route) =>
      failing && isRead(route) ? fail(route) : route.continue(),
    );
    await mount(page, `read-failure-${name.replace(' ', '-')}`);

    await page.getByRole('button', { name: 'Show every note of this page' }).click();
    const list = page.getByRole('dialog', { name: 'Notes on this page' });
    await expect(list.getByRole('status')).toHaveText(/could not be read/);
    await expect(list.getByText('No note on this page yet.')).toBeHidden();
    // No number on a tab: zero notes would be a guess.
    await expect(list.getByRole('tab')).toHaveText(['Open', 'Done', 'All']);
    const retry = list.getByRole('button', { name: 'Try again' });
    await expect(retry).toBeFocused();

    // The control: the same page, with a worker that answers an empty list, shows the empty state.
    failing = false;
    await retry.click();
    await expect(list.getByText('No note on this page yet.')).toBeVisible();
    await expect(list.getByRole('tab')).toHaveText(['Open 0', 'Done 0', 'All 0']);
    await expect(list.getByText(/could not be read/)).toHaveCount(0);
  });
}

test('a read that fails after a good one leaves the pins and the list as they were', async ({ page }) => {
  let failing = false;
  await page.route(`${WORKER_ORIGIN}/feedback**`, (route) =>
    failing && isRead(route) ? failures['503'](route) : route.continue(),
  );
  await mount(page, 'read-failure-later');

  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Kept through an outage');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 5_000 });
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  failing = true;
  const failed = page.waitForResponse((response) => response.status() === 503);
  await page.evaluate(() => (globalThis as unknown as { widget: { refresh(): Promise<void> } }).widget.refresh());
  await failed;

  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show every note of this page' }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await list.getByRole('tab', { name: 'All 1' }).click();
  await expect(list.locator('[data-fruitback-note]')).toHaveCount(1);
  await expect(list.getByText(/could not be read/)).toBeHidden();
});

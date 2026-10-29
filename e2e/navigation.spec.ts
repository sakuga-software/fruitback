import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';

/**
 * A note written on one page and sent after the page changed its address (FRU-152).
 *
 * The page stays live while the popover is open: a link of a single-page app or the back button
 * changes the address and the content without a reload. The note must go to the page where it was
 * written, with the element of that page. Before the fix it went with the address of the new page
 * and the selector of the old one.
 *
 * The widget is the one `init` assembles, from the built script, like `sidebar.spec.ts`: the
 * playground builds its own widget part by part.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${testCase}`);
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

/** A navigation of the client, the way React Router hears one: a new entry, then `popstate`. */
async function navigateTo(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, '', to);
    dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

test('a note sent after a navigation goes to the page where it was written', async ({ page }) => {
  const testCase = caseOf('navigation');
  await mount(page, testCase);
  const note = 'Written on the pricing page';

  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  const composer = page.getByRole('dialog', { name: 'New note' });
  const field = page.getByPlaceholder('What should change?');
  await field.fill(note);

  await navigateTo(page, `/checkout?widget=off&case=${testCase}`);
  await page.getByRole('heading', { name: 'Votre commande' }).waitFor();

  // The navigation neither closes the popover nor empties it.
  await expect(composer).toBeVisible();
  await expect(field).toHaveValue(note);

  const posted = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().startsWith(`${WORKER_ORIGIN}/feedback`),
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = (await posted).postDataJSON() as { page: { url: string; path: string }; anchor: { text?: string } };
  expect(new URL(sent.page.url).pathname).toBe('/');
  expect(sent.page.path).toBe('/');
  expect(new URL(sent.page.url).searchParams.get('case')).toBe(testCase);
  await expect(composer).toBeHidden({ timeout: 10_000 });

  // Not on the page the reporter went to.
  const open = page.getByRole('button', { name: 'Show every note in a sidebar' });
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await open.click();
  await expect(list.getByText('No note on this page yet.')).toBeVisible();
  await page.keyboard.press('Escape');

  // Back on the page where it was written, on its element.
  await page.goBack();
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await open.click();
  // « All »: whether the store in memory made it an open note or a done one is not this test's.
  await list.getByRole('button', { name: 'All 1', exact: true }).click();
  const entry = list.locator('[data-fruitback-note]');
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText(note);
  // Among the notes of the page, not among those that could not be placed.
  await expect(list.locator('.fruitback-sidebar-list [data-fruitback-note]')).toHaveCount(1);
  await expect(list.locator('[data-fruitback-unplaced]')).toBeHidden();
  await expect(entry).not.toContainText('approximate');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

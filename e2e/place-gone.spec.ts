import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * A note whose place the tracker refuses (FRU-640): the worker answers `502 destination-unavailable`
 * with an address of help. The widget keeps the text, says why, and links to that address. The
 * worker is made to answer so for each test only.
 *
 * The widget is the one `init` assembles, as the script of the Cloud and the extension mount it: the
 * playground assembles the parts itself, and sends with its own code.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function openPlayground(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
      }),
    WORKER_ORIGIN,
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

const CONSOLE_PAGE = 'https://app.fruitback.com/w/ws_1/sites/site_1';
const HELP_PAGE = 'https://fruitback.com/note-not-sent';

async function refusedFor(page: Page, reader: 'member' | 'visitor') {
  await page.route('**/feedback', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 502,
          contentType: 'application/json',
          // The playground calls the worker of another origin: without this header, the browser hides
          // the answer, and the widget reads a network failure.
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            error: 'destination-unavailable',
            help: reader === 'member' ? CONSOLE_PAGE : HELP_PAGE,
            for: reader,
          }),
        })
      : route.fallback(),
  );
}

async function sendANote(page: Page, note: string) {
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test('a visitor reads that the note did not reach the team, keeps it, and gets the page of help', async ({ page }) => {
  await openPlayground(page, 'place-gone-visitor');
  await refusedFor(page, 'visitor');
  const note = 'Le bouton est trop petit sur mobile';

  await sendANote(page, note);

  const composer = page.locator('[data-fruitback-composer]');
  await expect(composer).toContainText('This note could not reach the team.');
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);
  const help = composer.getByRole('link', { name: 'What to do' });
  await expect(help).toHaveAttribute('href', HELP_PAGE);
  await expect(help).toHaveAttribute('target', '_blank');
  await composer.screenshot({ path: 'test-results/place-gone-visitor.png' });
});

test('a member reads that the place is gone, and gets the page of the site in the console', async ({ page }) => {
  await openPlayground(page, 'place-gone-member');
  await refusedFor(page, 'member');
  const note = 'The heading overlaps the image';

  await sendANote(page, note);

  const composer = page.locator('[data-fruitback-composer]');
  await expect(composer).toContainText('The place this site sends notes to no longer exists in the tracker.');
  await expect(page.getByPlaceholder('What should change?')).toHaveValue(note);
  await expect(composer.getByRole('link', { name: 'Fix it in the console' })).toHaveAttribute('href', CONSOLE_PAGE);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  await composer.screenshot({ path: 'test-results/place-gone-member.png' });
});

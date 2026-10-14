import { expect, test } from '@playwright/test';
import { CONSOLE, SESSION_COOKIE, type Worker, cloudWorker, finished, served } from './cloud-worker.ts';

/**
 * The first administrator of an instance that sends no e-mail and has no provider (FRU-221), in a
 * browser, against a worker of the Cloud on PGlite that has no mailer.
 *
 * The link is the one the worker writes in its log when it starts with `FRUITBACK_FIRST_ADMIN`. It
 * lands on the sign-in page of the console and goes on through the setup, as the link of an e-mail
 * does: no screen of its own.
 */
const ADMIN = 'ana@acme.dev';

/** The link in the lines of the log, as a person copies it. */
function linkIn(lines: string[]): string {
  const link = /http:\/\/\S+/.exec(lines.find((line) => line.includes('/sign-in#')) ?? '')?.[0] ?? '';
  expect(link, lines.join('\n')).toMatch(new RegExp(`^${CONSOLE}/sign-in#`));

  return link;
}

test.describe('the first administrator, on a worker with no mail and no provider (FRU-221)', () => {
  let worker: Worker;

  test.beforeEach(async ({ page }) => {
    worker = await cloudWorker({ mail: false });
    await served(page, worker);
  });
  test.afterEach(({ page }) => finished(page, worker));

  test('reads on the sign-in screen that a link is to be asked for, opens the link of the log, and owns the first workspace', async ({
    page,
    context,
  }) => {
    await page.goto(`${CONSOLE}/sign-in`);
    await expect(
      page.getByRole('alert').filter({ hasText: 'This Fruitback sends no sign-in link by e-mail' }),
    ).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);

    const lines = await worker.firstAdminLines(ADMIN);
    await page.goto(linkIn(lines));

    // The setup of anybody who just signed in: the workspace is made, and the next step is the site.
    await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    const cookies = await context.cookies();
    // `served` hands the answer of the worker of the test to the browser: the cookie is there for both addresses.
    expect(cookies.filter((cookie) => cookie.name === SESSION_COOKIE).length).toBeGreaterThan(0);
    // The token left the address bar, and no e-mail was sent.
    expect(page.url()).not.toContain('#');
    expect(await worker.mail()).toEqual([]);
    // That person owns a workspace now: a second start of the worker writes nothing.
    expect(await worker.firstAdminLines(ADMIN)).toEqual([]);
    expect(await worker.firstAdminLines('eve@elsewhere.example')).toEqual([]);
  });

  test('refuses the link a second time, in another browser, and says so', async ({ page, browser }) => {
    const link = linkIn(await worker.firstAdminLines(ADMIN));
    await page.goto(link);
    await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();

    const other = await browser.newContext();
    const second = await other.newPage();
    await served(second, worker);
    try {
      await second.goto(link);
      await expect(second.getByRole('alert').first()).toBeVisible();
      await expect(second.getByRole('heading', { name: 'Current step: Your site' })).toHaveCount(0);
      expect((await other.cookies()).filter((cookie) => cookie.name === SESSION_COOKIE)).toEqual([]);
    } finally {
      await other.unrouteAll({ behavior: 'ignoreErrors' });
      await other.close();
    }
  });
});

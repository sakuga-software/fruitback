import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The sign-in screen of a worker that signs nobody in (FRU-217): accounts in its database, and no
 * `FRUITBACK_AUTH_SECRET`. That worker answers `{}` on `/auth/providers` and `401` on the console
 * (`auth.test.ts` holds both). The screen used to show its form, and a link asked for there was never
 * sent: « The link could not be sent just now. Try again in a minute. », for ever.
 *
 * The worker is answered by stubs, which keep what the console asked.
 */
const CONSOLE = 'http://localhost:5178';
const CLOSED = 'Nobody can sign in to this Fruitback yet';

async function stubWorker(page: Page, providers: () => { status: number; body: unknown }): Promise<string[]> {
  const asked: string[] = [];
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    asked.push(`${request.method()} ${pathname}`);
    if (pathname === '/auth/providers') {
      const { status, body } = providers();

      return route.fulfill({ status, json: body });
    }
    if (pathname === '/console/me') return route.fulfill({ status: 401, json: { error: 'identity-required' } });

    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });

  return asked;
}

test('says that nobody can sign in, and shows no form, when the worker offers no sign-in', async ({ page }) => {
  const asked = await stubWorker(page, () => ({ status: 200, body: {} }));

  await page.goto(`${CONSOLE}/setup`);

  await expect(page.getByRole('alert').filter({ hasText: CLOSED })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
  // Nothing to type in, and nothing to press: a link asked for here is never sent.
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Continue/ })).toHaveCount(0);
  expect(asked.filter((each) => each.startsWith('POST'))).toEqual([]);
  // The screen fits a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('keeps its form when the worker signs people in, and when it did not say', async ({ page }) => {
  // The control: a worker that says `betterAuth` has the form.
  await stubWorker(page, () => ({ status: 200, body: { betterAuth: { email: true, github: false, google: false } } }));
  await page.goto(`${CONSOLE}/setup`);
  await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: CLOSED })).toHaveCount(0);

  // A worker that refuses to say is not a worker that offers nothing: no form is taken away by a refusal.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stubWorker(page, () => ({ status: 429, body: { error: 'rate-limited' } }));
  await page.goto(`${CONSOLE}/setup`);
  await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: CLOSED })).toHaveCount(0);
});

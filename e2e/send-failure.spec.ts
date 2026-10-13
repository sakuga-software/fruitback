import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * What a failed send says (FRU-156).
 *
 * One sentence, « try again », answered six causes. For a site the worker refuses, trying again
 * never works, and the reporter had no way to know it. The widget is the one `init` assembles, from
 * the built script, like `sidebar.spec.ts`: the playground plants through its own harness.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string, locale: string): Promise<void> {
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
}

/** Every write answered `status`, with the worker's own error. */
async function refuseWrites(page: Page, status: number, error: string): Promise<void> {
  await page.route(
    (url) => url.origin === WORKER_ORIGIN && url.pathname === '/feedback',
    (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({
            status,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error }),
          })
        : route.fallback(),
  );
}

async function sendFailing(page: Page, note: string): Promise<string> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  const field = page.locator('[data-fruitback-note]');
  await field.fill(note);
  await page.locator('[data-fruitback-send]').click();
  const status = page.locator('[data-fruitback-status]');
  await expect(page.locator('[data-fruitback-state="failed"]')).toBeVisible();
  // The text is kept, whatever the cause.
  await expect(field).toHaveValue(note);

  return (await status.textContent()) ?? '';
}

test('a 503 and a 403 say two different things, and both keep the note', async ({ page }) => {
  await refuseWrites(page, 503, 'store-unavailable');
  await mount(page, 'send-failure-503', 'en-US');
  const unavailable = await sendFailing(page, 'Kept through a 503');
  expect(unavailable).toBe('did not go through — your text is kept, try again');

  await page.unrouteAll();
  await refuseWrites(page, 403, 'origin-not-allowed');
  await mount(page, 'send-failure-403', 'en-US');
  const refused = await sendFailing(page, 'Kept through a 403');
  expect(refused).toMatch(/tell the team of the site/);
  expect(refused).not.toBe(unavailable);

  // Still announced: the words are in the live region of the composer.
  await expect(page.locator('[data-fruitback-status]')).toHaveAttribute('role', 'status');
});

test('in French, at 360 px of composer, the failure has a line of its own above the buttons', async ({ page }) => {
  await refuseWrites(page, 403, 'origin-not-allowed');
  await mount(page, 'send-failure-layout', 'fr-FR');
  await sendFailing(page, 'Une note refusée');

  const status = await page.locator('[data-fruitback-status]').boundingBox();
  const cancel = await page.locator('[data-fruitback-cancel]').boundingBox();
  const send = await page.locator('[data-fruitback-send]').boundingBox();
  const composer = await page.locator('[data-fruitback-state="failed"]').boundingBox();
  expect(composer?.width).toBeLessThanOrEqual(360);
  // The sentence ends above the top of both buttons: it shares no line with them.
  expect((status?.y ?? 0) + (status?.height ?? 0)).toBeLessThanOrEqual(Math.min(cancel?.y ?? 0, send?.y ?? 0));
});

for (const [locale, sentence] of [
  ['en-US', 'Your session has ended. Your text is kept: sign in again, then send it.'],
  ['fr-FR', 'Votre session a expiré. Le texte est gardé : reconnectez-vous, puis renvoyez-le.'],
] as const) {
  test(`a 401 says to sign in again, in ${locale}, and Send stays ready (FRU-193)`, async ({ page }) => {
    // It said « tell the team of the site », and that team can do nothing about a session that ended.
    await refuseWrites(page, 401, 'invalid-identity');
    await mount(page, `send-failure-401-${locale}`, locale);
    expect(await sendFailing(page, 'Kept through a 401')).toBe(sentence);

    await expect(page.locator('[data-fruitback-send]')).toBeEnabled();
    const status = await page.locator('[data-fruitback-status]').boundingBox();
    const cancel = await page.locator('[data-fruitback-cancel]').boundingBox();
    const send = await page.locator('[data-fruitback-send]').boundingBox();
    const composer = await page.locator('[data-fruitback-state="failed"]').boundingBox();
    expect(composer?.width).toBeLessThanOrEqual(360);
    expect((status?.y ?? 0) + (status?.height ?? 0)).toBeLessThanOrEqual(Math.min(cancel?.y ?? 0, send?.y ?? 0));
  });
}

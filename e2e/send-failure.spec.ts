import { type Page, expect, test } from '@playwright/test';
import { caseOf, WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * What a failed send says (FRU-156).
 *
 * One sentence, « try again », answered six causes. For a site the worker refuses, trying again
 * never works, and the reporter had no way to know it. The widget is the one `init` assembles, from
 * the built script, like `sidebar.spec.ts`: the playground plants through its own harness.
 */
const IIFE = 'packages/widget/dist/fruitback.iife.js';

async function mount(page: Page, testCase: string, locale: string, endpoint = WORKER_ORIGIN): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ([endpoint, tag]) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint: endpoint as string,
        clientId: 'playground',
        locale: tag as string,
      }),
    [endpoint, locale],
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
  // The sentence of the cause, under « Not sent », in the card of a failed send (FRU-305).
  const status = page.locator('[data-fruitback-failed-text]');
  await expect(page.locator('[data-fruitback-state="failed"]')).toBeVisible();
  await expect(page.locator('[data-fruitback-failed-title]')).not.toHaveText('');
  // The text is kept, whatever the cause.
  await expect(field).toHaveValue(note);

  return (await status.textContent()) ?? '';
}

test('a 503 and a 403 say two different things, and both keep the note', async ({ page }) => {
  await refuseWrites(page, 503, 'store-unavailable');
  await mount(page, 'send-failure-503', 'en-US');
  const unavailable = await sendFailing(page, 'Kept through a 503');
  expect(unavailable).toBe('Your text is still here. Try again, or copy it before you close the page.');

  await page.unrouteAll();
  await refuseWrites(page, 403, 'origin-not-allowed');
  await mount(page, 'send-failure-403', 'en-US');
  const refused = await sendFailing(page, 'Kept through a 403');
  expect(refused).toMatch(/tell the team of the site/);
  expect(refused).not.toBe(unavailable);

  // Still announced: the card of a failure is an alert (FRU-305).
  await expect(page.locator('[data-fruitback-failed]')).toHaveAttribute('role', 'alert');
});

test('in French, at 360 px of composer, the failure has a line of its own above the buttons', async ({ page }) => {
  await refuseWrites(page, 403, 'origin-not-allowed');
  await mount(page, 'send-failure-layout', 'fr-FR');
  await sendFailing(page, 'Une note refusée');

  const status = await page.locator('[data-fruitback-failed]').boundingBox();
  const cancel = await page.locator('[data-fruitback-cancel]').boundingBox();
  const send = await page.locator('[data-fruitback-send]').boundingBox();
  const composer = await page.locator('[data-fruitback-state="failed"]').boundingBox();
  expect(composer?.width).toBeLessThanOrEqual(360);
  // The card of the failure ends above the top of both buttons: it shares no line with them.
  expect((status?.y ?? 0) + (status?.height ?? 0)).toBeLessThanOrEqual(Math.min(cancel?.y ?? 0, send?.y ?? 0));
});

for (const [locale, sentence] of [
  ['en-US', 'Your session has ended. Your text is still here. Sign in again, then send it.'],
  ['fr-FR', 'Votre session a pris fin. Votre texte est toujours là. Reconnectez-vous, puis renvoyez-le.'],
] as const) {
  test(`a 401 says to sign in again, in ${locale}, and Send stays ready (FRU-193)`, async ({ page }) => {
    // It said « tell the team of the site », and that team can do nothing about a session that ended.
    await refuseWrites(page, 401, 'invalid-identity');
    await mount(page, `send-failure-401-${locale}`, locale);
    expect(await sendFailing(page, 'Kept through a 401')).toBe(sentence);

    await expect(page.locator('[data-fruitback-send]')).toBeEnabled();
    const status = await page.locator('[data-fruitback-failed]').boundingBox();
    const cancel = await page.locator('[data-fruitback-cancel]').boundingBox();
    const send = await page.locator('[data-fruitback-send]').boundingBox();
    const composer = await page.locator('[data-fruitback-state="failed"]').boundingBox();
    expect(composer?.width).toBeLessThanOrEqual(360);
    expect((status?.y ?? 0) + (status?.height ?? 0)).toBeLessThanOrEqual(Math.min(cancel?.y ?? 0, send?.y ?? 0));
  });
}

/**
 * FRU-394, measured in production: a page with no session sent a note to a site whose notes are
 * « Members only », the worker answered `401`, and the composer said « try again ». The body is the
 * one `attributionFor` answers a note with no token there. The worker of the suite takes this note,
 * so the refusal is given here, as for the 401 above.
 */
for (const [locale, sentence] of [
  [
    'en-US',
    'This site is for members only. Your text is still here. Sign in to Fruitback from the extension, then send it again.',
  ],
  [
    'fr-FR',
    'Ce site est réservé aux membres. Votre texte est toujours là. Connectez-vous à Fruitback depuis l’extension, puis renvoyez-le.',
  ],
] as const) {
  test(`a note with no session on a site for members says to sign in, not to try again, in ${locale} (FRU-394)`, async ({
    page,
  }) => {
    await refuseWrites(page, 401, 'identity-required');
    await mount(page, `send-failure-members-${locale}`, locale);
    const said = await sendFailing(page, 'Kept through a members-only 401');

    expect(said).toBe(sentence);
    expect(said).not.toMatch(/try again|réessayez/i);
    await expect(page.locator('[data-fruitback-send]')).toBeEnabled();
  });
}

test('a page with no session on a site its members read says so in the list, with no « Try again » (FRU-394)', async ({
  page,
}) => {
  // The worker of the suite whose site its members read: its real 401, no answer given here.
  const refused = page.waitForResponse(
    (response) => response.url().startsWith(`${AUTHENTICATED_WORKER_ORIGIN}/feedback?`) && response.status() === 401,
  );
  await mount(page, 'read-members', 'en-US', AUTHENTICATED_WORKER_ORIGIN);
  await refused;

  const sentence = 'This site is for members only. Sign in to Fruitback from the extension to see its notes.';
  // Said on the page, without the list being opened (FRU-316).
  await expect(page.locator('[data-fruitback-announcer]')).toHaveText(sentence);
  await page.getByRole('button', { name: /^Show every note in a sidebar/ }).click();
  const list = page.getByRole('dialog', { name: 'Notes on this page' });
  await expect(list.getByRole('status')).toHaveText(sentence);
  await expect(list.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

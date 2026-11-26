import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * The safeguards of a page that anybody writes on (FRU-704), as a visitor with no account meets them:
 * the line of the card « Safeguards » set on the worker, then the widget in a browser.
 *
 * The widget as `init` assembles it, on the site `guards` of the dev worker (`POST /__dev/guards`): a
 * site of its own, so the other specs, which all send to `playground` from the same address, are
 * never counted. What the console sends for each line is held by `console-site-access.spec.ts`, and
 * what the worker does with each value by its own tests (`visitor-notes-limit.test.ts`).
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const SITE = 'guards';

async function guards(body: Record<string, unknown>): Promise<void> {
  const answer = await fetch(`${WORKER_ORIGIN}/__dev/guards`, { method: 'POST', body: JSON.stringify(body) });
  expect(answer.status, await answer.clone().text()).toBe(200);
}

async function mount(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, clientId }) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId,
      }),
    { endpoint: WORKER_ORIGIN, clientId: SITE },
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

/** A note on the card of the latte, written and sent as a visitor does. */
async function write(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  // The site goes back to « No limit », so a spec run after this one starts from nothing counted.
  await guards({ visitorNotesPerHour: 0 });
});

test('a visitor leaves the notes of the hour, then the widget asks them to wait, with their text kept (FRU-704)', async ({
  page,
}) => {
  // The smallest limit the console offers.
  await guards({ visitorNotesPerHour: 5 });
  await mount(page, `/?widget=off&case=${caseOf('visitor-limit')}`);
  for (let index = 1; index <= 5; index += 1) {
    await write(page, `Note ${index} d’un visiteur`);
    await expect(page.locator('[data-fruitback-pin]')).toHaveCount(index);
  }

  const refused = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/feedback' && response.request().method() === 'POST',
  );
  await write(page, 'Une sixième note dans l’heure');
  const answer = await refused;
  expect(answer.status()).toBe(429);
  expect(await answer.json()).toEqual({ error: 'visitor-limit', perHour: 5 });

  await expect(
    page.getByText(
      'You sent as many notes as this site takes in an hour. Your text is still here. Send it again later.',
    ),
  ).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une sixième note dans l’heure');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(5);

  // The site says « No limit » now: the same text goes, from the same composer.
  await guards({ visitorNotesPerHour: 0 });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(6);
});

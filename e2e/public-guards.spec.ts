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
  // The site goes back to « No limit » and holds nothing, so a spec run after this one starts clean.
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: false, keepNoteVersions: true });
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

test('a note of a visitor waits for a member on a site that holds them, and the widget says so (FRU-704)', async ({
  page,
}) => {
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: true });
  await mount(page, `/?widget=off&case=${caseOf('visitor-held')}`);
  const sent = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/feedback' && response.request().method() === 'POST',
  );

  await write(page, 'Une note qu’un membre relit d’abord');

  const answer = await sent;
  expect(answer.status()).toBe(202);
  expect(await answer.json()).toMatchObject({ held: true });
  await expect(page.getByText('Sent for review')).toBeVisible();
  await expect(
    page.getByText('The team of this site reviews notes before they go on. Its pin shows here once approved.'),
  ).toBeVisible();
  // In no tracker yet: no pin on the page, after a reload too.
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  await mount(page, `/?widget=off&case=${caseOf('visitor-held')}`);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  await guards({ holdVisitorNotes: false });
});

/** The thread of the one pin of the page. */
async function openThread(page: Page) {
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.locator('[data-fruitback-pin]').getByRole('button').first().click();

  return page.getByRole('dialog', { name: /Note 1/ });
}

test('a visitor who edits their note on a site that keeps every version is told the team keeps the text of before (FRU-704)', async ({
  page,
}) => {
  const KEPT = 'The team of this site keeps the text of before in the history of the note.';
  await guards({ visitorNotesPerHour: 0, holdVisitorNotes: false, keepNoteVersions: true });
  const path = `/?widget=off&case=${caseOf('visitor-versions')}`;
  await mount(page, path);
  await write(page, 'Une note qu’on modifie ensuite');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await mount(page, path);
  const thread = await openThread(page);
  await thread.getByRole('button', { name: 'More actions on your note' }).click();
  await thread.getByRole('menuitem', { name: 'Edit the text' }).click();
  await expect(thread.getByText(KEPT)).toBeVisible();
  await thread.getByRole('textbox', { name: 'Your note' }).fill('Une note modifiée, gardée pour l’équipe');
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/text'));
  await thread.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status()).toBe(200);
  await expect(thread.getByText('Saved')).toBeVisible();

  // The site keeps no version now: the same form says nothing of it.
  await guards({ keepNoteVersions: false });
  await mount(page, path);
  const again = await openThread(page);
  await again.getByRole('button', { name: 'More actions on your note' }).click();
  await again.getByRole('menuitem', { name: 'Edit the text' }).click();
  await expect(again.getByRole('textbox', { name: 'Your note' })).toBeVisible();
  await expect(again.getByText(KEPT)).toHaveCount(0);
  await guards({ keepNoteVersions: true });
});

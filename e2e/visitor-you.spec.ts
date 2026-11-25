import { type Page, type Request, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * A visitor with no account is known by the key of their browser (FRU-700): the note they left reads
 * « You · this browser » in their browser, and in no other.
 *
 * The widget as `init` assembles it, from its `<script>`: the playground assembles the parts itself,
 * and keeps no key. Two contexts are two browsers, each with its own `localStorage`, so its own key.
 * What a browser adds to `visitor-key.test.ts` of the worker is CORS: the header of the key is not
 * safelisted, and a preflight that did not list it would refuse every read of a visitor who sent a
 * note.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const NOTE = 'Une note que seul ce navigateur reconnaît';
const YOU = 'You · this browser';

async function mount(page: Page, path: string): Promise<void> {
  await page.goto(path);
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

/** The thread of the one pin of the page. */
async function openThread(page: Page) {
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.locator('[data-fruitback-pin]').getByRole('button').first().click();

  return page.getByRole('dialog', { name: /Note 1/ });
}

test('a visitor reads their note as theirs, and another browser does not', async ({ browser, baseURL }) => {
  const mine = await browser.newContext({ baseURL });
  const other = await browser.newContext({ baseURL });
  const page = await mine.newPage();
  const calls: Request[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${WORKER_ORIGIN}/feedback`) && request.method() !== 'OPTIONS') calls.push(request);
  });
  const path = `/?widget=off&case=${caseOf('visitor-you')}`;

  await mount(page, path);
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(NOTE);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await mount(page, path);
  const thread = await openThread(page);
  await expect(thread.getByText(NOTE)).toBeVisible();
  await expect(thread.getByText(YOU, { exact: true })).toBeVisible();

  // The first read went with no key, and the note made it: every call after carries the same one.
  const keys = await Promise.all(calls.map(async (call) => (await call.allHeaders())['x-fruitback-visitor']));
  const first = calls.findIndex((call) => call.method() === 'POST');
  expect(keys[0]).toBeUndefined();
  expect(keys[first]).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(new Set(keys.slice(first))).toEqual(new Set([keys[first]]));
  expect(calls.slice(first + 1).some((call) => call.method() === 'GET')).toBe(true);

  // Another browser reads the same note, and it is not theirs.
  const elsewhere = await other.newPage();
  await mount(elsewhere, path);
  const theirs = await openThread(elsewhere);
  await expect(theirs.getByText(NOTE)).toBeVisible();
  await expect(theirs.getByText(YOU, { exact: true })).toHaveCount(0);

  await mine.close();
  await other.close();
});

test('a visitor edits the text of their open note, and another browser reads the new text (FRU-701)', async ({
  browser,
  baseURL,
}) => {
  const mine = await browser.newContext({ baseURL });
  const other = await browser.newContext({ baseURL });
  const page = await mine.newPage();
  const path = `/?widget=off&case=${caseOf('visitor-edit')}`;

  await mount(page, path);
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(NOTE);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  await mount(page, path);
  const thread = await openThread(page);
  await expect(thread.getByText('You can edit it until a member picks it up.')).toBeVisible();
  await thread.getByRole('button', { name: 'More actions on your note' }).click();
  await expect(thread.getByRole('menuitem')).toHaveText(['Edit the text', 'Copy link to the note']);
  await thread.getByRole('menuitem', { name: 'Edit the text' }).click();
  const field = thread.getByRole('textbox', { name: 'Your note' });
  await field.fill('Une note modifiée par ce navigateur');
  await thread.getByRole('button', { name: 'Save' }).click();
  await expect(thread.getByText('Saved')).toBeVisible();
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('Une note modifiée par ce navigateur');

  // Another browser reads the new text, and is offered no edit.
  const elsewhere = await other.newPage();
  await mount(elsewhere, path);
  const theirs = await openThread(elsewhere);
  await expect(theirs.locator('.fruitback-thread-note')).toHaveText('Une note modifiée par ce navigateur');
  await expect(theirs.getByRole('button', { name: 'More actions on your note' })).toHaveCount(0);
  await expect(theirs.locator('.fruitback-thread-edit')).toHaveCount(0);

  await mine.close();
  await other.close();
});

test('a visitor deletes their open note after a confirmation, and its pin leaves the page for everyone (FRU-702)', async ({
  browser,
  baseURL,
}) => {
  const mine = await browser.newContext({ baseURL });
  const other = await browser.newContext({ baseURL });
  const page = await mine.newPage();
  const path = `/?widget=off&case=${caseOf('visitor-delete')}`;

  await mount(page, path);
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill(NOTE);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  // The control: another browser reads the pin before the deletion.
  const elsewhere = await other.newPage();
  await mount(elsewhere, path);
  await expect(elsewhere.locator('[data-fruitback-pin]')).toHaveCount(1);

  await mount(page, path);
  const thread = await openThread(page);
  await expect(thread.getByText('You can edit or delete it until a member picks it up.')).toBeVisible();
  await thread.getByRole('button', { name: 'More actions on your note' }).click();
  await thread.getByRole('menuitem', { name: 'Delete the note' }).click();
  await expect(thread.getByText('Delete your note?')).toBeVisible();
  await thread.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(thread.getByText('Deleted. The pin goes away when you close this note.')).toBeVisible();
  await thread.getByRole('button', { name: 'Close the note' }).click();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);

  // The read of the other browser answered, with no note: an absence after a read, not before it.
  const answered = elsewhere.waitForResponse(
    (response) => response.url().startsWith(`${WORKER_ORIGIN}/feedback?`) && response.request().method() === 'GET',
  );
  await mount(elsewhere, path);
  expect(((await (await answered).json()) as { issues: unknown[] }).issues).toEqual([]);
  await expect(elsewhere.locator('[data-fruitback-pin]')).toHaveCount(0);

  await mine.close();
  await other.close();
});

import { type Browser, type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * A visitor known by a confirmed address (FRU-705): before their first edit, the widget asks for an
 * address and the worker sends a link; opened in the browser that asked, it confirms the address, and
 * the note can be edited. Another browser that confirms the same address finds the note as its own.
 *
 * The widget as `init` assembles it, on the site `email` of the dev worker (`POST /__dev/email`), a site
 * of its own. The link goes to the mailer of development, which `GET /__dev/mail` answers: no message
 * leaves this machine. Two contexts are two browsers, each with its own `localStorage`, so its own key.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const SITE = 'email';
const NOTE = 'Une note à confirmer par e-mail';
const ADDRESS = 'visitor-of-a-test@example.com';

async function mount(page: Page, path: string): Promise<void> {
  if (path !== '') await page.goto(path);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, clientId }) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } }).Fruitback.init({
        endpoint,
        clientId,
      }),
    { endpoint: WORKER_ORIGIN, clientId: SITE },
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

async function openThread(page: Page) {
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.locator('[data-fruitback-pin]').getByRole('button').first().click();

  return page.getByRole('dialog', { name: /Note 1/ });
}

/** The link of the last message to `ADDRESS`, as the mailer of development kept it. */
async function lastLink(): Promise<string> {
  const answer = await fetch(`${WORKER_ORIGIN}/__dev/mail`);
  const sent = (await answer.json()) as { to: string; text: string }[];
  const text = sent.filter((each) => each.to === ADDRESS).at(-1)?.text ?? '';
  const link = /https?:\/\/\S+#fruitback-confirm=\S+/u.exec(text)?.[0];
  expect(link, text).toBeDefined();

  return link as string;
}

/** Asks for the link under the open note, then opens it in the same browser. */
async function confirmHere(page: Page, path: string): Promise<void> {
  const thread = await openThread(page);
  const form = thread.locator('.fruitback-thread-confirm');
  await form.getByRole('textbox', { name: 'Your e-mail address' }).fill(ADDRESS);
  await form.getByRole('button', { name: 'Send the link' }).click();
  await expect(form.getByRole('status')).toHaveText('Open the link we sent, in this browser, within 30 minutes.');
  await page.goto(await lastLink());
  await mount(page, '');
  // The link is taken out of the address once it served.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  expect(new URL(page.url()).pathname).toBe(new URL(path, 'http://localhost').pathname);
}

async function browserWith(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });

  return { context, page: await context.newPage() };
}

test('a visitor confirms an address before their first edit, and finds their note on another browser', async ({
  browser,
  baseURL,
}) => {
  const made = await fetch(`${WORKER_ORIGIN}/__dev/email`, { method: 'POST' });
  expect(made.status).toBe(200);
  const path = `/?widget=off&case=${caseOf('visitor-email')}`;

  const first = await browserWith(browser, baseURL);
  await mount(first.page, path);
  await first.page.getByRole('button', { name: /Leave a note/ }).click();
  await first.page.locator('[data-testid="card-latte"] .add').click();
  await first.page.getByPlaceholder('What should change?').fill(NOTE);
  await first.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(first.page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // Theirs, and no edit before an address is confirmed.
  await mount(first.page, path);
  let thread = await openThread(first.page);
  await expect(thread.getByText('You · this browser', { exact: true })).toBeVisible();
  await expect(thread.getByRole('button', { name: 'More actions on your note' })).toHaveCount(0);
  await expect(thread.locator('.fruitback-thread-confirm')).toContainText(
    'Confirm your address to edit or delete your note',
  );
  await first.page.keyboard.press('Escape');
  await confirmHere(first.page, path);

  thread = await openThread(first.page);
  await expect(thread.getByText('You', { exact: true })).toBeVisible();
  await expect(thread.locator('.fruitback-thread-confirm')).toHaveCount(0);
  await thread.getByRole('button', { name: 'More actions on your note' }).click();
  await thread.getByRole('menuitem', { name: 'Edit the text' }).click();
  await thread.getByRole('textbox', { name: 'Your note' }).fill('Une note confirmée, puis modifiée');
  await thread.getByRole('button', { name: 'Save' }).click();
  await expect(thread.getByText('Saved')).toBeVisible();

  // Another browser: not theirs until it confirms the same address, then theirs.
  const second = await browserWith(browser, baseURL);
  await mount(second.page, path);
  thread = await openThread(second.page);
  await expect(thread.getByText('You', { exact: true })).toHaveCount(0);
  await expect(thread.locator('.fruitback-thread-confirm')).toContainText('Left a note from another browser?');
  await second.page.keyboard.press('Escape');
  await confirmHere(second.page, path);
  thread = await openThread(second.page);
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('Une note confirmée, puis modifiée');
  await expect(thread.getByText('You', { exact: true })).toBeVisible();
  await expect(thread.getByRole('button', { name: 'More actions on your note' })).toBeVisible();

  for (const each of [first, second]) await each.context.close();
});

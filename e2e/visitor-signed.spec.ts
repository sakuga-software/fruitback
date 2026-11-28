import { createHmac } from 'node:crypto';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';

/**
 * A visitor the site signs (FRU-706): the backend of the site signs who its user is with the key of
 * the site, and the widget sends the token. Their note is theirs on another device, and a token that
 * expired falls back on the key of the browser, which opens nothing of theirs.
 *
 * The widget as `init` assembles it, on the site `signed` of the dev worker (`POST /__dev/signed`), a
 * site of its own that answers its key, as the console shows it once. The token is minted here, as a
 * backend mints it. Two contexts are two devices, each with its own `localStorage`, so its own key.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const SITE = 'signed';
const NOTE = 'Une note signée par le site';

async function keyOfTheSite(): Promise<string> {
  const answer = await fetch(`${WORKER_ORIGIN}/__dev/signed`, { method: 'POST' });
  expect(answer.status, await answer.clone().text()).toBe(200);

  return ((await answer.json()) as { key: string }).key;
}

/** A JWT HS256, as the guide `docs/install/identified-reporters.md` mints one. */
function tokenOf(key: string, sub: string, exp = Math.floor(Date.now() / 1000) + 300): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ sub, name: 'Ana', exp });

  return `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`;
}

async function mount(page: Page, path: string, token: string): Promise<void> {
  await page.goto(path);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    ({ endpoint, clientId, token }) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } }).Fruitback.init({
        endpoint,
        clientId,
        identityToken: () => token,
      }),
    { endpoint: WORKER_ORIGIN, clientId: SITE, token },
  );
  await expect(page.locator('[data-fruitback-host-launch]')).toBeVisible();
}

/** The thread of the one pin of the page. */
async function openThread(page: Page) {
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await page.locator('[data-fruitback-pin]').getByRole('button').first().click();

  return page.getByRole('dialog', { name: /Note 1/ });
}

async function device(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });

  return { context, page: await context.newPage() };
}

test('a person the site signs edits their note from another device, and a token that expired opens nothing of theirs', async ({
  browser,
  baseURL,
}) => {
  const key = await keyOfTheSite();
  const ana = tokenOf(key, 'user-ana');
  const path = `/?widget=off&case=${caseOf('visitor-signed')}`;

  // The first device sends the note, with the token of Ana.
  const first = await device(browser, baseURL);
  await mount(first.page, path, ana);
  await first.page.getByRole('button', { name: /Leave a note/ }).click();
  await first.page.locator('[data-testid="card-latte"] .add').click();
  // The site names the reporter: the composer asks for no name.
  await expect(first.page.getByPlaceholder('Your name')).toBeHidden();
  await first.page.getByPlaceholder('What should change?').fill(NOTE);
  await first.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(first.page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // Another device, another key of the browser, the same person: the note is theirs, and they edit it.
  const second = await device(browser, baseURL);
  await mount(second.page, path, ana);
  const thread = await openThread(second.page);
  await expect(thread.getByText(NOTE)).toBeVisible();
  await expect(thread.getByText('You', { exact: true })).toBeVisible();
  await expect(thread.getByText('You can edit or delete it until a member picks it up.')).toBeVisible();
  await thread.getByRole('button', { name: 'More actions on your note' }).click();
  await thread.getByRole('menuitem', { name: 'Edit the text' }).click();
  await thread.getByRole('textbox', { name: 'Your note' }).fill('Une note signée, modifiée ailleurs');
  await thread.getByRole('button', { name: 'Save' }).click();
  await expect(thread.getByText('Saved')).toBeVisible();
  await expect(thread.locator('.fruitback-thread-note')).toHaveText('Une note signée, modifiée ailleurs');

  // A third device whose token expired: the key of its browser decides, and the note is not theirs.
  const third = await device(browser, baseURL);
  await mount(third.page, path, tokenOf(key, 'user-ana', Math.floor(Date.now() / 1000) - 120));
  const theirs = await openThread(third.page);
  await expect(theirs.locator('.fruitback-thread-note')).toHaveText('Une note signée, modifiée ailleurs');
  await expect(theirs.locator('.fruitback-thread-you')).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'More actions on your note' })).toHaveCount(0);

  for (const each of [first, second, third]) await each.context.close();
});

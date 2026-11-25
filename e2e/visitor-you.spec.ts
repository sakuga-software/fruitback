import { type Request, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, badgeFor, caseOf, plantPin, waitForPins } from './pin.ts';

/**
 * A visitor with no account is known by the key of their browser (FRU-700): the note they left reads
 * « You · this browser » in their browser, and in no other.
 *
 * Two contexts are two browsers: each has its own `localStorage`, so its own key. What a browser adds
 * to `visitor-key.test.ts` of the worker is CORS: the header of the key is not safelisted, and a
 * preflight that does not list it would refuse every read of a visitor who sent a note.
 */

const NOTE = 'Une note que seul ce navigateur reconnaît';
const YOU = 'You · this browser';

test('a visitor reads their note as theirs, and another browser does not', async ({ browser, baseURL }) => {
  const mine = await browser.newContext({ baseURL });
  const other = await browser.newContext({ baseURL });
  const page = await mine.newPage();
  const reads: Request[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(`${WORKER_ORIGIN}/feedback?`)) reads.push(request);
  });
  const path = `/?case=${caseOf('visitor-you')}`;

  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await plantPin(page, page.locator('[data-testid="card-latte"] .add'), NOTE);
  await page.reload();
  await waitForPins(page, 1);
  await badgeFor(page, NOTE).click();
  const thread = page.getByRole('dialog', { name: /Note 1/ });
  await expect(thread.getByText(YOU, { exact: true })).toBeVisible();

  // The key went with the read after the note, through the preflight of the browser.
  const keyed = await Promise.all(reads.map(async (request) => (await request.allHeaders())['x-fruitback-visitor']));
  expect(keyed.at(-1)).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  // Another browser reads the same note, and it is not theirs.
  const elsewhere = await other.newPage();
  await elsewhere.goto(path);
  await waitForPins(elsewhere, 1);
  await badgeFor(elsewhere, NOTE).click();
  const theirs = elsewhere.getByRole('dialog', { name: /Note 1/ });
  await expect(theirs.getByText(NOTE)).toBeVisible();
  await expect(theirs.getByText(YOU, { exact: true })).toHaveCount(0);

  await mine.close();
  await other.close();
});

import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN, caseOf, hydrated } from './pin.ts';
import { addRule, openBareSite, test as extensionTest } from './extension.ts';

/**
 * « Want to know when it's fixed? » (FRU-604), on the playground, as a visitor with no account: the
 * question under the card of the note sent, the address given, the note moved to Done as a team
 * moves it, and the one message the worker of development keeps at `GET /__dev/mail`.
 *
 * The other specs start from a browser that answered the question (`storageState` of the
 * configuration); these start from one that never saw it.
 *
 * The question is a switch of the site, off by default (Mathieu, 2026-11-06). Its tests are in this
 * one file, which runs in order: the switch is off first, then on, and off again at the end, so a
 * file that runs beside it on CI meets the default.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/** « Offer visitors an e-mail when their note is done » of the site of the playground. */
async function offer(on: boolean): Promise<void> {
  const set = await fetch(`${WORKER_ORIGIN}/__dev/writers`, {
    method: 'POST',
    body: JSON.stringify({ writers: 'anyone', notifyDone: on }),
  });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { notifyDone?: unknown }).notifyDone).toBe(on);
}

test.afterAll(async () => {
  await offer(false);
});

test('switch off, the default: no question after a note, and the route refuses', async ({ page }) => {
  await offer(false);
  await openWidget(page, 'notify-off');
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('#checkout-cta').click();
  await page.getByPlaceholder('What should change?').fill('A note on a site that offers no e-mail');
  const answer = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/feedback',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const body = (await (await answer).json()) as { notify?: unknown };
  expect(body.notify).toBeUndefined();
  await expect(page.locator('[data-fruitback-notify]')).toBeHidden();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });

  const id = (await page.locator('[data-fruitback-pin]').last().getAttribute('data-fruitback-pin')) as string;
  const refused = await fetch(`${WORKER_ORIGIN}/feedback/${id}/notify?client=playground`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5177' },
    body: JSON.stringify({ email: 'ana@example.com', token: '1.x' }),
  });
  expect(refused.status).toBe(404);
});

type Mail = { to: string; subject: string; text: string; html: string };

const mails = async (): Promise<Mail[]> => (await (await fetch(`${WORKER_ORIGIN}/__dev/mail`)).json()) as Mail[];

/** The widget as `init` assembles it, on the bare playground: the scaffolding of the playground is not it. */
async function openWidget(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: 'packages/widget/dist/fruitback.iife.js' });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'playground',
        locale: 'en-US',
      }),
    WORKER_ORIGIN,
  );
}

async function send(page: Page, note: string): Promise<string> {
  await page.locator('[data-fruitback-host-launch]').click();
  await page.locator('#checkout-cta').click();
  await page.getByPlaceholder('What should change?').fill(note);
  const answer = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/feedback',
  );
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const body = (await (await answer).json()) as { issue: unknown };
  expect(body.issue).toBeDefined();
  await expect(page.locator('[data-fruitback-sent-title]')).toHaveText(/^Sent/);

  return (await page.locator('[data-fruitback-pin]').last().getAttribute('data-fruitback-pin')) as string;
}

test('switch on: a visitor gives an address after a note, and gets one e-mail when it is done', async ({ page }) => {
  test.slow();
  await offer(true);
  // A window where the element sits low: the question makes the composer taller after the send.
  await page.setViewportSize({ width: 1280, height: 800 });
  await openWidget(page, 'notify-guest');
  const id = await send(page, 'Le bouton Commander est trop petit');

  const question = page.locator('[data-fruitback-notify]');
  await expect(question).toBeVisible();
  await expect(question.locator('#fruitback-notify-title')).toHaveText('Want to know when it’s fixed?');
  await expect(question).toHaveAttribute('aria-labelledby', 'fruitback-notify-title');
  // Placed again with its new height: both answers are inside the window, with no scroll.
  await expect(question.getByRole('button', { name: 'Notify me' })).toBeInViewport({ ratio: 1 });
  await expect(question.getByRole('button', { name: 'No thanks' })).toBeInViewport({ ratio: 1 });
  await expect(question.getByRole('textbox', { name: 'Email' })).toBeFocused();
  // The composer stays open under the question: no timer closes it.
  await page.waitForTimeout(4_500);
  await expect(question).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(
    violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`),
  ).toEqual([]);

  // An address that is none is refused in the widget, and the field keeps what was typed.
  await question.getByRole('textbox', { name: 'Email' }).fill('ana-at-example');
  await question.getByRole('button', { name: 'Notify me' }).click();
  await expect(question.getByRole('alert')).toHaveText('Enter an email address, like name@example.com.');
  await expect(question.getByRole('textbox', { name: 'Email' })).toHaveValue('ana-at-example');

  const address = `ana+${test.info().testId.slice(0, 8)}@example.com`;
  await question.getByRole('textbox', { name: 'Email' }).fill(address);
  await question.getByRole('button', { name: 'Notify me' }).click();
  await expect(page.locator('[data-fruitback-notify-done]')).toHaveText('We’ll email you once, when it’s fixed.');
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });

  // Not done yet: nothing is sent.
  expect((await mails()).filter((mail) => mail.to === address)).toEqual([]);

  // The team moves the note to Done, as it would in its tracker.
  const moved = await fetch(`${WORKER_ORIGIN}/__dev/stage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: id, stage: 'done' }),
  });
  expect(moved.status).toBe(200);

  // A read of the page that asks the store sends it, once the read cache (15 s) let go of the answer of before.
  await expect
    .poll(
      async () => {
        await openWidget(page, 'notify-guest');
        await expect(page.locator('[data-fruitback-pin]').first()).toBeVisible();

        return (await mails()).filter((mail) => mail.to === address).length;
      },
      { timeout: 45_000, intervals: [3_000] },
    )
    .toBe(1);
  const [mail] = (await mails()).filter((each) => each.to === address);
  expect(mail?.subject).toBe('Your note on localhost:​5177 is fixed');
  expect(mail?.text).toContain(`#fruitback-note=${id}`);
  expect(mail?.html).toContain('Check it on the page');
  expect(mail?.text).not.toContain('Le bouton Commander');

  // Read again: nobody is written to a second time.
  await openWidget(page, 'notify-guest');
  await page.waitForTimeout(1_000);
  expect((await mails()).filter((each) => each.to === address)).toHaveLength(1);

  // Once per browser: the next note asks nothing, and the composer closes by itself.
  await send(page, 'Une deuxième note');
  await expect(page.locator('[data-fruitback-notify]')).toBeHidden();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
});

test('switch on: « No thanks » closes the composer, and the question is not asked again', async ({ page }) => {
  await offer(true);
  await openWidget(page, 'notify-no-thanks');
  await send(page, 'Une note sans adresse');
  const question = page.locator('[data-fruitback-notify]');
  await question.getByRole('button', { name: 'No thanks' }).click();
  await expect(page.locator('[data-fruitback-composer]')).toBeHidden();

  const stored = await page.evaluate(() => localStorage.getItem('fruitback:notify-ask'));
  expect(JSON.parse(stored ?? '{}')).toMatchObject({ answer: 'no' });
  expect(stored).not.toContain('@');

  await openWidget(page, 'notify-no-thanks');
  await send(page, 'Une autre note');
  await expect(page.locator('[data-fruitback-notify]')).toBeHidden();
});

extensionTest(
  'switch on: a widget the extension mounts never asks « Want to know when it’s fixed? » after a note',
  async ({ extension }) => {
    await offer(true);
    // Private mode on the public worker: the reviewer has no session there, so the worker takes the
    // note as a visitor's and offers a token. The control: the answer carries it, so the absence below
    // is the product's rule (the extension mounts with askForAddress: false), and not a missing token.
    await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
    const site = await extension.context.newPage();
    await openBareSite(site, 'extension-no-question');
    await site.locator('[data-fruitback-host-launch]').click();
    await site.locator('[data-testid="card-latte"] .add').click();
    await site.getByPlaceholder('What should change?').fill('A reviewer is never asked for an address.');
    const answer = site.waitForResponse(
      (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/feedback',
    );
    await site.getByRole('button', { name: 'Send', exact: true }).click();
    const body = (await (await answer).json()) as { notify?: { token?: unknown } };
    expect(typeof body.notify?.token).toBe('string');
    await expect(site.locator('[data-fruitback-pin]')).toHaveCount(1);
    // No question, and the composer closes by itself, as before FRU-604.
    await expect(site.locator('[data-fruitback-notify]')).toBeHidden();
    await expect(site.locator('[data-fruitback-composer]')).toBeHidden({ timeout: 10_000 });
  },
);

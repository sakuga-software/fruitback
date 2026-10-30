import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The sign-in page, and the tab that goes on by itself (FRU-235, screen 02 of the mockup of
 * 2026-10-13).
 *
 * The first part runs against a worker whose accounts are in PostgreSQL (PGlite): no stub decides an
 * answer, and the link is read in the mail. The second part measures the four states against the
 * mockup, and there the worker is answered by stubs: it measures boxes and colours.
 */
const INBOX = 'Check your inbox';

/** Asks for a link from the sign-in page, and waits until the worker was asked to send it. */
async function askForLink(page: Page, worker: Worker, email: string): Promise<string> {
  const before = (await worker.sent()).length;
  await page.goto(`${CONSOLE}/sign-in`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('heading', { name: INBOX })).toBeVisible();
  await expect.poll(async () => (await worker.sent()).length).toBe(before + 1);

  return linkIn(worker);
}

test.describe('the sign-in page, against a worker with accounts (FRU-235)', () => {
  let worker: Worker;

  test.beforeEach(async ({ context }) => {
    worker = await cloudWorker();
    await served(context, worker);
  });
  test.afterEach(({ context }) => finished(context, worker));

  test('the tab that asked for the link goes on by itself when the link is opened in another tab', async ({
    page,
    context,
  }) => {
    const link = await askForLink(page, worker, 'ana@acme.dev');
    // The confirmation names the address, and is said to a screen reader.
    await expect(page.getByRole('status')).toHaveText('A sign-in link is on its way to ana@acme.dev.');

    // The mail opens the link in another tab of the same browser.
    const other = await context.newPage();
    await other.goto(link);

    // The first tab is in the console, with no press of anything: a new account has no site yet,
    // so the front door leads it to the setup, signed in, at its second step.
    await expect(page).toHaveURL(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    // The tab of the link says so, and stays.
    await expect(other.getByRole('heading', { name: 'You are signed in' })).toBeVisible();
    await expect(other.getByRole('status')).toHaveText(
      'Your other Fruitback tab has carried on without you. You can close this one.',
    );
    // The token left the address bar, and reached the worker in no address.
    expect(other.url()).toBe(`${CONSOLE}/sign-in`);
    const token = link.split('#')[1] as string;
    expect((await worker.received()).some((each) => each.path.includes(token))).toBe(false);
    // The first tab asked the worker who is signed in: it did not take the word of the other tab.
    expect(
      (await worker.received()).filter((each) => each.path === '/console/me' && each.cookie).length,
    ).toBeGreaterThan(0);

    // « Continue in this tab » is a way on for whoever stays in the tab of the link.
    await other.getByRole('link', { name: 'Continue in this tab' }).click();
    await expect(other).toHaveURL(`${CONSOLE}/setup`);
  });

  // The setup that goes on by itself when its link is opened in another tab is measured with the
  // setup, in `console-setup.spec.ts` (FRU-239).

  test('the tab of the link is the console when no tab waits for it', async ({ page }) => {
    const link = await askForLink(page, worker, 'ana@acme.dev');

    // The same tab opens the link: nothing waits any more.
    await page.goto(link);

    await expect(page).toHaveURL(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You are signed in' })).toHaveCount(0);
  });

  test('a tab the browser told nothing goes on when it comes back to the front', async ({ page, context }) => {
    // A browser with no `BroadcastChannel`: the tabs tell each other nothing.
    await context.addInitScript(() => {
      delete (window as { BroadcastChannel?: unknown }).BroadcastChannel;
    });
    const link = await askForLink(page, worker, 'ana@acme.dev');
    const other = await context.newPage();
    await other.goto(link);
    // The tab of the link heard no answer: it is the console, as before.
    await expect(other).toHaveURL(`${CONSOLE}/setup`);
    // The control: the first tab did not move by itself.
    await expect(page.getByRole('heading', { name: INBOX })).toBeVisible();

    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));

    await expect(page).toHaveURL(`${CONSOLE}/setup`);
  });

  test('a tab that waits does not move on the word of another tab alone', async ({ page, context }) => {
    await askForLink(page, worker, 'ana@acme.dev');
    const asked = (await worker.received()).filter((each) => each.path === '/console/me').length;

    // Another page of the console says « signed-in », and nobody is: the link was not opened.
    const other = await context.newPage();
    await other.goto(`${CONSOLE}/sign-in`);
    await other.evaluate(() => new BroadcastChannel('fruitback:sign-in').postMessage('signed-in'));

    // The control: the tab heard it, and asked the worker.
    await expect
      .poll(async () => (await worker.received()).filter((each) => each.path === '/console/me').length)
      .toBeGreaterThan(asked + 1);
    await expect(page.getByRole('heading', { name: INBOX })).toBeVisible();
    expect(page.url()).toBe(`${CONSOLE}/sign-in`);
  });

  test('a link that was used says so, and « Send me a new link » sends one', async ({ page }) => {
    const link = await askForLink(page, worker, 'ana@acme.dev');
    await page.goto(link);
    await expect(page).toHaveURL(`${CONSOLE}/setup`);
    // Signed out, so the second visit of the link is of nobody.
    await page.context().clearCookies();

    await page.goto(link);

    await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
    await expect(
      page.getByText('A link works once, for fifteen minutes. This one was already used or ran out of time.'),
    ).toBeVisible();
    expect(page.url()).toBe(`${CONSOLE}/sign-in`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Send me a new link' }).click();
    await expect(page.getByRole('heading', { name: INBOX })).toBeVisible();
    await expect.poll(async () => (await worker.sent()).length).toBe(2);
    expect(await linkIn(worker)).not.toBe(link);
  });

  test('what is typed stays when the link is refused, and when the field is sent empty', async ({ page }) => {
    await page.goto(`${CONSOLE}/sign-in`);
    const field = page.getByRole('textbox', { name: 'Work email' });

    // Empty: the form says what is missing, and asks the worker for nothing.
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByRole('alert')).toHaveText('That is not an e-mail address. Check it and send again.');
    expect((await worker.received()).filter((each) => each.path === '/console/auth/email')).toEqual([]);

    // Refused by the worker: the same sentence, and the field as it was typed.
    await field.fill('ana at acme');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect
      .poll(async () => (await worker.received()).some((each) => each.path === '/console/auth/email'))
      .toBe(true);
    await expect(page.getByRole('alert')).toHaveText('That is not an e-mail address. Check it and send again.');
    await expect(field).toHaveValue('ana at acme');
    expect(await worker.sent()).toEqual([]);

    // « Use another address » gives the form back with the address in it.
    await field.fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByRole('heading', { name: INBOX })).toBeVisible();
    await page.getByRole('button', { name: 'Use another address' }).click();
    await expect(page.getByRole('textbox', { name: 'Work email' })).toHaveValue('ana@acme.dev');
  });

  test('somebody who is signed in already is sent to the console', async ({ page }) => {
    const link = await askForLink(page, worker, 'ana@acme.dev');
    await page.goto(link);
    await expect(page).toHaveURL(`${CONSOLE}/setup`);

    await page.goto(`${CONSOLE}/sign-in`);

    await expect(page).toHaveURL(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: 'Sign in to Fruitback' })).toHaveCount(0);
  });

  test('a screen of a workspace sends nobody signed in to the sign-in page', async ({ page }) => {
    await page.goto(`${CONSOLE}/w/ws_00000000000000000000/sites`);

    await expect(page).toHaveURL(`${CONSOLE}/sign-in`);
    await expect(page.getByRole('heading', { name: 'Sign in to Fruitback' })).toBeVisible();
  });
});

/** What the worker offers, and what it answers to a link: the stubs of the second part. */
type Stub = { providers?: unknown; redeem?: 'opens' | 'refuses' | 'silent'; send?: { status: number; body: unknown } };

async function stubWorker(page: Page, stub: Stub = {}): Promise<string[]> {
  const asked: string[] = [];
  await page.context().route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    asked.push(`${request.method()} ${pathname}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers') {
      return json(stub.providers ?? { betterAuth: { email: true, github: true, google: true } });
    }
    if (pathname === '/console/me') return json({ error: 'identity-required' }, 401);
    if (pathname === '/console/auth/email') return json(stub.send?.body ?? { sent: true }, stub.send?.status ?? 200);
    if (pathname === '/console/auth/email/redeem') {
      if (stub.redeem === 'silent') return json({ error: 'unavailable' }, 503);

      return stub.redeem === 'opens'
        ? json({ account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana' } })
        : json({ error: 'invalid-link' }, 401);
    }

    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });

  return asked;
}

const STATES = ['sign-in', 'sent', 'link-opened', 'expired'] as const;
type State = (typeof STATES)[number];
const TITLES: Record<State, string> = {
  'sign-in': 'Sign in to Fruitback',
  sent: INBOX,
  'link-opened': 'You are signed in',
  expired: 'This link no longer works',
};

/** Brings the page to a state of screen 02, with the worker answered by stubs. */
async function show(page: Page, state: State): Promise<void> {
  await stubWorker(page, { redeem: state === 'link-opened' ? 'opens' : 'refuses' });
  if (state === 'link-opened') {
    // A tab that waits, in the same browser: it says that it carried on.
    const other = await page.context().newPage();
    await other.goto(`${CONSOLE}/sign-in`);
    await other.evaluate(() => {
      const channel = new BroadcastChannel('fruitback:sign-in');
      channel.onmessage = (event) => {
        if (event.data !== 'signed-in') return;
        channel.postMessage('heard');
        channel.postMessage('carried-on');
      };
      (window as { kept?: unknown }).kept = channel;
    });
  }
  await page.goto(`${CONSOLE}/sign-in${state === 'link-opened' || state === 'expired' ? '#a-code' : ''}`);
  if (state === 'sent') {
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
  }
  await expect(page.getByRole('heading', { name: TITLES[state], level: 1 })).toBeVisible();
  await page.mouse.move(0, 0);
}

type Box = { x: number; y: number; width: number; height: number };

/** The box of an element, to a tenth of a pixel. */
async function boxOf(locator: Locator): Promise<Box> {
  const box = (await locator.first().boundingBox()) as Box;
  const round = (value: number) => Math.round(value * 10) / 10;

  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

/**
 * The mockup is measured in the system font of macOS: a line of text with no line height of its own
 * is 1 or 2 px taller in the system font of Linux, which the CI draws, and a word is not as wide.
 * So the boxes are compared where the font is the mockup's. Everything else is measured everywhere.
 */
const FONT_OF_THE_MOCKUP = process.platform === 'darwin';

/** Each side of `built` is within `tolerance` pixels of the mockup's. */
function expectNear(built: Box, mockup: Box, name: string, tolerance: number): void {
  if (!FONT_OF_THE_MOCKUP) return;
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    expect
      .soft(Math.abs(built[side] - mockup[side]), `${name}: ${side} is ${built[side]}, the mockup has ${mockup[side]}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

test.describe('the four states of the sign-in page, against the mockup (FRU-235)', () => {
  // The boxes of the mockup at 1440 × 900, read in its `measures.json`. Tolerance: 2 px.
  test('at 1440 px, the main elements are where the mockup has them', async ({ page }) => {
    const header = { x: 0, y: 0, width: 1440, height: 65 };
    const logo = { x: 80, y: 21, width: 113, height: 22 };
    const title = { x: 520, y: 155, width: 400, height: 32.2 };

    await show(page, 'sign-in');
    expectNear(await boxOf(page.locator('header')), header, 'header', 2);
    expectNear(await boxOf(page.getByRole('img', { name: 'Fruitback' })), logo, 'logo', 2);
    expectNear(await boxOf(page.getByRole('heading', { level: 1 })), title, 'title', 2);
    expectNear(
      await boxOf(page.getByRole('textbox', { name: 'Work email' })),
      { x: 520, y: 269, width: 400, height: 44 },
      'field',
      2,
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Email me a link' })),
      { x: 520, y: 327, width: 400, height: 44 },
      'main button',
      2,
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Continue with Google' })),
      { x: 520, y: 431, width: 400, height: 44 },
      'Google',
      2,
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Continue with GitHub' })),
      { x: 520, y: 485, width: 400, height: 44 },
      'GitHub',
      2,
    );
    expectNear(
      await boxOf(page.getByRole('link', { name: 'Set up a workspace' })),
      { x: 641, y: 561, width: 131.6, height: 17 },
      'link to the setup',
      2,
    );
    await expect(page.getByRole('link', { name: 'Set up a workspace' })).toHaveAttribute('href', '/setup');
    await expect(page.getByRole('link', { name: 'Fruitback' })).toHaveAttribute('href', 'https://fruitback.com');
    await expect(page).toHaveTitle('Sign in to Fruitback');
    // The main button is not dimmed for an empty field: the mockup draws it in full.
    await expect(page.getByRole('button', { name: 'Email me a link' })).toBeEnabled();

    await show(page, 'expired');
    expectNear(await boxOf(page.getByRole('heading', { level: 1 })), title, 'title, expired', 2);
    expectNear(
      await boxOf(page.getByRole('textbox', { name: 'Work email' })),
      { x: 520, y: 293, width: 400, height: 44 },
      'field, expired',
      2,
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Send me a new link' })),
      { x: 520, y: 351, width: 400, height: 44 },
      'main button, expired',
      2,
    );
  });

  test('at 1440 px, « Check your inbox » and « You are signed in » are where the mockup has them', async ({
    page,
    context,
  }) => {
    // The clock stands still, so the button reads « Send again in 1:00 » while it is measured. The
    // mockup reads « 0:41 », which is as wide: the digits of the system font have one width.
    await page.clock.install();
    await show(page, 'sent');
    expectNear(
      await boxOf(page.getByRole('heading', { level: 1 })),
      { x: 520, y: 155, width: 400, height: 32.2 },
      'title',
      2,
    );
    expectNear(await boxOf(page.getByRole('status')), { x: 520, y: 195, width: 400, height: 24 }, 'confirmation', 2);
    const again = page.getByRole('button', { name: /^Send again in / });
    expectNear(await boxOf(again), { x: 520, y: 300, width: 157.5, height: 44 }, '« Send again »', 2);
    await expect(again).toBeDisabled();
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Use another address' })),
      { x: 697, y: 302, width: 139.9, height: 41 },
      '« Use another address »',
      2,
    );

    const tab = await context.newPage();
    await show(tab, 'link-opened');
    expectNear(await boxOf(tab.locator('.kit-success')), { x: 524, y: 155, width: 40, height: 40 }, 'success mark', 2);
    expectNear(
      await boxOf(tab.getByRole('heading', { level: 1 })),
      { x: 520, y: 219, width: 400, height: 32.2 },
      'title, signed in',
      2,
    );
    expectNear(
      await boxOf(tab.getByRole('status')),
      { x: 520, y: 259, width: 400, height: 48 },
      'confirmation, signed in',
      2,
    );
    // The mockup's link is 46 px high: an `<a>` of 44 px with its border outside. Here it is the
    // 44 px of every control.
    expectNear(
      await boxOf(tab.getByRole('link', { name: 'Continue in this tab' })),
      { x: 520, y: 335, width: 169.1, height: 46 },
      '« Continue in this tab »',
      2,
    );
  });

  test('« Send again » counts a minute down, then sends a second link', async ({ page }) => {
    await page.clock.install();
    const asked = await stubWorker(page);
    await page.goto(`${CONSOLE}/sign-in`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByRole('button', { name: 'Send again in 1:00' })).toBeDisabled();

    await page.clock.runFor(19_000);
    await expect(page.getByRole('button', { name: 'Send again in 0:41' })).toBeDisabled();
    await page.clock.runFor(41_000);
    const again = page.getByRole('button', { name: 'Send again', exact: true });
    await expect(again).toBeEnabled();

    await again.click();
    await expect(page.getByRole('button', { name: 'Send again in 1:00' })).toBeDisabled();
    expect(asked.filter((each) => each === 'POST /console/auth/email')).toHaveLength(2);
  });

  test('the ceiling of the worker has its sentence under « Send again »', async ({ page }) => {
    await page.clock.install();
    await stubWorker(page);
    await page.goto(`${CONSOLE}/sign-in`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByRole('button', { name: 'Send again in 1:00' })).toBeDisabled();
    await page.clock.runFor(60_000);
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    await stubWorker(page, { send: { status: 429, body: { error: 'too-many-links' } } });

    await page.getByRole('button', { name: 'Send again', exact: true }).click();

    await expect(page.getByRole('alert')).toHaveText(
      'Several links went to this address already. Use the last one, or wait fifteen minutes.',
    );
    // The screen stays, with the address it was sent to.
    await expect(page.getByRole('status')).toContainText('ana@acme.dev');
  });

  for (const state of STATES) {
    test(`« ${TITLES[state]} » fits a phone, and axe finds nothing in it`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await show(page, state);

      // From the CSS of the mockup at 390 × 844: the header of 65 px, then 10vh, and 16 px at each
      // side. The success mark and its space are 64 px more above the title of « You are signed in ».
      const top = state === 'link-opened' ? 213.4 : 149.4;
      expectNear(
        await boxOf(page.getByRole('heading', { level: 1 })),
        { x: 16, y: top, width: 358, height: 32.2 },
        'title',
        4,
      );
      expectNear(
        await boxOf(page.getByRole('img', { name: 'Fruitback' })),
        { x: 16, y: 21, width: 113, height: 22 },
        'logo',
        4,
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.setViewportSize({ width: 320, height: 700 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual(
        [],
      );
      // One title, and the confirmation of a state that confirms something is said.
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      if (state === 'sent' || state === 'link-opened') await expect(page.getByRole('status')).toHaveCount(1);
    });
  }

  test('the page is in French for a French browser, and fits a phone there too', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await stubWorker(page);
    await page.goto(`${CONSOLE}/sign-in`);

    await expect(page.getByRole('heading', { name: 'Connectez-vous à Fruitback' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recevoir un lien par e-mail' })).toBeVisible();
    await expect(page).toHaveTitle('Connectez-vous à Fruitback');
    await page.getByRole('textbox', { name: 'E-mail professionnel' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Recevoir un lien par e-mail' }).click();
    await expect(page.getByRole('status')).toHaveText('Un lien de connexion est en route vers ana@acme.dev.');
    await expect(page.getByRole('button', { name: /^Renvoyer dans / })).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
    await context.close();
  });

  for (const locale of ['en', 'fr'] as const) {
    test(`the buttons of Google and GitHub carry their marks, drawn inline, in ${locale} at 390 px (FRU-362)`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        locale: locale === 'en' ? 'en-US' : 'fr-FR',
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      const outside: string[] = [];
      page.on('request', (request) => {
        const { origin } = new URL(request.url());
        if (origin !== CONSOLE && origin !== WORKER_ORIGIN) outside.push(request.url());
      });
      await stubWorker(page);
      await page.goto(`${CONSOLE}/sign-in`);
      const names =
        locale === 'en'
          ? { google: 'Continue with Google', github: 'Continue with GitHub' }
          : { google: 'Continuer avec Google', github: 'Continuer avec GitHub' };
      for (const [provider, name] of Object.entries(names)) {
        // The words are the whole name of the button: the mark is hidden from a screen reader.
        const button = page.getByRole('button', { name, exact: true });
        await expect(button).toBeVisible();
        const mark = button.locator('svg');
        await expect(mark).toHaveCount(1);
        await expect(mark).toHaveAttribute('aria-hidden', 'true');
        await expect(mark).toHaveAttribute('focusable', 'false');
        // 18 px, before the words, on their line.
        const box = (await mark.boundingBox())!;
        // The left edge of the words themselves, read on their text.
        const wordsX = await button.evaluate((element) => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const range = document.createRange();
          range.selectNodeContents(walker.nextNode()!);

          return range.getBoundingClientRect().x;
        });
        expect.soft(box.width, `${provider}: width`).toBe(18);
        expect.soft(box.height, `${provider}: height`).toBe(18);
        expect.soft(box.x + box.width, `${provider}: before the words`).toBeLessThanOrEqual(wordsX);
        const fills = await mark
          .locator('path')
          .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).fill));
        if (provider === 'google') {
          // The four colours of Google's guidelines, unchanged.
          expect(fills).toEqual(['rgb(234, 67, 53)', 'rgb(66, 133, 244)', 'rgb(251, 188, 5)', 'rgb(52, 168, 83)']);
        } else {
          // One colour: the colour of the words.
          expect(fills).toEqual([await button.evaluate((element) => getComputedStyle(element).color)]);
        }
      }
      // Drawn inline: nothing was asked of a third party.
      expect(outside).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);
      await context.close();
    });
  }

  test('a provider the worker does not offer has no button, and a worker that offers nothing has no form', async ({
    page,
  }) => {
    await stubWorker(page, { providers: { betterAuth: { email: true, github: false, google: true } } });
    await page.goto(`${CONSOLE}/sign-in`);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);

    // No provider at all: no button, and no « or » that would lead to nothing.
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    await stubWorker(page, { providers: { betterAuth: { email: true, github: false, google: false } } });
    await page.goto(`${CONSOLE}/sign-in`);
    await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Continue with/ })).toHaveCount(0);
    await expect(page.locator('.kit-divider')).toHaveCount(0);

    // A worker that signs nobody in (FRU-217): the sentence, and nothing to type in.
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    const asked = await stubWorker(page, { providers: {} });
    await page.goto(`${CONSOLE}/sign-in`);
    await expect(page.getByRole('alert')).toContainText('Nobody can sign in to this Fruitback yet');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    expect(asked.filter((each) => each.startsWith('POST'))).toEqual([]);
  });

  test('a link the worker did not answer for can be tried again, and is not spent', async ({ page }) => {
    const asked = await stubWorker(page, { redeem: 'silent' });
    await page.goto(`${CONSOLE}/sign-in#a-code`);

    await expect(page.getByRole('heading', { name: 'You are not signed in yet' })).toBeVisible();
    await expect(page.getByText('Fruitback hit an error. Your link still works.')).toBeVisible();
    expect(page.url()).toBe(`${CONSOLE}/sign-in`);
    const before = asked.filter((each) => each === 'POST /console/auth/email/redeem').length;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => asked.filter((each) => each === 'POST /console/auth/email/redeem').length).toBe(before + 1);
  });

  test('a code that a provider sent back has its sentence on the sign-in page', async ({ page }) => {
    await stubWorker(page);
    await page.goto(`${CONSOLE}/sign-in?error=access_denied`);

    await expect(page.getByRole('alert')).toHaveText('The access was declined. Try again, or use an email link.');
  });
});

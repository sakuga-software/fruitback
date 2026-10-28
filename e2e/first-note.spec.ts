import fs from 'node:fs';
import { type Page, expect } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { PLAYGROUND_ORIGIN, openPopup, test } from './extension.ts';
import { badgeFor } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

test.use({ keepWelcome: true });

/**
 * The whole way of a first user (FRU-481): from `/setup` to the first note on the site, in the real
 * console, the real popup and the real widget, against one worker of the Cloud.
 *
 * Each action of the person is written down with the place it happens. The steps that only Chrome
 * draws (the store, the pin, the prompt for the access to a site) cannot be driven: they are written
 * down as `chrome`, and counted, not done.
 */

type Place = 'console' | 'mail' | 'store' | 'chrome' | 'welcome' | 'popup' | 'site' | 'tab';
type Action = { place: Place; what: string };

let worker: Worker | undefined;

/** The rows of the table « What was measured » of `docs/decisions/onboarding.md`, in their order. */
function measuredInThePage(): Action[] {
  const page = fs.readFileSync('docs/decisions/onboarding.md', 'utf8');
  const rows = page
    .split('\n')
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  // A control: the reading found the table from its first row, so an equal list is a result.
  expect(rows[0]?.[2], 'the first row read from the page').toBe('open fruitback.com, then « Set up »');
  for (const row of rows) expect(row, 'a row of the table: #, place, action, becomes').toHaveLength(4);

  return rows.map(([, place, what]) => ({ place: place as Place, what: what ?? '' }));
}

test.afterEach(async ({ extension }) => finished(extension.context, worker));

test('a first user goes from the setup to a first note (FRU-481)', async ({ extension }) => {
  // In the test: a retry starts from an empty list.
  const actions: Action[] = [];
  const did = (place: Place, what: string): void => void actions.push({ place, what });
  test.setTimeout(120_000);
  worker = await cloudWorker();
  const { context } = extension;
  await served(context, worker);
  // The extension of the build speaks to the second worker of the suite: here, to this one.
  const cloud = worker.origin;
  await context.route(`${AUTHENTICATED_WORKER_ORIGIN}/**`, async (route) => {
    const asked = new URL(route.request().url());
    const response = await route.fetch({ url: `${cloud}${asked.pathname}${asked.search}`, maxRedirects: 0 });
    await route.fulfill({ response });
  });

  const setup = await context.newPage();
  await setup.goto(`${CONSOLE}/setup`);
  did('console', 'open fruitback.com, then « Set up »');
  await setup.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
  did('console', 'type the e-mail address');
  await setup.getByRole('button', { name: 'Email me a link' }).click();
  did('console', 'click « Email me a link »');
  await expect.poll(async () => (await worker!.sent()).length).toBe(1);

  did('mail', 'open the mailbox, then the message');
  const link = await context.newPage();
  await link.goto(await linkIn(worker));
  did('mail', 'click the link: a new tab opens');
  await expect(link.getByRole('heading', { name: 'You are signed in' })).toBeVisible({ timeout: 15_000 });
  await setup.screenshot({ path: test.info().outputPath('01-setup-after-link.png') });
  await link.screenshot({ path: test.info().outputPath('02-link-tab.png') });

  // The setup goes on in its first tab, and the tab of the link says to close it: step 6 of
  // `docs/decisions/onboarding.md`. A change here changes that page.
  const siteField = (page: Page) => page.getByRole('textbox', { name: 'Site address' });
  await expect(siteField(setup)).toBeVisible({ timeout: 15_000 });
  await expect(link.getByText(/You can close this one/)).toBeVisible();
  await expect(siteField(link)).toHaveCount(0);
  did('tab', 'go back to the tab of the setup');
  const goesOn = setup;

  await siteField(goesOn).fill(PLAYGROUND_ORIGIN);
  did('console', 'type the address of the site');
  await goesOn.getByRole('button', { name: 'Add site' }).click();
  did('console', 'click « Add site »');
  await expect(goesOn.getByRole('heading', { name: /Put it on the site/ })).toBeVisible();
  await goesOn.screenshot({ path: test.info().outputPath('03-step-3.png'), fullPage: true });

  const card = goesOn
    .locator('.kit-option')
    .filter({ has: goesOn.getByRole('heading', { name: 'Browser extension' }) });
  // The store is Chrome's: its tab opens, and goes no further here.
  await context.route('https://chromewebstore.google.com/**', (route) => route.abort());
  const storeOpens = context.waitForEvent('page');
  await card.getByRole('link', { name: 'Install the extension (beta)' }).click();
  did('console', 'click « Install the extension (beta) »: the store opens in a tab');
  await (await storeOpens).close();
  did('store', 'click « Add to Chrome »');
  did('chrome', 'click « Add extension » in the dialog of Chrome');

  // The install opens the welcome page.
  const welcomeUrl = `chrome-extension://${extension.id}/welcome.html`;
  const welcome = context.pages().find((page) => page.url() === welcomeUrl);
  expect(welcome, 'the welcome page').toBeDefined();
  await welcome!.screenshot({ path: test.info().outputPath('04-welcome.png') });
  // Pinning Fruitback is a tip of the page, and no step of this path needs it (FRU-484).

  // The popup on the welcome page, a page that is not a site, offers the sign-in too (FRU-482).
  const onWelcome = await openPopup(extension, welcome!);
  await expect(onWelcome.getByRole('button', { name: 'Sign in with email' })).toHaveCount(1);
  await onWelcome.close();

  // The welcome page signs in itself: the console opens in a tab, and the word is the same in both.
  await welcome!.bringToFront();
  const connectOpens = context.waitForEvent('page', { predicate: (page) => page.url().includes('/connect') });
  await welcome!.getByRole('button', { name: 'Sign in with email' }).click();
  did('welcome', 'click « Sign in with email »: the console opens in a tab');
  const connect = await connectOpens;
  const word = (await welcome!.locator('.word').innerText()).trim();
  await expect(connect.getByText(word, { exact: true })).toBeVisible({ timeout: 15_000 });
  await welcome!.screenshot({ path: test.info().outputPath('05-welcome-word.png') });
  await connect.screenshot({ path: test.info().outputPath('06-connect.png') });
  const approve = connect.getByRole('button', { name: /^Connect/ });
  const approveName = (await approve.innerText()).trim();
  await approve.click();
  did('console', `click « ${approveName} » after the word`);

  // The welcome page claims the session, closes the tab of the console, and says who signed in.
  await expect(welcome!.getByRole('status')).toHaveText('Signed in as ana@acme.dev.', { timeout: 20_000 });
  await expect.poll(() => connect.isClosed()).toBe(true);
  await welcome!.screenshot({ path: test.info().outputPath('07-welcome-signed-in.png') });

  // The welcome page offers the one site of the workspace: « Turn on » asks Chrome, then opens it.
  const turnOn = welcome!.getByRole('button', { name: 'Turn on localhost:5177' });
  await expect(turnOn).toBeVisible({ timeout: 15_000 });
  await welcome!.screenshot({ path: test.info().outputPath('08-welcome-turn-on.png') });
  const siteOpens = context.waitForEvent('page');
  await turnOn.click();
  did('welcome', 'click « Turn on <site> »: the site opens in a tab');
  did('chrome', 'click « Allow » in the prompt of Chrome for the access to the site');
  const site = await siteOpens;
  await site.waitForLoadState();
  expect(new URL(site.url()).origin).toBe(PLAYGROUND_ORIGIN);
  // The playground mounts a widget of its own: `widget=off` keeps only the one of the extension.
  await site.goto(`${PLAYGROUND_ORIGIN}/?widget=off`);
  await expect(site.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  // The welcome page says the site is on now, and offers to open it.
  await expect(welcome!.getByRole('button', { name: 'Open localhost:5177' })).toBeVisible();

  // The widget of the extension appears on the site.
  await site.bringToFront();
  const leave = site.getByRole('button', { name: 'Leave feedback' });
  await expect(leave).toBeVisible({ timeout: 20_000 });
  await site.screenshot({ path: test.info().outputPath('09-site-on.png') });
  await leave.click();
  did('site', 'click « Leave feedback »');
  await site.locator('[data-testid="card-espresso"] .add').click();
  did('site', 'click the element of the page');
  const note = `First note ${Date.now()}: the price is hard to read.`;
  await site.getByPlaceholder('What should change?').fill(note);
  did('site', 'type the note');
  await site.getByRole('button', { name: 'Send', exact: true }).click();
  did('site', 'click « Send »');
  await expect(site.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 15_000 });
  await site.screenshot({ path: test.info().outputPath('10-sent.png') });

  // The worker keeps the note: the site, loaded again, reads it from the worker and draws its pin.
  await site.reload();
  await expect(badgeFor(site, note)).toBeVisible({ timeout: 20_000 });

  fs.writeFileSync(test.info().outputPath('actions.json'), JSON.stringify(actions, null, 2));
  // The table of the page is this list: a change to the path changes both in one pull request.
  expect(actions).toEqual(measuredInThePage());
  console.log(actions.map((action, index) => `${index + 1}. [${action.place}] ${action.what}`).join('\n'));
});

import fs from 'node:fs';
import { type Page, expect } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { PLAYGROUND_ORIGIN, openPopup, test } from './extension.ts';
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

const actions: Action[] = [];
const did = (place: Place, what: string): void => void actions.push({ place, what });

let worker: Worker | undefined;

test.afterEach(async ({ extension }) => finished(extension.context, worker));

test('a first user goes from the setup to a first note (FRU-481)', async ({ extension }) => {
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
  await setup.screenshot({ path: test.info().outputPath('01-setup-after-link.png') });
  await link.screenshot({ path: test.info().outputPath('02-link-tab.png') });

  // Where does the setup go on: in the tab of the link, or in the first tab?
  const siteField = (page: Page) => page.getByRole('textbox', { name: 'Site address' });
  await expect
    .poll(async () => (await siteField(setup).isVisible()) || (await siteField(link).isVisible()), { timeout: 15_000 })
    .toBe(true);
  const goesOn = (await siteField(setup).isVisible()) ? setup : link;
  if (goesOn === setup) {
    did('tab', 'go back to the tab of the setup');
  }
  test.info().annotations.push({ type: 'setup goes on in', description: goesOn === setup ? 'first tab' : 'link tab' });

  await siteField(goesOn).fill(PLAYGROUND_ORIGIN);
  did('console', 'type the address of the site');
  await goesOn.getByRole('button', { name: 'Add site' }).click();
  did('console', 'click « Add site »');
  await expect(goesOn.getByRole('heading', { name: /Put it on the site/ })).toBeVisible();
  await goesOn.screenshot({ path: test.info().outputPath('03-step-3.png'), fullPage: true });

  const card = goesOn
    .locator('.kit-option')
    .filter({ has: goesOn.getByRole('heading', { name: 'Browser extension' }) });
  await expect(card.getByRole('link', { name: 'Install the extension (beta)' })).toBeVisible();
  did('console', 'click « Install the extension (beta) »: the Chrome Web Store opens in a tab');
  did('store', 'click « Add to Chrome »');
  did('chrome', 'click « Add extension » in the dialog of Chrome');

  // The install opens the welcome page.
  const welcomeUrl = `chrome-extension://${extension.id}/welcome.html`;
  const welcome = context.pages().find((page) => page.url() === welcomeUrl);
  expect(welcome, 'the welcome page').toBeDefined();
  await welcome!.screenshot({ path: test.info().outputPath('04-welcome.png') });
  did('chrome', 'open the puzzle menu of the toolbar');
  did('chrome', 'click the pin beside Fruitback');

  // The welcome page says: click the icon, then « Sign in with email ». On that page, the popup says
  // only that Fruitback works on web pages.
  did('popup', 'click the Fruitback icon, as the welcome page says');
  const onWelcome = await openPopup(extension, welcome!);
  await onWelcome.screenshot({ path: test.info().outputPath('05-popup-on-welcome.png') });
  const deadEnd = await onWelcome.getByRole('button', { name: 'Sign in with email' }).count();
  test.info().annotations.push({ type: 'sign-in offered on the welcome page', description: String(deadEnd) });
  await onWelcome.close();

  // To the site, by the link of the setup.
  did('tab', 'go back to the tab of the setup');
  await goesOn.bringToFront();
  const siteOpens = context.waitForEvent('page');
  await goesOn.getByRole('link', { name: /^Open .*localhost:5177$/ }).click();
  did('console', `click « Open ${new URL(PLAYGROUND_ORIGIN).host} »: the site opens in a tab`);
  const site = await siteOpens;
  // The playground mounts a widget of its own: `widget=off` keeps only the one of the extension.
  await site.goto(`${PLAYGROUND_ORIGIN}/?widget=off`);
  await expect(site.getByRole('heading', { name: 'Nos formules' })).toBeVisible();

  did('popup', 'click the Fruitback icon');
  const popup = await openPopup(extension, site);
  await popup.screenshot({ path: test.info().outputPath('05-popup-signed-out.png') });
  const connectOpens = context.waitForEvent('page', { predicate: (page) => page.url().includes('/connect') });
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  did('popup', 'click « Sign in with email »: the console opens in a tab');
  const connect = await connectOpens;
  await connect.waitForLoadState();
  await connect.screenshot({ path: test.info().outputPath('06-connect.png') });
  const approve = connect.getByRole('button', { name: /^Connect/ });
  await expect(approve).toBeVisible({ timeout: 15_000 });
  const approveName = (await approve.innerText()).trim();
  await approve.click();
  did('console', `click « ${approveName} » after the word`);
  await connect.screenshot({ path: test.info().outputPath('07-connected.png') });

  did('tab', 'go back to the tab of the site');
  did('popup', 'click the Fruitback icon');
  const onSite = await openPopup(extension, site);
  await onSite.screenshot({ path: test.info().outputPath('08-popup-on-site.png') });
  const turnOn = onSite.getByRole('button', { name: /^Turn on/ });
  await expect(turnOn).toBeVisible({ timeout: 15_000 });
  await turnOn.click();
  did('popup', 'click « Turn on »');
  did('chrome', 'click « Allow » in the prompt of Chrome for the access to the site');

  // The widget of the extension appears on the site.
  await site.bringToFront();
  const leave = site.getByRole('button', { name: 'Leave feedback' });
  await expect(leave).toBeVisible({ timeout: 20_000 });
  await site.screenshot({ path: test.info().outputPath('09-site-on.png') });
  await leave.click();
  did('site', 'click « Leave feedback »');
  await site.locator('[data-testid="card-espresso"] .add').click();
  did('site', 'click the element of the page');
  await site.getByPlaceholder('What should change?').fill('The price is hard to read.');
  did('site', 'type the note');
  await site.getByRole('button', { name: 'Send', exact: true }).click();
  did('site', 'click « Send »');
  await expect(site.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 15_000 });
  await site.screenshot({ path: test.info().outputPath('10-sent.png') });

  fs.writeFileSync(test.info().outputPath('actions.json'), JSON.stringify(actions, null, 2));
  console.log(actions.map((action, index) => `${index + 1}. [${action.place}] ${action.what}`).join('\n'));
  console.log(
    test
      .info()
      .annotations.map((note) => `${note.type}: ${note.description}`)
      .join('\n'),
  );
});

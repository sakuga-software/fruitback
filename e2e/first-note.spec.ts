import fs from 'node:fs';
import { type Page, expect } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { BUILT_EXTENSION, PLAYGROUND_ORIGIN, openPopup, test } from './extension.ts';
import { demoBox, demoFrame, framesNow, recordDemo, showPointer } from './demo.ts';
import { capture, capturesNow, recordCaptures } from './guide.ts';
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
 *
 * The same walk takes the captures of the guide (FRU-486, `guide.ts`): each control that a step of
 * the guide names is checked on its page, then the part of the page it shows is captured. What
 * varies from a run to the next (the word, the id of the site) is replaced on the page before a
 * capture, so a capture changes only when a screen does.
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
  const before = capturesNow();
  const framesBefore = framesNow();
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
  // The card of the script tag, for `docs/install.md`. The id of the site is new at each run, and the
  // addresses are the ones of the test: the capture shows those of Fruitback Cloud.
  const scriptCard = goesOn.locator('.kit-option').filter({ has: goesOn.getByRole('heading', { name: 'Script tag' }) });
  await scriptCard.getByRole('region', { name: 'Script tag' }).evaluate((snippet) => {
    const [only] = snippet.childNodes;
    if (snippet.childNodes.length !== 1 || only?.nodeType !== Node.TEXT_NODE)
      throw new Error('the script is not one text');
    only.nodeValue = (only.nodeValue ?? '')
      .replaceAll(/site_[\w-]+/g, 'site_8f3k2m')
      .replaceAll('http://localhost:5178', 'https://app.fruitback.com')
      .replaceAll('http://localhost:8788', 'https://api.fruitback.com');
  });
  await capture(goesOn, 'script', [scriptCard], 12);
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
  await capture(welcome!, 'welcome', [welcome!.locator('main.welcome')]);
  // Pinning Fruitback is a tip of the page, and no step of this path needs it (FRU-484).

  // The popup on the welcome page, a page that is not a site, offers the sign-in too (FRU-482).
  const onWelcome = await openPopup(extension, welcome!);
  await expect(onWelcome.getByRole('button', { name: 'Sign in with email' })).toHaveCount(1);
  await capture(onWelcome, 'popup-sign-in', [onWelcome.locator('.popup')], 0);
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
  // The word is drawn at random: the capture shows the same one at each run. The value of React's
  // own text node changes, and no node is replaced: a later render of React finds the node it made.
  await connect.getByText(word, { exact: true }).evaluate((shown) => {
    const [only] = shown.childNodes;
    if (shown.childNodes.length !== 1 || only?.nodeType !== Node.TEXT_NODE) throw new Error('the word is not one text');
    only.nodeValue = 'PLUM 42';
  });
  await capture(connect, 'word', [
    connect.getByRole('heading', { name: 'Connect this browser' }),
    connect.getByText('PLUM 42', { exact: true }),
    connect
      .getByRole('button', { name: 'Use another address' })
      .or(connect.getByRole('link', { name: 'Use another address' })),
  ]);
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
  await capture(welcome!, 'turn-on', [welcome!.locator('main.welcome')]);
  // The playground mounts a widget of its own unless its address says `widget=off`. Its root, as
  // the welcome page opens it, says so before the page reads it: only the widget of the extension
  // is left, and the choice it opens stays open (a reload would close it).
  await context.addInitScript((origin) => {
    if (location.origin === origin && location.pathname === '/' && location.search === '') {
      history.replaceState(null, '', '/?widget=off');
    }
  }, PLAYGROUND_ORIGIN);
  const siteOpens = context.waitForEvent('page');
  await turnOn.click();
  did('welcome', 'click « Turn on <site> »: the site opens in a tab');
  did('chrome', 'click « Allow » in the prompt of Chrome for the access to the site');
  const site = await siteOpens;
  await expect(site.getByRole('heading', { name: 'Nos formules' })).toBeVisible({ timeout: 15_000 });
  expect(new URL(site.url()).origin).toBe(PLAYGROUND_ORIGIN);
  // The welcome page says the site is on now, and offers to open it.
  await expect(welcome!.getByRole('button', { name: 'Open localhost:5177' })).toBeVisible();

  // The first activation opens the choice of an element (FRU-485): no « Leave a note » to press.
  await site.bringToFront();
  await expect(site.locator('[data-fruitback-host]')).toHaveAttribute('data-fruitback-capturing', '', {
    timeout: 20_000,
  });
  await site.screenshot({ path: test.info().outputPath('09-site-on.png') });
  // The video of the welcome page (FRU-531): a frame at each step from here to the pin, all in one
  // box of 16/9 around the element, with a pointer drawn where the person points.
  const element = site.locator('[data-testid="card-espresso"] .add');
  const where = await element.boundingBox();
  if (where === null) throw new Error('the element of the note is not on the page');
  const pointAt = { x: Math.round(where.x + where.width / 2), y: Math.round(where.y + where.height / 2) };
  // From above the title of the cards, tall enough for the composer under the element and its « Send ».
  const heading = await site.getByRole('heading', { name: 'Nos formules' }).boundingBox();
  const box = demoBox(site, { x: pointAt.x + 200, top: (heading?.y ?? where.y - 100) - 32 }, 1280);
  await showPointer(site, { x: box.x + 120, y: box.y + box.height - 120 });
  await demoFrame(site, '01-site', box);
  await element.hover();
  await showPointer(site, pointAt);
  await demoFrame(site, '02-pick', box);
  await element.click();
  did('site', 'click the element of the page');
  const composer = site.getByRole('dialog', { name: 'New note' });
  await expect(composer).toBeVisible();
  await settled(site);
  await demoFrame(site, '03-composer', box);
  // The worker of this test is its own: the text needs no mark of the run.
  const note = 'The price is hard to read.';
  const field = site.getByPlaceholder('What should change?');
  for (const [frame, typed] of [
    ['04-typing-1', 'The price'],
    ['05-typing-2', 'The price is hard'],
    ['06-typing-3', 'The price is hard to'],
  ] as const) {
    await field.fill(typed);
    await demoFrame(site, frame, box);
  }
  await field.fill(note);
  did('site', 'type the note');
  // The capture of the guide shows no pointer.
  await showPointer(site, undefined);
  await capture(site, 'note', [site.locator('[data-testid="card-espresso"]'), composer]);
  const send = site.getByRole('button', { name: 'Send', exact: true });
  const sendAt = await send.boundingBox();
  if (sendAt !== null) {
    await showPointer(site, {
      x: Math.round(sendAt.x + sendAt.width / 2),
      y: Math.round(sendAt.y + sendAt.height / 2),
    });
  }
  await demoFrame(site, '07-written', box);
  await send.click();
  did('site', 'click « Send »');
  await expect(composer).toBeHidden({ timeout: 15_000 });
  await site.screenshot({ path: test.info().outputPath('10-sent.png') });

  // The worker keeps the note: the site, loaded again, reads it from the worker and draws its pin.
  await site.reload();
  await expect(badgeFor(site, note)).toBeVisible({ timeout: 20_000 });
  // The pin of the note, then its preview under the pointer.
  await site.mouse.move(0, 0);
  await settled(site);
  await demoFrame(site, '08-sent', box);
  const pin = badgeFor(site, note);
  await pin.hover();
  const pinAt = await pin.boundingBox();
  if (pinAt !== null) {
    await showPointer(site, { x: Math.round(pinAt.x + pinAt.width / 2), y: Math.round(pinAt.y + pinAt.height / 2) });
  }
  await settled(site);
  await demoFrame(site, '09-pin', box);
  // A second load does not open the choice again: it opens at the first activation only.
  await expect(site.getByRole('button', { name: 'Leave a note' })).toBeVisible();
  await expect(site.locator('[data-fruitback-host]')).not.toHaveAttribute('data-fruitback-capturing');

  // The popup on the site that is on, for the last step of the guide: after the path, which it is not part of.
  const popup = await openPopup(extension, site);
  await capture(popup, 'popup', [popup.locator('.popup')], 0);
  await popup.close();
  const manifest = JSON.parse(fs.readFileSync(`${BUILT_EXTENSION}/manifest.json`, 'utf8')) as { version: string };
  const changed = recordCaptures(before, manifest.version);
  if (changed.length > 0) console.log(`The captures of the guide that changed: ${changed.join(', ')}`);
  const video = recordDemo(framesBefore);
  if (video.length > 0) console.log(`The video of the welcome page, written again: ${video.join(', ')}`);

  fs.writeFileSync(test.info().outputPath('actions.json'), JSON.stringify(actions, null, 2));
  // The table of the page is this list: a change to the path changes both in one pull request.
  expect(actions).toEqual(measuredInThePage());
  console.log(actions.map((action, index) => `${index + 1}. [${action.place}] ${action.what}`).join('\n'));
});

/**
 * Waits for the motions of the page to end: a frame taken in the middle of one differs at each run.
 * An animation with no end, such as a spinner, is not waited for.
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

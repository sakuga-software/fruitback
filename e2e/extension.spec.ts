import fs from 'node:fs';
import path from 'node:path';
import { type Page, expect, test as withoutExtension } from '@playwright/test';
import {
  BUILT_EXTENSION,
  addRule,
  mintPairing,
  mintPairingCode,
  openBareSite,
  openPopup,
  pairFromPopup,
  readSeeds,
  readableByThePage,
  recordPageMessages,
  seedsOn,
  storedTokens,
  test,
  type StoredToken,
} from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The extension across its worlds (FRU-45): what a site gets with it, without it, and what its page
 * can never read.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const REVIEWER = 'E2E Reviewer';

/** The requests a page sends to either worker, counted from the moment this is called. */
function workerCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (request) => {
    if ([WORKER_ORIGIN, AUTHENTICATED_WORKER_ORIGIN].some((origin) => request.url().startsWith(origin))) {
      calls.push(request.url());
    }
  });

  return calls;
}

/**
 * Enough time for a registered script to run and a widget to mount and read.
 *
 * An absence has no signal to wait for. The specs that expect a widget on the same page show that it
 * arrives well inside this delay.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

async function plantOnTheLatteCard(page: Page, launch: string | RegExp, note: string): Promise<void> {
  await page.getByRole('button', { name: launch }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What is wrong here?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/**
 * The licence a store hands out with the extension (FRU-82).
 *
 * `license.test.ts` reads the configuration that asks for the copy; this reads the build that
 * `pnpm e2e` made, which is what the archive is zipped from. A packaging change that drops the file
 * passes the first and fails this one. Raised in review.
 */
withoutExtension('carries its licence into the build a store is given', async () => {
  const built = fs.readFileSync(path.join(BUILT_EXTENSION, 'LICENSE'), 'utf8');

  expect(built).toEqual(fs.readFileSync('apps/extension/LICENSE', 'utf8'));
});

withoutExtension('without the extension, the site holds no widget and calls no worker', async ({ page }) => {
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-absent');
  await settle(page);

  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => 'fruitbackExtension' in window)).toBe(false);
});

test('an origin with no rule mounts nothing, until a rule covers it', async ({ extension }) => {
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-no-rule');
  await settle(page);

  // The copy holds host access to this origin, so what keeps the page empty is the missing rule.
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => '__fruitbackPageScript' in window || 'fruitbackExtension' in window)).toBe(false);

  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  await page.reload();

  await expect(page.getByRole('button', { name: /Leave feedback/ })).toBeVisible();
});

test('private mode: the mounted widget reads the component, and the pin comes back', async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private');

  await plantOnTheLatteCard(page, /Leave feedback/, 'Planté par le mode privé');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The component name comes from the React fiber, which only the page's own world can see. A widget
  // mounted from the isolated world would store the note with no source.
  const [seed] = await seedsOn(page);
  expect(seed?.note).toBe('Planté par le mode privé');
  expect(seed?.source).toMatchObject({ component: 'Button', file: expect.stringContaining('site.tsx') });

  await page.reload();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

/** What a team-mode site ships: a dormant widget that mounts when the extension announces itself. */
async function mountTheSiteWidget(page: Page, endpoint: string): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    type Mounted = { destroy(): void };
    const scope = globalThis as {
      Fruitback: { init(options: Record<string, unknown>): Mounted };
      fruitbackExtension?: { transport: unknown };
    };
    let widget: Mounted | undefined;
    const follow = (): void => {
      widget?.destroy();
      widget = undefined;
      if (scope.fruitbackExtension === undefined) return;
      widget = scope.Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: 'Team feedback',
        transport: scope.fruitbackExtension.transport,
      });
    };
    // The extension can announce before or after this runs, so the site does both.
    window.addEventListener('fruitback:extension', follow);
    follow();
  }, endpoint);
}

/**
 * Asserts that the page can read no stored token, and no bridge message that names the header.
 *
 * Each document records its own messages, so call it before a reload as well as after it.
 */
async function expectNoCredentialReadable(page: Page, tokens: StoredToken[]): Promise<void> {
  const readable = await readableByThePage(page);
  const { messages, chromeStorage } = JSON.parse(readable) as { messages: string[]; chromeStorage: string };
  expect(messages.join('\n')).toContain('relay-response');
  for (const { value } of tokens) expect(readable).not.toContain(value);
  // Only the messages: the widget script on the page names the header in its own code.
  expect(messages.join('\n')).not.toMatch(/authorization/i);
  expect(chromeStorage).toBe('undefined');
}

test('private mode on a worker that wants a session: the popup says why the page shows no note (FRU-66)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-authenticated');
  // The widget mounts and looks ready. Its reads answer 401, and nothing on the page says so.
  await expect(page.getByRole('button', { name: /Leave feedback/ })).toBeVisible();

  const popup = await openPopup(extension, page);

  await expect(popup.getByText(/answers a signed-in reader only/)).toBeVisible();
  // A session changes nothing in this mode, so the popup offers none (FRU-88). The team spec below
  // pairs through the same field, which is the control for this absence.
  await expect(popup.getByLabel('Pairing code')).toHaveCount(0);
  await expect(popup.getByText(/Not paired/)).toHaveCount(0);
  const shot = test.info().outputPath('popup.png');
  await popup.screenshot({ path: shot });
  await test.info().attach('popup', { path: shot, contentType: 'image/png' });
  await expect(popup.getByRole('link', { name: 'Which mode can read it' })).toHaveAttribute(
    'href',
    'https://sakuga-software.github.io/fruitback/modes.html',
  );
});

test('private mode on a worker that answers anyone: the popup says nothing about a session', async ({ extension }) => {
  // The control for the spec above: the same rule, on the worker that reads `public`.
  await addRule(extension, { mode: 'private', clientId: 'playground', endpoint: WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-public');

  const popup = await openPopup(extension, page);
  // An absence proves nothing until the question was asked and answered, so wait for the answer.
  await page.bringToFront();
  const answered = popup.waitForResponse((response) => response.url().startsWith(`${WORKER_ORIGIN}/feedback?`));
  await popup.reload();
  expect((await answered).status()).toBe(200);
  await popup.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));

  await expect(popup.getByText(/answers a signed-in reader only/)).toHaveCount(0);
  await expect(popup.getByText('On · playground', { exact: false })).toBeVisible();
});

test('team mode: paired from the popup, the site reads and writes through the relay and never sees a token', async ({
  extension,
}) => {
  await recordPageMessages(extension.context);
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-team');
  await mountTheSiteWidget(page, AUTHENTICATED_WORKER_ORIGIN);
  await expect(page.getByRole('button', { name: 'Team feedback' })).toBeVisible();

  await pairFromPopup(extension, page, mintPairingCode(REVIEWER), REVIEWER);

  await plantOnTheLatteCard(page, 'Team feedback', 'Planté par le mode équipe');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  const tokens = await storedTokens(extension.worker);
  // The refresh token in `local` and the access token in `session`, or the searches below prove nothing.
  expect([...new Set(tokens.map((token) => token.area))].sort()).toEqual(['local', 'session']);
  await expectNoCredentialReadable(page, tokens);

  // This worker refuses a read with no identity, so the pin read back below came through the relay.
  expect((await readSeeds(page, AUTHENTICATED_WORKER_ORIGIN)).status).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page, AUTHENTICATED_WORKER_ORIGIN);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
  await expectNoCredentialReadable(page, tokens);

  // Every call went through the background. The page itself never called a worker.
  expect(calls).toEqual([]);

  // Signed by the worker from the session: only the relay carries it.
  const access = tokens.find((token) => token.area === 'session')?.value;
  const [seed] = await seedsOn(page, AUTHENTICATED_WORKER_ORIGIN, access);
  expect(seed?.reporter).toMatchObject({ name: REVIEWER, verified: true });
});

test('a session held with the worker of a private-mode site stays on the popup, with its log out (FRU-88)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private-held-session');
  await pairFromPopup(extension, page, mintPairingCode(REVIEWER), REVIEWER);

  // The same rule, moved to private mode from the popup. The session stays in storage.
  const popup = await openPopup(extension, page);
  await popup.getByRole('button', { name: 'Change' }).click();
  await popup.getByLabel(/^Mode/).selectOption('private');
  await popup.getByLabel('Client id', { exact: true }).fill('playground');
  await popup.getByRole('button', { name: 'Save' }).click();

  await expect(popup.getByText('On · playground', { exact: false })).toBeVisible();
  await expect(popup.getByText(`Paired as ${REVIEWER}`)).toBeVisible();
  await expect(popup.getByLabel('Pairing code')).toHaveCount(0);

  await popup.getByRole('button', { name: 'Log out' }).click();
  await expect(popup.getByText(`Paired as ${REVIEWER}`)).toHaveCount(0);
  await expect(popup.getByLabel('Pairing code')).toHaveCount(0);
  await expect(popup.getByText('On · playground', { exact: false })).toBeVisible();
});

test('a failed pairing offers the one thing to do about it, and Try again pairs with the same code (FRU-90)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-remedies');
  const popup = await openPopup(extension, page);
  const shot = async (name: string): Promise<void> => {
    const path = test.info().outputPath(`${name}.png`);
    await popup.screenshot({ path, clip: { x: 0, y: 0, width: 520, height: 330 } });
    await test.info().attach(name, { path, contentType: 'image/png' });
  };

  // A code nobody minted: the worker answers, so the popup must not offer to try it again.
  await popup.getByRole('button', { name: 'I have a code' }).click();
  await popup.getByLabel('Pairing code').fill('AAAA-BBBB-CCCC');
  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText('That code has been used or has expired. Ask for a new one.')).toBeVisible();
  await expect(popup.getByRole('link', { name: 'How to get a code' })).toHaveAttribute(
    'href',
    'https://sakuga-software.github.io/fruitback/reviewing.html#3-pair-in-team-mode',
  );
  await expect(popup.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await shot('code-spent');

  // A worker that does not answer once. The code is not spent, so the same one must pair after.
  let refused = 0;
  await popup.route(`${AUTHENTICATED_WORKER_ORIGIN}/session/pair`, async (route) => {
    if (refused++ === 0) await route.abort('connectionrefused');
    else await route.continue();
  });
  await popup.getByLabel('Pairing code').fill(mintPairingCode(REVIEWER));
  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText('The worker did not answer. Try again.')).toBeVisible();
  await shot('worker-down');

  await popup.getByRole('button', { name: 'Try again' }).click();
  await expect(popup.getByText(`Paired as ${REVIEWER}`)).toBeVisible();
  expect(refused, 'the first attempt did not reach the route, so nothing was retried').toBe(2);
});

test('a pairing link pairs with one click, and the site then works through that session (FRU-92)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const site = await extension.context.newPage();
  await openBareSite(site, 'ext-pair-link');
  await mountTheSiteWidget(site, AUTHENTICATED_WORKER_ORIGIN);

  // The link an operator sends, opened like any link.
  const { link, code } = mintPairing(REVIEWER);
  expect(link).toBe(`${AUTHENTICATED_WORKER_ORIGIN}/pair#${code}`);
  const linkPage = await extension.context.newPage();
  const requests: string[] = [];
  linkPage.on('request', (request) => requests.push(request.url()));
  await linkPage.goto(link);
  await expect(linkPage.getByRole('heading', { name: 'Pair the Fruitback extension' })).toBeVisible();
  // The worker was asked for the page, and the code was in no request: a fragment is not sent.
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.join('\n')).not.toContain(code);

  const popup = await openPopup(extension, linkPage, AUTHENTICATED_WORKER_ORIGIN);
  await expect(popup.getByText(`This page is a pairing link for ${AUTHENTICATED_WORKER_ORIGIN}.`)).toBeVisible();
  // No field to fill in, and no form to switch the worker's own page on as a site.
  await expect(popup.getByLabel('Pairing code')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Turn on for this site' })).toHaveCount(0);
  // The address has the shape of a link, and that proves nothing: the site's screen is one click away.
  await popup.getByRole('button', { name: 'This is a site to review' }).click();
  await expect(popup.getByRole('button', { name: 'Turn on for this site' })).toBeVisible();
  await popup.reload();
  await expect(popup.getByText(`This page is a pairing link for ${AUTHENTICATED_WORKER_ORIGIN}.`)).toBeVisible();
  const shot = test.info().outputPath('pair-link.png');
  await popup.screenshot({ path: shot, clip: { x: 0, y: 0, width: 520, height: 220 } });
  await test.info().attach('pair-link', { path: shot, contentType: 'image/png' });
  const pageShot = test.info().outputPath('pair-page.png');
  await linkPage.screenshot({ path: pageShot, clip: { x: 0, y: 0, width: 900, height: 360 } });
  await test.info().attach('pair-page', { path: pageShot, contentType: 'image/png' });

  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText(`Paired as ${REVIEWER}`)).toBeVisible();

  // The session is stored under the endpoint the rule names, so the site's widget is served.
  await plantOnTheLatteCard(site, 'Team feedback', 'Planté après un lien');
  await expect(site.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The same link a second time: the code is spent, and the popup says what to do next.
  await popup.getByRole('button', { name: 'Log out' }).click();
  await popup.getByRole('button', { name: 'Pair with this worker' }).click();
  await expect(popup.getByText('That code has been used or has expired. Ask for a new one.')).toBeVisible();
  await expect(popup.getByRole('link', { name: 'How to get a code' })).toBeVisible();
});

test('the popup, the options page and the mounted widget speak the language of the account (FRU-131)', async ({
  extension,
}) => {
  await addRule(extension, { mode: 'team', endpoint: AUTHENTICATED_WORKER_ORIGIN });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-language');
  // The control: English, in the popup and then on the page.
  await pairFromPopup(extension, page, mintPairingCode(REVIEWER), REVIEWER);
  const setUp = await openPopup(extension, page);
  await setUp.getByRole('button', { name: 'Change' }).click();
  await setUp.getByLabel(/^Mode/).selectOption('private');
  await setUp.getByLabel('Client id', { exact: true }).fill('playground');
  await setUp.getByRole('button', { name: 'Save' }).click();
  await expect(setUp.getByText('On · playground', { exact: false })).toBeVisible();
  await setUp.close();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  // The worker of the session says the account reads French. The E2E workers keep no accounts, so
  // the answer of that one route is given here; the popup asks it with its real session.
  const asked: (string | undefined)[] = [];
  await extension.context.route(`${AUTHENTICATED_WORKER_ORIGIN}/session/sites`, (route) => {
    asked.push(route.request().headers().authorization);

    return route.fulfill({ json: { workspace: { id: 'ws_1', name: 'Acme' }, sites: [], locale: 'fr' } });
  });
  // This popup learns the language and does not draw again: it is still English.
  const learner = await openPopup(extension, page);
  await expect
    .poll(() => extension.worker.evaluate(() => chrome.storage.local.get('language')))
    .toEqual({ language: 'fr' });
  expect(asked[0]).toMatch(/^Bearer .+/);
  await expect(learner.getByText(`Paired as ${REVIEWER}`)).toBeVisible();
  await learner.close();

  // The open tab gets the widget again, in French, with no reload.
  await expect(page.getByRole('button', { name: 'Laisser un feedback' })).toBeVisible();

  const popup = await openPopup(extension, page);
  await expect(popup.getByText(`Appairé en tant que ${REVIEWER}`)).toBeVisible();
  await expect(popup.getByText('Activé · playground', { exact: false })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Tous les sites et les règles' })).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.lang)).toBe('fr');

  const options = await extension.context.newPage();
  await options.goto(`chrome-extension://${extension.id}/options.html`);
  await expect(options.getByRole('heading', { name: 'Sites Fruitback' })).toBeVisible();
  await expect(options.getByRole('button', { name: 'Ajouter la règle' })).toBeVisible();
  await options.close();

  // Logged out, no account is left to speak for: the language goes at once, and the open tab is
  // English again with no reload.
  await popup.getByRole('button', { name: 'Se déconnecter' }).click();
  await expect.poll(() => extension.worker.evaluate(() => chrome.storage.local.get('language'))).toEqual({});
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();
  await popup.close();
  const after = await openPopup(extension, page);
  await expect(after.getByText('On · playground', { exact: false })).toBeVisible();
});

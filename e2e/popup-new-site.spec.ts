import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Locator, type Page, expect } from '@playwright/test';
import { type LoadedExtension, PLAYGROUND_ORIGIN, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * A site of no workspace in the popup (FRU-255, screen 08): « Add to {workspace} and turn on ».
 *
 * The account is signed in through the routes of FRU-238, and `GET` and `POST /session/sites` are
 * answered here in the shape of the worker half (#310): the worker of the suite does not have that
 * route on this branch. What is measured is the extension: what it asks, in which order, and what it
 * draws and stores.
 */

const CLOUD = AUTHENTICATED_WORKER_ORIGIN;
const CONSOLE = 'http://localhost:5178';
const PERSON = { subject: 'acct_add', name: 'Camille Durand', email: 'camille@acme.dev', account: true };

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  return (await locator.first().boundingBox()) as Box;
}

function expectNear(built: Box, mockup: Partial<Box>, name: string): void {
  if (process.platform !== 'darwin') return;
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    const expected = mockup[side];
    if (expected === undefined) continue;
    expect
      .soft(Math.abs(built[side] - expected), `${name}: ${side} is ${built[side]}, the mock-up has ${expected}`)
      .toBeLessThanOrEqual(2);
  }
}

async function clean(surface: Page, name: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await surface.emulateMedia({ colorScheme });
    const { violations, passes } = await new AxeBuilder({ page: surface }).analyze();
    expect(
      passes.map((rule) => rule.id),
      `${name}, ${colorScheme}`,
    ).toContain('color-contrast');
    expect(
      violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`),
      `${name}, ${colorScheme}`,
    ).toEqual([]);
  }
  await surface.emulateMedia({ colorScheme: 'light' });
}

/** Signed in as an account, through the routes of FRU-238, answered here. */
async function signedIn(extension: LoadedExtension, page: Page, request: string): Promise<void> {
  await extension.context.route(`${CLOUD}/session/connect`, (route) =>
    route.fulfill({
      status: 201,
      json: {
        request,
        claim: `claim-${request}`,
        word: 'FIG 12',
        verificationUri: `${CONSOLE}/connect/${request}`,
        expiresIn: 900,
        interval: 2,
      },
    }),
  );
  await extension.context.route(`${CLOUD}/session/connect/claim`, (route) =>
    route.fulfill({
      status: 200,
      json: { refreshToken: 'add-refresh', accessToken: 'add-access', expiresIn: 600, identity: PERSON },
    }),
  );
  await extension.context.route(`${CONSOLE}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Connect</title>' }),
  );
  const popup = await openPopup(extension, page);
  const opened = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: /^(Sign in to Fruitback|Se connecter à Fruitback)$/ }).click();
  await (await opened).close();
  await expect(popup.getByRole('img', { name: /^(Signed in as|Connecté en tant que) Camille Durand$/ })).toBeVisible({
    timeout: 15_000,
  });
  await popup.close();
}

/** The list of an account, and the add, in the shape of the worker (#310). */
async function sitesRoute(
  context: BrowserContext,
  workspaces: { id: string; name: string; role: string; canAddSite: boolean }[],
) {
  const sites: { id: string; origin: string; visibility: string; workspace: string }[] = [];
  const posted: { body: unknown; authorization: string | null }[] = [];
  await context.route(`${CLOUD}/session/sites`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { workspace: string; origin: string };
      posted.push({ body, authorization: await request.headerValue('Authorization') });
      const site = {
        id: `site_${sites.length + 1}`,
        origin: body.origin,
        visibility: 'members',
        workspace: body.workspace,
      };
      sites.push(site);

      return route.fulfill({ status: 201, json: { site } });
    }

    return route.fulfill({ json: { account: true, workspaces, sites } });
  });

  return { sites, posted };
}

/**
 * How many buttons of the popup were turned back on, from now. An add turns them off; one that ends
 * by drawing the popup again leaves them off until then, or a second click adds once more.
 */
async function reEnabled(popup: Page): Promise<() => Promise<number>> {
  await popup.evaluate(() => {
    const seen = { count: 0 };
    (globalThis as unknown as { reEnabled: typeof seen }).reEnabled = seen;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.oldValue !== null && !(record.target as HTMLButtonElement).disabled) seen.count += 1;
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
      attributeOldValue: true,
    });
  });

  return () => popup.evaluate(() => (globalThis as unknown as { reEnabled: { count: number } }).reEnabled.count);
}

test('a site of no workspace: added to one and turned on, in one click (08)', async ({ extension }) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site');
  const { posted } = await sitesRoute(extension.context, [
    { id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true },
    { id: 'ws_2', name: 'Northwind', role: 'admin', canAddSite: true },
    { id: 'ws_3', name: 'Lumen', role: 'guest', canAddSite: false },
  ]);
  await signedIn(extension, page, 'req_add_1');

  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 360, height: 500 });
  await expect(popup.getByRole('heading', { level: 1, name: 'localhost:5177' })).toBeVisible();
  await expect(popup.getByText('Not in a workspace yet')).toBeVisible();
  // Only where the account may add a site: not Lumen, where it is a guest.
  const list = popup.getByRole('combobox', { name: 'Workspace' });
  await expect(list.locator('option')).toHaveText(['Sakuga', 'Northwind']);
  await expect(popup.getByText(/preview build/i)).toHaveCount(0);
  expectNear(await boxOf(popup.getByRole('heading', { level: 1 })), { x: 16, y: 77, width: 328 }, 'title');
  expectNear(await boxOf(list), { x: 16, y: 242, width: 328, height: 40 }, 'list');
  expectNear(await boxOf(popup.getByRole('button', { name: /^Add to/ })), { x: 16, width: 328, height: 46 }, 'add');
  await clean(popup, 'the popup on a site of no workspace');

  await list.selectOption('ws_2');
  await popup.getByRole('button', { name: 'Add to Northwind and turn on' }).click();

  // 07: on, in Northwind. The site was asked for with the token, as one of the workspace chosen.
  await expect(popup.getByRole('switch', { name: 'Fruitback on localhost:5177' })).toBeChecked();
  await expect(popup.getByText('On · Northwind')).toBeVisible();
  // Screen 07 of an account, against the mock-up: the switch and the two actions where it has them.
  await popup.setViewportSize({ width: 360, height: 540 });
  // The parts of the kit (FRU-293): the switch of 44 × 26, the main button of 46 px, the second of 44.
  expectNear(await boxOf(popup.getByRole('switch')), { x: 300, y: 84, width: 44, height: 26 }, 'switch');
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Leave feedback' })),
    { x: 16, y: 382, width: 328, height: 46 },
    'leave',
  );
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Show every note of the page' })),
    { x: 16, y: 436, width: 328, height: 44 },
    'every note',
  );
  expect(posted).toEqual([
    { body: { workspace: 'ws_2', origin: PLAYGROUND_ORIGIN }, authorization: 'Bearer add-access' },
  ]);
  const rules = await extension.worker.evaluate(async () => (await chrome.storage.local.get('sites')).sites);
  expect(rules).toEqual({
    [PLAYGROUND_ORIGIN]: {
      endpoint: CLOUD,
      enabled: true,
      mode: 'team',
      mount: { clientId: 'site_1', workspace: 'Northwind' },
    },
  });
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);
});

test('a site added, whose rule is not stored, is drawn as it is: a site of the workspace to turn on', async ({
  extension,
}) => {
  // Raised in review: the worker added the site, then storing the rule failed, and the popup said
  // the change failed over a site that exists.
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-unstored');
  await sitesRoute(extension.context, [{ id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true }]);
  await signedIn(extension, page, 'req_add_5');

  const popup = await openPopup(extension, page);
  // Every change of a rule goes to the background: this one is lost on the way.
  await popup.evaluate(() => {
    const runtime = (
      globalThis as unknown as { chrome: { runtime: { sendMessage: (message: unknown) => Promise<unknown> } } }
    ).chrome.runtime;
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (message: unknown) =>
      JSON.stringify(message).includes('site-mutation') ? Promise.reject(new Error('lost')) : send(message);
  });
  await popup.getByRole('button', { name: 'Add to Sakuga and turn on' }).click();

  await expect(popup.getByRole('button', { name: 'Turn on here' })).toBeVisible();
  await expect(popup.getByText('In Sakuga · members see the notes')).toBeVisible();
});

test('an add refused for its session keeps the buttons off until the popup is drawn again', async ({ extension }) => {
  // Raised in review: the buttons were turned on before the popup was drawn again, and a second click
  // asked for the access and posted the add once more while it was.
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-refused');
  const { posted } = await sitesRoute(extension.context, [
    { id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true },
  ]);
  await signedIn(extension, page, 'req_add_6');
  await extension.context.route(`${CLOUD}/session/sites`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 401, json: { error: 'invalid-identity', reason: 'session-ended' } })
      : route.fallback(),
  );

  const popup = await openPopup(extension, page);
  const add = popup.getByRole('button', { name: 'Add to Sakuga and turn on' });
  await expect(add).toBeEnabled();
  const turnedOn = await reEnabled(popup);
  const redrawn = popup.waitForFunction((button) => button !== null && !button.isConnected, await add.elementHandle());
  await add.click();
  await redrawn;

  expect(await turnedOn()).toBe(0);
  expect(posted).toEqual([]);
});

test('a site of no workspace, for an account that may add none: who can, and no button', async ({ extension }) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-none');
  const { posted } = await sitesRoute(extension.context, [
    { id: 'ws_3', name: 'Lumen', role: 'member', canAddSite: false },
  ]);
  await signedIn(extension, page, 'req_add_2');

  const popup = await openPopup(extension, page);
  await expect(popup.getByText('Ask an admin of your workspace to add this site.')).toBeVisible();
  await expect(popup.getByRole('button', { name: /^Add to/ })).toHaveCount(0);
  await clean(popup, 'the popup on a site of no workspace, without the right to add one');
  expect(posted).toEqual([]);
});

test('a Fruitback that does not answer is said, not read as « ask an admin »', async ({ extension }) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-down');
  let down = false;
  await extension.context.route(`${CLOUD}/session/sites`, (route) =>
    down
      ? route.abort('connectionrefused')
      : route.fulfill({
          json: {
            account: true,
            workspaces: [{ id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true }],
            sites: [],
          },
        }),
  );
  await signedIn(extension, page, 'req_add_4');
  down = true;

  const popup = await openPopup(extension, page);
  await expect(popup.getByRole('heading', { level: 1, name: 'Fruitback did not answer.' })).toBeVisible();
  await expect(popup.getByText('Ask an admin of your workspace to add this site.')).toHaveCount(0);
  down = false;
  await popup.getByRole('button', { name: 'Try again' }).click();
  await expect(popup.getByRole('button', { name: 'Add to Sakuga and turn on' })).toBeVisible();
});

test('a site of no workspace speaks French, with one workspace and its name in the button', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
  });
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-fr');
  await sitesRoute(extension.context, [{ id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true }]);
  await signedIn(extension, page, 'req_add_3');

  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 360, height: 500 });
  await expect(popup.getByText('Dans aucun workspace pour l’instant')).toBeVisible();
  await expect(popup.getByRole('combobox')).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Ajouter à Sakuga et activer' })).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await clean(popup, 'the popup on a site of no workspace, in French');
});

declare const chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };

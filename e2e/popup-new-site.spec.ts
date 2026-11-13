import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Locator, type Page, expect } from '@playwright/test';
import {
  type LoadedExtension,
  PLAYGROUND_ORIGIN,
  openBareSite,
  openPopup,
  test,
  SITE_MENU,
  SITE_ON,
  sessionSitesOf,
} from './extension.ts';
// `settled` comes from `e2e/settled.ts` (#873). The local copy that the squash left is removed.
import { settled } from './settled.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * A site of no workspace in the popup (FRU-255; screen 2 of FRU-298): « Leave notes on this
 * site? », its « Workspace » and « Turn on », then screen 3 with what the worker says of the site.
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
    await settled(surface);
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
  await popup.getByRole('button', { name: /^(Sign in with email|Se connecter par e-mail)$/ }).click();
  await (await opened).close();
  await expect(popup.getByRole('button', { name: /^(Account and settings|Compte et réglages)$/ })).toHaveText('C', {
    timeout: 15_000,
  });
  await popup.close();
}

/** The list of an account, and the add, in the shape of the worker (#310). */
async function sitesRoute(
  context: BrowserContext,
  workspaces: { id: string; name: string; role: string; canAddSite: boolean; sources?: unknown[] }[],
  destination: Record<string, unknown> = { label: 'Linear · Northwind' },
) {
  const sites: Record<string, unknown>[] = [];
  const posted: { body: unknown; authorization: string | null }[] = [];
  // FRU-453: the settings chosen on the screen, written after the add.
  const settings: unknown[] = [];
  // FRU-453: the teams of the Linear of a workspace, as the worker reads them from Linear.
  await context.route(`${CLOUD}/session/sites/places?*`, (route) =>
    route.fulfill({
      json: {
        kind: 'linear',
        teams: [
          { id: 'team_1', name: 'Northwind', key: 'NOR', projects: [{ id: 'proj_1', name: 'Website' }] },
          { id: 'team_2', name: 'Support', key: 'SUP', projects: [] },
        ],
      },
    }),
  );
  await context.route(`${CLOUD}/session/sites/settings`, async (route) => {
    const body = route.request().postDataJSON() as { workspace: string; site: string; visibility?: string };
    settings.push(body);
    const site = sites.find((each) => each.id === body.site);

    return route.fulfill({
      json: { site: { ...site, visibility: body.visibility ?? 'members', workspace: body.workspace } },
    });
  });
  await context.route(sessionSitesOf(CLOUD), async (route) => {
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
      // Listed after, with what FRU-295 adds for an account: where the notes go, and the fixes to check.
      sites.push({
        ...site,
        destination,
        // FRU-530: where the notes go by ids, for a role that changes it from screen 3.
        place: { connector: 'conn_1', teamId: 'team_1', projectId: 'proj_1' },
        toCheck: 2,
        notes: { new: 1, todo: 1, progress: 1, done: 2, closed: 0 },
      });

      return route.fulfill({ status: 201, json: { site } });
    }

    return route.fulfill({ json: { account: true, workspaces, sites } });
  });

  return { sites, posted, settings };
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

test('a site of no workspace: added to one and turned on, in one click, then screen 3 says what waits (FRU-298)', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site');
  const LINEAR = { id: 'conn_1', kind: 'linear', label: 'Linear · Acme' };
  const { posted, settings } = await sitesRoute(extension.context, [
    { id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true, sources: [] },
    { id: 'ws_2', name: 'Northwind', role: 'admin', canAddSite: true, sources: [LINEAR] },
    { id: 'ws_3', name: 'Lumen', role: 'guest', canAddSite: false },
  ]);
  await signedIn(extension, page, 'req_add_1');

  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });
  await expect(popup.getByRole('heading', { level: 1, name: 'Leave notes on this site?' })).toBeVisible();
  await expect(popup.locator('.kit-site-host')).toHaveText('localhost:5177');
  await expect(popup.getByText('Not in your sites yet')).toBeVisible();
  // Only where the account may add a site: not Lumen, where it is a guest.
  const list = popup.getByRole('combobox', { name: 'Workspace' });
  await expect(list.locator('option')).toHaveText(['Sakuga', 'Northwind']);
  // P2 of FRU-598: the defaults in a summary, which follows the workspace chosen.
  const summary = popup.locator('.turn-on-summary');
  await expect(summary.locator('dd')).toHaveText(['Fruitback', 'Members of Sakuga']);
  await expect(popup.getByText(/preview build/i)).toHaveCount(0);
  expectNear(await boxOf(popup.getByRole('heading', { level: 1 })), { x: 24, width: 332 }, 'title');
  expectNear(await boxOf(popup.getByRole('button', { name: 'Turn on' })), { x: 24, width: 332, height: 46 }, 'turn on');
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup on a site of no workspace');

  // FRU-453: who sees the notes and where they go are lists, for a role that manages the sites.
  await popup.getByRole('button', { name: 'Change before turning on' }).click();
  const who = popup.getByRole('combobox', { name: 'Who sees the notes' });
  await expect(who).toHaveValue('members');
  await expect(who.locator('option:checked')).toHaveText('Members of Sakuga');
  const where = popup.getByRole('combobox', { name: 'Notes go to' });
  await expect(where.locator('option')).toHaveText(['Fruitback (no tracker)']);
  await clean(popup, 'the lists of « Change before turning on »');

  await list.selectOption('ws_2');
  // The providers follow the workspace chosen; then a team, then a project of it.
  await expect(where.locator('option')).toHaveText(['Fruitback (no tracker)', 'Linear · Acme']);
  await where.selectOption('conn_1');
  const team = popup.getByRole('combobox', { name: 'Team' });
  await expect(team.locator('option')).toHaveText(['Choose a team…', 'Northwind (NOR)', 'Support (SUP)']);
  await team.selectOption('team_1');
  await popup.getByRole('combobox', { name: 'Project' }).selectOption('proj_1');
  await who.selectOption('everyone');
  await popup.getByRole('button', { name: 'Turn on' }).click();

  // 3: on, in Northwind. The site was asked for with the token, as one of the workspace chosen.
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  // What the worker says of the site (FRU-295), once it answers: the tracker, and what waits.
  // FRU-599: the state line names the workspace; « Sent to » has its own line, with its mark.
  await expect(popup.locator('.kit-site-state')).toHaveText('On · Northwind');
  const destination = popup.locator('.site-destination');
  await expect(destination.locator('.destination-place')).toHaveText('Linear / Northwind');
  await expect(destination.locator('svg.source-mark')).toHaveAttribute('data-kind', 'linear');
  await expect(popup.locator('.panel-counts')).toHaveText('3 open notes · 2 to check');
  // Screen 3 of an account, against the board P1 of FRU-598: 20 px around.
  expectNear(await boxOf(popup.getByRole('button', { name: SITE_MENU })), { x: 328, width: 32, height: 32 }, 'menu');
  expectNear(
    await boxOf(popup.getByRole('button', { name: 'Leave a note' })),
    { x: 20, width: 340, height: 56 },
    'leave',
  );
  expectNear(
    await boxOf(popup.getByRole('button', { name: /^Show all notes in a sidebar/ })),
    { x: 20, width: 340 },
    'sidebar',
  );
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup on a site that is on, for an account');
  expect(posted).toEqual([
    { body: { workspace: 'ws_2', origin: PLAYGROUND_ORIGIN }, authorization: 'Bearer add-access' },
  ]);
  expect(settings).toEqual([
    {
      workspace: 'ws_2',
      site: 'site_1',
      visibility: 'everyone',
      place: { connector: 'conn_1', teamId: 'team_1', projectId: 'proj_1' },
    },
  ]);

  // FRU-600: the site is on, and its destination changes from here: the pencil opens « Where notes
  // go », at the place of now. Nothing is written before « Save »; then screen 3 says what changed.
  await destination.getByRole('button', { name: 'Change where notes go' }).click();
  await expect(popup.getByRole('heading', { level: 1, name: 'Where notes go' })).toBeVisible();
  await expect(popup.getByRole('radio', { name: /^Linear/ })).toBeChecked();
  await expect(popup.getByRole('combobox', { name: 'Team' })).toHaveValue('team_1');
  await clean(popup, 'where notes go');
  await popup.getByRole('radio', { name: /^Fruitback/ }).check();
  expect(settings.length).toBe(1);
  await popup.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => settings.length).toBe(2);
  expect(settings[1]).toEqual({ workspace: 'ws_2', site: 'site_1', place: null });
  await expect(popup.getByRole('status').filter({ hasText: 'New notes now go to Fruitback' })).toBeVisible();
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
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

test('a site whose tracker refuses the connection says so, and an admin reconnects it at Linear from the popup (FRU-633)', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-refused-source');
  await sitesRoute(
    extension.context,
    [{ id: 'ws_2', name: 'Northwind', role: 'admin', canAddSite: true, sources: [] }],
    { label: 'Linear · Northwind', kind: 'linear', refused: true },
  );
  await signedIn(extension, page, 'req_refused_1');
  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });
  await popup.getByRole('button', { name: 'Turn on' }).click();

  const refused = popup.locator('.site-refused');
  await expect(refused.locator('.site-refused-words')).toHaveText(
    'Linear refuses the connection of this workspace, and the notes of this site do not reach it.',
  );
  // Right under « Sent to », above « Leave a note ».
  const [sent, line, leave] = await Promise.all([
    boxOf(popup.locator('.site-destination')),
    boxOf(refused),
    boxOf(popup.getByRole('button', { name: 'Leave a note' })),
  ]);
  expect(line.y).toBeGreaterThanOrEqual(sent.y + sent.height);
  expect(leave.y).toBeGreaterThanOrEqual(line.y + line.height);
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'a site whose tracker refuses the connection');

  // An admin goes to Linear from here: the worker gives the start of the flow, on its own address.
  const start = `${CLOUD}/auth/linear/start?ticket=abcdefghijklmnopqrstuvwx`;
  const asked: unknown[] = [];
  await extension.context.route(`${CLOUD}/session/sources/reconnect`, async (route) => {
    asked.push(route.request().postDataJSON());

    return route.fulfill({ status: 201, json: { url: start } });
  });
  await extension.context.route(`${CLOUD}/auth/linear/start?*`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Linear</title>' }),
  );
  const opened = extension.context.waitForEvent('page');
  await refused.getByRole('button', { name: 'Reconnect Linear' }).click();
  expect((await opened).url()).toBe(start);
  expect(asked).toEqual([{ workspace: 'ws_2', connector: 'conn_1' }]);

  // A worker that refuses (a connector made with a key, a worker of before): the panel in the console.
  await extension.context.unroute(`${CLOUD}/session/sources/reconnect`);
  await extension.context.route(`${CLOUD}/session/sources/reconnect`, (route) =>
    route.fulfill({ status: 404, json: { error: 'not-found' } }),
  );
  const again = await openPopup(extension, page);
  const fallback = extension.context.waitForEvent('page');
  await again.locator('.site-refused').getByRole('button', { name: 'Reconnect Linear' }).click();
  expect((await fallback).url()).toBe(`${CONSOLE}/w/ws_2/connectors?connector=conn_1`);
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
  await popup.getByRole('button', { name: 'Turn on' }).click();

  await expect(popup.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await expect(popup.getByText('In Sakuga · not on in this browser')).toBeVisible();
  // FRU-298: where the notes of that site go, as the worker lists it now.
  await expect(
    popup.locator('.kit-dl-entry').filter({ hasText: 'Notes go to' }).locator('dd:not(.kit-dl-action)'),
  ).toHaveText('Linear · Northwind');
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
  await extension.context.route(sessionSitesOf(CLOUD), (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 401, json: { error: 'invalid-identity', reason: 'session-ended' } })
      : route.fallback(),
  );

  const popup = await openPopup(extension, page);
  const add = popup.getByRole('button', { name: 'Turn on' });
  await expect(add).toBeEnabled();
  const turnedOn = await reEnabled(popup);
  const redrawn = popup.waitForFunction((button) => button !== null && !button.isConnected, await add.elementHandle());
  await add.click();
  await redrawn;

  expect(await turnedOn()).toBe(0);
  expect(posted).toEqual([]);
});

test('a site of no workspace, for an account that may add none: a message for an admin, and no « Turn on »', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-none');
  const { posted } = await sitesRoute(extension.context, [
    { id: 'ws_3', name: 'Lumen', role: 'member', canAddSite: false },
  ]);
  await signedIn(extension, page, 'req_add_2');
  await extension.context.grantPermissions(['clipboard-read', 'clipboard-write']);

  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });
  // P2 of FRU-598: the one workspace of the account is named, and the message names the site.
  await expect(popup.getByRole('heading', { level: 1, name: 'An admin of Lumen adds sites' })).toBeVisible();
  const message = popup.getByRole('textbox', { name: 'Message to send them' });
  await expect(message).toHaveValue(
    'Could you add http://localhost:5177 to the Lumen workspace of Fruitback? I would like to leave notes on it.',
  );
  await expect(message).not.toBeEditable();
  await expect(popup.getByRole('button', { name: 'Turn on' })).toHaveCount(0);
  await clean(popup, 'the popup on a site of no workspace, without the right to add one');

  await popup.getByRole('button', { name: 'Copy the message' }).click();
  await expect(popup.getByRole('status')).toHaveText('Copied');
  expect(await popup.evaluate(() => navigator.clipboard.readText())).toBe(await message.inputValue());
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  expect(posted).toEqual([]);
});

test('a Fruitback that does not answer is said, not read as « ask an admin »', async ({ extension }) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-down');
  let down = false;
  await extension.context.route(sessionSitesOf(CLOUD), (route) =>
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
  // Screen 4 (FRU-297): said in an alert, with « Try again ».
  await expect(popup.locator('.kit-alert-title')).toHaveText(/^Fruitback can't reach /);
  await expect(popup.getByText(/adds sites$/)).toHaveCount(0);
  down = false;
  await popup.getByRole('button', { name: 'Try again' }).click();
  await expect(popup.getByRole('button', { name: 'Turn on' })).toBeVisible();
});

test('a site of no workspace speaks French, with one workspace and no list', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
  });
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-fr');
  await sitesRoute(extension.context, [{ id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true }]);
  await signedIn(extension, page, 'req_add_3');

  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });
  await expect(popup.getByText('Pas encore dans vos sites')).toBeVisible();
  await expect(popup.getByRole('heading', { level: 1, name: 'Laisser des notes sur ce site ?' })).toBeVisible();
  await expect(popup.locator('.turn-on-summary dd')).toHaveText(['Fruitback', 'Les membres de Sakuga']);
  await expect(popup.getByRole('button', { name: 'Modifier avant d’activer' })).toBeVisible();
  // One workspace: no list of workspaces (the lists of FRU-453 are about the site).
  await expect(popup.getByRole('combobox', { name: 'Workspace' })).toHaveCount(0);
  await expect(popup.getByRole('button', { name: 'Activer', exact: true })).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup on a site of no workspace, in French');
});

declare const chrome: {
  storage: {
    local: { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };
  };
};

test('a site whose add the prompt cut short is added and turned on when the popup opens again (FRU-454)', async ({
  extension,
}) => {
  // The prompt of the browser closed the popup after « Turn on »: what it remembered is all there is.
  // Automation cannot answer the prompt, so the intent is written as the popup writes it.
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-new-site-cut-short');
  const { posted, settings } = await sitesRoute(extension.context, [
    { id: 'ws_1', name: 'Sakuga', role: 'owner', canAddSite: true, sources: [] },
  ]);
  await signedIn(extension, page, 'req_add_7');
  await extension.worker.evaluate(
    async ({ origin, endpoint }) => {
      await chrome.storage.local.set({
        'fruitback:pending-site': {
          pattern: origin,
          add: { endpoint, workspace: { id: 'ws_1', name: 'Sakuga' }, settings: { visibility: 'everyone' } },
          at: Date.now(),
        },
      });
    },
    { origin: PLAYGROUND_ORIGIN, endpoint: CLOUD },
  );

  const popup = await openPopup(extension, page);
  // No second « Turn on »: screen 3, on, in Sakuga.
  await expect(popup.getByRole('img', { name: SITE_ON })).toBeVisible();
  expect(posted.map((each) => each.body)).toEqual([{ workspace: 'ws_1', origin: PLAYGROUND_ORIGIN }]);
  expect(settings).toEqual([{ workspace: 'ws_1', site: 'site_1', visibility: 'everyone' }]);
  expect(
    await extension.worker.evaluate(
      async () => (await chrome.storage.local.get('fruitback:pending-site'))['fruitback:pending-site'],
    ),
  ).toBeUndefined();
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(1);
});

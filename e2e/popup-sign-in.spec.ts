import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Locator, type Page, type Route, expect } from '@playwright/test';
import { type LoadedExtension, PLAYGROUND_ORIGIN, addRule, openBareSite, openPopup, test } from './extension.ts';
import { AUTHENTICATED_WORKER_ORIGIN } from './worker-sessions.ts';

/**
 * The sign-in in the real extension (FRU-251, FRU-297): screen 1 of the popup against the mock-up of
 * 2026-10-20, its keyboard and its contrasts, and every screen of a sign-in.
 *
 * The Fruitback of the build is the second worker of the suite: `pnpm e2e` builds the extension with
 * `WXT_FRUITBACK_CLOUD` set to it. The routes of the sign-in (FRU-238) are answered here, in the shape
 * the worker gives them, so each answer the popup can meet is met on purpose: approved, refused,
 * expired, a console of another site, a Fruitback that does not answer.
 */

const CLOUD = AUTHENTICATED_WORKER_ORIGIN;
/** A console on the loopback, as the dev loop has it: of the site of the worker. */
const CONSOLE = 'http://localhost:5178';
/** What takes the session: it must appear in no address, no page and no `storage.local`. */
const CLAIM = 'e2e-claim-secret-7d3f9a1c0b2e4f6a8c9d1e3f5a7b9c0d2e4f6a8';
const WORD = 'PLUM 47';
const PERSON = { subject: 'acct_e2e', name: 'Camille Durand', email: 'camille@acme.dev', account: true };

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = (await locator.first().boundingBox()) as Box;
  const round = (value: number) => Math.round(value * 10) / 10;

  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

/**
 * The mock-up is measured in the system font of macOS; the CI draws Linux's, a pixel or two off. So
 * the boxes are compared where the font is the mock-up's, and everything else everywhere.
 */
const FONT_OF_THE_MOCKUP = process.platform === 'darwin';

function expectNear(built: Box, mockup: Partial<Box>, name: string): void {
  if (!FONT_OF_THE_MOCKUP) return;
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    const drawn = mockup[side];
    if (drawn === undefined) continue;
    expect
      .soft(Math.abs(built[side] - drawn), `${name}: ${side} is ${built[side]}, the mock-up has ${drawn}`)
      .toBeLessThanOrEqual(2);
  }
}

/** A request id of its own per test: the workers of the suite run in parallel. */
function requestOf(name: string): string {
  return `req_${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 30)}`;
}

/**
 * The two routes of the sign-in, as FRU-238 answers them. `claim` is read at each claim, so a spec
 * changes what the console did by changing it.
 */
async function signInRoutes(
  context: BrowserContext,
  request: string,
  options: { console?: string; start?: (route: Route) => Promise<void> } = {},
): Promise<{ claim: { answer: 'pending' | 'approved' | 'refused' | 'expired' }; bodies: unknown[] }> {
  const state = { answer: 'pending' as 'pending' | 'approved' | 'refused' | 'expired' };
  const bodies: unknown[] = [];
  // What an account of no workspace reads (FRU-238): the worker of the suite does not know the token.
  await context.route(`${CLOUD}/session/sites`, (route) =>
    route.fulfill({ json: { account: true, workspaces: [], sites: [] } }),
  );
  await context.route(`${CLOUD}/session/connect`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (options.start !== undefined) return options.start(route);

    return route.fulfill({
      status: 201,
      json: {
        request,
        claim: CLAIM,
        word: WORD,
        browser: 'Chrome on macOS',
        verificationUri: `${options.console ?? CONSOLE}/connect/${request}`,
        expiresIn: 900,
        interval: 2,
      },
    });
  });
  await context.route(`${CLOUD}/session/connect/claim`, async (route) => {
    bodies.push(route.request().postDataJSON());
    if (state.answer === 'pending') return route.fulfill({ status: 202, json: { state: 'pending', interval: 2 } });
    if (state.answer === 'refused') return route.fulfill({ status: 410, json: { error: 'connect-refused' } });
    if (state.answer === 'expired') return route.fulfill({ status: 410, json: { error: 'connect-expired' } });

    return route.fulfill({
      status: 200,
      json: { refreshToken: 'e2e-refresh-1', accessToken: 'e2e-access-1', expiresIn: 600, identity: PERSON },
    });
  });
  // The page of the console that approves: the console has a spec of its own (FRU-240).
  await context.route(`${CONSOLE}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Connect</title><h1>Connect this browser</h1><p>${WORD}</p>`,
    }),
  );

  return { claim: state, bodies };
}

/** The only `chrome.*` calls of this spec, from the service worker. */
declare const chrome: {
  storage: Record<
    'local' | 'session' | 'sync',
    {
      get(keys: null): Promise<Record<string, unknown>>;
      remove(keys: string[]): Promise<void>;
      set(items: Record<string, unknown>): Promise<void>;
    }
  >;
};

/** Everything the extension keeps in one area, as one text. */
function stored(extension: LoadedExtension, area: 'local' | 'session' | 'sync'): Promise<string> {
  return extension.worker.evaluate(async (name) => JSON.stringify(await chrome.storage[name].get(null)), area);
}

async function clean(surface: Page, name: string): Promise<void> {
  for (const colorScheme of ['light', 'dark'] as const) {
    await surface.emulateMedia({ colorScheme });
    const { violations, passes } = await new AxeBuilder({ page: surface }).analyze();
    // A control: axe did measure a contrast here, so an empty list is a result.
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

/** What the keyboard reaches, in order, from the top of the popup. */
async function tabStops(popup: Page, count: number): Promise<string[]> {
  await popup.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const stops: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await popup.keyboard.press('Tab');
    stops.push(
      await popup.evaluate(() => {
        const focused = document.activeElement as HTMLElement;

        return focused.getAttribute('aria-label') ?? focused.textContent ?? '';
      }),
    );
  }

  return stops;
}

test('signed out, the popup is screen 1 of the mock-up: its boxes, its keyboard, its contrasts (FRU-297)', async ({
  extension,
}) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-signed-out');
  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });

  await expect(
    popup.getByRole('heading', { level: 1, name: 'Comment on any website, right on the page' }),
  ).toBeVisible();
  await expect(popup.getByText('Invited by a client or a team?')).toBeVisible();
  // Signed out: no button of the account, and none of the words the popup no longer says.
  await expect(popup.getByRole('button', { name: 'Account and settings' })).toHaveCount(0);
  await expect(popup.locator('body')).not.toContainText(/worker|rule|client id|pair/i);

  // The boxes of screen 1 of the mock-up (popup/ExtPopups.dc.html, measured in a browser), ± 2 px.
  for (const [name, box] of [
    ['Comment on any website, right on the page', { x: 24, y: 85, width: 332, height: 52.8 }],
    ['Sign in with email', { x: 24, y: 211.8, width: 332, height: 46 }],
    ['Google', { x: 24, y: 267.8, width: 161, height: 44 }],
    ['GitHub', { x: 195, y: 267.8, width: 161, height: 44 }],
    ['Invited by a client or a team?', { x: 24, y: 464.5, width: 332 }],
    ['Use your own Fruitback server', { x: 24, y: 547.5 }],
  ] as const) {
    expectNear(await boxOf(popup.getByText(name, { exact: true })), box, name);
  }
  // Everywhere: the popup is 380 px wide, and nothing leaves it.
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  const action = popup.getByRole('button', { name: 'Sign in with email' });
  expect(await action.evaluate((button) => getComputedStyle(button).borderRadius)).toBe('10px');

  // The keyboard meets the three ways in, then the link, and sees where it is.
  expect(await tabStops(popup, 4)).toEqual(['Sign in with email', 'Google', 'GitHub', 'Use your own Fruitback server']);
  expect(await popup.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle)).toBe('solid');

  await clean(popup, 'the popup signed out');

  // The link of the foot opens the page of the extension.
  const settings = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Use your own Fruitback server' }).click();
  expect((await settings).url()).toBe(`chrome-extension://${extension.id}/options.html`);
});

for (const way of ['Google', 'GitHub'] as const) {
  test(`« ${way} » opens the sign-in of the console, as « Sign in with email » does (FRU-297)`, async ({
    extension,
  }) => {
    const request = requestOf(`approved-${way}`);
    await signInRoutes(extension.context, request);
    const page = await extension.context.newPage();
    await openBareSite(page, `popup-sign-in-${way}`);
    const popup = await openPopup(extension, page);

    const consoleTab = extension.context.waitForEvent('page');
    await popup.getByRole('button', { name: way, exact: true }).click();
    // No surface of authentication of the extension: the console's own page, which offers its methods.
    expect((await consoleTab).url()).toBe(`${CONSOLE}/connect/${request}`);
    await expect(
      popup.getByRole('heading', { level: 1, name: 'Check that the tab shows the same word' }),
    ).toBeVisible();
  });
}

test('a sign-in the console approves: the word, the tab, then the person, and the claim nowhere it must not be', async ({
  extension,
}) => {
  const request = requestOf('approved');
  const { claim, bodies } = await signInRoutes(extension.context, request);
  const addresses: string[] = [];
  extension.context.on('request', (sent) => addresses.push(sent.url()));
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-sign-in-approved');
  const popup = await openPopup(extension, page);

  // From the keyboard: the click is what the access to Fruitback is asked in.
  const consoleTab = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Sign in with email' }).focus();
  await popup.keyboard.press('Enter');
  const approving = await consoleTab;
  expect(approving.url()).toBe(`${CONSOLE}/connect/${request}`);

  // The popup shows the word to check against the tab, and says it waits, once.
  await expect(popup.getByRole('heading', { level: 1, name: 'Check that the tab shows the same word' })).toBeVisible();
  await expect(popup.getByText(WORD, { exact: true })).toBeVisible();
  await expect(popup.getByRole('status')).toHaveText('Waiting for you to connect in the tab…');
  expect(bodies[0]).toEqual({ browser: expect.stringMatching(/ on /) as unknown });
  await clean(popup, 'the popup waiting for the console');

  // The control of the absences below: while it waits, the claim is in `storage.session`.
  expect(await stored(extension, 'session')).toContain(CLAIM);

  claim.answer = 'approved';
  // The popup claims on its own, at the pace the worker asked: nobody clicks anything.
  await expect(popup.getByRole('button', { name: 'Account and settings' })).toHaveText('C', { timeout: 15_000 });
  await expect(popup.getByText('camille@acme.dev', { exact: true })).toBeVisible();
  await expect(popup.getByRole('link', { name: 'Open the console' })).toHaveAttribute('href', `${CONSOLE}/`);
  await clean(popup, 'the popup signed in');

  // The claim went in a body, and only there: no address, no page, no storage that outlives the browser.
  expect(bodies).toContainEqual({ claim: CLAIM });
  expect(addresses.filter((address) => address.includes(CLAIM))).toEqual([]);
  expect(await stored(extension, 'local')).not.toContain(CLAIM);
  expect(await stored(extension, 'session')).not.toContain(CLAIM);
  for (const surface of [page, approving]) {
    const world = await surface.evaluate(() =>
      [
        document.documentElement.outerHTML,
        JSON.stringify(localStorage),
        JSON.stringify(sessionStorage),
        location.href,
      ].join('\n'),
    );
    expect(world).not.toContain(CLAIM);
  }
  // The session is an account's, kept like a pairing's: a refresh token in `local`.
  expect(await stored(extension, 'local')).toContain('e2e-refresh-1');
  // And nothing went to the browser account: no rule was typed.
  expect(await stored(extension, 'sync')).toBe('{}');
});

test('a sign-in refused in the console says so once, then the popup asks again', async ({ extension }) => {
  const request = requestOf('refused');
  const { claim } = await signInRoutes(extension.context, request);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-sign-in-refused');
  const popup = await openPopup(extension, page);

  const consoleTab = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  await consoleTab;
  await expect(popup.getByText(WORD, { exact: true })).toBeVisible();

  claim.answer = 'refused';
  await expect(popup.getByRole('heading', { level: 1, name: 'The sign-in did not finish.' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(popup.getByRole('alert')).toHaveText('It was refused in the console.');
  await clean(popup, 'the popup after a refusal');
  expect(await stored(extension, 'session')).not.toContain(CLAIM);
  // One popup at a time: `openPopup` finds the popup by its address.
  await popup.close();

  const again = await openPopup(extension, page);
  await expect(
    again.getByRole('heading', { level: 1, name: 'Comment on any website, right on the page' }),
  ).toBeVisible();
});

test('a sign-in nobody approved in time, and « Start again »', async ({ extension }) => {
  const request = requestOf('expired');
  const { claim, bodies } = await signInRoutes(extension.context, request);
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-sign-in-expired');
  const popup = await openPopup(extension, page);

  let opened = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  await opened;
  await expect(popup.getByText(WORD, { exact: true })).toBeVisible();

  // « Start again » makes a new request rather than giving back the one that waits.
  opened = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Start again' }).click();
  await opened;
  await expect(popup.getByText(WORD, { exact: true })).toBeVisible();
  expect(bodies.filter((body) => (body as { browser?: string }).browser !== undefined)).toHaveLength(2);

  claim.answer = 'expired';
  await expect(popup.getByRole('alert')).toHaveText('The tab was not approved in time.', { timeout: 15_000 });
  await expect(popup.getByRole('button', { name: 'Sign in with email' })).toBeVisible();
});

test('a console of another site is not opened, and a Fruitback that does not answer is said', async ({ extension }) => {
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-sign-in-untrusted');

  // A worker that names a console somewhere else: no tab opens.
  await signInRoutes(extension.context, requestOf('untrusted'), { console: 'https://evil.example' });
  const popup = await openPopup(extension, page);
  const pages = extension.context.pages().length;
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  await expect(popup.getByRole('alert')).toHaveText('Fruitback named a console that is not its own.');
  expect(extension.context.pages()).toHaveLength(pages);
  expect(await stored(extension, 'session')).not.toContain(CLAIM);
  await popup.close();

  // A Fruitback that does not answer: said, with « Try again », and nothing kept.
  await extension.context.unroute(`${CLOUD}/session/connect`);
  await signInRoutes(extension.context, requestOf('down'), { start: (route) => route.abort('connectionrefused') });
  const down = await openPopup(extension, page);
  await down.getByRole('button', { name: 'Sign in with email' }).click();
  await expect(down.getByRole('heading', { level: 1, name: 'Fruitback did not answer.' })).toBeVisible();
  await expect(down.getByRole('alert')).toHaveText('Check the connection, then try again.');
  await expect(down.getByRole('button', { name: 'Try again' })).toBeVisible();
  await clean(down, 'the popup when Fruitback does not answer');
});

test('a session of the account that ended asks to sign in again; one Fruitback cannot reach says so', async ({
  extension,
}) => {
  const { claim } = await signInRoutes(extension.context, requestOf('ended'));
  claim.answer = 'approved';
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-sign-in-ended');
  const popup = await openPopup(extension, page);
  const opened = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  await opened;
  await expect(popup.getByRole('button', { name: 'Account and settings' })).toHaveText('C', { timeout: 15_000 });
  await popup.close();

  // The access token goes, so the next popup refreshes; Fruitback does not answer.
  const dropGrant = () =>
    extension.worker.evaluate(async () => {
      const area = chrome.storage.session;
      await area.remove(Object.keys(await area.get(null)).filter((key) => key.startsWith('fruitback:grant:')));
    });
  await dropGrant();
  await extension.context.route(`${CLOUD}/session/refresh`, (route) => route.abort('connectionrefused'));
  const unreachable = await openPopup(extension, page);
  await expect(unreachable.getByRole('heading', { level: 1, name: 'Fruitback did not answer.' })).toBeVisible();
  // The session is kept: an outage is not a sign-out.
  expect(await stored(extension, 'local')).toContain('e2e-refresh-1');
  await unreachable.close();

  // Fruitback refuses the session: it ended, and the popup says so.
  await extension.context.unroute(`${CLOUD}/session/refresh`);
  await extension.context.route(`${CLOUD}/session/refresh`, (route) =>
    route.fulfill({ status: 401, json: { error: 'session-revoked' } }),
  );
  const ended = await openPopup(extension, page);
  await expect(ended.getByRole('heading', { level: 1, name: 'Your sign-in ended' })).toBeVisible();
  await expect(ended.getByRole('button', { name: 'Sign in with email' })).toBeVisible();
  expect(await stored(extension, 'local')).not.toContain('e2e-refresh-1');
});

test('a session of the account that ended draws no person in the head, on a site a rule covers', async ({
  extension,
}) => {
  // Raised in review: the popup ended the session, then drew « Signed in as » from what it read before.
  const { claim } = await signInRoutes(extension.context, requestOf('ended-rule'));
  claim.answer = 'approved';
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-sign-in-ended-rule');
  const popup = await openPopup(extension, page);
  const opened = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  await opened;
  await expect(popup.getByRole('button', { name: 'Account and settings' })).toHaveText('C', { timeout: 15_000 });
  await popup.close();
  await addRule(extension, { mode: 'team', endpoint: CLOUD });

  await extension.worker.evaluate(async () => {
    const area = chrome.storage.session;
    await area.remove(Object.keys(await area.get(null)).filter((key) => key.startsWith('fruitback:grant:')));
  });
  await extension.context.route(`${CLOUD}/session/refresh`, (route) =>
    route.fulfill({ status: 401, json: { error: 'session-revoked' } }),
  );
  const after = await openPopup(extension, page);
  await expect(after.getByRole('heading', { level: 1, name: 'localhost:5177' })).toBeVisible();
  await expect(after.getByText(`Rule: ${'http://localhost:5177'}`)).toBeVisible();
  await expect(after.locator('.kit-avatar-dot', { hasText: /\S/ })).toHaveCount(0);
  await expect(after.getByRole('link', { name: 'Open the console' })).toHaveCount(0);
});

test('a session that ended keeps the note, and the popup offers to sign in again (FRU-238)', async ({ extension }) => {
  // Signed in with a session the worker of the suite does not know: it refuses its token and its
  // refresh, as a worker refuses a session ended in « My account » (`401` with `session-ended`).
  const { claim } = await signInRoutes(extension.context, requestOf('ended-write'));
  claim.answer = 'approved';
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-session-ended-write');
  const popup = await openPopup(extension, page);
  const opened = extension.context.waitForEvent('page');
  await popup.getByRole('button', { name: 'Sign in with email' }).click();
  await opened;
  await expect(popup.getByRole('button', { name: 'Account and settings' })).toHaveText('C', { timeout: 15_000 });
  await popup.close();

  // The site of the workspace, turned on as the one click of 06 stores it.
  await extension.worker.evaluate(
    async ({ origin, endpoint }) => {
      await chrome.storage.local.set({
        sites: {
          [origin]: { endpoint, enabled: true, mode: 'team', mount: { clientId: 'playground', workspace: 'Acme' } },
        },
      });
    },
    { origin: PLAYGROUND_ORIGIN, endpoint: CLOUD },
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Leave feedback' })).toBeVisible();

  // The reads of the widget are refused for that session; the background renews it once, and the
  // refresh is refused too: the session is forgotten. A note then: refused, and its text kept.
  await page.getByRole('button', { name: 'Leave feedback' }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What should change?').fill('Une note après la fin de la session');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText('Your session has ended. Your text is kept: sign in again, then send it.')).toBeVisible();
  await expect(page.getByPlaceholder('What should change?')).toHaveValue('Une note après la fin de la session');
  // The session is forgotten here: the refresh token is gone.
  await expect.poll(() => stored(extension, 'local')).not.toContain('e2e-refresh-1');

  // The popup offers the one thing that makes the site work again.
  const after = await openPopup(extension, page);
  await expect(
    after.getByRole('heading', { level: 1, name: 'Comment on any website, right on the page' }),
  ).toBeVisible();
  await expect(after.getByRole('button', { name: 'Sign in with email' })).toBeVisible();
});

test('the popup signed out speaks French, and keeps to its 380 px', async ({ extension }) => {
  await extension.context.addInitScript(() => {
    Object.defineProperty(navigator, 'language', { get: () => 'fr-FR' });
  });
  const page = await extension.context.newPage();
  await openBareSite(page, 'popup-signed-out-fr');
  const popup = await openPopup(extension, page);
  await popup.setViewportSize({ width: 380, height: 580 });

  await expect(
    popup.getByRole('heading', { level: 1, name: 'Commentez n’importe quel site, directement sur la page' }),
  ).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Se connecter par e-mail' })).toBeVisible();
  await expect(popup.getByRole('button', { name: 'Utiliser votre propre serveur Fruitback' })).toBeVisible();
  expect(await popup.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
  // The foot holds on one line or wraps inside the popup, never past it.
  const foot = await boxOf(popup.locator('.popup-foot'));
  expect(foot.x + foot.width).toBeLessThanOrEqual(380);
  await clean(popup, 'the popup signed out, in French');
});

import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Locator, type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import {
  CONSOLE as WORKER_CONSOLE,
  SESSION_COOKIE,
  type Worker,
  cloudWorker,
  finished,
  served,
} from './cloud-worker.ts';
import { ACME, type Role, box, contrast, painted, rgb, sideScroll, stubWorker, styles } from './console-workspace.ts';

/**
 * My account (FRU-248), the page « Profile » of the shell of the settings (FRU-692), measured in a
 * browser against the mockup « Mon compte (Profil) » of FRU-692, with what the worker of today does:
 * the profile, where the person is signed in, the addresses, how the person signs in, and the ways out.
 * The page « Sessions » lists every browser.
 *
 * First the screen, with a worker answered by stubs: the values read in the code of the mockup, at
 * 1440 px. Then the sessions, against a worker whose accounts are in PostgreSQL (PGlite): no stub
 * decides that a session ended.
 */
const CONSOLE = 'http://localhost:5178';

const WHITE = '#ffffff';

const SESSIONS = [
  { id: 'x1', createdAt: '2026-10-13T08:00:00.000Z', lastUsedAt: '2026-10-13T11:00:00.000Z', current: true },
  { id: 'x2', createdAt: '2026-10-12T09:30:00.000Z', lastUsedAt: '2026-10-13T09:10:00.000Z', current: false },
  { id: 'x3', createdAt: '2026-10-02T14:00:00.000Z', lastUsedAt: '2026-10-10T16:45:00.000Z', current: false },
];

type Stubbed = {
  sessions: unknown[] | undefined;
  /** The worker ends no session when it is asked to. */
  refuses: boolean;
  /** The sessions are ended already: the worker knows no session by these ids. */
  gone: boolean;
  /** The browsers of the extension (FRU-249); `undefined`: the worker does not answer. */
  extensions: unknown[] | undefined;
  /** The worker ends no extension when it is asked to. */
  extensionRefuses: boolean;
  /** The worker knows no extension by the id it is asked to end: its session ended elsewhere. */
  extensionGone?: boolean;
  /** How the person signs in (FRU-249); `undefined`: the worker does not answer. */
  methods: Record<string, unknown> | undefined;
  /** What the worker answers to « Unlink », and to a name, when it refuses. */
  unlinkRefuses?: string;
  nameRefuses?: string;
  /** The answer to a name is held until `release` is called. */
  nameWaits?: boolean;
  /** A held answer refuses the name: the worker says `invalid-name` when it is released. */
  nameWaitsRefused?: boolean;
  release?: () => void;
  /**
   * The link that came back from the provider and waits (FRU-415): what `GET /console/me/sign-in/pending`
   * answers. `undefined`: none, `404`.
   */
  pending?: { provider: string; email: string };
  /** What the worker answers to « Link this account » when it refuses, by its code. */
  confirmRefuses?: string;
  /** The addresses of the account (FRU-450); `undefined`: the worker does not answer. */
  emails: { email: string; primary: boolean; providers: string[]; verified: boolean }[] | undefined;
  /** Whether the worker sends the link that adds an address. */
  canAdd: boolean;
  /** What the worker answers to an address, a new primary one or a removal, when it refuses. */
  addRefuses?: string;
  addressRefuses?: string;
  sent: string[];
  /** The bodies the console sent, by path. */
  bodies: Record<string, unknown>;
};

const EMAILS = [
  { email: 'ana@acme.dev', primary: true, providers: [], verified: true },
  { email: 'ana.perso@gmail.test', primary: false, providers: ['github'], verified: false },
  { email: 'ana@home.test', primary: false, providers: [], verified: true },
];

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Stubbed> {
  const worker: Stubbed = {
    sessions: SESSIONS,
    refuses: false,
    gone: false,
    methods: { email: true, github: { linked: true }, google: { linked: false } },
    extensions: [],
    extensionRefuses: false,
    emails: EMAILS.map((each) => ({ ...each })),
    canAdd: true,
    sent: [],
    bodies: {},
  };
  const answer = (pathname: string, route: Route) => {
    const method = route.request().method();
    if (pathname === '/console/me/sign-in') {
      return worker.methods === undefined
        ? route.fulfill({ status: 500, json: { error: 'unknown' } })
        : route.fulfill({ json: worker.methods });
    }
    // FRU-415: the form of « Link » is a `POST` that the worker answers with the provider, which comes
    // back to « My account » with a link to confirm. The provider is not called: the round trip is one
    // redirect here, as the worker writes it on the way back.
    const starting = /^\/console\/auth\/link\/(\w+)$/.exec(pathname)?.[1];
    if (starting !== undefined) {
      worker.sent.push(`${method} ${pathname}`);
      if (method !== 'POST') return route.fulfill({ status: 405, json: { error: 'method-not-allowed' } });
      worker.pending = { provider: starting, email: 'ana.perso@gmail.test' };

      return route.fulfill({ status: 303, headers: { Location: `${CONSOLE}/w/w1/account?confirm=${starting}` } });
    }
    if (pathname === '/console/me/sign-in/pending') {
      if (method === 'GET') {
        return worker.pending === undefined
          ? route.fulfill({ status: 404, json: { error: 'no-pending-link' } })
          : route.fulfill({ json: worker.pending });
      }
      worker.sent.push(`${method} ${pathname}`);
      const waiting = worker.pending;
      worker.pending = undefined;
      if (waiting === undefined) return route.fulfill({ status: 404, json: { error: 'no-pending-link' } });
      if (method === 'DELETE') return route.fulfill({ status: 204 });
      if (worker.confirmRefuses !== undefined) {
        return route.fulfill({ status: 409, json: { error: worker.confirmRefuses } });
      }
      worker.methods = { ...worker.methods, [waiting.provider]: { linked: true } };

      return route.fulfill({ json: { provider: waiting.provider } });
    }
    const provider = /^\/console\/me\/sign-in\/(\w+)$/.exec(pathname)?.[1];
    if (provider !== undefined) {
      worker.sent.push(`${method} ${pathname}`);
      if (worker.unlinkRefuses !== undefined) {
        return route.fulfill({
          status: worker.unlinkRefuses === 'last-sign-in' ? 409 : 403,
          json: { error: worker.unlinkRefuses },
        });
      }
      worker.methods = { ...worker.methods, [provider]: { linked: false } };

      return route.fulfill({ status: 204 });
    }
    // FRU-450: the addresses of the account.
    if (pathname === '/console/me/emails' && method === 'GET') {
      return worker.emails === undefined
        ? route.fulfill({ status: 500, json: { error: 'unknown' } })
        : route.fulfill({ json: { canAdd: worker.canAdd, emails: worker.emails } });
    }
    if (pathname.startsWith('/console/me/emails')) {
      worker.sent.push(`${method} ${pathname}`);
      const body = route.request().postDataJSON() as { email?: string } | null;
      worker.bodies[pathname] = body;
      if (pathname === '/console/me/emails') {
        if (worker.addRefuses !== undefined) return route.fulfill({ status: 409, json: { error: worker.addRefuses } });

        return route.fulfill({ status: 202, json: { sent: true, email: (body?.email ?? '').toLowerCase() } });
      }
      if (worker.addressRefuses !== undefined) {
        return route.fulfill({ status: 409, json: { error: worker.addressRefuses } });
      }
      if (pathname === '/console/me/emails/primary') {
        worker.emails = (worker.emails ?? []).map((each) => ({ ...each, primary: each.email === body?.email }));

        return route.fulfill({ json: { email: body?.email } });
      }
      const gone = decodeURIComponent(pathname.split('/').at(-1) ?? '');
      worker.emails = (worker.emails ?? []).filter((each) => each.email !== gone);

      return route.fulfill({ status: 204 });
    }
    if (pathname === '/console/me/name') {
      const body = route.request().postDataJSON() as { name: string };
      worker.sent.push(`${method} ${pathname}`);
      worker.bodies[pathname] = body;
      if (worker.nameRefuses !== undefined) return route.fulfill({ status: 400, json: { error: worker.nameRefuses } });
      if (worker.nameWaits) {
        return new Promise<void>((resolve) => {
          worker.release = () =>
            void (
              worker.nameWaitsRefused
                ? route.fulfill({ status: 400, json: { error: 'invalid-name' } })
                : route.fulfill({ json: { account: { id: 'a1', email: 'ana@acme.dev', name: body.name } } })
            ).then(resolve);
        });
      }

      return route.fulfill({ json: { account: { id: 'a1', email: 'ana@acme.dev', name: body.name } } });
    }
    if (pathname === '/console/me/browsers') {
      return worker.extensions === undefined
        ? route.fulfill({ status: 500, json: { error: 'unknown' } })
        : route.fulfill({ json: { browsers: worker.extensions } });
    }
    if (pathname.startsWith('/console/me/browsers/')) {
      worker.sent.push(`${method} ${pathname}`);
      if (worker.extensionRefuses) return route.fulfill({ status: 502, json: { error: 'auth-unavailable' } });
      if (worker.extensionGone) return route.fulfill({ status: 404, json: { error: 'not-found' } });
      const id = pathname.split('/').at(-1);
      worker.extensions = (worker.extensions ?? []).filter((each) => (each as { id: string }).id !== id);

      return route.fulfill({ status: 204 });
    }
    if (pathname === '/console/sessions') {
      return worker.sessions === undefined
        ? route.fulfill({ status: 500, json: { error: 'unknown' } })
        : route.fulfill({ json: { sessions: worker.sessions } });
    }
    if (method === 'GET') return undefined;
    worker.sent.push(`${method} ${pathname}`);
    if (worker.refuses) return route.fulfill({ status: 502, json: { error: 'auth-unavailable' } });
    if (pathname.startsWith('/console/sessions/')) {
      return worker.gone
        ? route.fulfill({ status: 404, json: { error: 'not-found' } })
        : route.fulfill({ status: 204 });
    }
    if (pathname.startsWith('/console/auth/')) return route.fulfill({ json: { status: true } });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/account`);
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.getByText('Console · this browser')).toBeVisible();
}

/** The page « Sessions » (FRU-692): every browser, when it signed in, and when it was used last. */
async function openSessions(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/account/sessions`);
  await expect(page.locator('main h1')).toHaveText('Sessions');
  await expect(page.getByText('Console · this browser')).toBeVisible();
}

/** Chooses `item` in the menu of a row (FRU-692): the rare actions of a row are there. */
async function choose(row: Locator, item: string): Promise<void> {
  await row.getByRole('button', { name: /^(More for|Plus pour) / }).click();
  await row.page().getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
}

const section = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

/** The colours of the mockup of FRU-692. */
const MOCKUP = { line: '#e3e8ef', muted: '#5b6779' };

test('the screen is the one of the mockup, with what the worker of today does', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await workerWith(page);
  await open(page);

  // The shell (FRU-692): a bar of 48 px that says « Settings », the navigation of 220 px, the page.
  const nav = page.getByRole('main').getByRole('navigation', { name: 'Settings', exact: true });
  const bar = nav.locator('xpath=../preceding-sibling::div[1]');
  await expect(bar).toHaveText('Settings');
  expect.soft((await box(bar)).height, 'the bar').toBe(48);
  expect.soft(await styles(bar, ['border-bottom-width', 'font-size', 'font-weight'])).toEqual({
    'border-bottom-width': '1px',
    'font-size': '14px',
    'font-weight': '600',
  });
  expect.soft((await box(nav)).width, 'the navigation').toBe(220);
  expect.soft(await styles(nav, ['border-right-width'])).toEqual({ 'border-right-width': '1px' });
  // Its two groups, each named by its title, an icon on each entry. The pages that do not exist yet
  // have no entry: « Sign-in and addresses », « Appearance » (FRU-694) and « Notifications ».
  await expect(nav.getByRole('list', { name: 'Account' }).getByRole('link')).toHaveText(['Profile', 'Sessions']);
  await expect(nav.getByRole('list', { name: 'Workspace' }).getByRole('link')).toHaveText([
    'General',
    'AI',
    'Agents',
    'Members',
    'Connectors',
  ]);
  for (const link of await nav.getByRole('link').all()) await expect(link.locator('svg')).toHaveCount(1);
  const profile = nav.getByRole('link', { name: 'Profile' });
  await expect(profile).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current]')).toHaveCount(1);
  expect.soft(await styles(profile, ['height', 'font-size', 'font-weight', 'border-top-left-radius'])).toEqual({
    height: '28px',
    'font-size': '13px',
    'font-weight': '600',
    'border-top-left-radius': '6px',
  });
  expect.soft(await styles(nav.getByRole('link', { name: 'Sessions' }), ['font-weight'])).toEqual({
    'font-weight': '500',
  });

  // The head: a title of 20 px, its sentence, and « Sign out » at the right.
  const title = page.locator('main h1');
  await expect(title).toHaveText('Profile');
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '20px', 'font-weight': '600' });
  const lead = page.getByText('Your name on notes, your addresses and how you sign in.');
  expect.soft(await styles(lead, ['font-size', 'margin-top'])).toEqual({ 'font-size': '13px', 'margin-top': '6px' });
  expect.soft(await painted(lead, 'color')).toEqual(rgb(MOCKUP.muted));
  // 24 px under the bar, 32 px after the navigation.
  const head = await box(title);
  expect.soft(head.y - (await box(bar)).y - 48, 'the head under the bar').toBe(24);
  expect.soft(head.x - (await box(nav)).x - 220, 'the head after the navigation').toBe(32);
  const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
  await expect(signOut.locator('svg')).toHaveCount(1);
  const content = await box(title.locator('xpath=ancestor::header/..'));
  const out = await box(signOut);
  expect
    .soft(Math.abs(out.x + out.width - (content.x + content.width - 32)), '« Sign out » ends the head')
    .toBeLessThanOrEqual(1);

  // Four cards in two columns 16 px apart, as wide as the page (FRU-692).
  const cards = page.locator('main section.kit-settings-card');
  await expect(cards).toHaveCount(4);
  const named = ['Profile', 'Where you are signed in', 'Addresses', 'How you sign in'];
  for (const name of named) await expect(section(page, name), name).toBeVisible();
  const [left, right] = [await box(section(page, 'Profile')), await box(section(page, 'Addresses'))];
  expect.soft(Math.abs(left.width - right.width), 'the two columns are as wide').toBeLessThanOrEqual(1);
  expect.soft(Math.round(right.x - left.x - left.width), 'the gap of the columns').toBe(16);
  expect.soft(Math.abs(left.x - head.x), 'the first column starts the page').toBeLessThanOrEqual(1);
  expect
    .soft(Math.abs(right.x + right.width - (content.x + content.width - 32)), 'the second column ends the page')
    .toBeLessThanOrEqual(1);
  expect.soft(Math.round((await box(section(page, 'Where you are signed in'))).y - left.y - left.height)).toBe(16);
  expect.soft(Math.round((await box(section(page, 'How you sign in'))).x)).toBe(Math.round(right.x));
  expect
    .soft(await styles(cards.first(), ['border-top-width', 'border-top-left-radius']))
    .toEqual({ 'border-top-width': '1px', 'border-top-left-radius': '8px' });
  expect.soft(await painted(cards.first(), 'borderTopColor')).toEqual(rgb(MOCKUP.line));

  // Each card has a head of 44 px: an icon and its title, at 13 px, 600.
  for (const name of named) {
    const heading = section(page, name).getByRole('heading', { level: 2, name, exact: true });
    expect.soft(await styles(heading, ['font-size', 'font-weight']), name).toEqual({
      'font-size': '13px',
      'font-weight': '600',
    });
    expect.soft((await box(heading.locator('..'))).height, name).toBe(44);
    await expect(heading.locator('xpath=preceding-sibling::span//*[local-name()="svg"]'), name).toHaveCount(1);
  }

  // Every row of a card has an icon in a box of 24 px, a name at 600 and a line at 12 px (FRU-692).
  const rows = page.locator('main .kit-settings-row');
  await expect(rows).toHaveCount(9);
  for (const row of await rows.all()) {
    const icon = row.locator('div > span').first();
    expect.soft(await box(icon), (await row.textContent()) ?? '').toMatchObject({ width: 24, height: 24 });
    await expect(icon.locator('svg')).toHaveCount(1);
    expect.soft((await box(row)).height, (await row.textContent()) ?? '').toBeGreaterThanOrEqual(53);
  }
  const first = rows.first().locator('div > span').nth(1);
  expect.soft(await styles(first.locator('span').first(), ['font-weight'])).toEqual({ 'font-weight': '600' });
  expect.soft(await styles(first.locator('span').last(), ['font-size'])).toEqual({ 'font-size': '12px' });

  // The profile: the initial, the name and the address, then the name on the notes and the language.
  const card = section(page, 'Profile');
  const name = card.getByRole('textbox', { name: 'Name shown on notes' });
  await expect(name).toHaveValue('Ana');
  await expect(name).toBeEditable();
  await expect(card.getByText('ana@acme.dev')).toBeVisible();
  const language = card.getByRole('button', { name: /Language/ });
  await expect(language).toContainText('English');
  const fields = { name: await box(name), language: await box(language) };
  expect.soft(Math.abs(fields.name.y - fields.language.y), 'the two fields on one line').toBeLessThanOrEqual(1);
  expect.soft(Math.abs(fields.name.width - fields.language.width), 'the two fields are as wide').toBeLessThanOrEqual(1);

  // Where the console is signed in: this browser first, then the last ones, and « See all ».
  const where = section(page, 'Where you are signed in');
  const browsers = where.getByRole('listitem');
  await expect(browsers).toHaveCount(3);
  await expect(browsers.nth(0)).toContainText('Console · this browser');
  await expect(browsers.nth(0)).toContainText('This browser');
  await expect(browsers.nth(0).getByText('Active now', { exact: true })).toBeVisible();
  await expect(browsers.nth(0).getByRole('button')).toHaveCount(0);
  await expect(browsers.nth(1)).toContainText('Console · another browser');
  await expect(browsers.nth(1)).toContainText(/^Console · another browserUsed on Oct 13/);
  // The rare action of a row is in its menu: no underlined words (FRU-692).
  await expect(browsers.nth(1).getByRole('button', { name: 'More for Console · another browser' })).toBeVisible();
  await expect(where.getByRole('link', { name: 'See all 3' })).toHaveAttribute('href', '/w/w1/account/sessions');

  // The addresses: the primary one says so, each other one has its menu, and « Add » is in the head.
  const addresses = section(page, 'Addresses');
  await expect(addresses.getByRole('listitem')).toHaveCount(3);
  await expect(addresses.getByRole('listitem').nth(0).getByText('Primary', { exact: true })).toBeVisible();
  await expect(addresses.getByRole('button', { name: /^More for / })).toHaveCount(2);
  await expect(addresses.getByRole('button', { name: 'Add', exact: true })).toBeVisible();

  // How the person signs in: each way, linked or not, and what to do with it.
  const ways = section(page, 'How you sign in').getByRole('listitem');
  await expect(ways).toHaveCount(3);
  await expect(ways.nth(0)).toContainText('Email link');
  await expect(ways.nth(0)).toContainText('ana@acme.dev');
  await expect(ways.nth(0).getByText('Always on', { exact: true })).toBeVisible();
  await expect(ways.nth(1)).toContainText('Linked');
  await expect(ways.nth(1).getByRole('button', { name: 'Unlink GitHub' })).toHaveText('Unlink');
  await expect(ways.nth(2)).toContainText('Not linked');
  // A provider not linked is linked by a form that the worker answers (FRU-415: a `POST`, which no
  // other page of the site can send with the `Origin` of the console).
  const link = ways.nth(2).getByRole('button', { name: 'Link Google' });
  await expect(link).toHaveText('Link');
  await expect(link).toHaveAttribute('type', 'submit');
  const form = ways.nth(2).locator('form');
  await expect(form).toHaveAttribute('method', 'post');
  await expect(form).toHaveAttribute('action', 'http://localhost:8788/console/auth/link/google?workspace=w1');
  // The worker keeps no login of GitHub: « Linked », and not « Linked as ».
  await expect(page.getByText(/Linked as/)).toHaveCount(0);

  // No underlined words on the page (FRU-692): its actions are buttons and menus.
  const underlined = await page
    .locator('main a, main button')
    .evaluateAll((all) =>
      all.filter((each) => getComputedStyle(each).textDecorationLine === 'underline').map((each) => each.textContent),
    );
  expect.soft(underlined).toEqual([]);

  // Every text at 4.5:1 on the page.
  for (const text of [lead, ways.nth(0).getByText('Always on', { exact: true }), browsers.nth(1).getByText(/^Used/)]) {
    expect.soft(contrast(await painted(text, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(4.5);
  }
  await expectNoViolation(page, 'my account');
});

test('the cards are two columns from 1280 px, and one column under it (FRU-692)', async ({ page }) => {
  await workerWith(page);
  for (const [width, columns] of [
    [1280, 2],
    [1279, 1],
    [1024, 1],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const [profile, addresses] = [await box(section(page, 'Profile')), await box(section(page, 'Addresses'))];
    expect.soft(profile.y === addresses.y ? 2 : 1, `at ${width} px`).toBe(columns);
    expect.soft(await sideScroll(page), `at ${width} px`).toBe(0);
  }
});

test('« See all » opens « Sessions », which lists every browser and is the entry on screen', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  const worker = await workerWith(page);
  worker.extensions = EXTENSIONS;
  await open(page);
  const where = section(page, 'Where you are signed in');
  // Five browsers: the card of the profile shows the last three.
  await expect(where.getByRole('listitem')).toHaveCount(3);
  await where.getByRole('link', { name: 'See all 5' }).click();
  await expect(page).toHaveURL(/\/w\/w1\/account\/sessions$/);
  await expect(page.locator('main h1')).toHaveText('Sessions');
  await expect(where.getByRole('listitem')).toHaveCount(5);
  await expect(where.getByRole('link')).toHaveCount(0);
  const nav = page.getByRole('main').getByRole('navigation', { name: 'Settings', exact: true });
  await expect(nav.getByRole('link', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Profile' })).not.toHaveAttribute('aria-current');
  await expectNoViolation(page, 'the page « Sessions »');
});

test('a browser whose session ended elsewhere leaves the list, and is not said to be signed in', async ({ page }) => {
  const worker = await workerWith(page);
  await openSessions(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  await expect(browsers).toHaveCount(3);

  // Signed out from that browser, or from a third one, after this list was read: the worker
  // knows no session by this id. Nothing is left to end, and nothing to try again.
  worker.gone = true;
  worker.sessions = SESSIONS.filter((each) => each.id !== 'x2');
  await choose(browsers.nth(1), 'Disconnect');
  await expect(browsers).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(worker.sent).toEqual(['DELETE /console/sessions/x2']);
  await expect(browsers.nth(1)).toContainText(/Signed in Oct 2, 2026/);
});

test('a 404 for a browser that the list still names does not say that it is signed out', async ({ page }) => {
  const worker = await workerWith(page);
  await openSessions(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  await expect(browsers).toHaveCount(3);

  // A worker with no such route answers 404 too: the session is still in the list, so it did not end.
  worker.gone = true;
  await choose(browsers.nth(1), 'Disconnect');
  await expect(browsers.nth(1).getByRole('alert')).toHaveText(
    'This browser is still signed in: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(3);

  // And when the list cannot be read again, nothing is said to have ended either.
  worker.sessions = undefined;
  await choose(browsers.nth(1), 'Disconnect');
  await expect(browsers.nth(1).getByRole('alert')).toHaveText(
    'This browser is still signed in: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(3);
});

test('another browser is disconnected from its menu at once, and one that is still signed in says so', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await openSessions(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');

  // The worker did not end the session: the row stays, and says so.
  worker.refuses = true;
  await choose(browsers.nth(1), 'Disconnect');
  await expect(browsers.nth(1).getByRole('alert')).toHaveText(
    'This browser is still signed in: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(3);

  worker.refuses = false;
  await choose(browsers.nth(1), 'Disconnect');
  await expect(browsers).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // By its id, and the session of this browser is not the one that ended.
  expect(worker.sent).toEqual(['DELETE /console/sessions/x2', 'DELETE /console/sessions/x2']);
  await expect(browsers.nth(0)).toContainText('Console · this browser');
  await expect(browsers.nth(1)).toContainText(/Signed in Oct 2, 2026/);
});

test('a list of browsers that was not read is no list: it says so, and reads again', async ({ page }) => {
  const worker = await workerWith(page);
  worker.sessions = undefined;
  await page.goto(`${CONSOLE}/w/w1/account`);
  const where = section(page, 'Where you are signed in');
  await expect(where.getByRole('alert')).toHaveText(
    'The browsers where you are signed in did not load. Fruitback hit an error.',
  );
  await expect(where.getByRole('listitem')).toHaveCount(0);
  // The control of the count above: with an answer, the same reading finds the rows.
  worker.sessions = SESSIONS.slice(0, 1);
  await where.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(where.getByRole('listitem')).toHaveCount(1);
  await expect(where.getByRole('button')).toHaveCount(0);
});

for (const state of ['read', 'not read'] as const) {
  test(`« Sign out » keeps its place when the list of the browsers is ${state}, and a press across it is heard`, async ({
    page,
  }) => {
    const worker = await workerWith(page);
    worker.sessions = state === 'read' ? SESSIONS.slice(0, 1) : undefined;
    // The list is held: the screen is drawn without it, as on a slow line.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`${WORKER_ORIGIN}/console/sessions`, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`${CONSOLE}/w/w1/account`);
    const out = page.getByRole('button', { name: 'Sign out', exact: true });
    await expect(out).toBeVisible();
    await expect(section(page, 'Where you are signed in').getByText('Loading…')).toBeVisible();
    await expect(section(page, 'Addresses').getByRole('listitem')).toHaveCount(3);
    const before = await out.boundingBox();

    // The press starts before the list arrives, and ends after.
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    release();
    await expect(
      state === 'read'
        ? page.getByText('Console · this browser')
        : section(page, 'Where you are signed in').getByRole('alert'),
    ).toBeVisible();
    expect(await out.boundingBox()).toEqual(before);
    await page.mouse.up();

    await expect.poll(() => worker.sent).toContain('POST /console/auth/sign-out');
    await expect(page).toHaveURL(`${CONSOLE}/setup`);
  });
}

test('« Sign out everywhere » asks twice, and a sign-out that the worker did not confirm says so', async ({ page }) => {
  const worker = await workerWith(page);
  await openSessions(page);
  const everywhere = page.getByRole('button', { name: 'Sign out everywhere', exact: true });

  // The first press asks, in a dialog, sends nothing, and puts the keyboard on the way back.
  await everywhere.click();
  const group = page.getByRole('dialog').getByRole('group', { name: 'Sign out of every browser' });
  await expect(
    group.getByText(/Every browser where the console is signed in to your account is signed out/),
  ).toBeVisible();
  const stay = group.getByRole('button', { name: 'Stay signed in', exact: true });
  await expect(stay).toBeFocused();
  expect(worker.sent).toEqual([]);
  await expectNoViolation(page, 'the second time of « Sign out everywhere »');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(everywhere).toBeFocused();
  expect(worker.sent).toEqual([]);

  // Not confirmed by the worker: the person is not told that they are signed out, and stays.
  worker.refuses = true;
  await everywhere.click();
  await group.getByRole('button', { name: 'Sign out of every browser', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.',
  );
  await expect(page).toHaveURL(/\/account\/sessions$/);
  // « Sign out » is the action of the profile: the same.
  await open(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'You are still signed in: Fruitback did not confirm the sign-out. Try again.',
  );
  await expect(page).toHaveURL(/\/account$/);
  expect(worker.sent).toEqual(['POST /console/auth/revoke-sessions', 'POST /console/auth/sign-out']);
});

test('« My account » is about the person: the owner deletes the workspace from its settings (FRU-503)', async ({
  page,
}) => {
  await workerWith(page, 'owner');
  await open(page);
  await expect(page.locator('main section')).toHaveCount(4);
  await expect(page.getByText('Delete the workspace')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete workspace' })).toHaveCount(0);
});

for (const locale of ['en', 'fr'] as const) {
  for (const width of [390, 320]) {
    test(`at ${width} px nothing scrolls sideways, in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await workerWith(page, 'owner', locale);
      await page.goto(`${CONSOLE}/w/w1/account`);
      await expect(page.locator('main li').nth(4)).toBeVisible();
      expect.soft(await sideScroll(page), 'the screen').toBe(0);
      // The two fields are one under the other, each as wide as the card.
      const fields = page.locator('main section').first().locator('.kit-field');
      expect((await box(fields.nth(1))).y).toBeGreaterThan((await box(fields.nth(0))).y + 32);
      // The navigation of the settings is one row, which scrolls in its frame: the page does not.
      const nav = page.getByRole('main').getByRole('navigation');
      expect.soft((await box(nav)).width, 'the navigation').toBeLessThanOrEqual(width);
      await page.getByRole('button', { name: locale === 'en' ? 'Add' : 'Ajouter', exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect.soft(await sideScroll(page), 'the dialog that adds an address').toBe(0);
      if (width === 390) await expectNoViolation(page, `my account at ${width} px`);
      await page.keyboard.press('Escape');
      await page.goto(`${CONSOLE}/w/w1/account/sessions`);
      await page
        .getByRole('button', { name: locale === 'en' ? 'Sign out everywhere' : 'Se déconnecter partout', exact: true })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect.soft(await sideScroll(page), 'the second time of « Sign out everywhere »').toBe(0);
    });
  }
}

/**
 * The sessions, on a worker with accounts: the same person signs in in two browsers.
 */
test.describe('the browsers of a person, on a worker with accounts', () => {
  let worker: Worker;
  const contexts: BrowserContext[] = [];

  test.beforeEach(async () => {
    worker = await cloudWorker();
  });
  test.afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await finished(context, undefined);
      await context.close();
    }
    await worker.close();
  });

  /** Whether the worker still takes the cookie of a browser. */
  async function accepted(context: BrowserContext): Promise<number> {
    const cookie = (await context.cookies(`${worker.origin}/console/me`)).find((each) => each.name === SESSION_COOKIE);
    const answer = await fetch(`${worker.origin}/console/me`, {
      headers: { Origin: WORKER_CONSOLE, Cookie: `${SESSION_COOKIE}=${cookie?.value}` },
    });

    return answer.status;
  }

  /**
   * A browser of its own, signed in as `email` by the link of the mail, on the sites of the workspace.
   * The first one makes the workspace, named after the domain of the address (FRU-239).
   */
  async function browserOf(
    browser: import('@playwright/test').Browser,
    email: string,
  ): Promise<{ page: Page; context: BrowserContext }> {
    const context = await browser.newContext();
    contexts.push(context);
    await served(context, worker);
    const page = await context.newPage();
    const before = (await worker.sent()).length;
    await page.goto(`${WORKER_CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill(email);
    await page.getByRole('button', { name: 'Email me a link', exact: true }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(before + 1);
    const link = /http:\/\/\S+\/sign-in#\S+/.exec((await worker.sent()).at(-1) ?? '')?.[0];
    expect(link, 'no sign-in link in the message').toBeDefined();
    await page.goto(link as string);
    // The link is spent when the worker takes the cookie of this browser: the front door is asked after.
    await expect.poll(() => accepted(context)).toBe(200);
    // The setup is at its second step: the workspace is there, with no site yet.
    await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    const read = (await worker.received())
      .map((each) => /^\/console\/workspaces\/(ws_[0-9a-f]{20})\/sites$/.exec(each.path)?.[1])
      .filter((id) => id !== undefined);
    await page.goto(`${WORKER_CONSOLE}/w/${read.at(-1) as string}/sites`);
    await expect(page.getByRole('heading', { name: 'No site yet' })).toBeVisible();

    return { page, context };
  }

  /**
   * A page of the settings of the person in the workspace on screen: « Profile » (`account`) or
   * « Sessions » (`account/sessions`). The address names the workspace.
   */
  async function settingsOf(page: Page, path: 'account' | 'account/sessions'): Promise<void> {
    const workspace = /\/w\/(ws_[0-9a-f]{20})\//.exec(page.url())?.[1];
    expect(workspace, page.url()).toBeDefined();
    await page.goto(`${WORKER_CONSOLE}/w/${workspace as string}/${path}`);
    await expect(page.locator('main h1')).toBeVisible();
  }

  /** The next call of a browser: it adds a site, and the screen keeps what was typed. */
  async function nextCall(page: Page): Promise<void> {
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    await page.getByRole('button', { name: 'Add site', exact: true }).click();
  }

  /** The cookie of a browser, as the header of a call that the test makes for it. */
  async function cookieOf(context: BrowserContext): Promise<string> {
    const cookie = (await context.cookies(`${worker.origin}/console/me`)).find((each) => each.name === SESSION_COOKIE);

    return `${SESSION_COOKIE}=${cookie?.value}`;
  }

  /** What the worker answers the extension: its sites, and a new token for its refresh token. */
  async function extensionReads(session: { accessToken: string; refreshToken: string }) {
    const sites = await fetch(`${worker.origin}/session/sites`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    const refreshed = await fetch(`${worker.origin}/session/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    const next = (await refreshed.json()) as { accessToken?: string; refreshToken?: string };

    return { sites: sites.status, refresh: refreshed.status, next };
  }

  test('an extension connected to the account is listed, and « Disconnect » ends it on the worker', async ({
    browser,
  }) => {
    const first = await browserOf(browser, 'ana@acme.dev');
    const cookie = await cookieOf(first.context);
    const consoleCall = (path: string, method = 'GET', body?: unknown) =>
      fetch(`${worker.origin}${path}`, {
        method,
        headers: { Origin: WORKER_CONSOLE, Cookie: cookie, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // The extension asks (FRU-238), the console approves with the word and the account, the extension
    // claims its session.
    const asked = await fetch(`${worker.origin}/session/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ browser: 'Chrome on macOS' }),
    });
    expect(asked.status).toBe(201);
    const { request, claim, word } = (await asked.json()) as { request: string; claim: string; word: string };
    const me = (await (await consoleCall('/console/me')).json()) as { account: { id: string } };
    expect(
      (await consoleCall(`/console/connect/${request}/approve`, 'POST', { word, account: me.account.id })).status,
    ).toBe(200);
    const claimed = await fetch(`${worker.origin}/session/connect/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim }),
    });
    expect(claimed.status).toBe(200);
    const session = (await claimed.json()) as { accessToken: string; refreshToken: string };

    // « Sessions » lists it with the browsers of the console.
    await settingsOf(first.page, 'account/sessions');
    const browsers = first.page.getByRole('region', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(browsers).toHaveCount(2);
    const extension = browsers.filter({ hasText: 'Extension · Chrome on macOS' });
    await expect(extension).toContainText(/Connected \d+ \w+ · used (just now|\d+ min ago)/);

    // Disconnected from its menu, and a second press: the row goes, and the worker refuses its refresh.
    await choose(extension, 'Disconnect');
    await extension.getByRole('button', { name: 'Disconnect the extension in Chrome on macOS' }).click();
    await expect(browsers).toHaveCount(1);
    const refreshed = await fetch(`${worker.origin}/session/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    expect(refreshed.status).toBe(401);
    // The browser of the console is not the one that ended.
    expect(await accepted(first.context)).toBe(200);
  });

  test('the extension stays connected when My account disconnects a browser, and when it signs out everywhere', async ({
    browser,
  }) => {
    const first = await browserOf(browser, 'ana@acme.dev');
    const second = await browserOf(browser, 'ana@acme.dev');
    const workspace = /\/w\/(ws_[0-9a-f]{20})\//.exec(first.page.url())?.[1];
    expect(workspace).toBeDefined();

    // The extension is paired as the console pairs it: a code for this person in this workspace,
    // spent by the extension on `/session/pair` (FRU-100, FRU-92).
    const minted = await fetch(`${worker.origin}/console/workspaces/${workspace}/connect`, {
      method: 'POST',
      headers: { Origin: WORKER_CONSOLE, Cookie: await cookieOf(first.context), 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(minted.status).toBe(201);
    const { code } = (await minted.json()) as { code: string };
    const paired = await fetch(`${worker.origin}/session/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(paired.status).toBe(200);
    let session = (await paired.json()) as { accessToken: string; refreshToken: string };
    const before = await extensionReads(session);
    expect([before.sites, before.refresh]).toEqual([200, 200]);
    session = before.next as typeof session;

    // « Sessions » lists the browsers of the console only: the extension paired by a code is no row of it.
    await settingsOf(first.page, 'account/sessions');
    const browsers = first.page.getByRole('region', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(browsers).toHaveCount(2);

    // One browser disconnected: the extension reads its sites, and its session goes on.
    await choose(browsers.nth(1), 'Disconnect');
    await expect(browsers).toHaveCount(1);
    expect(await accepted(second.context)).toBe(401);
    const after = await extensionReads(session);
    expect([after.sites, after.refresh]).toEqual([200, 200]);
    session = after.next as typeof session;

    // Every browser signed out, this one too: the same.
    await first.page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    await first.page.getByRole('button', { name: 'Sign out of every browser', exact: true }).click();
    await expect(first.page).toHaveURL(/\/setup$/);
    expect(await accepted(first.context)).toBe(401);
    const last = await extensionReads(session);
    expect([last.sites, last.refresh]).toEqual([200, 200]);
  });

  test('one browser disconnects the other, which learns it at its next call; « Sign out everywhere » ends both', async ({
    browser,
  }) => {
    const first = await browserOf(browser, 'ana@acme.dev');
    const second = await browserOf(browser, 'ana@acme.dev');
    expect(await accepted(first.context)).toBe(200);
    expect(await accepted(second.context)).toBe(200);

    // The first browser lists both, itself first, and holds no token of either.
    await settingsOf(first.page, 'account/sessions');
    const browsers = first.page.getByRole('region', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(browsers).toHaveCount(2);
    // The worker names each browser by its user agent (FRU-249): the Chromium of the test, which
    // Playwright presents as « Desktop Chrome » (Windows) or as the machine it runs on.
    await expect(browsers.nth(0)).toContainText(/Console · Chrome on (Windows|macOS|Linux)/);
    await expect(browsers.nth(0)).toContainText('This browser');
    await expect(browsers.nth(1)).toContainText(/Console · Chrome on (Windows|macOS|Linux)/);

    // It disconnects the other one from its menu, at once, and the row goes.
    await choose(browsers.nth(1), 'Disconnect');
    await expect(browsers).toHaveCount(1);
    expect(await accepted(second.context)).toBe(401);
    // Its own session is not the one that ended.
    expect(await accepted(first.context)).toBe(200);

    // The other browser learns it at its next call: the banner, and what was typed stays.
    await nextCall(second.page);
    await expect(second.page.getByRole('alert').filter({ hasText: 'Your session ended' })).toBeVisible();
    await expect(second.page.getByRole('textbox', { name: 'Site address' })).toHaveValue('staging.acme.dev');

    // A third browser signs in. « Sign out everywhere » from the first ends every one of them.
    const third = await browserOf(browser, 'ana@acme.dev');
    await first.page.reload();
    await expect(browsers).toHaveCount(2);
    await first.page.getByRole('button', { name: 'Sign out everywhere', exact: true }).click();
    await first.page.getByRole('button', { name: 'Sign out of every browser', exact: true }).click();
    await expect(first.page).toHaveURL(/\/setup$/);
    expect(await accepted(first.context)).toBe(401);
    expect(await accepted(third.context)).toBe(401);
    await nextCall(third.page);
    await expect(third.page.getByRole('alert').filter({ hasText: 'Your session ended' })).toBeVisible();
  });

  test('an address is added by its link, becomes the primary one, and the one of before goes (FRU-450)', async ({
    browser,
  }) => {
    const { page } = await browserOf(browser, 'ana@acme.dev');
    await settingsOf(page, 'account');
    const addresses = section(page, 'Addresses');
    await expect(addresses.getByRole('listitem')).toHaveCount(1);

    // The link goes to the new address, and names the account that asked.
    await addresses.getByRole('button', { name: 'Add', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add an address' });
    await dialog.getByRole('textbox', { name: 'Address' }).fill('ana@home.test');
    await dialog.getByRole('button', { name: 'Send a link' }).click();
    await expect(
      addresses.getByRole('status').filter({ hasText: 'Fruitback sent a link to ana@home.test.' }),
    ).toBeVisible();
    const message = (await worker.mail()).at(-1);
    expect(message?.to).toBe('ana@home.test');
    const link = /http:\/\/\S+\/verify-email#\S+/.exec(message?.text ?? '')?.[0];
    expect(link, 'no link of verification in the message').toBeDefined();
    const account = page.url();

    // Opened in this browser, the address is added.
    await page.goto(link as string);
    await expect(page.getByRole('heading', { name: 'Address added' })).toBeVisible();
    await page.goto(account);
    await expect(addresses.getByRole('listitem')).toHaveCount(2);
    await expect(addresses.getByRole('listitem').nth(1)).toContainText('Verified by Fruitback');

    // It becomes the primary one: both addresses get an alert.
    await choose(addresses.getByRole('listitem').nth(1), 'Make primary');
    await expect(
      addresses.getByRole('status').filter({ hasText: 'ana@home.test is your primary address now.' }),
    ).toBeVisible();
    await expect(section(page, 'Profile').getByText('ana@home.test')).toBeVisible();
    const alerts = (await worker.mail())
      .slice(-2)
      .map((each) => each.to)
      .toSorted();
    expect(alerts).toEqual(['ana@acme.dev', 'ana@home.test']);

    // The address of before goes, from its menu and a second press.
    const before = addresses.getByRole('listitem').filter({ hasText: 'ana@acme.dev' });
    await choose(before, 'Remove');
    await before.getByRole('button', { name: 'Remove ana@acme.dev' }).click();
    await expect(addresses.getByRole('listitem')).toHaveCount(1);
    await expectNoViolation(page, 'the addresses on a worker with accounts');
  });
});

test('the name is kept when the field is left, and a refusal keeps what was typed', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const name = section(page, 'Profile').getByRole('textbox', { name: 'Name shown on notes' });
  // Left with nothing changed: nothing is sent.
  await name.focus();
  await page.keyboard.press('Tab');
  expect(worker.sent.filter((each) => each.endsWith('/me/name'))).toEqual([]);

  worker.nameRefuses = 'invalid-name';
  await name.fill('Ana Lopez');
  await page.keyboard.press('Tab');
  await expect(section(page, 'Profile').getByRole('alert')).toHaveText('A name is one line of 1 to 80 characters.');
  await expect(name).toHaveValue('Ana Lopez');

  worker.nameRefuses = undefined;
  await name.focus();
  await page.keyboard.press('Enter');
  await expect(section(page, 'Profile').getByRole('alert')).toHaveCount(0);
  expect(worker.bodies['/console/me/name']).toEqual({ name: 'Ana Lopez' });
  await expect(name).toHaveValue('Ana Lopez');
});

test('« Unlink » asks twice, and the last way to sign in stays and says why', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const github = section(page, 'How you sign in').getByRole('listitem').nth(1);
  worker.unlinkRefuses = 'last-sign-in';
  // « Unlink » shows the second time under its row: a button that names the provider.
  await github.getByRole('button', { name: 'Unlink GitHub' }).click();
  await expect(github.getByRole('group', { name: 'Unlink GitHub' })).toBeVisible();
  expect(worker.sent).toEqual([]);
  await github.getByRole('button', { name: 'Unlink GitHub' }).click();
  await expect(github.getByRole('alert')).toHaveText('This is the last way you sign in here: link another one first.');
  // A code of the worker that names a property of every object reads as a refusal it does not name.
  worker.unlinkRefuses = 'constructor';
  await github.getByRole('button', { name: 'Unlink GitHub' }).click();
  await expect(github.getByRole('alert')).toHaveText('GitHub is still linked. Try again.');
  await expect(github).toContainText('Linked');

  // The second time is still there: pressed again, once the worker takes it.
  worker.unlinkRefuses = undefined;
  await github.getByRole('button', { name: 'Unlink GitHub' }).click();
  await expect(github).toContainText('Not linked');
  await expect(github.getByRole('button', { name: 'Link GitHub' })).toBeVisible();
  expect(worker.sent.filter((each) => each.includes('/me/sign-in/'))).toEqual([
    'DELETE /console/me/sign-in/github',
    'DELETE /console/me/sign-in/github',
    'DELETE /console/me/sign-in/github',
  ]);
});

test('the way back of a link says what happened, once', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/account?linked=google`);
  await expect(page.getByRole('status').filter({ hasText: 'Google is linked to your account.' })).toBeVisible();
  // Said once: the address loses it, and a reload says nothing.
  await expect(page).toHaveURL(/\/w\/w1\/account$/);
  await page.reload();
  await expect(page.getByText('Console · this browser')).toBeVisible();
  await expect(page.getByText('Google is linked to your account.')).toHaveCount(0);

  // A refusal names the provider and the address of the account, and says what to do (FRU-416).
  // `email_does_not_match` is the code of better-auth 1.7.7: on `main` it read as an unknown code.
  const refusal = section(page, 'How you sign in').getByRole('alert');
  for (const [query, sentence] of [
    [
      'provider=google&error=email_does_not_match',
      'Your Google account does not have the address ana@acme.dev. Fruitback links only a Google account that has the address of your account. In Google, choose the account ana@acme.dev, or keep signing in as you do now.',
    ],
    [
      "provider=google&error=email_doesn't_match",
      'Your Google account does not have the address ana@acme.dev. Fruitback links only a Google account that has the address of your account. In Google, choose the account ana@acme.dev, or keep signing in as you do now.',
    ],
    [
      'provider=google&error=account_already_linked_to_different_user',
      'This Google account already opens another Fruitback account. To link it here, that account must unlink it first, or an administrator of this instance must delete that account.',
    ],
    [
      'provider=github&error=email_not_verified',
      'GitHub did not say that its address is verified. Verify it at GitHub, then link again.',
    ],
    // better-auth 1.7.7 says an address that GitHub did not verify with this code, and a write that
    // failed too: the sentence names both causes.
    [
      'provider=github&error=unable_to_link_account',
      'GitHub was not linked. If GitHub has not verified the address of that account, verify it there. Then link again.',
    ],
    [
      'provider=github&error=identity_required',
      'Your session ended before GitHub was linked. Sign in, then link again.',
    ],
    // FRU-415: the conditions of a provider of another address.
    [
      'provider=github&error=email_not_found',
      'GitHub gave no address for that account. Fruitback links only an account whose address GitHub verified. Add one at GitHub, then link again.',
    ],
    [
      'provider=google&error=email_already_used',
      'The address of this Google account is the one of another Fruitback account. Fruitback never joins two accounts: link it from that account, or choose another Google account.',
    ],
    [
      'provider=google&error=provider_already_linked',
      'A Google account is already linked here. Unlink it first, then link the other one.',
    ],
    ['provider=google&error=link_not_started', 'Google was not linked. Try again.'],
    // A refusal that this build does not know: no « Try again », which would not help.
    ['provider=google&error=access_denied', 'Google was not linked.'],
    // A failure on the way: trying again can work.
    ['provider=google&error=internal_server_error', 'Google was not linked. Try again.'],
    // Codes and providers of the address that name a property of every object, or nothing known.
    ['provider=google&error=constructor', 'Google was not linked.'],
    ['provider=gitlab&error=email_does_not_match', 'The account was not linked.'],
    ['provider=constructor&error=email_does_not_match', 'The account was not linked.'],
    ['error=email_does_not_match', 'The account was not linked.'],
  ] as const) {
    await page.goto(`${CONSOLE}/w/w1/account?${query}`);
    await expect(refusal, query).toHaveText(sentence);
    await expect(page, query).toHaveURL(/\/w\/w1\/account$/);
  }
});

test('a refused link stays said until the next gesture, in French too', async ({ page }) => {
  const worker = await workerWith(page, 'owner', 'fr');
  await page.goto(`${CONSOLE}/w/w1/account?provider=google&error=email_does_not_match`);
  const ways = section(page, 'Comment vous vous connectez');
  await expect(ways.getByRole('alert')).toHaveText(
    'Votre compte Google n’a pas l’adresse ana@acme.dev. Fruitback ne lie qu’un compte Google qui a l’adresse de votre compte. Dans Google, choisissez le compte ana@acme.dev, ou continuez de vous connecter comme aujourd’hui.',
  );
  // The address is clean, and the sentence is still there after the worker answered everything.
  await expect(page).toHaveURL(/\/w\/w1\/account$/);
  await expect(page.getByText('Console · ce navigateur')).toBeVisible();
  await expect(ways.getByRole('alert')).toHaveCount(1);

  // The next gesture takes it away.
  worker.unlinkRefuses = undefined;
  const github = ways.getByRole('listitem').nth(1);
  await github.getByRole('button', { name: 'Délier GitHub' }).click();
  await github.getByRole('button', { name: 'Délier GitHub' }).click();
  await expect(github).toContainText('Non lié');
  await expect(ways.getByRole('alert')).toHaveCount(0);
});

test('a provider is « Not set up » when the worker has none, and the three rows are there before it answers', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.methods = { email: false };
  await open(page);
  const ways = section(page, 'How you sign in').getByRole('listitem');
  await expect(ways).toHaveCount(3);
  await expect(ways.nth(0)).toContainText('Not sent by this Fruitback');
  await expect(ways.nth(1)).toContainText('Not set up');
  await expect(ways.nth(2)).toContainText('Not set up');
  await expect(section(page, 'How you sign in').getByRole('link')).toHaveCount(0);
  await expect(section(page, 'How you sign in').getByRole('button', { name: /^Link / })).toHaveCount(0);
});

test('« Link » asks to confirm the provider account on the way back, then the provider is in the list (FRU-415)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  const signIn = section(page, 'How you sign in');
  const google = signIn.getByRole('listitem').nth(2);
  await expect(google).toContainText('Not linked');

  // The form goes to the worker by a POST, and comes back with the question: nothing is linked yet.
  await google.getByRole('button', { name: 'Link Google' }).click();
  const question = signIn.getByRole('region', {
    name: 'Link the Google account ana.perso@gmail.test to your Fruitback account?',
  });
  await expect(question).toBeVisible();
  await expect(question).toContainText(
    'It will open this account, as your email link does. Fruitback sends a message to ana@acme.dev to say so.',
  );
  await expect(page).toHaveURL(/\/w\/w1\/account$/);
  await expect(google).toContainText('Not linked');
  expect(worker.sent).toEqual(['POST /console/auth/link/google']);
  await expectNoViolation(page, 'the question of a link');
  // At 390 px the question wraps, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  expect.soft(await sideScroll(page), 'the question at 390 px').toBe(0);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Yes: the worker links it, and the list says so.
  await question.getByRole('button', { name: 'Link this account' }).click();
  await expect(signIn.getByRole('status').filter({ hasText: 'Google is linked to your account.' })).toBeVisible();
  await expect(question).toHaveCount(0);
  await expect(google).toContainText('Linked');
  await expect(google.getByRole('button', { name: 'Unlink Google' })).toBeVisible();
  expect(worker.sent).toEqual(['POST /console/auth/link/google', 'POST /console/me/sign-in/pending']);

  // A reload asks nothing again: the address lost `?confirm=`.
  await page.reload();
  await expect(page.getByText('Console · this browser')).toBeVisible();
  await expect(signIn.getByRole('region')).toHaveCount(0);
});

test('« Cancel » links nothing; a refusal or a link that expired says what to do, in French too (FRU-415)', async ({
  page,
}) => {
  const worker = await workerWith(page, 'owner', 'fr');
  await page.goto(`${CONSOLE}/w/w1/account`);
  await expect(page.getByText('Console · ce navigateur')).toBeVisible();
  const ways = section(page, 'Comment vous vous connectez');
  const google = ways.getByRole('listitem').nth(2);
  const question = ways.getByRole('region', {
    name: 'Lier le compte Google ana.perso@gmail.test à votre compte Fruitback ?',
  });

  // Cancel: the worker forgets it, and Google stays unlinked.
  await google.getByRole('button', { name: 'Lier Google' }).click();
  await expect(question).toContainText('Fruitback envoie un message à ana@acme.dev pour le dire.');
  await question.getByRole('button', { name: 'Annuler' }).click();
  await expect(ways.getByRole('status').filter({ hasText: 'Google n’a pas été lié.' })).toBeVisible();
  await expect(google).toContainText('Non lié');
  expect(worker.sent.at(-1)).toBe('DELETE /console/me/sign-in/pending');

  // The worker refuses at the confirmation: the address is another account's. The sentence says so.
  worker.confirmRefuses = 'email_already_used';
  await google.getByRole('button', { name: 'Lier Google' }).click();
  await question.getByRole('button', { name: 'Lier ce compte' }).click();
  await expect(ways.getByRole('alert')).toHaveText(
    'L’adresse de ce compte Google est celle d’un autre compte Fruitback. Fruitback ne réunit jamais deux comptes : liez-le depuis cet autre compte, ou choisissez un autre compte Google.',
  );
  await expect(google).toContainText('Non lié');

  // Back on `?confirm=` with no link that waits: it expired, or another tab answered it.
  await page.goto(`${CONSOLE}/w/w1/account?confirm=google`);
  await expect(ways.getByRole('alert')).toHaveText(
    'La liaison de Google a trop attendu, ou a reçu une réponse dans un autre onglet. Liez Google à nouveau.',
  );
  await expect(question).toHaveCount(0);
  await expect(page).toHaveURL(/\/w\/w1\/account$/);

  // A provider that is not in the list asks nothing.
  await page.goto(`${CONSOLE}/w/w1/account?confirm=constructor`);
  await expect(page.getByText('Console · ce navigateur')).toBeVisible();
  await expect(ways.getByRole('region')).toHaveCount(0);
});

/** Noon of a fixed day: « used 2 h ago » is read on a clock of the browser set there. */
const NOON = new Date(2026, 9, 13, 12, 0, 0);
const EXTENSIONS = [
  {
    id: 'e1',
    browser: 'Chrome on macOS',
    connectedAt: new Date(2026, 9, 12, 9, 0).toISOString(),
    usedAt: new Date(NOON.getTime() - 2 * 3_600_000).toISOString(),
  },
  {
    id: 'e2',
    browser: 'Firefox on Linux',
    connectedAt: new Date(2026, 9, 2, 9, 0).toISOString(),
    usedAt: new Date(2026, 9, 10, 9, 0).toISOString(),
  },
];

test('the browsers of the extension are rows of the list, as the mockup draws them', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  const worker = await workerWith(page);
  worker.extensions = EXTENSIONS;
  await openSessions(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  // This browser first, then the others, of the console and of the extension, the one used last first
  // (FRU-692: the mockup mixes them).
  await expect(browsers).toHaveCount(5);
  await expect(browsers.first()).toContainText('Console · this browser');
  const chrome = browsers.filter({ hasText: 'Extension · Chrome on macOS' });
  const firefox = browsers.filter({ hasText: 'Extension · Firefox on Linux' });
  await expect(chrome).toContainText('Connected 12 Oct · used 2 h ago');
  await expect(firefox).toContainText('Connected 2 Oct · used 3 days ago');
  const order = await browsers.evaluateAll((rows) => rows.map((row) => row.textContent ?? ''));
  expect(order.findIndex((text) => text.includes('Chrome on macOS'))).toBeLessThan(
    order.findIndex((text) => text.includes('Firefox on Linux')),
  );
  // The row is the one of the console: its title at 600, its line at 12 px, its icon a piece of a puzzle.
  expect.soft(await styles(chrome.getByText('Extension · Chrome on macOS'), ['font-weight'])).toEqual({
    'font-weight': '600',
  });
  expect.soft(await styles(chrome.getByText(/^Connected/), ['font-size'])).toEqual({ 'font-size': '12px' });
  await expect(chrome.locator('[data-settings-icon="extension"]')).toHaveCount(1);
  await expectNoViolation(page, 'the browsers of the extension');
});

test('an extension is disconnected from its menu and a second press, and one still connected says so', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOON);
  const worker = await workerWith(page);
  worker.extensions = EXTENSIONS;
  await openSessions(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  const chrome = browsers.filter({ hasText: 'Extension · Chrome on macOS' });

  worker.extensionRefuses = true;
  await choose(chrome, 'Disconnect');
  expect(worker.sent).toEqual([]);
  await expect(chrome).toContainText('It stops showing notes at once.');
  await chrome.getByRole('button', { name: 'Disconnect the extension in Chrome on macOS' }).click();
  await expect(chrome.getByRole('alert')).toHaveText(
    'This extension is still connected: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(5);

  worker.extensionRefuses = false;
  await chrome.getByRole('button', { name: 'Disconnect the extension in Chrome on macOS' }).click();
  await expect(browsers).toHaveCount(4);
  await expect(page.getByText('Extension · Chrome on macOS')).toHaveCount(0);
  expect(worker.sent.filter((each) => each.includes('/me/browsers/'))).toEqual([
    'DELETE /console/me/browsers/e1',
    'DELETE /console/me/browsers/e1',
  ]);
});

test('a list of the extension that was not read leaves the browsers of the console, and says so', async ({ page }) => {
  const worker = await workerWith(page);
  worker.extensions = undefined;
  await page.goto(`${CONSOLE}/w/w1/account/sessions`);
  const where = section(page, 'Where you are signed in');
  // The browsers of the console are there, with their menu.
  await expect(where.getByRole('listitem').filter({ hasText: 'Console · this browser' })).toBeVisible();
  await expect(where.getByRole('button', { name: /^More for Console/ })).toHaveCount(2);
  // And a line says what is missing, with the way to read it again.
  await expect(where.getByRole('alert')).toHaveText(
    'The browsers of the extension did not load. Fruitback hit an error.',
  );
  worker.extensions = EXTENSIONS;
  await where.getByRole('button', { name: 'Try again' }).click();
  await expect(where.getByText('Extension · Chrome on macOS')).toBeVisible();
  await expect(where.getByRole('alert')).toHaveCount(0);
});

test('a browser is named as the worker names it', async ({ page }) => {
  const worker = await workerWith(page);
  worker.sessions = [
    { ...SESSIONS[0], browser: 'Firefox on macOS' },
    { ...SESSIONS[1], browser: 'Chrome on Windows' },
    { ...SESSIONS[2], browser: 'A browser' },
  ];
  await page.goto(`${CONSOLE}/w/w1/account/sessions`);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  await expect(browsers.nth(0)).toContainText('Console · Firefox on macOS');
  await expect(browsers.nth(0)).toContainText('This browser');
  await expect(browsers.nth(1)).toContainText('Console · Chrome on Windows');
  // One the worker could not name reads as before.
  await expect(browsers.nth(2)).toContainText('Console · another browser');
});

test('a name on its way is sent once, though the field is left before the answer', async ({ page }) => {
  const worker = await workerWith(page);
  worker.nameWaits = true;
  await open(page);
  const name = section(page, 'Profile').getByRole('textbox', { name: 'Name shown on notes' });
  await name.fill('Ana Lopez');
  await page.keyboard.press('Enter');
  // Left while the worker has not answered: nothing more is sent.
  await page.keyboard.press('Tab');
  await expect.poll(() => worker.sent.filter((each) => each.endsWith('/me/name')).length).toBe(1);
  await page.waitForTimeout(300);
  expect(worker.sent.filter((each) => each.endsWith('/me/name'))).toHaveLength(1);
  worker.release?.();
  await expect(name).toHaveValue('Ana Lopez');
});

test('what is typed while a name is on its way stays in the field, and leaves after it', async ({ page }) => {
  const worker = await workerWith(page);
  worker.nameWaits = true;
  await open(page);
  const name = section(page, 'Profile').getByRole('textbox', { name: 'Name shown on notes' });
  await name.fill('Ana Lopez');
  await page.keyboard.press('Enter');
  await expect.poll(() => worker.sent.filter((each) => each.endsWith('/me/name')).length).toBe(1);
  // Typed while the worker has not answered.
  await name.fill('Ana López');
  worker.nameWaits = false;
  worker.release?.();
  // The answer to the first name does not write over the second, which leaves in its turn.
  await expect.poll(() => worker.sent.filter((each) => each.endsWith('/me/name')).length).toBe(2);
  expect(worker.bodies['/console/me/name']).toEqual({ name: 'Ana López' });
  await expect(name).toHaveValue('Ana López');
});

test('what is typed while a refused name is on its way is sent after the refusal', async ({ page }) => {
  const worker = await workerWith(page);
  worker.nameWaits = true;
  worker.nameWaitsRefused = true;
  await open(page);
  const name = section(page, 'Profile').getByRole('textbox', { name: 'Name shown on notes' });
  await name.fill('Ana Lopez');
  await page.keyboard.press('Enter');
  await expect.poll(() => worker.sent.filter((each) => each.endsWith('/me/name')).length).toBe(1);
  // Typed, and the field left, while the worker has not answered.
  await name.fill('Ana López');
  await page.keyboard.press('Tab');
  worker.nameWaits = false;
  worker.release?.();
  // The first is refused; the newer text leaves in its turn, and the worker keeps it.
  await expect.poll(() => worker.sent.filter((each) => each.endsWith('/me/name')).length).toBe(2);
  expect(worker.bodies['/console/me/name']).toEqual({ name: 'Ana López' });
  await expect(name).toHaveValue('Ana López');
  await expect(section(page, 'Profile').getByRole('alert')).toHaveCount(0);
});

test('the line of a list of the extension that was not read goes when a later read succeeds', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  const worker = await workerWith(page);
  worker.extensions = EXTENSIONS;
  await openSessions(page);
  const where = section(page, 'Where you are signed in');
  const disconnect = async (name: string) => {
    const row = where.getByRole('listitem').filter({ hasText: `Extension · ${name}` });
    await choose(row, 'Disconnect');
    await row.getByRole('button', { name: `Disconnect the extension in ${name}` }).click();
  };
  // Chrome ended elsewhere (404), and the list cannot be read again: the line says so.
  worker.extensionGone = true;
  worker.extensions = undefined;
  await disconnect('Chrome on macOS');
  await expect(where.getByRole('alert')).toHaveText(
    'The browsers of the extension did not load. Fruitback hit an error.',
  );
  // Firefox ended elsewhere too, and the list is read: the rows are the worker's, and the line goes.
  worker.extensions = [];
  await disconnect('Firefox on Linux');
  await expect(where.getByText(/^Extension ·/)).toHaveCount(0);
  await expect(where.getByRole('alert')).toHaveCount(0);
});

test('the addresses of the account: the primary one, the others, and what each one can do (FRU-450)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  const addresses = section(page, 'Addresses');
  const rows = addresses.getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('ana@acme.dev');
  await expect(rows.nth(0)).toContainText('Primary · on your notes and in the messages of Fruitback');
  await expect(rows.nth(0).getByRole('button')).toHaveCount(0);
  // An address that a linked provider gives is not removed here: its provider is unlinked.
  await expect(rows.nth(1)).toContainText('From GitHub');
  await rows.nth(1).getByRole('button', { name: 'More for ana.perso@gmail.test' }).click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Make primary']);
  await page.keyboard.press('Escape');
  await expect(rows.nth(2)).toContainText('Verified by Fruitback');
  await rows.nth(2).getByRole('button', { name: 'More for ana@home.test' }).click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Make primary', 'Remove']);
  await page.keyboard.press('Escape');
  await expectNoViolation(page, 'the addresses');

  // « Add » opens a dialog. An address of another account: the refusal says so, and keeps what was typed.
  await addresses.getByRole('button', { name: 'Add', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add an address' });
  const field = dialog.getByRole('textbox', { name: 'Address' });
  worker.addRefuses = 'email-taken';
  await field.fill('bob@acme.dev');
  await dialog.getByRole('button', { name: 'Send a link' }).click();
  await expect(
    dialog.getByText('This address is the one of another Fruitback account.', { exact: false }),
  ).toBeVisible();
  await expect(field).toHaveValue('bob@acme.dev');
  await expectNoViolation(page, 'the dialog that adds an address');
  // Closed and opened again, what was typed is still there.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await addresses.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(field).toHaveValue('bob@acme.dev');
  // Accepted: the link goes, the dialog closes, and the address is added once the link is opened.
  worker.addRefuses = undefined;
  await field.fill('Ana@Work.test');
  await dialog.getByRole('button', { name: 'Send a link' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    addresses.getByRole('status').filter({ hasText: 'Fruitback sent a link to ana@work.test.' }),
  ).toBeVisible();
  expect(worker.bodies['/console/me/emails']).toEqual({ email: 'Ana@Work.test' });

  // Another address becomes the primary one: the page says it, and the profile names it.
  await choose(rows.nth(2), 'Make primary');
  await expect(
    addresses.getByRole('status').filter({ hasText: 'ana@home.test is your primary address now.' }),
  ).toBeVisible();
  await expect(rows.nth(2)).toContainText('Primary · on your notes');
  await expect(section(page, 'Profile').getByText('ana@home.test')).toBeVisible();
  expect(worker.bodies['/console/me/emails/primary']).toEqual({ email: 'ana@home.test', workspace: 'w1' });

  // « Remove » asks twice: in the menu, then under the row.
  await choose(rows.nth(0), 'Remove');
  expect(worker.sent.filter((each) => each.startsWith('DELETE'))).toEqual([]);
  await rows.nth(0).getByRole('button', { name: 'Remove ana@acme.dev' }).click();
  await expect(rows).toHaveCount(2);
  expect(worker.sent).toContain(`DELETE /console/me/emails/${encodeURIComponent('ana@acme.dev')}`);

  // At 390 px nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  expect.soft(await sideScroll(page), 'the addresses at 390 px').toBe(0);
  await expectNoViolation(page, 'the addresses at 390 px');
});

test('a refusal of an address says why, in French too (FRU-450)', async ({ page }) => {
  const worker = await workerWith(page, 'owner', 'fr');
  await page.goto(`${CONSOLE}/w/w1/account`);
  const addresses = section(page, 'Adresses');
  await expect(addresses.getByRole('listitem')).toHaveCount(3);
  worker.addressRefuses = 'sign-in-again';
  await choose(addresses.getByRole('listitem').nth(2), 'Rendre principale');
  await expect(addresses.getByText(/Reconnectez-vous d’abord\u202F: l’adresse principale/)).toBeVisible();
  await expect(addresses.getByRole('listitem').nth(0)).toContainText('ana@acme.dev');
});

test('a worker that sends no e-mail adds no address by hand, and says so (FRU-450)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.canAdd = false;
  await open(page);
  const addresses = section(page, 'Addresses');
  await expect(
    addresses.getByText('This Fruitback sends no email: an address is added by a linked provider only.'),
  ).toBeVisible();
  await expect(addresses.getByRole('button', { name: 'Add', exact: true })).toHaveCount(0);
});

test.describe('the link that adds an address (FRU-450)', () => {
  async function landing(page: Page, status: number, json: unknown) {
    const asked: unknown[] = [];
    await stubWorker(page, {
      answer: (pathname, route) => {
        if (pathname !== '/console/me/emails/verify') return undefined;
        asked.push(route.request().postDataJSON());

        return route.fulfill({ status, json });
      },
    });

    return asked;
  }

  test('adds the address in this browser, and takes the code out of the address bar', async ({ page }) => {
    const asked = await landing(page, 200, { email: 'ana@home.test' });
    await page.goto(`${CONSOLE}/verify-email#a-code-of-forty-three-characters-0123456789x`);
    await expect(page.getByRole('heading', { name: 'Address added' })).toBeVisible();
    await expect(page.getByText('ana@home.test is now an address of your account.', { exact: false })).toBeVisible();
    expect(asked).toEqual([{ token: 'a-code-of-forty-three-characters-0123456789x' }]);
    expect(new URL(page.url()).hash).toBe('');
    const results = await new AxeBuilder({ page }).analyze();
    expect.soft(results.violations.map((violation) => violation.id)).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect.soft(await sideScroll(page)).toBe(0);
  });

  test('asks to sign in first when this browser is not, and spends nothing', async ({ page }) => {
    await landing(page, 401, { error: 'identity-required' });
    await page.goto(`${CONSOLE}/verify-email#a-code-of-forty-three-characters-0123456789x`);
    await expect(page.getByRole('heading', { name: 'Sign in first' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  });

  test('says that a link spent, too old or of another account does not work, in French too', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('fruitback:locale', 'fr'));
    await landing(page, 404, { error: 'link-spent-or-expired' });
    await page.goto(`${CONSOLE}/verify-email#a-code-of-forty-three-characters-0123456789x`);
    await expect(page.getByRole('heading', { name: 'Ce lien ne fonctionne pas' })).toBeVisible();
  });
});

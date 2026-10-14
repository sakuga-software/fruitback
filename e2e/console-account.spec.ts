import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import {
  CONSOLE as WORKER_CONSOLE,
  SESSION_COOKIE,
  type Worker,
  cloudWorker,
  finished,
  served,
} from './cloud-worker.ts';
import {
  ACME,
  MOCKUP_FONT,
  type Role,
  box,
  contrast,
  expectBox,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';

/**
 * My account (FRU-248), measured in a browser against screen 13 of the mockup of 2026-10-13, with
 * what the worker of today does: the profile, how the person signs in, the browsers where the
 * console is signed in, and the two ways out.
 *
 * First the screen, with a worker answered by stubs: the values read in the code of the mockup
 * (`13-console-my-account.html`) and its boxes at 1440 px (a box is compared where the font is the
 * one of the mockup). Then the sessions, against a worker whose accounts are in PostgreSQL (PGlite):
 * no stub decides that a session ended.
 */
const CONSOLE = 'http://localhost:5178';

const MUTED = '#6b6b74';
const LINE = '#e4e4e7';
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
  /** How the person signs in (FRU-249); `undefined`: the worker does not answer. */
  methods: Record<string, unknown> | undefined;
  /** What the worker answers to « Unlink », and to a name, when it refuses. */
  unlinkRefuses?: string;
  nameRefuses?: string;
  /** The answer to a name is held until `release` is called. */
  nameWaits?: boolean;
  release?: () => void;
  sent: string[];
  /** The bodies the console sent, by path. */
  bodies: Record<string, unknown>;
};

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Stubbed> {
  const worker: Stubbed = {
    sessions: SESSIONS,
    refuses: false,
    gone: false,
    methods: { email: true, github: { linked: true }, google: { linked: false } },
    extensions: [],
    extensionRefuses: false,
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
    if (pathname === '/console/me/name') {
      const body = route.request().postDataJSON() as { name: string };
      worker.sent.push(`${method} ${pathname}`);
      worker.bodies[pathname] = body;
      if (worker.nameRefuses !== undefined) return route.fulfill({ status: 400, json: { error: worker.nameRefuses } });
      if (worker.nameWaits) {
        return new Promise<void>((resolve) => {
          worker.release = () =>
            void route
              .fulfill({ json: { account: { id: 'a1', email: 'ana@acme.dev', name: body.name } } })
              .then(resolve);
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

test('the screen is the one of the mockup, with what the worker of today does', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await expect(page.locator('main h1')).toHaveText('My account');
  await expect(page.getByText('Your name on notes, how you sign in, and where.')).toBeVisible();

  // Four sections of the mockup, each named by its title, 40 px apart; and the one it does not draw.
  const sections = page.locator('main section');
  await expect(sections).toHaveCount(5);
  for (const name of ['Profile', 'How you sign in', 'Where you are signed in', 'Sign out', 'Delete the workspace']) {
    await expect(section(page, name), name).toBeVisible();
  }
  expect.soft(await styles(sections.first().locator('..'), ['display', 'flex-direction', 'row-gap'])).toEqual({
    display: 'flex',
    'flex-direction': 'column',
    'row-gap': '40px',
  });
  const title = page.getByRole('heading', { level: 2, name: 'Profile' });
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '18px', 'font-weight': '700' });
  expectBox(await box(title), { x: 297, y: 142, height: 21 }, 2, '« Profile »');

  // The profile: the name, which the person changes (FRU-249), and the language.
  const profile = section(page, 'Profile');
  expect.soft(await styles(profile, ['row-gap'])).toEqual({ 'row-gap': '14px' });
  const name = profile.getByRole('textbox', { name: 'Name shown on notes' });
  await expect(name).toHaveValue('Ana');
  await expect(name).toBeEditable();
  await expect(profile.getByText('ana@acme.dev')).toBeVisible();
  expectBox(await box(name), { x: 297, y: 199, width: 355, height: 44 }, 2, 'the name');
  const language = profile.getByRole('button', { name: /Language/ });
  await expect(language).toContainText('English');
  expectBox(await box(language), { x: 666, y: 199, width: 355, height: 44 }, 2, 'the language');
  expect
    .soft(await styles(name.locator('xpath=ancestor::div[contains(@class,"grid")]'), ['column-gap', 'row-gap']))
    .toEqual({
      'column-gap': '14px',
      'row-gap': '14px',
    });

  // How the person signs in: each way, linked or not, and what to do with it.
  const signIn = section(page, 'How you sign in');
  const help = signIn.getByText('Any of these opens the same account, in the console and in the extension.');
  expect.soft(await styles(help, ['font-size', 'line-height', 'margin-bottom'])).toEqual({
    'font-size': '14px',
    'line-height': '21px',
    'margin-bottom': '12px',
  });
  expect.soft(await painted(help, 'color')).toEqual(rgb(MUTED));
  // The two fields have a line under them that the mockup does not draw (the address, and what the
  // language is for): what is under the profile is lower by those lines, and laid out as the mockup.
  const under = (await box(signIn.getByRole('heading', { level: 2 }))).y - 283;
  if (MOCKUP_FONT) expect.soft(under, 'the lines under the two fields').toBeGreaterThan(20);
  if (MOCKUP_FONT) expect.soft(under, 'the lines under the two fields').toBeLessThan(60);
  const ways = signIn.getByRole('listitem');
  await expect(ways).toHaveCount(3);
  expect.soft(await styles(ways.first().locator('..'), ['border-top-width', 'font-size'])).toEqual({
    'border-top-width': '1px',
    'font-size': '15px',
  });
  expect.soft(await painted(ways.first().locator('..'), 'borderTopColor')).toEqual(rgb(LINE));
  expect
    .soft(
      await styles(ways.first(), [
        'min-height',
        'box-sizing',
        'padding-top',
        'padding-bottom',
        'border-bottom-width',
        'column-gap',
        'row-gap',
        'flex-wrap',
      ]),
    )
    .toEqual({
      'min-height': '56px',
      'box-sizing': 'content-box',
      'padding-top': '8px',
      'padding-bottom': '8px',
      'border-bottom-width': '1px',
      'column-gap': '16px',
      'row-gap': '4px',
      'flex-wrap': 'wrap',
    });
  await expect(ways.nth(0)).toContainText('Email link');
  await expect(ways.nth(0)).toContainText('ana@acme.dev');
  const state = ways.nth(0).getByText('Always on', { exact: true });
  expect.soft(await styles(state, ['font-size'])).toEqual({ 'font-size': '14px' });
  expect.soft(await painted(state, 'color')).toEqual(rgb(MUTED));
  const way = ways.nth(1).getByText('GitHub', { exact: true });
  expect.soft(await styles(way, ['font-weight'])).toEqual({ 'font-weight': '600' });
  const detail = ways.nth(1).getByText('Linked', { exact: true });
  expect.soft(await styles(detail, ['font-size'])).toEqual({ 'font-size': '13px' });
  expect.soft(await painted(detail, 'color')).toEqual(rgb(MUTED));
  // A linked provider is unlinked; one that is not is linked, by a navigation to the worker.
  await expect(ways.nth(1).getByRole('button', { name: 'Unlink', exact: true })).toBeVisible();
  await expect(ways.nth(2)).toContainText('Not linked');
  const link = ways.nth(2).getByRole('link', { name: 'Link Google' });
  await expect(link).toHaveAttribute('href', 'http://localhost:8788/console/auth/link/google?workspace=w1');
  // An outlined button of 40 px, as the mockup draws « Link Google ».
  expect
    .soft(await styles(link, ['height', 'padding-left', 'border-top-left-radius', 'font-size', 'font-weight']))
    .toEqual({
      height: '40px',
      'padding-left': '16px',
      'border-top-left-radius': '6px',
      'font-size': '14px',
      'font-weight': '600',
    });
  // The worker keeps no login of GitHub: « Linked », and not « Linked as ».
  await expect(page.getByText(/Linked as/)).toHaveCount(0);

  // Where the console is signed in: this browser, then the others, the one used last first.
  const where = section(page, 'Where you are signed in');
  expectBox(
    await box(where.getByRole('heading', { level: 2 })),
    { x: 297, y: 601 + under, height: 21 },
    2,
    '« Where you are signed in »',
  );
  const browsers = where.getByRole('listitem');
  await expect(browsers).toHaveCount(3);
  await expect(browsers.nth(0)).toContainText('Console · this browser');
  await expect(browsers.nth(0)).toContainText('Active now');
  await expect(browsers.nth(0).getByText('This browser', { exact: true })).toBeVisible();
  await expect(browsers.nth(0).getByRole('button')).toHaveCount(0);
  await expect(browsers.nth(1)).toContainText('Console · another browser');
  await expect(browsers.nth(1)).toContainText(/Signed in Oct 12, 2026.* · used Oct 13, 2026/);
  await expect(browsers.nth(2)).toContainText(/Signed in Oct 2, 2026.* · used Oct 10, 2026/);
  // No kind of browser is shown, and no extension: the worker keeps neither for this screen yet.
  await expect(where.getByText(/Extension|Firefox|Chrome|macOS/)).toHaveCount(0);
  const disconnect = browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true });
  expect.soft(await styles(disconnect, ['font-size', 'font-weight', 'text-decoration-line', 'padding-top'])).toEqual({
    'font-size': '14px',
    'font-weight': '600',
    'text-decoration-line': 'underline',
    'padding-top': '10px',
  });
  expectBox(await box(disconnect), { x: 944, y: 751 + under, width: 76.2, height: 37 }, 2, '« Disconnect »');
  expectBox(await box(browsers.nth(2).getByRole('button')), { x: 944, y: 824 + under }, 2, 'the second « Disconnect »');

  // The two ways out.
  const out = section(page, 'Sign out');
  expect.soft(await styles(out, ['column-gap', 'row-gap', 'flex-wrap'])).toEqual({
    'column-gap': '20px',
    'row-gap': '12px',
    'flex-wrap': 'wrap',
  });
  const signOut = out.getByRole('button', { name: 'Sign out', exact: true });
  expect
    .soft(await styles(signOut, ['height', 'padding-left', 'border-top-left-radius', 'font-size', 'font-weight']))
    .toEqual({
      height: '44px',
      'padding-left': '18px',
      'border-top-left-radius': '6px',
      'font-size': '14px',
      'font-weight': '600',
    });
  expectBox(await box(signOut), { x: 297, y: 919 + under, width: 93.7, height: 44 }, 2, '« Sign out »');
  const everywhere = out.getByRole('button', { name: 'Sign out everywhere', exact: true });
  expect.soft(await styles(everywhere, ['text-decoration-line', 'padding-top'])).toEqual({
    'text-decoration-line': 'underline',
    'padding-top': '12px',
  });
  expectBox(await box(everywhere), { x: 410, y: 921 + under, width: 138.3, height: 41 }, 2, '« Sign out everywhere »');

  // Every text at 4.5:1 on the page.
  for (const text of [help, state, detail, browsers.nth(1).getByText(/Signed in/)]) {
    expect.soft(contrast(await painted(text, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(4.5);
  }
  await expectNoViolation(page, 'my account');
});

test('a browser whose session ended elsewhere leaves the list, and is not said to be signed in', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  await expect(browsers).toHaveCount(3);

  // Signed out from that browser, or from a third one, after this list was read: the worker
  // knows no session by this id. Nothing is left to end, and nothing to try again.
  worker.gone = true;
  worker.sessions = SESSIONS.filter((each) => each.id !== 'x2');
  await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(browsers).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(worker.sent).toEqual(['DELETE /console/sessions/x2']);
  await expect(browsers.nth(1)).toContainText(/Signed in Oct 2, 2026/);
});

test('a 404 for a browser that the list still names does not say that it is signed out', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  await expect(browsers).toHaveCount(3);

  // A worker with no such route answers 404 too: the session is still in the list, so it did not end.
  worker.gone = true;
  await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(browsers.nth(1).getByRole('alert')).toHaveText(
    'This browser is still signed in: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(3);

  // And when the list cannot be read again, nothing is said to have ended either.
  worker.sessions = undefined;
  await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(browsers.nth(1).getByRole('alert')).toHaveText(
    'This browser is still signed in: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(3);
});

test('another browser is disconnected in one press, and one that is still signed in says so', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');

  // The worker did not end the session: the row stays, and says so.
  worker.refuses = true;
  await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(browsers.nth(1).getByRole('alert')).toHaveText(
    'This browser is still signed in: Fruitback did not end its session. Try again.',
  );
  await expect(browsers).toHaveCount(3);

  worker.refuses = false;
  await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
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
    'Fruitback did not answer. The browsers where you are signed in could not be read.',
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
    const everywhere = page.getByRole('button', { name: 'Sign out everywhere', exact: true });
    await expect(out).toBeVisible();
    await expect(section(page, 'Where you are signed in').getByText('Loading…')).toBeVisible();
    const before = { out: await out.boundingBox(), everywhere: await everywhere.boundingBox() };

    // The press starts before the list arrives, and ends after.
    await page.mouse.move(before.out!.x + before.out!.width / 2, before.out!.y + before.out!.height / 2);
    await page.mouse.down();
    release();
    await expect(
      state === 'read'
        ? page.getByText('Console · this browser')
        : section(page, 'Where you are signed in').getByRole('alert'),
    ).toBeVisible();
    expect({ out: await out.boundingBox(), everywhere: await everywhere.boundingBox() }).toEqual(before);
    await page.mouse.up();

    await expect.poll(() => worker.sent).toContain('POST /console/auth/sign-out');
    await expect(page).toHaveURL(`${CONSOLE}/setup`);
  });
}

test('« Sign out everywhere » asks twice, and a sign-out that the worker did not confirm says so', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const out = section(page, 'Sign out');
  const everywhere = out.getByRole('button', { name: 'Sign out everywhere', exact: true });

  // The first press asks, sends nothing, and puts the keyboard on the way back.
  await everywhere.click();
  const group = page.getByRole('group', { name: 'Sign out of every browser' });
  await expect(
    group.getByText(/Every browser where the console is signed in to your account is signed out/),
  ).toBeVisible();
  const stay = group.getByRole('button', { name: 'Stay signed in', exact: true });
  await expect(stay).toBeFocused();
  expect(worker.sent).toEqual([]);
  await expectNoViolation(page, 'the second time of « Sign out everywhere »');
  await page.keyboard.press('Escape');
  await expect(group).toHaveCount(0);
  await expect(everywhere).toBeFocused();
  expect(worker.sent).toEqual([]);

  // Not confirmed by the worker: the person is not told that they are signed out, and stays.
  worker.refuses = true;
  await everywhere.click();
  await group.getByRole('button', { name: 'Sign out of every browser', exact: true }).click();
  await expect(out.getByRole('alert')).toHaveText(
    'You may still be signed in: Fruitback did not confirm the sign-out of every browser. Try again.',
  );
  await expect(page).toHaveURL(/\/account$/);
  await out.getByRole('button', { name: 'Stay signed in', exact: true }).click();
  await out.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(out.getByRole('alert')).toHaveText(
    'You are still signed in: Fruitback did not confirm the sign-out. Try again.',
  );
  await expect(page).toHaveURL(/\/account$/);
  expect(worker.sent).toEqual(['POST /console/auth/revoke-sessions', 'POST /console/auth/sign-out']);
});

test('the owner alone deletes the workspace, and asks twice', async ({ page }) => {
  const worker = await workerWith(page, 'owner');
  await open(page);
  const end = section(page, 'Delete the workspace');
  await end.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(end.getByRole('button', { name: 'Keep it', exact: true })).toBeFocused();
  await expect(end.getByRole('button', { name: 'Delete Acme', exact: true })).toBeVisible();
  expect(worker.sent).toEqual([]);
  await expectNoViolation(page, 'the second time of the deletion');
  await end.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(end.getByRole('button', { name: 'Delete workspace', exact: true })).toBeVisible();

  for (const role of ['admin', 'member', 'guest'] as const) {
    await page.unrouteAll();
    await workerWith(page, role);
    await open(page);
    await expect(page.getByText('Delete the workspace'), role).toHaveCount(0);
    await expect(page.locator('main section'), role).toHaveCount(4);
  }
});

for (const locale of ['en', 'fr'] as const) {
  for (const width of [390, 320]) {
    test(`at ${width} px nothing scrolls sideways, in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await workerWith(page, 'owner', locale);
      await page.goto(`${CONSOLE}/w/w1/account`);
      await expect(page.locator('main li').nth(4)).toBeVisible();
      expect.soft(await sideScroll(page), 'the screen').toBe(0);
      // The two fields are one under the other, each as wide as the screen.
      const fields = page.locator('main section').first().locator('.kit-field');
      expect((await box(fields.nth(1))).y).toBeGreaterThan((await box(fields.nth(0))).y + 44);
      await page
        .getByRole('button', { name: locale === 'en' ? 'Sign out everywhere' : 'Se déconnecter partout', exact: true })
        .click();
      expect.soft(await sideScroll(page), 'the second time of « Sign out everywhere »').toBe(0);
      if (width === 390) await expectNoViolation(page, `my account at ${width} px`);
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

    // My account lists it after the browsers of the console.
    await first.page.getByRole('link', { name: 'My account' }).click();
    const browsers = first.page.getByRole('region', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(browsers).toHaveCount(2);
    const extension = browsers.filter({ hasText: 'Extension · Chrome on macOS' });
    await expect(extension).toContainText(/Connected \d+ \w+ · used (Just now|\d+ min ago)/);

    // Disconnected in two presses: the row goes, and the worker refuses its refresh.
    await extension.getByRole('button', { name: 'Disconnect', exact: true }).click();
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

    // My account lists the browsers of the console only: the extension is no row of it.
    await first.page.getByRole('link', { name: 'My account' }).click();
    const browsers = first.page.getByRole('region', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(browsers).toHaveCount(2);

    // One browser disconnected: the extension reads its sites, and its session goes on.
    await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
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
    await first.page.getByRole('link', { name: 'My account' }).click();
    const browsers = first.page.getByRole('region', { name: 'Where you are signed in' }).getByRole('listitem');
    await expect(browsers).toHaveCount(2);
    // The worker names each browser by its user agent (FRU-249): the Chromium of the test, which
    // Playwright presents as « Desktop Chrome » (Windows) or as the machine it runs on.
    await expect(browsers.nth(0)).toContainText(/Console · Chrome on (Windows|macOS|Linux)/);
    await expect(browsers.nth(0)).toContainText('This browser');
    await expect(browsers.nth(1)).toContainText(/Console · Chrome on (Windows|macOS|Linux)/);

    // It disconnects the other one: one press, and the row goes.
    await browsers.nth(1).getByRole('button', { name: 'Disconnect', exact: true }).click();
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
  await github.getByRole('button', { name: 'Unlink', exact: true }).click();
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
  await expect(github.getByRole('link', { name: 'Link GitHub' })).toBeVisible();
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

  await page.goto(`${CONSOLE}/w/w1/account?error=email_doesn't_match`);
  await expect(section(page, 'How you sign in').getByRole('alert')).toHaveText(
    'That account has another address than yours. Fruitback links only the address of your account.',
  );
  // A code of the address that names a property of every object reads as a link that failed.
  await page.goto(`${CONSOLE}/w/w1/account?error=constructor`);
  await expect(section(page, 'How you sign in').getByRole('alert')).toHaveText(
    'The account was not linked. Try again.',
  );
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
  await open(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  // The browsers of the console first, then those of the extension, the one used last first.
  await expect(browsers).toHaveCount(5);
  await expect(browsers.nth(3)).toContainText('Extension · Chrome on macOS');
  await expect(browsers.nth(3)).toContainText('Connected 12 Oct · used 2 h ago');
  await expect(browsers.nth(4)).toContainText('Extension · Firefox on Linux');
  await expect(browsers.nth(4)).toContainText('Connected 2 Oct · used 3 days ago');
  // The row is the one of the console: its title at 600, its line at 13 px.
  expect.soft(await styles(browsers.nth(3).getByText('Extension · Chrome on macOS'), ['font-weight'])).toEqual({
    'font-weight': '600',
  });
  expect.soft(await styles(browsers.nth(3).getByText(/^Connected/), ['font-size'])).toEqual({ 'font-size': '13px' });
  await expectNoViolation(page, 'the browsers of the extension');
});

test('an extension is disconnected in two presses, and one that is still connected says so', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  const worker = await workerWith(page);
  worker.extensions = EXTENSIONS;
  await open(page);
  const browsers = section(page, 'Where you are signed in').getByRole('listitem');
  const chrome = browsers.filter({ hasText: 'Extension · Chrome on macOS' });

  worker.extensionRefuses = true;
  await chrome.getByRole('button', { name: 'Disconnect', exact: true }).click();
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
  await page.goto(`${CONSOLE}/w/w1/account`);
  const where = section(page, 'Where you are signed in');
  // The browsers of the console are there, with their « Disconnect ».
  await expect(where.getByRole('listitem').filter({ hasText: 'Console · this browser' })).toBeVisible();
  await expect(where.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(2);
  // And a line says what is missing, with the way to read it again.
  await expect(where.getByRole('alert')).toHaveText(
    'Fruitback did not answer. The browsers of the extension could not be read.',
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
  await page.goto(`${CONSOLE}/w/w1/account`);
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

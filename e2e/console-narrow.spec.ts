import { type Page, type Route, expect, test } from '@playwright/test';
import { stubWorker as stubScreens, fulfillSites } from './console-workspace.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The screens of a workspace on a narrow screen (FRU-159), in the console of the Cloud.
 *
 * Layout is what this measures, so the worker is answered by stubs: a worker with accounts needs a
 * signed-in person, and none of that changes a width.
 */
const CONSOLE = 'http://localhost:5178';
const LONG_HOST = 'preview-branch-feature-very-long-name-1234.staging.acme.dev';
const SCREENS = ['sites', 'notes', 'connectors', 'members', 'account'] as const;

async function stubWorker(page: Page, locale: 'en' | 'fr'): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  const sites = { sites: [{ id: 's1', origin: `https://${LONG_HOST}`, visibility: 'members' }] };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/domains') return json({ domains: [] });
    const read = fulfillSites(route, sites.sites);
    if (read !== false) return read;
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [], available: true });
    if (pathname === '/console/workspaces/w1/notes') {
      const note = {
        id: 'n1',
        excerpt: 'The order form rejects postcodes with a space, and says nothing of why it does so.',
        page: { url: `https://${LONG_HOST}/contact`, host: LONG_HOST, path: '/contact' },
        site: { id: 's1' },
        stage: 'new',
        author: { kind: 'anonymous' },
        place: { kind: 'fruitback' },
        createdAt: '2026-10-13T08:00:00.000Z',
      };

      return json({ notes: [note], total: 1, counts: { all: 1, byPlace: { fruitback: 1 } } });
    }
    // A worker that signs people in by a link: one that says nothing there shows no form (FRU-217).
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: false, google: false } });

    return route.fulfill({ status: 204 });
  });
}

async function open(page: Page, screen: string): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/${screen}`);
  await expect(page.locator('main h1')).toBeVisible();
}

const sideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [390, 320]) {
  for (const locale of ['en', 'fr'] as const) {
    test(`no screen of a workspace scrolls sideways at ${width} px, in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await stubWorker(page, locale);
      for (const screen of SCREENS) {
        await open(page, screen);
        expect.soft(await sideScroll(page), `${screen} scrolls sideways`).toBe(0);
      }
    });
  }
}

test('at 390 px, the title follows the sections, and a long host reads in full', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubWorker(page, 'fr');
  await open(page, 'sites');

  // The sections are in the rail (FRU-234), and the title is under the rail at the padding of the
  // mockup, 40 px: no more, so nothing takes room between the two.
  const rail = await page.locator('aside.kit-rail').boundingBox();
  const title = await page.locator('main h1').boundingBox();
  expect(title!.y - (rail!.y + rail!.height)).toBeLessThanOrEqual(40);
  expect(title!.y - (rail!.y + rail!.height)).toBeGreaterThan(0);

  const host = page.getByRole('heading', { level: 2, name: LONG_HOST, exact: true });
  await expect(host).toBeVisible();
  // Read in full: nothing cut, and nothing past the right edge of the screen.
  expect(await host.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const box = await host.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

/**
 * Every page of the console, read and with long lists (FRU-505). A list of three short rows fits
 * where forty long ones do not: the label of the status of a note, for a screen reader only, was
 * past the frame of the table when the text of a note was long, and the page was 412 px wide.
 */
const MANY = 40;
const many = <T>(make: (index: number) => T): T[] => Array.from({ length: MANY }, (_, index) => make(index));
const AT = '2026-10-20T10:00:00.000Z';
const LONG_TEXT =
  'The order form rejects every postcode with a space in it, says nothing of why, and keeps the button greyed out.';
const STATUSES = [
  { key: 'own:new', name: '', stage: 'new' },
  { key: 'own:todo', name: 'Waiting for the client to answer', stage: 'todo', color: '#2563eb', textColor: '#ffffff' },
  { key: 'own:progress', name: '', stage: 'progress' },
  { key: 'own:done', name: '', stage: 'done' },
  { key: 'own:closed', name: '', stage: 'closed' },
];
/** The statuses of a site as its screen reads them: the team added forty. */
const STATUS_ROWS = many((index) => ({
  key: `team-${index}`,
  stage: 'todo',
  source: 'own',
  name: `Waiting for the client's legal team to approve the new wording ${index}`,
  color: '#8b5cf6',
  textColor: null,
  position: index + 5,
  origin: 'team',
  hidden: false,
}));
const counted = { new: 14, todo: 22, progress: 18, done: 49, closed: 9 };

const SITES_OF_MANY = many((index) => ({
  id: `s${index + 1}`,
  origin: `https://preview-${index}-${LONG_HOST}`,
  visibility: index % 2 === 0 ? 'members' : 'everyone',
}));
const NOTES = many((index) => ({
  id: `n${index}`,
  excerpt: `${LONG_TEXT} (${index})`,
  page: { url: `https://${LONG_HOST}/checkout/step-${index}`, host: LONG_HOST, path: `/checkout/step-${index}` },
  site: { id: 's1' },
  stage: 'new',
  status: 'own:new',
  canSetStatus: true,
  author: { kind: 'member', name: 'Ana Lucía Fernández-Morales' },
  place: { kind: 'fruitback' },
  createdAt: AT,
}));
const roleOf = (index: number) => {
  if (index === 0) return 'owner';

  return index % 3 === 0 ? 'admin' : 'member';
};
const MEMBERS = many((index) => ({
  id: `m${index}`,
  userId: index === 0 ? 'a1' : `a${index + 1}`,
  role: roleOf(index),
  createdAt: AT,
  user: { id: `a${index + 1}`, email: `person.with.a.long.name.${index}@client-of-acme.dev`, name: `Person ${index}` },
}));
const INVITATIONS = many((index) => ({
  id: `i${index}`,
  email: `invited.person.${index}@client-of-acme.dev`,
  role: 'member',
  organizationId: 'w1',
  status: 'pending',
  createdAt: AT,
  expiresAt: '2026-10-27T10:00:00.000Z',
}));
const ADMIN_WORKSPACES = many((index) => ({
  id: `w${index + 10}`,
  name: `Acme workspace with a long name ${index}`,
  createdAt: AT,
  owners: [{ id: `a${index}`, name: 'Ana Lucía Fernández-Morales', email: `ana.${index}@client-of-acme.dev` }],
  members: 6,
  sites: 3,
  notes: counted,
  destinations: [{ id: 'c1', kind: 'linear', label: 'Acme' }],
  pendingDeliveries: index % 4,
}));
const ADMIN_USERS = many((index) => ({
  id: `a${index + 10}`,
  name: `Ana Lucía Fernández-Morales ${index}`,
  email: `ana.lucia.${index}@client-of-acme.dev`,
  createdAt: AT,
  instanceAdmin: index === 0,
  suspended: false,
  workspaces: [{ id: 'w1', name: 'Acme', role: 'member' }],
  providers: ['email'],
  lastSeen: AT,
  pendingInvitations: [],
}));
const ADMIN_NOTES = many((index) => ({
  id: `s1:n${index}`,
  workspace: { id: 'w1', name: 'Acme' },
  site: { id: 's1', origin: `https://${LONG_HOST}` },
  page: { url: `https://${LONG_HOST}/contact`, host: LONG_HOST, path: '/contact' },
  excerpt: `${LONG_TEXT} (${index})`.slice(0, 64),
  stage: 'todo',
  channel: 'extension',
  author: { kind: 'site' },
  place: { kind: 'linear', connector: 'c1', label: 'Linear · Acme' },
  ref: `ACM-${index}`,
  url: `https://linear.app/acme/issue/ACM-${index}`,
  createdAt: AT,
  checkedAt: AT,
}));

/** What the pages read, beyond the lists every screen of a workspace reads. */
function answerLong(pathname: string, route: Route): Promise<void> | undefined {
  const json = (body: unknown) => route.fulfill({ json: body });
  if (pathname === '/console/me') {
    return json({
      account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
      workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
      instanceAdmin: true,
    });
  }
  if (pathname === '/console/workspaces/w1/notes') {
    return json({
      notes: NOTES,
      total: 9990,
      counts: { all: 9990, byPlace: { fruitback: 9990 } },
      statuses: { s1: STATUSES },
    });
  }
  if (pathname.endsWith('/list-members')) return json({ members: MEMBERS });
  if (pathname.endsWith('/list-invitations')) return json(INVITATIONS);
  if (pathname === '/console/workspaces/w1/members/seen') return json({ seen: {} });
  if (pathname === '/console/workspaces/w1/sites/s1/statuses/tracker')
    return json({ trackerColours: false, trackers: [] });
  if (pathname === '/console/workspaces/w1/sites/s1/statuses') return json({ statuses: STATUS_ROWS });
  if (pathname === '/console/workspaces/w1/agent-keys') return json({ keys: [] });
  if (pathname === '/console/admin/workspaces') return json({ workspaces: ADMIN_WORKSPACES, total: 4000 });
  if (pathname === '/console/admin/users') return json({ users: ADMIN_USERS, total: 4000 });
  if (pathname === '/console/admin/notes') return json({ notes: ADMIN_NOTES, total: 9990, searched: [] });
  if (pathname === '/console/admin/actions') return json({ actions: [] });

  return undefined;
}

/** The pages of the console, with a text that shows each one is read: the first row of a list. */
const PAGES: readonly (readonly [string, string | undefined])[] = [
  ['/w/w1/sites', `preview-0-${LONG_HOST}`],
  ['/w/w1/sites/s1', undefined],
  ['/w/w1/sites/s1/statuses', "Waiting for the client's legal team to approve the new wording 0"],
  ['/w/w1/notes', LONG_TEXT.slice(0, 40)],
  ['/w/w1/connectors', undefined],
  ['/w/w1/members', 'invited.person.0@client-of-acme.dev'],
  ['/w/w1/account', undefined],
  ['/w/w1/settings', undefined],
  ['/w/w1/settings/agents', undefined],
  ['/admin', undefined],
  ['/admin/workspaces', 'Acme workspace with a long name 0'],
  ['/admin/users', 'ana.lucia.0@client-of-acme.dev'],
  ['/admin/notes', 'ACM-0'],
];

for (const width of [390, 320]) {
  test(`no page of the console scrolls sideways at ${width} px, with forty long rows in each list`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await stubScreens(page, { sites: SITES_OF_MANY, answer: answerLong });
    for (const [path, shown] of PAGES) {
      await page.goto(`${CONSOLE}${path}`);
      await expect(page.locator('main h1').first()).toBeVisible();
      if (shown !== undefined) await expect(page.getByText(shown).first()).toBeAttached();
      expect.soft(await sideScroll(page), `${path} scrolls sideways`).toBe(0);
    }
  });
}

test('at 390 px a note is a card: its status, its author and its day are on the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubScreens(page, { sites: SITES_OF_MANY, answer: answerLong });
  await page.goto(`${CONSOLE}/w/w1/notes`);
  const first = page.locator('tbody tr').first();
  const status = first.getByRole('button', { name: /Status of this note/ });
  await expect(status).toBeVisible();
  for (const part of [status, first.getByText('Ana Lucía Fernández-Morales'), first.locator('td').last()]) {
    const found = await part.boundingBox();
    expect.soft(found!.x, 'starts on the screen').toBeGreaterThanOrEqual(0);
    expect.soft(found!.x + found!.width, 'ends on the screen').toBeLessThanOrEqual(390);
  }
  // From 640 px it is the table again, which scrolls in its frame.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('thead th').first()).toBeVisible();
  expect(await first.evaluate((row) => getComputedStyle(row).display)).toBe('table-row');
});

test('at 390 px a role reads on one line', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubScreens(page, { sites: SITES_OF_MANY, answer: answerLong });
  await page.goto(`${CONSOLE}/w/w1/members`);
  const role = page.locator('tbody tr').nth(1).locator('td').nth(1);
  await expect(role).toHaveText('Member');
  const lines = await role.evaluate((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);

    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lines).toBe(1);
});

// The setup on a narrow screen (FRU-160) is measured with the setup, in `console-setup.spec.ts`.

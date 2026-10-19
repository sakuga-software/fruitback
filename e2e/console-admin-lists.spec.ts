import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { contrast, painted, rgb, sideScroll, stubWorker, styles, typeDuringTheWrite } from './console-workspace.ts';

/**
 * « Workspaces » and « Users » of the administration of the instance (FRU-263), measured in a
 * browser against screens 18 and 19 of the mockup of 2026-10-13 (`18-admin-workspaces.html`,
 * `19-admin-users.html`), read-only. The worker is answered by stubs with the shapes of
 * `instance-admin.ts`, and the stubs filter by `q` and `show` as the worker does: a search that the
 * stub did not filter would prove nothing.
 *
 * The sample data is of nobody: `acme.dev`, invented names.
 */
const CONSOLE = 'http://localhost:5178';
const DAY = 24 * 60 * 60_000;

const CHIP = '#f4f4f5';
const SUBTLE = '#fafafa';
const INK = '#18181b';
const INK_SOFT = '#52525b';
const MUTED = '#6b6b74';
const DONE = '#15803d';
const ACCENT = '#dd2c27';
const ACCENT_STRONG = '#b91c1c';

/** The gestures of the mockup that come with FRU-274: none of them is on these screens. */
const ACTIONS = [
  'New workspace',
  'Invite someone',
  'Send them again',
  'Suspend',
  'Delete the workspace',
  'Restore access',
  'Add to a workspace',
  'Resend',
  /^Delete .*account$/,
];

const counts = (seeded: number, green: number, ripening: number, ripe: number, composted: number) => ({
  seeded,
  green,
  ripening,
  ripe,
  composted,
});

const WORKSPACES = [
  {
    id: 'w1',
    name: 'Acme web',
    createdAt: '2026-09-03T10:00:00.000Z',
    owners: [{ id: 'a2', name: 'Nadia Benali', email: 'nadia@acme.dev' }],
    members: 6,
    sites: 3,
    notes: counts(14, 22, 18, 49, 9),
    destinations: [{ id: 'c1', kind: 'linear', label: 'Acme' }],
    pendingDeliveries: 0,
  },
  {
    id: 'w9',
    name: 'Acme support',
    createdAt: '2026-09-18T10:00:00.000Z',
    owners: [{ id: 'a3', name: 'Tom Marchal', email: 'tom@acme.dev' }],
    members: 2,
    sites: 1,
    notes: counts(5, 6, 4, 7, 1),
    destinations: [{ id: 'c2', kind: 'rest', label: 'hooks.acme.dev/fruitback' }],
    pendingDeliveries: 2,
  },
  {
    id: 'w5',
    name: 'Lumen',
    createdAt: '2026-10-12T10:00:00.000Z',
    owners: [{ id: 'a4', email: 'paul@lumen.studio' }],
    members: 1,
    sites: 1,
    // A worker that counts no stage sends none: the screen reads it as zero.
    notes: { seeded: 1 },
    destinations: [],
    pendingDeliveries: 0,
  },
  {
    id: 'w7',
    name: 'Northwind',
    createdAt: '2026-10-14T10:00:00.000Z',
    owners: [{ id: 'a6', email: 'zoe@northwind.dev' }],
    members: 1,
    sites: 0,
    notes: {},
    destinations: [{ id: 'c3', kind: 'linear', label: 'Northwind', attention: { reason: 'key-refused', since: 'x' } }],
    pendingDeliveries: 0,
  },
];

const DETAIL = {
  id: 'w9',
  name: 'Acme support',
  createdAt: '2026-09-18T10:00:00.000Z',
  members: [
    { id: 'a3', name: 'Tom Marchal', email: 'tom@acme.dev', role: 'owner', lastSeen: '2026-10-18' },
    { id: 'a2', name: 'Nadia Benali', email: 'nadia@acme.dev', role: 'member' },
  ],
  sites: [
    {
      id: 's1',
      origin: 'https://support.acme.dev',
      visibility: 'everyone',
      destinations: [{ connector: 'c2' }],
      notes: counts(5, 6, 4, 7, 1),
    },
  ],
  destinations: [{ id: 'c2', kind: 'rest', label: 'hooks.acme.dev/fruitback', createdAt: '2026-09-18T10:00:00.000Z' }],
  pendingDeliveries: 2,
  pendingInvitations: 0,
};

/** A day `n` days ago, as the worker keeps `lastSeen`. */
const daysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);

const USERS = [
  {
    id: 'a2',
    name: 'Nadia Benali',
    email: 'nadia@acme.dev',
    createdAt: '2026-09-03T10:00:00.000Z',
    instanceAdmin: true,
    workspaces: [
      { id: 'w1', name: 'Acme web', role: 'owner' },
      { id: 'w9', name: 'Acme support', role: 'member' },
    ],
    providers: ['email', 'github'],
    lastSeen: daysAgo(0),
    pendingInvitations: [],
  },
  {
    id: 'a3',
    name: 'Tom Marchal',
    email: 'tom@acme.dev',
    createdAt: '2026-09-18T10:00:00.000Z',
    instanceAdmin: false,
    workspaces: [
      { id: 'w9', name: 'Acme support', role: 'owner' },
      { id: 'w1', name: 'Acme web', role: 'member' },
    ],
    providers: ['email'],
    lastSeen: daysAgo(1),
    pendingInvitations: [],
  },
  {
    id: 'a5',
    name: 'Inès Roux',
    email: 'ines@acme.dev',
    createdAt: '2026-09-20T10:00:00.000Z',
    instanceAdmin: false,
    workspaces: [{ id: 'w1', name: 'Acme web', role: 'admin' }],
    providers: ['google'],
    lastSeen: daysAgo(4),
    pendingInvitations: [],
  },
  {
    id: 'a8',
    email: 'sara@acme.dev',
    createdAt: '2026-10-10T10:00:00.000Z',
    instanceAdmin: false,
    workspaces: [],
    providers: [],
    pendingInvitations: [{ workspace: { id: 'w9', name: 'Acme support' }, role: 'member' }],
  },
  {
    id: 'a9',
    name: 'Hugo Petit',
    email: 'hugo@acme.dev',
    createdAt: '2026-10-11T10:00:00.000Z',
    instanceAdmin: false,
    workspaces: [],
    providers: ['email'],
    pendingInvitations: [],
  },
];

const has = (text: string | undefined, q: string) => (text ?? '').toLowerCase().includes(q.toLowerCase());

function workspacesOf(q: string, show: string) {
  return WORKSPACES.filter(
    (workspace) =>
      (q === '' || has(workspace.name, q) || workspace.owners.some((owner) => has(owner.email, q))) &&
      (show !== 'attention' ||
        workspace.pendingDeliveries > 0 ||
        workspace.destinations.some((connector) => 'attention' in connector)) &&
      (show !== 'empty' || workspace.sites === 0),
  );
}

function usersOf(q: string, show: string) {
  return USERS.filter(
    (user) =>
      (q === '' || has(user.name, q) || has(user.email, q)) &&
      (show !== 'admins' || user.instanceAdmin) &&
      (show !== 'alone' || user.workspaces.length === 0),
  );
}

type Options = {
  admin?: boolean;
  locale?: 'en' | 'fr';
  /** A status that the lists answer instead of a list, until it is set to `undefined`. */
  failing?: { status: number | undefined };
  /** Holds every answer of a list until it resolves. */
  hold?: Promise<void>;
  workspaces?: typeof WORKSPACES;
  users?: typeof USERS;
};

type Asked = { path: string; q: string | null; show: string | null };

/** The worker of an administrator, or of somebody else, and what the lists were asked. */
async function stub(page: Page, options: Options = {}): Promise<Asked[]> {
  const { admin = true, locale = 'en', failing, hold } = options;
  const asked: Asked[] = [];
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
    instanceAdmin: admin,
  };
  const answer = (pathname: string, route: Route): Promise<void> | undefined => {
    if (pathname === '/console/me') return route.fulfill({ json: me });
    if (!pathname.startsWith('/console/admin')) return undefined;
    // The worker answers `404` to anybody else, as for a path that does not exist (FRU-261).
    if (!admin) return route.fulfill({ status: 404, json: { error: 'not-found' } });
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q');
    const show = url.searchParams.get('show');
    asked.push({ path: pathname, q, show });
    const reply = async (body: unknown) => {
      await (hold ?? Promise.resolve());
      if (failing?.status !== undefined) return route.fulfill({ status: failing.status, json: { error: 'down' } });

      return route.fulfill({ json: body });
    };
    if (pathname === '/console/admin/workspaces') {
      const found = workspacesOf(q ?? '', show ?? 'all').filter((each) =>
        (options.workspaces ?? WORKSPACES).includes(each),
      );
      return reply({ workspaces: found, total: found.length });
    }
    if (pathname === '/console/admin/workspaces/w9') return reply(DETAIL);
    if (pathname.startsWith('/console/admin/workspaces/'))
      return reply({ ...DETAIL, id: pathname.split('/').pop(), members: [], sites: [], destinations: [] });
    if (pathname === '/console/admin/users') {
      const found = usersOf(q ?? '', show ?? 'all').filter((each) => (options.users ?? USERS).includes(each));
      return reply({ users: found, total: found.length });
    }

    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  };
  await stubWorker(page, { locale, answer });

  return asked;
}

/** Every request the page sends to the worker, as `METHOD /path`. */
function watched(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(WORKER_ORIGIN)) sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  return sent;
}

const main = (page: Page) => page.locator('main');
const rows = (page: Page) => main(page).locator('table tbody tr:not(:has(#admin-panel))');
const panel = (page: Page) => page.locator('#admin-panel');
const search = (page: Page, name: string) => page.getByRole('searchbox', { name });
/** The list « Show », by the option it shows. */
const filter = (page: Page, shown: RegExp) => main(page).getByRole('button', { name: shown });

async function axe(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').include('aside.kit-rail').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

async function visit(page: Page, path: string, title: string): Promise<void> {
  await page.goto(`${CONSOLE}${path}`);
  await expect(main(page).getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** The search bar, its field and its list, by the boxes that hold them. */
function bar(page: Page, name: string): { bar: Locator; field: Locator; list: Locator } {
  const field = search(page, name).locator('xpath=ancestor::div[contains(@class,"kit-field")][1]/..');

  return { bar: field.locator('..'), field, list: field.locator('xpath=following-sibling::div[1]') };
}

/** The values of the search bar and of the two columns of the mockup. */
async function expectLayout(page: Page, search: string, table: string, minWidth: string): Promise<void> {
  expect.soft(await styles(main(page), ['max-width'])).toEqual({ 'max-width': '1240px' });
  const parts = bar(page, search);
  expect.soft(await styles(parts.bar, ['row-gap', 'column-gap', 'margin-bottom'])).toEqual({
    'row-gap': '10px',
    'column-gap': '10px',
    'margin-bottom': '16px',
  });
  expect.soft(await styles(parts.field, ['flex'])).toEqual({ flex: '999 1 260px' });
  expect.soft(await styles(parts.list, ['flex'])).toEqual({ flex: '1 1 200px' });
  expect.soft((await page.getByRole('searchbox', { name: search }).boundingBox())?.height).toBe(40);
  const frame = page.getByRole('region', { name: table });
  expect.soft(await styles(frame.locator('..'), ['flex'])).toEqual({ flex: '999 1 560px' });
  expect.soft(await styles(frame.locator('../..'), ['column-gap'])).toEqual({ 'column-gap': '28px' });
  expect.soft(await styles(frame.locator('table'), ['min-width'])).toEqual({ 'min-width': minWidth });
  for (const header of await frame.locator('th').all()) await expect.soft(header).toHaveAttribute('scope', 'col');
}

/** The panel of the mockup: its box, its tint, and the space of its parts. */
async function expectPanel(page: Page): Promise<void> {
  expect.soft(await styles(panel(page), ['flex', 'border-top-left-radius'])).toEqual({
    flex: '1 1 340px',
    'border-top-left-radius': '14px',
  });
  expect.soft(await painted(panel(page), 'backgroundColor')).toEqual(rgb(SUBTLE));
  const body = panel(page).locator('.kit-panel__body');
  expect.soft(await styles(body, ['padding-top', 'padding-left', 'row-gap'])).toEqual({
    'padding-top': '20px',
    'padding-left': '22px',
    'row-gap': '22px',
  });
  const row = panel(page).locator('li').first();
  expect.soft(await styles(row, ['padding-top', 'padding-bottom'])).toEqual({
    'padding-top': '8px',
    'padding-bottom': '8px',
  });
}

/** No gesture of FRU-274 is drawn, not even disabled, and nothing switches. */
async function expectNoAction(page: Page): Promise<void> {
  for (const name of ACTIONS) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  }
  await expect(main(page).getByRole('switch')).toHaveCount(0);
  await expect(main(page).getByRole('checkbox')).toHaveCount(0);
  await expect(main(page).locator('form')).toHaveCount(0);
}

test('the rail lists the screens of the administration in the order of the mockup', async ({ page }) => {
  await stub(page);
  await visit(page, '/admin/workspaces', 'Workspaces');
  const nav = page.getByRole('navigation', { name: 'Instance' });
  await expect(nav.getByRole('link')).toHaveText(['Instance', 'Workspaces', 'Users', 'Notes', 'My workspaces']);
  await expect(nav.getByRole('link', { name: 'Workspaces', exact: true })).toHaveAttribute('aria-current', 'page');
  await nav.getByRole('link', { name: 'Users' }).click();
  await expect(main(page).getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
});

test('Workspaces: the table, the panel of a row, and the values of the mockup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sent = watched(page);
  await stub(page);
  await visit(page, '/admin/workspaces', 'Workspaces');

  await expect(main(page).locator('header p')).toHaveText(
    'Every workspace on this instance, who owns it and where its notes go.',
  );
  const box = search(page, 'Search workspaces');
  await expect(box).toHaveAttribute('placeholder', 'Search by name or owner');
  // Both labels are there for a screen reader, and hidden.
  await expect(main(page).locator('label', { hasText: 'Search workspaces' })).toHaveClass(/sr-only/);
  await expect(main(page).getByText('Show', { exact: true })).toHaveClass(/sr-only/);
  await expect(filter(page, /All workspaces/)).toHaveAccessibleName(/Show/);

  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Workspace', 'Owner', 'Notes', 'Notes go to']);
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0).getByRole('cell')).toHaveText([
    'Acme web6 people · 3 sites',
    'nadia@acme.dev',
    '112',
    'Linear',
  ]);
  await expect(rows(page).nth(1).getByRole('cell').nth(3)).toHaveText('REST API2 notes not delivered');
  await expect(rows(page).nth(2).getByRole('cell').nth(0)).toHaveText('Lumen1 person · 1 site');
  await expect(rows(page).nth(2).getByRole('cell').nth(3)).toHaveText('Kept in Fruitback');
  await expect(rows(page).nth(3).getByRole('cell').nth(3)).toHaveText('LinearNeeds attention');
  const bars = table.getByRole('img');
  await expect(bars.first()).toHaveAccessibleName('112 notes: 14 new, 22 to do, 18 in progress, 49 done, 9 closed');
  await expect(bars.nth(2)).toHaveAccessibleName('1 note: 1 new, 0 to do, 0 in progress, 0 done, 0 closed');
  const barBox = await bars.first().boundingBox();
  expect.soft([barBox?.width, barBox?.height]).toEqual([96, 8]);
  expect.soft(await painted(bars.first(), 'backgroundColor')).toEqual(rgb(CHIP));
  const alert = rows(page).nth(1).getByText('2 notes not delivered');
  expect.soft(await painted(alert, 'color')).toEqual(rgb(ACCENT));
  expect.soft(await styles(alert, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });
  await expectLayout(page, 'Search workspaces', 'Workspaces of the instance', '680px');
  await expect(panel(page)).toHaveCount(0);
  await expect(main(page)).toContainText(
    'The owners of each workspace see that you read its list, with your address and the day.',
  );
  await axe(page, 'the workspaces at 1440 px');

  // A press of a row opens its panel, which takes focus.
  const link = main(page).getByRole('link', { name: 'Acme support' });
  await expect(link).toHaveAttribute('aria-current', 'false');
  await link.click();
  await expect(page).toHaveURL(/[?&]open=w9(&|$)/);
  await expect(panel(page)).toBeFocused();
  await expect(panel(page)).toHaveAccessibleName('Acme support');
  await expect(link).toHaveAttribute('aria-current', 'true');
  await expect(link).toHaveAttribute('aria-controls', 'admin-panel');
  const chosen = rows(page).nth(1);
  // The pointer is still on the row: the tint of the chosen row stays.
  expect.soft(await painted(chosen, 'backgroundColor')).toEqual(rgb(CHIP));
  const red = chosen.getByText('2 notes not delivered');
  expect.soft(await painted(red, 'color')).toEqual(rgb(ACCENT_STRONG));
  expect(contrast(await painted(red, 'color'), await painted(chosen, 'backgroundColor'))).toBeGreaterThanOrEqual(4.5);

  await expect(panel(page)).toContainText('Owned by tom@acme.dev · created 18 Sep');
  await expect(panel(page).getByRole('heading', { level: 3 })).toHaveText([
    'Where notes go',
    'People · 2',
    'Sites · 1',
    'Owner',
  ]);
  await expect(panel(page)).toContainText('REST API hooks.acme.dev/fruitback');
  const late = panel(page).getByText('2 notes not delivered.');
  expect.soft(await painted(late, 'color')).toEqual(rgb(ACCENT_STRONG));
  expect(contrast(await painted(late, 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);
  await expect(panel(page).getByRole('link', { name: 'See the notes' })).toHaveAttribute(
    'href',
    '/admin/notes?workspace=w9',
  );
  await expect(panel(page).getByRole('listitem')).toHaveText([
    'Tom MarchalOwner',
    'Nadia BenaliMember',
    'support.acme.devEveryone who visits',
  ]);
  await expect(panel(page).getByRole('link', { name: 'Manage in Users' })).toHaveAttribute(
    'href',
    '/admin/users?q=tom%40acme.dev',
  );
  await expect(panel(page)).toContainText('Tom Marchal, tom@acme.dev');
  await expectPanel(page);
  await expectNoAction(page);
  await axe(page, 'the panel of a workspace at 1440 px');

  // Escape closes it, and gives focus back to its row.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);
  await expect(link).toBeFocused();

  // The panel moves under its row below 1280 px, and a workspace opened again is not read again.
  await main(page).getByRole('link', { name: 'Acme web' }).click();
  await expect(panel(page)).toHaveAccessibleName('Acme web');
  await page.setViewportSize({ width: 1100, height: 1000 });
  await expect(panel(page)).toHaveAccessibleName('Acme web');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await link.click();
  await expect(panel(page)).toContainText('Owned by tom@acme.dev · created 18 Sep');
  await expect(panel(page).getByRole('heading', { level: 3 }).first()).toHaveText('Where notes go');
  await page.keyboard.press('Escape');

  // The control of the watch below: the screen did read the worker.
  expect(sent).toContain('GET /console/admin/workspaces');
  // One trace in a workspace for all the openings of its panel.
  const reads = sent.filter((request) => request.startsWith('GET /console/admin/workspaces/'));
  expect(reads.filter((request) => request === 'GET /console/admin/workspaces/w9')).toHaveLength(1);
  expect(reads).toHaveLength(2);
  expect(sent.filter((request) => !request.startsWith('GET ') && !request.startsWith('OPTIONS '))).toEqual([]);
});

test('Workspaces: the search reads once, 300 ms after the last key, and lives in the address', async ({ page }) => {
  const asked = await stub(page);
  await visit(page, '/admin/workspaces', 'Workspaces');
  await expect(rows(page)).toHaveCount(4);
  const lists = () => asked.filter((each) => each.path === '/console/admin/workspaces');
  // Each read leaves a trace with the owners: opening the screen reads the list once.
  await page.waitForTimeout(400);
  expect(lists()).toHaveLength(1);
  const before = lists().length;

  await search(page, 'Search workspaces').pressSequentially('lumen', { delay: 50 });
  await page.waitForTimeout(150);
  expect(lists().length).toBe(before);
  await expect(page).toHaveURL(/[?&]q=lumen(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(lists().slice(before)).toEqual([{ path: '/console/admin/workspaces', q: 'lumen', show: null }]);

  // A reload keeps the search; the owner's address is searched too.
  await page.reload();
  await expect(search(page, 'Search workspaces')).toHaveValue('lumen');
  await expect(rows(page)).toHaveCount(1);
  await search(page, 'Search workspaces').fill('tom@');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Acme support');

  // The filter of the worker, in the address too.
  await search(page, 'Search workspaces').fill('');
  await expect(page).not.toHaveURL(/q=/);
  await filter(page, /All workspaces/).click();
  await expect(page.getByRole('option')).toHaveText(['All workspaces', 'Needs a look', 'No site yet']);
  await page.getByRole('option', { name: 'Needs a look', exact: true }).click();
  await expect(page).toHaveURL(/[?&]show=attention(&|$)/);
  await expect(rows(page)).toHaveCount(2);
  expect(lists().at(-1)).toEqual({ path: '/console/admin/workspaces', q: null, show: 'attention' });
  await filter(page, /Needs a look/).click();
  await page.getByRole('option', { name: 'No site yet', exact: true }).click();
  await expect(page).toHaveURL(/[?&]show=empty(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('Northwind');

  // Back gives the filter before, and a search after it starts from that address, not an older one.
  await page.goBack();
  await expect(page).toHaveURL(/[?&]show=attention(&|$)/);
  await expect(rows(page)).toHaveCount(2);
  await search(page, 'Search workspaces').fill('acme');
  await expect(page).toHaveURL(/[?&]q=acme(&|$)/);
  await expect(page).toHaveURL(/[?&]show=attention(&|$)/);
  await page.goForward();
  await expect(page).toHaveURL(/[?&]show=empty(&|$)/);
  await expect(search(page, 'Search workspaces')).toHaveValue('');

  // A search that keeps nothing says so, and gives the whole list back.
  await search(page, 'Search workspaces').fill('nothing like this');
  await expect(main(page)).toContainText('No workspace matches this search.');
  await expect(search(page, 'Search workspaces')).toBeFocused();
  await main(page).getByRole('button', { name: 'Clear the filters' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(page).not.toHaveURL(/[?&](q|show)=/);
});

test('a key typed while the search is written in the address stays in the field (FRU-279)', async ({ page }) => {
  const asked = await stub(page);
  await visit(page, '/admin/workspaces', 'Workspaces');
  const field = search(page, 'Search workspaces');

  await typeDuringTheWrite(field, 'acm', 'e');

  await expect(page).toHaveURL(/[?&]q=acme(&|$)/);
  await expect(field).toHaveValue('acme');
  expect(asked.filter((each) => each.path === '/console/admin/workspaces').at(-1)?.q).toBe('acme');
});

test('Users: the table, the panel of a person, and the values of the mockup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1040 });
  const sent = watched(page);
  await stub(page);
  await visit(page, '/admin/users', 'Users');

  await expect(main(page).locator('header p')).toHaveText(
    'Everyone who can sign in to this instance, and in which workspaces.',
  );
  await expect(search(page, 'Search people')).toHaveAttribute('placeholder', 'Search by name or address');
  await expect(main(page).locator('label', { hasText: 'Search people' })).toHaveClass(/sr-only/);
  await expect(main(page).getByText('Show', { exact: true })).toHaveClass(/sr-only/);
  await expect(filter(page, /All people/)).toHaveAccessibleName(/Show/);

  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Person', 'Workspaces', 'Signs in with', 'Status']);
  await expect(rows(page)).toHaveCount(5);
  const cells = (row: number) => rows(page).nth(row).getByRole('cell');
  await expect(cells(0)).toHaveText([
    'NNadia Benalinadia@acme.dev',
    'Acme web · owner\nAcme support · member',
    'Email link, GitHub',
    'Instance adminToday',
  ]);
  await expect(cells(1).nth(3)).toHaveText('ActiveYesterday');
  await expect(cells(2).nth(2)).toHaveText('Google');
  await expect(cells(2).nth(3)).toHaveText('Active4 days ago');
  await expect(cells(3)).toHaveText([
    'Ssara@acme.dev',
    'Acme support · invited',
    'Not signed in yet',
    'InvitedNot seen yet',
  ]);
  await expect(cells(4).nth(1)).toHaveText('None');

  expect.soft(await styles(cells(0).nth(1), ['white-space'])).toEqual({ 'white-space': 'pre-line' });
  expect.soft(await painted(cells(0).nth(2), 'color')).toEqual(rgb(INK_SOFT));
  const avatar = cells(0).locator('.kit-avatar');
  const avatarBox = await avatar.boundingBox();
  expect.soft([avatarBox?.width, avatarBox?.height]).toEqual([32, 32]);
  const status = (row: number) => cells(row).nth(3).locator('span').first();
  for (const [row, colour] of [
    [0, INK],
    [1, DONE],
    [3, MUTED],
  ] as const) {
    expect.soft(await painted(status(row), 'color')).toEqual(rgb(colour));
    expect.soft(await styles(status(row), ['font-weight'])).toEqual({ 'font-weight': '600' });
  }
  await expectLayout(page, 'Search people', 'People of the instance', '700px');
  await expect(main(page)).toContainText(
    'The owners of each workspace see that you read its people, with your address and the day.',
  );
  await axe(page, 'the people at 1440 px');

  const link = main(page).getByRole('link', { name: 'Tom Marchal' });
  await link.click();
  await expect(page).toHaveURL(/[?&]open=a3(&|$)/);
  await expect(panel(page)).toBeFocused();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await expect(link).toHaveAttribute('aria-current', 'true');
  expect.soft(await painted(rows(page).nth(1), 'backgroundColor')).toEqual(rgb(CHIP));
  // On the chosen row, the green of « Active » stays over 4.5:1.
  expect(contrast(await painted(status(1), 'color'), rgb(CHIP))).toBeGreaterThanOrEqual(4.5);
  await expect(panel(page)).toContainText('tom@acme.dev');
  await expect(panel(page).getByRole('heading', { level: 3 })).toHaveText(['Workspaces', 'Sign-in']);
  await expect(panel(page).getByRole('listitem')).toHaveText([
    'Acme supportOwner',
    'Acme webMember',
    'Email linktom@acme.dev',
  ]);
  await expect(panel(page)).toContainText('Instance adminSees this admin and every workspace.No');
  // « Browsers signed in » of the mockup: the worker does not say it.
  await expect(panel(page)).not.toContainText('Browsers signed in');
  await expectPanel(page);
  await expectNoAction(page);
  await axe(page, 'the panel of a person at 1440 px');

  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(link).toBeFocused();

  // The administrator, and somebody invited who has no workspace yet.
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toContainText('Instance adminSees this admin and every workspace.Yes');
  await expect(panel(page).getByRole('listitem')).toHaveText([
    'Acme webOwner',
    'Acme supportMember',
    'Email linknadia@acme.dev',
    'GitHubLinked',
  ]);
  await main(page).getByRole('link', { name: 'sara@acme.dev' }).click();
  await expect(panel(page)).toHaveAccessibleName('sara@acme.dev');
  await expect(panel(page)).toContainText('Acme supportInvited');
  await expect(panel(page)).toContainText('Not signed in yet');

  expect(sent).toContain('GET /console/admin/users');
  expect(sent.filter((request) => !request.startsWith('GET ') && !request.startsWith('OPTIONS '))).toEqual([]);
});

test('Users: the search reads once, 300 ms after the last key, and the filters of the worker', async ({ page }) => {
  const asked = await stub(page);
  await visit(page, '/admin/users', 'Users');
  await expect(rows(page)).toHaveCount(5);
  const lists = () => asked.filter((each) => each.path === '/console/admin/users');
  await page.waitForTimeout(400);
  expect(lists()).toHaveLength(1);
  const before = lists().length;

  await search(page, 'Search people').pressSequentially('hugo', { delay: 50 });
  await expect(page).toHaveURL(/[?&]q=hugo(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await page.waitForTimeout(400);
  expect(lists().slice(before)).toEqual([{ path: '/console/admin/users', q: 'hugo', show: null }]);

  await search(page, 'Search people').fill('');
  await expect(rows(page)).toHaveCount(5);
  await filter(page, /All people/).click();
  // No count on an option: the worker counts the filter it answers only.
  await expect(page.getByRole('option')).toHaveText(['All people', 'Instance admins', 'In no workspace']);
  await page.getByRole('option', { name: 'Instance admins', exact: true }).click();
  await expect(page).toHaveURL(/[?&]show=admins(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await filter(page, /Instance admins/).click();
  await page.getByRole('option', { name: 'In no workspace', exact: true }).click();
  await expect(page).toHaveURL(/[?&]show=alone(&|$)/);
  await expect(rows(page)).toHaveCount(2);
  expect(lists().at(-1)).toEqual({ path: '/console/admin/users', q: null, show: 'alone' });
});

for (const [path, title] of [
  ['/admin/workspaces', 'Workspaces'],
  ['/admin/users', 'Users'],
] as const) {
  test(`an account that is not the administrator does not reach ${path}`, async ({ page }) => {
    const sent = watched(page);
    await stub(page, { admin: false });
    await page.goto(`${CONSOLE}${path}`);
    await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
    await expect(main(page).locator('h1')).toBeVisible();
    await expect(main(page).getByRole('heading', { level: 1, name: title })).toHaveCount(0);
    expect(sent.filter((request) => request.includes('/console/admin'))).toEqual([]);
  });
}

test('the states of a list: loading, a read that failed and « Try again », and no workspace at all', async ({
  page,
}) => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  const failing: { status: number | undefined } = { status: 503 };
  await stub(page, { hold, failing });
  await visit(page, '/admin/workspaces', 'Workspaces');
  await expect(main(page).getByText('Loading…')).toBeVisible();
  release();
  await expect(main(page).getByRole('alert')).toHaveText('The workspaces could not be read. Fruitback did not answer.');
  await expect(page.getByRole('table')).toHaveCount(0);
  await axe(page, 'a read that failed');
  failing.status = undefined;
  await main(page).getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(4);
  await expect(main(page).getByRole('alert')).toHaveCount(0);

  failing.status = 503;
  await page.goto(`${CONSOLE}/admin/users`);
  await expect(main(page).getByRole('alert')).toHaveText('The people could not be read. Fruitback did not answer.');
});

test('an instance with no workspace and nobody says so', async ({ page }) => {
  await stub(page, { workspaces: [], users: [] });
  await visit(page, '/admin/workspaces', 'Workspaces');
  await expect(main(page)).toContainText('No workspace on this instance yet.');
  await expect(main(page).getByRole('button', { name: 'Clear the filters' })).toHaveCount(0);
  await visit(page, '/admin/users', 'Users');
  await expect(main(page)).toContainText('Nobody has an account on this instance yet.');
});

test('the workspaces of « Instance » lead to the panel of each one', async ({ page }) => {
  await stub(page);
  // The facts of « Instance » are not what this spec measures.
  await page.route(`${WORKER_ORIGIN}/console/admin/instance`, (route) => route.fulfill({ status: 503, json: {} }));
  await visit(page, '/admin', 'Instance');
  await main(page).getByRole('button', { name: 'Show the workspaces' }).click();
  await main(page).getByRole('link', { name: 'Acme support' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/admin/workspaces?open=w9`);
  await expect(panel(page)).toHaveAccessibleName('Acme support');
  // A panel that a link of another screen opened takes no focus: nobody pressed its row.
  await expect(panel(page)).not.toBeFocused();
});

test('under 1280 px the panel opens under its row, and at 390 px nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await stub(page);
  await visit(page, '/admin/workspaces', 'Workspaces');
  await main(page).getByRole('link', { name: 'Acme support' }).click();
  await expect(panel(page)).toBeFocused();
  await expect(page.locator('table #admin-panel')).toHaveCount(1);
  // The row right under « Acme support » holds the panel.
  await expect(main(page).locator('tbody tr').nth(2).locator('#admin-panel')).toHaveCount(1);
  await expect(panel(page)).toContainText('Where notes go');
  await axe(page, 'the panel under its row at 1024 px');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('table #admin-panel')).toHaveCount(1);
  await expect(panel(page)).toBeInViewport();
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the workspaces at 390 px');

  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(page.locator('table #admin-panel')).toHaveCount(1);
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the people at 390 px');
});

test('in French, every sentence of both screens is French', async ({ page }) => {
  await stub(page, { locale: 'fr' });
  await page.goto(`${CONSOLE}/admin/workspaces?open=w9`);
  await expect(main(page).getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible();
  await expect(panel(page)).toContainText('Où vont les notes');
  await expect(search(page, 'Chercher un workspace')).toHaveAttribute(
    'placeholder',
    'Chercher par nom ou propriétaire',
  );
  await expect(main(page)).toContainText('2 notes non livrées');
  await expect(main(page)).toContainText('6 personnes · 3 sites');
  const english = [
    'Every workspace',
    'Search',
    'All workspaces',
    'Owner',
    'Notes go to',
    'people',
    'not delivered',
    'Kept in',
    'Needs attention',
    'Owned by',
    'created',
    'Where notes go',
    'See the notes',
    'People',
    'Manage in Users',
    'Everyone who visits',
    'Loading',
  ];
  const text = async () => (await page.locator('body').innerText()).replaceAll('\n', ' ');
  const workspacesText = await text();
  expect(english.filter((sentence) => workspacesText.includes(sentence))).toEqual([]);

  await page.goto(`${CONSOLE}/admin/users?open=a2`);
  await expect(main(page).getByRole('heading', { level: 1, name: 'Utilisateurs' })).toBeVisible();
  await expect(panel(page)).toContainText('Voit cette administration et chaque workspace.');
  await expect(main(page)).toContainText('Acme web · propriétaire');
  await expect(main(page)).toContainText('Lien par e-mail, GitHub');
  const usersText = await text();
  expect(
    [
      'Users',
      'Everyone who can',
      'Signs in with',
      'Instance admin',
      'Active',
      'Invited',
      'Today',
      'Yesterday',
      'days ago',
      'Not signed in yet',
      'Not seen yet',
      'Email link',
      'Sees this admin',
      'Sign-in',
      'Linked',
      'owner',
      'member',
    ].filter((sentence) => usersText.includes(sentence)),
  ).toEqual([]);
});

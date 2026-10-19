import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { contrast, painted, rgb, sideScroll, stubWorker, styles, typeDuringTheWrite } from './console-workspace.ts';

/**
 * « Workspaces » and « Users » of the administration of the instance (FRU-263), measured in a
 * browser against screens 18 and 19 of the mockup of 2026-10-13 (`18-admin-workspaces.html`,
 * `19-admin-users.html`), the switch « Instance admin » of a person (FRU-280), the suspension of
 * an account (FRU-281), the deletion of a workspace (FRU-284), and the writes of an administrator in
 * a workspace (FRU-283). The worker is answered by stubs with the shapes of
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

/**
 * The gestures of the mockup that come with FRU-274: none of them is on these screens, except
 * « Suspend » and « Restore access » of a person (FRU-281), « Delete the workspace » (FRU-284), and
 * « New workspace », « Invite someone » and « Add to a workspace » (FRU-283).
 */
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
    suspended: false,
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
    suspended: false,
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
    suspended: false,
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
    suspended: false,
    workspaces: [],
    providers: [],
    pendingInvitations: [{ workspace: { id: 'w9', name: 'Acme support' }, role: 'member' }],
  },
  {
    id: 'a9',
    name: 'Hugo Petit',
    email: 'hugo@acme.dev',
    createdAt: '2026-10-11T10:00:00.000Z',
    // Suspended, as the mockup draws him: the worker answers `instanceAdmin: false` for a suspended account.
    instanceAdmin: false,
    suspended: true,
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

function usersOf(users: typeof USERS, q: string, show: string) {
  return users.filter(
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
  /** The account of the administrator, `a1` by default, who is not in `USERS`. */
  self?: string;
  /** How many more people the worker counts than it lists: a list cut at its page. */
  cut?: number;
  /** A refusal that the role answers instead of a `200`, until it is set to `undefined`. */
  refusing?: { status: number; error: string } | undefined;
  /** Holds every answer of the role until it resolves. */
  holdRole?: Promise<void>;
  /** Each write of the role and of a suspension that the page sent. */
  posted?: Posted[];
  /** A refusal that a suspension answers instead of a `200`, until it is set to `undefined`. */
  refusingSuspension?: { status: number; error: string } | undefined;
  /** Holds every answer of a suspension until it resolves. */
  holdSuspension?: Promise<void>;
  /** A refusal that a deletion of a workspace answers instead of a `200`, until it is set to `undefined`. */
  refusingDeletion?: { status: number; error: string } | undefined;
  /** Holds every answer of a deletion until it resolves. */
  holdDeletion?: Promise<void>;
  /** A refusal that every write in a workspace answers (FRU-283), until it is set to `undefined`. */
  refusingWrite?: { status: number; error: string } | undefined;
  /** Whether the message of an invitation left (FRU-283). */
  mailed?: boolean;
};

type Posted = { path: string; body: unknown };

type Asked = { path: string; q: string | null; show: string | null };

/** The worker of an administrator, or of somebody else, and what the lists were asked. */
async function stub(page: Page, options: Options = {}): Promise<Asked[]> {
  const { admin = true, locale = 'en', failing, hold, self = 'a1', cut = 0 } = options;
  const asked: Asked[] = [];
  const me = {
    account: { id: self, email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
    instanceAdmin: admin,
  };
  const answer = (pathname: string, route: Route): Promise<void> | undefined => {
    if (pathname === '/console/me') return route.fulfill({ json: me });
    if (!pathname.startsWith('/console/admin')) return undefined;
    // The worker answers `404` to anybody else, as for a path that does not exist (FRU-261).
    if (!admin) return route.fulfill({ status: 404, json: { error: 'not-found' } });
    const role = /^\/console\/admin\/users\/([^/]+)\/instance-admin$/.exec(pathname);
    if (role !== null && route.request().method() === 'POST') return answerRole(role[1] as string, route);
    const suspension = /^\/console\/admin\/users\/([^/]+)\/suspension$/.exec(pathname);
    if (suspension !== null && route.request().method() === 'POST')
      return answerSuspension(suspension[1] as string, route);
    if (
      route.request().method() === 'POST' &&
      /^\/console\/admin\/(new-workspace|workspaces\/[^/]+\/(members(\/[^/]+\/role)?|owner|invitations))$/.test(
        pathname,
      )
    )
      return answerWrite(pathname, route);
    const deletion = /^\/console\/admin\/workspaces\/([^/]+)\/deletion$/.exec(pathname);
    if (deletion !== null && route.request().method() === 'POST') return answerDeletion(deletion[1] as string, route);
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
      const found = [
        ...workspacesOf(q ?? '', show ?? 'all').filter(
          (each) => (options.workspaces ?? WORKSPACES).includes(each) && !gone.has(each.id),
        ),
        ...made,
      ];
      return reply({ workspaces: found, total: found.length });
    }
    if (pathname === '/console/admin/workspaces/w9') return reply(DETAIL);
    if (pathname.startsWith('/console/admin/workspaces/'))
      return reply({ ...DETAIL, id: pathname.split('/').pop(), members: [], sites: [], destinations: [] });
    if (pathname === '/console/admin/users') {
      const found = usersOf(options.users ?? USERS, q ?? '', show ?? 'all');
      return reply({ users: found, total: found.length + cut });
    }

    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  };
  const answerRole = async (id: string, route: Route): Promise<void> => {
    const body = route.request().postDataJSON() as { admin: boolean };
    options.posted?.push({ path: new URL(route.request().url()).pathname, body });
    await (options.holdRole ?? Promise.resolve());
    const refused = options.refusing;
    if (refused !== undefined) return route.fulfill({ status: refused.status, json: { error: refused.error } });

    return route.fulfill({ json: { user: { id, instanceAdmin: body.admin }, changed: true } });
  };
  // The workspaces that a deletion took away: the lists leave them out after it, as the worker does.
  const gone = new Set<string>();
  // The workspaces that « New workspace » made: the list answers them after it, as the worker does.
  const made: (typeof WORKSPACES)[number][] = [];
  /** The writes of an administrator in a workspace (FRU-283), with the shapes of `instance-admin.ts`. */
  const answerWrite = async (path: string, route: Route): Promise<void> => {
    const body = route.request().postDataJSON() as Record<string, string>;
    options.posted?.push({ path, body });
    const refused = options.refusingWrite;
    if (refused !== undefined) return route.fulfill({ status: refused.status, json: { error: refused.error } });
    if (path === '/console/admin/new-workspace') {
      const workspace = {
        ...WORKSPACES[2],
        id: 'w20',
        name: body.name ?? '',
        owners: [{ id: 'a5', email: body.owner ?? '' }],
      };
      made.push(workspace as (typeof WORKSPACES)[number]);

      return route.fulfill({
        status: 201,
        json: { workspace: { id: 'w20', name: body.name }, owner: { id: 'a5', email: body.owner } },
      });
    }
    if (path.endsWith('/role'))
      return route.fulfill({ json: { member: { id: path.split('/')[6], role: body.role }, changed: true } });
    if (path.endsWith('/owner'))
      return route.fulfill({
        json: { owner: { id: 'a5', email: body.email }, previous: ['tom@acme.dev'], changed: true },
      });
    if (path.endsWith('/invitations'))
      return route.fulfill({
        json: {
          invitation: {
            id: 'inv_1',
            email: body.email,
            role: body.role,
            expiresAt: '2026-10-27T00:00:00.000Z',
            mailed: options.mailed ?? true,
          },
        },
      });

    return route.fulfill({ json: { member: { id: 'a5', email: body.email ?? 'ines@acme.dev', role: body.role } } });
  };
  const answerDeletion = async (id: string, route: Route): Promise<void> => {
    const body = route.request().postDataJSON() as { name: string };
    options.posted?.push({ path: new URL(route.request().url()).pathname, body });
    await (options.holdDeletion ?? Promise.resolve());
    const refused = options.refusingDeletion;
    if (refused !== undefined) return route.fulfill({ status: refused.status, json: { error: refused.error } });
    const workspace = WORKSPACES.find((each) => each.id === id);
    if (workspace === undefined || workspace.name !== body.name)
      return route.fulfill({ status: 409, json: { error: 'name-mismatch' } });
    gone.add(id);

    return route.fulfill({
      json: {
        workspace: { id, name: workspace.name },
        gone: { sites: workspace.sites, members: workspace.members, invitations: 0, connectors: 1, keptNotes: 3 },
      },
    });
  };
  const answerSuspension = async (id: string, route: Route): Promise<void> => {
    const body = route.request().postDataJSON() as { suspended: boolean };
    options.posted?.push({ path: new URL(route.request().url()).pathname, body });
    await (options.holdSuspension ?? Promise.resolve());
    const refused = options.refusingSuspension;
    if (refused !== undefined) return route.fulfill({ status: refused.status, json: { error: refused.error } });

    return route.fulfill({ json: { user: { id, suspended: body.suspended }, changed: true } });
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
/** The switch « Instance admin » of the open panel. */
const adminSwitch = (page: Page) => page.locator('#admin-panel').getByRole('switch', { name: /^Instance admin/ });
/** The track of the switch of the open panel, which a pointer presses: the input under it is hidden. */
const track = (page: Page) => page.locator('#admin-panel .kit-toggle .switch__control');
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

/**
 * No gesture of FRU-274 is drawn, not even disabled, but those of `drawn`. Nothing switches but
 * « Instance admin » in the panel of a person (FRU-280), when `switches` is 1.
 */
async function expectNoAction(page: Page, switches: 0 | 1 = 0, drawn: readonly string[] = []): Promise<void> {
  for (const name of ACTIONS.filter((action) => typeof action !== 'string' || !drawn.includes(action))) {
    await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByRole('link', { name })).toHaveCount(0);
  }
  await expect(main(page).getByRole('switch')).toHaveCount(switches);
  await expect(panel(page).getByRole('switch')).toHaveCount(switches);
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
  await expectNoAction(page, 0, ['Delete the workspace', 'New workspace', 'Invite someone']);
  await expect(panel(page).locator('.kit-panel__foot').getByRole('button')).toHaveText(['Delete the workspace']);
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
  await expect(adminSwitch(page)).not.toBeChecked();
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).toContainText('Sees this admin and every workspace.');
  // The words of the mockup: the label in bold, and the line under it.
  expect
    .soft(await styles(panel(page).locator('.kit-toggle .label'), ['font-weight']))
    .toEqual({ 'font-weight': '600' });
  // « Browsers signed in » of the mockup: the worker does not say it.
  await expect(panel(page)).not.toContainText('Browsers signed in');
  await expectPanel(page);
  // « Suspend » of FRU-281, in the foot of an active account.
  await expect(
    panel(page).locator('.kit-panel__foot').getByRole('button', { name: 'Suspend', exact: true }),
  ).toBeEnabled();
  await expectNoAction(page, 1, ['Suspend', 'Add to a workspace']);
  await axe(page, 'the panel of a person at 1440 px');

  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(link).toBeFocused();

  // The administrator, and somebody invited who has no workspace yet.
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toHaveAccessibleName('Nadia Benali');
  await expect(adminSwitch(page)).toBeChecked();
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
  await expect(panel(page)).toHaveAccessibleName('Acme support');
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
  await expect(panel(page)).toHaveAccessibleName('Acme support');
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
      'Suspended',
      'Restore access',
      'cannot be suspended',
    ].filter((sentence) => usersText.includes(sentence)),
  ).toEqual([]);
});

const SELF_REMOVAL = 'You cannot take this role from yourself. Another instance admin can.';
const LAST_ADMIN = 'The last instance admin keeps the role. Name another admin first.';
const NAMES_TOM = 'Name Tom Marchal admin';
const REMOVES_TOM = 'Remove Tom Marchal as admin';
const REMOVES_NADIA = 'Remove Nadia Benali as admin';
/** The second time of the gesture, by the button that sends. */
const confirmation = (page: Page, name: string) => panel(page).getByRole('group', { name });
const statusOf = (page: Page, row: number) => rows(page).nth(row).getByRole('cell').nth(3).locator('span').first();

test('Users: an admin names a person after a confirmation, then removes them the same way (FRU-280)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1040 });
  const posted: Posted[] = [];
  await stub(page, { posted });
  await visit(page, '/admin/users?open=a3', 'Users');
  await expect(adminSwitch(page)).not.toBeChecked();

  await track(page).click();
  const naming = confirmation(page, NAMES_TOM);
  await expect(naming).toContainText(
    'Tom Marchal sees this admin and every workspace, and can name and remove admins. Every instance admin reads that you made this change.',
  );
  await expect(naming.getByRole('button', { name: 'Keep it' })).toBeFocused();
  // The press asks: the switch still shows the role of the list, and nothing left.
  await expect(adminSwitch(page)).not.toBeChecked();
  expect(posted).toEqual([]);
  await axe(page, 'the confirmation of a new admin');

  await naming.getByRole('button', { name: NAMES_TOM }).click();
  await expect(naming).toHaveCount(0);
  await expect(adminSwitch(page)).toBeChecked();
  await expect(adminSwitch(page)).toBeFocused();
  await expect(statusOf(page, 1)).toHaveText('Instance admin');
  expect(posted).toEqual([{ path: '/console/admin/users/a3/instance-admin', body: { admin: true } }]);
  // Two admins now: the one of before is no longer the last one.
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toHaveAccessibleName('Nadia Benali');
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(LAST_ADMIN);

  await main(page).getByRole('link', { name: 'Tom Marchal' }).click();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await track(page).click();
  const removing = confirmation(page, REMOVES_TOM);
  await expect(removing).toContainText(
    'Tom Marchal no longer sees this admin, nor the workspaces they are not a member of. Every instance admin reads that you made this change.',
  );
  expect(posted).toHaveLength(1);
  await removing.getByRole('button', { name: REMOVES_TOM }).click();
  await expect(adminSwitch(page)).not.toBeChecked();
  await expect(statusOf(page, 1)).toHaveText('Active');
  expect(posted.at(-1)).toEqual({ path: '/console/admin/users/a3/instance-admin', body: { admin: false } });
  await expect(main(page).getByRole('alert')).toHaveCount(0);
});

test('Users: « Keep it » and Escape send nothing, and give focus back to the switch (FRU-280)', async ({ page }) => {
  const posted: Posted[] = [];
  await stub(page, { posted });
  await visit(page, '/admin/users?open=a3', 'Users');

  await track(page).click();
  await confirmation(page, NAMES_TOM).getByRole('button', { name: 'Keep it' }).click();
  await expect(confirmation(page, NAMES_TOM)).toHaveCount(0);
  await expect(adminSwitch(page)).toBeFocused();
  await expect(adminSwitch(page)).not.toBeChecked();

  // Space presses the switch, and Escape steps back from the confirmation and leaves the panel open.
  await page.keyboard.press('Space');
  await expect(confirmation(page, NAMES_TOM).getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation(page, NAMES_TOM)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(adminSwitch(page)).toBeFocused();
  await page.waitForTimeout(200);
  expect(posted).toEqual([]);
});

test('Users: the switch is held on yourself and on the last admin, and says why (FRU-280)', async ({ page }) => {
  const posted: Posted[] = [];
  // The administrator is Nadia, who also is the last one: the worker checks the caller first.
  await stub(page, { posted, self: 'a2' });
  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(adminSwitch(page)).toBeChecked();
  await expect(adminSwitch(page)).toBeDisabled();
  await expect(panel(page)).toContainText(SELF_REMOVAL);
  await expect(panel(page)).not.toContainText(LAST_ADMIN);
  await track(page).click({ force: true });
  await expect(panel(page).getByRole('group')).toHaveCount(0);
  // Another person of the list is not held.
  await main(page).getByRole('link', { name: 'Tom Marchal' }).click();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(SELF_REMOVAL);
  expect(posted).toEqual([]);
});

test('Users: the last admin is held only when the list holds every admin (FRU-280)', async ({ page }) => {
  await stub(page);
  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(adminSwitch(page)).toBeDisabled();
  await expect(panel(page)).toContainText(LAST_ADMIN);
  await axe(page, 'the switch of the last admin');

  // The filter of the admins holds them all too.
  await page.goto(`${CONSOLE}/admin/users?show=admins&open=a2`);
  await expect(adminSwitch(page)).toBeDisabled();

  // A search holds some of them: the console does not guess, and the worker answers.
  await page.goto(`${CONSOLE}/admin/users?q=nadia&open=a2`);
  await expect(adminSwitch(page)).toBeChecked();
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(LAST_ADMIN);
});

test('Users: a list cut at its page does not guess the last admin', async ({ page }) => {
  await stub(page, { cut: 150 });
  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(LAST_ADMIN);
});

test('Users: while a list is read again, the last admin is counted on the question of the rows shown (FRU-280)', async ({
  page,
}) => {
  // Two administrators: Nadia is never the last one.
  const users = USERS.map((user) => (user.id === 'a3' ? { ...user, instanceAdmin: true } : user));
  await stub(page, { users });
  await visit(page, '/admin/users?q=nadia&open=a2', 'Users');
  await expect(rows(page)).toHaveCount(1);
  await expect(adminSwitch(page)).toBeEnabled();

  // The next list waits: the rows of the search stay, under an address with no search.
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/console/admin/users', async (route) => {
    await gate;
    await route.fallback();
  });
  await search(page, 'Search people').fill('');
  await expect(page).not.toHaveURL(/q=/);
  await expect(rows(page)).toHaveCount(1);
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(LAST_ADMIN);

  release();
  await expect(rows(page)).toHaveCount(users.length);
  await expect(adminSwitch(page)).toBeEnabled();
});

test('Users: each refusal of the worker is said, and the switch shows the role it has (FRU-280)', async ({ page }) => {
  const posted: Posted[] = [];
  const refusing: { status: number; error: string } = { status: 409, error: 'last-admin' };
  const options: Options = { posted, cut: 150, refusing };
  await stub(page, options);
  await visit(page, '/admin/users?open=a2', 'Users');

  const refused = async (sentence: string) => {
    await track(page).click();
    await confirmation(page, REMOVES_NADIA).getByRole('button', { name: REMOVES_NADIA }).click();
    await expect(panel(page).getByRole('alert')).toHaveText(sentence);
    await expect(adminSwitch(page)).toBeChecked();
    await expect(adminSwitch(page)).toBeEnabled();
    await expect(adminSwitch(page)).toBeFocused();
    await expect(statusOf(page, 0)).toHaveText('Instance admin');
  };

  await refused(LAST_ADMIN);
  await axe(page, 'a refusal of the role');
  options.refusing = { status: 409, error: 'self-removal' };
  await refused(SELF_REMOVAL);
  options.refusing = { status: 500, error: 'down' };
  await refused('Fruitback did not answer. Try again.');
  options.refusing = { status: 404, error: 'not-found' };
  await refused('The role did not change. Try again.');
  expect(posted).toHaveLength(4);

  options.refusing = undefined;
  await track(page).click();
  // The sentence of the refusal stays until the next answer: no error path clears what it says.
  await expect(panel(page).getByRole('alert')).toHaveText('The role did not change. Try again.');
  await confirmation(page, REMOVES_NADIA).getByRole('button', { name: REMOVES_NADIA }).click();
  await expect(adminSwitch(page)).not.toBeChecked();
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('Users: the switch is busy while the worker answers, and a second press sends nothing (FRU-280)', async ({
  page,
}) => {
  const posted: Posted[] = [];
  let release = () => {};
  const holdRole = new Promise<void>((resolve) => (release = resolve));
  await stub(page, { posted, holdRole });
  await visit(page, '/admin/users?open=a3', 'Users');

  await track(page).click();
  const send = confirmation(page, NAMES_TOM).getByRole('button', { name: NAMES_TOM });
  await send.dblclick();
  await expect(adminSwitch(page)).toBeDisabled();
  await send.click();
  await track(page).click({ force: true });
  await page.waitForTimeout(200);
  expect(posted).toHaveLength(1);
  await expect(adminSwitch(page)).not.toBeChecked();

  release();
  await expect(adminSwitch(page)).toBeChecked();
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(confirmation(page, NAMES_TOM)).toHaveCount(0);
  expect(posted).toHaveLength(1);
});

test('Users: the switch and its confirmation in French, and at 390 px (FRU-280)', async ({ page }) => {
  const refusing = { status: 409, error: 'last-admin' };
  const options: Options = { locale: 'fr', cut: 150, refusing };
  await stub(page, options);
  await page.goto(`${CONSOLE}/admin/users?open=a2`);
  const role = panel(page).getByRole('switch', { name: /^Administrateur de l’instance/ });
  await expect(role).toBeChecked();
  await track(page).click();
  const asking = panel(page).getByRole('group', { name: 'Retirer le rôle à Nadia Benali' });
  await expect(asking).toContainText(
    'Nadia Benali ne voit plus cette administration, ni les workspaces dont cette personne n’est pas membre. Chaque administrateur de l’instance lit que vous avez fait ce changement.',
  );
  await expect(asking.getByRole('button', { name: 'Le garder' })).toBeVisible();
  await asking.getByRole('button', { name: /^Retirer/ }).click();
  await expect(panel(page).getByRole('alert')).toHaveText(
    'Le dernier administrateur de l’instance garde le rôle. Nommez d’abord un autre administrateur.',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/admin/users?open=a3`);
  await expect(panel(page).getByRole('switch', { name: /^Administrateur de l’instance/ })).not.toBeChecked();
  await track(page).click();
  const naming = panel(page).getByRole('group', { name: 'Nommer Tom Marchal administrateur' });
  await expect(naming).toContainText('Tom Marchal voit cette administration et chaque workspace');
  await expect(naming.getByRole('button', { name: /^Nommer/ })).toBeInViewport();
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the confirmation at 390 px');
  const text = (await panel(page).innerText()).replaceAll('\n', ' ');
  expect(
    ['Instance admin', 'Keep it', 'sees this admin', 'Every instance admin', 'Name Tom'].filter((sentence) =>
      text.includes(sentence),
    ),
  ).toEqual([]);

  // A person's own switch says why in French.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stub(page, { locale: 'fr', self: 'a2' });
  await page.goto(`${CONSOLE}/admin/users?open=a2`);
  await expect(panel(page)).toContainText(
    'Vous ne pouvez pas vous retirer ce rôle. Un autre administrateur de l’instance le peut.',
  );
});

const SELF_SUSPENSION = 'You cannot suspend your own account. Another instance admin can.';
const LAST_SUSPENSION = 'The last instance admin cannot be suspended. Name another admin first.';
const ROLE_OF_SUSPENDED = 'A suspended account is not an instance admin. Restore access first.';
const ROLE_AFTER_RESTORE = 'Its role shows when you open Users again.';
const SUSPENDS_TOM = 'Suspend Tom Marchal';
const SUSPENDS_NADIA = 'Suspend Nadia Benali';
const RESTORES_TOM = 'Restore access for Tom Marchal';
const RESTORES_HUGO = 'Restore access for Hugo Petit';
/** « Suspend » of the open panel, and not the button of its confirmation. */
const suspend = (page: Page) => panel(page).getByRole('button', { name: 'Suspend', exact: true });
const restore = (page: Page) => panel(page).getByRole('button', { name: 'Restore access', exact: true });

test('Users: a suspended person reads « Suspended », in the row and in the panel (FRU-281)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1040 });
  const sent = watched(page);
  await stub(page);
  await visit(page, '/admin/users', 'Users');

  await expect(statusOf(page, 4)).toHaveText('Suspended');
  // The red of the mockup on a row that is not chosen, in its weight.
  expect.soft(await painted(statusOf(page, 4), 'color')).toEqual(rgb(ACCENT));
  expect.soft(await styles(statusOf(page, 4), ['font-weight'])).toEqual({ 'font-weight': '600' });
  expect(contrast(await painted(statusOf(page, 4), 'color'), rgb('#ffffff'))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(await painted(statusOf(page, 4), 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);

  await main(page).getByRole('link', { name: 'Hugo Petit' }).click();
  await expect(panel(page)).toHaveAccessibleName('Hugo Petit');
  await expect(panel(page)).toBeFocused();
  // On the chosen row, the red of the mockup is 4.28:1: the row takes the darker red of the kit.
  expect.soft(await painted(statusOf(page, 4), 'color')).toEqual(rgb(ACCENT_STRONG));
  expect(contrast(await painted(statusOf(page, 4), 'color'), rgb(CHIP))).toBeGreaterThanOrEqual(4.5);

  const notice = panel(page).getByRole('status');
  await expect(notice).toHaveText('SuspendedHugo Petit cannot sign in, and every session they had ended.');
  const word = notice.locator('span').first();
  expect.soft(await styles(word, ['font-weight'])).toEqual({ 'font-weight': '600' });
  expect(contrast(await painted(word, 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);
  await expect(restore(page)).toBeEnabled();
  await expect(suspend(page)).toHaveCount(0);
  // The worker counts a suspended admin as no admin: the switch is held, and says why.
  await expect(adminSwitch(page)).not.toBeChecked();
  await expect(adminSwitch(page)).toBeDisabled();
  await expect(panel(page)).toContainText(ROLE_OF_SUSPENDED);
  await axe(page, 'the panel of a suspended person');

  expect(sent.filter((request) => !request.startsWith('GET ') && !request.startsWith('OPTIONS '))).toEqual([]);
});

test('Users: an admin suspends a person after a confirmation, then restores them (FRU-281)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1040 });
  const posted: Posted[] = [];
  const asked = await stub(page, { posted });
  await visit(page, '/admin/users?open=a3', 'Users');

  await suspend(page).click();
  const suspending = confirmation(page, SUSPENDS_TOM);
  await expect(suspending).toContainText(
    'Tom Marchal cannot sign in by any method, and their sessions of the console and of the extension end at once. Their notes stay. The owners of each of their workspaces see that you did it.',
  );
  await expect(suspending.getByRole('button', { name: 'Keep it' })).toBeFocused();
  // The press asks: the row still shows the state of the list, and nothing left.
  await expect(statusOf(page, 1)).toHaveText('Active');
  expect(posted).toEqual([]);
  await axe(page, 'the confirmation of a suspension');

  await suspending.getByRole('button', { name: SUSPENDS_TOM }).click();
  await expect(suspending).toHaveCount(0);
  await expect(statusOf(page, 1)).toHaveText('Suspended');
  await expect(panel(page).getByRole('status')).toContainText('Tom Marchal cannot sign in');
  await expect(suspend(page)).toHaveCount(0);
  await expect(restore(page)).toBeFocused();
  expect(posted).toEqual([{ path: '/console/admin/users/a3/suspension', body: { suspended: true } }]);

  await restore(page).click();
  const restoring = confirmation(page, RESTORES_TOM);
  await expect(restoring).toContainText(
    'Tom Marchal can sign in again. Their old sessions stay ended. The owners of each of their workspaces see that you did it.',
  );
  await expect(restoring.getByRole('button', { name: 'Keep it' })).toBeFocused();
  expect(posted).toHaveLength(1);
  await axe(page, 'the confirmation of a restoration');
  await restoring.getByRole('button', { name: RESTORES_TOM }).click();
  await expect(statusOf(page, 1)).toHaveText('Active');
  await expect(restore(page)).toHaveCount(0);
  await expect(suspend(page)).toBeFocused();
  expect(posted.at(-1)).toEqual({ path: '/console/admin/users/a3/suspension', body: { suspended: false } });
  await expect(main(page).getByRole('alert')).toHaveCount(0);
  // The row changed in place: each read leaves a trace, and the list was read once.
  expect(asked.filter((each) => each.path === '/console/admin/users')).toHaveLength(1);
});

test('Users: « Keep it » and Escape send nothing, and give focus back to « Suspend » and « Restore access » (FRU-281)', async ({
  page,
}) => {
  const posted: Posted[] = [];
  await stub(page, { posted });
  await visit(page, '/admin/users?open=a3', 'Users');

  await suspend(page).click();
  await confirmation(page, SUSPENDS_TOM).getByRole('button', { name: 'Keep it' }).click();
  await expect(confirmation(page, SUSPENDS_TOM)).toHaveCount(0);
  await expect(suspend(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmation(page, SUSPENDS_TOM).getByRole('button', { name: 'Keep it' })).toBeFocused();
  // Escape steps back from the confirmation and leaves the panel open.
  await page.keyboard.press('Escape');
  await expect(confirmation(page, SUSPENDS_TOM)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(suspend(page)).toBeFocused();
  await expect(statusOf(page, 1)).toHaveText('Active');

  await main(page).getByRole('link', { name: 'Hugo Petit' }).click();
  await expect(panel(page)).toHaveAccessibleName('Hugo Petit');
  await restore(page).click();
  await confirmation(page, RESTORES_HUGO).getByRole('button', { name: 'Keep it' }).click();
  await expect(restore(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmation(page, RESTORES_HUGO).getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirmation(page, RESTORES_HUGO)).toHaveCount(0);
  await expect(restore(page)).toBeFocused();
  await expect(statusOf(page, 4)).toHaveText('Suspended');
  await page.waitForTimeout(200);
  expect(posted).toEqual([]);
});

test('Users: « Suspend » is held on yourself and on the last admin, and a suspended admin is no admin (FRU-281)', async ({
  page,
}) => {
  const posted: Posted[] = [];
  // The administrator is Nadia, who also is the last one: the worker checks the caller first.
  await stub(page, { posted, self: 'a2' });
  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(suspend(page)).toBeDisabled();
  await expect(panel(page)).toContainText(SELF_SUSPENSION);
  await expect(panel(page)).not.toContainText(LAST_SUSPENSION);
  await suspend(page).click({ force: true });
  await expect(panel(page).getByRole('group')).toHaveCount(0);
  await main(page).getByRole('link', { name: 'Tom Marchal' }).click();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await expect(suspend(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(SELF_SUSPENSION);

  await stub(page, { posted });
  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(suspend(page)).toBeDisabled();
  await expect(panel(page)).toContainText(LAST_SUSPENSION);
  await axe(page, 'the suspension of the last admin');

  // Tom is named admin: Nadia is no longer the last one.
  await main(page).getByRole('link', { name: 'Tom Marchal' }).click();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await track(page).click();
  await confirmation(page, NAMES_TOM).getByRole('button', { name: NAMES_TOM }).click();
  await expect(statusOf(page, 1)).toHaveText('Instance admin');
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toHaveAccessibleName('Nadia Benali');
  await expect(suspend(page)).toBeEnabled();
  // Tom is suspended: a suspended admin is no admin, and Nadia is the last one again.
  await main(page).getByRole('link', { name: 'Tom Marchal' }).click();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await suspend(page).click();
  await confirmation(page, SUSPENDS_TOM).getByRole('button', { name: SUSPENDS_TOM }).click();
  await expect(statusOf(page, 1)).toHaveText('Suspended');
  await expect(adminSwitch(page)).not.toBeChecked();
  await expect(panel(page)).toContainText(ROLE_OF_SUSPENDED);
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toHaveAccessibleName('Nadia Benali');
  await expect(suspend(page)).toBeDisabled();
  await expect(panel(page)).toContainText(LAST_SUSPENSION);
  await expect(adminSwitch(page)).toBeDisabled();
  await expect(panel(page)).toContainText(LAST_ADMIN);
  // Tom is restored: his role of before shows again, and Nadia is not the last one.
  await main(page).getByRole('link', { name: 'Tom Marchal' }).click();
  await expect(panel(page)).toHaveAccessibleName('Tom Marchal');
  await restore(page).click();
  await confirmation(page, RESTORES_TOM).getByRole('button', { name: RESTORES_TOM }).click();
  await expect(statusOf(page, 1)).toHaveText('Instance admin');
  await expect(adminSwitch(page)).toBeChecked();
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toHaveAccessibleName('Nadia Benali');
  await expect(suspend(page)).toBeEnabled();

  // A search holds some admins: the console does not guess, and the worker answers.
  await page.goto(`${CONSOLE}/admin/users?q=nadia&open=a2`);
  await expect(suspend(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(LAST_SUSPENSION);
  expect(posted.map((each) => each.path)).toEqual([
    '/console/admin/users/a3/instance-admin',
    '/console/admin/users/a3/suspension',
    '/console/admin/users/a3/suspension',
  ]);
});

test('Users: after the restoration of an account read as suspended, the last admin is not guessed (FRU-281)', async ({
  page,
}) => {
  await stub(page);
  await visit(page, '/admin/users?open=a2', 'Users');
  await expect(suspend(page)).toBeDisabled();

  // The worker does not say the role of a suspended account: Hugo can be an admin again.
  await main(page).getByRole('link', { name: 'Hugo Petit' }).click();
  await expect(panel(page)).toHaveAccessibleName('Hugo Petit');
  await restore(page).click();
  await confirmation(page, RESTORES_HUGO).getByRole('button', { name: RESTORES_HUGO }).click();
  await expect(statusOf(page, 4)).toHaveText('Active');
  // Nor does a restore: the switch of Hugo does not say « No » for a role the console does not know.
  await expect(adminSwitch(page)).toBeDisabled();
  await expect(panel(page)).toContainText(ROLE_AFTER_RESTORE);
  await main(page).getByRole('link', { name: 'Nadia Benali' }).click();
  await expect(panel(page)).toHaveAccessibleName('Nadia Benali');
  await expect(suspend(page)).toBeEnabled();
  await expect(adminSwitch(page)).toBeEnabled();
  await expect(panel(page)).not.toContainText(LAST_SUSPENSION);
  await expect(panel(page)).not.toContainText(LAST_ADMIN);
});

test('Users: each refusal of a suspension is said, and the row keeps its true state (FRU-281)', async ({ page }) => {
  const posted: Posted[] = [];
  const options: Options = { posted, cut: 150, refusingSuspension: { status: 409, error: 'last-admin' } };
  await stub(page, options);
  await visit(page, '/admin/users?open=a2', 'Users');

  const refused = async (sentence: string) => {
    await suspend(page).click();
    await confirmation(page, SUSPENDS_NADIA).getByRole('button', { name: SUSPENDS_NADIA }).click();
    await expect(panel(page).getByRole('alert')).toHaveText(sentence);
    await expect(confirmation(page, SUSPENDS_NADIA)).toHaveCount(0);
    await expect(statusOf(page, 0)).toHaveText('Instance admin');
    await expect(restore(page)).toHaveCount(0);
    await expect(suspend(page)).toBeEnabled();
    await expect(suspend(page)).toBeFocused();
    await expect(adminSwitch(page)).toBeChecked();
  };

  await refused(LAST_SUSPENSION);
  await axe(page, 'a refusal of a suspension');
  options.refusingSuspension = { status: 409, error: 'self-suspension' };
  await refused(SELF_SUSPENSION);
  options.refusingSuspension = { status: 500, error: 'down' };
  await refused('Fruitback did not answer. Try again.');
  options.refusingSuspension = { status: 404, error: 'not-found' };
  await refused('Nothing changed. Try again.');
  options.refusingSuspension = { status: 400, error: 'invalid-suspended' };
  await refused('Nothing changed. Try again.');
  expect(posted).toHaveLength(5);

  // A refused restoration leaves the account suspended.
  options.refusingSuspension = { status: 502, error: 'down' };
  await main(page).getByRole('link', { name: 'Hugo Petit' }).click();
  await expect(panel(page)).toHaveAccessibleName('Hugo Petit');
  await restore(page).click();
  await confirmation(page, RESTORES_HUGO).getByRole('button', { name: RESTORES_HUGO }).click();
  await expect(panel(page).getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
  await expect(statusOf(page, 4)).toHaveText('Suspended');
  await expect(restore(page)).toBeFocused();

  options.refusingSuspension = undefined;
  await restore(page).click();
  // The sentence of the refusal stays until the next answer: no error path clears what it says.
  await expect(panel(page).getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
  await confirmation(page, RESTORES_HUGO).getByRole('button', { name: RESTORES_HUGO }).click();
  await expect(statusOf(page, 4)).toHaveText('Active');
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
});

test('Users: « Suspend » is busy while the worker answers, and a second press sends nothing (FRU-281)', async ({
  page,
}) => {
  const posted: Posted[] = [];
  let release = () => {};
  const holdSuspension = new Promise<void>((resolve) => (release = resolve));
  await stub(page, { posted, holdSuspension });
  await visit(page, '/admin/users?open=a3', 'Users');

  await suspend(page).click();
  const send = confirmation(page, SUSPENDS_TOM).getByRole('button', { name: SUSPENDS_TOM });
  await send.dblclick();
  await expect(suspend(page)).toBeDisabled();
  await send.click();
  await suspend(page).click({ force: true });
  await page.waitForTimeout(200);
  expect(posted).toHaveLength(1);
  await expect(statusOf(page, 1)).toHaveText('Active');

  release();
  await expect(statusOf(page, 1)).toHaveText('Suspended');
  await expect(restore(page)).toBeEnabled();
  await expect(confirmation(page, SUSPENDS_TOM)).toHaveCount(0);
  expect(posted).toHaveLength(1);
});

test('Users: the suspension and its confirmations in French, and at 390 px (FRU-281)', async ({ page }) => {
  const options: Options = { locale: 'fr', cut: 150, refusingSuspension: { status: 409, error: 'last-admin' } };
  await stub(page, options);
  await page.goto(`${CONSOLE}/admin/users?open=a9`);
  await expect(statusOf(page, 4)).toHaveText('Suspendu');
  await expect(panel(page).getByRole('status')).toHaveText(
    'SuspenduHugo Petit ne peut plus se connecter, et chacune de ses sessions a pris fin.',
  );
  await expect(panel(page)).toContainText(
    'Un compte suspendu n’est pas administrateur de l’instance. Rétablissez d’abord son accès.',
  );
  await panel(page).getByRole('button', { name: 'Rétablir l’accès', exact: true }).click();
  await expect(panel(page).getByRole('group', { name: 'Rétablir l’accès de Hugo Petit' })).toContainText(
    'Hugo Petit peut de nouveau se connecter. Ses anciennes sessions restent fermées. Les propriétaires de chacun de ses workspaces voient que vous l’avez fait.',
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/admin/users?open=a2`);
  await panel(page).getByRole('button', { name: 'Suspendre', exact: true }).click();
  const asking = panel(page).getByRole('group', { name: 'Suspendre Nadia Benali' });
  await expect(asking).toContainText(
    'Nadia Benali ne peut plus se connecter d’aucune façon, et ses sessions de la console et de l’extension prennent fin aussitôt. Ses notes restent. Les propriétaires de chacun de ses workspaces voient que vous l’avez fait.',
  );
  await expect(asking.getByRole('button', { name: 'Le garder' })).toBeFocused();
  await expect(asking.getByRole('button', { name: 'Suspendre Nadia Benali' })).toBeInViewport();
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the confirmation of a suspension at 390 px');
  const text = (await panel(page).innerText()).replaceAll('\n', ' ');
  expect(
    ['Suspend ', 'Keep it', 'cannot sign in', 'Their notes', 'owners'].filter((sentence) => text.includes(sentence)),
  ).toEqual([]);
  await asking.getByRole('button', { name: 'Suspendre Nadia Benali' }).click();
  await expect(panel(page).getByRole('alert')).toHaveText(
    'Le dernier administrateur de l’instance ne peut pas être suspendu. Nommez d’abord un autre administrateur.',
  );
  await expect(panel(page).getByRole('alert')).toBeInViewport();
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'a refusal of a suspension at 390 px');

  await page.goto(`${CONSOLE}/admin/users?open=a9`);
  await expect(panel(page).getByRole('status')).toBeInViewport();
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'a suspended person at 390 px');

  // A person's own « Suspend » says why in French.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stub(page, { locale: 'fr', self: 'a2' });
  await page.goto(`${CONSOLE}/admin/users?open=a2`);
  await expect(panel(page)).toContainText(
    'Vous ne pouvez pas suspendre votre propre compte. Un autre administrateur de l’instance le peut.',
  );
});

/** The button that deletes the workspace of the open panel, once « Delete the workspace » was pressed. */
const deleteButton = (page: Page, name: string) => panel(page).getByRole('button', { name: `Delete ${name}` });
const nameField = (page: Page, name: string) => panel(page).getByRole('textbox', { name: `Type ${name} to confirm` });

test('Workspaces: an admin deletes a workspace after typing its name, and the row goes (FRU-284)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: Posted[] = [];
  const sent = watched(page);
  await stub(page, { posted });
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  await expect(panel(page)).toHaveAccessibleName('Acme support');

  await panel(page).getByRole('button', { name: 'Delete the workspace' }).click();
  const asking = panel(page).getByRole('group', { name: 'Delete Acme support' });
  await expect(asking).toContainText(
    'Acme support is deleted at once, and nothing brings it back. Its sites, its members, its invitations, its connectors and the notes that Fruitback keeps for it go. The issues already sent to its sources stay there, and its people keep their accounts. Every instance admin reads that you did it.',
  );
  // The field has focus, and the button that deletes is held until the name is typed as it is written.
  await expect(nameField(page, 'Acme support')).toBeFocused();
  await expect(deleteButton(page, 'Acme support')).toBeDisabled();
  for (const typed of ['acme support', 'Acme', 'Acme supports']) {
    await nameField(page, 'Acme support').fill(typed);
    await expect(deleteButton(page, 'Acme support')).toBeDisabled();
  }
  await axe(page, 'the confirmation of a deletion at 1440 px');
  await nameField(page, 'Acme support').fill('Acme support');
  await expect(deleteButton(page, 'Acme support')).toBeEnabled();
  expect(posted).toEqual([]);

  await deleteButton(page, 'Acme support').click();
  const said = main(page).getByRole('status').filter({ hasText: 'Acme support was deleted.' });
  await expect(said).toHaveText('Acme support was deleted. Every instance admin reads it on the page Instance.');
  await expect(said).toBeFocused();
  await expect(panel(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);
  await expect(main(page).getByRole('link', { name: 'Acme support' })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  expect(posted).toEqual([{ path: '/console/admin/workspaces/w9/deletion', body: { name: 'Acme support' } }]);
  expect(sent.filter((request) => request.startsWith('POST '))).toEqual(['POST /console/admin/workspaces/w9/deletion']);
});

test('Workspaces: « Keep it » and Escape send nothing, keep the panel, and give focus back to « Delete the workspace » (FRU-284)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: Posted[] = [];
  await stub(page, { posted });
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  const first = panel(page).getByRole('button', { name: 'Delete the workspace' });

  await first.click();
  await nameField(page, 'Acme support').fill('Acme support');
  await panel(page).getByRole('button', { name: 'Keep it' }).click();
  await expect(first).toBeFocused();
  await expect(nameField(page, 'Acme support')).toHaveCount(0);

  await first.click();
  // The name typed before is not kept: a second opening asks for it again.
  await expect(nameField(page, 'Acme support')).toHaveValue('');
  await nameField(page, 'Acme support').fill('Acme support');
  await page.keyboard.press('Escape');
  await expect(first).toBeFocused();
  await expect(panel(page)).toHaveAccessibleName('Acme support');
  expect(posted).toEqual([]);
});

test('Workspaces: each refusal of a deletion is said, the typed name stays, and the row stays (FRU-284)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const options: Options = { posted: [], refusingDeletion: { status: 409, error: 'name-mismatch' } };
  await stub(page, options);
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  await panel(page).getByRole('button', { name: 'Delete the workspace' }).click();
  await nameField(page, 'Acme support').fill('Acme support');

  for (const [refusal, sentence] of [
    [
      { status: 409, error: 'name-mismatch' },
      'This is not the name of the workspace. Type it as it is written, capitals included.',
    ],
    [
      { status: 404, error: 'not-found' },
      'This workspace no longer exists. Another admin or its owner may have deleted it.',
    ],
    [{ status: 500, error: 'down' }, 'Fruitback did not answer. Try again.'],
    [{ status: 403, error: 'forbidden' }, 'The workspace was not deleted. Try again.'],
  ] as const) {
    options.refusingDeletion = refusal;
    await deleteButton(page, 'Acme support').click();
    await expect(panel(page)).toContainText(sentence);
    await expect(nameField(page, 'Acme support')).toHaveValue('Acme support');
  }
  // A key typed in the field takes the refusal away: it was about the name that was sent.
  await nameField(page, 'Acme support').press('End');
  await page.keyboard.type(' ');
  await expect(panel(page)).not.toContainText('The workspace was not deleted.');
  await expect(main(page).getByRole('link', { name: 'Acme support' })).toBeVisible();
  expect(options.posted).toHaveLength(4);
});

test('Workspaces: the button that deletes is busy while the worker answers, and a second press sends nothing (FRU-284)', async ({
  page,
}) => {
  let release = (): void => {};
  const posted: Posted[] = [];
  await stub(page, { posted, holdDeletion: new Promise<void>((resolve) => (release = resolve)) });
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  await panel(page).getByRole('button', { name: 'Delete the workspace' }).click();
  await nameField(page, 'Acme support').fill('Acme support');

  await deleteButton(page, 'Acme support').click();
  await expect(deleteButton(page, 'Acme support')).toBeDisabled();
  await deleteButton(page, 'Acme support').click({ force: true });
  release();
  await expect(main(page).getByRole('status').filter({ hasText: 'was deleted' })).toBeVisible();
  expect(posted).toHaveLength(1);
});

test('Workspaces: the deletion in French, and at 390 px (FRU-284)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stub(page, { locale: 'fr' });
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  await panel(page).getByRole('button', { name: 'Supprimer le workspace' }).click();
  const asking = panel(page).getByRole('group', { name: 'Supprimer Acme support' });
  await expect(asking).toContainText(
    'Acme support est supprimé tout de suite, et rien ne le fait revenir. Ses sites, ses membres, ses invitations, ses connecteurs et les notes que Fruitback garde pour lui disparaissent. Les tickets déjà envoyés à ses sources y restent, et ses membres gardent leur compte. Chaque administrateur de l’instance lit que vous l’avez fait.',
  );
  const field = panel(page).getByRole('textbox', { name: 'Tapez Acme support pour confirmer' });
  await expect(field).toBeFocused();
  await expect(asking.getByRole('button')).toHaveText(['Le garder', 'Supprimer Acme support']);
  expect(await sideScroll(page)).toBe(0);
  // The confirmation is in view on a phone, under the panel of its row.
  await expect(asking.getByRole('button', { name: 'Supprimer Acme support' })).toBeInViewport();
  await axe(page, 'the confirmation of a deletion at 390 px');

  await field.fill('acme support');
  await expect(asking.getByRole('button', { name: 'Supprimer Acme support' })).toBeDisabled();
  await field.fill('Acme support');
  await asking.getByRole('button', { name: 'Supprimer Acme support' }).click();
  await expect(main(page).getByRole('status').filter({ hasText: 'Acme support a été supprimé.' })).toHaveText(
    'Acme support a été supprimé. Chaque administrateur de l’instance le lit sur la page Instance.',
  );
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the workspaces after a deletion at 390 px');
});

/** The group of a write of the open panel, or of the page, by its name (FRU-283). */
const group = (page: Page, name: string) => page.getByRole('group', { name });

test('Workspaces: an admin changes the owner after a confirmation that says the owners see it (FRU-283)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: Posted[] = [];
  const sent = watched(page);
  await stub(page, { posted });
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  await expect(panel(page)).toContainText('Tom Marchal, tom@acme.dev');

  const first = panel(page).getByRole('button', { name: 'Change the owner' });
  await first.click();
  const asking = group(page, 'Change the owner of Acme support');
  const field = asking.getByRole('textbox', { name: 'Address of the new owner' });
  await expect(field).toBeFocused();
  await expect(asking.getByRole('button', { name: 'Make them the owner' })).toBeDisabled();
  await field.fill('ines@acme.dev');
  await expect(asking).toContainText(
    'ines@acme.dev becomes the owner of Acme support at once. The owners of before become admins: they keep the workspace. The owners see that you did it.',
  );
  await axe(page, 'the change of the owner at 1440 px');
  expect(posted).toEqual([]);

  await asking.getByRole('button', { name: 'Make them the owner' }).click();
  await expect(panel(page).getByRole('status')).toHaveText('ines@acme.dev owns Acme support now.');
  await expect(first).toBeFocused();
  expect(posted).toEqual([{ path: '/console/admin/workspaces/w9/owner', body: { email: 'ines@acme.dev' } }]);
  // The panel reads its workspace again: its owner changed.
  await expect.poll(() => sent.filter((request) => request === 'GET /console/admin/workspaces/w9').length).toBe(2);
});

test('Workspaces: « Keep it » and Escape send nothing and keep the panel; a refusal is said and keeps the address (FRU-283)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const options: Options = { posted: [] };
  await stub(page, options);
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  const first = panel(page).getByRole('button', { name: 'Add someone' });

  await first.click();
  await group(page, 'Add someone to Acme support').getByRole('textbox').fill('nobody@acme.dev');
  await page.keyboard.press('Escape');
  await expect(first).toBeFocused();
  await expect(panel(page)).toHaveAccessibleName('Acme support');
  await first.click();
  await expect(group(page, 'Add someone to Acme support').getByRole('textbox')).toHaveValue('');
  await group(page, 'Add someone to Acme support').getByRole('button', { name: 'Keep it' }).click();
  await expect(first).toBeFocused();
  expect(options.posted).toEqual([]);

  for (const [refusal, sentence] of [
    [
      { status: 409, error: 'unknown-account' },
      'No account has this address. Use « Invite someone » for a person with no account.',
    ],
    [{ status: 409, error: 'already-member' }, 'This person is a member of the workspace already.'],
    [{ status: 409, error: 'workspace-suspended' }, 'This workspace is suspended. Restore it first.'],
    [{ status: 500, error: 'down' }, 'Fruitback did not answer. Try again.'],
  ] as const) {
    options.refusingWrite = refusal;
    if ((await group(page, 'Add someone to Acme support').count()) === 0) await first.click();
    const asking = group(page, 'Add someone to Acme support');
    await asking.getByRole('textbox').fill('nobody@acme.dev');
    await asking.getByRole('button', { name: 'Add to Acme support' }).click();
    await expect(panel(page)).toContainText(sentence);
    await expect(asking.getByRole('textbox')).toHaveValue('nobody@acme.dev');
  }
  expect(options.posted).toHaveLength(4);
  expect(options.posted?.[0]).toEqual({
    path: '/console/admin/workspaces/w9/members',
    body: { email: 'nobody@acme.dev', role: 'member' },
  });
});

test('Workspaces: an admin invites an address, and is told to send the link when no message left (FRU-283)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: Posted[] = [];
  await stub(page, { posted, mailed: false });
  await visit(page, '/admin/workspaces?open=w9', 'Workspaces');
  await panel(page).getByRole('button', { name: 'Invite someone' }).click();
  const asking = group(page, 'Invite someone to Acme support');
  await asking.getByRole('textbox', { name: 'Their e-mail address' }).fill('paul@acme.dev');
  await expect(asking).toContainText(
    'paul@acme.dev is invited to Acme support as Member, for 7 days, in your name. The owners of Acme support see that you did it.',
  );
  await asking.getByRole('button', { name: 'Send the invitation' }).click();
  await expect(panel(page).getByRole('status')).toHaveText(
    'paul@acme.dev is invited. No message left: send them http://localhost:5178/invitations',
  );
  expect(posted).toEqual([
    { path: '/console/admin/workspaces/w9/invitations', body: { email: 'paul@acme.dev', role: 'member' } },
  ]);
});

test('Workspaces: « New workspace » makes one for an account, and its panel opens (FRU-283)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: Posted[] = [];
  await stub(page, { posted });
  await visit(page, '/admin/workspaces', 'Workspaces');
  await main(page).getByRole('button', { name: 'New workspace' }).click();
  const asking = group(page, 'New workspace');
  await expect(asking.getByRole('textbox', { name: 'Name of the workspace' })).toBeFocused();
  await asking.getByRole('textbox', { name: 'Name of the workspace' }).fill('  Ines   studio ');
  await expect(asking.getByRole('button', { name: 'Make the workspace' })).toBeDisabled();
  await asking.getByRole('textbox', { name: 'Address of its owner' }).fill('ines@acme.dev');
  await expect(asking).toContainText(
    'The workspace is made at once, and ines@acme.dev owns it. They see that you made it.',
  );
  await asking.getByRole('button', { name: 'Make the workspace' }).click();

  await expect(main(page).getByRole('status').first()).toHaveText('Ines studio was made, owned by ines@acme.dev.');
  await expect(page).toHaveURL(/[?&]open=w20(&|$)/);
  await expect(panel(page)).toHaveAccessibleName('Ines studio');
  expect(posted).toEqual([
    { path: '/console/admin/new-workspace', body: { name: 'Ines studio', owner: 'ines@acme.dev' } },
  ]);
});

test('Users: an admin changes a role and adds a person to a workspace, and the panel says it (FRU-283)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: Posted[] = [];
  await stub(page, { posted });
  await visit(page, '/admin/users?open=a5', 'Users');
  await expect(panel(page).getByRole('listitem').first()).toHaveText('Acme webAdmin');

  await panel(page).getByRole('button', { name: 'Change a role' }).click();
  const role = group(page, 'Change the role of Inès Roux');
  await role.getByRole('button', { name: /New role/ }).click();
  await page.getByRole('option', { name: 'Member' }).click();
  await expect(role).toContainText(
    'Inès Roux becomes Member of Acme web at once. The owners of Acme web see that you did it.',
  );
  await role.getByRole('button', { name: 'Change the role' }).click();
  await expect(panel(page).getByRole('listitem').first()).toHaveText('Acme webMember');

  await panel(page).getByRole('button', { name: 'Add to a workspace' }).click();
  const add = group(page, 'Add Inès Roux to a workspace');
  await expect(add).toContainText('The owners of each workspace listed here see that you read the list.');
  await expect(add.getByRole('button', { name: /Workspace/ })).toContainText('Acme support');
  await add.getByRole('button', { name: 'Add to the workspace' }).click();
  await expect(panel(page).getByRole('listitem').nth(1)).toHaveText('Acme supportMember');
  expect(posted).toEqual([
    { path: '/console/admin/workspaces/w1/members/a5/role', body: { role: 'member' } },
    { path: '/console/admin/workspaces/w9/members', body: { email: 'ines@acme.dev', role: 'member' } },
  ]);
});

test('the writes of FRU-283 in French, and at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stub(page, { locale: 'fr' });
  await page.goto(`${CONSOLE}/admin/workspaces?open=w9`);
  await expect(panel(page)).toContainText('Où vont les notes');
  await panel(page).getByRole('button', { name: 'Changer le propriétaire' }).click();
  const asking = group(page, 'Changer le propriétaire de Acme support');
  await asking.getByRole('textbox', { name: 'Adresse du nouveau propriétaire' }).fill('ines@acme.dev');
  await expect(asking).toContainText(
    'ines@acme.dev devient propriétaire de Acme support tout de suite. Les propriétaires d’avant deviennent administrateurs : ils gardent le workspace. Les propriétaires voient que vous l’avez fait.',
  );
  await expect(asking.getByRole('button')).toHaveText(['Le garder', 'En faire le propriétaire']);
  await expect(asking.getByRole('button', { name: 'En faire le propriétaire' })).toBeInViewport();
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the change of the owner at 390 px');
  await asking.getByRole('button', { name: 'Le garder' }).click();

  await panel(page).getByRole('button', { name: 'Inviter quelqu’un' }).click();
  await expect(group(page, 'Inviter quelqu’un dans Acme support')).toContainText('pour 7 jours, en votre nom');
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'an invitation at 390 px');

  await page.goto(`${CONSOLE}/admin/users?open=a5`);
  await panel(page).getByRole('button', { name: 'Ajouter à un workspace' }).click();
  await expect(group(page, 'Ajouter Inès Roux à un workspace')).toContainText(
    'Les propriétaires de chaque workspace de cette liste voient que vous l’avez lue.',
  );
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'an addition to a workspace at 390 px');
});

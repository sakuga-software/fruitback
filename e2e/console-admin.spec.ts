import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import { painted, rgb, sideScroll, stubWorker, styles } from './console-workspace.ts';

/**
 * The administration of the instance (FRU-262), measured in a browser against screen 17 of the
 * mockup of 2026-10-13 (`17-self-hosted-instance-admin.html`), read-only: the frame and the
 * « Instance » screen. The worker is answered by stubs, with the shapes of `instance-admin.ts`.
 *
 * The sample data is of nobody: `acme.dev`, invented names.
 */
const CONSOLE = 'http://localhost:5178';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const LINE = '#e4e4e7';
const SUBTLE = '#fafafa';
const INK_SOFT = '#52525b';
const DONE = '#15803d';
const ACCENT = '#dd2c27';

type Facts = Record<string, unknown>;

function facts(change: Facts = {}): Facts {
  return {
    startedAt: new Date(Date.now() - 12 * DAY - MINUTE).toISOString(),
    store: 'postgres',
    database: { kind: 'postgresql', schema: 'public' },
    mail: {
      provider: 'scaleway-tem',
      sender: 'feedback@acme.dev',
      variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'],
      lastSentAt: new Date(Date.now() - 3 * MINUTE - 5_000).toISOString(),
    },
    signIn: {
      email: { on: true, variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'] },
      github: { on: true, variables: ['FRUITBACK_AUTH_GITHUB_OAUTH'] },
      google: { on: false, variables: ['FRUITBACK_GOOGLE_OAUTH'] },
    },
    publicUrl: { value: 'https://feedback.acme.dev', variable: 'FRUITBACK_PUBLIC_URL' },
    consoleUrl: { value: 'https://console.acme.dev', variable: 'FRUITBACK_CONSOLE_URL' },
    signUp: { policy: 'invited', variable: 'FRUITBACK_SIGN_UP' },
    counts: { workspaces: 3, accounts: 9, admins: 1 },
    attention: {
      count: 1,
      connectors: [
        {
          id: 'c1',
          kind: 'rest',
          label: 'REST API',
          attention: { reason: 'key-refused', since: '2026-10-18T09:12:00.000Z' },
          workspace: { id: 'w9', name: 'Acme support' },
        },
      ],
    },
    ...change,
  };
}

const WORKSPACES = {
  total: 3,
  workspaces: [
    {
      id: 'w1',
      name: 'Acme web',
      createdAt: '2026-09-03T10:00:00.000Z',
      owners: [{ id: 'a2', email: 'nadia@acme.dev' }],
      members: 6,
      sites: 3,
      notes: {},
      destinations: [],
      pendingDeliveries: 0,
    },
    {
      id: 'w9',
      name: 'Acme support',
      createdAt: '2026-09-18T10:00:00.000Z',
      owners: [{ id: 'a3', email: 'tom@acme.dev' }],
      members: 2,
      sites: 1,
      notes: {},
      destinations: [],
      pendingDeliveries: 2,
    },
    {
      id: 'w5',
      name: 'Lumen',
      createdAt: '2026-10-12T10:00:00.000Z',
      owners: [{ id: 'a4', email: 'paul@lumen.studio' }],
      members: 1,
      sites: 1,
      notes: {},
      destinations: [],
      pendingDeliveries: 0,
    },
  ],
};

type Admin = {
  /** `instanceAdmin` of `/console/me`; `undefined`: a worker of before FRU-261 sends none. */
  admin?: boolean;
  locale?: 'en' | 'fr';
  /** The answer of `GET /console/admin/instance`; a number: that status with no facts. */
  instance?: Facts | number;
  /** Holds the answer of `GET /console/admin/instance` until it resolves. */
  hold?: Promise<void>;
  /** Holds the read of the deleted workspaces (FRU-284) as `hold` holds the one of the instance. */
  holdDeleted?: Promise<void>;
  /** The workspaces that an administrator deleted (FRU-284), none by default; a number: that status. */
  deleted?: readonly unknown[] | number;
};

/** Every request the page sends to the worker, as `METHOD /path`. */
function watched(page: Page): string[] {
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(WORKER_ORIGIN)) sent.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });

  return sent;
}

/** The worker of a person who administers the instance, or not, and the two reads of the screen. */
async function stub(page: Page, options: Admin = {}): Promise<void> {
  const { locale = 'en', instance = facts(), hold } = options;
  // An absent `admin` is a worker of before, not an administrator: no default here.
  const admin = 'admin' in options ? options.admin : true;
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
    ...(admin === undefined ? {} : { instanceAdmin: admin }),
  };
  const answer = (pathname: string, route: Route): Promise<void> | undefined => {
    if (pathname === '/console/me') return route.fulfill({ json: me });
    // The worker answers `404` to anybody else, as for a path that does not exist (FRU-261).
    if (pathname.startsWith('/console/admin') && !admin)
      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    if (pathname === '/console/admin/instance')
      return (hold ?? Promise.resolve()).then(() =>
        typeof instance === 'number'
          ? route.fulfill({ status: instance, json: { error: 'unavailable' } })
          : route.fulfill({ json: instance }),
      );
    if (pathname === '/console/admin/workspaces') return route.fulfill({ json: WORKSPACES });
    if (pathname === '/console/admin/actions') {
      const deleted = options.deleted ?? [];
      // The page asks for the deleted workspaces alone: a read of every action would trace the others.
      if (new URL(route.request().url()).searchParams.get('kind') !== 'workspace-deleted')
        return route.fulfill({ status: 400, json: { error: 'invalid-kind' } });

      return (options.holdDeleted ?? Promise.resolve()).then(() =>
        typeof deleted === 'number'
          ? route.fulfill({ status: deleted, json: { error: 'unavailable' } })
          : route.fulfill({ json: { actions: deleted } }),
      );
    }

    return undefined;
  };
  await stubWorker(page, { locale, answer });
}

const main = (page: Page) => page.locator('main');
const rail = (page: Page) => page.locator('aside.kit-rail');
const health = (page: Page) => page.getByRole('region', { name: 'Health' });
/** Every way to the administration a screen can show: a link to `/admin`, by its address or its name. */
const adminEntries = (page: Page): Locator =>
  page.locator('a[href="/admin"], a[href^="/admin/"]').or(page.getByRole('link', { name: 'Administration' }));

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/admin`);
  await expect(main(page).getByRole('heading', { level: 1, name: 'Instance' })).toBeVisible();
}

/** The value and the line under it of one fact of « Health ». */
function fact(page: Page, term: string): { value: Locator; detail: Locator } {
  const box = health(page)
    .locator('div')
    .filter({ has: page.locator('dt', { hasText: term }) });

  return { value: box.locator('dd').nth(0), detail: box.locator('dd').nth(1) };
}

async function axe(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').include('aside.kit-rail').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('an administrator sees the frame and the instance, with the values of the mockup', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stub(page);
  await open(page);

  // The rail: the host of the instance, what it is, its screens, the way back and the guide.
  await expect(rail(page)).toContainText('localhost:8788');
  await expect(rail(page)).toContainText('Self-hosted instance');
  const nav = page.getByRole('navigation', { name: 'Instance' });
  await expect(nav.getByRole('link')).toHaveText(['Instance', 'Workspaces', 'Users', 'Notes', 'My workspaces']);
  await expect(nav.getByRole('link', { name: 'Instance' })).toHaveAttribute('aria-current', 'page');
  // Straight to the first workspace, not through the front door (FRU-356).
  await expect(nav.getByRole('link', { name: 'My workspaces' })).toHaveAttribute('href', '/w/w1/sites');
  await expect(rail(page).getByRole('link', { name: 'Self-hosting guide' })).toHaveAttribute(
    'href',
    'https://fruitback.com/self-hosting.html',
  );

  // As wide as its column (FRU-398), where the mockup capped it at 1040 px.
  expect.soft(await styles(main(page), ['max-width', 'row-gap', 'flex-direction'])).toEqual({
    'max-width': 'none',
    'row-gap': '44px',
    'flex-direction': 'column',
  });
  await expect(main(page).locator('header p')).toHaveText(
    'Everything this server runs. Each setting comes from the environment of the server.',
  );
  expect.soft((await styles(main(page).locator('header p'), ['max-width']))['max-width']).not.toBe('none');

  // Health.
  const grid = health(page).locator('dl');
  expect.soft((await styles(grid, ['grid-template-columns']))['grid-template-columns']?.split(' ').length).toBe(4);
  const worker = fact(page, 'Worker');
  await expect(worker.value).toHaveText('Answering');
  await expect(worker.detail).toHaveText('Up for 12 days');
  expect.soft(await painted(worker.value, 'color')).toEqual(rgb(DONE));
  expect
    .soft(await styles(worker.value, ['font-size', 'font-weight']))
    .toEqual({ 'font-size': '15px', 'font-weight': '600' });
  expect.soft(await styles(worker.detail, ['font-size'])).toEqual({ 'font-size': '13px' });
  await expect(fact(page, 'Database').value).toHaveText('PostgreSQL');
  await expect(fact(page, 'Database').detail).toHaveText('Not reported');
  await expect(fact(page, 'Mail').value).toHaveText('Scaleway TEM');
  await expect(fact(page, 'Mail').detail).toHaveText('Last link sent 3 min ago');
  const connectors = fact(page, 'Connectors');
  await expect(connectors.value).toHaveText('1 needs a look');
  await expect(connectors.detail).toHaveText('REST API, Acme support');
  expect.soft(await painted(connectors.value, 'color')).toEqual(rgb(ACCENT));

  // Sign-in: each way, and the variable that sets it.
  const signIn = page.getByRole('region', { name: 'Sign-in' });
  await expect(signIn).toContainText('How people get into this instance, in the console and in the extension.');
  const ways = signIn.getByRole('listitem');
  await expect(ways).toHaveCount(3);
  await expect(ways.nth(0)).toContainText('Email link');
  await expect(ways.nth(0)).toContainText('Sent through Scaleway TEM from feedback@acme.dev');
  await expect(ways.nth(0)).toContainText('Set by FRUITBACK_MAIL_FROM and FRUITBACK_SCALEWAY_TEM in the environment.');
  await expect(ways.nth(1)).toContainText('GitHub');
  await expect(ways.nth(1)).toContainText('Set by FRUITBACK_AUTH_GITHUB_OAUTH in the environment.');
  await expect(ways.nth(2)).toContainText('Google');
  await expect(ways.nth(2)).toContainText('Not set up yet');
  await expect(ways.nth(2)).toContainText('Set by FRUITBACK_GOOGLE_OAUTH in the environment.');
  await expect(ways.nth(2)).toContainText('Redirect address to give Google:');
  const code = ways.nth(2).locator('code');
  await expect(code).toHaveText('https://feedback.acme.dev/console/auth/callback/google');
  expect
    .soft(
      await styles(code, [
        'padding-top',
        'padding-left',
        'border-top-width',
        'border-top-style',
        'border-top-left-radius',
        'font-size',
      ]),
    )
    .toEqual({
      'padding-top': '4px',
      'padding-left': '8px',
      'border-top-width': '1px',
      'border-top-style': 'solid',
      'border-top-left-radius': '6px',
      'font-size': '12px',
    });
  expect.soft(await painted(code, 'borderTopColor')).toEqual(rgb(LINE));
  expect.soft(await painted(code, 'backgroundColor')).toEqual(rgb(SUBTLE));
  await expect(ways.nth(2).getByRole('button', { name: 'Copy' })).toBeVisible();

  // Who can make an account: the policy of the worker, read-only, with the variable that sets it.
  const policy = page.getByRole('radiogroup', { name: 'Who can make an account' });
  const radios = policy.getByRole('radio');
  await expect(radios).toHaveCount(2);
  await expect(policy.getByRole('radio', { name: 'Only people invited to a workspace' })).toBeChecked();
  await expect(policy.getByRole('radio', { name: 'Anyone' })).not.toBeChecked();
  for (const radio of await radios.all()) await expect(radio).toBeDisabled();
  await expect(policy).toHaveAccessibleDescription('Set by FRUITBACK_SIGN_UP in the environment.');

  // The public address: a locked field, described by the sentence that says what sets it.
  const address = page.getByRole('textbox', { name: 'Public address' });
  await expect(address).toHaveValue('https://feedback.acme.dev');
  await expect(address).toHaveAttribute('readonly', '');
  const described = (await address.getAttribute('aria-describedby')) ?? '';
  expect(described).not.toBe('');
  await expect(page.locator(`[id="${described.split(' ')[0]}"]`)).toHaveText(
    'Set by FRUITBACK_PUBLIC_URL in the environment.',
  );
  expect.soft(await painted(address, 'borderTopColor')).toEqual(rgb(LINE));
  expect.soft(await painted(address, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await painted(address, 'color')).toEqual(rgb(INK_SOFT));
  expect.soft((await address.boundingBox())?.width ?? 0).toBeLessThanOrEqual(520);

  // The workspaces of the instance, read on a click only: each read leaves a trace with their owners.
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(main(page)).toContainText('The owners of each workspace see that you read its list');
  await main(page).getByRole('button', { name: 'Show the workspaces' }).click();
  const table = page.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Owner', 'Members', 'Sites', 'Created']);
  await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText([
    'Acme web',
    'nadia@acme.dev',
    '6',
    '3',
    // « Sep » in the mockup; the ICU of a browser can write « Sept » for en-GB.
    /^3 Sept?$/,
  ]);
  await expect(table.getByRole('row')).toHaveCount(4);
  expect.soft(await styles(table, ['min-width'])).toEqual({ 'min-width': '620px' });
  const cell = table.getByRole('row').nth(1).getByRole('cell').nth(2);
  expect.soft(await styles(cell, ['padding-top', 'padding-left', 'text-align', 'font-variant-numeric'])).toEqual({
    'padding-top': '14px',
    'padding-left': '16px',
    'text-align': 'right',
    'font-variant-numeric': 'tabular-nums',
  });

  await axe(page, 'the instance at 1440 px');
});

test('no field is editable, nothing changes a setting, and no write request leaves the screen', async ({ page }) => {
  const sent = watched(page);
  await stub(page);
  await open(page);
  // No visit reads the workspaces: their owners would see a read nobody asked for (Mathieu, 2026-10-19).
  await expect(fact(page, 'Worker').value).toHaveText('Answering');
  expect(sent).not.toContain('GET /console/admin/workspaces');
  await main(page).getByRole('button', { name: 'Show the workspaces' }).click();
  await expect(page.getByRole('table')).toBeVisible();

  // Every field is read-only, every radio disabled, and there is no switch nor any button of a form.
  const editable = main(page).locator(
    'input:not([readonly]):not([disabled]):not([type="radio"]), textarea:not([readonly]), select, [contenteditable="true"]',
  );
  await expect(editable).toHaveCount(0);
  for (const radio of await main(page).getByRole('radio').all()) await expect(radio).toBeDisabled();
  await expect(main(page).getByRole('switch')).toHaveCount(0);
  await expect(main(page).locator('form')).toHaveCount(0);
  for (const name of ['Edit keys', 'Turn on Google', 'New workspace', 'Save'])
    await expect(main(page).getByRole('button', { name })).toHaveCount(0);
  // The control of the count above: the one field is there, and it is the locked one.
  await expect(main(page).getByRole('textbox')).toHaveCount(1);

  // A press on every button the screen offers sends nothing either.
  for (const button of await main(page).getByRole('button').all()) await button.click();
  await main(page).getByText('Anyone', { exact: true }).click({ force: true });
  await expect(page.getByRole('radio', { name: 'Anyone' })).not.toBeChecked();

  // The control: the screen was read from the worker, so the watch sees requests.
  expect(sent).toContain('GET /console/admin/instance');
  expect(sent).toContain('GET /console/admin/workspaces');
  expect(sent.filter((request) => !request.startsWith('GET ') && !request.startsWith('OPTIONS '))).toEqual([]);
});

for (const [name, admin] of [
  ['an account that is not the administrator', false],
  ['an account of a worker of before FRU-261', undefined],
] as const) {
  test(`${name} is sent to the front door, and sees no way to the administration`, async ({ page }) => {
    const sent = watched(page);
    await stub(page, { admin });
    await page.goto(`${CONSOLE}/admin`);
    await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
    await expect(main(page).locator('h1')).toBeVisible();

    await expect(adminEntries(page)).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Instance' })).toHaveCount(0);
    expect(sent.filter((request) => request.includes('/console/admin'))).toEqual([]);
  });
}

test('the control: the same locator finds the way to the administration of an administrator', async ({ page }) => {
  await stub(page);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(main(page).locator('h1')).toBeVisible();

  const entry = page.getByRole('navigation', { name: 'Instance' }).getByRole('link', { name: 'Administration' });
  await expect(adminEntries(page)).toHaveCount(1);
  await expect(entry).toHaveAttribute('href', '/admin');
  await entry.click();
  await expect(main(page).getByRole('heading', { level: 1, name: 'Instance' })).toBeVisible();
  await axe(page, 'the rail of a workspace with the way to the administration');
});

test('an instance with no mail and no provider says so', async ({ page }) => {
  const off = (variables: string[]) => ({ on: false, variables });
  await stub(page, {
    instance: facts({
      mail: {
        provider: null,
        sender: null,
        variables: ['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM'],
        lastSentAt: null,
      },
      signIn: {
        email: off(['FRUITBACK_MAIL_FROM', 'FRUITBACK_SCALEWAY_TEM']),
        github: off(['FRUITBACK_AUTH_GITHUB_OAUTH']),
        google: off(['FRUITBACK_GOOGLE_OAUTH']),
      },
      publicUrl: { value: null, variable: 'FRUITBACK_PUBLIC_URL' },
      signUp: { policy: 'anyone', variable: 'FRUITBACK_SIGN_UP' },
      attention: { count: 0, connectors: [] },
    }),
  });
  await open(page);

  await expect(fact(page, 'Mail').value).toHaveText('Not set up');
  await expect(fact(page, 'Mail').detail).toHaveText('No sign-in link goes out by e-mail.');
  await expect(fact(page, 'Connectors').value).toHaveText('All working');
  const ways = page.getByRole('region', { name: 'Sign-in' }).getByRole('listitem');
  for (const way of await ways.all()) await expect(way).toContainText('Not set up yet');
  // With no public address, Google is given the address of the worker the console calls.
  await expect(ways.nth(2).locator('code')).toHaveText(`${WORKER_ORIGIN}/console/auth/callback/google`);
  await expect(page.getByRole('radio', { name: 'Anyone' })).toBeChecked();
  await expect(page.getByRole('textbox', { name: 'Public address' })).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Public address' })).toHaveAttribute('placeholder', 'Not set');
  await axe(page, 'an instance with no mail and no provider');
});

test('a worker that does not answer the read says so, keeps the frame, and reads again on « Try again »', async ({
  page,
}) => {
  let status: number | undefined = 503;
  await stubWorker(page, {
    answer: (pathname, route) => {
      if (pathname === '/console/me')
        return route.fulfill({
          json: { account: { id: 'a1', email: 'ana@acme.dev' }, workspaces: [], instanceAdmin: true },
        });
      if (pathname === '/console/admin/instance')
        return status === undefined
          ? route.fulfill({ json: facts() })
          : route.fulfill({ status, json: { error: 'unavailable' } });
      if (pathname === '/console/admin/workspaces') return route.fulfill({ json: WORKSPACES });
      // No workspace was deleted (FRU-284): the one read that fails here is the one of the instance.
      if (pathname === '/console/admin/actions') return route.fulfill({ json: { actions: [] } });

      return undefined;
    },
  });
  await open(page);

  await expect(main(page).getByRole('alert')).toHaveText('The instance could not be read. Fruitback did not answer.');
  await expect(health(page)).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Instance' })).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Show the workspaces' })).toBeVisible();
  await axe(page, 'a read that failed');

  status = undefined;
  await main(page).getByRole('button', { name: 'Try again' }).click();
  await expect(fact(page, 'Worker').value).toHaveText('Answering');
  await expect(main(page).getByRole('alert')).toHaveCount(0);
});

test('the screen says it is loading while the worker has not answered', async ({ page }) => {
  let release = () => {};
  const hold = new Promise<void>((resolve) => (release = resolve));
  // « Deleted workspaces » (FRU-284) says « Loading… » too while its own read waits. On CI that read
  // was sometimes still on its way, and a locator of the whole screen found two lines. Both reads are
  // held here, so the two lines are always there, and the line of the instance is the one under the
  // header.
  await stub(page, { hold, holdDeleted: hold });
  await open(page);

  const loading = main(page).getByText('Loading…');
  await expect(loading).toHaveCount(2);
  await expect(main(page).locator('header + p')).toHaveText('Loading…');
  await expect(page.getByRole('region', { name: 'Deleted workspaces' }).getByText('Loading…')).toBeVisible();
  await expect(health(page)).toHaveCount(0);
  release();
  await expect(fact(page, 'Worker').value).toHaveText('Answering');
  await expect(loading).toHaveCount(0);
});

test('in French, every sentence of the screen is French', async ({ page }) => {
  await stub(page, { locale: 'fr' });
  await page.goto(`${CONSOLE}/admin`);
  await expect(main(page).getByRole('heading', { level: 1, name: 'Instance' })).toBeVisible();
  await expect(main(page)).toContainText('Les propriétaires de chaque workspace voient que vous avez lu sa liste');
  await main(page).getByRole('button', { name: 'Afficher les workspaces' }).click();
  await expect(page.getByRole('table')).toBeVisible();

  await expect(main(page).locator('header p')).toHaveText(
    'Tout ce que fait tourner ce serveur. Chaque réglage vient de l’environnement du serveur.',
  );
  await expect(page.getByRole('navigation', { name: 'Instance' }).getByRole('link')).toHaveText([
    'Instance',
    'Workspaces',
    'Utilisateurs',
    'Notes',
    'Mes workspaces',
  ]);
  await expect(rail(page)).toContainText('Instance auto-hébergée');
  await expect(page.getByRole('textbox', { name: 'Adresse publique' })).toHaveAccessibleDescription(
    'Réglé par FRUITBACK_PUBLIC_URL dans l’environnement.',
  );
  await expect(main(page)).toContainText(
    'Réglé par FRUITBACK_MAIL_FROM et FRUITBACK_SCALEWAY_TEM dans l’environnement.',
  );
  await expect(main(page)).toContainText('En marche depuis 12 jours');
  await expect(page.getByRole('radio', { name: 'Seulement les personnes invitées dans un workspace' })).toBeChecked();

  const english = [
    'Health',
    'Answering',
    'Up for',
    'Not reported',
    'Last link sent',
    'needs a look',
    'How people get into',
    'Set by',
    'Redirect address',
    'Who can make an account',
    'Only people invited',
    'Public address',
    'Created',
    'My workspaces',
    'Self-hosted instance',
    'Self-hosting guide',
  ];
  const text = (await page.locator('body').innerText()).replaceAll('\n', ' ');
  expect(english.filter((sentence) => text.includes(sentence))).toEqual([]);
});

test('at 390 px the document does not scroll sideways, and axe finds nothing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stub(page);
  await open(page);
  await main(page).getByRole('button', { name: 'Show the workspaces' }).click();
  await expect(page.getByRole('table')).toBeVisible();

  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the instance at 390 px');
});

/** Two workspaces that an administrator deleted, as `GET /console/admin/actions?kind=workspace-deleted` answers them. */
const DELETED = [
  {
    action: 'workspace-deleted',
    at: '2026-10-19T09:30:00.000Z',
    actor: { id: 'a1', email: 'ana@acme.dev', name: 'Ana' },
    workspace: { id: 'w3', name: 'Acme archive' },
    detail: {
      workspace: { id: 'w3', name: 'Acme archive' },
      gone: { sites: 2, members: 1, invitations: 0, connectors: 1, keptNotes: 14 },
    },
  },
  {
    action: 'workspace-deleted',
    at: '2026-10-02T09:30:00.000Z',
    actor: { email: 'former-admin@acme.dev' },
    workspace: { id: 'w4', name: 'Old tests' },
    detail: { workspace: { id: 'w4', name: 'Old tests' }, gone: { sites: 1, members: 3, keptNotes: 1 } },
  },
];

test('« Deleted workspaces » lists what an admin deleted, read at each visit with no trace (FRU-284)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(WORKER_ORIGIN))
      sent.push(`${request.method()} ${request.url().slice(WORKER_ORIGIN.length)}`);
  });
  await stub(page, { deleted: DELETED });
  await open(page);

  const section = page.getByRole('region', { name: 'Deleted workspaces', exact: true });
  await expect(section).toContainText(
    'Deleted by an instance admin. Their owners cannot read this: the workspace is gone.',
  );
  const table = page.getByRole('region', { name: 'Workspaces deleted by an instance admin' }).getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Name', 'Deleted by', 'What went', 'Deleted']);
  await expect(table.getByRole('row').nth(1).getByRole('cell')).toHaveText([
    'Acme archive',
    'ana@acme.dev',
    '2 sites · 1 person · 14 kept notes',
    /^19 Oct/,
  ]);
  await expect(table.getByRole('row').nth(2).getByRole('cell')).toHaveText([
    'Old tests',
    'former-admin@acme.dev',
    '1 site · 3 people · 1 kept note',
    /^2 Oct/,
  ]);
  // Every read of the actions asks for the deletions alone (the dev server mounts twice), and the
  // visit reads no workspace.
  const actions = sent.filter((request) => request.includes('/console/admin/actions'));
  expect(actions.length).toBeGreaterThan(0);
  expect([...new Set(actions)]).toEqual(['GET /console/admin/actions?kind=workspace-deleted']);
  expect(sent.some((request) => request.startsWith('GET /console/admin/workspaces'))).toBe(false);
  await axe(page, 'the deleted workspaces at 1440 px');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the deleted workspaces at 390 px');
});

test('« Deleted workspaces » says when there is none, and when the read failed, in English and in French (FRU-284)', async ({
  page,
}) => {
  await stub(page);
  await open(page);
  const section = page.getByRole('region', { name: 'Deleted workspaces', exact: true });
  await expect(section).toContainText('No workspace was deleted.');
  await expect(section.getByRole('table')).toHaveCount(0);

  await stub(page, { deleted: 503 });
  await page.reload();
  await expect(section).toContainText('The deleted workspaces could not be read. Fruitback did not answer.');
  await stub(page, { deleted: DELETED });
  await section.getByRole('button', { name: 'Try again' }).click();
  await expect(section.getByRole('table')).toBeVisible();

  await stub(page, { locale: 'fr', deleted: DELETED });
  await page.reload();
  const french = page.getByRole('region', { name: 'Workspaces supprimés', exact: true });
  await expect(french).toContainText(
    'Supprimés par un administrateur de l’instance. Leurs propriétaires ne peuvent pas le lire : le workspace n’existe plus.',
  );
  await expect(french.getByRole('columnheader')).toHaveText(['Nom', 'Supprimé par', 'Ce qui a disparu', 'Supprimé le']);
  await expect(french.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveText(
    '2 sites · 1 personne · 14 notes gardées',
  );
});

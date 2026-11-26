import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker, fulfillSites } from './console-workspace.ts';

/**
 * The page of a site (FRU-433), in tabs since FRU-689: the head « Sites › site » with « Open site »
 * and « See its N notes », the row of the tabs, and « Overview » with its figures, the card « Site »,
 * where the notes go and the card « Install ». The worker is answered by stubs; the sample data is of
 * nobody.
 */
const CONSOLE = 'http://localhost:5178';

const LINEAR = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
const SITES = [
  {
    id: 's1',
    origin: 'https://staging.acme.dev',
    visibility: 'members',
    writers: 'anyone',
    destinations: [
      { connector: 'c1', teamId: 't1', label: 'Linear · Web' },
      { connector: 'c1', teamId: 't2', label: 'Linear · Support' },
    ],
    via: ['script', 'extension'],
    notes: { new: 3, todo: 4, progress: 2, done: 1, closed: 2 },
    undelivered: 1,
    lastNoteAt: '2026-11-20T10:00:00.000Z',
  },
  { id: 's2', origin: 'https://acme.dev', visibility: 'everyone' },
  {
    id: 's3',
    origin: 'https://docs.acme.dev',
    visibility: 'members',
    notes: { new: 0, todo: 0, progress: 0, done: 0, closed: 0 },
    undelivered: 0,
  },
];

type Worker = { reads: number; fails: boolean; deleted: string[]; placed: unknown[] };

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { reads: 0, fails: false, deleted: [], placed: [] };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    // The list of places is written whole (FRU-123): the worker answers the list it kept.
    if (pathname === '/console/workspaces/w1/sites/s1/destinations' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { destinations: { connector: string; teamId?: string }[] };
      worker.placed.push(body);
      const labels: Record<string, string> = { t1: 'Linear · Web', t2: 'Linear · Support' };

      return json({
        destinations: body.destinations.map((each) => ({ ...each, label: labels[each.teamId ?? ''] })),
      });
    }
    // The frame reads its one site, and « Advanced » the sites to choose from for its previews (FRU-497).
    if (route.request().method() === 'GET' && /^\/console\/workspaces\/w1\/sites\/\w+$/.test(pathname)) {
      if (!pathname.endsWith('/choices')) worker.reads += 1;
      if (worker.fails) return json({ error: 'unknown' }, 500);

      return fulfillSites(route, SITES) || undefined;
    }
    if (route.request().method() === 'DELETE') {
      worker.deleted.push(pathname);

      return route.fulfill({ status: 204 });
    }
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [LINEAR], available: true });
    if (pathname === '/console/workspaces/w1/connectors/c1/teams')
      return json({
        teams: [
          { id: 't1', name: 'Web', key: 'WEB', projects: [{ id: 'p1', name: 'Site' }] },
          { id: 't2', name: 'Support', key: 'SUP', projects: [] },
        ],
      });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const tabs = (page: Page) => page.getByRole('navigation', { name: 'Sections of the site' });
const about = (page: Page) => page.getByRole('region', { name: 'Site', exact: true });
const install = (page: Page) => page.getByRole('region', { name: 'Install on staging.acme.dev' });
/** The values of the rows of the card « Site », in their order. */
const values = (page: Page) => about(page).locator('[data-site-row-value]');

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('an owner reads the overview of a site: its head, its tabs, its figures, its rows and its install', async ({
  page,
}) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);

  // The head of 48 px: the crumbs « Sites › site », the site as the title, « Open site » and its notes.
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  await expect(crumbs(page)).toHaveText('Sitesstaging.acme.dev');
  await expect(crumbs(page).getByRole('link', { name: 'Sites' })).toHaveAttribute('href', '/w/w1/sites');
  const open = page.getByRole('link', { name: 'Open site (opens in a new tab)' });
  await expect(open).toHaveAttribute('href', 'https://staging.acme.dev');
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('link', { name: 'See its 12 notes' })).toHaveAttribute('href', '/w/w1/notes?site=s1');
  const head = await page.locator('main header').first().boundingBox();
  expect(head?.height).toBe(48);

  // The tabs, each a route: « Overview » is the one on screen.
  await expect(tabs(page).getByRole('link')).toHaveText([
    'Overview',
    'Install',
    'Destinations',
    'Statuses',
    'Access',
    'Advanced',
  ]);
  await expect(tabs(page).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
  for (const [name, path] of [
    ['Install', '/install'],
    ['Destinations', '/destinations'],
    ['Statuses', '/statuses'],
    ['Access', '/access'],
    ['Advanced', '/advanced'],
  ] as const)
    await expect(tabs(page).getByRole('link', { name })).toHaveAttribute('href', `/w/w1/sites/s1${path}`);
  expect((await tabs(page).boundingBox())?.height).toBe(45);

  // The three figures, from the summary of the site: no figure the worker does not give.
  await expect(page.locator('[data-figure]')).toHaveText([
    'Notes12',
    'Open3 new6 to do or in progress',
    'Delivered91 %1 not delivered yet',
  ]);
  await expect(page.locator('[data-figure]').first().getByRole('img')).toHaveAccessibleName(
    '12 notes: 3 new, 4 to do, 2 in progress, 1 done, 2 closed',
  );
  await expect(page.getByRole('link', { name: '1 not delivered yet' })).toHaveAttribute('href', '/w/w1/notes?site=s1');

  // The card « Site »: a row of 44 px for each setting, and « Change » leads to the tab that changes it.
  await expect(about(page).locator('[data-site-row-name]')).toHaveText([
    'Address',
    'Who sees the notes',
    'Who can leave a note',
    'E-mail when a note is done',
    'On the page with',
  ]);
  await expect(values(page)).toHaveText([
    'https://staging.acme.dev (opens in a new tab)',
    'Members only',
    'Anyone on the page',
    'Off',
    'Extension and script',
  ]);
  for (const row of await about(page).locator('[data-site-row]').all())
    expect((await row.boundingBox())?.height).toBe(44);
  for (const [name, href] of [
    ['Change who sees the notes of staging.acme.dev', '/w/w1/sites/s1/access'],
    ['Change who can leave a note on staging.acme.dev', '/w/w1/sites/s1/access'],
    ['Change the e-mail when a note of staging.acme.dev is done', '/w/w1/sites/s1/access'],
    ['Change how Fruitback is on staging.acme.dev', '/w/w1/sites/s1/install'],
  ] as const)
    await expect(about(page).getByRole('link', { name })).toHaveAttribute('href', href);
  await expect(about(page).getByRole('textbox')).toHaveCount(0);

  // Where the notes go: the logo, the name and « Default » of each place, a menu, and « Add ».
  const places = page.getByRole('region', { name: 'Where the notes go' });
  await expect(places.locator('[data-place]')).toHaveText(['Linear · WebDefault', 'Linear · Support']);
  await expect(places.locator('[data-place]').first().locator('svg').first()).toBeVisible();
  await expect(places.getByRole('link', { name: 'Add a destination for staging.acme.dev' })).toHaveAttribute(
    'href',
    '/w/w1/sites/s1/destinations',
  );

  // The install: the script on ink, with this console's address and the site's id, and « Copy ».
  await expect(install(page).getByRole('heading')).toHaveText('Install');
  await expect(install(page).locator('[data-install-state]')).toHaveText('Notes came');
  const script = install(page).getByRole('region', { name: 'Script' });
  await expect(script).toContainText(`src="${CONSOLE}/`);
  await expect(script).toContainText('data-fruitback-client="s1"');
  await expect(script).toHaveAttribute('data-tone', 'ink');
  await expect(install(page).locator('[data-install-seen]')).toHaveText(
    /^Notes came through the script\. The last note of the site came /,
  );
  // The column of the install is 420 px wide beside the rest, from 1100 px.
  expect((await install(page).boundingBox())?.width).toBe(420);
  await expectNoViolation(page, 'the overview of a site');

  // « Extension »: the way of the browser, in the same card.
  // A press on the label of the segment, which holds the hidden radio, as a person does.
  await install(page)
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: 'Extension', exact: true }) })
    .click();
  await expect(install(page).getByRole('radio', { name: 'Extension' })).toBeChecked();
  await expect(install(page).getByRole('button', { name: 'Connect this browser' })).toBeVisible();
  await expect(install(page).locator('[data-install-seen]')).toHaveText(
    /^Notes came through the extension\. The last note of the site came /,
  );
  await expectNoViolation(page, 'the overview of a site, « Extension »');
});

test('each tab is in the address: a press, a reload and the way back keep it, with one read of the site', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  const reads = worker.reads;

  await tabs(page).getByRole('link', { name: 'Install' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/install`);
  await expect(tabs(page).getByRole('link', { name: 'Install' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Copy the script' })).toBeVisible();

  await tabs(page).getByRole('link', { name: 'Destinations' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/destinations`);
  await expect(page.getByRole('region', { name: 'Where the notes of staging.acme.dev go' })).toBeVisible();

  // « Statuses » takes the places of the site from the frame too (review of #965): no second read.
  await tabs(page).getByRole('link', { name: 'Statuses' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/statuses`);
  await expect(page.locator('main')).toContainText('The name and the colour of each status');

  await tabs(page).getByRole('link', { name: 'Advanced' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/advanced`);
  await expect(page.locator('main h2:visible')).toHaveText(['Start an agent', 'Preview deploys', 'Remove this site']);
  // A move between tabs asks the worker nothing of the site: the frame read it once.
  expect(worker.reads).toBe(reads);

  await page.goBack();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/statuses`);
  await page.goBack();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/destinations`);
  await expect(tabs(page).getByRole('link', { name: 'Destinations' })).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(tabs(page).getByRole('link', { name: 'Destinations' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Where the notes of staging.acme.dev go' })).toBeVisible();
});

test('the menu of a place makes it the default or removes it, and the list the worker kept is shown', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const places = page.getByRole('region', { name: 'Where the notes go' });
  await places.getByRole('button', { name: 'Actions of Linear · Support' }).click();
  await page.getByRole('menuitem', { name: 'Make it the default' }).click();
  await expect(places.locator('[data-place]')).toHaveText(['Linear · SupportDefault', 'Linear · Web']);
  expect(worker.placed).toHaveLength(1);

  // The first place has no « Make it the default ».
  await places.getByRole('button', { name: 'Actions of Linear · Support' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Remove']);
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(places.locator('[data-place]')).toHaveText(['Linear · WebDefault']);
  expect(worker.placed).toHaveLength(2);
});

test('the address of the site opens the site in a new tab, and the console stays (FRU-575)', async ({ page }) => {
  await workerWith(page);
  // The site answers here: no request leaves the machine.
  await page
    .context()
    .route('https://staging.acme.dev/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Acme staging</title>' }),
    );
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const address = about(page).getByRole('link', { name: 'https://staging.acme.dev (opens in a new tab)' });
  await expect(address).toBeVisible();
  // It reads as a link: underlined, in ink.
  expect.soft(await address.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe('underline');

  const opened = page.waitForEvent('popup');
  await address.click();
  const site = await opened;
  await expect(site).toHaveTitle('Acme staging');
  expect(site.url()).toBe('https://staging.acme.dev/');
  // No referrer goes with it.
  expect(await site.evaluate(() => document.referrer)).toBe('');
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1`);
});

test('a member reads the overview with nothing to change, and has no tab of an owner (FRU-703)', async ({ page }) => {
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(values(page).nth(1)).toHaveText('Members only');
  await expect(tabs(page).getByRole('link')).toHaveText(['Overview', 'Install', 'Access']);
  // « Change » of how the site is installed only: the tab « Install » is every role's.
  await expect(about(page).getByRole('link', { name: /^Change/ })).toHaveText(['Change']);
  await expect(about(page).getByRole('link', { name: /^Change/ })).toHaveAttribute('href', '/w/w1/sites/s1/install');
  await expect(page.getByRole('region', { name: 'Where the notes go' })).toHaveCount(0);
  await expect(install(page)).toBeVisible();
  await expectNoViolation(page, 'the overview of a site, for a member');

  // A tab of an owner, reached by its address, says why it shows nothing, and asks the worker nothing.
  await page.goto(`${CONSOLE}/w/w1/sites/s1/advanced`);
  await expect(page.locator('main')).toContainText('Only an owner or an admin of the workspace sets these for a site.');
  await page.goto(`${CONSOLE}/w/w1/sites/s1/destinations`);
  await expect(page.locator('main')).toContainText(
    'Only an owner or an admin of the workspace sets where the notes of a site go.',
  );

  // A guest reads where the notes went in no figure: « Delivered » is of the tracker.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await workerWith(page, 'guest');
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(page.locator('[data-figure]')).toHaveCount(2);
  await expect(tabs(page).getByRole('link')).toHaveText(['Overview', 'Install', 'Access']);
});

test('the head leads to the notes of the site, says how many, and says nothing of none (FRU-504)', async ({ page }) => {
  await workerWith(page, 'guest');
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await page.getByRole('link', { name: 'See its 12 notes' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?site=s1`);

  // A site with no note: no link to an empty list.
  await page.goto(`${CONSOLE}/w/w1/sites/s3`);
  await expect(page.locator('main h1')).toHaveText('docs.acme.dev');
  await expect(page.getByRole('link', { name: /^See its/ })).toHaveCount(0);
  // A worker of before sends no count: the link has no number.
  await page.goto(`${CONSOLE}/w/w1/sites/s2`);
  await expect(page.getByRole('link', { name: 'See its notes' })).toHaveAttribute('href', '/w/w1/notes?site=s2');
});

test('a site with no note yet is « Not seen yet », never « Installed », and its figures say so', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s3`);
  const card = page.getByRole('region', { name: 'Install on docs.acme.dev' });
  await expect(card.locator('[data-install-state]')).toHaveText('Not seen yet');
  await expect(card.locator('[data-install-seen]')).toHaveText('No note came through the script yet.');
  await expect(page.locator('main')).not.toContainText('Installed');
  await expect(page.locator('[data-figure]')).toHaveText([
    'Notes0Waiting for the first note',
    'Open0 new0 to do or in progress',
    'DeliveredIn FruitbackNo tracker for this site',
  ]);
});

test('a site the widget was seen on is « Installed », with its oldest open note and its notes of 30 days (FRU-721)', async ({
  page,
}) => {
  const HOUR = 3_600_000;
  const now = Date.now();
  const base = {
    visibility: 'members',
    destinations: [{ connector: 'c1', teamId: 't1', label: 'Linear · Web' }],
    via: ['script'],
    notes: { new: 3, todo: 1, progress: 1, done: 4, closed: 1 },
    undelivered: 0,
    lastNoteAt: new Date(now - 3 * HOUR).toISOString(),
  };
  await stubWorker(page, {
    workspaces: [ACME],
    sites: [
      {
        ...base,
        id: 's4',
        origin: 'https://shop.acme.dev',
        seen: { script: new Date(now - 2 * HOUR - 60_000).toISOString() },
        oldestOpenAt: new Date(now - 5 * 24 * HOUR - HOUR).toISOString(),
        recent: { days: 30, notes: 10, undelivered: 0 },
      },
      {
        ...base,
        id: 's5',
        origin: 'https://blog.acme.dev',
        seen: { extension: new Date(now - 30 * 60_000).toISOString() },
        oldestOpenAt: new Date(now - HOUR).toISOString(),
        recent: { days: 30, notes: 8, undelivered: 2 },
      },
    ],
  });

  await page.goto(`${CONSOLE}/w/w1/sites/s4`);
  const card = page.getByRole('region', { name: 'Install on shop.acme.dev' });
  await expect(card.locator('[data-install-state]')).toHaveText('Installed');
  await expect(card.locator('[data-install-seen]')).toHaveText('Seen on the site 2 h ago.');
  await expect(page.locator('[data-figure]')).toHaveText([
    'Notes10',
    'Open3 newoldest 5 days',
    'Delivered100 %last 30 days',
  ]);

  // Seen by the extension only: « Installed » too, and its line says the extension.
  await page.goto(`${CONSOLE}/w/w1/sites/s5`);
  const other = page.getByRole('region', { name: 'Install on blog.acme.dev' });
  await expect(other.locator('[data-install-state]')).toHaveText('Installed');
  // The script was not seen there since the worker keeps it: its line says the notes that came by it.
  await expect(other.locator('[data-install-seen]')).toHaveText(
    'Notes came through the script. The last note of the site came 3 h ago.',
  );
  await other
    .locator('label')
    .filter({ has: page.getByRole('radio', { name: 'Extension', exact: true }) })
    .click();
  await expect(other.locator('[data-install-seen]')).toHaveText('Seen with the extension 30 min ago.');
  // Two of the 8 notes of 30 days did not arrive: 75 %, and a link to them.
  const figures = page.locator('[data-figure]');
  await expect(figures.nth(1)).toHaveText('Open3 newoldest today');
  await expect(figures.nth(2)).toHaveText('Delivered75 %2 not delivered in 30 days');
  await expect(page.getByRole('link', { name: '2 not delivered in 30 days' })).toHaveAttribute(
    'href',
    '/w/w1/notes?site=s5&undelivered=1',
  );
});

test('a site that everyone reads takes a note from anybody, and says so', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s2`);
  await expect(values(page)).toHaveText([
    'https://acme.dev (opens in a new tab)',
    'Everyone who visits',
    'Anyone on the page',
    // FRU-604: a worker of before sends no `notifyDone`: off.
    'Off',
    'None yet',
  ]);
  // A worker of before sends no count: a dot, and no bar.
  await expect(page.locator('[data-figure]').first()).toHaveText('Notes·');
});

test('a hash of the page of before opens its tab, and #remove asks the second time', async ({ page }) => {
  const worker = await workerWith(page);
  await page.setViewportSize({ width: 1440, height: 600 });
  for (const [hash, path] of [
    ['#install', '/install'],
    ['#destinations', '/destinations'],
    ['#statuses', '/statuses'],
    ['#advanced', '/advanced'],
    ['#agent', '/advanced#agent'],
  ] as const) {
    await page.goto(`${CONSOLE}/w/w1/sites/s1${hash}`);
    await expect(page, hash).toHaveURL(`${CONSOLE}/w/w1/sites/s1${path}`);
  }

  await page.goto(`${CONSOLE}/w/w1/sites/s1#previews`);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/advanced#previews`);
  await expect(page.getByRole('region', { name: 'Preview deploys' })).toBeInViewport();

  await page.goto(`${CONSOLE}/w/w1/sites/s1#remove`);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/advanced#remove`);
  const group = page.getByRole('group', { name: 'Remove staging.acme.dev' });
  await expect(group).toBeInViewport();
  expect(worker.deleted).toEqual([]);
  await group.getByRole('button', { name: 'Remove staging.acme.dev' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  expect(worker.deleted).toEqual(['/console/workspaces/w1/sites/s1']);
});

test('a site that is not in the workspace says so, and a read that failed is asked again', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/nope`);
  await expect(page.getByText('This site is not in the workspace any more.')).toBeVisible();
  await expect(crumbs(page).getByRole('link', { name: 'Sites' })).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);

  worker.fails = true;
  await page.goto(`${CONSOLE}/w/w1/sites/s1/install`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The site did not load');
  await expect(page.getByText('This site is not in the workspace any more.')).toHaveCount(0);
  const before = worker.reads;
  worker.fails = false;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  await expect(tabs(page).getByRole('link', { name: 'Install' })).toHaveAttribute('aria-current', 'page');
  expect(worker.reads).toBe(before + 1);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing of the page of a site scrolls sideways, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await page.goto(`${CONSOLE}/w/w1/sites/s1`);
    await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
    await expect(about(page)).toContainText(locale === 'en' ? 'Who can leave a note' : 'Qui peut laisser une note');
    await page.waitForTimeout(300);
    expect.soft(await sideScroll(page)).toBe(0);
    // The script breaks inside its attributes (FRU-321): nothing of it is past its block.
    expect.soft(await page.locator('pre').evaluate((pre) => pre.scrollWidth <= pre.clientWidth)).toBe(true);
    await expectNoViolation(page, `the overview of a site at 390 px, ${locale}`);

    // The tab « Advanced » fits too; the row of the tabs scrolls in its frame.
    await page.goto(`${CONSOLE}/w/w1/sites/s1/advanced`);
    await expect(page.getByRole('region', { name: locale === 'en' ? 'Preview deploys' : 'Previews' })).toBeVisible();
    await page.waitForTimeout(300);
    expect.soft(await sideScroll(page)).toBe(0);
    await expectNoViolation(page, `the tab « Advanced » at 390 px, ${locale}`);
  });
}

import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The page of a site (FRU-433): what the grid of the Sites screen unfolded under a card, in one
 * place, with crumbs « Sites › site ». The worker is answered by stubs; the sample data is of nobody.
 */
const CONSOLE = 'http://localhost:5178';

const LINEAR = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
const SITES = [
  {
    id: 's1',
    origin: 'https://staging.acme.dev',
    visibility: 'members',
    writers: 'anyone',
    destinations: [{ connector: 'c1', teamId: 't1', label: 'Linear · Web' }],
    via: ['script', 'extension'],
  },
  { id: 's2', origin: 'https://acme.dev', visibility: 'everyone' },
];

type Worker = { reads: number; fails: boolean; deleted: string[] };

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { reads: 0, fails: false, deleted: [] };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/console/workspaces/w1/sites') {
      worker.reads += 1;

      return worker.fails ? json({ error: 'unknown' }, 500) : json({ sites: SITES });
    }
    if (route.request().method() === 'DELETE') {
      worker.deleted.push(pathname);

      return route.fulfill({ status: 204 });
    }
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [LINEAR], available: true });
    if (pathname === '/console/workspaces/w1/connectors/c1/teams')
      return json({ teams: [{ id: 't1', name: 'Web', key: 'WEB', projects: [{ id: 'p1', name: 'Site' }] }] });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('an owner reads everything of a site on its page, under the crumbs « Sites › site »', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);

  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  await expect(crumbs(page)).toHaveText('Sites›staging.acme.dev');
  await expect(crumbs(page).getByRole('link', { name: 'Sites' })).toHaveAttribute('href', '/w/w1/sites');

  // Its sections, in this order: nothing is unfolded under a card any more.
  await expect(page.locator('main h2')).toHaveText([
    'Site',
    'Install',
    'Script',
    'Extension',
    'Where the notes of staging.acme.dev go',
    'Statuses',
    'Start an agent',
    'Preview deploys',
    'Remove this site',
  ]);

  // Its address, who sees its notes and who writes them, which the worker sets when it is added.
  const about = page.getByRole('region', { name: 'Site', exact: true });
  await expect(about.locator('dd')).toHaveText([
    'https://staging.acme.dev',
    'Members of Acme',
    'Anyone on the page',
    'Extension, script',
  ]);
  await expect(about.getByRole('textbox')).toHaveCount(0);
  await expect(about.getByRole('radio')).toHaveCount(0);

  await expect(page.getByRole('region', { name: 'Install on staging.acme.dev' })).toBeVisible();
  const places = page.getByRole('region', { name: 'Where the notes of staging.acme.dev go' });
  await expect(places.getByText('Linear · Web', { exact: true })).toBeVisible();
  await expect(places.getByRole('button', { name: /Add a destination for staging\.acme\.dev/ })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Preview deploys' })).toBeVisible();
  await expectNoViolation(page, 'the page of a site');

  // « Edit the statuses » leads to the page of the statuses (FRU-371).
  await page.getByRole('link', { name: 'Edit the statuses' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1/statuses`);
});

test('a site that everyone reads takes a note from anybody, and says so', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/s2`);
  await expect(page.getByRole('region', { name: 'Site', exact: true }).locator('dd')).toHaveText([
    'https://acme.dev',
    'Everyone who visits',
    'Anyone on the page',
    'None yet',
  ]);
});

test('a hash of the address goes to its section, and #remove asks the second time', async ({ page }) => {
  const worker = await workerWith(page);
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1#previews`);
  await expect(page.getByRole('region', { name: 'Preview deploys' })).toBeInViewport();

  await page.goto(`${CONSOLE}/w/w1/sites/s1#remove`);
  const group = page.getByRole('group', { name: 'Remove staging.acme.dev' });
  await expect(group).toBeInViewport();
  expect(worker.deleted).toEqual([]);
  await group.getByRole('button', { name: 'Remove staging.acme.dev' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  expect(worker.deleted).toEqual(['/console/workspaces/w1/sites/s1']);
});

test('a member installs, and reads where the notes go nowhere on the page', async ({ page }) => {
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  await expect(page.locator('main h2').first()).toHaveText('Site');
  await expect(page.getByRole('region', { name: 'Install on staging.acme.dev' })).toBeVisible();
  for (const name of [
    'Where the notes of staging.acme.dev go',
    'Statuses',
    'Start an agent',
    'Preview deploys',
    'Remove this site',
  ])
    await expect(page.getByRole('region', { name })).toHaveCount(0);
  await expectNoViolation(page, 'the page of a site, for a member');

  // A guest neither.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await workerWith(page, 'guest');
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(page.getByRole('region', { name: 'Install on staging.acme.dev' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Where the notes of staging.acme.dev go' })).toHaveCount(0);
});

test('a site that is not in the workspace says so, and a read that failed is asked again', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites/nope`);
  await expect(page.getByText('This site is not in the workspace any more.')).toBeVisible();
  await expect(crumbs(page).getByRole('link', { name: 'Sites' })).toBeVisible();

  worker.fails = true;
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The site did not load');
  await expect(page.getByText('This site is not in the workspace any more.')).toHaveCount(0);
  const before = worker.reads;
  worker.fails = false;
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  expect(worker.reads).toBe(before + 1);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing of the page of a site scrolls sideways, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await page.goto(`${CONSOLE}/w/w1/sites/s1`);
    await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
    await expect(
      page.getByRole('region', { name: locale === 'en' ? 'Remove this site' : 'Retirer ce site' }),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Site', exact: true })).toContainText(
      locale === 'en' ? 'Who can leave a note' : 'Qui peut laisser une note',
    );
    await page.waitForTimeout(300);
    expect.soft(await sideScroll(page)).toBe(0);
    // The script breaks inside its attributes (FRU-321): nothing of it is past its block.
    expect.soft(await page.locator('pre').evaluate((pre) => pre.scrollWidth <= pre.clientWidth)).toBe(true);
    await expectNoViolation(page, `the page of a site at 390 px, ${locale}`);
  });
}

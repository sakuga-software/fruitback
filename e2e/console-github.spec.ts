import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * GitHub on the Connectors screen (FRU-361): « Connect » goes to the App by the start of the worker,
 * each word of the way back says what happened, and the panel of an installation chooses a
 * repository for each site.
 *
 * The worker is answered by stubs. They keep the places of each site, and every list the console
 * sent, so a spec reads the body that the worker would get.
 */
const CONSOLE = 'http://localhost:5178';
const INSTALLATION = 'https://github.com/apps/fruitback-app/installations/new?state=s';

type Place = { connector: string; teamId?: string; projectId?: string; repository?: string };

const LINEAR = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
const GITHUB = { id: 'g1', kind: 'github', label: 'GitHub App · acme', createdAt: '2026-10-20T10:00:00.000Z' };
const REPOSITORIES = [
  { fullName: 'acme/web', private: true },
  { fullName: 'acme/Docs', private: false },
  { fullName: 'acme/api', private: true },
];

/** What the worker writes beside a place, as it does for each kind. */
function labelled(place: Place): Place & { label: string } {
  if (place.connector === GITHUB.id) return { ...place, label: `GitHub · ${place.teamId}` };

  return { ...place, label: 'Linear · Web' };
}

type Worker = {
  connectors: unknown[];
  githubApp: boolean;
  /** What the start answers: the address at GitHub, or a refusal. */
  start: { status: number; body: unknown };
  /** The places of the one site, as the worker keeps them: a repository is in `teamId`. */
  places: Place[];
  /** Every list of places the console sent, as it sent it. */
  sent: Place[][];
  started: number;
  /** How many reads of the repositories fail before one answers. */
  silentReads: number;
};

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = {
    connectors: [LINEAR, GITHUB],
    githubApp: true,
    start: { status: 201, body: { url: INSTALLATION } },
    places: [],
    sent: [],
    started: 0,
    silentReads: 0,
  };
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (pathname.endsWith('/connectors/github/start') && request.method() === 'POST') {
      worker.started += 1;

      return json(worker.start.body, worker.start.status);
    }
    if (pathname.endsWith('/sites/s1/destinations') && request.method() === 'POST') {
      const { destinations } = request.postDataJSON() as { destinations: Place[] };
      worker.sent.push(destinations);
      worker.places = destinations.map(({ repository, ...rest }) =>
        repository === undefined ? rest : { ...rest, teamId: repository.toLowerCase() },
      );

      return json({ destinations: worker.places.map(labelled) });
    }
    if (pathname.endsWith('/connectors')) {
      return json({ connectors: worker.connectors, available: true, linearOAuth: true, githubApp: worker.githubApp });
    }
    if (pathname.endsWith('/sites')) {
      return json({
        sites: [
          {
            id: 's1',
            origin: 'https://staging.acme.dev',
            visibility: 'members',
            destinations: worker.places.map(labelled),
          },
        ],
      });
    }
    if (pathname.endsWith('/g1/repositories')) {
      if (worker.silentReads === 0) return json({ repositories: REPOSITORIES });
      worker.silentReads -= 1;

      return json({ error: 'connector-failed' }, 502);
    }
    if (pathname.endsWith('/c1/teams')) return json({ teams: [{ id: 't1', name: 'Web', key: 'WEB', projects: [] }] });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });
  // The page of GitHub, so that the navigation to it ends here.
  await page.route('https://github.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>GitHub</title><h1>Install Fruitback App</h1>' }),
  );

  return worker;
}

const card = (page: Page) => page.locator('[data-source="GitHub Issues"]');
const rows = (page: Page) => page.locator('button[aria-pressed]');
const panel = (page: Page) => page.getByRole('region', { name: /^GitHub Issues · / });

/**
 * A picture for the record of the ticket. It changes nothing of the test.
 *
 * WARNING: a full page picture resizes the viewport, and the resize closes an open list. Give
 * `fullPage: false` while a list is open.
 */
async function picture(page: Page, name: string, { fullPage = true } = {}): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage });
  await test.info().attach(name, { path, contentType: 'image/png' });
}

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

/** Opens the panel of the GitHub installation, and waits for it by its name. */
async function openGithub(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await rows(page).nth(1).click();
  await expect(panel(page)).toBeVisible();
}

test('« Connect » of GitHub asks the worker where to go, then goes there', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const connect = card(page).getByRole('button', { name: 'Connect GitHub Issues', exact: true });
  await expect(card(page).getByText('An issue per note, in one repository.', { exact: false })).toBeVisible();
  await picture(page, 'github-card');
  await expectNoViolation(page, 'the card of GitHub');

  await connect.click();
  await page.waitForURL(INSTALLATION);
  expect(worker.started).toBe(1);
});

test('a start that the worker refuses says why under the card, and stays', async ({ page }) => {
  const worker = await workerWith(page);
  worker.start = { status: 404, body: { error: 'connectors-unavailable' } };
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await card(page).getByRole('button', { name: 'Connect GitHub Issues', exact: true }).click();
  await expect(card(page).getByRole('alert')).toHaveText(
    'This Fruitback has no GitHub App. Its operator must set one up.',
  );
  expect(page.url()).toBe(`${CONSOLE}/w/w1/connectors`);
});

test('without the App, the card of GitHub says so and connects nothing', async ({ page }) => {
  const worker = await workerWith(page);
  worker.githubApp = false;
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(card(page).getByRole('button')).toHaveText('Not on this Fruitback');
  await expect(card(page).getByRole('button')).toBeDisabled();
  await expect(card(page).getByText('The operator of this Fruitback has not set up the GitHub App.')).toBeVisible();
  // The control: Linear still connects.
  await expect(page.getByRole('button', { name: 'Connect Linear', exact: true })).toBeEnabled();
});

test('a member reads the card of GitHub and cannot press it', async ({ page }) => {
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(card(page).getByRole('button', { name: 'Connect GitHub Issues', exact: true })).toBeDisabled();
});

const RETURNS = {
  requested:
    'GitHub was not connected yet: an owner of the organisation must approve the App. After the approval, connect GitHub again.',
  elsewhere:
    'Another workspace already receives the notes of this installation. Disconnect it there, or install the App on another account.',
  refused:
    'GitHub was not connected: your GitHub account does not reach this installation. Ask an owner of the organisation to connect it.',
  forbidden: 'Only an owner or an admin of the workspace connects a source.',
  suspended: 'This workspace is suspended, so nothing in it can change. Contact the administrator of this instance.',
  'unauthorized-app':
    'GitHub was not connected: the GitHub App of this Fruitback is not set up correctly. Contact the operator of this Fruitback.',
  failed: 'GitHub was not connected. Start again from « Connect ».',
  unstarted:
    'GitHub sent you back without a start from this workspace, so nothing was connected. If you installed the App on github.com, press « Connect » here and choose the same account.',
} as const;

test('each word of the way back from GitHub says what happened, then leaves the address', async ({ page }) => {
  await workerWith(page);
  for (const [word, sentence] of Object.entries(RETURNS)) {
    await page.goto(`${CONSOLE}/w/w1/connectors?github=${word}`);
    await expect(card(page).getByRole('alert'), word).toHaveText(sentence);
    await expect.poll(() => new URL(page.url()).search, word).toBe('');
    await picture(page, `return-${word}`);
  }
});

test('back with « connected », the panel of the GitHub installation opens, even when it is not the last row', async ({
  page,
}) => {
  const worker = await workerWith(page);
  // An installation again keeps its connector: a source added after it is the last row.
  worker.connectors = [LINEAR, GITHUB, { ...LINEAR, id: 'c2', label: 'Linear · Bo' }];
  await page.goto(`${CONSOLE}/w/w1/connectors?github=connected`);
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('heading', { name: 'GitHub Issues', exact: true })).toBeVisible();
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('back on the front door with « unstarted », the console says to start from the workspace', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/?github=unstarted`);
  await expect(card(page).getByRole('alert')).toHaveText(RETURNS.unstarted);
  expect(new URL(page.url()).pathname).toBe('/w/w1/connectors');
});

test('back on the front door with « unstarted », a person who manages no workspace reads that nothing was connected', async ({
  page,
}) => {
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/?github=unstarted`);
  await expect(page.getByRole('alert')).toHaveText(
    'GitHub sent you back, but nothing was connected. Only an owner or an admin of a workspace connects GitHub, from the Connectors of that workspace.',
  );
  await picture(page, 'unstarted-member');
  expect(new URL(page.url()).pathname).toBe('/');

  // « Continue » takes the front door as usual: a member goes to the sites.
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
});

test('the row of an installation names its account, and one that needs repair links to the App', async ({ page }) => {
  const worker = await workerWith(page);
  const row = rows(page).nth(1);
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(row).toContainText('GitHub Issues');
  await expect(row).toContainText('Installed on acme');
  await expect(row).toContainText('Connected');

  worker.connectors = [
    LINEAR,
    { ...GITHUB, attention: { reason: 'connection-ended', since: '2026-10-21T08:00:00.000Z' } },
  ];
  await page.reload();
  await expect(row.getByText('Needs attention', { exact: true })).toBeVisible();
  await row.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByRole('alert').first()).toContainText(
    'The GitHub App is no longer installed on acme, and since',
  );
  await expect(panel(page).getByRole('link', { name: 'Open the App on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/apps/fruitback-app',
  );
});

test('a site chooses a repository, sent as a repository, and a public one says its issues are public', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await openGithub(page);
  const add = panel(page).getByRole('button', { name: /Add a repository for staging\.acme\.dev/ });
  await expect(add).toBeEnabled();
  await add.click();
  // The private ones, then the public ones, each in the order of their names.
  await expect(page.getByRole('option')).toHaveText(['Add a repository…', 'acme/api', 'acme/web', 'acme/Docs']);
  await expect(page.getByText('Public repositories: their issues are public', { exact: true })).toBeVisible();
  await picture(page, 'repository-picker', { fullPage: false });
  await page.getByRole('option', { name: 'acme/Docs', exact: true }).click();

  await expect.poll(() => worker.sent).toEqual([[{ connector: 'g1', repository: 'acme/docs' }]]);
  // The choice comes back from `teamId`, in lower case.
  await expect(panel(page).getByText('GitHub · acme/docs', { exact: true })).toBeVisible();
  const warning = panel(page).locator('[data-public]');
  await expect(warning).toHaveText(
    'acme/docs is public: each note of this site becomes an issue that anybody can read.',
  );
  await picture(page, 'repository-public-warning');

  // A private repository says nothing of the kind.
  await panel(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(2);
  await panel(page)
    .getByRole('button', { name: /Add a repository for staging\.acme\.dev/ })
    .click();
  await page.getByRole('option', { name: 'acme/web', exact: true }).click();
  await expect(panel(page).getByText('GitHub · acme/web', { exact: true })).toBeVisible();
  await expect(panel(page).locator('[data-public]')).toHaveCount(0);
  await expectNoViolation(page, 'the panel of an installation');
});

test('a read of the repositories that failed says so, and « Try again » reads them again', async ({ page }) => {
  const worker = await workerWith(page);
  worker.silentReads = 1;
  await openGithub(page);
  await expect(panel(page).getByRole('alert')).toHaveText(
    'GitHub did not answer with the repositories of this installation.',
  );
  const add = panel(page).getByRole('button', { name: /Add a repository for staging\.acme\.dev/ });
  await panel(page).getByRole('button', { name: 'Try again', exact: true }).click();

  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await add.click();
  await expect(page.getByRole('option')).toHaveText(['Add a repository…', 'acme/api', 'acme/web', 'acme/Docs']);
});

test('the panel of Linear sends the GitHub place of a site as a repository', async ({ page }) => {
  const worker = await workerWith(page);
  worker.places = [
    { connector: 'g1', teamId: 'acme/web' },
    { connector: 'c1', teamId: 't1' },
  ];
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await rows(page).first().click();
  await expect(page.getByRole('region', { name: /^Linear · / })).toBeVisible();
  await page
    .getByRole('region', { name: /^Linear · / })
    .getByRole('button', { name: 'Remove', exact: true })
    .click();

  await expect.poll(() => worker.sent).toEqual([[{ connector: 'g1', repository: 'acme/web' }]]);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px the card and the panel of GitHub fit, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const worker = await workerWith(page, 'owner', locale);
    worker.places = [{ connector: 'g1', teamId: 'acme/docs' }];
    await page.goto(`${CONSOLE}/w/w1/connectors?github=requested`);
    await expect(card(page).getByRole('alert')).toBeVisible();
    expect.soft(await sideScroll(page), 'the card').toBe(0);
    await card(page).scrollIntoViewIfNeeded();
    await picture(page, `card-390-${locale}`);
    await rows(page).nth(1).click();
    await expect(panel(page).locator('[data-public]')).toBeVisible();
    await page.waitForTimeout(300);
    expect.soft(await sideScroll(page), 'the panel').toBe(0);
    await picture(page, `panel-390-${locale}`);
    await expectNoViolation(page, `the panel at 390 px, ${locale}`);
  });
}

import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker, fulfillSites } from './console-workspace.ts';

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

/**
 * What the worker writes beside a place, as it does for each kind: for a repository, whether GitHub
 * says it is private (FRU-382), unless `privacy` says the worker does not know it.
 */
function labelled(place: Place, privacy: 'known' | 'unknown' = 'known'): Place & { label: string } {
  if (place.connector === GITHUB.id) {
    const listed = REPOSITORIES.find((each) => each.fullName.toLowerCase() === place.teamId);

    return {
      ...place,
      label: `GitHub · ${place.teamId}`,
      ...(privacy === 'known' && listed !== undefined ? { private: listed.private } : {}),
    };
  }

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
  /** FRU-382: the read of the repositories never answers, as one that is still on its way. */
  repositoriesWait: boolean;
  /** How many reads of the repositories the console asked for. */
  listed: number;
  /** Whether the worker says if each repository is private: a worker of before does not. */
  privacy: 'known' | 'unknown';
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
    repositoriesWait: false,
    listed: 0,
    privacy: 'known',
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

      return json({ destinations: worker.places.map((each) => labelled(each, worker.privacy)) });
    }
    if (pathname.endsWith('/connectors')) {
      return json({ connectors: worker.connectors, available: true, linearOAuth: true, githubApp: worker.githubApp });
    }
    const read = fulfillSites(route, [
      {
        id: 's1',
        origin: 'https://staging.acme.dev',
        visibility: 'members',
        destinations: worker.places.map((each) => labelled(each, worker.privacy)),
      },
    ]);
    if (read !== false) return read;
    if (pathname.endsWith('/g1/repositories')) {
      worker.listed += 1;
      if (worker.repositoriesWait) return new Promise<void>(() => {});
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
const rows = (page: Page) => page.locator('button[id^="source-row-"]');
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

/** The warning of a public repository, and its words for acme/docs. */
const PUBLIC_DOCS = 'acme/docs is public: each note of this site becomes an issue that anybody can read.';

test('in the panel, once the list names the repository, it wins over an older word of the worker (FRU-382)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  // The worker last read acme/web public; GitHub's list says it is private. And acme/docs the other way.
  worker.places = [{ connector: 'g1', teamId: 'acme/web' }];
  worker.repositoriesWait = true;
  const stale = { connector: 'g1', teamId: 'acme/web', label: 'GitHub · acme/web', private: false };
  await page.route(/\/console\/workspaces\/w1\/sites(\?|$)/, (route) =>
    route.fulfill({
      json: { sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members', destinations: [stale] }] },
    }),
  );
  await openGithub(page);
  // While the list is read, the worker's word.
  await expect(panel(page).locator('[data-public]')).toHaveCount(1);

  worker.repositoriesWait = false;
  await page.reload();
  await rows(page).nth(1).click();
  await expect(panel(page)).toBeVisible();
  await expect.poll(() => worker.listed).toBeGreaterThan(1);
  await expect(panel(page).locator('[data-public]')).toHaveCount(0);
});

test('in the panel, a list of the repositories that failed keeps the warning, says so, and reads again', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.places = [{ connector: 'g1', teamId: 'acme/docs' }];
  // Every read fails until « Try again »: a development build runs the effect twice, a build once
  // (FRU-473), so no count of reads holds for both.
  worker.silentReads = Number.POSITIVE_INFINITY;
  await openGithub(page);
  await expect(
    panel(page).getByText('GitHub did not answer with the repositories of this installation.'),
  ).toBeVisible();
  await expect(panel(page).locator('[data-public]')).toHaveText(PUBLIC_DOCS);
  // The panel reads only when it opens and on « Try again » (`reads` in `connector-github.tsx`). The
  // read that answers must be the one of the press: a read of the opening that came late would hide
  // a « Try again » that reads nothing (raised in review).
  const before = worker.listed;
  worker.silentReads = 0;
  await panel(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect.poll(() => worker.listed).toBe(before + 1);
  await expect(panel(page).getByText('GitHub did not answer with the repositories of this installation.')).toHaveCount(
    0,
  );
  // acme/docs is public in the list too: the warning stays.
  await expect(panel(page).locator('[data-public]')).toHaveText(PUBLIC_DOCS);
});

test('a member reads the warning too, and asks for no list (FRU-382)', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.places = [
    { connector: 'g1', teamId: 'acme/docs' },
    { connector: 'g1', teamId: 'acme/web' },
  ];
  await openGithub(page);

  // The public one only: acme/web is private.
  await expect(panel(page).locator('[data-public]')).toHaveText([PUBLIC_DOCS]);
  await expect(panel(page).getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  expect(worker.listed).toBe(0);
  await expectNoViolation(page, 'the panel of a member');
});

test('the control: with no word of the worker and no list, nothing says the repository is public (FRU-382)', async ({
  page,
}) => {
  // A worker of before says nothing of the repository, and a member reads no list: the warning
  // above comes from the destination, not from the list.
  const worker = await workerWith(page, 'member');
  worker.privacy = 'unknown';
  worker.places = [{ connector: 'g1', teamId: 'acme/docs' }];
  await openGithub(page);

  await expect(panel(page).getByText('GitHub · acme/docs', { exact: true })).toBeVisible();
  await expect(panel(page).locator('[data-public]')).toHaveCount(0);
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

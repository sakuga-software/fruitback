import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * Where the notes of a site go, set from the Sites screen (FRU-399), and no longer from the panel of
 * a source: the places of the site in their order, the teams of each Linear, the repositories of each
 * GitHub (FRU-361) with the warning of a public one (FRU-382), and an address (FRU-132). A list is
 * written whole, one write at a time (FRU-123).
 *
 * The worker is answered by stubs. They keep the places of the one site, and every list the console
 * sent, so a spec reads the body that the worker would get.
 */
const CONSOLE = 'http://localhost:5178';
const SITE = 'staging.acme.dev';

type Place = { connector: string; teamId?: string; projectId?: string; repository?: string };

const LINEAR = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
const GITHUB = { id: 'g1', kind: 'github', label: 'GitHub App · acme', createdAt: '2026-10-20T10:00:00.000Z' };
const REST = {
  id: 'r1',
  kind: 'rest',
  label: 'REST · https://hooks.acme.dev/fruitback',
  createdAt: '2026-10-02T10:00:00.000Z',
};
const TEAMS = [{ id: 't1', name: 'Web', key: 'WEB', projects: [{ id: 'p1', name: 'Site' }] }];
const REPOSITORIES = [
  { fullName: 'acme/web', private: true },
  { fullName: 'acme/Docs', private: false },
  { fullName: 'acme/api', private: true },
];
/** The warning of a public repository, and its words for acme/docs. */
const PUBLIC_DOCS = 'acme/docs is public: each note of this site becomes an issue that anybody can read.';

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
  if (place.connector === REST.id) return { ...place, label: 'REST API · hooks.acme.dev' };

  return {
    ...place,
    label: ['Linear', 'Web', place.projectId === undefined ? undefined : 'Site'].filter(Boolean).join(' · '),
  };
}

type Worker = {
  connectors: unknown[];
  /** The read of the sources fails. */
  connectorsFail: boolean;
  /** The places of the one site, as the worker keeps them: a repository is in `teamId`. */
  places: Place[];
  /** Every list of places the console sent, as it sent it. */
  sent: Place[][];
  /** How many reads of the repositories fail before one answers. */
  silentReads: number;
  /** FRU-382: the read of the repositories never answers, as one that is still on its way. */
  repositoriesWait: boolean;
  /** How many reads of the repositories the console asked for. */
  listed: number;
  /** Whether the worker says if each repository is private: a worker of before does not. */
  privacy: 'known' | 'unknown';
  /** Holds the next write open until `release` is called. */
  holdNext: () => void;
  release: () => void;
};

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  let hold = false;
  let released = () => {};
  const worker: Worker = {
    connectors: [LINEAR, GITHUB, REST],
    connectorsFail: false,
    places: [],
    sent: [],
    silentReads: 0,
    repositoriesWait: false,
    listed: 0,
    privacy: 'known',
    holdNext: () => void (hold = true),
    release: () => released(),
  };
  /** The write of the places: held open while `hold` is set, then kept. */
  const write = async (route: Route) => {
    const { destinations } = route.request().postDataJSON() as { destinations: Place[] };
    worker.sent.push(destinations);
    if (hold) {
      hold = false;
      await new Promise<void>((done) => (released = done));
    }
    worker.places = destinations.map(({ repository, ...rest }) =>
      repository === undefined ? rest : { ...rest, teamId: repository.toLowerCase() },
    );

    return route.fulfill({ json: { destinations: worker.places.map((each) => labelled(each, worker.privacy)) } });
  };
  // Not `async`: what this does not answer must be `undefined`, so the stub of the workspace answers it.
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (pathname.endsWith('/sites/s1/destinations') && request.method() === 'POST') return write(route);
    if (pathname.endsWith('/connectors')) {
      if (worker.connectorsFail) return json({ error: 'unknown' }, 500);

      return json({ connectors: worker.connectors, available: true, linearOAuth: true, githubApp: true });
    }
    if (pathname.endsWith('/sites')) {
      return json({
        sites: [
          {
            id: 's1',
            origin: `https://${SITE}`,
            visibility: 'members',
            destinations: worker.places.map((each) => labelled(each, worker.privacy)),
          },
        ],
      });
    }
    if (pathname.endsWith('/g1/repositories')) {
      worker.listed += 1;
      if (worker.repositoriesWait) return new Promise<void>(() => {});
      if (worker.silentReads === 0) return json({ repositories: REPOSITORIES });
      worker.silentReads -= 1;

      return json({ error: 'connector-failed' }, 502);
    }
    if (pathname.endsWith('/c1/teams')) return json({ teams: TEAMS });
    if (pathname.endsWith('/r1/deliveries')) return json({ deliveries: [] });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

const card = (page: Page) => page.locator('li[data-site]').first();
const panel = (page: Page) => page.getByRole('region', { name: `Where the notes of ${SITE} go` });
const add = (page: Page) => panel(page).getByRole('button', { name: new RegExp(`Add a destination for ${SITE}`) });

/** Opens the Sites screen, then « Destinations » in the menu of the card. */
async function openPlaces(page: Page, words = { more: 'More for', item: 'Destinations' }): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await page.getByRole('button', { name: `${words.more} ${SITE}`, exact: true }).click();
  await page.getByRole('menuitem', { name: words.item, exact: true }).click();
  await expect(panel(page)).toBeVisible();
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

test('an owner chooses where the notes of a site go, on the Sites screen (FRU-399)', async ({ page }) => {
  const worker = await workerWith(page);
  await openPlaces(page);
  await expect(panel(page)).toContainText('Its notes stay in Fruitback, in this workspace.');

  // Every source of the workspace, each with what it offers: the teams of Linear, the repositories of
  // GitHub (the private ones, then the public ones), and the address.
  await expect(add(page)).toBeEnabled();
  await add(page).click();
  await expect(page.getByRole('option')).toHaveText([
    'Add a destination…',
    'Web, no project',
    'Web · Site',
    'acme/api',
    'acme/web',
    'acme/Docs',
    'hooks.acme.dev/fruitback',
  ]);
  await expect(page.getByText('GitHub, public repositories of acme: their issues are public')).toBeVisible();
  await page.getByRole('option', { name: 'Web, no project', exact: true }).click();

  await expect.poll(() => worker.sent).toEqual([[{ connector: 'c1', teamId: 't1' }]]);
  await expect(panel(page).getByText('Linear · Web', { exact: true })).toBeVisible();
  await expect(panel(page).getByText('Default', { exact: true })).toBeVisible();
  // The card says it at once, from the answer of the write: the list is not read again.
  await expect(card(page).locator('dd').nth(1)).toHaveText('LinearTeam Web');
  await expectNoViolation(page, 'the places of a site');

  // The address goes after the place of before.
  await add(page).click();
  await page.getByRole('option', { name: 'hooks.acme.dev/fruitback', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(2);
  expect(worker.sent[1]).toEqual([{ connector: 'c1', teamId: 't1' }, { connector: 'r1' }]);
  await expect(panel(page).getByText('REST API · hooks.acme.dev', { exact: true })).toBeVisible();

  // « Close » gives focus back to the button of the card.
  await panel(page).locator('..').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: `More for ${SITE}`, exact: true })).toBeFocused();
});

test('the places wait for a list to be kept before the next gesture (FRU-123)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.places = [{ connector: 'c1', teamId: 't1' }];
  await openPlaces(page);
  const remove = panel(page).getByRole('button', { name: 'Remove', exact: true });
  await expect(add(page)).toBeEnabled();

  // The first gesture: a second place, whose write the worker holds open.
  worker.holdNext();
  await add(page).click();
  await page.getByRole('option', { name: 'Web · Site', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(1);

  // While it is written, every control of the list waits.
  await expect(add(page)).toBeDisabled();
  await expect(remove).toBeDisabled();
  // A second gesture now would be made from the list of before, which has one place: it sends nothing.
  await remove.click({ force: true });

  worker.release();
  await expect(panel(page).getByText('Linear · Web · Site', { exact: true })).toBeVisible();
  await expect(remove.first()).toBeEnabled();
  expect(worker.sent).toEqual([
    [
      { connector: 'c1', teamId: 't1' },
      { connector: 'c1', teamId: 't1', projectId: 'p1' },
    ],
  ]);

  // The next gesture starts from the list the worker keeps: the place added is in it.
  await panel(page).getByRole('button', { name: 'Make it the default', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(2);
  expect(worker.sent[1]).toEqual([
    { connector: 'c1', teamId: 't1', projectId: 'p1' },
    { connector: 'c1', teamId: 't1' },
  ]);
});

test('a repository is sent as a repository, and a public one says its issues are public', async ({ page }) => {
  const worker = await workerWith(page);
  await openPlaces(page);
  await add(page).click();
  await page.getByRole('option', { name: 'acme/Docs', exact: true }).click();

  await expect.poll(() => worker.sent).toEqual([[{ connector: 'g1', repository: 'acme/docs' }]]);
  // The choice comes back from `teamId`, in lower case.
  await expect(panel(page).getByText('GitHub · acme/docs', { exact: true })).toBeVisible();
  await expect(panel(page).locator('[data-public]')).toHaveText(PUBLIC_DOCS);
  // The card says it too, to whoever reads where the notes go.
  await expect(card(page).getByRole('alert')).toHaveText(PUBLIC_DOCS);

  // A private repository says nothing of the kind.
  await panel(page).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(2);
  await add(page).click();
  await page.getByRole('option', { name: 'acme/web', exact: true }).click();
  await expect(panel(page).getByText('GitHub · acme/web', { exact: true })).toBeVisible();
  await expect(panel(page).locator('[data-public]')).toHaveCount(0);
  await expect(card(page).getByRole('alert')).toHaveCount(0);
  await expectNoViolation(page, 'a repository chosen');
});

test('a place of Linear that is removed sends the GitHub place of the site as a repository', async ({ page }) => {
  const worker = await workerWith(page);
  worker.places = [
    { connector: 'g1', teamId: 'acme/web' },
    { connector: 'c1', teamId: 't1' },
  ];
  await openPlaces(page);
  await panel(page).getByRole('button', { name: 'Remove', exact: true }).nth(1).click();

  await expect.poll(() => worker.sent).toEqual([[{ connector: 'g1', repository: 'acme/web' }]]);
});

test('a read of the repositories that failed says so, and « Try again » reads them again', async ({ page }) => {
  const worker = await workerWith(page);
  // Two: a development build runs the effect twice, and only the read of the second run is shown.
  worker.silentReads = 2;
  await openPlaces(page);
  await expect(panel(page).getByRole('alert')).toHaveText(
    'GitHub Issues · Installed on acme did not answer with its places.',
  );
  await panel(page).getByRole('button', { name: 'Try again', exact: true }).click();

  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await add(page).click();
  await expect(page.getByRole('option', { name: 'acme/Docs', exact: true })).toBeVisible();
});

test('the warning of a public repository shows at once, while the list is still read (FRU-382)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.places = [{ connector: 'g1', teamId: 'acme/docs' }];
  worker.repositoriesWait = true;
  await openPlaces(page);

  await expect(panel(page).locator('[data-public]')).toHaveText(PUBLIC_DOCS);
  // The list was asked for and has not answered: the warning is the worker's word on the destination.
  expect(worker.listed).toBeGreaterThan(0);
});

test('a list of the repositories that failed does not hide the warning (FRU-382)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.places = [{ connector: 'g1', teamId: 'acme/docs' }];
  // Every read fails: a development build runs the effect twice, and a second read must not answer.
  worker.silentReads = 100;
  await openPlaces(page);

  await expect(panel(page).getByText('did not answer with its places.')).toBeVisible();
  await expect(panel(page).locator('[data-public]')).toHaveText(PUBLIC_DOCS);
});

test('once the list names the repository, it wins over an older word of the worker (FRU-382)', async ({ page }) => {
  const worker = await workerWith(page);
  // The worker last read acme/web public; GitHub's list now says it is private.
  worker.places = [{ connector: 'g1', teamId: 'acme/web' }];
  worker.repositoriesWait = true;
  const stale = { connector: 'g1', teamId: 'acme/web', label: 'GitHub · acme/web', private: false };
  await page.route('**/console/workspaces/w1/sites', (route) =>
    route.fulfill({
      json: { sites: [{ id: 's1', origin: `https://${SITE}`, visibility: 'members', destinations: [stale] }] },
    }),
  );
  await openPlaces(page);
  // While the list is read, the worker's word.
  await expect(panel(page).locator('[data-public]')).toHaveCount(1);

  worker.repositoriesWait = false;
  await page.reload();
  await page.getByRole('button', { name: `More for ${SITE}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Destinations', exact: true }).click();
  await expect(add(page)).toBeEnabled();
  await expect(panel(page).locator('[data-public]')).toHaveCount(0);
});

test('a member reads where the notes go and the warning, chooses nothing, and asks for no list', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.places = [
    { connector: 'g1', teamId: 'acme/docs' },
    { connector: 'g1', teamId: 'acme/web' },
  ];
  await page.goto(`${CONSOLE}/w/w1/sites`);

  // The public one only: acme/web is private.
  await expect(card(page).getByRole('alert')).toHaveText([PUBLIC_DOCS]);
  await page.getByRole('button', { name: `More for ${SITE}`, exact: true }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Install']);
  await page.keyboard.press('Escape');
  expect(worker.listed).toBe(0);
  await expectNoViolation(page, 'the card of a member');
});

test('the control: with no word of the worker, the card says nothing is public (FRU-382)', async ({ page }) => {
  // A worker of before says nothing of the repository, and a member reads no list: the warning
  // above comes from the destination.
  const worker = await workerWith(page, 'member');
  worker.privacy = 'unknown';
  worker.places = [{ connector: 'g1', teamId: 'acme/docs' }];
  await page.goto(`${CONSOLE}/w/w1/sites`);

  await expect(card(page).getByText('GitHub', { exact: true })).toBeVisible();
  await expect(card(page).getByRole('alert')).toHaveCount(0);
});

test('with no source, and with a read of the sources that failed, the panel says which', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  await openPlaces(page);
  await expect(panel(page)).toContainText('No source is connected. Connect a tracker');
  await expect(panel(page).getByRole('link', { name: 'Connect a tracker' })).toHaveAttribute(
    'href',
    '/w/w1/connectors',
  );
  await expect(add(page)).toHaveCount(0);

  worker.connectors = [LINEAR];
  worker.connectorsFail = true;
  await openPlaces(page);
  await expect(panel(page).getByRole('alert')).toHaveText('The sources of this workspace did not load.');
  worker.connectorsFail = false;
  await panel(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(add(page)).toBeEnabled();
});

test('the panel of a source lists the sites that send there, and leads to the Sites screen to change them', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.places = [{ connector: 'c1', teamId: 't1' }];
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await page.locator('button[id^="source-row-"]').first().click();
  const linear = page.getByRole('region', { name: /^Linear · / });
  await expect(linear.locator(`[data-site="${SITE}"]`)).toContainText('Linear · Web');
  // The places are read here, and chosen on the Sites screen only.
  await expect(linear.getByRole('button', { name: /Add a destination/ })).toHaveCount(0);
  await expect(linear.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
  await linear.getByRole('link', { name: 'Open the sites' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px the places of a site fit, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const worker = await workerWith(page, 'owner', locale);
    worker.places = [
      { connector: 'g1', teamId: 'acme/docs' },
      { connector: 'c1', teamId: 't1', projectId: 'p1' },
    ];
    await page.goto(`${CONSOLE}/w/w1/sites`);
    await page
      .getByRole('button', { name: `${locale === 'en' ? 'More for' : 'Plus pour'} ${SITE}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Destinations', exact: true }).click();
    const opened = page.getByRole('region', {
      name: locale === 'en' ? `Where the notes of ${SITE} go` : `Où vont les notes de ${SITE}`,
    });
    await expect(opened.locator('[data-public]')).toBeVisible();
    await page.waitForTimeout(300);
    expect.soft(await sideScroll(page), 'the places').toBe(0);
    await expectNoViolation(page, `the places at 390 px, ${locale}`);
  });
}

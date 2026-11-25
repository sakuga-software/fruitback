import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import {
  ACME,
  type Role,
  box,
  contrast,
  fulfillSites,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';
import { settled, unfolded } from './settled.ts';

/**
 * The Connectors screen (FRU-690): the table of the connectors with the health of each one, the
 * catalogue of what can be added with the logo of each tracker, and the settings of a connector in a
 * dialog. The values are those of the mockup of FRU-690 (« Maquette HTML · Connecteurs »), on the
 * tokens of the console. The writes of the settings are in `console-destinations.spec.ts`. The
 * worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const MUTED = '#5b6779';
const LINE = '#e3e8ef';
const CHIP = '#e8edf3';
/** Under the pointer (FRU-683). */
const HOVER = '#e8edf3';
const ACCENT = '#dd2c27';
const ACCENT_STRONG = '#b91c1c';
const DONE = '#166534';

const SETTINGS = { showComments: true, stages: {} };
const LINEAR = {
  id: 'c1',
  kind: 'linear',
  label: 'Linear OAuth · Acme',
  createdAt: '2026-10-01T10:00:00.000Z',
  settings: SETTINGS,
};
const ADDRESS = {
  id: 'r1',
  kind: 'rest',
  label: 'REST · hooks.acme.dev/feedback',
  createdAt: '2026-10-02T10:00:00.000Z',
};
const PLACE = { connector: 'c1', teamId: 't1', label: 'Linear · Acme web' };
const THERE = { connector: 'r1', label: 'REST API · hooks.acme.dev/feedback' };
const SITES = [
  { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members', destination: PLACE, destinations: [PLACE] },
  { id: 's2', origin: 'https://acme.dev', visibility: 'everyone', destination: PLACE, destinations: [PLACE, THERE] },
  { id: 's3', origin: 'https://support.acme.dev', visibility: 'everyone' },
];
const STATES = (
  [
    ['Triage', 'new'],
    ['Todo', 'todo'],
    ['In Progress', 'progress'],
    ['Done', 'done'],
    ['Canceled', 'closed'],
  ] as const
).map(([name, stage], index) => ({ id: `st${index}`, name, type: 'x', teamId: 't1', team: 'Acme web', stage }));
const LATE = [
  { id: 'd1', createdAt: '2026-10-12T09:00:00.000Z', attempts: 3, nextAt: '2026-10-13T12:00:00.000Z', lastStatus: 500 },
  { id: 'd2', createdAt: '2026-10-12T10:00:00.000Z', attempts: 8, lastError: 'timeout' },
];

type Worker = {
  connectors: unknown[];
  oauth: boolean;
  /** The notes that did not reach the address. `undefined`: the worker does not answer that read. */
  late: unknown[] | undefined;
  /** The worker answers no list of sources, and no list of sites. */
  down: boolean;
  /** The worker says it cannot keep a key: nobody connects a source. */
  unavailable?: boolean;
  /** What the worker answers to a source that is added. */
  refuses?: string;
  /** What the worker answers to a name (FRU-404). */
  refusesName?: string;
  sent: { pathname: string; body: unknown }[];
};

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { connectors: [LINEAR, ADDRESS], oauth: true, late: LATE, down: false, sent: [] };
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (request.method() !== 'GET') {
      worker.sent.push({ pathname, body: request.postDataJSON() });
      // FRU-633: the consent at Linear is skipped. The browser comes back as the worker sends it back.
      if (pathname.endsWith('/connectors/c1/reconnect')) {
        worker.connectors = worker.connectors.map((each) => ((each as { id: string }).id === 'c1' ? LINEAR : each));

        return json({ url: `${CONSOLE}/w/w1/connectors?linear=reconnected&connector=c1` }, 201);
      }
      const named = /\/connectors\/(\w+)$/.exec(pathname);
      if (named !== null && request.method() === 'POST') {
        if (worker.refusesName !== undefined) return json({ error: worker.refusesName }, 400);
        const name = (request.postDataJSON() as { name: string }).name;
        worker.connectors = worker.connectors.map((each) => {
          const connector = each as { id: string; name?: string };
          if (connector.id !== named[1]) return each;
          const { name: _, ...rest } = connector;

          return name === '' ? rest : { ...rest, name };
        });

        return json(worker.connectors.find((each) => (each as { id: string }).id === named[1]));
      }
      if (pathname.endsWith('/connectors')) {
        if (worker.refuses !== undefined) return json({ error: worker.refuses }, 400);
        // A key of Linear: the connector of its person, with no secret to show.
        if ((request.postDataJSON() as { kind?: string }).kind === 'linear') {
          const key = {
            id: 'c9',
            kind: 'linear',
            label: 'Linear · Bo',
            createdAt: '2026-10-13T10:00:00.000Z',
            settings: SETTINGS,
          };
          worker.connectors = [...worker.connectors, key];

          return json(key, 201);
        }
        // A secret the person gave is not sent back: the worker shows only the one it made.
        const given = (request.postDataJSON() as { secret?: string }).secret !== undefined;
        const made = {
          id: 'r2',
          kind: 'rest',
          label: 'REST · hooks.client.fr/notes',
          createdAt: '2026-10-13T10:00:00.000Z',
        };
        worker.connectors = [...worker.connectors, made];

        return json(given ? made : { ...made, secret: 'made-by-fruitback-0123456789' }, 201);
      }

      return json({});
    }
    if (worker.down && (pathname.endsWith('/connectors') || pathname.endsWith('/sites'))) return json({}, 500);
    if (pathname.endsWith('/connectors'))
      return json({ connectors: worker.connectors, available: worker.unavailable !== true, linearOAuth: worker.oauth });
    const read = fulfillSites(route, SITES);
    if (read !== false) return read;
    if (pathname.endsWith('/c1/teams'))
      return json({ teams: [{ id: 't1', name: 'Acme web', key: 'ACM', projects: [{ id: 'p1', name: 'Website' }] }] });
    if (pathname.endsWith('/c1/states')) return json({ states: STATES, settings: SETTINGS });
    // The statuses page of a site (FRU-371, FRU-368), which a link of the panel opens.
    if (/\/sites\/\w+\/statuses$/.test(pathname)) return json({ statuses: [] });
    if (/\/sites\/\w+\/statuses\/tracker$/.test(pathname)) return json({ trackerColours: false, trackers: [] });
    if (pathname.endsWith('/deliveries'))
      return worker.late === undefined
        ? json({}, 500)
        : json({ deliveries: pathname.includes('/r1/') ? worker.late : [] });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** The rows of the table of the connectors (FRU-690). */
const rows = (page: Page) => page.locator('tbody tr[data-connector]');
/** The button at the end of a row that opens the settings of its connector. */
const settingsOf = (page: Page, name: string) => page.getByRole('button', { name: `Settings of ${name}`, exact: true });
const panel = (page: Page) => page.locator('#source-panel');
/** The catalogue, on the page under the table (FRU-690). */
const catalogue = (page: Page) => page.getByRole('region', { name: 'Add a connector' });
const tiles = (page: Page) => catalogue(page).getByRole('listitem');
const tile = (page: Page, name: string) => catalogue(page).locator(`[data-source="${name}"]`);
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search trackers and tools' });
/** The count of the sends that wait, on « Connectors » in the bar (FRU-684, FRU-690). */
const failing = (page: Page) =>
  page
    .locator('aside')
    .getByRole('link', { name: /^Connectors/ })
    .locator('[data-failing]');

/** The tiles of the catalogue, in the order of the mockup of FRU-690. */
const CATALOGUE = [
  ['Linear', 'linear'],
  ['Jira', 'jira'],
  ['GitHub Issues', 'github'],
  ['GitLab', 'gitlab'],
  ['Asana', 'asana'],
  ['ClickUp', 'clickup'],
  ['Trello', 'trello'],
  ['Notion', 'notion'],
  ['Slack', 'slack'],
  ['Webhook', 'webhook'],
  ['REST API', 'rest'],
  ['Claude Code routine', 'claude-routine'],
] as const;

/** Opens the settings of a connector from its row, and waits for the dialog. */
async function openSettings(page: Page, name: string): Promise<void> {
  await settingsOf(page, name).click();
  await unfolded(page);
}

async function expectNoViolation(page: Page, name: string, scope = 'main'): Promise<void> {
  await settled(page);
  const results = await new AxeBuilder({ page }).include(scope).analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the table of the connectors, and the settings of a Linear in their dialog', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await expect(
    page.getByText('Connect a tracker once. Every site of Acme can then send its notes there.'),
  ).toBeVisible();

  // « Your connectors » and how many.
  const title = page.getByRole('heading', { level: 2, name: /^Your connectors/ });
  await expect(title).toHaveText('Your connectors2');
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });

  // A table: the connector with its logo, its account, the sites that use it, its health.
  await expect(page.locator('.kit-table thead th')).toHaveText([
    'Connector',
    'Account',
    'Used by',
    'Health',
    'Actions',
  ]);
  await expect(rows(page)).toHaveCount(2);
  const linear = rows(page).first();
  await expect(linear.locator('td')).toHaveText(['Linear', 'Workspace Acme', '2 sites', 'Connected', '']);
  await expect(rows(page).nth(1).locator('td').nth(1)).toHaveText('hooks.acme.dev/feedback');

  // The logo is a file the console serves itself, in its box of 24 px, 14 px inside.
  const logo = linear.locator('img[data-logo="linear"]');
  await expect(logo).toHaveAttribute('src', '/logos/linear.svg');
  await expect(logo).toHaveAttribute('alt', '');
  expect(await logo.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  expect.soft(await styles(logo, ['width', 'height'])).toEqual({ width: '14px', height: '14px' });
  const frame = logo.locator('..');
  await expect(frame).toHaveAttribute('aria-hidden', 'true');
  expect.soft(await styles(frame, ['width', 'height', 'border-top-left-radius'])).toEqual({
    width: '24px',
    height: '24px',
    'border-top-left-radius': '6px',
  });
  expect.soft(await painted(frame, 'borderTopColor')).toEqual(rgb(LINE));
  await expect(rows(page).nth(1).locator('img[data-logo="rest"]')).toHaveAttribute('src', '/logos/rest.svg');

  // A tracker says « Connected »: the worker does not say yet whether its notes arrived (FRU-714).
  const state = linear.locator('[data-pill]');
  expect.soft(await styles(state, ['font-size', 'font-weight', 'height'])).toEqual({
    'font-size': '12px',
    'font-weight': '600',
    height: '20px',
  });
  expect.soft(await painted(state, 'color')).toEqual(rgb(DONE));
  expect
    .soft(contrast(rgb(DONE), await painted(state, 'backgroundColor')), 'the green on its tint')
    .toBeGreaterThanOrEqual(4.5);

  // A press of « … » opens the settings in a dialog named after the connector. No accordion any more.
  const opener = settingsOf(page, 'Linear');
  await openSettings(page, 'Linear');
  const dialog = page.getByRole('dialog', { name: 'Linear' });
  await expect(dialog).toBeVisible();
  await expect(panel(page)).toHaveAttribute('aria-label', 'Linear · Workspace Acme');
  await expect(linear).toHaveAttribute('data-chosen', 'true');
  const card = panel(page).locator('aside');
  await expect(card.getByText('Connected to the workspace Acme')).toBeVisible();

  // The sites that send here, each with its places, read only: a site chooses them on the Sites
  // screen (FRU-399), which the block leads to.
  await expect(card.locator('[data-site]')).toHaveCount(2);
  await expect(card.locator('[data-site="support.acme.dev"]')).toHaveCount(0);
  await expect(card.getByText('Each site chooses where its notes go, on the Sites screen.')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open the sites' })).toHaveAttribute('href', '/w/w1/sites');
  // The statuses of each site, on its row (FRU-478).
  await expect(card.getByRole('heading', { level: 3 })).toHaveText(['Sites sending here']);
  await expect(card.getByRole('link', { name: /^Statuses of / })).toHaveText(['Statuses', 'Statuses']);
  await expect(
    card.locator('[data-site="staging.acme.dev"]').getByRole('link', { name: 'Statuses of https://staging.acme.dev' }),
  ).toHaveAttribute('href', '/w/w1/sites/s1/statuses');
  await expect(card.getByRole('switch', { name: 'Show Linear comments as replies' })).toBeChecked();
  await expect(card.getByRole('button', { name: 'Disconnect Linear', exact: true })).toBeVisible();
  await expectNoViolation(page, 'the settings of a Linear', '[role="dialog"]');

  // Escape closes it, and focus goes back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // A press on the row opens them too.
  await linear.locator('td').nth(1).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expectNoViolation(page, 'the table');
});

test('an address says how many sends wait, « Retry » sends them again, and the bar counts them', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const address = rows(page).nth(1);
  const state = address.getByText('2 notes not delivered', { exact: true });
  await expect(state).toBeVisible();
  // The strong red: the accent is under 4.5:1 on a tint (FRU-683).
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT_STRONG));
  expect
    .soft(contrast(rgb(ACCENT_STRONG), await painted(state, 'backgroundColor')), 'the red on its tint')
    .toBeGreaterThanOrEqual(4.5);
  await address.hover();
  expect.soft(await painted(address, 'backgroundColor')).toEqual(rgb(HOVER));
  expect
    .soft(contrast(rgb(ACCENT_STRONG), rgb(HOVER)), 'the red on a row under the pointer')
    .toBeGreaterThanOrEqual(4.5);
  expect(contrast(rgb(ACCENT), rgb(CHIP)), 'the control: the accent would not do').toBeLessThan(4.5);

  // The red count of « Connectors » in the bar follows them.
  await expect(failing(page)).toHaveText('failed sends:2');

  // The settings of the address list them, as before.
  await openSettings(page, 'REST API');
  await expect(panel(page).getByRole('heading', { level: 2, name: 'REST API', exact: true })).toBeAttached();
  await expect(panel(page).getByText('Your receiver answered 500')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Try now' })).toHaveCount(2);
  await page.keyboard.press('Escape');

  // « Retry » asks each of them again, then reads the health again.
  worker.late = [];
  await address.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(address.getByText('Healthy', { exact: true })).toBeVisible();
  expect(worker.sent.map((each) => each.pathname)).toEqual([
    '/console/workspaces/w1/connectors/r1/deliveries/d1/retry',
    '/console/workspaces/w1/connectors/r1/deliveries/d2/retry',
  ]);
  await expect(address.getByRole('button', { name: /^Retry/ })).toHaveCount(0);
  await expect(failing(page)).toHaveCount(0);

  // One note: the singular.
  worker.late = LATE.slice(0, 1);
  await open(page);
  await expect(rows(page).nth(1).getByText('1 note not delivered', { exact: true })).toBeVisible();
  await expect(failing(page)).toHaveText('failed sends:1');
});

test('the sends of an address that were not read are « Not read », and the screen says so', async ({ page }) => {
  const worker = await workerWith(page);
  worker.late = undefined;
  await open(page);
  const address = rows(page).nth(1);
  // Never « Healthy »: the screen does not know.
  await expect(address.locator('[data-pill]')).toHaveText('Not read');
  await expect(address.getByText('Healthy')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveText(
    'The health of some connectors did not load. Fruitback hit an error.',
  );
  await openSettings(page, 'REST API');
  await expect(panel(page).getByText('Fruitback hit an error. Try again in a moment.')).toBeVisible();
  await expect(panel(page).getByText('Every note arrived.')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // « Try again » reads them again.
  worker.late = [];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(address.locator('[data-pill]')).toHaveText('Healthy');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a connector that its tracker refuses, or a place it refused, says so in red', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [
    { ...LINEAR, label: 'Linear · Ana', attention: { reason: 'key-refused', since: '2026-10-10T10:00:00.000Z' } },
    ADDRESS,
  ];
  await open(page);
  const state = rows(page).first().locator('[data-pill]');
  await expect(state).toHaveText('Needs attention');
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT_STRONG));
  await openSettings(page, 'Linear');
  await expect(panel(page).getByRole('alert').first()).toContainText('Linear refuses this connection since');
  await expect(panel(page).getByText('Connected with the key of Ana')).toBeVisible();
});

test('a place of a site that the tracker refused makes its connector « Needs attention » (FRU-640)', async ({
  page,
}) => {
  await workerWith(page);
  await page.route(
    `${WORKER_ORIGIN}/console/workspaces/w1/sites*`,
    (route) =>
      fulfillSites(route, [
        {
          ...SITES[0],
          destinations: [{ ...PLACE, attention: { reason: 'place-gone', since: '2026-11-20T10:00:00Z' } }],
        },
      ]) || route.fallback(),
  );
  await open(page);
  await expect(rows(page).first().locator('[data-pill]')).toHaveText('Needs attention');
  await expect(rows(page).nth(1).locator('[data-pill]')).toHaveText('2 notes not delivered');
});

test('a connection that Linear ended is reconnected from its settings, and keeps its sites (FRU-633)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  const ended = { ...LINEAR, attention: { reason: 'connection-ended', since: '2026-11-12T09:54:53.000Z' } };
  worker.connectors = [ended, ADDRESS];
  await open(page);
  await openSettings(page, 'Linear');
  const alert = panel(page).getByRole('alert').first();
  await expect(alert).toContainText('Linear ended this connection, and since');
  await expect(alert).toContainText('Reconnect it: its sites and its settings stay as they are.');

  await panel(page).getByRole('button', { name: 'Reconnect Linear', exact: true }).click();

  // Back from Linear, the settings of the connector open by themselves, with what happened.
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
  expect(worker.sent.map((each) => each.pathname)).toContain('/console/workspaces/w1/connectors/c1/reconnect');
  await expect(panel(page).getByRole('status')).toHaveText(
    'Linear is connected again. Its sites send their notes to the same places.',
  );
  await expect(panel(page).getByRole('alert')).toHaveCount(0);
  await expect(rows(page).first().locator('[data-pill]')).toHaveText('Connected');
});

test('a member reads that a connection ended, and is not offered to reconnect it (FRU-633)', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [{ ...LINEAR, attention: { reason: 'connection-ended', since: '2026-11-12T09:54:53.000Z' } }];
  await open(page);
  await openSettings(page, 'Linear');
  await expect(panel(page).getByRole('alert').first()).toContainText(
    'An owner or an admin of the workspace can reconnect it here.',
  );
  await expect(panel(page).getByRole('button', { name: 'Reconnect Linear' })).toHaveCount(0);
});

test('a consent for another workspace of Linear says so in the settings of the connector (FRU-633)', async ({
  page,
}) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/connectors?linear=other-organization&connector=c1`);
  await expect(panel(page).getByRole('alert').first()).toHaveText(
    'This connector did not change: you chose another workspace of Linear at Linear. Reconnect it, and choose its workspace of Linear.',
  );
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
});

test('with no connector, and with a read that failed, the screen says which of the two it is', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  await open(page);
  await expect(page.getByText('No tracker yet. The notes stay in Fruitback.')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(12);
  await expect(page.getByRole('heading', { level: 2, name: /^Your connectors/ })).toHaveCount(0);
  // The catalogue is on the screen: no « New connector » leads to it.
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  await expectNoViolation(page, 'no connector');

  // A read that failed is not « no tracker »: it says so, and reads again.
  worker.down = true;
  await open(page);
  await expect(page.getByRole('alert')).toHaveText(
    'The connectors and their sites did not load. Fruitback hit an error.',
  );
  await expect(page.getByText('No tracker yet. The notes stay in Fruitback.')).toHaveCount(0);
  // Nothing to add while the list is not read: the screen does not know how this worker connects
  // Linear, by the consent at Linear or by a key.
  await expect(catalogue(page)).toHaveCount(0);
  worker.down = false;
  worker.connectors = [LINEAR, ADDRESS];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The control of the count above: once read, the catalogue is there.
  await expect(tiles(page)).toHaveCount(12);
});

test('the catalogue: a tile for each tracker, its logo, one line, and its state', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const worker = await workerWith(page);
  worker.connectors = [ADDRESS];
  await open(page);
  await expect(tiles(page)).toHaveCount(12);
  for (const [index, [name, kind]] of CATALOGUE.entries()) {
    const each = tiles(page).nth(index);
    await expect(each, name).toHaveAttribute('data-source', name);
    await expect(each.locator(`img[data-logo="${kind}"]`), kind).toHaveAttribute('src', `/logos/${kind}.svg`);
  }
  // Every logo is drawn: each file is served by the console itself.
  for (const image of await catalogue(page).locator('img[data-logo]').all()) {
    expect(await image.evaluate((each: HTMLImageElement) => each.complete && each.naturalWidth > 0)).toBe(true);
  }

  // A tile of 64 px: the logo in its box of 36 px, 20 px inside; four in a row at 1440 px.
  const first = tile(page, 'Linear');
  expect.soft(await styles(first, ['height', 'border-top-left-radius', 'border-top-width'])).toEqual({
    height: '64px',
    'border-top-left-radius': '8px',
    'border-top-width': '1px',
  });
  expect.soft(await painted(first, 'borderTopColor')).toEqual(rgb(LINE));
  const frame = first.locator('img').locator('..');
  expect.soft(await styles(frame, ['width', 'height'])).toEqual({ width: '36px', height: '36px' });
  expect.soft(await styles(first.locator('img'), ['width', 'height'])).toEqual({ width: '20px', height: '20px' });
  const boxes = await Promise.all([0, 1, 2, 3, 4].map(async (index) => box(tiles(page).nth(index))));
  for (const index of [1, 2, 3]) expect(boxes[index]!.y, `tile ${index + 1}`).toBe(boxes[0]!.y);
  expect(boxes[4]!.y).toBeGreaterThan(boxes[0]!.y);
  expect.soft(await styles(catalogue(page).getByRole('list'), ['row-gap', 'column-gap'])).toEqual({
    'row-gap': '10px',
    'column-gap': '10px',
  });

  // One line of what a note becomes there, cut at its end; the whole sentence is the tooltip.
  const line = tile(page, 'Webhook').locator('[data-tile-line]');
  await expect(line).toHaveText('Tells any address when a note arrives');
  expect.soft(await styles(line, ['white-space', 'text-overflow', 'overflow-x'])).toEqual({
    'white-space': 'nowrap',
    'text-overflow': 'ellipsis',
    'overflow-x': 'hidden',
  });
  expect(await line.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(line.locator('..')).toHaveAttribute('title', 'Tells Slack or any address when a note arrives.');
  expect.soft(await painted(line, 'color')).toEqual(rgb(MUTED));

  // The states: « Connected », « Connect », « Soon », and the « New » of the routine.
  await expect(tile(page, 'REST API').locator('[data-pill]')).toHaveText('Connected');
  await expect(tile(page, 'REST API').getByRole('button', { name: 'Connect another REST API' })).toBeVisible();
  for (const name of ['Jira', 'GitLab', 'Asana', 'ClickUp', 'Trello', 'Notion', 'Slack', 'Webhook']) {
    // No plugin of this kind on this worker: nothing here connects.
    await expect(tile(page, name).locator('[data-pill]'), name).toHaveText('Soon');
    await expect(tile(page, name).getByRole('button'), name).toHaveCount(0);
  }
  const connect = tile(page, 'GitHub Issues').getByRole('button', { name: 'Connect GitHub Issues', exact: true });
  // The worker of these stubs has no GitHub App: the tile says so, and connects nothing.
  await expect(connect).toHaveCount(0);
  await expect(tile(page, 'GitHub Issues').locator('[data-pill]')).toHaveText('Not set up');
  await expect(tile(page, 'GitHub Issues').locator('[data-tile-line]')).toHaveText(
    'The operator of this Fruitback has not set up the GitHub App.',
  );
  await expect(tile(page, 'Claude Code routine').locator('[data-pill]')).toHaveText('New');
  const routine = tile(page, 'Claude Code routine').getByRole('button', { name: 'Connect Claude Code routine' });
  expect.soft(await styles(routine, ['height', 'font-size'])).toEqual({ height: '24px', 'font-size': '12px' });

  // Linear connects by the consent at Linear, and its key is the other way, in a menu.
  await expect(tile(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true })).toBeVisible();
  await tile(page, 'Linear').getByRole('button', { name: 'Other ways to connect Linear' }).click();
  await page.getByRole('menuitem', { name: 'Use an API key' }).click();
  await expect(tile(page, 'Linear').getByLabel('Linear API key')).toBeVisible();
  // The tile of the form takes the whole row.
  expect((await box(tile(page, 'Linear'))).width).toBeGreaterThan(boxes[0]!.width * 3);
  await tile(page, 'Linear').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(tile(page, 'Linear').getByLabel('Linear API key')).toHaveCount(0);
  await expectNoViolation(page, 'the catalogue');
});

test('the catalogue searches its tiles, and shows one kind at a time', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const names = () => tiles(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-source')));
  await search(page).fill('git');
  await expect.poll(names).toEqual(['GitHub Issues', 'GitLab']);
  // No case and no accent: « Dépôt » finds what « depot » would.
  await search(page).fill('TRELLO');
  await expect.poll(names).toEqual(['Trello']);
  await search(page).fill('zzz');
  await expect(tiles(page)).toHaveCount(0);
  await expect(catalogue(page).getByRole('status')).toHaveText('No connector matches « zzz ».');
  await search(page).fill('');

  const group = catalogue(page).getByRole('group', { name: 'Kind of connector' });
  await expect(group.getByRole('button')).toHaveText(['All kinds', 'Trackers', 'Agents', 'Developers']);
  await expect(group.getByRole('button', { name: 'All kinds' })).toHaveAttribute('aria-pressed', 'true');
  await group.getByRole('button', { name: 'Developers' }).click();
  await expect.poll(names).toEqual(['Webhook', 'REST API']);
  await group.getByRole('button', { name: 'Agents' }).click();
  await expect.poll(names).toEqual(['Claude Code routine']);
  await group.getByRole('button', { name: 'Trackers' }).click();
  await expect(tiles(page)).toHaveCount(9);
  await expect(group.getByRole('button', { name: 'Trackers' })).toHaveAttribute('aria-pressed', 'true');
});

test('an address connected from its tile shows its secret once, then its settings open', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await tile(page, 'REST API').getByRole('button', { name: 'Connect another REST API' }).click();
  const field = page.getByRole('textbox', { name: 'Address of your receiver' });
  // An address that the worker refuses keeps what was typed.
  worker.refuses = 'invalid-address';
  await field.fill('https://hooks.client.fr/notes');
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(tile(page, 'REST API').getByRole('alert')).toContainText('Fruitback cannot send to this address.');
  await expect(field).toHaveValue('https://hooks.client.fr/notes');
  await expectNoViolation(page, 'the form of an address');

  // Kept: the secret that Fruitback made is on the screen once, and the address is in the table.
  worker.refuses = undefined;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveCount(0);
  // Its settings open, and the secret is gone from the screen.
  await expect(panel(page)).toHaveAttribute('aria-label', /hooks\.client\.fr\/notes/);
  await expect(page.getByText('made-by-fruitback-0123456789')).toHaveCount(0);
});

test('a secret on the screen stays when the read after it says no connector can be added', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await tile(page, 'REST API').getByRole('button', { name: 'Connect another REST API' }).click();
  await page.getByRole('textbox', { name: 'Address of your receiver' }).fill('https://hooks.client.fr/notes');
  // The read that follows the address says this worker cannot keep a key any more: the buttons of
  // the catalogue go, and the form with the secret must not go with them.
  worker.unavailable = true;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(panel(page)).toBeVisible();
});

test('« New connector » and `?new` lead to the search of the catalogue', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'New connector', exact: true }).click();
  await expect(search(page)).toBeFocused();
  await expect(catalogue(page).getByRole('heading', { name: 'Add a connector' })).toBeInViewport();

  await page.goto(`${CONSOLE}/w/w1/connectors?new=1`);
  await expect(search(page)).toBeFocused();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
});

test('`?new` leads nowhere for a person who cannot add a connector', async ({ page }) => {
  await workerWith(page, 'member');
  await page.goto(`${CONSOLE}/w/w1/connectors?new=1`);
  await expect(rows(page)).toHaveCount(2);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/connectors`);
  await expect(search(page)).not.toBeFocused();

  // A worker that cannot keep a key: the same, also after a later read that can.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const owner = await workerWith(page);
  owner.unavailable = true;
  await page.goto(`${CONSOLE}/w/w1/connectors?new=1`);
  await expect(rows(page)).toHaveCount(2);
  await expect(search(page)).not.toBeFocused();
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  owner.unavailable = false;
  await page.getByRole('button', { name: 'Retry REST API', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toBeVisible();
  await expect(search(page)).not.toBeFocused();
});

test('the catalogue waits for the list of the connectors, and its buttons do not move under a press', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  // The read is held: the screen is drawn without the list, as on a slow line.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${WORKER_ORIGIN}/console/workspaces/w1/connectors`, async (route) => {
    await held;
    await route.fallback();
  });
  await open(page);
  const connect = page.getByRole('button', { name: 'Connect REST API', exact: true });
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  // Nothing to press yet: what « Connect Linear » does (the consent at Linear, or a key) is said by
  // the same read.
  await expect(tiles(page)).toHaveCount(0);
  await expect(connect).toHaveCount(0);

  release();
  await expect(tiles(page)).toHaveCount(12);
  await expect(rows(page)).toHaveCount(0);
  const before = await connect.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.waitForLoadState('networkidle');
  expect(await connect.boundingBox()).toEqual(before);
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'Address of your receiver' })).toBeVisible();
});

test('a worker with no Linear application connects Linear by a key, and its settings open', async ({ page }) => {
  const worker = await workerWith(page);
  worker.oauth = false;
  worker.connectors = [ADDRESS];
  await open(page);
  await expect(tile(page, 'Linear').getByRole('button', { name: 'Other ways to connect Linear' })).toHaveCount(0);
  await tile(page, 'Linear').getByRole('button', { name: 'Connect Linear', exact: true }).click();
  await tile(page, 'Linear').getByLabel('Linear API key').fill('lin_api_0123456789');
  await tile(page, 'Linear').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(panel(page)).toHaveAttribute('aria-label', 'Linear · Key of Bo');
  await expect(tile(page, 'Linear').getByLabel('Linear API key')).toHaveCount(0);
});

test('a first address opens its settings once read, also when the read ends after « I kept it »', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  await open(page);
  await page.getByRole('button', { name: 'Connect REST API', exact: true }).click();
  await page.getByRole('textbox', { name: 'Address of your receiver' }).fill('https://hooks.client.fr/notes');
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${WORKER_ORIGIN}/console/workspaces/w1/connectors`, async (route) => {
    if (route.request().method() === 'GET') await held;
    await route.fallback();
  });
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(rows(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  release();
  await expect(rows(page)).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute('aria-label', /hooks\.client\.fr\/notes/);
});

test('after an address whose read failed, « Cancel » of the next form closes only the form', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await tile(page, 'REST API').getByRole('button', { name: 'Connect another REST API' }).click();
  await page.getByRole('textbox', { name: 'Address of your receiver' }).fill('https://hooks.client.fr/notes');
  await page.getByLabel('Secret (optional)').fill('my-own-secret-0123456789');
  // The address is kept with a secret of its own, and the read that follows fails: no settings open.
  worker.down = true;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The connectors and their sites did not load.');
  await expect(panel(page)).toHaveCount(0);
  worker.down = false;
  await tile(page, 'REST API').getByRole('button', { name: 'Connect another REST API' }).click();
  await tile(page, 'REST API').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Address of your receiver' })).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test('a member reads the connectors and the catalogue, and changes nothing', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [];
  await open(page);
  await expect(page.getByText('An owner or an admin adds a connector')).toBeVisible();
  await expect(tiles(page)).toHaveCount(12);
  // No button that does nothing: the line above says who adds one.
  await expect(catalogue(page).getByRole('button', { name: /^Connect/ })).toHaveCount(0);
  worker.connectors = [LINEAR, ADDRESS];
  await open(page);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'New connector', exact: true })).toHaveCount(0);
  await expect(
    rows(page)
      .nth(1)
      .getByRole('button', { name: /^Retry/ }),
  ).toHaveCount(0);
  await openSettings(page, 'Linear');
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Sites sending here' })).toBeVisible();
  await expect(panel(page).locator('[data-site]')).toHaveCount(2);
  await expect(panel(page).getByRole('link', { name: /^Statuses of / })).toHaveCount(0);
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await expect(panel(page).getByRole('switch')).toHaveCount(0);
});

test('a link of the settings leads to the statuses of its site (FRU-368)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await openSettings(page, 'Linear');
  await panel(page).getByRole('link', { name: 'Statuses of https://staging.acme.dev' }).click();
  await expect(page).toHaveURL(/\/w\/w1\/sites\/s1\/statuses$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statuses');
});

test('a long address keeps one line in its row, cut at its end (FRU-321)', async ({ page }) => {
  const long = 'REST · hooks.a-very-long-subdomain-of-the-receiver.staging.acme-corporation.dev/feedback/notes';
  const worker = await workerWith(page);
  worker.connectors = [LINEAR, { ...ADDRESS, label: long }];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const line = rows(page).nth(1).locator('[data-source-line]');
    const fontSize = await line.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect((await box(line)).height, `${width} px`).toBeLessThan(fontSize * 2);
    expect(await line.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expect(line).toHaveAttribute('title', long.replace(/^REST · /, ''));
    expect(await sideScroll(page), `${width} px`).toBe(0);
  }
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing scrolls sideways, with the settings open, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await open(page);
    expect.soft(await sideScroll(page), 'the table and the catalogue').toBe(0);
    // A row is a card under 680 px (FRU-505): its words are one under the other.
    await expect(page.locator('.kit-table')).toHaveAttribute('data-stacked', 'true');
    for (const name of ['Linear', locale === 'en' ? 'REST API' : 'API REST']) {
      await page
        .getByRole('button', { name: `${locale === 'en' ? 'Settings of' : 'Réglages de'} ${name}`, exact: true })
        .click();
      await unfolded(page);
      const dialog = await box(page.getByRole('dialog'));
      expect.soft(dialog.x).toBeGreaterThanOrEqual(0);
      expect.soft(dialog.x + dialog.width).toBeLessThanOrEqual(390);
      await expectNoViolation(page, `the settings of ${name} at 390 px`, '[role="dialog"]');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
    // One tile in a row.
    for (const each of await tiles(page).all())
      expect.soft((await box(each)).x + (await box(each)).width).toBeLessThanOrEqual(390);
    await page
      .getByRole('button', { name: locale === 'en' ? 'Connect another REST API' : 'Connecter un autre API REST' })
      .click();
    expect.soft(await sideScroll(page), 'the form of an address').toBe(0);
    await expectNoViolation(page, `390 px in ${locale}`);
  });
}

/**
 * FRU-404. Several connectors can reach one tracker, so an owner or an admin names each one in its
 * settings, and the name is what its row shows. An empty name gives it back the name of its kind.
 */
for (const { width, height, locale, words } of [
  {
    width: 1440,
    height: 900,
    locale: 'en',
    words: {
      settings: 'Settings of',
      rename: 'Rename Linear',
      field: 'Name of this connector',
      save: 'Save',
      refused: 'A name of one line, up to 80 characters.',
    },
  },
  {
    width: 390,
    height: 844,
    locale: 'fr',
    words: {
      settings: 'Réglages de',
      rename: 'Renommer Linear',
      field: 'Nom de ce connecteur',
      save: 'Enregistrer',
      refused: 'Un nom d’une ligne, de 80 caractères au plus.',
    },
  },
] as const) {
  test(`an owner names a connector, and its row says the name, at ${width} px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const worker = await workerWith(page, 'owner', locale);
    worker.connectors = [LINEAR, { ...LINEAR, id: 'c2', label: 'Linear · Ana' }, ADDRESS];
    await open(page);
    const row = rows(page).first();
    const name = row.locator('td').first();
    await row.getByRole('button', { name: `${words.settings} Linear`, exact: true }).click();
    await unfolded(page);

    // A refused name keeps the form open, with what was typed.
    await panel(page).getByRole('button', { name: words.rename, exact: true }).click();
    const field = panel(page).getByRole('textbox', { name: words.field });
    await expect(field).toBeFocused();
    await field.fill('Clients');
    worker.refusesName = 'invalid-name';
    await panel(page).getByRole('button', { name: words.save, exact: true }).click();
    await expect(panel(page).getByText(words.refused)).toBeVisible();
    await expect(field).toHaveValue('Clients');

    worker.refusesName = undefined;
    await field.fill('  Clients  ');
    await field.press('Enter');
    await expect(name).toHaveText('Clients');
    expect(worker.sent.at(-1)).toEqual({ pathname: '/console/workspaces/w1/connectors/c1', body: { name: 'Clients' } });
    // The kind goes first in its account, so that a name never hides what the connector is.
    await expect(row.locator('[data-source-line]')).toHaveText(/^Linear · /);
    // The dialog is named after it too.
    await expect(page.getByRole('dialog', { name: 'Clients' })).toBeVisible();
    // The neighbour of the same kind keeps its own name.
    await expect(rows(page).nth(1).locator('td').first()).toHaveText('Linear');
    await expect(panel(page).getByRole('button', { name: /Clients$/ })).toBeFocused();
    await expectNoViolation(page, `named, ${width} px`, '[role="dialog"]');

    // Escape in the form closes the form, not the dialog.
    await panel(page)
      .getByRole('button', { name: /Clients$/ })
      .click();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();

    // An empty name gives the connector back the name of its kind.
    await panel(page)
      .getByRole('button', { name: /Clients$/ })
      .click();
    await panel(page).getByRole('textbox', { name: words.field }).fill('');
    await panel(page).getByRole('button', { name: words.save, exact: true }).click();
    await expect(name).toHaveText('Linear');
    expect(worker.sent.at(-1)?.body).toEqual({ name: '' });
  });
}

test('« Rename » starts from the name of the last read, not the one of when the settings opened', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await openSettings(page, 'REST API');
  // Another admin names it meanwhile; « Try now » of a late note reads the list again.
  worker.connectors = [LINEAR, { ...ADDRESS, name: 'Support' }];
  await panel(page).getByRole('button', { name: 'Try now' }).first().click();
  await expect(rows(page).nth(1).locator('td').first()).toHaveText('Support');
  await panel(page).getByRole('button', { name: 'Rename Support', exact: true }).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name of this connector' })).toHaveValue('Support');
});

test('a member reads the name of a connector, and renames none', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [{ ...LINEAR, name: 'Clients' }, ADDRESS];
  await open(page);
  await expect(rows(page).first().locator('td').first()).toHaveText('Clients');
  await openSettings(page, 'Clients');
  await expect(panel(page).getByText('Clients', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /^Rename/ })).toHaveCount(0);
});

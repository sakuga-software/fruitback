import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';
import {
  ACME,
  type Role,
  box,
  contrast,
  expectBox,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
  fulfillSites,
} from './console-workspace.ts';

/**
 * The Connectors screen (FRU-246), measured in a browser against screen 11 of the mockup of
 * 2026-10-13: the sources that are connected, the ones to add, and the panel of a source.
 *
 * The values are read in the code of the mockup (`11-console-connectors.html`), and the boxes in its
 * render at 1440 px (a box is compared where the font is the one of the mockup). Where a panel opens
 * and what takes focus is in `console-source-panel.spec.ts`; the writes of a panel are in
 * `console-destinations.spec.ts`. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const MUTED = '#6b6b74';
const LINE = '#e4e4e7';
const SUBTLE = '#fafafa';
const CHIP = '#f4f4f5';
const ACCENT = '#dd2c27';
const ACCENT_STRONG = '#b91c1c';
const DONE = '#15803d';
const WHITE = '#ffffff';
/** The width of a row at 1440 px, inside the border of the list: the whole page, since FRU-403. */
const ROW_WIDTH = 1093;

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
        const made = {
          id: 'r2',
          kind: 'rest',
          label: 'REST · hooks.client.fr/notes',
          createdAt: '2026-10-13T10:00:00.000Z',
        };
        worker.connectors = [...worker.connectors, made];

        return json({ ...made, secret: 'made-by-fruitback-0123456789' }, 201);
      }

      return json({});
    }
    if (worker.down && (pathname.endsWith('/connectors') || pathname.endsWith('/sites'))) return json({}, 500);
    if (pathname.endsWith('/connectors'))
      return json({ connectors: worker.connectors, available: true, linearOAuth: worker.oauth });
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

const rows = (page: Page) => page.locator('button[id^="source-row-"]');
const panel = (page: Page) => page.locator('#source-panel');
const sources = (page: Page) => page.getByRole('region', { name: 'Add a connector' }).getByRole('listitem');

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the list of the sources and the panel of a Linear are the ones of the mockup', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await expect(
    page.getByText('Connect a tracker once. Every site of Acme can then send its notes there.'),
  ).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await rows(page).first().click();
  await expect(panel(page)).toBeVisible();

  // One column (FRU-403): the panel opens under its row, where the mockup draws a column beside the list.
  const list = page.locator('main > div').last();
  expect.soft(await styles(list, ['display', 'flex-direction', 'row-gap'])).toEqual({
    display: 'flex',
    'flex-direction': 'column',
    'row-gap': '32px',
  });

  // « Connected »: one frame, a row for each source, a rule between two rows.
  const title = page.getByRole('heading', { level: 2, name: 'Your connectors', exact: true });
  expect.soft(await styles(title, ['font-size', 'font-weight', 'margin-bottom'])).toEqual({
    'font-size': '15px',
    'font-weight': '600',
    'margin-bottom': '10px',
  });
  const frame = rows(page).first().locator('xpath=ancestor::ul');
  expect.soft(await styles(frame, ['border-top-left-radius', 'border-top-width', 'overflow-x'])).toEqual({
    'border-top-left-radius': '14px',
    'border-top-width': '1px',
    'overflow-x': 'hidden',
  });
  expect.soft(await painted(frame, 'borderTopColor')).toEqual(rgb(LINE));
  const chosen = rows(page).first();
  const resting = rows(page).nth(1);
  await expect(chosen).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('button[id^="source-row-"][aria-expanded="true"]')).toHaveCount(1);
  expect.soft(await styles(chosen, ['padding', 'column-gap', 'text-align'])).toEqual({
    padding: '14px 18px',
    'column-gap': '14px',
    'text-align': 'left',
  });
  expect.soft(await painted(chosen, 'backgroundColor')).toEqual(rgb(CHIP));
  expect.soft(await painted(resting, 'backgroundColor')).toEqual(rgb(WHITE));
  // The boxes at 1440 px. The rows take the width of the page, where the mockup draws a column for
  // the panel, and the panel opens under its row, before the next one (FRU-403).
  // The panel scrolled the screen as far as it needs: the boxes are taken from the top of the screen.
  await title.evaluate((heading) => {
    for (let at: Element | null = heading; at !== null; at = at.parentElement) at.scrollTop = 0;
    document.scrollingElement?.scrollTo(0, 0);
  });
  expectBox(await box(title), { x: 297, y: 130, height: 18 }, 2, '« Connected »');
  expectBox(await box(chosen), { x: 298, y: 159, width: ROW_WIDTH, height: 65 }, 2, 'the first row');
  expectBox(await box(panel(page)), { x: 298, y: 224, width: ROW_WIDTH }, 2, 'the panel');
  const under = await box(panel(page));
  expectBox(await box(resting), { x: 298, y: under.y + under.height, width: ROW_WIDTH }, 2, 'the second row');

  // A hover scrolls the second row into view, below the panel: the boxes are taken before it.
  await resting.hover();
  expect.soft(await painted(resting, 'backgroundColor')).toEqual(rgb(SUBTLE));
  await page.mouse.move(700, 880);

  // The mark: 34 px inside its border, a letter, or « { } » in the mono font.
  const mark = chosen.locator('span[aria-hidden="true"]');
  await expect(mark).toHaveText('L');
  expect
    .soft(await styles(mark, ['width', 'height', 'box-sizing', 'border-top-left-radius', 'font-size', 'font-weight']))
    .toEqual({
      width: '34px',
      height: '34px',
      'box-sizing': 'content-box',
      'border-top-left-radius': '8px',
      'font-size': '13px',
      'font-weight': '700',
    });
  expect.soft(await painted(mark, 'backgroundColor')).toEqual(rgb(WHITE));
  const braces = resting.locator('span[aria-hidden="true"]');
  await expect(braces).toHaveText('{ }');
  expect.soft((await styles(braces, ['font-family']))['font-family']).toContain('monospace');
  expect.soft(await styles(braces, ['font-size'])).toEqual({ 'font-size': '12px' });

  // The name, how the source is connected with the count of its sites, and its state.
  const name = chosen.getByText('Linear', { exact: true });
  expect.soft(await styles(name, ['font-size', 'font-weight'])).toEqual({ 'font-size': '15px', 'font-weight': '600' });
  const detail = chosen.getByText('Workspace Acme · 2 sites');
  expect.soft(await styles(detail, ['font-size'])).toEqual({ 'font-size': '13px' });
  expect.soft(await painted(detail, 'color')).toEqual(rgb(MUTED));
  await expect(resting.getByText('hooks.acme.dev/feedback · 1 site')).toBeVisible();
  const state = chosen.getByText('Connected', { exact: true });
  expect.soft(await styles(state, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });
  expect.soft(await painted(state, 'color')).toEqual(rgb(DONE));
  expect.soft(contrast(rgb(DONE), rgb(CHIP)), 'the green on the tint of the chosen row').toBeGreaterThanOrEqual(4.5);

  // The panel: the tint of a panel inside the frame of the list, under the rule of its row. It has
  // no card of its own, and its row shows its name: its title is said to a screen reader only.
  expect.soft(await painted(panel(page), 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await styles(panel(page), ['border-top-width'])).toEqual({ 'border-top-width': '1px' });
  expect.soft(await painted(panel(page), 'borderTopColor')).toEqual(rgb(LINE));
  const card = panel(page).locator('aside');
  expect.soft(await styles(card, ['border-top-width', 'background-color'])).toEqual({
    'border-top-width': '0px',
    'background-color': 'rgba(0, 0, 0, 0)',
  });
  const heading = card.getByRole('heading', { level: 2, name: 'Linear', exact: true });
  await expect(heading).toBeAttached();
  expect.soft(await styles(heading, ['width', 'height', 'position'])).toEqual({
    width: '1px',
    height: '1px',
    position: 'absolute',
  });
  expect.soft(await styles(heading.locator('..'), ['padding', 'border-bottom-width'])).toEqual({
    padding: '16px 22px 0px',
    'border-bottom-width': '0px',
  });
  await expect(card.getByText('Connected to the workspace Acme')).toBeVisible();
  const block = card.getByRole('heading', { level: 3, name: 'Sites sending here' });
  expect.soft(await styles(block, ['font-size', 'font-weight'])).toEqual({ 'font-size': '14px', 'font-weight': '600' });
  expect.soft(await styles(block.locator('xpath=ancestor::section[1]/..'), ['padding', 'row-gap'])).toEqual({
    padding: '20px 22px',
    'row-gap': '24px',
  });

  // The sites that send here, each with its places, read only: a site chooses them on the Sites
  // screen (FRU-399), which the block leads to.
  await expect(card.locator('[data-site]')).toHaveCount(2);
  const sender = card.locator('[data-site="staging.acme.dev"]');
  expect.soft(await styles(sender, ['padding-top', 'padding-bottom', 'border-bottom-width'])).toEqual({
    'padding-top': '8px',
    'padding-bottom': '8px',
    'border-bottom-width': '1px',
  });
  expect
    .soft(await styles(sender.getByText('https://staging.acme.dev', { exact: true }), ['font-weight']))
    .toEqual({ 'font-weight': '600' });
  await expect(card.getByRole('heading', { level: 3, name: 'Other sites' })).toHaveCount(0);
  await expect(card.locator('[data-site="support.acme.dev"]')).toHaveCount(0);
  await expect(card.getByText('Each site chooses where its notes go, on the Sites screen.')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open the sites' })).toHaveAttribute('href', '/w/w1/sites');

  // The statuses: since FRU-368 they are set per site, on its statuses page. Since FRU-478 each site
  // of « Sites sending here » links there on its own row: no second block lists the same sites again.
  await expect(
    card.getByText('The stage and the colour of each state of Linear are set for each site, on its statuses page.'),
  ).toBeVisible();
  await expect(card.getByRole('heading', { level: 3 })).toHaveText(['Sites sending here']);
  await expect(card.getByRole('link', { name: /^Statuses of / })).toHaveText(['Statuses', 'Statuses']);
  await expect(sender.getByRole('link', { name: 'Statuses of https://staging.acme.dev' })).toHaveAttribute(
    'href',
    '/w/w1/sites/s1/statuses',
  );
  await expect(
    card.locator('[data-site="acme.dev"]').getByRole('link', { name: 'Statuses of https://acme.dev' }),
  ).toHaveAttribute('href', '/w/w1/sites/s2/statuses');
  // The list of FRU-102 is gone from the panel: no state of Linear is chosen here any more.
  await expect(card.getByRole('button', { name: /^Status for / })).toHaveCount(0);

  await expect(card.getByRole('switch', { name: 'Show Linear comments as replies' })).toBeChecked();
  // Not delivered: the picture of the element (FRU-198), and the date of the last issue (FRU-237).
  await expect(card.getByText('Attach a picture of the element')).toHaveCount(0);
  await expect(card.getByText(/Last issue created/)).toHaveCount(0);

  // The foot: underlined words that disconnect, after a second question.
  const disconnect = card.getByRole('button', { name: 'Disconnect Linear', exact: true });
  expect.soft(await styles(disconnect, ['font-size', 'font-weight', 'text-decoration-line', 'padding-top'])).toEqual({
    'font-size': '14px',
    'font-weight': '600',
    'text-decoration-line': 'underline',
    'padding-top': '10px',
  });
  expect.soft(await styles(disconnect.locator('..'), ['padding', 'border-top-width'])).toEqual({
    padding: '14px 22px',
    'border-top-width': '1px',
  });

  await expectNoViolation(page, 'the list and the panel of a Linear');
});

test('an address says how many of its notes did not arrive, in a red that reads on its row', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const address = rows(page).nth(1);
  const state = address.getByText('2 notes did not arrive', { exact: true });
  await expect(state).toBeVisible();
  expect.soft(await styles(state, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });
  // At rest, the accent on white.
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT));
  expect.soft(contrast(await painted(state, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(4.5);
  // On the chosen row, the strong accent: the accent is 4.28:1 on the tint.
  await address.click();
  await expect(panel(page)).toBeVisible();
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT_STRONG));
  expect
    .soft(contrast(await painted(state, 'color'), await painted(address, 'backgroundColor')))
    .toBeGreaterThanOrEqual(4.5);
  expect(contrast(rgb(ACCENT), rgb(CHIP)), 'the control: the accent would not do').toBeLessThan(4.5);

  // The panel of the address lists them, and its sites.
  await expect(panel(page).getByRole('heading', { level: 2, name: 'REST API', exact: true })).toBeVisible();
  await expect(panel(page).getByText('Sends to hooks.acme.dev/feedback')).toBeVisible();
  await expect(panel(page).getByText('Your receiver answered 500')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Try now' })).toHaveCount(2);
  await expect(panel(page).getByRole('button', { name: 'Disconnect REST API', exact: true })).toBeVisible();
  await expectNoViolation(page, 'the panel of an address');

  // One note: the singular. No note: « Connected ».
  worker.late = LATE.slice(0, 1);
  await open(page);
  await expect(rows(page).nth(1).getByText('1 note did not arrive', { exact: true })).toBeVisible();
  worker.late = [];
  await open(page);
  await expect(rows(page).nth(1).getByText('Connected', { exact: true })).toBeVisible();
  await expect(
    rows(page)
      .nth(1)
      .getByText(/did not arrive/),
  ).toHaveCount(0);
});

test('a list of late notes that was not read is no number, and not « every note arrived »', async ({ page }) => {
  const worker = await workerWith(page);
  worker.late = undefined;
  await open(page);
  const address = rows(page).nth(1);
  // The row says only what it knows.
  await expect(address.getByText('Connected', { exact: true })).toBeVisible();
  await expect(address.getByText(/did not arrive/)).toHaveCount(0);
  await address.click();
  await expect(panel(page).getByText('Fruitback hit an error. Try again in a moment.')).toBeVisible();
  await expect(panel(page).getByText('Every note arrived.')).toHaveCount(0);
});

test('a source that its tracker refuses says so in red, on its row and in its panel', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [
    { ...LINEAR, label: 'Linear · Ana', attention: { reason: 'key-refused', since: '2026-10-10T10:00:00.000Z' } },
    ADDRESS,
  ];
  await open(page);
  const row = rows(page).first();
  const state = row.getByText('Needs attention', { exact: true });
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT));
  await expect(row.getByText('Connected', { exact: true })).toHaveCount(0);
  await row.click();
  expect.soft(await painted(state, 'color')).toEqual(rgb(ACCENT_STRONG));
  await expect(panel(page).getByRole('alert').first()).toContainText('Linear refuses this connection since');
  await expect(panel(page).getByText('Connected with the key of Ana')).toBeVisible();
});

test('with no source, and with a read that failed, the screen says which of the two it is', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [];
  await open(page);
  await expect(page.getByText('No tracker yet. The notes stay in Fruitback.')).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectNoViolation(page, 'no source');

  // A read that failed is not « no tracker »: it says so, and reads again.
  worker.down = true;
  await open(page);
  await expect(page.getByRole('alert')).toHaveText(
    'The connectors and their sites did not load. Fruitback hit an error.',
  );
  await expect(page.getByText('No tracker yet. The notes stay in Fruitback.')).toHaveCount(0);
  // Nothing to add while the list is not read: the screen does not know how this worker connects
  // Linear, by the consent at Linear or by a key.
  await expect(sources(page)).toHaveCount(0);
  worker.down = false;
  worker.connectors = [LINEAR, ADDRESS];
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The control of the count above: once read, the sources to add are there, and Linear is by consent.
  await expect(sources(page)).toHaveCount(8);
  await expect(page.getByRole('button', { name: 'Use an API key', exact: true })).toBeVisible();
});

test('« Add a connector » lists what connects, and what does not yet with a button that says when', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  const title = page.getByRole('heading', { level: 2, name: 'Add a connector', exact: true });
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '15px', 'font-weight': '600' });
  await expect(sources(page)).toHaveCount(8);
  const row = sources(page).nth(3);
  expect
    .soft(await styles(row, ['padding-top', 'padding-bottom', 'border-bottom-width', 'column-gap', 'row-gap']))
    .toEqual({
      'padding-top': '12px',
      'padding-bottom': '12px',
      'border-bottom-width': '1px',
      'column-gap': '16px',
      'row-gap': '8px',
    });
  // The sentences of the mockup.
  for (const [name, sentence] of [
    ['Jira', 'An issue in a Jira Cloud project.'],
    ['GitLab', 'An issue in a project, cloud or self-managed.'],
    ['Trello', 'A card in the list you choose.'],
    ['Notion', 'A row in a database.'],
    ['Webhook', 'Tells Slack or any address when a note arrives.'],
  ] as const) {
    const source = page.locator(`[data-source="${name}"]`);
    await expect(source.getByText(sentence, { exact: true })).toBeVisible();
    // No connector of this kind exists: nothing here connects.
    await expect(source.getByRole('button')).toHaveText('After the beta');
    await expect(source.getByRole('button')).toBeDisabled();
  }
  await expect(page.locator('[data-source="GitHub Issues"]').getByRole('button')).toBeDisabled();

  // The two that exist: a button of 40 px named after its source, as the mockup names them.
  const linear = page.getByRole('button', { name: 'Connect Linear', exact: true });
  const address = page.getByRole('button', { name: 'Connect REST API', exact: true });
  await expect(linear).toHaveText('Connect Linear');
  expect
    .soft(await styles(linear, ['height', 'padding-left', 'padding-right', 'border-top-left-radius', 'font-size']))
    .toEqual({
      height: '40px',
      'padding-left': '16px',
      'padding-right': '16px',
      'border-top-left-radius': '6px',
      'font-size': '14px',
    });
  expectBox(await box(linear), { width: 90.9, height: 40 }, 2, '« Connect »');
  // A worker with a Linear application: the key is the other way.
  await expect(page.getByRole('button', { name: 'Use an API key', exact: true })).toBeVisible();

  // An address that the worker refuses keeps what was typed.
  await address.click();
  const field = page.getByRole('textbox', { name: 'Address of your receiver' });
  worker.refuses = 'invalid-address';
  await field.fill('https://hooks.client.fr/notes');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-source="REST API"]').getByRole('alert')).toContainText(
    'Fruitback cannot send to this address.',
  );
  await expect(field).toHaveValue('https://hooks.client.fr/notes');
  await expectNoViolation(page, 'the form of an address');

  // Kept: the secret that Fruitback made is on the screen once.
  worker.refuses = undefined;
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveText('made-by-fruitback-0123456789');
  await expect(rows(page)).toHaveCount(3);
  await page.getByRole('button', { name: 'I kept it', exact: true }).click();
  await expect(page.locator('[data-secret]')).toHaveCount(0);
  await expect(page.getByText('made-by-fruitback-0123456789')).toHaveCount(0);
});

test('« Add a connector » waits for the list of the sources, and its buttons do not move under a press', async ({
  page,
}) => {
  await workerWith(page);
  // The read is held: the screen is drawn without the list, as on a slow line.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${WORKER_ORIGIN}/console/workspaces/w1/connectors`, async (route) => {
    await held;
    await route.fallback();
  });
  await open(page);
  const connect = page.getByRole('button', { name: 'Connect REST API', exact: true });
  await expect(page.getByRole('region', { name: 'Your connectors' }).getByText('Loading…')).toBeVisible();
  // Nothing to press yet: the list arrives above these buttons, and what « Connect Linear » does
  // (the consent at Linear, or a key) is said by the same read.
  await expect(sources(page)).toHaveCount(0);
  await expect(connect).toHaveCount(0);

  release();
  await expect(rows(page)).toHaveCount(2);
  await expect(sources(page)).toHaveCount(8);
  // The buttons came with the list: a press finds them where they stay.
  const before = await connect.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
  await page.mouse.down();
  await page.waitForLoadState('networkidle');
  expect(await connect.boundingBox()).toEqual(before);
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'Address of your receiver' })).toBeVisible();
});

test('a worker with no Linear application connects Linear by a key, under its row', async ({ page }) => {
  const worker = await workerWith(page);
  worker.oauth = false;
  await open(page);
  await expect(page.getByRole('button', { name: 'Use an API key', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect Linear', exact: true }).click();
  const source = page.locator('[data-source="Linear"]');
  await expect(source.getByLabel('Linear API key')).toBeVisible();
  await source.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(source.getByLabel('Linear API key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect Linear', exact: true })).toBeVisible();
});

test('a member reads the sources and changes none', async ({ page }) => {
  await workerWith(page, 'member');
  await open(page);
  await expect(page.getByText('An owner or an admin adds a connector')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Linear', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Connect REST API', exact: true })).toBeDisabled();
  await rows(page).first().click();
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Sites sending here' })).toBeVisible();
  await expect(panel(page).locator('[data-site]')).toHaveCount(2);
  // No list of the other sites, no status to set, nothing to disconnect.
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Other sites' })).toHaveCount(0);
  await expect(panel(page).getByRole('link', { name: /^Statuses of / })).toHaveCount(0);
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await expect(panel(page).getByRole('switch')).toHaveCount(0);
});

test('a link of the panel leads to the statuses of its site (FRU-368)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await rows(page).first().click();
  await panel(page).getByRole('link', { name: 'Statuses of https://staging.acme.dev' }).click();
  // A cold dev server once reloaded the page here, for a dependency it bundled late: vite.config.ts.
  await expect(page).toHaveURL(/\/w\/w1\/sites\/s1\/statuses$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Statuses');
});

test('at 390 px a long address keeps one line on its row, and its state goes under it (FRU-321)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const long = 'REST · hooks.a-very-long-subdomain-of-the-receiver.staging.acme-corporation.dev/feedback/notes';
  const worker = await workerWith(page);
  worker.connectors = [LINEAR, { ...ADDRESS, label: long }];
  await open(page);
  const address = rows(page).nth(1);
  const line = address.locator('[data-source-line]');
  // One line, cut at its end: the whole address is in the title of the line, and in the panel.
  const box = await line.boundingBox();
  // `leading-auto` computes to « normal », so one line is measured against the size of the font.
  const fontSize = await line.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
  expect(box?.height ?? 0).toBeLessThan(fontSize * 2);
  expect(await line.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(address.locator('[title]')).toHaveAttribute('title', long.replace(/^REST · /, ''));
  // The state is under the address, not in the middle of it.
  const state = address.getByText('2 notes did not arrive', { exact: true });
  expect((await state.boundingBox())?.y ?? 0).toBeGreaterThan((box?.y ?? 0) + (box?.height ?? 0) - 1);
  expect(await sideScroll(page)).toBe(0);
  // From 640 px the state is back at the end of the row.
  await page.setViewportSize({ width: 1024, height: 844 });
  const wide = await line.boundingBox();
  expect(Math.abs(((await state.boundingBox())?.y ?? 0) - (wide?.y ?? 0))).toBeLessThan(24);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing scrolls sideways, with a panel open, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await open(page);
    expect.soft(await sideScroll(page), 'the list').toBe(0);
    for (const index of [0, 1]) {
      await rows(page).nth(index).click();
      await expect(panel(page)).toBeVisible();
      await page.waitForTimeout(300);
      expect.soft(await sideScroll(page), `the panel of source ${index + 1}`).toBe(0);
      await expectNoViolation(page, `the panel of source ${index + 1} at 390 px`);
      await rows(page).nth(index).click();
    }
    await page
      .getByRole('button', { name: locale === 'en' ? 'Connect REST API' : 'Connecter API REST', exact: true })
      .click();
    expect.soft(await sideScroll(page), 'the form of an address').toBe(0);
  });
}

/**
 * FRU-404. Several sources can reach one tracker, so an owner or an admin names each one in its panel,
 * and the name is what its row shows. An empty name gives it back the name of its kind.
 */
for (const { width, height, locale, words } of [
  {
    width: 1440,
    height: 900,
    locale: 'en',
    words: {
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
      rename: 'Renommer Linear',
      field: 'Nom de ce connecteur',
      save: 'Enregistrer',
      refused: 'Un nom d’une ligne, de 80 caractères au plus.',
    },
  },
] as const) {
  test(`an owner names a source, and its row says the name, at ${width} px in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const worker = await workerWith(page, 'owner', locale);
    worker.connectors = [LINEAR, { ...LINEAR, id: 'c2', label: 'Linear · Ana' }, ADDRESS];
    await open(page);
    const row = rows(page).first();
    await row.click();

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
    await expect(row.locator('span.font-semibold').first()).toHaveText('Clients');
    expect(worker.sent.at(-1)).toEqual({ pathname: '/console/workspaces/w1/connectors/c1', body: { name: 'Clients' } });
    // The kind goes under the name, so that a name never hides what the source is.
    await expect(row.locator('[data-source-line]')).toHaveText(/^Linear · /);
    // The neighbour of the same kind keeps its own name.
    await expect(rows(page).nth(1).locator('span.font-semibold').first()).toHaveText('Linear');
    // Focus is back on « Rename », and the panel is still open.
    await expect(panel(page).getByRole('button', { name: /Clients$/ })).toBeFocused();
    expect(await sideScroll(page)).toBe(0);
    await expectNoViolation(page, `named, ${width} px`);

    // Escape in the form closes the form, not the panel.
    await panel(page)
      .getByRole('button', { name: /Clients$/ })
      .click();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();

    // An empty name gives the source back the name of its kind.
    await panel(page)
      .getByRole('button', { name: /Clients$/ })
      .click();
    await panel(page).getByRole('textbox', { name: words.field }).fill('');
    await panel(page).getByRole('button', { name: words.save, exact: true }).click();
    await expect(row.locator('span.font-semibold').first()).toHaveText('Linear');
    expect(worker.sent.at(-1)?.body).toEqual({ name: '' });
  });
}

test('« Rename » starts from the name of the last read, not the one of when the panel opened', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  // The panel of the address: « Try now » of a late note reads the list of the sources again.
  const row = rows(page).nth(1);
  await row.click();
  // Another admin names it meanwhile.
  worker.connectors = [LINEAR, { ...ADDRESS, name: 'Support' }];
  await panel(page).getByRole('button', { name: 'Try now' }).first().click();
  await expect(row.locator('span.font-semibold').first()).toHaveText('Support');
  await panel(page).getByRole('button', { name: 'Rename Support', exact: true }).click();
  await expect(panel(page).getByRole('textbox', { name: 'Name of this connector' })).toHaveValue('Support');
});

test('a member reads the name of a source, and renames none', async ({ page }) => {
  const worker = await workerWith(page, 'member');
  worker.connectors = [{ ...LINEAR, name: 'Clients' }, ADDRESS];
  await open(page);
  await expect(rows(page).first().locator('span.font-semibold').first()).toHaveText('Clients');
  await rows(page).first().click();
  await expect(panel(page).getByText('Clients', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: /^Rename/ })).toHaveCount(0);
});

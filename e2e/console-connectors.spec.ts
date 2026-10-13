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
    ['Triage', 'seeded'],
    ['Todo', 'green'],
    ['In Progress', 'ripening'],
    ['Done', 'ripe'],
    ['Canceled', 'composted'],
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
    if (pathname.endsWith('/sites')) return json({ sites: SITES });
    if (pathname.endsWith('/c1/teams'))
      return json({ teams: [{ id: 't1', name: 'Acme web', key: 'ACM', projects: [{ id: 'p1', name: 'Website' }] }] });
    if (pathname.endsWith('/c1/states')) return json({ states: STATES, settings: SETTINGS });
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

const rows = (page: Page) => page.locator('button[aria-pressed]');
const panel = (page: Page) => page.locator('#source-panel');
const sources = (page: Page) => page.getByRole('region', { name: 'Add a source' }).getByRole('listitem');

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

  // Two columns that wrap: the list takes the room, the panel 340 px inside its border.
  const columns = page.locator('main > div').last();
  expect.soft(await styles(columns, ['display', 'flex-wrap', 'column-gap', 'align-items'])).toEqual({
    display: 'flex',
    'flex-wrap': 'wrap',
    'column-gap': '28px',
    'align-items': 'flex-start',
  });
  const list = columns.locator('> div').first();
  expect.soft(await styles(list, ['flex-grow', 'flex-basis', 'row-gap'])).toEqual({
    'flex-grow': '999',
    'flex-basis': '440px',
    'row-gap': '32px',
  });

  // « Connected »: one frame, a row for each source, a rule between two rows.
  const title = page.getByRole('heading', { level: 2, name: 'Connected', exact: true });
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
  await expect(chosen).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('button[aria-pressed="true"]')).toHaveCount(1);
  expect.soft(await styles(chosen, ['padding', 'column-gap', 'text-align'])).toEqual({
    padding: '14px 18px',
    'column-gap': '14px',
    'text-align': 'left',
  });
  expect.soft(await painted(chosen, 'backgroundColor')).toEqual(rgb(CHIP));
  expect.soft(await painted(resting, 'backgroundColor')).toEqual(rgb(WHITE));
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

  // The boxes of the mockup at 1440 px.
  expectBox(await box(title), { x: 297, y: 130, height: 18 }, 2, '« Connected »');
  expectBox(await box(chosen), { x: 298, y: 159, width: 711.7, height: 65 }, 2, 'the first row');
  expectBox(await box(resting), { x: 298, y: 224, width: 711.7 }, 2, 'the second row');
  expectBox(await box(panel(page)), { x: 1038, y: 130, width: 342.3 }, 2, 'the panel');
  expectBox(
    await box(panel(page).getByRole('heading', { level: 2 })),
    { x: 1061, y: 151, height: 21 },
    2,
    'the title of the panel',
  );

  // The panel: a tinted card with a head, a body and a foot.
  const card = panel(page).locator('aside');
  expect.soft(await styles(card, ['border-top-left-radius', 'border-top-width'])).toEqual({
    'border-top-left-radius': '14px',
    'border-top-width': '1px',
  });
  expect.soft(await painted(card, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await painted(card, 'borderTopColor')).toEqual(rgb(LINE));
  const heading = card.getByRole('heading', { level: 2, name: 'Linear', exact: true });
  expect
    .soft(await styles(heading, ['font-size', 'font-weight']))
    .toEqual({ 'font-size': '18px', 'font-weight': '700' });
  expect.soft(await styles(heading.locator('..'), ['padding', 'border-bottom-width'])).toEqual({
    padding: '20px 22px',
    'border-bottom-width': '1px',
  });
  await expect(card.getByText('Connected to the workspace Acme')).toBeVisible();
  const block = card.getByRole('heading', { level: 3, name: 'Sites sending here' });
  expect.soft(await styles(block, ['font-size', 'font-weight'])).toEqual({ 'font-size': '14px', 'font-weight': '600' });
  expect.soft(await styles(block.locator('xpath=ancestor::section/..'), ['padding', 'row-gap'])).toEqual({
    padding: '20px 22px',
    'row-gap': '24px',
  });

  // The sites that send here, each with its places; then the ones that do not, to add this place.
  await expect(card.locator('[data-site]')).toHaveCount(3);
  const sender = card.locator('[data-site="staging.acme.dev"]');
  expect.soft(await styles(sender, ['padding-top', 'padding-bottom', 'border-bottom-width'])).toEqual({
    'padding-top': '8px',
    'padding-bottom': '8px',
    'border-bottom-width': '1px',
  });
  expect
    .soft(await styles(sender.getByText('staging.acme.dev', { exact: true }), ['font-weight']))
    .toEqual({ 'font-weight': '600' });
  const others = card.getByRole('heading', { level: 3, name: 'Other sites' });
  expect((await box(card.locator('[data-site="support.acme.dev"]'))).y).toBeGreaterThan((await box(others)).y);
  expect((await box(card.locator('[data-site="acme.dev"]'))).y).toBeLessThan((await box(others)).y);

  // The statuses: a state of Linear, an arrow, and a list named after the state.
  await expect(card.getByText('Which Linear state gives each pin its status.')).toBeVisible();
  const states = card.locator('[data-states] > li');
  await expect(states).toHaveCount(5);
  expect
    .soft(await styles(states.first(), ['display', 'column-gap']))
    .toEqual({ display: 'grid', 'column-gap': '8px' });
  const linear = states.first().locator('> span').first();
  await expect(linear).toHaveText('Triage');
  expect.soft(await styles(linear, ['padding', 'border-top-left-radius', 'border-top-width', 'white-space'])).toEqual({
    padding: '9px 12px',
    'border-top-left-radius': '8px',
    'border-top-width': '1px',
    'white-space': 'nowrap',
  });
  expect.soft(await painted(linear, 'backgroundColor')).toEqual(rgb(WHITE));
  for (const [index, [state, status]] of (
    [
      ['Triage', 'New'],
      ['Todo', 'To do'],
      ['In Progress', 'In progress'],
      ['Done', 'Done'],
      ['Canceled', 'Closed'],
    ] as const
  ).entries()) {
    // The status is said in words: its drop is a picture, and the amber one is 2.15:1 on white.
    const choice = states.nth(index).getByRole('button', { name: new RegExp(`Status for ${state}`) });
    await expect(choice, state).toContainText(status);
    await expect(states.nth(index).locator('.kit-drop'), state).toHaveAttribute('aria-hidden', 'true');
  }

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
  await expect(panel(page).getByText('Fruitback did not answer. Try again.')).toBeVisible();
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
    'Fruitback did not answer. The sources and their sites could not be read.',
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

test('« Add a source » lists what connects, and what does not yet with a button that says when', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const title = page.getByRole('heading', { level: 2, name: 'Add a source', exact: true });
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

test('« Add a source » waits for the list of the sources, and its buttons do not move under a press', async ({
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
  await expect(page.getByRole('region', { name: 'Connected' }).getByText('Loading…')).toBeVisible();
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
  await expect(page.getByText('An owner or an admin connects a source')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Linear', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Connect REST API', exact: true })).toBeDisabled();
  await rows(page).first().click();
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Sites sending here' })).toBeVisible();
  await expect(panel(page).locator('[data-site]')).toHaveCount(2);
  // No list of the other sites, no status to set, nothing to disconnect.
  await expect(panel(page).getByRole('heading', { level: 3, name: 'Other sites' })).toHaveCount(0);
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  await expect(panel(page).getByRole('switch')).toHaveCount(0);
});

test('a status that is chosen is sent, and the drop beside it follows', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await rows(page).first().click();
  const first = panel(page).locator('[data-states] > li').first();
  const before = await painted(first.locator('.kit-drop'), 'backgroundColor');
  await first.getByRole('button', { name: /Status for Triage/ }).click();
  await page.getByRole('option', { name: 'Done', exact: true }).click();
  await expect
    .poll(() => worker.sent.at(-1))
    .toEqual({
      pathname: '/console/workspaces/w1/connectors/c1/settings',
      body: { showComments: true, stages: { st0: 'ripe' } },
    });
  await expect(first.getByRole('button', { name: /Status for Triage/ })).toContainText('Done');
  expect(await painted(first.locator('.kit-drop'), 'backgroundColor')).toEqual(rgb(DONE));
  expect(before).not.toEqual(rgb(DONE));
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

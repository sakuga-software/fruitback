import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import {
  ACME,
  BAR_SHIFT,
  type Role,
  box,
  contrast,
  expectBox,
  fulfillSites,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';

/**
 * The Sites screen (FRU-243), measured in a browser against screen 09 of the mockup of 2026-10-13:
 * the table, the card of a workspace with no site, the alert of a read that failed, the form that
 * adds a site, and the menu of a row.
 *
 * The values are read in the code of the mockup (`09-console-sites.html`), and the boxes in its
 * render at 1440 px and at 390 px (a box is compared where the font is the one of the mockup). The
 * table has the six columns of the mockup: the notes by status, the way on the page and the last note
 * are the summary of the sites (FRU-237, FRU-270). The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const INK = '#0f172a';
const MUTED = '#5b6779';
const LINE = '#e3e8ef';
const CONTROL = '#7b8797';
const SUBTLE = '#f7f9fb';
const CHIP = '#e8edf3';
const ACCENT = '#dd2c27';
const WHITE = '#ffffff';

const LINEAR = { connector: 'c1', teamId: 't1', label: 'Linear · Acme web' };
const ADDRESS = { connector: 'c2', label: 'REST API · hooks.acme.dev/feedback' };
const MINUTE = 60_000;
/**
 * The moments are counted back from noon of a fixed day, and every test that reads a moment sets the
 * clock of the browser there: counted from the clock of the machine, « 2 h ago » read « Yesterday »
 * between midnight and two in the morning.
 */
const NOON = new Date(2026, 9, 13, 12, 0, 0);
const since = (minutes: number, from: Date = NOON) => new Date(from.getTime() - minutes * MINUTE).toISOString();
const counts = (fresh: number, todo: number, progress: number, done: number, closed: number) => ({
  new: fresh,
  todo,
  progress,
  done,
  closed,
});
/** The summary of the sites (FRU-237): the counts of the mockup, its ways on the page, its last notes. */
const SITES = [
  {
    id: 's1',
    origin: 'https://staging.acme.dev',
    visibility: 'members',
    destination: LINEAR,
    destinations: [LINEAR],
    notes: counts(3, 2, 4, 2, 1),
    via: ['script', 'extension'],
    lastNoteAt: since(125),
    undelivered: 0,
  },
  {
    id: 's2',
    origin: 'https://acme.dev',
    visibility: 'everyone',
    destination: LINEAR,
    destinations: [LINEAR, ADDRESS],
    notes: counts(6, 4, 5, 7, 1),
    via: ['script'],
    lastNoteAt: since(12),
    undelivered: 0,
  },
  {
    id: 's3',
    origin: 'https://support.acme.dev',
    visibility: 'everyone',
    destination: ADDRESS,
    destinations: [ADDRESS],
    notes: counts(2, 1, 0, 1, 0),
    via: ['script'],
    lastNoteAt: since(40),
    undelivered: 2,
  },
  {
    id: 's4',
    origin: 'https://preview.lumen.studio',
    visibility: 'members',
    notes: counts(0, 0, 0, 0, 0),
    via: [],
    undelivered: 0,
  },
];

type Sent = { method: string; pathname: string; body: unknown };
type Worker = {
  /** What the console sent that changes something. */
  sent: Sent[];
  /** How the worker answers the read of the sites. `waits` holds it until `release` is called. */
  read: 'list' | 'fails' | 'unreachable' | 'waits';
  release: () => void;
  /** What the worker answers to a site that is added, and to one that is removed. */
  refuses?: { status: number; error: string };
};

/** A workspace with the sites above, for a role. The stub keeps what the console sent. */
async function workerWith(
  page: Page,
  role: Role = 'owner',
  sites: readonly unknown[] = SITES,
  locale: 'en' | 'fr' = 'en',
): Promise<Worker> {
  let released: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    released = resolve;
  });
  const worker: Worker = { sent: [], read: 'list', release: () => released() };
  const kept = [...sites];
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const method = request.method();
    const one = /^\/console\/workspaces\/w1\/sites(?:\/(\w+))?$/.exec(pathname);
    if (one === null) return undefined;
    if (method === 'GET') {
      // A page of the grid, one site, or the whole list (FRU-497), from what the worker keeps.
      const answered = () => fulfillSites(route, kept) || route.fulfill({ json: { sites: kept } });
      if (worker.read === 'waits') return held.then(answered);
      if (worker.read === 'fails') return route.fulfill({ status: 500, json: { error: 'unknown' } });
      if (worker.read === 'unreachable') return route.abort('connectionfailed');

      return answered();
    }
    worker.sent.push({ method, pathname, body: method === 'POST' ? request.postDataJSON() : undefined });
    if (worker.refuses !== undefined)
      return route.fulfill({ status: worker.refuses.status, json: { error: worker.refuses.error } });
    if (method === 'DELETE') {
      // The worker forgets a site it removed: the grid that comes back reads it without it.
      kept.splice(
        kept.findIndex((each) => (each as { id: string }).id === one[1]),
        1,
      );

      return route.fulfill({ status: 204 });
    }
    const { url, visibility, writers } = request.postDataJSON() as {
      url: string;
      visibility: string;
      writers?: string;
    };
    // The worker keeps a site it added: the page of the site reads it in the list (FRU-433).
    const added = {
      id: `n${worker.sent.length}`,
      origin: new URL(url).origin,
      visibility,
      ...(writers === undefined ? {} : { writers }),
    };
    kept.push(added);

    return route.fulfill({ status: 201, json: added });
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toBeVisible();
}

const table = (page: Page) => page.getByRole('table', { name: 'Sites' });
/** The row of a site (FRU-688), in its `tbody`, named by its address with no scheme when the scheme is https (FRU-408). */
const row = (page: Page, name: string) =>
  table(page)
    .locator('tbody[data-site]')
    .filter({ has: page.locator('th[scope="row"]').getByRole('link', { name, exact: true }) });
/** A cell of a row: `site`, `notes`, `open`, `sent`, `who`, `last` or `menu`. */
const cell = (site: Locator, column: string) => site.locator(`[data-column="${column}"]`);
/** The links of the hosts, in the order of the rows: the link of the site in a new tab has a target. */
const hosts = (page: Page) => table(page).locator('th[scope="row"] a:not([target])');
const more = (page: Page, name: string) => page.getByRole('button', { name: `More for ${name}`, exact: true });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search sites' });

async function expectNoViolation(page: Page, name: string, within = 'main'): Promise<void> {
  // A dialog is read once it has come in: during its entrance its text is still fading in. The page
  // of a site in its preview is not the console's, and is not read.
  if (within !== 'main') await expect(page.locator('.modal__backdrop[data-entering]')).toHaveCount(0);
  if (within !== 'main') await page.waitForTimeout(300);
  const results = await new AxeBuilder({ page }).include(within).exclude('iframe').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the list is a table, one line of 36 px per site, named by its address and its icon (FRU-408, FRU-688)', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOON);
  await workerWith(page);
  await open(page);

  // The head of the screen (FRU-688): « Sites » and « Add a site » in 48 px, from the bar to the edge.
  const head = page.locator('main header');
  await expect(head.locator('h1')).toHaveText('Sites');
  expect.soft(await styles(head.locator('h1'), ['font-size', 'font-weight'])).toEqual({
    'font-size': '14px',
    'font-weight': '600',
  });
  const frame = await box(page.locator('main'));
  expectBox(await box(head), { x: frame.x, y: 0, width: frame.width, height: 48 }, 1, 'the head');
  const add = page.getByRole('button', { name: 'Add a site', exact: true });
  const drawnAdd = await box(add);
  expect.soft(drawnAdd.height, '« Add a site »').toBe(28);
  expect.soft(frame.x + frame.width - (drawnAdd.x + drawnAdd.width), 'from the right edge').toBeCloseTo(16, 0);
  // The sentence under the title went with the large title.
  await expect(page.getByText('Where Acme collects notes, and where they stand.')).toHaveCount(0);

  // The bar: the search by address, 240 px, and the colours of the statuses at the right (FRU-688).
  const field = await box(search(page));
  expectBox(field, { x: frame.x + 20, y: 48 + 8, width: 240, height: 28 }, 1, 'the search');
  await expect(search(page)).toHaveAttribute('placeholder', 'Search by address');
  const legend = page.getByRole('list', { name: 'Statuses' });
  await expect(legend.getByRole('listitem')).toHaveText(['New', 'To do', 'In progress', 'Done', 'Closed']);
  await expect(legend.locator('[data-status]')).toHaveCount(5);
  expect
    .soft((await box(legend)).y + (await box(legend)).height / 2, 'the legend is on the line of the search')
    .toBeCloseTo(field.y + field.height / 2, 0);
  // « / » gives the focus to the search.
  await page.keyboard.press('/');
  await expect(search(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('main h1').click();

  // The table: a head of 32 px, then a line of 36 px per site, from one edge of the screen to the other.
  const drawn = table(page);
  await expect(drawn.getByRole('columnheader')).toHaveText([
    'Site',
    'Notes',
    'Open',
    'Sent to',
    'Who sees the notes',
    'Last note',
    'Actions',
  ]);
  expect.soft((await box(drawn.locator('thead tr'))).height).toBe(32);
  const around = await box(drawn);
  expect.soft(around.x).toBeCloseTo(frame.x, 0);
  expect.soft(around.width).toBeCloseTo(frame.width, 0);
  const rows = drawn.locator('tbody[data-site] > tr:first-child');
  await expect(rows).toHaveCount(4);
  const heights = await rows.evaluateAll((each) => each.map((one) => one.getBoundingClientRect().height));
  expect.soft(heights).toEqual([36, 36, 36, 36]);

  // A site is its address with no « https:// » (FRU-408), in the order of the worker.
  await expect(hosts(page)).toHaveText(['staging.acme.dev', 'acme.dev', 'support.acme.dev', 'preview.lumen.studio']);
  await expect(drawn.getByText(/https?:\/\//)).toHaveCount(0);
  const first = row(page, 'staging.acme.dev');
  const name = first.getByRole('link', { name: 'staging.acme.dev', exact: true });
  expect.soft(await styles(name, ['font-weight', 'font-size'])).toEqual({ 'font-weight': '600', 'font-size': '13px' });
  expect.soft(await painted(name, 'color')).toEqual(rgb(INK));
  // Beside the address, the site itself in a new tab.
  const outside = first.getByRole('link', { name: 'Open staging.acme.dev in a new tab', exact: true });
  await expect(outside).toHaveAttribute('href', 'https://staging.acme.dev');
  await expect(outside).toHaveAttribute('target', '_blank');
  await expect(outside).toHaveAttribute('rel', 'noreferrer');

  // The icon of each site, 20 px: its favicon, asked of the site itself with no referrer, or its
  // first letter when there is none.
  for (const [site, letter] of [
    ['staging.acme.dev', 'S'],
    ['acme.dev', 'A'],
  ] as const) {
    const icon = cell(row(page, site), 'site').locator('img, span[aria-hidden="true"]').first();
    const size = await box(icon);
    expect.soft({ width: size.width, height: size.height }, `the icon of ${site}`).toEqual({ width: 20, height: 20 });
    const tag = await icon.evaluate((element) => element.tagName);
    if (tag === 'IMG') {
      await expect(icon).toHaveAttribute('src', `https://${site}/favicon.ico`);
      await expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(icon).toHaveAttribute('alt', '');
    } else await expect(icon).toHaveText(letter);
  }

  // The notes: a bar of 128 × 8 px whose name says the counts again, then how many.
  const bar = cell(first, 'notes').getByRole('img', {
    name: '12 notes: 3 new, 2 to do, 4 in progress, 2 done, 1 closed',
    exact: true,
  });
  const size = await box(bar);
  expect.soft({ width: size.width, height: size.height }).toEqual({ width: 128, height: 8 });
  // A status with no note takes no room in the bar.
  await expect(bar.locator('span')).toHaveCount(5);
  await expect(
    cell(row(page, 'support.acme.dev'), 'notes')
      .getByRole('img', { name: '4 notes: 2 new, 1 to do, 0 in progress, 1 done, 0 closed', exact: true })
      .locator('span'),
  ).toHaveCount(3);
  await expect(cell(first, 'notes')).toHaveText('12');
  const waiting = cell(row(page, 'preview.lumen.studio'), 'notes').getByText('Waiting for the first note', {
    exact: true,
  });
  await expect(waiting).toBeVisible();
  expect.soft(await painted(waiting, 'color')).toEqual(rgb(MUTED));

  // The new notes, in red after a dot, at 4.5:1; none is a dot.
  const fresh = cell(first, 'open').getByRole('link', { name: 'See the 3 new notes of staging.acme.dev' });
  await expect(fresh).toHaveText('3 new');
  expect.soft(contrast(await painted(fresh, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(4.5);
  await expect(cell(row(page, 'acme.dev'), 'open')).toHaveText('6 new');
  await expect(cell(row(page, 'preview.lumen.studio'), 'open')).toHaveText('·None yet');

  // Where the notes go, on one line after the logos of the trackers (FRU-541, FRU-688).
  await expect(cell(first, 'sent')).toHaveText('Team Acme web');
  await expect(cell(row(page, 'acme.dev'), 'sent')).toHaveText('Acme web, hooks.acme.dev/feedback');
  await expect(cell(row(page, 'acme.dev'), 'sent').locator('svg[data-mark]')).toHaveCount(2);
  const linear = cell(first, 'sent').locator('svg[data-mark="linear"]');
  await expect(linear).toHaveAttribute('viewBox', '0 0 24 24');
  expect.soft(await styles(linear, ['width', 'height'])).toEqual({ width: '14px', height: '14px' });
  // Notes an address did not take yet: the icon of a retry in red, to the notes of the site.
  const support = cell(row(page, 'support.acme.dev'), 'sent');
  await expect(support.locator('svg[data-mark="rest"]')).toHaveAttribute('viewBox', '0 0 16 16');
  const late = support.getByRole('link', { name: '2 not delivered yet: see the notes of support.acme.dev' });
  await expect(late).toHaveAttribute('href', '/w/w1/notes?site=s3');
  expect.soft(contrast(await painted(late, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(3);
  await expect(cell(first, 'sent').getByRole('link', { name: /not delivered/ })).toHaveCount(0);
  // No tracker: the drop of Fruitback, and the notes kept there.
  await expect(cell(row(page, 'preview.lumen.studio'), 'sent')).toHaveText('Kept in Fruitback');

  // Who sees the notes: an icon and the words, with no name of the workspace (FRU-583).
  await expect(cell(first, 'who')).toHaveText('Members only');
  await expect(cell(first, 'who').locator('svg[data-access="members"]')).toBeVisible();
  await expect(cell(row(page, 'support.acme.dev'), 'who')).toHaveText('Everyone who visits');
  await expect(cell(row(page, 'support.acme.dev'), 'who').locator('svg[data-access="everyone"]')).toBeVisible();

  // The last note: short to the eye, whole under the pointer and to a screen reader.
  const last = cell(first, 'last');
  await expect(last.locator('[aria-hidden="true"]')).toHaveText('2h');
  await expect(last.locator('[aria-hidden="true"]')).toHaveAttribute('title', '2 h ago');
  await expect(last.locator('.sr-only')).toHaveText('2 h ago');
  expect.soft(await painted(last.locator('[aria-hidden="true"]'), 'color')).toEqual(rgb(MUTED));
  await expect(cell(row(page, 'acme.dev'), 'last').locator('.sr-only')).toHaveText('12 min ago');
  await expect(cell(row(page, 'support.acme.dev'), 'last').locator('.sr-only')).toHaveText('40 min ago');
  // A site with no note yet: a dot for the eye, and words for a screen reader.
  const lumen = cell(row(page, 'preview.lumen.studio'), 'last');
  await expect(lumen.locator('[aria-hidden="true"]')).toHaveText('·');
  await expect(lumen.locator('.sr-only')).toHaveText('None yet');

  // The button of a row: 28 px (FRU-683), named after its site, at the right, and it opens a menu.
  const button = more(page, 'staging.acme.dev');
  const corner = await box(button);
  expect.soft({ width: corner.width, height: corner.height }).toEqual({ width: 28, height: 28 });
  expect.soft(around.x + around.width - (corner.x + corner.width), 'from the right of the table').toBeCloseTo(12, 0);
  expect.soft(await styles(button, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '6px' });
  expect.soft(await painted(button, 'color')).toEqual(rgb(MUTED));
  await expect(button).toHaveAttribute('aria-haspopup', /^(menu|true)$/);
  await button.hover();
  expect.soft(await painted(button, 'backgroundColor')).toEqual(rgb(CHIP));
  await page.mouse.move(700, 800);

  // Under the table: the sites that keep their notes in Fruitback, and the way to connect a tracker.
  const band = page.locator('main p').filter({ hasText: 'preview.lumen.studio keeps its notes in Fruitback.' });
  expect.soft(await styles(band, ['border-top-style', 'border-top-left-radius'])).toEqual({
    'border-top-style': 'dashed',
    'border-top-left-radius': '6px',
  });
  expect.soft(await painted(band, 'borderTopColor')).toEqual(rgb(LINE));
  const banded = await box(band);
  expect.soft(banded.x - frame.x, 'the band is 20 px from the edge').toBeCloseTo(20, 0);
  // FRU-571: it opens the dialog « Add a connector » of the Connectors screen (FRU-562).
  await expect(band.getByRole('link', { name: 'Connect a tracker' })).toHaveAttribute('href', '/w/w1/connectors?new=1');
  // Four sites fit on one page: no pages.
  await expect(page.getByRole('navigation', { name: 'Pages of sites' })).toHaveCount(0);

  await expectNoViolation(page, 'the list');
});

test('a press on a row opens the page of its site, and a press on a control of the row is the control’s (FRU-688)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  const acme = row(page, 'acme.dev');

  // A press in the middle of the row, on no control.
  const notes = await box(cell(acme, 'who'));
  await page.mouse.click(notes.x + notes.width / 2, notes.y + notes.height / 2);
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s2`);
  await expect(page.locator('main h1')).toHaveText('acme.dev');

  // The new notes lead to the notes, not to the page of the site.
  await page.goBack();
  await cell(acme, 'open').getByRole('link').click();
  await expect(page).toHaveURL(/\/w\/w1\/notes\?site=s2&stage=new$/);

  // The menu opens, and a press on one of its items is the item's: « See the notes ».
  await page.goBack();
  await more(page, 'acme.dev').click();
  await page.getByRole('menuitem', { name: 'See the notes' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?site=s2`);

  // A row under the pointer is tinted, and shows the pointer of a link.
  await page.goBack();
  await expect(table(page)).toBeVisible();
  const line = acme.locator('tr').first();
  await line.hover();
  expect.soft(await painted(line, 'backgroundColor')).toEqual(rgb(CHIP));
  expect.soft(await styles(line, ['cursor'])).toEqual({ cursor: 'pointer' });
});

test('who writes is a pencil with its words, a long place is cut with a tooltip, and every row is one line (FRU-566, FRU-567, FRU-688)', async ({
  page,
}) => {
  const team = 'Sakuga-software · Coeur du Périgord, the long name of a project that does not fit';
  const long = { connector: 'c1', teamId: 't9', label: `Linear · ${team}` };
  await workerWith(page, 'owner', [
    ...SITES,
    {
      id: 's5',
      origin: 'https://review.acme.dev',
      visibility: 'members',
      writers: 'anyone',
      destination: long,
      destinations: [long],
      notes: counts(16, 3, 2, 1, 0),
      via: ['extension'],
      lastNoteAt: since(5),
      undelivered: 0,
    },
  ]);
  await open(page);

  // FRU-566: « Notes from anyone on the page » is a pencil after « Members only », its words in a
  // tooltip and to a screen reader.
  const review = row(page, 'review.acme.dev');
  const writes = cell(review, 'who').getByRole('group');
  await expect(writes.locator('svg[data-access="anyone"]')).toBeVisible();
  await expect(writes.locator('.sr-only').last()).toHaveText('Notes from anyone on the page');
  await expect(cell(review, 'who').locator('svg[data-access="members"]')).toBeVisible();
  await expect(cell(row(page, 'staging.acme.dev'), 'who').locator('svg[data-access="anyone"]')).toHaveCount(0);
  const pencil = await box(writes);
  await page.mouse.move(0, 0);
  await page.mouse.move(pencil.x + pencil.width / 2, pencil.y + pencil.height / 2, { steps: 5 });
  await expect(page.getByRole('tooltip')).toHaveText('Notes from anyone on the page');
  await page.mouse.move(700, 800);
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  // FRU-567: the place is on one line, cut with « … », whole in the page for a screen reader.
  const place = cell(review, 'sent').getByText(`Team ${team}`, { exact: true });
  const cut = await place.evaluate((element) => ({
    line: parseFloat(getComputedStyle(element).lineHeight),
    height: element.getBoundingClientRect().height,
    overflow: element.scrollWidth > element.clientWidth,
    ellipsis: getComputedStyle(element).textOverflow,
  }));
  expect.soft(cut.height, 'one line').toBeLessThanOrEqual(cut.line + 1);
  expect.soft(cut.overflow, 'the name is wider than its room').toBe(true);
  expect.soft(cut.ellipsis).toBe('ellipsis');
  // The pointer on it shows the label of the worker whole. Measured: a pointer that jumps onto the
  // trigger in one move opened no tooltip here, and one that travels to it does, as a hand does.
  const trigger = cell(review, 'sent').locator('.kit-tip-trigger');
  const at = await box(trigger);
  await page.mouse.move(0, 0);
  await page.mouse.move(at.x + 8, at.y + at.height / 2, { steps: 5 });
  await expect(page.getByRole('tooltip')).toHaveText(`Linear · ${team}`);
  await page.mouse.move(700, 800);
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  // FRU-688: every row is 36 px, whatever it holds.
  const heights = await table(page)
    .locator('tbody[data-site] > tr:first-child')
    .evaluateAll((rows) => rows.map((each) => each.getBoundingClientRect().height));
  expect(heights).toEqual([36, 36, 36, 36, 36]);
  await expectNoViolation(page, 'the rows with a pencil and a cut place');
});

for (const locale of ['en', 'fr'] as const) {
  test(`who sees the notes names no workspace, and every cell is one line, in ${locale} (FRU-583, FRU-688)`, async ({
    page,
  }) => {
    const words =
      locale === 'en'
        ? { members: 'Members only', everyone: 'Everyone who visits', waiting: 'Waiting for the first note' }
        : { members: 'Membres uniquement', everyone: 'Tous les visiteurs', waiting: 'En attente de la première note' };
    await workerWith(
      page,
      'owner',
      [...SITES, { id: 's9', origin: 'https://empty.acme.dev', visibility: 'members', notes: counts(0, 0, 0, 0, 0) }],
      locale,
    );
    await open(page);

    // FRU-583: « Members only », and the name of the workspace nowhere in the table.
    await expect(table(page).getByText(/Members of|membres de/i)).toHaveCount(0);
    await expect(cell(row(page, 'staging.acme.dev'), 'who')).toHaveText(words.members);
    await expect(cell(row(page, 'support.acme.dev'), 'who')).toHaveText(words.everyone);
    await expect(cell(row(page, 'empty.acme.dev'), 'notes')).toHaveText(words.waiting);

    // FRU-688: no text of a row goes on a second line, in either language. Each piece of text alone:
    // a cell holds an icon beside its words, whose box is no line.
    const wrapped = () =>
      table(page)
        .locator('tbody[data-site] > tr:first-child')
        .evaluateAll((rows) =>
          rows.flatMap((each) => {
            const texts = document.createTreeWalker(each, NodeFilter.SHOW_TEXT);
            const found: string[] = [];
            for (let node = texts.nextNode(); node !== null; node = texts.nextNode()) {
              if ((node.textContent ?? '').trim() === '' || node.parentElement?.checkVisibility() !== true) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const tops = new Set(
                [...range.getClientRects()].filter((rect) => rect.width > 1).map((rect) => Math.round(rect.top)),
              );
              if (tops.size > 1) found.push(node.textContent ?? '');
            }

            return found;
          }),
        );
    expect(await wrapped()).toEqual([]);
    // The control: words let to wrap in a narrow box are found.
    await cell(row(page, 'staging.acme.dev'), 'who')
      .getByText(words.members)
      .evaluate((element: HTMLElement) => Object.assign(element.style, { whiteSpace: 'normal', width: '40px' }));
    expect(await wrapped()).toEqual([words.members]);
    await expectNoViolation(page, `the table in ${locale}`);
  });
}

/** A host longer than its cell, as the one Mathieu noted (FRU-585). */
const LONG_HOST = 'coeur-du-perigord-preview-branch-42.deploy.sakuga.dev';
const LONG_SITE = { ...SITES[0], id: 's7', origin: `https://${LONG_HOST}` };

/** The words of a link, cut to one line: its height, its line, whether they overflow, and its ellipsis. */
const cutOf = (link: Locator) =>
  link.evaluate((element) => ({
    lines: Math.round(element.getBoundingClientRect().height / parseFloat(getComputedStyle(element).lineHeight)),
    overflow: element.scrollWidth > element.clientWidth,
    ellipsis: getComputedStyle(element).textOverflow,
  }));

test('a long host is cut to one line, and whole in a tooltip for the pointer and the keyboard, only when cut (FRU-585)', async ({
  page,
}) => {
  await workerWith(page, 'owner', [LONG_SITE, ...SITES.slice(1)]);
  await open(page);
  const long = row(page, LONG_HOST).getByRole('link', { name: LONG_HOST, exact: true });
  const short = row(page, 'acme.dev').getByRole('link', { name: 'acme.dev', exact: true });

  // Cut on one line with « … », and whole in the page: the link is named by the whole host.
  expect.soft(await cutOf(long)).toEqual({ lines: 1, overflow: true, ellipsis: 'ellipsis' });
  expect.soft(await cutOf(short)).toEqual({ lines: 1, overflow: false, ellipsis: 'ellipsis' });

  // The pointer: a host that fits has no tooltip (the control), a cut one shows it whole.
  const hover = async (link: Locator) => {
    const at = await box(link);
    await page.mouse.move(0, 0);
    await page.mouse.move(at.x + 8, at.y + at.height / 2, { steps: 5 });
  };
  await hover(short);
  await page.waitForTimeout(700);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await hover(long);
  await expect(page.getByRole('tooltip')).toHaveText(LONG_HOST);
  await page.mouse.move(700, 880);
  await expect(page.getByRole('tooltip')).toHaveCount(0);

  // The keyboard: the link before « Open … in a new tab » takes focus, and the tooltip opens with it.
  const outside = (name: string) => page.getByRole('link', { name: `Open ${name} in a new tab`, exact: true });
  await outside('acme.dev').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(short).toBeFocused();
  await page.waitForTimeout(400);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await outside(LONG_HOST).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(long).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText(LONG_HOST);
  // Escape closes it and leaves focus where it was; the link still leads to the page of the site.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(long).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tooltip')).toHaveText(LONG_HOST);
  await expectNoViolation(page, 'a cut host with its tooltip');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/w\/w1\/sites\/s7$/);
});

test.describe('on a phone, by touch', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a long press on a cut host shows it whole and stays on the table; a tap follows the link (FRU-585)', async ({
    page,
  }) => {
    await workerWith(page, 'owner', [LONG_SITE, ...SITES.slice(1)]);
    await open(page);
    const long = row(page, LONG_HOST).getByRole('link', { name: LONG_HOST, exact: true });
    const short = row(page, 'acme.dev').getByRole('link', { name: 'acme.dev', exact: true });
    expect.soft(await cutOf(long)).toEqual({ lines: 1, overflow: true, ellipsis: 'ellipsis' });
    expect.soft(await sideScroll(page), 'the table').toBe(0);

    // A finger held on a link for 800 ms, as Chromium receives it.
    const cdp = await page.context().newCDPSession(page);
    const press = async (link: Locator, ms: number) => {
      await link.scrollIntoViewIfNeeded();
      const at = await box(link);
      const point = { x: at.x + 12, y: at.y + at.height / 2 };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(ms);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };

    // The control: a host that fits shows no tooltip under a long press. Chromium under CDP has no menu
    // of a link and follows it after the press, so the table is opened again.
    await press(short, 800);
    await page.waitForTimeout(300);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await open(page);

    await press(long, 800);
    await expect(page.getByRole('tooltip')).toHaveText(LONG_HOST);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/\/w\/w1\/sites$/);
    const tip = await box(page.getByRole('tooltip'));
    expect.soft(tip.x, 'the tooltip is inside the screen').toBeGreaterThanOrEqual(0);
    expect.soft(tip.x + tip.width, 'the tooltip is inside the screen').toBeLessThanOrEqual(390);

    // A tap elsewhere closes it; a tap on the host follows the link.
    const title = await box(page.locator('main h1'));
    await page.touchscreen.tap(title.x + 4, title.y + title.height / 2);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    const at = await box(long);
    await page.touchscreen.tap(at.x + 12, at.y + at.height / 2);
    await expect(page).toHaveURL(/\/w\/w1\/sites\/s7$/);

    await open(page);
    // Only the click that ends the long press is ignored (review of FRU-585): a click with no press
    // before it, a second after, follows the link.
    await press(long, 800);
    await expect(page.getByRole('tooltip')).toHaveText(LONG_HOST);
    await page.waitForTimeout(1200);
    await long.evaluate((element: HTMLElement) => element.click());
    await expect(page).toHaveURL(/\/w\/w1\/sites\/s7$/);
    await open(page);
    // A long press that ends with no click (the browser took it for a menu) does not swallow the next
    // gesture: Enter on the link follows it.
    await long.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
    await page.waitForTimeout(800);
    await expect(page.getByRole('tooltip')).toHaveText(LONG_HOST);
    await long.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/w\/w1\/sites\/s7$/);
  });
});

test('the new notes of a site are in their column, and lead to the notes of the site that are new (FRU-570, FRU-688)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);

  // On every row: « 3 new » on the line of the site, after its bar.
  for (const [name, count] of [
    ['staging.acme.dev', 3],
    ['acme.dev', 6],
    ['support.acme.dev', 2],
  ] as const) {
    const site = row(page, name);
    const fresh = cell(site, 'open').getByRole('link', { name: `See the ${count} new notes of ${name}`, exact: true });
    await expect(fresh).toHaveText(`${count} new`);
    const bar = await box(cell(site, 'notes').getByRole('img', { name: /notes:/ }));
    const line = await box(fresh);
    expect.soft(line.x, `the new notes of ${name} are after the bar`).toBeGreaterThan(bar.x + bar.width);
    expect
      .soft(line.y + line.height / 2, `the new notes of ${name} are on its line`)
      .toBeCloseTo(bar.y + bar.height / 2, 0);
  }
  // No new note: no link.
  await expect(row(page, 'preview.lumen.studio').getByRole('link', { name: /new notes?/ })).toHaveCount(0);

  // A press opens the Notes screen with this site and « New » chosen.
  await row(page, 'acme.dev').getByRole('link', { name: 'See the 6 new notes of acme.dev', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/w1\/notes\?site=s2&stage=new$/);
});

test('the team of a Linear leads to its page at Linear, and only an address of Linear does (FRU-574)', async ({
  page,
}) => {
  const team = {
    connector: 'c1',
    teamId: 't1',
    label: 'Linear · Acme web',
    url: 'https://linear.app/acme/team/WEB/all',
  };
  const elsewhere = { connector: 'c1', teamId: 't2', label: 'Linear · Ops', url: 'https://evil.example/team/OPS' };
  await workerWith(page, 'owner', [
    { ...SITES[0], destination: team, destinations: [team] },
    { ...SITES[1], destination: elsewhere, destinations: [elsewhere] },
    SITES[2],
  ]);
  await open(page);

  const link = cell(row(page, 'staging.acme.dev'), 'sent').getByRole('link', {
    name: 'Team Acme web, at Linear, in a new tab',
    exact: true,
  });
  await expect(link).toHaveAttribute('href', 'https://linear.app/acme/team/WEB/all');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noreferrer');
  await expect(link).toHaveText('Team Acme web');
  // An address that is not Linear's is no link, and a place with no address neither.
  await expect(cell(row(page, 'acme.dev'), 'sent').getByRole('link')).toHaveCount(0);
  await expect(cell(row(page, 'acme.dev'), 'sent')).toContainText('Team Ops');
  await expect(cell(row(page, 'support.acme.dev'), 'sent').getByRole('link', { name: /at Linear/ })).toHaveCount(0);
  await expectNoViolation(page, 'the link to the team');
});

test('the search keeps the sites whose address holds it, and a reload keeps it (FRU-408)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const names = hosts(page);

  await search(page).fill('ACME');
  await expect(names).toHaveText(['staging.acme.dev', 'acme.dev', 'support.acme.dev']);
  // The search is written in the address 300 ms after the last key, and a reload keeps it.
  await expect(page).toHaveURL(/[?&]q=ACME(&|$)/);
  await page.reload();
  await expect(search(page)).toHaveValue('ACME');
  await expect(names).toHaveText(['staging.acme.dev', 'acme.dev', 'support.acme.dev']);

  // A search that keeps nothing says so, and gives the whole list back.
  await search(page).fill('nothing here');
  await expect(page.getByText('No site matches « nothing here ».')).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expectNoViolation(page, 'a search that keeps nothing');
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await expect(names).toHaveCount(4);
  await expect(search(page)).toHaveValue('');
  await expect(page).not.toHaveURL(/[?&]q=/);
});

test('the sites come 25 to a page, and a search or a new site shows its page (FRU-408, FRU-688)', async ({ page }) => {
  const many = Array.from({ length: 60 }, (_, index) => ({
    id: `m${index + 1}`,
    origin: `https://site-${index + 1}.acme.dev`,
    visibility: 'members',
    notes: counts(0, 0, 0, 0, 0),
    via: [],
    undelivered: 0,
  }));
  await workerWith(page, 'owner', many);
  await open(page);
  const rows = hosts(page);
  const pages = page.getByRole('navigation', { name: 'Pages of sites' });
  const previous = pages.getByRole('button', { name: 'Previous' });
  const next = pages.getByRole('button', { name: 'Next' });

  await expect(rows).toHaveCount(25);
  await expect(pages).toContainText('1 to 25 of 60');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(pages).toContainText('26 to 50 of 60');
  await expect(rows.first()).toHaveText('site-26.acme.dev');
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  // The page lives in the address: a reload keeps it.
  await page.reload();
  await expect(pages).toContainText('26 to 50 of 60');
  await next.click();
  await expect(pages).toContainText('51 to 60 of 60');
  await expect(rows).toHaveCount(10);
  await expect(next).toBeDisabled();
  await expectNoViolation(page, 'the last page');

  // A page past the last one shows the last one.
  await page.goto(`${CONSOLE}/w/w1/sites?page=9`);
  await expect(pages).toContainText('51 to 60 of 60');

  // A search goes back to the first page, and its 11 sites need no pages.
  await search(page).fill('site-1');
  await expect(rows).toHaveCount(11);
  await expect(pages).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]page=/);

  // A new site opens its own page, at its installation (FRU-433); back on the table, it is the last one.
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await page.getByRole('textbox', { name: 'Site address' }).fill('new.acme.dev');
  await page.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/n1#install`);
  await expect(page.getByRole('region', { name: 'Install on new.acme.dev' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sites' }).click();
  await expect(search(page)).toHaveValue('');
  // Each page is drawn before the next press: « Next » reads the page it was drawn on, so a second
  // press before the first page is drawn turns to the same page again (CI, run 40136362608).
  await expect(pages).toContainText('1 to 25 of 61');
  await pages.getByRole('button', { name: 'Next' }).click();
  await expect(pages).toContainText('26 to 50 of 61');
  await pages.getByRole('button', { name: 'Next' }).click();
  await expect(pages).toContainText('51 to 61 of 61');
  await expect(row(page, 'new.acme.dev')).toBeVisible();
});

test('a site keeps its scheme only where the address alone would read another one (FRU-408)', async ({ page }) => {
  await workerWith(page, 'owner', [
    { id: 'h1', origin: 'http://acme.dev', visibility: 'members' },
    { id: 'h2', origin: 'http://localhost:3000', visibility: 'members' },
    { id: 'h3', origin: 'https://localhost:3000', visibility: 'members' },
  ]);
  await open(page);
  // A local host is http when typed alone, and every other host https (FRU-314): the other scheme is
  // said, so two sites that differ by their scheme alone read as two.
  await expect(hosts(page)).toHaveText(['http://acme.dev', 'localhost:3000', 'https://localhost:3000']);
  // A site on http gets its letter: the policy of the console loads images over https only.
  await expect(row(page, 'localhost:3000').locator('img')).toHaveCount(0);
  await expect(cell(row(page, 'localhost:3000'), 'site').locator('span[aria-hidden="true"]').first()).toHaveText('L');
});

test('the last note is counted in hours for a whole day, across midnight, then by the calendar', async ({ page }) => {
  // Half past midnight: a note of 22:30 is « 2 h ago », not « Yesterday »; one of midnight the day
  // before is « Yesterday »; one of 23:30 two days before is « 2 days ago ».
  const halfPastMidnight = new Date(2026, 9, 13, 0, 30, 0);
  await page.clock.setFixedTime(halfPastMidnight);
  const at = (minutes: number) => since(minutes, halfPastMidnight);
  await workerWith(page, 'owner', [
    { ...SITES[0], lastNoteAt: at(120) },
    { ...SITES[1], lastNoteAt: at(24 * 60 + 30) },
    { ...SITES[2], lastNoteAt: at(25 * 60) },
  ]);
  await open(page);
  // Short to the eye (FRU-688), whole to a screen reader and under the pointer.
  for (const [site, short, whole] of [
    ['staging.acme.dev', '2h', '2 h ago'],
    ['acme.dev', '1d', 'Yesterday'],
    ['support.acme.dev', '1d', '2 days ago'],
  ] as const) {
    await expect(cell(row(page, site), 'last').locator('[aria-hidden="true"]')).toHaveText(short);
    await expect(cell(row(page, site), 'last').locator('.sr-only')).toHaveText(whole);
  }
});

test('a workspace with no site shows the card of the mockup, and its form adds the first site', async ({ page }) => {
  const worker = await workerWith(page, 'owner', []);
  await open(page);

  const empty = page.locator('main > div').filter({ hasText: 'No site yet' });
  expect
    .soft(
      await styles(empty, [
        'padding-top',
        'padding-left',
        'border-top-left-radius',
        'row-gap',
        'max-width',
        'box-sizing',
      ]),
    )
    .toEqual({
      'padding-top': '48px',
      // clamp(20px, 5vw, 56px) at 1440 px.
      'padding-left': '56px',
      'border-top-left-radius': '8px',
      'row-gap': '14px',
      'max-width': '640px',
      'box-sizing': 'content-box',
    });
  expect.soft(await painted(empty, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await painted(empty, 'borderTopColor')).toEqual(rgb(LINE));
  expectBox(await box(empty), { x: 297 + BAR_SHIFT, y: 72, width: 754 }, 2, 'the card');

  const drop = empty.locator('svg').first();
  expectBox(await box(drop), { x: 354 + BAR_SHIFT, y: 121, width: 40, height: 48 }, 2, 'the drop');
  expect.soft(await painted(drop, 'fill')).toEqual(rgb(ACCENT));
  const title = empty.getByRole('heading', { level: 2, name: 'No site yet' });
  expectBox(await box(title), { x: 354 + BAR_SHIFT, y: 183, height: 26 }, 2, 'the title of the card');
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '20px', 'font-weight': '700' });
  const text = empty.getByText(
    "Paste the address of a site you review. Staging, a preview build or a client's live site: any page of it will do.",
  );
  expect
    .soft(await styles(text, ['font-size', 'line-height']))
    .toEqual({ 'font-size': '13px', 'line-height': '20.15px' });
  expect.soft(await painted(text, 'color')).toEqual(rgb(MUTED));

  const field = empty.getByRole('textbox', { name: 'Site address' });
  await expect(field).toHaveAttribute('placeholder', 'staging.acme.dev');
  expectBox(await box(field), { x: 354 + BAR_SHIFT, y: 305.3, width: 535.2, height: 32 }, 2, 'the field');
  const submit = empty.getByRole('button', { name: 'Add site', exact: true });
  expectBox(await box(submit), { x: 898.7 + BAR_SHIFT, y: 305.3, width: 94.8, height: 32 }, 2, '« Add site »');
  // The head has no « Add a site »: the card is the way to add one.
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(table(page)).toHaveCount(0);
  await expectNoViolation(page, 'the card');

  // Who sees the notes is chosen here too: no route changes it after.
  const who = empty.getByRole('radiogroup', { name: 'Who sees the notes?' });
  await expect(who.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await who.getByText('Everyone who visits').click();
  await field.fill('acme.dev');
  await submit.click();
  await expect
    .poll(() => worker.sent)
    .toEqual([
      {
        method: 'POST',
        pathname: '/console/workspaces/w1/sites',
        body: { url: 'https://acme.dev', visibility: 'everyone' },
      },
    ]);
  // The site opens its page, at how to put Fruitback on it (FRU-433).
  await expect(page.getByRole('region', { name: 'Install on acme.dev' })).toBeVisible();
  await expect(page.locator('main h1')).toHaveText('acme.dev');
  await expect(empty).toHaveCount(0);
});

// FRU-516: « Fruitback did not answer » was said for a 500 too. A read with no answer at all asks to
// check the connection, and one answered with an error does not.
test('a read with no answer asks to check the connection, and an error answered says so', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'unreachable';
  await open(page);
  const card = page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'The sites did not load' }) });
  await expect(
    card.getByText('Fruitback could not be reached. Check your connection. Your sites and notes are safe.'),
  ).toBeVisible();

  worker.read = 'fails';
  await card.getByRole('button', { name: 'Try again' }).click();
  await expect(card.getByText('Fruitback hit an error. Your sites and notes are safe.')).toBeVisible();
  await expect(card).not.toContainText('connection');
});

test('a read that failed is the alert of the mockup, and never « No site yet » (FRU-162)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'fails';
  await open(page);

  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { level: 2, name: 'The sites did not load' })).toBeVisible();
  await expect(alert.getByText('Fruitback hit an error. Your sites and notes are safe.')).toBeVisible();
  expect
    .soft(
      await styles(alert, ['padding-top', 'padding-left', 'border-top-left-radius', 'border-top-width', 'max-width']),
    )
    .toEqual({
      'padding-top': '28px',
      'padding-left': '32px',
      'border-top-left-radius': '8px',
      'border-top-width': '1px',
      'max-width': '760px',
    });
  expect.soft(await painted(alert, 'borderTopColor')).toEqual(rgb(CONTROL));
  expectBox(await box(alert), { x: 297 + BAR_SHIFT, y: 72, width: 826, height: 98.5 }, 2, 'the alert');
  const title = alert.getByRole('heading', { level: 2 });
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '14px', 'font-weight': '600' });
  expectBox(await box(title), { x: 330 + BAR_SHIFT, y: 101, height: 17 }, 2, 'the title of the alert');
  const again = alert.getByRole('button', { name: 'Try again', exact: true });
  expectBox(await box(again), { x: 993 + BAR_SHIFT, y: 105.2, width: 96.6, height: 32 }, 2, '« Try again »');
  expect.soft(await styles(again, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '6px' });

  // Neither the card of a workspace with no site, nor a way to add one on a list nobody read.
  await expect(page.getByText('No site yet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(table(page)).toHaveCount(0);
  await expectNoViolation(page, 'the alert');

  // « Try again » reads again, and the list is there.
  worker.read = 'list';
  await again.click();
  await expect(row(page, 'staging.acme.dev')).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('the control of « never No site yet »: an answer with no site does show the card', async ({ page }) => {
  await workerWith(page, 'owner', []);
  await open(page);
  await expect(page.getByText('No site yet')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('while the sites are read, the screen says so and shows neither state', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'waits';
  await open(page);
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  await expect(page.getByText('No site yet')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
});

test('the counts come with the list: nothing that a pointer can reach moves when the list arrives', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.read = 'waits';
  await open(page);
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  const reachable = [
    page.getByRole('link', { name: 'Connectors', exact: true }),
    page.getByRole('link', { name: 'Settings', exact: true }),
    page.locator('main h1'),
  ];
  const before = await Promise.all(reachable.map(box));

  worker.release();
  // The rows and their counts are drawn in the same paint: when the table is there, so are the bars.
  await page.waitForFunction(() => document.querySelector('main table[aria-label="Sites"]') !== null);
  expect(await table(page).getByRole('img').count()).toBe(3);
  const button = more(page, 'support.acme.dev');
  const first = await box(button);
  await expect(row(page, 'support.acme.dev').getByRole('img', { name: /^4 notes/ })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await box(button)).toEqual(first);
  expect(await Promise.all(reachable.map(box))).toEqual(before);
  expectBox(
    await box(page.getByRole('button', { name: 'Add a site', exact: true })),
    // In the head of 48 px (FRU-688), 16 px from the right edge of the screen.
    { x: 1440 - 16 - (await box(page.getByRole('button', { name: 'Add a site', exact: true }))).width, y: 10 },
    2,
    '« Add a site »',
  );
});

test('« Add a site » opens a dialog, Escape closes it, and a refusal keeps what was typed (FRU-558)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  const opener = page.getByRole('button', { name: 'Add a site', exact: true });
  await opener.click();

  // A dialog named by its title, with focus in its field; Escape closes it, and focus goes back.
  const form = page.getByRole('dialog', { name: 'Add a site' });
  await expect(form).toBeVisible();
  const field = form.getByRole('textbox', { name: 'Site address' });
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toHaveCount(0);
  await expect(opener).toBeFocused();
  await opener.click();
  await expect(field).toBeFocused();
  // A press outside does not close it: the form and its refusal stay (raised in review).
  await page.mouse.click(20, 880);
  await expect(form).toBeVisible();
  await field.focus();
  // Tab never leaves the dialog: the page under it is out of reach.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    expect(await form.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  const submit = form.getByRole('button', { name: 'Add site', exact: true });
  await expect(form.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await expectNoViolation(page, 'the form', '[role="dialog"]');

  // What is not an address: the sentence of the console, nothing sent, the field as it was.
  await field.fill('not an address');
  await submit.click();
  await expect(form.getByRole('alert')).toHaveText('Paste the full address of the site, starting with https://.');
  await expect(field).toHaveValue('not an address');
  expect(worker.sent).toEqual([]);

  // What the worker refuses: its own sentence, and the field as it was.
  worker.refuses = { status: 403, error: 'forbidden' };
  await field.fill('docs.acme.dev');
  await submit.click();
  await expect(form.getByRole('alert')).toHaveText('Only an owner or an admin of the workspace adds a site.');
  await expect(field).toHaveValue('docs.acme.dev');
  await expect(row(page, 'docs.acme.dev')).toHaveCount(0);

  // « Cancel » closes the form and sends nothing more.
  const before = worker.sent.length;
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(worker.sent.length).toBe(before);

  // Added: the page of the site opens, at how to put Fruitback on it (FRU-433).
  worker.refuses = undefined;
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await form.getByRole('textbox', { name: 'Site address' }).fill('docs.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Install on docs.acme.dev' })).toBeVisible();
  await expect(page.getByText('Members of Acme', { exact: true })).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(worker.sent.at(-1)).toEqual({
    method: 'POST',
    pathname: '/console/workspaces/w1/sites',
    body: { url: 'https://docs.acme.dev', visibility: 'members', writers: 'members' },
  });
});

test('the dialog shows the icon and the page of the typed site, once it is an address (FRU-558)', async ({ page }) => {
  await workerWith(page);
  // The site, as its own server would answer the browser of the person: the console asks nothing.
  await page.route('https://docs.acme.dev/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Docs</title><h1>Acme docs</h1>' }),
  );
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add a site' });
  const field = form.getByRole('textbox', { name: 'Site address' });

  // One word names no site: nothing is asked.
  await field.fill('docs');
  await page.waitForTimeout(900);
  await expect(form.getByRole('region', { name: /^Preview of/ })).toHaveCount(0);

  await field.fill('docs.acme.dev');
  const preview = form.getByRole('region', { name: 'Preview of docs.acme.dev' });
  await expect(preview).toBeVisible();
  // Its icon: the image of the site, or its letter when none loads (no route sees /favicon.ico).
  await expect(preview.locator('.add-site-dialog__icon').first()).toBeVisible();
  const frame = preview.frameLocator('iframe[title="docs.acme.dev, live"]');
  await expect(frame.getByRole('heading', { name: 'Acme docs' })).toBeVisible();
  await expect(preview.locator('iframe')).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expectNoViolation(page, 'the dialog with its preview', '[role="dialog"]');

  // An address that is no longer one hides the preview at once, not after the pause of 600 ms.
  await field.fill('docs');
  await expect(form.getByRole('region', { name: /^Preview of/ })).toHaveCount(0, { timeout: 300 });
});

test('« Who can leave a note? » is asked for a site that its members read, « Members only » first (FRU-330)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add a site' });
  const writers = form.getByRole('radiogroup', { name: 'Who can leave a note?' });

  // A new site is « Members only », and the detail says what private mode needs.
  await expect(writers.getByRole('radio', { name: 'Members only' })).toBeChecked();
  await expect(writers).toContainText('In private mode the extension holds no session');
  await expect(writers).toContainText(/«\sAnyone on the page\s»/);
  await expectNoViolation(page, 'the form with « Who can leave a note? »', '[role="dialog"]');

  // A site that everyone reads takes a note from anybody: the question is not asked, nor sent.
  await form.getByText('Everyone who visits', { exact: true }).click();
  await expect(writers).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Site address' }).fill('help.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('help.acme.dev');
  expect(worker.sent.at(-1)?.body).toEqual({ url: 'https://help.acme.dev', visibility: 'everyone' });
  const back = () => page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sites' }).click();
  await back();
  await expect(row(page, 'help.acme.dev')).toBeVisible();
  await expect(row(page, 'help.acme.dev').getByText(/Notes from/)).toHaveCount(0);

  // « Anyone on the page », chosen, is sent and said on the row.
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await expect(form.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await writers.getByText('Anyone on the page', { exact: true }).click();
  await expect(writers.getByRole('radio', { name: 'Anyone on the page' })).toBeChecked();
  await form.getByRole('textbox', { name: 'Site address' }).fill('review.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('review.acme.dev');
  await back();
  await expect(cell(row(page, 'review.acme.dev'), 'who').getByText('Notes from anyone on the page')).toHaveCount(1);
  expect(worker.sent.at(-1)?.body).toEqual({
    url: 'https://review.acme.dev',
    visibility: 'members',
    writers: 'anyone',
  });

  // The next form starts from « Members only » again.
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await expect(writers.getByRole('radio', { name: 'Members only' })).toBeChecked();
});

test('a press anywhere on a choice of the form chooses it, its detail and its corner too (FRU-569)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add a site' });
  const everyone = form.getByRole('radio', { name: 'Everyone who visits' });
  const members = form.getByRole('radio', { name: /Members of Acme/ });
  await expect(members).toBeChecked();

  // The detail under the label: HeroUI made only the row of the radio a label.
  await form.getByText('A public way to report a problem on a live site.', { exact: true }).click();
  await expect(everyone).toBeChecked();

  // The bottom right corner of the other card, in its padding, far from the radio and its words.
  const card = form.locator('.kit-pick__card').filter({ has: page.getByRole('radio', { name: /Members of Acme/ }) });
  const frame = await card.boundingBox();
  if (frame === null) throw new Error('the card of « Members of Acme » has no box');
  await page.mouse.click(frame.x + frame.width - 6, frame.y + frame.height - 6);
  await expect(members).toBeChecked();

  // The keyboard still walks the choices, and the detail is still the description of its radio.
  await members.focus();
  await page.keyboard.press('ArrowDown');
  await expect(everyone).toBeChecked();
  await expect(everyone).toHaveAccessibleDescription('A public way to report a problem on a live site.');
  // The detail is in the label now: it must not join the name of the radio.
  await expect(everyone).toHaveAccessibleName('Everyone who visits');
  // The detail is `aria-hidden` and referenced by `aria-describedby`. What Chromium gives a screen
  // reader, read in its own accessibility tree and not computed by Playwright: the name without the
  // detail, and the detail as the description (raised in review).
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Accessibility.enable');
  const { nodes } = (await cdp.send('Accessibility.getFullAXTree')) as {
    nodes: { role?: { value?: string }; name?: { value?: string }; description?: { value?: string } }[];
  };
  const radios = nodes
    .filter((node) => node.role?.value === 'radio')
    .map((node) => ({ name: node.name?.value, description: node.description?.value }));
  expect(radios).toContainEqual({
    name: 'Everyone who visits',
    description: 'A public way to report a problem on a live site.',
  });
});

test('the menu of a row is walked with the keyboard, and leads to the page of the site (FRU-433)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const button = more(page, 'staging.acme.dev');

  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More for staging.acme.dev' });
  // « Open its page » is the page of the site; « See the notes » the Notes screen with the site chosen
  // (FRU-504); « Statuses » the page of its statuses (FRU-371).
  await expect(menu.getByRole('menuitem')).toHaveText(['Open its page', 'See the notes', 'Statuses', 'Remove']);
  await expect(menu.getByRole('menuitem', { name: 'Open its page' })).toBeFocused();
  await page.waitForTimeout(250);
  const opened = await new AxeBuilder({ page }).include('.kit-menu').analyze();
  expect
    .soft(opened.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  // « See the notes »: the Notes screen, with this site chosen.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?site=s1`);

  // « Open its page » is the page of the site, and the name of the row a link to it.
  await page.goBack();
  await button.click();
  await menu.getByRole('menuitem', { name: 'Open its page' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1`);
  await expect(table(page)).toHaveCount(0);
  await page.goBack();
  await row(page, 'acme.dev').getByRole('link', { name: 'acme.dev', exact: true }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s2`);
  await expect(page.locator('main h1')).toHaveText('acme.dev');
});

test('what is typed in the form stays when the form goes and comes back', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add a site' });
  await form.getByRole('textbox', { name: 'Site address' }).fill('docs.acme.dev');
  await form.getByText('Everyone who visits').click();
  // « Cancel » closes the form. What was typed is not thrown away: the form shows it again.
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Site address' })).toHaveValue('docs.acme.dev');
  await expect(form.getByRole('radio', { name: /Everyone who visits/ })).toBeChecked();
});

test('a tracker that this build does not know has its name and no mark, even a key of every object (FRU-541)', async ({
  page,
}) => {
  await workerWith(page, 'owner', [
    {
      id: 's1',
      origin: 'https://staging.acme.dev',
      visibility: 'members',
      destination: { connector: 'c1', label: 'constructor · Board' },
    },
    {
      id: 's2',
      origin: 'https://acme.dev',
      visibility: 'members',
      destination: { connector: 'c2', label: 'Jira · Web' },
    },
  ]);
  await open(page);
  for (const [site, words] of [
    ['staging.acme.dev', 'constructor · Board'],
    ['acme.dev', 'Jira · Web'],
  ] as const) {
    await expect(cell(row(page, site), 'sent')).toHaveText(words);
    await expect(cell(row(page, site), 'sent').locator('svg')).toHaveCount(0);
  }
});

test('a destination with no words of the worker reads as a tracker, and not as nothing', async ({ page }) => {
  // A worker of before FRU-123 writes no label on a destination.
  await workerWith(page, 'owner', [
    {
      id: 's1',
      origin: 'https://staging.acme.dev',
      visibility: 'members',
      destination: { connector: 'c1', teamId: 't1' },
    },
  ]);
  await open(page);
  await expect(cell(row(page, 'staging.acme.dev'), 'sent')).toHaveText('A tracker');
  // Nor does it send the summary of the sites: the row says that nothing is known, and draws no bar.
  for (const column of ['notes', 'open', 'last'])
    await expect(cell(row(page, 'staging.acme.dev'), column)).toHaveText('·None yet');
  await expect(row(page, 'staging.acme.dev').getByRole('img')).toHaveCount(0);
});

test('removing a site asks twice, and the table it comes back to has focus on its search', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);

  // « Remove » of the menu is the first time; the page of the site asks the second (FRU-433).
  await more(page, 'staging.acme.dev').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1#remove`);
  const group = page.getByRole('group', { name: 'Remove staging.acme.dev' });
  await expect(group.getByText(/The widget stops on staging\.acme\.dev,/)).toBeVisible();
  await expect(group.getByRole('button', { name: 'Keep it' })).toBeFocused();
  expect(worker.sent).toEqual([]);
  await expectNoViolation(page, 'the second time of a removal');
  await group.getByRole('button', { name: 'Keep it' }).click();
  await expect(group).toHaveCount(0);
  const ask = page
    .getByRole('region', { name: 'Remove this site' })
    .getByRole('button', { name: 'Remove', exact: true });
  await expect(ask).toBeFocused();

  // The worker refuses: the site stays, and the page says why.
  worker.refuses = { status: 403, error: 'forbidden' };
  await ask.click();
  await group.getByRole('button', { name: 'Remove staging.acme.dev' }).click();
  await expect(page.getByRole('alert')).toHaveText('Only an owner or an admin of the workspace removes a site.');
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');

  worker.refuses = undefined;
  await group.getByRole('button', { name: 'Remove staging.acme.dev' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(row(page, 'staging.acme.dev')).toHaveCount(0);
  await expect(row(page, 'acme.dev')).toBeVisible();
  // Its row and its button are gone: focus is on the search, and not back at the top of the page.
  await expect(search(page)).toBeFocused();
  expect(worker.sent.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
    'DELETE /console/workspaces/w1/sites/s1',
    'DELETE /console/workspaces/w1/sites/s1',
  ]);
});

test('when the last site is removed, focus goes to the field of the card', async ({ page }) => {
  await workerWith(page, 'owner', [SITES[3]]);
  await open(page);
  await more(page, 'preview.lumen.studio').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('button', { name: 'Remove preview.lumen.studio' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'No site yet' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Site address' })).toBeFocused();
});

test('a member installs and changes nothing; a guest does not read where the notes go', async ({ page }) => {
  await workerWith(page, 'member');
  await open(page);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(table(page).getByRole('columnheader', { name: 'Sent to' })).toHaveCount(1);
  await expect(cell(row(page, 'staging.acme.dev'), 'sent')).toHaveText('Team Acme web');
  await more(page, 'staging.acme.dev').click();
  await expect(page.getByRole('menuitem')).toHaveText(['Open its page', 'See the notes']);
  await page.keyboard.press('Escape');

  // The worker sends a guest no destination, and a row says nothing of one.
  await page.unrouteAll();
  await workerWith(
    page,
    'guest',
    SITES.map(({ id, origin, visibility, notes, via, lastNoteAt }) => ({
      id,
      origin,
      visibility,
      notes,
      via,
      lastNoteAt,
    })),
  );
  await open(page);
  // The notes of the sites shared with a guest are theirs to count; where they go is not: a guest
  // has no column « Sent to », and no band under the table.
  await expect(table(page).getByRole('columnheader')).toHaveText([
    'Site',
    'Notes',
    'Open',
    'Who sees the notes',
    'Last note',
    'Actions',
  ]);
  await expect(cell(row(page, 'staging.acme.dev'), 'sent')).toHaveCount(0);
  await expect(row(page, 'staging.acme.dev').getByRole('img', { name: /^12 notes/ })).toBeVisible();
  await expect(page.getByText('Kept in Fruitback')).toHaveCount(0);
  await expect(page.getByText(/keeps? (its|their) notes in Fruitback/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);

  // With no site, somebody who cannot add one reads who can, and gets no form.
  await page.unrouteAll();
  await workerWith(page, 'member', []);
  await open(page);
  await expect(page.getByText('An owner or an admin of Acme adds its first site.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing scrolls sideways, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const worker = await workerWith(page, 'owner', SITES, locale);
    await open(page);
    const words = locale === 'en' ? { add: 'Add a site' } : { add: 'Ajouter un site' };
    expect.soft(await sideScroll(page), 'the list').toBe(0);
    // FRU-688: the table is as wide as the screen, and keeps the site, its new notes and its menu.
    expect.soft((await box(table(page))).width).toBeCloseTo(390, 0);
    const shown = await table(page)
      .locator('thead th')
      .evaluateAll((heads) => heads.filter((head) => head.getBoundingClientRect().width > 0).length);
    expect.soft(shown, 'the columns at 390 px').toBe(3);
    const first = row(page, 'staging.acme.dev');
    for (const column of ['site', 'open', 'menu']) await expect(cell(first, column).locator('> *')).toBeVisible();
    for (const column of ['notes', 'sent', 'who', 'last'])
      await expect(cell(first, column).locator('> *')).toBeHidden();
    const heights = await table(page)
      .locator('tbody[data-site] > tr:first-child')
      .evaluateAll((rows) => rows.map((each) => each.getBoundingClientRect().height));
    expect.soft(heights).toEqual([36, 36, 36, 36]);
    await expectNoViolation(page, `the table at 390 px in ${locale}`);

    await page.getByRole('button', { name: words.add, exact: true }).click();
    expect.soft(await sideScroll(page), 'the form').toBe(0);

    worker.read = 'fails';
    await open(page);
    await expect(page.getByRole('alert')).toBeVisible();
    expect.soft(await sideScroll(page), 'the alert').toBe(0);
  });
}

test('at 390 px the card and the alert are where the mockup draws them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page, 'owner', []);
  await open(page);
  // The render of the mockup at 390 px. Its rail takes the rest of a short window (175 px here), which
  // the frame does not copy: the boxes are compared from the top of the screen under the rail.
  const top = (await box(page.locator('main'))).y;
  const empty = page.locator('main > div').filter({ hasText: 'No site yet' });
  expectBox(await box(empty), { x: 16, y: top + 72, width: 358 }, 4, 'the card');
  expectBox(await box(empty.locator('svg').first()), { x: 37, y: top + 121, width: 40, height: 48 }, 4, 'the drop');
  expectBox(await box(empty.getByRole('heading', { level: 2 })), { x: 37, y: top + 183, height: 26 }, 4, 'the title');
  expectBox(
    await box(empty.getByRole('textbox', { name: 'Site address' })),
    { x: 37, y: top + 325.4, width: 316, height: 32 },
    4,
    'the field',
  );
  expectBox(
    await box(empty.getByRole('button', { name: 'Add site' })),
    { x: 37, y: top + 367.4, width: 94.8, height: 32 },
    4,
    '« Add site »',
  );
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'the card at 390 px');

  await page.unrouteAll();
  const worker = await workerWith(page);
  worker.read = 'fails';
  await open(page);
  const alert = page.getByRole('alert');
  const under = (await box(page.locator('main'))).y;
  expectBox(await box(alert), { x: 16, y: under + 72, width: 358, height: 166 }, 4, 'the alert');
  expectBox(
    await box(alert.getByRole('heading', { level: 2 })),
    { x: 49, y: under + 101, height: 20 },
    4,
    'the title of the alert',
  );
  expectBox(
    await box(alert.getByRole('button', { name: 'Try again' })),
    { x: 49, y: under + 177, width: 100.1, height: 32 },
    4,
    '« Try again »',
  );
});

test('every text of the list is at 4.5:1 on what is behind it', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const first = row(page, 'staging.acme.dev');
  const texts: [string, Locator][] = [
    ['the last note', cell(first, 'last')],
    ['an address', first.getByRole('link', { name: 'staging.acme.dev', exact: true })],
    ['how many notes', cell(first, 'notes').getByText('12', { exact: true })],
    ['the new notes', cell(first, 'open').getByRole('link')],
    ['who sees the notes', first.getByText('Members only', { exact: true })],
    ['a place in a tracker', first.getByText('Team Acme web', { exact: true })],
    ['a head of a column', table(page).getByRole('columnheader', { name: 'Sent to' })],
    ['a status of the legend', page.getByRole('list', { name: 'Statuses' }).getByText('Closed')],
  ];
  // White, and the tint of a row under the pointer (FRU-688).
  for (const behind of [WHITE, CHIP]) {
    for (const [name, text] of texts) {
      expect
        .soft(contrast(await painted(text, 'color'), rgb(behind)), `${name} on ${behind}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  }
  // The button of a row is a picture: 3:1 on the row, and on its own tint under the pointer.
  const button = more(page, 'staging.acme.dev');
  expect.soft(contrast(await painted(button, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(3);
  expect.soft(contrast(await painted(button, 'color'), rgb(CHIP))).toBeGreaterThanOrEqual(3);
});

import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
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

const INK = '#18181b';
const MUTED = '#6b6b74';
const LINE = '#e4e4e7';
const CONTROL = '#8a8a93';
const SUBTLE = '#fafafa';
const CHIP = '#f4f4f5';
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
  read: 'list' | 'fails' | 'waits';
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
      if (worker.read === 'waits') return held.then(() => route.fulfill({ json: { sites: kept } }));
      if (worker.read === 'fails') return route.fulfill({ status: 500, json: { error: 'unknown' } });

      return route.fulfill({ json: { sites: kept } });
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

const grid = (page: Page) => page.getByRole('list', { name: 'Sites' });
/** A site is named by its address with no scheme when the scheme is https (FRU-408). */
const card = (page: Page, name: string) =>
  grid(page)
    .locator('li[data-site]')
    .filter({ has: page.getByRole('heading', { level: 2, name, exact: true }) });
/** What a card says after one of its terms: « Notes go to », « Last note »… */
const value = (site: Locator, term: string) =>
  site.locator('dt', { hasText: term }).locator('xpath=following-sibling::dd[1]');
const more = (page: Page, name: string) => page.getByRole('button', { name: `More for ${name}`, exact: true });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search sites' });

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the list is a grid of cards, each named by its address and its icon (FRU-408)', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await workerWith(page);
  await open(page);

  // The head of the page: the title, what the page is for with the name of the workspace, the action.
  await expect(page.locator('main h1')).toHaveText('Sites');
  await expect(page.getByText('Where Acme collects notes, and where they stand.')).toBeVisible();
  const add = page.getByRole('button', { name: 'Add a site', exact: true });
  // The screen is as wide as its column (FRU-398): 71.5 px wider than the 1120 px of the mockup.
  expectBox(await box(add), { x: 1282, y: 58, width: 110, height: 44 }, 2, '« Add a site »');
  expect.soft(await styles(page.locator('main header'), ['margin-bottom'])).toEqual({ 'margin-bottom': '28px' });
  // No legend of the statuses (FRU-400): a bar says its counts in its own name, and the page of the
  // statuses of a site says what each colour is.
  await expect(page.getByRole('list', { name: 'Statuses' })).toHaveCount(0);

  // The search, then the grid: a card for each site, three side by side in the column.
  expectBox(await box(search(page)), { x: 298, y: 130, height: 40 }, 2, 'the search');
  const cards = grid(page).locator('li[data-site]');
  await expect(cards).toHaveCount(4);
  const columns = await grid(page).evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' '));
  expect.soft(columns).toHaveLength(3);
  expect.soft(await styles(grid(page), ['column-gap', 'row-gap'])).toEqual({ 'column-gap': '16px', 'row-gap': '16px' });

  // A site is its address with no « https:// » (FRU-408), in the order of the worker.
  await expect(cards.getByRole('heading', { level: 2 })).toHaveText([
    'staging.acme.dev',
    'acme.dev',
    'support.acme.dev',
    'preview.lumen.studio',
  ]);
  await expect(grid(page).getByText(/https?:\/\//)).toHaveCount(0);

  const first = card(page, 'staging.acme.dev');
  expect.soft(await styles(first, ['border-top-left-radius', 'border-top-width'])).toEqual({
    'border-top-left-radius': '14px',
    'border-top-width': '1px',
  });
  expect.soft(await painted(first, 'borderTopColor')).toEqual(rgb(LINE));
  expect.soft(await painted(first, 'backgroundColor')).toEqual(rgb(WHITE));

  // The site: its address at 600, and who sees its notes under it.
  const name = first.getByRole('heading', { level: 2 });
  expect.soft(await styles(name, ['font-weight', 'font-size'])).toEqual({ 'font-weight': '600', 'font-size': '15px' });
  expect.soft(await painted(name, 'color')).toEqual(rgb(INK));
  const audience = first.getByText('Members of Acme', { exact: true });
  expect.soft(await styles(audience, ['font-size'])).toEqual({ 'font-size': '13px' });
  expect.soft(await painted(audience, 'color')).toEqual(rgb(MUTED));
  await expect(card(page, 'support.acme.dev').getByText('Everyone who visits', { exact: true })).toBeVisible();

  // The icon of each site, 28 px: its favicon, asked of the site itself with no referrer, or its
  // first letter when there is none.
  for (const [site, letter] of [
    ['staging.acme.dev', 'S'],
    ['acme.dev', 'A'],
  ] as const) {
    const icon = card(page, site).locator('img, span[aria-hidden="true"]').first();
    const size = await box(icon);
    expect.soft({ width: size.width, height: size.height }, `the icon of ${site}`).toEqual({ width: 28, height: 28 });
    const tag = await icon.evaluate((element) => element.tagName);
    if (tag === 'IMG') {
      await expect(icon).toHaveAttribute('src', `https://${site}/favicon.ico`);
      await expect(icon).toHaveAttribute('referrerpolicy', 'no-referrer');
      await expect(icon).toHaveAttribute('alt', '');
    } else await expect(icon).toHaveText(letter);
  }

  // The notes: how many, at 600, and a bar of 128 × 8 px whose name says the counts again.
  const bar = first.getByRole('img', {
    name: '12 notes: 3 new, 2 to do, 4 in progress, 2 done, 1 closed',
    exact: true,
  });
  const drawn = await box(bar);
  expect.soft({ width: drawn.width, height: drawn.height }).toEqual({ width: 128, height: 8 });
  // A status with no note takes no room in the bar.
  await expect(bar.locator('span')).toHaveCount(5);
  await expect(
    card(page, 'support.acme.dev')
      .getByRole('img', { name: '4 notes: 2 new, 1 to do, 0 in progress, 1 done, 0 closed', exact: true })
      .locator('span'),
  ).toHaveCount(3);
  const total = first.getByText('12', { exact: true });
  expect.soft(await styles(total, ['font-weight', 'font-variant-numeric'])).toEqual({
    'font-weight': '600',
    'font-variant-numeric': 'tabular-nums',
  });
  const waiting = card(page, 'preview.lumen.studio').getByText('Waiting for the first note', { exact: true });
  expect.soft(await styles(waiting, ['font-size'])).toEqual({ 'font-size': '13px' });
  expect.soft(await painted(waiting, 'color')).toEqual(rgb(MUTED));

  // What the table said in its columns, each after its term.
  await expect(first.locator('dt')).toHaveText(['On the page with', 'Notes go to', 'Last note']);
  expect.soft(await painted(first.locator('dt').first(), 'color')).toEqual(rgb(MUTED));
  await expect(value(first, 'On the page with')).toHaveText('Extension, script');
  await expect(value(card(page, 'acme.dev'), 'On the page with')).toHaveText('Script');
  await expect(value(first, 'Last note')).toHaveText('2 h ago');
  await expect(value(card(page, 'acme.dev'), 'Last note')).toHaveText('12 min ago');
  await expect(value(card(page, 'support.acme.dev'), 'Last note')).toHaveText('40 min ago');
  // A site with no note yet: a dot for the eye, and words for a screen reader.
  const lumen = card(page, 'preview.lumen.studio');
  for (const term of ['On the page with', 'Last note']) {
    await expect(value(lumen, term).locator('[aria-hidden="true"]')).toHaveText('·');
    await expect(value(lumen, term).locator('.sr-only')).toHaveText('None yet');
  }

  // Where the notes go: the tracker, and the place in it, or the notes an address did not take.
  await expect(value(first, 'Notes go to')).toHaveText('LinearTeam Acme web');
  await expect(value(card(page, 'acme.dev'), 'Notes go to')).toContainText('Team Acme web and 1 more');
  await expect(value(card(page, 'support.acme.dev'), 'Notes go to')).toHaveText('REST API2 not delivered yet');
  await expect(value(lumen, 'Notes go to')).toHaveText('Kept in FruitbackNo tracker yet');

  // The button of a card: 36 px, named after its site, in the top right corner, and it opens a menu.
  const button = more(page, 'staging.acme.dev');
  const corner = await box(button);
  const around = await box(first);
  expect.soft({ width: corner.width, height: corner.height }).toEqual({ width: 36, height: 36 });
  expect.soft(around.x + around.width - (corner.x + corner.width), 'from the right of the card').toBeLessThan(16);
  expect.soft(corner.y - around.y, 'from the top of the card').toBeLessThan(16);
  expect.soft(await styles(button, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '8px' });
  expect.soft(await painted(button, 'color')).toEqual(rgb(MUTED));
  await expect(button).toHaveAttribute('aria-haspopup', /^(menu|true)$/);
  await button.hover();
  expect.soft(await painted(button, 'backgroundColor')).toEqual(rgb(CHIP));
  await page.mouse.move(700, 800);

  // Under the grid: what a site with no tracker does, and the way to connect one.
  const foot = page.getByText('A site with no tracker keeps its notes in Fruitback.');
  expect.soft(await styles(foot, ['font-size', 'line-height', 'margin-top'])).toEqual({
    'font-size': '13px',
    'line-height': '19.5px',
    'margin-top': '14px',
  });
  expect.soft(await painted(foot, 'color')).toEqual(rgb(MUTED));
  const connect = foot.getByRole('link', { name: 'Connect a tracker' });
  await expect(connect).toHaveAttribute('href', '/w/w1/connectors');
  // And the way to the page of the notes (FRU-245).
  await expect(foot).toContainText('Connect a tracker or see where every note went');
  await expect(foot.getByRole('link', { name: 'see where every note went' })).toHaveAttribute('href', '/w/w1/notes');
  // Four sites fit on one page: no pages.
  await expect(page.getByRole('navigation', { name: 'Pages of sites' })).toHaveCount(0);

  await expectNoViolation(page, 'the list');
});

test('the search keeps the sites whose address holds it, and a reload keeps it (FRU-408)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const names = grid(page).locator('li[data-site]').getByRole('heading', { level: 2 });

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
  await expect(grid(page)).toHaveCount(0);
  await expectNoViolation(page, 'a search that keeps nothing');
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await expect(names).toHaveCount(4);
  await expect(search(page)).toHaveValue('');
  await expect(page).not.toHaveURL(/[?&]q=/);
});

test('the sites come 12 to a page, and a search or a new site shows its page (FRU-408)', async ({ page }) => {
  const many = Array.from({ length: 30 }, (_, index) => ({
    id: `m${index + 1}`,
    origin: `https://site-${index + 1}.acme.dev`,
    visibility: 'members',
    notes: counts(0, 0, 0, 0, 0),
    via: [],
    undelivered: 0,
  }));
  await workerWith(page, 'owner', many);
  await open(page);
  const cards = grid(page).locator('li[data-site]');
  const pages = page.getByRole('navigation', { name: 'Pages of sites' });
  const previous = pages.getByRole('button', { name: 'Previous' });
  const next = pages.getByRole('button', { name: 'Next' });

  await expect(cards).toHaveCount(12);
  await expect(pages).toContainText('1 to 12 of 30');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(pages).toContainText('13 to 24 of 30');
  await expect(cards.first().getByRole('heading')).toHaveText('site-13.acme.dev');
  await expect(page).toHaveURL(/[?&]page=2(&|$)/);
  // The page lives in the address: a reload keeps it.
  await page.reload();
  await expect(pages).toContainText('13 to 24 of 30');
  await next.click();
  await expect(pages).toContainText('25 to 30 of 30');
  await expect(cards).toHaveCount(6);
  await expect(next).toBeDisabled();
  await expectNoViolation(page, 'the last page');

  // A page past the last one shows the last one.
  await page.goto(`${CONSOLE}/w/w1/sites?page=9`);
  await expect(pages).toContainText('25 to 30 of 30');

  // A search goes back to the first page, and its 11 sites need no pages.
  await search(page).fill('site-1');
  await expect(cards).toHaveCount(11);
  await expect(pages).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]page=/);

  // A new site opens its own page, at its installation (FRU-433); back on the grid, it is the last one.
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await page.getByRole('textbox', { name: 'Site address' }).fill('new.acme.dev');
  await page.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/n1#install`);
  await expect(page.getByRole('region', { name: 'Install on new.acme.dev' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sites' }).click();
  await expect(search(page)).toHaveValue('');
  await pages.getByRole('button', { name: 'Next' }).click();
  await pages.getByRole('button', { name: 'Next' }).click();
  await expect(pages).toContainText('25 to 31 of 31');
  await expect(card(page, 'new.acme.dev')).toBeVisible();
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
  await expect(grid(page).locator('li[data-site]').getByRole('heading', { level: 2 })).toHaveText([
    'http://acme.dev',
    'localhost:3000',
    'https://localhost:3000',
  ]);
  // A site on http gets its letter: the policy of the console loads images over https only.
  await expect(card(page, 'localhost:3000').locator('img')).toHaveCount(0);
  await expect(card(page, 'localhost:3000').locator('span[aria-hidden="true"]').first()).toHaveText('L');
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
  await expect(value(card(page, 'staging.acme.dev'), 'Last note')).toHaveText('2 h ago');
  await expect(value(card(page, 'acme.dev'), 'Last note')).toHaveText('Yesterday');
  await expect(value(card(page, 'support.acme.dev'), 'Last note')).toHaveText('2 days ago');
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
      'border-top-left-radius': '14px',
      'row-gap': '14px',
      'max-width': '640px',
      'box-sizing': 'content-box',
    });
  expect.soft(await painted(empty, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await painted(empty, 'borderTopColor')).toEqual(rgb(LINE));
  expectBox(await box(empty), { x: 297, y: 130, width: 754 }, 2, 'the card');

  const drop = empty.locator('svg').first();
  expectBox(await box(drop), { x: 354, y: 179, width: 40, height: 48 }, 2, 'the drop');
  expect.soft(await painted(drop, 'fill')).toEqual(rgb(ACCENT));
  const title = empty.getByRole('heading', { level: 2, name: 'No site yet' });
  expectBox(await box(title), { x: 354, y: 241, height: 26 }, 2, 'the title of the card');
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '20px', 'font-weight': '700' });
  const text = empty.getByText(
    "Paste the address of a site you review. Staging, a preview build or a client's live site: any page of it will do.",
  );
  expect
    .soft(await styles(text, ['font-size', 'line-height']))
    .toEqual({ 'font-size': '15px', 'line-height': '23.25px' });
  expect.soft(await painted(text, 'color')).toEqual(rgb(MUTED));

  const field = empty.getByRole('textbox', { name: 'Site address' });
  await expect(field).toHaveAttribute('placeholder', 'staging.acme.dev');
  expectBox(await box(field), { x: 354, y: 370, width: 530.7, height: 44 }, 2, 'the field');
  const submit = empty.getByRole('button', { name: 'Add site', exact: true });
  expectBox(await box(submit), { x: 894, y: 370, width: 99.3, height: 44 }, 2, '« Add site »');
  // The head has no « Add a site »: the card is the way to add one.
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(grid(page)).toHaveCount(0);
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

test('a read that failed is the alert of the mockup, and never « No site yet » (FRU-162)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'fails';
  await open(page);

  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { level: 2, name: 'The sites did not load' })).toBeVisible();
  await expect(alert.getByText('Fruitback did not answer. Your sites and notes are safe.')).toBeVisible();
  expect
    .soft(
      await styles(alert, ['padding-top', 'padding-left', 'border-top-left-radius', 'border-top-width', 'max-width']),
    )
    .toEqual({
      'padding-top': '28px',
      'padding-left': '32px',
      'border-top-left-radius': '14px',
      'border-top-width': '1px',
      'max-width': '760px',
    });
  expect.soft(await painted(alert, 'borderTopColor')).toEqual(rgb(CONTROL));
  expectBox(await box(alert), { x: 297, y: 130, width: 826, height: 104.5 }, 2, 'the alert');
  const title = alert.getByRole('heading', { level: 2 });
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '17px', 'font-weight': '600' });
  expectBox(await box(title), { x: 330, y: 159, height: 20 }, 2, 'the title of the alert');
  const again = alert.getByRole('button', { name: 'Try again', exact: true });
  expectBox(await box(again), { x: 989, y: 160, width: 100.1, height: 44 }, 2, '« Try again »');
  expect.soft(await styles(again, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '6px' });

  // Neither the card of a workspace with no site, nor a way to add one on a list nobody read.
  await expect(page.getByText('No site yet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(grid(page)).toHaveCount(0);
  await expectNoViolation(page, 'the alert');

  // « Try again » reads again, and the list is there.
  worker.read = 'list';
  await again.click();
  await expect(card(page, 'staging.acme.dev')).toBeVisible();
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
    page.getByRole('link', { name: 'My account', exact: true }),
    page.locator('main h1'),
  ];
  const before = await Promise.all(reachable.map(box));

  worker.release();
  // The cards and their counts are drawn in the same paint: when the grid is there, so are the bars.
  await page.waitForFunction(() => document.querySelector('main ul[aria-label="Sites"]') !== null);
  expect(await grid(page).getByRole('img').count()).toBe(3);
  const button = more(page, 'support.acme.dev');
  const first = await box(button);
  await expect(card(page, 'support.acme.dev').getByRole('img', { name: /^4 notes/ })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await box(button)).toEqual(first);
  expect(await Promise.all(reachable.map(box))).toEqual(before);
  expectBox(
    await box(page.getByRole('button', { name: 'Add a site', exact: true })),
    { x: 1282, y: 58 },
    2,
    '« Add a site »',
  );
});

test('« Add a site » opens the form above the grid, and a refusal keeps what was typed', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();

  const form = page.getByRole('region', { name: 'Add a site' });
  const formBox = await box(form);
  expect(formBox.y + formBox.height).toBeLessThanOrEqual((await box(search(page))).y);
  const field = form.getByRole('textbox', { name: 'Site address' });
  const submit = form.getByRole('button', { name: 'Add site', exact: true });
  await expect(form.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await expectNoViolation(page, 'the form');

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
  await expect(card(page, 'docs.acme.dev')).toHaveCount(0);

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

test('« Who can leave a note? » is asked for a site that its members read, « Members only » first (FRU-330)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('region', { name: 'Add a site' });
  const writers = form.getByRole('radiogroup', { name: 'Who can leave a note?' });

  // A new site is « Members only », and the detail says what private mode needs.
  await expect(writers.getByRole('radio', { name: 'Members only' })).toBeChecked();
  await expect(writers).toContainText('Private mode carries no session');
  await expect(writers).toContainText(/«\sAnyone on the page\s»/);
  await expectNoViolation(page, 'the form with « Who can leave a note? »');

  // A site that everyone reads takes a note from anybody: the question is not asked, nor sent.
  await form.getByText('Everyone who visits', { exact: true }).click();
  await expect(writers).toHaveCount(0);
  await form.getByRole('textbox', { name: 'Site address' }).fill('help.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('help.acme.dev');
  expect(worker.sent.at(-1)?.body).toEqual({ url: 'https://help.acme.dev', visibility: 'everyone' });
  const back = () => page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sites' }).click();
  await back();
  await expect(card(page, 'help.acme.dev')).toBeVisible();
  await expect(card(page, 'help.acme.dev').getByText(/Notes from/)).toHaveCount(0);

  // « Anyone on the page », chosen, is sent and said on the card.
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await expect(form.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await writers.getByText('Anyone on the page', { exact: true }).click();
  await expect(writers.getByRole('radio', { name: 'Anyone on the page' })).toBeChecked();
  await form.getByRole('textbox', { name: 'Site address' }).fill('review.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText('review.acme.dev');
  await back();
  await expect(card(page, 'review.acme.dev').getByText('Notes from anyone on the page')).toBeVisible();
  expect(worker.sent.at(-1)?.body).toEqual({
    url: 'https://review.acme.dev',
    visibility: 'members',
    writers: 'anyone',
  });

  // The next form starts from « Members only » again.
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await expect(writers.getByRole('radio', { name: 'Members only' })).toBeChecked();
});

test('the menu of a card is walked with the keyboard, and leads to the page of the site (FRU-433)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  const button = more(page, 'staging.acme.dev');

  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More for staging.acme.dev' });
  // « Settings » is the page of the site; « Statuses » the page of its statuses (FRU-371).
  await expect(menu.getByRole('menuitem')).toHaveText(['Settings', 'Install', 'Statuses', 'Remove']);
  await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
  await page.waitForTimeout(250);
  const opened = await new AxeBuilder({ page }).include('.kit-menu').analyze();
  expect
    .soft(opened.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  // The grid unfolds nothing under a card: « Install » is a section of the page of the site.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1#install`);
  const install = page.getByRole('region', { name: 'Install on staging.acme.dev' });
  await expect(install.getByRole('button', { name: 'Copy the script' })).toBeVisible();
  await expect(grid(page)).toHaveCount(0);

  // « Settings » is the top of the same page, and the name of the card a link to it.
  await page.goBack();
  await button.click();
  await menu.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s1`);
  await page.goBack();
  await card(page, 'acme.dev').getByRole('link', { name: 'acme.dev', exact: true }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites/s2`);
  await expect(page.locator('main h1')).toHaveText('acme.dev');
});

test('what is typed in the form stays when the form goes and comes back', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('region', { name: 'Add a site' });
  await form.getByRole('textbox', { name: 'Site address' }).fill('docs.acme.dev');
  await form.getByText('Everyone who visits').click();
  // « Cancel » closes the form. What was typed is not thrown away: the form shows it again.
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await expect(form.getByRole('textbox', { name: 'Site address' })).toHaveValue('docs.acme.dev');
  await expect(form.getByRole('radio', { name: /Everyone who visits/ })).toBeChecked();
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
  await expect(value(card(page, 'staging.acme.dev'), 'Notes go to')).toHaveText('A tracker');
  // Nor does it send the summary of the sites: the card says that nothing is known, and draws no bar.
  await expect(value(card(page, 'staging.acme.dev'), 'Last note')).toHaveText('·None yet');
  await expect(card(page, 'staging.acme.dev').getByRole('img')).toHaveCount(0);
});

test('removing a site asks twice, and the grid it comes back to has focus on its search', async ({ page }) => {
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
  await expect(card(page, 'staging.acme.dev')).toHaveCount(0);
  await expect(card(page, 'acme.dev')).toBeVisible();
  // Its card and its button are gone: focus is on the search, and not back at the top of the page.
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
  await expect(card(page, 'staging.acme.dev').locator('dt')).toHaveText([
    'On the page with',
    'Notes go to',
    'Last note',
  ]);
  await more(page, 'staging.acme.dev').click();
  await expect(page.getByRole('menuitem')).toHaveText(['Settings', 'Install']);
  await page.keyboard.press('Escape');

  // The worker sends a guest no destination, and a card says nothing of one.
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
  // The notes of the sites shared with a guest are theirs to count; where they go is not.
  await expect(card(page, 'staging.acme.dev').locator('dt')).toHaveText(['On the page with', 'Last note']);
  await expect(card(page, 'staging.acme.dev').getByRole('img', { name: /^12 notes/ })).toBeVisible();
  await expect(page.getByText('Kept in Fruitback')).toHaveCount(0);
  await expect(page.getByText('A site with no tracker keeps its notes in Fruitback.')).toHaveCount(0);
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
    // One card in a row, as wide as the column of the page.
    const cards = grid(page).locator('li[data-site]');
    const column = await box(grid(page));
    expect.soft((await box(cards.nth(1))).y).toBeGreaterThan((await box(cards.nth(0))).y);
    expect.soft((await box(cards.nth(0))).width).toBeCloseTo(column.width, 0);

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
  expectBox(await box(empty), { x: 16, y: top + 154.2, width: 358 }, 4, 'the card');
  expectBox(await box(empty.locator('svg').first()), { x: 37, y: top + 203.2, width: 40, height: 48 }, 4, 'the drop');
  expectBox(await box(empty.getByRole('heading', { level: 2 })), { x: 37, y: top + 265.2, height: 26 }, 4, 'the title');
  expectBox(
    await box(empty.getByRole('textbox', { name: 'Site address' })),
    { x: 37, y: top + 417, width: 316, height: 44 },
    4,
    'the field',
  );
  expectBox(
    await box(empty.getByRole('button', { name: 'Add site' })),
    { x: 37, y: top + 471, width: 99.3, height: 44 },
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
  expectBox(await box(alert), { x: 16, y: under + 154.2, width: 358, height: 187 }, 4, 'the alert');
  expectBox(
    await box(alert.getByRole('heading', { level: 2 })),
    { x: 49, y: under + 183.2, height: 20 },
    4,
    'the title of the alert',
  );
  expectBox(
    await box(alert.getByRole('button', { name: 'Try again' })),
    { x: 49, y: under + 268.2, width: 100.1, height: 44 },
    4,
    '« Try again »',
  );
});

test('every text of the list is at 4.5:1 on what is behind it', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const first = card(page, 'staging.acme.dev');
  const texts: [string, Locator][] = [
    ['a term', first.locator('dt').first()],
    ['an address', first.getByRole('heading', { level: 2 })],
    ['who sees the notes', first.getByText('Members of Acme', { exact: true })],
    ['a tracker', first.getByText('Linear', { exact: true })],
    ['a place in a tracker', first.getByText('Team Acme web', { exact: true })],
  ];
  for (const behind of [WHITE, SUBTLE]) {
    for (const [name, text] of texts) {
      expect
        .soft(contrast(await painted(text, 'color'), rgb(behind)), `${name} on ${behind}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  }
  // The button of a card is a picture: 3:1 on the card, and on its own tint under the pointer.
  const button = more(page, 'staging.acme.dev');
  expect.soft(contrast(await painted(button, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(3);
  expect.soft(contrast(await painted(button, 'color'), rgb(CHIP))).toBeGreaterThanOrEqual(3);
});

import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import {
  ACME,
  type Role,
  box,
  expectBox,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
  typeDuringTheWrite,
} from './console-workspace.ts';

/**
 * The Notes page (FRU-245), measured in a browser against screen 10 of the mockup of 2026-10-13: the
 * chips of where the notes went, the filters, the table, the pages, « Send again », and the states the
 * mockup does not draw (loading, none, no match, a read that failed).
 *
 * The worker is answered by stubs, at the shape of the route of FRU-244 that fru-console announced:
 * `GET /console/workspaces/<id>/notes?place=&site=&stage=&mine=&q=&cursor=` answers `{notes, total,
 * counts: {all, byPlace, undelivered?}, next?}`, and a note carries its first 64 characters (`excerpt`),
 * never its text (Q6). The values are read in `10-console-notes.html`; a box is compared where the
 * font is the one of the mockup.
 */
const CONSOLE = 'http://localhost:5178';

const INK = '#18181b';
const MUTED = '#6b6b74';
const CONTROL = '#8a8a93';
const ACCENT = '#dd2c27';
const WHITE = '#ffffff';
const RAIL_TEXT = '#d4d4d8';

const MINUTE = 60_000;
/**
 * The moments are counted back from noon of a fixed day, and a test that reads « 2 h ago » sets the
 * clock of the browser there: near midnight, two hours ago is « Yesterday ».
 */
const NOON = new Date(2026, 9, 13, 12, 0, 0);
const since = (minutes: number) => new Date(NOON.getTime() - minutes * MINUTE).toISOString();

const SITES = [
  { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' },
  { id: 's2', origin: 'https://acme.dev', visibility: 'everyone' },
  { id: 's3', origin: 'https://support.acme.dev', visibility: 'everyone' },
];
const CONNECTORS = [
  { id: 'c1', kind: 'linear', label: 'Acme', createdAt: '2026-10-01T08:00:00.000Z' },
  { id: 'c2', kind: 'rest', label: 'hooks.acme.dev/feedback', createdAt: '2026-10-01T08:00:00.000Z' },
];
const LINEAR = { kind: 'linear', connector: 'c1', label: 'Acme' };
const REST = { kind: 'rest', connector: 'c2', label: 'hooks.acme.dev/feedback' };

type Note = {
  id: string;
  excerpt: string;
  page: { url: string; host: string; path: string };
  site: { id: string };
  stage: string;
  author: { kind: string; name?: string };
  note?: string;
  place?: Record<string, string>;
  ref?: string;
  url?: string;
  delivery?: { id: string; state: string };
  createdAt: string;
};

const page = (url: string) => {
  const parsed = new URL(url);

  return { url, host: parsed.host, path: parsed.pathname };
};

/** The eight notes of the mockup, with acme.dev for its sites and invented names. */
const FIRST: Note[] = [
  {
    id: 'n1',
    excerpt: 'The order form rejects postcodes with a space.',
    page: page('https://support.acme.dev/contact'),
    site: { id: 's3' },
    stage: 'new',
    author: { kind: 'anonymous' },
    place: REST,
    delivery: { id: 'd1', state: 'waiting' },
    createdAt: since(40),
  },
  {
    id: 'n2',
    excerpt: 'The headline runs to three lines on a phone. Can it be shorter?',
    page: page('https://staging.acme.dev/'),
    site: { id: 's1' },
    stage: 'new',
    author: { kind: 'you', name: 'Ana' },
    note: 'note-n2',
    place: LINEAR,
    ref: 'ACM-151',
    url: 'https://linear.app/acme/issue/ACM-151',
    createdAt: since(65),
  },
  {
    id: 'n3',
    excerpt: 'The returns policy says "recieve".',
    page: page('https://acme.dev/help/returns'),
    site: { id: 's2' },
    stage: 'todo',
    author: { kind: 'anonymous' },
    place: LINEAR,
    ref: 'ACM-149',
    url: 'https://linear.app/acme/issue/ACM-149',
    createdAt: since(185),
  },
  {
    id: 'n4',
    excerpt: 'The chat bubble covers the send button on a phone.',
    page: page('https://support.acme.dev/'),
    site: { id: 's3' },
    stage: 'done',
    author: { kind: 'member', name: 'Léa Martin' },
    place: REST,
    createdAt: since(26 * 60),
  },
  {
    id: 'n5',
    excerpt: 'The button is hard to read on the green. Could it take the cream',
    page: page('https://staging.acme.dev/'),
    site: { id: 's1' },
    stage: 'progress',
    author: { kind: 'guest', name: 'Camille Durand' },
    place: LINEAR,
    ref: 'ACM-142',
    url: 'https://linear.app/acme/issue/ACM-142',
    createdAt: since(2 * 24 * 60 + 60),
  },
  {
    id: 'n6',
    excerpt: 'The yearly toggle goes back to monthly on reload.',
    page: page('https://staging.acme.dev/pricing'),
    site: { id: 's1' },
    stage: 'todo',
    author: { kind: 'admin', name: 'Marc Petit' },
    place: LINEAR,
    ref: 'ACM-139',
    url: 'https://linear.app/acme/issue/ACM-139',
    createdAt: since(3 * 24 * 60 + 60),
  },
  {
    id: 'n7',
    excerpt: 'The checkout button sits under the cookie banner.',
    page: page('https://acme.dev/checkout'),
    site: { id: 's2' },
    stage: 'progress',
    author: { kind: 'verified' },
    place: { kind: 'fruitback' },
    createdAt: since(4 * 24 * 60 + 60),
  },
  {
    id: 'n8',
    excerpt: 'The mug is cut off at the top on every tile of this row.',
    page: page('https://staging.acme.dev/shop'),
    site: { id: 's1' },
    stage: 'done',
    author: { kind: 'member', name: 'Léa Martin' },
    place: LINEAR,
    ref: 'ACM-120',
    url: 'https://linear.app/acme/issue/ACM-120',
    createdAt: since(6 * 24 * 60 + 60),
  },
];
/** The second page: the notes after the eighth, as a cursor reaches them. */
const SECOND: Note[] = [
  { ...(FIRST[7] as Note), id: 'n9', excerpt: 'The footer links overlap on a tablet.', createdAt: since(8 * 24 * 60) },
  {
    ...(FIRST[3] as Note),
    id: 'n10',
    excerpt: 'The contact form says nothing after it is sent.',
    stage: 'todo',
    // The worker stopped trying to deliver this one (FRU-122).
    delivery: { id: 'd10', state: 'gave-up' },
    createdAt: since(9 * 24 * 60),
  },
];

type Asked = Record<string, string>;
type Worker = {
  /** What each read of the notes asked, in order. */
  asked: Asked[];
  /** What the console sent that changes something. */
  sent: string[];
  read: 'list' | 'fails' | 'none' | 'waits';
  /** Releases a read that `waits`. */
  release: () => void;
  retry: 'ok' | 'refused' | 'waits';
  /** The sources of the workspace, which may have a name (FRU-404). */
  connectors: unknown[];
};

async function workerWith(page: Page, role: Role = 'owner', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  let release: () => void = () => {};
  const worker: Worker = {
    asked: [],
    sent: [],
    read: 'list',
    release: () => release(),
    retry: 'ok',
    connectors: CONNECTORS,
  };
  const delivered = new Set<string>();
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    if (pathname === '/console/workspaces/w1/connectors') {
      return role === 'guest'
        ? route.fulfill({ status: 403, json: { error: 'forbidden' } })
        : route.fulfill({ json: { connectors: worker.connectors, available: true } });
    }
    const retry = /^\/console\/workspaces\/w1\/notes\/(\w+)\/retry$/.exec(pathname);
    if (retry !== null) {
      worker.sent.push(`POST ${pathname}`);
      if (worker.retry === 'waits') return new Promise<void>(() => {});
      if (worker.retry === 'refused') return route.fulfill({ status: 502, json: { error: 'unreachable' } });
      delivered.add(retry[1] as string);

      return route.fulfill({ status: 204 });
    }
    if (pathname !== '/console/workspaces/w1/notes') return undefined;
    const asked = Object.fromEntries(new URL(request.url()).searchParams);
    worker.asked.push(asked);
    if (worker.read === 'fails') return route.fulfill({ status: 500, json: { error: 'unknown' } });
    const fulfil = () => {
      if (worker.read === 'none') {
        return route.fulfill({ json: { notes: [], total: 0, counts: { all: 0, byPlace: {} } } });
      }
      const all = [...FIRST, ...SECOND]
        .map((note) => (delivered.has(note.id) ? { ...note, delivery: undefined } : note))
        // A guest gets no place, no reference and no delivery (FRU-244).
        .map((note) =>
          role === 'guest' ? { ...note, place: undefined, ref: undefined, url: undefined, delivery: undefined } : note,
        );
      const kept = all.filter(
        (note) =>
          (asked.site === undefined || note.site.id === asked.site) &&
          (asked.stage === undefined || note.stage === asked.stage) &&
          (asked.mine === undefined || note.author.kind === 'you') &&
          (asked.q === undefined || note.excerpt.toLowerCase().includes(asked.q.toLowerCase())),
      );
      const placed = kept.filter((note) => {
        if (asked.place === undefined) return true;

        return (note.place?.connector ?? note.place?.kind) === asked.place;
      });
      const start = asked.cursor === 'p2' ? 8 : 0;
      const notes = placed.slice(start, start + 8);
      const byPlace: Record<string, number> = {};
      for (const note of kept) {
        const id = (note.place?.connector ?? note.place?.kind) as string;
        byPlace[id] = (byPlace[id] ?? 0) + 1;
      }

      return route.fulfill({
        json: {
          notes,
          total: placed.length,
          counts: {
            all: kept.length,
            // A guest gets neither: the worker of FRU-244 leaves them out.
            ...(role === 'guest'
              ? {}
              : { byPlace, undelivered: kept.filter((note) => note.delivery !== undefined).length }),
          },
          ...(start + 8 < placed.length ? { next: 'p2' } : {}),
        },
      });
    };
    if (worker.read === 'waits') {
      return new Promise<void>((resolve) => {
        release = () => void fulfil().then(resolve);
      });
    }

    return fulfil();
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], sites: SITES, answer });

  return worker;
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/notes${query}`);
  await expect(page.locator('main h1')).toBeVisible();
}

const table = (page: Page) => page.getByRole('region', { name: 'Notes' });
const rows = (page: Page) => table(page).locator('tbody tr');
const chips = (page: Page) => page.getByRole('group', { name: 'Where the notes went' }).getByRole('button');
const chip = (page: Page, name: string | RegExp) =>
  page.getByRole('group', { name: 'Where the notes went' }).getByRole('button', { name });
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search notes' });
const pages = (page: Page) => page.getByRole('navigation', { name: 'Pages of notes' });
const row = (page: Page, excerpt: string) => rows(page).filter({ hasText: excerpt });

async function expectNoViolation(page: Page, name: string): Promise<void> {
  // A list of HeroUI fades in: axe reads it once it is there.
  await page.waitForTimeout(250);
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the page is the one of the mockup: chips, filters, the table and its pages', async ({ page }) => {
  await page.clock.setFixedTime(NOON);
  await workerWith(page);
  await open(page);
  await expect(rows(page)).toHaveCount(8);

  // The rail has its entry, on screen, between « Sites » and « Connectors ».
  const rail = page.getByRole('navigation', { name: 'Workspace' }).getByRole('link');
  await expect(rail).toHaveText(['Sites', 'Notes', 'Connectors', 'Members', 'Settings', 'My account']);
  await expect(rail.nth(1)).toHaveAttribute('aria-current', 'page');

  // The head.
  await expect(page.locator('main h1')).toHaveText('Notes');
  await expect(page.getByText('Every note left on the sites of Acme, and where it went.')).toBeVisible();
  expect.soft(await styles(page.locator('main header'), ['margin-bottom'])).toEqual({ 'margin-bottom': '24px' });

  // The chips: every note, and each place with notes. No « Not delivered »: the route counts those
  // notes and does not filter them, and a chip that chooses nothing is not drawn.
  await expect(chips(page)).toHaveText(['All10', 'Linear6', 'REST API3', 'In Fruitback1']);
  const all = chip(page, /^All/);
  await expect(all).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^Linear/)).toHaveAttribute('aria-pressed', 'false');
  expectBox(await box(all), { x: 297, y: 126, height: 36 }, 2, '« All »');
  expect
    .soft(
      await styles(all, ['height', 'padding-left', 'border-top-left-radius', 'font-size', 'font-weight', 'column-gap']),
    )
    .toEqual({
      height: '36px',
      'padding-left': '14px',
      'border-top-left-radius': '999px',
      'font-size': '13px',
      'font-weight': '600',
      'column-gap': '8px',
    });
  // Pressed: ink, white words, a light count.
  expect.soft(await painted(all, 'backgroundColor')).toEqual(rgb(INK));
  expect.soft(await painted(all, 'color')).toEqual(rgb(WHITE));
  expect.soft(await painted(all.locator('span').last(), 'color')).toEqual(rgb(RAIL_TEXT));
  // At rest: white, the border of a control, a muted count at 400.
  const linear = chip(page, /^Linear/);
  expect.soft(await painted(linear, 'backgroundColor')).toEqual(rgb(WHITE));
  expect.soft(await painted(linear, 'borderTopColor')).toEqual(rgb(CONTROL));
  expect.soft(await painted(linear.locator('span').last(), 'color')).toEqual(rgb(MUTED));
  expect.soft(await styles(linear.locator('span').last(), ['font-weight'])).toEqual({ 'font-weight': '400' });
  await linear.hover();
  expect.soft(await painted(linear, 'borderTopColor')).toEqual(rgb(INK));
  await page.mouse.move(700, 880);
  expect
    .soft(await styles(page.getByRole('group', { name: 'Where the notes went' }), ['column-gap', 'margin-bottom']))
    .toEqual({
      'column-gap': '8px',
      'margin-bottom': '14px',
    });

  // The filters: a search and two lists, 40 px, their names for a screen reader only.
  expectBox(await box(search(page)), { x: 297, y: 176, height: 40 }, 2, 'the search');
  // What the index searches: not the author, which the mockup says.
  await expect(search(page)).toHaveAttribute('placeholder', 'Search the text, the page or the reference');
  const site = page
    .getByRole('button', { name: /Site$/ })
    .or(page.getByRole('button', { name: /^Every site/ }))
    .first();
  await expect(site).toBeVisible();
  expect.soft((await box(site)).height).toBe(40);

  // « Only my notes »: a box of 16 px, its words at 14 px 8 px after it, on a line of 40 px.
  const mine = page.getByRole('checkbox', { name: 'Only my notes' });
  await expect(mine).not.toBeChecked();
  const tick = await box(page.locator('.kit-checkbox .checkbox__control'));
  expect.soft({ width: tick.width, height: tick.height }).toEqual({ width: 16, height: 16 });
  expectBox(await box(page.locator('.kit-checkbox')), { x: 1276, y: 176, height: 40 }, 2, '« Only my notes »');
  expect.soft(await styles(page.locator('.kit-checkbox'), ['column-gap'])).toEqual({ 'column-gap': '8px' });
  expect.soft(await styles(page.locator('.kit-checkbox .label'), ['font-size'])).toEqual({ 'font-size': '14px' });

  // The table: 960 px at the least, the five columns.
  const headers = table(page).locator('thead th');
  await expect(headers).toHaveText(['Note', 'Status', 'Left by', 'Went to', 'When']);
  expect.soft(await styles(table(page).locator('table'), ['min-width', 'font-size'])).toEqual({
    'min-width': '960px',
    'font-size': '14px',
  });
  expectBox(await box(table(page).locator('table')), { x: 298, y: 233 }, 2, 'the table');
  expect.soft(await styles(headers.last(), ['text-align'])).toEqual({ 'text-align': 'right' });

  // A note: its 64 characters on two lines at most, its page, and the way to see it there.
  const first = row(page, 'The headline runs');
  const excerpt = first.locator('td').first().locator('span').first();
  expect.soft(await styles(excerpt, ['-webkit-line-clamp', 'overflow'])).toEqual({
    '-webkit-line-clamp': '2',
    overflow: 'hidden',
  });
  await expect(first.locator('td').first()).toContainText('staging.acme.dev/');
  const show = first.getByRole('link', { name: 'Show on the page' });
  // The link of the widget (FRU-253) opens the note by the id the widget gave it, by its issue when
  // the worker does not send that id, and opens the page alone with neither.
  await expect(show).toHaveAttribute('href', 'https://staging.acme.dev/#fruitback-note=note-n2');
  await expect(row(page, 'returns policy').getByRole('link', { name: 'Show on the page' })).toHaveAttribute(
    'href',
    'https://acme.dev/help/returns#fruitback-note=ACM-149',
  );
  await expect(row(page, 'checkout button').getByRole('link', { name: 'Show on the page' })).toHaveAttribute(
    'href',
    'https://acme.dev/checkout',
  );
  await expect(show).toHaveAttribute('target', '_blank');

  // Its status: a drop of 10 px, and the word.
  await expect(first.locator('td').nth(1)).toHaveText('New');
  const drop = await box(first.locator('td').nth(1).locator('[aria-hidden="true"]'));
  expect.soft({ width: drop.width, height: drop.height }).toEqual({ width: 10, height: 10 });

  // Who left it.
  await expect(first.locator('td').nth(2)).toHaveText('AnaYou');
  await expect(row(page, 'The order form').locator('td').nth(2)).toHaveText('VisitorAnonymous');
  await expect(row(page, 'The checkout button').locator('td').nth(2)).toHaveText('VisitorVerified by https://acme.dev');
  await expect(row(page, 'cream').locator('td').nth(2)).toHaveText('Camille DurandGuest');
  await expect(row(page, 'yearly toggle').locator('td').nth(2)).toHaveText('Marc PetitAdmin');

  // Where it went: the tracker at 600, its reference as a link at 400 with an arrow.
  const went = first.locator('td').nth(3);
  await expect(went.locator('span').first()).toHaveText('Linear');
  expect.soft(await styles(went.locator('span').first(), ['font-weight'])).toEqual({ 'font-weight': '600' });
  const ref = went.getByRole('link', { name: 'ACM-151' });
  await expect(ref).toHaveAttribute('href', 'https://linear.app/acme/issue/ACM-151');
  expect.soft(await styles(ref, ['font-size', 'font-weight', 'column-gap'])).toEqual({
    'font-size': '13px',
    'font-weight': '400',
    'column-gap': '4px',
  });
  const arrow = await box(ref.locator('svg'));
  expect.soft({ width: arrow.width, height: arrow.height }).toEqual({ width: 12, height: 12 });
  await expect(row(page, 'chat bubble').locator('td').nth(3)).toHaveText('REST APIDelivered to hooks.acme.dev');
  // A note an address did not take does not say it was delivered.
  await expect(row(page, 'The order form').locator('td').nth(3)).toHaveText('REST APINot delivered yetSend again');
  // An excerpt of 64 characters was cut: it says so.
  await expect(row(page, 'cream').locator('td').first().locator('span').first()).toHaveText(
    'The button is hard to read on the green. Could it take the cream…',
  );
  await expect(first.locator('td').first().locator('span').first()).toHaveText(
    'The headline runs to three lines on a phone. Can it be shorter?',
  );
  await expect(row(page, 'checkout button').locator('td').nth(3)).toHaveText('Kept in Fruitback');
  // Each source has its mark before its name, 14 px, hidden from a screen reader (FRU-435).
  // A note kept in Fruitback went to no source, and has none.
  for (const cell of [went, row(page, 'chat bubble').locator('td').nth(3)]) {
    const mark = cell.locator('span').first().locator('svg');
    await expect(mark).toHaveAttribute('aria-hidden', 'true');
    const size = await box(mark);
    expect.soft({ width: size.width, height: size.height }).toEqual({ width: 14, height: 14 });
  }
  await expect(row(page, 'checkout button').locator('td').nth(3).locator('svg')).toHaveCount(0);
  // Not delivered: the words in the accent, and « Send again » at 32 px.
  const late = row(page, 'The order form').locator('td').nth(3);
  const words = late.getByText('Not delivered yet', { exact: true });
  expect.soft(await styles(words, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });
  expect.soft(await painted(words, 'color')).toEqual(rgb(ACCENT));
  const again = late.getByRole('button', { name: 'Send again' });
  expect
    .soft(await styles(again, ['height', 'padding-left', 'border-top-left-radius', 'font-size', 'font-weight']))
    .toEqual({
      height: '32px',
      'padding-left': '10px',
      'border-top-left-radius': '6px',
      'font-size': '13px',
      'font-weight': '600',
    });

  // When: aligned to the right, muted, tabular.
  const when = first.locator('td').nth(4);
  await expect(when).toHaveText('1 h ago');
  await expect(row(page, 'The mug').locator('td').nth(4)).toHaveText('6 days ago');
  expect.soft(await styles(when, ['text-align', 'font-variant-numeric', 'white-space'])).toEqual({
    'text-align': 'right',
    'font-variant-numeric': 'tabular-nums',
    'white-space': 'nowrap',
  });
  expect.soft(await painted(when, 'color')).toEqual(rgb(MUTED));

  // The pages.
  await expect(pages(page).locator('span').first()).toHaveText('1 to 8 of 10');
  const previous = pages(page).getByRole('button', { name: 'Previous' });
  await expect(previous).toBeDisabled();
  expect.soft(await styles(previous, ['height', 'padding-left', 'border-top-left-radius', 'font-size'])).toEqual({
    height: '40px',
    'padding-left': '14px',
    'border-top-left-radius': '6px',
    'font-size': '14px',
  });
  expect
    .soft(await styles(pages(page), ['margin-top', 'font-size']))
    .toEqual({ 'margin-top': '16px', 'font-size': '14px' });
  expect.soft(await painted(pages(page), 'color')).toEqual(rgb(MUTED));

  await expectNoViolation(page, 'the list');
});

test('each filter writes the address and reads again, and a reload keeps the view', async ({ page }) => {
  const worker = await workerWith(page);
  await page.clock.install();
  await open(page);
  await expect(rows(page)).toHaveCount(8);

  // A chip.
  await chip(page, /^REST API/).click();
  await expect(page).toHaveURL(/[?&]place=c2(&|$)/);
  await expect(rows(page)).toHaveCount(3);
  await expect(chip(page, /^REST API/)).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, /^All/)).toHaveAttribute('aria-pressed', 'false');
  expect(worker.asked.at(-1)).toEqual({ place: 'c2' });
  await chip(page, /^All/).click();
  await expect(rows(page)).toHaveCount(8);

  // The status.
  await page.getByRole('button', { name: /Any status/ }).click();
  await page.getByRole('option', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(/[?&]stage=done(&|$)/);
  await expect(rows(page)).toHaveCount(3);

  // The search waits 300 ms after the last key, and reads once. The clock of the page is held while
  // the keys go in: 299 ms later nothing is read, whatever the load of the machine (FRU-327).
  const before = worker.asked.length;
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
  await search(page).pressSequentially('mug');
  await page.clock.runFor(299);
  expect(worker.asked.length).toBe(before);
  await expect(page).not.toHaveURL(/q=/);
  await page.clock.resume();
  await expect(page).toHaveURL(/[?&]q=mug(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  expect(worker.asked.length).toBe(before + 1);
  expect(worker.asked.at(-1)).toEqual({ stage: 'done', q: 'mug' });

  // A key typed while the search is written in the address stays in the field (FRU-279).
  await search(page).fill('');
  await expect(page).not.toHaveURL(/q=/);
  const typed = worker.asked.length;
  await typeDuringTheWrite(search(page), 'mu', 'g');
  await expect(page).toHaveURL(/[?&]q=mug(&|$)/);
  await expect(search(page)).toHaveValue('mug');
  // The address is written before the read leaves: the read comes from an effect of the next render.
  // So wait for the read itself, and only one made after the keys (FRU-327).
  await expect.poll(() => worker.asked.slice(typed).at(-1)).toEqual({ stage: 'done', q: 'mug' });

  // « Only my notes ».
  const mine = page.getByRole('checkbox', { name: 'Only my notes' });
  await search(page).fill('');
  await expect(page).not.toHaveURL(/q=/);
  await page.getByRole('button', { name: /Done/ }).first().click();
  await page.getByRole('option', { name: 'Any status', exact: true }).click();
  await expect(page).not.toHaveURL(/stage=/);
  await expect(rows(page)).toHaveCount(8);
  // The box is pressed where it is drawn: the input of HeroUI is hidden under it.
  await page.getByText('Only my notes', { exact: true }).click();
  await expect(mine).toBeChecked();
  await expect(page).toHaveURL(/[?&]mine=1(&|$)/);
  await expect(rows(page)).toHaveCount(1);
  await expect.poll(() => worker.asked.at(-1)).toEqual({ mine: '1' });
  await page.keyboard.press('Space');
  await expect(mine).not.toBeChecked();
  await expect(rows(page)).toHaveCount(8);
  await search(page).fill('mug');
  await expect(page).toHaveURL(/[?&]q=mug(&|$)/);
  await page.getByRole('button', { name: /Any status/ }).click();
  await page.getByRole('option', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(/[?&]stage=done(&|$)/);
  await expect(rows(page)).toHaveCount(1);

  // A reload keeps it all.
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(search(page)).toHaveValue('mug');
  await expect(page.getByRole('button', { name: /Done/ }).first()).toBeVisible();
  expect(worker.asked.at(-1)).toEqual({ stage: 'done', q: 'mug' });
});

test('a list chosen while the search waits its 300 ms is kept when the search lands', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await expect(rows(page)).toHaveCount(8);
  await search(page).fill('mug');
  // Inside the 300 ms of the search: a status is chosen.
  await page.getByRole('button', { name: /Any status/ }).click();
  await page.getByRole('option', { name: 'Done', exact: true }).click();
  await expect(page).toHaveURL(/[?&]q=mug(&|$)/);
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/[?&]stage=done(&|$)/);
  await expect.poll(() => worker.asked.at(-1)).toEqual({ stage: 'done', q: 'mug' });
});

test('the pages go forward with the cursor and come back, « Previous » off on the first one', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const next = pages(page).getByRole('button', { name: 'Next' });
  const previous = pages(page).getByRole('button', { name: 'Previous' });
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(rows(page)).toHaveCount(2);
  await expect(pages(page).locator('span').first()).toHaveText('9 to 10 of 10');
  expect(worker.asked.at(-1)).toEqual({ cursor: 'p2' });
  await expect(next).toBeDisabled();
  await expect(page).toHaveURL(/[?&]cursor=p2(&|$)/);
  await previous.click();
  await expect(rows(page)).toHaveCount(8);
  await expect(pages(page).locator('span').first()).toHaveText('1 to 8 of 10');
  await expect(previous).toBeDisabled();
  expect(worker.asked.at(-1)).toEqual({});
  // A filter starts again from the first page.
  await next.click();
  await expect(rows(page)).toHaveCount(2);
  await chip(page, /^Linear/).click();
  await expect(page).not.toHaveURL(/cursor=/);
  await expect.poll(() => worker.asked.at(-1)).toEqual({ place: 'c1' });
});

test('a link to a later page reads its range, and « Previous » goes to the first page, range and all', async ({
  page,
}) => {
  const worker = await workerWith(page);
  // A link shared from the second page, or a reload there: the cursors before it are not known.
  await open(page, '?cursor=p2&from=9');
  await expect(rows(page)).toHaveCount(2);
  await expect(pages(page).locator('span').first()).toHaveText('9 to 10 of 10');
  await pages(page).getByRole('button', { name: 'Previous' }).click();
  await expect(page).not.toHaveURL(/cursor=|from=/);
  await expect(rows(page)).toHaveCount(8);
  await expect(pages(page).locator('span').first()).toHaveText('1 to 8 of 10');
  await expect(pages(page).getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(worker.asked.at(-1)).toEqual({});
});

test('« Send again » waits, then the row loses its alert; a refusal says so on the row', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const late = row(page, 'The order form');
  const again = late.getByRole('button', { name: 'Send again' });

  worker.retry = 'refused';
  await again.click();
  await expect(late.getByRole('alert')).toHaveText('Fruitback hit an error. Try again in a moment.');
  await expect(late.getByText('Not delivered yet')).toBeVisible();

  worker.retry = 'ok';
  await again.click();
  await expect(late.getByText('Not delivered yet')).toHaveCount(0);
  await expect(late.getByRole('alert')).toHaveCount(0);
  expect(worker.sent).toEqual([
    'POST /console/workspaces/w1/notes/n1/retry',
    'POST /console/workspaces/w1/notes/n1/retry',
  ]);
});

test('a delivery the worker gave up says so, and « Send again » still sends it', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await pages(page).getByRole('button', { name: 'Next' }).click();
  const given = row(page, 'The contact form');
  await expect(given.locator('td').nth(3)).toHaveText('REST APINot delivered: Fruitback stopped tryingSend again');
  const words = given.getByText('Not delivered: Fruitback stopped trying', { exact: true });
  expect.soft(await painted(words, 'color')).toEqual(rgb(ACCENT));
  // One that the worker still tries says « yet ».
  await pages(page).getByRole('button', { name: 'Previous' }).click();
  await expect(row(page, 'The order form').getByText('Not delivered yet', { exact: true })).toBeVisible();
  await pages(page).getByRole('button', { name: 'Next' }).click();
  await given.getByRole('button', { name: 'Send again' }).click();
  await expect(given.getByText(/Not delivered/)).toHaveCount(0);
  expect(worker.sent).toEqual(['POST /console/workspaces/w1/notes/n10/retry']);
});

test('« Send again » is off while it is on its way', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  worker.retry = 'waits';
  const again = row(page, 'The order form').getByRole('button', { name: 'Send again' });
  await again.click();
  await expect(again).toBeDisabled();
});

test('a workspace with no note says so, and a read that failed is an alert, never « No note yet »', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.read = 'none';
  await open(page);
  await expect(
    page.getByText('No note yet. Notes show here as soon as someone leaves one on a site of Acme.'),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(table(page)).toHaveCount(0);

  worker.read = 'fails';
  await open(page);
  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { name: 'The notes did not load' })).toBeVisible();
  await expect(alert).toContainText('Fruitback hit an error. Try again in a moment. Your notes are safe.');
  await expect(page.getByText(/No note yet/)).toHaveCount(0);
  await expectNoViolation(page, 'the alert');

  // « Try again » reads again, and the list comes.
  worker.read = 'list';
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(8);
});

test('a filter that keeps nothing says so, and clears in one press', async ({ page }) => {
  await workerWith(page);
  await open(page, '?q=nothing-like-this');
  await expect(page.getByText('No note matches.')).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear the filters' }).click();
  await expect(rows(page)).toHaveCount(8);
  await expect(search(page)).toHaveValue('');
  await expect(page).not.toHaveURL(/q=/);
});

test('while a filter is read, the rows stay and nothing a pointer can reach moves', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await expect(rows(page)).toHaveCount(8);
  const reachable = [
    chip(page, /^All/),
    chip(page, /^Linear/),
    search(page),
    row(page, 'The order form').getByRole('button', { name: 'Send again' }),
    pages(page).getByRole('button', { name: 'Next' }),
  ];
  const before = await Promise.all(reachable.map(box));

  worker.read = 'waits';
  await page.getByRole('button', { name: /Any status/ }).click();
  await page.getByRole('option', { name: 'New', exact: true }).click();
  await expect(page).toHaveURL(/stage=new/);
  await page.waitForTimeout(300);
  // The answer is held: the eight rows are still there, and nothing moved.
  await expect(rows(page)).toHaveCount(8);
  await expect(page.getByText('Loading…')).toHaveCount(0);
  expect(await Promise.all(reachable.map(box))).toEqual(before);

  worker.release();
  await expect(rows(page)).toHaveCount(2);
});

test('the first read says « Loading… », and draws no state before its answer', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'waits';
  await open(page);
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  await expect(page.getByText(/No note/)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  worker.release();
  await expect(rows(page)).toHaveCount(8);
});

test('a guest reads no place, no reference, no chip and no « Send again »', async ({ page }) => {
  await workerWith(page, 'guest');
  await open(page);
  await expect(rows(page)).toHaveCount(8);
  await expect(page.getByRole('group', { name: 'Where the notes went' })).toHaveCount(0);
  await expect(table(page).getByRole('link', { name: /ACM-/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send again' })).toHaveCount(0);
  // The route does not search a reference for a guest, and the field does not say it does.
  await expect(search(page)).toHaveAttribute('placeholder', 'Search the text or the page');
  // The worker tells a guest nothing of where a note went: no column for it.
  await expect(table(page).locator('thead th')).toHaveText(['Note', 'Status', 'Left by', 'When']);
  await expect(page.getByText('Not delivered yet')).toHaveCount(0);
});

test('a member reads « Not delivered yet » and sends nothing again', async ({ page }) => {
  await workerWith(page, 'member');
  await open(page);
  await expect(row(page, 'The order form').getByText('Not delivered yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send again' })).toHaveCount(0);
});

test('the Sites screen leads here: « see where every note went »', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const link = page.getByRole('link', { name: 'see where every note went' });
  await expect(link).toHaveAttribute('href', '/w/w1/notes');
  await link.click();
  await expect(page.locator('main h1')).toHaveText('Notes');
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px the page does not scroll sideways, and each note is a card, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await workerWith(page, 'owner', locale);
    await page.goto(`${CONSOLE}/w/w1/notes`);
    await expect(page.locator('tbody tr')).toHaveCount(8);
    expect.soft(await sideScroll(page)).toBe(0);
    // Under 640 px a row is a card (FRU-505): the frame does not scroll, and no cell is past it.
    const frame = page.locator('.kit-table');
    expect.soft(await frame.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    expect
      .soft(
        await page
          .locator('tbody tr')
          .first()
          .evaluate((row) => getComputedStyle(row).display),
      )
      .toBe('flex');
    await expectNoViolation(page, `390 px, ${locale}`);
  });
}

test('a source its workspace named is called by its name, on its chip and in its rows (FRU-404)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.connectors = [{ ...(CONNECTORS[0] as object), name: 'Clients' }, CONNECTORS[1]];
  await open(page);
  await expect(chips(page)).toHaveText(['All10', 'Clients6', 'REST API3', 'In Fruitback1']);
  await expect(rows(page).getByText('Clients', { exact: true }).first()).toBeVisible();
  await expect(rows(page).getByText('Linear', { exact: true })).toHaveCount(0);
  // A source with no name keeps the name of its kind.
  await expect(rows(page).getByText('REST API', { exact: true }).first()).toBeVisible();
});

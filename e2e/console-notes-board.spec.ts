import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The board of the notes (FRU-436): « Table » and « Board » above the notes, the choice kept in the
 * address (`?view=board`), a column per status of the site in view in the order of its statuses, or
 * per stage when several sites are in view, and the same filters as the table. A note the person may
 * move is dragged to another column, or moved with the select of its card. The worker is answered by
 * stubs at the shape of `GET …/notes` and `POST …/notes/<note>/status` (FRU-384).
 */
const CONSOLE = 'http://localhost:5178';
const SITE = { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' };
const OTHER = { id: 's2', origin: 'https://client.fr', visibility: 'members' };
const page = (path: string) => ({ url: `https://staging.acme.dev${path}`, host: 'staging.acme.dev', path });
const AT = '2026-10-20T10:00:00.000Z';

/** The statuses of the site: the team added « Waiting » and hid « Parked ». */
const STATUSES = [
  { key: 'own:waiting', name: 'Waiting', stage: 'todo', color: '#2563eb', textColor: '#ffffff' },
  { key: 'own:parked', name: 'Parked', stage: 'todo', color: '#7c3aed', textColor: '#ffffff', hidden: true },
  { key: 'own:new', name: '', stage: 'new' },
  { key: 'own:todo', name: '', stage: 'todo' },
  { key: 'own:progress', name: '', stage: 'progress' },
  { key: 'own:done', name: 'Shipped', stage: 'done' },
  { key: 'own:closed', name: '', stage: 'closed' },
];

/** Ana's note, kept by the worker; Ben's, in the hidden status; and a note in Linear. */
function notes() {
  return [
    {
      id: 'n1',
      excerpt: 'The headline runs to three lines on a phone.',
      page: page('/'),
      site: { id: 's1' },
      stage: 'new',
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'fruitback' },
      status: 'own:new',
      canSetStatus: true,
      createdAt: AT,
    },
    {
      id: 'n2',
      excerpt: 'The price of the yearly plan is wrong.',
      page: page('/pricing'),
      site: { id: 's1' },
      stage: 'todo',
      author: { kind: 'member', name: 'Ben' },
      place: { kind: 'fruitback' },
      status: 'own:parked',
      canSetStatus: false,
      createdAt: AT,
    },
    {
      id: 'n3',
      excerpt: 'The returns policy says "recieve".',
      page: page('/help'),
      site: { id: 's1' },
      stage: 'progress',
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'linear', connector: 'c1', label: 'Acme' },
      ref: 'ACM-149',
      url: 'https://linear.app/acme/issue/ACM-149',
      createdAt: AT,
    },
  ];
}

type Worker = {
  sent: { path: string; body: unknown }[];
  asked: URLSearchParams[];
  refuse: { status: number; error: string } | undefined;
};

async function workerWith(
  page: Page,
  options: { locale?: 'en' | 'fr'; sites?: readonly unknown[] } = {},
): Promise<Worker> {
  const worker: Worker = { sent: [], asked: [], refuse: undefined };
  const kept = notes();
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    if (pathname === '/console/workspaces/w1/connectors') {
      return route.fulfill({ json: { connectors: [{ id: 'c1', kind: 'linear', label: 'Acme', createdAt: AT }] } });
    }
    const status = /^\/console\/workspaces\/w1\/notes\/(\w+)\/status$/.exec(pathname);
    if (status !== null && request.method() === 'POST') {
      const body = request.postDataJSON() as { status: string };
      worker.sent.push({ path: pathname, body });
      if (worker.refuse !== undefined) return route.fulfill({ status: worker.refuse.status, json: worker.refuse });
      const chosen = STATUSES.find((one) => one.key === body.status)!;
      const note = kept.find((one) => one.id === status[1])!;
      note.status = body.status;
      note.stage = chosen.stage;

      return route.fulfill({ json: { status: body.status, stage: chosen.stage } });
    }
    if (pathname !== '/console/workspaces/w1/notes') return undefined;
    const query = new URL(request.url()).searchParams;
    worker.asked.push(query);
    const stage = query.get('stage');
    const listed = stage === null ? kept : kept.filter((note) => note.stage === stage);

    return route.fulfill({
      json: { notes: listed, total: listed.length, counts: { all: kept.length }, statuses: { s1: STATUSES } },
    });
  };
  await stubWorker(page, {
    locale: options.locale ?? 'en',
    workspaces: [ACME],
    sites: options.sites ?? [SITE],
    answer,
  });

  return worker;
}

/** A column by the name of its status, as its heading writes it before the count. */
const column = (page: Page, name: string) =>
  page
    .locator('section[data-column]')
    .filter({ has: page.locator('h2 span.truncate', { hasText: new RegExp(`^${name}$`) }) });
const card = (page: Page, excerpt: string) => page.locator('li[data-note]').filter({ hasText: excerpt });

async function expectNoViolation(page: Page): Promise<void> {
  // A list of HeroUI fades in: axe reads it once it is there.
  await page.waitForTimeout(250);
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

test('« Board » shows a column per status of the site, in its order, and the address keeps it', async ({ page }) => {
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const views = page.getByRole('group', { name: 'Show the notes as' });
  await expect(views.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');

  await views.getByRole('button', { name: 'Board' }).click();
  await expect(page).toHaveURL(/[?&]view=board/);
  await expect(views.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('table')).toHaveCount(0);
  const board = page.getByRole('region', { name: 'Notes by status' });
  // The hidden « Parked » is there because Ben's note is in it. A built-in status the team did not
  // rename is named by its stage.
  await expect(board.getByRole('heading', { level: 2 })).toHaveText([
    /^Waiting/,
    /^Parked/,
    /^New/,
    /^To do/,
    /^In progress/,
    /^Shipped/,
    /^Closed/,
  ]);
  await expect(column(page, 'New').locator('li')).toHaveText([/The headline/]);
  await expect(column(page, 'Parked').locator('li')).toHaveText([/The price/]);
  // The note in Linear has a stage only: it is in the built-in status of its stage.
  await expect(column(page, 'In progress').locator('li')).toHaveText([/The returns policy/]);
  await expect(column(page, 'Waiting').getByText('No note here.')).toBeVisible();

  // A reload keeps the board; « Table » takes it out of the address.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Notes by status' })).toBeVisible();
  await page.getByRole('button', { name: 'Table' }).click();
  await expect(page).not.toHaveURL(/view=board/);
  await expect(page.locator('tbody tr')).toHaveCount(3);
});

test('the board has the filters of the table, and a filter keeps the board', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await expect(card(page, 'The headline')).toBeVisible();

  await page.getByRole('button', { name: /Any status/ }).click();
  await page.getByRole('option', { name: 'In progress', exact: true }).click();
  await expect(page).toHaveURL(/stage=progress/);
  await expect(page).toHaveURL(/view=board/);
  expect(worker.asked.at(-1)?.get('stage')).toBe('progress');
  await expect(page.locator('li[data-note]')).toHaveCount(1);
  await expect(column(page, 'In progress').locator('li')).toHaveText([/The returns policy/]);
});

test('a note is dragged to another status, and the worker saves it', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await expect(card(page, 'The headline')).toBeVisible();
  // Ben's note and the note in Linear do not move: Ana may not, and Linear keeps its status.
  await expect(card(page, 'The price')).toHaveAttribute('draggable', 'false');
  await expect(card(page, 'The returns policy')).toHaveAttribute('draggable', 'false');

  await card(page, 'The headline').dragTo(column(page, 'Waiting'));
  await expect(column(page, 'Waiting').locator('li')).toHaveText([/The headline/]);
  await expect(column(page, 'New').getByText('No note here.')).toBeVisible();
  expect(worker.sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/status', body: { status: 'own:waiting' } }]);

  // Dropped on the hidden status, nothing is sent: no note goes in it.
  await card(page, 'The headline').dragTo(column(page, 'Parked'));
  await page.waitForTimeout(200);
  expect(worker.sent).toHaveLength(1);
  await expect(column(page, 'Waiting').locator('li')).toHaveText([/The headline/]);
});

test('a refused move is said, and the note stays where it was', async ({ page }) => {
  const worker = await workerWith(page);
  worker.refuse = { status: 403, error: 'not-allowed' };
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await card(page, 'The headline').dragTo(column(page, 'To do'));
  await expect.poll(() => worker.sent.length).toBe(1);
  await expect(page.getByRole('alert')).toHaveText(
    'Only the person who left this note, or an owner or an admin, changes its status.',
  );
  await expect(column(page, 'New').locator('li')).toHaveText([/The headline/]);
});

test('the keyboard moves a note with the select of its card', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  const select = card(page, 'The headline').getByRole('button', { name: /Status of this note/ });
  await select.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('option', { name: 'Shipped', exact: true })).toBeVisible();
  await page.getByRole('option', { name: 'Shipped', exact: true }).focus();
  await page.keyboard.press('Enter');

  await expect(column(page, 'Shipped').locator('li')).toHaveText([/The headline/]);
  expect(worker.sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/status', body: { status: 'own:done' } }]);
});

test('with several sites in view, a column is a stage', async ({ page }) => {
  await workerWith(page, { sites: [SITE, OTHER] });
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  const board = page.getByRole('region', { name: 'Notes by status' });
  await expect(board.getByRole('heading', { level: 2 })).toHaveText([
    /^New/,
    /^To do/,
    /^In progress/,
    /^Done/,
    /^Closed/,
  ]);
  await expect(column(page, 'To do').locator('li')).toHaveText([/The price/]);
  // No status is the column: nothing is dragged.
  await expect(card(page, 'The headline')).toHaveAttribute('draggable', 'false');
});

for (const width of [1440, 390]) {
  test(`at ${width} px the board scrolls in its frame, never the page, and axe finds nothing`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await workerWith(page);
    await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
    const board = page.getByRole('region', { name: 'Notes by status' });
    await expect(card(page, 'The headline')).toBeVisible();
    expect(await sideScroll(page)).toBe(0);
    // Seven columns of 272 px are wider than either screen: the frame scrolls.
    expect(await board.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expectNoViolation(page);
  });
}

test('in French', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fruitback:locale', 'fr'));
  await workerWith(page, { locale: 'fr' });
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await page.getByRole('group', { name: 'Afficher les notes en' }).getByRole('button', { name: 'Tableau' }).click();
  await expect(page.getByRole('region', { name: 'Notes par statut' })).toBeVisible();
  // A built-in status is named by its stage, in French; a status the team named keeps its name.
  await expect(column(page, 'Nouveau').locator('li')).toHaveText([/The headline/]);
  await expect(column(page, 'Waiting').getByText('Aucune note ici.')).toBeVisible();
  await expectNoViolation(page);
});

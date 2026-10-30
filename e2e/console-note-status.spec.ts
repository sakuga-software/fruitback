import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, painted, rgb, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The status of a note in the list of the notes (FRU-384), in a browser. The worker is answered by
 * stubs at the shape of the route of #505: `GET …/notes` gives each note the worker keeps its `status`
 * and `canSetStatus`, and `statuses` per site; `POST …/notes/<note>/status` takes `{ status }`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const LINEAR = { kind: 'linear', connector: 'c1', label: 'Acme' };
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

/** Ana's note, kept by the worker; Ben's, kept too; and a note in Linear. */
const NOTES = [
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
    place: LINEAR,
    ref: 'ACM-149',
    url: 'https://linear.app/acme/issue/ACM-149',
    createdAt: AT,
  },
];

type Worker = { sent: { path: string; body: unknown }[]; refuse: { status: number; error: string } | undefined };

async function workerWith(page: Page, role: Role = 'member', locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { sent: [], refuse: undefined };
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
      const chosen = STATUSES.find((one) => one.key === body.status);

      return route.fulfill({ json: { status: body.status, stage: chosen?.stage } });
    }
    if (pathname !== '/console/workspaces/w1/notes') return undefined;

    return route.fulfill({
      json: { notes: NOTES, total: NOTES.length, counts: { all: NOTES.length }, statuses: { s1: STATUSES } },
    });
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], sites: SITES, answer });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await expect(page.locator('tbody tr')).toHaveCount(NOTES.length);
}

const row = (page: Page, excerpt: string) => page.locator('tbody tr').filter({ hasText: excerpt });

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

test('the author chooses the status of a note kept in Fruitback, among the shown statuses of its site', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  // Ana's note: a select, named for a screen reader, on its status. A built-in status the team did not
  // rename is named by its stage.
  const select = row(page, 'The headline').getByRole('button', { name: /Status of this note/ });
  await expect(select).toContainText('New');
  await select.click();
  // The hidden status is not offered; the renamed built-in one is offered by its name.
  await expect(page.getByRole('option')).toHaveText(['Waiting', 'New', 'To do', 'In progress', 'Shipped', 'Closed']);
  await page.getByRole('option', { name: 'Waiting', exact: true }).click();

  await expect(select).toContainText('Waiting');
  expect(worker.sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/status', body: { status: 'own:waiting' } }]);
  await expect(row(page, 'The headline').getByRole('alert')).toHaveCount(0);

  // Ben's note: Ana may not change it. Its status is named, hidden as it is, with no select.
  const bens = row(page, 'The price');
  await expect(bens.getByRole('button', { name: /Status of this note/ })).toHaveCount(0);
  await expect(bens.locator('td').nth(2)).toHaveText('Parked');
  // The note in Linear shows its stage: its status changes in Linear.
  const tracked = row(page, 'The returns policy');
  await expect(tracked.getByRole('button', { name: /Status of this note/ })).toHaveCount(0);
  await expect(tracked.locator('td').nth(2)).toHaveText('In progress');

  await expectNoViolation(page, 'the list with a select');
});

test('the drop of a status takes its colour, or the one of its stage when the team gave none (FRU-385)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  const mine = row(page, 'The headline');
  const select = mine.getByRole('button', { name: /Status of this note/ });
  const drop = select.locator('.kit-drop');

  // « New » is built-in, with no colour of the team: its drop is the one of its stage.
  await select.click();
  const option = (name: string) => page.getByRole('option', { name, exact: true }).locator('.kit-drop');
  const stageNew = await painted(option('New'), 'backgroundColor');
  expect(await painted(drop, 'backgroundColor')).toEqual(stageNew);
  expect(stageNew).not.toEqual(rgb('#2563eb'));
  // Each status of the list has its drop: « Waiting » in its colour, « To do » in the one of its stage.
  expect(await painted(option('Waiting'), 'backgroundColor')).toEqual(rgb('#2563eb'));
  expect(await painted(option('To do'), 'backgroundColor')).not.toEqual(rgb('#2563eb'));
  await page.getByRole('option', { name: 'Waiting', exact: true }).click();

  // Chosen, the drop of the select takes the colour of « Waiting », and keeps its edge.
  await expect(select).toContainText('Waiting');
  expect(await painted(drop, 'backgroundColor')).toEqual(rgb('#2563eb'));
  expect(await drop.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe('none');
  // A status shown with no select, « Parked », is drawn in its colour too.
  expect(await painted(row(page, 'The price').locator('.kit-drop'), 'backgroundColor')).toEqual(rgb('#7c3aed'));
});

for (const [error, sentence] of [
  ['status-hidden', 'This status is hidden now, so no note goes in it. Choose another one.'],
  ['status-changed', 'This status was removed from the site since the list was read. Reload the page.'],
  ['not-allowed', 'Only the person who left this note, or an owner or an admin, changes its status.'],
] as const) {
  test(`a refusal (${error}) is said under the select, which keeps the choice`, async ({ page }) => {
    const worker = await workerWith(page);
    worker.refuse = { status: error === 'not-allowed' ? 403 : 409, error };
    await open(page);

    const select = row(page, 'The headline').getByRole('button', { name: /Status of this note/ });
    const cell = row(page, 'The headline').locator('td').nth(2);
    const width = (await cell.boundingBox())?.width;
    await select.click();
    await page.getByRole('option', { name: 'Shipped', exact: true }).click();

    await expect(row(page, 'The headline').getByRole('alert')).toHaveText(sentence);
    // The sentence wraps under the select: the column keeps its width.
    expect((await cell.boundingBox())?.width).toBe(width);
    // What the person chose stays chosen: nothing is undone behind their back.
    await expect(select).toContainText('Shipped');
    await expect(select).toBeEnabled();
  });
}

test('a refusal is said in French, under the select', async ({ page }) => {
  const worker = await workerWith(page, 'member', 'fr');
  worker.refuse = { status: 409, error: 'status-hidden' };
  await open(page);

  const select = row(page, 'The headline').getByRole('button', { name: /Statut de cette note/ });
  await expect(select).toContainText('Nouveau');
  await select.click();
  await page.getByRole('option', { name: 'Waiting', exact: true }).click();
  await expect(row(page, 'The headline').getByRole('alert')).toHaveText(
    'Ce statut est désormais masqué : aucune note n’y entre. Choisissez-en un autre.',
  );
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px the page does not scroll sideways with a select and a refusal, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const worker = await workerWith(page, 'owner', locale);
    worker.refuse = { status: 409, error: 'status-changed' };
    await open(page);
    const select = row(page, 'The headline').getByRole('button', {
      name: locale === 'en' ? /Status of this note/ : /Statut de cette note/,
    });
    await select.click();
    await page.getByRole('option', { name: 'Waiting', exact: true }).click();
    await expect(row(page, 'The headline').getByRole('alert')).toBeVisible();

    // The list of the select fades out: it is measured once gone, as the page stays.
    await expect(page.getByRole('listbox')).toHaveCount(0);
    expect.soft(await sideScroll(page)).toBe(0);
    await expectNoViolation(page, `390 px, ${locale}`);
  });
}

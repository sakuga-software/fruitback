import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { LUMEN, type StubbedWorkspace, box, contrast, painted, rgb, stubWorker, styles } from './console-workspace.ts';

/**
 * The views of the bar (FRU-697), under its sections: a filter of the Notes screen, with a name and a
 * count, as option A of the mockup of FRU-684 draws them (« Barre latérale (3 options) », attached to
 * FRU-697). A view is a link to the address of its filter.
 *
 * The three views of the mockup: « New this week » (`created=week`, which the Notes screen asks the
 * worker as `since`), « Assigned to me » (`assignee=me`) and « Not delivered » (`undelivered=1`,
 * FRU-722). The count of a view is the one of the read of the bar (FRU-711), then the total the worker
 * answered to the Notes screen for that filter: no screen reads the notes for it.
 */
const CONSOLE = 'http://localhost:5178';
const KIT = 'http://localhost:5179';

/** The values of the mockup. */
const BAR = '#f1f4f8';
const ACTIVE = '#e2e8f0';
const SECONDARY = '#5b6779';
const ENTRY_TEXT = '#334155';

const rail = (page: Page) => page.locator('aside.kit-rail');
const views = (page: Page) => rail(page).getByRole('navigation', { name: 'Views' });
const assigned = (page: Page) => views(page).getByRole('link', { name: /^Assigned to me/ });
const fresh = (page: Page) => views(page).getByRole('link', { name: /^New this week/ });
const undelivered = (page: Page) => views(page).getByRole('link', { name: /^Not delivered/ });
const sections = (page: Page) => rail(page).getByRole('navigation', { name: 'Workspace' });

/** A note given to the person: a task Fruitback keeps. */
const NOTE = {
  id: 'n1',
  excerpt: 'The button is cut on a phone',
  page: { url: 'https://acme.dev/pricing', host: 'acme.dev', path: '/pricing' },
  site: { id: 's1' },
  stage: 'todo',
  author: { kind: 'anonymous' },
  status: 'own:todo',
  canSetStatus: true,
  task: { assignee: { id: 'a1', name: 'Ana' }, labels: [] },
  createdAt: '2026-10-13T12:00:00.000Z',
};

/** A note an address did not take: « Send again » is a write, and the list is read again after it. */
const LATE = {
  ...NOTE,
  id: 'n2',
  excerpt: 'The menu closes too fast',
  stage: 'new',
  status: 'own:new',
  task: { labels: [] },
  place: { kind: 'rest', connector: 'c2', label: 'hooks.acme.dev/feedback' },
  delivery: { id: 'd2', state: 'gave-up' },
};

type Worker = {
  asked: { pathname: string; query: string }[];
  total: number;
  /** FRU-722: the notes not delivered are none. */
  noneLate?: boolean;
  /** Holds the answer of the next read that is not of the view, until it settles. */
  hold?: Promise<void>;
};

/**
 * A worker that answers the notes: `total` notes for `assignee=me`, and 12 for every other filter. It
 * keeps each read of the notes, so a spec can say which screen asked for which.
 */
async function workerWith(page: Page, workspaces?: StubbedWorkspace[], locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { asked: [], total: 4 };
  await stubWorker(page, {
    locale,
    ...(workspaces === undefined ? {} : { workspaces }),
    answer: (pathname: string, route: Route) => {
      if (/^\/console\/workspaces\/w\d\/notes\/n2\/retry$/.test(pathname)) return route.fulfill({ status: 204 });
      if (!/^\/console\/workspaces\/w\d\/notes$/.test(pathname)) return undefined;
      const query = new URL(route.request().url()).searchParams;
      worker.asked.push({ pathname, query: query.toString() });
      const mine = query.get('assignee') === 'me';
      // FRU-722: 7 notes left this week, 2 that did not arrive.
      let total = mine ? worker.total : 12;
      if (query.has('since')) total = 7;
      if (query.get('undelivered') === '1') total = 2;
      const held = mine ? undefined : worker.hold;
      worker.hold = undefined;

      const none = worker.noneLate === true && query.get('undelivered') === '1';
      let notes = mine ? [NOTE] : [NOTE, LATE];
      if (none) [total, notes] = [0, []];
      const fulfil = () =>
        route.fulfill({
          json: {
            notes,
            total,
            counts: { all: total, byPlace: {}, byStage: { todo: total } },
          },
        });

      return held === undefined ? fulfil() : held.then(fulfil);
    },
  });

  return worker;
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`${CONSOLE}${path}`);
  await expect(page.locator('main h1')).toBeVisible();
}

test('at 1440 px the views have the values of the mockup, under the sections', async ({ page }) => {
  await stubWorker(page);
  await page.goto(`${KIT}/kit/frame`);
  await expect(views(page)).toBeVisible();

  // « Views »: 600 11px in the secondary text, 8 px in.
  const heading = views(page).getByText('Views', { exact: true });
  expect.soft(await styles(heading, ['font-size', 'font-weight', 'padding-left'])).toEqual({
    'font-size': '11px',
    'font-weight': '600',
    'padding-left': '8px',
  });
  expect.soft(await painted(heading, 'color')).toEqual(rgb(SECONDARY));
  expect.soft(contrast(await painted(heading, 'color'), rgb(BAR))).toBeGreaterThanOrEqual(4.5);

  // The boxes of the mockup: « Settings » at 164, « Views » at 263, the first view at 279.
  const settings = await box(sections(page).getByRole('link', { name: 'Settings' }));
  const entry = await box(fresh(page));
  const words = await box(heading);
  expect.soft(settings.y).toBeCloseTo(48 + 29 * 4, 0);
  expect.soft(entry.y - (settings.y + settings.height)).toBeCloseTo(31, 0);
  // As wide as a section, from the same edge.
  expect.soft(entry.x).toBeCloseTo(settings.x, 0);
  expect.soft(entry.width).toBeCloseTo(settings.width, 0);
  expect.soft(entry.height).toBeCloseTo(28, 0);
  // The words of « Views » sit 15 px under « Settings », and 5 px over the first view.
  expect.soft(Math.abs(words.y + 7 - (settings.y + settings.height + 15))).toBeLessThanOrEqual(1);

  // The entry is one of the bar: 28 px, 8 px in, 500 in the words of an entry, its count at the right.
  expect.soft(await styles(assigned(page), ['height', 'padding-left', 'column-gap', 'font-weight'])).toEqual({
    height: '28px',
    'padding-left': '8px',
    'column-gap': '8px',
    'font-weight': '500',
  });
  expect.soft(await painted(assigned(page), 'color')).toEqual(rgb(ENTRY_TEXT));
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 4');
  const count = assigned(page).locator('span').last();
  expect.soft(await styles(count, ['font-size', 'font-weight'])).toEqual({ 'font-size': '12px', 'font-weight': '500' });
  expect.soft(await painted(count, 'color')).toEqual(rgb(SECONDARY));

  // Its mark: the initial of the person on a disc of 16 px, on `avatar`, as at the foot of the bar.
  const mark = assigned(page).locator('[data-view-mark]');
  await expect(mark).toHaveText('A');
  await expect(mark).toHaveAttribute('aria-hidden', 'true');
  expect.soft(await styles(mark, ['width', 'height'])).toEqual({ width: '16px', height: '16px' });
  const foot = rail(page).getByRole('button', { name: /@/ }).locator('span[aria-hidden="true"]').first();
  expect.soft(await painted(mark, 'backgroundColor')).toEqual(await painted(foot, 'backgroundColor'));
});

test('a view opens the notes with its filter in the address, and is the entry on screen', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page, '/w/w1/sites');
  await expect(assigned(page)).toHaveAttribute('href', '/w/w1/notes?assignee=me');
  await assigned(page).click();

  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?assignee=me`);
  await expect.poll(() => worker.asked.at(-1)?.query ?? '').toContain('assignee=me');
  // The chip of the filter says what the list shows (FRU-686).
  await expect(page.locator('main').getByText('Me', { exact: true })).toBeVisible();
  // The view is the entry on screen, and « Notes » is not: one entry alone is on screen.
  await expect(assigned(page)).toHaveAttribute('aria-current', 'page');
  await expect(rail(page).locator('[aria-current="page"]')).toHaveCount(1);
  expect.soft(await painted(assigned(page), 'backgroundColor')).toEqual(rgb(ACTIVE));
  expect.soft(await styles(assigned(page), ['font-weight'])).toEqual({ 'font-weight': '600' });

  // A filter more is another list: « Notes » is the entry on screen again.
  await page.goto(`${CONSOLE}/w/w1/notes?assignee=me&site=s1`);
  await expect(page.locator('main h1')).toBeVisible();
  await expect(assigned(page)).not.toHaveAttribute('aria-current', 'page');
  await expect(sections(page).getByRole('link', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
  // The board, a page or a task opened are no filter: still the view.
  await page.goto(`${CONSOLE}/w/w1/notes?assignee=me&view=board`);
  await expect(page.locator('main h1')).toBeVisible();
  await expect(assigned(page)).toHaveAttribute('aria-current', 'page');
});

test('the count of a view is the total the notes read for its filter, and no screen reads the notes for it', async ({
  page,
}) => {
  const worker = await workerWith(page);
  // On another screen, before the notes read the filter, and with no read of the bar (the stub does
  // not answer it): no count, and no read of the notes at all.
  await open(page, '/w/w1/sites');
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me');
  await expect(assigned(page).locator('span')).toHaveCount(2);
  await page.waitForLoadState('networkidle');
  expect(worker.asked).toEqual([]);

  // The notes with no filter count 12: that is not the count of the view.
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  await expect.poll(() => worker.asked.length).toBe(1);
  await expect(page.locator('main').getByText('The button is cut on a phone')).toBeVisible();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me');

  // The view read its filter: 4.
  await assigned(page).click();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 4');

  // The count stays on another screen, which reads no note for it.
  const before = worker.asked.length;
  await sections(page).getByRole('link', { name: 'Members' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/members`);
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 4');
  await page.waitForLoadState('networkidle');
  expect(worker.asked.length).toBe(before);

  // A read of the view later says the number of now.
  worker.total = 5;
  await assigned(page).click();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 5');

  // A write on another list can change what the view counts: once the list is read again after it,
  // the count goes, until the view is read again. The read of the list alone left it (above).
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  await expect(page.locator('main').getByText('The menu closes too fast')).toBeVisible();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 5');
  const reads = worker.asked.length;
  await page.locator('main').getByRole('button', { name: 'Send again' }).click();
  await expect.poll(() => worker.asked.length).toBe(reads + 1);
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me');
  await assigned(page).click();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 5');

  // The count goes when the read after a write starts, not when it is answered: a filter chosen
  // meanwhile drops that answer, and the count of before the write must not stay (raised in review).
  await sections(page).getByRole('link', { name: 'Notes' }).click();
  await expect(page.locator('main').getByText('The menu closes too fast')).toBeVisible();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 5');
  let release: () => void = () => {};
  worker.hold = new Promise<void>((resolve) => (release = resolve));
  await page.locator('main').getByRole('button', { name: 'Send again' }).click();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Status', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Unresolved', exact: true }).click();
  await expect(page).toHaveURL(/unresolved=1/);
  release();
  await expect.poll(() => worker.asked.at(-1)?.query ?? '').toContain('unresolved=1');
  await expect(page.locator('main').getByText('The menu closes too fast')).toBeVisible();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me');

  // Another workspace forgets the count: it was of the first one.
  await page.goto(`${CONSOLE}/w/w2/sites`);
  await expect(page.locator('main h1')).toBeVisible();
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me');
});

test('the read of the bar counts a view at once, and a count the Notes screen said is not written over (FRU-711)', async ({
  page,
}) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let holding = false;
  const worker = await workerWith(page);
  // The read of the bar, before the stubs of `workerWith`: 4 for the view, held when a case asks.
  await page.route(/\/console\/workspaces\/w1\/rail(\?|$)/, async (route) => {
    if (holding) await held;
    await route.fulfill({ json: { sites: 1, notes: 12, failing: 0, views: { assigned: 4 } } });
  });

  // On another screen: the count of the bar, and still no read of the notes.
  await open(page, '/w/w1/sites');
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 4');
  await page.waitForLoadState('networkidle');
  expect(worker.asked).toEqual([]);

  // The Notes screen reads 5 for the view while the read of the bar is on its way: its answer, 4,
  // comes after, and does not take the place of the newer count.
  worker.total = 5;
  holding = true;
  await open(page, '/w/w1/notes?assignee=me');
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 5');
  release();
  await page.waitForLoadState('networkidle');
  await expect(assigned(page)).toHaveAccessibleName('Assigned to me 5');
});

test('a guest has « New this week » alone: no task is theirs, nor where a note went', async ({ page }) => {
  await workerWith(page, [{ ...LUMEN, id: 'w1', role: 'guest' }]);
  await open(page, '/w/w1/notes');
  await expect(sections(page)).toBeVisible();
  await expect(views(page).getByRole('link')).toHaveCount(1);
  await expect(fresh(page)).toBeVisible();
  // Nor the filter on the deliveries in « Filter ».
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Left', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delivery', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // The control: a member of the same workspace has the three, and the filter.
  await workerWith(page, [{ ...LUMEN, id: 'w1', role: 'member' }]);
  await open(page, '/w/w1/notes');
  await expect(views(page).getByRole('link')).toHaveText([/New this week/, /Assigned to me/, /Not delivered/]);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Delivery', exact: true })).toBeVisible();
});

test('« New this week » asks the notes left since midnight six days ago, and says it in a chip (FRU-722)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page, '/w/w1/sites');
  await expect(fresh(page)).toHaveAttribute('href', '/w/w1/notes?created=week');
  await fresh(page).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?created=week`);
  await expect.poll(() => worker.asked.at(-1)?.query ?? '').toContain('since=');
  const asked = new URLSearchParams(worker.asked.at(-1)?.query);
  // The day of the browser: midnight, six days before today.
  const expected = await page.evaluate(() => {
    const now = new Date();

    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime();
  });
  expect(Number(asked.get('since'))).toBe(expected);
  // The worker is not asked a filter it does not read.
  expect(asked.has('created')).toBe(false);
  await expect(fresh(page)).toHaveAttribute('aria-current', 'page');
  await expect(fresh(page)).toHaveAccessibleName('New this week 7');
  const chips = page.getByRole('group', { name: 'Filters on' });
  await expect(chips).toContainText('Left');
  await expect(chips).toContainText('This week');
  // Its cross takes it away: the list of every note, and « Notes » on screen.
  await chips.getByRole('button', { name: 'Remove the filter Left: This week' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes`);
  await expect(sections(page).getByRole('link', { name: /^Notes/ })).toHaveAttribute('aria-current', 'page');
});

test('« Not delivered » asks the notes whose delivery did not arrive, and its count is red (FRU-722)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page, '/w/w1/sites');
  await expect(undelivered(page)).toHaveAttribute('href', '/w/w1/notes?undelivered=1');
  await undelivered(page).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?undelivered=1`);
  await expect.poll(() => worker.asked.at(-1)?.query ?? '').toContain('undelivered=1');
  await expect(undelivered(page)).toHaveAccessibleName('Not delivered 2');
  await expect(page.getByRole('group', { name: 'Filters on' })).toContainText('Not delivered');
  // Red, as the mockup draws it, with no dot: the dot says a failure of a connector.
  const count = undelivered(page).locator('[data-alert-count]');
  expect.soft(await painted(count, 'color')).toEqual(rgb('#b91c1c'));
  await expect(undelivered(page).locator('[data-failing]')).toHaveCount(0);
  // Its braces are red too, and the circle of « New this week » is not.
  expect.soft(await painted(undelivered(page).locator('[data-view-mark]'), 'color')).toEqual(rgb('#b91c1c'));
  expect.soft(await painted(fresh(page).locator('[data-view-mark]'), 'color')).not.toEqual(rgb('#b91c1c'));

  // The filter is in « Filter » too, and chosen there it is the same view.
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await expect(page.locator('main h1')).toBeVisible();
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delivery', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Not delivered', exact: true }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes?undelivered=1`);
  await expect(undelivered(page)).toHaveAttribute('aria-current', 'page');
});

test('« Clear the filters » of an empty list clears « Left » and « Delivery » too (FRU-722)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.noneLate = true;
  await open(page, '/w/w1/notes?undelivered=1&created=week');
  await expect(page.locator('main').getByText('No note matches.')).toBeVisible();
  await page.locator('main').getByRole('button', { name: 'Clear the filters' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/notes`);
});

test('a count of « Not delivered » of zero is not red', async ({ page }) => {
  await stubWorker(page, {
    answer: (pathname, route) =>
      /\/console\/workspaces\/w1\/rail$/.test(pathname)
        ? route.fulfill({ json: { sites: 1, notes: 3, failing: 0, views: { new: 0, assigned: 0, undelivered: 0 } } })
        : undefined,
  });
  await open(page, '/w/w1/sites');
  await expect(undelivered(page)).toHaveAccessibleName('Not delivered 0');
  await expect(undelivered(page).locator('[data-alert-count]')).toHaveCount(0);
});

test('the views speak French, and the bar with them passes axe', async ({ page }) => {
  await workerWith(page, undefined, 'fr');
  await open(page, '/w/w1/notes?assignee=me');
  const vues = rail(page).getByRole('navigation', { name: 'Vues' });
  await expect(vues.getByRole('link')).toHaveCount(3);
  await expect(vues.getByRole('link', { name: /^Assignées à moi/ })).toHaveAccessibleName('Assignées à moi 4');
  await expect(vues.getByRole('link').first()).toHaveAccessibleName(/^Nouvelles cette semaine/);
  await expect(vues.getByRole('link').last()).toHaveAccessibleName(/^Non livrées/);
  const results = await new AxeBuilder({ page }).include('aside.kit-rail').analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
});

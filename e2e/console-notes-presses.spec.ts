import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * A press of « Next page » while a page is read (FRU-709): each press goes on from the page asked
 * last, not from the page shown. Before, a second press during the read of the next page asked the
 * same cursor again, and was lost: the list went one page on instead of two. A slow CI made
 * `console-notes-pages.spec.ts` fail on it.
 *
 * The worker is answered by stubs, and holds the read of a page until the spec lets it go: the
 * presses come while it is on its way, whatever the speed of the machine. 263 notes, 25 to a page,
 * the cursor the index of the first note of a page.
 */
const CONSOLE = 'http://localhost:5178';

const NOTES = Array.from({ length: 263 }, (_, n) => ({
  id: `n${n}`,
  excerpt: `Note ${n + 1} of the list`,
  page: { url: `https://acme.dev/p${n}`, host: 'acme.dev', path: `/p${n}` },
  site: { id: 's1' },
  stage: 'new',
  author: { kind: 'anonymous' },
  createdAt: new Date(Date.UTC(2026, 9, 13, 12) - n * 60_000).toISOString(),
}));

/** The reads of the worker, and a way to hold the read of one cursor until the spec lets it go. */
type Reads = { cursors: string[]; hold: (cursor: string) => () => void };

/** Answers `route` once the read of its cursor is let go; the cursors asked are kept, in order. */
function reads(): Reads & { answer: (cursor: string, answer: () => Promise<void>) => Promise<void> } {
  const cursors: string[] = [];
  const held = new Map<string, Promise<void>>();

  return {
    cursors,
    hold(cursor) {
      let release = () => {};
      held.set(cursor, new Promise<void>((resolve) => (release = resolve)));

      return release;
    },
    answer(cursor, answer) {
      cursors.push(cursor);

      return (held.get(cursor) ?? Promise.resolve()).then(answer);
    },
  };
}

async function open(page: Page): Promise<Reads> {
  const read = reads();
  await stubWorker(page, {
    workspaces: [ACME],
    answer: (pathname, route: Route) => {
      if (pathname !== '/console/workspaces/w1/notes') return undefined;
      const params = new URL(route.request().url()).searchParams;
      const cursor = params.get('cursor') ?? '';
      const start = cursor === '' ? 0 : Number(cursor.split(':')[1]);
      const limit = Number(params.get('limit') ?? 8);

      return read.answer(cursor, () =>
        route.fulfill({
          json: {
            notes: NOTES.slice(start, start + limit),
            total: NOTES.length,
            counts: { all: NOTES.length, byPlace: { fruitback: NOTES.length }, undelivered: 0 },
            ...(start + limit < NOTES.length ? { next: `all:${start + limit}` } : {}),
          },
        }),
      );
    },
  });
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await expect(summary(page)).toHaveText('1 to 25 of 263');

  return read;
}

const pages = (page: Page) => page.getByRole('navigation', { name: 'Pages of notes' });
const summary = (page: Page) => pages(page).locator('span').first();
const press = (page: Page, name: 'Next page' | 'Previous page') =>
  pages(page).getByRole('button', { name, exact: true }).click();
const firstRow = (page: Page) =>
  page.getByRole('region', { name: 'Notes' }).locator('tbody tr:not(.kit-table-group)').first();

/** Lets the effects of the last answer run: a press that waits for it goes on in them. */
const settled = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('two presses of « Next page » go two pages on, even when the second comes during the read', async ({ page }) => {
  const read = await open(page);
  const release = read.hold('all:25');
  await press(page, 'Next page');
  await expect.poll(() => read.cursors.at(-1)).toBe('all:25');
  // The second page is still on its way: the rows of the first are on the screen.
  await expect(firstRow(page)).toContainText('Note 1 of the list');
  await press(page, 'Next page');
  release();

  await expect(summary(page)).toHaveText('51 to 75 of 263');
  await expect(firstRow(page)).toContainText('Note 51 of the list');
  await expect(page).toHaveURL(/[?&]cursor=all%3A50(&|$)/);
  // Each page read once, in the order of the presses.
  expect(read.cursors).toEqual(['', 'all:25', 'all:50']);
  // The pages walked through are offered back.
  await expect(pages(page).getByRole('button', { name: 'Page 2', exact: true })).toBeVisible();
});

test('three presses during two held reads go three pages on, and the screen ends on the last one', async ({ page }) => {
  const read = await open(page);
  const second = read.hold('all:25');
  const third = read.hold('all:50');
  for (let presses = 0; presses < 3; presses += 1) await press(page, 'Next page');
  await expect.poll(() => read.cursors.at(-1)).toBe('all:25');
  second();
  await expect.poll(() => read.cursors.at(-1)).toBe('all:50');
  third();

  await expect(summary(page)).toHaveText('76 to 100 of 263');
  await expect(firstRow(page)).toContainText('Note 76 of the list');
  expect(read.cursors).toEqual(['', 'all:25', 'all:50', 'all:75']);
});

test('« Previous page » takes back a press of « Next page » that waits for its page', async ({ page }) => {
  const read = await open(page);
  const release = read.hold('all:25');
  await press(page, 'Next page');
  await expect.poll(() => read.cursors.at(-1)).toBe('all:25');
  await press(page, 'Next page');
  await press(page, 'Previous page');
  release();

  // Next, Next, Previous: one page on.
  await expect(summary(page)).toHaveText('26 to 50 of 263');
  await expect(firstRow(page)).toContainText('Note 26 of the list');
  await settled(page);
  await expect(summary(page)).toHaveText('26 to 50 of 263');
  expect(read.cursors).toEqual(['', 'all:25']);
});

test('a number pressed during the read goes to its page, and no press of « Next page » waits after it', async ({
  page,
}) => {
  const read = await open(page);
  const release = read.hold('all:25');
  await press(page, 'Next page');
  await expect.poll(() => read.cursors.at(-1)).toBe('all:25');
  await press(page, 'Next page');
  await pages(page).getByRole('button', { name: 'Page 1', exact: true }).click();
  release();

  await expect(summary(page)).toHaveText('1 to 25 of 263');
  await expect(firstRow(page)).toContainText('Note 1 of the list');
  await settled(page);
  await expect(summary(page)).toHaveText('1 to 25 of 263');
  expect(read.cursors).toEqual(['', 'all:25', '']);
});

/** A note of the instance, as `adminNoteView` of the worker answers it (FRU-272). */
const instanceNote = (n: number) => ({
  id: `s9:n${n}`,
  workspace: { id: 'w9', name: 'Acme support' },
  site: { id: 's9', origin: 'https://support.acme.dev' },
  page: { url: `https://support.acme.dev/p${n}`, host: 'support.acme.dev', path: `/p${n}` },
  excerpt: `Note ${n} of the instance`,
  text: `Note ${n} of the instance`,
  stage: 'new',
  channel: 'script',
  author: { kind: 'visitor' },
  place: { kind: 'fruitback' },
  createdAt: new Date(Date.UTC(2026, 9, 13, 12) - n * 60_000).toISOString(),
  checkedAt: new Date(Date.UTC(2026, 9, 13, 12) - n * 60_000).toISOString(),
});

test('the notes of the instance: a press of « Next page » during the read goes on from the page asked', async ({
  page,
}) => {
  const read = reads();
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
    instanceAdmin: true,
  };
  await stubWorker(page, {
    answer: (pathname, route) => {
      if (pathname === '/console/me') return route.fulfill({ json: me });
      if (pathname !== '/console/admin/notes') return undefined;
      // One note a page, three pages: the cursor `p<n>` is the page `n`.
      const cursor = new URL(route.request().url()).searchParams.get('cursor') ?? '';
      const at = cursor === '' ? 1 : Number(cursor.slice(1));

      return read.answer(cursor, () =>
        route.fulfill({
          json: { notes: [instanceNote(at)], total: 3, ...(at < 3 ? { next: `p${at + 1}` } : {}), searched: [] },
        }),
      );
    },
  });
  await page.goto(`${CONSOLE}/admin/notes`);
  const main = page.locator('main');
  await expect(main.getByText('1 to 1 of 3')).toBeVisible();
  const release = read.hold('p2');
  await main.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(() => read.cursors.at(-1)).toBe('p2');
  await main.getByRole('button', { name: 'Next page' }).click();
  release();

  await expect(main.getByText('3 to 3 of 3')).toBeVisible();
  await expect(main.getByRole('table')).toContainText('Note 3 of the instance');
  expect(read.cursors).toEqual(['', 'p2', 'p3']);
  // « Previous page » goes back by the cursors walked through.
  await main.getByRole('button', { name: 'Previous page' }).click();
  await expect(main.getByText('2 to 2 of 3')).toBeVisible();
  await expect(main.getByRole('table')).toContainText('Note 2 of the instance');
});

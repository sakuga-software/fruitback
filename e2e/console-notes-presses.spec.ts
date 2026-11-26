import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * A press while the next notes are read (FRU-709, then FRU-724). On the notes of a workspace, which
 * scroll with no end, « Load more » during the read of the next notes asks nothing again: the list goes
 * on from the notes that read brings, once they are drawn. Each chunk is read once, and each note is one
 * row. On the notes of the instance, which keep their pages, each press of « Next page » goes on from
 * the page asked last, not from the page shown.
 *
 * The worker is answered by stubs, and holds the read of a cursor until the spec lets it go: the
 * presses come while it is on its way, whatever the speed of the machine. 263 notes, 25 to a read,
 * the cursor the index of the first note of a read.
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

/**
 * `failOnce`: the first read of this cursor answers `503`, as a worker that did not answer. The observer
 * of the browser never fires: « Load more » alone reads the next notes, and the spec says when.
 */
async function open(page: Page, failOnce?: string): Promise<Reads> {
  const read = reads();
  let failing = failOnce;
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  });
  await stubWorker(page, {
    workspaces: [ACME],
    answer: (pathname, route: Route) => {
      if (pathname !== '/console/workspaces/w1/notes') return undefined;
      const params = new URL(route.request().url()).searchParams;
      const cursor = params.get('cursor') ?? '';
      const start = cursor === '' ? 0 : Number(cursor.split(':')[1]);
      const limit = Number(params.get('limit') ?? 8);

      return read.answer(cursor, () => {
        if (cursor === failing) {
          failing = undefined;
          return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        }

        return route.fulfill({
          json: {
            notes: NOTES.slice(start, start + limit),
            total: NOTES.length,
            counts: { all: NOTES.length, byPlace: { fruitback: NOTES.length }, undelivered: 0 },
            ...(start + limit < NOTES.length ? { next: `all:${start + limit}` } : {}),
          },
        });
      });
    },
  });
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await expect(rows(page)).toHaveCount(25);

  return read;
}

const rows = (page: Page) => page.getByRole('region', { name: 'Notes' }).locator('tbody tr:not(.kit-table-group)');
const end = (page: Page) => page.locator('[data-notes-end]');
const loadMore = (page: Page) => end(page).getByRole('button', { name: 'Load more' });
/** The ids of the rows, in order: each note once. */
const ids = (page: Page) => rows(page).evaluateAll((all) => all.map((row) => row.getAttribute('data-note')));

/** Lets the effects of the last answer run: a press that waits for it goes on in them. */
const settled = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('presses of « Load more » during the read of the next notes ask nothing again', async ({ page }) => {
  const read = await open(page);
  const release = read.hold('all:25');
  await loadMore(page).click();
  await expect.poll(() => read.cursors.at(-1)).toBe('all:25');
  // The next notes are still on their way: the notes read stay, and the presses ask nothing.
  await loadMore(page).click();
  await loadMore(page).click();
  await expect(end(page)).toContainText('Loading…');
  release();

  await expect(rows(page)).toHaveCount(50);
  await settled(page);
  await expect(rows(page)).toHaveCount(50);
  expect(read.cursors).toEqual(['', 'all:25']);
  expect(new Set(await ids(page)).size).toBe(50);
  // A press once they are drawn goes on from them.
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(75);
  await expect(rows(page).last()).toContainText('Note 75 of the list');
  expect(read.cursors).toEqual(['', 'all:25', 'all:50']);
});

test('a read of the next notes that fails keeps the notes, says so under them, and « Try again » reads them (FRU-682)', async ({
  page,
}) => {
  const read = await open(page, 'all:25');
  const release = read.hold('all:25');
  await loadMore(page).click();
  await expect.poll(() => read.cursors.at(-1)).toBe('all:25');
  await loadMore(page).click();
  release();

  // The read failed: the notes read stay, and the end of the list says it, with « Try again ».
  const failed = end(page).getByRole('alert');
  await expect(failed).toContainText('The next notes did not load.');
  await expect(rows(page)).toHaveCount(25);
  await expect(page.getByText('The notes did not load')).toHaveCount(0);
  await expect(loadMore(page)).toHaveCount(0);
  await end(page).getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(50);
  await expect(failed).toHaveCount(0);
  await settled(page);
  // The cursor that failed, once more, and only it: the press during the failed read asked nothing.
  expect(read.cursors).toEqual(['', 'all:25', 'all:25']);
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(75);
  expect(read.cursors).toEqual(['', 'all:25', 'all:25', 'all:50']);
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
      // Two notes a page, three pages, the last with one note (FRU-710): the cursor `p<n>` is the page `n`.
      const cursor = new URL(route.request().url()).searchParams.get('cursor') ?? '';
      const at = cursor === '' ? 1 : Number(cursor.slice(1));
      const notes = (at < 3 ? [2 * at - 1, 2 * at] : [5]).map(instanceNote);

      return read.answer(cursor, () =>
        route.fulfill({ json: { notes, total: 5, ...(at < 3 ? { next: `p${at + 1}` } : {}), searched: [] } }),
      );
    },
  });
  await page.goto(`${CONSOLE}/admin/notes`);
  const main = page.locator('main');
  await expect(main.getByText('1 to 2 of 5')).toBeVisible();
  const release = read.hold('p2');
  await main.getByRole('button', { name: 'Next page' }).click();
  await expect.poll(() => read.cursors.at(-1)).toBe('p2');
  await main.getByRole('button', { name: 'Next page' }).click();
  release();

  await expect(main.getByText('5 to 5 of 5')).toBeVisible();
  await expect(main.getByRole('table')).toContainText('Note 5 of the instance');
  expect(read.cursors).toEqual(['', 'p2', 'p3']);
  // « Previous page » goes back by the cursors walked through, each with the range it was shown with:
  // the last page holds fewer notes than the others (FRU-710).
  await main.getByRole('button', { name: 'Previous page' }).click();
  await expect(main.getByText('3 to 4 of 5')).toBeVisible();
  await expect(main.getByRole('table')).toContainText('Note 3 of the instance');
  await main.getByRole('button', { name: 'Previous page' }).click();
  await expect(main.getByText('1 to 2 of 5')).toBeVisible();
});

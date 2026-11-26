import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The notes of a workspace scroll with no end (FRU-724, Mathieu), in place of the pages of FRU-587:
 * the next notes are read by the cursor of the last answer as the end of the list comes near, and
 * « Load more » reads them too. A new list starts again from its first notes, and the answer of a
 * read of the list of before is dropped. The pages of the sites, read by their offset, stay.
 *
 * The worker is answered by stubs: 263 notes, the cursor `<list>:<index of the next note>`, as a cursor
 * of the worker belongs to one filter. Where a spec presses « Load more » alone, the observer of the
 * browser is one that never fires: the case « Load more » is there for.
 */
const CONSOLE = 'http://localhost:5178';

const noteOf = (n: number, of = 'Note') => ({
  id: `n${n}`,
  excerpt: `${of} ${n + 1} of the list`,
  page: { url: `https://acme.dev/p${n}`, host: 'acme.dev', path: `/p${n}` },
  site: { id: 's1' },
  stage: 'new',
  author: { kind: 'anonymous' },
  createdAt: new Date(Date.UTC(2026, 9, 13, 12) - n * 60_000).toISOString(),
});
const NOTES = Array.from({ length: 263 }, (_, n) => noteOf(n));

type Asked = Record<string, string>;
type Worker = {
  /** The reads of the notes, their query without the order. */
  asked: Asked[];
  /** Holds the read of a cursor until the spec lets it go. */
  hold: (cursor: string) => () => void;
  /** The next read of this cursor answers `503`. */
  failOnce: (cursor: string) => void;
};

async function open(
  page: Page,
  {
    query = '',
    locale = 'en',
    notes = NOTES,
    observer = true,
  }: {
    query?: string;
    locale?: 'en' | 'fr';
    notes?: typeof NOTES;
    /** `false`: the observer of the browser never fires, and « Load more » alone reads the next notes. */
    observer?: boolean;
  } = {},
): Promise<Worker> {
  const asked: Asked[] = [];
  const held = new Map<string, Promise<void>>();
  const failing = new Set<string>();
  if (!observer) {
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
  }
  await stubWorker(page, {
    locale,
    workspaces: [ACME, { id: 'w2', name: 'Lumen Studio', role: 'owner' }],
    answer: (pathname, route) => {
      if (/^\/console\/workspaces\/w1\/notes\/\w+\/retry$/.test(pathname)) return route.fulfill({ status: 204 });
      const at = /^\/console\/workspaces\/(w[12])\/notes$/.exec(pathname);
      if (at === null) return undefined;
      const { order: _order, ...params } = Object.fromEntries(new URL(route.request().url()).searchParams);
      asked.push(at[1] === 'w1' ? params : { workspace: at[1] as string, ...params });
      // A cursor carries its list, and a cursor of another list is refused, as the worker does.
      const list = `${at[1]}/${params.stage ?? 'all'}`;
      const [of, index] = (params.cursor ?? `${list}:0`).split(':');
      const cursor = params.cursor ?? '';
      const fulfil = () => {
        if (of !== list) return route.fulfill({ status: 400, json: { error: 'invalid-cursor' } });
        if (failing.delete(cursor)) return route.fulfill({ status: 503, json: { error: 'unavailable' } });
        const start = Number(index);
        const limit = Number(params.limit ?? 25);
        const all = at[1] === 'w1' ? notes : notes.slice(0, 40).map((_, n) => noteOf(n, 'Lumen note'));

        return route.fulfill({
          json: {
            notes: all.slice(start, start + limit),
            ...(params.counts === 'none'
              ? {}
              : { total: all.length, counts: { all: all.length, byPlace: { fruitback: all.length }, undelivered: 0 } }),
            ...(start + limit < all.length ? { next: `${list}:${start + limit}` } : {}),
          },
        });
      };

      return (held.get(cursor) ?? Promise.resolve()).then(fulfil);
    },
  });
  await page.goto(`${CONSOLE}/w/w1/notes${query}`);
  await expect(page.locator('main h1')).toBeVisible();

  return {
    asked,
    hold(cursor) {
      let release = () => {};
      held.set(cursor, new Promise<void>((resolve) => (release = resolve)));

      return () => {
        held.delete(cursor);
        release();
      };
    },
    failOnce: (cursor) => void failing.add(cursor),
  };
}

const rows = (page: Page) => page.getByRole('region', { name: 'Notes' }).locator('tbody tr:not(.kit-table-group)');
const end = (page: Page) => page.locator('[data-notes-end]');
const loadMore = (page: Page) => end(page).getByRole('button', { name: 'Load more' });
const said = (page: Page) => end(page).getByRole('status');
/** The cursors the reads of the notes asked, in order; the first notes ask none. */
const cursors = (worker: Worker) => worker.asked.map((each) => each.cursor ?? '');
/** Scrolls the window to the end of the document, as a person who reads down the list. */
const toTheEnd = (page: Page) => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

/** FRU-686: a filter is chosen from « Filter »: its field, then its value. */
async function choose(page: Page, field: string, value: string): Promise<void> {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menuitem', { name: field, exact: true }).click();
  await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}

test('the next notes are read as the end of the list comes near, by the cursor of the last answer', async ({
  page,
}) => {
  const worker = await open(page);
  // 1440 × 900: the first 25 notes do not reach 720 px under the window, so the next 25 are read.
  await expect(rows(page)).toHaveCount(50);
  expect(worker.asked.slice(0, 2)).toEqual([
    { limit: '25' },
    // FRU-502: the counts are read with the first notes only.
    { limit: '25', cursor: 'w1/all:25', counts: 'none' },
  ]);
  // No pages on this screen any more; the total stays in the bar, and under the list.
  await expect(page.getByRole('navigation', { name: 'Pages of notes' })).toHaveCount(0);
  await expect(page.locator('[data-pinned-filters]')).toContainText('263 notes');
  await expect(end(page)).toContainText('50 of 263');
  await expect(page).not.toHaveURL(/cursor=|from=/);

  // Down the list to its end: each read goes on from the one before, once each.
  while ((await rows(page).count()) < 263) {
    const before = await rows(page).count();
    await toTheEnd(page);
    await expect.poll(() => rows(page).count()).toBeGreaterThan(before);
  }
  await expect(rows(page).last()).toContainText('Note 263 of the list');
  expect(cursors(worker)).toEqual(['', ...Array.from({ length: 10 }, (_, n) => `w1/all:${(n + 1) * 25}`)]);
  await expect(end(page)).toContainText('263 of 263');
  await expect(loadMore(page)).toHaveCount(0);
  // Each note once.
  const ids = await rows(page).evaluateAll((all) => all.map((row) => row.getAttribute('data-note')));
  expect(new Set(ids).size).toBe(263);
});

test('« Load more » reads the next notes from the keyboard, and a screen reader hears how many came', async ({
  page,
}) => {
  const worker = await open(page, { observer: false });
  await expect(rows(page)).toHaveCount(25);
  await expect(said(page)).toHaveText('');
  await loadMore(page).focus();
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(50);
  await expect(said(page)).toHaveText('25 more notes. 50 of 263 shown.');
  await expect(end(page)).toContainText('50 of 263');
  // The focus stays on the button, under the notes that came.
  await expect(loadMore(page)).toBeFocused();
  expect(cursors(worker)).toEqual(['', 'w1/all:25']);

  for (let read = 0; read < 8; read += 1) {
    const before = await rows(page).count();
    await page.keyboard.press('Enter');
    await expect(rows(page)).toHaveCount(before + 25);
  }
  // The last read holds 13 notes, and there is no next one.
  await expect(rows(page)).toHaveCount(250);
  await page.keyboard.press('Enter');
  await expect(rows(page)).toHaveCount(263);
  await expect(said(page)).toHaveText('13 more notes. 263 of 263 shown.');
  await expect(loadMore(page)).toHaveCount(0);
});

test('a filter starts again from the first notes, at the top, and the next notes of the list of before are dropped', async ({
  page,
}) => {
  const worker = await open(page, { observer: false });
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(50);
  await toTheEnd(page);
  // The next notes of every note are on their way when the status « New » is chosen.
  const release = worker.hold('w1/all:50');
  await loadMore(page).click();
  await expect.poll(() => cursors(worker).at(-1)).toBe('w1/all:50');
  await choose(page, 'Status', 'New');
  await expect.poll(() => worker.asked.at(-1)).toEqual({ stage: 'new', limit: '25' });
  await expect(rows(page)).toHaveCount(25);
  release();
  await expect.poll(() => worker.asked.length).toBe(4);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  // The answer for every note came last, and is not added to the notes « New ».
  await expect(rows(page)).toHaveCount(25);
  await expect(end(page)).toContainText('25 of 263');
  // The new list is drawn from its top: its first note is in the window, under the filters.
  await expect(rows(page).first()).toBeInViewport();
  await expect(page.locator('[data-pinned-filters]')).toBeInViewport();
  // « Load more » goes on in the new list, by its own cursor.
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(50);
  expect(cursors(worker)).toEqual(['', 'w1/all:25', 'w1/all:50', '', 'w1/new:25']);
});

test('the search and another workspace start again from the first notes too', async ({ page }) => {
  const worker = await open(page, { observer: false });
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(50);
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Note');
  await expect.poll(() => worker.asked.at(-1)).toEqual({ q: 'Note', limit: '25' });
  await expect(rows(page)).toHaveCount(25);

  // The buttons of the browser go to the notes of another workspace: the same screen, not drawn again.
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(50);
  await page.evaluate(() => {
    window.history.pushState(null, '', '/w/w2/notes');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect.poll(() => worker.asked.at(-1)).toEqual({ workspace: 'w2', limit: '25' });
  await expect(rows(page)).toHaveCount(25);
  await expect(rows(page).first()).toContainText('Lumen note 1 of the list');
  await expect(end(page)).toContainText('25 of 40');
});

test('the note opened and the place in the list stay when its panel closes', async ({ page }) => {
  const worker = await open(page, { observer: false });
  await loadMore(page).click();
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(75);
  const sixtieth = rows(page).nth(59);
  await sixtieth.scrollIntoViewIfNeeded();
  const reads = worker.asked.length;
  await sixtieth.locator('[data-note-title]').click();
  await expect(page).toHaveURL(/[?&]task=n59(&|$)/);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The panel read nothing of the list: the 75 notes are there, and the note is where it was.
  await expect(rows(page)).toHaveCount(75);
  await expect(sixtieth.locator('[data-note-title]')).toBeFocused();
  await expect(sixtieth).toBeInViewport();
  expect(worker.asked.length).toBe(reads);
});

test('a read again after a write reads back the notes shown, and the list stays where it was', async ({ page }) => {
  // The sixtieth note did not reach its connector: « Send again » sends it, then the list is read again.
  const late = {
    ...noteOf(59),
    place: { kind: 'rest', connector: 'c2', label: 'hooks.acme.dev' },
    delivery: { id: 'd59', state: 'waiting' },
  };
  const notes = NOTES.map((note, n) => (n === 59 ? late : note));
  const worker = await open(page, { observer: false, notes });
  await loadMore(page).click();
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(75);
  const row = rows(page).nth(59);
  await row.scrollIntoViewIfNeeded();
  const reads = worker.asked.length;
  await row.getByRole('button', { name: 'Send again' }).click();

  // 75 notes read back: 50, the most the worker reads at once, then 25, from the first notes.
  await expect
    .poll(() => worker.asked.slice(reads))
    .toEqual([{ limit: '50' }, { limit: '25', cursor: 'w1/all:50', counts: 'none' }]);
  await expect(rows(page)).toHaveCount(75);
  await expect(row).toBeInViewport();
});

test('the screen keeps 500 notes, and says that a filter or the search finds the others', async ({ page }) => {
  const many = Array.from({ length: 620 }, (_, n) => noteOf(n));
  const worker = await open(page, { observer: false, notes: many });
  for (let read = 1; read < 20; read += 1) {
    await loadMore(page).click();
    await expect(rows(page)).toHaveCount((read + 1) * 25);
  }
  await expect(rows(page)).toHaveCount(500);
  await expect(loadMore(page)).toHaveCount(0);
  await expect(end(page)).toContainText(
    '500 of 620The first 500 notes are shown. A filter or the search finds the others.',
  );
  expect(worker.asked).toHaveLength(20);
});

for (const [width, locale, more, shown] of [
  [1440, 'en', 'Load more', '25 of 263'],
  [390, 'fr', 'Charger la suite', '25 sur 263'],
] as const) {
  test(`the end of the list at ${width} px in ${locale}: one line, named, and nothing past the screen`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, { locale, observer: false });
    await expect(rows(page)).toHaveCount(25);
    const button = end(page).getByRole('button', { name: more });
    await expect(button).toBeEnabled();
    await expect(end(page)).toContainText(shown);
    // The count and the button on one line: one middle, to the pixel.
    const middles = await end(page)
      .locator(':scope > div:last-child > *')
      .evaluateAll((all) =>
        all.map((each) => {
          const box = each.getBoundingClientRect();

          return box.top + box.height / 2;
        }),
      );
    expect(middles).toHaveLength(2);
    expect(Math.abs((middles[0] as number) - (middles[1] as number))).toBeLessThanOrEqual(1);
    expect.soft(await sideScroll(page)).toBe(0);
    await button.scrollIntoViewIfNeeded();
    const results = await new AxeBuilder({ page }).include('[data-notes-end]').analyze();
    expect.soft(results.violations.map((violation) => violation.id)).toEqual([]);
  });
}

/**
 * The offered pages of a list that knows its pages, as a person reads them: their numbers, « … », and
 * the one shown in brackets.
 */
function offered(page: Page, name: string): Promise<string[]> {
  return page
    .getByRole('navigation', { name })
    .locator('button[aria-label^="Page"], span[aria-hidden]')
    .evaluateAll((all) =>
      all.map((element) => {
        const text = element.textContent?.trim() ?? '';

        return element.getAttribute('aria-current') === 'page' ? `[${text}]` : text;
      }),
    );
}

test('the pages of the sites offer every number, as the sites are read by their offset', async ({ page }) => {
  // 25 rows to a page (FRU-688): 150 sites are 6 pages.
  const many = Array.from({ length: 150 }, (_, index) => ({
    id: `m${index + 1}`,
    origin: `https://site-${index + 1}.acme.dev`,
    visibility: 'members',
    notes: { new: 0, todo: 0, progress: 0, done: 0, closed: 0 },
    via: [],
    undelivered: 0,
  }));
  await stubWorker(page, { workspaces: [ACME], sites: many });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const name = 'Pages of sites';
  const pages = page.getByRole('navigation', { name });
  const summary = pages.locator('span').first();
  await expect(summary).toHaveText('1 to 25 of 150');
  await expect.poll(() => offered(page, name)).toEqual(['[1]', '2', '…', '6']);
  await pages.getByRole('button', { name: 'Page 6', exact: true }).click();
  await expect(summary).toHaveText('126 to 150 of 150');
  await expect(page).toHaveURL(/[?&]page=6(&|$)/);
  await expect.poll(() => offered(page, name)).toEqual(['1', '…', '5', '[6]']);
});

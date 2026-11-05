import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The pages of the notes (FRU-587, Mathieu): « Previous » and « Next » are icon buttons, and the
 * numbers of the pages around the one shown go to them in one press. The notes are read by a cursor,
 * so a number is offered only for a page whose cursor the screen knows: the first one, the next one,
 * and the pages walked through. A list read by its offset, the sites, offers every number.
 *
 * The worker is answered by stubs: 263 notes, 25 to a page (11 pages), the cursor the index of the
 * first note of a page.
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

type Asked = Record<string, string>;

async function open(page: Page, query = '', locale: 'en' | 'fr' = 'en'): Promise<Asked[]> {
  const asked: Asked[] = [];
  await stubWorker(page, {
    locale,
    workspaces: [ACME],
    answer: (pathname, route) => {
      if (pathname !== '/console/workspaces/w1/notes') return undefined;
      const { order: _order, ...params } = Object.fromEntries(new URL(route.request().url()).searchParams);
      asked.push(params);
      const start = Number(params.cursor ?? 0);
      const limit = Number(params.limit ?? 8);

      return route.fulfill({
        json: {
          notes: NOTES.slice(start, start + limit),
          total: NOTES.length,
          counts: { all: NOTES.length, byPlace: { fruitback: NOTES.length }, undelivered: 0 },
          ...(start + limit < NOTES.length ? { next: String(start + limit) } : {}),
        },
      });
    },
  });
  await page.goto(`${CONSOLE}/w/w1/notes${query}`);
  await expect(page.locator('main h1')).toBeVisible();

  return asked;
}

const pages = (page: Page, name = 'Pages of notes') => page.getByRole('navigation', { name });
const summary = (page: Page, name?: string) => pages(page, name).locator('span').first();
const number = (page: Page, at: number, name?: string) =>
  pages(page, name).getByRole('button', { name: `Page ${at}`, exact: true });

/** The pages offered, as a person reads them: their numbers, « … », and the one shown in brackets. */
function offered(page: Page, name?: string): Promise<string[]> {
  return pages(page, name)
    .locator('button[aria-label^="Page"], span[aria-hidden]')
    .evaluateAll((all) =>
      all.map((element) => {
        const text = element.textContent?.trim() ?? '';

        return element.getAttribute('aria-current') === 'page' ? `[${text}]` : text;
      }),
    );
}

test('the numbers go to the pages around, by the cursors the screen knows', async ({ page }) => {
  const asked = await open(page);
  // The worker is asked for 25 notes a page, by name.
  await expect.poll(() => asked.at(-1)?.limit).toBe('25');
  await expect(summary(page)).toHaveText('1 to 25 of 263');
  // The first page: itself, the next one, and « … » for the pages whose cursor is not known yet.
  await expect.poll(() => offered(page)).toEqual(['[1]', '2', '…']);
  await expect(pages(page).getByRole('button', { name: 'Previous page' })).toBeDisabled();

  // A number goes to its page, and the focus stays on it.
  await number(page, 2).click();
  await expect(summary(page)).toHaveText('26 to 50 of 263');
  await expect(number(page, 2)).toHaveAttribute('aria-current', 'page');
  await expect(number(page, 2)).toBeFocused();
  await expect(page).toHaveURL(/[?&]cursor=25(&|$)/);

  // Three pages further by « Next page »: the pages walked through are offered back.
  for (let press = 0; press < 3; press += 1) await pages(page).getByRole('button', { name: 'Next page' }).click();
  await expect(summary(page)).toHaveText('101 to 125 of 263');
  await expect.poll(() => offered(page)).toEqual(['1', '…', '4', '[5]', '6', '…']);

  // Back to the fourth page by its number: the cursor it was read with, and the counts kept (FRU-502).
  await number(page, 4).click();
  await expect(summary(page)).toHaveText('76 to 100 of 263');
  expect(asked.at(-1)).toEqual({ limit: '25', cursor: '75', counts: 'none' });
  await expect.poll(() => offered(page)).toEqual(['1', '2', '3', '[4]', '5', '…']);

  // The first page: no cursor in the address.
  await number(page, 1).click();
  await expect(summary(page)).toHaveText('1 to 25 of 263');
  await expect(page).not.toHaveURL(/cursor=|from=/);
  await expect.poll(() => offered(page)).toEqual(['[1]', '2', '…']);
});

test('the last page is offered once its cursor is known, and « Next page » is off there', async ({ page }) => {
  await open(page, '?cursor=225&from=226');
  await expect(summary(page)).toHaveText('226 to 250 of 263');
  // Opened from a link: the cursors before are not known, the first page and the next one are.
  await expect.poll(() => offered(page)).toEqual(['1', '…', '[10]', '11']);
  // The page before has no known cursor: the arrow says it goes to the first page (review of #823).
  await expect(pages(page).getByRole('button', { name: 'Previous page' })).toHaveCount(0);
  await expect(pages(page).getByRole('button', { name: 'First page' })).toBeEnabled();
  await number(page, 11).click();
  await expect(summary(page)).toHaveText('251 to 263 of 263');
  await expect(pages(page).getByRole('button', { name: 'Next page' })).toBeDisabled();
  await expect.poll(() => offered(page)).toEqual(['1', '…', '10', '[11]']);
  // The arrow back from the last page, which holds 13 notes: the tenth page, from its first note.
  await pages(page).getByRole('button', { name: 'Previous page' }).click();
  await expect(summary(page)).toHaveText('226 to 250 of 263');
  await expect(page).toHaveURL(/[?&]from=226(&|$)/);
  await number(page, 11).click();
  await number(page, 10).click();
  await expect(summary(page)).toHaveText('226 to 250 of 263');
  // Still from the link: the arrow goes to the first page, and reads it.
  await pages(page).getByRole('button', { name: 'First page' }).click();
  await expect(summary(page)).toHaveText('1 to 25 of 263');
  await expect(page).not.toHaveURL(/cursor=|from=/);
});

test('after the Back button of the browser, each number still reads its own page (review of #823)', async ({
  page,
}) => {
  const asked = await open(page);
  const first = page.getByRole('region', { name: 'Notes' }).locator('tbody tr:not(.kit-table-group)').first();
  await number(page, 2).click();
  await expect(summary(page)).toHaveText('26 to 50 of 263');
  await number(page, 3).click();
  await expect(summary(page)).toHaveText('51 to 75 of 263');
  // The browser goes back a page: the address changes, and nothing the screen pressed.
  await page.goBack();
  await expect(summary(page)).toHaveText('26 to 50 of 263');
  await expect(first).toContainText('Note 26 of the list');
  await expect.poll(() => offered(page)).toEqual(['1', '[2]', '3', '…']);
  // « Page 1 » reads the first page, with no cursor, and « Page 3 » the third with its own.
  await number(page, 1).click();
  await expect(summary(page)).toHaveText('1 to 25 of 263');
  await expect(first).toContainText('Note 1 of the list');
  expect(asked.at(-1)?.cursor).toBeUndefined();
  await number(page, 2).click();
  await number(page, 3).click();
  await page.goBack();
  await expect(summary(page)).toHaveText('26 to 50 of 263');
  // « Previous page » too.
  await pages(page).getByRole('button', { name: 'Previous page' }).click();
  await expect(summary(page)).toHaveText('1 to 25 of 263');
  await expect(first).toContainText('Note 1 of the list');
});

test('the pages of the sites offer every number, as the sites are read by their offset', async ({ page }) => {
  const many = Array.from({ length: 70 }, (_, index) => ({
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
  await expect(summary(page, name)).toHaveText('1 to 12 of 70');
  await expect.poll(() => offered(page, name)).toEqual(['[1]', '2', '…', '6']);
  await number(page, 6, name).click();
  await expect(summary(page, name)).toHaveText('61 to 70 of 70');
  await expect(page).toHaveURL(/[?&]page=6(&|$)/);
  await expect.poll(() => offered(page, name)).toEqual(['1', '…', '5', '[6]']);
});

for (const [width, locale, label, previous, next] of [
  [1440, 'en', 'Pages of notes', 'First page', 'Page 2'],
  [390, 'fr', 'Pages de notes', 'Première page', 'Page 2'],
] as const) {
  test(`the pages at ${width} px in ${locale}: one line, named, and nothing past the screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, '?cursor=100&from=101', locale);
    const nav = pages(page, label);
    await expect(nav.getByRole('button', { name: previous })).toBeEnabled();
    await expect(nav.getByRole('button', { name: next, exact: true })).toHaveCount(0);
    await expect(nav.getByRole('button', { name: 'Page 5', exact: true })).toHaveAttribute('aria-current', 'page');
    // The buttons of the pages are on one line.
    const tops = await nav
      .getByRole('button')
      .evaluateAll((all) => [...new Set(all.map((button) => Math.round(button.getBoundingClientRect().top)))]);
    expect(tops).toHaveLength(1);
    expect.soft(await sideScroll(page)).toBe(0);
    await nav.scrollIntoViewIfNeeded();
    const results = await new AxeBuilder({ page }).include('nav').analyze();
    expect.soft(results.violations.map((violation) => violation.id)).toEqual([]);
  });
}

import { type Page, expect, test } from '@playwright/test';
import { sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The heads of a table of the console are one line each (FRU-401): at 1024 and 1280 px « Sur la page
 * avec », « Les notes vont vers » and « Dernière note » broke on two lines in the table of the Sites
 * screen. That screen was a grid of cards from FRU-408, and is a table again since FRU-688, one line
 * per site: its heads and its rows are measured there, in French, whose words are the longest, and
 * the rule of the kit on the table that `/kit` mounts. The worker
 * is answered by stubs; the sample data is of nobody.
 */
const CONSOLE = 'http://localhost:5178';
/**
 * The development server of the console, for `/kit` alone: a build has no `/kit` (`kit-route.test.ts`),
 * and the specs serve the console built on 5178 (FRU-473, `playwright.config.ts`).
 */
const KIT = 'http://localhost:5179';

const LINEAR = { connector: 'c1', teamId: 't1', label: 'Linear · Acme web' };
const NOTES = { new: 3, todo: 2, progress: 4, done: 2, closed: 1 };
const SITES = [
  {
    id: 's1',
    origin: 'https://app.acme.dev',
    visibility: 'members',
    destination: LINEAR,
    destinations: [LINEAR],
    notes: NOTES,
    via: ['script', 'extension'],
    lastNoteAt: '2026-10-13T10:00:00.000Z',
    undelivered: 0,
  },
  {
    id: 's2',
    origin: 'https://staging.a-long-address-of-a-client.fr',
    visibility: 'public',
    notes: NOTES,
    via: ['extension'],
    lastNoteAt: '2026-10-13T11:00:00.000Z',
    undelivered: 0,
  },
];

/** The words of each element, and the number of lines they take. */
function linesOf(page: Page, selector: string): Promise<{ text: string; lines: number }[]> {
  return page.locator(selector).evaluateAll((elements) =>
    elements
      .filter((element) => element.checkVisibility())
      .map((element) => {
        const words = document.createRange();
        words.selectNodeContents(element);
        const tops = new Set(
          [...words.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)),
        );

        return { text: element.textContent ?? '', lines: tops.size };
      }),
  );
}

for (const width of [1024, 1280, 1440, 390]) {
  test(`the heads and the rows of the table of sites are one line at ${width} px, in French`, async ({ page }) => {
    await stubWorker(page, { locale: 'fr', sites: SITES });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const table = page.getByRole('table', { name: 'Sites' });
    await expect(table.locator('tbody[data-site]').first()).toBeVisible();

    // FRU-688: the Sites screen is a table again, one line of 36 px per site. Each head shown, and
    // what each cell shows, is one line; a column that has no room goes, and its head with it.
    const heads = await linesOf(page, 'main table thead th > span:not(.sr-only)');
    expect(heads.length).toBeGreaterThanOrEqual(3);
    expect(heads.filter(({ lines }) => lines !== 1)).toEqual([]);
    // Each piece of text of a row, alone: a cell holds an icon beside its words, whose box is no line.
    const words = await table.locator('tbody[data-site] > tr:first-child').evaluateAll((rows) =>
      rows.flatMap((row) => {
        const texts = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        const found: { text: string; lines: number }[] = [];
        for (let node = texts.nextNode(); node !== null; node = texts.nextNode()) {
          if ((node.textContent ?? '').trim() === '' || node.parentElement?.checkVisibility() !== true) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const tops = new Set(
            [...range.getClientRects()].filter((rect) => rect.width > 1).map((rect) => Math.round(rect.top)),
          );
          found.push({ text: node.textContent ?? '', lines: tops.size });
        }

        return found;
      }),
    );
    expect(words.length).toBeGreaterThanOrEqual(4);
    expect(words.filter(({ lines }) => lines > 1)).toEqual([]);
    const heights = await table
      .locator('tbody[data-site] > tr:first-child')
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    expect(heights).toEqual([36, 36]);
    expect(await sideScroll(page)).toBe(0);
  });
}

test('every head of a table of the kit is one line, at 390 px too', async ({ page }) => {
  await stubWorker(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${KIT}/kit`);
  const heads = page.getByRole('region', { name: 'Members' }).locator('thead th');
  await expect(heads.first()).toBeVisible();

  for (const head of await heads.all())
    expect(await head.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');
  expect(await linesOf(page, 'main [role="region"][aria-label="Members"] thead th')).toEqual([
    { text: 'Person', lines: 1 },
    { text: 'Role', lines: 1 },
    { text: 'Last seen', lines: 1 },
  ]);
});

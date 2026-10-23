import { type Page, expect, test } from '@playwright/test';
import { sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The heads of a table of the console are one line each (FRU-401): at 1024 and 1280 px « Sur la page
 * avec », « Les notes vont vers » and « Dernière note » broke on two lines in the table of the Sites
 * screen. That screen is a grid of cards since FRU-408: its terms are measured there, in French,
 * whose words are the longest, and the rule of the kit on the table that `/kit` mounts. The worker
 * is answered by stubs; the sample data is of nobody.
 */
const CONSOLE = 'http://localhost:5178';

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
  test(`every term of a card of sites is one line at ${width} px, in French`, async ({ page }) => {
    await stubWorker(page, { locale: 'fr', sites: SITES });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    await expect(page.getByRole('list', { name: 'Sites' }).locator('li[data-site]').first()).toBeVisible();

    const terms = await linesOf(page, 'main li[data-site] dt');
    // The control: the terms of the tracker are there, so the three of them are measured.
    expect(terms.map(({ text }) => text)).toEqual(
      expect.arrayContaining(['Sur la page avec', 'Les notes vont vers', 'Dernière note']),
    );
    expect(terms.filter(({ lines }) => lines !== 1)).toEqual([]);
    expect(await sideScroll(page)).toBe(0);
  });
}

test('every head of a table of the kit is one line, at 390 px too', async ({ page }) => {
  await stubWorker(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/kit`);
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

import { type Page, expect, test } from '@playwright/test';
import { sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The heads of a table of the console are one line each (FRU-401). Measured on the Sites screen in
 * French, whose heads are the longest, with the six columns that an owner sees: at
 * 1024 and 1280 px « Sur la page avec », « Les notes vont vers » and « Dernière note » broke on two
 * lines. The worker is answered by stubs; the sample data is of nobody.
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

/** The heads that show words, each with the number of lines its words take. */
function linesOfHeads(page: Page): Promise<{ head: string; lines: number }[]> {
  return page
    .getByRole('region', { name: 'Sites' })
    .locator('thead th')
    .evaluateAll((heads) =>
      heads
        // A head with no word to show (the column of the menus) is said to a screen reader only.
        .filter(
          (head) => head.checkVisibility() && getComputedStyle(head.firstElementChild ?? head).position !== 'absolute',
        )
        .map((head) => {
          const words = document.createRange();
          words.selectNodeContents(head);
          const tops = new Set(
            [...words.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top)),
          );

          return { head: head.textContent ?? '', lines: tops.size };
        }),
    );
}

for (const width of [1024, 1280, 1440, 390]) {
  test(`every head of the table of sites is one line at ${width} px, in French`, async ({ page }) => {
    await stubWorker(page, { locale: 'fr', sites: SITES });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    await expect(page.getByRole('region', { name: 'Sites' }).locator('tbody tr').first()).toBeVisible();

    const heads = await linesOfHeads(page);
    // The control: the heads of the tracker are there, so the six columns are measured.
    expect(heads.map(({ head }) => head)).toEqual(
      expect.arrayContaining(['Sur la page avec', 'Les notes vont vers', 'Dernière note']),
    );
    expect(heads.filter(({ lines }) => lines !== 1)).toEqual([]);
    // A table wider than its frame scrolls in it: the page does not.
    expect(await sideScroll(page)).toBe(0);
  });
}

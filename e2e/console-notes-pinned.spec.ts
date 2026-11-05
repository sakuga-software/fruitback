import { type Page, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The notes scroll under their filters (FRU-586, Mathieu): the filters stay at the top of the window
 * in every case, the head of the columns under them, and the head of a group of a status while a note
 * of that group is on screen. Measured in the table at 1440 and 1280 px, in the cards at 1024 and
 * 390 px, and in the board.
 *
 * The worker is answered by stubs: one page of 50 notes in five groups, as `order=status` reads them.
 */
const CONSOLE = 'http://localhost:5178';

const SITES = [
  { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' },
  { id: 's2', origin: 'https://acme.dev', visibility: 'everyone' },
];
const CONNECTORS = [{ id: 'c1', kind: 'linear', label: 'Acme', createdAt: '2026-10-01T08:00:00.000Z' }];
/** The groups in the order of the table (FRU-551), and the notes of each. */
const GROUPS = [
  ['progress', 6],
  ['todo', 9],
  ['new', 12],
  ['closed', 3],
  ['done', 20],
] as const;

const NOTES = GROUPS.flatMap(([stage, count], group) =>
  Array.from({ length: count }, (_, at) => {
    const n = group * 100 + at;

    return {
      id: `n${n}`,
      excerpt: `Note ${n}: the button of the pricing page covers the footer on a phone`,
      page: { url: `https://acme.dev/p${n}`, host: 'acme.dev', path: `/p${n}` },
      site: { id: n % 2 === 0 ? 's1' : 's2' },
      stage,
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'linear', connector: 'c1', label: 'Acme' },
      ref: `ACM-${n}`,
      url: `https://linear.app/acme/issue/ACM-${n}`,
      createdAt: new Date(Date.UTC(2026, 9, 13, 12) - n * 60_000).toISOString(),
    };
  }),
);

async function open(page: Page, query = '', locale: 'en' | 'fr' = 'en'): Promise<void> {
  await stubWorker(page, {
    locale,
    workspaces: [ACME],
    sites: SITES,
    answer: (pathname, route) => {
      if (pathname === '/console/workspaces/w1/connectors')
        return route.fulfill({ json: { connectors: CONNECTORS, available: true } });
      if (pathname !== '/console/workspaces/w1/notes') return undefined;

      return route.fulfill({
        json: {
          notes: NOTES,
          total: NOTES.length,
          counts: {
            all: NOTES.length,
            byPlace: { c1: 30, fruitback: 20 },
            undelivered: 0,
            byStage: Object.fromEntries(GROUPS),
          },
        },
      });
    },
  });
  await page.goto(`${CONSOLE}/w/w1/notes${query}`);
  await expect(page.locator('main h1')).toBeVisible();
}

const frame = (page: Page) => page.locator('.kit-table');

/** Scrolls the window, and waits for the frame that the scroll paints. */
async function scrollTo(page: Page, y: number): Promise<void> {
  await page.evaluate((to) => window.scrollTo(0, to), y);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/**
 * What is pinned, as the window shows it: the bottom of the filters, of the head of the columns, and
 * of the head of the group under them; the group of that head, as a point at its middle finds it, and
 * the group of the first note under the heads.
 */
function pinned(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-pinned-filters]')!.getBoundingClientRect();
    const table = document.querySelector('.kit-table')!;
    const head = table.querySelector('thead th')!.getBoundingClientRect();
    const stacked = (table as HTMLElement).dataset.stacked === 'true';
    const under = stacked ? bar.bottom : head.bottom;
    const x = table.getBoundingClientRect().left + 40;
    const shownHead = document.elementFromPoint(x, under + 4)?.closest('tr.kit-table-group');
    const headBottom = shownHead?.querySelector('th')?.getBoundingClientRect().bottom ?? under;
    const firstNote = [...table.querySelectorAll<HTMLElement>('tbody tr:not(.kit-table-group)')].find(
      (row) => row.getBoundingClientRect().bottom > headBottom + 1,
    );

    return {
      barTop: bar.top,
      barBottom: bar.bottom,
      headTop: head.top,
      under,
      headGroup: shownHead?.closest('tbody')?.dataset.group,
      headTop2: shownHead?.querySelector('th')?.getBoundingClientRect().top,
      noteGroup: firstNote?.closest('tbody')?.dataset.group,
    };
  });
}

/** At each depth of the list: the filters at the top, and the head of the group of the first note under them. */
async function expectPinnedDown(page: Page, stacked: boolean): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(height, 'the list is longer than the window').toBeGreaterThan(2000);
  const seen = new Set<string>();
  for (let y = 400; y < height - 200; y += 350) {
    await scrollTo(page, y);
    const at = await pinned(page);
    expect.soft(at.barTop, `the filters at the top, at ${y}`).toBeCloseTo(0, 0);
    if (!stacked)
      expect.soft(at.headTop, `the head of the columns under the filters, at ${y}`).toBeCloseTo(at.barBottom, 0);
    expect.soft(at.headTop2, `the head of a group under the heads, at ${y}`).toBeCloseTo(at.under, 0);
    expect.soft(at.headGroup, `the head shown is the group of the first note, at ${y}`).toBe(at.noteGroup);
    if (at.headGroup !== undefined) seen.add(at.headGroup);
  }
  // Every group had its head pinned on the way down.
  expect(seen).toEqual(new Set(GROUPS.map(([stage]) => stage)));
  expect.soft(await sideScroll(page)).toBe(0);
  expect.soft(await frame(page).evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
}

for (const [width, height] of [
  [1440, 900],
  [1280, 800],
] as const) {
  test(`at ${width} px the filters and the heads stay at the top, the head of a group while its notes are there`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await open(page);
    await expect(frame(page)).toHaveAttribute('data-stacked', 'false');
    await expect(frame(page).locator('thead th').first()).toBeVisible();
    await expectPinnedDown(page, false);
  });
}

for (const [width, locale] of [
  [1024, 'en'],
  [390, 'fr'],
] as const) {
  test(`at ${width} px the notes are cards, and the filters and the head of a group stay, in ${locale}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await open(page, '', locale);
    // Narrower than the 720 px the table takes, a note is a card: nothing is past the frame.
    await expect(frame(page)).toHaveAttribute('data-stacked', 'true');
    await expectPinnedDown(page, true);
  });
}

test('the table is cards in a narrow window, and a table again once the window is wide', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await open(page);
  await expect(frame(page)).toHaveAttribute('data-stacked', 'true');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(frame(page)).toHaveAttribute('data-stacked', 'false');
  await expect(frame(page).locator('thead th').first()).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(frame(page)).toHaveAttribute('data-stacked', 'true');
});

test('the keyboard never leaves focus behind the pinned heads', async ({ page }) => {
  await open(page);
  // A link of the middle of the list, under the heads, then the keys back up to the notes above it.
  await scrollTo(page, 1800);
  const links = frame(page).getByRole('link', { name: 'Show on the page' });
  const middle = await links.evaluateAll((all) =>
    all.findIndex((link) => link.getBoundingClientRect().top > window.innerHeight / 2),
  );
  await links.nth(middle).focus();
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press('Shift+Tab');
    const at = await page.evaluate(() => {
      const focused = document.activeElement!.getBoundingClientRect();
      const table = document.querySelector('.kit-table')!;
      const heads = [table.querySelector('thead th'), ...table.querySelectorAll('.kit-table-group th')]
        .map((head) => head!.getBoundingClientRect())
        .filter((head) => head.top <= 200);

      return { top: focused.top, covered: Math.max(...heads.map((head) => head.bottom)) };
    });
    expect.soft(at.top, `focus ${press + 1} is under the pinned heads`).toBeGreaterThanOrEqual(at.covered - 1);
  }
});

test('in the board the filters stay at the top too', async ({ page }) => {
  await open(page, '?view=board');
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeVisible();
  const height = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(height).toBeGreaterThan(500);
  await scrollTo(page, height);
  const bar = await page.locator('[data-pinned-filters]').evaluate((element) => element.getBoundingClientRect().top);
  expect.soft(bar).toBeCloseTo(0, 0);
  await expect(page.getByRole('searchbox', { name: 'Search notes' })).toBeInViewport();
});

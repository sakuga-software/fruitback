import { type Page, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * A chunk of notes added at the end of the list draws its own rows, and not the rows above it
 * (FRU-731). Drawing the whole table again took about 0.4 s for each chunk at 500 notes of tasks.
 *
 * The rows React draws are counted from the hook of the React developer tools, which the production
 * build of React calls at each commit: a row drawn is the fiber of a `tr[data-note]` that the commit
 * made, and that carries the flag `PerformedWork` (1). A row whose box is ticked is drawn again, and
 * is counted: the control.
 */
const CONSOLE = 'http://localhost:5178';

const noteOf = (n: number) => ({
  id: `n${n}`,
  excerpt: `Task ${n + 1} of the list`,
  page: { url: `https://acme.dev/p${n}`, host: 'acme.dev', path: `/p${n}` },
  site: { id: 's1' },
  stage: 'new',
  status: 'own:new',
  canSetStatus: true,
  task: { labels: [] },
  author: { kind: 'anonymous' },
  createdAt: new Date(Date.UTC(2026, 9, 13, 12) - n * 60_000).toISOString(),
});
const NOTES = Array.from({ length: 120 }, (_, n) => noteOf(n));
// Each read gives the statuses of the site again, as the worker does: new objects, the same statuses.
const statuses = () => ({ s1: [{ key: 'own:new', name: 'New', stage: 'new' }] });

async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // « Load more » alone reads the next notes: the observer of the browser never fires.
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
    type Fiber = {
      child: Fiber | null;
      sibling: Fiber | null;
      type: unknown;
      flags: number;
      memoizedProps: Record<string, unknown> | null;
    };
    const drawn: string[] = [];
    // The rows of the last commit. A commit that does not render the table keeps the fibers of its rows,
    // with the flags of the render that drew them: only a fiber that is new since the last commit counts.
    let before = new WeakSet<Fiber>();
    Object.assign(window, {
      fruitbackRowsDrawn: drawn,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
          const now = new WeakSet<Fiber>();
          const walk = (first: Fiber | null) => {
            for (let fiber = first; fiber !== null; fiber = fiber.sibling) {
              const row = fiber.child;
              const id = row?.type === 'tr' ? row.memoizedProps?.['data-note'] : undefined;
              if (typeof id === 'string') {
                now.add(fiber);
                if (!before.has(fiber) && (fiber.flags & 1) === 1) drawn.push(id);
              }
              walk(fiber.child);
            }
          };
          walk(root.current);
          before = now;
        },
      },
    });
  });
  await stubWorker(page, {
    workspaces: [ACME],
    answer: (pathname, route) => {
      if (pathname !== '/console/workspaces/w1/notes') return undefined;
      const params = new URL(route.request().url()).searchParams;
      const start = Number((params.get('cursor') ?? 'all:0').split(':')[1]);
      const limit = Number(params.get('limit') ?? 25);

      return route.fulfill({
        json: {
          notes: NOTES.slice(start, start + limit),
          statuses: statuses(),
          ...(params.get('counts') === 'none'
            ? {}
            : { total: NOTES.length, counts: { all: NOTES.length, byPlace: { fruitback: NOTES.length } } }),
          ...(start + limit < NOTES.length ? { next: `all:${start + limit}` } : {}),
        },
      });
    },
  });
  await page.goto(`${CONSOLE}/w/w1/notes`);
  await expect(rows(page)).toHaveCount(25);
}

const rows = (page: Page) => page.locator('[data-notes-list] tbody tr[data-note]');
const loadMore = (page: Page) => page.locator('[data-notes-end]').getByRole('button', { name: 'Load more' });
/** Presses the box of a row: the input of a box of HeroUI is hidden under its drawing (FRU-550). */
const press = (page: Page, text: string, modifiers: 'Shift'[] = []) =>
  page.locator('tr[data-note]', { hasText: text }).locator('.kit-select .checkbox__control').click({ modifiers });

/** The rows drawn since the last call, by the id of their note. */
const drawn = (page: Page) =>
  page.evaluate(() => {
    const ids = (window as unknown as { fruitbackRowsDrawn: string[] }).fruitbackRowsDrawn;

    return ids.splice(0).toSorted();
  });

test('a chunk of notes draws its own rows, and none of the rows above it', async ({ page }) => {
  await open(page);
  await drawn(page);

  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(50);
  await expect(loadMore(page)).toBeEnabled();
  const second = await drawn(page);
  expect(second).toEqual(
    NOTES.slice(25, 50)
      .map((note) => note.id)
      .toSorted(),
  );

  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(75);
  await expect(loadMore(page)).toBeEnabled();
  expect(await drawn(page)).toEqual(
    NOTES.slice(50, 75)
      .map((note) => note.id)
      .toSorted(),
  );
});

test('a row is drawn again when its selection changes, and its menu acts on the whole selection', async ({ page }) => {
  await open(page);
  await drawn(page);

  // The control: a box ticked draws its row, and the count sees it.
  await press(page, 'Task 1 of the list');
  await expect(page.getByRole('region', { name: 'The selected notes' })).toContainText('1 note selected');
  expect(await drawn(page)).toEqual(['n0']);

  // A second box: the first row now acts on both, so it is drawn again too.
  await press(page, 'Task 2 of the list');
  await expect(page.getByRole('region', { name: 'The selected notes' })).toContainText('2 notes selected');
  expect(await drawn(page)).toEqual(['n0', 'n1']);
  await expect(rows(page).first().getByRole('button', { name: 'Actions of the 2 selected notes' })).toBeAttached();
});

test('Shift and a box select a range that two chunks read, from a row drawn before the second', async ({ page }) => {
  await open(page);
  await press(page, 'Task 3 of the list');
  await loadMore(page).click();
  await expect(rows(page)).toHaveCount(50);
  await expect(loadMore(page)).toBeEnabled();

  // The range starts at a row of the first chunk, which was not drawn again: it reads the list now.
  await press(page, 'Task 40 of the list', ['Shift']);
  await expect(page.getByRole('region', { name: 'The selected notes' })).toContainText('38 notes selected');
  await press(page, 'Task 3 of the list');
  await expect(page.getByRole('region', { name: 'The selected notes' })).toContainText('37 notes selected');
});

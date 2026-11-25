import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * The filters on the fields of a task (FRU-655): a row under the others, once the list holds a task
 * Fruitback keeps. Each writes the address and reads again; the day filters send the day of the person.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const AT = '2026-11-20T10:00:00.000Z';

async function worker(p: Page, kept: boolean): Promise<URLSearchParams[]> {
  const asked: URLSearchParams[] = [];
  const note = {
    id: 'n1',
    excerpt: 'The headline runs to three lines on a phone.',
    page: { url: 'https://staging.acme.dev/', host: 'staging.acme.dev', path: '/' },
    site: { id: 's1' },
    stage: 'new',
    author: { kind: 'you', name: 'Ana' },
    createdAt: AT,
    ...(kept
      ? { place: { kind: 'fruitback' }, status: 'own:new', canSetStatus: true, task: { labels: [] } }
      : { place: { kind: 'linear', connector: 'c1', label: 'Acme' }, ref: 'ACM-1' }),
  };
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: 'owner' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      if (pathname === '/console/workspaces/w1/notes') {
        asked.push(new URL(route.request().url()).searchParams);

        return route.fulfill({ json: { notes: [note], total: 1, counts: { all: 1 } } });
      }
      if (pathname.endsWith('/list-members')) {
        return route.fulfill({
          json: {
            members: [
              {
                id: 'm2',
                userId: 'a2',
                role: 'member',
                createdAt: AT,
                user: { id: 'a2', email: 'ben@acme.dev', name: 'Ben Martin' },
              },
            ],
          },
        });
      }
      if (pathname === '/console/workspaces/w1/labels') {
        return route.fulfill({ json: { labels: [{ id: 'l1', name: 'Bug', color: '#dc2626' }] } });
      }

      return undefined;
    },
  });

  return asked;
}

/** FRU-686: a filter is chosen from « Filter »: its field, then its value. */
async function choose(page: Page, field: string, value: string): Promise<void> {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menuitem', { name: field, exact: true }).click();
  await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}
/** The chips of the filters that are on (FRU-686). */
const chips = (p: Page) => p.getByRole('group', { name: 'Filters on' }).locator('.kit-filter-tag');

test('each filter on the tasks writes the address and asks the worker, and they combine', async ({ page: p }) => {
  const asked = await worker(p, true);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.getByText('The headline runs')).toBeVisible();

  await choose(p, 'Assignee', 'Ben Martin');
  await expect(p).toHaveURL(/assignee=a2/);
  await choose(p, 'Priority', 'High');
  await choose(p, 'Label', 'Bug');
  await choose(p, 'Due day', 'Overdue');
  await expect(p).toHaveURL(/due=overdue/);
  // The read of the last filter is asked after the address changes.
  await expect.poll(() => asked.at(-1)?.get('due')).toBe('overdue');

  const last = asked.at(-1) as URLSearchParams;
  expect(Object.fromEntries(['assignee', 'priority', 'label', 'due'].map((name) => [name, last.get(name)]))).toEqual({
    assignee: 'a2',
    priority: 'high',
    label: 'l1',
    due: 'overdue',
  });
  // The day of the person, which the worker cannot know.
  expect(last.get('today')).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // A reload keeps them: they are in the address, and each has its chip (FRU-686).
  await p.reload();
  await expect(chips(p)).toHaveText(['AssigneeBen Martin', 'PriorityHigh', 'LabelBug', 'Due dayOverdue']);
});

test('a list with no task Fruitback keeps offers no filter of the tasks', async ({ page: p }) => {
  await worker(p, false);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.getByText('The headline runs')).toBeVisible();
  await p.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(p.getByRole('menuitem', { name: 'Status', exact: true })).toBeVisible();
  await expect(p.getByRole('menuitem', { name: 'Assignee', exact: true })).toHaveCount(0);
});

test('« Unresolved » of the status asks the worker for the notes not done nor closed, and « Any status » for every note again (FRU-667)', async ({
  page: p,
}) => {
  const asked = await worker(p, true);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.getByText('The headline runs')).toBeVisible();

  await choose(p, 'Status', 'Unresolved');
  await expect(p).toHaveURL(/unresolved=1/);
  await expect.poll(() => asked.at(-1)?.get('unresolved')).toBe('1');
  expect(asked.at(-1)?.get('stage')).toBeNull();
  // A reload keeps it: it is in the address.
  await p.reload();
  await expect(chips(p)).toHaveText(['StatusUnresolved']);

  // A stage takes its place: the worker gets one of the two, never both.
  await choose(p, 'Status', 'Done');
  await expect.poll(() => asked.at(-1)?.get('stage')).toBe('done');
  expect(asked.at(-1)?.get('unresolved')).toBeNull();
  await expect(p).not.toHaveURL(/unresolved=/);

  // The other direction: « Any status » reads every note again.
  await choose(p, 'Status', 'Unresolved');
  await expect.poll(() => asked.at(-1)?.get('unresolved')).toBe('1');
  await choose(p, 'Status', 'Any status');
  await expect.poll(() => asked.at(-1)?.has('unresolved')).toBe(false);
  await expect(p).not.toHaveURL(/unresolved=/);
});

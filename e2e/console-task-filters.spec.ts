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

async function pick(p: Page, button: RegExp, option: string): Promise<void> {
  await p.getByRole('button', { name: button }).click();
  await p.getByRole('option', { name: option, exact: true }).click();
}

test('each filter on the tasks writes the address and asks the worker, and they combine', async ({ page: p }) => {
  const asked = await worker(p, true);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.locator('[data-task-filters]')).toBeVisible();

  await pick(p, /Anyone assigned/, 'Ben Martin');
  await expect(p).toHaveURL(/assignee=a2/);
  await pick(p, /Any priority/, 'High');
  await pick(p, /Any label/, 'Bug');
  await pick(p, /Any due day/, 'Overdue');
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

  // A reload keeps them: they are in the address.
  await p.reload();
  await expect(p.getByRole('button', { name: /Overdue/ })).toBeVisible();
  await expect(p.getByRole('button', { name: /Ben Martin/ })).toBeVisible();
});

test('a list with no task Fruitback keeps draws no row of task filters', async ({ page: p }) => {
  await worker(p, false);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.getByText('The headline runs')).toBeVisible();
  await expect(p.locator('[data-task-filters]')).toHaveCount(0);
});

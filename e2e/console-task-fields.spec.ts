import { type Page, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * The fields of a task the worker keeps (FRU-652), under its text in the table and on the board:
 * the priority, the day, who does it, and the labels. The worker is answered by stubs at the shape of
 * `GET …/notes`, which gives each kept note its `task`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const page = (path: string) => ({ url: `https://staging.acme.dev${path}`, host: 'staging.acme.dev', path });
const AT = '2026-10-20T10:00:00.000Z';
const STATUSES = [
  { key: 'own:new', name: '', stage: 'new' },
  { key: 'own:todo', name: '', stage: 'todo' },
  { key: 'own:progress', name: '', stage: 'progress' },
  { key: 'own:done', name: '', stage: 'done' },
  { key: 'own:closed', name: '', stage: 'closed' },
];
const kept = { site: { id: 's1' }, place: { kind: 'fruitback' }, canSetStatus: true, createdAt: AT };
const NOTES = [
  {
    ...kept,
    id: 'n1',
    excerpt: 'The headline runs to three lines on a phone.',
    page: page('/'),
    stage: 'todo',
    status: 'own:todo',
    author: { kind: 'you', name: 'Ana' },
    task: {
      assignee: { id: 'u2', name: 'Ben Martin' },
      priority: 'urgent',
      dueOn: '2026-12-01',
      labels: [
        { id: 'l1', name: 'Bug', color: '#dc2626' },
        { id: 'l2', name: 'Mobile', color: '#2563eb' },
      ],
    },
  },
  {
    ...kept,
    id: 'n2',
    excerpt: 'The price of the yearly plan is wrong.',
    page: page('/pricing'),
    stage: 'new',
    status: 'own:new',
    author: { kind: 'member', name: 'Ben' },
    task: { labels: [] },
  },
];

async function notes(page: Page, locale: 'en' | 'fr' = 'en', view = ''): Promise<void> {
  await stubWorker(page, {
    locale,
    workspaces: [{ ...ACME, role: 'owner' }],
    sites: SITES,
    answer: (pathname, route) =>
      pathname === '/console/workspaces/w1/notes'
        ? route.fulfill({ json: { notes: NOTES, total: 2, counts: { all: 2 }, statuses: { s1: STATUSES } } })
        : undefined,
  });
  await page.goto(`${CONSOLE}/w/w1/notes${view}`);
  await expect(page.getByText('The headline runs')).toBeVisible();
}

test('a row says the priority, the day, the assignee and the labels of its task, and nothing when none is set', async ({
  page,
}) => {
  await notes(page);
  const marks = page.locator('tr', { hasText: 'The headline' }).locator('[data-task-marks]');
  await expect(marks).toContainText('Urgent');
  await expect(marks).toContainText('Due 1 Dec');
  await expect(marks).toContainText('Assigned to Ben Martin');
  await expect(marks).toContainText('Bug');
  await expect(marks).toContainText('Mobile');
  // The control: a task with no field set draws no line.
  await expect(page.locator('tr', { hasText: 'The price of the yearly' }).locator('[data-task-marks]')).toHaveCount(0);
});

test('a card of the board says them too, and in French', async ({ page }) => {
  await notes(page, 'fr', '?view=board');
  const marks = page.locator('[data-task-marks]');
  await expect(marks).toHaveCount(1);
  await expect(marks).toContainText('Urgente');
  await expect(marks).toContainText('Assignée à Ben Martin');
  await expect(marks).toContainText('Échéance 1 déc.');
});

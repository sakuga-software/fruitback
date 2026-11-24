import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * A task written by hand (FRU-657): « New task » at the head of the list and of each column of the
 * board, and the key « C ». The worker is answered by stubs at the shape of `POST …/notes` and of
 * `GET …/notes/<note>`, which reads a task as `{ task }`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const AT = '2026-11-24T10:00:00.000Z';
const STATUSES = ['new', 'todo', 'progress', 'done', 'closed'].map((stage) => ({
  key: `own:${stage}`,
  name: '',
  stage,
}));

type Sent = { path: string; body: Record<string, unknown> };

async function worker(p: Page, { refuse = false }: { refuse?: boolean } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  const written: Record<string, unknown>[] = [];
  const listed = () => [
    ...written.map((body, index) => ({
      id: `t${index + 1}`,
      note: `task_${index + 1}`,
      excerpt: body.title,
      page: { url: '', host: '', path: '' },
      site: { id: 's1' },
      stage: String(body.status ?? 'own:new').slice('own:'.length),
      status: body.status ?? 'own:new',
      canSetStatus: true,
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'fruitback' },
      task: { labels: [], ...(body.priority === undefined ? {} : { priority: body.priority }) },
      createdAt: AT,
    })),
    {
      id: 'n1',
      note: 'sd_1',
      excerpt: 'The price of the yearly plan is cut off on a phone.',
      page: { url: 'https://staging.acme.dev/pricing', host: 'staging.acme.dev', path: '/pricing' },
      site: { id: 's1' },
      stage: 'new',
      status: 'own:new',
      canSetStatus: true,
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'fruitback' },
      task: { labels: [] },
      createdAt: AT,
    },
  ];
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: 'owner' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      const request = route.request();
      if (pathname === '/console/workspaces/w1/notes' && request.method() === 'POST') {
        const body = request.postDataJSON() as Record<string, unknown>;
        sent.push({ path: pathname, body });
        if (refuse) return route.fulfill({ status: 409, json: { error: 'status-changed' } });
        written.push(body);

        return route.fulfill({
          status: 201,
          json: { id: `t${written.length}`, identifier: `FB-${40 + written.length}`, stage: 'new' },
        });
      }
      if (pathname === '/console/workspaces/w1/notes') {
        const notes = listed();

        return route.fulfill({
          json: { notes, total: notes.length, counts: { all: notes.length }, statuses: { s1: STATUSES } },
        });
      }
      if (pathname.endsWith('/list-members') || pathname === '/console/workspaces/w1/labels') {
        return route.fulfill({ json: { members: [], labels: [] } });
      }
      const one = /^\/console\/workspaces\/w1\/notes\/t(\d+)$/.exec(pathname);
      if (one !== null) {
        const body = written[Number(one[1]) - 1] as Record<string, unknown>;

        return route.fulfill({
          json: {
            task: {
              id: one[1],
              identifier: `FB-${40 + Number(one[1])}`,
              title: body.title,
              stage: 'new',
              stateName: '',
              status: 'own:new',
              updatedAt: AT,
              comments: [],
              mine: true,
              task: {
                kind: 'fruitback.task',
                v: 1,
                id: `task_${one[1]}`,
                createdAt: AT,
                title: body.title,
                ...(body.text === undefined ? {} : { text: body.text }),
              },
            },
          },
        });
      }

      return undefined;
    },
  });

  return sent;
}

test('« New task » takes a title, then the task is in the list with no page, and opens in its panel', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.locator('tr', { hasText: 'The price' })).toBeVisible();

  await p.getByRole('button', { name: /New task/ }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Title')).toBeFocused();
  // No title: nothing is sent, and the field says why.
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect(dialog.getByText('Give the task a title.')).toBeVisible();
  expect(sent).toEqual([]);

  await dialog.getByLabel('Title').fill('Write the release notes');
  await dialog.getByLabel('Text').fill('Every change of 0.8.0.\nFor the newsletter too.');
  await dialog.getByRole('button', { name: /Priority/ }).click();
  await p.getByRole('option', { name: 'High', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create the task' }).click();

  await expect
    .poll(() => sent)
    .toEqual([
      {
        path: '/console/workspaces/w1/notes',
        body: {
          site: 's1',
          title: 'Write the release notes',
          text: 'Every change of 0.8.0.\nFor the newsletter too.',
          status: 'own:new',
          priority: 'high',
        },
      },
    ]);
  const panel = p.getByRole('dialog', { name: 'Write the release notes' });
  await expect(panel).toBeVisible();
  await expect(p).toHaveURL(/task=t1/);
  await expect(panel.locator('[data-task-reference]')).toHaveText('FB-41');
  await expect(panel.locator('[data-task-text]')).toContainText('For the newsletter too.');
  await expect(panel.getByText('Written by hand: no page and no pin.')).toBeVisible();
  await p.keyboard.press('Escape');

  // In the list, a task has no link to a page.
  const row = p.locator('tr', { hasText: 'Write the release notes' });
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: 'Show on the page' })).toHaveCount(0);
  await expect(p.locator('tr', { hasText: 'The price' }).getByRole('link', { name: 'Show on the page' })).toHaveCount(
    1,
  );
});

test('the key C opens « New task », but not in a field; the head of a column of the board gives its status', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await expect(p.locator('section[data-column="own:todo"]')).toBeVisible();

  // A « c » typed in the search is a letter of the search.
  await p.getByRole('searchbox').fill('c');
  await expect(p.getByRole('dialog')).toHaveCount(0);
  await p.getByRole('searchbox').fill('');
  await p.locator('body').click({ position: { x: 5, y: 5 } });
  await p.keyboard.press('c');
  await expect(p.getByRole('dialog', { name: 'New task' })).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog')).toHaveCount(0);

  await p.getByRole('button', { name: 'New task in To do' }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByRole('button', { name: /Status/ })).toContainText('To do');
  await dialog.getByLabel('Title').fill('Call the printer');
  await dialog.getByLabel('Title').press('Enter');
  await expect.poll(() => sent.at(-1)?.body).toEqual({ site: 's1', title: 'Call the printer', status: 'own:todo' });
  await expect(p.locator('section[data-column="own:todo"]')).toContainText('Call the printer');
});

test('a refusal keeps what was typed, and the dialog fits a phone', async ({ page: p }) => {
  const sent = await worker(p, { refuse: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.getByText('The price of the yearly plan')).toBeVisible();

  await p.getByRole('button', { name: /New task/ }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Title').fill('Check the invoices');
  await dialog.getByLabel('Text').fill('All of May.');
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect(dialog.getByText('This status was removed since the list was read. Reload the page.')).toBeVisible();
  await expect(dialog.getByLabel('Title')).toHaveValue('Check the invoices');
  expect(sent).toHaveLength(1);
  expect(await sideScroll(p)).toBe(0);

  // Closed, then opened again: the draft is still there.
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: /New task/ }).click();
  await expect(p.getByRole('dialog', { name: 'New task' }).getByLabel('Text')).toHaveValue('All of May.');
});

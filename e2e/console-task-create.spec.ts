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

/** A status the team of `s1` added, which no other site has. */
const REVIEW = { key: 'own:review', name: 'Review', stage: 'progress' };

type Sent = { path: string; body: Record<string, unknown> };

async function worker(
  p: Page,
  {
    refuse = false,
    sites = SITES,
    role = 'owner',
  }: { refuse?: boolean; sites?: typeof SITES; role?: 'owner' | 'guest' } = {},
): Promise<Sent[]> {
  const sent: Sent[] = [];
  const written: Record<string, unknown>[] = [];
  const listed = () => [
    ...written.map((body, index) => ({
      id: `t${index + 1}`,
      note: `task_${index + 1}`,
      excerpt: body.title,
      page: { url: '', host: '', path: '' },
      // FRU-672: a task with no site is listed with the site `''`.
      site: { id: typeof body.site === 'string' ? body.site : '' },
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
    workspaces: [{ ...ACME, role }],
    sites,
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
          json: { notes, total: notes.length, counts: { all: notes.length }, statuses: { s1: [...STATUSES, REVIEW] } },
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

  await p.getByRole('button', { name: 'New task', exact: true }).click();
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

test('« + » in the head of a group of the list gives its status (FRU-685)', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  const head = p.locator('tbody[data-group="new"] .kit-table-group');
  await expect(head).toBeVisible();
  await head.getByRole('button', { name: 'New task in New' }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByRole('button', { name: /Status/ })).toContainText('New');
  await dialog.getByLabel('Title').fill('Call the printer');
  await dialog.getByLabel('Title').press('Enter');
  await expect.poll(() => sent.at(-1)?.body).toEqual({ site: 's1', title: 'Call the printer', status: 'own:new' });
});

test('a refusal keeps what was typed, and the dialog fits a phone', async ({ page: p }) => {
  const sent = await worker(p, { refuse: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.getByText('The price of the yearly plan')).toBeVisible();

  await p.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Title').fill('Check the invoices');
  await dialog.getByLabel('Text').fill('All of May.');
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect(
    dialog.getByText(
      'This status was removed since the list was read. Create the task again: it takes the first status of its site.',
    ),
  ).toBeVisible();
  await expect(dialog.getByLabel('Title')).toHaveValue('Check the invoices');
  expect(sent).toHaveLength(1);
  expect(await sideScroll(p)).toBe(0);
  // A second press sends no status: the site gives its first one.
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.body.status).toBeUndefined();

  // Closed, then opened again: the draft is still there.
  await p.keyboard.press('Escape');
  await p.getByRole('button', { name: 'New task', exact: true }).click();
  await expect(p.getByRole('dialog', { name: 'New task' }).getByLabel('Text')).toHaveValue('All of May.');
});

test('a status the team added is of its site: another site chosen starts from its own, a built-in one stays', async ({
  page: p,
}) => {
  const sent = await worker(p, {
    sites: [...SITES, { id: 's2', origin: 'https://www.acme.dev', visibility: 'members' }],
  });
  await p.goto(`${CONSOLE}/w/w1/notes?view=board&site=s1`);
  const dialog = p.getByRole('dialog', { name: 'New task' });
  const create = async (column: string, title: string) => {
    await p.getByRole('button', { name: `New task in ${column}` }).click();
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByRole('button', { name: /Site/ }).click();
    await p.getByRole('option', { name: 'https://www.acme.dev' }).click();
    await dialog.getByRole('button', { name: 'Create the task' }).click();
    await expect(p.getByRole('dialog', { name: title })).toBeVisible();
    await p.keyboard.press('Escape');
  };

  // `s2` has no « Review »: the list read no status of it, so none is sent, and the worker gives the first.
  await create('Review', 'Order the banners');
  expect(sent.at(-1)?.body).toEqual({ site: 's2', title: 'Order the banners' });
  // « To do » is a status of every site.
  await create('To do', 'Call the printer');
  expect(sent.at(-1)?.body).toEqual({ site: 's2', title: 'Call the printer', status: 'own:todo' });
});

test('a status asked from a column does not stay for the next « New task », once cancelled', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?view=board&site=s1`);
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await p.getByRole('button', { name: 'New task in Review' }).click();
  await dialog.getByLabel('Title').fill('Order the banners');
  await p.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The head of the list asks no status: the title typed stays, the status is the first of the site.
  await p
    .getByRole('button', { name: /^New task/ })
    .first()
    .click();
  await expect(dialog.getByLabel('Title')).toHaveValue('Order the banners');
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect.poll(() => sent.at(-1)?.body).toEqual({ site: 's1', title: 'Order the banners', status: 'own:new' });
});

test('a status chosen in the dialog stays with the draft, as the words typed do', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?site=s1`);
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await p
    .getByRole('button', { name: /^New task/ })
    .first()
    .click();
  await dialog.getByLabel('Title').fill('Print the menus');
  await dialog.getByRole('button', { name: /Status/ }).click();
  await p.getByRole('option', { name: 'In progress' }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await p
    .getByRole('button', { name: /^New task/ })
    .first()
    .click();
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect.poll(() => sent.at(-1)?.body).toEqual({ site: 's1', title: 'Print the menus', status: 'own:progress' });
});

test('a member writes a task of the whole workspace, with no site and the built-in statuses (FRU-672)', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.locator('tr', { hasText: 'The price' })).toBeVisible();

  await p.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await dialog.getByLabel('Title').fill('Renew the domain');
  await dialog.getByRole('button', { name: /Site/ }).click();
  await expect(p.getByRole('option')).toHaveText(['https://staging.acme.dev', 'No site: the whole workspace']);
  await p.getByRole('option', { name: 'No site: the whole workspace' }).click();
  // The statuses of a task of the workspace are the built-in ones: « Review » is of the site.
  await dialog.getByRole('button', { name: /Status/ }).click();
  await expect(p.getByRole('option')).toHaveText(['New', 'To do', 'In progress', 'Done', 'Closed']);
  await p.getByRole('option', { name: 'To do' }).click();
  await dialog.getByRole('button', { name: 'Create the task' }).click();

  await expect
    .poll(() => sent)
    .toEqual([{ path: '/console/workspaces/w1/notes', body: { title: 'Renew the domain', status: 'own:todo' } }]);
  const panel = p.getByRole('dialog', { name: 'Renew the domain' });
  await expect(panel.getByText('Written by hand: no page and no pin. No site: the whole workspace.')).toBeVisible();
  await p.keyboard.press('Escape');
  const row = p.locator('tr', { hasText: 'Renew the domain' });
  await expect(row.locator('[data-no-site]')).toHaveText('No site');
  // The note of the site keeps its host.
  await expect(p.locator('tr', { hasText: 'The price' }).locator('[data-no-site]')).toHaveCount(0);
});

test('a guest is offered no task of the whole workspace (FRU-672)', async ({ page: p }) => {
  const sent = await worker(p, { role: 'guest' });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(p.locator('tr', { hasText: 'The price' })).toBeVisible();

  await p.getByRole('button', { name: 'New task', exact: true }).click();
  const dialog = p.getByRole('dialog', { name: 'New task' });
  await expect(dialog.getByLabel('Title')).toBeFocused();
  // One site and no other choice: no choice of the site at all.
  await expect(dialog.getByRole('button', { name: /Site/ })).toHaveCount(0);
  await dialog.getByLabel('Title').fill('Check the footer');
  await dialog.getByRole('button', { name: 'Create the task' }).click();
  await expect.poll(() => sent.at(-1)?.body).toEqual({ site: 's1', title: 'Check the footer', status: 'own:new' });
});

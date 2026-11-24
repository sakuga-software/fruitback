import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, stubWorker } from './console-workspace.ts';

/**
 * The menu of a task (FRU-654): its button closes a row of the table and the foot of a card, and a
 * right click opens it too. A task the worker keeps, that this person may change, offers its status,
 * its assignee, its priority, its day and its labels; every note offers its link. The worker is
 * answered by stubs at the shape of `POST …/notes/<note>/task` and `…/labels`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const page = (path: string) => ({ url: `https://staging.acme.dev${path}`, host: 'staging.acme.dev', path });
const AT = '2026-11-20T10:00:00.000Z';
const STATUSES = ['new', 'todo', 'progress', 'done', 'closed'].map((stage) => ({
  key: `own:${stage}`,
  name: '',
  stage,
}));

type Sent = { path: string; body: unknown };

type Member = {
  id: string;
  userId: string;
  role: Role;
  createdAt: string;
  user: { id: string; email: string; name: string };
};
const member = (n: number, name: string, role: Role = 'member'): Member => ({
  id: `m${n}`,
  userId: `a${n}`,
  role,
  createdAt: AT,
  user: { id: `a${n}`, email: `p${n}@acme.dev`, name },
});
const MEMBERS = [member(1, 'Ana', 'owner'), member(2, 'Ben Martin'), member(3, 'Gus', 'guest')];

/**
 * `list-members` with the rule of the worker (FRU-673): a page of 1 to 100 members (`MEMBERS_PAGE` of
 * `organization-paths.ts`), else `400 invalid-request`, from `offset`, in the order they joined, with
 * `total`. The stub of before answered any `limit`, so the menu that asked for 200 passed here and
 * listed nobody on a worker. `fail` counts down the reads that answer `503` first.
 */
function members(route: Route, all: readonly Member[], fail?: { reads: number }) {
  const query = new URL(route.request().url()).searchParams;
  const limit = Number(query.get('limit') ?? 100);
  const offset = Number(query.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return route.fulfill({ status: 400, json: { error: 'invalid-request', field: 'limit' } });
  }
  if (fail !== undefined && fail.reads > 0) {
    fail.reads -= 1;

    return route.fulfill({ status: 503, json: { error: 'store-unavailable' } });
  }

  return route.fulfill({ json: { members: all.slice(offset, offset + limit), total: all.length } });
}

async function worker(
  p: Page,
  options: {
    role?: Role;
    refuse?: string;
    members?: readonly Member[];
    membersFail?: { reads: number };
    /** FRU-675: the reads of `GET …/labels` that answer `503` first. */
    labelsFail?: { reads: number };
  } = {},
): Promise<Sent[]> {
  const sent: Sent[] = [];
  const labels = [{ id: 'l1', name: 'Bug', color: '#dc2626' }];
  const notes = [
    {
      id: 'n1',
      excerpt: 'The headline runs to three lines on a phone.',
      page: page('/'),
      site: { id: 's1' },
      stage: 'new',
      status: 'own:new',
      canSetStatus: true,
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'fruitback' },
      task: { labels: [] as { id: string; name: string; color: string }[] },
      createdAt: AT,
    },
    {
      id: 'n2',
      excerpt: 'The returns policy says "recieve".',
      page: page('/help'),
      site: { id: 's1' },
      stage: 'progress',
      author: { kind: 'member', name: 'Ben' },
      place: { kind: 'linear', connector: 'c1', label: 'Acme' },
      ref: 'ACM-149',
      createdAt: AT,
    },
  ];
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: options.role ?? 'owner' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      const request = route.request();
      if (pathname === '/console/workspaces/w1/notes') {
        return route.fulfill({ json: { notes, total: 2, counts: { all: 2 }, statuses: { s1: STATUSES } } });
      }
      if (pathname.endsWith('/list-members')) return members(route, options.members ?? MEMBERS, options.membersFail);
      if (pathname === '/console/workspaces/w1/labels') {
        if (request.method() === 'GET') {
          if (options.labelsFail !== undefined && options.labelsFail.reads > 0) {
            options.labelsFail.reads -= 1;

            return route.fulfill({ status: 503, json: { error: 'store-unavailable' } });
          }

          return route.fulfill({ json: { labels } });
        }
        const body = request.postDataJSON() as { name: string; color: string };
        sent.push({ path: pathname, body });
        const label = { id: `l${labels.length + 1}`, ...body };
        labels.push(label);

        return route.fulfill({ status: 201, json: { label } });
      }
      const task = /^\/console\/workspaces\/w1\/notes\/(\w+)\/task$/.exec(pathname);
      if (task !== null) {
        const body = request.postDataJSON() as { priority?: string; labels?: string[]; assignee?: string };
        sent.push({ path: pathname, body });
        if (options.refuse !== undefined) return route.fulfill({ status: 409, json: { error: options.refuse } });
        const note = notes.find((one) => one.id === task[1]);
        if (note?.task !== undefined) {
          Object.assign(note.task, body.priority === undefined ? {} : { priority: body.priority });
          if (body.labels !== undefined) note.task.labels = labels.filter((one) => body.labels?.includes(one.id));
          if (body.assignee !== undefined) {
            const named = (options.members ?? MEMBERS).find((one) => one.user.id === body.assignee);
            Object.assign(note.task, { assignee: { id: body.assignee, name: named?.user.name ?? '' } });
          }
        }

        return route.fulfill({ status: 204 });
      }

      return undefined;
    },
  });

  return sent;
}

const row = (p: Page, text: string) => p.locator('tr', { hasText: text });

test('a right click on a row opens the menu of its task, and a priority is saved at once', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });

  await expect(p.getByRole('menuitem', { name: 'Priority' })).toBeVisible();
  // The members are offered, a guest is not: a guest reads only the sites shared with them.
  await p.getByRole('menuitem', { name: 'Assignee' }).hover();
  await expect(p.getByRole('menuitemradio', { name: 'Ben Martin' })).toBeVisible();
  await expect(p.getByRole('menuitemradio', { name: 'Gus' })).toHaveCount(0);
  await p.getByRole('menuitem', { name: 'Priority' }).hover();
  await p.getByRole('menuitemradio', { name: 'High' }).click();

  expect(sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/task', body: { priority: 'high' } }]);
  await expect(row(p, 'The headline').locator('[data-task-marks]')).toContainText('High');
});

test('the keyboard opens the menu with Shift+F10, and a note of a tracker offers its link only', async ({
  page: p,
}) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);

  await row(p, 'The returns policy').getByRole('button', { name: 'Actions of this note' }).focus();
  await p.keyboard.press('Shift+F10');
  await expect(p.getByRole('menuitem', { name: 'Copy the link to the note' })).toBeVisible();
  await expect(p.getByRole('menuitem', { name: 'Priority' })).toHaveCount(0);
});

test('a new label is added from the menu, and goes on the task it was asked from', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await p.getByText('The headline runs').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();
  await p.getByRole('menuitemcheckbox', { name: 'New label…' }).click();

  const dialog = p.getByRole('dialog', { name: 'New label' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Mobile');
  await dialog.getByText('Blue', { exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'Blue' })).toBeChecked();
  await dialog.getByRole('button', { name: 'Add the label' }).click();

  await expect(dialog).toBeHidden();
  expect(sent).toEqual([
    { path: '/console/workspaces/w1/labels', body: { name: 'Mobile', color: '#2563eb' } },
    { path: '/console/workspaces/w1/notes/n1/task', body: { labels: ['l2'] } },
  ]);
  await expect(p.locator('[data-task-marks]')).toContainText('Mobile');
});

test('a member who may not add a label is told who does, and a refusal is said under the note', async ({ page: p }) => {
  const sent = await worker(p, { role: 'member', refuse: 'not-member' });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();
  await expect(p.getByRole('menuitemcheckbox', { name: 'New label…' })).toHaveCount(0);
  await p.getByRole('menuitemcheckbox', { name: 'Bug' }).click();

  expect(sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/task', body: { labels: ['l1'] } }]);
  await expect(row(p, 'The headline').getByRole('alert')).toContainText('no longer a member');
});

test('a new label that the task does not take keeps the dialog open, and says why', async ({ page: p }) => {
  const sent = await worker(p, { refuse: 'not-allowed' });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();
  await p.getByRole('menuitemcheckbox', { name: 'New label…' }).click();
  const dialog = p.getByRole('dialog', { name: 'New label' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Mobile');
  await dialog.getByRole('button', { name: 'Add the label' }).click();

  await expect(dialog.getByRole('alert')).toContainText('added to the workspace, but not to this note');
  // The label is made once: its name goes, so a second press does not make it again.
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  expect(sent.map((one) => one.path)).toEqual([
    '/console/workspaces/w1/labels',
    '/console/workspaces/w1/notes/n1/task',
  ]);
});

test('a workspace past a hundred members offers every one of them, and a task goes to the last one (FRU-673)', async ({
  page: p,
}) => {
  // 130 members: two pages of the worker. The menu asked for 200 in one page, got a 400, and listed nobody.
  const crowd = [member(1, 'Ana', 'owner'), ...Array.from({ length: 129 }, (_, n) => member(n + 2, `Person ${n + 2}`))];
  const sent = await worker(p, { members: crowd });
  const asked: string[] = [];
  p.on('request', (request) => {
    if (request.url().includes('/list-members')) asked.push(new URL(request.url()).searchParams.toString());
  });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Assignee' }).hover();

  const assignee = p.getByRole('menu', { name: 'Assignee' });
  await expect(assignee.getByRole('menuitemradio', { name: 'Ana' })).toBeVisible();
  await expect(assignee.getByRole('menuitemradio')).toHaveCount(1 + 130);
  await assignee.getByRole('menuitemradio', { name: 'Person 130' }).click();

  expect(sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/task', body: { assignee: 'a130' } }]);
  await expect(row(p, 'The headline').locator('[data-task-marks]')).toContainText('Person 130');
  // Two pages of a hundred at most, the second from the hundredth member.
  expect(asked).toEqual(['organizationId=w1&limit=100&offset=0', 'organizationId=w1&limit=100&offset=100']);
});

test('the members that did not load are said in the menu, and « Try again » reads them (FRU-673)', async ({
  page: p,
}) => {
  const sent = await worker(p, { membersFail: { reads: 1 } });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Assignee' }).hover();

  const assignee = p.getByRole('menu', { name: 'Assignee' });
  // Not a menu with nobody in it: the sentence, the cause, and a way to read them again.
  await expect(assignee.getByRole('menuitem', { name: /The members did not load\./ })).toBeDisabled();
  await expect(assignee.getByRole('menuitem', { name: /The members did not load\./ })).toContainText(
    'Fruitback hit an error.',
  );
  await expect(assignee.getByRole('menuitemradio')).toHaveCount(0);
  await assignee.getByRole('menuitem', { name: 'Try again' }).click();

  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Assignee' }).hover();
  await p.getByRole('menuitemradio', { name: 'Ben Martin' }).click();
  expect(sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/task', body: { assignee: 'a2' } }]);
  await expect(row(p, 'The headline').locator('[data-task-marks]')).toContainText('Ben Martin');
});

test('the labels that did not load are said in the menu, never « No label yet », and « Try again » reads them (FRU-675)', async ({
  page: p,
}) => {
  // A member: the menu of before said « No label yet » to them, as if the workspace had none.
  const sent = await worker(p, { role: 'member', labelsFail: { reads: 1 } });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();

  const labels = p.getByRole('menu', { name: 'Labels' });
  await expect(labels.getByRole('menuitem', { name: /The labels did not load\./ })).toBeDisabled();
  await expect(labels.getByRole('menuitem', { name: /The labels did not load\./ })).toContainText(
    'Fruitback hit an error.',
  );
  await expect(labels.getByText('No label yet')).toHaveCount(0);
  await expect(labels.getByRole('menuitemcheckbox')).toHaveCount(0);
  await labels.getByRole('menuitem', { name: 'Try again' }).click();

  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();
  await p.getByRole('menuitemcheckbox', { name: 'Bug' }).click();
  expect(sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/task', body: { labels: ['l1'] } }]);
  await expect(row(p, 'The headline').locator('[data-task-marks]')).toContainText('Bug');
});

test('an owner whose labels did not load is not offered « New label… » alone (FRU-675)', async ({ page: p }) => {
  await worker(p, { labelsFail: { reads: 1 } });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();

  // Which labels the workspace holds is not known: a new one could take the name of one of them.
  const labels = p.getByRole('menu', { name: 'Labels' });
  await expect(labels.getByRole('menuitem', { name: /The labels did not load\./ })).toBeVisible();
  await expect(labels.getByRole('menuitemcheckbox')).toHaveCount(0);
  await labels.getByRole('menuitem', { name: 'Try again' }).click();

  await row(p, 'The headline').getByText('The headline').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Labels' }).hover();
  await expect(p.getByRole('menuitemcheckbox', { name: 'Bug' })).toBeVisible();
  await expect(p.getByRole('menuitemcheckbox', { name: 'New label…' })).toBeVisible();
});

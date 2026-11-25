import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * The place of a task in its column, its archive and its deletion (FRU-665). The worker is answered by
 * stubs at the shape of `POST …/notes/<note>/task` (`position`, `archived`), `DELETE …/task` and
 * `GET …/notes?archived=1`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const STATUSES = ['new', 'todo', 'progress', 'done', 'closed'].map((stage) => ({
  key: `own:${stage}`,
  name: '',
  stage,
}));

type Sent = { method: string; path: string; body: unknown };
type Task = { labels: never[]; position?: number; archived?: true };
type Note = { id: string; excerpt: string; createdAt: string; task: Task };

async function worker(p: Page): Promise<Sent[]> {
  const sent: Sent[] = [];
  // Three tasks of one column, the newest first: Alpha, then Beta, then Gamma.
  const notes: Note[] = [
    ['n1', 'Alpha task', '2026-11-20T12:00:00.000Z'],
    ['n2', 'Beta task', '2026-11-20T11:00:00.000Z'],
    ['n3', 'Gamma task', '2026-11-20T10:00:00.000Z'],
  ].map(([id, excerpt, createdAt]) => ({
    id: id as string,
    excerpt: excerpt as string,
    createdAt: createdAt as string,
    task: { labels: [] },
  }));
  const shown = (note: Note) => ({
    ...note,
    page: { url: 'https://staging.acme.dev/', host: 'staging.acme.dev', path: '/' },
    site: { id: 's1' },
    stage: 'new',
    status: 'own:new',
    canSetStatus: true,
    author: { kind: 'you', name: 'Ana' },
    place: { kind: 'fruitback' },
  });
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: 'owner' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      const request = route.request();
      if (pathname === '/console/workspaces/w1/notes') {
        const archived = new URL(request.url()).searchParams.get('archived') === '1';
        const listed = notes.filter((note) => (note.task.archived === true) === archived).map(shown);

        return route.fulfill({
          json: { notes: listed, total: listed.length, counts: { all: listed.length }, statuses: { s1: STATUSES } },
        });
      }
      if (pathname.endsWith('/list-members') || pathname.endsWith('/labels')) {
        return route.fulfill({ json: { members: [], labels: [] } });
      }
      const task = /^\/console\/workspaces\/w1\/notes\/(\w+)\/task$/.exec(pathname);
      if (task === null) return undefined;
      const body =
        request.method() === 'DELETE'
          ? undefined
          : (request.postDataJSON() as { position?: number; archived?: boolean });
      sent.push({ method: request.method(), path: pathname, body });
      const at = notes.findIndex((note) => note.id === task[1]);
      if (request.method() === 'DELETE') notes.splice(at, 1);
      else {
        const note = notes[at] as Note;
        if (body?.position !== undefined) note.task.position = body.position;
        if (body?.archived === true) note.task.archived = true;
        if (body?.archived === false) delete note.task.archived;
      }

      return route.fulfill({ status: 204 });
    },
  });

  return sent;
}

const order = (p: Page) => p.locator('section[data-column] li[data-note]').allInnerTexts();

/** FRU-686: a filter is chosen from « Filter »: its field, then its value. */
async function choose(page: Page, field: string, value: string): Promise<void> {
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.getByRole('menuitem', { name: field, exact: true }).click();
  await page.getByRole('menuitemradio', { name: value, exact: true }).click();
}

test('a task goes down its column from its menu, and a drag puts it back on top', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await expect(p.locator('li[data-note]')).toHaveCount(3);

  await p.getByText('Alpha task').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Move down' }).click();
  // The menu closes once its item is chosen.
  await expect(p.getByRole('menu')).toHaveCount(0);
  await expect
    .poll(async () => (await order(p)).map((text) => text.split('\n')[0]))
    .toEqual(['Beta task', 'Alpha task', 'Gamma task']);
  // Between Beta and Gamma: the middle of their places, which are their dates, the newest first.
  expect(sent[0]?.body).toEqual({
    position: (-Date.parse('2026-11-20T11:00:00.000Z') - Date.parse('2026-11-20T10:00:00.000Z')) / 2,
  });

  // The top of the column offers no « Move up ».
  await p.getByText('Beta task').click({ button: 'right' });
  await expect(p.getByRole('menuitem', { name: 'Move down' })).toBeVisible();
  await expect(p.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0);
  await p.keyboard.press('Escape');

  await p.getByText('Alpha task').dragTo(p.getByText('Beta task'), { targetPosition: { x: 10, y: 2 } });
  await expect
    .poll(async () => (await order(p)).map((text) => text.split('\n')[0]))
    .toEqual(['Alpha task', 'Beta task', 'Gamma task']);
});

test('an archived task leaves the board, the filter « Archived » finds it, and it is brought back', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await p.locator('tr', { hasText: 'Gamma task' }).getByText('Gamma task').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Archive' }).click();

  await expect(p.getByText('Gamma task')).toHaveCount(0);
  await choose(p, 'Status', 'Archived');
  await expect(p.getByText('Gamma task')).toBeVisible();
  await expect(p).toHaveURL(/archived=1/);
  await p.locator('tr', { hasText: 'Gamma task' }).getByText('Gamma task').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Bring back' }).click();
  await expect(p.getByText('Gamma task')).toHaveCount(0);
  expect(sent.map((one) => one.body)).toEqual([{ archived: true }, { archived: false }]);
});

test('a task is deleted only once the person confirms it', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  const beta = p.locator('tr', { hasText: 'Beta task' });
  await beta.getByText('Beta task').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Delete…' }).click();

  // « Keep it » has the focus: Enter keeps the task.
  await expect(beta.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await p.keyboard.press('Enter');
  expect(sent).toEqual([]);

  await beta.getByText('Beta task').click({ button: 'right' });
  await p.getByRole('menuitem', { name: 'Delete…' }).click();
  await beta.getByRole('button', { name: 'Delete this note' }).click();
  await expect(p.getByText('Beta task')).toHaveCount(0);
  expect(sent).toEqual([{ method: 'DELETE', path: '/console/workspaces/w1/notes/n2/task', body: undefined }]);
});

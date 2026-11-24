import { type Page, type Route, expect, test } from '@playwright/test';
import { noteFixture } from '../packages/shared/src/note.fixture.ts';
import { ACME, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The page of a task (FRU-653): a panel over the list, opened from the text of a note, its address
 * `?task=<id>`. The worker is answered by stubs at the shape of `GET …/notes/<note>` and of
 * `POST …/notes/<note>/task`.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const AT = '2026-11-20T10:00:00.000Z';
const STATUSES = ['new', 'todo', 'progress', 'done', 'closed'].map((stage) => ({
  key: `own:${stage}`,
  name: '',
  stage,
}));
const NOTE = noteFixture({
  id: 'sd_1',
  text: 'The price of the yearly plan is cut off on a phone.\nThe monthly plan is fine.',
  page: { url: 'https://staging.acme.dev/pricing', path: '/pricing' },
});

type Sent = { path: string; body: unknown };

async function worker(p: Page, options: { membersFail?: number } = {}): Promise<Sent[]> {
  const sent: Sent[] = [];
  let failing = options.membersFail ?? 0;
  const task: { labels: never[]; priority?: string; dueOn?: string } = { labels: [] };
  const listed = () => [
    {
      id: 'n1',
      note: 'sd_1',
      excerpt: 'The price of the yearly plan is cut off on a phone.',
      page: { url: NOTE.page.url, host: 'staging.acme.dev', path: '/pricing' },
      site: { id: 's1' },
      stage: 'new',
      status: 'own:new',
      canSetStatus: true,
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'fruitback' },
      task: { ...task },
      createdAt: AT,
    },
    {
      id: 'n2',
      excerpt: 'The returns policy says "recieve".',
      page: { url: 'https://staging.acme.dev/help', host: 'staging.acme.dev', path: '/help' },
      site: { id: 's1' },
      stage: 'progress',
      author: { kind: 'member', name: 'Ben' },
      place: { kind: 'linear', connector: 'c1', label: 'Acme' },
      ref: 'ACM-149',
      createdAt: AT,
    },
  ];
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: 'owner' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      const request = route.request();
      if (pathname === '/console/workspaces/w1/notes') {
        return route.fulfill({ json: { notes: listed(), total: 2, counts: { all: 2 }, statuses: { s1: STATUSES } } });
      }
      if (pathname.endsWith('/list-members')) {
        // FRU-673: the first reads fail, as a worker that is down answers.
        if (failing > 0) {
          failing -= 1;

          return route.fulfill({ status: 503, json: { error: 'store-unavailable' } });
        }
        const ben = { id: 'a2', email: 'ben@acme.dev', name: 'Ben Martin' };

        return route.fulfill({
          json: { members: [{ id: 'm2', userId: 'a2', role: 'member', createdAt: AT, user: ben }], total: 1 },
        });
      }
      if (pathname === '/console/workspaces/w1/labels') return route.fulfill({ json: { labels: [] } });
      if (pathname === '/console/workspaces/w1/notes/n1') {
        return route.fulfill({
          json: {
            note: {
              id: '1',
              identifier: 'FB-12',
              title: '',
              stage: 'new',
              stateName: '',
              updatedAt: AT,
              note: NOTE,
              comments: [{ id: 'c1', body: 'We see it too.', createdAt: AT, author: 'Ben Martin' }],
            },
          },
        });
      }
      if (pathname === '/console/workspaces/w1/notes/n2') {
        // Slow: the panel is seen while it reads.
        return new Promise<void>((resolve) => setTimeout(resolve, 1500)).then(() =>
          route.fulfill({
            json: {
              note: {
                id: 'x',
                identifier: 'ACM-149',
                title: '',
                stage: 'progress',
                stateName: '',
                updatedAt: AT,
                note: { ...NOTE, id: 'sd_2', text: 'The returns policy says "recieve".' },
              },
            },
          }),
        );
      }
      if (pathname === '/console/workspaces/w1/notes/n1/task') {
        const body = request.postDataJSON() as { priority?: string; dueOn?: string };
        sent.push({ path: pathname, body });
        Object.assign(task, body);

        return route.fulfill({ status: 204 });
      }

      return undefined;
    },
  });

  return sent;
}

test('the text of a note opens its page: its text, its element and its replies, then Escape goes back', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await p
    .locator('tr', { hasText: 'The price' })
    .getByRole('button', { name: /The price of the yearly plan/ })
    .click();

  const panel = p.getByRole('dialog', { name: /The price of the yearly plan/ });
  await expect(panel).toBeVisible();
  await expect(p).toHaveURL(/task=n1/);
  await expect(panel.locator('[data-task-reference]')).toHaveText('FB-12');
  await expect(panel.locator('[data-task-text]')).toContainText('The monthly plan is fine.');
  await expect(panel.locator('[data-task-replies]')).toContainText('We see it too.');
  await expect(panel.getByText(NOTE.anchor.selector)).toBeVisible();

  // A field saves at once, as the menu does.
  await panel.getByRole('button', { name: /Priority/ }).click();
  await p.getByRole('option', { name: 'High', exact: true }).click();
  await expect.poll(() => sent).toEqual([{ path: '/console/workspaces/w1/notes/n1/task', body: { priority: 'high' } }]);
  await panel.getByLabel('Due day').fill('2026-12-01');
  await expect
    .poll(() => sent.at(-1))
    .toEqual({ path: '/console/workspaces/w1/notes/n1/task', body: { dueOn: '2026-12-01' } });

  await p.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(p).not.toHaveURL(/task=/);
  await expect(p.locator('tr', { hasText: 'The price' }).locator('[data-task-marks]')).toContainText('High');
});

test('a panel opened on another note shows nothing of the one before while it reads', async ({ page: p }) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?task=n1`);
  const panel = p.getByRole('dialog');
  await expect(panel.locator('[data-task-text]')).toContainText('The monthly plan is fine.');
  await p.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  await p
    .locator('tr', { hasText: 'The returns policy' })
    .getByRole('button', { name: /The returns policy/ })
    .click();
  // While the second note is read, the panel says so, and draws no text or field of the first one.
  await expect(p.getByRole('dialog').getByText('Loading…')).toBeVisible();
  await expect(p.getByRole('dialog').locator('[data-task-text], [data-task-fields]')).toHaveCount(0);
  await expect(p.getByRole('dialog').locator('[data-task-text]')).toContainText('recieve');
});

test('a link with the task opens it, a note of a tracker shows no field, and the panel fits a phone', async ({
  page: p,
}) => {
  await worker(p);
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${CONSOLE}/w/w1/notes?task=n2`);

  const panel = p.getByRole('dialog', { name: /The returns policy/ });
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-task-reference]')).toHaveText('ACM-149');
  await expect(panel.locator('[data-task-fields]')).toHaveCount(0);
  const box = await panel.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(390);
  expect(await sideScroll(p)).toBe(0);
});

test('the members that did not load are said under « Assignee », and « Try again » reads them (FRU-673)', async ({
  page: p,
}) => {
  await worker(p, { membersFail: 1 });
  await p.goto(`${CONSOLE}/w/w1/notes?task=n1`);
  const panel = p.getByRole('dialog', { name: /The price of the yearly plan/ });

  const failed = panel.locator('[data-task-people-failed]');
  await expect(failed.getByRole('alert')).toContainText('The members did not load. Fruitback hit an error.');
  await failed.getByRole('button', { name: 'Try again' }).click();

  await expect(failed).toHaveCount(0);
  await panel.getByRole('button', { name: /Assignee/ }).click();
  await expect(p.getByRole('option', { name: 'Ben Martin', exact: true })).toBeVisible();
});

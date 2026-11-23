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

async function worker(p: Page): Promise<Sent[]> {
  const sent: Sent[] = [];
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
      if (pathname.endsWith('/list-members') || pathname === '/console/workspaces/w1/labels') {
        return route.fulfill({ json: { members: [], labels: [] } });
      }
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
        return route.fulfill({
          json: {
            note: {
              id: 'x',
              identifier: 'ACM-149',
              title: '',
              stage: 'progress',
              stateName: '',
              updatedAt: AT,
              note: { ...NOTE, id: 'sd_2' },
            },
          },
        });
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

test('a link with the task opens it, a note of a tracker shows no field, and the panel fits a phone', async ({
  page: p,
}) => {
  await worker(p);
  await p.setViewportSize({ width: 390, height: 844 });
  await p.goto(`${CONSOLE}/w/w1/notes?task=n2`);

  const panel = p.getByRole('dialog', { name: /The price of the yearly plan/ });
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-task-reference]')).toHaveText('ACM-149');
  await expect(panel.locator('[data-task-fields]')).toHaveCount(0);
  const box = await panel.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(390);
  expect(await sideScroll(p)).toBe(0);
});

import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * Several tasks at once (FRU-656, `design/task-bulk`): a box on each task Fruitback keeps, Shift and a
 * click for a range, Cmd or Ctrl and A for the page, Escape to clear; the bar under the list changes
 * every selected task in one call; the menu of a task on a selection acts on all of it. The worker is
 * answered by stubs at the shape of `POST …/tasks` and `POST …/tasks/delete`.
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

type Sent = { path: string; body: Record<string, unknown> };
type Label = { id: string; name: string; color: string };
/** A note of the list, as the stub answers it: a task carries its status and its fields. */
type Listed =
  | ReturnType<typeof task>
  | (Omit<ReturnType<typeof task>, 'status' | 'canSetStatus' | 'task'> & {
      status?: string;
      canSetStatus?: boolean;
      task?: ReturnType<typeof task>['task'];
      ref?: string;
    });

function task(id: string, excerpt: string, stage: string, mine = true) {
  return {
    id,
    excerpt,
    page: page(`/${id}`),
    site: { id: 's1' },
    stage,
    status: `own:${stage}`,
    canSetStatus: mine,
    author: mine ? { kind: 'you', name: 'Ana' } : { kind: 'member', name: 'Ben' },
    place: { kind: 'fruitback' } as { kind: string; connector?: string; label?: string },
    task: { labels: [] as Label[] } as { labels: Label[]; priority?: string },
    createdAt: AT,
  };
}

async function worker(p: Page, options: { refuse?: string; locale?: 'en' | 'fr'; role?: 'owner' | 'member' } = {}) {
  const sent: Sent[] = [];
  const labels: Label[] = [{ id: 'l1', name: 'Bug', color: '#dc2626' }];
  let notes: Listed[] = [
    task('n1', 'The headline runs to three lines on a phone.', 'new'),
    task('n2', 'The logo is blurred on a retina screen.', 'new'),
    task('n3', 'The footer links are too close together.', 'new'),
    task('n4', 'A typo in the second paragraph of About.', 'new', false),
    {
      id: 'n5',
      excerpt: 'The returns policy says "recieve".',
      page: page('/help'),
      site: { id: 's1' },
      stage: 'new',
      author: { kind: 'member', name: 'Ben' },
      place: { kind: 'linear', connector: 'c1', label: 'Acme' },
      ref: 'ACM-149',
      createdAt: AT,
    },
  ];
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: options.role ?? 'owner' }],
    sites: SITES,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    answer: (pathname: string, route: Route) => {
      const request = route.request();
      if (pathname === '/console/workspaces/w1/notes') {
        return route.fulfill({
          json: { notes, total: notes.length, counts: { all: notes.length }, statuses: { s1: STATUSES } },
        });
      }
      if (pathname.endsWith('/list-members')) return route.fulfill({ json: { members: [] } });
      if (pathname === '/console/workspaces/w1/labels') return route.fulfill({ json: { labels } });
      if (pathname === '/console/workspaces/w1/tasks' || pathname === '/console/workspaces/w1/tasks/delete') {
        const body = request.postDataJSON() as { notes: string[]; change?: Record<string, any> };
        sent.push({ path: pathname, body });
        if (options.refuse !== undefined) return route.fulfill({ status: 409, json: { error: options.refuse } });
        if (pathname.endsWith('/delete')) {
          notes = notes.filter((note) => !body.notes.includes(note.id));

          return route.fulfill({ json: { deleted: body.notes.length } });
        }
        for (const note of notes) {
          if (!body.notes.includes(note.id) || note.task === undefined) continue;
          const change = body.change ?? {};
          if (change.priority !== undefined) note.task.priority = change.priority;
          if (change.addLabels !== undefined) {
            note.task.labels = [...note.task.labels, ...labels.filter((one) => change.addLabels.includes(one.id))];
          }
          if (typeof change.status === 'string') {
            note.status = change.status;
            note.stage = change.status.slice('own:'.length);
          }
        }

        return route.fulfill({ json: { changed: body.notes.length } });
      }

      return undefined;
    },
  });

  return sent;
}

const row = (p: Page, text: string) => p.locator('tr', { hasText: text });
const box = (p: Page, text: string) => p.getByRole('checkbox', { name: new RegExp(`^Select: ${text}`) });
const bar = (p: Page) => p.getByRole('region', { name: 'The selected notes' });
/**
 * Presses the box of the row or the card of a note. The input of a box of HeroUI is hidden under its
 * drawing: a person presses the box (FRU-550).
 */
const press = (p: Page, text: string, modifiers: ('Shift' | 'ControlOrMeta')[] = []) =>
  p
    .locator('tr[data-note], li[data-note]', { hasText: text })
    .locator('.kit-select .checkbox__control')
    .click({ modifiers });

/** FRU-686: the table or the board, from « Display ». */
async function display(page: Page, view: string, button = 'Display'): Promise<void> {
  await page.getByRole('button', { name: button }).click();
  await page.getByRole('menuitemradio', { name: view, exact: true }).click();
}

test('a box, then Shift and a click, select a range; the bar changes them in one call; Escape clears', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(row(p, 'The headline')).toBeVisible();
  // A note of a tracker has no box.
  await expect(row(p, 'The returns policy').getByRole('checkbox')).toHaveCount(0);
  await expect(bar(p)).toHaveCount(0);

  await press(p, 'The headline');
  await expect(bar(p)).toContainText('1 note selected');
  await press(p, 'The footer', ['Shift']);
  await expect(bar(p)).toContainText('3 notes selected');
  await expect(box(p, 'The logo')).toBeChecked();
  await expect(p.getByRole('status').filter({ hasText: '3 notes selected' })).toHaveCount(1);
  await expect(row(p, 'The logo')).toHaveAttribute('data-selected', 'true');

  await bar(p).getByRole('button', { name: 'Priority' }).click();
  await p.getByRole('menuitemradio', { name: 'High' }).click();
  await expect
    .poll(() => sent)
    .toEqual([
      { path: '/console/workspaces/w1/tasks', body: { notes: ['n1', 'n2', 'n3'], change: { priority: 'high' } } },
    ]);
  await expect(bar(p)).toContainText('3 notes changed.');
  for (const text of ['The headline', 'The logo', 'The footer']) {
    await expect(row(p, text).locator('[data-task-marks]')).toContainText('High');
  }
  // A list read again makes what the bar said stale: the board shows the same selection, unsaid.
  await display(p, 'Board');
  await expect(bar(p)).toContainText('3 notes selected');
  await expect(bar(p)).not.toContainText('3 notes changed.');
  await display(p, 'Table');
  await expect(bar(p)).toContainText('3 notes selected');
  // The selection stays after a change: a label goes on every task, in one more call.
  await bar(p).getByRole('button', { name: 'Labels' }).click();
  await p.getByRole('menuitemcheckbox', { name: 'Bug' }).click();
  await expect
    .poll(() => sent[1])
    .toEqual({
      path: '/console/workspaces/w1/tasks',
      body: { notes: ['n1', 'n2', 'n3'], change: { addLabels: ['l1'] } },
    });

  // The first Escape closes the menu, which keeps it; the next one clears the selection.
  await p.keyboard.press('Escape');
  await expect(p.getByRole('menu')).toHaveCount(0);
  await expect(bar(p)).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(bar(p)).toHaveCount(0);
  // The focus was in the bar: it goes to the list, not to the page.
  await expect(p.getByRole('region', { name: 'Notes', exact: true })).toBeFocused();
  await expect(box(p, 'The logo')).not.toBeChecked();
});

test('Cmd or Ctrl and A selects the page; a task that is not yours is said; Delete… asks again', async ({
  page: p,
}) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await expect(row(p, 'The headline')).toBeVisible();
  // In the search, the key selects its text, not the tasks.
  await p.getByRole('searchbox').or(p.getByRole('textbox')).first().focus();
  await p.keyboard.press('ControlOrMeta+a');
  await expect(bar(p)).toHaveCount(0);

  await row(p, 'The headline').locator('td').nth(2).click();
  await p.keyboard.press('ControlOrMeta+a');
  await expect(bar(p)).toContainText('4 notes selected');
  // FRU-685: the list has no head of columns; the box of each group says its tasks are all selected.
  const groups = p.getByRole('checkbox', { name: /^Select every task of / });
  expect(await groups.count()).toBeGreaterThan(0);
  for (const group of await groups.all()) await expect(group).toBeChecked();
  await expect(bar(p)).toContainText('1 of them is not yours to change: it stays as it is.');

  await bar(p).getByRole('button', { name: 'Delete…' }).click();
  await expect(bar(p).getByRole('button', { name: 'Keep them' })).toBeFocused();
  await p.keyboard.press('Escape');
  await expect(bar(p).getByRole('button', { name: 'Delete…' })).toBeFocused();
  await expect(bar(p)).toContainText('4 notes selected');
  expect(sent).toEqual([]);

  await bar(p).getByRole('button', { name: 'Delete…' }).click();
  await bar(p).getByRole('button', { name: 'Delete 3 notes' }).click();
  await expect
    .poll(() => sent)
    .toEqual([{ path: '/console/workspaces/w1/tasks/delete', body: { notes: ['n1', 'n2', 'n3'] } }]);
  await expect(row(p, 'The headline')).toHaveCount(0);
  // The task that was not yours stays selected; the deletion is said.
  await expect(bar(p)).toContainText('1 note selected');
  await expect(p.getByRole('status').filter({ hasText: '3 notes deleted.' })).toHaveCount(1);
});

test('a right click on a selected task opens the menu of the whole selection', async ({ page: p }) => {
  const sent = await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await press(p, 'The headline');
  await press(p, 'The logo');

  await row(p, 'The logo').getByText('The logo').click({ button: 'right' });
  await expect(p.getByRole('menuitem', { name: 'Copy the link to its page' })).toHaveCount(0);
  await p.getByRole('menuitem', { name: 'Status' }).hover();
  await p.getByRole('menuitemradio', { name: 'In progress' }).click();
  await expect
    .poll(() => sent)
    .toEqual([
      { path: '/console/workspaces/w1/tasks', body: { notes: ['n1', 'n2'], change: { status: 'own:progress' } } },
    ]);
  await expect(row(p, 'The logo').getByRole('button', { name: 'Actions of the 2 selected notes' })).toBeVisible();

  // A task out of the selection keeps the menu of its own.
  await row(p, 'The footer').getByText('The footer').click({ button: 'right' });
  await expect(p.getByRole('menuitem', { name: 'Copy the link to its page' })).toBeVisible();
});

test('on the board, a card is selected by its box, and a refusal is said in the bar', async ({ page: p }) => {
  const sent = await worker(p, { refuse: 'unknown-label' });
  await p.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await press(p, 'The headline');
  await press(p, 'The footer');
  await expect(bar(p)).toContainText('2 notes selected');

  await bar(p).getByRole('button', { name: 'Labels' }).click();
  await p.getByRole('menuitemcheckbox', { name: 'Bug' }).click();
  await expect.poll(() => sent).toHaveLength(1);
  await expect(bar(p).getByRole('alert')).toContainText('This label was removed since the list was read.');
  await expect(bar(p)).toContainText('2 notes selected');
});

test('at 390 px in French, the bar holds in the screen', async ({ page: p }) => {
  await p.setViewportSize({ width: 390, height: 844 });
  await worker(p, { locale: 'fr' });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await press(p, 'The headline');
  const french = p.getByRole('region', { name: 'Les notes sélectionnées' });
  await expect(french).toContainText('1 note sélectionnée');
  await expect(french.getByRole('button', { name: 'Échéance' })).toBeVisible();
  const box390 = await french.boundingBox();
  expect(box390?.x).toBeGreaterThanOrEqual(0);
  expect((box390?.x ?? 0) + (box390?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await p.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

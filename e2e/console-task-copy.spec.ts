import { type Page, type Route, expect, test } from '@playwright/test';
import { noteFixture } from '../packages/shared/src/note.fixture.ts';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * Copy a task (FRU-658): its link in the console, its ID and its Markdown, from its menu, its panel
 * and the keyboard (Cmd/Ctrl+Shift+C, Cmd/Ctrl+Shift+.). The worker is answered by stubs; the
 * clipboard is the browser's, read back after each copy.
 */
const CONSOLE = 'http://localhost:5178';
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }];
const AT = '2026-11-24T10:00:00.000Z';
const STATUSES = ['new', 'todo', 'progress', 'done', 'closed'].map((stage) => ({
  key: `own:${stage}`,
  name: '',
  stage,
}));
const NOTE = noteFixture({
  id: 'sd_1',
  text: 'The price of the yearly plan is cut off on a phone.',
  createdAt: AT,
  page: { url: 'https://staging.acme.dev/pricing', path: '/pricing' },
  reporter: { name: 'Ana', verified: true },
});

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function worker(
  p: Page,
  { failing = false, onePage = false }: { failing?: boolean; onePage?: boolean } = {},
): Promise<void> {
  const listed = [
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
      ref: 'FB-12',
      task: { labels: [] },
      createdAt: AT,
    },
    {
      id: 't1',
      note: 'task_1',
      excerpt: 'Write the release notes',
      page: { url: '', host: '', path: '' },
      site: { id: 's1' },
      stage: 'todo',
      status: 'own:todo',
      canSetStatus: true,
      author: { kind: 'you', name: 'Ana' },
      place: { kind: 'fruitback' },
      ref: 'FB-41',
      task: { labels: [] },
      createdAt: AT,
    },
  ];
  await stubWorker(p, {
    workspaces: [{ ...ACME, role: 'owner' }],
    sites: SITES,
    answer: (pathname: string, route: Route) => {
      if (pathname === '/console/workspaces/w1/notes') {
        // `onePage`: the task is on another page of the list, and only its link opens it.
        const notes = onePage ? listed.slice(0, 1) : listed;

        return route.fulfill({
          json: { notes, total: notes.length, counts: { all: notes.length }, statuses: { s1: STATUSES } },
        });
      }
      if (pathname.endsWith('/list-members') || pathname === '/console/workspaces/w1/labels') {
        return route.fulfill({ json: { members: [], labels: [] } });
      }
      if (pathname === '/console/workspaces/w1/notes/n1') {
        if (failing) return route.fulfill({ status: 500, json: { error: 'store-unavailable' } });
        return route.fulfill({
          json: {
            note: {
              id: '12',
              identifier: 'FB-12',
              title: '',
              stage: 'new',
              stateName: '',
              status: 'own:new',
              updatedAt: AT,
              note: NOTE,
              comments: [{ id: 'c1', body: 'We see it too.', createdAt: AT, author: 'Ben' }],
            },
          },
        });
      }
      if (pathname === '/console/workspaces/w1/notes/t1') {
        return route.fulfill({
          json: {
            task: {
              id: '41',
              identifier: 'FB-41',
              title: 'Write the release notes',
              stage: 'todo',
              stateName: '',
              status: 'own:todo',
              updatedAt: AT,
              comments: [],
              task: {
                kind: 'fruitback.task',
                v: 1,
                id: 'task_1',
                createdAt: AT,
                title: 'Write the release notes',
                text: 'Every change of 0.8.0.',
                reporter: { name: 'Ana', verified: true },
              },
            },
          },
        });
      }

      return undefined;
    },
  });
}

const clipboard = (p: Page) => p.evaluate(() => navigator.clipboard.readText());

test('the menu copies the link of a task in the console, its ID, and the note as Markdown for an agent', async ({
  page: p,
}) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  const row = p.locator('tr', { hasText: 'The price' });
  const status = p.locator('[data-copy-status]');

  await row.getByRole('button', { name: 'Actions of this note' }).click();
  await p.getByRole('menuitem', { name: 'Copy the link', exact: true }).click();
  await expect(status).toHaveText('Link copied.');
  expect(await clipboard(p)).toBe(`${CONSOLE}/w/w1/notes?task=n1`);

  await row.getByRole('button', { name: 'Actions of this note' }).click();
  await p.getByRole('menuitem', { name: 'Copy the ID' }).click();
  await expect(status).toHaveText('FB-12 copied.');
  expect(await clipboard(p)).toBe('FB-12');

  await row.getByRole('button', { name: 'Actions of this note' }).click();
  await p.getByRole('menuitem', { name: 'Copy as Markdown' }).click();
  await expect(status).toHaveText('Copied as Markdown.');
  expect(await clipboard(p)).toBe(
    [
      '# Notes on https://staging.acme.dev/pricing',
      '',
      '## 1. FB-12 — New',
      '',
      `- Element: ${NOTE.anchor.tag} "${NOTE.anchor.text}" · \`${NOTE.anchor.selector}\``,
      `- Component: ${NOTE.source?.component} · ${NOTE.source?.file}:${NOTE.source?.line}`,
      '- By: Ana · 2026-11-24',
      '',
      '> The price of the yearly plan is cut off on a phone.',
      '',
      'Reply from Ben · 2026-11-24',
      '> We see it too.',
      '',
    ].join('\n'),
  );
  // The link to the page of the note stays, under its own name.
  await row.getByRole('button', { name: 'Actions of this note' }).click();
  await expect(p.getByRole('menuitem', { name: 'Copy the link to its page' })).toBeVisible();
});

test('the panel of a task written by hand copies its Markdown, and the keyboard copies its link and its ID', async ({
  page: p,
}) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?task=t1`);
  const panel = p.getByRole('dialog', { name: 'Write the release notes' });
  await expect(panel.locator('[data-task-text]')).toContainText('Every change of 0.8.0.');
  const status = p.locator('[data-copy-status]');

  await panel.getByRole('button', { name: 'Copy as Markdown' }).click();
  await expect(status).toHaveText('Copied as Markdown.');
  expect(await clipboard(p)).toBe(
    [
      '# Tasks with no page',
      '',
      '## 1. FB-41 — To do',
      '',
      '- By: Ana · 2026-11-24',
      '',
      '> Write the release notes',
      '>',
      '> Every change of 0.8.0.',
      '',
    ].join('\n'),
  );

  await p.keyboard.press('ControlOrMeta+Shift+C');
  await expect(status).toHaveText('Link copied.');
  expect(await clipboard(p)).toBe(`${CONSOLE}/w/w1/notes?task=t1`);
  await p.keyboard.press('ControlOrMeta+Shift+Period');
  await expect(status).toHaveText('FB-41 copied.');
  expect(await clipboard(p)).toBe('FB-41');
});

test('a note that does not load copies nothing, and the line says the read failed, not the browser', async ({
  page: p,
}) => {
  await worker(p, { failing: true });
  await p.goto(`${CONSOLE}/w/w1/notes`);
  await p.evaluate(() => navigator.clipboard.writeText('kept'));
  const row = p.locator('tr', { hasText: 'The price' });
  await row.getByRole('button', { name: 'Actions of this note' }).click();
  await p.getByRole('menuitem', { name: 'Copy as Markdown' }).click();
  await expect(p.locator('[data-copy-status]')).toHaveText(
    'The notes did not load, and nothing was copied. Try again.',
  );
  expect(await clipboard(p)).toBe('kept');
});

test('with the panel closed, the keyboard copies the link of the row that holds the focus', async ({ page: p }) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes?task=t1`);
  await expect(p.getByRole('dialog', { name: 'Write the release notes' })).toBeVisible();
  await p.keyboard.press('Escape');
  await expect(p.getByRole('dialog')).toHaveCount(0);

  await p.locator('tr', { hasText: 'The price' }).getByRole('button', { name: 'Actions of this note' }).focus();
  await p.keyboard.press('ControlOrMeta+Shift+C');
  await expect(p.locator('[data-copy-status]')).toHaveText('Link copied.');
  expect(await clipboard(p)).toBe(`${CONSOLE}/w/w1/notes?task=n1`);
});

test('a selection copies the IDs and the Markdown of all its notes, from its bar and from the menu of one of them', async ({
  page: p,
}) => {
  await worker(p);
  await p.goto(`${CONSOLE}/w/w1/notes`);
  const select = (text: string) =>
    p.locator('tr[data-note]', { hasText: text }).locator('.kit-select .checkbox__control').click();
  await select('The price');
  await select('Write the release notes');
  const bar = p.getByRole('region', { name: 'The selected notes' });
  const status = p.locator('[data-copy-status]');

  await bar.getByRole('button', { name: 'Copy' }).click();
  await p.getByRole('menuitem', { name: 'Copy the ID' }).click();
  await expect(status).toHaveText('2 IDs copied.');
  // In the order of the screen: the table groups by status, To do before New.
  expect(await clipboard(p)).toBe('FB-41\nFB-12');
  // A copy closes the menu of the bar.
  await expect(p.getByRole('menu', { name: 'Copy' })).toBeHidden();

  await p
    .locator('tr', { hasText: 'The price' })
    .getByRole('button', { name: /Actions of the 2 selected notes/ })
    .click();
  await p.getByRole('menuitem', { name: 'Copy as Markdown' }).click();
  await expect(status).toHaveText('2 notes copied as Markdown.');
  const markdown = await clipboard(p);
  expect(markdown).toContain('# Notes on https://staging.acme.dev/pricing');
  expect(markdown).toContain('# Tasks with no page');
  expect(markdown.indexOf('# Notes on')).toBeLessThan(markdown.indexOf('# Tasks with no page'));
});

test('the panel of a task the list does not hold still copies its ID with the keyboard', async ({ page: p }) => {
  await worker(p, { onePage: true });
  await p.goto(`${CONSOLE}/w/w1/notes?task=t1`);
  await expect(p.getByRole('dialog', { name: 'Write the release notes' })).toBeVisible();
  await p.keyboard.press('ControlOrMeta+Shift+Period');
  await expect(p.locator('[data-copy-status]')).toHaveText('FB-41 copied.');
  expect(await clipboard(p)).toBe('FB-41');
});

import { type Page, expect, test } from '@playwright/test';
import { ACME, stubWorker } from './console-workspace.ts';

/**
 * No shortcut of the console acts on a key typed in a field (FRU-726), the console's own or one in a
 * Shadow root: the Fruitback widget on the console is one. The shortcuts read `composedPath()`, where
 * the target of such a key is the host element. Mathieu's note lost each of its « c » to « New task »,
 * and the button read « New taskC ».
 *
 * Two fields in a Shadow root: a component of the page, and the widget as `init` assembles it. Each
 * test also presses the key out of a field, so a shortcut that never acts proves nothing alone.
 */
const CONSOLE = 'http://localhost:5178';
const IIFE = 'packages/widget/dist/fruitback.iife.js';
const TEXT = 'cette carte coince / c';
/** One note, so that the screen draws its bar and its search. */
const NOTE = {
  id: 'n1',
  note: 'sd_1',
  excerpt: 'The price of the yearly plan is cut off on a phone.',
  page: { url: 'https://staging.acme.dev/pricing', host: 'staging.acme.dev', path: '/pricing' },
  site: { id: 's1' },
  stage: 'todo',
  status: 'own:todo',
  canSetStatus: true,
  author: { kind: 'you', name: 'Ana' },
  place: { kind: 'fruitback' },
  task: { labels: [] },
  createdAt: '2026-11-24T10:00:00.000Z',
};

async function openConsole(page: Page): Promise<void> {
  await stubWorker(page, {
    workspaces: [{ ...ACME, role: 'owner' }],
    answer: (pathname, route) => {
      if (pathname === '/console/workspaces/w1/notes') {
        return route.fulfill({ json: { notes: [NOTE], total: 1, counts: { all: 1 } } });
      }
      // What the widget reads for the page: no note.
      if (pathname === '/feedback') return route.fulfill({ json: { issues: [] } });
      if (pathname.endsWith('/list-members') || pathname === '/console/workspaces/w1/labels') {
        return route.fulfill({ json: { members: [], labels: [] } });
      }

      return undefined;
    },
  });
}

/** A component of the page with a field in its open Shadow root, at the top of the screen. */
async function shadowField(page: Page): Promise<void> {
  await page.evaluate(() => {
    const host = document.createElement('acme-field');
    host.style.cssText = 'position:fixed;top:8px;left:50%;z-index:100';
    host.attachShadow({ mode: 'open' }).innerHTML = '<textarea aria-label="Shadow field"></textarea>';
    document.body.append(host);
  });
}

test('« C » and « / » act out of a field, and not in a field of a Shadow root', async ({ page }) => {
  await openConsole(page);
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  await expect(page.getByRole('button', { name: /New task/ }).first()).toBeVisible();
  await shadowField(page);

  const field = page.getByLabel('Shadow field');
  await field.click();
  await field.pressSequentially(TEXT);
  await expect(field).toHaveValue(TEXT);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('searchbox')).not.toBeFocused();

  // The controls: out of a field, « / » gives the focus to the search and « C » opens « New task ».
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('c');
  await expect(page.getByRole('dialog', { name: 'New task' })).toBeVisible();
});

test('« / » of the sites leaves a field of a Shadow root alone', async ({ page }) => {
  await openConsole(page);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const search = page.locator('main input[type="search"]');
  await expect(search).toBeVisible();
  await shadowField(page);

  const field = page.getByLabel('Shadow field');
  await field.click();
  await field.pressSequentially('a/b');
  await expect(field).toHaveValue('a/b');
  await expect(search).not.toBeFocused();

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
});

test('a note typed in the widget on the console keeps its « c », and « New task » stays shut', async ({ page }) => {
  await openConsole(page);
  await page.goto(`${CONSOLE}/w/w1/notes?view=board`);
  const newTask = page.getByRole('button', { name: /New task/ }).first();
  await expect(newTask).toBeVisible();
  await page.addScriptTag({ path: IIFE });
  await page.evaluate(
    (endpoint) =>
      (globalThis as unknown as { Fruitback: { init(options: Record<string, string>): unknown } }).Fruitback.init({
        endpoint,
        clientId: 'console-e2e',
        locale: 'en-US',
      }),
    'http://localhost:8788',
  );
  await page.getByRole('button', { name: /Leave a note/ }).click();
  await newTask.click();
  const note = page.getByPlaceholder('What should change?');
  await expect(note).toBeFocused();

  await note.pressSequentially(TEXT);

  await expect(note).toHaveValue(TEXT);
  await expect(page.getByRole('dialog', { name: 'New task' })).toHaveCount(0);
  await expect(page.getByRole('searchbox')).not.toBeFocused();
});

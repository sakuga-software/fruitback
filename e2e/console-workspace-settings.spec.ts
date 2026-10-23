import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { ACME, LUMEN, type StubbedWorkspace, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The settings of a workspace (FRU-414): the name of the workspace, at the top of the rail, opens
 * them. With one workspace the name is a link; with several it opens the menu of the workspaces,
 * which ends with « Workspace settings ». The screen renames the workspace for an owner or an admin,
 * and the rail shows the new name at once. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

type Worker = { renames: Record<string, unknown>[]; refuses?: string };

async function workerWith(page: Page, workspaces: StubbedWorkspace[], locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { renames: [] };
  // What the worker keeps: `/console/me` answers the names a rename wrote.
  const kept = workspaces.map((each) => ({ ...each }));
  await stubWorker(page, {
    locale,
    workspaces,
    answer: (pathname, route) => {
      if (pathname === '/console/me')
        return route.fulfill({
          json: { account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale }, workspaces: kept },
        });
      if (route.request().method() !== 'POST' || !/^\/console\/workspaces\/w\d$/.test(pathname)) return undefined;
      const body = route.request().postDataJSON() as { name: string };
      worker.renames.push(body);
      if (worker.refuses !== undefined) return route.fulfill({ status: 400, json: { error: worker.refuses } });
      const workspace = kept.find((each) => each.id === pathname.split('/').at(-1));
      if (workspace === undefined) return route.fulfill({ status: 404, json: { error: 'not-found' } });
      workspace.name = body.name.trim();

      return route.fulfill({ json: workspace });
    },
  });

  return worker;
}

const rail = (page: Page) => page.locator('aside');

test('the name of the only workspace leads to its settings, which rename it', async ({ page }) => {
  const worker = await workerWith(page, [ACME]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites`);
  const head = rail(page).getByRole('link', { name: 'Acme Cloud workspace Workspace settings' });
  await head.click();
  await expect(page).toHaveURL(/\/w\/w1\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();
  await expect(head).toHaveAttribute('aria-current', 'page');

  const name = page.getByRole('textbox', { name: 'Workspace name' });
  await expect(name).toHaveValue('Acme');
  // A refusal says why, and keeps what was typed.
  worker.refuses = 'invalid-name';
  await name.fill('Acme Labs');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toHaveText('A workspace needs a name of one line, up to 80 characters.');
  await expect(name).toHaveValue('Acme Labs');
  await expect(rail(page)).toContainText('Acme');

  worker.refuses = undefined;
  await name.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'The name is saved.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The rail shows the new name at once, and keeps it on the next screen.
  await expect(rail(page).getByRole('link', { name: /^Acme Labs Cloud workspace/ })).toBeVisible();
  expect(worker.renames).toEqual([{ name: 'Acme Labs' }, { name: 'Acme Labs' }]);
  await rail(page).getByRole('link', { name: 'Sites', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/w1\/sites$/);
  await expect(rail(page).getByRole('link', { name: /^Acme Labs Cloud workspace/ })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('with several workspaces, their menu ends with « Workspace settings »', async ({ page }) => {
  await workerWith(page, [ACME, LUMEN]);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await rail(page).getByRole('button', { name: /^Acme/ }).click();
  const menu = page.getByRole('menu');
  // The workspaces are a choice, and the settings choose nothing.
  await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
  await expect(menu.getByRole('menuitemradio', { name: /^Acme/ })).toHaveAttribute('aria-checked', 'true');
  const settings = menu.getByRole('menuitem', { name: 'Workspace settings' });
  await settings.click();
  await expect(page).toHaveURL(/\/w\/w1\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();

  // The keyboard reaches it too, and a workspace is still chosen from the same menu.
  await rail(page).getByRole('button', { name: /^Acme/ }).press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/w\/w2\/sites$/);
});

test('the settings of another workspace show its own name, not what was typed for the first', async ({ page }) => {
  await workerWith(page, [ACME, { ...LUMEN, role: 'admin' }]);
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const name = page.getByRole('textbox', { name: 'Workspace name' });
  await expect(name).toHaveValue('Acme');
  await name.fill('Typed for Acme');
  // The same screen of another workspace, with no load of the page.
  await page.evaluate(() => {
    history.pushState(null, '', '/w/w2/settings');
    dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/w\/w2\/settings$/);
  await expect(name).toHaveValue('Lumen Studio');
});

test('a member reads the name and does not rename it', async ({ page }) => {
  await workerWith(page, [{ ...ACME, role: 'member' }]);
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const name = page.getByRole('textbox', { name: 'Workspace name' });
  await expect(name).toHaveValue('Acme');
  await expect(name).toHaveAttribute('readonly', '');
  await expect(page.getByText('Only an owner or an admin of the workspace renames it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('at 390 px in French nothing scrolls sideways', async ({ page }) => {
  await workerWith(page, [ACME], 'fr');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/w/w1/settings`);
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages du workspace' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Acme Workspace Cloud Réglages du workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

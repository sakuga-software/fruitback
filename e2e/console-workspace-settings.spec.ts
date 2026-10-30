import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { ACME, LUMEN, type StubbedWorkspace, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The settings of a workspace (FRU-414): the name of the workspace, at the top of the rail, opens
 * them. With one workspace the name is a link; with several it opens the menu of the workspaces,
 * which ends with « Workspace settings ». For an owner or an admin they are also « Settings » in the
 * rail (FRU-503). The screen renames the workspace for an owner or an admin, and the rail shows the
 * new name at once, and the owner deletes the workspace there (FRU-503). Its page « AI » leads through
 * what an agent needs (FRU-544). The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

type Worker = { renames: Record<string, unknown>[]; deleted: string[]; refuses?: string };

async function workerWith(page: Page, workspaces: StubbedWorkspace[], locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { renames: [], deleted: [] };
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
      if (route.request().method() === 'DELETE' && /^\/console\/workspaces\/w\d$/.test(pathname)) {
        worker.deleted.push(pathname);

        return route.fulfill({ status: 204 });
      }
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
  // FRU-503: the entry « Settings » of the rail is the one on screen, and the name is not a second one.
  await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(head).not.toHaveAttribute('aria-current', 'page');

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

  // The menu closes after the click. Wait for it: a key that arrives sooner reaches a trigger without its focus.
  await expect(menu).toBeHidden();
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

test('« Settings » is an entry of the rail for an owner and an admin, under « Members » (FRU-503)', async ({
  page,
}) => {
  for (const role of ['owner', 'admin'] as const) {
    await page.unrouteAll();
    await workerWith(page, [{ ...ACME, role }]);
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const entries = rail(page).getByRole('navigation', { name: 'Workspace' }).getByRole('link');
    await expect(entries, role).toHaveText(['Sites', 'Notes', 'Connectors', 'Members', 'Settings', 'My account']);
    await rail(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/w\/w1\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();
  }
  // The keys of the agents are under the settings: the entry stays the one on screen there.
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');

  // A member and a guest have no entry; the name of the workspace still leads to the settings.
  for (const role of ['member', 'guest'] as const) {
    await page.unrouteAll();
    await workerWith(page, [{ ...ACME, role }]);
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const entries = rail(page).getByRole('navigation', { name: 'Workspace' }).getByRole('link');
    await expect(entries, role).toHaveText(['Sites', 'Notes', 'Connectors', 'Members', 'My account']);
    await rail(page).getByRole('link', { name: 'Acme Cloud workspace Workspace settings' }).click();
    await expect(page).toHaveURL(/\/w\/w1\/settings$/);
    // The name stays the one on screen on the page « AI » of the settings (FRU-544).
    await page.getByRole('main').getByRole('link', { name: 'AI', exact: true }).click();
    await expect(page).toHaveURL(/\/w\/w1\/settings\/ai$/);
    await expect(
      rail(page).getByRole('link', { name: 'Acme Cloud workspace Workspace settings' }),
      role,
    ).toHaveAttribute('aria-current', 'page');
  }
});

test('the settings have two pages, « General » and « AI », and « Agents » is on « AI » alone (FRU-544)', async ({
  page,
}) => {
  await workerWith(page, [ACME]);
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const pages = page.getByRole('main').getByRole('navigation', { name: 'Pages of the settings' }).getByRole('link');
  await expect(pages).toHaveText(['General', 'AI']);
  await expect(pages.first()).toHaveAttribute('aria-current', 'page');
  await expect(pages.last()).not.toHaveAttribute('aria-current');
  // « General » holds the name, the logo and the deletion; the agents are no longer there.
  await expect(page.getByRole('region', { name: 'Name' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agents' })).toHaveCount(0);

  await pages.last().click();
  await expect(page).toHaveURL(/\/w\/w1\/settings\/ai$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();
  await expect(pages.last()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Name' })).toHaveCount(0);
  await expect(page.getByText('Delete the workspace')).toHaveCount(0);
  // The entry « Settings » of the rail stays the one on screen.
  await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  // Back to « General » with the keyboard.
  await pages.first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/w\/w1\/settings$/);
  await expect(page.getByRole('region', { name: 'Name' })).toBeVisible();
});

test('the section « Agents » leads to the keys, the addresses that receive, and the trigger of each site (FRU-503)', async ({
  page,
}) => {
  await workerWith(page, [ACME]);
  await page.goto(`${CONSOLE}/w/w1/settings/ai`);
  const agents = page.getByRole('region', { name: 'Agents' });
  await expect(agents.getByRole('link', { name: 'Manage the agent keys' })).toHaveAttribute(
    'href',
    '/w/w1/settings/agents',
  );
  await expect(agents.getByRole('link', { name: 'Connectors' })).toHaveAttribute('href', '/w/w1/connectors');
  // The three steps are numbered: a `li` that is a flex box would draw no number.
  const steps = agents.locator('ol > li');
  await expect(steps).toHaveCount(3);
  for (const index of [0, 1, 2])
    expect(await steps.nth(index).evaluate((li) => getComputedStyle(li).display), `step ${index + 1}`).toBe(
      'list-item',
    );
  const sites = agents.getByRole('list', { name: 'Start an agent, by site' });
  await expect(sites.getByRole('link')).toHaveText(['Start an agent on staging.acme.dev']);
  await expect(sites.getByRole('link')).toHaveAttribute('href', '/w/w1/sites/s1#agent');

  // A member reads why there is no way, and the section asks the worker nothing.
  await page.unrouteAll();
  await workerWith(page, [{ ...ACME, role: 'member' }]);
  const asked: string[] = [];
  page.on('request', (request) => {
    if (/\/console\/workspaces\/w1\/sites(\/choices)?(\?|$)/.test(request.url())) asked.push(request.url());
  });
  await page.goto(`${CONSOLE}/w/w1/settings/ai`);
  await expect(page.getByRole('region', { name: 'Agents' })).toContainText(
    'Only an owner or an admin of the workspace manages its agent keys.',
  );
  await expect(page.getByRole('region', { name: 'Agents' }).getByRole('link')).toHaveCount(0);
  expect(asked).toEqual([]);
});

test('the owner alone deletes the workspace, from its settings, and asks twice (FRU-503)', async ({ page }) => {
  const worker = await workerWith(page, [ACME]);
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const end = page.getByRole('region', { name: 'Delete the workspace', exact: true });
  await end.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await expect(end.getByRole('button', { name: 'Keep it', exact: true })).toBeFocused();
  // The control: one press deletes nothing.
  expect(worker.deleted).toEqual([]);
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  await end.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(end.getByRole('button', { name: 'Delete workspace', exact: true })).toBeVisible();

  await end.getByRole('button', { name: 'Delete workspace', exact: true }).click();
  await end.getByRole('button', { name: 'Delete Acme', exact: true }).click();
  await expect.poll(() => worker.deleted).toEqual(['/console/workspaces/w1']);
  await expect(page).not.toHaveURL(/\/w\/w1\/settings$/);

  for (const role of ['admin', 'member', 'guest'] as const) {
    await page.unrouteAll();
    await workerWith(page, [{ ...ACME, role }]);
    await page.goto(`${CONSOLE}/w/w1/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' }), role).toBeVisible();
    await expect(page.getByText('Delete the workspace'), role).toHaveCount(0);
  }
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
  await expect(page.getByRole('heading', { level: 1, name: 'Réglages de l’espace de travail' })).toBeVisible();
  await expect(
    rail(page).getByRole('link', { name: 'Acme Espace de travail Cloud Réglages de l’espace de travail' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  // The page « IA » too (FRU-544): its links and the steps of « Agents » fit in 390 px.
  await page.getByRole('main').getByRole('link', { name: 'IA', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  const ai = await new AxeBuilder({ page }).analyze();
  expect(ai.violations.map((violation) => violation.id)).toEqual([]);
});

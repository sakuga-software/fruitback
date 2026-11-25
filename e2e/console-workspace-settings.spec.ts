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
  const head = rail(page).getByRole('link', { name: 'Acme Workspace settings' });
  await head.click();
  await expect(page).toHaveURL(/\/w\/w1\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  // FRU-503: the entry « Settings » of the rail is the one on screen, and the name is not a second one.
  await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(head).not.toHaveAttribute('aria-current', 'page');

  const name = page.getByRole('textbox', { name: 'Workspace name' });
  await expect(name).toHaveValue('Acme');
  // FRU-693: « Save » is in the head of the page, and does nothing until the name changes.
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await name.fill('Acme ');
  await expect(save).toBeDisabled();
  // A refusal says why, and keeps what was typed.
  worker.refuses = 'invalid-name';
  await name.fill('Acme Labs');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('A workspace needs a name of one line, up to 80 characters.');
  await expect(name).toHaveValue('Acme Labs');
  await expect(rail(page)).toContainText('Acme');

  worker.refuses = undefined;
  await name.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'The name is saved.' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  // The rail shows the new name at once, and keeps it on the next screen.
  await expect(rail(page).getByRole('link', { name: /^Acme Labs Workspace settings/ })).toBeVisible();
  expect(worker.renames).toEqual([{ name: 'Acme Labs' }, { name: 'Acme Labs' }]);
  await rail(page).getByRole('link', { name: 'Sites', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/w1\/sites$/);
  await expect(rail(page).getByRole('link', { name: /^Acme Labs Workspace settings/ })).toBeVisible();

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
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();

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
    await expect(entries, role).toHaveText(['Notes', 'Sites', 'Connectors', 'Members', 'Settings']);
    await rail(page).getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/w\/w1\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
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
    await expect(entries, role).toHaveText(['Notes', 'Sites', 'Connectors', 'Members']);
    await rail(page).getByRole('link', { name: 'Acme Workspace settings' }).click();
    await expect(page).toHaveURL(/\/w\/w1\/settings$/);
    // The name stays the one on screen on the page « AI » of the settings (FRU-544).
    await page.getByRole('main').getByRole('link', { name: 'AI', exact: true }).click();
    await expect(page).toHaveURL(/\/w\/w1\/settings\/ai$/);
    await expect(rail(page).getByRole('link', { name: 'Acme Workspace settings' }), role).toHaveAttribute(
      'aria-current',
      'page',
    );
  }
});

test('the settings are pages of the shell, beside the pages of the person (FRU-692)', async ({ page }) => {
  await workerWith(page, [ACME]);
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const nav = page.getByRole('main').getByRole('navigation', { name: 'Settings', exact: true });
  await expect(nav.getByRole('list', { name: 'Account' }).getByRole('link')).toHaveText([
    'Profile',
    'Sessions',
    'Appearance',
  ]);
  const pages = nav.getByRole('list', { name: 'Workspace' }).getByRole('link');
  await expect(pages).toHaveText(['General', 'AI', 'Agents', 'Members', 'Connectors']);
  await expect(pages.first()).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current]')).toHaveCount(1);
  // « General » holds the name, the logo and the deletion; the agents are not there.
  await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Danger zone' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agents' })).toHaveCount(0);

  await pages.nth(1).click();
  await expect(page).toHaveURL(/\/w\/w1\/settings\/ai$/);
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible();
  await expect(pages.nth(1)).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current]')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Identity' })).toHaveCount(0);
  await expect(page.getByText('Delete the workspace')).toHaveCount(0);
  // The entry « Settings » of the rail stays the one on screen.
  await expect(rail(page).getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  // « Agents » is a page of the shell too: the keys.
  await pages.nth(2).click();
  await expect(page).toHaveURL(/\/w\/w1\/settings\/agents$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  await expect(pages.nth(2)).toHaveAttribute('aria-current', 'page');
  // « Members » and « Connectors » lead to the screens of the rail, out of the shell.
  await expect(pages.nth(3)).toHaveAttribute('href', '/w/w1/members');
  await expect(pages.nth(4)).toHaveAttribute('href', '/w/w1/connectors');

  // Back to « General » with the keyboard.
  await pages.first().focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/w\/w1\/settings$/);
  await expect(page.getByRole('region', { name: 'Identity' })).toBeVisible();
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

test('the owner alone deletes the workspace, in a dialog, once its name is typed (FRU-503, FRU-693)', async ({
  page,
}) => {
  const worker = await workerWith(page, [ACME]);
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const zone = page.getByRole('region', { name: 'Danger zone', exact: true });
  await expect(zone).toContainText('Sites, members and pin positions go. Items in your trackers stay there.');
  const open = zone.getByRole('button', { name: 'Delete the workspace' });
  await expect(open).toHaveText('Delete…');
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Delete Acme?' });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole('button', { name: 'Delete Acme', exact: true });
  // The control: the button that deletes waits for the name, typed as the rail shows it.
  await expect(confirm).toBeDisabled();
  const typed = dialog.getByRole('textbox', { name: 'Type Acme to confirm' });
  await typed.fill('acme');
  await expect(confirm).toBeDisabled();
  await typed.press('Enter');
  expect(worker.deleted).toEqual([]);
  // A colour read while the dialog fades in is the colour of its fade.
  await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished)));
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  // « Keep it » closes it, sends nothing, and the name typed is gone the next time.
  await dialog.getByRole('button', { name: 'Keep it', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  expect(worker.deleted).toEqual([]);
  // Escape closes it too.
  await open.click();
  await expect(typed).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(worker.deleted).toEqual([]);

  // A refusal of the worker is said in the dialog, which stays open with the name typed. While the
  // deletion is on its way, Escape and « Keep it » do not close the dialog its answer ends in.
  let answer = () => {};
  const answered = new Promise<void>((resolve) => (answer = resolve));
  await page.unroute('**/console/workspaces/w1');
  await page.route('**/console/workspaces/w1', async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    await answered;

    return route.fulfill({ status: 403, json: { error: 'forbidden', role: 'admin' } });
  });
  await open.click();
  await typed.fill(' Acme ');
  await confirm.click();
  await expect(dialog.getByRole('button', { name: 'Deleting…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Keep it', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  answer();
  await expect(dialog.getByRole('alert')).toHaveText('Only the owner of the workspace deletes it.');
  await expect(typed).toHaveValue(' Acme ');
  await page.unroute('**/console/workspaces/w1');

  await confirm.click();
  await expect.poll(() => worker.deleted).toEqual(['/console/workspaces/w1']);
  await expect(page).not.toHaveURL(/\/w\/w1\/settings$/);

  for (const role of ['admin', 'member', 'guest'] as const) {
    await page.unrouteAll();
    await workerWith(page, [{ ...ACME, role }]);
    await page.goto(`${CONSOLE}/w/w1/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'General' }), role).toBeVisible();
    await expect(page.getByRole('region', { name: 'Danger zone' }), role).toHaveCount(0);
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
  await expect(page.getByRole('heading', { level: 1, name: 'Général' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Acme Réglages de l’espace de travail' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  // The page « IA » too (FRU-544): its links and the steps of « Agents » fit in 390 px. The
  // navigation of the settings is one row there, which scrolls in its frame (FRU-692).
  await page.getByRole('main').getByRole('navigation').getByRole('link', { name: 'IA', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Agents' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  const ai = await new AxeBuilder({ page }).analyze();
  expect(ai.violations.map((violation) => violation.id)).toEqual([]);
});

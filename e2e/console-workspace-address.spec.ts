import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { type StubbedWorkspace, stubWorker } from './console-workspace.ts';

/**
 * The address of a workspace in the console (FRU-715): `/w/<its short name>`. An address that names
 * it by its id, as the links of the worker and of before do, or by a short name it left in the last
 * 30 days, opens it and is replaced by the one of its short name. An owner or an admin changes the
 * short name in « General », with the name; a name another workspace holds is refused with its
 * sentence. Every call of the worker still names the id. The worker is answered by stubs; its rules
 * are held by `console-workspace-slug.test.ts` of the worker.
 */
const CONSOLE = 'http://localhost:5178';

type Slugged = StubbedWorkspace & { slug: string; formerSlugs?: string[] };

const ACME: Slugged = { id: 'w1', name: 'Acme', role: 'owner', slug: 'acme', formerSlugs: ['acme-old'] };
const LUMEN: Slugged = { id: 'w2', name: 'Lumen Studio', role: 'member', slug: 'lumen' };

type Worker = { saves: Record<string, unknown>[]; calls: string[] };

/** The worker of the stubs, with short names: a save writes them as the worker would, `globex` is taken. */
async function workerWith(page: Page, workspaces: Slugged[]): Promise<Worker> {
  const worker: Worker = { saves: [], calls: [] };
  const kept = workspaces.map((each) => ({ ...each }));
  await stubWorker(page, {
    workspaces: kept,
    answer: (pathname, route) => {
      if (pathname.startsWith('/console/workspaces/')) worker.calls.push(pathname);
      if (pathname === '/console/me')
        return route.fulfill({
          json: { account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' }, workspaces: kept },
        });
      if (route.request().method() !== 'POST' || !/^\/console\/workspaces\/w\d$/.test(pathname)) return undefined;
      const body = route.request().postDataJSON() as { name: string; slug?: string };
      worker.saves.push(body);
      if (body.slug === 'globex') return route.fulfill({ status: 409, json: { error: 'slug-taken' } });
      if (body.slug === 'admin') return route.fulfill({ status: 400, json: { error: 'reserved-slug' } });
      const workspace = kept.find((each) => each.id === pathname.split('/').at(-1));
      if (workspace === undefined) return route.fulfill({ status: 404, json: { error: 'not-found' } });
      workspace.name = body.name.trim();
      if (body.slug !== undefined && body.slug !== workspace.slug) {
        workspace.formerSlugs = [workspace.slug, ...(workspace.formerSlugs ?? [])];
        workspace.slug = body.slug;
      }

      return route.fulfill({ json: { id: workspace.id, name: workspace.name, slug: workspace.slug, role: 'owner' } });
    },
  });

  return worker;
}

const rail = (page: Page) => page.locator('aside');

test('an address by the id, or by a name the workspace left, opens it at its short name', async ({ page }) => {
  const worker = await workerWith(page, [ACME, LUMEN]);
  await page.goto(`${CONSOLE}/`);
  await page.goto(`${CONSOLE}/w/w1/notes?stage=new#top`);
  // Replaced, with the rest of the path, the query and the hash: the history holds no `/w/w1`.
  await expect(page).toHaveURL(`${CONSOLE}/w/acme/notes?stage=new#top`);
  await expect(rail(page).getByRole('button', { name: /^Acme/ })).toBeVisible();
  // The rail leads by the short name, and the entry on screen is still the one of the path.
  await expect(rail(page).getByRole('link', { name: 'Sites', exact: true })).toHaveAttribute('href', '/w/acme/sites');
  await page.goBack();
  await expect(page).toHaveURL(`${CONSOLE}/`);

  await page.goto(`${CONSOLE}/w/acme-old/sites`);
  await expect(page).toHaveURL(`${CONSOLE}/w/acme/sites`);
  await expect(rail(page).getByRole('link', { name: 'Sites', exact: true })).toHaveAttribute('aria-current', 'page');
  // Another workspace of the person, by its short name, from the menu of the workspaces.
  await rail(page).getByRole('button', { name: /^Acme/ }).click();
  await page.getByRole('menuitemradio', { name: /Lumen Studio/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/lumen/sites`);
  // A name that opens nothing of the person leads to the front door, as an unknown id did.
  await page.goto(`${CONSOLE}/w/initech/sites`);
  await expect(page).not.toHaveURL(/\/w\/initech/);

  // Every call of the worker names the id, never a short name.
  expect(worker.calls.filter((path) => !/^\/console\/workspaces\/w\d(\/|$)/.test(path))).toEqual([]);
  expect(worker.calls.length).toBeGreaterThan(0);
});

test('« General » changes the short name with the name, and says why a name is refused', async ({ page }) => {
  const worker = await workerWith(page, [ACME]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/acme/settings`);
  const address = page.getByRole('textbox', { name: 'Workspace URL' });
  await expect(address).toHaveValue('acme');
  // The host and `/w/` stand before it, in the box, and are not typed.
  const box = address.locator('xpath=..');
  await expect(box).toContainText('localhost:5178/w/');
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();

  // A form the worker would refuse is said at once, and nothing is sent.
  await address.fill('Acme Labs!');
  await expect(address).toHaveValue('acme labs!');
  await save.click();
  await expect(
    page.getByText('Use 3 to 40 lowercase letters, digits or hyphens, with a letter or a digit at each end.'),
  ).toBeVisible();
  await expect(address).toHaveAttribute('aria-invalid', 'true');
  expect(worker.saves).toEqual([]);

  // A name another workspace holds: the worker's refusal, under the field, and what was typed stays.
  await address.fill('globex');
  await expect(address).not.toHaveAttribute('aria-invalid', 'true');
  await address.press('Enter');
  await expect(page.getByText('Another workspace already has this address. Choose another one.')).toBeVisible();
  await expect(address).toHaveValue('globex');
  await expect(page).toHaveURL(`${CONSOLE}/w/acme/settings`);
  await address.fill('admin');
  await save.click();
  await expect(page.getByText('This address is reserved for Fruitback. Choose another one.')).toBeVisible();

  // Kept: the address of the page follows at once, and the rail leads there.
  await address.fill('acme-labs');
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'The address is saved.' })).toBeVisible();
  await expect(page).toHaveURL(`${CONSOLE}/w/acme-labs/settings`);
  await expect(address).toHaveValue('acme-labs');
  await expect(rail(page).getByRole('link', { name: 'Notes', exact: true })).toHaveAttribute(
    'href',
    '/w/acme-labs/notes',
  );
  expect(worker.saves).toEqual([
    { name: 'Acme', slug: 'globex' },
    { name: 'Acme', slug: 'admin' },
    { name: 'Acme', slug: 'acme-labs' },
  ]);
  // The name of before still opens the workspace, at its new short name.
  await page.goto(`${CONSOLE}/w/acme/sites`);
  await expect(page).toHaveURL(`${CONSOLE}/w/acme-labs/sites`);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('a member reads the address and cannot change it', async ({ page }) => {
  await workerWith(page, [{ ...ACME, role: 'member' }]);
  await page.goto(`${CONSOLE}/w/acme/settings`);
  await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Workspace URL' })).toHaveCount(0);
  await expect(page.locator('li').filter({ hasText: 'Workspace URL' })).toContainText('localhost:5178/w/acme');
});

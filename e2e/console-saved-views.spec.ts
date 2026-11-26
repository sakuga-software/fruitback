import { type Browser, type BrowserContext, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';

/**
 * The views of the person (FRU-723): « Save view » in the bar of filters of the notes names the
 * filters that are on, the worker keeps the view with the membership of the person, and the bar shows
 * it under the views of the mockup. Its menu renames it and deletes it.
 *
 * The worker is a process of this spec, on PGlite, and answers each request: no stub decides an
 * answer. A second browser of the same person reads the view from the worker, so nothing of it is
 * kept in the browser.
 */

const views = (page: Page) => page.locator('aside.kit-rail').getByRole('navigation', { name: 'Views' });
const toolbar = (page: Page) => page.locator('[data-notes-toolbar]');

/** Signs `email` in by a link, in the setup, and answers the id of the workspace it makes. */
async function signInByLink(page: Page, worker: Worker, email: string): Promise<string> {
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.sent()).length).toBe(1);
  await page.goto(await linkIn(worker));
  await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
  const read = (await worker.received())
    .map((each) => /^\/console\/workspaces\/(ws_[0-9a-f]{20})\/sites$/.exec(each.path)?.[1])
    .filter((id) => id !== undefined);
  expect(read.length, 'the console read the sites of no workspace').toBeGreaterThan(0);

  return read.at(-1) as string;
}

/** Another browser of the same person, signed in by a second link, on the Sites screen. */
async function anotherBrowser(
  browser: Browser,
  worker: Worker,
  email: string,
  workspace: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await served(context, worker);
  const page = await context.newPage();
  const before = (await worker.sent()).length;
  await page.goto(`${CONSOLE}/sign-in`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.sent()).length).toBe(before + 1);
  await page.goto(await linkIn(worker));
  await expect(page).toHaveURL(/\/setup$|\/sites$/);
  await page.goto(`${CONSOLE}/w/${workspace}/sites`);
  await expect(page.getByRole('heading', { name: 'Sites', level: 1 })).toBeVisible();

  return { context, page };
}

/** The Notes screen with `query`, at rest: the bar of filters is drawn. */
async function openNotes(page: Page, workspace: string, query: string): Promise<void> {
  await page.goto(`${CONSOLE}/w/${workspace}/notes?${query}`);
  await expect(toolbar(page)).toBeVisible();
  await expect(page.getByText('No note matches.')).toBeVisible();
}

/** Chooses an item of the menu of a view of the person in the bar. */
async function fromMenu(page: Page, view: string, item: string): Promise<void> {
  await views(page)
    .getByRole('button', { name: `Actions of the view ${view}` })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe('the views of the person (FRU-723)', () => {
  let worker: Worker;

  test.beforeEach(async ({ page }) => {
    // The index of the notes: the Notes screen reads its list, and draws the bar of filters.
    worker = await cloudWorker({ index: true });
    await served(page, worker);
  });
  test.afterEach(({ page }) => finished(page, worker));

  test('saves a view from the bar of filters, opens it in another browser, renames it and deletes it', async ({
    page,
    browser,
  }) => {
    const workspace = await signInByLink(page, worker, 'ana@acme.dev');
    await openNotes(page, workspace, 'stage=new&q=menu');
    // The control: no view of the person yet, and the list is « Notes ».
    await expect(views(page).getByRole('link')).toHaveCount(3);

    await toolbar(page).getByRole('button', { name: 'Save view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save view' });
    await dialog.getByRole('textbox', { name: 'Name' }).fill('  Fresh menus  ');
    await dialog.getByRole('button', { name: 'Save view' }).click();
    await expect(dialog).toHaveCount(0);

    // The view is under the three of the mockup, and it is the one on screen.
    const saved = views(page).getByRole('link', { name: 'Fresh menus', exact: true });
    await expect(saved).toHaveAttribute('aria-current', 'page');
    await expect(views(page).getByRole('link')).toHaveCount(4);
    await expect(views(page).getByRole('link').nth(3)).toHaveText('Fresh menus');
    await expect(page.locator('aside.kit-rail').getByRole('link', { name: /^Notes/ })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
    // The filters are a view now: no « Save view » for them.
    await expect(toolbar(page).getByRole('button', { name: 'Save view' })).toHaveCount(0);
    // Nothing of it in the storage of the browser: the worker keeps it.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored).not.toContain('Fresh menus');

    // Another browser of Ana: the view is in its bar, and opens the list with its filters.
    const other = await anotherBrowser(browser, worker, 'ana@acme.dev', workspace);
    try {
      const there = views(other.page).getByRole('link', { name: 'Fresh menus', exact: true });
      await expect(there).not.toHaveAttribute('aria-current', 'page');
      await there.click();
      await expect(other.page).toHaveURL(`${CONSOLE}/w/${workspace}/notes?stage=new&q=menu`);
      await expect(there).toHaveAttribute('aria-current', 'page');
      await expect(other.page.getByRole('textbox', { name: 'Search notes' })).toHaveValue('menu');
    } finally {
      await finished(other.context, undefined);
      await other.context.close();
    }

    // Renamed from the menu of its entry: the name it was given is in the field.
    await fromMenu(page, 'Fresh menus', 'Rename…');
    const rename = page.getByRole('dialog', { name: 'Rename the view' });
    const name = rename.getByRole('textbox', { name: 'Name' });
    await expect(name).toHaveValue('Fresh menus');
    await name.fill('Menus to fix');
    await rename.getByRole('button', { name: 'Rename' }).click();
    await expect(rename).toHaveCount(0);
    await expect(views(page).getByRole('link', { name: 'Menus to fix', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(views(page).getByRole('link', { name: 'Fresh menus' })).toHaveCount(0);

    // Deleted from the menu: the dialog asks the second time, and « Cancel » keeps it.
    await fromMenu(page, 'Menus to fix', 'Delete…');
    const ask = page.getByRole('dialog', { name: 'Delete the view' });
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(views(page).getByRole('link', { name: 'Menus to fix', exact: true })).toBeVisible();
    await fromMenu(page, 'Menus to fix', 'Delete…');
    await ask.getByRole('button', { name: 'Delete « Menus to fix »' }).click();
    await expect(ask).toHaveCount(0);
    await expect(views(page).getByRole('link')).toHaveCount(3);
    // The list stays on screen with its filters, and « Save view » is offered again.
    await expect(page).toHaveURL(`${CONSOLE}/w/${workspace}/notes?stage=new&q=menu`);
    await expect(toolbar(page).getByRole('button', { name: 'Save view' })).toBeVisible();

    // The worker was asked each time: kept, renamed, deleted, and none of it is left.
    const asked = (await worker.received()).map((each) => `${each.method} ${each.path}`);
    expect(asked).toContain(`POST /console/workspaces/${workspace}/views`);
    expect(asked.some((each) => new RegExp(`^POST /console/workspaces/${workspace}/views/view_`).test(each))).toBe(
      true,
    );
    expect(asked.some((each) => new RegExp(`^DELETE /console/workspaces/${workspace}/views/view_`).test(each))).toBe(
      true,
    );
    await page.reload();
    await expect(toolbar(page)).toBeVisible();
    await expect(views(page).getByRole('link')).toHaveCount(3);
  });

  test('offers « Save view » once a filter is on, and not for the filters of a view of the mockup', async ({
    page,
  }) => {
    const workspace = await signInByLink(page, worker, 'ana@acme.dev');
    // « Assigned to me » is a view of the mockup already.
    await openNotes(page, workspace, 'assignee=me');
    await expect(views(page).getByRole('link', { name: /^Assigned to me/ })).toHaveAttribute('aria-current', 'page');
    await expect(toolbar(page).getByRole('button', { name: 'Save view' })).toHaveCount(0);

    // The control: a filter more, and it is another list, which a view can name.
    await openNotes(page, workspace, 'assignee=me&stage=todo');
    await expect(toolbar(page).getByRole('button', { name: 'Save view' })).toBeVisible();
  });
});

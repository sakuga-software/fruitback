import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, served } from './cloud-worker.ts';

/**
 * The Members screen of a workspace past a hundred members and a hundred invitations (FRU-496), on a
 * worker of this spec (`cloud-worker.ts`): 501 members and 300 invitations that wait.
 *
 * The screen stopped at the hundred first of each and said nothing: the 101ᵗʰ member could not be
 * found nor removed. Now each list is in pages of 50, under its heading and its count, and a search
 * reads the name or the address. The worker gives the members a page at a time.
 */

/** Signs `email` in by the link of the setup: somebody with no workspace gets one. Its id. */
async function owner(page: Page, worker: Worker, email: string): Promise<string> {
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  let link: string | undefined;
  await expect
    .poll(async () => {
      const text = (await worker.mail()).findLast((each) => each.to === email)?.text ?? '';
      link = /http:\/\/\S+\/sign-in#\S+/.exec(text)?.[0];

      return link !== undefined;
    })
    .toBe(true);
  await page.goto(link as string);
  await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
  // The workspace has no site, so the front door leads to the setup: its id is where the worker read it.
  const workspace = (await worker.received())
    .map((each) => /^\/console\/workspaces\/(ws_[0-9a-f]{20})\/sites$/.exec(each.path)?.[1])
    .findLast((id) => id !== undefined);
  expect(workspace).toMatch(/^ws_[0-9a-f]{20}$/);

  return workspace as string;
}

test.describe('the members of a large workspace (FRU-496)', () => {
  // The start of the worker and the 800 rows are counted in the time of the test (FRU-430).
  test.slow();
  let worker: Worker;
  let context: BrowserContext;

  test.beforeEach(async ({ browser }) => {
    worker = await cloudWorker();
    context = await browser.newContext({ locale: 'en-US' });
    await served(context, worker);
  });
  test.afterEach(async () => {
    await finished(context, worker);
    await context.close();
  });

  test('pages through 501 members, finds the 322nd by a search, and removes them', async () => {
    const page = await context.newPage();
    const workspace = await owner(page, worker, 'owner@acme.dev');
    await worker.crowd(workspace, 500, 300);
    await page.goto(`${CONSOLE}/w/${workspace}/members`);

    const members = page.getByRole('region', { name: 'Members' });
    const pages = page.getByRole('navigation', { name: 'Pages of members' });
    await expect(page.getByRole('heading', { name: 'Members 501', level: 2 })).toBeVisible();
    await expect(members.locator('tbody tr')).toHaveCount(50);
    await expect(pages).toContainText('1 to 50 of 501');
    await expect(pages.getByRole('button', { name: 'Previous' })).toBeDisabled();
    // The owner joined first: the first row. The 50th row is the 49th person of the crowd.
    await expect(members.locator('tbody tr').first()).toContainText('owner (you)');
    await expect(members.locator('tbody tr').last()).toContainText('p49@crowd.test');

    // Each page follows the one before, with no member twice and none skipped, to the 501st.
    await pages.getByRole('button', { name: 'Next' }).click();
    await expect(pages).toContainText('51 to 100 of 501');
    await expect(members.locator('tbody tr').first()).toContainText('p50@crowd.test');
    await expect(members.locator('tbody tr').last()).toContainText('p99@crowd.test');
    await pages.getByRole('button', { name: 'Next' }).click();
    await expect(pages).toContainText('101 to 150 of 501');
    await expect(members.locator('tbody tr').first()).toContainText('p100@crowd.test');
    for (let at = 151; at <= 501; at += 50) await pages.getByRole('button', { name: 'Next' }).click();
    await expect(pages).toContainText('501 to 501 of 501');
    await expect(members.locator('tbody tr')).toHaveCount(1);
    await expect(members.locator('tbody tr')).toContainText('p500@crowd.test');
    await expect(pages.getByRole('button', { name: 'Next' })).toBeDisabled();

    // A search by address, whatever its case, back on the first page of what it finds.
    await page.getByRole('searchbox', { name: 'Search members' }).fill('P321@CROWD');
    await expect(page.getByRole('heading', { name: 'Members 1', level: 2 })).toBeVisible();
    await expect(members.locator('tbody tr')).toHaveCount(1);
    await expect(members.locator('tbody tr')).toContainText('Person 321');
    await expect(pages).toHaveCount(0);
    // And by name: « Person 32 » is ten people and Person 32 itself.
    await page.getByRole('searchbox', { name: 'Search members' }).fill('person 32');
    await expect(page.getByRole('heading', { name: 'Members 11', level: 2 })).toBeVisible();

    // The 322nd member of the workspace is removed, as any other.
    await page.getByRole('searchbox', { name: 'Search members' }).fill('p321@');
    await expect(members.locator('tbody tr')).toHaveCount(1);
    await members.getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove Person 321' }).click();
    await expect(page.getByText('Nobody matches this search.')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search members' }).fill('');
    await expect(page.getByRole('heading', { name: 'Members 500', level: 2 })).toBeVisible();
    await expect(pages).toContainText('1 to 50 of 500');
  });

  test('pages through 300 invitations that wait, and finds one by its address', async () => {
    const page = await context.newPage();
    const workspace = await owner(page, worker, 'owner@acme.dev');
    await worker.crowd(workspace, 500, 300);
    await page.goto(`${CONSOLE}/w/${workspace}/members`);

    const waiting = page.getByRole('region', { name: 'Pending invitations' });
    const pages = page.getByRole('navigation', { name: 'Pages of invitations' });
    await expect(page.getByRole('heading', { name: 'Pending invitations 300', level: 2 })).toBeVisible();
    await expect(waiting.locator('tbody tr')).toHaveCount(50);
    await expect(pages).toContainText('1 to 50 of 300');
    await expect(waiting.locator('tbody tr').first()).toContainText('invitee1@client.test');
    for (let at = 51; at <= 251; at += 50) await pages.getByRole('button', { name: 'Next' }).click();
    await expect(pages).toContainText('251 to 300 of 300');
    await expect(waiting.locator('tbody tr').last()).toContainText('invitee300@client.test');

    // The search reads the address of an invitation too, and leaves the members it does not find.
    await page.getByRole('searchbox', { name: 'Search members' }).fill('INVITEE299');
    await expect(page.getByRole('heading', { name: 'Pending invitations 1', level: 2 })).toBeVisible();
    await expect(waiting.locator('tbody tr')).toHaveCount(1);
    await expect(waiting.locator('tbody tr')).toContainText('invitee299@client.test');
    await expect(page.getByText('Nobody matches this search.')).toBeVisible();
  });
});

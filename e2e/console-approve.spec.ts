import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, stubWorker } from './console-workspace.ts';

/**
 * The queue « To approve » of a workspace (FRU-704): the notes of visitors that wait for a member on
 * the sites that say « Hold new visitor notes ». The worker is answered by stubs, with the bodies of
 * `console-held.ts`; the sample data is of nobody. What the worker does with an approval (the note goes
 * to its place, as the visitor's own) is held by `held-notes.test.ts`.
 */
const CONSOLE = 'http://localhost:5178';

const NOTES = [
  {
    site: 's2',
    origin: 'https://acme.dev',
    note: 'n1',
    page: 'https://acme.dev/pricing',
    text: 'The price of the yearly plan is wrong.',
    name: 'Camille',
    heldAt: Date.now() - 120_000,
  },
  {
    site: 's2',
    origin: 'https://acme.dev',
    note: 'n2',
    page: 'https://acme.dev/',
    text: 'The headline runs to three lines on a phone.',
    heldAt: Date.now() - 600_000,
  },
];

type Worker = { posted: string[]; fails?: string };

/**
 * `late`: the first read of the count waits for it, and then answers the count of when it was asked,
 * as a slow worker does (FRU-733).
 */
async function workerWith(page: Page, role: Role = 'member', notes = NOTES, late?: Promise<void>): Promise<Worker> {
  const worker: Worker = { posted: [] };
  let waiting = [...notes];
  let held = late;
  await stubWorker(page, {
    workspaces: [{ ...ACME, role }],
    answer: (pathname: string, route: Route) => {
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (pathname === '/console/workspaces/w1/held/count') {
        if (role === 'guest') return json({ error: 'forbidden' }, 403);
        const count = waiting.length;
        const wait = held;
        held = undefined;

        return wait === undefined ? json({ count }) : wait.then(() => json({ count }));
      }
      if (pathname === '/console/workspaces/w1/held') return json({ notes: waiting });
      const asked = /^\/console\/workspaces\/w1\/held\/(\w+)\/(\w+)\/(approve|reject)$/.exec(pathname);
      if (asked !== null && route.request().method() === 'POST') {
        worker.posted.push(`${asked[3]} ${asked[2]}`);
        if (worker.fails !== undefined) return json({ error: worker.fails }, 502);
        waiting = waiting.filter((each) => each.note !== asked[2]);

        return asked[3] === 'reject' ? route.fulfill({ status: 204 }) : json({ issue: { identifier: 'ACME-12' } });
      }

      return undefined;
    },
  });

  return worker;
}

const entry = (page: Page) => page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /To approve/ });
const rows = (page: Page) => page.getByRole('list', { name: 'Notes to approve' }).getByRole('listitem');

test('a member finds the notes to approve from the bar, approves one and rejects the other (FRU-704)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(entry(page)).toContainText('2');

  await entry(page).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/approve`);
  await expect(page.locator('main h1')).toHaveText('To approve');
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).first()).toContainText('acme.dev · /pricing · Camille');
  await expect(rows(page).first()).toContainText('The price of the yearly plan is wrong.');
  await expect(rows(page).nth(1)).toContainText('A visitor');
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  await page.getByRole('button', { name: 'Approve the note of Camille' }).click();
  await expect(page.getByRole('status')).toHaveText('Approved. The note was sent as ACME-12.');
  await expect(rows(page)).toHaveCount(1);
  await expect(entry(page)).toContainText('1');

  await page.getByRole('button', { name: 'Reject the note of a visitor' }).click();
  await expect(page.getByRole('status')).toHaveText('Rejected. The note was removed.');
  await expect(page.locator('[data-approve-empty]')).toHaveText('No note waits for approval.');
  expect(worker.posted).toEqual(['approve n1', 'reject n2']);
});

test('a late read of the bar does not set an older count of « To approve » again (FRU-733)', async ({ page }) => {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await workerWith(page, 'member', NOTES, released);
  await page.goto(`${CONSOLE}/w/w1/approve`);
  await expect(rows(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Approve the note of Camille' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(entry(page)).toContainText('1');

  // The read of the bar, asked when two notes waited, answers now.
  const answered = page.waitForEvent('requestfinished', (request) => request.url().endsWith('/held/count'));
  release();
  await answered;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(entry(page)).toContainText('1');
  await expect(entry(page)).not.toContainText('2');
});

test('a refused approval says why, and the note still waits (FRU-704)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.fails = 'store-unavailable';
  await page.goto(`${CONSOLE}/w/w1/approve`);
  await page.getByRole('button', { name: 'Approve the note of Camille' }).click();

  await expect(page.locator('main')).toContainText('The tracker did not answer. The note still waits: try again.');
  await expect(rows(page)).toHaveCount(2);
});

test('the bar shows no « To approve » while nothing waits, nor to a guest (FRU-704)', async ({ page }) => {
  await workerWith(page, 'member', []);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toHaveText('Sites');
  await expect(page.getByRole('link', { name: /To approve/ })).toHaveCount(0);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await workerWith(page, 'guest');
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toHaveText('Sites');
  await expect(page.getByRole('link', { name: /To approve/ })).toHaveCount(0);
});

test('at 390 px the queue does not scroll sideways (FRU-704)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/approve`);
  await expect(rows(page)).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0,
  );
});

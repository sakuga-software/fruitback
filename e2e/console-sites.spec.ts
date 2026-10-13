import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import {
  ACME,
  type Role,
  box,
  contrast,
  expectBox,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';

/**
 * The Sites screen (FRU-243), measured in a browser against screen 09 of the mockup of 2026-10-13:
 * the table, the card of a workspace with no site, the alert of a read that failed, the form that
 * adds a site, and the menu of a row.
 *
 * The values are read in the code of the mockup (`09-console-sites.html`), and the boxes in its
 * render at 1440 px and at 390 px (a box is compared where the font is the one of the mockup). The table has the columns that the worker of today fills: the
 * count of notes, the way on the page and the last note wait for FRU-237. The worker is answered by
 * stubs.
 */
const CONSOLE = 'http://localhost:5178';

const INK = '#18181b';
const MUTED = '#6b6b74';
const LINE = '#e4e4e7';
const CONTROL = '#8a8a93';
const SUBTLE = '#fafafa';
const CHIP = '#f4f4f5';
const ACCENT = '#dd2c27';
const WHITE = '#ffffff';

const LINEAR = { connector: 'c1', teamId: 't1', label: 'Linear · Acme web' };
const ADDRESS = { connector: 'c2', label: 'REST API · hooks.acme.dev/feedback' };
const SITES = [
  { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members', destination: LINEAR, destinations: [LINEAR] },
  {
    id: 's2',
    origin: 'https://acme.dev',
    visibility: 'everyone',
    destination: LINEAR,
    destinations: [LINEAR, ADDRESS],
  },
  {
    id: 's3',
    origin: 'https://support.acme.dev',
    visibility: 'everyone',
    destination: ADDRESS,
    destinations: [ADDRESS],
  },
  { id: 's4', origin: 'https://preview.lumen.studio', visibility: 'members' },
];

type Sent = { method: string; pathname: string; body: unknown };
type Worker = {
  /** What the console sent that changes something. */
  sent: Sent[];
  /** How the worker answers the read of the sites. */
  read: 'list' | 'fails' | 'waits';
  /** What the worker answers to a site that is added, and to one that is removed. */
  refuses?: { status: number; error: string };
};

/** A workspace with the sites above, for a role. The stub keeps what the console sent. */
async function workerWith(
  page: Page,
  role: Role = 'owner',
  sites: readonly unknown[] = SITES,
  locale: 'en' | 'fr' = 'en',
): Promise<Worker> {
  const worker: Worker = { sent: [], read: 'list' };
  const kept = [...sites];
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const method = request.method();
    const one = /^\/console\/workspaces\/w1\/sites(?:\/(\w+))?$/.exec(pathname);
    if (one === null) return undefined;
    if (method === 'GET') {
      if (worker.read === 'waits') return new Promise<void>(() => {});
      if (worker.read === 'fails') return route.fulfill({ status: 500, json: { error: 'unknown' } });

      return route.fulfill({ json: { sites: kept } });
    }
    worker.sent.push({ method, pathname, body: method === 'POST' ? request.postDataJSON() : undefined });
    if (worker.refuses !== undefined)
      return route.fulfill({ status: worker.refuses.status, json: { error: worker.refuses.error } });
    if (method === 'DELETE') return route.fulfill({ status: 204 });
    const { url, visibility } = request.postDataJSON() as { url: string; visibility: string };

    return route.fulfill({
      status: 201,
      json: { id: `n${worker.sent.length}`, origin: new URL(url).origin, visibility },
    });
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }], answer });

  return worker;
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.locator('main h1')).toBeVisible();
}

const table = (page: Page) => page.getByRole('region', { name: 'Sites' });
const row = (page: Page, host: string) =>
  table(page)
    .locator('tbody tr')
    .filter({ has: page.getByText(host, { exact: true }) })
    .first();
const more = (page: Page, host: string) => page.getByRole('button', { name: `More for ${host}`, exact: true });

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the list is the table of the mockup, with the columns the worker of today fills', async ({ page }) => {
  await workerWith(page);
  await open(page);

  // The head of the page: the title, what the page is for with the name of the workspace, the action.
  await expect(page.locator('main h1')).toHaveText('Sites');
  await expect(page.getByText('Where Acme collects notes, and where they stand.')).toBeVisible();
  const add = page.getByRole('button', { name: 'Add a site', exact: true });
  expectBox(await box(add), { x: 1211, y: 58, width: 110, height: 44 }, 2, '« Add a site »');
  expect.soft(await styles(page.locator('main header'), ['margin-bottom'])).toEqual({ 'margin-bottom': '28px' });

  // Three columns, each a column header. « Actions » is said and not shown.
  const headers = table(page).locator('thead th');
  await expect(headers).toHaveText(['Site', 'Notes go to', 'Actions']);
  for (const header of await headers.all()) await expect(header).toHaveAttribute('scope', 'col');
  const hidden = await box(headers.last().locator('span'));
  expect.soft({ width: hidden.width, height: hidden.height }).toEqual({ width: 1, height: 1 });
  // The count of notes, the way on the page and the last note wait for the summary of the sites
  // (FRU-237), and the legend of the statuses comes with them.
  await expect(page.getByRole('list', { name: 'Statuses' })).toHaveCount(0);

  // The frame and the cells, as the mockup writes them.
  expect.soft(await styles(table(page), ['border-top-left-radius', 'border-top-width', 'overflow-x'])).toEqual({
    'border-top-left-radius': '14px',
    'border-top-width': '1px',
    'overflow-x': 'auto',
  });
  expect.soft(await painted(table(page), 'borderTopColor')).toEqual(rgb(LINE));
  expect.soft(await styles(table(page).locator('table'), ['font-size', 'line-height'])).toEqual({
    'font-size': '14px',
    'line-height': '20.3px',
  });
  const cell = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  expect.soft(await styles(headers.nth(0), [...cell, 'font-size', 'font-weight', 'text-align'])).toEqual({
    'padding-top': '12px',
    'padding-right': '16px',
    'padding-bottom': '12px',
    'padding-left': '20px',
    'font-size': '13px',
    'font-weight': '600',
    'text-align': 'left',
  });
  expect.soft(await painted(headers.nth(0), 'color')).toEqual(rgb(MUTED));
  expect.soft(await styles(headers.nth(1), cell)).toEqual({
    'padding-top': '12px',
    'padding-right': '16px',
    'padding-bottom': '12px',
    'padding-left': '16px',
  });
  const first = row(page, 'staging.acme.dev');
  expect.soft(await styles(first.locator('td').nth(0), cell)).toEqual({
    'padding-top': '14px',
    'padding-right': '16px',
    'padding-bottom': '14px',
    'padding-left': '20px',
  });
  expect.soft(await styles(first.locator('td').last(), ['padding-right', 'text-align'])).toEqual({
    'padding-right': '20px',
    'text-align': 'right',
  });
  // A row of the mockup is 68 px: two lines of 14 px and 13 px at 1.45, and 14 px above and under.
  expectBox(await box(first), { x: 298, height: 68.2 }, 2, 'the first row');

  // The site: its host at 600, and who sees its notes under it.
  const host = first.getByText('staging.acme.dev', { exact: true });
  expect.soft(await styles(host, ['font-weight', 'font-size'])).toEqual({ 'font-weight': '600', 'font-size': '14px' });
  expect.soft(await painted(host, 'color')).toEqual(rgb(INK));
  const audience = first.getByText('Members of Acme', { exact: true });
  expect.soft(await styles(audience, ['font-size'])).toEqual({ 'font-size': '13px' });
  expect.soft(await painted(audience, 'color')).toEqual(rgb(MUTED));
  await expect(row(page, 'support.acme.dev').getByText('Everyone who visits', { exact: true })).toBeVisible();

  // Where the notes go: the tracker, and the place in it.
  await expect(first.locator('td').nth(1)).toHaveText('LinearTeam Acme web');
  await expect(row(page, 'acme.dev').locator('td').nth(1)).toContainText('Team Acme web and 1 more');
  await expect(row(page, 'support.acme.dev').locator('td').nth(1)).toHaveText('REST APIhooks.acme.dev/feedback');
  await expect(row(page, 'preview.lumen.studio').locator('td').nth(1)).toHaveText('Kept in FruitbackNo tracker yet');

  // The button of a row: 36 px, named after its site, and it opens a menu.
  const button = more(page, 'staging.acme.dev');
  expectBox(await box(button), { x: 1264, width: 36, height: 36 }, 2, 'the button of a row');
  expect.soft(await styles(button, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '8px' });
  expect.soft(await painted(button, 'color')).toEqual(rgb(MUTED));
  await expect(button).toHaveAttribute('aria-haspopup', /^(menu|true)$/);
  await button.hover();
  expect.soft(await painted(button, 'backgroundColor')).toEqual(rgb(CHIP));
  // A row under the pointer is tinted.
  expect.soft(await painted(first, 'backgroundColor')).toEqual(rgb(SUBTLE));
  await page.mouse.move(700, 800);

  // Under the table: what a site with no tracker does, and the way to connect one.
  const foot = page.getByText('A site with no tracker keeps its notes in Fruitback.');
  expect.soft(await styles(foot, ['font-size', 'line-height', 'margin-top'])).toEqual({
    'font-size': '13px',
    'line-height': '19.5px',
    'margin-top': '14px',
  });
  expect.soft(await painted(foot, 'color')).toEqual(rgb(MUTED));
  const connect = foot.getByRole('link', { name: 'Connect a tracker' });
  await expect(connect).toHaveAttribute('href', '/w/w1/connectors');
  expect.soft(await styles(connect, ['font-weight', 'text-decoration-line'])).toEqual({
    'font-weight': '600',
    'text-decoration-line': 'underline',
  });
  // The page of the notes does not exist yet: no link leads to it.
  await expect(page.getByText('see where every note went')).toHaveCount(0);

  await expectNoViolation(page, 'the list');
});

test('a workspace with no site shows the card of the mockup, and its form adds the first site', async ({ page }) => {
  const worker = await workerWith(page, 'owner', []);
  await open(page);

  const card = page.locator('main > div').filter({ hasText: 'No site yet' });
  expect
    .soft(
      await styles(card, [
        'padding-top',
        'padding-left',
        'border-top-left-radius',
        'row-gap',
        'max-width',
        'box-sizing',
      ]),
    )
    .toEqual({
      'padding-top': '48px',
      // clamp(20px, 5vw, 56px) at 1440 px.
      'padding-left': '56px',
      'border-top-left-radius': '14px',
      'row-gap': '14px',
      'max-width': '640px',
      'box-sizing': 'content-box',
    });
  expect.soft(await painted(card, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await painted(card, 'borderTopColor')).toEqual(rgb(LINE));
  expectBox(await box(card), { x: 297, y: 130, width: 754 }, 2, 'the card');

  const drop = card.locator('svg').first();
  expectBox(await box(drop), { x: 354, y: 179, width: 40, height: 48 }, 2, 'the drop');
  expect.soft(await painted(drop, 'fill')).toEqual(rgb(ACCENT));
  const title = card.getByRole('heading', { level: 2, name: 'No site yet' });
  expectBox(await box(title), { x: 354, y: 241, height: 26 }, 2, 'the title of the card');
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '20px', 'font-weight': '700' });
  const text = card.getByText(
    "Paste the address of a site you review. Staging, a preview build or a client's live site: any page of it will do.",
  );
  expect
    .soft(await styles(text, ['font-size', 'line-height']))
    .toEqual({ 'font-size': '15px', 'line-height': '23.25px' });
  expect.soft(await painted(text, 'color')).toEqual(rgb(MUTED));

  const field = card.getByRole('textbox', { name: 'Site address' });
  await expect(field).toHaveAttribute('placeholder', 'staging.acme.dev');
  expectBox(await box(field), { x: 354, y: 370, width: 530.7, height: 44 }, 2, 'the field');
  const submit = card.getByRole('button', { name: 'Add site', exact: true });
  expectBox(await box(submit), { x: 894, y: 370, width: 99.3, height: 44 }, 2, '« Add site »');
  // The head has no « Add a site »: the card is the way to add one.
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(table(page)).toHaveCount(0);
  await expectNoViolation(page, 'the card');

  // Who sees the notes is chosen here too: no route changes it after.
  const who = card.getByRole('radiogroup', { name: 'Who sees the notes?' });
  await expect(who.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await who.getByText('Everyone who visits').click();
  await field.fill('acme.dev');
  await submit.click();
  await expect
    .poll(() => worker.sent)
    .toEqual([
      {
        method: 'POST',
        pathname: '/console/workspaces/w1/sites',
        body: { url: 'https://acme.dev', visibility: 'everyone' },
      },
    ]);
  // The site is a row of the table, and how to put Fruitback on it is open under it.
  await expect(row(page, 'acme.dev').getByText('Everyone who visits')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Install on acme.dev' })).toBeVisible();
  await expect(card).toHaveCount(0);
});

test('a read that failed is the alert of the mockup, and never « No site yet » (FRU-162)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'fails';
  await open(page);

  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { level: 2, name: 'The sites did not load' })).toBeVisible();
  await expect(alert.getByText('Fruitback did not answer. Your sites and notes are safe.')).toBeVisible();
  expect
    .soft(
      await styles(alert, ['padding-top', 'padding-left', 'border-top-left-radius', 'border-top-width', 'max-width']),
    )
    .toEqual({
      'padding-top': '28px',
      'padding-left': '32px',
      'border-top-left-radius': '14px',
      'border-top-width': '1px',
      'max-width': '760px',
    });
  expect.soft(await painted(alert, 'borderTopColor')).toEqual(rgb(CONTROL));
  expectBox(await box(alert), { x: 297, y: 130, width: 826, height: 104.5 }, 2, 'the alert');
  const title = alert.getByRole('heading', { level: 2 });
  expect.soft(await styles(title, ['font-size', 'font-weight'])).toEqual({ 'font-size': '17px', 'font-weight': '600' });
  expectBox(await box(title), { x: 330, y: 159, height: 20 }, 2, 'the title of the alert');
  const again = alert.getByRole('button', { name: 'Try again', exact: true });
  expectBox(await box(again), { x: 989, y: 160, width: 100.1, height: 44 }, 2, '« Try again »');
  expect.soft(await styles(again, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '6px' });

  // Neither the card of a workspace with no site, nor a way to add one on a list nobody read.
  await expect(page.getByText('No site yet')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(table(page)).toHaveCount(0);
  await expectNoViolation(page, 'the alert');

  // « Try again » reads again, and the list is there.
  worker.read = 'list';
  await again.click();
  await expect(row(page, 'staging.acme.dev')).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('the control of « never No site yet »: an answer with no site does show the card', async ({ page }) => {
  await workerWith(page, 'owner', []);
  await open(page);
  await expect(page.getByText('No site yet')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('while the sites are read, the screen says so and shows neither state', async ({ page }) => {
  const worker = await workerWith(page);
  worker.read = 'waits';
  await open(page);
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  await expect(page.getByText('No site yet')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
});

test('« Add a site » opens the form above the table, and a refusal keeps what was typed', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();

  const form = page.getByRole('region', { name: 'Add a site' });
  const formBox = await box(form);
  expect(formBox.y + formBox.height).toBeLessThanOrEqual((await box(table(page))).y);
  const field = form.getByRole('textbox', { name: 'Site address' });
  const submit = form.getByRole('button', { name: 'Add site', exact: true });
  await expect(form.getByRole('radio', { name: /Members of Acme/ })).toBeChecked();
  await expectNoViolation(page, 'the form');

  // What is not an address: the sentence of the console, nothing sent, the field as it was.
  await field.fill('not an address');
  await submit.click();
  await expect(form.getByRole('alert')).toHaveText('Paste the full address of the site, starting with https://.');
  await expect(field).toHaveValue('not an address');
  expect(worker.sent).toEqual([]);

  // What the worker refuses: its own sentence, and the field as it was.
  worker.refuses = { status: 403, error: 'forbidden' };
  await field.fill('docs.acme.dev');
  await submit.click();
  await expect(form.getByRole('alert')).toHaveText('Only an owner or an admin of the workspace adds a site.');
  await expect(field).toHaveValue('docs.acme.dev');
  await expect(row(page, 'docs.acme.dev')).toHaveCount(0);

  // « Cancel » closes the form and sends nothing more.
  const before = worker.sent.length;
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(worker.sent.length).toBe(before);

  // Added: the form closes, the site is a row, and how to put Fruitback on it is open.
  worker.refuses = undefined;
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await form.getByRole('textbox', { name: 'Site address' }).fill('docs.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(row(page, 'docs.acme.dev').getByText('Members of Acme')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Install on docs.acme.dev' })).toBeVisible();
  await expect(form).toHaveCount(0);
  expect(worker.sent.at(-1)).toEqual({
    method: 'POST',
    pathname: '/console/workspaces/w1/sites',
    body: { url: 'https://docs.acme.dev', visibility: 'members' },
  });
});

test('the menu of a row is walked with the keyboard, and what it opens gives focus back', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const button = more(page, 'staging.acme.dev');

  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'More for staging.acme.dev' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Install', 'Preview builds', 'Remove']);
  await expect(menu.getByRole('menuitem', { name: 'Install' })).toBeFocused();
  await page.waitForTimeout(250);
  const opened = await new AxeBuilder({ page }).include('.kit-menu').analyze();
  expect
    .soft(opened.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(button).toBeFocused();

  // « Install »: the two ways to put Fruitback on the site, under its row.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  const install = page.getByRole('region', { name: 'Install on staging.acme.dev' });
  await expect(install.getByRole('button', { name: 'Copy the script' })).toBeVisible();
  await expect(install.getByRole('button', { name: 'Connect this browser' })).toBeVisible();
  expect((await box(install)).y).toBeGreaterThanOrEqual((await box(row(page, 'staging.acme.dev'))).y);
  await expectNoViolation(page, 'the installation under a row');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(install).toHaveCount(0);
  await expect(button).toBeFocused();

  // « Preview builds »: the proof of a domain (FRU-103), which did not go away.
  await button.click();
  await menu.getByRole('menuitem', { name: 'Preview builds' }).click();
  const previews = page.getByRole('region', { name: 'Preview deploys' });
  await expect(previews.getByRole('textbox', { name: 'Domain' })).toBeVisible();
  await expect(previews.getByText('No domain yet. A site covers its own address only.')).toBeVisible();
  // One thing is open at a time, on one row at a time.
  await more(page, 'acme.dev').click();
  await page.getByRole('menu', { name: 'More for acme.dev' }).getByRole('menuitem', { name: 'Install' }).click();
  await expect(previews).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Install on acme.dev' })).toBeVisible();
});

test('removing a site asks twice, and a site that is still there says so on its row', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const button = more(page, 'staging.acme.dev');
  const ask = async () => {
    await button.click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
  };

  await ask();
  const group = page.getByRole('group', { name: 'Remove staging.acme.dev' });
  await expect(group.getByText(/The widget stops on staging\.acme\.dev/)).toBeVisible();
  await expect(group.getByRole('button', { name: 'Keep it' })).toBeFocused();
  expect(worker.sent).toEqual([]);
  await expectNoViolation(page, 'the second time of a removal');
  await group.getByRole('button', { name: 'Keep it' }).click();
  await expect(group).toHaveCount(0);
  await expect(button).toBeFocused();

  // The worker refuses: the site stays, and its row says why.
  worker.refuses = { status: 403, error: 'forbidden' };
  await ask();
  await group.getByRole('button', { name: 'Remove staging.acme.dev' }).click();
  await expect(page.getByRole('alert')).toHaveText('Only an owner or an admin of the workspace removes a site.');
  await expect(row(page, 'staging.acme.dev')).toBeVisible();

  worker.refuses = undefined;
  await group.getByRole('button', { name: 'Remove staging.acme.dev' }).click();
  await expect(page.getByText('staging.acme.dev', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(worker.sent.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
    'DELETE /console/workspaces/w1/sites/s1',
    'DELETE /console/workspaces/w1/sites/s1',
  ]);
});

test('a member installs and changes nothing; a guest does not read where the notes go', async ({ page }) => {
  await workerWith(page, 'member');
  await open(page);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);
  await expect(table(page).locator('thead th')).toHaveText(['Site', 'Notes go to', 'Actions']);
  await more(page, 'staging.acme.dev').click();
  await expect(page.getByRole('menuitem')).toHaveText(['Install']);
  await page.keyboard.press('Escape');

  // The worker sends a guest no destination, and the screen draws no column for one.
  await page.unrouteAll();
  await workerWith(
    page,
    'guest',
    SITES.map(({ id, origin, visibility }) => ({ id, origin, visibility })),
  );
  await open(page);
  await expect(table(page).locator('thead th')).toHaveText(['Site', 'Actions']);
  await expect(page.getByText('Kept in Fruitback')).toHaveCount(0);
  await expect(page.getByText('A site with no tracker keeps its notes in Fruitback.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a site', exact: true })).toHaveCount(0);

  // With no site, somebody who cannot add one reads who can, and gets no form.
  await page.unrouteAll();
  await workerWith(page, 'member', []);
  await open(page);
  await expect(page.getByText('An owner or an admin of Acme adds its first site.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

for (const locale of ['en', 'fr'] as const) {
  test(`at 390 px nothing scrolls sideways, in ${locale}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const worker = await workerWith(page, 'owner', SITES, locale);
    await open(page);
    const words =
      locale === 'en'
        ? { more: 'More for', install: 'Install', previews: 'Preview builds', add: 'Add a site' }
        : { more: 'Plus pour', install: 'Installer', previews: 'Previews', add: 'Ajouter un site' };
    expect.soft(await sideScroll(page), 'the list').toBe(0);
    // The table fits: nothing of a row is past the edge, so what opens under a row is on screen.
    expect.soft(await table(page).evaluate((frame) => frame.scrollWidth - frame.clientWidth), 'the table').toBe(0);

    const button = page.getByRole('button', { name: `${words.more} staging.acme.dev`, exact: true });
    await button.click();
    await page.getByRole('menuitem', { name: words.install, exact: true }).click();
    expect.soft(await sideScroll(page), 'the installation').toBe(0);
    // The script is one long line: it scrolls in its own block, and the table stays as wide as its frame.
    const fits = () => table(page).evaluate((frame) => frame.scrollWidth - frame.clientWidth);
    expect.soft(await fits(), 'the table, with the installation under a row').toBe(0);
    expect.soft(await page.locator('pre').evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true);
    await button.click();
    await page.getByRole('menuitem', { name: words.previews, exact: true }).click();
    await expect(page.getByRole('textbox').first()).toBeVisible();
    expect.soft(await sideScroll(page), 'the proof of a domain').toBe(0);
    expect.soft(await fits(), 'the table, with the proof of a domain under a row').toBe(0);
    await page.getByRole('button', { name: words.add, exact: true }).click();
    expect.soft(await sideScroll(page), 'the form').toBe(0);

    worker.read = 'fails';
    await open(page);
    await expect(page.getByRole('alert')).toBeVisible();
    expect.soft(await sideScroll(page), 'the alert').toBe(0);
  });
}

test('at 390 px the card and the alert are where the mockup draws them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page, 'owner', []);
  await open(page);
  // The render of the mockup at 390 px. Its rail takes the rest of a short window (175 px here), which
  // the frame does not copy: the boxes are compared from the top of the screen under the rail.
  const top = (await box(page.locator('main'))).y;
  const card = page.locator('main > div').filter({ hasText: 'No site yet' });
  expectBox(await box(card), { x: 16, y: top + 154.2, width: 358 }, 4, 'the card');
  expectBox(await box(card.locator('svg').first()), { x: 37, y: top + 203.2, width: 40, height: 48 }, 4, 'the drop');
  expectBox(await box(card.getByRole('heading', { level: 2 })), { x: 37, y: top + 265.2, height: 26 }, 4, 'the title');
  expectBox(
    await box(card.getByRole('textbox', { name: 'Site address' })),
    { x: 37, y: top + 417, width: 316, height: 44 },
    4,
    'the field',
  );
  expectBox(
    await box(card.getByRole('button', { name: 'Add site' })),
    { x: 37, y: top + 471, width: 99.3, height: 44 },
    4,
    '« Add site »',
  );
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'the card at 390 px');

  await page.unrouteAll();
  const worker = await workerWith(page);
  worker.read = 'fails';
  await open(page);
  const alert = page.getByRole('alert');
  const under = (await box(page.locator('main'))).y;
  expectBox(await box(alert), { x: 16, y: under + 154.2, width: 358, height: 187 }, 4, 'the alert');
  expectBox(
    await box(alert.getByRole('heading', { level: 2 })),
    { x: 49, y: under + 183.2, height: 20 },
    4,
    'the title of the alert',
  );
  expectBox(
    await box(alert.getByRole('button', { name: 'Try again' })),
    { x: 49, y: under + 268.2, width: 100.1, height: 44 },
    4,
    '« Try again »',
  );
});

test('every text of the list is at 4.5:1 on what is behind it, a row under the pointer too', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const first = row(page, 'staging.acme.dev');
  const texts: [string, Locator][] = [
    ['a column header', table(page).locator('thead th').first()],
    ['a host', first.getByText('staging.acme.dev', { exact: true })],
    ['who sees the notes', first.getByText('Members of Acme', { exact: true })],
    ['a tracker', first.getByText('Linear', { exact: true })],
    ['a place in a tracker', first.getByText('Team Acme web', { exact: true })],
  ];
  for (const behind of [WHITE, SUBTLE]) {
    for (const [name, text] of texts) {
      expect
        .soft(contrast(await painted(text, 'color'), rgb(behind)), `${name} on ${behind}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  }
  // The button of a row is a picture: 3:1 on the row, and on its own tint under the pointer.
  const button = more(page, 'staging.acme.dev');
  expect.soft(contrast(await painted(button, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(3);
  expect.soft(contrast(await painted(button, 'color'), rgb(CHIP))).toBeGreaterThanOrEqual(3);
});

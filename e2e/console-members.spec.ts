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
 * The Members screen (FRU-247), measured in a browser against screen 12 of the mockup of 2026-10-13:
 * the invitation on one line, and the table of the people and of the invitations.
 *
 * The values are read in the code of the mockup (`12-console-members.html`), and the boxes in its
 * render at 1440 px and at 390 px (a box is compared where the font is the one of the mockup). The
 * form offers « Guest, one site » when the workspace has a site, and the list « Site » for that role
 * only (FRU-250); the mockup draws that state, and the screen opens on « Member ». The last column is
 * « Last seen » for an owner or an admin, read from `…/members/seen` (FRU-249), and the day somebody
 * joined for the others, or when that read gives nothing. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const INK = '#18181b';
const MUTED = '#6b6b74';
const LINE = '#e4e4e7';
const CONTROL = '#8a8a93';
const SUBTLE = '#fafafa';
const AVATAR = '#3f3f46';
const ACCENT = '#dd2c27';
const ACCENT_STRONG = '#b91c1c';
const WHITE = '#ffffff';

const person = (id: number, name: string, email: string, role: Role, day: string) => ({
  id: `m${id}`,
  userId: `a${id}`,
  role,
  createdAt: `${day}T12:00:00.000Z`,
  user: { id: `a${id}`, email, name },
});
const ANA = person(1, 'Ana', 'ana@acme.dev', 'owner', '2026-06-02');
const TOM = person(2, 'Tom', 'tom@acme.dev', 'admin', '2026-07-14');
const NORA = person(3, 'Nora', 'nora@acme.dev', 'member', '2026-09-01');
const INES = {
  ...person(4, 'Inès Morel', 'ines@client.fr', 'guest', '2026-09-22'),
  sites: [{ id: 's1', origin: 'https://staging.acme.dev' }],
};
const MEMBERS = [ANA, TOM, NORA, INES];
const PAUL = {
  id: 'i1',
  email: 'paul@client.fr',
  role: 'member',
  organizationId: 'w1',
  status: 'pending',
  createdAt: '2026-10-03T12:00:00.000Z',
  expiresAt: '2026-10-10T12:00:00.000Z',
};

type Sent = { call: string; body: Record<string, unknown> };
type Worker = {
  /** Releases a held `…/members/seen`. */
  release: () => void;
  /** What the console sent that changes something. */
  sent: Sent[];
  /** What the console read. */
  read: string[];
  /** How the worker answers the read of the members. */
  members: 'list' | 'fails' | 'waits';
  /** Whether the worker sends mail, and whether it sent the message of this invitation. */
  mails: boolean;
  held: boolean;
  /** An invitation that is asked and not answered yet. */
  slow: boolean;
  /** What the worker answers to a change it refuses. */
  refuses?: { status: number; error: string; field?: string };
};

type World = {
  role?: Role;
  locale?: 'en' | 'fr';
  members?: readonly unknown[];
  invitations?: readonly unknown[];
  /** The answer of `…/members/seen`: the day of each account, refused, or held. Absent: no route. */
  seen?: Record<string, string> | 'refused' | 'waits';
  /** The days that a held answer gives when it is released. */
  released?: Record<string, string>;
  /** The days that a read made again gets, while the first one is still held. */
  later?: Record<string, string>;
};

/** A workspace with the people above, for a role. The stub keeps what the console sent. */
async function workerWith(page: Page, world: World = {}): Promise<Worker> {
  const held: (() => void)[] = [];
  const worker: Worker = {
    release: () => {
      for (const each of held.splice(0)) each();
    },
    sent: [],
    read: [],
    members: 'list',
    mails: true,
    held: false,
    slow: false,
  };
  const members = [...(world.members ?? MEMBERS)];
  const invitations = [...(world.invitations ?? [PAUL])] as (typeof PAUL)[];
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const call = pathname.split('/').at(-1) ?? '';
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers')
      return json({ betterAuth: { email: worker.mails, github: false, google: false } });
    if (call === 'list-members') {
      worker.read.push(call);
      if (worker.members === 'waits') return new Promise<void>(() => {});
      if (worker.members === 'fails') return json({ error: 'unknown' }, 500);

      return json({ members });
    }
    if (pathname === '/console/workspaces/w1/members/seen' && world.seen !== undefined) {
      worker.read.push('seen');
      // A read made again while the first is held gets its answer at once, when the test gives one.
      // The first read is sent twice by the development server (the effects of React run twice):
      // it is the read after an action, counted from the invitations, that is the second one.
      if (world.seen === 'waits' && world.later !== undefined && worker.sent.length > 0) {
        return json({ seen: world.later });
      }
      if (world.seen === 'waits') {
        return new Promise<void>((resolve) => {
          held.push(() => void json({ seen: world.released ?? {} }).then(resolve));
        });
      }
      if (world.seen === 'refused') return json({ error: 'forbidden' }, 403);

      return json({ seen: world.seen });
    }
    if (call === 'list-invitations') {
      worker.read.push(call);

      return json(invitations);
    }
    if (!['invite-member', 'cancel-invitation', 'remove-member'].includes(call)) return undefined;
    const body = request.postDataJSON() as Record<string, unknown>;
    // A request held open reaches the worker a while after the button says « Sending… »: on CI the
    // button said it before the stub saw the request (FRU-442: 6 sent where 7 were read).
    // The stub keeps that order on every machine, so a test reads what was sent by polling.
    if (worker.slow)
      return new Promise<void>(() => {
        setTimeout(() => worker.sent.push({ call, body }), 300);
      });
    worker.sent.push({ call, body });
    if (worker.refuses !== undefined) {
      const { status, ...refused } = worker.refuses;

      return json(refused, status);
    }
    if (call !== 'invite-member') return json({});
    const again = invitations.find((each) => each.email === body.email);
    const invitation = again ?? {
      ...PAUL,
      id: `i${invitations.length + 1}`,
      email: String(body.email),
      role: String(body.role),
      createdAt: '2026-10-13T12:00:00.000Z',
      expiresAt: '2026-10-20T12:00:00.000Z',
    };
    if (again === undefined) invitations.push(invitation);

    return json({ ...invitation, ...(worker.held ? { mailed: false } : {}) });
  };
  await stubWorker(page, {
    locale: world.locale ?? 'en',
    workspaces: [{ ...ACME, role: world.role ?? 'owner' }],
    answer,
  });

  return worker;
}

/** The sites of the workspace, in place of the one the stub lists. */
async function stubSites(page: Page, sites: readonly unknown[]): Promise<void> {
  await page.route(/\/console\/workspaces\/w1\/sites$/, (route) => route.fulfill({ status: 200, json: { sites } }));
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/members`);
  await expect(page.locator('main h1')).toBeVisible();
}

const form = (page: Page) => page.getByRole('form', { name: 'Invite someone' });
const email = (page: Page) => form(page).getByRole('textbox', { name: 'Email', exact: true });
const roles = (page: Page) => form(page).getByRole('button', { name: /Role$/ });
const invite = (page: Page) => form(page).getByRole('button', { name: 'Invite', exact: true });
const table = (page: Page) => page.getByRole('region', { name: /^(Members|Membres)$/ });
const row = (page: Page, name: string) =>
  table(page)
    .locator('tbody tr')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const cells = (page: Page, name: string) => row(page, name).locator('td');

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

const CELL = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];

test('the list is the table of the mockup, with what the worker of today says of a person', async ({ page }) => {
  await workerWith(page);
  await open(page);

  // The head of the page: 24 px above the form on this screen.
  await expect(page.locator('main h1')).toHaveText('Members');
  await expect(page.getByText('Who sees and leaves notes, and who changes the workspace.')).toBeVisible();
  expect.soft(await styles(page.locator('main header'), ['margin-bottom'])).toEqual({ 'margin-bottom': '24px' });
  expectBox(await box(page.locator('main h1')), { x: 296.5, y: 40, height: 32.2 }, 2, 'the title');

  // Four columns, each a column header. « Last seen » waits for a decision: the day somebody joined.
  const headers = table(page).locator('thead th');
  await expect(headers).toHaveText(['Person', 'Role', 'Sites', 'Joined']);
  for (const header of await headers.all()) await expect(header).toHaveAttribute('scope', 'col');
  await expect(page.getByText('Last seen')).toHaveCount(0);

  // The frame and the cells, as the mockup writes them.
  expect.soft(await styles(table(page), ['border-top-left-radius', 'border-top-width', 'overflow-x'])).toEqual({
    'border-top-left-radius': '14px',
    'border-top-width': '1px',
    'overflow-x': 'auto',
  });
  expect.soft(await painted(table(page), 'borderTopColor')).toEqual(rgb(LINE));
  expect.soft(await styles(table(page).locator('table'), ['font-size', 'line-height', 'min-width'])).toEqual({
    'font-size': '14px',
    'line-height': '20.3px',
    'min-width': '760px',
  });
  expect.soft(await styles(headers.nth(0), [...CELL, 'font-size', 'font-weight', 'text-align'])).toEqual({
    'padding-top': '12px',
    'padding-right': '16px',
    'padding-bottom': '12px',
    'padding-left': '20px',
    'font-size': '13px',
    'font-weight': '600',
    'text-align': 'left',
  });
  expect.soft(await painted(headers.nth(0), 'color')).toEqual(rgb(MUTED));
  expect.soft(await styles(headers.nth(3), ['padding-right', 'text-align'])).toEqual({
    'padding-right': '20px',
    'text-align': 'right',
  });
  const tom = cells(page, 'Tom');
  expect.soft(await styles(tom.nth(0), CELL)).toEqual({
    'padding-top': '12px',
    'padding-right': '16px',
    'padding-bottom': '12px',
    'padding-left': '20px',
  });
  expect.soft(await styles(tom.nth(1), CELL)).toEqual({
    'padding-top': '12px',
    'padding-right': '16px',
    'padding-bottom': '12px',
    'padding-left': '16px',
  });
  expect
    .soft(await styles(tom.nth(3), ['padding-right', 'text-align', 'white-space', 'font-variant-numeric']))
    .toEqual({
      'padding-right': '20px',
      'text-align': 'right',
      'white-space': 'nowrap',
      'font-variant-numeric': 'tabular-nums',
    });
  expect.soft(await painted(tom.nth(3), 'color')).toEqual(rgb(MUTED));
  // The screen is as wide as its column (FRU-398): 71.5 px wider than the 1120 px of the mockup.
  expectBox(await box(table(page)), { x: 296.5, y: 216.2, width: 1095.5, height: 366.5 }, 2, 'the frame of the table');
  expectBox(await box(table(page).locator('thead tr')), { height: 43.3 }, 2, 'the header row');
  // A row of the mockup is 64 px: two lines of 14 px and 13 px at 1.45, and 12 px above and under.
  expectBox(await box(row(page, 'Tom')), { x: 297.5, y: 324.7, width: 1093.5, height: 64.1 }, 2, 'the second row');

  // A person: the round chip with the initial, the name at 600, the address under it.
  const chip = tom.nth(0).locator('.kit-avatar');
  await expect(chip).toHaveText('T');
  await expect(chip).toHaveAttribute('aria-hidden', 'true');
  expect.soft(await styles(chip, ['width', 'height', 'border-top-left-radius', 'font-size', 'font-weight'])).toEqual({
    width: '32px',
    height: '32px',
    'border-top-left-radius': '999px',
    'font-size': '13px',
    'font-weight': '700',
  });
  expect.soft(await painted(chip, 'backgroundColor')).toEqual(rgb(AVATAR));
  expect.soft(await painted(chip, 'color')).toEqual(rgb(WHITE));
  expectBox(await box(chip), { x: 317.5, y: 340.7, width: 32, height: 32 }, 2, 'the chip of the second row');
  expect.soft(await styles(tom.nth(0).locator('> span'), ['column-gap'])).toEqual({ 'column-gap': '12px' });
  const name = tom.nth(0).getByText('Tom', { exact: true });
  expect.soft(await styles(name, ['font-weight', 'font-size'])).toEqual({ 'font-weight': '600', 'font-size': '14px' });
  expect.soft(await painted(name, 'color')).toEqual(rgb(INK));
  expectBox(await box(name), { x: 361.5, y: 337.1, height: 20.3 }, 2, 'the name of the second row');
  const address = tom.nth(0).getByText('tom@acme.dev', { exact: true });
  expect.soft(await styles(address, ['font-size', 'line-height'])).toEqual({
    'font-size': '13px',
    'line-height': '18.85px',
  });
  expect.soft(await painted(address, 'color')).toEqual(rgb(MUTED));

  // The role is a word, and the sites are every site: the site of a guest is named (FRU-250).
  await expect(cells(page, 'Ana (you)')).toHaveText(['AAna (you)ana@acme.dev', 'Owner', 'Every site', '2 Jun 2026']);
  await expect(tom.nth(1)).toHaveText('Admin');
  await expect(tom.nth(2)).toHaveText('Every site');
  await expect(tom.nth(3)).toHaveText('14 Jul 2026Remove');
  await expect(cells(page, 'Nora').nth(1)).toHaveText('Member');
  await expect(cells(page, 'Inès Morel').nth(1)).toHaveText('Guest');
  await expect(cells(page, 'Inès Morel').nth(2)).toHaveText('https://staging.acme.dev');
  expect.soft(await painted(tom.nth(1), 'color')).toEqual(rgb(INK));
  // Nobody removes themselves here.
  await expect(row(page, 'Ana (you)').getByRole('button')).toHaveCount(0);

  // An invitation: the chip of nobody yet, the address where a name is, and its day.
  const paul = cells(page, 'paul@client.fr');
  await expect(paul).toHaveText(['Ppaul@client.frInvitation sent', 'Member', 'Every site', /^Sent 3 OctUntil 10 Oct/]);
  const waiting = paul.nth(0).locator('.kit-avatar');
  expect.soft(await painted(waiting, 'backgroundColor')).toEqual(rgb(WHITE));
  expect.soft(await painted(waiting, 'color')).toEqual(rgb(MUTED));
  expect.soft(await painted(waiting, 'borderTopColor')).toEqual(rgb(LINE));
  expect.soft(await styles(paul.nth(3).locator('> span'), ['column-gap'])).toEqual({ 'column-gap': '16px' });
  const resend = paul.nth(3).getByRole('button', { name: 'Resend', exact: true });
  const cancel = paul.nth(3).getByRole('button', { name: 'Cancel', exact: true });
  expect.soft(await styles(resend, ['font-size', 'font-weight', 'text-decoration-line', 'padding-top'])).toEqual({
    'font-size': '14px',
    'font-weight': '600',
    'text-decoration-line': 'underline',
    'padding-top': '8px',
  });
  expect.soft(await painted(resend, 'color')).toEqual(rgb(INK));
  // The link of the kit is 33 px high where the mockup has 36.3: its line is `normal`, not 1.45.
  expectBox(await box(resend), { x: 1258.5, y: 531, width: 50.2 }, 2, '« Resend »');
  expectBox(await box(cancel), { x: 1324.7, y: 531, width: 46.3 }, 2, '« Cancel »');
  await resend.hover();
  expect.soft(await painted(resend, 'color')).toEqual(rgb(ACCENT_STRONG));
  await page.mouse.move(700, 800);

  // No legend of the roles under the table (FRU-437).
  await expect(page.locator('main dl')).toHaveCount(0);

  await expectNoViolation(page, 'the list');
});

test('the invitation is one line: a form with a name, and each field under its label', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);

  await expect(form(page)).toBeVisible();
  expect
    .soft(await styles(form(page), ['display', 'flex-wrap', 'column-gap', 'row-gap', 'align-items', 'margin-bottom']))
    .toEqual({
      display: 'flex',
      'flex-wrap': 'wrap',
      'column-gap': '10px',
      'row-gap': '10px',
      'align-items': 'flex-end',
      'margin-bottom': '24px',
    });
  const basis = (locator: Locator) =>
    locator.evaluate((element) => {
      const { flexGrow, flexShrink, flexBasis } = getComputedStyle(element.closest('form > div')!);

      return `${flexGrow} ${flexShrink} ${flexBasis}`;
    });
  expect.soft(await basis(email(page))).toBe('999 1 260px');
  expect.soft(await basis(roles(page))).toBe('1 1 200px');

  // Each field has its label on the screen, above it.
  for (const [word, control] of [
    ['Email', email(page)],
    ['Role', roles(page)],
  ] as const) {
    const label = form(page).locator('.label', { hasText: word }).first();
    await expect(label).toBeVisible();
    expect
      .soft(await styles(label, ['font-size', 'font-weight']))
      .toEqual({ 'font-size': '13px', 'font-weight': '600' });
    expect.soft(await painted(label, 'color')).toEqual(rgb(INK));
    expect.soft((await box(label)).y + (await box(label)).height, word).toBeLessThanOrEqual((await box(control)).y);
    expect
      .soft(await styles(control, ['height', 'border-top-left-radius', 'border-top-width', 'font-size']), word)
      .toEqual({ height: '44px', 'border-top-left-radius': '8px', 'border-top-width': '1px', 'font-size': '15px' });
    expect.soft(await painted(control, 'borderTopColor'), word).toEqual(rgb(CONTROL));
  }
  await expect(email(page)).toHaveAttribute('type', 'email');
  await expect(email(page)).toHaveAttribute('placeholder', 'name@company.com');
  expect.soft(await styles(email(page), ['padding-left'])).toEqual({ 'padding-left': '14px' });
  expect
    .soft(
      await styles(invite(page), ['height', 'padding-left', 'padding-right', 'border-top-left-radius', 'font-size']),
    )
    .toEqual({
      height: '44px',
      'padding-left': '24px',
      'padding-right': '24px',
      'border-top-left-radius': '999px',
      'font-size': '14px',
    });
  expect.soft(await painted(invite(page), 'backgroundColor')).toEqual(rgb(ACCENT));

  // The mockup has a third list, « Site », where the role is here: the field takes its room.
  expectBox(await box(form(page)), { x: 296.5, y: 126.2, width: 1095.5, height: 66 }, 2, 'the form');
  expectBox(await box(email(page)), { x: 296.5, y: 148.2, height: 44 }, 2, 'the field');
  expectBox(await box(roles(page)), { x: 1096.7, y: 148.2, width: 200.3, height: 44 }, 2, 'the list of roles');
  expectBox(await box(invite(page)), { x: 1307.3, y: 148.2, width: 85.2, height: 44 }, 2, '« Invite »');

  // The roles in the order of the mockup; the list « Site » is for a guest only.
  await expect(form(page).getByText('Site', { exact: true })).toHaveCount(0);
  await roles(page).click();
  await expect(page.getByRole('option')).toHaveText(['Guest, one site', 'Member', 'Admin']);
  await page.waitForTimeout(250);
  const opened = await new AxeBuilder({ page }).analyze();
  expect
    .soft(opened.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);
  await page.getByRole('option', { name: 'Admin' }).click();
  await expect(form(page).getByText('Site', { exact: true })).toHaveCount(0);

  // Nothing to send with no address; then the address and the role go as they are.
  await expect(invite(page)).toBeDisabled();
  await email(page).fill('  zoe@client.fr ');
  await invite(page).click();
  await expect
    .poll(() => worker.sent)
    .toEqual([{ call: 'invite-member', body: { organizationId: 'w1', email: 'zoe@client.fr', role: 'admin' } }]);
  await expect(email(page)).toHaveValue('');
  await expect(cells(page, 'zoe@client.fr')).toHaveText([
    'Zzoe@client.frInvitation sent',
    'Admin',
    'Every site',
    /^Sent 13 OctUntil 20 Oct/,
  ]);
});

const sitesList = (page: Page) => form(page).getByRole('button', { name: /Site$/ });

test('a guest of one site: the list « Site » where the mockup draws it, and the site goes with the invitation (FRU-250)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await stubSites(page, [
    { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' },
    { id: 's2', origin: 'https://acme.dev', visibility: 'everyone' },
  ]);
  await open(page);
  await roles(page).click();
  await page.getByRole('option', { name: 'Guest, one site' }).click();

  // The state of the mockup at 1440 px: Email, Role, Site, « Invite » on one line.
  await expect(sitesList(page)).toBeVisible();
  await expect(sitesList(page)).toContainText('staging.acme.dev');
  expectBox(await box(email(page)), { x: 297, y: 148, width: 580.1, height: 44 }, 2, 'the field');
  expectBox(await box(roles(page)), { x: 886.6, y: 148, width: 200.3, height: 44 }, 2, 'the list of roles');
  expectBox(await box(sitesList(page)), { x: 1097, y: 148, width: 200.3, height: 44 }, 2, 'the list of sites');
  expectBox(await box(invite(page)), { x: 1307.3, y: 148.2, width: 85.2, height: 44 }, 2, '« Invite »');
  const label = form(page).locator('.label', { hasText: 'Site' }).first();
  expect.soft(await styles(label, ['font-size', 'font-weight'])).toEqual({ 'font-size': '13px', 'font-weight': '600' });
  await expectNoViolation(page, 'the form of a guest');

  await sitesList(page).click();
  await expect(page.getByRole('option')).toHaveText(['https://staging.acme.dev', 'https://acme.dev']);
  await page.getByRole('option', { name: 'https://acme.dev', exact: true }).click();
  await email(page).fill('zoe@client.fr');
  await invite(page).click();
  await expect
    .poll(() => worker.sent)
    .toEqual([
      {
        call: 'invite-member',
        body: { organizationId: 'w1', email: 'zoe@client.fr', role: 'guest', sites: ['s2'] },
      },
    ]);
});

test('a workspace with no site offers no guest, and a site the worker refuses is said (FRU-250)', async ({ page }) => {
  await workerWith(page);
  await stubSites(page, []);
  await open(page);
  await roles(page).click();
  await expect(page.getByRole('option')).toHaveText(['Member', 'Admin']);
  await page.keyboard.press('Escape');

  await page.unrouteAll();
  const worker = await workerWith(page);
  worker.refuses = { status: 400, error: 'invalid-request', field: 'sites' };
  await open(page);
  await roles(page).click();
  await page.getByRole('option', { name: 'Guest, one site' }).click();
  await email(page).fill('zoe@client.fr');
  await invite(page).click();
  await expect(page.getByRole('alert')).toHaveText('This site is no longer one of the workspace. Choose another one.');
  await expect(email(page)).toHaveValue('zoe@client.fr');
});

test('an invitation that was kept gives its link, whatever became of its message', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const notice = page.getByRole('status');

  // The message went.
  await email(page).fill('zoe@client.fr');
  await invite(page).click();
  await expect(notice).toContainText('Invitation sent to zoe@client.fr. You can also send them this link:');
  await expect(notice).toContainText(`${CONSOLE}/invitations`);
  await expect(notice.getByRole('button', { name: 'Copy the link' })).toBeVisible();
  // The block is between the form and the table, on the tint of a block of the mockup.
  expect((await box(notice)).y).toBeGreaterThanOrEqual((await box(form(page))).y + (await box(form(page))).height);
  expect((await box(notice)).y + (await box(notice)).height).toBeLessThanOrEqual((await box(table(page))).y);
  expect.soft(await painted(notice, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await styles(notice, ['border-top-left-radius'])).toEqual({ 'border-top-left-radius': '14px' });
  for (const text of await notice.locator('p').all())
    expect.soft(contrast(await painted(text, 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);
  await expectNoViolation(page, 'the block of an invitation that was kept');

  // The worker sends mail, and sent none for this one (FRU-209).
  worker.held = true;
  await row(page, 'zoe@client.fr').getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(notice).toContainText('Invitation kept for zoe@client.fr, but no message was sent');
  await expect(notice).toContainText(`${CONSOLE}/invitations`);
  expect(worker.sent.at(-1)).toEqual({
    call: 'invite-member',
    body: { organizationId: 'w1', email: 'zoe@client.fr', role: 'member', resend: true },
  });
  // A message did leave before this one: the row still says so.
  await expect(cells(page, 'zoe@client.fr').nth(0)).toContainText('Invitation sent');

  // An invitation whose first message did not leave says « kept » on its row, until one leaves.
  await email(page).fill('lou@client.fr');
  await invite(page).click();
  await expect(notice).toContainText('Invitation kept for lou@client.fr, but no message was sent');
  await expect(cells(page, 'lou@client.fr')).toHaveText([
    'Llou@client.frInvitation kept',
    'Member',
    'Every site',
    /^13 OctUntil 20 Oct/,
  ]);
  await row(page, 'lou@client.fr').getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(notice).toContainText('Invitation kept for lou@client.fr, but no message was sent');
  await expect(cells(page, 'lou@client.fr').nth(0)).toContainText('Invitation kept');
  worker.held = false;
  await row(page, 'lou@client.fr').getByRole('button', { name: 'Resend', exact: true }).click();
  await expect(notice).toContainText('Invitation sent to lou@client.fr.');
  await expect(cells(page, 'lou@client.fr')).toHaveText([
    'Llou@client.frInvitation sent',
    'Member',
    'Every site',
    /^Sent 13 OctUntil 20 Oct/,
  ]);

  // A worker with no mailer sent nothing, and the row does not say « sent ».
  await page.unrouteAll();
  const silent = await workerWith(page);
  silent.mails = false;
  await open(page);
  await expect(cells(page, 'paul@client.fr')).toHaveText([
    'Ppaul@client.frInvitation kept',
    'Member',
    'Every site',
    /^3 OctUntil 10 Oct/,
  ]);
  await email(page).fill('zoe@client.fr');
  await invite(page).click();
  await expect(notice).toContainText('Invitation kept for zoe@client.fr. Send them this link:');
});

test('after a reload, an invitation whose message did not leave reads « kept », with its link to copy (FRU-269)', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CONSOLE });
  await workerWith(page, {
    invitations: [
      { ...PAUL, mailed: false },
      { ...PAUL, id: 'i2', email: 'zoe@client.fr', mailed: true },
    ],
  });
  await open(page);

  await expect(cells(page, 'paul@client.fr').nth(0)).toContainText('Invitation kept');
  await expect(cells(page, 'zoe@client.fr').nth(0)).toContainText('Invitation sent');
  // The control: a message that left gives no link on its row.
  await expect(row(page, 'zoe@client.fr').getByRole('button', { name: 'Copy the link' })).toHaveCount(0);
  const copy = row(page, 'paul@client.fr').getByRole('button', { name: 'Copy the link', exact: true });
  await copy.click();
  await expect(row(page, 'paul@client.fr').getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${CONSOLE}/invitations`);
  await expectNoViolation(page, 'a kept invitation after a reload');
});

test('an invitation that is refused says its cause, and clears nothing that was typed', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const refusals: [number, string, string][] = [
    [400, 'invalid-request', 'Type the full address of the person, like name@company.com.'],
    [400, 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION', 'This person is already a member of the workspace.'],
    [
      400,
      'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION',
      'This address is invited already. Send the invitation again from its row.',
    ],
    [403, 'forbidden', 'Only an owner or an admin of the workspace invites.'],
    [500, 'unknown', 'Fruitback did not answer. Try again.'],
    [418, 'something-new', 'The invitation was not sent. Try again.'],
  ];
  await roles(page).click();
  await page.getByRole('option', { name: 'Admin' }).click();
  await email(page).fill('tom@acme');
  for (const [status, error, sentence] of refusals) {
    worker.refuses = { status, error };
    await invite(page).click();
    await expect(page.getByRole('alert'), error).toHaveText(sentence);
    await expect(email(page), error).toHaveValue('tom@acme');
    await expect(roles(page), error).toContainText('Admin');
  }
  await expect(page.getByRole('status')).toHaveCount(0);
  await expectNoViolation(page, 'an invitation that is refused');

  // While the worker has not answered, the button says so and sends nothing twice.
  worker.refuses = undefined;
  worker.slow = true;
  const before = worker.sent.length;
  await invite(page).click();
  const sending = form(page).getByRole('button', { name: 'Sending…' });
  await expect(sending).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(email(page)).toHaveValue('tom@acme');
  // The request reaches the worker after the button changed: it is waited for, not read at once.
  await expect.poll(() => worker.sent.length).toBe(before + 1);
  // A second press on the busy button sends nothing more, even once its request had time to arrive.
  await sending.click({ force: true });
  await page.waitForTimeout(400);
  expect(worker.sent.length).toBe(before + 1);
});

test('cancelling an invitation and removing a member ask twice, with the keyboard too', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);

  // « Cancel »: what it costs, « Keep it » with focus, and the button that names the address.
  const cancel = row(page, 'paul@client.fr').getByRole('button', { name: 'Cancel', exact: true });
  await cancel.click();
  const cancelling = page.getByRole('group', { name: 'Cancel the invitation of paul@client.fr' });
  await expect(cancelling.getByText('The message already sent no longer lets paul@client.fr join.')).toBeVisible();
  await expect(cancelling.getByRole('button', { name: 'Keep it' })).toBeFocused();
  expect(worker.sent).toEqual([]);
  await expectNoViolation(page, 'the second time of a gesture');
  // « Keep it » gives the row back, with focus on the button that asked.
  await cancelling.getByRole('button', { name: 'Keep it' }).click();
  await expect(cancelling).toHaveCount(0);
  await expect(cancel).toBeFocused();
  // Escape does the same, from the keyboard alone.
  await page.keyboard.press('Enter');
  await expect(cancelling.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cancelling).toHaveCount(0);
  await expect(cancel).toBeFocused();
  expect(worker.sent).toEqual([]);

  // « Remove »: the worker refuses, the member stays, and the row says why.
  const remove = row(page, 'Tom').getByRole('button', { name: 'Remove', exact: true });
  await remove.click();
  const removing = page.getByRole('group', { name: 'Remove Tom' });
  await expect(
    removing.getByText('Tom leaves the workspace, and their extension stops reading its sites. Their notes stay.'),
  ).toBeVisible();
  await expect(removing.getByRole('button', { name: 'Keep it' })).toBeFocused();
  // What is asked is under the row of the person, and above the next one.
  expect((await box(removing)).y).toBeGreaterThanOrEqual((await box(row(page, 'Tom'))).y + 64);
  expect((await box(removing)).y).toBeLessThan((await box(row(page, 'Nora'))).y);
  worker.refuses = { status: 403, error: 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER' };
  await removing.getByRole('button', { name: 'Remove Tom' }).click();
  await expect(page.getByRole('alert')).toHaveText('Only an owner removes an owner.');
  await expect(row(page, 'Tom')).toBeVisible();
  await expectNoViolation(page, 'a removal that was refused');

  worker.refuses = undefined;
  await removing.getByRole('button', { name: 'Remove Tom' }).click();
  await expect(page.getByText('tom@acme.dev', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await cancel.click();
  await cancelling.getByRole('button', { name: 'Cancel the invitation of paul@client.fr' }).click();
  await expect(page.getByText('paul@client.fr', { exact: true })).toHaveCount(0);
  expect(worker.sent).toEqual([
    { call: 'remove-member', body: { organizationId: 'w1', memberIdOrEmail: 'm2' } },
    { call: 'remove-member', body: { organizationId: 'w1', memberIdOrEmail: 'm2' } },
    { call: 'cancel-invitation', body: { organizationId: 'w1', invitationId: 'i1' } },
  ]);
});

test('Tab goes from the form to each action of the table, and each stop shows its ring', async ({ page }) => {
  await workerWith(page);
  await open(page);
  await email(page).fill('zoe@client.fr');
  await email(page).focus();

  const stops: [string, Locator][] = [
    ['the list of roles', roles(page)],
    ['« Invite »', invite(page)],
    // The frame takes focus, so a keyboard scrolls a table wider than its screen.
    ['the frame of the table', table(page)],
    ['« Remove » of the second row', row(page, 'Tom').getByRole('button', { name: 'Remove', exact: true })],
    ['« Remove » of the third row', row(page, 'Nora').getByRole('button', { name: 'Remove', exact: true })],
    ['« Remove » of the fourth row', row(page, 'Inès Morel').getByRole('button', { name: 'Remove', exact: true })],
    ['« Resend »', row(page, 'paul@client.fr').getByRole('button', { name: 'Resend', exact: true })],
    ['« Cancel »', row(page, 'paul@client.fr').getByRole('button', { name: 'Cancel', exact: true })],
  ];
  for (const [name, stop] of stops) {
    await page.keyboard.press('Tab');
    await expect(stop, name).toBeFocused();
    expect
      .soft(await styles(stop, ['outline-style', 'outline-width', 'outline-offset']), name)
      .toEqual({ 'outline-style': 'solid', 'outline-width': '2px', 'outline-offset': '2px' });
    expect.soft(await painted(stop, 'outlineColor'), name).toEqual(rgb(ACCENT));
  }
});

test('an admin invites; a member reads; a guest sees their own row and nothing of the others', async ({ page }) => {
  await workerWith(page, { role: 'admin' });
  await open(page);
  await expect(form(page)).toBeVisible();
  await expect(row(page, 'Tom').getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await expect(row(page, 'paul@client.fr')).toBeVisible();

  // A member reads who is there: no form, no gesture, and no invitation is asked for.
  await page.unrouteAll();
  const read = await workerWith(page, { role: 'member', members: [ANA, TOM, NORA] });
  await open(page);
  await expect(row(page, 'Tom')).toBeVisible();
  await expect(table(page).locator('thead th')).toHaveText(['Person', 'Role', 'Sites', 'Joined']);
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.locator('main').getByRole('button')).toHaveCount(0);
  await expect(page.getByText('paul@client.fr')).toHaveCount(0);
  // The development build runs an effect twice: what matters is which lists are asked for.
  expect([...new Set(read.read)]).toEqual(['list-members']);
  await expectNoViolation(page, 'the screen of a member');

  // A guest: the worker refuses them the list, so the screen asks for none and draws their row.
  await page.unrouteAll();
  const refused = await workerWith(page, { role: 'guest' });
  await open(page);
  await expect(table(page).locator('thead th')).toHaveText(['Person', 'Role', 'Sites']);
  await expect(table(page).locator('tbody tr')).toHaveCount(1);
  // Their site is the one the worker lists to them (FRU-250).
  await expect(table(page).locator('tbody td')).toHaveText([
    'AAna (you)ana@acme.dev',
    'Guest',
    'https://staging.acme.dev',
  ]);
  await expect(page.getByRole('form')).toHaveCount(0);
  expect(refused.read).toEqual([]);
  await expectNoViolation(page, 'the screen of a guest');
});

test('a read that failed says so with « Try again », and is never a table with nobody (FRU-162)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.members = 'fails';
  await open(page);

  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Fruitback did not answer. Try again.');
  const frame = page.locator('main > div').filter({ has: alert });
  expect
    .soft(await styles(frame, ['padding-top', 'padding-left', 'border-top-left-radius', 'border-top-width']))
    .toEqual({
      'padding-top': '28px',
      'padding-left': '32px',
      'border-top-left-radius': '14px',
      'border-top-width': '1px',
    });
  expect.soft(await painted(frame, 'borderTopColor')).toEqual(rgb(CONTROL));
  expect.soft(contrast(await painted(alert, 'color'), rgb(WHITE))).toBeGreaterThanOrEqual(4.5);
  await expect(table(page)).toHaveCount(0);
  // What was typed before the failure stays, and the form is still there.
  await email(page).fill('zoe@client.fr');
  await expectNoViolation(page, 'a read that failed');

  worker.members = 'list';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row(page, 'Tom')).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(email(page)).toHaveValue('zoe@client.fr');
});

test('a day that the worker did not give, or that is no date, is not drawn', async ({ page }) => {
  const { createdAt: _none, ...undated } = PAUL;
  await workerWith(page, {
    members: [ANA, { ...TOM, createdAt: 'yesterday' }],
    invitations: [{ ...undated, expiresAt: 'soon' }],
  });
  await open(page);
  // The cell is there with its gestures, and reads no « Invalid Date ».
  await expect(cells(page, 'Tom').nth(3)).toHaveText('Remove');
  await expect(cells(page, 'paul@client.fr').nth(3)).toHaveText('ResendCancel');
  await expect(page.getByText('Invalid Date')).toHaveCount(0);
  // The control: a day that is one is drawn.
  await expect(cells(page, 'Ana (you)').nth(3)).toHaveText('2 Jun 2026');
});

test('a read made again keeps the rows on the screen, and a press on one of them is heard', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await expect(row(page, 'paul@client.fr')).toBeVisible();
  const shown = await table(page).locator('tbody tr').count();
  const before = { table: await box(table(page)) };

  // A message that did not leave makes the screen read its lists again; the worker is slow to answer.
  const reads = () => worker.read.filter((each) => each === 'list-members').length;
  const read = reads();
  worker.members = 'waits';
  worker.refuses = { status: 503, error: 'mail-unavailable' };
  await email(page).fill('zoe@client.fr');
  await invite(page).click();
  await expect.poll(reads).toBe(read + 1);
  // The alert of the refusal took its room above the table, once: from here nothing moves.
  await expect(page.getByRole('alert')).toBeVisible();
  const during = { table: await box(table(page)) };

  // The rows stay while the lists are read again: no « Loading… » in their place.
  await expect(page.locator('main').getByText('Loading…')).toHaveCount(0);
  await expect(table(page).locator('tbody tr')).toHaveCount(shown);
  expect(during.table.height).toBe(before.table.height);
  // An action of a row is still there to press.
  await row(page, 'paul@client.fr').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Cancel the invitation of paul@client.fr' })).toBeVisible();
});

test('while the members are read, the screen says so and draws no table', async ({ page }) => {
  const worker = await workerWith(page);
  worker.members = 'waits';
  await open(page);
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(form(page)).toBeVisible();
});

for (const width of [390, 320]) {
  for (const locale of ['en', 'fr'] as const) {
    test(`at ${width} px the table scrolls in its frame and the page does not, in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const worker = await workerWith(page, { locale });
      await open(page);
      const words =
        locale === 'en'
          ? { remove: 'Remove', keep: 'Keep it', invite: 'Invite', email: 'Email', again: 'Try again' }
          : { remove: 'Retirer', keep: 'Le garder', invite: 'Inviter', email: 'E-mail', again: 'Réessayer' };
      expect.soft(await sideScroll(page), 'the list').toBe(0);
      // The table keeps its 760 px, in a frame as wide as the screen allows.
      const frame = await box(table(page));
      expect.soft(frame.x + frame.width, 'the frame').toBeLessThanOrEqual(width);
      expect
        .soft(await table(page).evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeGreaterThan(0);
      if (locale === 'fr') {
        await expect(table(page).locator('thead th')).toHaveText(['Personne', 'Rôle', 'Sites', 'Arrivée']);
        await expect(cells(page, 'paul@client.fr').nth(0)).toContainText('Invitation envoyée');
        await expect(cells(page, 'paul@client.fr').nth(3)).toContainText('Envoyée le 3 oct.');
      }

      // What a gesture costs is read without scrolling the table, whatever part of it is on screen.
      const remove = row(page, 'Tom').getByRole('button', { name: words.remove, exact: true });
      await remove.click();
      const asked = page.getByRole('group').filter({ has: page.getByRole('button', { name: words.keep }) });
      const sentence = asked.locator('p');
      await expect(sentence).toBeVisible();
      const read = await box(sentence);
      expect.soft(read.x, 'the sentence starts on the screen').toBeGreaterThanOrEqual(0);
      expect.soft(read.x + read.width, 'the sentence ends on the screen').toBeLessThanOrEqual(width);
      expect.soft(await sideScroll(page), 'the second time of a removal').toBe(0);
      await asked.getByRole('button', { name: words.keep }).click();

      // The block of an invitation, a refusal, and a read that failed.
      await page.getByRole('textbox', { name: words.email, exact: true }).fill('zoe@client.fr');
      await page.getByRole('button', { name: words.invite, exact: true }).click();
      await expect(page.getByRole('status')).toBeVisible();
      expect.soft(await sideScroll(page), 'the block of an invitation').toBe(0);
      worker.refuses = { status: 400, error: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION' };
      await page.getByRole('textbox', { name: words.email, exact: true }).fill('zoe@client.fr');
      await page.getByRole('button', { name: words.invite, exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      expect.soft(await sideScroll(page), 'a refusal').toBe(0);
      worker.members = 'fails';
      await open(page);
      await expect(page.getByRole('button', { name: words.again, exact: true })).toBeVisible();
      expect.soft(await sideScroll(page), 'a read that failed').toBe(0);
    });
  }
}

test('at 390 px the form stacks, and each part is where the mockup draws it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page);
  await open(page);
  // The render of the mockup at 390 px, from the top of the screen under the rail. The mockup has a
  // line more in its form, the list « Site » (76 px): what is under the form is compared 76 px higher.
  const top = (await box(page.locator('main'))).y;
  const less = 76;
  expectBox(await box(page.locator('main h1')), { x: 16, y: top + 40, width: 358, height: 32.2 }, 4, 'the title');
  expectBox(await box(email(page)), { x: 16, y: top + 172.2, width: 358, height: 44 }, 4, 'the field');
  // The last list and the button share a line, as « Site » and « Invite » do in the mockup.
  expectBox(await box(roles(page)), { x: 16, y: top + 324.2 - less, width: 262.8, height: 44 }, 4, 'the list of roles');
  expectBox(await box(invite(page)), { x: 288.8, y: top + 324.2 - less, width: 85.2, height: 44 }, 4, '« Invite »');
  expectBox(await box(table(page)), { x: 16, y: top + 392.2 - less, width: 358, height: 366.5 }, 4, 'the frame');
  expectBox(await box(table(page).locator('table')), { x: 17, width: 760 }, 4, 'the table');
  expectBox(await box(row(page, 'Tom')), { x: 17, y: top + 500.7 - less, height: 64.1 }, 4, 'the second row');
  expectBox(
    await box(row(page, 'Tom').locator('.kit-avatar')),
    { x: 37, y: top + 516.7 - less, width: 32, height: 32 },
    4,
    'the chip of the second row',
  );
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page, 'the list at 390 px');
});

test('every text of the screen is at 4.5:1 on what is behind it', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const tom = cells(page, 'Tom');
  const paul = cells(page, 'paul@client.fr');
  const onWhite: [string, Locator][] = [
    ['the sentence under the title', page.getByText('Who sees and leaves notes, and who changes the workspace.')],
    ['a label of the form', form(page).locator('.label').first()],
    ['a column header', table(page).locator('thead th').first()],
    ['a name', tom.nth(0).getByText('Tom', { exact: true })],
    ['an address', tom.nth(0).getByText('tom@acme.dev', { exact: true })],
    ['a role', tom.nth(1)],
    ['the sites', tom.nth(2)],
    ['the day somebody joined', tom.nth(3)],
    ['« Remove »', tom.nth(3).getByRole('button')],
    ['« Invitation sent »', paul.nth(0).getByText('Invitation sent', { exact: true })],
    ['the day an invitation ends', paul.nth(3).getByText('Until 10 Oct', { exact: true })],
    ['the initial of somebody invited', paul.nth(0).locator('.kit-avatar')],
  ];
  for (const [name, text] of onWhite) {
    expect.soft(contrast(await painted(text, 'color'), rgb(WHITE)), name).toBeGreaterThanOrEqual(4.5);
  }
  // The placeholder of the field, as the browser paints it.
  const placeholder = await email(page).evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    context.fillStyle = getComputedStyle(element, '::placeholder').color;
    context.fillRect(0, 0, 1, 1);

    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  });
  expect.soft(contrast(placeholder, rgb(WHITE)), 'the placeholder').toBeGreaterThanOrEqual(4.5);
  // White on the chip of a person, and on the button of the form once it can act.
  const chip = tom.nth(0).locator('.kit-avatar');
  expect
    .soft(contrast(await painted(chip, 'color'), await painted(chip, 'backgroundColor')), 'an initial')
    .toBeGreaterThanOrEqual(4.5);
  await email(page).fill('zoe@client.fr');
  expect
    .soft(contrast(await painted(invite(page), 'color'), await painted(invite(page), 'backgroundColor')), '« Invite »')
    .toBeGreaterThanOrEqual(4.5);
  // What a gesture costs is on the tint of what is under a row.
  await tom.nth(3).getByRole('button').click();
  const asked = page.getByRole('group', { name: 'Remove Tom' });
  expect.soft(await painted(asked.locator('xpath=ancestor::tr'), 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect
    .soft(contrast(await painted(asked.locator('p'), 'color'), rgb(SUBTLE)), 'what a gesture costs')
    .toBeGreaterThanOrEqual(4.5);
});

/** Noon of UTC: « Today » is the day of UTC the worker writes. */
const NOON_UTC = new Date('2026-10-13T12:00:00.000Z');
const SEEN = { a1: '2026-10-13', a2: '2026-10-12', a3: '2026-10-10' };

test('an owner reads « Last seen »: a day, never an hour, and « Not seen yet »', async ({ page }) => {
  await page.clock.setFixedTime(NOON_UTC);
  const worker = await workerWith(page, { seen: SEEN });
  await open(page);
  const table = page.getByRole('region', { name: 'Members' });
  await expect(table.locator('thead th')).toHaveText(['Person', 'Role', 'Sites', 'Last seen']);
  const last = (name: string) => table.locator('tbody tr').filter({ hasText: name }).first().locator('td').last();
  await expect(last('ana@acme.dev')).toContainText('Today');
  await expect(last('tom@acme.dev')).toContainText('Yesterday');
  await expect(last('nora@acme.dev')).toContainText('3 days ago');
  // Nobody saw this one since « Last seen » came: the screen says so, and not a date.
  await expect(last('ines@client.fr')).toContainText('Not seen yet');
  // An invitation still says when it was sent.
  await expect(last('paul@client.fr')).toContainText('Sent 3 Oct');
  expect(worker.read).toContain('seen');
});

test('the table does not wait for « Last seen », and nothing of a row moves when the days arrive', async ({ page }) => {
  await page.clock.setFixedTime(NOON_UTC);
  const worker = await workerWith(page, { seen: 'waits', released: SEEN });
  await open(page);
  const table = page.getByRole('region', { name: 'Members' });
  // The members are there while the days are on their way.
  await expect(table.locator('tbody tr')).toHaveCount(5);
  await expect(table.locator('thead th').last()).toHaveText('Last seen');
  const remove = table.locator('tbody tr').filter({ hasText: 'nora@acme.dev' }).getByRole('button', { name: 'Remove' });
  const cancel = table
    .locator('tbody tr')
    .filter({ hasText: 'paul@client.fr' })
    .getByRole('button', { name: 'Cancel' });
  const before = [await box(remove), await box(cancel)];

  worker.release();
  await expect(table.locator('tbody tr').filter({ hasText: 'nora@acme.dev' })).toContainText('3 days ago');
  await expect(table.locator('tbody tr').filter({ hasText: 'ines@client.fr' })).toContainText('Not seen yet');
  expect([await box(remove), await box(cancel)]).toEqual(before);
});

test('a member reads the day somebody joined, and does not ask « Last seen »', async ({ page }) => {
  const worker = await workerWith(page, { role: 'member', seen: SEEN });
  await open(page);
  const table = page.getByRole('region', { name: 'Members' });
  await expect(table.locator('thead th')).toHaveText(['Person', 'Role', 'Sites', 'Joined']);
  await expect(page.getByText('Today')).toHaveCount(0);
  expect(worker.read).not.toContain('seen');
});

test('a « Last seen » the worker refuses leaves the day somebody joined', async ({ page }) => {
  await workerWith(page, { seen: 'refused' });
  await open(page);
  const table = page.getByRole('region', { name: 'Members' });
  await expect(table.locator('thead th')).toHaveText(['Person', 'Role', 'Sites', 'Joined']);
});

test('the days of a read made before, late, do not replace those of the read made after', async ({ page }) => {
  await page.clock.setFixedTime(NOON_UTC);
  // The first days are held; the members are read again (an invitation whose message did not
  // leave), and the second days come at once: Nora was seen two days ago.
  const worker = await workerWith(page, { seen: 'waits', released: SEEN, later: { a3: '2026-10-11' } });
  await open(page);
  worker.refuses = { status: 503, error: 'mail-unavailable' };
  await page.getByRole('textbox', { name: 'Email' }).fill('zoe@client.fr');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  const nora = page.getByRole('region', { name: 'Members' }).locator('tbody tr').filter({ hasText: 'nora@acme.dev' });
  await expect(nora).toContainText('2 days ago');

  // The first answer lands now: it is of a read that is no longer the last one.
  worker.release();
  await page.waitForTimeout(300);
  await expect(nora).toContainText('2 days ago');
  await expect(nora).not.toContainText('3 days ago');
});

test('the words of « Email » and « Role » sit on one baseline, in the type of the mockup (FRU-412)', async ({
  page,
}) => {
  await workerWith(page);
  await page.setViewportSize({ width: 1528, height: 840 });
  await open(page);
  // The mockup writes both controls at 15 px. HeroUI wrote the chosen role at 14 px on a line of
  // 20 px, so its words sat higher and smaller than those of the field beside it.
  const type = (locator: Locator) =>
    locator.evaluate((element) => {
      const { fontSize, lineHeight } = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return { fontSize, lineHeight, middle: Math.round((box.top + box.height / 2) * 10) / 10 };
    });
  const field = await type(email(page));
  const chosen = await type(roles(page).locator('.select__value'));
  expect(chosen).toEqual(field);
  expect(field.fontSize).toBe('15px');
  // The value takes the size of its button, so a compact list keeps its own.
  const button = await roles(page).evaluate((element) => getComputedStyle(element).fontSize);
  expect(chosen.fontSize).toBe(button);
});

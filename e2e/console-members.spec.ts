import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from '@playwright/test';
import {
  ACME,
  NO_PASSWORD_MANAGER,
  type Role,
  box,
  contrast,
  expectBox,
  fillMarks,
  fulfillSites,
  painted,
  rgb,
  sideScroll,
  stubWorker,
  styles,
} from './console-workspace.ts';

/**
 * The Members screen, measured in a browser against the mockup « Membres » of the redesign (FRU-691,
 * `maquette-membres.html` attached to the ticket): a head of 48 px with « Invite », the tabs
 * « Members » and « Invitations » with their counts and the search, one dense table a tab with rows of
 * 36 px, and the dialog « Invite people » of 480 px. Before, screen 12 of the mockup of 2026-10-13
 * (FRU-247): two tables under their headings, and a dialog « Invite someone » of one address.
 *
 * The values are read in the code of the mockup, and the boxes in its render at 1440 px (a box is
 * compared where the font is the one of the mockup). « Last active » is read from `…/members/seen`
 * (FRU-249), for an owner or an admin. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const INK = '#0f172a';
const INK_SOFT = '#334155';
const MUTED = '#5b6779';
const LINE = '#e3e8ef';
const SUBTLE = '#f7f9fb';
const AVATAR = '#334155';
const ACCENT = '#dd2c27';
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
  /** How long a change waits before its answer, in milliseconds. */
  lag?: number;
  /** What the worker answers to a change it refuses. */
  refuses?: { status: number; error: string; field?: string };
  /** The addresses whose invitation the worker refuses, with what it answers. */
  refusesFor?: Record<string, { status: number; error: string }>;
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

const CHANGES = ['invite-member', 'cancel-invitation', 'remove-member', 'update-member-role'];

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
  // Copies: a change of role writes on them, and the next test reads the people as they were.
  const members = (world.members ?? MEMBERS).map((each) => ({ ...(each as object) })) as { id: string; role: string }[];
  const invitations = [...(world.invitations ?? [PAUL])] as (typeof PAUL)[];
  const answer = (pathname: string, route: Route): Promise<void> | undefined => {
    const request = route.request();
    const call = pathname.split('/').at(-1) ?? '';
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers')
      return json({ betterAuth: { email: worker.mails, github: false, google: false } });
    if (call === 'list-members') {
      worker.read.push(call);
      if (worker.members === 'waits') return new Promise<void>(() => {});
      if (worker.members === 'fails') return json({ error: 'unknown' }, 500);
      // As the worker: a search past 100 characters is refused (FRU-496).
      if ((new URL(request.url()).searchParams.get('q') ?? '').length > 100) {
        return json({ error: 'invalid-request', field: 'q' }, 400);
      }

      return json({ members, total: members.length });
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
    if (!CHANGES.includes(call)) return undefined;
    const body = request.postDataJSON() as Record<string, unknown>;
    // A request held open reaches the worker a while after the button says « Sending… »: on CI the
    // button said it before the stub saw the request (FRU-442: 6 sent where 7 were read).
    // The stub keeps that order on every machine, so a test reads what was sent by polling.
    if (worker.slow)
      return new Promise<void>(() => {
        setTimeout(() => worker.sent.push({ call, body }), 300);
      });
    worker.sent.push({ call, body });
    if (worker.lag !== undefined) {
      const lag = worker.lag;

      return new Promise<void>((resolve) => setTimeout(resolve, lag)).then(() => answered(call, body, json));
    }

    return answered(call, body, json);
  };
  /** The answer of the worker to a change it was sent. */
  const answered = (
    call: string,
    body: Record<string, unknown>,
    json: (body: unknown, status?: number) => Promise<void>,
  ): Promise<void> => {
    const refused = worker.refusesFor?.[String(body.email)] ?? worker.refuses;
    if (refused !== undefined) {
      const { status, ...rest } = refused;

      return json(rest, status);
    }
    // A member removed is no longer listed: the screen reads its page again (FRU-496).
    const removed = members.findIndex((each) => each.id === body.memberIdOrEmail);
    if (call === 'remove-member' && removed >= 0) members.splice(removed, 1);
    if (call === 'update-member-role') {
      const changed = members.find((each) => each.id === body.memberId);
      if (changed !== undefined) changed.role = String(body.role);

      return json({ ...changed, role: body.role });
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
  // The list, or the sites to choose from (FRU-497).
  await page.route(
    /\/console\/workspaces\/w1\/sites(\/choices)?(\?|$)/,
    (route) => fulfillSites(route, sites) || route.fallback(),
  );
}

async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/members`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** « Invite » in the head of the page: it opens the dialog « Invite people ». */
const opener = (page: Page) => page.locator('main header').getByRole('button', { name: 'Invite', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Invite people' });
const form = (page: Page) => page.getByRole('form', { name: 'Invite people' });
async function inviting(page: Page): Promise<void> {
  await opener(page).click();
  await expect(form(page)).toBeVisible();
  // The dialog slides and fades in: a box is read once it is still.
  await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished)));
}
const emails = (page: Page) => form(page).getByRole('textbox', { name: 'Emails', exact: true });
const card = (page: Page, role: 'Admin' | 'Member' | 'Guest') =>
  form(page).getByRole('radio', { name: new RegExp(`^${role}`) });
/** The card of a role: the box a person presses, around its radio. */
const cardBox = (page: Page, role: 'Admin' | 'Member' | 'Guest') =>
  form(page)
    .locator('.kit-radio-card')
    .filter({ has: page.getByText(role, { exact: true }) });
/** « Send N invites »: its name counts the addresses. */
const send = (page: Page) => form(page).getByRole('button', { name: /^(Send|Sending)/ });
const tab = (page: Page, name: 'Members' | 'Invitations') =>
  page.getByRole('group', { name: 'Members and invitations' }).getByRole('button', { name: new RegExp(`^${name}`) });
const table = (page: Page) => page.getByRole('region', { name: 'Members', exact: true });
const invitationsTable = (page: Page) => page.getByRole('region', { name: 'Invitations', exact: true });
/** The row of a person, or of an invitation. */
const row = (page: Page, name: string) =>
  page
    .locator('main tbody tr')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const cells = (page: Page, name: string) => row(page, name).locator('td');
/** The menu « … » of a row, and one of its items. */
async function fromMenu(page: Page, name: string, item: string): Promise<void> {
  await row(page, name)
    .getByRole('button', { name: `Actions for ${name}` })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
  // The menu fades out: what comes next is pressed once it is gone, as a hand does.
  await expect(page.getByRole('menu')).toHaveCount(0);
}
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search members' });

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

/** Axe on the dialog, which is not in `main`: React Aria draws it at the end of the body. */
async function expectNoDialogViolation(page: Page, name: string): Promise<void> {
  // A colour read while a list closes is the colour of its fade.
  await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished)));
  const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the head, the tabs and the table are the ones of the mockup, a line of 36 px a person', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-13T12:00:00.000Z'));
  await workerWith(page, { seen: { a1: '2026-10-13' } });
  await open(page);

  // The head: « Members » at 14 px and 600, « Invite » at its right, 48 px from one edge to the other.
  const head = page.locator('main header');
  await expect(page.locator('main h1')).toHaveText('Members');
  expect.soft(await styles(page.locator('main h1'), ['font-size', 'font-weight'])).toEqual({
    'font-size': '14px',
    'font-weight': '600',
  });
  expectBox(await box(head), { x: 232, y: 0, width: 1208, height: 48 }, 1.5, 'the head');
  expectBox(await box(page.locator('main h1')), { x: 252 }, 1, 'the title');
  expectBox(await box(opener(page)), { y: 10, height: 28 }, 1, '« Invite »');
  expect
    .soft(Math.abs((await box(opener(page))).x + (await box(opener(page))).width - 1424), '16 px from the edge')
    .toBeLessThan(1);
  expect.soft(await painted(opener(page), 'backgroundColor')).toEqual(rgb(ACCENT));
  // The sentence under the title of before is gone: the mockup draws none.
  await expect(page.getByText('Who sees and leaves notes, and who changes the workspace.')).toHaveCount(0);

  // The tabs: « Members 4 » chosen, in ink and underlined by 2 px; « Invitations 1 » muted.
  await expect(tab(page, 'Members')).toHaveAccessibleName('Members 4');
  await expect(tab(page, 'Invitations')).toHaveAccessibleName('Invitations 1');
  await expect(tab(page, 'Members')).toHaveAttribute('aria-pressed', 'true');
  await expect(tab(page, 'Invitations')).toHaveAttribute('aria-pressed', 'false');
  expectBox(await box(tab(page, 'Members')), { x: 252, y: 48, height: 44 }, 1.5, 'the tab « Members »');
  expect.soft(await styles(tab(page, 'Members'), ['font-size', 'font-weight', 'box-shadow'])).toEqual({
    'font-size': '13px',
    'font-weight': '500',
    'box-shadow': `${'rgb(15, 23, 42)'} 0px -2px 0px 0px inset`,
  });
  expect.soft(await painted(tab(page, 'Invitations'), 'color')).toEqual(rgb(MUTED));
  // The search, 240 px, at the right of the tabs, 16 px from the edge.
  const searched = await box(search(page));
  expect.soft(Math.abs(searched.x + searched.width - 1424), 'the search ends 16 px from the edge').toBeLessThan(2);
  expectBox(searched, { width: 240 }, 1, 'the search');
  await expect(search(page)).toHaveAttribute('placeholder', 'Search by name or address');

  // The columns of the mockup, each a column header; the last is the menu, named for a screen reader.
  const headers = table(page).locator('thead th');
  await expect(headers).toHaveText(['Name', 'Email', 'Role', 'Sites', 'Last active', 'Joined', 'Actions']);
  for (const header of await headers.all()) await expect(header).toHaveAttribute('scope', 'col');
  expect.soft(await styles(headers.nth(0), ['height', 'font-size', 'font-weight', 'padding-left'])).toEqual({
    height: '32px',
    'font-size': '12px',
    'font-weight': '500',
    'padding-left': '12px',
  });
  expect.soft(await painted(headers.nth(0), 'color')).toEqual(rgb(MUTED));
  expectBox(await box(table(page)), { x: 232, width: 1208 }, 1, 'the frame of the list');
  // The columns start where the mockup starts them, at 22, 22, 13, 17, 11, 11 and 4 % of its table.
  const starts = await headers.evaluateAll((all) => all.map((each) => Math.round(each.getBoundingClientRect().x)));
  expect.soft(starts[0]).toBe(240);
  expect.soft(starts[1]).toBe(502);
  expect.soft(starts[2]).toBe(764);

  // A row of 36 px, its border counted, and never a second line.
  for (const name of ['Ana', 'Tom', 'Nora', 'Inès Morel']) {
    expectBox(await box(row(page, name)), { height: 36 }, 0.5, `the row of ${name}`);
  }
  const tom = cells(page, 'Tom');
  expect.soft(await styles(tom.nth(1), ['white-space', 'text-overflow', 'overflow-x', 'padding-left'])).toEqual({
    'white-space': 'nowrap',
    'text-overflow': 'ellipsis',
    'overflow-x': 'hidden',
    'padding-left': '12px',
  });

  // A person: the round initial of 24 px, the name at 600, « (you) » muted, the address in the soft ink.
  const chip = tom.nth(0).locator('.kit-avatar');
  await expect(chip).toHaveText('T');
  await expect(chip).toHaveAttribute('aria-hidden', 'true');
  expect.soft(await styles(chip, ['width', 'height', 'font-size', 'font-weight'])).toEqual({
    width: '24px',
    height: '24px',
    'font-size': '11px',
    'font-weight': '600',
  });
  expect.soft(await painted(chip, 'backgroundColor')).toEqual(rgb(AVATAR));
  expectBox(await box(chip), { x: 252 }, 1, 'the initial');
  expect
    .soft(await styles(tom.nth(0).getByText('Tom', { exact: true }), ['font-weight']))
    .toEqual({ 'font-weight': '600' });
  await expect(cells(page, 'Ana').nth(0)).toHaveText('AAna (you)');
  expect.soft(await painted(cells(page, 'Ana').getByText('(you)'), 'color')).toEqual(rgb(MUTED));
  expect.soft(await painted(tom.nth(1), 'color')).toEqual(rgb(INK_SOFT));

  // The role is a list in the row, but for an owner and for oneself; the sites are every site, or the
  // tile and the host of the site of a guest (FRU-250); the day somebody was last active, and joined.
  await expect(cells(page, 'Ana')).toHaveText([
    'AAna (you)',
    'ana@acme.dev',
    'Owner',
    'Every site',
    'Today',
    '2 Jun 2026',
    '',
  ]);
  await expect(cells(page, 'Ana').nth(2).getByRole('button')).toHaveCount(0);
  await expect(tom.nth(2).getByRole('button', { name: 'Admin, role of Tom' })).toBeVisible();
  expect
    .soft(await styles(tom.nth(2).getByRole('button'), ['height', 'border-top-left-radius', 'font-weight']))
    .toEqual({ height: '24px', 'border-top-left-radius': '6px', 'font-weight': '500' });
  expect.soft(await painted(tom.nth(2).getByRole('button'), 'borderTopColor')).toEqual(rgb(LINE));
  await expect(tom.nth(3)).toHaveText('Every site');
  await expect(tom.nth(3).locator('svg')).toHaveCount(1);
  await expect(cells(page, 'Inès Morel').nth(3)).toHaveText('Sstaging.acme.dev');
  await expect(
    cells(page, 'Inès Morel').nth(2).getByRole('button', { name: 'Guest, role of Inès Morel' }),
  ).toBeVisible();
  await expect(tom.nth(4)).toHaveText('Not seen yet');
  await expect(tom.nth(5)).toHaveText('14 Jul 2026');
  // The menu of a row, but on one's own row.
  await expect(tom.nth(6).getByRole('button', { name: 'Actions for Tom' })).toBeVisible();
  await expect(row(page, 'Ana').getByRole('button')).toHaveCount(0);
  // No legend of the roles, and no « Pending invitations » under the table: the invitations are a tab.
  await expect(page.locator('main dl')).toHaveCount(0);
  await expect(page.getByText('paul@client.fr')).toHaveCount(0);

  await expectNoViolation(page, 'the list');
});

test('the tab « Invitations » lists what waits, with its menu, and the search reads both tabs', async ({ page }) => {
  const worker = await workerWith(page, {
    invitations: [PAUL, { ...PAUL, id: 'i2', email: 'zoe@client.fr', role: 'admin', mailed: false }],
  });
  await open(page);
  await tab(page, 'Invitations').click();
  await expect(tab(page, 'Invitations')).toHaveAttribute('aria-pressed', 'true');
  await expect(table(page)).toHaveCount(0);
  const headers = invitationsTable(page).locator('thead th');
  await expect(headers).toHaveText(['Email', 'Role', 'Sites', 'Message', 'Invited', 'Expires', 'Actions']);
  await expect(cells(page, 'paul@client.fr')).toHaveText([
    'Ppaul@client.fr',
    'Member',
    'Every site',
    'Invitation sent',
    '3 Oct',
    '10 Oct',
    '',
  ]);
  await expect(cells(page, 'zoe@client.fr').nth(3)).toHaveText('Invitation kept');
  expectBox(await box(row(page, 'paul@client.fr')), { height: 36 }, 0.5, 'the row of an invitation');
  // The initial of somebody who has not come: no colour.
  const waiting = cells(page, 'paul@client.fr').nth(0).locator('.kit-avatar');
  expect.soft(await painted(waiting, 'backgroundColor')).toEqual(rgb(WHITE));
  expect.soft(await painted(waiting, 'borderTopColor')).toEqual(rgb(LINE));

  // Its menu: « Resend invitation », « Copy invite link » when its message did not leave, « Cancel invitation ».
  await row(page, 'paul@client.fr').getByRole('button', { name: 'Actions for paul@client.fr' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Resend invitation', 'Cancel invitation']);
  await page.keyboard.press('Escape');
  await row(page, 'zoe@client.fr').getByRole('button', { name: 'Actions for zoe@client.fr' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['Resend invitation', 'Copy invite link', 'Cancel invitation']);
  await page.keyboard.press('Escape');
  await expectNoViolation(page, 'the invitations');

  // The search finds an invitation by its address, and the members by the worker.
  await search(page).fill('ZOE');
  await expect(invitationsTable(page).locator('tbody tr')).toHaveCount(1);
  await expect(tab(page, 'Invitations')).toHaveAccessibleName('Invitations 1');
  await search(page).fill('nobody');
  await expect(page.getByText('No invitation matches this search.')).toBeVisible();
  await search(page).fill('');
  await tab(page, 'Members').click();
  await expect(row(page, 'Tom')).toBeVisible();
  // « / » gives the focus to the search, from anywhere but a field.
  await page.locator('main h1').click();
  await page.keyboard.press('/');
  await expect(search(page)).toBeFocused();
  expect(worker.sent).toEqual([]);
});

test('« Invite » opens « Invite people »: 480 px, three cards of a role, and « Send N invites » counts the addresses', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  // The dialog is not on the page: « Invite », at the right of the head, opens it.
  await expect(form(page)).toHaveCount(0);
  await inviting(page);
  await expect(dialog(page).getByRole('heading', { name: 'Invite people' })).toBeVisible();
  await expect(emails(page)).toBeFocused();
  expectBox(await box(dialog(page)), { width: 480 }, 0.5, 'the dialog');
  // Its head of 48 px over a rule, its foot on the subtle tint.
  const heading = dialog(page).getByRole('heading', { name: 'Invite people' });
  expect
    .soft(await styles(heading, ['font-size', 'font-weight']))
    .toEqual({ 'font-size': '14px', 'font-weight': '600' });
  expectBox(await box(heading.locator('..')), { height: 48 }, 1, 'the head of the dialog');
  const foot = dialog(page).locator('.kit-dialog__foot');
  expect.soft(await painted(foot, 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect.soft(await painted(foot, 'borderTopColor')).toEqual(rgb(LINE));

  // The three roles in the order of the mockup, each with what it lets its person do; « Member » chosen.
  await expect(form(page).getByRole('radio')).toHaveCount(3);
  for (const [role, does] of [
    ['Admin', 'Sites, members, connectors'],
    ['Member', 'Sees and leaves notes'],
    ['Guest', 'Only the site you pick'],
  ] as const) {
    await expect(cardBox(page, role)).toContainText(does);
  }
  await expect(card(page, 'Member')).toBeChecked();
  const cards = await form(page).locator('.kit-radio-card').all();
  const [admin, member, guest] = await Promise.all(cards.map((each) => box(each)));
  expect.soft(admin!.y, 'the cards on one line').toBeCloseTo(guest!.y, 0);
  expect.soft(member!.width).toBeCloseTo(admin!.width, 0);
  expect.soft(await painted(form(page).locator('.kit-radio-card').nth(1), 'borderTopColor')).toEqual(rgb(INK_SOFT));
  // « Sites » is every site for this role: set by the role, and drawn as such.
  await expect(form(page).getByRole('textbox', { name: 'Sites' })).toHaveValue('Every site');
  await expect(form(page).getByRole('textbox', { name: 'Sites' })).toHaveAttribute('readonly', '');

  // The foot: « Copy invite link » at the left, « Cancel » and « Send N invites » at the right.
  const copy = dialog(page).getByRole('button', { name: 'Copy invite link' });
  const cancel = dialog(page).getByRole('button', { name: 'Cancel', exact: true });
  expect.soft((await box(copy)).x).toBeLessThan((await box(cancel)).x);
  expect.soft((await box(cancel)).x).toBeLessThan((await box(send(page))).x);
  for (const control of [copy, cancel, send(page)]) {
    expect
      .soft(await styles(control, ['height', 'border-top-left-radius']))
      .toEqual({ height: '28px', 'border-top-left-radius': '6px' });
  }

  // Nothing to send with no address; « Send N invites » counts the valid ones, each once.
  await expect(send(page)).toHaveText('Send invites');
  await expect(send(page)).toBeDisabled();
  await emails(page).fill('zoe@client.fr');
  await expect(send(page)).toHaveText('Send 1 invite');
  await emails(page).fill('zoe@client.fr, paul@acme.dev; ZOE@client.fr\nlou@client.fr');
  await expect(send(page)).toHaveText('Send 3 invites');
  // What is no address is said under the field, and not counted.
  await emails(page).fill('zoe@client.fr, tom@acme, lou@client.fr');
  await expect(send(page)).toHaveText('Send 2 invites');
  await expect(form(page).getByText('Not an address, so not sent: tom@acme')).toBeVisible();
  await expectNoDialogViolation(page, 'the dialog');

  // Escape closes it, focus goes back to « Invite », and what was typed is there when it opens again.
  await cardBox(page, 'Admin').click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
  await inviting(page);
  await expect(emails(page)).toHaveValue('zoe@client.fr, tom@acme, lou@client.fr');
  await expect(card(page, 'Admin')).toBeChecked();
  // « Cancel » closes it too, and sends nothing.
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(opener(page)).toBeFocused();
  expect(worker.sent).toEqual([]);

  // Each valid address goes, one after the other, with the role; what is no address stays.
  await inviting(page);
  await send(page).click();
  await expect
    .poll(() => worker.sent)
    .toEqual([
      { call: 'invite-member', body: { organizationId: 'w1', email: 'zoe@client.fr', role: 'admin' } },
      { call: 'invite-member', body: { organizationId: 'w1', email: 'lou@client.fr', role: 'admin' } },
    ]);
  await expect(emails(page)).toHaveValue('tom@acme');
  await expect(dialog(page)).toBeVisible();
  // One sentence for the addresses whose message went, then the link once.
  await expect(page.getByRole('status')).toContainText(
    'Invitations sent to zoe@client.fr, lou@client.fr. You can also send them this link:',
  );
  await expect(page.getByRole('status')).toContainText(
    'They open it, sign in with the address that was invited, and join.',
  );
  // The address that was fixed goes, and the dialog closes: the field is empty for the next one.
  await emails(page).fill('tom@acme.dev');
  await send(page).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Invitation sent to tom@acme.dev.');
  await tab(page, 'Invitations').click();
  await expect(cells(page, 'zoe@client.fr')).toHaveText([
    'Zzoe@client.fr',
    'Admin',
    'Every site',
    'Invitation sent',
    '13 Oct',
    '20 Oct',
    '',
  ]);
  await inviting(page);
  await expect(emails(page)).toHaveValue('');
});

test('the addresses and the search are no field for a password manager (FRU-540)', async ({ page }) => {
  await workerWith(page);
  await open(page);
  expect(await fillMarks(search(page))).toEqual(NO_PASSWORD_MANAGER);
  await inviting(page);
  expect(await fillMarks(emails(page))).toEqual(NO_PASSWORD_MANAGER);

  // What LastPass 4.156 adds to the parent of a field moves nothing in the dialog.
  const before = { form: await box(form(page)), emails: await box(emails(page)) };
  await emails(page).evaluate((input) => {
    const icon = document.createElement('div');
    icon.setAttribute('data-lastpass-icon-root', '');
    icon.setAttribute(
      'style',
      'position: relative !important; height: 0px !important; width: 0px !important; display: initial !important; float: left !important;',
    );
    input.after(icon);
  });
  expect(await box(form(page))).toEqual(before.form);
  expect(await box(emails(page))).toEqual(before.emails);
});

test('a guest: « Sites » lists the sites of the workspace, and the one chosen goes with the invitation (FRU-250)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await stubSites(page, [
    { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' },
    { id: 's2', origin: 'https://acme.dev', visibility: 'everyone' },
  ]);
  await open(page);
  await inviting(page);
  await cardBox(page, 'Guest').click();
  const sitesList = form(page).getByRole('button', { name: /Sites$/ });
  await expect(sitesList).toBeVisible();
  // The sites to choose from come by address (FRU-497): the first one is chosen.
  await expect(sitesList).toContainText('acme.dev');
  await expect(sitesList).not.toContainText('staging');
  await expectNoDialogViolation(page, 'the form of a guest');
  await sitesList.click();
  await expect(page.getByRole('option')).toHaveText(['acme.dev', 'staging.acme.dev']);
  await page.getByRole('option', { name: 'staging.acme.dev', exact: true }).click();
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect
    .poll(() => worker.sent)
    .toEqual([
      { call: 'invite-member', body: { organizationId: 'w1', email: 'zoe@client.fr', role: 'guest', sites: ['s1'] } },
    ]);
});

test('a workspace with no site offers no guest, and a site the worker refuses is said (FRU-250)', async ({ page }) => {
  await workerWith(page);
  await stubSites(page, []);
  await open(page);
  await inviting(page);
  await expect(card(page, 'Guest')).toBeDisabled();
  await expect(cardBox(page, 'Guest')).toContainText('Add a site first');
  await page.keyboard.press('Escape');

  await page.unrouteAll();
  const worker = await workerWith(page);
  worker.refuses = { status: 400, error: 'invalid-request', field: 'sites' };
  await open(page);
  await inviting(page);
  await cardBox(page, 'Guest').click();
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'This site is no longer one of the workspace. Choose another one.',
  );
  await expect(emails(page)).toHaveValue('zoe@client.fr');
});

test('an invitation that was kept gives its link, whatever became of its message', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  const notice = page.getByRole('status');

  // The message went.
  await inviting(page);
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect(notice).toContainText('Invitation sent to zoe@client.fr. You can also send them this link:');
  await expect(notice).toContainText(`${CONSOLE}/invitations`);
  await expect(notice).toContainText('They open it, sign in with zoe@client.fr, and join.');
  await expect(notice.getByRole('button', { name: 'Copy the link' })).toBeVisible();
  // FRU-642: the short guide of a client, to send with the link.
  await expect(notice.getByRole('link', { name: 'How to leave a note' })).toHaveAttribute(
    'href',
    'https://fruitback.com/leave-a-note.html',
  );
  // The block is under the tabs, on the tint of a block, and above the list.
  expect((await box(notice)).y).toBeGreaterThanOrEqual((await box(tab(page, 'Members'))).y + 44);
  expect((await box(notice)).y + (await box(notice)).height).toBeLessThanOrEqual((await box(table(page))).y);
  expect.soft(await painted(notice, 'backgroundColor')).toEqual(rgb(SUBTLE));
  for (const text of await notice.locator('p').all())
    expect.soft(contrast(await painted(text, 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);
  await expectNoViolation(page, 'the block of an invitation that was kept');

  // The worker sends mail, and sent none for this one (FRU-209).
  worker.held = true;
  await tab(page, 'Invitations').click();
  await fromMenu(page, 'zoe@client.fr', 'Resend invitation');
  await expect(notice).toContainText('Invitation kept for zoe@client.fr, but no message was sent');
  expect(worker.sent.at(-1)).toEqual({
    call: 'invite-member',
    body: { organizationId: 'w1', email: 'zoe@client.fr', role: 'member', resend: true },
  });
  // A message did leave before this one: the row still says so.
  await expect(cells(page, 'zoe@client.fr').nth(3)).toHaveText('Invitation sent');

  // An invitation whose first message did not leave says « kept » on its row, until one leaves.
  await inviting(page);
  await emails(page).fill('lou@client.fr');
  await send(page).click();
  await expect(notice).toContainText('Invitation kept for lou@client.fr, but no message was sent');
  await expect(cells(page, 'lou@client.fr').nth(3)).toHaveText('Invitation kept');
  await fromMenu(page, 'lou@client.fr', 'Resend invitation');
  await expect(notice).toContainText('Invitation kept for lou@client.fr, but no message was sent');
  await expect(cells(page, 'lou@client.fr').nth(3)).toHaveText('Invitation kept');
  worker.held = false;
  await fromMenu(page, 'lou@client.fr', 'Resend invitation');
  await expect(notice).toContainText('Invitation sent to lou@client.fr.');
  await expect(cells(page, 'lou@client.fr').nth(3)).toHaveText('Invitation sent');

  // A worker with no mailer sent nothing, and the row does not say « sent ».
  await page.unrouteAll();
  const silent = await workerWith(page);
  silent.mails = false;
  await open(page);
  await tab(page, 'Invitations').click();
  await expect(cells(page, 'paul@client.fr').nth(3)).toHaveText('Invitation kept');
  await inviting(page);
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect(notice).toContainText('Invitation kept for zoe@client.fr. Send them this link:');
});

test('« Copy invite link » copies the link, in the dialog and on a row whose message did not leave (FRU-269)', async ({
  page,
}) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CONSOLE });
  await workerWith(page, { invitations: [{ ...PAUL, mailed: false }] });
  await open(page);
  await tab(page, 'Invitations').click();
  await expect(cells(page, 'paul@client.fr').nth(3)).toHaveText('Invitation kept');
  await fromMenu(page, 'paul@client.fr', 'Copy invite link');
  await expect(page.getByRole('status')).toHaveText('The link is copied. Send it to them.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${CONSOLE}/invitations`);
  await expectNoViolation(page, 'a copied link');

  await page.evaluate(() => navigator.clipboard.writeText(''));
  await inviting(page);
  await dialog(page).getByRole('button', { name: 'Copy invite link' }).click();
  await expect(dialog(page).getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${CONSOLE}/invitations`);
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
    [500, 'unknown', 'Fruitback hit an error. Try again in a moment.'],
    [418, 'something-new', 'The invitation was not sent. Try again.'],
  ];
  await inviting(page);
  await cardBox(page, 'Admin').click();
  await emails(page).fill('tom@acme.dev');
  for (const [status, error, sentence] of refusals) {
    worker.refuses = { status, error };
    await send(page).click();
    // The sentence is in the dialog, under the fields: the dialog stays open.
    await expect(dialog(page).getByRole('alert'), error).toHaveText(sentence);
    await expect(emails(page), error).toHaveValue('tom@acme.dev');
    // Focus is back in the field: the button it left was disabled while it sent.
    await expect(emails(page), error).toBeFocused();
    await expect(card(page, 'Admin'), error).toBeChecked();
  }
  await expect(page.getByRole('status')).toHaveCount(0);
  await expectNoDialogViolation(page, 'an invitation that is refused');

  // Of several addresses, the ones refused stay, each said with its cause; the others go.
  worker.refuses = undefined;
  worker.refusesFor = {
    'tom@acme.dev': { status: 400, error: 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION' },
  };
  await emails(page).fill('tom@acme.dev, zoe@client.fr');
  await send(page).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'tom@acme.dev: This person is already a member of the workspace.',
  );
  await expect(emails(page)).toHaveValue('tom@acme.dev');
  await expect(page.getByRole('status')).toContainText('Invitation sent to zoe@client.fr.');

  // While the worker has not answered, the button says so and sends nothing twice.
  worker.refusesFor = undefined;
  worker.slow = true;
  const before = worker.sent.length;
  await emails(page).fill('lou@client.fr');
  await send(page).click();
  const sending = form(page).getByRole('button', { name: 'Sending…' });
  await expect(sending).toBeDisabled();
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await expect(emails(page)).toHaveValue('lou@client.fr');
  await expect.poll(() => worker.sent.length).toBe(before + 1);
  await sending.click({ force: true });
  await page.waitForTimeout(400);
  expect(worker.sent.length).toBe(before + 1);
});

test('an invitation kept with a message that did not leave leaves the field, and says so (FRU-691)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  await inviting(page);
  worker.refusesFor = { 'zoe@client.fr': { status: 503, error: 'mail-unavailable' } };
  await emails(page).fill('zoe@client.fr, lou@client.fr');
  await send(page).click();
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'zoe@client.fr: The invitation is kept, but its message did not leave. Send it again from its row.',
  );
  // The worker kept it: sent again from the field, it would be refused as invited already.
  await expect(emails(page)).toHaveValue('');
  await expect(send(page)).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Invitation sent to lou@client.fr.');
  expect(worker.sent.map((each) => each.body.email)).toEqual(['zoe@client.fr', 'lou@client.fr']);
});

test('what is typed in « Emails » while the invitations go stays in it (FRU-691)', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await inviting(page);
  worker.lag = 1500;
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect(form(page).getByRole('button', { name: 'Sending…' })).toBeVisible();
  // Typed before the answer: the address that goes, and one more.
  await emails(page).fill('zoe@client.fr, ana@acme.dev');
  await expect(page.getByRole('status')).toContainText('Invitation sent to zoe@client.fr.');
  await expect(emails(page)).toHaveValue('ana@acme.dev');
  await expect(dialog(page)).toBeVisible();
  await expect(send(page)).toHaveText('Send 1 invite');

  // One address refused, and one typed meanwhile: the sentence names the address it is about.
  worker.refusesFor = { 'tom@acme.dev': { status: 400, error: 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION' } };
  await emails(page).fill('tom@acme.dev');
  await send(page).click();
  await expect(form(page).getByRole('button', { name: 'Sending…' })).toBeVisible();
  await emails(page).fill('tom@acme.dev, lou@client.fr');
  await expect(dialog(page).getByRole('alert')).toHaveText(
    'tom@acme.dev: This person is already a member of the workspace.',
  );
  await expect(emails(page)).toHaveValue('tom@acme.dev, lou@client.fr');
});

test('an owner changes a role in its row; a guest made a member asks twice; a refusal is said (FRU-691)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  // Tom, an admin, made a member: the list offers the roles a change gives, and the role goes.
  const tomRole = row(page, 'Tom').getByRole('button', { name: 'Admin, role of Tom' });
  await tomRole.click();
  await expect(page.getByRole('menuitemradio')).toHaveText(['Member', 'Admin']);
  await expect(page.getByRole('menuitemradio', { name: 'Admin' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Member' }).click();
  await expect
    .poll(() => worker.sent)
    .toEqual([{ call: 'update-member-role', body: { organizationId: 'w1', memberId: 'm2', role: 'member' } }]);
  await expect(row(page, 'Tom').getByRole('button', { name: 'Member, role of Tom' })).toBeVisible();
  // The same role chosen again sends nothing.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row(page, 'Tom').getByRole('button', { name: 'Member, role of Tom' }).click();
  await page.getByRole('menuitemradio', { name: 'Member' }).click();
  await page.waitForTimeout(200);
  expect(worker.sent).toHaveLength(1);

  // Inès, a guest, made a member reads every site: it asks twice, and « Keep it » sends nothing.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row(page, 'Inès Morel').getByRole('button', { name: 'Guest, role of Inès Morel' }).click();
  await expect(page.getByRole('menuitemradio')).toHaveText(['Guest', 'Member', 'Admin']);
  await page.getByRole('menuitemradio', { name: 'Member' }).click();
  const asked = page.getByRole('group', { name: 'Make Inès Morel a member' });
  await expect(
    asked.getByText('Inès Morel reads every site of the workspace, not only the sites shared with them.'),
  ).toBeVisible();
  await expect(asked.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await expectNoViolation(page, 'a change of role that asks twice');
  await page.keyboard.press('Escape');
  await expect(asked).toHaveCount(0);
  await expect(row(page, 'Inès Morel').getByRole('button', { name: 'Guest, role of Inès Morel' })).toBeFocused();
  expect(worker.sent).toHaveLength(1);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row(page, 'Inès Morel').getByRole('button', { name: 'Guest, role of Inès Morel' }).click();
  await page.getByRole('menuitemradio', { name: 'Member' }).click();
  await asked.getByRole('button', { name: 'Make Inès Morel a member' }).click();
  await expect
    .poll(() => worker.sent.at(-1))
    .toEqual({
      call: 'update-member-role',
      body: { organizationId: 'w1', memberId: 'm4', role: 'member' },
    });
  // Their sites went with the role of a guest: the row reads every site.
  await expect(cells(page, 'Inès Morel').nth(3)).toHaveText('Every site');

  // The worker refuses: the role stays, and the row says why.
  worker.refuses = { status: 403, error: 'YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER' };
  // The menu of before has faded away: one menu at a time.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await row(page, 'Nora').getByRole('button', { name: 'Member, role of Nora' }).click();
  await page.getByRole('menuitemradio', { name: 'Admin' }).click();
  await expect(page.getByRole('alert')).toHaveText('Only an owner changes the role of an owner.');
  await expect(row(page, 'Nora').getByRole('button', { name: 'Member, role of Nora' })).toBeVisible();
  await expectNoViolation(page, 'a change of role that was refused');
});

test('removing a member and cancelling an invitation ask twice, from the menu of the row, with the keyboard too', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);

  // « Remove from workspace »: what it costs, « Keep it » with focus, and the button that names Tom.
  await fromMenu(page, 'Tom', 'Remove from workspace');
  const removing = page.getByRole('group', { name: 'Remove Tom' });
  await expect(
    removing.getByText('Tom leaves the workspace, and their extension stops reading its sites. Their notes stay.'),
  ).toBeVisible();
  await expect(removing.getByRole('button', { name: 'Keep it' })).toBeFocused();
  // What is asked is under the row of the person, and above the next one.
  expect((await box(removing)).y).toBeGreaterThanOrEqual((await box(row(page, 'Tom'))).y + 36);
  expect((await box(removing)).y).toBeLessThan((await box(row(page, 'Nora'))).y);
  expect.soft(await painted(removing.locator('xpath=ancestor::tr'), 'backgroundColor')).toEqual(rgb(SUBTLE));
  expect(worker.sent).toEqual([]);
  // « Keep it » gives the row back, with focus on the menu that asked.
  await removing.getByRole('button', { name: 'Keep it' }).click();
  await expect(removing).toHaveCount(0);
  const menu = row(page, 'Tom').getByRole('button', { name: 'Actions for Tom' });
  await expect(menu).toBeFocused();
  // The keyboard alone: Enter opens the menu on its item, Enter takes it, Escape steps back.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Remove from workspace' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(removing.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(removing).toHaveCount(0);
  await expect(menu).toBeFocused();

  // The worker refuses, the member stays, and the row says why.
  worker.refuses = { status: 403, error: 'YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER' };
  await fromMenu(page, 'Tom', 'Remove from workspace');
  await removing.getByRole('button', { name: 'Remove Tom' }).click();
  await expect(page.getByRole('alert')).toHaveText('Only an owner removes an owner.');
  await expect(row(page, 'Tom')).toBeVisible();
  await expectNoViolation(page, 'a removal that was refused');
  worker.refuses = undefined;
  await fromMenu(page, 'Tom', 'Remove from workspace');
  await removing.getByRole('button', { name: 'Remove Tom' }).click();
  await expect(page.getByText('tom@acme.dev', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);

  // « Cancel invitation », in the tab of the invitations.
  await tab(page, 'Invitations').click();
  await fromMenu(page, 'paul@client.fr', 'Cancel invitation');
  const cancelling = page.getByRole('group', { name: 'Cancel the invitation of paul@client.fr' });
  await expect(cancelling.getByText('The message already sent no longer lets paul@client.fr join.')).toBeVisible();
  await cancelling.getByRole('button', { name: 'Cancel the invitation of paul@client.fr' }).click();
  await expect(page.getByText('paul@client.fr', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No invitation waits.')).toBeVisible();
  expect(worker.sent).toEqual([
    { call: 'remove-member', body: { organizationId: 'w1', memberIdOrEmail: 'm2' } },
    { call: 'remove-member', body: { organizationId: 'w1', memberIdOrEmail: 'm2' } },
    { call: 'cancel-invitation', body: { organizationId: 'w1', invitationId: 'i1' } },
  ]);
});

test('Tab walks the dialog and stays in it, then goes from « Invite » to the tabs, the search and each row', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  await inviting(page);
  await emails(page).fill('zoe@client.fr');
  await expect(emails(page)).toBeFocused();

  // In the dialog: the role chosen, « Sites », the button of the link, « Cancel », « Send », the close
  // button, then the field again. Focus never leaves it.
  const inside: [string, Locator][] = [
    ['the role chosen', card(page, 'Member')],
    ['« Sites »', form(page).getByRole('textbox', { name: 'Sites' })],
    ['« Copy invite link »', dialog(page).getByRole('button', { name: 'Copy invite link' })],
    ['« Cancel »', dialog(page).getByRole('button', { name: 'Cancel', exact: true })],
    ['« Send 1 invite »', send(page)],
    ['the close button', dialog(page).getByRole('button', { name: 'Close', exact: true })],
    ['the field', emails(page)],
  ];
  for (const [name, stop] of inside) {
    await page.keyboard.press('Tab');
    await expect(stop, name).toBeFocused();
  }
  // The arrows go from one role to the next.
  await page.keyboard.press('Tab');
  await expect(card(page, 'Member')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Guest')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(opener(page)).toBeFocused();

  const stops: [string, Locator][] = [
    ['the tab « Members »', tab(page, 'Members')],
    ['the tab « Invitations »', tab(page, 'Invitations')],
    ['the search', search(page)],
    // The frame takes focus, so a keyboard scrolls a table wider than its screen.
    ['the frame of the list', table(page)],
    ['the role of Tom', row(page, 'Tom').getByRole('button', { name: 'Admin, role of Tom' })],
    ['the menu of Tom', row(page, 'Tom').getByRole('button', { name: 'Actions for Tom' })],
    ['the role of Nora', row(page, 'Nora').getByRole('button', { name: 'Member, role of Nora' })],
  ];
  for (const [name, stop] of stops) {
    await page.keyboard.press('Tab');
    await expect(stop, name).toBeFocused();
    expect
      .soft(await styles(stop, ['outline-style', 'outline-width']), name)
      .toEqual({ 'outline-style': 'solid', 'outline-width': '2px' });
    expect.soft(await painted(stop, 'outlineColor'), name).toEqual(rgb(ACCENT));
  }
});

test('an admin invites and changes roles; a member reads; a guest sees their own row and nothing of the others', async ({
  page,
}) => {
  await workerWith(page, { role: 'admin' });
  await open(page);
  await expect(opener(page)).toBeVisible();
  // An admin changes no owner, as the worker refuses it: Ana's role is words.
  await expect(row(page, 'Ana').getByRole('button', { name: /role of Ana/ })).toHaveCount(0);
  await expect(row(page, 'Nora').getByRole('button', { name: 'Member, role of Nora' })).toBeVisible();
  await expect(tab(page, 'Invitations')).toBeVisible();

  // A member reads who is there: no tab of the invitations, no list of a role, no menu, and no
  // invitation is asked for.
  await page.unrouteAll();
  const read = await workerWith(page, { role: 'member', members: [ANA, TOM, NORA] });
  await open(page);
  await expect(row(page, 'Tom')).toBeVisible();
  await expect(table(page).locator('thead th')).toHaveText(['Name', 'Email', 'Role', 'Sites', 'Joined']);
  await expect(tab(page, 'Invitations')).toHaveCount(0);
  await expect(page.locator('main').getByRole('button', { name: /role of|Actions for|^Invite$/ })).toHaveCount(0);
  await expect(page.getByText('paul@client.fr')).toHaveCount(0);
  // The development build runs an effect twice: what matters is which lists are asked for.
  expect([...new Set(read.read)]).toEqual(['list-members']);
  await expectNoViolation(page, 'the screen of a member');

  // A guest: the worker refuses them the list, so the screen asks for none and draws their row.
  await page.unrouteAll();
  const refused = await workerWith(page, { role: 'guest' });
  await open(page);
  await expect(table(page).locator('thead th')).toHaveText(['Name', 'Email', 'Role', 'Sites']);
  await expect(table(page).locator('tbody tr')).toHaveCount(1);
  // Their site is the one the worker lists to them (FRU-250).
  await expect(table(page).locator('tbody td')).toHaveText([
    'AAna (you)',
    'ana@acme.dev',
    'Guest',
    'Sstaging.acme.dev',
  ]);
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  expect(refused.read).toEqual([]);
  await expectNoViolation(page, 'the screen of a guest');
});

test('a read that failed says so with « Try again », and is never a table with nobody (FRU-162)', async ({ page }) => {
  const worker = await workerWith(page);
  worker.members = 'fails';
  await open(page);

  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { level: 2, name: 'The members did not load' })).toBeVisible();
  await expect(alert.locator('p')).toHaveText('Fruitback hit an error. Your members are safe.');
  await expect(page.getByText('Try again')).toHaveCount(1);
  await expect(table(page)).toHaveCount(0);
  // FRU-616: « Invite » comes with the list. A read that failed offers « Try again » and nothing else.
  await expect(opener(page)).toHaveCount(0);
  await expectNoViolation(page, 'a read that failed');

  worker.members = 'list';
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row(page, 'Tom')).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect(opener(page)).toBeVisible();
});

test('what was typed in the invitation stays through a read that failed, and « Invite » comes back with the list (FRU-616)', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await open(page);
  await inviting(page);
  await cardBox(page, 'Guest').click();
  await emails(page).fill('zoe@client.fr');
  // A site removed meanwhile makes the screen read its lists again, and that read fails.
  worker.members = 'fails';
  worker.refuses = { status: 400, error: 'invalid-request', field: 'sites' };
  await send(page).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { level: 2, name: 'The members did not load' })).toBeVisible();
  await expect(opener(page)).toHaveCount(0);

  worker.members = 'list';
  worker.refuses = undefined;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(row(page, 'Tom')).toBeVisible();
  await inviting(page);
  await expect(emails(page)).toHaveValue('zoe@client.fr');
});

test('a search longer than the worker reads is cut at 100 characters, and never fails the list (FRU-496)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  await search(page).fill('a'.repeat(120));
  await expect(search(page)).toHaveValue('a'.repeat(100));
  await expect.poll(async () => (await table(page).locator('tbody tr').count()) > 0).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  await expect(row(page, 'Tom')).toBeVisible();
});

test('a member removed stays removed when the read of their page after it fails (FRU-496)', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await fromMenu(page, 'Tom', 'Remove from workspace');
  worker.members = 'fails';
  await page.getByRole('button', { name: 'Remove Tom' }).click();
  await expect.poll(() => worker.sent.map((each) => each.call)).toEqual(['remove-member']);
  await expect.poll(() => worker.read.filter((each) => each === 'list-members').length).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  await expect(page.getByText('tom@acme.dev', { exact: true })).toHaveCount(0);
  await expect(row(page, 'Nora')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
});

test('a day that the worker did not give, or that is no date, is not drawn', async ({ page }) => {
  const { createdAt: _none, ...undated } = PAUL;
  await workerWith(page, {
    members: [ANA, { ...TOM, createdAt: 'yesterday' }],
    invitations: [{ ...undated, expiresAt: 'soon' }],
  });
  await open(page);
  await expect(cells(page, 'Tom').nth(5)).toHaveText('');
  await expect(page.getByText('Invalid Date')).toHaveCount(0);
  // The control: a day that is one is drawn.
  await expect(cells(page, 'Ana').nth(5)).toHaveText('2 Jun 2026');
  await tab(page, 'Invitations').click();
  await expect(cells(page, 'paul@client.fr').nth(4)).toHaveText('');
  await expect(cells(page, 'paul@client.fr').nth(5)).toHaveText('');
  await expect(page.getByText('Invalid Date')).toHaveCount(0);
});

test('a read made again keeps the rows on the screen, and a press on one of them is heard', async ({ page }) => {
  const worker = await workerWith(page);
  await open(page);
  await expect(row(page, 'Tom')).toBeVisible();
  const shown = await table(page).locator('tbody tr').count();
  const before = await box(table(page));

  // A message that did not leave makes the screen read its lists again; the worker is slow to answer.
  const reads = () => worker.read.filter((each) => each === 'list-members').length;
  const read = reads();
  worker.members = 'waits';
  worker.refuses = { status: 503, error: 'mail-unavailable' };
  await inviting(page);
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect.poll(reads).toBe(read + 1);
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  const during = await box(table(page));
  expect(during.y).toBe(before.y);

  // The rows stay while the lists are read again: no « Loading… » in their place.
  await expect(page.locator('main').getByText('Loading…')).toHaveCount(0);
  await expect(table(page).locator('tbody tr')).toHaveCount(shown);
  expect(during.height).toBe(before.height);
  // An action of a row is still there to press.
  await fromMenu(page, 'Tom', 'Remove from workspace');
  await expect(page.getByRole('group', { name: 'Remove Tom' })).toBeVisible();
});

test('while the members are read, the screen says so and draws no table', async ({ page }) => {
  const worker = await workerWith(page);
  worker.members = 'waits';
  await open(page);
  await expect(page.locator('main').getByText('Loading…')).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  // FRU-616: « Invite » waits for the list too.
  await expect(opener(page)).toHaveCount(0);
});

for (const width of [390, 320]) {
  for (const locale of ['en', 'fr'] as const) {
    test(`at ${width} px the list scrolls in its frame and the page does not, in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      const worker = await workerWith(page, { locale });
      await open(page);
      const words =
        locale === 'en'
          ? {
              actions: 'Actions for Tom',
              remove: 'Remove from workspace',
              keep: 'Keep it',
              invite: 'Invite',
              emails: 'Emails',
              again: 'Try again',
              send: 'Send 1 invite',
              dialog: 'Invite people',
            }
          : {
              actions: 'Actions pour Tom',
              remove: 'Retirer de l’espace de travail',
              keep: 'Le garder',
              invite: 'Inviter',
              emails: 'E-mails',
              again: 'Réessayer',
              send: 'Envoyer 1 invitation',
              dialog: 'Inviter des personnes',
            };
      const list = page.getByRole('region', { name: locale === 'en' ? 'Members' : 'Membres', exact: true });
      expect.soft(await sideScroll(page), 'the list').toBe(0);
      const frame = await box(list);
      expect.soft(frame.x + frame.width, 'the frame').toBeLessThanOrEqual(width);
      expect.soft(await list.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
      if (locale === 'fr') {
        await expect(list.locator('thead th')).toHaveText([
          'Nom',
          'E-mail',
          'Rôle',
          'Sites',
          'Dernière activité',
          'Arrivée',
          'Actions',
        ]);
      }
      // A row stays one line of 36 px on a phone.
      expectBox(await box(row(page, 'Tom')), { height: 36 }, 0.5, 'a row on a phone');

      // What a gesture costs is read without scrolling the list, whatever part of it is on screen.
      await row(page, 'Tom').getByRole('button', { name: words.actions }).click();
      await page.getByRole('menuitem', { name: words.remove }).click();
      const asked = page.getByRole('group').filter({ has: page.getByRole('button', { name: words.keep }) });
      const sentence = asked.locator('p');
      await expect(sentence).toBeVisible();
      const read = await box(sentence);
      expect.soft(read.x, 'the sentence starts on the screen').toBeGreaterThanOrEqual(0);
      expect.soft(read.x + read.width, 'the sentence ends on the screen').toBeLessThanOrEqual(width);
      expect.soft(await sideScroll(page), 'the second time of a removal').toBe(0);
      await asked.getByRole('button', { name: words.keep }).click();

      // The dialog, the block of an invitation, a refusal, and a read that failed.
      const inviteButton = page.locator('main header').getByRole('button', { name: words.invite, exact: true });
      await inviteButton.click();
      // By its name: the menu of « Actions » is a dialog too while it fades out (FRU-736).
      const opened = page.getByRole('dialog', { name: words.dialog, exact: true });
      await expect(opened).toBeVisible();
      await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished)));
      const drawn = await box(opened);
      expect.soft(drawn.x, 'the dialog starts on the screen').toBeGreaterThanOrEqual(0);
      expect.soft(drawn.x + drawn.width, 'the dialog ends on the screen').toBeLessThanOrEqual(width);
      expect.soft(drawn.y + drawn.height, 'the dialog ends in the window').toBeLessThanOrEqual(844);
      expect.soft(await sideScroll(page), 'the dialog').toBe(0);
      await page.getByRole('textbox', { name: words.emails, exact: true }).fill('zoe@client.fr');
      await opened.getByRole('button', { name: words.send }).click();
      await expect(page.getByRole('status')).toBeVisible();
      expect.soft(await sideScroll(page), 'the block of an invitation').toBe(0);
      worker.refuses = { status: 400, error: 'USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION' };
      await inviteButton.click();
      await page.getByRole('textbox', { name: words.emails, exact: true }).fill('zoe@client.fr');
      await opened.getByRole('button', { name: words.send }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      expect.soft(await sideScroll(page), 'a refusal').toBe(0);
      await expectNoDialogViolation(page, `the dialog at ${width} px in ${locale}`);
      worker.members = 'fails';
      await open(page);
      await expect(page.getByRole('button', { name: words.again, exact: true })).toBeVisible();
      expect.soft(await sideScroll(page), 'a read that failed').toBe(0);
    });
  }
}

test('every text of the screen is at 4.5:1 on what is behind it', async ({ page }) => {
  await workerWith(page);
  await open(page);
  const tom = cells(page, 'Tom');
  const onWhite: [string, Locator][] = [
    ['the title', page.locator('main h1')],
    ['a tab that is not chosen', tab(page, 'Invitations')],
    ['a count', tab(page, 'Members').locator('.kit-line-tab__count')],
    ['a column header', table(page).locator('thead th').first()],
    ['a name', tom.nth(0).getByText('Tom', { exact: true })],
    ['« (you) »', cells(page, 'Ana').getByText('(you)')],
    ['an address', tom.nth(1)],
    ['a role', tom.nth(2).getByRole('button')],
    ['the sites', tom.nth(3)],
    ['the day somebody joined', tom.nth(5)],
  ];
  for (const [name, text] of onWhite) {
    expect.soft(contrast(await painted(text, 'color'), rgb(WHITE)), name).toBeGreaterThanOrEqual(4.5);
  }
  // White on the initial of a person, and on « Invite ».
  const chip = tom.nth(0).locator('.kit-avatar');
  expect
    .soft(contrast(await painted(chip, 'color'), await painted(chip, 'backgroundColor')), 'an initial')
    .toBeGreaterThanOrEqual(4.5);
  expect
    .soft(contrast(await painted(opener(page), 'color'), await painted(opener(page), 'backgroundColor')), '« Invite »')
    .toBeGreaterThanOrEqual(4.5);
  // The words of the dialog, on its white and on its foot.
  await inviting(page);
  const words: [string, Locator, string][] = [
    ['the label « Emails »', form(page).locator('.label').first(), WHITE],
    ['what a role does', form(page).locator('.kit-radio-card .description').first(), WHITE],
    ['« Copy invite link »', dialog(page).getByRole('button', { name: 'Copy invite link' }), SUBTLE],
  ];
  for (const [name, text, behind] of words) {
    expect.soft(contrast(await painted(text, 'color'), rgb(behind)), name).toBeGreaterThanOrEqual(4.5);
  }
  await emails(page).fill('zoe@client.fr');
  expect
    .soft(
      contrast(await painted(send(page), 'color'), await painted(send(page), 'backgroundColor')),
      '« Send 1 invite »',
    )
    .toBeGreaterThanOrEqual(4.5);
  expect
    .soft(await painted(form(page).locator('.kit-radio-card').first().locator('.label'), 'color'))
    .toEqual(rgb(INK));
});

/** Noon of UTC: « Today » is the day of UTC the worker writes. */
const NOON_UTC = new Date('2026-10-13T12:00:00.000Z');
const SEEN = { a1: '2026-10-13', a2: '2026-10-12', a3: '2026-10-10' };

test('an owner reads « Last active »: a day, never an hour, and « Not seen yet »', async ({ page }) => {
  await page.clock.setFixedTime(NOON_UTC);
  const worker = await workerWith(page, { seen: SEEN });
  await open(page);
  const last = (name: string) => cells(page, name).nth(4);
  await expect(last('Ana')).toHaveText('Today');
  await expect(last('Tom')).toHaveText('Yesterday');
  await expect(last('Nora')).toHaveText('3 days ago');
  // Nobody saw this one since « Last active » came: the screen says so, and not a date.
  await expect(last('Inès Morel')).toHaveText('Not seen yet');
  expect(worker.read).toContain('seen');
});

test('the table does not wait for « Last active », and nothing of a row moves when the days arrive', async ({
  page,
}) => {
  await page.clock.setFixedTime(NOON_UTC);
  const worker = await workerWith(page, { seen: 'waits', released: SEEN });
  await open(page);
  await expect(table(page).locator('tbody tr')).toHaveCount(4);
  await expect(table(page).locator('thead th').nth(4)).toHaveText('Last active');
  const menu = row(page, 'Nora').getByRole('button', { name: 'Actions for Nora' });
  const role = row(page, 'Nora').getByRole('button', { name: 'Member, role of Nora' });
  const before = [await box(menu), await box(role)];

  worker.release();
  await expect(cells(page, 'Nora').nth(4)).toHaveText('3 days ago');
  await expect(cells(page, 'Inès Morel').nth(4)).toHaveText('Not seen yet');
  expect([await box(menu), await box(role)]).toEqual(before);
});

test('a member reads the day somebody joined, and does not ask « Last active »', async ({ page }) => {
  const worker = await workerWith(page, { role: 'member', seen: SEEN });
  await open(page);
  await expect(table(page).locator('thead th')).toHaveText(['Name', 'Email', 'Role', 'Sites', 'Joined']);
  await expect(page.getByText('Today')).toHaveCount(0);
  expect(worker.read).not.toContain('seen');
});

test('a « Last active » the worker refuses leaves the column empty, and the day somebody joined', async ({ page }) => {
  await workerWith(page, { seen: 'refused' });
  await open(page);
  await expect(table(page).locator('thead th')).toHaveText([
    'Name',
    'Email',
    'Role',
    'Sites',
    'Last active',
    'Joined',
    'Actions',
  ]);
  await expect(cells(page, 'Tom').nth(4)).toHaveText('');
  await expect(cells(page, 'Tom').nth(5)).toHaveText('14 Jul 2026');
});

test('the days of a read made before, late, do not replace those of the read made after', async ({ page }) => {
  await page.clock.setFixedTime(NOON_UTC);
  // The first days are held; the members are read again (an invitation whose message did not
  // leave), and the second days come at once: Nora was seen two days ago.
  const worker = await workerWith(page, { seen: 'waits', released: SEEN, later: { a3: '2026-10-11' } });
  await open(page);
  worker.refuses = { status: 503, error: 'mail-unavailable' };
  await inviting(page);
  await emails(page).fill('zoe@client.fr');
  await send(page).click();
  await expect(dialog(page).getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(cells(page, 'Nora').nth(4)).toHaveText('2 days ago');

  // The first answer lands now: it is of a read that is no longer the last one.
  worker.release();
  await page.waitForTimeout(300);
  await expect(cells(page, 'Nora').nth(4)).toHaveText('2 days ago');
});

test('the words of « Emails » and of the list « Sites » sit at one height in their control (FRU-412)', async ({
  page,
}) => {
  await workerWith(page);
  await open(page);
  await inviting(page);
  await cardBox(page, 'Guest').click();
  // HeroUI wrote the chosen value of a list at 14 px on a line of 20 px, so its words sat higher and
  // smaller than those of a field. The middle of the words is read from the top of each control.
  const type = async (locator: Locator, control: Locator) =>
    locator.evaluate(
      (element, top) => {
        const { fontSize, lineHeight } = getComputedStyle(element);
        const found = element.getBoundingClientRect();
        return { fontSize, lineHeight, middle: Math.round((found.top + found.height / 2 - top) * 10) / 10 };
      },
      (await box(control)).y,
    );
  const sitesList = form(page).getByRole('button', { name: /Sites$/ });
  const field = await type(emails(page), emails(page));
  const chosen = await type(sitesList.locator('.select__value'), sitesList);
  expect(chosen).toEqual(field);
  expect(field.fontSize).toBe('13px');
});

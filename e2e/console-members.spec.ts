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
 * the invitation on one line, the table of the people and of the invitations, and what each role does.
 *
 * The values are read in the code of the mockup (`12-console-members.html`), and the boxes in its
 * render at 1440 px and at 390 px (a box is compared where the font is the one of the mockup). The
 * screen has what the worker of today gives: no list « Site » and no « Guest, one site » in the form,
 * and the last column is the day somebody joined, not when they were last seen. The worker is
 * answered by stubs.
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
const INES = person(4, 'Inès Morel', 'ines@client.fr', 'guest', '2026-09-22');
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
  refuses?: { status: number; error: string };
};

type World = {
  role?: Role;
  locale?: 'en' | 'fr';
  members?: readonly unknown[];
  invitations?: readonly unknown[];
};

/** A workspace with the people above, for a role. The stub keeps what the console sent. */
async function workerWith(page: Page, world: World = {}): Promise<Worker> {
  const worker: Worker = { sent: [], read: [], members: 'list', mails: true, held: false, slow: false };
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
    if (call === 'list-invitations') {
      worker.read.push(call);

      return json(invitations);
    }
    if (!['invite-member', 'cancel-invitation', 'remove-member'].includes(call)) return undefined;
    const body = request.postDataJSON() as Record<string, unknown>;
    worker.sent.push({ call, body });
    if (worker.slow) return new Promise<void>(() => {});
    if (worker.refuses !== undefined) return json({ error: worker.refuses.error }, worker.refuses.status);
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
  expectBox(await box(table(page)), { x: 296.5, y: 216.2, width: 1024, height: 366.5 }, 2, 'the frame of the table');
  expectBox(await box(table(page).locator('thead tr')), { height: 43.3 }, 2, 'the header row');
  // A row of the mockup is 64 px: two lines of 14 px and 13 px at 1.45, and 12 px above and under.
  expectBox(await box(row(page, 'Tom')), { x: 297.5, y: 324.7, width: 1022, height: 64.1 }, 2, 'the second row');

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

  // The role is a word, and the sites are every site: the shared ones for a guest.
  await expect(cells(page, 'Ana (you)')).toHaveText(['AAna (you)ana@acme.dev', 'Owner', 'Every site', '2 Jun 2026']);
  await expect(tom.nth(1)).toHaveText('Admin');
  await expect(tom.nth(2)).toHaveText('Every site');
  await expect(tom.nth(3)).toHaveText('14 Jul 2026Remove');
  await expect(cells(page, 'Nora').nth(1)).toHaveText('Member');
  await expect(cells(page, 'Inès Morel').nth(1)).toHaveText('Guest');
  await expect(cells(page, 'Inès Morel').nth(2)).toHaveText('Shared ones');
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
  expectBox(await box(resend), { x: 1187, y: 531, width: 50.2 }, 2, '« Resend »');
  expectBox(await box(cancel), { x: 1253.2, y: 531, width: 46.3 }, 2, '« Cancel »');
  await resend.hover();
  expect.soft(await painted(resend, 'color')).toEqual(rgb(ACCENT_STRONG));
  await page.mouse.move(700, 800);

  // What each role does, under the table. A guest is on the screen, so what a guest does is said.
  const legend = page.locator('main dl');
  expect
    .soft(await styles(legend, ['margin-top', 'column-gap', 'row-gap', 'font-size', 'line-height', 'display']))
    .toEqual({
      'margin-top': '28px',
      'column-gap': '32px',
      'row-gap': '16px',
      'font-size': '14px',
      'line-height': '21px',
      display: 'grid',
    });
  await expect(legend.locator('dt')).toHaveText(['Admin', 'Member', 'Guest']);
  await expect(legend.locator('dd')).toHaveText([
    'Sites, connectors and members.',
    'Every site. Sees the links to the tracker.',
    'Only the sites shared with them. Free, and never sees the tracker.',
  ]);
  expect.soft(await styles(legend.locator('dt').first(), ['font-weight'])).toEqual({ 'font-weight': '600' });
  expect.soft(await styles(legend.locator('dd').first(), ['margin-top'])).toEqual({ 'margin-top': '2px' });
  expect.soft(await painted(legend.locator('dd').first(), 'color')).toEqual(rgb(MUTED));
  expectBox(await box(legend), { x: 296.5, y: 610.7, width: 1024, height: 65 }, 2, 'the legend');
  expectBox(await box(legend.locator('> div').nth(1)), { x: 648.5, width: 320 }, 2, 'the second role of the legend');

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
  expectBox(await box(form(page)), { x: 296.5, y: 126.2, width: 1024, height: 66 }, 2, 'the form');
  expectBox(await box(email(page)), { x: 296.5, y: 148.2, height: 44 }, 2, 'the field');
  expectBox(await box(roles(page)), { x: 1025.1, y: 148.2, width: 200.3, height: 44 }, 2, 'the list of roles');
  expectBox(await box(invite(page)), { x: 1235.3, y: 148.2, width: 85.2, height: 44 }, 2, '« Invite »');

  // An invitation is for a member or an admin: no guest of one site, and no list of sites.
  await roles(page).click();
  await expect(page.getByRole('option')).toHaveText(['Member', 'Admin']);
  await page.waitForTimeout(250);
  const opened = await new AxeBuilder({ page }).analyze();
  expect
    .soft(opened.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`))
    .toEqual([]);
  await page.getByRole('option', { name: 'Admin' }).click();
  await expect(form(page).getByText('Site', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Guest, one site')).toHaveCount(0);

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
  // Nobody is a guest here, and nobody can be invited as one yet: what a guest does is not said.
  await expect(page.locator('main dt')).toHaveText(['Admin', 'Member']);
  await expectNoViolation(page, 'the screen of a member');

  // A guest: the worker refuses them the list, so the screen asks for none and draws their row.
  await page.unrouteAll();
  const refused = await workerWith(page, { role: 'guest' });
  await open(page);
  await expect(table(page).locator('thead th')).toHaveText(['Person', 'Role', 'Sites']);
  await expect(table(page).locator('tbody tr')).toHaveCount(1);
  await expect(table(page).locator('tbody td')).toHaveText(['AAna (you)ana@acme.dev', 'Guest', 'Shared ones']);
  await expect(page.getByRole('form')).toHaveCount(0);
  await expect(page.locator('main dt')).toHaveText(['Admin', 'Member', 'Guest']);
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
  // One role under the other, each as wide as the screen allows.
  const legend = page.locator('main dl');
  expectBox(await box(legend), { x: 16, y: top + 786.7 - less, width: 358, height: 185 }, 4, 'the legend');
  expectBox(await box(legend.locator('> div').nth(1)), { x: 16, y: top + 846.7 - less, width: 358 }, 4, 'a role');
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
    ['a role of the legend', page.locator('main dt').first()],
    ['what a role does', page.locator('main dd').first()],
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

import AxeBuilder from '@axe-core/playwright';
import { type BrowserContext, type Locator, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, served } from './cloud-worker.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * An invited reviewer, from the message they received to their first note (FRU-104).
 *
 * Two people, two browsers: the owner makes a workspace and a site, and invites Paul by his address.
 * Paul opens the link of the message, signs in with that address, joins, and connects his browser.
 * The worker is a process of this spec on PGlite (`cloud-worker.ts`), and each message is read where
 * the worker was asked to send it.
 *
 * **The note is sent as the extension sends it**, with the session that the pairing code of the
 * console opens: this spec loads no extension. `extension.spec.ts` holds the extension itself, from
 * the pairing page to the note, against the worker of the playground.
 */

const SITE = 'https://staging.acme.dev';

/** The last message sent to `to`. */
async function lastTo(worker: Worker, to: string): Promise<string> {
  let found: string | undefined;
  await expect
    .poll(async () => {
      found = (await worker.mail()).filter((each) => each.to === to).at(-1)?.text;

      return found !== undefined;
    })
    .toBe(true);

  return found as string;
}

/**
 * Signs `email` in by the link of the setup, in this browser. Somebody with no workspace and no
 * invitation gets one named after their address (FRU-239): « Acme » for `owner@acme.dev`.
 */
async function signIn(page: Page, worker: Worker, email: string): Promise<void> {
  const before = (await worker.mail()).filter((each) => each.to === email).length;
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.mail()).filter((each) => each.to === email).length).toBe(before + 1);
  const link = /http:\/\/\S+\/sign-in#\S+/.exec(await lastTo(worker, email))?.[0];
  expect(link, 'no sign-in link in the message').toBeDefined();
  await page.goto(link as string);
}

test.describe('an invited reviewer (FRU-104)', () => {
  let worker: Worker;
  const contexts: BrowserContext[] = [];

  test.beforeEach(async () => {
    worker = await cloudWorker();
  });
  test.afterEach(async () => {
    for (const context of contexts.splice(0)) {
      await finished(context, undefined);
      await context.close();
    }
    await worker.close();
  });

  test('goes from the link of the message to their first note, and sees what a member sees', async ({ browser }) => {
    const owners = await browser.newContext({ locale: 'en-US' });
    const pauls = await browser.newContext({ locale: 'en-US' });
    contexts.push(owners, pauls);
    await served(owners, worker);
    await served(pauls, worker);
    const owner = await owners.newPage();
    const paul = await pauls.newPage();

    // The owner: a workspace, a site, and an invitation.
    await signIn(owner, worker, 'owner@acme.dev');
    // The second step of the setup adds the site, and the front door then leads to the sites.
    await expect(owner.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    await owner.getByRole('textbox', { name: 'Site address' }).fill(SITE);
    await owner.getByRole('button', { name: 'Add site' }).click();
    await expect(owner.getByRole('heading', { name: 'Current step: Put it on the site' })).toBeVisible();
    await owner.goto(CONSOLE);
    await expect(owner).toHaveURL(/\/w\/ws_[0-9a-f]{20}\/sites$/);
    const workspace = /\/w\/(ws_[0-9a-f]{20})\//.exec(owner.url())?.[1] as string;
    await expect(owner.getByText('https://staging.acme.dev', { exact: true })).toBeVisible();

    await owner.goto(`${CONSOLE}/w/${workspace}/members`);
    await owner.getByRole('textbox', { name: 'Email', exact: true }).fill('paul@client.dev');
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    const kept = owner.getByRole('status');
    await expect(kept).toContainText('Invitation sent to paul@client.dev.');
    // The link to send by hand is the one of the message: it names no invitation (FRU-107).
    await expect(kept).toContainText(`${CONSOLE}/invitations`);
    await expect(owner.getByText('paul@client.dev', { exact: true })).toBeVisible();
    await expect(owner.getByText('Invitation sent', { exact: true })).toBeVisible();

    // Paul: the message names the workspace, and its link holds nothing to spend.
    const message = await lastTo(worker, 'paul@client.dev');
    // The names a person wrote hold a zero-width space after each `.` and `@`: no client links them.
    expect(message.replaceAll('\u200B', '')).toContain(
      'owner@acme.dev invites you to the workspace « Acme » on Fruitback, as a member.',
    );
    const link = /http:\/\/\S+/.exec(message)?.[0];
    expect(link).toBe(`${CONSOLE}/invitations`);

    await paul.goto(link as string);
    await expect(
      paul.getByText('Sign in with the address the invitation was sent to, and it shows here.'),
    ).toBeVisible();
    await paul.getByRole('link', { name: 'Sign in' }).click();
    await expect(paul).toHaveURL(`${CONSOLE}/sign-in`);
    // No workspace name: Paul comes to join one.
    await signIn(paul, worker, 'paul@client.dev');
    await expect(paul).toHaveURL(`${CONSOLE}/invitations`);
    // The screen of the invitation (FRU-241): who invites, the role, and the address that joins.
    await expect(paul.getByRole('heading', { name: 'Join Acme on Fruitback' })).toBeVisible();
    await expect(paul.getByText('Acme invited you')).toBeVisible();
    await expect(paul.getByText('You join as a member: you see and leave notes on every site of Acme.')).toBeVisible();
    await expect(paul.locator('dl')).toHaveText('Signed in aspaul@client.devRoleMember');
    await paul.getByRole('button', { name: 'Join Acme' }).click();
    // Joined: the screen says so, names the site of the workspace, and leads to the console.
    await expect(paul.getByRole('heading', { name: 'You are in' })).toBeVisible();
    await expect(paul.getByRole('status')).toHaveText(
      'One more thing: the extension shows the notes on https://staging.acme.dev and lets you leave yours.',
    );
    await expect(paul.getByRole('link', { name: 'Open https://staging.acme.dev' })).toHaveAttribute('href', SITE);
    await paul.getByRole('link', { name: 'Go to the console' }).click();
    await expect(paul).toHaveURL(`${CONSOLE}/w/${workspace}/sites`);
    await expect(paul.getByText('https://staging.acme.dev', { exact: true })).toBeVisible();

    // The owner sees Paul as a member, and the invitation is gone.
    await owner.reload();
    await expect(owner.getByText('paul@client.dev', { exact: true })).toBeVisible();
    await expect(owner.getByText('Invitation sent', { exact: true })).toHaveCount(0);

    // Paul connects his browser: the pairing page opens with a code after the `#`.
    // « Install » is in the menu of the row of the site, for a member too (FRU-243).
    await paul.getByRole('button', { name: 'More for https://staging.acme.dev' }).click();
    await paul.getByRole('menuitem', { name: 'Install' }).click();
    const opened = pauls.waitForEvent('page');
    await paul.getByRole('button', { name: 'Connect this browser' }).click();
    const pairing = await opened;
    await pairing.waitForURL(/\/pair#/);
    const code = new URL(pairing.url()).hash.slice(1);
    expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // What the extension does with that code, then with its session: pair, list the sites, send a note.
    const paired = (await (
      await fetch(`${worker.origin}/session/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    ).json()) as { accessToken: string; identity: { email?: string; workspace?: string } };
    expect(paired.identity).toMatchObject({ email: 'paul@client.dev', workspace });
    const bearer = { Authorization: `Bearer ${paired.accessToken}` };
    const sites = (await (await fetch(`${worker.origin}/session/sites`, { headers: bearer })).json()) as {
      sites: { id: string; origin: string }[];
    };
    const site = sites.sites.find((each) => each.origin === SITE);
    expect(site, 'Paul does not reach the site of the workspace').toBeDefined();

    const note = {
      kind: 'fruitback.seed',
      v: 2,
      id: 'sd_paul_first',
      createdAt: new Date().toISOString(),
      note: 'The button is too small on a phone.',
      page: { url: `${SITE}/pricing`, path: '/pricing' },
      viewport: { width: 1440, height: 900 },
      anchor: { selector: 'main > button', tag: 'button', bounds: { xPct: 40, yPct: 60, wPct: 12, hPct: 4 } },
      client: { id: site?.id },
    };
    const written = await fetch(`${worker.origin}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE, ...bearer },
      body: JSON.stringify(note),
    });
    expect(written.status, await written.clone().text()).toBe(201);

    // The note is Paul's, and the worker vouches for it.
    const read = (await (
      await fetch(`${worker.origin}/feedback?url=${encodeURIComponent(`${SITE}/pricing`)}&client=${site?.id}`, {
        headers: { Origin: SITE, ...bearer },
      })
    ).json()) as { issues?: { seed: { note: string; reporter?: { email?: string; verified?: boolean } } }[] };
    const mine = (read.issues ?? []).find((each) => each.seed.note === note.note);
    expect(mine?.seed.reporter).toMatchObject({ email: 'paul@client.dev', verified: true });
  });

  test('says that the fourth message did not go, and gives the link to send by hand (FRU-209)', async ({ browser }) => {
    const owners = await browser.newContext({ locale: 'en-US' });
    contexts.push(owners);
    await served(owners, worker);
    const owner = await owners.newPage();
    await signIn(owner, worker, 'owner@acme.dev');
    await expect(owner.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    // The workspace has no site, so the front door leads back to the setup: its id is read where
    // the worker received it.
    const workspace = (await worker.received())
      .map((each) => /^\/console\/workspaces\/(ws_[0-9a-f]{20})\/sites$/.exec(each.path)?.[1])
      .findLast((id) => id !== undefined) as string;
    expect(workspace).toMatch(/^ws_[0-9a-f]{20}$/);
    const toPaul = async (): Promise<number> =>
      (await worker.mail()).filter((each) => each.to === 'paul@client.dev').length;

    await owner.goto(`${CONSOLE}/w/${workspace}/members`);
    await owner.getByRole('textbox', { name: 'Email', exact: true }).fill('paul@client.dev');
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    const notice = owner.getByRole('status');
    await expect(notice).toContainText('Invitation sent to paul@client.dev.');
    // Two more messages go: three in the window of this workspace for this address.
    for (const sent of [2, 3]) {
      await owner.getByRole('button', { name: 'Resend' }).click();
      await expect.poll(toPaul).toBe(sent);
      await expect(notice).toContainText('Invitation sent to paul@client.dev.');
    }

    // The fourth is kept and not sent: the worker answers `mailed: false`, and the console says so.
    await owner.getByRole('button', { name: 'Resend' }).click();
    await expect(notice).toContainText('Invitation kept for paul@client.dev, but no message was sent');
    await expect(notice).toContainText(`${CONSOLE}/invitations`);
    await expect(notice.getByRole('button', { name: 'Copy the link' })).toBeVisible();
    expect(await toPaul()).toBe(3);
    await expect(owner.getByText('Invitation sent', { exact: true })).toBeVisible();
  });
});

/** What the worker answers about the invitations of the person, for the second part: stubs. */
type Stub = {
  as?: 'nobody' | 'somebody';
  invitations?:
    | {
        id: string;
        role: string;
        organizationId: string;
        organizationName: string;
        createdAt: string;
        sites?: { id: string; origin: string }[];
      }[]
    | 'failed';
  /** What the worker answers to « Join » and to « Decline ». */
  answer?: { status: number; body: unknown };
  /** `failed`: the worker refuses the list. `lost`: the request does not arrive. */
  sites?: string[] | 'failed' | 'lost';
  signsOut?: boolean;
  locale?: 'en' | 'fr';
};

/**
 * The sample words are as wide as the mockup's in the system font, without copying its sample data:
 * « Havane » for the workspace. The address is the mockup's own example, which is on `main` already.
 */
const INVITED = 'camille@acme.dev';
const HAVANE = {
  id: 'i1',
  role: 'member',
  organizationId: 'w1',
  organizationName: 'Havane',
  createdAt: '2026-10-12T08:00:00.000Z',
};

async function stubWorker(page: Page, stub: Stub = {}): Promise<string[]> {
  const asked: string[] = [];
  let signedIn = stub.as !== 'nobody';
  await page.context().route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    asked.push(`${request.method()} ${pathname}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: false, google: false } });
    if (pathname === '/console/me') {
      return signedIn
        ? json({ account: { id: 'a1', email: INVITED, name: 'Camille', locale: stub.locale ?? 'en' }, workspaces: [] })
        : json({ error: 'identity-required' }, 401);
    }
    if (pathname.endsWith('/list-user-invitations')) {
      if (stub.invitations === 'failed') return json({ error: 'unavailable' }, 503);

      return json(
        (stub.invitations ?? [HAVANE]).map((each) => ({
          ...each,
          email: INVITED,
          status: 'pending',
          expiresAt: '2026-12-01T08:00:00.000Z',
        })),
      );
    }
    if (pathname.endsWith('/accept-invitation') || pathname.endsWith('/reject-invitation')) {
      return json(stub.answer?.body ?? {}, stub.answer?.status ?? 200);
    }
    if (pathname === '/console/workspaces/w1/sites') {
      if (stub.sites === 'failed') return json({ error: 'unavailable' }, 503);
      if (stub.sites === 'lost') return route.abort('connectionfailed');

      return json({
        sites: (stub.sites ?? []).map((origin, index) => ({ id: `s${index}`, origin, visibility: 'members' })),
      });
    }
    if (pathname === '/console/auth/sign-out') {
      if (stub.signsOut === false) return json({ error: 'unavailable' }, 503);
      signedIn = false;

      return json({ success: true });
    }

    return route.fulfill({ status: 404, json: { error: 'not-found' } });
  });

  return asked;
}

type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = (await locator.first().boundingBox()) as Box;
  const round = (value: number) => Math.round(value * 10) / 10;

  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

/**
 * The mockup is measured in the system font of macOS: a line of text with no line height of its own
 * is 1 or 2 px taller in the system font of Linux, which the CI draws, and a word is not as wide.
 * So the boxes are compared where the font is the mockup's. Everything else is measured everywhere.
 */
const FONT_OF_THE_MOCKUP = process.platform === 'darwin';

function expectNear(built: Box, mockup: Box, name: string, tolerance = 2): void {
  if (!FONT_OF_THE_MOCKUP) return;
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    expect
      .soft(Math.abs(built[side] - mockup[side]), `${name}: ${side} is ${built[side]}, the mockup has ${mockup[side]}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

const violations = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).analyze()).violations.map(
    (violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`,
  );

test.describe('the screen of an invitation, against the mockup (FRU-241)', () => {
  // The boxes of the mockup at 1440 × 900, read in its `measures.json`. Its title has two lines and
  // its list three rows, for a guest of one site (the next test): a member's title has one line
  // (32.2 px less) and the list two rows (43 px less).
  test('the invitation: the boxes of the mockup at 1440 px, less what a guest of one site adds', async ({ page }) => {
    await stubWorker(page);
    await page.goto(`${CONSOLE}/invitations`);
    const join = page.getByRole('button', { name: 'Join Havane' });
    await expect(join).toBeVisible();

    expectNear(
      await boxOf(page.getByRole('img', { name: 'Fruitback' })),
      { x: 80, y: 21, width: 113, height: 22 },
      'logo',
    );
    expectNear(await boxOf(page.locator('.kit-avatar')), { x: 500, y: 155, width: 28, height: 28 }, 'avatar');
    const title = page.getByRole('heading', { level: 1 });
    await expect(title).toHaveText('Join Havane on Fruitback');
    expectNear(await boxOf(title), { x: 500, y: 203, width: 440, height: 32.2 }, 'title');
    expectNear(await boxOf(join), { x: 500, y: 507 - 32.2 - 43, width: 440, height: 44 }, '« Join »');
    await expect(page.locator('dl > div')).toHaveCount(2);
    await expect(page.locator('dl')).toHaveText(`Signed in as${INVITED}RoleMember`);
    // The line under the button says nothing of a link that signs in: the link of an invitation
    // signs nobody in (the decision on that is open, Q2 of FRU-230).
    await expect(page.getByText(`Not ${INVITED}?`)).toBeVisible();
    await expect(page.getByText(/signed you in/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Decline' })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  // The state the mockup draws (FRU-250): a guest of one site, the title on two lines, three rows.
  test('the invitation of a guest of one site: the boxes, the words and the row « Site » of the mockup', async ({
    page,
  }) => {
    await stubWorker(page, {
      invitations: [{ ...HAVANE, role: 'guest', sites: [{ id: 's1', origin: 'https://staging.acme.dev' }] }],
    });
    await page.goto(`${CONSOLE}/invitations`);
    const join = page.getByRole('button', { name: 'Join Havane' });
    await expect(join).toBeVisible();

    const title = page.getByRole('heading', { level: 1 });
    await expect(title).toHaveText('Review https://staging.acme.dev with Havane');
    expectNear(await boxOf(title), { x: 500, y: 203, width: 440, height: 64.4 }, 'title');
    await expect(
      page.getByText(
        'You join as a guest: you see and leave notes on this site only. Guests are free and never see the tracker.',
      ),
    ).toBeVisible();
    await expect(page.locator('dl > div')).toHaveCount(3);
    await expect(page.locator('dl')).toHaveText(`Signed in as${INVITED}RoleGuestSitehttps://staging.acme.dev`);
    expectNear(await boxOf(join), { x: 500, y: 507, width: 440, height: 44 }, '« Join »');
    expect(await violations(page)).toEqual([]);
  });

  test('a guest who joined is sent to their site: « Open staging.acme.dev »', async ({ page }) => {
    await stubWorker(page, {
      invitations: [{ ...HAVANE, role: 'guest', sites: [{ id: 's1', origin: 'https://staging.acme.dev' }] }],
      // The worker lists to a guest the sites shared with them (FRU-250).
      sites: ['https://staging.acme.dev'],
    });
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Join Havane' }).click();
    await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open https://staging.acme.dev' })).toHaveAttribute(
      'href',
      'https://staging.acme.dev',
    );
  });

  test('joined: the boxes of the mockup at 1440 px, and the confirmation is said', async ({ page }) => {
    await stubWorker(page, { sites: ['https://staging.acme.dev'] });
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Join Havane' }).click();
    await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();

    expectNear(await boxOf(page.locator('.kit-success')), { x: 504, y: 155, width: 40, height: 40 }, 'success mark');
    expectNear(
      await boxOf(page.getByRole('heading', { level: 1 })),
      { x: 500, y: 219, width: 440, height: 32.2 },
      'title',
    );
    // The sentence of the mockup has three lines; without « It signs in with this account. » it has
    // two, so what follows is 24 px higher.
    const status = page.getByRole('status');
    await expect(status).toHaveText(
      'One more thing: the extension shows the notes on https://staging.acme.dev and lets you leave yours.',
    );
    expectNear(await boxOf(status), { x: 500, y: 261, width: 440, height: 48 }, 'confirmation');
    const add = page.getByRole('link', { name: 'Install the extension (beta)' });
    // « Install the extension (beta) » (FRU-318) and « Open https://… » (FRU-314) are longer than the
    // words of the mockup: the link to the site goes under the button.
    expectNear(await boxOf(add), { x: 500, y: 361 - 24, width: 244.3, height: 44 }, '« Install the extension (beta) »');
    expectNear(
      await boxOf(page.getByRole('link', { name: 'Open https://staging.acme.dev' })),
      { x: 500, y: 391.2, width: 208.8, height: 41 },
      '« Open the site »',
    );
    expectNear(
      await boxOf(page.getByRole('link', { name: 'Install it in Firefox (beta)' })),
      { x: 595, y: 481.2, width: 164.1, height: 17 },
      'Firefox',
    );
    // The extension is in no store yet: both links lead to the page that says how to install it.
    for (const link of [add, page.getByRole('link', { name: 'Install it in Firefox (beta)' })]) {
      await expect(link).toHaveAttribute('href', 'https://fruitback.com/reviewing.html#1-install-it');
      await expect(link).toHaveAttribute('target', '_blank');
    }
    await expect(page.getByText(/signs in with this account/)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveAttribute('href', '/w/w1/sites');
    expect(await violations(page)).toEqual([]);
  });

  test('joined a workspace with no site: the sentence names the workspace, and nothing opens a site', async ({
    page,
  }) => {
    await stubWorker(page, { sites: [] });
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Join Havane' }).click();

    await expect(page.getByRole('status')).toHaveText(
      'One more thing: the extension shows the notes on the sites of Havane and lets you leave yours.',
    );
    await expect(page.getByRole('link', { name: /^Open / })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveCount(1);
  });

  for (const sites of ['failed', 'lost'] as const) {
    test(`joined, and the sites cannot be read (${sites}): « You are in » all the same, and nothing stays busy`, async ({
      page,
    }) => {
      const asked = await stubWorker(page, { sites });
      await page.goto(`${CONSOLE}/invitations`);
      await page.getByRole('button', { name: 'Join Havane' }).click();

      // The invitation is accepted: the screen says so, and names no site it could not read.
      await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();
      await expect(page.getByRole('status')).toHaveText(
        'One more thing: the extension shows the notes on the sites of Havane and lets you leave yours.',
      );
      await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveCount(1);
      expect(asked).toContain('GET /console/workspaces/w1/sites');
    });
  }

  test('several invitations: the most recent on the screen, the others under it, each to join or decline', async ({
    page,
  }) => {
    const asked = await stubWorker(page, {
      invitations: [
        {
          ...HAVANE,
          id: 'old',
          organizationName: 'Lumen',
          organizationId: 'w2',
          createdAt: '2026-10-01T08:00:00.000Z',
        },
        HAVANE,
        {
          ...HAVANE,
          id: 'older',
          role: 'admin',
          organizationName: 'Client',
          organizationId: 'w3',
          createdAt: '2026-09-01T08:00:00.000Z',
        },
      ],
    });
    await page.goto(`${CONSOLE}/invitations`);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Join Havane on Fruitback');
    const more = page.getByRole('region', { name: '2 more invitations' });
    await expect(more.getByRole('listitem')).toHaveText([/^LumenMember/, /^ClientAdmin/]);
    await more.getByRole('listitem').filter({ hasText: 'Client' }).getByRole('button', { name: 'Decline' }).click();
    await expect(page.getByRole('region', { name: 'One more invitation' }).getByRole('listitem')).toHaveText([
      /^LumenMember/,
    ]);
    expect(asked.filter((each) => each.includes('reject-invitation'))).toHaveLength(1);
    expect(await violations(page)).toEqual([]);
  });

  test('an invitation that ended says so, and stays on the screen', async ({ page }) => {
    await stubWorker(page, { answer: { status: 400, body: { code: 'INVITATION_NOT_FOUND' } } });
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Join Havane' }).click();

    await expect(page.getByRole('alert')).toHaveText(
      'This invitation was cancelled, or it ended. Ask for another one.',
    );
    await expect(page.getByRole('button', { name: 'Join Havane' })).toBeEnabled();
  });

  test('« Use another address » ends the session and leads to the sign-in, or says that it did not', async ({
    page,
  }) => {
    // The worker does not end the session: the screen stays, and says so.
    await stubWorker(page, { signsOut: false });
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Use another address' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'You are still signed in: Fruitback did not confirm the sign-out. Try again.',
    );
    await expect(page.getByRole('button', { name: 'Join Havane' })).toBeVisible();

    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    const asked = await stubWorker(page);
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Use another address' }).click();
    await expect(page).toHaveURL(`${CONSOLE}/sign-in`);
    await expect(page.getByRole('heading', { name: 'Sign in to Fruitback' })).toBeVisible();
    expect(asked).toContain('POST /console/auth/sign-out');
  });

  test('nobody signed in, no invitation, and a worker that did not answer each have their sentence', async ({
    page,
  }) => {
    await stubWorker(page, { as: 'nobody' });
    await page.goto(`${CONSOLE}/invitations`);
    await expect(
      page.getByText('Sign in with the address the invitation was sent to, and it shows here.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
    expect(await violations(page)).toEqual([]);

    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    await stubWorker(page, { invitations: [] });
    await page.goto(`${CONSOLE}/invitations`);
    await expect(
      page.getByText(
        `No invitation waits for ${INVITED}. An invitation sent to another address shows to that address only.`,
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveAttribute('href', '/');

    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    await stubWorker(page, { invitations: 'failed' });
    await page.goto(`${CONSOLE}/invitations`);
    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Your invitations are not lost.');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  for (const locale of ['en', 'fr'] as const) {
    test(`the invitation and « You are in » fit a phone, in ${locale}`, async ({ browser }) => {
      const context = await browser.newContext({
        locale: locale === 'en' ? 'en-US' : 'fr-FR',
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      const long = 'A workspace with a very long name that somebody typed in a hurry';
      await stubWorker(page, {
        locale,
        invitations: [{ ...HAVANE, organizationName: long }],
        sites: ['https://preview-branch-feature-very-long-name-1234.staging.acme.dev'],
      });
      await page.goto(`${CONSOLE}/invitations`);
      const join = page.getByRole('button', { name: locale === 'en' ? `Join ${long}` : `Rejoindre ${long}` });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const sideScroll = () =>
        page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect.soft(await sideScroll(), `the invitation scrolls sideways at ${width} px`).toBe(0);
      }
      await join.click();
      await expect(page.getByRole('status')).toBeVisible();
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        expect.soft(await sideScroll(), `« You are in » scrolls sideways at ${width} px`).toBe(0);
      }
      await context.close();
    });
  }
});

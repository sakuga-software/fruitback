import { type BrowserContext, type Page, expect, test } from '@playwright/test';
import { CONSOLE, SESSION_COOKIE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The console signs in with the cookie of a session of better-auth (FRU-148), from the sign-in
 * screen to the list of the sites, against a worker whose accounts are in PostgreSQL (PGlite).
 *
 * The worker is a process of this spec, and answers each request the console sends to the address of
 * the worker: no stub decides an answer. The link is read where the worker was asked to send it, in the
 * mail, and never in the database.
 */
/**
 * From the setup to the list of the sites, by a link. Answers the id of the workspace.
 *
 * The workspace takes its name from the address (FRU-239): « Acme » for `…@acme.dev`. A workspace
 * with no site goes back to the setup from the front door, so the Sites screen is opened by its
 * address.
 */
async function signInByLink(page: Page, worker: Worker, email: string): Promise<string> {
  await page.goto(`${CONSOLE}/setup`);
  await page.getByRole('textbox', { name: 'Work email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a link' }).click();
  await expect.poll(async () => (await worker.sent()).length).toBe(1);

  await page.goto(await linkIn(worker));
  // The link signs in, the workspace is made, and the setup is at its second step.
  await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
  const workspace = await workspaceOf(worker);
  await page.goto(`${CONSOLE}/w/${workspace}/sites`);
  await expect(page.getByRole('heading', { name: 'Sites', level: 1 })).toBeVisible();
  // The list was read: the title is there before the answer, and a test starts from a screen at rest.
  await expect(page.getByRole('heading', { name: 'No site yet' })).toBeVisible();

  return workspace;
}

/**
 * My account, at rest: the list of the browsers is read.
 *
 * WARNING: the list arrives after the screen is drawn, and « Sign out » is under it: the button goes
 * down 53 px when it does. A press that starts before and ends after is lost: the button has focus,
 * nothing is sent, and the page stays. Measured on `main` at 30c62f8, where this spec failed for it.
 */
async function openAccount(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'My account' }).click();
  // The row of this browser: the worker names it by its user agent (FRU-249).
  await expect(
    page.getByRole('region', { name: 'Where you are signed in' }).getByText('This browser', { exact: true }),
  ).toBeVisible();
}

/** The id of the workspace the console last read the sites of, as the worker received it. */
async function workspaceOf(worker: Worker): Promise<string> {
  const read = (await worker.received())
    .map((each) => /^\/console\/workspaces\/(ws_[0-9a-f]{20})\/sites$/.exec(each.path)?.[1])
    .filter((id) => id !== undefined);
  expect(read.length, 'the console read the sites of no workspace').toBeGreaterThan(0);

  return read.at(-1) as string;
}

test.describe('the console, signed in by the cookie of better-auth (FRU-148)', () => {
  let worker: Worker;

  test.beforeEach(async ({ page }) => {
    worker = await cloudWorker();
    await served(page, worker);
  });
  test.afterEach(({ page }) => finished(page, worker));

  test('goes from the sign-in screen to the sites by a link, and holds no token anywhere a script reads', async ({
    page,
    context,
  }) => {
    await signInByLink(page, worker, 'ana@acme.dev');

    // The token of the link was sent in a body, and is in no address the worker received.
    const token = (await linkIn(worker)).split('#')[1] as string;
    const received = await worker.received();
    expect(received.some((each) => each.path.includes(token))).toBe(false);
    expect(received.map((each) => each.path)).toContain('/console/auth/email/redeem');
    // No call had a token: the cookie is all the worker was given.
    expect(received.filter((each) => each.authorization)).toEqual([]);
    expect(received.some((each) => each.path === '/console/me' && each.cookie)).toBe(true);

    // The control first: the browser holds the cookie of the session, where no script reads it.
    const cookie = (await context.cookies(`${WORKER_ORIGIN}/console/me`)).find((each) => each.name === SESSION_COOKIE);
    expect(cookie, 'the browser holds no cookie of a session: nothing below is tested').toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/console' });
    const value = decodeURIComponent(cookie?.value ?? '').split('.')[0] as string;
    expect(value.length).toBeGreaterThan(20);

    const held = await page.evaluate(() => ({
      cookie: document.cookie,
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
    }));
    expect(held.cookie).not.toContain('session_token');
    for (const store of [held.cookie, held.local, held.session]) {
      expect(store).not.toContain(value);
      expect(store).not.toContain(token);
    }

    // A site added from the list, with the cookie: a change, from the origin of the console.
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    await page.getByRole('button', { name: 'Add site', exact: true }).click();
    await expect(page.getByText('https://staging.acme.dev', { exact: true })).toBeVisible();
  });

  test('takes the token of a link out of the address bar, for a link that works and for one that does not (FRU-207)', async ({
    page,
  }) => {
    // A link that opens nothing: the screen stays, and the address it shows holds no token. A reload,
    // a shared screen or the history would show it.
    const spent = 'a-token-of-a-link-that-opens-nothing';
    await page.goto(`${CONSOLE}/sign-in#${spent}`);
    await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
    expect(page.url()).toBe(`${CONSOLE}/sign-in`);
    // The control: the worker is asked with that token, so the screen read it before it took it away.
    // Asked for, and not read at once: in development React runs the effect twice, and the second run
    // finds no token and draws this screen before the first call reaches the worker.
    await expect
      .poll(async () => (await worker.received()).map((each) => each.path))
      .toContain('/console/auth/email/redeem');

    // A link that works, held while the worker answers: the token is gone before the answer.
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(1);
    const link = await linkIn(worker);
    const token = link.split('#')[1] as string;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const redeem = `${WORKER_ORIGIN}/console/auth/email/redeem`;
    await page.route(redeem, async (route) => {
      await held;
      await route.fallback();
    });
    const asked = page.waitForRequest(redeem);
    await page.goto(link);
    await asked;
    expect(page.url()).toBe(`${CONSOLE}/sign-in`);
    expect(await page.evaluate(() => window.location.href)).not.toContain(token);
    release();
    await expect(page).toHaveURL(/\/setup|\/sites$/);
    await page.unroute(redeem);
  });

  test('keeps what was typed when the session ended, says so, and goes on after a new sign-in', async ({
    page,
    context,
  }) => {
    await signInByLink(page, worker, 'ana@acme.dev');
    const field = page.getByRole('textbox', { name: 'Site address' });
    await field.fill('staging.acme.dev');

    // The session ends on the worker: « sign out everywhere », from another place.
    const cookies = await context.cookies(`${WORKER_ORIGIN}/console/me`);
    const ended = await fetch(`${worker.origin}/console/auth/revoke-sessions`, {
      method: 'POST',
      headers: {
        Origin: CONSOLE,
        'Content-Type': 'application/json',
        Cookie: cookies.map((each) => `${each.name}=${each.value}`).join('; '),
      },
      body: '{}',
    });
    expect(ended.status).toBe(200);

    await page.getByRole('button', { name: 'Add site', exact: true }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'Your session ended' });
    await expect(notice).toBeVisible();
    await expect(field).toHaveValue('staging.acme.dev');
    await expect(page).toHaveURL(/\/sites$/);

    // The worker does not answer « Continue »: that is not « still signed out ».
    const down = `${WORKER_ORIGIN}/console/me`;
    await page.route(down, (route) => route.abort());
    await notice.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'cannot reach its server' })).toBeVisible();
    await expect(notice).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'You are still signed out' })).toHaveCount(0);
    await page.unroute(down);

    // Still signed out: « Continue » says so, and the field keeps its text.
    await notice.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'You are still signed out' })).toBeVisible();
    await expect(field).toHaveValue('staging.acme.dev');

    // The sign-in opens in another tab, and the first tab goes on with what it had.
    const [tab] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('alert').getByRole('link', { name: 'Sign in', exact: true }).click(),
    ]);
    // The sign-in page (FRU-235): the banner no longer leads to the setup.
    await expect(tab).toHaveURL(`${CONSOLE}/sign-in`);
    await tab.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await tab.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(2);
    await tab.goto(await linkIn(worker));
    // Signed in again. The workspace has no site yet, so the front door leads to the setup.
    await expect(tab).toHaveURL(/\/setup$|\/sites$/);

    await page.getByRole('alert').getByRole('button', { name: 'Continue', exact: true }).click();
    // The notice goes. The sentence of the screen, « the site was not added », stays until the next try.
    await expect(page.getByRole('alert').filter({ hasText: /signed out|session ended/ })).toHaveCount(0);
    await expect(field).toHaveValue('staging.acme.dev');
    await page.getByRole('button', { name: 'Add site', exact: true }).click();
    await expect(page.getByText('https://staging.acme.dev', { exact: true })).toBeVisible();
  });

  test('ends the session on the worker when the person signs out', async ({ page, context }) => {
    await signInByLink(page, worker, 'ana@acme.dev');
    const before = (await context.cookies(`${WORKER_ORIGIN}/console/me`)).filter(
      (each) => each.name === SESSION_COOKIE,
    );
    expect(before).toHaveLength(1);

    await openAccount(page);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up Fruitback' })).toBeVisible();

    expect((await worker.received()).map((each) => each.path)).toContain('/console/auth/sign-out');
    // The cookie the browser held is refused by the worker, whoever presents it.
    const again = await fetch(`${worker.origin}/console/me`, {
      headers: { Origin: CONSOLE, Cookie: `${SESSION_COOKIE}=${before[0]?.value}` },
    });
    expect(again.status).toBe(401);
  });

  test('stays on the account, and says so, when the worker did not end the session (FRU-204)', async ({
    page,
    context,
  }) => {
    await signInByLink(page, worker, 'ana@acme.dev');
    const session = (await context.cookies(`${WORKER_ORIGIN}/console/me`)).find((each) => each.name === SESSION_COOKIE);
    const me = (): Promise<Response> =>
      fetch(`${worker.origin}/console/me`, {
        headers: { Origin: CONSOLE, Cookie: `${SESSION_COOKIE}=${session?.value}` },
      });
    await openAccount(page);

    // better-auth does not answer: what the worker says then (`auth-unavailable`), as the console reads it.
    const refused = `${WORKER_ORIGIN}/console/auth/sign-out`;
    await page.route(refused, (route) =>
      route.fulfill({
        status: 502,
        headers: { 'Access-Control-Allow-Origin': CONSOLE, 'Access-Control-Allow-Credentials': 'true' },
        json: { error: 'auth-unavailable' },
      }),
    );
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();

    await expect(page.getByRole('alert').filter({ hasText: 'You are still signed in' })).toBeVisible();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole('heading', { name: 'My account' })).toBeVisible();
    // The sentence is true: the cookie still opens the account.
    expect((await me()).status).toBe(200);

    await page.unroute(refused);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up Fruitback' })).toBeVisible();
    expect((await me()).status).toBe(401);
  });

  /** Another person signs in, in another tab of the same browser: the cookie is theirs from then on. */
  async function signInElsewhere(context: BrowserContext, worker: Worker, email: string, mails: number): Promise<Page> {
    const tab = await context.newPage();
    await tab.goto(`${CONSOLE}/setup`);
    await tab.getByRole('textbox', { name: 'Work email' }).fill(email);
    await tab.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(mails);
    await tab.goto(await linkIn(worker));
    await expect(tab.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();

    return tab;
  }

  /** What the worker was asked to change on the sites of a workspace. */
  const sitesWritten = async (worker: Worker): Promise<number> =>
    (await worker.received()).filter((each) => each.method === 'POST' && each.path.endsWith('/sites')).length;

  /** The screen of a tab that stopped: nothing of the person before, but what was typed, to copy. */
  async function expectStopped(page: Page, title: string): Promise<void> {
    await expect(page.getByRole('alert').getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sites', level: 1 })).toHaveCount(0);
    await expect(page.getByText('Acme')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add site', exact: true })).toHaveCount(0);
    const draft = page.getByRole('textbox', { name: 'Site address' });
    await expect(draft).toHaveValue('staging.acme.dev');
    await expect(draft).toHaveAttribute('readonly', '');
  }

  test('« Continue » sends nothing when another account signed in, and keeps what was typed to copy (FRU-210)', async ({
    page,
    context,
  }) => {
    await signInByLink(page, worker, 'ana@acme.dev');
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    // The session of Ana ends, as in the case above, and her next call shows the banner.
    const cookies = await context.cookies(`${WORKER_ORIGIN}/console/me`);
    await fetch(`${worker.origin}/console/auth/revoke-sessions`, {
      method: 'POST',
      headers: {
        Origin: CONSOLE,
        'Content-Type': 'application/json',
        Cookie: cookies.map((each) => `${each.name}=${each.value}`).join('; '),
      },
      body: '{}',
    });
    await page.getByRole('button', { name: 'Add site', exact: true }).click();
    const notice = page.getByRole('alert').filter({ hasText: 'Your session ended' });
    await expect(notice).toBeVisible();
    const written = await sitesWritten(worker);

    // Bob signs in in another tab, and somebody presses « Continue » on the screen of Ana.
    const other = await signInElsewhere(context, worker, 'bob@client.fr', 2);
    await notice.getByRole('button', { name: 'Continue', exact: true }).click();

    await expectStopped(page, 'Another account is signed in in this browser');
    expect(await sitesWritten(worker)).toBe(written);
    // The one way on loads the console for whoever is signed in now.
    await page.getByRole('button', { name: 'Load the console again', exact: true }).click();
    // The workspace of Bob, named after his address, has no site yet: the front door leads to the
    // setup, at its second step.
    await expect(page.getByRole('heading', { name: 'Current step: Your site' })).toBeVisible();
    await expect(page.getByText('Client', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Site address' })).toHaveValue('');
    await other.close();
  });

  test('a tab that comes back stops when another account signed in, or when its session ended elsewhere (FRU-210)', async ({
    page,
    context,
  }) => {
    const workspace = await signInByLink(page, worker, 'ana@acme.dev');
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    /** The tab is shown again: what a browser tells a page when somebody comes back to it. */
    const comesBack = (tab: Page) => tab.evaluate(() => void window.dispatchEvent(new Event('focus')));

    // The control: the tab comes back and nothing changed. The screen stays.
    await comesBack(page);
    await expect(page.getByRole('textbox', { name: 'Site address' })).toHaveValue('staging.acme.dev');
    await expect(page.getByRole('heading', { name: 'Sites', level: 1 })).toBeVisible();

    // In a second tab Ana signs out, and Bob signs in.
    const second = await context.newPage();
    await second.goto(`${CONSOLE}/w/${workspace}/sites`);
    await openAccount(second);
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Set up Fruitback' })).toBeVisible();
    await second.close();
    const other = await signInElsewhere(context, worker, 'bob@client.fr', 2);

    await comesBack(page);
    await expectStopped(page, 'Another account is signed in in this browser');
    expect(await sitesWritten(worker)).toBe(0);
    await other.close();
  });

  test('a tab that comes back after a sign-out elsewhere shows nothing of its person (FRU-210)', async ({
    page,
    context,
  }) => {
    const workspace = await signInByLink(page, worker, 'ana@acme.dev');
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    const second = await context.newPage();
    await second.goto(`${CONSOLE}/w/${workspace}/sites`);
    await openAccount(second);
    await second.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(second.getByRole('heading', { name: 'Set up Fruitback' })).toBeVisible();
    await second.close();

    await page.evaluate(() => void window.dispatchEvent(new Event('focus')));

    await expectStopped(page, 'You were signed out');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Fruitback' })).toBeVisible();
  });
});

import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import {
  ACME,
  LUMEN,
  type Role,
  type StubbedWorkspace,
  contrast,
  painted,
  rgb,
  sideScroll,
} from './console-workspace.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * « Connect this browser » (FRU-240), screen 04 of the mockup of 2026-10-13, against a worker
 * answered by stubs that keeps the state of each request as the worker of FRU-238 does: pending,
 * approved, refused, claimed, expired. The end-to-end path, with a real worker and its claim, is in
 * `console-connect-worker.spec.ts`.
 *
 * The sample data is of nobody: `acme.dev`, invented names.
 */
const CONSOLE = 'http://localhost:5178';
const EMAIL = 'ana@acme.dev';

/** The mockup is measured in the system font of macOS: a box is compared there only. */
const FONT_OF_THE_MOCKUP = process.platform === 'darwin';

type Request = {
  word: string;
  browser: string;
  state: 'pending' | 'approved' | 'refused' | 'claimed' | 'expired';
  /** The account that answered it. */
  by?: string;
};

type Worker = {
  signedIn: boolean;
  /** The worker does not answer. */
  silent: boolean;
  workspaces: readonly StubbedWorkspace[];
  requests: Record<string, Request>;
  /** What the console asked to change, in order. */
  sent: string[];
  /** The worker ends the session when it is asked to. */
  signsOut: boolean;
  /** The account of the session: `a1` is Ana. */
  account: { id: string; email: string };
  /** What the console sent with each answer. */
  bodies: unknown[];
};

async function workerWith(page: Page, given: Partial<Worker> = {}): Promise<Worker> {
  const worker: Worker = {
    signedIn: true,
    silent: false,
    workspaces: [ACME, LUMEN],
    requests: { r1: { word: 'PEAR 31', browser: 'Chrome on macOS', state: 'pending' } },
    sent: [],
    signsOut: true,
    account: { id: 'a1', email: EMAIL },
    bodies: [],
    ...given,
  };
  await page.context().route(`${WORKER_ORIGIN}/**`, (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: true, google: false } });
    // The provider said yes: the worker brings the console back to its root, signed in.
    if (pathname === '/console/auth/start/github') {
      worker.signedIn = true;

      return route.fulfill({ status: 302, headers: { Location: `${CONSOLE}/` } });
    }
    if (pathname === '/console/auth/email') return json({ sent: true });
    if (worker.silent) return json({ error: 'unavailable' }, 503);
    if (pathname === '/console/auth/sign-out') {
      worker.sent.push('sign-out');
      if (!worker.signsOut) return json({ error: 'unavailable' }, 503);
      worker.signedIn = false;

      return json({ success: true });
    }
    if (pathname === '/console/me') {
      return worker.signedIn
        ? json({ account: { ...worker.account, name: 'Ana', locale: 'en' }, workspaces: worker.workspaces })
        : json({ error: 'identity-required' }, 401);
    }
    const asked = /^\/console\/connect\/([^/]+)(?:\/(approve|refuse))?$/.exec(pathname);
    if (asked === null) return route.fulfill({ status: 204 });
    if (!worker.signedIn) return json({ error: 'identity-required' }, 401);
    const [, id = '', verb] = asked;
    const found = worker.requests[decodeURIComponent(id)];
    // Unknown, or answered by another account: the worker says the same, and nothing of it.
    if (found === undefined || (found.by !== undefined && found.by !== worker.account.id)) {
      return json({ error: 'connect-unknown' }, 404);
    }
    if (verb !== undefined) worker.sent.push(`${verb} ${id}`);
    if (found.state === 'expired') return json({ error: 'connect-expired' }, 410);
    // As the worker of FRU-238: a request that waits shows its word, its account and the workspaces of
    // the account; an answered one shows its state and its browser, to the account that answered.
    const view = () =>
      found.state === 'pending'
        ? {
            request: id,
            state: found.state,
            word: found.word,
            browser: found.browser,
            account: worker.account,
            workspaces: worker.workspaces,
          }
        : { request: id, state: found.state, browser: found.browser };
    if (verb === undefined) return json(view());
    const body = request.postDataJSON() as { word?: string; account?: string };
    worker.bodies.push(body);
    if (body.account !== worker.account.id) return json({ error: 'account-changed' }, 409);
    if (found.state !== 'pending') return json({ error: 'connect-already' }, 409);
    if (verb === 'approve' && body.word !== found.word) return json({ error: 'word-mismatch', attemptsLeft: 4 }, 422);
    found.state = verb === 'approve' ? 'approved' : 'refused';
    found.by = worker.account.id;

    return json(
      verb === 'approve'
        ? { state: 'approved', browser: found.browser, workspaces: worker.workspaces }
        : { state: 'refused', browser: found.browser },
    );
  });

  return worker;
}

const connect = (page: Page) => page.getByRole('button', { name: 'Connect Chrome', exact: true });

async function open(page: Page, request = 'r1'): Promise<void> {
  await page.goto(`${CONSOLE}/connect/${request}`);
  await expect(page.locator('main h1')).toBeVisible();
}

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
    name,
  ).toEqual([]);
}

type Box = { x: number; y: number; width: number; height: number };

/** A box of the page against the one measured on the mockup, within `tolerance` pixels. */
async function expectNear(page: Page, selector: string, expected: Partial<Box>, name: string, tolerance = 2) {
  if (!FONT_OF_THE_MOCKUP) return;
  const found = await page.locator(selector).first().boundingBox();
  for (const [key, value] of Object.entries(expected)) {
    expect
      .soft(Math.abs((found?.[key as keyof Box] ?? Number.NaN) - value), `${name}, ${key}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

test.describe('Connect this browser (FRU-240)', () => {
  test('asks with the word of the worker, and connects on a press of « Connect »', async ({ page }) => {
    const worker = await workerWith(page);
    await open(page);

    await expect(page.locator('main h1')).toHaveText('Connect this browser');
    await expect(page).toHaveTitle('Connect this browser');
    await expect(page.getByText('PEAR 31', { exact: true })).toBeVisible();
    const rows = page.locator('main dl > div');
    await expect(rows).toHaveText(['Account' + EMAIL, 'BrowserChrome on macOS', 'WorkspacesAcme, Lumen Studio']);
    // Nothing is approved by opening the page.
    expect(worker.sent).toEqual([]);

    // The values of the mockup: the word, white on ink, in a monospace of 22 px.
    const word = page.locator('.kit-verify__word');
    expect(
      await word.evaluate((element) => {
        const style = getComputedStyle(element);

        return [style.fontSize, style.fontWeight, style.letterSpacing];
      }),
    ).toEqual(['22px', '700', '1.76px']);
    expect(
      contrast(await painted(word, 'color'), await painted(page.locator('.kit-verify'), 'backgroundColor')),
    ).toBeCloseTo(17.72, 1);
    expect(await painted(page.locator('.kit-verify'), 'backgroundColor')).toEqual(rgb('#18181b'));
    await expectNear(page, 'main h1', { x: 500, width: 440 }, 'title');
    await expectNear(page, '.kit-verify', { x: 500, width: 440 }, 'the word');
    await expectNoViolation(page, 'ask');

    await connect(page).click();
    await expect(page.locator('main h1')).toHaveText('Chrome is connected');
    await expect(page.getByRole('status')).toHaveText(
      'Open the popup on any site of Acme or Lumen Studio. You can close this tab.',
    );
    expect(worker.sent).toEqual(['approve r1']);
    // The answer names the word and the account the page showed: the worker checks both.
    expect(worker.bodies).toEqual([{ word: 'PEAR 31', account: 'a1' }]);
    await expectNoViolation(page, 'connected');
  });

  test('the word and the browser are never read from the address of the page', async ({ page }) => {
    await workerWith(page);
    await page.goto(`${CONSOLE}/connect/r1?word=EVIL%2099&browser=Netscape#word=EVIL%2099`);
    await expect(page.getByText('PEAR 31', { exact: true })).toBeVisible();
    // The control of the absence below: the word of the worker is there, read the same way.
    await expect(page.locator('main')).not.toContainText('EVIL');
    await expect(page.locator('main')).not.toContainText('Netscape');
  });

  test('« Not now » refuses the request, and says what the extension does then', async ({ page }) => {
    const worker = await workerWith(page);
    await open(page);
    await page.getByRole('button', { name: 'Not now', exact: true }).click();

    await expect(page.locator('main h1')).toHaveText('This browser is not connected');
    await expect(page.getByRole('status')).toHaveText(
      'The extension stays signed out. To connect it later, open its popup and sign in from there.',
    );
    expect(worker.sent).toEqual(['refuse r1']);
  });

  test('two presses on « Connect » send one answer', async ({ page }) => {
    const worker = await workerWith(page);
    await open(page);
    await connect(page).dblclick();
    await expect(page.locator('main h1')).toHaveText('Chrome is connected');
    expect(worker.sent).toEqual(['approve r1']);
  });

  test('a request answered in another tab is read again, and never answered twice', async ({ page }) => {
    const worker = await workerWith(page);
    const other = await page.context().newPage();
    await open(page);
    await open(other);

    await connect(other).click();
    await expect(other.locator('main h1')).toHaveText('Chrome is connected');
    // The first tab still shows the question: its press finds the request answered, and says so.
    await connect(page).click();
    await expect(page.locator('main h1')).toHaveText('Chrome is connected');
    expect(worker.sent).toEqual(['approve r1', 'approve r1']);
    expect(worker.requests.r1?.state).toBe('approved');

    // Refused in one tab: the other says it, and does not connect it.
    worker.requests.r2 = { word: 'FIG 12', browser: 'Chrome on macOS', state: 'pending' };
    await open(page, 'r2');
    await open(other, 'r2');
    await other.getByRole('button', { name: 'Not now', exact: true }).click();
    await connect(page).click();
    await expect(page.locator('main h1')).toHaveText('This browser is not connected');
    expect(worker.requests.r2?.state).toBe('refused');
    await other.close();
  });

  for (const [state, why] of [
    ['expired', 'a request that ran out of time'],
    ['unknown', 'a request the worker does not know'],
  ] as const) {
    test(`${why} says that it no longer works, and offers no « Connect »`, async ({ page }) => {
      const worker = await workerWith(page);
      if (state === 'expired') worker.requests.r1 = { word: 'PEAR 31', browser: 'Chrome on macOS', state: 'expired' };
      await open(page, state === 'expired' ? 'r1' : 'nope');

      await expect(page.locator('main h1')).toHaveText('This request no longer works');
      await expect(connect(page)).toHaveCount(0);
      await expect(page.getByText('PEAR 31')).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveAttribute('href', '/');
    });
  }

  test('a request that expires while the question is on the screen says so at the press', async ({ page }) => {
    const worker = await workerWith(page);
    await open(page);
    worker.requests.r1!.state = 'expired';
    await connect(page).click();
    await expect(page.locator('main h1')).toHaveText('This request no longer works');
    expect(worker.sent).toEqual(['approve r1']);
  });

  test('a session that ends while the question is on the screen asks for a sign-in once, at the press', async ({
    page,
  }) => {
    const worker = await workerWith(page);
    await open(page);
    worker.signedIn = false;
    await connect(page).click();
    await expect(page.locator('main h1')).toHaveText('Sign in to connect this browser');
    // The page asks for the sign-in itself: the banner of the root would say another thing.
    await expect(page.getByText('Your session ended.', { exact: false })).toHaveCount(0);
    expect(worker.requests.r1?.state).toBe('pending');
  });

  test('nobody signed in: the ways in, and back to the question after, never to the answer', async ({ page }) => {
    const worker = await workerWith(page, { signedIn: false });
    await open(page);

    await expect(page.locator('main h1')).toHaveText('Sign in to connect this browser');
    await expect(page.getByText('The Fruitback extension in Chrome is waiting.', { exact: false })).toBeVisible();
    await expect(page.getByText('PEAR 31')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Work email' }).fill(EMAIL);
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.locator('main h1')).toHaveText('Check your inbox');

    // The link is opened in another tab: this one hears it, and shows the question.
    worker.signedIn = true;
    const other = await page.context().newPage();
    await other.goto(`${CONSOLE}/kit/entry`);
    await other.evaluate(() => new BroadcastChannel('fruitback:sign-in').postMessage('signed-in'));
    await expect(page.locator('main h1')).toHaveText('Connect this browser');
    await expect(page.getByText('PEAR 31', { exact: true })).toBeVisible();
    // A sign-in answers no request: only the press does.
    expect(worker.sent).toEqual([]);
    expect(worker.requests.r1?.state).toBe('pending');
    await other.close();
  });

  test('a request answered by another account is unknown here, and shows nothing of it', async ({ page }) => {
    const worker = await workerWith(page);
    worker.requests.r1 = { word: 'PEAR 31', browser: 'Chrome on macOS', state: 'approved', by: 'a2' };
    await open(page);
    await expect(page.locator('main h1')).toHaveText('This request no longer works');
    await expect(page.locator('main')).not.toContainText('Chrome');
    // The control: answered by this account, the same request reads as connected.
    worker.requests.r1.by = 'a1';
    await open(page);
    await expect(page.locator('main h1')).toHaveText('Chrome is connected');
  });

  test('another account signed in since the page read the request: the press is refused, and the page reads again', async ({
    page,
  }) => {
    const worker = await workerWith(page);
    await open(page);
    // The session of this browser changed account in another tab.
    worker.account = { id: 'a2', email: 'tom@acme.dev' };
    await connect(page).click();
    await expect(page.locator('main dl > div').first()).toHaveText('Accounttom@acme.dev');
    expect(worker.requests.r1?.state).toBe('pending');
    expect(worker.bodies).toEqual([{ word: 'PEAR 31', account: 'a1' }]);
  });

  test('a sign-in with a provider comes back to the question, and answers nothing', async ({ page }) => {
    const worker = await workerWith(page, { signedIn: false });
    await open(page);
    await page.getByRole('button', { name: 'Continue with GitHub' }).click();
    // The worker brought the console back to its root: the front door goes back to the request.
    await expect(page).toHaveURL(`${CONSOLE}/connect/r1`);
    await expect(page.getByText('PEAR 31', { exact: true })).toBeVisible();
    expect(worker.sent).toEqual([]);
    expect(worker.requests.r1?.state).toBe('pending');
    // Once: the next visit of the front door does not come back here.
    expect(await page.evaluate(() => sessionStorage.getItem('fruitback:connect'))).toBeNull();
  });

  test('a connected request whose workspaces cannot be read says « Try again », and sends nobody to the setup', async ({
    page,
  }) => {
    const worker = await workerWith(page);
    worker.requests.r1 = { word: 'PEAR 31', browser: 'Chrome on macOS', state: 'approved', by: 'a1' };
    await page.route(`${WORKER_ORIGIN}/console/me`, (route) =>
      route.fulfill({ status: 503, json: { error: 'unavailable' } }),
    );
    await open(page);
    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
    await expect(page.getByRole('link', { name: 'Set up a workspace' })).toHaveCount(0);
    // The control: once the account is read, the page says where the extension reads.
    await page.unroute(`${WORKER_ORIGIN}/console/me`);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Open the popup on any site of Acme or Lumen Studio. You can close this tab.',
    );
  });

  test('« Use another address » signs out and asks for the other address, or says that it did not', async ({
    page,
  }) => {
    const worker = await workerWith(page, { signsOut: false });
    await open(page);
    await page.getByRole('button', { name: 'Use another address', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText(
      'You are still signed in: Fruitback did not confirm the sign-out. Try again.',
    );
    await expect(page.locator('main h1')).toHaveText('Connect this browser');

    worker.signsOut = true;
    await page.getByRole('button', { name: 'Use another address', exact: true }).click();
    await expect(page.locator('main h1')).toHaveText('Sign in to connect this browser');
    expect(worker.sent).toEqual(['sign-out', 'sign-out']);
  });

  test('an account with no workspace connects, and is sent to the setup', async ({ page }) => {
    await workerWith(page, { workspaces: [] });
    await open(page);
    await expect(page.locator('main dl > div').nth(2)).toHaveText('WorkspacesNo workspace yet');
    await connect(page).click();
    await expect(page.locator('main h1')).toHaveText('Chrome is connected');
    await expect(page.getByRole('status')).toContainText('you have none yet');
    await expect(page.getByRole('link', { name: 'Set up a workspace' })).toHaveAttribute('href', '/setup');
  });

  for (const role of ['owner', 'admin', 'member', 'guest'] as Role[]) {
    test(`asks the same of a ${role}: the request is of the account, not of a workspace`, async ({ page }) => {
      await workerWith(page, { workspaces: [{ ...ACME, role }] });
      await open(page);
      await expect(connect(page)).toBeEnabled();
      await expect(page.locator('main dl > div').nth(2)).toHaveText('WorkspacesAcme');
    });
  }

  test('a worker that does not answer: no question, no answer, and « Try again »', async ({ page }) => {
    const worker = await workerWith(page, { silent: true });
    await open(page);
    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
    await expect(connect(page)).toHaveCount(0);
    worker.silent = false;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByText('PEAR 31', { exact: true })).toBeVisible();

    // A press that gets no answer says so, and the question stays.
    worker.silent = true;
    await connect(page).click();
    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
    await expect(connect(page)).toBeEnabled();
  });

  for (const width of [390, 320]) {
    test(`at ${width} px nothing scrolls sideways, and the word stays whole`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await workerWith(page);
      await open(page);
      expect(await sideScroll(page)).toBe(0);
      const word = await page.locator('.kit-verify__word').boundingBox();
      const block = await page.locator('.kit-verify').boundingBox();
      expect(word!.x + word!.width).toBeLessThanOrEqual(block!.x + block!.width);
      await expectNoViolation(page, `ask at ${width} px`);
    });
  }

  test('in French for a French browser', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    await workerWith(page);
    await open(page);
    await expect(page.locator('main h1')).toHaveText('Connecter ce navigateur');
    await expect(page.getByRole('button', { name: 'Connecter Chrome', exact: true })).toBeVisible();
    await context.close();
  });
});

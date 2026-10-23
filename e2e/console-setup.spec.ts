import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from '@playwright/test';
import { CONSOLE, type Worker, cloudWorker, finished, linkIn, served } from './cloud-worker.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The setup on one screen (FRU-239, screen 01 of the mockup of 2026-10-13): « Your account »,
 * « Your site », then the step that puts Fruitback on the site.
 *
 * The first part runs against a worker whose accounts are in PostgreSQL (PGlite): no stub decides an
 * answer, and the link is read in the mail. The second part measures the states against the mockup,
 * and there the worker is answered by stubs: it measures boxes and colours.
 */
const CURRENT = 'Current step: ';

test.describe('the setup, against a worker with accounts (FRU-239)', () => {
  let worker: Worker;

  test.beforeEach(async ({ context }) => {
    worker = await cloudWorker();
    await served(context, worker);
  });
  test.afterEach(({ context }) => finished(context, worker));

  /** The workspaces of the person signed in in `page`, as the worker lists them. */
  const workspaces = (page: Page): Promise<{ id: string; name: string }[]> =>
    page.evaluate(async (origin) => {
      const answer = await fetch(`${origin}/console/me`, { credentials: 'include' });

      return ((await answer.json()) as { workspaces: { id: string; name: string }[] }).workspaces;
    }, WORKER_ORIGIN);

  test('a new address goes from the link to its site, with a workspace named after its domain', async ({
    page,
    context,
  }) => {
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: `${CURRENT}Your account` })).toBeVisible();
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect(page.getByRole('status')).toContainText(
      'A sign-in link is on its way to ana@acme.dev. Open it in this browser: this page carries on by itself.',
    );
    await expect.poll(async () => (await worker.sent()).length).toBe(1);

    // The mail opens the link in another tab of the same browser.
    const other = await context.newPage();
    await other.goto(await linkIn(worker));

    // The setup goes on by itself, to its second step: nobody was asked for a name.
    await expect(page.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();
    await expect(page.getByText('Signed in as ana@acme.dev')).toBeVisible();
    await expect(page.getByText('Workspace Acme')).toBeVisible();
    await expect(other.getByRole('heading', { name: 'You are signed in' })).toBeVisible();
    // One workspace, though two tabs of the browser were signed in at that moment.
    expect((await workspaces(page)).map((each) => each.name)).toEqual(['Acme']);
    // The step that is done is no longer the current one, and the last one is still to come.
    await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Put it on the site', exact: true })).toBeVisible();

    // « Rename »: the name becomes a field, and the worker keeps the new one.
    await page.getByRole('button', { name: 'Rename' }).click();
    const name = page.getByRole('textbox', { name: 'Workspace name' });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Acme');
    await name.fill('Acme Studio');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Workspace Acme Studio')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rename' })).toBeFocused();
    expect((await workspaces(page)).map((each) => each.name)).toEqual(['Acme Studio']);
    // The new name is in the words of the second step too.
    await expect(page.getByRole('radio', { name: /^Members of Acme Studio/ })).toBeChecked();

    // « Add site »: a host with no scheme, and the setup is at its last step.
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();
    await expect(page.getByText('https://staging.acme.dev', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Members of Acme Studio see the notes')).toBeVisible();

    // Somebody who comes back is where they left: the front door leads to the sites now.
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();
    await page.goto(CONSOLE);
    await expect(page).toHaveURL(/\/w\/ws_[0-9a-f]{20}\/sites$/);
  });

  test('two tabs of one browser make one workspace, not one each', async ({ page, context }) => {
    await page.goto(`${CONSOLE}/sign-in`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(1);
    // The worker is slow to make the workspace: the first tab is still asking when the second arrives.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const making = `${WORKER_ORIGIN}/console/workspaces`;
    await context.route(making, async (route) => {
      await held;
      await route.fallback();
    });
    const asked = page.waitForRequest(making);
    await page.goto(await linkIn(worker));
    await asked;

    const second = await context.newPage();
    await second.goto(`${CONSOLE}/setup`);
    // The control: the second tab is signed in, has no workspace yet, and is past its own reading.
    // The first tab read its invitations twice (the front door, then the setup): the third reading
    // is the second tab's, and what it does next is make the workspace, or wait for the first.
    await expect
      .poll(async () => (await worker.received()).filter((each) => each.path.endsWith('/list-user-invitations')).length)
      .toBe(3);
    await second.waitForTimeout(300);
    release();

    await expect(page.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();
    await expect(second.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();
    expect((await workspaces(page)).map((each) => each.name)).toEqual(['Acme']);
    const made = (await worker.received()).filter(
      (each) => each.method === 'POST' && each.path === '/console/workspaces',
    );
    expect(made).toHaveLength(1);
  });

  test('the last step gives the script of the site, copies it, and connects the browser', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const toSite: string[] = [];
    await context.route('https://staging.acme.dev/**', (route) => {
      toSite.push(route.request().url());

      return route.abort();
    });
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(1);
    await page.goto(await linkIn(worker));
    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();

    // The script names the site as the worker made it, and « Copy script » copies that script.
    const [workspace] = await workspaces(page);
    const site = await page.evaluate(
      async ([origin, id]) => {
        const answer = await fetch(`${origin}/console/workspaces/${id}/sites`, { credentials: 'include' });

        return ((await answer.json()) as { sites: { id: string }[] }).sites[0]!.id;
      },
      [WORKER_ORIGIN, workspace!.id],
    );
    const script = page.getByRole('region', { name: 'Script tag' });
    await expect(script).toContainText(`data-fruitback-client="${site}"`);
    await expect(script).toContainText(`data-fruitback-endpoint="${WORKER_ORIGIN}"`);
    await page.getByRole('button', { name: 'Copy script' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await script.innerText());

    // « Connect this browser »: the pairing page of the worker opens, with a code after the `#`.
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Connect this browser' }).click();
    const pairing = await opened;
    await pairing.waitForURL(/\/pair#/);
    expect(new URL(pairing.url()).hash.slice(1)).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    await pairing.close();

    // The preview frames the site (FRU-354): the browser asks it for its page, and for nothing else.
    const preview = page.getByRole('region', { name: 'Preview of your site' });
    await expect(preview.getByText('https://staging.acme.dev', { exact: true })).toBeVisible();
    await expect(preview.locator('iframe')).toHaveAttribute('src', 'https://staging.acme.dev/');
    await expect.poll(() => toSite.length).toBeGreaterThan(0);
    expect(new Set(toSite)).toEqual(new Set(['https://staging.acme.dev/']));
    // The way on is always there: nothing tells the console that a first note came.
    await page.getByRole('link', { name: 'Open the console' }).click();
    await expect(page).toHaveURL(`${CONSOLE}/w/${workspace!.id}/sites`);
  });

  test('a name the worker refuses stays in its field, with the reason', async ({ page }) => {
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(1);
    await page.goto(await linkIn(worker));
    await expect(page.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();

    await page.getByRole('button', { name: 'Rename' }).click();
    const name = page.getByRole('textbox', { name: 'Workspace name' });
    // The field stops at 80 characters, as the rule of the worker: a name of spaces is what it refuses.
    await name.fill('   ');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('alert')).toHaveText('A workspace needs a name of one line, up to 80 characters.');
    await expect(name).toHaveValue('   ');
    expect((await workspaces(page)).map((each) => each.name)).toEqual(['Acme']);

    // Escape gives the name back as it was, and focus to « Rename ».
    await name.press('Escape');
    await expect(page.getByText('Workspace Acme')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rename' })).toBeFocused();
  });

  test('« Change » replaces a site added in this visit, and keeps one of a visit before', async ({ page }) => {
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(1);
    await page.goto(await linkIn(worker));
    await page.getByRole('textbox', { name: 'Site address' }).fill('stagin.acme.dev');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();
    const [workspace] = await workspaces(page);
    const sites = (): Promise<string[]> =>
      page.evaluate(
        async ([origin, id]) => {
          const answer = await fetch(`${origin}/console/workspaces/${id}/sites`, { credentials: 'include' });

          return ((await answer.json()) as { sites: { origin: string }[] }).sites.map((site) => site.origin);
        },
        [WORKER_ORIGIN, workspace!.id],
      );

    // A typing mistake, seen at once: the form opens with its values, and the site is replaced.
    await page.getByRole('button', { name: 'Change' }).click();
    const address = page.getByRole('textbox', { name: 'Site address' });
    // The address comes back with its scheme, so an http site stays http (FRU-314).
    await expect(address).toHaveValue('https://stagin.acme.dev');
    await address.fill('staging.acme.dev');
    await page.getByText('Everyone who visits', { exact: true }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Everyone who visits sees the notes')).toBeVisible();
    expect(await sites()).toEqual(['https://staging.acme.dev']);

    // « Cancel » and a form sent as it was change nothing.
    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Everyone who visits sees the notes')).toBeVisible();
    expect(await sites()).toEqual(['https://staging.acme.dev']);

    // Another visit: the site may hold notes now, so it is not removed behind the person's back.
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('button', { name: 'Change' }).click();
    await page.getByRole('textbox', { name: 'Site address' }).fill('preview.acme.dev');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('https://preview.acme.dev', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'is still in your sites' })).toHaveText(
      'https://staging.acme.dev is still in your sites, with its notes. Remove it in Sites if you no longer review it.',
    );
    expect((await sites()).toSorted()).toEqual(['https://preview.acme.dev', 'https://staging.acme.dev']);
  });

  test('somebody who was invited is sent to their invitation: no workspace is made for them', async ({
    page,
    browser,
  }) => {
    // An owner, with a workspace, invites Tom.
    const owners = await browser.newContext({ locale: 'en-US' });
    await served(owners, worker);
    const owner = await owners.newPage();
    await owner.goto(`${CONSOLE}/setup`);
    await owner.getByRole('textbox', { name: 'Work email' }).fill('ana@acme.dev');
    await owner.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.sent()).length).toBe(1);
    await owner.goto(await linkIn(worker));
    await expect(owner.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();
    const [workspace] = await workspaces(owner);
    await owner.goto(`${CONSOLE}/w/${workspace!.id}/members`);
    await owner.getByRole('textbox', { name: 'Email', exact: true }).fill('tom@client.fr');
    await owner.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect.poll(async () => (await worker.mail()).filter((each) => each.to === 'tom@client.fr').length).toBe(1);

    // Tom opens the setup, not the link of his invitation, and signs in there.
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill('tom@client.fr');
    await page.getByRole('button', { name: 'Email me a link' }).click();
    await expect.poll(async () => (await worker.mail()).filter((each) => each.to === 'tom@client.fr').length).toBe(2);
    const link = /http:\/\/\S+\/sign-in#\S+/.exec(
      (await worker.mail()).findLast((each) => each.to === 'tom@client.fr')!.text,
    );
    // The tab of the setup goes on by itself, and finds the invitation.
    const other = await page.context().newPage();
    await other.goto(link![0]);
    await expect(page).toHaveURL(`${CONSOLE}/invitations`);
    await expect(page.getByRole('button', { name: 'Join Acme' })).toBeVisible();
    expect(await workspaces(page)).toEqual([]);
    await finished(owners, undefined);
    await owners.close();
  });
});

/**
 * Lets `periods` reads of five seconds go by, each with the real time a request takes to reach the
 * stub: a read made in one of them is counted after it, not lost in a jump of the clock.
 */
async function quietFor(page: Page, periods: number): Promise<void> {
  for (let period = 0; period < periods; period += 1) {
    await page.clock.runFor(5_000);
    await page.waitForTimeout(150);
  }
}

type Stub = {
  /** Nobody signed in, somebody with a workspace, or somebody with a workspace and a site. */
  as: 'nobody' | 'named' | 'sited';
  role?: 'owner' | 'member';
  /** What the worker answers when a workspace is made or a site is added. */
  refuses?: { workspace?: boolean | 'invalid-name'; site?: number; sites?: boolean; invitations?: 503 | 404 };
  locale?: 'en' | 'fr';
  /** Who sees the notes of the site of « sited ». */
  audience?: 'members' | 'everyone';
  /** From this read of the sites on, the site of « sited » has its first note (FRU-242). */
  notedFrom?: number;
  /** The worker counts the note and gives no day of the last one. */
  noDay?: boolean;
};

const LONG_HOST = 'preview-branch-feature-very-long-name-1234.staging.acme.dev';

/**
 * The sample words are as wide as the mockup's in the system font, so a line wraps where the
 * mockup wraps it: « Havane » for the name of the workspace, `marianne@acme.dev` for the address.
 */
const EMAIL = 'marianne@acme.dev';
const NAME = 'Havane';

async function stubWorker(page: Page, stub: Stub): Promise<string[]> {
  const asked: string[] = [];
  const workspace = { id: 'w1', name: NAME, role: stub.role ?? 'owner' };
  const account = { id: 'a1', email: EMAIL, name: 'Marianne', locale: stub.locale ?? 'en' };
  const site = { id: 's1', origin: 'https://staging.acme.dev', visibility: stub.audience ?? 'members' };
  let made = stub.as !== 'nobody';
  await page.context().route(`${WORKER_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    asked.push(`${request.method()} ${pathname}`);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: true, google: true } });
    if (pathname === '/console/me') {
      if (stub.as === 'nobody') return json({ error: 'identity-required' }, 401);

      return json({ account, workspaces: made && stub.refuses?.workspace === undefined ? [workspace] : [] });
    }
    if (pathname === '/console/auth/email') return json({ sent: true });
    if (pathname.endsWith('/list-user-invitations')) {
      const refused = stub.refuses?.invitations;

      return refused === undefined ? json([]) : json({ error: 'unavailable' }, refused);
    }
    if (pathname === '/console/workspaces') {
      if (stub.refuses?.workspace === 'invalid-name') return json({ error: 'invalid-name' }, 400);
      if (stub.refuses?.workspace === true) return json({ error: 'unavailable' }, 503);
      made = true;

      return json(workspace, 201);
    }
    if (pathname === '/console/workspaces/w1/sites') {
      if (request.method() === 'GET') {
        if (stub.refuses?.sites === true) return json({ error: 'unavailable' }, 503);
        const reads = asked.filter((each) => each === 'GET /console/workspaces/w1/sites').length;
        const first =
          stub.notedFrom !== undefined && reads >= stub.notedFrom
            ? {
                notes: { new: 1, todo: 0, progress: 0, done: 0, closed: 0 },
                ...(stub.noDay === true ? {} : { lastNoteAt: new Date().toISOString() }),
                via: ['extension'],
              }
            : {};

        return json({ sites: stub.as === 'sited' ? [{ ...site, ...first }] : [] });
      }
      if (stub.refuses?.site !== undefined) return json({ error: 'forbidden' }, stub.refuses.site);
      const { url, visibility, writers } = request.postDataJSON() as {
        url: string;
        visibility: string;
        writers?: string;
      };

      return json(
        { id: 's2', origin: new URL(url).origin, visibility, ...(writers === undefined ? {} : { writers }) },
        201,
      );
    }

    return route.fulfill({ status: 204 });
  });
  // The site itself, which the preview frames (FRU-354).
  await page
    .context()
    .route(/^https:\/\/[^/]*acme\.dev\//, (route) => route.fulfill({ contentType: 'text/html', body: SITE_PAGE }));

  return asked;
}

const SITE_PAGE = '<!doctype html><html lang="en"><title>Acme Outdoor</title><h1>Pack light, walk far.</h1></html>';

type Box = { x: number; y: number; width: number; height: number };

/** The box of an element in the page, to a tenth of a pixel. */
async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();

    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  });
  const round = (value: number) => Math.round(value * 10) / 10;

  return { x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height) };
}

/**
 * The mockup is measured in the system font of macOS: a line of text with no line height of its own
 * is 1 or 2 px taller in the system font of Linux, which the CI draws, and a word is not as wide.
 * So the boxes are compared where the font is the mockup's. Everything else is measured everywhere.
 */
const FONT_OF_THE_MOCKUP = process.platform === 'darwin';

/** Each side of `built` is within `tolerance` pixels of the mockup's. */
function expectNear(built: Box, mockup: Box, name: string, tolerance = 2): void {
  if (!FONT_OF_THE_MOCKUP) return;
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    expect
      .soft(Math.abs(built[side] - mockup[side]), `${name}: ${side} is ${built[side]}, the mockup has ${mockup[side]}`)
      .toBeLessThanOrEqual(tolerance);
  }
}

const sideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const violations = async (page: Page): Promise<string[]> =>
  (await new AxeBuilder({ page }).analyze()).violations.map(
    (violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`,
  );

/**
 * The mockup's lead ends with « Hosted in Europe », which a console that is not of the Cloud does not
 * say (FRU-321): its lead is one line shorter at 1440 px, and what is under it is that much higher.
 */
const LEAD = 24;

test.describe('the states of the setup, against the mockup (FRU-239)', () => {
  // The boxes of the mockup at 1440 × 900, read in its `measures.json`. Tolerance: 2 px.
  test('« Your account », to do: the boxes of the mockup at 1440 px', async ({ page }) => {
    await stubWorker(page, { as: 'nobody' });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: `${CURRENT}Your account` })).toBeVisible();

    expectNear(await boxOf(page.locator('header')), { x: 0, y: 0, width: 1440, height: 65 }, 'header');
    expectNear(
      await boxOf(page.getByRole('img', { name: 'Fruitback' })),
      { x: 80, y: 21, width: 113, height: 22 },
      'logo',
    );
    const guide = page.getByRole('link', { name: 'Self-hosting guide' });
    expectNear(await boxOf(guide), { x: 1241, y: 24, width: 118.8, height: 17 }, 'guide');
    await expect(guide).toHaveAttribute('href', 'https://fruitback.com/self-hosting.html');
    expectNear(
      await boxOf(page.getByRole('heading', { level: 1 })),
      { x: 112, y: 113, width: 400.2, height: 34.5 },
      'title',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: `${CURRENT}Your account` })),
      { x: 160, y: 240 - LEAD, width: 352.2, height: 26 },
      'step 1',
    );
    expectNear(
      await boxOf(page.getByRole('textbox', { name: 'Work email' })),
      { x: 160, y: 361 - LEAD, width: 352.2, height: 44 },
      'field',
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Email me a link' })),
      { x: 160, y: 415 - LEAD, width: 142.5, height: 44 },
      'main button',
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Continue with Google' })),
      { x: 160, y: 562 - LEAD, width: 352.2, height: 44 },
      'Google',
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Continue with GitHub' })),
      { x: 160, y: 616 - LEAD, width: 352.2, height: 44 },
      'GitHub',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Your site', exact: true })),
      { x: 160, y: 692 - LEAD, width: 352.2, height: 26 },
      'step 2',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Put it on the site', exact: true })),
      { x: 160, y: 773 - LEAD, width: 352.2, height: 26 },
      'step 3',
    );
    const preview = page.getByRole('region', { name: 'Preview of your site' });
    expectNear(await boxOf(preview), { x: 568, y: 113, width: 759.8, height: 698.5 }, 'preview');
    expectNear(await boxOf(preview.locator('svg')), { x: 920, y: 404, width: 56, height: 68 }, 'drop of the preview');
    await expect(preview.getByText('your site', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle('Set up Fruitback');

    // The steps are a list in order, and the current one is said as such to a screen reader only.
    await expect(page.locator('main ol > li')).toHaveCount(3);
    await expect(page.locator('main ol > li[aria-current="step"]')).toHaveCount(1);
    const hidden = await page.getByText('Current step:').first().boundingBox();
    expect.soft(hidden!.width, 'the words « Current step: » are not drawn').toBeLessThanOrEqual(1);
    expect(await violations(page)).toEqual([]);
  });

  test('« Check your inbox »: the boxes of the mockup at 1440 px', async ({ page }) => {
    // The clock is set, so the button reads « Send again in 0:41 », as on the mockup.
    await page.clock.install();
    await stubWorker(page, { as: 'nobody' });
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('textbox', { name: 'Work email' }).fill(EMAIL);
    await page.getByRole('button', { name: 'Email me a link' }).click();
    const sent = page.getByRole('status');
    await expect(sent).toContainText('Check your inbox');
    await page.clock.runFor(19_000);

    expectNear(await boxOf(sent), { x: 160, y: 278 - LEAD, width: 352.2, height: 283.5 }, 'callout');
    const again = page.getByRole('button', { name: 'Send again in 0:41' });
    expectNear(await boxOf(again), { x: 181, y: 455 - LEAD, width: 157.5, height: 40 }, '« Send again »');
    await expect(again).toBeDisabled();
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Use another address' })),
      { x: 181, y: 505 - LEAD, width: 139.9, height: 37 },
      '« Use another address »',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Your site', exact: true })),
      { x: 160, y: 593 - LEAD, width: 352.2, height: 26 },
      'step 2',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Put it on the site', exact: true })),
      { x: 160, y: 674 - LEAD, width: 352.2, height: 26 },
      'step 3',
    );
    expect(await violations(page)).toEqual([]);

    // « Use another address » gives the form back, with the address in it.
    await page.getByRole('button', { name: 'Use another address' }).click();
    await expect(page.getByRole('textbox', { name: 'Work email' })).toHaveValue(EMAIL);
  });

  test('« Your site », to do: the boxes of the mockup at 1440 px', async ({ page }) => {
    await stubWorker(page, { as: 'named' });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();

    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Your account', exact: true })),
      { x: 160, y: 240 - LEAD, width: 352.2, height: 26 },
      'step 1',
    );
    expectNear(
      await boxOf(page.locator('main ol > li').first().locator('.kit-step__mark svg')),
      { x: 122, y: 247 - LEAD, width: 13, height: 13 },
      'check of step 1',
    );
    // « Rename » is where the mockup has it, 6 px higher and 12 px taller: its target (A23).
    const rename = await boxOf(page.getByRole('button', { name: 'Rename' }));
    expectNear(
      { ...rename, y: rename.y + 6, height: rename.height - 12 },
      { x: 314, y: 299 - LEAD, width: 54.4, height: 21 },
      '« Rename »',
    );
    expect.soft(rename.height, 'the target of « Rename »').toBeGreaterThanOrEqual(24);
    expectNear(
      await boxOf(page.getByRole('heading', { name: `${CURRENT}Your site` })),
      { x: 160, y: 353 - LEAD, width: 352.2, height: 26 },
      'step 2',
    );
    expectNear(
      await boxOf(page.getByRole('textbox', { name: 'Site address' })),
      { x: 160, y: 413 - LEAD, width: 352.2, height: 44 },
      'field',
    );
    // Under the field the mockup has a hint of two lines, and its second sentence waits for a
    // decision on the previews (FRU-103): one line here, so what follows is 19.5 px higher.
    const hint = 19.5;
    const cards = page.locator('.kit-pick__card');
    expectNear(await boxOf(cards.nth(0)), { x: 160, y: 546 - hint - LEAD, width: 352.2, height: 90 }, 'card, members');
    expectNear(
      await boxOf(cards.nth(1)),
      { x: 160, y: 644 - hint - LEAD, width: 352.2, height: 70.5 },
      'card, everyone',
    );
    // « Who can leave a note? » (FRU-330) is not on the board: it comes 20 px under the cards, the
    // gap of the form, and what follows is that much lower.
    const writers = await boxOf(page.getByRole('radiogroup', { name: 'Who can leave a note?' }));
    expectNear(
      { ...writers, height: 0 },
      { x: 160, y: 644 + 70.5 + 20 - hint - LEAD, width: 352.2, height: 0 },
      '« Who can leave a note? »',
    );
    const asked = writers.height + 20;
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Add site' })),
      { x: 160, y: 734 + asked - hint - LEAD, width: 98.6, height: 44 },
      '« Add site »',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Put it on the site', exact: true })),
      { x: 160, y: 810 + asked - hint - LEAD, width: 352.2, height: 26 },
      'step 3',
    );
    await expect(page.getByText('Any page of it will do.')).toBeVisible();
    await expect(page.getByText(/preview\.acme\.dev/)).toHaveCount(0);

    // The question is the name of its group, and the first answer is chosen.
    const group = page.getByRole('radiogroup', { name: 'Who sees the notes?' });
    await expect(group.getByRole('radio')).toHaveCount(2);
    await expect(group.getByRole('radio', { name: /^Members of Havane/ })).toBeChecked();
    expect(await violations(page)).toEqual([]);
  });

  test('« Put it on the site »: the two cards, the site itself, and the boxes of the mockup at 1440 px', async ({
    page,
  }) => {
    await stubWorker(page, { as: 'sited' });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();

    expectNear(
      await boxOf(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })),
      { x: 160, y: 466 - LEAD, width: 352.2, height: 26 },
      'step 3',
    );
    const change = await boxOf(page.getByRole('button', { name: 'Change' }));
    expectNear(
      { ...change, y: change.y + 6, height: change.height - 12 },
      { x: 405, y: 412 - LEAD, width: 51.8, height: 21 },
      '« Change »',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Browser extension' })),
      { x: 179, y: 553 - LEAD, width: 314.2, height: 18 },
      'card of the extension',
    );
    // The cards are one under the other in this column, as on the mockup, and as wide.
    const cards = page.locator('.kit-option');
    await expect(cards).toHaveCount(2);
    expectNear(
      await boxOf(cards.nth(0)),
      { x: 160, y: 534 - LEAD, width: 352.2, height: (await boxOf(cards.nth(0))).height },
      'first card',
    );
    expect.soft((await boxOf(cards.nth(1))).x).toBe(160);
    // Chromium installs from the Chrome Web Store (FRU-409); `console-extension-store.spec.ts` holds Firefox.
    await expect(page.getByRole('link', { name: 'Install the extension (beta)' })).toHaveAttribute(
      'href',
      'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa',
    );
    // The step says that it waits for the first note, and what to do on the site (FRU-237 tells it).
    await expect(page.getByRole('status').filter({ hasText: 'Waiting for your first note.' })).toContainText(
      'Waiting for your first note. Open the site, click Leave feedback, then any part of the page.',
    );
    await expect(page.getByRole('link', { name: 'Open https://staging.acme.dev' })).toHaveAttribute(
      'href',
      'https://staging.acme.dev',
    );
    await expect(page.getByRole('link', { name: 'Open the console' })).toHaveAttribute('href', '/w/w1/sites');
    await expect(page.getByText('Before the closing body tag. Members see their pins on every visit.')).toBeVisible();
    // Only Fruitback Cloud says where it is hosted: this console calls a worker of its own (FRU-321).
    await expect(page.getByText('Three steps to your first note on a live page.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Hosted in Europe/)).toHaveCount(0);

    // The site itself (FRU-354): the address in the bar, the page in a frame laid out at 1280 px and
    // scaled down, sandboxed so that it cannot take the tab away, and with no referrer.
    const preview = page.getByRole('region', { name: 'Preview of your site' });
    expectNear(await boxOf(preview.locator('.kit-browser')), { x: 568, y: 113, width: 759.8, height: 665 }, 'preview');
    const frame = preview.locator('iframe');
    await expect(frame).toHaveAttribute('src', 'https://staging.acme.dev/');
    await expect(frame).toHaveAttribute('title', 'staging.acme.dev, live');
    await expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
    );
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(await frame.evaluate((element) => (element as HTMLIFrameElement).offsetWidth)).toBe(1280);
    expectNear(await boxOf(frame), { x: 569, y: 158, width: 757.8, height: 620 }, 'the page, scaled', 3);
    await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Pack light, walk far.' })).toBeVisible();
    await expect(preview).toContainText(
      'Your site, as it is now. A blank frame or an error means your site refuses to show inside another page.',
    );
    expect(await violations(page)).toEqual([]);

    // The address in place of the frame: the icon of the site, its domain, and why. It is kept.
    // Under Playwright an image at `/favicon.ico` fails before any request a route sees (measured on
    // 2026-10-21, a `/icon.png` loads): the icon is then the first letter of the domain.
    await preview.getByRole('button', { name: 'Show its address instead' }).click();
    await expect(frame).toHaveCount(0);
    await expect(preview.locator('.site-preview__host')).toHaveText('staging.acme.dev');
    await expect(preview.locator('.site-preview__letter')).toHaveText('S');
    await expect(preview).toContainText('X-Frame-Options or Content-Security-Policy header says so');
    await expect(preview.getByRole('link', { name: 'Open staging.acme.dev in a new tab' })).toHaveAttribute(
      'href',
      'https://staging.acme.dev',
    );
    expect(await violations(page)).toEqual([]);

    // « Show an example »: the example page of before, a picture, as a last resort (FRU-354).
    await preview.getByRole('button', { name: 'Show an example' }).click();
    const scene = preview.locator('.scene');
    await expect(scene).toBeVisible();
    await expect(scene).toHaveAttribute('aria-hidden', 'true');
    expect(await scene.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
    await expect(preview.locator('.scene__hint')).toHaveText('Click Leave feedback, then any part of the page.');
    await expect(preview).toContainText('An example page. Pins show the same way on your site.');
    await expect(preview.locator('.site-preview__host')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
    await preview.getByRole('button', { name: 'Show its address instead' }).click();
    await expect(scene).toHaveCount(0);
    await expect(preview.locator('.site-preview__host')).toHaveText('staging.acme.dev');

    // The address is kept for the site; the example is not.
    await page.reload();
    await expect(preview.locator('.site-preview__host')).toHaveText('staging.acme.dev');
    await expect(preview.locator('iframe')).toHaveCount(0);
    await preview.getByRole('button', { name: 'Show the live page' }).click();
    await expect(preview.locator('iframe')).toBeVisible();
  });

  test('a site that cannot show offers the example page, in French at 390 px', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR', viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await stubWorker(page, { as: 'sited', locale: 'fr' });
    await page.goto(`${CONSOLE}/setup`);
    const preview = page.getByRole('region', { name: 'Aperçu de votre site' });
    // A phone lays the site out at the width of the frame: no scale.
    const frame = preview.locator('iframe');
    await expect(frame).toHaveAttribute('title', 'staging.acme.dev, en direct');
    expect(await frame.evaluate((element) => (element as HTMLIFrameElement).style.transform)).toBe('');
    await preview.getByRole('button', { name: 'Afficher son adresse à la place' }).click();
    await expect(preview).toContainText('Beaucoup de sites refusent de s’afficher dans une autre page');
    await preview.getByRole('button', { name: 'Voir un exemple' }).click();
    await expect(preview.locator('.scene__hint')).toHaveText(
      'Cliquez sur Laisser une note, puis sur n’importe quelle partie de la page.',
    );
    await expect(preview).toContainText('Une page d’exemple. Les pins s’affichent de la même façon sur votre site.');
    expect(await sideScroll(page)).toBe(0);
    expect(await violations(page)).toEqual([]);
    await context.close();
  });

  test('the setup ends by itself at the first note: the step and the conclusion', async ({ page }) => {
    await page.clock.install();
    const asked = await stubWorker(page, { as: 'sited', notedFrom: 3 });
    const reads = () => asked.filter((each) => each === 'GET /console/workspaces/w1/sites').length;
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();
    await expect(page.getByText('Waiting for your first note.')).toBeVisible();

    // Every five seconds while the tab is shown; the third read has the note.
    await page.clock.runFor(5_000);
    await expect.poll(reads).toBe(2);
    await expect(page.getByText('Waiting for your first note.')).toBeVisible();
    await page.clock.runFor(5_000);
    await expect.poll(reads).toBe(3);

    // The last step is done, by itself, and says how the note came.
    await expect(page.getByRole('heading', { name: 'Put it on the site', exact: true })).toBeVisible();
    // The worker does not say which browser sent the note: none is named.
    await expect(page.getByText('Extension on', { exact: true })).toBeVisible();
    await expect(page.getByText('First note received just now')).toBeVisible();
    await expect(page.getByText('Waiting for your first note.')).toHaveCount(0);
    // The conclusion is said, and takes no focus: the person may be on their site, in another tab.
    const conclusion = page
      .getByRole('status')
      .filter({ has: page.getByRole('heading', { name: 'Your first note is in' }) });
    await expect(conclusion).toContainText(
      'It waits in the Havane workspace. Send your notes to a tracker or your own API whenever you like.',
    );
    await expect(conclusion.getByRole('link', { name: 'Open the console' })).toHaveAttribute('href', '/w/w1/sites');
    await expect(conclusion.getByRole('link', { name: 'Connect a tracker' })).toHaveAttribute(
      'href',
      '/w/w1/connectors',
    );
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    // The preview stays the site itself: its pins are on the page, where the widget draws them.
    await expect(page.getByRole('region', { name: 'Preview of your site' }).locator('iframe')).toBeVisible();
    expect(await violations(page)).toEqual([]);

    // Nothing is read again once the note came.
    await quietFor(page, 6);
    expect(reads()).toBe(3);
  });

  test('a hidden tab reads nothing, and reads again once it is shown', async ({ page }) => {
    await page.clock.install();
    const asked = await stubWorker(page, { as: 'sited' });
    const reads = () => asked.filter((each) => each === 'GET /console/workspaces/w1/sites').length;
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByText('Waiting for your first note.')).toBeVisible();
    const show = (state: 'hidden' | 'visible') =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);

    await show('hidden');
    await quietFor(page, 6);
    expect(reads()).toBe(1);
    // The control: shown again, the reads go on at their pace.
    await show('visible');
    await page.clock.runFor(5_000);
    await expect.poll(reads).toBe(2);
  });

  test('a read that fails changes nothing on the screen, and the next one finds the note', async ({ page }) => {
    await page.clock.install();
    const stub: Stub = { as: 'sited', notedFrom: 2 };
    await stubWorker(page, stub);
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByText('Waiting for your first note.')).toBeVisible();
    stub.refuses = { sites: true };
    await page.clock.runFor(10_000);
    await expect(page.getByText('Waiting for your first note.')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    stub.refuses = undefined;
    await page.clock.runFor(5_000);
    await expect(page.getByRole('heading', { name: 'Your first note is in' })).toBeVisible();
  });

  test('a count with no day of the last note says no moment', async ({ page }) => {
    await stubWorker(page, { as: 'sited', notedFrom: 1, noDay: true });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByText('First note received', { exact: true })).toBeVisible();
    await expect(page.getByText('First note received just now')).toHaveCount(0);
  });

  test('a site that has its first note already: the setup opens on its end', async ({ page }) => {
    await stubWorker(page, { as: 'sited', notedFrom: 1 });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('heading', { name: 'Your first note is in' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Put it on the site', exact: true })).toBeVisible();
  });

  test('the script card says who sees the pins of a site that everyone sees', async ({ page }) => {
    await stubWorker(page, { as: 'sited', audience: 'everyone' });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page.getByText('Before the closing body tag. Every visitor sees the pins.')).toBeVisible();
    await expect(page.getByText('Everyone who visits sees the notes')).toBeVisible();
  });

  test('a copy the browser refuses says so, and the script stays to select', async ({ page }) => {
    await stubWorker(page, { as: 'sited' });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      });
    });
    await page.goto(`${CONSOLE}/setup`);
    await page.getByRole('button', { name: 'Copy script' }).click();

    await expect(page.getByRole('alert')).toHaveText(
      'The browser refused the copy. Select the script above and copy it by hand.',
    );
    await expect(page.getByRole('region', { name: 'Script tag' })).toContainText('data-fruitback-client="s1"');
  });

  test('the keyboard walks the setup in the order it reads', async ({ page }) => {
    await stubWorker(page, { as: 'nobody' });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('textbox', { name: 'Work email' })).toBeVisible();
    const order = [
      page.getByRole('link', { name: 'Fruitback' }),
      page.getByRole('link', { name: 'Self-hosting guide' }),
      page.getByRole('textbox', { name: 'Work email' }),
      page.getByRole('button', { name: 'Email me a link' }),
      page.getByRole('button', { name: 'Continue with Google' }),
      page.getByRole('button', { name: 'Continue with GitHub' }),
    ];
    for (const control of order) {
      await page.keyboard.press('Tab');
      await expect(control).toBeFocused();
    }
    // The ring of the mockup on the control the keyboard is on.
    const focused = page.getByRole('button', { name: 'Continue with GitHub' });
    expect(await focused.evaluate((element) => getComputedStyle(element).outline)).toBe('rgb(221, 44, 39) solid 2px');
  });

  test('« Who can leave a note? » is « Members only » for a new site, and « Anyone on the page » is said once chosen (FRU-330)', async ({
    page,
  }) => {
    await stubWorker(page, { as: 'named' });
    await page.goto(`${CONSOLE}/setup`);
    const writers = page.getByRole('radiogroup', { name: 'Who can leave a note?' });
    await expect(writers.getByRole('radio', { name: 'Members only' })).toBeChecked();
    // A site that everyone reads is not asked: the question goes, and comes back with its answer.
    await page.getByText('Everyone who visits', { exact: true }).click();
    await expect(writers).toHaveCount(0);
    await page.getByText(/^Members of Havane/).click();
    await writers.getByText('Anyone on the page', { exact: true }).click();

    await page.getByRole('textbox', { name: 'Site address' }).fill('staging.acme.dev');
    await page.getByRole('button', { name: 'Add site' }).click();

    await expect(page.getByText('Notes from anyone on the page')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });

  test('a refusal keeps what is typed, at each step', async ({ page }) => {
    // The site: the worker refuses, the address stays, and the sentence says why.
    const asked = await stubWorker(page, { as: 'named', refuses: { site: 403 } });
    await page.goto(`${CONSOLE}/setup`);
    const address = page.getByRole('textbox', { name: 'Site address' });
    await address.fill('staging.acme.dev');
    await page.getByText('Everyone who visits', { exact: true }).click();
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('alert')).toHaveText('Only an owner or an admin of the workspace adds a site.');
    await expect(address).toHaveValue('staging.acme.dev');
    await expect(page.getByRole('radio', { name: /^Everyone who visits/ })).toBeChecked();
    await expect(page.getByRole('heading', { name: `${CURRENT}Your site` })).toBeVisible();

    // What is not an address: the sentence of the console, and nothing asked of the worker.
    const before = asked.filter((each) => each.startsWith('POST')).length;
    await address.fill('pas une adresse');
    await page.getByRole('button', { name: 'Add site' }).click();
    await expect(page.getByRole('alert')).toHaveText('Paste the full address of the site, starting with https://.');
    await expect(address).toHaveValue('pas une adresse');
    expect(asked.filter((each) => each.startsWith('POST')).length).toBe(before);
  });

  test('no workspace is made while the invitations cannot be read, and one is once they can', async ({ page }) => {
    let refused: 503 | undefined = 503;
    const asked = await stubWorker(page, {
      as: 'named',
      refuses: {
        workspace: true,
        get invitations() {
          return refused;
        },
      },
    });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
    // The first step is still the one to do, and the second is to come: a screen reader says so.
    await expect(page.getByRole('heading', { name: `${CURRENT}Your account` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your site', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveCount(0);
    expect(asked.filter((each) => each === 'POST /console/workspaces')).toEqual([]);

    // The control: the same person, once the worker answers, gets a workspace made.
    refused = undefined;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => asked.filter((each) => each === 'POST /console/workspaces').length).toBe(1);
  });

  test('a worker with no invitations at all (404) does not stop the setup', async ({ page }) => {
    const asked = await stubWorker(page, { as: 'named', refuses: { workspace: true, invitations: 404 } });
    await page.goto(`${CONSOLE}/setup`);

    await expect.poll(() => asked.filter((each) => each === 'POST /console/workspaces').length).toBe(1);
  });

  test('the form of a workspace that was not made opens on what the worker said of the try', async ({ page }) => {
    await stubWorker(page, { as: 'named', refuses: { workspace: 'invalid-name' } });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page.getByRole('alert')).toHaveText('A workspace needs a name of one line, up to 80 characters.');
    await expect(page.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Acme');
  });

  test('a workspace the worker did not make is asked for again, with the name in a field', async ({ page }) => {
    const asked = await stubWorker(page, { as: 'named', refuses: { workspace: true } });
    await page.goto(`${CONSOLE}/setup`);

    // Signed in, and no workspace: the first step is still the current one, and says what failed: the
    // worker did not answer the try that was made for the person.
    await expect(page.getByRole('heading', { name: `${CURRENT}Your account` })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Try again.');
    const name = page.getByRole('textbox', { name: 'Workspace name' });
    // The name the workspace would have taken: the domain of the address.
    await expect(name).toHaveValue('Acme');
    await name.fill('Acme Studio');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => asked.filter((each) => each === 'POST /console/workspaces').length).toBe(2);
    await expect(name).toHaveValue('Acme Studio');
  });

  test('sites that could not be read are not « no site »: the step says so, and asks nothing again', async ({
    page,
  }) => {
    await stubWorker(page, { as: 'named', refuses: { sites: true } });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page.getByRole('alert')).toHaveText('Fruitback did not answer. Your sites are not lost.');
    await expect(page.getByRole('textbox', { name: 'Site address' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('somebody who does not manage the workspace sees no « Rename » and no « Change »', async ({ page }) => {
    await stubWorker(page, { as: 'sited', role: 'member' });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page.getByRole('heading', { name: `${CURRENT}Put it on the site` })).toBeVisible();
    await expect(page.getByText('Workspace Havane')).toBeVisible();
    await expect(page.getByRole('button', { name: /Rename|Change/ })).toHaveCount(0);
  });

  test('a member of a workspace with no site is sent to its Sites screen, with no form that cannot work', async ({
    page,
  }) => {
    const asked = await stubWorker(page, { as: 'named', role: 'member' });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
    await expect(page.getByRole('textbox', { name: 'Site address' })).toHaveCount(0);
    expect(asked.filter((each) => each === 'POST /console/workspaces/w1/sites')).toEqual([]);
    // The control: the owner of the same workspace stays on the setup, at the form.
    await page.context().unrouteAll({ behavior: 'ignoreErrors' });
    await stubWorker(page, { as: 'named', role: 'owner' });
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByRole('textbox', { name: 'Site address' })).toBeVisible();
    await expect(page).toHaveURL(`${CONSOLE}/setup`);
  });

  for (const locale of ['en', 'fr'] as const) {
    test(`no state of the setup scrolls sideways on a phone, in ${locale}`, async ({ browser }) => {
      const context = await browser.newContext({
        locale: locale === 'en' ? 'en-US' : 'fr-FR',
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      const check = async (state: string) => {
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          expect.soft(await sideScroll(page), `${state} scrolls sideways at ${width} px`).toBe(0);
        }
        await page.setViewportSize({ width: 390, height: 844 });
      };

      // To do, then the link on its way.
      await stubWorker(page, { as: 'nobody', locale });
      await page.goto(`${CONSOLE}/setup`);
      const email = page.getByRole('textbox', { name: locale === 'en' ? 'Work email' : 'E-mail professionnel' });
      await expect(email).toBeVisible();
      await check('step 1');
      // The two columns are one: the preview is under the steps, as on the mockup at 390 px.
      const steps = await boxOf(page.locator('main ol'));
      const preview = await boxOf(page.locator('main > section').nth(1));
      expect.soft(preview.y, 'the preview is under the steps').toBeGreaterThan(steps.y + steps.height);
      // In French the sentence of the header takes two lines there, and all that follows is lower.
      if (locale === 'en') {
        expectNear(
          await boxOf(page.getByRole('heading', { level: 1 })),
          { x: 16, y: 113, width: 358, height: 34.5 },
          'title',
          4,
        );
      }
      await email.fill(`someone.with.a.long.name@${LONG_HOST}`);
      await page
        .getByRole('button', { name: locale === 'en' ? 'Email me a link' : 'Recevoir un lien par e-mail' })
        .click();
      await expect(page.getByRole('status')).toBeVisible();
      await check('the link on its way, to a long address');
      await context.unrouteAll({ behavior: 'ignoreErrors' });

      // The site, then the last step with a long host.
      await stubWorker(page, { as: 'named', locale });
      await page.goto(`${CONSOLE}/setup`);
      const address = page.getByRole('textbox', { name: locale === 'en' ? 'Site address' : 'Adresse du site' });
      await expect(address).toBeVisible();
      await check('step 2');
      await address.fill(LONG_HOST);
      await page.getByRole('button', { name: locale === 'en' ? 'Add site' : 'Ajouter le site' }).click();
      await expect(page.locator('main ol > li[aria-current="step"]')).toContainText('3');
      await check('step 3, with a long host');
      // The long host reads in full: it takes the lines it needs.
      const host = page.getByText(`https://${LONG_HOST}`, { exact: true }).first();
      expect.soft(await host.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      // The script breaks inside its attributes: nothing of it is past the edge of its card (FRU-321).
      const script = page.locator('.kit-snippet').first();
      expect.soft(await script.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(script).toContainText('fruitback.iife.js');
      expect(await violations(page)).toEqual([]);
      await context.close();
    });
  }

  test('the setup is in French for a French browser', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    await stubWorker(page, { as: 'named', locale: 'fr' });
    await page.goto(`${CONSOLE}/setup`);

    await expect(page.getByRole('heading', { name: 'Mettre en place Fruitback' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Étape en cours : Votre site' })).toBeVisible();
    await expect(page.getByText('Connecté en tant que marianne@acme.dev')).toBeVisible();
    await expect(page.getByRole('radio', { name: /^Les membres de Havane/ })).toBeChecked();
    await expect(page).toHaveTitle('Mettre en place Fruitback');
    await context.close();
  });
});

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
    await expect(page.getByText('staging.acme.dev', { exact: true }).first()).toBeVisible();
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
    await expect(address).toHaveValue('stagin.acme.dev');
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
    await expect(page.getByText('preview.acme.dev', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'is still in your sites' })).toHaveText(
      'staging.acme.dev is still in your sites, with its notes. Remove it in Sites if you no longer review it.',
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

type Stub = {
  /** Nobody signed in, somebody with a workspace, or somebody with a workspace and a site. */
  as: 'nobody' | 'named' | 'sited';
  role?: 'owner' | 'member';
  /** What the worker answers when a workspace is made or a site is added. */
  refuses?: { workspace?: boolean | 'invalid-name'; site?: number; sites?: boolean; invitations?: 503 | 404 };
  locale?: 'en' | 'fr';
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
  const site = { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' };
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

        return json({ sites: stub.as === 'sited' ? [site] : [] });
      }
      if (stub.refuses?.site !== undefined) return json({ error: 'forbidden' }, stub.refuses.site);
      const { url, visibility } = request.postDataJSON() as { url: string; visibility: string };

      return json({ id: 's2', origin: new URL(url).origin, visibility }, 201);
    }

    return route.fulfill({ status: 204 });
  });

  return asked;
}

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
      { x: 160, y: 240, width: 352.2, height: 26 },
      'step 1',
    );
    expectNear(
      await boxOf(page.getByRole('textbox', { name: 'Work email' })),
      { x: 160, y: 361, width: 352.2, height: 44 },
      'field',
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Email me a link' })),
      { x: 160, y: 415, width: 142.5, height: 44 },
      'main button',
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Continue with Google' })),
      { x: 160, y: 562, width: 352.2, height: 44 },
      'Google',
    );
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Continue with GitHub' })),
      { x: 160, y: 616, width: 352.2, height: 44 },
      'GitHub',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Your site', exact: true })),
      { x: 160, y: 692, width: 352.2, height: 26 },
      'step 2',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Put it on the site', exact: true })),
      { x: 160, y: 773, width: 352.2, height: 26 },
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

    expectNear(await boxOf(sent), { x: 160, y: 278, width: 352.2, height: 283.5 }, 'callout');
    const again = page.getByRole('button', { name: 'Send again in 0:41' });
    expectNear(await boxOf(again), { x: 181, y: 455, width: 157.5, height: 40 }, '« Send again »');
    await expect(again).toBeDisabled();
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Use another address' })),
      { x: 181, y: 505, width: 139.9, height: 37 },
      '« Use another address »',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Your site', exact: true })),
      { x: 160, y: 593, width: 352.2, height: 26 },
      'step 2',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Put it on the site', exact: true })),
      { x: 160, y: 674, width: 352.2, height: 26 },
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
      { x: 160, y: 240, width: 352.2, height: 26 },
      'step 1',
    );
    expectNear(
      await boxOf(page.locator('main ol > li').first().locator('.kit-step__mark svg')),
      { x: 122, y: 247, width: 13, height: 13 },
      'check of step 1',
    );
    // « Rename » is where the mockup has it, 6 px higher and 12 px taller: its target (A23).
    const rename = await boxOf(page.getByRole('button', { name: 'Rename' }));
    expectNear(
      { ...rename, y: rename.y + 6, height: rename.height - 12 },
      { x: 314, y: 299, width: 54.4, height: 21 },
      '« Rename »',
    );
    expect.soft(rename.height, 'the target of « Rename »').toBeGreaterThanOrEqual(24);
    expectNear(
      await boxOf(page.getByRole('heading', { name: `${CURRENT}Your site` })),
      { x: 160, y: 353, width: 352.2, height: 26 },
      'step 2',
    );
    expectNear(
      await boxOf(page.getByRole('textbox', { name: 'Site address' })),
      { x: 160, y: 413, width: 352.2, height: 44 },
      'field',
    );
    // Under the field the mockup has a hint of two lines, and its second sentence waits for a
    // decision on the previews (FRU-103): one line here, so what follows is 19.5 px higher.
    const hint = 19.5;
    const cards = page.locator('.kit-pick__card');
    expectNear(await boxOf(cards.nth(0)), { x: 160, y: 546 - hint, width: 352.2, height: 90 }, 'card, members');
    expectNear(await boxOf(cards.nth(1)), { x: 160, y: 644 - hint, width: 352.2, height: 70.5 }, 'card, everyone');
    expectNear(
      await boxOf(page.getByRole('button', { name: 'Add site' })),
      { x: 160, y: 734 - hint, width: 98.6, height: 44 },
      '« Add site »',
    );
    expectNear(
      await boxOf(page.getByRole('heading', { name: 'Put it on the site', exact: true })),
      { x: 160, y: 810 - hint, width: 352.2, height: 26 },
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
      const host = page.getByText(LONG_HOST, { exact: true }).first();
      expect.soft(await host.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
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

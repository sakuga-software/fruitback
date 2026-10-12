import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The screens of a workspace on a narrow screen (FRU-159), in the console of the Cloud.
 *
 * Layout is what this measures, so the worker is answered by stubs: a worker with accounts needs a
 * signed-in person, and none of that changes a width.
 */
const CONSOLE = 'http://localhost:5178';
const LONG_HOST = 'preview-branch-feature-very-long-name-1234.staging.acme.dev';
const SCREENS = ['sites', 'connectors', 'members', 'account'] as const;

async function stubWorker(page: Page, locale: 'en' | 'fr'): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  const sites = { sites: [{ id: 's1', origin: `https://${LONG_HOST}`, visibility: 'members' }] };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/sites') return json(sites);
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [], available: true });
    if (pathname === '/auth/providers') return json({});

    return route.fulfill({ status: 204 });
  });
}

async function open(page: Page, screen: string): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/${screen}`);
  await expect(page.locator('main h1')).toBeVisible();
}

const sideScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const width of [390, 320]) {
  for (const locale of ['en', 'fr'] as const) {
    test(`no screen of a workspace scrolls sideways at ${width} px, in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await stubWorker(page, locale);
      for (const screen of SCREENS) {
        await open(page, screen);
        expect.soft(await sideScroll(page), `${screen} scrolls sideways`).toBe(0);
      }
    });
  }
}

test('at 390 px, the title follows the sections, and a long host reads in full', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubWorker(page, 'fr');
  await open(page, 'sites');

  const nav = await page.getByRole('navigation').boundingBox();
  const title = await page.locator('main h1').boundingBox();
  expect(title!.y - (nav!.y + nav!.height)).toBeLessThan(40);

  const host = page.getByText(LONG_HOST, { exact: true });
  await expect(host).toBeVisible();
  // Read in full: nothing cut, and nothing past the right edge of the screen.
  expect(await host.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const box = await host.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

/** The worker as `/setup` meets it (FRU-160): nobody signed in, or a person with one workspace. */
async function stubSetup(page: Page, signedIn: boolean): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  const site = { id: 's1', origin: `https://${LONG_HOST}`, visibility: 'members' };
  await page.route(`${WORKER_ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/console/me') return signedIn ? json(me) : json({ error: 'unauthorized' }, 401);
    if (pathname === '/console/workspaces/w1/sites') return json(site, 201);
    if (pathname === '/auth/providers') return json({});

    return route.fulfill({ status: 204 });
  });
}

/** The lines each visible label of the header of `/setup` takes. */
const headerLines = (page: Page) =>
  page.locator('header').evaluate((header) =>
    [...header.querySelectorAll<HTMLElement>('span, a')]
      .filter((element) => element.children.length === 0 && element.textContent?.trim() && element.offsetWidth > 1)
      .map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));

        return { text: element.textContent?.trim(), lines: tops.size };
      }),
  );

/** How far the title of the current step is cut, and the lines it takes. A whole title: 0 and 1. */
const currentStepTitle = (page: Page) =>
  page
    .locator('ol [aria-current="step"] span span')
    .first()
    .evaluate((title) => {
      const range = document.createRange();
      range.selectNodeContents(title);
      const tops = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));

      return { cut: title.scrollWidth - title.clientWidth, lines: tops.size };
    });

for (const width of [390, 320]) {
  for (const locale of ['en-US', 'fr-FR']) {
    test(`no step of /setup scrolls sideways at ${width} px, in ${locale}`, async ({ browser }) => {
      const context = await browser.newContext({ locale, viewport: { width, height: 844 } });
      const page = await context.newPage();
      const continueButton = page.getByRole('button', { name: /^(Continue|Continuer)$/ });

      // Step 1, signed out.
      await stubSetup(page, false);
      await page.goto(`${CONSOLE}/setup`);
      await expect(continueButton).toBeVisible();
      expect.soft(await sideScroll(page), 'step 1 scrolls sideways').toBe(0);
      expect.soft(await currentStepTitle(page), 'the title of step 1').toEqual({ cut: 0, lines: 1 });
      if (width === 390) {
        expect.soft((await headerLines(page)).filter((label) => label.lines > 1)).toEqual([]);
        const box = await continueButton.boundingBox();
        expect.soft(box!.y + box!.height, 'the action of step 1 is under the fold').toBeLessThanOrEqual(844);
      }
      await page.unrouteAll();

      // Steps 2, 3 and 4, with a workspace.
      await stubSetup(page, true);
      await page.goto(`${CONSOLE}/setup`);
      await expect(page.locator('ol [aria-current="step"]')).toContainText('2');
      expect.soft(await sideScroll(page), 'step 2 scrolls sideways').toBe(0);
      expect.soft(await currentStepTitle(page), 'the title of step 2').toEqual({ cut: 0, lines: 1 });
      await page.goto(`${CONSOLE}/setup?step=site`);
      await expect(page.locator('ol [aria-current="step"]')).toContainText('3');
      expect.soft(await sideScroll(page), 'step 3 scrolls sideways').toBe(0);
      expect.soft(await currentStepTitle(page), 'the title of step 3').toEqual({ cut: 0, lines: 1 });
      await page.getByRole('textbox').first().fill(`https://${LONG_HOST}`);
      await continueButton.click();
      await expect(page.locator('ol [aria-current="step"]')).toContainText('4');
      await expect(page.locator('pre')).toBeVisible();
      expect.soft(await sideScroll(page), 'step 4 scrolls sideways').toBe(0);
      expect.soft(await currentStepTitle(page), 'the title of step 4').toEqual({ cut: 0, lines: 1 });
      // The script scrolls inside its block, and stays whole.
      expect(await page.locator('pre').evaluate((pre) => pre.scrollWidth > pre.clientWidth)).toBe(true);
      await context.close();
    });
  }
}

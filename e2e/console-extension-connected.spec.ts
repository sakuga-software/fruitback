import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { sideScroll, stubWorker } from './console-workspace.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * No screen offers to install or to connect the extension once a browser of the account is
 * connected (FRU-441). The worker says which browsers are (`GET /console/me/browsers`, FRU-238); the
 * rail, step 3 of the setup and « You are in » then name the one used last, and « Connect another
 * browser » is the only way on. `/connect`, opened in a browser with the label of a connected one,
 * says so and leads to the console.
 *
 * The worker is answered by stubs. Each test runs once with a browser connected and once with none,
 * so that what it reads is not there by default.
 */

const CONSOLE = 'http://localhost:5178';
const STORE = 'https://chromewebstore.google.com/detail/fruitback/jjjemdloknmggncbickofjgbodplekoa';
// Chromium of Playwright says « Chrome » in its user agent: the rail and the cards lead to the store.
const CHROME_ON_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
test.use({ userAgent: CHROME_ON_MAC });

const AT = '2026-10-23T09:00:00.000Z';
const MAC = { id: 'ext_mac', browser: 'Chrome on macOS', connectedAt: AT, usedAt: '2026-10-24T08:00:00.000Z' };
const PC = { id: 'ext_pc', browser: 'Edge on Windows', connectedAt: AT, usedAt: '2026-10-24T09:00:00.000Z' };

/** The browsers of the extension of the account, and the session of the console in this tab. */
function browsersAnswer(browsers: readonly unknown[], here = 'Chrome on macOS') {
  return (pathname: string, route: Route) => {
    if (pathname === '/console/me/browsers') return route.fulfill({ json: { browsers } });
    if (pathname === '/console/sessions') {
      return route.fulfill({
        json: { sessions: [{ id: 'cs1', createdAt: AT, lastUsedAt: AT, current: true, browser: here }] },
      });
    }

    return undefined;
  };
}

async function noViolation(page: Page): Promise<void> {
  // The frame of the site preview holds the site, not the console: axe reads the console.
  const results = await new AxeBuilder({ page }).include('main').exclude('iframe').analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

test.describe('the rail', () => {
  test('names the browser used last, and offers to connect another one', async ({ page }) => {
    await stubWorker(page, { answer: browsersAnswer([MAC, PC]) });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const rail = page.locator('aside.kit-rail');
    await expect(rail.getByTitle('Edge on Windows')).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Install the extension (beta)' })).toHaveCount(0);
    const another = rail.getByRole('link', { name: 'Connect another browser' });
    await expect(another).toHaveAttribute('href', STORE);
    await expect(another).toHaveAttribute('target', '_blank');
  });

  test('says it on two lines that do not wrap, the browser cut with « … » when it is long (FRU-456)', async ({
    page,
  }) => {
    const LONG = { ...MAC, browser: 'Chrome on macOS Sequoia, the laptop of the studio downstairs' };
    for (const [browsers, locale] of [
      [[MAC], 'en'],
      [[LONG], 'fr'],
    ] as const) {
      await page.addInitScript((each) => localStorage.setItem('fruitback:locale', each), locale);
      await stubWorker(page, { locale, answer: browsersAnswer(browsers) });
      await page.goto(`${CONSOLE}/w/w1/sites`);
      const rail = page.locator('aside.kit-rail');
      const said = rail.getByText(locale === 'fr' ? 'Extension connectée' : 'Extension connected', { exact: true });
      const browser = rail.getByTitle(browsers[0].browser);
      await expect(said).toBeVisible();
      await expect(browser).toBeVisible();
      // One line each: as high as one line of the rail, and the browser inside the rail.
      for (const line of [said, browser]) {
        const box = await line.boundingBox();
        expect(box?.height, await line.textContent()).toBeLessThan(24);
      }
      const shown = await browser.evaluate((node) => ({ cut: node.scrollWidth > node.clientWidth }));
      expect(shown.cut).toBe(browsers[0] === LONG);
    }
  });

  test('offers to install the extension when no browser is connected', async ({ page }) => {
    await stubWorker(page, { answer: browsersAnswer([]) });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const rail = page.locator('aside.kit-rail');
    await expect(rail.getByRole('link', { name: 'Install the extension (beta)' })).toBeVisible();
    await expect(rail.getByText(/Extension connected/)).toHaveCount(0);
  });

  test('reads the browsers again when the tab is shown again', async ({ page }) => {
    let browsers: unknown[] = [];
    await stubWorker(page, {
      answer: (pathname, route) =>
        pathname === '/console/me/browsers' ? route.fulfill({ json: { browsers } }) : undefined,
    });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const rail = page.locator('aside.kit-rail');
    await expect(rail.getByRole('link', { name: 'Install the extension (beta)' })).toBeVisible();
    // The person connects the extension in another tab, and comes back.
    browsers = [MAC];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(rail.getByTitle('Chrome on macOS')).toBeVisible();
  });

  test('an answer of an older read does not undo the answer of a newer one', async ({ page }) => {
    // What the next reads answer, in order; once they are spent, the browser of Edge.
    const next: { browsers: unknown[]; slow: boolean }[] = [];
    await stubWorker(page, {
      answer: (pathname, route) => {
        if (pathname !== '/console/me/browsers') return undefined;
        const { browsers, slow } = next.shift() ?? { browsers: [PC], slow: false };
        if (!slow) return route.fulfill({ json: { browsers } });

        return new Promise((resolve) => setTimeout(resolve, 1_500)).then(() => route.fulfill({ json: { browsers } }));
      },
    });
    await page.goto(`${CONSOLE}/w/w1/sites`);
    const rail = page.locator('aside.kit-rail');
    await expect(rail.getByTitle('Edge on Windows')).toBeVisible();
    // The tab is shown twice: the first read is slow and says « none », the second is quick.
    next.push({ browsers: [], slow: true }, { browsers: [MAC], slow: false });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(rail.getByTitle('Chrome on macOS')).toBeVisible();
    await page.waitForTimeout(2_000);
    await expect(rail.getByTitle('Chrome on macOS')).toBeVisible();
  });
});

test.describe('the page of a site (FRU-455)', () => {
  test('the block of the extension says it is connected, and offers to connect another browser', async ({ page }) => {
    await stubWorker(page, { answer: browsersAnswer([MAC]) });
    await page.goto(`${CONSOLE}/w/w1/sites/s1`);
    const block = page
      .locator('main div')
      .filter({ has: page.getByRole('heading', { name: 'Extension', exact: true }) })
      .last();
    await expect(block.getByText('Extension connected · Chrome on macOS')).toBeVisible();
    await expect(block.getByRole('button', { name: 'Connect this browser' })).toHaveCount(0);
    await expect(block.getByRole('button', { name: 'Connect another browser' })).toBeVisible();
    await noViolation(page);
  });

  test('offers to connect this browser when none is connected', async ({ page }) => {
    await stubWorker(page, { answer: browsersAnswer([]) });
    await page.goto(`${CONSOLE}/w/w1/sites/s1`);
    const block = page
      .locator('main div')
      .filter({ has: page.getByRole('heading', { name: 'Extension', exact: true }) })
      .last();
    await expect(block.getByRole('button', { name: 'Connect this browser' })).toBeVisible();
    await expect(block.getByText(/Extension connected/)).toHaveCount(0);
  });
});

test.describe('step 3 of the setup', () => {
  async function stubSetup(page: Page, browsers: readonly unknown[], locale: 'en' | 'fr' = 'en'): Promise<void> {
    const answer = browsersAnswer(browsers);
    await page.route(`${WORKER_ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({ json: body });
      const answered = answer(pathname, route);
      if (answered !== undefined) return answered;
      if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: false, google: false } });
      if (pathname === '/console/me') {
        return json({
          account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
          workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
        });
      }
      if (pathname.endsWith('/list-user-invitations')) return json([]);
      if (pathname === '/console/workspaces/w1/sites') {
        return json({ sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }] });
      }

      return route.fulfill({ status: 204 });
    });
    await page.route(/^https:\/\/staging\.acme\.dev\//, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Acme</title>' }),
    );
  }

  for (const width of [1440, 390]) {
    test(`the card of the extension says it is connected, at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubSetup(page, [MAC]);
      await page.goto(`${CONSOLE}/setup`);
      const card = page
        .locator('.kit-option')
        .filter({ has: page.getByRole('heading', { name: 'Browser extension' }) });
      await expect(card.getByText('Extension connected · Chrome on macOS')).toBeVisible();
      await expect(card.getByRole('link', { name: 'Install the extension (beta)' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Connect this browser' })).toHaveCount(0);
      await expect(card.getByRole('button', { name: 'Connect another browser' })).toBeVisible();
      expect(await sideScroll(page)).toBe(0);
      await noViolation(page);
    });
  }

  test('the card offers to install and to connect when no browser is connected', async ({ page }) => {
    await stubSetup(page, []);
    await page.goto(`${CONSOLE}/setup`);
    const card = page.locator('.kit-option').filter({ has: page.getByRole('heading', { name: 'Browser extension' }) });
    await expect(card.getByRole('link', { name: 'Install the extension (beta)' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Connect this browser' })).toBeVisible();
    await expect(card.getByText(/Extension connected/)).toHaveCount(0);
  });

  test('in French', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fruitback:locale', 'fr'));
    await stubSetup(page, [MAC], 'fr');
    await page.goto(`${CONSOLE}/setup`);
    await expect(page.getByText('Extension connectée · Chrome on macOS')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connecter un autre navigateur' })).toBeVisible();
  });
});

test.describe('« You are in »', () => {
  async function stubJoin(page: Page, browsers: readonly unknown[]): Promise<void> {
    const answer = browsersAnswer(browsers);
    await page.route(`${WORKER_ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      const json = (body: unknown) => route.fulfill({ json: body });
      const answered = answer(pathname, route);
      if (answered !== undefined) return answered;
      if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: false, google: false } });
      if (pathname === '/console/me') {
        return json({
          account: { id: 'a1', email: 'camille@acme.dev', name: 'Camille', locale: 'en' },
          workspaces: [],
        });
      }
      if (pathname.endsWith('/list-user-invitations')) {
        return json([
          {
            id: 'i1',
            role: 'member',
            organizationId: 'w1',
            organizationName: 'Havane',
            email: 'camille@acme.dev',
            status: 'pending',
            createdAt: AT,
            expiresAt: '2026-12-01T08:00:00.000Z',
          },
        ]);
      }
      if (pathname.endsWith('/accept-invitation')) return json({});
      if (pathname === '/console/workspaces/w1/sites') {
        return json({ sites: [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'members' }] });
      }

      return route.fulfill({ status: 404, json: { error: 'not-found' } });
    });
  }

  for (const width of [1440, 390]) {
    test(`names the connected browser and leads to the site, at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubJoin(page, [MAC]);
      await page.goto(`${CONSOLE}/invitations`);
      await page.getByRole('button', { name: 'Join Havane' }).click();
      await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();
      await expect(page.getByText('Extension connected · Chrome on macOS')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Install the extension (beta)' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Install it in Firefox (beta)' })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Open https://staging.acme.dev' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Connect another browser' })).toHaveAttribute('href', STORE);
      expect(await sideScroll(page)).toBe(0);
      await noViolation(page);
    });
  }

  test('offers to install the extension when no browser is connected', async ({ page }) => {
    await stubJoin(page, []);
    await page.goto(`${CONSOLE}/invitations`);
    await page.getByRole('button', { name: 'Join Havane' }).click();
    await expect(page.getByRole('heading', { name: 'You are in' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Install the extension (beta)' })).toBeVisible();
    await expect(page.getByText(/Extension connected/)).toHaveCount(0);
  });
});

test.describe('/connect', () => {
  async function stubConnect(page: Page, browsers: readonly unknown[], here: string): Promise<void> {
    const answer = browsersAnswer(browsers, here);
    await page.route(`${WORKER_ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());

      return answer(pathname, route) ?? route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    });
  }

  for (const width of [1440, 390]) {
    test(`opened in a browser already connected, says so and leads to the console, at ${width} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubConnect(page, [MAC, PC], 'Chrome on macOS');
      await page.goto(`${CONSOLE}/connect`);
      await expect(page.locator('main h1')).toHaveText('This browser is already connected');
      await expect(page.getByText('Extension connected · Chrome on macOS')).toBeVisible();
      await expect(page.getByRole('link', { name: 'Go to the console' })).toHaveAttribute('href', '/');
      expect(await sideScroll(page)).toBe(0);
      await noViolation(page);

      // The steps stay one press away: another computer can have the same browser and system.
      await page.getByRole('button', { name: 'Connect another browser' }).click();
      await expect(page.locator('main h1')).toHaveText('Connect this browser');
      await expect(page.getByRole('link', { name: 'Install the extension (beta)' })).toBeVisible();
    });
  }

  test('shows the steps when no connected browser has the label of this one', async ({ page }) => {
    await stubConnect(page, [PC], 'Chrome on macOS');
    await page.goto(`${CONSOLE}/connect`);
    await expect(page.locator('main h1')).toHaveText('Connect this browser');
    // The reads are answered: the page had what it needed to decide.
    await page.waitForTimeout(300);
    await expect(page.locator('main h1')).toHaveText('Connect this browser');
  });

  test('a late answer does not turn the steps into « already connected » under the eyes of the person', async ({
    page,
  }) => {
    await page.route(`${WORKER_ORIGIN}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname !== '/console/me/browsers' && pathname !== '/console/sessions') {
        return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
      }
      // Slower than the two seconds the page waits for its reads.
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      return pathname === '/console/me/browsers'
        ? route.fulfill({ json: { browsers: [MAC] } })
        : route.fulfill({
            json: {
              sessions: [{ id: 'cs1', createdAt: AT, lastUsedAt: AT, current: true, browser: 'Chrome on macOS' }],
            },
          });
    });
    await page.goto(`${CONSOLE}/connect`);
    await expect(page.locator('main h1')).toHaveText('Connect this browser');
    // The answers come three seconds after the page opened, after the steps were shown: they stay.
    await page.waitForTimeout(3_500);
    await expect(page.locator('main h1')).toHaveText('Connect this browser');
  });

  test('in French', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fruitback:locale', 'fr'));
    await stubConnect(page, [MAC], 'Chrome on macOS');
    await page.goto(`${CONSOLE}/connect`);
    await expect(page.locator('main h1')).toHaveText('Ce navigateur est déjà connecté');
    await expect(page.getByRole('link', { name: 'Aller à la console' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connecter un autre navigateur' })).toBeVisible();
  });
});

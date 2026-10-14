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
const SCREENS = ['sites', 'notes', 'connectors', 'members', 'account'] as const;

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
    if (pathname === '/console/workspaces/w1/domains') return json({ domains: [] });
    if (pathname === '/console/workspaces/w1/sites') return json(sites);
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [], available: true });
    if (pathname === '/console/workspaces/w1/notes') {
      const note = {
        id: 'n1',
        excerpt: 'The order form rejects postcodes with a space, and says nothing of why it does so.',
        page: { url: `https://${LONG_HOST}/contact`, host: LONG_HOST, path: '/contact' },
        site: { id: 's1' },
        stage: 'seeded',
        author: { kind: 'anonymous' },
        place: { kind: 'fruitback' },
        createdAt: '2026-10-13T08:00:00.000Z',
      };

      return json({ notes: [note], total: 1, counts: { all: 1, byPlace: { fruitback: 1 } } });
    }
    // A worker that signs people in by a link: one that says nothing there shows no form (FRU-217).
    if (pathname === '/auth/providers') return json({ betterAuth: { email: true, github: false, google: false } });

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

  // The sections are in the rail (FRU-234), and the title is under the rail at the padding of the
  // mockup, 40 px: no more, so nothing takes room between the two.
  const rail = await page.locator('aside.kit-rail').boundingBox();
  const title = await page.locator('main h1').boundingBox();
  expect(title!.y - (rail!.y + rail!.height)).toBeLessThanOrEqual(40);
  expect(title!.y - (rail!.y + rail!.height)).toBeGreaterThan(0);

  const host = page.getByText(LONG_HOST, { exact: true });
  await expect(host).toBeVisible();
  // Read in full: nothing cut, and nothing past the right edge of the screen.
  expect(await host.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const box = await host.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

// The setup on a narrow screen (FRU-160) is measured with the setup, in `console-setup.spec.ts`.

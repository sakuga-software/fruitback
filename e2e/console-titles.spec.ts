import { type Page, expect, test } from '@playwright/test';
import { ACME, box, sideScroll, stubWorker, styles } from './console-workspace.ts';

/**
 * The title of every page of a workspace and of the administration is at one place, in one size
 * (FRU-405): 40 px under the top of the screen, at the left of its padding, 28 px. The statuses of a
 * site drew their crumbs above the title, which put it 31 px lower than on every other page. The
 * worker is answered by stubs; the sample data is of nobody.
 */
const CONSOLE = 'http://localhost:5178';

const PAGES = [
  '/w/w1/sites',
  '/w/w1/sites/s1',
  '/w/w1/sites/s1/statuses',
  '/w/w1/notes',
  '/w/w1/connectors',
  '/w/w1/members',
  '/w/w1/account',
  '/admin',
  '/admin/workspaces',
  '/admin/users',
  '/admin/notes',
];

/** The person administers the instance, so both frames open. */
async function stub(page: Page, locale: 'en' | 'fr'): Promise<void> {
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale },
    workspaces: [ACME],
    instanceAdmin: true,
  };
  await stubWorker(page, {
    locale,
    workspaces: [ACME],
    answer: (pathname, route) => (pathname === '/console/me' ? route.fulfill({ json: me }) : undefined),
  });
}

/** Where the title is in its screen, and its type. */
async function titleOf(page: Page, path: string): Promise<Record<string, string | number>> {
  await page.goto(`${CONSOLE}${path}`);
  const title = page.locator('main h1');
  await expect(title).toBeVisible();
  const main = await box(page.locator('main'));
  const found = await box(title);
  const padding = await styles(page.locator('main'), ['padding-left']);

  return {
    top: Math.round(found.y - main.y),
    left: Math.round(found.x - main.x - Number.parseFloat(padding['padding-left'] ?? '0')),
    ...(await styles(title, ['font-size', 'line-height', 'font-weight', 'letter-spacing'])),
  };
}

for (const [width, locale] of [
  [1440, 'en'],
  [1492, 'fr'],
  [390, 'fr'],
] as const) {
  test(`every page title is at the same place and the same size, at ${width} px in ${locale}`, async ({ page }) => {
    await stub(page, locale);
    await page.setViewportSize({ width, height: 847 });
    const first = await titleOf(page, PAGES[0]!);
    expect(first).toEqual({
      top: 40,
      left: 0,
      'font-size': '28px',
      'line-height': '32.2px',
      'font-weight': '700',
      'letter-spacing': '-0.56px',
    });
    for (const path of PAGES.slice(1)) {
      expect.soft(await titleOf(page, path), path).toEqual(first);
      expect.soft(await sideScroll(page), path).toBe(0);
    }
  });
}

test('the crumbs of the statuses of a site are above the title, in the room of the top of the screen', async ({
  page,
}) => {
  await stub(page, 'en');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1/statuses`);
  const crumbs = await box(page.getByRole('navigation', { name: 'Breadcrumb' }));
  const title = await box(page.locator('main h1'));
  const main = await box(page.locator('main'));
  expect(crumbs.y).toBeGreaterThan(main.y);
  expect(crumbs.y + crumbs.height).toBeLessThanOrEqual(title.y);
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Sites' })).toBeVisible();
});

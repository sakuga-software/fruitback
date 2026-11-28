import { type Page, expect, test } from '@playwright/test';
import { ACME, box, sideScroll, stubWorker, styles } from './console-workspace.ts';

/**
 * The title of every page of a workspace and of the administration is at one place, in one size
 * (FRU-405): 40 px under the top of the screen, at the left of its padding, 28 px. The statuses of a
 * site drew their crumbs above the title, which put it 31 px lower than on every other page. The
 * worker is answered by stubs; the sample data is of nobody.
 *
 * The pages of the shell of the settings (FRU-692: My account, the settings of the workspace) have
 * their own head, a title of 20 px under the bar of the shell: `console-account.spec.ts` holds it.
 */
const CONSOLE = 'http://localhost:5178';

const PAGES = [
  // FRU-688: Sites has the head of 48 px of the redesign, as Notes: console-sites.spec.ts measures it.
  // FRU-689: the page of a site and its tabs (the statuses among them) have it too, the site as their
  // title: console-site-page.spec.ts measures it.
  // FRU-686: Notes has the head of 48 px of its mockup, « Notes » at 14 px beside its tabs:
  // console-notes.spec.ts measures it. FRU-691: Members has it too, console-members.spec.ts.
  // FRU-738: Connectors has it too, console-connectors-table.spec.ts.
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
      'font-size': '20px',
      'line-height': '25px',
      'font-weight': '700',
      'letter-spacing': '-0.4px',
    });
    for (const path of PAGES.slice(1)) {
      expect.soft(await titleOf(page, path), path).toEqual(first);
      expect.soft(await sideScroll(page), path).toBe(0);
    }
  });
}

test('the statuses of a site are a tab of its page, under the crumbs « Sites › site » (FRU-689)', async ({ page }) => {
  await stub(page, 'en');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1/statuses`);
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByRole('link', { name: 'Sites' })).toBeVisible();
  await expect(crumbs.locator('h1')).toHaveText('staging.acme.dev');
  await expect(
    page.getByRole('navigation', { name: 'Sections of the site' }).getByRole('link', { name: 'Statuses' }),
  ).toHaveAttribute('aria-current', 'page');
});

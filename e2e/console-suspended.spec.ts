import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, LUMEN, contrast, painted, rgb, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * A suspended workspace, as its members read it (FRU-328): a banner at the top of the console of the
 * workspace says since when, and who to ask, and never the reason of the administrator. A write that
 * the worker refuses with `409 workspace-suspended` says the same, in the words of the screen, and
 * the banner comes then too. The worker is answered by stubs, with the fields of `/console/me`.
 */
const CONSOLE = 'http://localhost:5178';

const SUSPENDED_AT = new Date(Date.UTC(new Date().getUTCFullYear(), 8, 30, 9)).toISOString();
const DAY = new Date(SUSPENDED_AT).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const DAY_FR = new Date(SUSPENDED_AT).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
/**
 * The note of the administrator. The worker answers it to them only (FRU-328): the stub sends it all
 * the same, as a worker of before did, and no screen of a member shows it.
 */
const REASON = 'Unpaid invoice of September';
const SUSPENDED = { ...ACME, suspended: true, suspendedAt: SUSPENDED_AT, reason: REASON };

const ACCENT_STRONG = '#b91c1c';
const SUBTLE = '#fafafa';

const LEAD =
  'An administrator of this instance suspended it. You can still read it, but nothing in it can change, and its sites take no notes. To restore it, contact the administrator of this instance.';
const REFUSED = 'This workspace is suspended, so nothing in it can change. Contact the administrator of this instance.';

const banner = (page: Page) => page.getByRole('status').filter({ hasText: /suspend/i });

async function open(page: Page, screen = 'sites', workspace = 'w1'): Promise<void> {
  await page.goto(`${CONSOLE}/w/${workspace}/${screen}`);
  await expect(page.locator('main h1')).toBeVisible();
}

async function axe(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

/** Every write of the workspace is refused as the worker refuses it, with the day it tells a member. */
function refusingWrites(posted: string[]) {
  return (pathname: string, route: Route) => {
    const method = route.request().method();
    if (method === 'GET' || method === 'OPTIONS' || !pathname.startsWith('/console/workspaces/')) return undefined;
    posted.push(`${method} ${pathname}`);

    return route.fulfill({ status: 409, json: { error: 'workspace-suspended', suspendedAt: SUSPENDED_AT } });
  };
}

test('a member of a suspended workspace reads a banner: since when, and who to ask, never the reason', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stubWorker(page, { workspaces: [SUSPENDED, LUMEN] });
  await open(page);

  await expect(banner(page)).toHaveText(`This workspace has been suspended since ${DAY}.${LEAD}`);
  // The banner is above the screen, in the column of the section, and not in the rail.
  await expect(page.locator('aside.kit-rail').getByRole('status')).toHaveCount(0);
  const title = banner(page).locator('p').first();
  expect.soft(await painted(title, 'color')).toEqual(rgb(ACCENT_STRONG));
  expect(contrast(await painted(title, 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);
  expect(contrast(await painted(banner(page).locator('p').last(), 'color'), rgb(SUBTLE))).toBeGreaterThanOrEqual(4.5);
  const above = await banner(page).boundingBox();
  const screen = await page.locator('main').boundingBox();
  expect(above!.y + above!.height).toBeLessThanOrEqual(screen!.y + 1);
  await expect(page.locator('body')).not.toContainText(REASON);
  await axe(page, 'the banner at 1440 px');

  // Every section of the workspace shows it; the reason shows on none of them.
  for (const section of ['notes', 'connectors', 'members', 'account']) {
    await page
      .locator('aside.kit-rail')
      .getByRole('link', { name: new RegExp(`^${section}$|^my ${section}$`, 'i') })
      .click();
    await expect(page).toHaveURL(new RegExp(`/w/w1/${section}`));
    await expect(banner(page)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(REASON);
  }

  // A workspace that is not suspended has no banner: the control.
  await open(page, 'sites', 'w2');
  await expect(page.getByRole('heading', { level: 1, name: 'Sites' })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
});

test('a suspension the worker answers with no day says only that the workspace is suspended', async ({ page }) => {
  await stubWorker(page, { workspaces: [{ ...ACME, suspended: true }] });
  await open(page);

  await expect(banner(page)).toHaveText(`This workspace is suspended.${LEAD}`);
});

test('a write refused with 409 workspace-suspended says so, keeps what was typed, and shows the banner', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const posted: string[] = [];
  // `/console/me` was read before the suspension: the workspace reads as active.
  await stubWorker(page, { workspaces: [ACME, LUMEN], answer: refusingWrites(posted) });
  await open(page);
  await expect(banner(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  const form = page.getByRole('region', { name: 'Add a site' });
  await form.getByRole('textbox', { name: 'Site address' }).fill('docs.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();

  await expect(form.getByRole('alert')).toHaveText(REFUSED);
  await expect(form.getByRole('textbox', { name: 'Site address' })).toHaveValue('docs.acme.dev');
  await expect(banner(page)).toHaveText(`This workspace has been suspended since ${DAY}.${LEAD}`);
  expect(posted).toEqual(['POST /console/workspaces/w1/sites']);
  await axe(page, 'a write refused while suspended');

  // The control: another refusal of the worker keeps the sentence of the screen, and no banner.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stubWorker(page, {
    workspaces: [ACME, LUMEN],
    answer: (pathname, route) =>
      route.request().method() === 'POST' && pathname === '/console/workspaces/w1/sites'
        ? route.fulfill({ status: 409, json: { error: 'site-exists' } })
        : undefined,
  });
  await open(page);
  await page.getByRole('button', { name: 'Add a site', exact: true }).click();
  await form.getByRole('textbox', { name: 'Site address' }).fill('docs.acme.dev');
  await form.getByRole('button', { name: 'Add site', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText('The site was not added. Try again.');
  await expect(banner(page)).toHaveCount(0);
});

test('in French and at 390 px, the banner and the refusal are French, and nothing scrolls sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posted: string[] = [];
  await stubWorker(page, { locale: 'fr', workspaces: [SUSPENDED, LUMEN], answer: refusingWrites(posted) });
  await open(page);

  await expect(banner(page)).toHaveText(
    `Ce workspace est suspendu depuis le ${DAY_FR}.Un administrateur de cette instance l’a suspendu. Vous pouvez toujours le lire, mais rien ne peut y changer, et ses sites ne prennent aucune note. Pour le rétablir, contactez l’administrateur de cette instance.`,
  );
  await expect(page.locator('body')).not.toContainText(REASON);
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'the banner at 390 px, in French');

  await page.getByRole('button', { name: 'Ajouter un site', exact: true }).click();
  const form = page.getByRole('region', { name: 'Ajouter un site' });
  await form.getByRole('textbox', { name: 'Adresse du site' }).fill('docs.acme.dev');
  await form.getByRole('button', { name: 'Ajouter le site', exact: true }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Ce workspace est suspendu : rien ne peut y changer. Contactez l’administrateur de cette instance.',
  );
  expect(posted).toEqual(['POST /console/workspaces/w1/sites']);
  expect(await sideScroll(page)).toBe(0);
  await axe(page, 'a write refused while suspended, at 390 px, in French');
});

test('an invitation that the organization plugin refuses while suspended says so too', async ({ page }) => {
  // The guard of the worker answers the routes of the organization plugin with the same `409`.
  await stubWorker(page, {
    workspaces: [ACME, LUMEN],
    answer: (pathname, route) =>
      route.request().method() === 'POST' && pathname.endsWith('/invite-member')
        ? route.fulfill({ status: 409, json: { error: 'workspace-suspended', suspendedAt: SUSPENDED_AT } })
        : undefined,
  });
  await open(page, 'members');
  const form = page.getByRole('form', { name: 'Invite someone' });
  await form.getByRole('textbox', { name: 'Email' }).fill('dana@acme.dev');
  await form.getByRole('button', { name: 'Invite', exact: true }).click();
  // The sentence is under the form, where the screen says its refusals.
  await expect(page.locator('main').getByRole('alert').filter({ hasText: REFUSED })).toHaveText(REFUSED);
  await expect(form.getByRole('textbox', { name: 'Email' })).toHaveValue('dana@acme.dev');
  await expect(banner(page)).toHaveText(`This workspace has been suspended since ${DAY}.${LEAD}`);
});

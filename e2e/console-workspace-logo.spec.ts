import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type StubbedWorkspace, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * The logo of a workspace (FRU-428), on its settings and in the rail. An owner or an admin sends
 * one, replaces it and removes it; the rail shows the change at once; without one, the initial of
 * the name shows. The console refuses an SVG and a file over 512 KB before it sends anything, and
 * says each refusal of the worker. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

/** A PNG of 16 × 16 pixels, orange. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGN4EctCEmIY1TCqYfhqAADMmEkQa4Cp+AAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Logo = StubbedWorkspace & { logo?: string | null };
type Worker = {
  sent: { type: string | null; size: number }[];
  removed: number;
  /** A code the worker refuses the next logo with. */
  refuses?: string;
  /** Holds the answer of a write until it is released. */
  hold?: Promise<void>;
};

async function workerWith(page: Page, workspace: Logo, locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { sent: [], removed: 0 };
  const kept: Logo = { ...workspace };
  let version = 1;
  await stubWorker(page, {
    locale,
    workspaces: [kept],
    answer: (pathname, route: Route) => {
      const request = route.request();
      if (pathname === '/console/me')
        return route.fulfill({
          json: { account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale }, workspaces: [kept] },
        });
      if (pathname !== `/console/workspaces/${kept.id}/logo`) return undefined;
      if (request.method() === 'GET') return route.fulfill({ body: PNG, contentType: 'image/png' });

      return (async () => {
        await worker.hold;
        if (request.method() === 'DELETE') {
          worker.removed += 1;
          kept.logo = null;

          return route.fulfill({ json: { logo: null } });
        }
        worker.sent.push({
          type: request.headers()['content-type'] ?? null,
          size: request.postDataBuffer()?.length ?? 0,
        });
        if (worker.refuses !== undefined) return route.fulfill({ status: 400, json: { error: worker.refuses } });
        version += 1;
        kept.logo = `/console/workspaces/${kept.id}/logo?v=${version}`;

        return route.fulfill({ json: { logo: kept.logo } });
      })();
    },
  });

  return worker;
}

const rail = (page: Page) => page.locator('aside');
const picker = (page: Page) => page.locator('input[type="file"]');
const file = (name: string, mimeType: string, buffer: Buffer) => ({ name, mimeType, buffer });

test('an owner sends a logo, the rail shows it at once, then replaces it and removes it', async ({ page }) => {
  const worker = await workerWith(page, { ...ACME, logo: null });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const logo = page.getByRole('region', { name: 'Logo' });
  // No logo: the initial, in the rail and on the screen.
  await expect(rail(page).locator('img')).toHaveCount(0);
  await expect(rail(page).getByRole('link', { name: /^Acme Cloud workspace/ })).toContainText('A');
  await expect(logo.getByRole('button', { name: 'Remove the logo' })).toHaveCount(0);

  let release = () => {};
  worker.hold = new Promise((resolve) => (release = resolve));
  await picker(page).setInputFiles(file('acme.png', 'image/png', PNG));
  // While it is sent: said on the button, and nothing else can be pressed.
  await expect(logo.getByRole('button', { name: 'Uploading…' })).toBeDisabled();
  await expect(logo).toHaveAttribute('aria-busy', 'true');
  release();
  await expect(page.getByRole('status').filter({ hasText: 'The logo is saved.' })).toBeVisible();
  expect(worker.sent).toEqual([{ type: 'image/png', size: PNG.length }]);
  await expect(rail(page).locator('img')).toHaveAttribute('src', /\/console\/workspaces\/w1\/logo\?v=2$/);
  await expect(logo.locator('img')).toHaveAttribute('src', /\?v=2$/);
  await expect
    .poll(() =>
      rail(page)
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(16);
  const box = await rail(page).locator('img').boundingBox();
  expect([box?.width, box?.height]).toEqual([32, 32]);
  // The rail keeps it on the next screen.
  await rail(page).getByRole('link', { name: 'Sites', exact: true }).click();
  await expect(rail(page).locator('img')).toHaveAttribute('src', /\?v=2$/);
  await rail(page)
    .getByRole('link', { name: /^Acme Cloud workspace/ })
    .click();

  await expect(logo.getByRole('button', { name: 'Replace the logo' })).toBeVisible();
  await picker(page).setInputFiles(file('acme.png', 'image/png', PNG));
  await expect(rail(page).locator('img')).toHaveAttribute('src', /\?v=3$/);

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  await logo.getByRole('button', { name: 'Remove the logo' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The logo is removed.' })).toBeVisible();
  expect(worker.removed).toBe(1);
  await expect(rail(page).locator('img')).toHaveCount(0);
  await expect(logo.getByRole('button', { name: 'Upload a logo' })).toBeVisible();
});

test('an SVG and a file over 512 KB are refused before anything is sent, and a refusal of the worker is said', async ({
  page,
}) => {
  const worker = await workerWith(page, { ...ACME, role: 'admin', logo: null });
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const alert = page.getByRole('alert');

  await picker(page).setInputFiles(file('logo.svg', 'image/svg+xml', SVG));
  await expect(alert).toHaveText('Choose a PNG, JPEG or WebP image. SVG is not accepted.');
  await picker(page).setInputFiles(file('big.png', 'image/png', Buffer.alloc(512 * 1_024 + 1)));
  await expect(alert).toHaveText('The image is over 512 KB. Choose a smaller one.');
  expect(worker.sent).toEqual([]);

  worker.refuses = 'type-mismatch';
  await picker(page).setInputFiles(file('fake.png', 'image/png', SVG));
  await expect(alert).toHaveText('This file is not the image its type says. Choose another one.');
  worker.refuses = 'image-too-large';
  await picker(page).setInputFiles(file('huge.png', 'image/png', PNG));
  await expect(alert).toHaveText('The image is over 4096 pixels on a side. Choose a smaller one.');
  expect(worker.sent).toHaveLength(2);
  await expect(rail(page).locator('img')).toHaveCount(0);

  // A logo that is taken clears the refusal.
  worker.refuses = undefined;
  await picker(page).setInputFiles(file('acme.png', 'image/png', PNG));
  await expect(page.getByRole('status').filter({ hasText: 'The logo is saved.' })).toBeVisible();
  await expect(alert).toHaveCount(0);
});

test('a member sees the logo and changes nothing', async ({ page }) => {
  await workerWith(page, { ...ACME, role: 'member', logo: '/console/workspaces/w1/logo?v=1' });
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const logo = page.getByRole('region', { name: 'Logo' });
  await expect(logo.locator('img')).toHaveAttribute('src', /\?v=1$/);
  await expect(rail(page).locator('img')).toHaveAttribute('src', /\?v=1$/);
  await expect(logo.getByRole('button')).toHaveCount(0);
  await expect(picker(page)).toHaveCount(0);
  await expect(logo.getByText('Only an owner or an admin of the workspace changes its logo.')).toBeVisible();
});

test('at 390 px in French, with a logo, nothing scrolls sideways', async ({ page }) => {
  const worker = await workerWith(page, { ...ACME, logo: '/console/workspaces/w1/logo?v=1' }, 'fr');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/w/w1/settings`);
  const logo = page.getByRole('region', { name: 'Logo' });
  await expect(logo.getByRole('button', { name: 'Remplacer le logo' })).toBeVisible();
  await expect(logo.getByRole('button', { name: 'Retirer le logo' })).toBeVisible();
  await expect(rail(page).locator('img')).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  let results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);

  await picker(page).setInputFiles(file('logo.svg', 'image/svg+xml', SVG));
  await expect(page.getByRole('alert')).toHaveText('Choisissez une image PNG, JPEG ou WebP. Le SVG n’est pas accepté.');
  expect(await sideScroll(page)).toBe(0);
  results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
  expect(worker.sent).toEqual([]);
});

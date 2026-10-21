import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The moves between a workspace and the administration of the instance (FRU-356).
 *
 * Each frame asked `/console/me` again when it mounted and showed « Loading… » with no rail until
 * the worker answered: at 250 ms of latency, 37 frames of the page had no rail on the way to the
 * administration, and 115 on the way back. The frames now draw the last answer of the tab at once.
 * Each frame of the page is read during the move (`requestAnimationFrame`): none may lose the rail.
 */
const CONSOLE = 'http://localhost:5178';
const LATENCY = 250;

async function stub(page: Page): Promise<string[]> {
  const asked: string[] = [];
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
    workspaces: [
      { id: 'w1', name: 'Acme', role: 'owner' },
      { id: 'w2', name: 'Lumen', role: 'member' },
    ],
    instanceAdmin: true,
  };
  await page.route(`${WORKER_ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    asked.push(pathname);
    await new Promise((done) => setTimeout(done, LATENCY));
    if (pathname === '/console/me') return route.fulfill({ json: me });
    if (pathname === '/console/admin/instance') return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    if (pathname.endsWith('/sites')) return route.fulfill({ json: { sites: [] } });

    return route.fulfill({ json: {} });
  });

  return asked;
}

/** Starts to read, at each frame of the page, whether a rail is drawn. */
async function watchFrames(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    const tick = () => {
      seen.push(document.querySelector('aside nav') !== null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** How many frames were drawn since the watch started, and how many had no rail. Starts again. */
async function framesSeen(page: Page): Promise<{ frames: number; withoutRail: number }> {
  return page.evaluate(() => {
    const window_ = window as unknown as { seen: boolean[] };
    const seen = window_.seen.splice(0);

    return { frames: seen.length, withoutRail: seen.filter((rail) => !rail).length };
  });
}

test('the rail stays on screen between a workspace and the administration, both ways', async ({ page }) => {
  const asked = await stub(page);
  await page.goto(`${CONSOLE}/w/w1/sites`);
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible();
  await watchFrames(page);
  const reads = () => asked.filter((path) => path === '/console/me').length;
  const before = reads();

  await page.getByRole('link', { name: 'Administration' }).click();
  await expect(page.getByRole('navigation', { name: 'Instance' }).getByRole('link', { name: 'Users' })).toBeVisible();
  await page.waitForTimeout(LATENCY * 2);
  const there = await framesSeen(page);
  expect(there.frames).toBeGreaterThan(10);
  expect(there.withoutRail).toBe(0);

  // « My workspaces » goes to the first workspace itself, not through the front door.
  await page.getByRole('link', { name: 'My workspaces' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/sites`);
  await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible();
  await page.waitForTimeout(LATENCY * 2);
  const back = await framesSeen(page);
  expect(back.frames).toBeGreaterThan(10);
  expect(back.withoutRail).toBe(0);
  // Each frame still asks the worker again: what it drew first is checked.
  expect(reads()).toBeGreaterThanOrEqual(before + 2);
  // Not through the front door, which asks for the invitations before it goes anywhere.
  expect(asked.filter((path) => path.endsWith('/list-user-invitations'))).toEqual([]);

  // The control: a page loaded afresh has no answer to draw, and the same watch sees frames with no rail.
  const fresh = await page.context().newPage();
  await stub(fresh);
  await fresh.addInitScript(() => {
    const seen: boolean[] = [];
    (window as unknown as { seen: boolean[] }).seen = seen;
    const tick = () => {
      seen.push(document.querySelector('aside nav') !== null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await fresh.goto(`${CONSOLE}/admin`);
  await expect(fresh.getByRole('navigation', { name: 'Instance' })).toBeVisible();
  expect((await framesSeen(fresh)).withoutRail).toBeGreaterThan(0);
});

test('the screen cross-fades, and nothing moves with reduced motion', async ({ browser }) => {
  for (const motion of ['no-preference', 'reduce'] as const) {
    const context = await browser.newContext({ reducedMotion: motion });
    const page = await context.newPage();
    await stub(page);
    await page.goto(`${CONSOLE}/w/w1/sites`);
    await expect(page.getByRole('link', { name: 'Administration' })).toBeVisible();
    await page.waitForTimeout(LATENCY * 2);
    // The animations of the view transition, read while it runs.
    await page.evaluate(() => {
      const found: string[] = [];
      (window as unknown as { found: string[] }).found = found;
      const tick = () => {
        for (const animation of document.getAnimations()) {
          const name = (animation as CSSAnimation).animationName;
          if (typeof name === 'string' && !found.includes(name)) found.push(name);
        }
        if (found.length < 5) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByRole('link', { name: 'Administration' }).click();
    await expect(page.getByRole('navigation', { name: 'Instance' })).toBeVisible();
    await page.waitForTimeout(400);
    const found = await page.evaluate(() => (window as unknown as { found: string[] }).found);
    if (motion === 'reduce') expect(found.filter((name) => name.startsWith('kit-screen'))).toEqual([]);
    else expect(found).toEqual(expect.arrayContaining(['kit-screen-out', 'kit-screen-in']));
    expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);
    await context.close();
  }
});

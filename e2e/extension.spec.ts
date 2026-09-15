import { type Page, expect, test as withoutExtension } from '@playwright/test';
import {
  addRule,
  mintPairingCode,
  openBareSite,
  pairFromPopup,
  readableByThePage,
  recordPageMessages,
  seedsOn,
  storedTokens,
  test,
} from './extension.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The extension across its worlds (SKG-538): what a site gets with it, without it, and what its page
 * can never read.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const REVIEWER = 'E2E Reviewer';

/** The requests a page sends to the worker, counted from the moment this is called. */
function workerCalls(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith(WORKER_ORIGIN)) calls.push(request.url());
  });

  return calls;
}

/**
 * Enough time for a registered script to run and a widget to mount and read.
 *
 * An absence has no signal to wait for. The specs that expect a widget on the same page show that it
 * arrives well inside this delay.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
}

async function plantOnTheLatteCard(page: Page, launch: string | RegExp, note: string): Promise<void> {
  await page.getByRole('button', { name: launch }).click();
  await page.locator('[data-testid="card-latte"] .add').click();
  await page.getByPlaceholder('What is wrong here?').fill(note);
  await page.getByRole('button', { name: 'Plant', exact: true }).click();
}

withoutExtension('without the extension, the site holds no widget and calls no worker', async ({ page }) => {
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-absent');
  await settle(page);

  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => 'fruitbackExtension' in window)).toBe(false);
});

test('an origin with no rule mounts nothing, until a rule covers it', async ({ extension }) => {
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-no-rule');
  await settle(page);

  // The copy holds host access to this origin, so what keeps the page empty is the missing rule.
  await expect(page.locator('[data-fruitback-host]')).toHaveCount(0);
  expect(calls).toEqual([]);
  expect(await page.evaluate(() => '__fruitbackPageScript' in window || 'fruitbackExtension' in window)).toBe(false);

  await addRule(extension, { mode: 'private', clientId: 'playground' });
  await page.reload();

  await expect(page.getByRole('button', { name: /Leave feedback/ })).toBeVisible();
});

test('private mode: the mounted widget reads the component, and the pin comes back', async ({ extension }) => {
  await addRule(extension, { mode: 'private', clientId: 'playground' });
  const page = await extension.context.newPage();
  await openBareSite(page, 'ext-private');

  await plantOnTheLatteCard(page, /Leave feedback/, 'Planté par le mode privé');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // The component name comes from the React fiber, which only the page's own world can see. A widget
  // mounted from the isolated world would store the note with no source.
  const [seed] = await seedsOn(page);
  expect(seed?.note).toBe('Planté par le mode privé');
  expect(seed?.source).toMatchObject({ component: 'Button', file: expect.stringContaining('site.tsx') });

  await page.reload();
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);
});

/** What a team-mode site ships: a dormant widget that mounts when the extension announces itself. */
async function mountTheSiteWidget(page: Page): Promise<void> {
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    type Mounted = { destroy(): void };
    const scope = globalThis as {
      Fruitback: { init(options: Record<string, unknown>): Mounted };
      fruitbackExtension?: { transport: unknown };
    };
    let widget: Mounted | undefined;
    const follow = (): void => {
      widget?.destroy();
      widget = undefined;
      if (scope.fruitbackExtension === undefined) return;
      widget = scope.Fruitback.init({
        endpoint,
        clientId: 'playground',
        label: 'Team feedback',
        transport: scope.fruitbackExtension.transport,
      });
    };
    // The extension can announce before or after this runs, so the site does both.
    window.addEventListener('fruitback:extension', follow);
    follow();
  }, WORKER_ORIGIN);
}

test('team mode: paired from the popup, the site writes through the relay and never sees a token', async ({
  extension,
}) => {
  await recordPageMessages(extension.context);
  await addRule(extension, { mode: 'team' });
  const page = await extension.context.newPage();
  const calls = workerCalls(page);
  await openBareSite(page, 'ext-team');
  await mountTheSiteWidget(page);
  await expect(page.getByRole('button', { name: 'Team feedback' })).toBeVisible();

  await pairFromPopup(extension, page, mintPairingCode(REVIEWER), REVIEWER);

  await plantOnTheLatteCard(page, 'Team feedback', 'Planté par le mode équipe');
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // Signed by the worker from the session: only the relay carries it.
  const [seed] = await seedsOn(page);
  expect(seed?.reporter).toMatchObject({ name: REVIEWER, verified: true });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Nos formules' })).toBeVisible();
  await mountTheSiteWidget(page);
  await expect(page.locator('[data-fruitback-pin]')).toHaveCount(1);

  // Every call went through the background. The page itself never called the worker.
  expect(calls).toEqual([]);

  const tokens = await storedTokens(extension.worker);
  // A refresh token and an access token, or the search below proves nothing.
  expect(tokens.length).toBeGreaterThanOrEqual(2);
  const readable = await readableByThePage(page);
  const { messages, chromeStorage } = JSON.parse(readable) as { messages: string[]; chromeStorage: string };
  expect(messages.join('\n')).toContain('relay-response');
  for (const token of tokens) expect(readable).not.toContain(token);
  // Only the messages: the widget script on the page names the header in its own code.
  expect(messages.join('\n')).not.toMatch(/authorization/i);
  expect(chromeStorage).toBe('undefined');
});

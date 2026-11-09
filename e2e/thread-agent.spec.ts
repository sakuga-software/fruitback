import { type Page, expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { WORKER_ORIGIN, caseOf, hydrated, pinFor } from './pin.ts';

/**
 * « An agent is working on this note » in the thread of the pin (FRU-618), in a real browser.
 *
 * Which notes an agent works on, and who gets the address of its session, is the worker's
 * (`agent-read.test.ts`, with a session of a member, of a guest and none). The first worker of the
 * suite starts no routine, so its read is changed here: once as a member reads it, once as anybody
 * else does. The line, its link, its tab and its contrast are what this spec holds.
 */

const IIFE = 'packages/widget/dist/fruitback.iife.js';
const SESSION = 'https://claude.ai/code/session_01AbC';

/** Every note of the read is one an agent works on, with the session or not. */
async function agentInTheRead(page: Page, agent: { url?: string }): Promise<void> {
  await page.route(`${WORKER_ORIGIN}/feedback?**`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { issues: Record<string, unknown>[] };
    for (const issue of body.issues) issue.agent = agent;
    await route.fulfill({ response, json: body });
  });
}

async function publicPage(page: Page, testCase: string): Promise<void> {
  await page.goto(`/?widget=off&case=${caseOf(testCase)}`);
  await page.getByRole('heading', { name: 'Nos formules' }).waitFor();
  await hydrated(page);
  await page.addScriptTag({ path: IIFE });
  await page.evaluate((endpoint) => {
    const scope = globalThis as unknown as { Fruitback: { init(options: Record<string, unknown>): unknown } };
    scope.Fruitback.init({ endpoint, clientId: 'playground', locale: 'en-US' });
  }, WORKER_ORIGIN);
}

async function plant(page: Page, note: string): Promise<void> {
  await page.getByRole('button', { name: 'Leave a note' }).click();
  await page.locator('[data-testid="card-espresso"] .add').click();
  await page.getByPlaceholder('What should change?').fill(note);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New note' })).toBeHidden({ timeout: 10_000 });
}

test('the thread says an agent works on the note, and links its session for a member of the team (FRU-618)', async ({
  page,
  context,
}) => {
  await publicPage(page, 'thread-agent-team');
  await plant(page, 'An agent takes this one');
  await agentInTheRead(page, { url: SESSION });
  await publicPage(page, 'thread-agent-team');

  await pinFor(page, 'An agent takes this one').getByRole('button').click();
  const line = page.locator('.fruitback-thread-agent');
  await expect(line).toHaveText('An agent is working on this note · Open the session');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const scanned = await new AxeBuilder({ page }).include('[data-fruitback-host]').analyze();
  expect(scanned.violations.map((violation) => violation.id)).toEqual([]);

  // The session opens in a tab of its own, and the page stays where it is.
  await context.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, body: 'session' }));
  const [opened] = await Promise.all([
    context.waitForEvent('page'),
    line.getByRole('link', { name: 'Open the session' }).click(),
  ]);
  expect(opened.url()).toBe(SESSION);
  expect(page.url()).toContain('thread-agent-team');
});

test('the thread says an agent works on the note, and no link, for a reader who is not of the team (FRU-618)', async ({
  page,
}) => {
  await publicPage(page, 'thread-agent-reader');
  await plant(page, 'An agent takes that one');
  await agentInTheRead(page, {});
  await publicPage(page, 'thread-agent-reader');

  await pinFor(page, 'An agent takes that one').getByRole('button').click();
  await expect(page.locator('.fruitback-thread-agent')).toHaveText('An agent is working on this note');
  await expect(page.locator('.fruitback-thread-agent').getByRole('link')).toHaveCount(0);
});

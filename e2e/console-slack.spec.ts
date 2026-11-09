import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker, fulfillSites } from './console-workspace.ts';

/**
 * The Slack connector (FRU-624) in « Add a connector »: its card, its form of a webhook and of the
 * notes to post, a refusal that keeps what was typed, and the panel of the new connector with the
 * notes that did not reach Slack. The worker is answered by stubs; its side is
 * `apps/worker/src/trackers/slack.test.ts`, against a fake Slack.
 */
const CONSOLE = 'http://localhost:5178';

const HOOK = 'https://hooks.slack.com/services/T0ACME01/B0NOTES1/abcDEF0123456789xyz';
const SLACK = {
  id: 'c5',
  kind: 'slack',
  label: 'Slack · T0ACME01/B0NOTES1',
  createdAt: '2026-11-08T10:00:00.000Z',
  settings: { showComments: true, stages: {} },
};
const HOOK_REST = {
  id: 'c2',
  kind: 'rest',
  label: 'REST · https://hooks.acme.dev',
  createdAt: '2026-10-01T10:00:00.000Z',
};
const PLACE = { connector: 'c5', teamId: 'channel', label: 'Slack · channel' };
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'everyone', destinations: [PLACE] }];

type Worker = { connectors: unknown[]; added: Record<string, unknown>[] };

async function workerWith(page: Page, options: { connectors?: unknown[]; locale?: 'en' | 'fr' } = {}): Promise<Worker> {
  const worker: Worker = { connectors: options.connectors ?? [HOOK_REST], added: [] };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const read = fulfillSites(route, SITES);
    if (read !== false) return read;
    if (pathname === '/console/workspaces/w1/connectors') {
      if (route.request().method() === 'GET') {
        return json({
          connectors: worker.connectors,
          available: true,
          trackers: [{ kind: 'slack', oauth: false, token: true }],
        });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      worker.added.push(body);
      if (body.url !== HOOK) return json({ error: 'key-refused' }, 400);
      worker.connectors = [...worker.connectors, SLACK];

      return json(SLACK, 201);
    }
    if (pathname === '/console/workspaces/w1/connectors/c5/deliveries') {
      return json({
        deliveries: [
          {
            id: 'dlv_1',
            event: 'note.created',
            createdAt: '2026-11-08T11:00:00.000Z',
            attempts: 1,
            lastStatus: 410,
            lastError: 'Slack refused the channel: channel_is_archived',
          },
        ],
      });
    }

    return undefined;
  };
  await stubWorker(page, {
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    workspaces: [{ ...ACME, role: 'owner' }],
    answer,
  });

  return worker;
}

async function expectNoViolation(page: Page): Promise<void> {
  // A panel that opens fades in: axe reads the colours once it has.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

for (const width of [390, 1440]) {
  test(`Slack is connected from its card with a webhook and the notes to post, at ${width} px`, async ({ page }) => {
    const worker = await workerWith(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${CONSOLE}/w/w1/connectors`);
    await page.getByRole('button', { name: 'New connector' }).click();
    const card = page.getByRole('dialog', { name: 'Add a connector' }).locator('[data-source="Slack"]');
    await expect(card).toHaveCount(1);
    await expect(card.locator('svg[data-mark="slack"]')).toHaveCount(1);
    await card.getByRole('button', { name: 'Connect Slack' }).click();

    // Verified notes are the default.
    await expect(card.getByRole('button', { name: /Notes to post/ })).toContainText('Verified notes only');
    await card.getByLabel('Webhook URL').fill('https://hooks.slack.com/services/T0ACME01/B0GONE01/removedremoved');
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(card.getByRole('alert')).toContainText('Slack refused this webhook');
    expect(worker.added.at(-1)).toMatchObject({ kind: 'slack', notes: 'verified' });
    await expectNoViolation(page);
    expect(await sideScroll(page)).toBe(0);

    await card.getByRole('button', { name: /Notes to post/ }).click();
    await page.getByRole('option', { name: 'Every note' }).click();
    await card.getByLabel('Webhook URL').fill(HOOK);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    expect(worker.added.at(-1)).toEqual({ kind: 'slack', url: HOOK, notes: 'all' });
    // Its panel opens with the site that sends there and the notes that did not reach Slack.
    const panel = page.getByRole('region', { name: /Slack/ });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Slack · channel');
    await expect(panel.locator('[data-deliveries]')).toContainText(
      'Slack did not take it: Slack refused the channel: channel_is_archived',
    );
    expect(await page.content()).not.toContain('abcDEF0123456789xyz');
    await expectNoViolation(page);
    expect(await sideScroll(page)).toBe(0);
  });
}

test('a webhook Slack refuses since a moment says to make a new one, in French too', async ({ page }) => {
  const refused = { ...SLACK, attention: { reason: 'key-refused', since: '2026-11-08T11:00:00.000Z' } };
  await workerWith(page, { connectors: [refused], locale: 'fr' });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await page.locator('button[aria-expanded]').filter({ hasText: 'Slack' }).click();
  const panel = page.getByRole('region', { name: /Slack/ });
  await expect(panel).toContainText('Slack refuse le webhook depuis');
  await expect(panel).toContainText('Créez un nouveau webhook');
});

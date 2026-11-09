import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker, fulfillSites } from './console-workspace.ts';

/**
 * The GitLab connector (FRU-623) in « Add a connector »: its card, its form of an instance and a
 * token, a refusal that keeps what was typed, the panel of the new connector, and what it says when
 * GitLab refuses its token. The worker is answered by stubs; its side is
 * `apps/worker/src/gitlab.test.ts`, against a fake GitLab.
 */
const CONSOLE = 'http://localhost:5178';

const TOKEN = 'glpat-the-token-of-one-project-only';
const GITLAB = {
  id: 'c4',
  kind: 'gitlab',
  label: 'GitLab · gitlab.acme.dev',
  createdAt: '2026-11-08T10:00:00.000Z',
  settings: { showComments: true, stages: {} },
};
const HOOK = { id: 'c2', kind: 'rest', label: 'REST · https://hooks.acme.dev', createdAt: '2026-10-01T10:00:00.000Z' };
const PLACE = { connector: 'c4', teamId: '42', label: 'GitLab · acme/web' };
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'everyone', destinations: [PLACE] }];

type Worker = { connectors: unknown[]; added: Record<string, unknown>[] };

async function workerWith(page: Page, options: { connectors?: unknown[]; locale?: 'en' | 'fr' } = {}): Promise<Worker> {
  const worker: Worker = { connectors: options.connectors ?? [HOOK], added: [] };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const read = fulfillSites(route, SITES);
    if (read !== false) return read;
    if (pathname === '/console/workspaces/w1/connectors') {
      if (route.request().method() === 'GET') {
        return json({
          connectors: worker.connectors,
          available: true,
          trackers: [{ kind: 'gitlab', oauth: false, token: true }],
        });
      }
      const body = route.request().postDataJSON() as Record<string, unknown>;
      worker.added.push(body);
      if (body.token !== TOKEN) return json({ error: 'key-refused' }, 400);
      worker.connectors = [...worker.connectors, GITLAB];

      return json(GITLAB, 201);
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
  test(`GitLab is connected from its card with an instance and a token, at ${width} px`, async ({ page }) => {
    const worker = await workerWith(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${CONSOLE}/w/w1/connectors`);
    await page.getByRole('button', { name: 'New connector' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a connector' });
    const card = dialog.locator('[data-source="GitLab"]');
    // One card of GitLab: the one that connects, and no « After the beta » beside it.
    await expect(card).toHaveCount(1);
    await expect(card.locator('svg[data-mark="gitlab"]')).toHaveCount(1);
    await expect(card.getByText('An issue in a project, cloud or self-managed.', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Connect GitLab' }).click();

    // The address may stay empty for gitlab.com; the token may not.
    const connect = card.getByRole('button', { name: 'Connect', exact: true });
    await expect(connect).toBeDisabled();
    await card.getByLabel('GitLab address (optional)').fill('https://gitlab.acme.dev');
    await card.getByLabel('Access token').fill('glpat-a-token-that-gitlab-revoked');
    await connect.click();
    // A token GitLab refuses: the sentence says why, and nothing that was typed goes.
    await expect(card.getByRole('alert')).toContainText('GitLab refused this token: it is wrong, expired or revoked.');
    await expect(card.getByLabel('GitLab address (optional)')).toHaveValue('https://gitlab.acme.dev');
    await expectNoViolation(page);
    expect(await sideScroll(page)).toBe(0);

    await card.getByLabel('Access token').fill(TOKEN);
    await connect.click();
    expect(worker.added.at(-1)).toEqual({ kind: 'gitlab', url: 'https://gitlab.acme.dev', token: TOKEN });
    // Its panel opens with the sites that send there, and no part of the page writes the token.
    const panel = page.getByRole('region', { name: /GitLab/ });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('gitlab.acme.dev');
    await expect(panel).toContainText('GitLab · acme/web');
    expect(await page.content()).not.toContain(TOKEN);
    await expectNoViolation(page);
    expect(await sideScroll(page)).toBe(0);
  });
}

test('an empty address sends none: the worker takes gitlab.com', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await page.getByRole('button', { name: 'New connector' }).click();
  const card = page.locator('[data-source="GitLab"]');
  await card.getByRole('button', { name: 'Connect GitLab' }).click();
  await card.getByLabel('Access token').fill(TOKEN);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('region', { name: /GitLab/ })).toBeVisible();
  expect(worker.added.at(-1)).toEqual({ kind: 'gitlab', token: TOKEN });
});

test('a token GitLab refuses since a moment says to make a new one, in French too', async ({ page }) => {
  const refused = { ...GITLAB, attention: { reason: 'key-refused', since: '2026-11-08T11:00:00.000Z' } };
  await workerWith(page, { connectors: [refused], locale: 'fr' });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await page.locator('button[aria-expanded]').filter({ hasText: 'GitLab' }).click();
  const panel = page.getByRole('region', { name: /GitLab/ });
  await expect(panel).toContainText('GitLab refuse le jeton depuis');
  await expect(panel).toContainText('il a expiré ou a été révoqué');
});

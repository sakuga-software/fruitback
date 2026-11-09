import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, sideScroll, stubWorker, fulfillSites } from './console-workspace.ts';
import { unfolded } from './settled.ts';

/**
 * A Claude Code routine as what the trigger of a site calls (FRU-594): connected from « Connectors »
 * with its Fire URL and its token, chosen on the page of a site, and its panel with the sessions its
 * calls started (« Session started », with the link) and the calls that did not start it. The worker
 * is answered by stubs; its side is `apps/worker/src/claude-routine.test.ts`, against a local `/fire`.
 */
const CONSOLE = 'http://localhost:5178';

const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire';
const TOKEN = 'sk-ant-oat01-the-token-of-this-task-only';
const ROUTINE = {
  id: 'c3',
  kind: 'claude-routine',
  label: 'Claude Code routine · trig_01ABCDEFGHJKLMNOPQRSTUVW',
  createdAt: '2026-11-06T10:00:00.000Z',
};
const HOOK = { id: 'c2', kind: 'rest', label: 'REST · https://hooks.acme.dev', createdAt: '2026-10-01T10:00:00.000Z' };
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'everyone', writers: 'anyone' }];
const SESSION = 'https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ';

type Worker = { connectors: unknown[]; added: unknown[]; triggers: unknown[] };

async function workerWith(
  page: Page,
  options: { connectors?: unknown[]; locale?: 'en' | 'fr'; refused?: boolean; trigger?: unknown } = {},
): Promise<Worker> {
  const worker: Worker = { connectors: options.connectors ?? [ROUTINE], added: [], triggers: [] };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const read = fulfillSites(route, SITES);
    if (read !== false) return read;
    if (pathname === '/console/workspaces/w1/connectors') {
      if (route.request().method() === 'GET') return json({ connectors: worker.connectors, available: true });
      const body = route.request().postDataJSON() as { kind: string; url: string; token: string };
      worker.added.push(body);
      if (!body.url.startsWith('https://api.anthropic.com/')) return json({ error: 'invalid-fire-url' }, 400);
      worker.connectors = [...worker.connectors, ROUTINE];

      return json(ROUTINE, 201);
    }
    if (pathname === '/console/workspaces/w1/connectors/c3/deliveries') {
      return json({
        deliveries: options.refused
          ? [
              {
                id: 'dlv_2',
                event: 'agent.requested',
                createdAt: '2026-11-06T11:00:00.000Z',
                attempts: 1,
                lastStatus: 401,
                lastError: 'The routine refused its token: generate a new one at claude.ai/code/routines',
              },
            ]
          : [],
        sessions: [
          {
            id: 'dlv_1',
            site: 's1',
            identifiers: ['FB-12', 'FB-13'],
            url: SESSION,
            startedAt: '2026-11-06T10:30:00.000Z',
          },
        ],
      });
    }
    if (pathname === '/console/workspaces/w1/sites/s1/agent-trigger') {
      if (route.request().method() === 'GET') return json({ trigger: options.trigger ?? null });
      const body = route.request().postDataJSON() as Record<string, unknown>;
      worker.triggers.push(body);

      return json({ trigger: { ...body, waiting: 0 } });
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
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

test('a routine is connected with its Fire URL and its token, which the page never shows again', async ({ page }) => {
  const worker = await workerWith(page, { connectors: [HOOK] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await page.getByRole('button', { name: 'New connector' }).click();
  const card = page.locator('[data-source="Claude Code routine"]');
  await card.getByRole('button', { name: 'Connect Claude Code routine' }).click();

  // A URL of another host is refused, and what was typed stays.
  await card.getByLabel('Fire URL').fill('https://evil.dev/fire');
  await card.getByLabel('Token').fill(TOKEN);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(card.getByText(/This is not the Fire URL of a routine/)).toBeVisible();
  await expect(card.getByLabel('Token')).toHaveValue(TOKEN);

  await card.getByLabel('Fire URL').fill(FIRE_URL);
  await card.getByRole('button', { name: 'Connect', exact: true }).click();
  // Its panel opens, and no part of the page writes the token.
  await expect(page.getByRole('region', { name: /Claude Code routine/ })).toBeVisible();
  expect(worker.added.at(-1)).toEqual({ kind: 'claude-routine', url: FIRE_URL, token: TOKEN });
  expect(await page.content()).not.toContain(TOKEN);
});

test('the panel of a routine says « Session started » with the link of each session, and the calls that did not start it', async ({
  page,
}) => {
  await workerWith(page, { refused: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const row = page.locator('button[aria-expanded]').filter({ hasText: 'Claude Code routine' });
  await expect(row).toContainText('Trigger trig_01ABCDEFGHJKLMNOPQRSTUVW');
  await expect(row).toContainText('1 call of an agent did not arrive');
  await row.click();
  await unfolded(page);
  const session = page.locator('[data-session]');
  await expect(session).toHaveCount(1);
  await expect(session).toContainText('Session started');
  await expect(session).toContainText('FB-12, FB-13');
  await expect(session.getByRole('link', { name: 'Open the session' })).toHaveAttribute('href', SESSION);
  await expect(page.locator('[data-deliveries]')).toContainText('The routine answered 401');
  await expectNoViolation(page);
});

test('the trigger of a site can call a routine, and says what its call carries: identifiers only', async ({ page }) => {
  const worker = await workerWith(page, { connectors: [HOOK, ROUTINE] });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1#agent`);
  const agent = page.getByRole('region', { name: 'Start an agent', exact: true });
  await expect(agent.getByRole('switch', { name: /Start an agent when a note arrives/ })).toBeVisible();
  await agent.getByText('Start an agent when a note arrives', { exact: true }).click();
  // The address and the routine are both offered; the routine is named by its trigger.
  await agent.getByRole('button', { name: /Call/ }).click();
  await expect(page.getByRole('option')).toHaveText([
    'hooks.acme.dev',
    'Claude Code routine · trig_01ABCDEFGHJKLMNOPQRSTUVW',
  ]);
  await page.getByRole('option', { name: 'Claude Code routine · trig_01ABCDEFGHJKLMNOPQRSTUVW' }).click();
  await expect(agent).toContainText('Notes (read each with get_note):');
  await expect(agent).not.toContainText('"event": "agent.requested"');
  await agent.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => worker.triggers.at(-1)).toEqual({ connector: 'c3', moment: 'verified-note', enabled: true });
});

test('the calls that wait for a routine are said with its trigger, not as an address (review)', async ({ page }) => {
  await workerWith(page, {
    connectors: [HOOK, ROUTINE],
    trigger: { connector: 'c3', moment: 'verified-note', enabled: true, waiting: 2 },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1#agent`);
  const agent = page.getByRole('region', { name: 'Start an agent', exact: true });
  await expect(agent).toContainText('2 calls did not arrive at Claude Code routine · trig_01ABCDEFGHJKLMNOPQRSTUVW.');
});

test('at 390 px in French, the panel says « Session lancée », and nothing scrolls sideways', async ({ page }) => {
  await workerWith(page, { locale: 'fr' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await page.locator('button[aria-expanded]').filter({ hasText: 'Routine Claude Code' }).click();
  // The panel fades in: axe reads its contrast once it is there.
  await unfolded(page);
  await expect(page.locator('[data-session]')).toContainText('Session lancée');
  await expect(page.locator('[data-session]').getByRole('link', { name: 'Ouvrir la session' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page);
});

/**
 * FRU-595: the recipes that start an agent with no code, under « Your connectors »: an agent of
 * Linear, and Claude Code in GitHub Actions. Each starts from the issue its tracker makes of a note,
 * so its card shows once that tracker is connected. Each is a card with « No code » and a link to its
 * steps in `docs/agents.md`; neither has a field.
 */
const GUIDE = 'https://fruitback.com/agents.html';
const LINEAR = { id: 'c4', kind: 'linear', label: 'Linear OAuth · Acme', createdAt: '2026-10-01T10:00:00.000Z' };
const GITHUB = { id: 'c5', kind: 'github', label: 'GitHub · acme/web', createdAt: '2026-10-02T10:00:00.000Z' };

async function openRecipes(page: Page, connectors: unknown[], locale: 'en' | 'fr' = 'en'): Promise<void> {
  await workerWith(page, { connectors, locale });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(
    page.getByRole('heading', { name: locale === 'en' ? 'Your connectors' : 'Vos connecteurs' }),
  ).toBeVisible();
}

test('the two recipes with no code sit under the trackers that make an issue, each with its steps in the guide', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecipes(page, [LINEAR, GITHUB, HOOK]);
  const recipes = page.getByRole('region', { name: 'Start an agent, with no code' });
  await expect(recipes).toBeVisible();
  await expect(recipes.getByRole('listitem')).toHaveCount(2);
  for (const [name, anchor] of [
    ['An agent of Linear', 'delegate-to-an-agent-of-linear'],
    ['Claude Code in GitHub Actions', 'claude-code-in-github-actions-on-the-issue-of-a-note'],
  ] as const) {
    const card = recipes.locator(`[data-recipe="${anchor}"]`);
    await expect(card).toContainText(name);
    await expect(card).toContainText('No code');
    const link = card.getByRole('link', { name: `Open the recipe: ${name}` });
    await expect(link).toHaveAttribute('href', `${GUIDE}#${anchor}`);
    await expect(link).toHaveAttribute('target', '_blank');
  }
  // No field: a recipe with no code takes nothing, and keeps no secret.
  await expect(recipes.getByRole('textbox')).toHaveCount(0);
  await expectNoViolation(page);
});

test('a recipe shows only with its tracker: Linear alone, then none with no tracker that makes an issue', async ({
  page,
}) => {
  await openRecipes(page, [LINEAR, HOOK]);
  const recipes = page.getByRole('region', { name: 'Start an agent, with no code' });
  await expect(recipes.getByRole('listitem')).toHaveCount(1);
  await expect(recipes.locator('[data-recipe="delegate-to-an-agent-of-linear"]')).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await openRecipes(page, [HOOK, ROUTINE]);
  // The control: the list of the connectors is there, and the recipes are not.
  await expect(page.getByRole('listitem').filter({ hasText: 'REST' })).toBeVisible();
  await expect(recipes).toHaveCount(0);
});

test('at 390 px in French, the recipes say « Sans code », and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRecipes(page, [LINEAR, GITHUB], 'fr');
  const recipes = page.getByRole('region', { name: 'Lancer un agent, sans code' });
  await recipes.scrollIntoViewIfNeeded();
  await expect(recipes.getByText('Sans code', { exact: true })).toHaveCount(2);
  await expect(recipes.getByRole('link', { name: 'Ouvrir la recette : Un agent de Linear' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page);
});

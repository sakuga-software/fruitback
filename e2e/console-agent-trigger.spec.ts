import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type Role, sideScroll, stubWorker, fulfillSites } from './console-workspace.ts';

/**
 * « Start an agent », a section of the page of a site (FRU-468, the board `design/agent-triggers/`):
 * off by default; on, the address that receives, the moment, what the call carries; a workspace
 * with no address; the calls that did not arrive; a member. The worker is answered by stubs.
 */
const CONSOLE = 'http://localhost:5178';

const HOOK = { id: 'c2', kind: 'rest', label: 'REST · https://hooks.acme.dev', createdAt: '2026-10-01T10:00:00.000Z' };
const LINEAR = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
const SITES = [{ id: 's1', origin: 'https://staging.acme.dev', visibility: 'everyone', writers: 'anyone' }];

type Trigger = { connector: string; moment: string; enabled: boolean; waiting: number };
type Worker = { trigger: Trigger | null; written: unknown[]; refuses?: string; asked: number };

async function workerWith(
  page: Page,
  options: { role?: Role; connectors?: unknown[]; trigger?: Trigger | null; locale?: 'en' | 'fr' } = {},
): Promise<Worker> {
  const worker: Worker = { trigger: options.trigger ?? null, written: [], asked: 0 };
  const answer = (pathname: string, route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const read = fulfillSites(route, SITES);
    if (read !== false) return read;
    if (pathname === '/console/workspaces/w1/connectors')
      return json({ connectors: options.connectors ?? [LINEAR, HOOK], available: true });
    if (pathname !== '/console/workspaces/w1/sites/s1/agent-trigger') return undefined;
    worker.asked += 1;
    if (route.request().method() === 'GET') return json({ trigger: worker.trigger });
    const body = route.request().postDataJSON() as Omit<Trigger, 'waiting'>;
    worker.written.push(body);
    if (worker.refuses !== undefined) return json({ error: worker.refuses }, 400);
    worker.trigger = { ...body, waiting: 0 };

    return json({ trigger: worker.trigger });
  };
  await stubWorker(page, {
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    workspaces: [{ ...ACME, role: options.role ?? 'owner' }],
    answer,
  });

  return worker;
}

const section = (page: Page, name = 'Start an agent') => page.getByRole('region', { name, exact: true });

async function expectNoViolation(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

test('off by default; turned on, it calls an address that receives at the moment chosen, with ids only', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const agent = section(page);
  const toggle = agent.getByRole('switch', { name: /Start an agent when a note arrives/ });
  await expect(toggle).not.toBeChecked();
  await expect(agent).toContainText('Off. Nothing is called.');
  // Off: no address, no moment.
  await expect(agent.getByRole('radiogroup', { name: 'When' })).toHaveCount(0);
  await expectNoViolation(page);

  await agent.getByText('Start an agent when a note arrives', { exact: true }).click();
  await expect(toggle).toBeChecked();
  // The address is the one that receives; a tracker is not offered.
  await agent.getByRole('button', { name: /Call/ }).click();
  await expect(page.getByRole('option')).toHaveText(['hooks.acme.dev']);
  await page.keyboard.press('Escape');
  await expect(agent.getByRole('radio', { name: 'A note of a known person arrives' })).toBeChecked();
  const carried = agent.getByRole('region', { name: 'What the call carries' });
  await expect(carried).toContainText('"event": "agent.requested"');
  await expect(carried).toContainText('"reason": "verified-note"');
  await expect(carried).not.toContainText('"text"');
  await agent.getByText('A person of the team moves a note to To do', { exact: true }).click();
  await expect(carried).toContainText('"reason": "moved-to-todo"');
  await expectNoViolation(page);

  await agent.getByRole('button', { name: 'Save' }).click();
  await expect(agent.getByRole('status')).toHaveText('Saved.');
  expect(worker.written).toEqual([{ connector: 'c2', moment: 'moved-to-todo', enabled: true }]);

  // Read again: what was saved is what is drawn.
  await page.reload();
  await expect(section(page).getByRole('switch', { name: /Start an agent when a note arrives/ })).toBeChecked();
  await expect(section(page).getByRole('radio', { name: 'A person of the team moves a note to To do' })).toBeChecked();
});

test('a refusal keeps what was chosen, and calls that did not arrive lead to the address', async ({ page }) => {
  const worker = await workerWith(page, {
    trigger: { connector: 'c2', moment: 'verified-note', enabled: true, waiting: 2 },
  });
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const agent = section(page);
  await expect(agent).toContainText('2 calls did not arrive at hooks.acme.dev.');
  await expect(agent.getByRole('link', { name: 'See the calls' })).toHaveAttribute('href', '/w/w1/connectors');

  worker.refuses = 'unknown-connector';
  await agent.getByText('A person of the team moves a note to To do', { exact: true }).click();
  await agent.getByRole('button', { name: 'Save' }).click();
  await expect(agent.getByRole('alert')).toHaveText(
    'This address is not in the workspace any more. Choose another one.',
  );
  await expect(agent.getByRole('radio', { name: 'A person of the team moves a note to To do' })).toBeChecked();
});

test('with no address that receives, the section leads to the connectors and turns nothing on', async ({ page }) => {
  const worker = await workerWith(page, { connectors: [LINEAR] });
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const agent = section(page);
  await expect(agent).toContainText('The workspace has no address that receives yet.');
  await expect(agent.getByRole('link', { name: 'Connect an address' })).toHaveAttribute('href', '/w/w1/connectors');
  await expect(agent.getByRole('switch')).toHaveCount(0);
  expect(worker.written).toEqual([]);
});

test('a member does not see the section, and the page asks nothing of the trigger', async ({ page }) => {
  const worker = await workerWith(page, { role: 'member' });
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(page.locator('main h1')).toHaveText('staging.acme.dev');
  await expect(section(page)).toHaveCount(0);
  expect(worker.asked).toBe(0);
});

test('at 390 px in French, on, nothing scrolls sideways', async ({ page }) => {
  await workerWith(page, {
    locale: 'fr',
    trigger: { connector: 'c2', moment: 'verified-note', enabled: true, waiting: 0 },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const agent = section(page, 'Lancer un agent');
  await expect(agent.getByRole('radio', { name: 'Une note d’une personne connue arrive' })).toBeChecked();
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page);
});

test('the address counts a call of an agent apart from a note, and its panel names it', async ({ page }) => {
  await stubWorker(page, {
    workspaces: [ACME],
    sites: SITES,
    answer: (pathname, route) => {
      if (pathname === '/console/workspaces/w1/connectors')
        return route.fulfill({ json: { connectors: [HOOK], available: true } });
      if (pathname === '/console/workspaces/w1/connectors/c2/deliveries')
        return route.fulfill({
          json: {
            deliveries: [
              {
                id: 'dlv_1',
                event: 'agent.requested',
                createdAt: '2026-10-28T10:00:00.000Z',
                attempts: 2,
                nextAt: '2026-10-28T11:00:00.000Z',
                lastStatus: 401,
              },
            ],
          },
        });

      return undefined;
    },
  });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const row = page.locator('button[aria-expanded]').filter({ hasText: 'REST API' });
  // The control: no note waits, so the row does not say one does.
  await expect(row).toContainText('1 call of an agent did not arrive');
  await expect(row).not.toContainText('note did not arrive');
  await row.click();
  await expect(page.locator('[data-deliveries]')).toContainText('Call of an agent');
  await expect(page.locator('[data-deliveries]')).toContainText('Your receiver answered 401');
});

test('a read of the addresses that failed says so, and « Try again » brings the section back', async ({ page }) => {
  let fails = true;
  await stubWorker(page, {
    workspaces: [ACME],
    answer: (pathname, route) => {
      const read = fulfillSites(route, SITES);
      if (read !== false) return read;
      if (pathname === '/console/workspaces/w1/connectors')
        return fails
          ? route.fulfill({ status: 500, json: { error: 'unknown' } })
          : route.fulfill({ json: { connectors: [HOOK], available: true } });
      if (pathname === '/console/workspaces/w1/sites/s1/agent-trigger')
        return route.fulfill({
          json: { trigger: { connector: 'c2', moment: 'verified-note', enabled: true, waiting: 0 } },
        });

      return undefined;
    },
  });
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const agent = section(page);
  await expect(agent.getByRole('alert')).toContainText('The addresses of the workspace did not load.');
  // The control: no switch is drawn on a list that was not read.
  await expect(agent.getByRole('switch')).toHaveCount(0);
  fails = false;
  await agent.getByRole('button', { name: 'Try again' }).click();
  await expect(agent.getByRole('switch', { name: /Start an agent when a note arrives/ })).toBeChecked();
});

test('an address with notes and a call that wait says both: the agent did not start either', async ({ page }) => {
  const waiting = (id: string, event?: string) => ({
    id,
    ...(event === undefined ? {} : { event }),
    createdAt: '2026-10-28T10:00:00.000Z',
    attempts: 2,
    nextAt: '2026-10-28T11:00:00.000Z',
    lastStatus: 500,
  });
  await stubWorker(page, {
    workspaces: [ACME],
    sites: SITES,
    answer: (pathname, route) => {
      if (pathname === '/console/workspaces/w1/connectors')
        return route.fulfill({ json: { connectors: [HOOK], available: true } });
      if (pathname === '/console/workspaces/w1/connectors/c2/deliveries')
        return route.fulfill({
          json: { deliveries: [waiting('dlv_1'), waiting('dlv_2'), waiting('dlv_3', 'agent.requested')] },
        });

      return undefined;
    },
  });
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const row = page.locator('button[aria-expanded]').filter({ hasText: 'REST API' });
  await expect(row.getByText('2 notes did not arrive', { exact: true })).toBeVisible();
  await expect(row.getByText('1 call of an agent did not arrive', { exact: true })).toBeVisible();
});

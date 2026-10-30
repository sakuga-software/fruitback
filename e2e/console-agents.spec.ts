import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, type StubbedWorkspace, box, sideScroll, stubWorker } from './console-workspace.ts';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The agent keys of a workspace (FRU-462), the board `design/agents/`: the way from the settings,
 * the list with its last use, its end and the warning 7 days before, a key made and shown once with
 * the line for Claude Code, its copy, the writes of a key, and its revocation. The worker is answered
 * by stubs; the routes are those of FRU-461 and FRU-464.
 */
const CONSOLE = 'http://localhost:5178';
const DAY = 86_400_000;
const SECRET = `fbk_${'A1b2C3d4'.repeat(5)}xyz`;

const SITES = [
  { id: 's1', origin: 'https://shop.acme.dev', visibility: 'members' },
  { id: 's2', origin: 'https://docs.acme.dev', visibility: 'everyone' },
];

type Key = {
  id: string;
  name: string;
  sites: { id: string; origin: string }[];
  rights: 'read' | 'write';
  verifiedOnly: boolean;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** A key in use, one that ends in 5 days and was used yesterday, one that ended and was never used. */
const KEYS = (): Key[] => [
  {
    id: 'agk_ci',
    name: 'Claude on CI',
    sites: [{ id: 's1', origin: 'https://shop.acme.dev' }],
    rights: 'write',
    verifiedOnly: true,
    createdBy: 'a1',
    createdAt: iso(-10 * DAY),
    expiresAt: iso(80 * DAY),
    lastUsedAt: iso(-12 * 60_000),
  },
  {
    id: 'agk_triage',
    name: 'Nightly triage',
    sites: [{ id: 's2', origin: 'https://docs.acme.dev' }],
    rights: 'read',
    verifiedOnly: false,
    createdBy: 'a1',
    createdAt: iso(-85 * DAY),
    expiresAt: iso(5 * DAY - 3_600_000),
    lastUsedAt: iso(-26 * 3_600_000),
  },
  {
    id: 'agk_old',
    name: 'Old reader',
    sites: [{ id: 's1', origin: 'https://shop.acme.dev' }],
    rights: 'read',
    verifiedOnly: true,
    createdBy: 'a1',
    createdAt: iso(-100 * DAY),
    expiresAt: iso(-8 * DAY),
    lastUsedAt: null,
  },
];

type Worker = {
  keys: Key[];
  made: unknown[];
  revoked: string[];
  /** Every call to the routes of the keys, as `METHOD path`. */
  asked: string[];
  /** A code the worker refuses the next key with. */
  refuses?: { status: number; error: string };
};

async function workerWith(
  page: Page,
  options: { workspace?: StubbedWorkspace; keys?: Key[]; locale?: 'en' | 'fr'; sites?: typeof SITES } = {},
): Promise<Worker> {
  const worker: Worker = { keys: options.keys ?? KEYS(), made: [], revoked: [], asked: [] };
  const workspace = options.workspace ?? ACME;
  await stubWorker(page, {
    workspaces: [workspace],
    sites: options.sites ?? SITES,
    ...(options.locale === undefined ? {} : { locale: options.locale }),
    answer: (pathname, route: Route) => {
      const request = route.request();
      const base = `/console/workspaces/${workspace.id}/agent-keys`;
      if (!pathname.startsWith(base)) return undefined;
      worker.asked.push(`${request.method()} ${pathname}`);
      if (pathname === base && request.method() === 'GET') return route.fulfill({ json: { keys: worker.keys } });
      if (pathname === base && request.method() === 'POST') {
        const body = request.postDataJSON() as {
          name: string;
          sites: string[];
          rights: 'read' | 'write';
          days: number;
          verifiedOnly: boolean;
        };
        worker.made.push(body);
        if (worker.refuses !== undefined)
          return route.fulfill({ status: worker.refuses.status, json: { error: worker.refuses.error } });
        const key: Key = {
          id: 'agk_new',
          name: body.name,
          sites: SITES.filter((site) => body.sites.includes(site.id)).map(({ id, origin }) => ({ id, origin })),
          rights: body.rights,
          verifiedOnly: body.verifiedOnly,
          createdBy: 'a1',
          createdAt: iso(0),
          expiresAt: iso(body.days * DAY),
          lastUsedAt: null,
        };
        worker.keys = [...worker.keys, key];

        return route.fulfill({ status: 201, json: { ...key, secret: SECRET } });
      }
      const writes = /\/agent-keys\/([^/]+)\/writes$/.exec(pathname);
      if (writes !== null) {
        return route.fulfill({
          json: {
            writes:
              writes[1] === 'agk_ci'
                ? [
                    {
                      key: 'agk_ci',
                      keyName: 'Claude on CI',
                      site: 's1',
                      note: 'sd_8f2k1x',
                      action: 'status',
                      status: 'own:done',
                      at: iso(-12 * 60_000),
                    },
                    {
                      key: 'agk_ci',
                      keyName: 'Claude on CI',
                      site: 's1',
                      note: 'sd_8f2k1x',
                      action: 'reply',
                      at: iso(-13 * 60_000),
                    },
                  ]
                : [],
          },
        });
      }
      const one = /\/agent-keys\/([^/]+)$/.exec(pathname);
      if (one !== null && request.method() === 'DELETE') {
        worker.revoked.push(one[1] as string);
        worker.keys = worker.keys.filter((key) => key.id !== one[1]);

        return route.fulfill({ status: 204 });
      }

      return route.fulfill({ status: 405, json: { error: 'method-not-allowed' } });
    },
  });

  return worker;
}

const list = (page: Page) => page.getByRole('list', { name: /^(Agent keys|Clés d’agent)$/ });
const row = (page: Page, name: string) =>
  list(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

async function expectNoViolation(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(' ')}`),
  ).toEqual([]);
}

test('the settings lead an owner to the keys, listed with their last use, their end and the warning before it', async ({
  page,
}) => {
  await workerWith(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/settings/ai`);
  const section = page.getByRole('region', { name: 'Agents' });
  await section.getByRole('link', { name: 'Manage the agent keys' }).click();
  await expect(page).toHaveURL(`${CONSOLE}/w/w1/settings/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents');
  // The crumbs lead back to the settings, and to their page « AI » (FRU-544).
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link');
  await expect(crumbs).toHaveText(['Workspace settings', 'AI']);
  await expect(crumbs.last()).toHaveAttribute('href', '/w/w1/settings/ai');

  await expect(list(page).getByRole('listitem')).toHaveCount(3);
  const ci = row(page, 'Claude on CI');
  await expect(ci).toContainText('shop.acme.dev');
  await expect(ci).toContainText('Read, reply and set a status');
  await expect(ci).toContainText('Notes of known people only');
  await expect(ci).toContainText('12 min ago');
  const triage = row(page, 'Nightly triage');
  await expect(triage).toContainText('Every note, a visitor’s too');
  await expect(triage).toContainText('Yesterday');
  await expect(triage).toContainText('Ends in 5 days');
  const old = row(page, 'Old reader');
  await expect(old).toContainText('Never used');
  await expect(old).toContainText('Ended');
  // The control: a key far from its end says no warning.
  await expect(ci).not.toContainText('Ends in');
  await expect(page.getByText('« Nightly triage » ends in 5 days.', { exact: false })).toBeVisible();
  await expect(page.getByText('3 of 20 keys.')).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page);
});

test('a key is made, shown once with the line for Claude Code, copied, then gone from the screen', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: CONSOLE });
  const worker = await workerWith(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  await page.getByRole('button', { name: 'New key' }).click();
  const form = page.getByRole('region', { name: 'New agent key' });
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'New key' })).toBeDisabled();

  await form.getByRole('textbox', { name: 'Name' }).fill('  Claude on my laptop ');
  // The input of a box of HeroUI is hidden under its drawing: a person presses the box, or its words
  // (FRU-550: the box did not tick).
  const docs = form.getByRole('checkbox', { name: /docs\.acme\.dev/ });
  await form.locator('.kit-checkbox').filter({ hasText: 'docs.acme.dev' }).locator('.checkbox__control').click();
  await expect(docs).toBeChecked();
  await form.getByText('docs.acme.dev', { exact: true }).click();
  await expect(docs).not.toBeChecked();
  await form.getByText('docs.acme.dev', { exact: true }).click();
  await expect(docs).toBeChecked();
  await form.getByText('Read, reply and set a status', { exact: true }).click();
  await expect(form.getByRole('radio', { name: 'Read, reply and set a status' })).toBeChecked();
  await form.getByRole('textbox', { name: 'Lives for, in days' }).fill('30');
  await expect(form).toContainText('Ends on');
  // On by default, and turned off here, knowing it.
  const known = form.getByRole('switch', { name: /Only the notes of known people/ });
  await expect(known).toBeChecked();
  await form.getByText('Only the notes of known people', { exact: true }).click();
  await expect(known).not.toBeChecked();
  await form.getByRole('button', { name: 'Make the key' }).click();

  expect(worker.made).toEqual([
    { name: 'Claude on my laptop', sites: ['s2'], rights: 'write', days: 30, verifiedOnly: false },
  ]);
  const once = page.getByRole('region', { name: '« Claude on my laptop » is made' });
  await expect(once.locator('[data-secret]')).toHaveText(SECRET);
  const line = `claude mcp add --transport http fruitback ${WORKER_ORIGIN}/mcp \\\n  --header "Authorization: Bearer ${SECRET}"`;
  await expect(once.getByRole('region', { name: 'The line that connects Claude Code' })).toHaveText(line);
  await expect(row(page, 'Claude on my laptop')).toContainText('Never used');
  await expectNoViolation(page);

  await once.getByRole('button', { name: 'Copy the key' }).click();
  await expect(once.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SECRET);
  await once.getByRole('button', { name: 'Copy the line' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(line);

  await once.getByRole('button', { name: 'I kept it' }).click();
  await expect(once).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New key' })).toBeFocused();
  // Shown once: nothing of the screen holds the key any more, nor a storage of the browser.
  expect(await page.content()).not.toContain(SECRET);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(SECRET);
});

test('the form says what it needs and sends nothing, and keeps what was typed through a refusal', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  await page.getByRole('button', { name: 'New key' }).click();
  const form = page.getByRole('region', { name: 'New agent key' });
  await form.getByRole('button', { name: 'Make the key' }).click();
  await expect(form).toContainText('Give the key a name.');
  await expect(form).toContainText('Choose at least one site.');
  await expect(form.getByRole('textbox', { name: 'Name' })).toBeFocused();
  await form.getByRole('textbox', { name: 'Name' }).fill('Reader');
  await form.getByRole('textbox', { name: 'Lives for, in days' }).fill('400');
  await form.getByRole('button', { name: 'Make the key' }).click();
  await expect(form.getByRole('checkbox', { name: /shop\.acme\.dev/ })).toBeFocused();
  await form.getByText('shop.acme.dev', { exact: true }).click();
  await form.getByRole('button', { name: 'Make the key' }).click();
  await expect(form).toContainText('Choose from 1 to 365 days.');
  expect(worker.made).toEqual([]);

  worker.refuses = { status: 409, error: 'too-many-keys' };
  await form.getByRole('textbox', { name: 'Lives for, in days' }).fill('7');
  await form.getByRole('button', { name: 'Make the key' }).click();
  await expect(form.getByRole('alert')).toHaveText('A workspace holds 20 keys at most. Revoke one to make another.');
  await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Reader');
  expect(worker.made).toHaveLength(1);

  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New key' })).toBeFocused();
});

test('the writes of a key unfold under its row, and a key revoked after a second press leaves the list', async ({
  page,
}) => {
  const worker = await workerWith(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  const ci = row(page, 'Claude on CI');
  const writes = ci.getByRole('button', { name: 'Writes' });
  await expect(writes).toHaveAttribute('aria-expanded', 'false');
  await writes.click();
  await expect(writes).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'Writes of Claude on CI' });
  await expect(panel.getByRole('listitem')).toHaveText([
    /^Set the status to « Done »shop\.acme\.devsd_8f2k1x12 min ago$/,
    /^Replied to a noteshop\.acme\.devsd_8f2k1x13 min ago$/,
  ]);
  expect(worker.asked).toContain('GET /console/workspaces/w1/agent-keys/agk_ci/writes');
  await row(page, 'Nightly triage').getByRole('button', { name: 'Writes' }).click();
  await expect(page.getByRole('region', { name: 'Writes of Nightly triage' })).toContainText(
    'This key wrote nothing yet.',
  );
  await expectNoViolation(page);

  await ci.getByRole('button', { name: 'Revoke', exact: true }).click();
  // The control: one press revokes nothing.
  expect(worker.revoked).toEqual([]);
  await ci.getByRole('button', { name: 'Revoke « Claude on CI »' }).click();
  await expect(row(page, 'Claude on CI')).toHaveCount(0);
  expect(worker.revoked).toEqual(['agk_ci']);
  await expect(page.getByRole('status').filter({ hasText: '« Claude on CI » is revoked.' })).toBeVisible();
  await expect(page.getByText('2 of 20 keys.')).toBeVisible();
});

test('a member reads why there is no way to the keys, and the page asks the worker nothing', async ({ page }) => {
  const worker = await workerWith(page, { workspace: { ...ACME, role: 'member' } });
  await page.goto(`${CONSOLE}/w/w1/settings/ai`);
  const section = page.getByRole('region', { name: 'Agents' });
  await expect(section).toContainText('Only an owner or an admin of the workspace manages its agent keys.');
  await expect(section.getByRole('link')).toHaveCount(0);
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  await expect(page.getByText('Only an owner or an admin of the workspace manages its agent keys.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New key' })).toHaveCount(0);
  expect(worker.asked).toEqual([]);
});

test('the last key revoked: one « New key », in the empty card, with the focus (FRU-503)', async ({ page }) => {
  const worker = await workerWith(page, { keys: KEYS().slice(0, 1) });
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  const ci = row(page, 'Claude on CI');
  await ci.getByRole('button', { name: 'Revoke', exact: true }).click();
  await ci.getByRole('button', { name: 'Revoke « Claude on CI »' }).click();
  await expect(page.getByRole('heading', { name: 'No agent key yet' })).toBeVisible();
  expect(worker.revoked).toEqual(['agk_ci']);
  await expect(page.getByRole('button', { name: 'New key' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New key' })).toBeFocused();
});

test('with no key, the screen says what a key is for; at 390 px in French nothing scrolls sideways', async ({
  page,
}) => {
  await workerWith(page, { keys: [] });
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  await expect(page.getByRole('heading', { name: 'No agent key yet' })).toBeVisible();
  // FRU-503: one « New key », in the card. The head had a second one above it.
  const card = page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'No agent key yet' }) })
    .last();
  await expect(page.getByRole('button', { name: 'New key' })).toHaveCount(1);
  await expect(card.getByRole('button', { name: 'New key' })).toBeVisible();
  // Opened and cancelled from the card, the form gives the focus back to it.
  await card.getByRole('button', { name: 'New key' }).click();
  const form = page.getByRole('region', { name: 'New agent key' });
  await form.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New key' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'New key' })).toBeFocused();
  await expectNoViolation(page);

  await page.unrouteAll();
  // A site with a long name: its box wraps in the list of the form, and never past the edge (#742).
  const long = {
    id: 's3',
    origin: 'https://staging.a-very-long-client-name-for-the-select.co.uk',
    visibility: 'everyone',
  };
  await workerWith(page, { locale: 'fr', sites: [...SITES, long] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${CONSOLE}/w/w1/settings/agents`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agents');
  await expect(row(page, 'Nightly triage')).toContainText('Prend fin dans 5 jours');
  await expect(row(page, 'Old reader')).toContainText('Jamais utilisée');
  expect(await sideScroll(page)).toBe(0);
  await expectNoViolation(page);
  await page.getByRole('button', { name: 'Nouvelle clé' }).first().click();
  const wide = page.getByRole('checkbox', { name: /a-very-long-client-name/ });
  await expect(wide).toBeAttached();
  expect(await sideScroll(page)).toBe(0);
  const field = await box(page.locator('.kit-checks .kit-checkbox').filter({ hasText: 'a-very-long-client-name' }));
  const list = await box(page.locator('.kit-checks'));
  expect(field.x + field.width).toBeLessThanOrEqual(list.x + list.width + 0.5);
});

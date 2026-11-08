import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, fulfillSites, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * ClickUp in the console (FRU-625): its card in « Add a connector », the consent where the server has
 * a ClickUp app and the form of a personal token where it has none, and its lists in « Add a
 * destination » of a site. The worker is answered by stubs, with the words it says
 * (`apps/worker/src/trackers/routes.ts`).
 */
const CONSOLE = 'http://localhost:5178';
const SITE = 'staging.acme.dev';
const CLICKUP = { id: 'k1', kind: 'clickup', label: 'ClickUp · Acme', createdAt: '2026-11-08T10:00:00.000Z' };
const TOKEN = 'pk_123456_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

type Place = { connector: string; teamId?: string };
type Worker = {
  connectors: unknown[];
  offer: { kind: string; oauth: boolean; token: boolean };
  /** What the worker answers to a token, in place of the connector. */
  refuses?: string;
  added: unknown[];
  started: number;
  sent: Place[][];
};

async function workerWith(page: Page, connectors: unknown[] = [], locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = {
    connectors,
    offer: { kind: 'clickup', oauth: true, token: true },
    added: [],
    started: 0,
    sent: [],
  };
  let places: Place[] = [];
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (pathname.endsWith('/connectors/clickup/oauth') && request.method() === 'POST') {
      worker.started += 1;

      return json({ url: `${CONSOLE}/w/w1/connectors?clickup=failed` }, 201);
    }
    if (pathname.endsWith('/connectors') && request.method() === 'POST') {
      worker.added.push(request.postDataJSON());
      if (worker.refuses !== undefined) return json({ error: worker.refuses }, 400);
      worker.connectors = [...worker.connectors, CLICKUP];

      return json(CLICKUP, 201);
    }
    if (pathname.endsWith('/sites/s1/destinations') && request.method() === 'POST') {
      const { destinations } = request.postDataJSON() as { destinations: Place[] };
      worker.sent.push(destinations);
      places = destinations;

      return json({ destinations: places.map((each) => ({ ...each, label: 'ClickUp · Product › Web › Bugs' })) });
    }
    if (pathname.endsWith('/connectors')) {
      return json({ connectors: worker.connectors, available: true, linearOAuth: false, trackers: [worker.offer] });
    }
    if (pathname.endsWith('/k1/places')) {
      return json({
        places: [
          { id: '125', name: 'Product › Inbox' },
          { id: '124', name: 'Product › Web › Bugs' },
        ],
      });
    }
    const read = fulfillSites(route, [
      {
        id: 's1',
        origin: `https://${SITE}`,
        visibility: 'members',
        destinations: places.map((each) => ({ ...each, label: 'ClickUp · Product › Web › Bugs' })),
      },
    ]);
    if (read !== false) return read;
    if (/\/sites\/\w+\/statuses/.test(pathname)) return json({ statuses: [], trackerColours: false, trackers: [] });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role: 'owner' }], answer });

  return worker;
}

const catalogue = (page: Page) =>
  page.getByRole('dialog', { name: 'Add a connector' }).or(page.getByRole('region', { name: 'Add a connector' }));
const card = (page: Page) => catalogue(page).locator('[data-source="ClickUp"]');

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the card of ClickUp connects by consent, and says why it came back with nothing', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/connectors`);

  await expect(card(page)).toHaveCount(1);
  await expect(card(page).locator('svg[data-mark="clickup"]')).toHaveCount(1);
  await expect(
    card(page).getByText('A task per note, in the ClickUp list you choose, with the files of the note.'),
  ).toBeVisible();
  // The consent first; the token is the other way.
  await expect(card(page).getByRole('button', { name: 'Use a token' })).toBeVisible();
  await expectNoViolation(page, 'the card of ClickUp');

  await card(page).getByRole('button', { name: 'Connect ClickUp', exact: true }).click();
  await expect(card(page).getByRole('alert')).toHaveText('ClickUp was not connected. Start again from « Connect ».');
  expect(worker.started).toBe(1);
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('a server with no ClickUp app connects it by a personal token, and keeps what was typed when refused', async ({
  page,
}) => {
  const worker = await workerWith(page);
  worker.offer = { kind: 'clickup', oauth: false, token: true };
  await page.goto(`${CONSOLE}/w/w1/connectors`);

  await card(page).getByRole('button', { name: 'Connect ClickUp', exact: true }).click();
  const field = card(page).getByLabel('ClickUp personal token');
  await expect(field).toHaveAttribute('type', 'password');
  const connect = card(page).getByRole('button', { name: 'Connect', exact: true });
  await expect(connect).toBeDisabled();

  worker.refuses = 'key-refused';
  await field.fill(TOKEN);
  await connect.click();
  await expect(card(page).getByRole('alert')).toHaveText(
    'ClickUp refused this token. Copy it again from ClickUp, then try again.',
  );
  await expect(field).toHaveValue(TOKEN);
  await expectNoViolation(page, 'the form of a token');

  worker.refuses = undefined;
  await connect.click();
  await expect(page.locator('#source-panel')).toBeVisible();
  await expect(page.locator('#source-panel').getByText('Acme', { exact: true }).first()).toBeVisible();
  expect(worker.added.at(-1)).toEqual({ kind: 'clickup', token: TOKEN });
  await expect(page.getByText(TOKEN)).toHaveCount(0);
});

test('« Add a destination » of a site lists the lists of ClickUp, and keeps the one chosen', async ({ page }) => {
  const worker = await workerWith(page, [CLICKUP]);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const places = page.getByRole('region', { name: `Where the notes of ${SITE} go` });
  await expect(places).toBeVisible();

  await places.getByRole('button', { name: new RegExp(`Add a destination for ${SITE}`) }).click();
  await expect(page.getByRole('option')).toHaveText(['Add a destination…', 'Product › Inbox', 'Product › Web › Bugs']);
  await page.getByRole('option', { name: 'Product › Web › Bugs', exact: true }).click();
  await expect.poll(() => worker.sent).toEqual([[{ connector: 'k1', teamId: '124' }]]);
  await expect(places.getByText('ClickUp · Product › Web › Bugs', { exact: true })).toBeVisible();
  await expectNoViolation(page, 'a ClickUp destination');
});

test('the card of ClickUp fits a phone, in French', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page, [], 'fr');
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const french = page.locator('[data-source="ClickUp"]');

  await expect(
    french.getByText('Une tâche par note, dans la liste ClickUp de votre choix, avec les fichiers de la note.'),
  ).toBeVisible();
  await expect(french.getByRole('button', { name: 'Connecter ClickUp', exact: true })).toBeVisible();
  await expect(french.getByRole('button', { name: 'Utiliser un jeton' })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
});

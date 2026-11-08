import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, fulfillSites, sideScroll, stubWorker } from './console-workspace.ts';

/**
 * Jira Cloud in the console (FRU-622): its card in « Add a connector », the way to Atlassian and
 * back, its panel, and its projects in « Add a destination » of a site. The worker is answered by
 * stubs, with the words it says (`apps/worker/src/trackers/routes.ts`).
 */
const CONSOLE = 'http://localhost:5178';
const SITE = 'staging.acme.dev';
const CLOUD = '11223344-a1b2-3b33-c444-def123456789';
const JIRA = { id: 'j1', kind: 'jira', label: 'Jira · acme', createdAt: '2026-11-08T10:00:00.000Z' };

type Place = { connector: string; teamId?: string };
type Worker = {
  connectors: unknown[];
  offer: { kind: string; oauth: boolean; token: boolean };
  /** Where `POST /connectors/jira/oauth` sends the browser. */
  leaveTo: string;
  started: number;
  sent: Place[][];
};

async function workerWith(page: Page, connectors: unknown[] = [], locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = {
    connectors,
    offer: { kind: 'jira', oauth: true, token: false },
    leaveTo: `${CONSOLE}/w/w1/connectors?jira=declined`,
    started: 0,
    sent: [],
  };
  let places: Place[] = [];
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (pathname.endsWith('/connectors/jira/oauth') && request.method() === 'POST') {
      worker.started += 1;

      return json({ url: worker.leaveTo }, 201);
    }
    if (pathname.endsWith('/sites/s1/destinations') && request.method() === 'POST') {
      const { destinations } = request.postDataJSON() as { destinations: Place[] };
      worker.sent.push(destinations);
      places = destinations;

      return json({ destinations: places.map((each) => ({ ...each, label: 'Jira · Design (DES)' })) });
    }
    if (pathname.endsWith('/connectors')) {
      return json({ connectors: worker.connectors, available: true, linearOAuth: false, trackers: [worker.offer] });
    }
    if (pathname.endsWith('/j1/places')) {
      return json({
        places: [
          { id: `${CLOUD}/10000`, name: 'Design (DES)' },
          { id: `${CLOUD}/10001`, name: 'Platform (PLA)' },
        ],
      });
    }
    const read = fulfillSites(route, [
      {
        id: 's1',
        origin: `https://${SITE}`,
        visibility: 'members',
        destinations: places.map((each) => ({ ...each, label: 'Jira · Design (DES)' })),
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
const jira = (page: Page) => catalogue(page).locator('[data-source="Jira"]');

async function expectNoViolation(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

test('the card of Jira connects by consent at Atlassian, and says why it came back with nothing', async ({ page }) => {
  const worker = await workerWith(page);
  await page.goto(`${CONSOLE}/w/w1/connectors`);

  // One card of Jira: the one of the plugin, not the one « After the beta ».
  await expect(jira(page)).toHaveCount(1);
  await expect(jira(page).locator('svg[data-mark="jira"]')).toHaveCount(1);
  await expect(
    jira(page).getByText('An issue per note, in the Jira Cloud project you choose, with the files of the note.'),
  ).toBeVisible();
  await expect(jira(page).getByRole('button', { name: 'After the beta' })).toHaveCount(0);
  // No token is ever asked: Jira connects by OAuth only.
  await expect(jira(page).getByRole('button', { name: 'Use a token' })).toHaveCount(0);
  await expectNoViolation(page, 'the card of Jira');

  // The way to Atlassian: the worker says where, and the person said no there.
  await jira(page).getByRole('button', { name: 'Connect Jira', exact: true }).click();
  await expect(page).toHaveURL(/\/w\/w1\/connectors/);
  expect(worker.started).toBe(1);
  await expect(jira(page).getByRole('alert')).toHaveText(
    'You declined access in Jira, so it is not connected. Press Connect to try again.',
  );
  // The word of the way back leaves the address.
  await expect.poll(() => new URL(page.url()).search).toBe('');
});

test('a server with no Jira app connects nothing, and says so on the card', async ({ page }) => {
  const worker = await workerWith(page);
  worker.offer = { kind: 'jira', oauth: false, token: false };
  await page.goto(`${CONSOLE}/w/w1/connectors`);

  await expect(jira(page).getByRole('button', { name: 'Not on this Fruitback' })).toBeDisabled();
  await expect(jira(page).getByText('The operator of this Fruitback has not set up Jira.')).toBeVisible();
});

test('back from Atlassian, the panel of the new Jira opens, and says a refusal with what to do', async ({ page }) => {
  await workerWith(page, [{ ...JIRA, attention: { reason: 'key-refused', since: '2026-11-08T11:00:00.000Z' } }]);
  await page.goto(`${CONSOLE}/w/w1/connectors?jira=connected`);

  const panel = page.locator('#source-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Jira' })).toBeVisible();
  await expect(panel.getByText('Site acme').first()).toBeVisible();
  await expect(panel.getByRole('alert')).toContainText('Jira refuses this connection since');
  await expect(page.locator('button[id^="source-row-"]')).toContainText('Needs attention');
});

test('« Add a destination » of a site lists the projects of Jira, and keeps the one chosen', async ({ page }) => {
  const worker = await workerWith(page, [JIRA]);
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  const places = page.getByRole('region', { name: `Where the notes of ${SITE} go` });
  await expect(places).toBeVisible();

  await places.getByRole('button', { name: new RegExp(`Add a destination for ${SITE}`) }).click();
  await expect(page.getByRole('option')).toHaveText(['Add a destination…', 'Design (DES)', 'Platform (PLA)']);
  await page.getByRole('option', { name: 'Design (DES)', exact: true }).click();
  await expect.poll(() => worker.sent).toEqual([[{ connector: 'j1', teamId: `${CLOUD}/10000` }]]);
  await expect(places.getByText('Jira · Design (DES)', { exact: true })).toBeVisible();
  await expectNoViolation(page, 'a Jira destination');
});

test('the card of Jira fits a phone, in French', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await workerWith(page, [], 'fr');
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  const card = page.locator('[data-source="Jira"]');

  await expect(
    card.getByText('Un ticket par note, dans le projet Jira Cloud de votre choix, avec les fichiers de la note.'),
  ).toBeVisible();
  await expect(card.getByRole('button', { name: 'Connecter Jira', exact: true })).toBeVisible();
  expect(await sideScroll(page)).toBe(0);
});

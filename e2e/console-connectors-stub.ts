import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect } from '@playwright/test';
import { ACME, type Role, type StubbedWorkspace, fulfillSites, stubWorker } from './console-workspace.ts';
import { settled, unfolded } from './settled.ts';

/**
 * What the specs of the Connectors screen share (FRU-690): a worker answered by stubs, with a Linear
 * and an address, the sites that send to them, and the sends that wait for the address; and the
 * parts of the screen. `console-connectors-table.spec.ts` holds the table, the health and the
 * settings; `console-connectors-catalogue.spec.ts` the catalogue. The sample data is of nobody.
 */
export const CONSOLE = 'http://localhost:5178';

export const MUTED = '#5b6779';
export const LINE = '#e3e8ef';
export const CHIP = '#e8edf3';
/** Under the pointer (FRU-683). */
export const HOVER = '#e8edf3';
export const ACCENT = '#dd2c27';
export const ACCENT_STRONG = '#b91c1c';
export const DONE = '#166534';

export const SETTINGS = { showComments: true, stages: {} };
export const LINEAR = {
  id: 'c1',
  kind: 'linear',
  label: 'Linear OAuth · Acme',
  createdAt: '2026-10-01T10:00:00.000Z',
  settings: SETTINGS,
};
export const ADDRESS = {
  id: 'r1',
  kind: 'rest',
  label: 'REST · hooks.acme.dev/feedback',
  createdAt: '2026-10-02T10:00:00.000Z',
};
export const PLACE = { connector: 'c1', teamId: 't1', label: 'Linear · Acme web' };
export const THERE = { connector: 'r1', label: 'REST API · hooks.acme.dev/feedback' };
export const SITES = [
  { id: 's1', origin: 'https://staging.acme.dev', visibility: 'members', destination: PLACE, destinations: [PLACE] },
  { id: 's2', origin: 'https://acme.dev', visibility: 'everyone', destination: PLACE, destinations: [PLACE, THERE] },
  { id: 's3', origin: 'https://support.acme.dev', visibility: 'everyone' },
];
export const STATES = (
  [
    ['Triage', 'new'],
    ['Todo', 'todo'],
    ['In Progress', 'progress'],
    ['Done', 'done'],
    ['Canceled', 'closed'],
  ] as const
).map(([name, stage], index) => ({ id: `st${index}`, name, type: 'x', teamId: 't1', team: 'Acme web', stage }));
export const LATE = [
  { id: 'd1', createdAt: '2026-10-12T09:00:00.000Z', attempts: 3, nextAt: '2026-10-13T12:00:00.000Z', lastStatus: 500 },
  { id: 'd2', createdAt: '2026-10-12T10:00:00.000Z', attempts: 8, lastError: 'timeout' },
];

export type Worker = {
  connectors: unknown[];
  oauth: boolean;
  /** The notes that did not reach the address. `undefined`: the worker does not answer that read. */
  late: unknown[] | undefined;
  /** The worker answers no list of sources, and no list of sites. */
  down: boolean;
  /** The worker says it cannot keep a key: nobody connects a source. */
  unavailable?: boolean;
  /** What the worker answers to a source that is added. */
  refuses?: string;
  /** What the worker answers to a name (FRU-404). */
  refusesName?: string;
  sent: { pathname: string; body: unknown }[];
};

export async function workerWith(
  page: Page,
  role: Role = 'owner',
  locale: 'en' | 'fr' = 'en',
  others: readonly StubbedWorkspace[] = [],
): Promise<Worker> {
  const worker: Worker = { connectors: [LINEAR, ADDRESS], oauth: true, late: LATE, down: false, sent: [] };
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (request.method() !== 'GET') {
      worker.sent.push({ pathname, body: request.postDataJSON() });
      // FRU-633: the consent at Linear is skipped. The browser comes back as the worker sends it back.
      if (pathname.endsWith('/connectors/c1/reconnect')) {
        worker.connectors = worker.connectors.map((each) => ((each as { id: string }).id === 'c1' ? LINEAR : each));

        return json({ url: `${CONSOLE}/w/w1/connectors?linear=reconnected&connector=c1` }, 201);
      }
      const named = /\/connectors\/(\w+)$/.exec(pathname);
      if (named !== null && request.method() === 'POST') {
        if (worker.refusesName !== undefined) return json({ error: worker.refusesName }, 400);
        const name = (request.postDataJSON() as { name: string }).name;
        worker.connectors = worker.connectors.map((each) => {
          const connector = each as { id: string; name?: string };
          if (connector.id !== named[1]) return each;
          const { name: _, ...rest } = connector;

          return name === '' ? rest : { ...rest, name };
        });

        return json(worker.connectors.find((each) => (each as { id: string }).id === named[1]));
      }
      if (pathname.endsWith('/connectors')) {
        if (worker.refuses !== undefined) return json({ error: worker.refuses }, 400);
        // A key of Linear: the connector of its person, with no secret to show.
        if ((request.postDataJSON() as { kind?: string }).kind === 'linear') {
          const key = {
            id: 'c9',
            kind: 'linear',
            label: 'Linear · Bo',
            createdAt: '2026-10-13T10:00:00.000Z',
            settings: SETTINGS,
          };
          worker.connectors = [...worker.connectors, key];

          return json(key, 201);
        }
        // A secret the person gave is not sent back: the worker shows only the one it made.
        const given = (request.postDataJSON() as { secret?: string }).secret !== undefined;
        const made = {
          id: 'r2',
          kind: 'rest',
          label: 'REST · hooks.client.fr/notes',
          createdAt: '2026-10-13T10:00:00.000Z',
        };
        worker.connectors = [...worker.connectors, made];

        return json(given ? made : { ...made, secret: 'made-by-fruitback-0123456789' }, 201);
      }

      return json({});
    }
    if (worker.down && (pathname.endsWith('/connectors') || pathname.endsWith('/sites'))) return json({}, 500);
    if (pathname.endsWith('/connectors'))
      return json({ connectors: worker.connectors, available: worker.unavailable !== true, linearOAuth: worker.oauth });
    const read = fulfillSites(route, SITES);
    if (read !== false) return read;
    if (pathname.endsWith('/c1/teams'))
      return json({ teams: [{ id: 't1', name: 'Acme web', key: 'ACM', projects: [{ id: 'p1', name: 'Website' }] }] });
    if (pathname.endsWith('/c1/states')) return json({ states: STATES, settings: SETTINGS });
    // The statuses page of a site (FRU-371, FRU-368), which a link of the panel opens.
    if (/\/sites\/\w+\/statuses$/.test(pathname)) return json({ statuses: [] });
    if (/\/sites\/\w+\/statuses\/tracker$/.test(pathname)) return json({ trackerColours: false, trackers: [] });
    if (pathname.endsWith('/deliveries'))
      return worker.late === undefined
        ? json({}, 500)
        : json({ deliveries: pathname.includes('/r1/') ? worker.late : [] });

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role }, ...others], answer });

  return worker;
}

export async function open(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(page.locator('main h1')).toBeVisible();
}

/** The rows of the table of the connectors (FRU-690). */
export const rows = (page: Page) => page.locator('tbody tr[data-connector]');
/** The button at the end of a row that opens the settings of its connector. */
export const settingsOf = (page: Page, name: string) =>
  page.getByRole('button', { name: `Settings of ${name}`, exact: true });
export const panel = (page: Page) => page.locator('#source-panel');
/** The catalogue, on the page under the table (FRU-690). */
export const catalogue = (page: Page) => page.getByRole('region', { name: 'Add a connector' });
export const tiles = (page: Page) => catalogue(page).getByRole('listitem');
export const tile = (page: Page, name: string) => catalogue(page).locator(`[data-source="${name}"]`);
export const search = (page: Page) => page.getByRole('searchbox', { name: 'Search trackers and tools' });
/** The count of the sends that wait, on « Connectors » in the bar (FRU-684, FRU-690). */
export const failing = (page: Page) =>
  page
    .locator('aside')
    .getByRole('link', { name: /^Connectors/ })
    .locator('[data-failing]');

/** The tiles of the catalogue, in the order of the mockup of FRU-690. */
export const CATALOGUE = [
  ['Linear', 'linear'],
  ['Jira', 'jira'],
  ['GitHub Issues', 'github'],
  ['GitLab', 'gitlab'],
  ['Asana', 'asana'],
  ['ClickUp', 'clickup'],
  ['Trello', 'trello'],
  ['Notion', 'notion'],
  ['Slack', 'slack'],
  ['Webhook', 'webhook'],
  ['REST API', 'rest'],
  ['Claude Code routine', 'claude-routine'],
] as const;

/** Opens the settings of a connector from its row, and waits for the dialog. */
export async function openSettings(page: Page, name: string): Promise<void> {
  await settingsOf(page, name).click();
  await unfolded(page);
}

export async function expectNoViolation(page: Page, name: string, scope = 'main'): Promise<void> {
  await settled(page);
  const results = await new AxeBuilder({ page }).include(scope).analyze();
  expect
    .soft(
      results.violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target.join(' ')}`),
      name,
    )
    .toEqual([]);
}

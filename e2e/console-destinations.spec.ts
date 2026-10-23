import { type Page, expect, test } from '@playwright/test';
import { WORKER_ORIGIN } from './pin.ts';

/**
 * The panels of a source, where a site chooses where its notes go (FRU-123, FRU-132), measured with
 * a slow write (FRU-191).
 *
 * A panel writes the whole list of a site, made from the list on the screen. A second gesture made
 * before the first write is kept and read again would start from the list of before, and take the
 * first change away. So the controls wait while a list is written: these specs hold a write open,
 * try the second gesture, then let the write go.
 *
 * The worker is answered by stubs. They keep the list of each site, and every list the console sent.
 */
const CONSOLE = 'http://localhost:5178';
const SITE = 'staging.acme.dev';

type Place = { connector: string; teamId?: string; projectId?: string };

const LINEAR = { id: 'c1', kind: 'linear', label: 'Linear · Ana', createdAt: '2026-10-01T10:00:00.000Z' };
const REST = {
  id: 'r1',
  kind: 'rest',
  label: 'REST · https://hooks.acme.dev/fruitback',
  createdAt: '2026-10-02T10:00:00.000Z',
};
const TEAMS = [{ id: 't1', name: 'Web', key: 'WEB', projects: [{ id: 'p1', name: 'Site' }] }];

/** What the worker writes beside a place, as it reads the tracker. */
function labelled(place: Place): Place & { label?: string } {
  if (place.connector !== LINEAR.id) return place;

  return {
    ...place,
    label: ['Linear', 'Web', place.projectId === undefined ? undefined : 'Site'].filter(Boolean).join(' · '),
  };
}

type Worker = {
  /** Every list the console asked the worker to keep, in the order it asked. */
  sent: Place[][];
  /** The list the worker keeps now. */
  kept: () => Place[];
  /** Holds the next write open until `release` is called. */
  holdNext: () => void;
  release: () => void;
};

async function stubWorker(page: Page, places: Place[]): Promise<Worker> {
  let kept = places;
  const sent: Place[][] = [];
  let hold = false;
  let release = () => {};
  const me = {
    account: { id: 'a1', email: 'ana@acme.dev', name: 'Ana', locale: 'en' },
    workspaces: [{ id: 'w1', name: 'Acme', role: 'owner' }],
  };
  await page.route(`${WORKER_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (pathname === '/console/me') return json(me);
    if (pathname === '/console/workspaces/w1/sites') {
      return json({
        sites: [{ id: 's1', origin: `https://${SITE}`, visibility: 'members', destinations: kept.map(labelled) }],
      });
    }
    if (pathname === '/console/workspaces/w1/sites/s1/destinations') {
      const { destinations } = request.postDataJSON() as { destinations: Place[] };
      sent.push(destinations);
      if (hold) {
        hold = false;
        await new Promise<void>((done) => (release = done));
      }
      kept = destinations;

      return json({ destinations: kept.map(labelled) });
    }
    if (pathname === '/console/workspaces/w1/connectors') return json({ connectors: [LINEAR, REST], available: true });
    if (pathname === '/console/workspaces/w1/connectors/c1/teams') return json({ teams: TEAMS });
    if (pathname === '/console/workspaces/w1/connectors/r1/deliveries') return json({ deliveries: [] });

    return route.fulfill({ status: 204 });
  });

  return {
    sent,
    kept: () => kept,
    holdNext: () => void (hold = true),
    release: () => release(),
  };
}

/** Opens the connectors screen, then the panel of one source by its row. */
async function openPanel(page: Page, row: number): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/connectors`);
  await expect(page.locator('main h1')).toBeVisible();
  await page.locator('button[id^="source-row-"]').nth(row).click();
}

test('the Linear panel waits for a list to be kept before the next gesture', async ({ page }) => {
  const worker = await stubWorker(page, [{ connector: 'c1', teamId: 't1' }]);
  await openPanel(page, 0);
  const add = page.getByRole('button', { name: new RegExp(`Add a destination for ${SITE}`) });
  const remove = page.getByRole('button', { name: 'Remove', exact: true });
  await expect(add).toBeEnabled();

  // The first gesture: a second place, whose write the worker holds open.
  worker.holdNext();
  await add.click();
  await page.getByRole('option', { name: 'Web · Site', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(1);

  // While it is written, every control of the list waits.
  await expect(add).toBeDisabled();
  await expect(remove).toBeDisabled();
  // A second gesture now would be made from the list of before, which has one place: it sends nothing.
  await remove.click({ force: true });

  worker.release();
  await expect(page.getByText('Linear · Web · Site', { exact: true })).toBeVisible();
  await expect(remove.first()).toBeEnabled();
  expect(worker.sent).toEqual([
    [
      { connector: 'c1', teamId: 't1' },
      { connector: 'c1', teamId: 't1', projectId: 'p1' },
    ],
  ]);

  // The next gesture starts from the list the worker keeps: the place added is in it.
  await page.getByRole('button', { name: 'Make it the default', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(2);
  expect(worker.sent[1]).toEqual([
    { connector: 'c1', teamId: 't1', projectId: 'p1' },
    { connector: 'c1', teamId: 't1' },
  ]);
  await expect.poll(() => worker.kept()).toEqual(worker.sent[1]);
});

test('the panel of an address waits for a list to be kept before the next gesture', async ({ page }) => {
  const worker = await stubWorker(page, [{ connector: 'c1', teamId: 't1' }]);
  await openPanel(page, 1);
  const choice = page.getByRole('button', { name: new RegExp(SITE) });
  await expect(choice).toBeEnabled();

  // The first gesture: the site sends to this address too, and the worker holds the write open.
  worker.holdNext();
  await choice.click();
  await page.getByRole('option', { name: 'Fruitback, and this address', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(1);

  // While it is written, the choice waits: a second gesture cannot even open it.
  await expect(choice).toBeDisabled();
  await choice.click({ force: true });
  await expect(page.getByRole('listbox')).toHaveCount(0);

  worker.release();
  await expect(choice).toBeEnabled();
  await expect(choice).toContainText('Fruitback, and this address');
  // The other place of the site stays, first, and this address comes after it.
  expect(worker.sent).toEqual([[{ connector: 'c1', teamId: 't1' }, { connector: 'r1' }]]);

  // The next gesture takes the address out, from the list the worker keeps.
  await choice.click();
  await page.getByRole('option', { name: 'Another source', exact: true }).click();
  await expect.poll(() => worker.sent.length).toBe(2);
  expect(worker.sent[1]).toEqual([{ connector: 'c1', teamId: 't1' }]);
  await expect.poll(() => worker.kept()).toEqual([{ connector: 'c1', teamId: 't1' }]);
});

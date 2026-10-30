import AxeBuilder from '@axe-core/playwright';
import { type Page, type Route, expect, test } from '@playwright/test';
import { ACME, stubWorker, fulfillSites } from './console-workspace.ts';

/**
 * A repository past the list (FRU-500). GitHub lists 1,000 repositories of an installation at most,
 * so the page of a site says that the list is cut, and how much, and takes the name of another
 * repository, which the worker reads alone (`GET …/repositories?name=`). Found, it is added as a
 * destination; not found, the page says so.
 *
 * The worker is answered by stubs, as in `console-site-places.spec.ts`.
 */
const CONSOLE = 'http://localhost:5178';
const SITE = 'staging.acme.dev';
const GITHUB = { id: 'g1', kind: 'github', label: 'GitHub App · acme', createdAt: '2026-10-20T10:00:00.000Z' };
const LISTED = Array.from({ length: 1000 }, (_, index) => ({ fullName: `acme/repo-${index}`, private: true }));

type Place = { connector: string; teamId?: string; repository?: string };
type Worker = { sent: Place[][]; asked: string[]; total: number };

async function workerWith(page: Page, total: number, locale: 'en' | 'fr' = 'en'): Promise<Worker> {
  const worker: Worker = { sent: [], asked: [], total };
  let places: Place[] = [];
  const answer = (pathname: string, route: Route) => {
    const request = route.request();
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (!pathname.startsWith('/console/workspaces/w1/')) return undefined;
    if (pathname.endsWith('/sites/s1/destinations') && request.method() === 'POST') {
      const { destinations } = request.postDataJSON() as { destinations: Place[] };
      worker.sent.push(destinations);
      places = destinations.map(({ repository, ...rest }) =>
        repository === undefined ? rest : { ...rest, teamId: repository.toLowerCase() },
      );

      return json({
        destinations: places.map((each) => ({ ...each, label: `GitHub · ${each.teamId}`, private: true })),
      });
    }
    if (pathname.endsWith('/connectors')) {
      return json({ connectors: [GITHUB], available: true, linearOAuth: true, githubApp: true });
    }
    const read = fulfillSites(route, [
      {
        id: 's1',
        origin: `https://${SITE}`,
        visibility: 'members',
        destinations: places.map((each) => ({ ...each, label: `GitHub · ${each.teamId}`, private: true })),
      },
    ]);
    if (read !== false) return read;
    if (pathname.endsWith('/g1/repositories')) {
      const name = new URL(request.url()).searchParams.get('name');
      if (name === null) return json({ repositories: LISTED, total: worker.total });
      worker.asked.push(name);
      if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return json({ error: 'invalid-repository' }, 400);
      if (name.toLowerCase() === 'acme/repo-1203') {
        return json({ repository: { fullName: 'acme/repo-1203', private: true } });
      }

      return json({ error: 'repository-not-found' }, 404);
    }

    return undefined;
  };
  await stubWorker(page, { locale, workspaces: [{ ...ACME, role: 'owner' }], answer });

  return worker;
}

const panel = (page: Page) => page.getByRole('region', { name: `Where the notes of ${SITE} go` });
const byName = (page: Page) => panel(page).locator('form[data-repository-by-name]');

async function openPlaces(page: Page): Promise<void> {
  await page.goto(`${CONSOLE}/w/w1/sites/s1`);
  await expect(panel(page)).toBeVisible();
}

test('a repository past the 1,000 listed is added by its name (FRU-500)', async ({ page }) => {
  const worker = await workerWith(page, 1250);
  await openPlaces(page);

  await expect(byName(page)).toContainText(
    'GitHub lists 1000 of the 1250 repositories of acme. Add another one by its name.',
  );
  const field = byName(page).getByRole('textbox', { name: 'Repository of acme' });
  const addButton = byName(page).getByRole('button', { name: 'Add', exact: true });

  // A name the App does not reach: said, and nothing is written.
  await field.fill('acme/elsewhere');
  await addButton.click();
  await expect(byName(page).getByText('The App reaches no repository acme/elsewhere.')).toBeVisible();
  // What is not owner/name: said too.
  await field.fill('acme');
  await addButton.click();
  await expect(byName(page).getByText('Write the repository as owner/name.')).toBeVisible();
  expect(worker.sent).toEqual([]);

  // The one past the list: asked alone, then added as a destination.
  await field.fill('Acme/Repo-1203');
  await addButton.click();
  await expect.poll(() => worker.sent).toEqual([[{ connector: 'g1', repository: 'acme/repo-1203' }]]);
  await expect(panel(page).getByText('GitHub · acme/repo-1203', { exact: true })).toBeVisible();
  await expect(field).toHaveValue('');
  expect(worker.asked).toEqual(['acme/elsewhere', 'acme', 'Acme/Repo-1203']);

  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
});

test('the control: a list GitHub did not cut offers no field', async ({ page }) => {
  await workerWith(page, 1000);
  await openPlaces(page);

  await expect(panel(page).getByRole('button', { name: new RegExp(`Add a destination for ${SITE}`) })).toBeVisible();
  await expect(byName(page)).toHaveCount(0);
});
